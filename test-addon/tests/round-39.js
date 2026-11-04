import {ACTION_WAIT, POLL_WAIT, SETTLE_TIMEOUT, NETWORK_URL, MESSAGE_URL, ORDER_URL, AUTH_URL, AUTH_CREDENTIALS, DEAD_PROXY_PORTS} from '../constants.js';
import {wait} from '../test.js';
import {sceneUrl, withContainer} from '../tabs.js';

export const note = `Round 39 - several listeners of one event in one context of the extension, and a listener that
throws: what the window of the background sees of a listener's error, and whether the listeners after
the throw still run (R39.01); what the sender of runtime.sendMessage gets when three runtime.onMessage
listeners of the background answer in different ways (R39.02); which of two blocking
webRequest.onBeforeRequest listeners decides the request (R39.03); how the headers of two
onBeforeSendHeaders listeners combine (R39.04); whose authCredentials of two onAuthRequired listeners
apply (R39.05) and the asyncBlocking callback against the return value (R39.06); how three
proxy.onRequest listeners chain, and what a throw and a rejection do (R39.07); a promise against a
sendResponse called at once, and whether two onMessage listeners get one message object (R39.08);
whether two tabs.onCreated listeners get one tab object (R39.09); the lists two onBeforeSendHeaders
listeners return against the original headers - an original header one of them omits, a header
pushed into details.requestHeaders in place, a string returned (R39.10); a proxy, a direct entry and
a rejection after a proxy, a proxy after a direct entry (R39.11); two asyncBlocking onAuthRequired
listeners (R39.12); the order of the evaluation of ES modules - a global set by one import is seen
by the instances of a module imported after it and not by one imported before (R39.13), and the
same across ten loads of the page by the browser, every second one past the cache (R39.14). The facts
a layer that calls several handlers from one real listener has to follow (DESIGN-LISTENERS.md §2),
and the order its schemes rely on (§1). Needs the network: ${NETWORK_URL} and ${AUTH_URL}; the webRequest,
webRequestBlocking, proxy and <all_urls> permissions of the manifest; no proxy configured in the
browser or in the system, so that a request has no proxy unless a listener gives it one. The own
uuid is never printed.`;

const OWN_ORIGIN = browser.runtime.getURL('');
const RUN = Date.now(); // a token in every url of the site: the page is never served from the cache of an earlier run
const REDIRECT_URL = `${NETWORK_URL}?stg-redirected=${RUN}`;
const SITE_FRAMES = {urls: [`${NETWORK_URL}*`, `${AUTH_URL}*`], types: ['main_frame']};
const SITE_URLS = {urls: [`${NETWORK_URL}*`]};
const WRONG_CREDENTIALS = {username: AUTH_CREDENTIALS.username, password: 'wrong'};

const mask = text => text.replaceAll(OWN_ORIGIN, '<own page>/');
const addNote = (t, text) => t.note(mask(text));
const short = url => url.replace(AUTH_URL, '<auth page>').replace(NETWORK_URL, '<site>/').replace(/&run=\d+$/, '').replace(/(stg-redirected=)\d+$/, '$1run');
const caseUrl = name => `${NETWORK_URL}?stg-case=${name}&run=${RUN}`;
const deadProxy = port => ({type: 'http', host: '127.0.0.1', port});
const caseOf = url => {
    try {
        return new URL(url).searchParams.get('stg-case');
    } catch {
        return null;
    }
};
const describeError = error => error?.message ?? (typeof error === 'object' ? JSON.stringify(error) : String(error));
const names = list => list.map(entry => entry.who).join('; ') || 'none';
const describeProxy = proxyInfo => proxyInfo ? `${proxyInfo.type} ${proxyInfo.host}:${proxyInfo.port}` : 'none, direct';
const ours = headers => headers.filter(header => header.name.toLowerCase().startsWith('x-stg-')).map(header => `${header.name}: ${header.value}`).join(', ') || 'none';

async function until(condition) {
    const started = Date.now();

    while (!condition() && Date.now() - started < SETTLE_TIMEOUT) {
        await wait(POLL_WAIT);
    }

    return condition();
}

// a listener of a browser event for the time of the test
function listen(t, target, handler, ...args) {
    target.addListener(handler, ...args);
    t.listeners.push({target, handler});
}

// the error and unhandledrejection events of the background's own window, what the logger of an add-on sees;
// known: error object → who made it
function listenWindowErrors(t, known = new Map) {
    const seen = {errors: [], rejections: []};
    const whose = error => known.get(error) ?? `an unknown error: ${describeError(error)}`;

    const onError = event => {
        seen.errors.push({who: whose(event.error), same: known.has(event.error)});
        t.record('window error', `${whose(event.error)}, event.message: ${event.message}, event.error is the thrown object: ${known.has(event.error)}`);
    };

    const onRejection = event => {
        seen.rejections.push({who: whose(event.reason)});
        t.record('window unhandledrejection', whose(event.reason));
    };

    self.addEventListener('error', onError);
    self.addEventListener('unhandledrejection', onRejection);
    t.listeners.push({target: {removeListener: handler => self.removeEventListener('error', handler)}, handler: onError});
    t.listeners.push({target: {removeListener: handler => self.removeEventListener('unhandledrejection', handler)}, handler: onRejection});

    return seen;
}

// the outcome of every request to the site, by the url it started with: the proxy it was given, a redirect, the status it completed with, the error it failed with
function listenOutcomes(t) {
    const outcomes = new Map; // requestId → [text]
    const requestIds = new Map; // the url of the first hop → requestId
    const of = details => {
        if (!outcomes.has(details.requestId)) {
            outcomes.set(details.requestId, []);
        }

        return outcomes.get(details.requestId);
    };

    listen(t, browser.webRequest.onBeforeRequest, details => {
        if (!outcomes.has(details.requestId)) {
            requestIds.set(details.url, details.requestId);
        }

        of(details).push(`proxy: ${describeProxy(details.proxyInfo)}`);
        t.record('webRequest.onBeforeRequest', `${short(details.url)}  proxy: ${describeProxy(details.proxyInfo)}`);
    }, SITE_FRAMES);

    listen(t, browser.webRequest.onBeforeRedirect, details => {
        of(details).push(`redirected to ${short(details.redirectUrl)}`);
        t.record('webRequest.onBeforeRedirect', `${short(details.url)} → ${short(details.redirectUrl)}`);
    }, SITE_FRAMES);

    listen(t, browser.webRequest.onCompleted, details => {
        of(details).push(`completed ${details.statusCode}${details.fromCache ? ' from the cache' : ''}`);
        t.record('webRequest.onCompleted', `${short(details.url)}  status ${details.statusCode}${details.fromCache ? ', from the cache' : ''}`);
    }, SITE_FRAMES);

    listen(t, browser.webRequest.onErrorOccurred, details => {
        of(details).push(`failed: ${details.error}`);
        t.record('webRequest.onErrorOccurred', `${short(details.url)}  ${details.error}`);
    }, SITE_FRAMES);

    const outcomesOf = url => outcomes.get(requestIds.get(url)) ?? [];

    return {
        of: outcomesOf,
        done: url => /^(completed|failed)/.test(outcomesOf(url).at(-1) ?? ''),
    };
}

// the test waits until the request that started with the url has its outcome
async function outcomeOf(t, name, url, outcomes) {
    const done = await until(() => outcomes.done(url));

    if (!done) {
        addNote(t, `${name}: no outcome after ${SETTLE_TIMEOUT} ms`);
    }

    return outcomes.of(url).join(', ') || 'the request never started';
}

// the scene tab x loads the url of the case
async function navigate(t, name, url, outcomes) {
    await t.step(`tabs.update(x, {url: ${short(url)}})`, () => browser.tabs.update(t.id('x'), {url}), {wait: 0, snap: false});

    return outcomeOf(t, name, url, outcomes);
}

// a new tab of the container loads the url: a fresh container starts with an empty auth cache of the browser
async function navigateInContainer(t, name, url, cookieStoreId, outcomes) {
    await t.step(`tabs.create(${name}, {url: ${short(url)}, cookieStoreId: the container of the test})`, async () => {
        const tab = await browser.tabs.create({windowId: t.win, active: false, cookieStoreId, url});

        t.bind(tab.id, name);
        t.createdByAction.add(tab.id);
    }, {wait: 0, snap: false});

    return outcomeOf(t, name, url, outcomes);
}

// a message reported by the page: what its runtime.sendMessage got back
function listenReports(t) {
    const reports = new Map;
    const onReport = message => {
        if (message?.report) {
            reports.set(message.case, message.error === undefined ? `answer ${message.answer}` : `error "${message.error}"`);
            t.record('page reports', `${message.case}: ${reports.get(message.case)}`);
        }
    };

    listen(t, browser.runtime.onMessage, onReport);

    return reports;
}

async function openPage(t, name, cases) {
    const tab = await browser.tabs.create({windowId: t.win, active: false, url: `${sceneUrl(name, MESSAGE_URL)}&do=${cases.join(',')}`});

    t.bind(tab.id, name);
    t.createdByAction.add(tab.id);
}

// the listeners under test, one per name: a case says what each one does and how the record calls it;
// the case of a request is in its url, the case of a message in its ask; sees(details) is what a listener saw of its
// argument, recorded and kept in the returned map, case → listener → text
function listenCases(t, target, label, cases, listenerNames, {args = [], calls = null, sees = null} = {}) {
    const seen = {};

    for (const name of listenerNames) {
        listen(t, target, (details, ...rest) => {
            const which = caseOf(details?.url ?? '') ?? details?.ask;
            const act = cases[which]?.[name];

            if (!act) {
                return;
            }

            calls?.push(`${which}: ${name}`);

            if (sees) {
                (seen[which] ??= {})[name] = sees(details);
                t.record(`${label} ${name}`, `${which}: sees ${seen[which][name]}; ${act.says}`);
            } else {
                t.record(`${label} ${name}`, `${which}: ${act.says}`);
            }

            return act.run(details, ...rest);
        }, ...args);
    }

    return seen;
}

// the cases of runtime.onMessage: the listeners under test, the page that sends every case and reports its answer, the window errors
async function runMessageCases(t, cases, listenerNames) {
    const seen = listenWindowErrors(t);
    const calls = [];

    listenCases(t, browser.runtime.onMessage, 'runtime.onMessage', cases, listenerNames, {calls});

    const reports = listenReports(t);

    await t.scene(['x']);
    await t.snap('before');

    await t.step(`tabs.create(message.html?do=${Object.keys(cases).join(',')})`, () => openPage(t, 'page', Object.keys(cases)), {wait: 0, snap: false});

    const complete = await until(() => reports.size === Object.keys(cases).length);

    if (!complete) {
        addNote(t, `${Object.keys(cases).length - reports.size} case(s) got no report after ${SETTLE_TIMEOUT} ms`);
    }

    for (const [name, listeners] of Object.entries(cases)) {
        const described = Object.entries(listeners).map(([listener, {says}]) => `${listener} ${says}`).join('; ');
        const called = calls.filter(call => call.startsWith(`${name}: `)).map(call => call.slice(name.length + 2));

        addNote(t, `${name}: ${described} - the sender got ${reports.get(name) ?? 'nothing'}; called: ${called.join(', ') || 'none'}`);
    }

    addNote(t, `window error events: ${seen.errors.length} - ${names(seen.errors)}`);
    addNote(t, `window unhandledrejection events: ${seen.rejections.length} - ${names(seen.rejections)}`);

    return {reports, calls, seen};
}

// the cases of proxy.onRequest: the listeners under test, a navigation per case with the proxy the request got and its outcome, proxy.onError, the window errors
async function runProxyCases(t, cases, listenerNames) {
    const seen = listenWindowErrors(t);
    const calls = [];
    const proxyErrors = [];

    listenCases(t, browser.proxy.onRequest, 'proxy.onRequest', cases, listenerNames, {args: [SITE_URLS], calls});

    listen(t, browser.proxy.onError, error => {
        proxyErrors.push(describeError(error));
        t.record('proxy.onError', describeError(error));
    });

    const outcomes = listenOutcomes(t);

    await t.scene(['x']);
    await t.snap('before');

    const results = {};

    for (const [name, listeners] of Object.entries(cases)) {
        const before = proxyErrors.length;
        const outcome = await navigate(t, name, caseUrl(name), outcomes);
        const described = Object.entries(listeners).map(([listener, {says}]) => `${listener} ${says}`).join('; ');
        const called = calls.filter(call => call.startsWith(`${name}: `)).map(call => call.slice(name.length + 2));
        const steps = outcomes.of(caseUrl(name));

        results[name] = {proxies: steps.filter(step => step.startsWith('proxy:')), final: steps.at(-1) ?? 'no request', proxyErrors: proxyErrors.length - before};
        addNote(t, `${name}: ${described} - ${outcome}; called: ${called.join(', ') || 'none'}; proxy.onError: ${proxyErrors.slice(before).join('; ') || 'none'}`);
    }

    addNote(t, `window error events: ${seen.errors.length} - ${names(seen.errors)}`);
    addNote(t, `window unhandledrejection events: ${seen.rejections.length} - ${names(seen.rejections)}`);

    return {results, calls, seen};
}

export const tests = [

{
    id: 'R39.01',
    title: 'tabs.onCreated with four listeners - L1 throws, L2 records, L3 calls self.reportError, L4 returns a rejected promise: what reaches the error and unhandledrejection events of the background window, and do L2-L4 still run after the throw of L1',
    async run(t) {
        t.mask = mask;

        const thrown = new Error('L1 throws');
        const reported = new Error('L3 reportError');
        const rejected = new Error('L4 rejects');
        const seen = listenWindowErrors(t, new Map([[thrown, 'the error L1 threw'], [reported, 'the error L3 passed to self.reportError'], [rejected, 'the rejection L4 returned']]));
        const calls = [];

        await t.scene(['x']);
        await t.snap('before');

        const inScene = tab => tab.windowId === t.win;

        listen(t, browser.tabs.onCreated, tab => {
            if (inScene(tab)) {
                calls.push('L1');
                t.record('tabs.onCreated L1', 'throws');
                throw thrown;
            }
        });

        listen(t, browser.tabs.onCreated, tab => {
            if (inScene(tab)) {
                calls.push('L2');
                t.record('tabs.onCreated L2', 'called');
            }
        });

        listen(t, browser.tabs.onCreated, tab => {
            if (inScene(tab)) {
                calls.push('L3');
                t.record('tabs.onCreated L3', 'calls self.reportError and goes on');
                self.reportError(reported);
            }
        });

        listen(t, browser.tabs.onCreated, tab => {
            if (inScene(tab)) {
                calls.push('L4');
                t.record('tabs.onCreated L4', 'returns a rejected promise');
                return Promise.reject(rejected);
            }
        });

        await t.step('tabs.create(new)', () => t.create('new'));
        await wait(ACTION_WAIT);

        addNote(t, `listeners called, in order: ${calls.join(', ') || 'none'}`);
        addNote(t, `window error events: ${seen.errors.length} - ${names(seen.errors)}`);
        addNote(t, `window unhandledrejection events: ${seen.rejections.length} - ${names(seen.rejections)}`);

        t.expect('a listener that throws stops none of the listeners added after it (BEHAVIOR-LISTENERS.md §1)', calls, ['L1', 'L2', 'L3', 'L4']);
        t.expect('the throw and self.reportError are error events of the window with the object itself, a rejected promise is nothing (BEHAVIOR-LISTENERS.md §2)', seen, {
            errors: [{who: 'the error L1 threw', same: true}, {who: 'the error L3 passed to self.reportError', same: true}],
            rejections: [],
        });
    },
},

{
    id: 'R39.02',
    title: 'runtime.onMessage with three listeners in the background, what the sender gets: a synchronous sendResponse against a promise, a promise against a throw, true with a late sendResponse against a promise, two promises in order, a promise of undefined, no answer at all, true alone, a throw alone, a rejection alone; and which listeners are called',
    async run(t) {
        t.mask = mask;

        const later = value => wait(ACTION_WAIT).then(() => value);
        const cases = {
            'sync-vs-promise': {
                L1: {says: 'calls sendResponse("L1") at once, returns nothing', run: (message, sender, sendResponse) => void sendResponse('L1')},
                L2: {says: 'returns Promise.resolve("L2")', run: () => Promise.resolve('L2')},
            },
            'promise-vs-throw': {
                L1: {says: 'returns Promise.resolve("L1")', run: () => Promise.resolve('L1')},
                L2: {says: 'throws', run: () => {
                    throw new Error('L2 throws');
                }},
            },
            'true-vs-promise': {
                L1: {says: `returns true, calls sendResponse("L1") ${ACTION_WAIT} ms later`, run: (message, sender, sendResponse) => {
                    setTimeout(() => sendResponse('L1'), ACTION_WAIT);
                    return true;
                }},
                L2: {says: 'returns Promise.resolve("L2")', run: () => Promise.resolve('L2')},
            },
            'promise-order': {
                L1: {says: `returns a promise of "L1" settled ${ACTION_WAIT} ms later`, run: () => later('L1')},
                L2: {says: 'returns Promise.resolve("L2")', run: () => Promise.resolve('L2')},
            },
            'undefined-promise': {
                L1: {says: 'returns Promise.resolve(undefined)', run: () => Promise.resolve(undefined)},
                L2: {says: `returns a promise of "L2" settled ${ACTION_WAIT} ms later`, run: () => later('L2')},
            },
            'no-answer': {
                L1: {says: 'returns a string', run: () => 'a string'},
                L2: {says: 'returns an object', run: () => ({object: true})},
                L3: {says: 'returns false', run: () => false},
            },
            'true-only': {
                L1: {says: `returns true, calls sendResponse("L1") ${ACTION_WAIT} ms later`, run: (message, sender, sendResponse) => {
                    setTimeout(() => sendResponse('L1'), ACTION_WAIT);
                    return true;
                }},
            },
            'throw-only': {
                L1: {says: 'throws', run: () => {
                    throw new Error('L1 throws');
                }},
            },
            'reject-only': {
                L1: {says: 'returns Promise.reject', run: () => Promise.reject(new Error('L1 rejects'))},
            },
        };

        const {reports, calls, seen} = await runMessageCases(t, cases, ['L1', 'L2', 'L3']);

        t.expect('what the sender gets from several listeners: the first settled answer, a promise of undefined is one, a string, an object or false is none, a throw or a rejection is the error (BEHAVIOR-LISTENERS.md §3)', Object.fromEntries(Object.keys(cases).map(name => [name, reports.get(name) ?? 'nothing'])), {
            'sync-vs-promise': 'answer "L1"',
            'promise-vs-throw': 'error "L2 throws"',
            'true-vs-promise': 'answer "L2"',
            'promise-order': 'answer "L2"',
            'undefined-promise': 'answer undefined',
            'no-answer': 'answer undefined',
            'true-only': 'answer "L1"',
            'throw-only': 'error "L1 throws"',
            'reject-only': 'error "L1 rejects"',
        });
        t.expect('every listener with something to do is called, in the order of adding, after an answer as well (BEHAVIOR-LISTENERS.md §3)', calls, Object.entries(cases).flatMap(([name, listeners]) => Object.keys(listeners).map(listener => `${name}: ${listener}`)));
        t.expect('a throw of a listener is an error event of the window with a copy of the error, a rejection is nothing (BEHAVIOR-LISTENERS.md §4)', seen, {
            errors: [{who: 'an unknown error: L2 throws', same: false}, {who: 'an unknown error: L1 throws', same: false}],
            rejections: [],
        });
    },
},

{
    id: 'R39.03',
    title: 'blocking webRequest.onBeforeRequest with two listeners, which one decides the request: redirect then cancel, cancel then redirect, a rejection then cancel, a throw then redirect, a cancel settled later against a redirect returned at once',
    async run(t) {
        t.mask = mask;
        t.require('webRequest API present', Boolean(browser.webRequest?.onBeforeRequest), 'the webRequest permission is missing from the manifest');

        const cases = {
            'redirect-then-cancel': {
                L1: {says: 'returns {redirectUrl}', run: () => ({redirectUrl: REDIRECT_URL})},
                L2: {says: 'returns {cancel: true}', run: () => ({cancel: true})},
            },
            'cancel-then-redirect': {
                L1: {says: 'returns {cancel: true}', run: () => ({cancel: true})},
                L2: {says: 'returns {redirectUrl}', run: () => ({redirectUrl: REDIRECT_URL})},
            },
            'reject-then-cancel': {
                L1: {says: 'returns Promise.reject', run: () => Promise.reject(new Error('L1 rejects'))},
                L2: {says: 'returns {cancel: true}', run: () => ({cancel: true})},
            },
            'throw-then-redirect': {
                L1: {says: 'throws', run: () => {
                    throw new Error('L1 throws');
                }},
                L2: {says: 'returns {redirectUrl}', run: () => ({redirectUrl: REDIRECT_URL})},
            },
            'async-order': {
                L1: {says: `returns a promise of {cancel: true} settled ${ACTION_WAIT} ms later`, run: () => wait(ACTION_WAIT).then(() => ({cancel: true}))},
                L2: {says: 'returns {redirectUrl} at once', run: () => ({redirectUrl: REDIRECT_URL})},
            },
        };

        const seen = listenWindowErrors(t);
        const calls = [];

        try {
            listenCases(t, browser.webRequest.onBeforeRequest, 'onBeforeRequest', cases, ['L1', 'L2'], {args: [SITE_FRAMES, ['blocking']], calls});
        } catch (error) {
            t.require('blocking webRequest listeners registered', false, `${error.message}, is the webRequestBlocking permission missing from the manifest?`);
        }

        const outcomes = listenOutcomes(t);

        await t.scene(['x']);
        await t.snap('before');

        const decisions = {};

        for (const [name, listeners] of Object.entries(cases)) {
            const outcome = await navigate(t, name, caseUrl(name), outcomes);
            const described = Object.entries(listeners).map(([listener, {says}]) => `${listener} ${says}`).join('; ');
            const called = calls.filter(call => call.startsWith(`${name}: `)).map(call => call.slice(name.length + 2));

            decisions[name] = outcome.includes('redirected to') ? 'redirected' : outcome.includes('NS_ERROR_ABORT') ? 'canceled' : outcome;
            addNote(t, `${name}: ${described} - ${outcome}; called: ${called.join(', ') || 'none'}`);
        }

        addNote(t, `window error events: ${seen.errors.length} - ${names(seen.errors)}`);
        addNote(t, `window unhandledrejection events: ${seen.rejections.length} - ${names(seen.rejections)}`);

        t.expect('the first redirect or cancel in the order of adding decides, a later-settled one included; a rejection and a throw are skipped (BEHAVIOR-LISTENERS.md §5)', decisions, {
            'redirect-then-cancel': 'redirected',
            'cancel-then-redirect': 'canceled',
            'reject-then-cancel': 'canceled',
            'throw-then-redirect': 'redirected',
            'async-order': 'canceled',
        });
        t.expect('both listeners are called for every request (BEHAVIOR-LISTENERS.md §5)', calls, Object.keys(cases).flatMap(name => [`${name}: L1`, `${name}: L2`]));
        t.expect('the throw is an error event of the window with a copy of the error, the rejection is nothing (BEHAVIOR-LISTENERS.md §5)', seen, {errors: [{who: 'an unknown error: L1 throws', same: false}], rejections: []});
    },
},

{
    id: 'R39.04',
    title: 'blocking webRequest.onBeforeSendHeaders with two listeners: L1 adds X-Stg-A: 1 and X-Stg-B: 1, L2 sets X-Stg-A: 2 and tells whether it saw X-Stg-B - what the second listener gets and what is sent (onSendHeaders)',
    async run(t) {
        t.mask = mask;
        t.require('webRequest API present', Boolean(browser.webRequest?.onBeforeSendHeaders), 'the webRequest permission is missing from the manifest');

        const name = 'headers';
        const sent = [];
        let seenByL2 = 'not called';

        const cases = {
            [name]: {
                L1: {says: 'adds X-Stg-A: 1 and X-Stg-B: 1', run: () => {}},
                L2: {says: 'sets X-Stg-A: 2', run: () => {}},
            },
        };

        try {
            listen(t, browser.webRequest.onBeforeSendHeaders, details => {
                if (caseOf(details.url) !== name) {
                    return;
                }

                t.record('onBeforeSendHeaders L1', `sees ${ours(details.requestHeaders)}; ${cases[name].L1.says}`);

                return {requestHeaders: [...details.requestHeaders, {name: 'X-Stg-A', value: '1'}, {name: 'X-Stg-B', value: '1'}]};
            }, SITE_FRAMES, ['blocking', 'requestHeaders']);

            listen(t, browser.webRequest.onBeforeSendHeaders, details => {
                if (caseOf(details.url) !== name) {
                    return;
                }

                seenByL2 = ours(details.requestHeaders);
                t.record('onBeforeSendHeaders L2', `sees ${seenByL2}; ${cases[name].L2.says}`);

                const requestHeaders = details.requestHeaders.filter(header => header.name.toLowerCase() !== 'x-stg-a');

                return {requestHeaders: [...requestHeaders, {name: 'X-Stg-A', value: '2'}]};
            }, SITE_FRAMES, ['blocking', 'requestHeaders']);
        } catch (error) {
            t.require('blocking webRequest listeners registered', false, `${error.message}, is the webRequestBlocking permission missing from the manifest?`);
        }

        listen(t, browser.webRequest.onSendHeaders, details => {
            if (caseOf(details.url) === name) {
                sent.push(ours(details.requestHeaders));
                t.record('webRequest.onSendHeaders', `sent ${ours(details.requestHeaders)}`);
            }
        }, SITE_FRAMES, ['requestHeaders']);

        const outcomes = listenOutcomes(t);

        await t.scene(['x']);
        await t.snap('before');

        const outcome = await navigate(t, name, caseUrl(name), outcomes);

        addNote(t, `${name}: L1 ${cases[name].L1.says}; L2 ${cases[name].L2.says} - sent: ${sent.join(' | ') || 'nothing recorded'}; ${outcome}`);

        t.expect('the second listener gets the original headers; sent is the merge: the last change of a header wins, an addition of the first stays (BEHAVIOR-LISTENERS.md §6)', {seenByL2, sent}, {seenByL2: 'none', sent: ['X-Stg-A: 2, X-Stg-B: 1']});
    },
},

{
    id: 'R39.05',
    title: 'blocking webRequest.onAuthRequired with two listeners: on the first challenge L1 answers with wrong credentials and L2 with the right ones, on a later challenge L1 answers {} - how many challenges come and whose credentials apply',
    async run(t) {
        t.mask = mask;
        t.require('webRequest API present', Boolean(browser.webRequest?.onAuthRequired), 'the webRequest permission is missing from the manifest');

        const name = 'auth';
        const challenges = [];
        let first = true;

        try {
            listen(t, browser.webRequest.onAuthRequired, details => {
                if (details.url !== AUTH_URL) {
                    return;
                }

                challenges.push('L1');

                const wrong = first;

                first = false;
                t.record('onAuthRequired L1', `challenge ${challenges.filter(c => c === 'L1').length}, status ${details.statusCode}: ${wrong ? 'returns wrong credentials' : 'returns {}'}`);

                return wrong ? {authCredentials: WRONG_CREDENTIALS} : {};
            }, SITE_FRAMES, ['blocking']);

            listen(t, browser.webRequest.onAuthRequired, details => {
                if (details.url !== AUTH_URL) {
                    return;
                }

                challenges.push('L2');
                t.record('onAuthRequired L2', `challenge ${challenges.filter(c => c === 'L2').length}: returns the right credentials`);

                return {authCredentials: AUTH_CREDENTIALS};
            }, SITE_FRAMES, ['blocking']);
        } catch (error) {
            t.require('blocking webRequest listeners registered', false, `${error.message}, is the webRequestBlocking permission missing from the manifest?`);
        }

        const outcomes = listenOutcomes(t);

        await t.scene(['x']);
        await t.snap('before');

        // the browser remembers accepted credentials by host, realm and container: a fresh container starts with none
        await withContainer(t, async cookieStoreId => {
            const outcome = await navigateInContainer(t, name, AUTH_URL, cookieStoreId, outcomes);

            addNote(t, `${name}: challenges ${challenges.join(', ') || 'none'} - ${outcome}`);

            t.expect('the first authCredentials in the order of adding apply; refused ones bring another challenge to every listener, and the request completes with the credentials of the later challenge (BEHAVIOR-LISTENERS.md §7)', {challenges, final: outcome.split(', ').at(-1)}, {challenges: ['L1', 'L2', 'L1', 'L2'], final: 'completed 200'});
        });
    },
},

{
    id: 'R39.06',
    title: 'webRequest.onAuthRequired with asyncBlocking, one listener: on the first challenge returns wrong credentials and passes the right ones to asyncCallback ACTION_WAIT later - is the return value ignored',
    async run(t) {
        t.mask = mask;
        t.require('webRequest API present', Boolean(browser.webRequest?.onAuthRequired), 'the webRequest permission is missing from the manifest');

        const name = 'auth-async';
        let challenges = 0;

        try {
            listen(t, browser.webRequest.onAuthRequired, (details, asyncCallback) => {
                if (details.url !== AUTH_URL) {
                    return;
                }

                challenges++;

                const wrong = challenges === 1;

                t.record('onAuthRequired L1', `challenge ${challenges}, status ${details.statusCode}: returns ${wrong ? 'wrong credentials' : '{}'}, asyncCallback with the right ones ${ACTION_WAIT} ms later (asyncCallback is ${typeof asyncCallback})`);

                setTimeout(() => asyncCallback?.({authCredentials: AUTH_CREDENTIALS}), ACTION_WAIT);

                return wrong ? {authCredentials: WRONG_CREDENTIALS} : {};
            }, SITE_FRAMES, ['asyncBlocking']);
        } catch (error) {
            t.require('asyncBlocking webRequest listener registered', false, error.message);
        }

        const outcomes = listenOutcomes(t);

        await t.scene(['x']);
        await t.snap('before');

        // the browser remembers accepted credentials by host, realm and container: a fresh container starts with none
        await withContainer(t, async cookieStoreId => {
            const outcome = await navigateInContainer(t, name, AUTH_URL, cookieStoreId, outcomes);

            addNote(t, `${name}: ${challenges} challenge(s) - ${outcome}`);

            t.expect('the return value of an asyncBlocking listener is ignored, the credentials of asyncCallback apply (BEHAVIOR-LISTENERS.md §8)', {challenges, final: outcome.split(', ').at(-1)}, {challenges: 1, final: 'completed 200'});
        });
    },
},

{
    id: 'R39.07',
    title: 'proxy.onRequest with three listeners, how they chain: a dead proxy, undefined, null; a dead proxy, undefined, undefined; a throw first; a rejection first - the proxy the request gets, its outcome, and whether proxy.onError fires',
    async run(t) {
        t.mask = mask;
        t.require('proxy API present', Boolean(browser.proxy?.onRequest), 'the proxy permission is missing from the manifest');

        const cases = {
            'dead-undefined-null': {
                L1: {says: 'returns a dead proxy', run: () => deadProxy(DEAD_PROXY_PORTS[0])},
                L2: {says: 'returns undefined', run: () => undefined},
                L3: {says: 'returns null', run: () => null},
            },
            'dead-undefined-undefined': {
                L1: {says: 'returns another dead proxy', run: () => deadProxy(DEAD_PROXY_PORTS[1])},
                L2: {says: 'returns undefined', run: () => undefined},
                L3: {says: 'returns undefined', run: () => undefined},
            },
            'throw-first': {
                L1: {says: 'throws', run: () => {
                    throw new Error('L1 throws');
                }},
                L2: {says: 'returns undefined', run: () => undefined},
                L3: {says: 'returns undefined', run: () => undefined},
            },
            'reject-first': {
                L1: {says: 'returns Promise.reject', run: () => Promise.reject(new Error('L1 rejects'))},
                L2: {says: 'returns undefined', run: () => undefined},
                L3: {says: 'returns undefined', run: () => undefined},
            },
        };

        const {results, calls, seen} = await runProxyCases(t, cases, ['L1', 'L2', 'L3']);

        t.expect('undefined keeps the result of the listener before, null makes it direct, a dead proxy left in place fails the request; a throw and a rejection leave the request direct, only the rejection fires proxy.onError (BEHAVIOR-LISTENERS.md §9)', results, {
            'dead-undefined-null': {proxies: ['proxy: none, direct'], final: 'completed 200', proxyErrors: 0},
            'dead-undefined-undefined': {proxies: [`proxy: http 127.0.0.1:${DEAD_PROXY_PORTS[1]}`], final: 'failed: NS_ERROR_PROXY_CONNECTION_REFUSED', proxyErrors: 0},
            'throw-first': {proxies: ['proxy: none, direct'], final: 'completed 200', proxyErrors: 0},
            'reject-first': {proxies: ['proxy: none, direct'], final: 'completed 200', proxyErrors: 2},
        });
        t.expect('every listener is called in the order of adding, twice per navigation (BEHAVIOR-LISTENERS.md §9)', calls, Object.keys(cases).flatMap(name => ['L1', 'L1', 'L2', 'L2', 'L3', 'L3'].map(listener => `${name}: ${listener}`)));
        t.expect('the throw is an error event of the window per call, the rejection is nothing (BEHAVIOR-LISTENERS.md §9)', seen, {errors: [{who: 'an unknown error: L1 throws', same: false}, {who: 'an unknown error: L1 throws', same: false}], rejections: []});
    },
},

{
    id: 'R39.08',
    title: 'runtime.onMessage with two listeners: a promise L1 returns against a sendResponse L2 calls at once - which answer the sender gets; L1 adds a field to the message object and L2 answers with what it sees - one message object for both listeners, or one each',
    async run(t) {
        t.mask = mask;

        const cases = {
            'promise-vs-sync': {
                L1: {says: 'returns Promise.resolve("L1")', run: () => Promise.resolve('L1')},
                L2: {says: 'calls sendResponse("L2") at once, returns nothing', run: (message, sender, sendResponse) => void sendResponse('L2')},
            },
            'mutate': {
                L1: {says: 'sets message.touched = "L1", returns nothing', run: message => {
                    message.touched = 'L1';
                }},
                L2: {says: 'returns a promise of message.touched, "nothing" when there is none', run: message => Promise.resolve(message.touched ?? 'nothing')},
            },
        };

        const {reports} = await runMessageCases(t, cases, ['L1', 'L2']);

        t.expect('a sendResponse called at once by the second listener beats the resolved promise of the first; the listeners get one message object (BEHAVIOR-LISTENERS.md §10)', Object.fromEntries(Object.keys(cases).map(name => [name, reports.get(name) ?? 'nothing'])), {
            'promise-vs-sync': 'answer "L2"',
            'mutate': 'answer "L1"',
        });
    },
},

{
    id: 'R39.09',
    title: 'tabs.onCreated with two listeners: L1 adds a field to the tab object it gets, L2 tells whether it sees the field - one tab object for both listeners, or one each',
    async run(t) {
        t.mask = mask;

        const seen = listenWindowErrors(t);

        await t.scene(['x']);
        await t.snap('before');

        const inScene = tab => tab.windowId === t.win;
        let seenByL2 = 'not called';

        listen(t, browser.tabs.onCreated, tab => {
            if (inScene(tab)) {
                t.record('tabs.onCreated L1', 'sets tab.touched = "L1"');
                tab.touched = 'L1';
            }
        });

        listen(t, browser.tabs.onCreated, tab => {
            if (inScene(tab)) {
                seenByL2 = tab.touched ?? 'nothing';
                t.record('tabs.onCreated L2', `sees tab.touched: ${seenByL2}`);
            }
        });

        await t.step('tabs.create(new)', () => t.create('new'));

        addNote(t, `L1 sets tab.touched = "L1"; L2 sees tab.touched: ${seenByL2}`);
        addNote(t, `window error events: ${seen.errors.length} - ${names(seen.errors)}`);

        t.expect('every listener gets a tab object of its own (BEHAVIOR-LISTENERS.md §11)', seenByL2, 'nothing');
    },
},

{
    id: 'R39.10',
    title: 'blocking webRequest.onBeforeSendHeaders with two listeners, the lists they return against the original headers: L1 pushes X-Stg-Mut into details.requestHeaders in place and returns that array while L2 returns its list without Accept-Language; L1 returns its list without Accept-Language while L2 returns its list as it is; both omit Accept-Language, the control that the header can be removed at all; L1 returns a string while L2 adds X-Stg-C - what each listener sees and what onSendHeaders reports sent',
    async run(t) {
        t.mask = mask;
        t.require('webRequest API present', Boolean(browser.webRequest?.onBeforeSendHeaders), 'the webRequest permission is missing from the manifest');

        const LANGUAGE = 'accept-language';
        const PRESENT = 'Accept-Language present';
        const without = headers => headers.filter(header => header.name.toLowerCase() !== LANGUAGE);
        const describe = headers => `${headers.some(header => header.name.toLowerCase() === LANGUAGE) ? PRESENT : 'Accept-Language absent'}, X-Stg-*: ${ours(headers)}`;
        const sent = {}; // case → the headers onSendHeaders reported
        let seen = {}; // case → listener → the headers it saw

        const cases = {
            'omit-second': {
                L1: {says: 'pushes X-Stg-Mut: 1 into details.requestHeaders in place and returns that array', run: details => {
                    details.requestHeaders.push({name: 'X-Stg-Mut', value: '1'});
                    return {requestHeaders: details.requestHeaders};
                }},
                L2: {says: 'returns its list without Accept-Language', run: details => ({requestHeaders: without(details.requestHeaders)})},
            },
            'omit-first': {
                L1: {says: 'returns its list without Accept-Language', run: details => ({requestHeaders: without(details.requestHeaders)})},
                L2: {says: 'returns its list as it is', run: details => ({requestHeaders: details.requestHeaders})},
            },
            'omit-both': {
                L1: {says: 'returns its list without Accept-Language', run: details => ({requestHeaders: without(details.requestHeaders)})},
                L2: {says: 'returns its list without Accept-Language', run: details => ({requestHeaders: without(details.requestHeaders)})},
            },
            'string-then-add': {
                L1: {says: 'returns a string', run: () => 'a string'},
                L2: {says: 'adds X-Stg-C: 1', run: details => ({requestHeaders: [...details.requestHeaders, {name: 'X-Stg-C', value: '1'}]})},
            },
        };

        try {
            seen = listenCases(t, browser.webRequest.onBeforeSendHeaders, 'onBeforeSendHeaders', cases, ['L1', 'L2'], {args: [SITE_FRAMES, ['blocking', 'requestHeaders']], sees: details => describe(details.requestHeaders)});
        } catch (error) {
            t.require('blocking webRequest listeners registered', false, `${error.message}, is the webRequestBlocking permission missing from the manifest?`);
        }

        listen(t, browser.webRequest.onSendHeaders, details => {
            const which = caseOf(details.url);

            if (cases[which]) {
                sent[which] = describe(details.requestHeaders);
                t.record('webRequest.onSendHeaders', `${which}: sent ${sent[which]}`);
            }
        }, SITE_FRAMES, ['requestHeaders']);

        const outcomes = listenOutcomes(t);

        await t.scene(['x']);
        await t.snap('before');

        for (const [name, listeners] of Object.entries(cases)) {
            const outcome = await navigate(t, name, caseUrl(name), outcomes);
            const described = Object.entries(listeners).map(([listener, {says}]) => `${listener} ${says}`).join('; ');
            const saw = Object.entries(seen[name] ?? {}).map(([listener, headers]) => `${listener} saw ${headers}`).join('; ') || 'no listener called';

            addNote(t, `${name}: ${described} - ${saw}; sent ${sent[name] ?? 'nothing recorded'}; ${outcome}`);
        }

        const omitCases = Object.keys(cases).filter(name => name.startsWith('omit-'));

        t.require('Accept-Language was in the original headers of every omit-* case', omitCases.every(name => seen[name]?.L1?.startsWith(PRESENT)), 'a header that was not there cannot show whether a listener removed it');
        t.expect('every listener gets a details of its own; a list is the changes against the original headers: an original header any one listener omits is removed, a header pushed in place and returned is added, a string is skipped (BEHAVIOR-LISTENERS.md §12)', {secondSaw: seen['omit-second']?.L2, sent}, {
            secondSaw: `${PRESENT}, X-Stg-*: none`,
            sent: {
                'omit-second': 'Accept-Language absent, X-Stg-*: X-Stg-Mut: 1',
                'omit-first': 'Accept-Language absent, X-Stg-*: none',
                'omit-both': 'Accept-Language absent, X-Stg-*: none',
                'string-then-add': `${PRESENT}, X-Stg-*: X-Stg-C: 1`,
            },
        });
    },
},

{
    id: 'R39.11',
    title: 'proxy.onRequest with two listeners, a result after a ProxyInfo: a dead proxy then another dead proxy - which one goes first; {type: "direct"} then a dead proxy - does the request fall back to the direct connection once the proxy refuses; a dead proxy then {type: "direct"} - does the proxy of L1 stay; a dead proxy then a rejection - does the proxy of L1 stay',
    async run(t) {
        t.mask = mask;
        t.require('proxy API present', Boolean(browser.proxy?.onRequest), 'the proxy permission is missing from the manifest');

        const cases = {
            'dead-then-other': {
                L1: {says: 'returns a dead proxy', run: () => deadProxy(DEAD_PROXY_PORTS[2])},
                L2: {says: 'returns another dead proxy', run: () => deadProxy(DEAD_PROXY_PORTS[3])},
            },
            'direct-then-dead': {
                L1: {says: 'returns {type: "direct"}', run: () => ({type: 'direct'})},
                L2: {says: 'returns a dead proxy', run: () => deadProxy(DEAD_PROXY_PORTS[4])},
            },
            'dead-then-direct': {
                L1: {says: 'returns a dead proxy', run: () => deadProxy(DEAD_PROXY_PORTS[5])},
                L2: {says: 'returns {type: "direct"}', run: () => ({type: 'direct'})},
            },
            'dead-then-reject': {
                L1: {says: 'returns a dead proxy', run: () => deadProxy(DEAD_PROXY_PORTS[6])},
                L2: {says: 'returns Promise.reject', run: () => Promise.reject(new Error('L2 rejects'))},
            },
        };

        const {results} = await runProxyCases(t, cases, ['L1', 'L2']);
        const failed = 'failed: NS_ERROR_PROXY_CONNECTION_REFUSED';
        const proxy = index => `proxy: http 127.0.0.1:${DEAD_PROXY_PORTS[index]}`;

        t.expect('a ProxyInfo goes before the one of the listener before, which becomes its failover; {type: "direct"} after a ProxyInfo leaves it and before one is no failover; a rejection leaves the ProxyInfo before and fires proxy.onError per call (BEHAVIOR-LISTENERS.md §13)', results, {
            'dead-then-other': {proxies: [proxy(3), proxy(2)], final: failed, proxyErrors: 0},
            'direct-then-dead': {proxies: [proxy(4)], final: failed, proxyErrors: 0},
            'dead-then-direct': {proxies: [proxy(5)], final: failed, proxyErrors: 0},
            'dead-then-reject': {proxies: [proxy(6)], final: failed, proxyErrors: 2},
        });
    },
},

{
    id: 'R39.12',
    title: 'webRequest.onAuthRequired with asyncBlocking and two listeners: on the first challenge L1 passes wrong credentials to its asyncCallback ACTION_WAIT later and L2 passes the right ones at once, on a later challenge L1 passes the right ones too - whose credentials apply, the first listener in the order of adding or the first callback called',
    async run(t) {
        t.mask = mask;
        t.require('webRequest API present', Boolean(browser.webRequest?.onAuthRequired), 'the webRequest permission is missing from the manifest');

        const name = 'auth-async-two';
        const challenges = [];
        const count = listener => challenges.filter(c => c === listener).length;

        try {
            listen(t, browser.webRequest.onAuthRequired, (details, asyncCallback) => {
                if (details.url !== AUTH_URL) {
                    return;
                }

                challenges.push('L1');

                const wrong = count('L1') === 1;

                t.record('onAuthRequired L1', `challenge ${count('L1')}, status ${details.statusCode}: asyncCallback with ${wrong ? 'wrong' : 'the right'} credentials ${ACTION_WAIT} ms later`);
                setTimeout(() => asyncCallback({authCredentials: wrong ? WRONG_CREDENTIALS : AUTH_CREDENTIALS}), ACTION_WAIT);
            }, SITE_FRAMES, ['asyncBlocking']);

            listen(t, browser.webRequest.onAuthRequired, (details, asyncCallback) => {
                if (details.url !== AUTH_URL) {
                    return;
                }

                challenges.push('L2');
                t.record('onAuthRequired L2', `challenge ${count('L2')}: asyncCallback with the right credentials at once`);
                asyncCallback({authCredentials: AUTH_CREDENTIALS});
            }, SITE_FRAMES, ['asyncBlocking']);
        } catch (error) {
            t.require('asyncBlocking webRequest listeners registered', false, error.message);
        }

        const outcomes = listenOutcomes(t);

        await t.scene(['x']);
        await t.snap('before');

        // the browser remembers accepted credentials by host, realm and container: a fresh container starts with none
        await withContainer(t, async cookieStoreId => {
            const outcome = await navigateInContainer(t, name, AUTH_URL, cookieStoreId, outcomes);

            addNote(t, `${name}: challenges ${challenges.join(', ') || 'none'} - ${outcome}`);

            t.expect('the credentials of the first listener in the order of adding apply, although its asyncCallback came later (BEHAVIOR-LISTENERS.md §14)', {challenges, final: outcome.split(', ').at(-1)}, {challenges: ['L1', 'L2', 'L1', 'L2'], final: 'completed 200'});
        });
    },
},

{
    id: 'R39.13',
    title: 'the order of the evaluation of ES modules: a page imports a module that sets a global on self, then ten instances of a module that read the global at their own evaluation, and before both a module that imports an instance of its own - which instances see the global',
    async run(t) {
        t.mask = mask;

        const name = 'order';
        const probes = [];

        listen(t, browser.runtime.onMessage, message => {
            if (message?.report === name && message.orderProbes) {
                for (const {query, seen} of message.orderProbes) {
                    probes.push(`${query}: ${seen ? 'sees' : 'does not see'} the global`);
                    t.record(`order-probe.js?${query}`, `${seen ? 'sees' : 'does not see'} the global at its evaluation`);
                }
            }
        });

        await t.scene(['x']);
        await t.snap('before');

        await t.step('tabs.create(order.html)', async () => {
            const tab = await browser.tabs.create({windowId: t.win, active: false, url: sceneUrl(name, ORDER_URL)});

            t.bind(tab.id, name);
            t.createdByAction.add(tab.id);
        }, {wait: 0, snap: false});

        const complete = await until(() => probes.length > 0);

        if (!complete) {
            addNote(t, `no report from the page after ${SETTLE_TIMEOUT} ms`);
        }

        addNote(t, `the probes in the order of their evaluation: ${probes.join('; ') || 'none'}`);

        t.expect('a global set by one import is there for every instance imported after it and not for the one imported before (BEHAVIOR-LISTENERS.md §15)', probes, [
            'early: does not see the global',
            ...Array.from({length: 10}, (_, index) => `${index + 1}: sees the global`),
        ]);
    },
},

{
    id: 'R39.14',
    title: 'the page of R39.13 loaded by the browser ten times, every second load past the cache: does every load evaluate the modules in the same order',
    async run(t) {
        t.mask = mask;

        const name = 'order';
        const loads = [];

        listen(t, browser.runtime.onMessage, message => {
            if (message?.report === name && message.orderProbes) {
                const early = message.orderProbes.filter(({query}) => query === 'early');
                const later = message.orderProbes.filter(({query}) => query !== 'early');
                const line = `early ${early.length === 1 && !early[0].seen ? 'does not see' : 'sees'} the global, ${later.length} later ${later.every(({seen}) => seen) ? 'see' : 'do not all see'} it`;

                loads.push(line);
                t.record(`load ${loads.length}`, line);
            }
        });

        await t.scene(['x']);
        await t.snap('before');

        await t.step('tabs.create(order.html)', async () => {
            const tab = await browser.tabs.create({windowId: t.win, active: false, url: sceneUrl(name, ORDER_URL)});

            t.bind(tab.id, name);
            t.createdByAction.add(tab.id);
        }, {wait: 0, snap: false});

        for (let load = 1; load <= 10; load++) {
            if (load > 1) {
                const bypassCache = load % 2 === 0;

                await t.step(`tabs.reload(order, {bypassCache: ${bypassCache}})`, () => browser.tabs.reload(t.id(name), {bypassCache}), {wait: 0, snap: false});
            }

            const reported = await until(() => loads.length === load);

            if (!reported) {
                addNote(t, `load ${load}: no report from the page after ${SETTLE_TIMEOUT} ms`);
                break;
            }
        }

        addNote(t, `${loads.length} load(s): ${[...new Set(loads)].join(' | ') || 'none'}`);

        t.expect('every load of the page by the browser evaluates the modules in the same order (BEHAVIOR-LISTENERS.md §16)', loads, Array.from({length: 10}, () => 'early does not see the global, 10 later see it'));
    },
},

];
