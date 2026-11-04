import {describe, test, afterEach} from 'node:test';
import assert from 'node:assert/strict';

// every test gets its own instance of the module: Node loads a module again for a different query or fragment
const MODULE_URL = new URL('../src/js/listeners.js', import.meta.url);
const START_TIME_PROMISE_SYMBOL = Symbol.for('__listeners_extension_start_time_promise__');
const CUSTOM_EVENT_SCHEMES_SYMBOL = Symbol.for('__listeners_custom_event_schemes__');
const START_TIME_KEY = '__ext_start_time';
const ORIGIN = 'moz-extension://uuid';
const BACKGROUND_PATHNAME = '/_generated_background_page.html';
const PAGE_PATHNAME = '/popup/popup.html';
const NO_LISTENER_MESSAGE = 'No listener for "runtime.onMessage", please call back later';

const EVENT_NAMES = [
    'tabs.onCreated',
    'tabs.onUpdated',
    'tabs.onActivated',
    'windows.onCreated',
    'runtime.onMessage',
    'runtime.onMessageExternal',
    'runtime.onUserScriptMessage',
    'runtime.onInstalled',
    'runtime.onUpdateAvailable',
    'runtime.onConnect',
    'runtime.onConnectExternal',
    'runtime.onUserScriptConnect',
    'webRequest.onBeforeRequest',
    'webRequest.onBeforeSendHeaders',
    'webRequest.onHeadersReceived',
    'webRequest.onAuthRequired',
    'proxy.onRequest',
    'storage.local.onChanged',
    'bookmarks.onCreated',
    'downloads.onChanged',
    'webNavigation.onCommitted',
    'devtools.network.onRequestFinished',
];

let loadCount = 0;
const loaded = [];

function createEvent() {
    const listeners = new Map; // listener → the arguments of addListener after it

    return {
        listeners,
        addListener(listener, ...args) {
            listeners.set(listener, args);
        },
        removeListener(listener) {
            listeners.delete(listener);
        },
        hasListener(listener) {
            return listeners.has(listener);
        },
        fire(...args) {
            let result;

            for (const listener of listeners.keys()) {
                result = listener(...args);
            }

            return result;
        },
    };
}

function createBrowser({manifest, session}) {
    const browser = {
        runtime: {
            getManifest: () => manifest,
            getURL: path => `${ORIGIN}/${path}`, // as the browser: the path is put after the root as it is
        },
        storage: {
            session: { // a round trip to the browser takes a task, not a microtask
                reads: 0,
                writes: 0,
                async get(key) {
                    await tick();
                    browser.storage.session.reads++;
                    return Object.hasOwn(session, key) ? {[key]: session[key]} : {}; // a key that is not there is not in the result
                },
                async set(values) {
                    await tick();
                    Object.assign(session, values);
                    browser.storage.session.writes++;
                },
            },
        },
    };

    for (const name of EVENT_NAMES) {
        const parts = name.split('.');
        const namespace = parts.slice(0, -1).reduce((obj, part) => obj[part] ??= {}, browser);
        namespace[parts.at(-1)] = createEvent();
    }

    browser.tabs.query = async () => []; // a function of the API next to the events

    return browser;
}

function eventOf(root, name) {
    return name.split('.').reduce((obj, part) => obj?.[part], root);
}

async function load(query, {
        pathname = BACKGROUND_PATHNAME,
        manifest = {background: {scripts: ['background.js']}},
        session = {},
        shareStartTime = false,
        storage = true,
        schemes = null,
    } = {}) {
    const reported = []; // what the module reported as uncaught errors

    globalThis.self = globalThis;
    globalThis.location = {origin: ORIGIN, pathname};
    globalThis.browser = createBrowser({manifest, session});
    globalThis.reportError = error => reported.push(error);

    if (!storage) {
        delete globalThis.browser.storage; // an add-on without the storage permission
    }

    if (schemes) {
        globalThis[CUSTOM_EVENT_SCHEMES_SYMBOL] = schemes; // the schemes of the add-on, put there by a module evaluated earlier
    } else {
        delete globalThis[CUSTOM_EVENT_SCHEMES_SYMBOL];
    }

    if (!shareStartTime) {
        delete globalThis[START_TIME_PROMISE_SYMBOL];
    }

    const module = await import(`${MODULE_URL.href}?${query}#${++loadCount}`);
    const names = [...new URL(`${MODULE_URL.href}?${query}`).searchParams.keys()];

    loaded.push({Listeners: module.default, names});

    return {
        Listeners: module.default,
        browser: globalThis.browser,
        session,
        reported,
    };
}

function tick() {
    return new Promise(resolve => setTimeout(resolve));
}

// the start time is read and written through the storage: three tasks until every handler has heard of it
async function settled() {
    for (let i = 0; i < 3; i++) {
        await tick();
    }
}

const later = value => tick().then(() => value);

// the handlers added as L1, L2, …: every call goes into calls, in its order
function addNamed(event, handlers, calls) {
    handlers.forEach((handler, index) => {
        event.add((...args) => {
            calls.push(`L${index + 1}`);
            return handler(...args);
        });
    });
}

// the rejections nobody handled while run ran; the runner fails the test on one, so its listeners step aside for that time
async function unhandledRejectionsOf(run) {
    const unhandled = [];
    const runnerListeners = process.rawListeners('unhandledRejection');
    const onUnhandled = reason => unhandled.push(reason);

    process.removeAllListeners('unhandledRejection');
    process.on('unhandledRejection', onUnhandled);

    try {
        await run();
    } finally {
        process.off('unhandledRejection', onUnhandled);
        runnerListeners.forEach(listener => process.on('unhandledRejection', listener));
    }

    return unhandled;
}

// the instances of a test end with it: the real listeners and the timers are gone, the start time is read and written
afterEach(async () => {
    for (const {Listeners, names} of loaded.splice(0)) {
        for (const name of names) {
            eventOf(Listeners, name).unsubscribe();
        }
    }

    await settled();
});

describe('the query of the import', () => {
    test('an array is the arguments of addListener after the listener', async () => {
        const {browser} = await load('webRequest.onBeforeRequest=[{"urls":["<all_urls>"]},["blocking"]]');
        const [args] = browser.webRequest.onBeforeRequest.listeners.values();

        assert.deepEqual(args, [{urls: ['<all_urls>']}, ['blocking']]);
    });

    test('an object carries the arguments in args and the prefs of the subscription', async () => {
        const {Listeners, browser} = await load('tabs.onUpdated={"args":[{"properties":["title"]}],"waitListener":false}');
        const [args] = browser.tabs.onUpdated.listeners.values();
        const calls = [];

        assert.deepEqual(args, [{properties: ['title']}]);

        browser.tabs.onUpdated.fire(1, {title: 'a'}, {id: 1});
        Listeners.tabs.onUpdated.add((...eventArgs) => calls.push(eventArgs));

        assert.deepEqual(calls, []);
    });

    test('a wrong query throws at load', async () => {
        const cases = [
            ['tabs.onCreated&tabs.onCreated', 'Duplicate event "tabs.onCreated" in the query'],
            ['tabs.onNothing', 'Event object for "tabs.onNothing" listener not found!'],
            ['tabs.query', '"tabs.query" is not an event object'],
            ['tabs', '"tabs" is not an event object'],
            ['tabs.onCreated={bad', 'Invalid JSON value for listener event "tabs.onCreated" json: {bad'],
            ['tabs.onCreated=5', 'The value of "tabs.onCreated" must be an array or an object'],
            ['tabs.onCreated=true', 'The value of "tabs.onCreated" must be an array or an object'],
            ['tabs.onCreated=null', 'The value of "tabs.onCreated" must be an array or an object'],
            ['tabs.onCreated={"args":5}', 'Arguments for "tabs.onCreated" must be an array!'],
            ['tabs.onCreated={"foo":1}', '"foo" cannot be set in the query of "tabs.onCreated"'],
            ['tabs.onCreated={"returnPromise":true}', '"returnPromise" cannot be set in the query of "tabs.onCreated"'],
            ['tabs.onCreated={"waitListener":1}', 'Invalid value of "waitListener" for "tabs.onCreated": 1'],
            ['tabs.onActivated={"keepAllPending":true}', '"keepAllPending" needs "canKeepAllPending" for "tabs.onActivated"'],
            ['tabs.onCreated={"keepAllPending":true,"waitListener":false}', '"keepAllPending" needs "waitListener" for "tabs.onCreated"'],
            ['runtime.onMessage={"calledOnce":true}', '"calledOnce" excludes "returnPromise" for "runtime.onMessage"'],
            ['runtime.onInstalled={"waitListener":false}', '"calledOnce" needs "waitListener" for "runtime.onInstalled"'],
            ['tabs.onCreated={"pendingPromiseTimeout":5}', '"pendingPromiseTimeout" needs "returnPromise" for "tabs.onCreated"'],
            ['runtime.onMessage={"pendingPromiseTimeout":-1}', 'Invalid value of "pendingPromiseTimeout" for "runtime.onMessage": -1'],
        ];

        for (const [query, message] of cases) {
            await assert.rejects(load(query), {message}, query);
        }
    });
});

describe('the schemes of the add-on itself', () => {
    test('a scheme for an event the module does not know: its keys apply to the subscription', async () => {
        const schemes = new Map([['devtools.network.onRequestFinished', {sharedArgs: true, canKeepAllPending: true}]]);
        const {Listeners, browser} = await load('devtools.network.onRequestFinished={"keepAllPending":true}', {schemes});
        const requests = [{getContent() {}}, {getContent() {}}];
        const calls = [];

        browser.devtools.network.onRequestFinished.fire(requests[0]);
        browser.devtools.network.onRequestFinished.fire(requests[1]);
        Listeners.devtools.network.onRequestFinished.add(request => calls.push(request));

        assert.equal(calls.length, 2);
        assert.equal(calls[0], requests[0]);
        assert.equal(calls[1], requests[1]);
    });

    test('an own event of the add-on through the event key, with the methods of a browser event', async () => {
        const ready = createEvent();
        const schemes = new Map([['addon.onReady', {event: ready, calledOnce: true}]]);
        const {Listeners} = await load('addon.onReady', {schemes});
        const calls = [];

        assert.equal(ready.listeners.size, 1);

        ready.fire({at: 1});
        Listeners.addon.onReady.add(details => calls.push(details));
        Listeners.addon.onReady.add(details => calls.push(details));

        assert.deepEqual(calls, [{at: 1}, {at: 1}]);

        Listeners.addon.onReady.unsubscribe();

        assert.equal(ready.listeners.size, 0);
    });

    test('a scheme of the add-on is checked at load like the own ones, and a name the module has throws', async () => {
        await assert.rejects(load('tabs.onCreated', {schemes: new Map([['devtools.network.onRequestFinished', {foo: 1}]])}), {message: 'Unknown key "foo" in the scheme of "devtools.network.onRequestFinished"'});
        await assert.rejects(load('tabs.onCreated', {schemes: new Map([['devtools.network.onRequestFinished', {answerArg: 1}]])}), {message: '"answerArg" needs "returnPromise" for "devtools.network.onRequestFinished"'});
        await assert.rejects(load('tabs.onCreated', {schemes: new Map([['tabs.onCreated', {canKeepAllPending: true}]])}), {message: 'The scheme of "tabs.onCreated" is already in the module'});
    });
});

describe('the subscription at load', () => {
    test('the real listener is registered at import and every event gets the same methods', async () => {
        const {Listeners, browser} = await load('tabs.onCreated&storage.local.onChanged');

        assert.equal(browser.tabs.onCreated.listeners.size, 1);
        assert.equal(browser.storage.local.onChanged.listeners.size, 1);
        assert.ok(Object.isFrozen(Listeners));

        for (const event of [Listeners.tabs.onCreated, Listeners.storage.local.onChanged]) {
            for (const method of ['add', 'remove', 'has', 'clear', 'unsubscribe']) {
                assert.equal(typeof event[method], 'function', method);
            }
        }
    });
});

describe('add, remove, has, clear', () => {
    test('add returns the remover and adds the same handler once', async () => {
        const {Listeners, browser} = await load('tabs.onCreated');
        const calls = [];
        const handler = tab => calls.push(tab);

        const off = Listeners.tabs.onCreated.add(handler);
        Listeners.tabs.onCreated.add(handler);
        browser.tabs.onCreated.fire({id: 1});

        assert.deepEqual(calls, [{id: 1}]);
        assert.ok(Listeners.tabs.onCreated.has(handler));

        off();
        browser.tabs.onCreated.fire({id: 2});

        assert.deepEqual(calls, [{id: 1}]);
        assert.ok(!Listeners.tabs.onCreated.has(handler));
    });

    test('remove tells whether the handler was there, clear counts the removed and keeps the real listener', async () => {
        const {Listeners, browser} = await load('tabs.onCreated');
        const a = () => {};
        const b = () => {};

        Listeners.tabs.onCreated.add(a);
        Listeners.tabs.onCreated.add(b);

        assert.equal(Listeners.tabs.onCreated.remove(a), true);
        assert.equal(Listeners.tabs.onCreated.remove(a), false);
        assert.equal(Listeners.tabs.onCreated.clear(), 1);
        assert.equal(Listeners.tabs.onCreated.clear(), 0);
        assert.equal(browser.tabs.onCreated.listeners.size, 1);
    });

    test('a handler may remove itself while it runs', async () => {
        const {Listeners, browser} = await load('tabs.onCreated');
        const calls = [];
        const off = Listeners.tabs.onCreated.add(tab => {
            calls.push(tab);
            off();
        });

        browser.tabs.onCreated.fire({id: 1});
        browser.tabs.onCreated.fire({id: 2});

        assert.deepEqual(calls, [{id: 1}]);
    });

    test('a handler added during a dispatch is not called for that event; a handler removed before its turn is not called', async () => {
        const {Listeners, browser} = await load('tabs.onCreated');
        const calls = [];
        const late = tab => calls.push(['late', tab.id]);
        const victim = tab => calls.push(['victim', tab.id]);

        Listeners.tabs.onCreated.add(tab => {
            calls.push(['first', tab.id]);
            Listeners.tabs.onCreated.add(late);
            Listeners.tabs.onCreated.remove(victim);
        });
        Listeners.tabs.onCreated.add(victim);

        browser.tabs.onCreated.fire({id: 1});
        browser.tabs.onCreated.fire({id: 2});

        assert.deepEqual(calls, [['first', 1], ['first', 2], ['late', 2]]);
    });

    test('an add from a handler during a keepAllPending replay: nothing is replayed twice, the new handler gets the remaining events', async () => {
        const {Listeners, browser} = await load('tabs.onCreated={"keepAllPending":true}');
        const calls = [];
        const second = tab => calls.push(['B', tab.id]);

        browser.tabs.onCreated.fire({id: 1});
        browser.tabs.onCreated.fire({id: 2});
        browser.tabs.onCreated.fire({id: 3});
        Listeners.tabs.onCreated.add(tab => {
            calls.push(['A', tab.id]);
            Listeners.tabs.onCreated.add(second);
        });

        assert.deepEqual(calls, [['A', 1], ['A', 2], ['B', 2], ['A', 3], ['B', 3]]);
    });

    test('remove of a handler that is not there does not drop the kept events, nor the message waiting', async () => {
        const kept = await load('tabs.onActivated');
        const calls = [];

        kept.browser.tabs.onActivated.fire({tabId: 1});
        kept.Listeners.tabs.onActivated.remove(() => {});
        kept.Listeners.tabs.onActivated.add(info => calls.push(info));

        assert.deepEqual(calls, [{tabId: 1}]);

        const waiting = await load('runtime.onMessage');
        const answer = waiting.browser.runtime.onMessage.fire({action: 'x'}, {id: 'sender'}, () => {});

        waiting.Listeners.runtime.onMessage.remove(() => {});
        waiting.Listeners.runtime.onMessage.add(message => Promise.resolve(message.action));

        assert.equal(await answer, 'x');
    });
});

describe('waitListener', () => {
    test('the last event before the handler is replayed once, to the first handler only', async () => {
        const {Listeners, browser} = await load('tabs.onActivated');
        const first = [];
        const second = [];

        browser.tabs.onActivated.fire({tabId: 1});
        browser.tabs.onActivated.fire({tabId: 2});
        Listeners.tabs.onActivated.add(info => first.push(info));
        Listeners.tabs.onActivated.add(info => second.push(info));

        assert.deepEqual(first, [{tabId: 2}]);
        assert.deepEqual(second, []);
    });

    test('a handler added with waitListener false takes nothing and drops the kept event', async () => {
        const {Listeners, browser} = await load('tabs.onActivated');
        const first = [];
        const second = [];
        const handler = info => first.push(info);

        browser.tabs.onActivated.fire({tabId: 1});
        Listeners.tabs.onActivated.add(handler, {waitListener: false});
        Listeners.tabs.onActivated.remove(handler);
        Listeners.tabs.onActivated.add(info => second.push(info));

        assert.deepEqual(first, []);
        assert.deepEqual(second, []);
    });

    test('with a handler the event is delivered at once, after remove the events are kept again', async () => {
        const {Listeners, browser} = await load('tabs.onActivated');
        const first = [];
        const second = [];
        const handler = info => first.push(info);

        Listeners.tabs.onActivated.add(handler);
        browser.tabs.onActivated.fire({tabId: 1});
        Listeners.tabs.onActivated.remove(handler);
        browser.tabs.onActivated.fire({tabId: 2});
        Listeners.tabs.onActivated.add(info => second.push(info));

        assert.deepEqual(first, [{tabId: 1}]);
        assert.deepEqual(second, [{tabId: 2}]);
    });
});

describe('keepAllPending', () => {
    test('every event before the handler is replayed in order', async () => {
        const {Listeners, browser} = await load('tabs.onCreated={"keepAllPending":true}');
        const calls = [];

        browser.tabs.onCreated.fire({id: 1});
        browser.tabs.onCreated.fire({id: 2});
        browser.tabs.onCreated.fire({id: 3});
        Listeners.tabs.onCreated.add(tab => calls.push(tab));

        assert.deepEqual(calls, [{id: 1}, {id: 2}, {id: 3}]);
    });

    test('runtime.onConnect keeps every port by its scheme and hands the very port object to the handler', async () => {
        const {Listeners, browser} = await load('runtime.onConnect');
        const ports = [{name: 'a', postMessage() {}}, {name: 'b', postMessage() {}}];
        const calls = [];

        browser.runtime.onConnect.fire(ports[0]);
        browser.runtime.onConnect.fire(ports[1]);
        Listeners.runtime.onConnect.add(port => calls.push(port));

        assert.equal(calls.length, 2);
        assert.equal(calls[0], ports[0]);
        assert.equal(calls[1], ports[1]);
    });

    test('runtime.onConnectExternal and runtime.onUserScriptConnect follow the same scheme', async () => {
        for (const name of ['runtime.onConnectExternal', 'runtime.onUserScriptConnect']) {
            const {Listeners, browser} = await load(name);
            const port = {name: 'a', postMessage() {}};
            const calls = [];

            eventOf(browser, name).fire(port);
            eventOf(Listeners, name).add(received => calls.push(received));

            assert.equal(calls[0], port, name);
        }
    });

    test('the events that are facts of the standard namespaces may keep all: a bookmark, a download, a navigation, a storage change', async () => {
        for (const name of ['bookmarks.onCreated', 'downloads.onChanged', 'webNavigation.onCommitted', 'storage.local.onChanged']) {
            const {Listeners, browser} = await load(`${name}={"keepAllPending":true}`);
            const calls = [];

            eventOf(browser, name).fire({id: 1});
            eventOf(browser, name).fire({id: 2});
            eventOf(Listeners, name).add(details => calls.push(details));

            assert.deepEqual(calls, [{id: 1}, {id: 2}], name);
        }
    });

    test('without keepAllPending only the last event is kept', async () => {
        const {Listeners, browser} = await load('tabs.onCreated');
        const calls = [];

        browser.tabs.onCreated.fire({id: 1});
        browser.tabs.onCreated.fire({id: 2});
        Listeners.tabs.onCreated.add(tab => calls.push(tab));

        assert.deepEqual(calls, [{id: 2}]);
    });
});

describe('calledOnce', () => {
    test('every delivery is kept with a handler in place and reaches every handler once; a handler added later gets the latest one', async () => {
        const {Listeners, browser} = await load('runtime.onUpdateAvailable');
        const first = [];
        const second = [];
        const third = [];

        Listeners.runtime.onUpdateAvailable.add(details => first.push(details));
        browser.runtime.onUpdateAvailable.fire({version: '2.0'});
        Listeners.runtime.onUpdateAvailable.add(details => second.push(details));
        browser.runtime.onUpdateAvailable.fire({version: '2.1'});
        Listeners.runtime.onUpdateAvailable.add(details => third.push(details));

        assert.deepEqual(first, [{version: '2.0'}, {version: '2.1'}]);
        assert.deepEqual(second, [{version: '2.0'}, {version: '2.1'}]);
        assert.deepEqual(third, [{version: '2.1'}]);
    });

    test('a handler added with waitListener false declines the kept event and is not called at a later add, the event stays kept for the others; added before the event it gets it', async () => {
        const after = await load('runtime.onInstalled');
        const declined = [];
        const later = [];

        after.browser.runtime.onInstalled.fire({reason: 'install'});
        after.Listeners.runtime.onInstalled.add(details => declined.push(details), {waitListener: false});
        after.Listeners.runtime.onInstalled.add(details => later.push(details));

        assert.deepEqual(declined, []);
        assert.deepEqual(later, [{reason: 'install'}]);

        const before = await load('runtime.onInstalled');
        const calls = [];

        before.Listeners.runtime.onInstalled.add(details => calls.push(details), {waitListener: false});
        before.browser.runtime.onInstalled.fire({reason: 'install'});

        assert.deepEqual(calls, [{reason: 'install'}]);
    });

    test('a handler removed and added again, or added after clear, gets the event once more', async () => {
        const {Listeners, browser} = await load('runtime.onInstalled');
        const calls = [];
        const handler = details => calls.push(details);

        browser.runtime.onInstalled.fire({reason: 'install'});
        Listeners.runtime.onInstalled.add(handler);
        Listeners.runtime.onInstalled.remove(handler);
        Listeners.runtime.onInstalled.add(handler);
        Listeners.runtime.onInstalled.clear();
        Listeners.runtime.onInstalled.add(handler);

        assert.equal(calls.length, 3);
    });
});

describe('a message before the handler (returnPromise)', () => {
    const sender = {id: 'sender'};

    test('the message waits for the handler and gets its answer', async () => {
        const {Listeners, browser} = await load('runtime.onMessage');
        const answer = browser.runtime.onMessage.fire({action: 'x'}, sender, () => {});

        assert.ok(answer instanceof Promise);

        Listeners.runtime.onMessage.add(message => Promise.resolve(`ok:${message.action}`));

        assert.equal(await answer, 'ok:x');
    });

    test('a handler that returns true answers through its own sendResponse, in a replay and live alike', async t => {
        const {Listeners, browser} = await load('runtime.onMessage');
        const browserSendResponse = t.mock.fn();
        const waiting = browser.runtime.onMessage.fire({action: 'x'}, sender, browserSendResponse);

        Listeners.runtime.onMessage.add((message, sender, sendResponse) => {
            setTimeout(() => sendResponse(`late:${message.action}`));
            return true;
        });

        assert.equal(await waiting, 'late:x');

        const live = browser.runtime.onMessage.fire({action: 'y'}, sender, browserSendResponse);

        assert.ok(live instanceof Promise);
        assert.equal(await live, 'late:y');
        assert.equal(browserSendResponse.mock.callCount(), 0);
    });

    test('a handler without an answer resolves the waiting message with undefined', async () => {
        const {Listeners, browser} = await load('runtime.onMessage');
        const silent = browser.runtime.onMessage.fire({action: 'x'}, sender, () => {});

        Listeners.runtime.onMessage.add(() => {});

        assert.equal(await silent, undefined);

        Listeners.runtime.onMessage.clear();

        const object = browser.runtime.onMessage.fire({action: 'y'}, sender, () => {});

        Listeners.runtime.onMessage.add(() => ({not: 'an answer'}));

        assert.equal(await object, undefined);
    });

    test('without a handler the message is refused after pendingPromiseTimeout', async () => {
        const {browser} = await load('runtime.onMessage={"pendingPromiseTimeout":20}');
        const answer = browser.runtime.onMessage.fire({action: 'x'}, sender, () => {});

        await assert.rejects(answer, {message: NO_LISTENER_MESSAGE});
    });

    test('a newer message refuses the one waiting', async () => {
        const {Listeners, browser} = await load('runtime.onMessage');
        const first = browser.runtime.onMessage.fire({action: 'one'}, sender, () => {});
        const second = browser.runtime.onMessage.fire({action: 'two'}, sender, () => {});

        await assert.rejects(first, {message: NO_LISTENER_MESSAGE});

        Listeners.runtime.onMessage.add(message => Promise.resolve(message.action));

        assert.equal(await second, 'two');
    });

    test('a message after the last handler is removed waits for a handler like one before the first, on purpose', async () => {
        const {Listeners, browser} = await load('runtime.onMessage');
        const handler = message => Promise.resolve(`first:${message.action}`);

        Listeners.runtime.onMessage.add(handler);
        Listeners.runtime.onMessage.remove(handler);

        const waiting = browser.runtime.onMessage.fire({action: 'x'}, sender, () => {});

        assert.ok(waiting instanceof Promise);

        Listeners.runtime.onMessage.add(message => Promise.resolve(`second:${message.action}`));

        assert.equal(await waiting, 'second:x');
    });

    test('a handler that removes itself or unsubscribes while it runs still answers the message it handles', async () => {
        const removing = await load('runtime.onMessage');
        const first = removing.browser.runtime.onMessage.fire({action: 'x'}, sender, () => {});
        const handler = () => {
            removing.Listeners.runtime.onMessage.remove(handler);
            return Promise.resolve('removed');
        };

        removing.Listeners.runtime.onMessage.add(handler); // the waiting message is replayed inside add

        assert.equal(await first, 'removed');
        assert.ok(!removing.Listeners.runtime.onMessage.has(handler));

        const unsubscribing = await load('runtime.onMessage');
        const second = unsubscribing.browser.runtime.onMessage.fire({action: 'x'}, sender, () => {});

        unsubscribing.Listeners.runtime.onMessage.add(() => {
            unsubscribing.Listeners.runtime.onMessage.unsubscribe();
            return Promise.resolve('unsubscribed');
        });

        assert.equal(await second, 'unsubscribed');
        assert.equal(unsubscribing.browser.runtime.onMessage.listeners.size, 0);
    });
});

describe('a handler that throws (BEHAVIOR-LISTENERS.md §1, §2, §4)', () => {
    test('an ordinary event: the error is reported as an uncaught one, the very object, and the handlers after it still run in order', async () => {
        const {Listeners, browser, reported} = await load('tabs.onCreated');
        const boom = new Error('boom');
        const calls = [];

        addNamed(Listeners.tabs.onCreated, [
            () => {
                throw boom;
            },
            () => {},
            () => {},
        ], calls);
        browser.tabs.onCreated.fire({id: 1});

        assert.deepEqual(calls, ['L1', 'L2', 'L3']);
        assert.equal(reported.length, 1);
        assert.equal(reported[0], boom);
    });

    test('a rejected promise returned by a handler of an ordinary event is not reported by the module: it stays an unhandled rejection of the page, on purpose', async () => {
        const {Listeners, browser, reported} = await load('tabs.onCreated');
        const rejection = new Error('rejected');

        Listeners.tabs.onCreated.add(() => Promise.reject(rejection));

        const unhandled = await unhandledRejectionsOf(async () => {
            browser.tabs.onCreated.fire({id: 1});
            await settled();
        });

        assert.deepEqual(reported, []);
        assert.equal(unhandled.length, 1);
        assert.equal(unhandled[0], rejection);
    });

    test('a message handler that throws: the error is reported, the very object, and the refusal is the answer', async () => {
        const {Listeners, browser, reported} = await load('runtime.onMessage');
        const boom = new Error('boom');

        Listeners.runtime.onMessage.add(() => {
            throw boom;
        });

        await assert.rejects(browser.runtime.onMessage.fire({action: 'x'}, {id: 'sender'}, () => {}), {message: 'boom'});
        assert.equal(reported.length, 1);
        assert.equal(reported[0], boom);
    });
});

describe('several handlers of runtime.onMessage (BEHAVIOR-LISTENERS.md §3)', () => {
    const sender = {id: 'sender'};

    async function ask(query, handlers) {
        const {Listeners, browser, reported} = await load(query);
        const calls = [];

        addNamed(Listeners.runtime.onMessage, handlers, calls);

        return {answer: browser.runtime.onMessage.fire({ask: 1}, sender, () => {}), reported, calls};
    }

    test('a sendResponse called inside the handler beats a promise; the handler after the answer is called as well', async () => {
        const {answer, calls} = await ask('runtime.onMessage', [
            (message, sender, sendResponse) => void sendResponse('L1'),
            () => Promise.resolve('L2'),
        ]);

        assert.equal(await answer, 'L1');
        assert.deepEqual(calls, ['L1', 'L2']);
    });

    test('a sendResponse called at once by a later handler beats a resolved promise of an earlier one (§10)', async () => {
        const {answer} = await ask('runtime.onMessage', [
            () => Promise.resolve('L1'),
            (message, sender, sendResponse) => void sendResponse('L2'),
        ]);

        assert.equal(await answer, 'L2');
    });

    test('the handlers get one and the same message object (§10)', async () => {
        const {answer} = await ask('runtime.onMessage', [
            message => {
                message.touched = 'L1';
            },
            message => Promise.resolve(message.touched ?? 'nothing'),
        ]);

        assert.equal(await answer, 'L1');
    });

    test('a throw beats a promise returned by an earlier handler', async () => {
        const {answer, reported, calls} = await ask('runtime.onMessage', [
            () => Promise.resolve('L1'),
            () => {
                throw new Error('L2 throws');
            },
        ]);

        await assert.rejects(answer, {message: 'L2 throws'});
        assert.equal(reported.length, 1);
        assert.deepEqual(calls, ['L1', 'L2']);
    });

    test('a promise resolved at once beats true with a late sendResponse and a promise settled later', async () => {
        const trueFirst = await ask('runtime.onMessage', [
            (message, sender, sendResponse) => {
                setTimeout(() => sendResponse('L1'));
                return true;
            },
            () => Promise.resolve('L2'),
        ]);

        assert.equal(await trueFirst.answer, 'L2');

        const laterFirst = await ask('runtime.onMessage', [
            () => later('L1'),
            () => Promise.resolve('L2'),
        ]);

        assert.equal(await laterFirst.answer, 'L2');
    });

    test('a promise of undefined is an answer', async () => {
        const {answer} = await ask('runtime.onMessage', [
            () => Promise.resolve(undefined),
            () => later('L2'),
        ]);

        assert.ok(answer instanceof Promise);
        assert.equal(await answer, undefined);
    });

    test('a string, an object or false is no answer: nothing is returned to the browser, every handler is called in order', async () => {
        const {answer, calls} = await ask('runtime.onMessage', [
            () => 'a string',
            () => ({object: true}),
            () => false,
        ]);

        assert.equal(answer, undefined);
        assert.deepEqual(calls, ['L1', 'L2', 'L3']);
    });

    test('true alone: the answer comes through sendResponse; a rejection alone is the error', async () => {
        const trueOnly = await ask('runtime.onMessage', [
            (message, sender, sendResponse) => {
                setTimeout(() => sendResponse('L1'));
                return true;
            },
        ]);

        assert.equal(await trueOnly.answer, 'L1');

        const rejectOnly = await ask('runtime.onMessage', [() => Promise.reject(new Error('L1 rejects'))]);

        await assert.rejects(rejectOnly.answer, {message: 'L1 rejects'});
        assert.deepEqual(rejectOnly.reported, []);
    });

    test('every handler is called in order, after an answer too, each with a sendResponse of its own; a sendResponse after a promise is ignored', async () => {
        const browserSendResponse = () => {};
        const sends = [];
        const calls = [];
        const {Listeners, browser} = await load('runtime.onMessage');

        addNamed(Listeners.runtime.onMessage, [
            (message, sender, sendResponse) => {
                sends.push(sendResponse);
                setTimeout(() => sendResponse('ignored'));
                return Promise.resolve('L1');
            },
            (message, sender, sendResponse) => void sends.push(sendResponse),
            (message, sender, sendResponse) => void sends.push(sendResponse),
        ], calls);

        const answer = browser.runtime.onMessage.fire({ask: 1}, sender, browserSendResponse);

        assert.equal(await answer, 'L1');
        assert.deepEqual(calls, ['L1', 'L2', 'L3']);
        assert.equal(new Set(sends).size, 3);
        assert.ok(!sends.includes(browserSendResponse));
    });

    test('runtime.onMessageExternal and runtime.onUserScriptMessage follow the same rules', async () => {
        for (const name of ['runtime.onMessageExternal', 'runtime.onUserScriptMessage']) {
            const {Listeners, browser} = await load(name);
            const event = eventOf(Listeners, name);

            event.add((message, sender, sendResponse) => void sendResponse('L1'));
            event.add(() => Promise.resolve('L2'));

            assert.equal(await eventOf(browser, name).fire({ask: 1}, sender, () => {}), 'L1', name);
        }
    });
});

describe('the arguments of the handlers of an ordinary event (BEHAVIOR-LISTENERS.md §11)', () => {
    test('sharedArgs set in the query for an event whose argument cannot be cloned: the handlers get the very object', async () => {
        const {Listeners, browser} = await load('devtools.network.onRequestFinished={"sharedArgs":true}');
        const request = {startedDateTime: '2026-11-04T10:00:00.000Z', getContent() {}}; // a HAR entry carries a method
        let secondSaw;

        Listeners.devtools.network.onRequestFinished.add(request => {
            request.touched = 'L1';
        });
        Listeners.devtools.network.onRequestFinished.add(request => {
            secondSaw = request;
        });
        browser.devtools.network.onRequestFinished.fire(request);

        assert.equal(secondSaw, request);
        assert.equal(secondSaw.touched, 'L1');
    });

    test('every handler gets a tab object of its own', async () => {
        const {Listeners, browser} = await load('tabs.onCreated');
        let secondSaw;

        Listeners.tabs.onCreated.add(tab => {
            tab.touched = 'L1';
        });
        Listeners.tabs.onCreated.add(tab => {
            secondSaw = tab.touched ?? 'nothing';
        });
        browser.tabs.onCreated.fire({id: 1});

        assert.equal(secondSaw, 'nothing');
    });
});

describe('several handlers of blocking webRequest (BEHAVIOR-LISTENERS.md §5–§8, §12, §14)', () => {
    const REDIRECT = 'https://r/';
    const details = {requestId: '1', url: 'https://a/'};

    async function decide(query, name, handlers, requestDetails = details, ...rest) {
        const {Listeners, browser, reported} = await load(query);
        const calls = [];

        addNamed(eventOf(Listeners, name), handlers, calls);

        return {answer: await eventOf(browser, name).fire(requestDetails, ...rest), reported, calls};
    }

    const request = (handlers, ...rest) => decide('webRequest.onBeforeRequest=[{"urls":["<all_urls>"]},["blocking"]]', 'webRequest.onBeforeRequest', handlers, ...rest);

    test('both handlers are called in order; the first redirect or cancel in the order of adding decides, a later-settled one included', async () => {
        const redirectFirst = await request([() => ({redirectUrl: REDIRECT}), () => ({cancel: true})]);

        assert.deepEqual(redirectFirst.answer, {redirectUrl: REDIRECT});
        assert.deepEqual(redirectFirst.calls, ['L1', 'L2']);
        assert.deepEqual((await request([() => ({cancel: true}), () => ({redirectUrl: REDIRECT})])).answer, {cancel: true});
        assert.deepEqual((await request([() => later({cancel: true}), () => ({redirectUrl: REDIRECT})])).answer, {cancel: true});
    });

    test('a rejection, a throw and a non-object are skipped, the next handler decides; the throw is reported, the rejection is not', async () => {
        const rejected = await request([() => Promise.reject(new Error('rejected')), () => ({cancel: true})]);

        assert.deepEqual(rejected.answer, {cancel: true});
        assert.deepEqual(rejected.reported, []);

        const thrown = await request([() => {
            throw new Error('thrown');
        }, () => ({redirectUrl: REDIRECT})]);

        assert.deepEqual(thrown.answer, {redirectUrl: REDIRECT});
        assert.equal(thrown.reported.length, 1);
        assert.deepEqual((await request([() => 'a string', () => ({cancel: true})])).answer, {cancel: true});
    });

    test('a rejection of a later handler after an earlier cancel is nothing, not an unhandled rejection (§5)', async () => {
        const unhandled = await unhandledRejectionsOf(async () => {
            const {answer, reported} = await request([() => ({cancel: true}), () => tick().then(() => {
                throw new Error('rejected later');
            })]);

            assert.deepEqual(answer, {cancel: true});
            await settled();
            assert.deepEqual(reported, []);
        });

        assert.deepEqual(unhandled, []);
    });

    test('upgradeToSecure holds until a redirect or a cancel; without a handler the answer is {}', async () => {
        assert.deepEqual((await request([() => ({upgradeToSecure: true}), () => ({})])).answer, {upgradeToSecure: true});
        assert.deepEqual((await request([() => ({upgradeToSecure: true}), () => ({redirectUrl: REDIRECT})])).answer, {redirectUrl: REDIRECT});
        assert.deepEqual((await request([])).answer, {});
    });

    test('the headers of several handlers merge list by list against the original ones, which every handler sees: the last change wins, an addition stays, an original header missing from a list goes', async () => {
        const original = [{name: 'Host', value: 'a'}, {name: 'X-Keep', value: 'k'}];
        let secondSaw;
        const {answer} = await decide('webRequest.onBeforeSendHeaders=[{"urls":["<all_urls>"]},["blocking","requestHeaders"]]', 'webRequest.onBeforeSendHeaders', [
            ({requestHeaders}) => ({requestHeaders: [...requestHeaders, {name: 'X-Stg-A', value: '1'}, {name: 'X-Stg-B', value: '1'}]}),
            ({requestHeaders}) => {
                secondSaw = requestHeaders;
                return {requestHeaders: [{name: 'Host', value: 'a'}, {name: 'X-Stg-A', value: '2'}]};
            },
        ], {...details, requestHeaders: original});

        assert.deepEqual(secondSaw, original);
        assert.deepEqual(answer, {requestHeaders: [{name: 'Host', value: 'a'}, {name: 'X-Stg-A', value: '2'}, {name: 'X-Stg-B', value: '1'}]});
    });

    test('the response headers of onHeadersReceived merge the same way', async () => {
        const original = [{name: 'Content-Type', value: 'text/html'}, {name: 'X-Keep', value: 'k'}];
        const {answer} = await decide('webRequest.onHeadersReceived=[{"urls":["<all_urls>"]},["blocking","responseHeaders"]]', 'webRequest.onHeadersReceived', [
            ({responseHeaders}) => ({responseHeaders: [...responseHeaders, {name: 'X-Stg-A', value: '1'}]}),
            ({responseHeaders}) => ({responseHeaders: responseHeaders.map(header => header.name === 'Content-Type' ? {name: 'Content-Type', value: 'text/plain'} : header)}),
        ], {...details, responseHeaders: original});

        assert.deepEqual(answer, {responseHeaders: [{name: 'Content-Type', value: 'text/plain'}, {name: 'X-Keep', value: 'k'}, {name: 'X-Stg-A', value: '1'}]});
    });

    test('an original header an earlier handler omits stays removed although a later one returns it unchanged (§12)', async () => {
        const original = [{name: 'Host', value: 'a'}, {name: 'X-Keep', value: 'k'}];
        const {answer} = await decide('webRequest.onBeforeSendHeaders=[{"urls":["<all_urls>"]},["blocking","requestHeaders"]]', 'webRequest.onBeforeSendHeaders', [
            ({requestHeaders}) => ({requestHeaders: requestHeaders.filter(header => header.name !== 'X-Keep')}),
            ({requestHeaders}) => ({requestHeaders}),
        ], {...details, requestHeaders: original});

        assert.deepEqual(answer, {requestHeaders: [{name: 'Host', value: 'a'}]});
    });

    test('every handler gets a details of its own: a header pushed into details.requestHeaders in place is not seen by the next handler, and returned with the array it is an addition (§12)', async () => {
        const original = [{name: 'Host', value: 'a'}, {name: 'X-Keep', value: 'k'}];
        let secondSaw;
        const {answer} = await decide('webRequest.onBeforeSendHeaders=[{"urls":["<all_urls>"]},["blocking","requestHeaders"]]', 'webRequest.onBeforeSendHeaders', [
            details => {
                details.requestHeaders.push({name: 'X-Stg-Mut', value: '1'});
                return {requestHeaders: details.requestHeaders};
            },
            ({requestHeaders}) => {
                secondSaw = requestHeaders;
                return {requestHeaders: requestHeaders.filter(header => header.name !== 'X-Keep')};
            },
        ], {...details, requestHeaders: original});

        assert.deepEqual(secondSaw, [{name: 'Host', value: 'a'}, {name: 'X-Keep', value: 'k'}]);
        assert.deepEqual(answer, {requestHeaders: [{name: 'Host', value: 'a'}, {name: 'X-Stg-Mut', value: '1'}]});
    });

    test('onAuthRequired with blocking: both handlers are called, the first authCredentials in the order of adding win', async () => {
        const auth = handlers => decide('webRequest.onAuthRequired=[{"urls":["<all_urls>"]},["blocking"]]', 'webRequest.onAuthRequired', handlers);
        const wrong = {username: 'u', password: 'wrong'};
        const right = {username: 'u', password: 'right'};
        const wrongFirst = await auth([() => ({authCredentials: wrong}), () => ({authCredentials: right})]);

        assert.deepEqual(wrongFirst.answer, {authCredentials: wrong});
        assert.deepEqual(wrongFirst.calls, ['L1', 'L2']);
        assert.deepEqual((await auth([() => ({}), () => ({authCredentials: right})])).answer, {authCredentials: right});
    });

    test('onAuthRequired with asyncBlocking: every handler answers through a callback of its own, the return value is ignored, the callback of the browser gets the combined answer once', async t => {
        const asyncCallback = t.mock.fn();
        const right = {username: 'u', password: 'right'};
        const {answer} = await decide('webRequest.onAuthRequired=[{"urls":["<all_urls>"]},["asyncBlocking"]]', 'webRequest.onAuthRequired', [
            (details, callback) => {
                setTimeout(() => callback({authCredentials: right}));
                return {authCredentials: {username: 'u', password: 'wrong'}};
            },
            (details, callback) => void callback({}),
        ], details, asyncCallback);

        assert.equal(answer, undefined);

        await settled();

        assert.deepEqual(asyncCallback.mock.calls.map(call => call.arguments), [[{authCredentials: right}]]);
    });

    test('onAuthRequired with asyncBlocking and two handlers: the credentials of the first in the order of adding apply, although its callback comes later (§14)', async t => {
        const asyncCallback = t.mock.fn();
        const wrong = {username: 'u', password: 'wrong'};
        const right = {username: 'u', password: 'right'};

        await decide('webRequest.onAuthRequired=[{"urls":["<all_urls>"]},["asyncBlocking"]]', 'webRequest.onAuthRequired', [
            (details, callback) => void setTimeout(() => callback({authCredentials: wrong})),
            (details, callback) => void callback({authCredentials: right}),
        ], details, asyncCallback);
        await settled();

        assert.deepEqual(asyncCallback.mock.calls.map(call => call.arguments), [[{authCredentials: wrong}]]);
    });

    test('onAuthRequired with asyncBlocking and waitListener: a challenge nobody handled gets {} into the callback of the browser on the timeout and on unsubscribe', async t => {
        const query = 'webRequest.onAuthRequired={"args":[{"urls":["<all_urls>"]},["asyncBlocking"]],"waitListener":true,"pendingPromiseTimeout":20}';
        const timedOut = await load(query);
        const lateCallback = t.mock.fn();

        await timedOut.browser.webRequest.onAuthRequired.fire(details, lateCallback); // the promise the browser ignores settles on the timeout

        assert.deepEqual(lateCallback.mock.calls.map(call => call.arguments), [[{}]]);

        const unsubscribed = await load(query);
        const droppedCallback = t.mock.fn();

        unsubscribed.browser.webRequest.onAuthRequired.fire(details, droppedCallback);
        unsubscribed.Listeners.webRequest.onAuthRequired.unsubscribe();
        await settled();

        assert.deepEqual(droppedCallback.mock.calls.map(call => call.arguments), [[{}]]);
    });

    test('onAuthRequired with asyncBlocking and no handler: the callback of the browser gets {}', async t => {
        const asyncCallback = t.mock.fn();
        const {answer} = await decide('webRequest.onAuthRequired=[{"urls":["<all_urls>"]},["asyncBlocking"]]', 'webRequest.onAuthRequired', [], details, asyncCallback);

        assert.equal(answer, undefined);

        await settled();

        assert.deepEqual(asyncCallback.mock.calls.map(call => call.arguments), [[{}]]);
    });
});

describe('several handlers of proxy.onRequest (BEHAVIOR-LISTENERS.md §9, §13)', () => {
    const dead = {type: 'http', host: '127.0.0.1', port: 65535};
    const other = {type: 'http', host: '127.0.0.1', port: 65534};
    const direct = {type: 'direct'};

    async function resolve(handlers) {
        const {Listeners, browser, reported} = await load('proxy.onRequest=[{"urls":["<all_urls>"]}]');
        const calls = [];

        addNamed(Listeners.proxy.onRequest, handlers, calls);

        return {answer: await browser.proxy.onRequest.fire({requestId: '1', url: 'https://a/'}), reported, calls};
    }

    test('every handler is called in order; undefined keeps the proxy so far, null makes it direct, each handler awaited in its turn', async () => {
        const nullLast = await resolve([() => dead, () => undefined, () => null]);

        assert.equal(nullLast.answer, null);
        assert.deepEqual(nullLast.calls, ['L1', 'L2', 'L3']);
        assert.deepEqual((await resolve([() => dead, () => undefined, () => undefined])).answer, [dead]);
        assert.equal((await resolve([])).answer, undefined);
    });

    test('a ProxyInfo after a ProxyInfo goes first and the earlier one is its failover; {type: "direct"} after a ProxyInfo leaves it, before one it is the failover (§13)', async () => {
        assert.deepEqual((await resolve([() => dead, () => Promise.resolve(other)])).answer, [other, dead]);
        assert.deepEqual((await resolve([() => dead, () => direct])).answer, [dead]);
        assert.deepEqual((await resolve([() => direct, () => dead])).answer, [dead, direct]);
        assert.equal((await resolve([() => null, () => direct])).answer, null);
        assert.deepEqual((await resolve([() => null, () => dead])).answer, [dead, null]);
    });

    test('a list of proxies is a chain of its own; a null entry inside a list ends the chain there', async () => {
        assert.deepEqual((await resolve([() => [dead, other], () => undefined])).answer, [dead, other]);
        assert.deepEqual((await resolve([() => dead, () => [other, null]])).answer, [other, null]);
        assert.deepEqual((await resolve([() => dead, () => [other]])).answer, [other, dead]);
    });

    test('a throw and a rejection keep the proxy so far, a rejection first included; the throw is reported, the rejection is not', async () => {
        const thrown = await resolve([() => {
            throw new Error('thrown');
        }, () => undefined]);

        assert.equal(thrown.answer, undefined);
        assert.equal(thrown.reported.length, 1);

        const rejectedFirst = await resolve([() => Promise.reject(new Error('rejected')), () => undefined]);

        assert.equal(rejectedFirst.answer, undefined);
        assert.deepEqual(rejectedFirst.reported, []);

        const rejectedAfter = await resolve([() => dead, () => Promise.reject(new Error('rejected'))]);

        assert.deepEqual(rejectedAfter.answer, [dead]);
    });
});

describe('the start time is read for a start event only', () => {
    test('an instance without a start event never reads the storage', async () => {
        const {browser} = await load('tabs.onCreated');

        await settled();

        assert.equal(browser.storage.session.reads, 0);
    });

    test('a load without the storage API: an ordinary event works and nothing is rejected', async () => {
        const unhandled = await unhandledRejectionsOf(async () => {
            const {Listeners, browser} = await load('tabs.onCreated', {storage: false});
            const calls = [];

            Listeners.tabs.onCreated.add(tab => calls.push(tab));
            browser.tabs.onCreated.fire({id: 1});

            assert.deepEqual(calls, [{id: 1}]);
            await settled();
        });

        assert.deepEqual(unhandled, []);
    });

    test('a start event without the storage API: the read fails loudly and the handler is not called', async () => {
        let calls = 0;
        const unhandled = await unhandledRejectionsOf(async () => {
            const {Listeners} = await load('extension.onStart', {storage: false});

            Listeners.extension.onStart.add(() => calls++);
            await settled();
        });

        assert.equal(calls, 0);
        assert.equal(unhandled.length, 1);
        assert.ok(unhandled[0] instanceof TypeError);
    });
});

describe('extension.onStart and extension.onWake', () => {
    test('a fresh start of the background: onStart fires after the start time is written, onWake stays silent', async () => {
        const {Listeners, browser, session} = await load('extension.onStart&extension.onWake');
        const started = [];
        const woken = [];

        Listeners.extension.onStart.add(() => started.push(session[START_TIME_KEY]));
        Listeners.extension.onWake.add(() => woken.push(1));
        await settled();

        assert.equal(started.length, 1);
        assert.equal(typeof started[0], 'number');
        assert.equal(woken.length, 0);
        assert.equal(browser.storage.session.writes, 1);
    });

    test('a handler added after the delivery gets onStart once', async () => {
        const {Listeners} = await load('extension.onStart');
        let calls = 0;

        await settled();
        Listeners.extension.onStart.add(() => calls++);
        Listeners.extension.onStart.add(() => calls++);

        assert.equal(calls, 2);
    });

    test('a start time already there: onWake fires, onStart stays silent, nothing is written', async () => {
        const {Listeners, browser} = await load('extension.onStart&extension.onWake', {session: {[START_TIME_KEY]: 123}});
        let started = 0;
        let woken = 0;

        Listeners.extension.onStart.add(() => started++);
        Listeners.extension.onWake.add(() => woken++);
        await settled();

        assert.equal(started, 0);
        assert.equal(woken, 1);
        assert.equal(browser.storage.session.writes, 0);
    });

    test('two instances of one background share the read and the write', async () => {
        const session = {};
        const first = await load('extension.onStart', {session});
        const second = await load('extension.onStart', {session, shareStartTime: true});
        let calls = 0;

        first.Listeners.extension.onStart.add(() => calls++);
        second.Listeners.extension.onStart.add(() => calls++);
        await settled();

        assert.equal(calls, 2);
        assert.equal(first.browser.storage.session.writes + second.browser.storage.session.writes, 1);
    });

    test('a page of the add-on writes no start time: loaded after the write it gets onWake, loaded before it gets onStart', async () => {
        const after = await load('extension.onStart&extension.onWake', {pathname: PAGE_PATHNAME, session: {[START_TIME_KEY]: 123}});
        const afterCalls = [];

        after.Listeners.extension.onStart.add(() => afterCalls.push('onStart'));
        after.Listeners.extension.onWake.add(() => afterCalls.push('onWake'));
        await settled();

        assert.deepEqual(afterCalls, ['onWake']);
        assert.equal(after.browser.storage.session.writes, 0);

        const before = await load('extension.onStart&extension.onWake', {pathname: PAGE_PATHNAME});
        const beforeCalls = [];

        before.Listeners.extension.onStart.add(() => beforeCalls.push('onStart'));
        before.Listeners.extension.onWake.add(() => beforeCalls.push('onWake'));
        await settled();

        assert.deepEqual(beforeCalls, ['onStart']);
        assert.equal(before.browser.storage.session.writes, 0);
        assert.equal(before.session[START_TIME_KEY], undefined);
    });

    test('unsubscribe before the time is read: the handler is not called and add throws', async () => {
        const {Listeners} = await load('extension.onStart');
        let calls = 0;
        const handler = () => calls++;

        Listeners.extension.onStart.add(handler);
        Listeners.extension.onStart.unsubscribe();
        await settled();

        assert.equal(calls, 0);
        assert.throws(() => Listeners.extension.onStart.add(handler), {message: '"extension.onStart" is unsubscribed, a handler cannot be added'});
    });
});

describe('unsubscribe', () => {
    test('removes the real listener and the handlers; add throws after it, a second unsubscribe is harmless', async () => {
        const {Listeners, browser} = await load('tabs.onCreated={"keepAllPending":true}');
        const handler = () => {};

        Listeners.tabs.onCreated.add(handler);
        Listeners.tabs.onCreated.unsubscribe();

        assert.equal(browser.tabs.onCreated.listeners.size, 0);
        assert.equal(Listeners.tabs.onCreated.has(handler), false);
        assert.equal(Listeners.tabs.onCreated.remove(handler), false);
        assert.equal(Listeners.tabs.onCreated.clear(), 0);
        assert.throws(() => Listeners.tabs.onCreated.add(handler), {message: '"tabs.onCreated" is unsubscribed, a handler cannot be added'});

        Listeners.tabs.onCreated.unsubscribe();
    });

    test('refuses a waiting message', async () => {
        const {Listeners, browser} = await load('runtime.onMessage');
        const answer = browser.runtime.onMessage.fire({action: 'x'}, {id: 'sender'}, () => {});

        Listeners.runtime.onMessage.unsubscribe();

        await assert.rejects(answer, {message: NO_LISTENER_MESSAGE});
    });
});

describe('the background by the manifest', () => {
    test('background.page: the page of the manifest is the background, the generated page is not', async () => {
        const manifest = {background: {page: 'bg.html'}};
        const page = await load('extension.onStart', {manifest, pathname: '/bg.html'});

        await settled();

        const generated = await load('extension.onStart', {manifest});

        await settled();

        assert.equal(typeof page.session[START_TIME_KEY], 'number');
        assert.equal(generated.session[START_TIME_KEY], undefined);
    });

    test('background.page with a leading slash or a dot names the same page; a page of the add-on is not the background', async () => {
        for (const page of ['/bg.html', './bg.html', 'pages/bg.html']) {
            const manifest = {background: {page}};
            const pathname = `/${page.replace(/^\.?\//, '')}`;
            const background = await load('extension.onStart', {manifest, pathname});

            await settled();

            const other = await load('extension.onStart', {manifest, pathname: PAGE_PATHNAME});

            await settled();

            assert.equal(typeof background.session[START_TIME_KEY], 'number', page);
            assert.equal(other.session[START_TIME_KEY], undefined, page);
        }
    });

    test('background.service_worker: the script of the manifest is the background, a page is not', async () => {
        const manifest = {background: {service_worker: 'sw.js'}};
        const worker = await load('extension.onStart', {manifest, pathname: '/sw.js'});

        await settled();

        const page = await load('extension.onStart', {manifest, pathname: PAGE_PATHNAME});

        await settled();

        assert.equal(typeof worker.session[START_TIME_KEY], 'number');
        assert.equal(page.session[START_TIME_KEY], undefined);
    });
});
