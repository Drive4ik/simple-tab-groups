import {HOLD_WAIT, LOAD_WAIT, NETWORK_URL, NOISY_UPDATE_KEYS} from '../constants.js';
import {wait} from '../test.js';
import {TabsTest, sceneUrl} from '../tabs.js';

export const note = `Round 21 - the FIRST load of a new tab: in which order the add-on hears about it.
STG gives a tab its group in tabs.onCreated and decides about the container and the catch rules in
webRequest.onBeforeRequest of the same first load, so the order of the two events and the distance
between them is all its request handler may rely on. Every test prints one timeline: tabs.onCreated
with the url and status the event carries, webRequest.onBeforeRequest from a BLOCKING listener
without a window filter, the resolve of the call that made the tab, and tabs.onUpdated {url, status}.
The request listener probes the tab before it lets the request go: tabs.get, then
sessions.setTabValue with how long it took, and after the load the value is read back with
sessions.getTabValue. A tab made by tabs.create with an http url (R21.01). The same while the
listener keeps holding the request for ${HOLD_WAIT} ms after the probe, to see whether tabs.onCreated
and the resolve of tabs.create still arrive during the hold (R21.02). window.open from a page of the
add-on (R21.03). Two MANUAL tests, a middle-click on a link in a page of the add-on (R21.04) and on
the only link of a web page (R21.05). In the manual tests the clock starts at the question, so only
the distances between events mean anything. The listener has no window filter on purpose, so a
main-frame load in any other window shows up in the events as unknownN and is held like the rest.
Needs the webRequest, webRequestBlocking and <all_urls> permissions of the manifest.`;

const LINK_URL = browser.runtime.getURL('link.html');
const PROBE_KEY = 'probe';
const PROBE_VALUE = 'set from onBeforeRequest';
const WATCH = ['tabs.onCreated', 'tabs.onUpdated'];
const UPDATED_KEYS = ['url', 'status'];

const short = url => url.length > 60 ? `${url.slice(0, 57)}...` : url;

class FirstLoadTest extends TabsTest {
    constructor(options) {
        super(options);

        this.createdSeen = new Set();
        this.marks = new Map();
        this.held = [];
        this.requestIds = new Map();
        this.firstRequest = new Map();
    }

    mark(tabId, event) {
        const marks = this.marks.get(tabId) ?? new Map();

        if (!marks.has(event)) {
            marks.set(event, this.ms());
        }

        this.marks.set(tabId, marks);
    }

    eventFormatters() {
        return {
            ...super.eventFormatters(),
            'tabs.onCreated': ([tab]) => {
                if (tab.windowId !== this.win) {
                    return null;
                }

                this.createdSeen.add(tab.id);
                this.mark(tab.id, 'tabs.onCreated');

                return () => `${this.known(tab.id)}  index:${tab.index} url:${short(tab.url)} status:${tab.status}`;
            },
            'tabs.onUpdated': ([tabId, changeInfo, tab], {updatedKeys}) => {
                if (tab.windowId !== this.win) {
                    return null;
                }

                const keys = Object.keys(changeInfo).filter(key => {
                    return updatedKeys ? updatedKeys.includes(key) : !NOISY_UPDATE_KEYS.includes(key);
                });

                if (!keys.length) {
                    this.data.dropped++;
                    return null;
                }

                const shown = keys.map(key => `${key}: ${key === 'url' ? short(changeInfo[key]) : changeInfo[key]}`);

                return () => `${this.known(tabId)}  {${shown.join(', ')}}`;
            },
        };
    }

    listenRequests({hold = 0} = {}) {
        this.require('webRequest API present', Boolean(browser.webRequest?.onBeforeRequest), 'the webRequest permission is missing from the manifest');

        const handler = details => {
            const created = this.createdSeen.has(details.tabId);
            const previous = this.requestIds.get(details.tabId);
            const which = previous === undefined
                ? 'the first request of the tab'
                : previous === details.requestId ? 'the same requestId as the previous hop, a redirect' : 'a new requestId';

            this.requestIds.set(details.tabId, details.requestId);

            if (previous === undefined) {
                this.firstRequest.set(details.tabId, {created, hops: 1, oneRequestId: true});
            } else {
                const first = this.firstRequest.get(details.tabId);

                first.hops++;
                first.oneRequestId &&= previous === details.requestId;
            }

            this.mark(details.tabId, 'webRequest.onBeforeRequest');
            this.record('webRequest.onBeforeRequest', () => `${this.known(details.tabId)}  ${short(details.url)}  ${which}, tabs.onCreated delivered before this: ${created}`);

            const release = this.probe(details.tabId)
                .then(() => hold && wait(hold))
                .then(() => {
                    this.record('webRequest.onBeforeRequest', () => `${this.known(details.tabId)}  released${hold ? ` after holding the request ${hold} ms more` : ''}`);
                    return {};
                });

            this.held.push(release);

            return release;
        };

        try {
            browser.webRequest.onBeforeRequest.addListener(handler, {urls: ['<all_urls>'], types: ['main_frame']}, ['blocking']);
        } catch (error) {
            this.require('blocking webRequest listener registered', false, `${error.message}, is the webRequestBlocking permission missing from the manifest?`);
        }

        this.listeners.push({target: browser.webRequest.onBeforeRequest, handler});
    }

    async probe(tabId) {
        const tab = await browser.tabs.get(tabId).catch(error => ({error: error.message}));
        const got = tab.error
            ? `rejected, ${tab.error}`
            : `url:${short(tab.url)} status:${tab.status} index:${tab.index} in the scene window:${tab.windowId === this.win}`;

        this.record('probe tabs.get', () => `${this.known(tabId)}  ${got}`);

        const started = this.ms();
        const set = await browser.sessions.setTabValue(tabId, PROBE_KEY, PROBE_VALUE).then(
            () => 'ok',
            error => `rejected, ${error.message}`,
        );
        const took = this.ms() - started;

        this.record('probe setTabValue', () => `${this.known(tabId)}  ${set}, took ${took} ms`);

        const first = this.firstRequest.get(tabId);

        if (first && first.probed === undefined) {
            first.probed = {get: !tab.error, set: set === 'ok'};
        }
    }

    async released() {
        await Promise.allSettled(this.held);
        await this.settled();
    }

    async readBack(name) {
        const value = await browser.sessions.getTabValue(this.id(name), PROBE_KEY).catch(error => `rejected, ${error.message}`);

        this.expect(`${name}: sessions.getTabValue after the load returns the value set from inside onBeforeRequest (CREATE-TABS-BEHAVIOR.md §24)`, value === PROBE_VALUE ? 'the value' : JSON.stringify(value), 'the value');
    }

    async idsNow() {
        return new Set((await this.query()).map(tab => tab.id));
    }

    async adopt(name, idsBefore) {
        const windowsBefore = (await browser.windows.getAll({windowTypes: ['normal']})).length;

        await this.settled({until: state => state.tabs.some(tab => !idsBefore.has(tab.id))});

        const fresh = (await this.query()).find(tab => !idsBefore.has(tab.id));

        if (!fresh) {
            const windowsNow = (await browser.windows.getAll({windowTypes: ['normal']})).length;

            this.note(`${name}: no new tab appeared in the scene window, normal windows before: ${windowsBefore}, now: ${windowsNow}`);
            return null;
        }

        this.bind(fresh.id, name);
        this.createdByAction.add(fresh.id);

        return fresh;
    }

    summarize(name) {
        const marks = this.marks.get(this.id(name));

        if (!marks) {
            this.note(`${name}: no event recorded for it`);
            return;
        }

        const order = [...marks].sort((a, b) => a[1] - b[1]).map(([event, at]) => `${event} at ${at} ms`).join(' → ');

        this.note(`${name}: ${order}`);

        const created = marks.get('tabs.onCreated');
        const request = marks.get('webRequest.onBeforeRequest');

        if (created === undefined || request === undefined) {
            this.note(`${name}: ${created === undefined ? 'tabs.onCreated' : 'webRequest.onBeforeRequest'} was never delivered`);
        } else {
            this.note(`${name}: ${created <= request ? 'tabs.onCreated came first' : 'webRequest.onBeforeRequest came first'}, ${Math.abs(request - created)} ms apart`);
        }

        const first = this.firstRequest.get(this.id(name));

        this.expect(`${name}: tabs.onCreated is delivered before the first onBeforeRequest of the tab (CREATE-TABS-BEHAVIOR.md §23)`, first?.created, true);
        this.expect(`${name}: inside that listener tabs.get resolves and sessions.setTabValue succeeds (§24)`, first?.probed, {get: true, set: true});

        if (first?.hops > 1) {
            this.expect(`${name}: all ${first.hops} hops of the first load share one requestId (§25)`, first.oneRequestId, true);
        }
    }
}

export const testClass = FirstLoadTest;

async function createWithUrl(t, name) {
    await t.step(`tabs.create({url: http?tab=${name}, active: false})`, async () => {
        const tab = await browser.tabs.create({windowId: t.win, url: sceneUrl(name, NETWORK_URL), active: false});

        t.mark(tab.id, 'tabs.create resolved');
        t.record('tabs.create', () => `${t.known(tab.id)}  resolved`);
        t.bind(tab.id, name);
        t.createdByAction.add(tab.id);
        t.expected.set(tab.id, name);
    }, {snap: false});

    await t.released();
    await t.snap('after');
    await t.readBack(name);
    t.summarize(name);
}

async function openLinkPage(t, to) {
    const tab = await browser.tabs.create({windowId: t.win, url: `${LINK_URL}?tab=page&to=${encodeURIComponent(to)}`, active: true});

    t.bind(tab.id, 'page');
    t.expected.set(tab.id, 'page');

    await t.settled();
    await wait(LOAD_WAIT);

    return tab;
}

async function finishOpened(t, idsBefore, {named = true} = {}) {
    const opened = await t.adopt('opened', idsBefore);

    if (opened && named) {
        t.expected.set(opened.id, 'opened');
    }

    await t.released();
    await t.snap('after');

    if (opened) {
        await t.readBack('opened');
        t.summarize('opened');
    }
}

export const tests = [

{
    id: 'R21.01',
    title: 'tabs.create with an http url: tabs.onCreated against webRequest.onBeforeRequest of the first load, and the tab as the request listener sees it',
    async run(t) {
        await t.scene(['x']);

        t.listenRequests();
        t.watch(WATCH, {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        await createWithUrl(t, 'new');
    },
},

{
    id: 'R21.02',
    title: `tabs.create with an http url while the blocking listener HOLDS the request ${HOLD_WAIT} ms after the probe: do tabs.onCreated and the resolve of tabs.create arrive during the hold`,
    async run(t) {
        await t.scene(['x']);

        t.listenRequests({hold: HOLD_WAIT});
        t.watch(WATCH, {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        await createWithUrl(t, 'new');
    },
},

{
    id: 'R21.03',
    title: 'window.open from a page of the add-on: the same timeline for a tab the page opened',
    async run(t) {
        await t.scene(['x']);

        const to = sceneUrl('opened', NETWORK_URL);
        const page = await openLinkPage(t, to);

        t.listenRequests();
        t.watch(WATCH, {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        const idsBefore = await t.idsNow();

        await t.step('tabs.sendMessage(page, {action: open})  // the page calls window.open(http?tab=opened, _blank)', async () => {
            const reply = await browser.tabs.sendMessage(page.id, {action: 'open', to}).catch(error => ({error: error.message}));

            t.record('window.open', () => reply.error ? `sendMessage rejected, ${reply.error}` : `returned ${reply.opened ? 'a window' : 'null (blocked)'}`);
        }, {wait: 0, snap: false});

        await finishOpened(t, idsBefore);
    },
},

{
    id: 'R21.04',
    title: 'MANUAL: a middle-click on a link in a page of the add-on, the timeline for a tab the USER opened',
    async run(t) {
        await t.scene(['x']);

        await openLinkPage(t, sceneUrl('opened', NETWORK_URL));

        t.listenRequests();
        t.watch(WATCH, {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        const idsBefore = await t.idsNow();

        t.act('USER: middle-click the link on the active page');
        await t.ask('The active tab of the scene window shows one link. MIDDLE-CLICK it (or Ctrl+click) so it opens in a new tab, wait for that page to load, then T.visualAnswer("done")');

        await finishOpened(t, idsBefore);
    },
},

{
    id: 'R21.05',
    url: NETWORK_URL,
    title: 'MANUAL: a middle-click on the only link of a WEB page, the timeline for a tab the user opened from web content',
    async run(t) {
        await t.scene(['x']);

        t.listenRequests();
        t.watch(WATCH, {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        const idsBefore = await t.idsNow();

        t.act('USER: middle-click the only link of the web page');
        await t.ask('The active tab of the scene window is a web page with a single link. MIDDLE-CLICK it (or Ctrl+click) so it opens in a new tab, wait for that page to load, then T.visualAnswer("done")');

        await finishOpened(t, idsBefore, {named: false});
    },
},

];
