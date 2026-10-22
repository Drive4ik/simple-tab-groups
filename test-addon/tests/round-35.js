import {TIGHT_POLL_WAIT, WINDOW_READ_WAIT, QUIET_WAIT, POLL_WAIT, SETTLE_TIMEOUT, ACTION_WAIT, LOAD_WAIT, NETWORK_URL} from '../constants.js';
import {wait} from '../test.js';
import {TabsTest, nameFromUrl, openedWindows} from '../tabs.js';
import * as Sessions from '../sessions.js';

const TAB_COUNT = 1000;
const LOADED_COUNT = 100;
const PINNED_COUNT = 5;
const CREATE_CHUNK = 100;
const COUNT_STEP = 100;

export const note = `Round 35 - a closed window of ${TAB_COUNT} tabs brought back by sessions.restore, the API behind
undo close, with ${PINNED_COUNT} pinned tabs at its head and ${LOADED_COUNT} tabs loaded before the close: what a
tabs.query issued as the FIRST line of the windows.onCreated handler returns, and how the window fills
from that moment - the count of tabs, of pinned tabs and of loaded tabs, re-read every ${TIGHT_POLL_WAIT} ms,
a line at every ${COUNT_STEP} tabs and at every change of the pinned or the loaded count, with the state at
${WINDOW_READ_WAIT} ms marked: the moment the grand restore of the add-on reads the window (R35.01). The
tabs.onCreated of the pinned tabs are printed one by one with their index; the other tabs.onCreated
are counted, with the first and the last moment; tabs.onUpdated is kept for the pinned key only. The
first tab of a restored window is created before windows.onCreated (BEHAVIOR-CREATE-TABS.md §28), so
the events are collected first and sorted out once the restored window is known. Needs the network:
the tabs are ${NETWORK_URL} pages.`;

class RestoreScaleTest extends TabsTest {
    constructor(options) {
        super(options);

        this.born = null;
        this.birth = null;
        this.firstQuery = null;
        this.foreign = new Set();
        this.creations = [];
    }

    nameOf(tab) {
        return nameFromUrl(tab.url) ?? this.known(tab.id);
    }

    // the normal windows that exist before the restore, the scene window aside: their events are not ours
    async rememberWindows() {
        const windows = await browser.windows.getAll({windowTypes: ['normal']});
        this.foreign = new Set(windows.map(win => win.id).filter(id => id !== this.win));
    }

    isForeign(windowId) {
        return windowId !== undefined && windowId !== this.win && this.foreign.has(windowId);
    }

    winTag(windowId) {
        if (windowId === undefined || windowId === this.win) {
            return '';
        }

        return windowId === this.born ? '  [born]' : '  [other window]';
    }

    describeTabs(tabs) {
        const pinned = tabs.filter(tab => tab.pinned);
        const loaded = tabs.filter(tab => !tab.discarded && tab.status === 'complete');
        const active = tabs.find(tab => tab.active);
        const at = tab => `${this.nameOf(tab)}@${tab.index}`;

        return `${tabs.length} tab(s), ${pinned.length} pinned [${pinned.map(at).join(' ')}], ${loaded.length} loaded, ${tabs.filter(tab => tab.discarded).length} discarded, active: ${active ? at(active) : '-'}`;
    }

    eventFormatters() {
        return {
            ...super.eventFormatters(),
            'windows.onCreated': ([win]) => () => `${win.id === this.born ? 'born' : 'another'}  type:${win.type}`,
            // the born window is known only from windows.onCreated, and its first tab is created before that
            'tabs.onCreated': ([tab]) => {
                if (tab.windowId !== this.win && !this.isForeign(tab.windowId)) {
                    this.creations.push({at: this.ms(), tab});
                }

                return null;
            },
            'tabs.onUpdated': ([tabId, changeInfo, tab], {updatedKeys}) => {
                if (this.isForeign(tab.windowId)) {
                    return null;
                }

                const keys = Object.keys(changeInfo).filter(key => updatedKeys.includes(key));

                if (!keys.length) {
                    this.data.dropped++;
                    return null;
                }

                return () => `${this.known(tabId)}  {${keys.map(key => `${key}: ${changeInfo[key]}`).join(', ')}}${this.winTag(tab.windowId)}`;
            },
            'tabs.onActivated': ([info]) => {
                return this.isForeign(info.windowId) ? null : () => `${this.known(info.tabId)}${this.winTag(info.windowId)}`;
            },
        };
    }

    watchBirth() {
        const handler = win => {
            if (win.type !== 'normal' || this.born !== null || this.isForeign(win.id)) {
                return;
            }

            this.born = win.id;
            openedWindows.add(win.id);
            this.trackWindow(win.id);
            this.birth = this.sample(win.id, this.ms());
        };

        browser.windows.onCreated.addListener(handler);
        this.listeners.push({target: browser.windows.onCreated, handler});
    }

    // the query is the first line of the handler; then the window is re-read until it holds every tab and stays quiet
    async sample(windowId, bornAt) {
        const first = await browser.tabs.query({windowId});
        const resolvedAt = this.ms() - bornAt;

        this.firstQuery = first;
        this.record('windows.onCreated+query', () => `${this.describeTabs(first)}  (the query resolved ${resolvedAt} ms after windows.onCreated)`, bornAt);

        let last = null;
        let changedAt = 0;
        let readShown = false;

        while (this.ms() - bornAt < SETTLE_TIMEOUT) {
            const tabs = await browser.tabs.query({windowId});
            const sinceBorn = this.ms() - bornAt;
            const key = [Math.floor(tabs.length / COUNT_STEP), tabs.filter(tab => tab.pinned).length, tabs.filter(tab => !tab.discarded && tab.status === 'complete').length].join(':');

            if (key !== last) {
                this.record('window', () => `${this.describeTabs(tabs)}  ${sinceBorn} ms after windows.onCreated`);
                last = key;
                changedAt = sinceBorn;
            }

            if (!readShown && sinceBorn >= WINDOW_READ_WAIT) {
                readShown = true;
                this.record('at the read moment', () => `${this.describeTabs(tabs)}  ${sinceBorn} ms after windows.onCreated`);
            }

            if (readShown && tabs.length >= TAB_COUNT && sinceBorn - changedAt >= QUIET_WAIT) {
                return;
            }

            await wait(TIGHT_POLL_WAIT);
        }

        this.record('window', 'sampling gave up after the timeout');
    }

    async waitBorn() {
        const started = Date.now();

        while (this.born === null && Date.now() - started < SETTLE_TIMEOUT) {
            await wait(TIGHT_POLL_WAIT);
        }

        this.require('windows.onCreated was delivered for the restored window', this.born !== null, `no new normal window within ${SETTLE_TIMEOUT} ms`);
    }

    async finishBirth(label) {
        await this.waitBorn();
        await this.birth;

        const settled = await this.settled();
        const action = this.data.rows.findLast(row => row.kind === 'action');

        if (action && !action.timing) {
            action.timing = `settled ${settled.ms} ms`;
        }

        const tabs = (await browser.tabs.query({windowId: this.born})).sort((a, b) => a.index - b.index);

        // the lines of the events are rendered at the flush: the fresh ids get their names first
        this.bindFresh(tabs);

        const creations = this.creations.filter(({tab}) => tab.windowId === this.born);
        const plain = creations.filter(({tab}) => !tab.pinned);

        for (const {at, tab} of creations.filter(({tab}) => tab.pinned)) {
            this.record('tabs.onCreated', () => `${this.known(tab.id)}  index:${tab.index} pinned:true active:${tab.active} discarded:${tab.discarded}  [born]`, at);
        }

        if (plain.length) {
            this.record('tabs.onCreated', `${plain.length} more, not pinned, between ${plain[0].at} ms and ${plain.at(-1).at} ms  [born]`, plain.at(-1).at);
        }

        this.queued.sort((a, b) => a.at - b.at);

        this.note(`${label}: ${this.describeTabs(tabs)}`);
        this.note(`${label}, head: ${tabs.slice(0, PINNED_COUNT + 3).map(tab => this.cell(tab)).join(' | ')}`);

        await this.snap('after (scene window)');

        const count = list => ({tabs: list.length, pinned: list.filter(tab => tab.pinned).length, loaded: list.filter(tab => !tab.discarded && tab.status === 'complete').length});

        this.expect('the query at windows.onCreated returns the whole window, the pinned tabs flagged (BEHAVIOR-CREATE-TABS.md §59)', count(this.firstQuery), {tabs: TAB_COUNT, pinned: PINNED_COUNT, loaded: PINNED_COUNT});
        this.expect('the pinned tabs are created with pinned: true (§59)', creations.filter(({tab}) => tab.pinned).length, PINNED_COUNT);
        this.expect('the pinned tabs come back loaded, every other tab discarded (§59)', count(tabs), {tabs: TAB_COUNT, pinned: PINNED_COUNT, loaded: PINNED_COUNT});

        return tabs;
    }
}

export const testClass = RestoreScaleTest;

async function waitLoaded(windowId, names) {
    const started = Date.now();

    while (Date.now() - started < SETTLE_TIMEOUT) {
        const tabs = await browser.tabs.query({windowId});
        const loaded = tabs.filter(tab => names.includes(nameFromUrl(tab.url)) && !tab.discarded && tab.status === 'complete');

        if (loaded.length === names.length) {
            return loaded.length;
        }

        await wait(POLL_WAIT);
    }

    return null;
}

export const tests = [

{
    id: 'R35.01',
    url: NETWORK_URL,
    title: `sessions.restore of a closed window of ${TAB_COUNT} tabs, ${PINNED_COUNT} pinned at its head, ${LOADED_COUNT} loaded before the close: what tabs.query returns at the first line of windows.onCreated, and how the window fills until the read moment of the add-on`,
    async run(t) {
        await t.scene(['x']);

        const names = Array.from({length: TAB_COUNT}, (_, index) => `t${index}`);
        const winId = await t.buildWindow([names[0]]);

        t.trackWindow(winId);

        for (let start = 1; start < TAB_COUNT; start += CREATE_CHUNK) {
            await Promise.all(names.slice(start, start + CREATE_CHUNK).map((name, offset) => {
                return browser.tabs.create({
                    windowId: winId,
                    url: t.tabUrl(name),
                    index: start + offset,
                    active: false,
                    discarded: true,
                    title: name,
                }).then(tab => t.bind(tab.id, name));
            }));
        }

        await t.settled();

        {
            const actual = (await browser.tabs.query({windowId: winId})).sort((a, b) => a.index - b.index).map(tab => nameFromUrl(tab.url) ?? '?');
            t.require(`the second window holds the ${TAB_COUNT} tabs in order`, actual.join(',') === names.join(','), `${actual.length} tab(s), head [${actual.slice(0, 8).join(', ')}]`);
        }

        const toLoad = names.slice(0, LOADED_COUNT);

        await Promise.all(toLoad.map(name => browser.tabs.reload(t.id(name))));

        t.require(`the first ${LOADED_COUNT} tabs are loaded`, await waitLoaded(winId, toLoad) !== null, `not all of them loaded within ${SETTLE_TIMEOUT} ms`);

        await wait(LOAD_WAIT);

        for (const name of names.slice(0, PINNED_COUNT)) {
            await browser.tabs.update(t.id(name), {pinned: true});
        }

        await browser.tabs.update(t.id(names[0]), {active: true});
        await wait(ACTION_WAIT);

        const before = (await browser.tabs.query({windowId: winId})).sort((a, b) => a.index - b.index);
        const idsBefore = new Set(before.map(tab => tab.id));

        t.note(`before the close: ${t.describeTabs(before)}`);
        t.note(`before the close, head: ${before.slice(0, PINNED_COUNT + 3).map(tab => t.cell(tab)).join(' | ')}`);
        await t.snap('before (scene window)');

        const knownSessions = await Sessions.knownSessionIds();

        await t.step('windows.remove(second)', () => {
            openedWindows.delete(winId);
            return browser.windows.remove(winId);
        }, {snap: false});

        const session = await Sessions.findClosedWindowSession([names[0], names[PINNED_COUNT], names.at(-1)], knownSessions);
        t.require('the closed window is in sessions.getRecentlyClosed', session !== null, 'no new window session holding the tabs');

        const sessionPinned = session.window.tabs.filter(tab => tab.pinned);
        t.note(`session record: ${session.window.tabs.length} tabs, ${sessionPinned.length} pinned [${sessionPinned.map(tab => `${nameFromUrl(tab.url)}@${tab.index}`).join(' ')}]`);
        t.expect('the session record flags no pinned tab (BEHAVIOR-CREATE-TABS.md §59)', sessionPinned.length, 0);

        await t.rememberWindows();
        t.watchBirth();
        t.watch(['windows.onCreated', 'tabs.onCreated', 'tabs.onUpdated', 'tabs.onActivated'], {updatedKeys: ['pinned']});

        await t.step('sessions.restore(sessionId of the window)', () => browser.sessions.restore(session.window.sessionId), {wait: 0, snap: false});

        const after = await t.finishBirth('restored');

        const reused = after.filter(tab => idsBefore.has(tab.id)).length;

        t.note(`tab ids reused after the restore: ${reused} of ${after.length} (0 = all fresh)`);
        t.expect('every tab id is fresh (§59)', reused, 0);
    },
},

];
