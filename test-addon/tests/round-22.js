import {TIGHT_POLL_WAIT, WINDOW_READ_WAIT, SETTLE_TIMEOUT, NETWORK_URL} from '../constants.js';
import {wait} from '../test.js';
import {TabsTest, sceneUrl, nameFromUrl, openedWindows} from '../tabs.js';
import * as Sessions from '../sessions.js';

export const note = `Round 22 - a window appears: what its ACTIVE tab reports while the first page is on the way.
STG reads a window ${WINDOW_READ_WAIT} ms after windows.onCreated (GrandRestore) and, for an active tab that
still shows an empty page, takes the url from its own mirror. The guard there is "active", not
"loading": the active tab of a window that has just appeared is assumed to be loading. Here the
active tab is sampled every ${TIGHT_POLL_WAIT} ms from windows.onCreated, and every change of its url, status
and discarded flag is printed with its time, until the read moment has passed and the load is
complete. The line "at the read moment" is the state STG would see, with the distance from
windows.onCreated. The tabs a tabs.query issued from the windows.onCreated handler returned are
printed too, and every tabs.onCreated carries url, status and discarded. An empty url is one of
about:blank, about:newtab, about:home, the same three STG treats as empty. If the tab sampled
first no longer exists at the end, its lines keep an unknownN name: the browser replaced it
instead of loading it. A window created with one http url (R22.01) and with three (R22.02), a
window created without a url (R22.03), a closed window of three http tabs brought back by
sessions.restore, the API behind undo close (R22.04).`;

const EMPTY_URLS = new Set(['about:blank', 'about:newtab', 'about:home']);
const WATCH = ['windows.onCreated', 'tabs.onCreated', 'tabs.onUpdated', 'tabs.onActivated'];
const UPDATED_KEYS = ['url', 'status'];

const short = url => url.length > 60 ? `${url.slice(0, 57)}...` : url;
const isEmpty = url => EMPTY_URLS.has(url);

class WindowBirthTest extends TabsTest {
    constructor(options) {
        super(options);

        this.born = null;
        this.births = [];
        this.atBirth = null;
        this.othersAtBirth = null;
        this.atRead = null;
    }

    stateOf(tab) {
        return {empty: isEmpty(tab.url), status: tab.status, discarded: tab.discarded};
    }

    winTag(windowId) {
        if (windowId === undefined || windowId === this.win) {
            return '';
        }

        return windowId === this.born ? '  [born]' : '  [other window]';
    }

    describeTab(tab) {
        return `url:${short(tab.url)} status:${tab.status} discarded:${tab.discarded}`;
    }

    eventFormatters() {
        return {
            ...super.eventFormatters(),
            'windows.onCreated': ([win]) => () => `${win.id === this.born ? 'born' : 'another'}  type:${win.type}`,
            'tabs.onCreated': ([tab]) => () => `${this.known(tab.id)}  index:${tab.index} active:${tab.active} ${this.describeTab(tab)}${this.winTag(tab.windowId)}`,
            'tabs.onActivated': ([info]) => () => `${this.known(info.tabId)}${this.winTag(info.windowId)}`,
            'tabs.onUpdated': ([tabId, changeInfo, tab], {updatedKeys}) => {
                const keys = Object.keys(changeInfo).filter(key => updatedKeys.includes(key));

                if (!keys.length) {
                    this.data.dropped++;
                    return null;
                }

                const shown = keys.map(key => `${key}: ${key === 'url' ? short(changeInfo[key]) : changeInfo[key]}`);

                return () => `${this.known(tabId)}  {${shown.join(', ')}}${this.winTag(tab.windowId)}`;
            },
        };
    }

    watchBirth() {
        const handler = win => {
            if (win.type !== 'normal' || this.born !== null) {
                return;
            }

            this.born = win.id;
            openedWindows.add(win.id);
            this.trackWindow(win.id);
            this.births.push(this.sampleActive(win.id, this.ms()));
        };

        browser.windows.onCreated.addListener(handler);
        this.listeners.push({target: browser.windows.onCreated, handler});
    }

    async sampleActive(windowId, bornAt) {
        const tabs = await browser.tabs.query({windowId});

        this.record('windows.onCreated+query', () => `${tabs.length} tab(s): ${tabs.map(tab => `${this.known(tab.id)}${tab.active ? '*' : ''} ${this.describeTab(tab)}`).join(' | ')}`, bornAt);

        const activeAtBirth = tabs.find(tab => tab.active);

        this.atBirth = activeAtBirth ? this.stateOf(activeAtBirth) : null;
        this.othersAtBirth = tabs.filter(tab => !tab.active).map(tab => this.stateOf(tab));

        let last = null;
        let readMomentShown = false;

        while (this.ms() - bornAt < SETTLE_TIMEOUT) {
            const [active] = await browser.tabs.query({windowId, active: true});

            if (!active) {
                this.record('active tab', 'no active tab in the window');
                return;
            }

            const state = this.describeTab(active);
            const sinceBorn = this.ms() - bornAt;
            const pastRead = sinceBorn >= WINDOW_READ_WAIT;

            if (state !== last) {
                this.record('active tab', () => `${this.known(active.id)}  ${state}`);
                last = state;
            }

            if (pastRead && !readMomentShown) {
                readMomentShown = true;
                this.atRead = this.stateOf(active);
                this.record('at the read moment', () => `${this.known(active.id)}  ${state}  empty url:${isEmpty(active.url)}  ${sinceBorn} ms after windows.onCreated`);
            }

            if (pastRead && active.status === 'complete') {
                return;
            }

            await wait(TIGHT_POLL_WAIT);
        }

        this.record('active tab', 'sampling gave up after the timeout');
    }

    async finishBirth(label, names = null) {
        this.require('windows.onCreated was delivered for the new window', this.born !== null, 'no normal window appeared');

        await Promise.allSettled(this.births);

        if (names) {
            await this.waitWindowLoaded(this.born, names);
        }

        const settled = await this.settled();
        const action = this.data.rows.findLast(row => row.kind === 'action');

        if (action && !action.timing) {
            action.timing = `settled ${settled.ms} ms`;
        }

        const tabs = (await browser.tabs.query({windowId: this.born})).sort((a, b) => a.index - b.index);

        for (const tab of tabs) {
            const name = nameFromUrl(tab.url);

            this.bind(tab.id, name ?? `tab${tab.index}`);
            this.createdByAction.add(tab.id);
        }

        this.row(label, tabs.map(tab => this.cell(tab)));
        await this.snap('after (scene window)');

        for (const tab of tabs) {
            this.note(`${this.known(tab.id)}${tab.active ? ' (active)' : ''}: ${this.describeTab(tab)}`);
        }

        this.untrackWindow(this.born);
        await browser.windows.remove(this.born).catch(() => {});
        openedWindows.delete(this.born);
    }

    expectBirth({others = null, atRead}) {
        this.expect('the active tab at windows.onCreated: an empty url with status complete, not loading yet (CREATE-TABS-BEHAVIOR.md §26)', this.atBirth, {empty: true, status: 'complete', discarded: false});

        if (others) {
            this.expect('the other tabs at windows.onCreated (§27)', this.othersAtBirth, others);
        }

        this.expect('the active tab at the read moment (§26)', this.atRead, atRead);
    }
}

const LOADED = {empty: false, status: 'complete', discarded: false};
const BLANK = {empty: true, status: 'complete', discarded: false};
const DISCARDED_WITH_URL = {empty: false, status: 'complete', discarded: true};

export const testClass = WindowBirthTest;

async function createWindow(t, label, properties, names) {
    await t.scene(['x']);

    t.watchBirth();
    t.watch(WATCH, {updatedKeys: UPDATED_KEYS});
    await t.snap('before (scene window)');

    await t.step(label, () => browser.windows.create(properties), {wait: 0, snap: false});
    await t.finishBirth('after (born window)', names);
}

export const tests = [

{
    id: 'R22.01',
    title: 'windows.create with one http url: the active tab from windows.onCreated until the load completes',
    async run(t) {
        await createWindow(t, 'windows.create({url: http?tab=a})', {url: sceneUrl('a', NETWORK_URL)}, ['a']);
        t.expectBirth({atRead: LOADED});
    },
},

{
    id: 'R22.02',
    title: 'windows.create with three http urls: the active tab and the two others',
    async run(t) {
        const names = ['a', 'b', 'c'];

        await createWindow(t, 'windows.create({url: [http?tab=a, http?tab=b, http?tab=c]})', {url: names.map(name => sceneUrl(name, NETWORK_URL))}, names);
        t.expectBirth({others: [BLANK, BLANK], atRead: LOADED});
    },
},

{
    id: 'R22.03',
    title: 'windows.create without a url: the active tab of a window whose first page is an empty one',
    async run(t) {
        await createWindow(t, 'windows.create()', {});
        t.expectBirth({atRead: BLANK});
    },
},

{
    id: 'R22.04',
    url: NETWORK_URL,
    title: 'sessions.restore of a closed window with three http tabs, the API behind undo close: the active tab and the others from windows.onCreated',
    async run(t) {
        await t.scene(['x']);

        const names = ['p', 'a', 'b'];
        const winId = await t.buildWindow(names);

        const before = (await browser.tabs.query({windowId: winId})).sort((a, b) => a.index - b.index);

        t.row('before (second window)', before.map(tab => t.cell(tab)));
        await t.snap('before (scene window)');

        t.watchBirth();
        t.watch(WATCH, {updatedKeys: UPDATED_KEYS});

        const knownSessions = await Sessions.knownSessionIds();

        await t.step('windows.remove(second)', () => {
            openedWindows.delete(winId);
            return browser.windows.remove(winId);
        }, {snap: false});

        for (const tab of before) {
            t.bind(tab.id, `old-${nameFromUrl(tab.url)}`);
        }

        const session = await Sessions.findClosedWindowSession(names, knownSessions);
        t.require('the closed window is in sessions.getRecentlyClosed', session !== null, `no new window session holding ${names.join(', ')}`);

        await t.step('sessions.restore(sessionId of the window)', () => browser.sessions.restore(session.window.sessionId), {wait: 0, snap: false});
        await t.finishBirth('restored (born window)', names);
        t.expectBirth({others: [DISCARDED_WITH_URL, DISCARDED_WITH_URL], atRead: LOADED});
    },
},

];
