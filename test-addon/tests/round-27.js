import {NETWORK_URL, READER_URL, NAVIGATE_URL, POLL_WAIT, TIGHT_POLL_WAIT, LOAD_WAIT} from '../constants.js';
import {wait} from '../test.js';
import {sceneUrl, nameFromUrl, openedWindows, withContainer} from '../tabs.js';
import * as Sessions from '../sessions.js';

export const note = `Round 27 - reader mode and extension pages through the tabs API.
tabs.create refuses an about:reader url (BEHAVIOR-CREATE-TABS.md 16), so reader mode is driven
through the openInReaderMode flag, and every step prints what the tab reports: url,
isInReaderMode, isArticle, status, discarded. A background tab created with the flag, at the
resolve, once loaded, after tabs.discard and after activation (R27.01); the same tab created
discarded (R27.02); the flag on a page that cannot be put into reader mode (R27.03); the flag on
view-source, an own extension page, about:blank and no url (R27.04); the flag in a non-default
container (R27.05); tabs.update with an about:reader url, and tabs.create with one that wraps
view-source (R27.06); tabs.toggleReaderMode on an article and on a page that cannot be put into
reader mode, with the urls a webRequest main_frame listener and tabs.onUpdated deliver (R27.07);
a reader tab brought back by sessions.restore (R27.08) and by a browser restart (R27.09, stops
and asks for it); management.getSelf().hostPermissions against the extension's own origin, and
tabs.create with a moz-extension url of an unknown uuid and of an extension id (R27.10); R27.11
is MANUAL - the reader-mode button (F9) pressed by hand, to enter the reader view and to leave
it, with the same listeners armed; reader tabs hidden and discarded right after their creation,
before and after the reader url has committed, the shape of Groups.settleTabs on an unloaded group
(R27.12); what the URL constructor makes of an extension page address that names the extension by
its id, for every shape an id takes (R27.14); tabs.update with a url on a DISCARDED tab - born
discarded, discarded after its load, hidden, and born on a page of an unknown uuid, shown and
hidden (R27.15).
The expectations are the facts of BEHAVIOR-CREATE-TABS.md 30-35, 40, 41 and 53. Needs the network:
the article is a real page.`;

const UPDATED_KEYS = ['url', 'status', 'isArticle', 'discarded'];
const OWN_ORIGIN = browser.runtime.getURL('');

// the shapes an extension id takes, and a uuid next to them for comparison: the id, and the user
// name and the host the URL constructor reads it as (BEHAVIOR-CREATE-TABS.md 41)
const ID_SHAPES = [
    ['uuid', '9a1b7c52-3f0e-4d8a-b6c1-2e5f7a9d0c34', '', '9a1b7c52-3f0e-4d8a-b6c1-2e5f7a9d0c34'],
    ['name@domain', 'some-addon@example.com', 'some-addon', 'example.com'],
    ['Name@Domain', 'Some-Addon@Example.Com', 'Some-Addon', 'example.com'],
    ['name_name@domain', 'some_addon@example.com', 'some_addon', 'example.com'],
    ['@name', '@some-addon', '', 'some-addon'],
    ['{guid}', '{506e023c-7f2b-40a3-8066-bc5deb40aebe}', '', '{506e023c-7f2b-40a3-8066-bc5deb40aebe}'],
    ['{GUID}', '{66E978CD-981F-47DF-AC42-E3CF417C1467}', '', '{66e978cd-981f-47df-ac42-e3cf417c1467}'],
];

const readerUrl = url => `about:reader?url=${encodeURIComponent(url)}`;
const short = url => url.length > 90 ? `${url.slice(0, 87)}...` : url;
const shortError = message => message.length > 200 ? `${message.slice(0, 200)}...` : message;
const describe = tab => `url:${short(tab.url)} isInReaderMode:${tab.isInReaderMode} isArticle:${tab.isArticle} status:${tab.status} discarded:${tab.discarded}`;
const readerState = tab => ({url: tab.url, isInReaderMode: tab.isInReaderMode, discarded: tab.discarded});

async function attempt(t, name, label, properties, windowId = t.win) {
    const own = windowId === t.win;

    const tab = await t.step(`tabs.create(${label})`, async () => {
        try {
            const created = await browser.tabs.create({windowId, active: false, ...properties});

            t.bind(created.id, name);
            t.createdByAction.add(created.id);
            t.note(`${name} at the resolve: ${describe(created)}`);

            return created;
        } catch (error) {
            t.note(`${name}: rejected - ${shortError(error.message)}`);
            return null;
        }
    }, {snap: own ? name : false});

    if (!own) {
        await t.snapWindow(`${name} (second window)`, windowId);
    }

    return tab;
}

// a created tab starts on about:blank with status complete (BEHAVIOR-CREATE-TABS.md 12): the page
// is on it once the status is complete past that, or it never comes - a real load takes LOAD_WAIT
async function loaded(t, name) {
    const started = Date.now();

    while (true) {
        const tab = await browser.tabs.get(t.id(name)).catch(() => null);

        if (!tab || tab.discarded || (tab.status === 'complete' && tab.url !== 'about:blank')) {
            break;
        }

        if (Date.now() - started >= LOAD_WAIT) {
            t.note(`${name}: no page after ${LOAD_WAIT} ms, read as it is - ${describe(tab)}`);
            break;
        }

        await wait(POLL_WAIT);
    }

    await t.settled();

    return browser.tabs.get(t.id(name)).catch(() => null);
}

async function report(t, name, moment) {
    const tab = await loaded(t, name);

    t.note(tab ? `${name} ${moment}: ${describe(tab)}` : `${name} ${moment}: the tab is gone`);

    return tab;
}

function watchRequests(t) {
    t.require('webRequest API present', Boolean(browser.webRequest), 'the webRequest permission is missing from the manifest');

    const seen = [];
    const handler = details => {
        // the listener hears every window of the browser: only the tabs of the test and the requests of no tab count
        if (details.tabId !== browser.tabs.TAB_ID_NONE && !t.nameById.has(details.tabId)) {
            return;
        }

        const tab = details.tabId === browser.tabs.TAB_ID_NONE ? 'no tab' : t.known(details.tabId);
        const origin = details.originUrl ? short(details.originUrl.replace(OWN_ORIGIN, '<own page>/')) : 'none';

        seen.push(details.url);
        t.record('webRequest.onBeforeRequest', `${tab}  ${details.method} ${details.type} frame:${details.frameId}  ${short(details.url)}  origin: ${origin}`);
    };

    browser.webRequest.onBeforeRequest.addListener(handler, {urls: ['<all_urls>'], types: ['main_frame']});
    t.listeners.push({target: browser.webRequest.onBeforeRequest, handler});

    return seen;
}

function attemptCall(t, name, label, call, snap = name) {
    return t.step(label, async () => {
        try {
            const result = await call();

            t.note(`${name}: resolved${result?.url ? ` with ${describe(result)}` : ''}`);

            return result;
        } catch (error) {
            t.note(`${name}: rejected - ${shortError(error.message)}`);
            return null;
        }
    }, {snap});
}

async function activate(t, name) {
    await t.step(`tabs.update(${name}, {active: true})`, () => browser.tabs.update(t.id(name), {active: true}), {snap: `${name} activated`});
    return report(t, name, 'activated and loaded');
}

export const tests = [

{
    id: 'R27.01',
    title: 'tabs.create({url: article, openInReaderMode: true}) as a background tab - what the tab reports at the resolve, once loaded, after tabs.discard and after activation; the urls webRequest and tabs.onUpdated deliver on the way',
    async run(t) {
        await t.scene(['x']);
        t.watch(['tabs.onUpdated'], {updatedKeys: UPDATED_KEYS});
        const seen = watchRequests(t);
        await t.snap('before');

        const tab = await attempt(t, 'reader', '{url: article, openInReaderMode: true}', {url: READER_URL, openInReaderMode: true});

        t.require('the create resolved', tab !== null);
        t.expect('at the resolve the tab is about:blank without the flag (BEHAVIOR-CREATE-TABS.md §30)', {url: tab.url, isInReaderMode: tab.isInReaderMode}, {url: 'about:blank', isInReaderMode: false});

        const loadedTab = await report(t, 'reader', 'loaded');
        t.expect('loaded: the reader url with isInReaderMode (§30)', readerState(loadedTab), {url: readerUrl(READER_URL), isInReaderMode: true, discarded: false});

        await t.step('tabs.discard(reader)', () => browser.tabs.discard(t.id('reader')), {snap: 'discarded'});
        const discarded = await report(t, 'reader', 'discarded');
        t.expect('discarded: the reader url and the flag stay (§30)', readerState(discarded), {url: readerUrl(READER_URL), isInReaderMode: true, discarded: true});

        const activated = await activate(t, 'reader');
        t.expect('activated: the reader page is back with the same url (§30)', readerState(activated), {url: readerUrl(READER_URL), isInReaderMode: true, discarded: false});
        t.expectRow('reader activated', ['x', '➕reader*']);
        t.expect('no main_frame request reaches webRequest for the reader page (§30)', seen.length, 0);
    },
},

{
    id: 'R27.02',
    title: 'tabs.create({url: article, openInReaderMode: true, discarded: true}) - does a tab born discarded already report the reader url, and what it loads when activated',
    async run(t) {
        await t.scene(['x']);
        t.watch(['tabs.onUpdated'], {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        const tab = await attempt(t, 'lazy', '{url: article, openInReaderMode: true, discarded: true, title: lazy}', {url: READER_URL, openInReaderMode: true, discarded: true, title: 'lazy'});

        t.expect('a discarded create with the flag is refused (BEHAVIOR-CREATE-TABS.md §30)', tab === null, true);

        if (!tab) {
            return;
        }

        t.note(`lazy read again after the step: ${describe(await browser.tabs.get(tab.id))}`);

        await activate(t, 'lazy');
    },
},

{
    id: 'R27.03',
    title: 'openInReaderMode: true on a page the browser cannot put into reader mode - is the create refused, and what the tab ends up on',
    async run(t) {
        await t.scene(['x']);
        t.watch(['tabs.onUpdated'], {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        const tab = await attempt(t, 'plain', `{url: ${NETWORK_URL}, openInReaderMode: true}`, {url: NETWORK_URL, openInReaderMode: true});

        t.require('the create resolved', tab !== null);

        const loadedTab = await report(t, 'plain', 'loaded');
        t.expect('the tab lands on the reader url all the same (BEHAVIOR-CREATE-TABS.md §30)', readerState(loadedTab), {url: readerUrl(NETWORK_URL), isInReaderMode: true, discarded: false});

        const activated = await activate(t, 'plain');
        t.expect('and stays there once activated (§30)', readerState(activated), {url: readerUrl(NETWORK_URL), isInReaderMode: true, discarded: false});
    },
},

{
    id: 'R27.04',
    title: 'openInReaderMode: true with a view-source url, an own extension page, about:blank and no url at all - which are refused, and what the accepted ones report',
    async run(t) {
        await t.scene(['x']);
        await t.snap('before');

        const cases = [
            ['view', `view-source:${NETWORK_URL}`],
            ['own', sceneUrl('own')],
            ['blank', 'about:blank'],
        ];

        const verdicts = {};
        const landed = {};

        for (const [name, url] of cases) {
            const tab = await attempt(t, name, `{url: ${short(url)}, openInReaderMode: true}`, {url, openInReaderMode: true});

            verdicts[name] = tab ? 'resolved' : 'rejected';

            if (tab) {
                const fresh = await report(t, name, 'loaded');
                landed[name] = {url: fresh.url, isInReaderMode: fresh.isInReaderMode};
            }
        }

        const nourl = await attempt(t, 'nourl', '{openInReaderMode: true}, no url', {openInReaderMode: true});

        verdicts.nourl = nourl ? 'resolved' : 'rejected';

        if (nourl) {
            const fresh = await report(t, 'nourl', 'settled');
            landed.nourl = {url: fresh.url, isInReaderMode: fresh.isInReaderMode};
        }

        t.expect('every call resolves (BEHAVIOR-CREATE-TABS.md §30)', verdicts, {view: 'resolved', own: 'resolved', blank: 'resolved', nourl: 'resolved'});
        t.expect('view-source, an own page and about:blank stay on about:blank without the flag, no url opens about:newtab (§30)', landed, {
            view: {url: 'about:blank', isInReaderMode: false},
            own: {url: 'about:blank', isInReaderMode: false},
            blank: {url: 'about:blank', isInReaderMode: false},
            nourl: {url: 'about:newtab', isInReaderMode: false},
        });
    },
},

{
    id: 'R27.05',
    title: 'openInReaderMode: true together with cookieStoreId - does the reader tab open in the container',
    async run(t) {
        await t.scene(['x']);
        await t.snap('before');

        await withContainer(t, async cookieStoreId => {
            const tab = await attempt(t, 'reader', '{url: article, openInReaderMode: true, cookieStoreId: container}', {url: READER_URL, openInReaderMode: true, cookieStoreId});

            t.require('the create resolved', tab !== null);

            const fresh = await report(t, 'reader', 'loaded');

            t.note(`reader container: ${fresh?.cookieStoreId} (${fresh?.cookieStoreId === cookieStoreId ? 'the requested one' : 'NOT the requested one'})`);
            t.expect('the reader page opens in the requested container (BEHAVIOR-CREATE-TABS.md §30)', {...readerState(fresh), container: fresh.cookieStoreId === cookieStoreId}, {url: readerUrl(READER_URL), isInReaderMode: true, discarded: false, container: true});
        });
    },
},

{
    id: 'R27.06',
    title: 'tabs.update({url: about:reader?url=...}) on a live tab - wrapping an article, a view-source url and a page that cannot be put into reader mode; tabs.create with an about:reader url that wraps view-source',
    async run(t) {
        await t.scene(['x', 'y', 'z']);
        t.watch(['tabs.onUpdated'], {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        const cases = [
            ['x', readerUrl(READER_URL)],
            ['y', readerUrl(`view-source:${NETWORK_URL}`)],
            ['z', readerUrl(NETWORK_URL)],
        ];

        const verdicts = {};
        const stayed = {};

        for (const [name, url] of cases) {
            // an accepted update takes the scene name out of the url: the settle must not wait for it to come back
            t.expected.delete(t.id(name));

            const updated = await attemptCall(t, name, `tabs.update(${name}, {url: ${short(url)}})`, () => browser.tabs.update(t.id(name), {url}), `${name} updated`);
            const fresh = await report(t, name, 'settled');

            verdicts[name] = updated ? 'resolved' : 'rejected';
            stayed[name] = nameFromUrl(fresh.url) === name;
        }

        const created = await attempt(t, 'created', `{url: ${short(readerUrl(`view-source:${NETWORK_URL}`))}}`, {url: readerUrl(`view-source:${NETWORK_URL}`)});

        t.expect('tabs.update refuses an about:reader url whatever it wraps (BEHAVIOR-CREATE-TABS.md §31)', verdicts, {x: 'rejected', y: 'rejected', z: 'rejected'});
        t.expect('the tabs stay on their pages (§31)', stayed, {x: true, y: true, z: true});
        t.expect('tabs.create refuses an about:reader url whatever it wraps (§16, §31)', created === null, true);
    },
},

{
    id: 'R27.07',
    title: 'tabs.toggleReaderMode on a loaded article, on and off again, and on a page that cannot be put into reader mode - the urls webRequest and tabs.onUpdated deliver, and what the tab reports after each toggle',
    async run(t) {
        await t.scene(['x']);
        await t.snap('before');

        const article = await attempt(t, 'article', '{url: article}', {url: READER_URL});
        const plain = await attempt(t, 'plain', `{url: ${NETWORK_URL}}`, {url: NETWORK_URL});

        t.require('both pages were created', article !== null && plain !== null);

        const inBackground = await report(t, 'article', 'loaded in the background');
        await report(t, 'plain', 'loaded in the background');

        t.watch(['tabs.onUpdated'], {updatedKeys: UPDATED_KEYS});
        const seen = watchRequests(t);

        let toggled = await attemptCall(t, 'article', 'tabs.toggleReaderMode(article)  // a background tab', () => browser.tabs.toggleReaderMode(t.id('article')).then(() => true), 'reader on');

        t.expect('a background tab has no isArticle and cannot be toggled (BEHAVIOR-CREATE-TABS.md §32)', {isArticle: inBackground.isArticle, toggle: toggled ? 'resolved' : 'rejected'}, {isArticle: undefined, toggle: 'rejected'});

        // a background tab may never be judged an article: the toggle is tried again once the tab has been shown
        if (toggled === null) {
            const shown = await activate(t, 'article');
            t.expect('once shown, the article has isArticle: true (§32)', shown.isArticle, true);

            toggled = await attemptCall(t, 'article', 'tabs.toggleReaderMode(article)  // the active tab', () => browser.tabs.toggleReaderMode(t.id('article')).then(() => true), 'reader on');
        }

        const on = await report(t, 'article', 'after the toggle on');
        t.expect('the toggle on the shown article resolves and puts it on the reader url (§32)', {toggle: toggled ? 'resolved' : 'rejected', ...readerState(on), isArticle: on.isArticle}, {toggle: 'resolved', url: readerUrl(READER_URL), isInReaderMode: true, discarded: false, isArticle: false});

        if (toggled) {
            const toggledBack = await attemptCall(t, 'article', 'tabs.toggleReaderMode(article) again', () => browser.tabs.toggleReaderMode(t.id('article')).then(() => true), 'reader off');
            const off = await report(t, 'article', 'after the toggle off');

            t.expect('the toggle off brings the plain url back (§32)', {toggle: toggledBack ? 'resolved' : 'rejected', ...readerState(off), isArticle: off.isArticle}, {toggle: 'resolved', url: READER_URL, isInReaderMode: false, discarded: false, isArticle: true});
        }

        await activate(t, 'plain');
        const plainToggled = await attemptCall(t, 'plain', 'tabs.toggleReaderMode(plain)  // the active tab', () => browser.tabs.toggleReaderMode(t.id('plain')).then(() => true), 'plain toggled');
        const plainAfter = await report(t, 'plain', 'after the toggle');

        t.expect('a page that is not an article is refused even when shown (§32)', {toggle: plainToggled ? 'resolved' : 'rejected', url: plainAfter.url, isArticle: plainAfter.isArticle}, {toggle: 'rejected', url: NETWORK_URL, isArticle: undefined});
        t.expect('no main_frame request reaches webRequest for either toggle (§32)', seen.length, 0);
    },
},

{
    id: 'R27.08',
    title: 'a closed window with a reader tab brought back by sessions.restore() - what the session record holds, what the fresh tab reports, and what it loads when activated',
    async run(t) {
        await t.scene(['keep']);

        const winId = await t.buildWindow(['w']);

        t.trackWindow(winId);
        await t.snapWindow('before (second window)', winId);

        const tab = await attempt(t, 'reader', '{url: article, openInReaderMode: true} in the second window', {url: READER_URL, openInReaderMode: true}, winId);

        t.require('the create resolved', tab !== null);

        await report(t, 'reader', 'loaded');
        await t.snapWindow('before close (second window)', winId);

        const knownSessions = await Sessions.knownSessionIds();

        await t.step('windows.remove(second)', () => {
            openedWindows.delete(winId);
            return browser.windows.remove(winId);
        }, {snap: false});

        const session = await Sessions.findClosedWindowSession(['w'], knownSessions);

        t.require('the closed window is in sessions.getRecentlyClosed', session !== null, 'no NEW window session holding w');

        for (const record of session.window.tabs) {
            t.note(`session record: url:${short(record.url)}; keys: ${Object.keys(record).sort().join(', ')}`);
        }

        t.expect('the session record holds the reader url (BEHAVIOR-CREATE-TABS.md §33)', session.window.tabs.map(record => record.url), [sceneUrl('w'), readerUrl(READER_URL)]);

        const restored = await t.step('sessions.restore(sessionId of the window)', () => browser.sessions.restore(session.window.sessionId), {wait: 0, snap: false});
        const restoredWinId = restored.window.id;

        openedWindows.add(restoredWinId);

        const after = await t.settleRestored(restoredWinId, ['w']);

        t.require('the restored window is populated', after !== null, 'the visible tabs never finished loading');
        t.bindFresh(after);

        const back = after.find(candidate => nameFromUrl(candidate.url) === null);

        t.require('the reader tab came back', Boolean(back), 'every tab of the restored window carries a scene name');
        t.bind(back.id, 'reader');

        await t.snapWindow('restored (second window)', restoredWinId);
        t.note(`reader restored: ${describe(back)}`);
        t.expectRow('restored (second window)', ['w*', 'reader']);
        t.expect('restored: discarded, on the reader url, with the flag (§33)', readerState(back), {url: readerUrl(READER_URL), isInReaderMode: true, discarded: true});

        await t.step('tabs.update(reader, {active: true})', () => browser.tabs.update(back.id, {active: true}), {snap: false});
        const activated = await report(t, 'reader', 'activated and loaded');
        await t.snapWindow('activated (second window)', restoredWinId);

        t.expect('activated: the reader page loads on the same url (§33)', readerState(activated), {url: readerUrl(READER_URL), isInReaderMode: true, discarded: false});
    },
},

{
    id: 'R27.09',
    title: 'browser restart with a reader tab in the window - what the restored tab reports before and after it is activated',
    async run(t) {
        await t.scene(['x']);

        const tab = await attempt(t, 'reader', '{url: article, openInReaderMode: true}', {url: READER_URL, openInReaderMode: true});

        t.require('the reader tab was created', tab !== null);

        await report(t, 'reader', 'loaded');
        await t.snap('before restart');

        await t.restart();
    },
    async afterRestart(t) {
        await t.settled();

        const back = (await t.query()).find(candidate => nameFromUrl(candidate.url) === null);

        t.require('the reader tab is in the scene window after the restart', Boolean(back), 'every tab of the scene window carries a scene name');
        t.bind(back.id, 'reader');

        await t.snap('after restart');
        t.note(`reader after the restart: ${describe(back)}`);
        t.expectRow('after restart', ['x*', 'reader']);
        t.expect('after the restart: discarded, on the reader url, with the flag (BEHAVIOR-CREATE-TABS.md §33)', readerState(back), {url: readerUrl(READER_URL), isInReaderMode: true, discarded: true});

        const activated = await activate(t, 'reader');
        t.expect('activated: the reader page loads on the same url (§33)', readerState(activated), {url: readerUrl(READER_URL), isInReaderMode: true, discarded: false});
    },
},

{
    id: 'R27.10',
    title: 'management.getSelf().hostPermissions - is the extension\'s own moz-extension origin listed; tabs.create with a moz-extension url of an unknown uuid and of an extension id',
    async run(t) {
        await t.scene(['x']);
        await t.snap('before');

        const self = await browser.management.getSelf();
        const ownOrigin = browser.runtime.getURL('');
        const listed = self.hostPermissions?.some(pattern => pattern.startsWith(ownOrigin));

        t.note(`getSelf: id ${self.id}; hostPermissions: ${JSON.stringify(self.hostPermissions)}`);
        t.note(`the own origin is ${listed ? 'listed' : 'NOT listed'} in hostPermissions`);
        t.expect('hostPermissions names the extension\'s own origin (BEHAVIOR-CREATE-TABS.md §34)', listed, true);

        const cases = [
            ['unknown', `moz-extension://${crypto.randomUUID()}/tab.html?tab=unknown`],
            ['idform', `moz-extension://${self.id}/tab.html?tab=idform`],
        ];

        const verdicts = {};
        const landed = {};

        for (const [name, url] of cases) {
            const tab = await attempt(t, name, `{url: ${short(url)}}`, {url});

            verdicts[name] = tab ? 'resolved' : 'rejected';

            if (tab) {
                landed[name] = (await report(t, name, 'loaded')).url;
            }
        }

        t.expect('both urls are accepted by tabs.create (§34)', verdicts, {unknown: 'resolved', idform: 'resolved'});
        t.expect('and both tabs stay on about:blank (§34)', landed, {unknown: 'about:blank', idform: 'about:blank'});
    },
},

{
    id: 'R27.11',
    title: 'MANUAL: the reader-mode button (F9) pressed by hand on a shown article, to enter the reader view and to leave it - the requests webRequest gets, the urls tabs.onUpdated delivers, and what the tab reports after either press',
    async run(t) {
        await t.scene(['x']);

        const article = await attempt(t, 'article', '{url: article}', {url: READER_URL});

        t.require('the article was created', article !== null);

        await report(t, 'article', 'loaded in the background');
        await activate(t, 'article');

        t.watch(['tabs.onUpdated'], {updatedKeys: UPDATED_KEYS});
        const seen = watchRequests(t);
        const pressed = {};

        for (const [moment, aim, wanted] of [['entered', 'to enter the reader view', 'the reader view'], ['left', 'to leave the reader view', 'the plain page']]) {
            const before = seen.length;

            t.act(`the user presses F9 in the article tab ${aim}`);
            await t.ask(`press F9 (or the reader-view icon in the address bar) in the article tab, the active tab of the scene window; wait for ${wanted}, then answer: done`);
            await t.settled();
            await t.snap(moment);

            const tab = await report(t, 'article', moment);

            pressed[moment] = {...readerState(tab), isArticle: tab.isArticle, requests: seen.length - before};

            t.note(`main_frame requests, reader view ${moment}: ${seen.length - before}${seen.length > before ? ` - ${seen.slice(before).map(short).join(' | ')}` : ''}`);
        }

        t.expect('the reader button takes the tab into the reader view and back, with no main_frame request either way (BEHAVIOR-CREATE-TABS.md §40)', pressed, {
            entered: {url: readerUrl(READER_URL), isInReaderMode: true, discarded: false, isArticle: false, requests: 0},
            left: {url: READER_URL, isInReaderMode: false, discarded: false, isArticle: true, requests: 0},
        });
    },
},

{
    id: 'R27.12',
    title: 'reader tabs created with the flag and hidden + discarded right away - before their url has committed, and once it has committed but the load still runs (the shape of Groups.settleTabs on an unloaded group): do they keep the reader url, and what they load when shown and activated',
    async run(t) {
        await t.scene(['x']);
        t.watch(['tabs.onUpdated'], {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        const createBatch = async names => {
            const tabs = await Promise.all(names.map(name => browser.tabs.create({windowId: t.win, active: false, url: READER_URL, openInReaderMode: true}).then(tab => {
                t.bind(tab.id, name);
                t.createdByAction.add(tab.id);
                return tab;
            })));

            t.note(`at the resolve: ${tabs.map(tab => `${t.nameOf(tab)} ${describe(tab)}`).join(' | ')}`);

            return tabs;
        };

        const hideAndDiscard = async (tabs, moment) => {
            const ids = tabs.map(tab => tab.id);
            const fresh = await Promise.all(ids.map(id => browser.tabs.get(id)));

            t.note(`${moment}: ${fresh.map(tab => `${t.nameOf(tab)} ${describe(tab)}`).join(' | ')}`);

            const hidden = await browser.tabs.hide(ids);

            t.note(`tabs.hide: hid ${hidden.length} of ${ids.length}`);

            await browser.tabs.discard(ids).then(() => t.note('tabs.discard resolved'), error => t.note(`tabs.discard rejected - ${shortError(error.message)}`));
        };

        const early = ['e1', 'e2', 'e3'];
        const committed = ['c1', 'c2', 'c3'];

        const states = async (names, moment) => {
            const result = {};

            for (const name of names) {
                result[name] = readerState(await report(t, name, moment));
            }

            return result;
        };

        const blank = {url: 'about:blank', isInReaderMode: false, discarded: true};
        const reader = {url: readerUrl(READER_URL), isInReaderMode: true, discarded: true};

        await t.step('tabs.create x3 ({url: article, openInReaderMode: true}) in parallel, then tabs.hide and tabs.discard at once', async () => {
            const tabs = await createBatch(early);
            await hideAndDiscard(tabs, 'at the discard');
        }, {snap: 'early batch hidden and discarded'});

        t.expectRow('early batch hidden and discarded', ['x*', '➕e1(h)', '➕e2(h)', '➕e3(h)']);
        t.expect('discarded before the url committed: about:blank, no flag (BEHAVIOR-CREATE-TABS.md §35)', await states(early, 'after hide + discard'), {e1: blank, e2: blank, e3: blank});

        await t.step('tabs.create x3 in parallel, wait until every url reads about:reader, then tabs.hide and tabs.discard', async () => {
            const tabs = await createBatch(committed);
            const started = Date.now();

            while (Date.now() - started < LOAD_WAIT) {
                const fresh = await Promise.all(tabs.map(tab => browser.tabs.get(tab.id)));

                if (fresh.every(tab => tab.url.startsWith('about:reader'))) {
                    break;
                }

                await wait(TIGHT_POLL_WAIT);
            }

            await hideAndDiscard(tabs, `at the discard, ${Date.now() - started} ms after the resolve`);
        }, {snap: 'committed batch hidden and discarded'});

        t.expectRow('committed batch hidden and discarded', ['x*', '➕e1(h)', '➕e2(h)', '➕e3(h)', '➕c1(h)', '➕c2(h)', '➕c3(h)']);
        t.expect('discarded once the url committed: the reader url and the flag stay (§35)', await states(committed, 'after hide + discard'), {c1: reader, c2: reader, c3: reader});

        await t.step('tabs.show(all six)', () => browser.tabs.show(t.ids([...early, ...committed])), {snap: 'shown'});

        t.expectRow('shown', ['x*', '➕e1', '➕e2', '➕e3', '➕c1', '➕c2', '➕c3']);
        t.expect('shown, still discarded: nothing changes (§35)', await states([...early, ...committed], 'shown'), {e1: blank, e2: blank, e3: blank, c1: reader, c2: reader, c3: reader});

        const loadedReader = {...reader, discarded: false};

        t.expect('activated: both load the reader page (§35)', {e1: readerState(await activate(t, 'e1')), c1: readerState(await activate(t, 'c1'))}, {e1: loadedReader, c1: loadedReader});
        t.expectRow('e1 activated', ['x', '➕e1*', '➕e2', '➕e3', '➕c1', '➕c2', '➕c3']);
        t.expectRow('c1 activated', ['x', '➕e1', '➕e2', '➕e3', '➕c1*', '➕c2', '➕c3']);
    },
},

{
    id: 'R27.14',
    title: 'new URL() on the address of an extension page that names the extension by its id - for every shape an id takes: does the constructor accept it, what it reads as the user name, the host, the path, the query and the hash, and does the address come back unchanged',
    async run(t) {
        const path = '/dir/page.html';
        const search = `?url=${encodeURIComponent(NETWORK_URL)}&x=1`;
        const hash = '#part';
        const got = {};
        const want = {};

        for (const [shape, id, username, host] of ID_SHAPES) {
            const start = `moz-extension://${id}`;
            const url = `${start}${path}${search}${hash}`;

            want[shape] = {username, host, start: `moz-extension://${username && `${username}@`}${host}`, read: true};

            try {
                const parsed = new URL(url);
                const parts = ['username', 'host', 'pathname', 'search', 'hash', 'origin'].map(key => `${key}:"${parsed[key]}"`);

                got[shape] = {
                    username: parsed.username,
                    host: parsed.host,
                    start: parsed.href.slice(0, parsed.href.indexOf(path)),
                    read: parsed.pathname === path && parsed.search === search && parsed.hash === hash && parsed.searchParams.get('url') === NETWORK_URL,
                };

                t.note(`${shape} (${id}): parsed, href ${parsed.href === url ? 'unchanged' : `CHANGED to ${parsed.href}`}; ${parts.join(' ')}; searchParams url:"${parsed.searchParams.get('url')}"`);

                parsed.searchParams.set('x', '2');

                t.note(`${shape}: after searchParams.set the address ${parsed.href.startsWith(`${start}/`) ? 'still starts' : 'NO LONGER starts'} with the id - ${parsed.href}`);
            } catch (error) {
                got[shape] = 'throws';
                t.note(`${shape} (${id}): the constructor throws - ${shortError(error.message)}`);
            }
        }

        t.expect('every shape is parsed and its path, query and hash are read; the host comes back in lower case and a leading @ is gone (BEHAVIOR-CREATE-TABS.md §41)', got, want);
    },
},

{
    id: 'R27.15',
    title: 'tabs.update({url, loadReplace: true}) on a DISCARDED tab - a tab born discarded, a tab discarded after its load, a hidden discarded one, and two born discarded on a page of an unknown uuid, one of them hidden: does the call resolve, what the tab reports at the resolve and once settled, does it stay discarded, and what it shows once activated',
    async run(t) {
        const unknownOrigin = `moz-extension://${crypto.randomUUID()}/`;
        const mask = text => text.replaceAll(OWN_ORIGIN, '<own page>/').replaceAll(unknownOrigin, '<unknown uuid>/');

        // the page a tab is on before the update, and the one the update asks for: another page of the add-on under the same name
        const from = {
            born: sceneUrl('born'),
            unloaded: sceneUrl('unloaded'),
            hidden: sceneUrl('hidden'),
            dead: `${unknownOrigin}tab.html?tab=dead`,
            deadhidden: `${unknownOrigin}tab.html?tab=deadhidden`,
        };
        const to = name => sceneUrl(name, NAVIGATE_URL);
        const place = (tab, name) => tab.url === to(name) ? 'on the new page' : tab.url === from[name] ? 'on the old page' : `on ${short(mask(tab.url))}`;
        const tell = (tab, name) => tab ? `${place(tab, name)}, status ${tab.status}, discarded ${tab.discarded}, hidden ${tab.hidden}` : 'the tab is gone';
        const read = name => browser.tabs.get(t.id(name)).catch(() => null);
        const refused = (name, error) => t.note(`${name}: rejected - ${mask(shortError(error.message))}`);

        const create = (name, label, properties = {}) => t.step(`tabs.create(${label})`, async () => {
            const tab = await browser.tabs.create({windowId: t.win, active: false, url: from[name], ...properties});

            t.bind(tab.id, name);
            t.createdByAction.add(tab.id);
        }, {snap: name});

        t.mask = mask;

        await t.scene(['x']);
        t.watch(['tabs.onUpdated'], {updatedKeys: ['url', 'status', 'discarded']});
        await t.snap('before');

        await create('born', '{url: own page, discarded: true, title}', {discarded: true, title: 'born'});

        for (const name of ['unloaded', 'hidden']) {
            await create(name, '{url: own page}');
            await loaded(t, name);
        }

        await t.step('tabs.discard([unloaded, hidden])', () => browser.tabs.discard(t.ids(['unloaded', 'hidden'])), {snap: 'discarded'});

        // the shape of a tab another install of an add-on left behind
        for (const name of ['dead', 'deadhidden']) {
            await create(name, '{url: moz-extension://<unknown uuid>/tab.html, discarded: true, title}', {discarded: true, title: name});
        }

        const names = Object.keys(from);
        const hidden = ['hidden', 'deadhidden'];

        await t.step(`tabs.hide([${hidden.join(', ')}])`, () => browser.tabs.hide(t.ids(hidden)), {snap: 'hidden'});

        const scene = await Promise.all(names.map(read));

        for (const [index, name] of names.entries()) {
            t.note(`${name} before the update: ${tell(scene[index], name)}`);
        }

        t.require('every tab is discarded and on its page, hidden and deadhidden are hidden', scene.every((tab, index) => tab?.discarded === true && tab.url === from[names[index]] && tab.hidden === hidden.includes(names[index])));

        const got = {};

        for (const name of names) {
            const result = await t.step(`tabs.update(${name}, {url: <another own page>, loadReplace: true})`, () => {
                return browser.tabs.update(t.id(name), {url: to(name), loadReplace: true}).catch(error => {
                    refused(name, error);
                    return null;
                });
            }, {snap: `${name} updated`});

            got[name] = {atResolve: result ? tell(result, name) : 'rejected', settled: tell(await read(name), name)};

            t.note(`${name} at the resolve: ${got[name].atResolve}`);
            t.note(`${name} settled: ${got[name].settled}`);
        }

        await t.step(`tabs.show([${hidden.join(', ')}])`, () => browser.tabs.show(t.ids(hidden)).catch(error => refused('tabs.show', error)), {snap: 'shown'});

        for (const name of names) {
            await t.step(`tabs.update(${name}, {active: true})`, () => browser.tabs.update(t.id(name), {active: true}).catch(error => refused(name, error)), {wait: LOAD_WAIT, snap: `${name} activated`});

            got[name].activated = tell(await read(name), name);

            t.note(`${name} activated: ${got[name].activated}`);
        }

        const updated = isHidden => ({
            atResolve: `on about:blank, status complete, discarded false, hidden ${isHidden}`,
            settled: `on the new page, status complete, discarded false, hidden ${isHidden}`,
            activated: 'on the new page, status complete, discarded false, hidden false',
        });

        t.expectRow('deadhidden updated', ['x*', '➕born', '➕unloaded', '➕hidden(h)', '➕dead', '➕deadhidden(h)']);
        t.expect('the update loads a discarded tab on the new page, a hidden one stays hidden, a tab of an unknown uuid alike (BEHAVIOR-CREATE-TABS.md §53)', got, Object.fromEntries(names.map(name => [name, updated(hidden.includes(name))])));
    },
},

];
