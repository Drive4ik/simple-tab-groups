import {LOAD_WAIT, NETWORK_URL, TABS_CREATE_URL_LIMIT} from '../constants.js';
import {wait} from '../test.js';
import {sceneUrl} from '../tabs.js';

export const note = `Round 20 - what tabs.create accepts, and what a page of the add-on may navigate to.
Which url classes tabs.create refuses and with which error (R20.01); whether the accepted ones can
be created in a non-default container (R20.02); which data: content types a top-level
location.replace from an extension page is allowed to reach (R20.03); what
runtime.getBackgroundPage() returns to an extension page opened in a container (R20.04); the exact
byte limit of a url passed to tabs.create, and whether it counts bytes or characters (R20.05);
which schemes a webRequest main_frame listener sees at all (R20.06). Every refusal is printed with
the browser's own error text, and whether a url over the limit can still be reached by navigation
and held as a tab url (R20.07). The expectations are the facts of CREATE-TABS-BEHAVIOR.md 16-22.
Needs the cookies, contextualIdentities, webRequest and <all_urls> permissions of the manifest.`;

const NAVIGATE_URL = browser.runtime.getURL('navigate.html');
const PROBE_URL = browser.runtime.getURL('probe.html');

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const GIF_1PX = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const PDF_MIN = '%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 3 3]>>endobj\ntrailer<</Root 1 0 R>>';

const URL_CASES = [
    ['blank', 'about:blank'],
    ['newtab', 'about:newtab'],
    ['home', 'about:home'],
    ['config', 'about:config'],
    ['addons', 'about:addons'],
    ['reader', `about:reader?url=${encodeURIComponent(NETWORK_URL)}`],
    ['datatext', 'data:text/plain,hello'],
    ['dataimg', `data:image/png;base64,${PNG_1PX}`],
    ['file', 'file:///'],
    ['js', 'javascript:void(0)'],
    ['chrome', 'chrome://browser/content/browser.xhtml'],
    ['ftp', 'ftp://example.com/'],
    ['view', `view-source:${NETWORK_URL}`],
    ['viewfile', 'view-source:file:///'],
    ['own', sceneUrl('own')],
    ['http', NETWORK_URL],
];

const CONTAINER_CASES = [
    ['blank', 'about:blank'],
    ['newtab', 'about:newtab'],
    ['home', 'about:home'],
    ['view', `view-source:${NETWORK_URL}`],
    ['own', sceneUrl('own')],
    ['http', NETWORK_URL],
];

const DATA_CASES = [
    ['png', 'image/png', `data:image/png;base64,${PNG_1PX}`],
    ['gif', 'image/gif', `data:image/gif;base64,${GIF_1PX}`],
    ['svg', 'image/svg+xml', `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')}`],
    ['pdf', 'application/pdf', `data:application/pdf,${encodeURIComponent(PDF_MIN)}`],
    ['json', 'application/json', `data:application/json,${encodeURIComponent('{"a":1}')}`],
    ['tjson', 'text/json', `data:text/json,${encodeURIComponent('{"a":1}')}`],
    ['text', 'text/plain', 'data:text/plain,hello'],
    ['html', 'text/html', `data:text/html,${encodeURIComponent('<b>hello</b>')}`],
    ['video', 'video/mp4', 'data:video/mp4;base64,AAAA'],
    ['notype', '(no type)', 'data:,hello'],
];

const short = url => url.length > 70 ? `${url.slice(0, 67)}...` : url;
const shortError = message => message.length > 200 ? `${message.slice(0, 200)}... (${message.length} chars, the browser embeds the whole url)` : message;

async function attempt(t, name, label, properties) {
    const index = (await t.query()).length;

    return t.step(`tabs.create(${label}, {index: ${index}})`, async () => {
        try {
            const tab = await browser.tabs.create({windowId: t.win, index, active: false, ...properties});

            t.bind(tab.id, name);
            t.createdByAction.add(tab.id);
            t.note(`${name}: resolved`);

            return tab;
        } catch (error) {
            t.note(`${name}: rejected - ${shortError(error.message)}`);
            return null;
        }
    }, {snap: name});
}

async function describeCreated(t, created) {
    for (const [name, tab] of created) {
        const fresh = await browser.tabs.get(tab.id).catch(() => null);

        if (!fresh) {
            t.note(`${name}: the tab is gone`);
            continue;
        }

        t.note(`${name}: url ${short(fresh.url)}; container ${fresh.cookieStoreId}; discarded ${fresh.discarded}`);
    }
}

async function withContainer(t, run) {
    t.require('contextualIdentities API present', Boolean(browser.contextualIdentities), 'the cookies and contextualIdentities permissions are missing from the manifest');

    const identity = await browser.contextualIdentities.create({name: 'stg-test', color: 'blue', icon: 'fingerprint'});

    t.note(`container created for the test: ${identity.cookieStoreId} (${identity.name}); removed at the end`);

    try {
        await run(identity.cookieStoreId);
    } finally {
        await browser.contextualIdentities.remove(identity.cookieStoreId).catch(error => t.note(`container removal failed: ${error.message}`));
    }
}

async function navigatePage(t, name, to, properties = {}) {
    const url = `${NAVIGATE_URL}?tab=${encodeURIComponent(name)}&to=${encodeURIComponent(to)}`;
    const tab = await attempt(t, name, `navigate.html?to=${short(to)}  // the page calls location.replace on load`, {url, ...properties});

    if (!tab) {
        return null;
    }

    await wait(LOAD_WAIT);

    const fresh = await browser.tabs.get(tab.id).catch(() => null);

    if (!fresh) {
        return 'the tab is gone';
    }

    if (fresh.url.startsWith(NAVIGATE_URL)) {
        return 'BLOCKED - still on the page';
    }

    return `navigated: ${short(fresh.url)}`;
}

export const tests = [

{
    id: 'R20.01',
    title: 'tabs.create url classes - which are accepted, which are refused and with what error; what a create without url opens',
    async run(t) {
        await t.scene(['x']);
        await t.snap('before');

        const created = [];
        const verdicts = {};

        for (const [name, url] of URL_CASES) {
            const tab = await attempt(t, name, `{url: ${short(url)}}`, {url});

            verdicts[name] = tab ? 'resolved' : 'rejected';

            if (tab) {
                created.push([name, tab]);
            }
        }

        const nourl = await attempt(t, 'nourl', 'no url at all', {});

        verdicts.nourl = nourl ? 'resolved' : 'rejected';

        if (nourl) {
            created.push(['nourl', nourl]);
        }

        await t.step('let the created pages load', () => wait(LOAD_WAIT), {wait: 0, snap: 'loaded'});
        await describeCreated(t, created);

        t.expect('tabs.create verdicts by url class (CREATE-TABS-BEHAVIOR.md §16)', verdicts, {
            blank: 'resolved', newtab: 'rejected', home: 'rejected', config: 'rejected', addons: 'rejected', reader: 'rejected',
            datatext: 'rejected', dataimg: 'rejected', file: 'rejected', js: 'rejected', chrome: 'rejected',
            ftp: 'resolved', view: 'resolved', viewfile: 'rejected', own: 'resolved', http: 'resolved', nourl: 'resolved',
        });
        t.expect('a create without url opens about:newtab (§16)', nourl && (await browser.tabs.get(nourl.id)).url, 'about:newtab');
        t.expect('an ftp url is accepted but the tab stays on about:blank (§16)', (await browser.tabs.get(t.id('ftp'))).url, 'about:blank');
    },
},

{
    id: 'R20.02',
    title: 'the accepted url classes in a NON-default container - about:blank, no url, about:home, view-source, an own extension page, http',
    async run(t) {
        await t.scene(['x']);
        await t.snap('before');

        await withContainer(t, async cookieStoreId => {
            const created = [];
            const verdicts = {};

            for (const [name, url] of CONTAINER_CASES) {
                const tab = await attempt(t, name, `{url: ${short(url)}, cookieStoreId: container}`, {url, cookieStoreId});

                verdicts[name] = tab ? 'resolved' : 'rejected';

                if (tab) {
                    created.push([name, tab]);
                }
            }

            const nourl = await attempt(t, 'nourl', 'no url, cookieStoreId: container', {cookieStoreId});

            verdicts.nourl = nourl ? 'resolved' : 'rejected';

            if (nourl) {
                created.push(['nourl', nourl]);
            }

            await t.step('let the created pages load', () => wait(LOAD_WAIT), {wait: 0, snap: 'loaded'});
            await describeCreated(t, created);

            const containers = {};

            for (const [name, tab] of created) {
                containers[name] = (await browser.tabs.get(tab.id)).cookieStoreId === cookieStoreId ? 'container' : 'elsewhere';
            }

            t.expect('the same verdicts in a container (CREATE-TABS-BEHAVIOR.md §17)', verdicts, {
                blank: 'resolved', newtab: 'rejected', home: 'rejected', view: 'resolved', own: 'resolved', http: 'resolved', nourl: 'resolved',
            });
            t.expect('every accepted tab lives in the requested container (§17)', containers, {
                blank: 'container', view: 'container', own: 'container', http: 'container', nourl: 'container',
            });
            t.expect('a create without url opens about:newtab in the container too (§17)', nourl && (await browser.tabs.get(nourl.id)).url, 'about:newtab');
        });
    },
},

{
    id: 'R20.03',
    title: 'top-level location.replace to a data: url from a page of the add-on - which content types the browser lets through',
    async run(t) {
        await t.scene(['x']);
        await t.snap('before');

        const outcomes = {};

        for (const [name, type, dataUrl] of DATA_CASES) {
            const outcome = await navigatePage(t, name, dataUrl);

            outcomes[type] = outcome.startsWith('navigated') ? 'navigated' : 'blocked';
            t.note(`${type}: ${outcome}`);
        }

        t.expect('which data: types a top-level navigation from an extension page reaches (CREATE-TABS-BEHAVIOR.md §18)', outcomes, {
            'image/png': 'navigated', 'image/gif': 'navigated', 'image/svg+xml': 'blocked',
            'application/pdf': 'navigated', 'application/json': 'navigated', 'text/json': 'navigated',
            'text/plain': 'blocked', 'text/html': 'blocked', 'video/mp4': 'blocked', '(no type)': 'blocked',
        });
    },
},

{
    id: 'R20.04',
    title: 'runtime.getBackgroundPage() and extension.getBackgroundPage() from an extension page - opened in the default container and in a non-default one',
    async run(t) {
        await t.scene(['x']);
        await t.snap('before');

        const reports = new Map();
        const handler = message => {
            if (message?.probe) {
                reports.set(message.probe, message);
            }
        };

        browser.runtime.onMessage.addListener(handler);
        t.listeners.push({target: browser.runtime.onMessage, handler});

        await attempt(t, 'default', 'probe.html, default container', {url: `${PROBE_URL}?probe=default`});

        await withContainer(t, async cookieStoreId => {
            await attempt(t, 'container', 'probe.html, cookieStoreId: container', {url: `${PROBE_URL}?probe=container`, cookieStoreId});
            await t.step('let the probes report', () => wait(LOAD_WAIT), {wait: 0, snap: 'reported'});

            for (const probe of ['default', 'container']) {
                const report = reports.get(probe);
                t.note(`${probe}: ${report ? JSON.stringify(report) : 'no report arrived'}`);
            }

            const visible = browser.extension.getViews({type: 'tab'})
                .filter(view => view.location.href.startsWith(PROBE_URL))
                .map(view => new URL(view.location.href).searchParams.get('probe'));

            t.note(`the background's extension.getViews({type: 'tab'}) sees these probes: ${visible.join(', ') || '(none)'}`);

            const answers = Object.fromEntries(['default', 'container'].map(probe => {
                const report = reports.get(probe);
                return [probe, report ? {runtime: report.runtimeGetBackgroundPage, extension: report.extensionGetBackgroundPage, reported: true} : {reported: false}];
            }));

            t.expect('the background page seen from an extension page, by container (CREATE-TABS-BEHAVIOR.md §19)', answers, {
                default: {runtime: 'window', extension: 'window', reported: true},
                container: {runtime: 'null', extension: 'null', reported: true},
            });
            t.expect('the background sees only the default-container page in getViews (§19)', visible, ['default']);
        });
    },
},

{
    id: 'R20.05',
    title: 'the url length limit of tabs.create - the exact byte boundary, and bytes versus characters',
    async run(t) {
        await t.scene(['x']);
        await t.snap('before');

        const encoder = new TextEncoder();
        const bytesOf = text => encoder.encode(text).length;
        const serializedLength = url => new URL(url).href.length;
        const base = `${sceneUrl('len', NETWORK_URL)}&pad=`;
        const ascii = chars => base + 'a'.repeat(chars - base.length);

        // a two-byte letter serializes to six characters (%D1%8F), the padding stops just short of the limit
        const encodedBase = base + 'я'.repeat(Math.floor((TABS_CREATE_URL_LIMIT - serializedLength(base)) / 6));
        const padded = length => encodedBase + 'a'.repeat(length - serializedLength(encodedBase));

        const cases = [
            [`${TABS_CREATE_URL_LIMIT} chars, ascii: the limit`, ascii(TABS_CREATE_URL_LIMIT)],
            [`${TABS_CREATE_URL_LIMIT + 1} chars, ascii: one over`, ascii(TABS_CREATE_URL_LIMIT + 1)],
            [`${TABS_CREATE_URL_LIMIT + 4} chars, ascii: 1 MiB`, ascii(TABS_CREATE_URL_LIMIT + 4)],
            [`${TABS_CREATE_URL_LIMIT + 5} chars, ascii: 1 MiB plus one`, ascii(TABS_CREATE_URL_LIMIT + 5)],
            ['524000 two-byte letters: under the limit in utf-8 bytes, far over it serialized', base + 'я'.repeat(524_000)],
            [`two-byte letters and ascii padded to a serialized length of exactly ${TABS_CREATE_URL_LIMIT}`, padded(TABS_CREATE_URL_LIMIT)],
            [`the same plus one character: serialized ${TABS_CREATE_URL_LIMIT + 1}`, padded(TABS_CREATE_URL_LIMIT + 1)],
        ];

        // the parser checks a pessimistic estimate of the escaped spec, so the last accepted length may depend on the shape of the url
        const shaped = (base, length) => base + 'a'.repeat(length - base.length);
        const ownBase = `${sceneUrl('len')}&pad=`;
        const userBase = `${sceneUrl('len', NETWORK_URL.replace('://', '://user@'))}&pad=`;

        cases.push(
            [`own page, a path with .html and a query, ${TABS_CREATE_URL_LIMIT} chars`, shaped(ownBase, TABS_CREATE_URL_LIMIT)],
            [`own page, a path with .html and a query, ${TABS_CREATE_URL_LIMIT - 1} chars`, shaped(ownBase, TABS_CREATE_URL_LIMIT - 1)],
            [`https with user@, ${TABS_CREATE_URL_LIMIT + 1} chars`, shaped(userBase, TABS_CREATE_URL_LIMIT + 1)],
            [`https with user@, ${TABS_CREATE_URL_LIMIT} chars`, shaped(userBase, TABS_CREATE_URL_LIMIT)],
        );

        const pick = (object, keys) => Object.fromEntries(keys.map(key => [key, object[key]]));
        const verdicts = {};
        const parses = {};

        const describeSerialized = (name, url) => {
            try {
                parses[name] = 'parses';
                return `${serializedLength(url)} serialized`;
            } catch (error) {
                parses[name] = 'throws';
                return `the URL constructor throws: ${shortError(error.message)}`;
            }
        };

        for (const [index, [label, url]] of cases.entries()) {
            const name = `len${index + 1}`;
            const tab = await attempt(t, name, `{url: ${label}, discarded: true}`, {url, discarded: true, title: name});

            verdicts[name] = tab ? 'resolved' : 'rejected';
            t.note(`${name}: ${verdicts[name]}, ${url.length} chars, ${bytesOf(url)} utf-8 bytes, ${describeSerialized(name, url)}`);
        }

        const settled = ['len1', 'len2', 'len3', 'len4', 'len5', 'len6', 'len7'];

        t.expect('the limit is 1048572 characters of the serialized url, not utf-8 bytes (CREATE-TABS-BEHAVIOR.md §20)', pick(verdicts, settled), {
            len1: 'resolved', len2: 'rejected', len3: 'rejected', len4: 'rejected', len5: 'rejected', len6: 'resolved', len7: 'rejected',
        });
        t.expect('the URL constructor enforces the same boundary (§20)', pick(parses, settled), {
            len1: 'parses', len2: 'throws', len3: 'throws', len4: 'throws', len5: 'throws', len6: 'parses', len7: 'throws',
        });
        t.expect('the boundary moves with the shape of the url: the own page with .html accepts 1048572 and 1048571, https with user@ accepts 1048573 and 1048572 (§20)', pick(verdicts, ['len8', 'len9', 'len10', 'len11']), {
            len8: 'resolved', len9: 'resolved', len10: 'resolved', len11: 'resolved',
        });
    },
},

{
    id: 'R20.06',
    title: 'webRequest.onBeforeRequest main_frame with <all_urls> - which loads are seen: http, an own extension page, about:blank, view-source, a data: navigation',
    async run(t) {
        await t.scene(['x']);
        await t.snap('before');

        t.require('webRequest API present', Boolean(browser.webRequest), 'the webRequest permission is missing from the manifest');

        const seen = [];
        const handler = details => {
            seen.push({at: t.ms(), tabId: details.tabId, type: details.type, url: details.url});
        };

        browser.webRequest.onBeforeRequest.addListener(handler, {urls: ['<all_urls>'], types: ['main_frame']});
        t.listeners.push({target: browser.webRequest.onBeforeRequest, handler});

        await attempt(t, 'http', `{url: ${NETWORK_URL}}`, {url: NETWORK_URL});
        await attempt(t, 'own', '{url: own page}', {url: sceneUrl('own')});
        await attempt(t, 'blank', '{url: about:blank}', {url: 'about:blank'});
        await attempt(t, 'view', `{url: view-source:${NETWORK_URL}}`, {url: `view-source:${NETWORK_URL}`});

        const [, , pngUrl] = DATA_CASES[0];
        t.note(`png: ${await navigatePage(t, 'png', pngUrl)}`);

        await t.step('let the loads finish', () => wait(LOAD_WAIT), {wait: 0, snap: 'loaded'});

        if (!seen.length) {
            t.note('webRequest saw nothing');
        }

        for (const {at, tabId, type, url} of seen) {
            t.note(`webRequest ${String(at).padStart(5)}ms  ${type}  ${t.known(tabId)}  ${short(url)}`);
        }

        t.expect('main_frame loads seen by webRequest: http and view-source with its inner url, nothing else (CREATE-TABS-BEHAVIOR.md §21)', seen.map(({tabId, url}) => `${t.known(tabId)} ${url}`), [
            `http ${NETWORK_URL}`,
            `view ${NETWORK_URL}`,
        ]);
    },
},

{
    id: 'R20.07',
    title: 'urls over the limit reached by navigation, not by tabs.create - the address arrives by message: can a page navigate to a data: image and to an https url over the limit, and does the tab then hold a url longer than the limit',
    async run(t) {
        await t.scene(['x']);
        await t.snap('before');

        const over = TABS_CREATE_URL_LIMIT + 100_000;
        const targets = [
            ['bigpng', 'data:image/png over the limit', `data:image/png;base64,${'A'.repeat(over)}`],
            ['bighttp', 'https url over the limit', `${sceneUrl('bighttp', NETWORK_URL)}&pad=${'a'.repeat(over)}`],
        ];

        const outcomes = {};

        for (const [name, label, target] of targets) {
            const tab = await attempt(t, name, `navigate.html, no ?to=  // ${label} will arrive by message`, {url: `${NAVIGATE_URL}?tab=${name}`});

            if (!tab) {
                outcomes[name] = 'not created';
                continue;
            }

            await wait(LOAD_WAIT);

            await t.step(`tabs.sendMessage(${name}, {action: navigate, to: ${label}, ${target.length} chars})`, () => {
                return browser.tabs.sendMessage(tab.id, {action: 'navigate', to: target}).then(
                    () => t.note(`${name}: the message was delivered`),
                    error => t.note(`${name}: sendMessage rejected - ${shortError(error.message)}`),
                );
            }, {wait: LOAD_WAIT, snap: name});

            const fresh = await browser.tabs.get(tab.id).catch(() => null);

            if (!fresh) {
                outcomes[name] = 'gone';
                t.note(`${name}: the tab is gone`);
                continue;
            }

            outcomes[name] = fresh.url === target ? 'navigated' : fresh.url.startsWith(NAVIGATE_URL) ? 'refused' : 'elsewhere';

            t.note(`${name}: ${outcomes[name]}${outcomes[name] === 'elsewhere' ? ` ${short(fresh.url)}` : ''}, tab url ${fresh.url.length} chars, the limit is ${TABS_CREATE_URL_LIMIT}, status ${fresh.status}`);
        }

        t.expect('a data: image over the limit is navigated to and held as the tab url, an https url over the limit is refused by location.replace itself (CREATE-TABS-BEHAVIOR.md §22)', outcomes, {
            bigpng: 'navigated',
            bighttp: 'refused',
        });
    },
},

];
