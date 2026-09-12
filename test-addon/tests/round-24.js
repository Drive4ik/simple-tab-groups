import {TabsTest, nameFromUrl, openedWindows} from '../tabs.js';
import * as Sessions from '../sessions.js';

export const note = `Round 24 — sessions.setTabValue values and sessions.restore(), the API behind "undo close
tab" (Ctrl+Shift+T) and "undo close window" (Ctrl+Shift+N). A restored tab comes back with a FRESH id
(OPENER-BEHAVIOR §15, §16); the question is whether the value set on the old id rides along, and when:
every tabs.onCreated is probed with sessions.getTabValue right inside the handler ("probe getTabValue",
with how long the read took), and the value is read again once the restore has settled. A single closed
tab (R24.01); a closed window with a loaded active tab, a background tab that comes back discarded
(CREATE-TABS-BEHAVIOR §27) and a hidden member (R24.02); a write from inside tabs.onCreated of the
restored tab against the value the restore brings — which one is there at the end, the shape of the
STG onCreated handler that binds a new tab to the window's group (R24.03); a sessions.setWindowValue
value across the restore of its window, probed from every tabs.onCreated of the restored window
(the first one precedes windows.onCreated) and from windows.onCreated (R24.04). A read that finds nothing is printed as "none", a rejected read as
"rejected, <message>".`;

const VALUE_KEY = 'testKey';
const WRITTEN_VALUE = 'written-inside-onCreated';
const WATCH = ['windows.onCreated', 'windows.onRemoved', 'tabs.onCreated', 'tabs.onRemoved', 'tabs.onUpdated', 'tabs.onActivated'];
const UPDATED_KEYS = ['hidden', 'discarded'];

const shown = value => value === undefined ? 'none' : JSON.stringify(value);

// a browser message may spell the raw tab id - masked, real ids never reach the report
const rejected = error => `rejected, ${error.message.replace(/\d+/g, '<id>')}`;

async function readValue(tabId) {
    return browser.sessions.getTabValue(tabId, VALUE_KEY).then(shown, rejected);
}

async function readWindowValue(windowId) {
    return browser.sessions.getWindowValue(windowId, VALUE_KEY).then(shown, rejected);
}

class RestoreValueTest extends TabsTest {
    constructor(options) {
        super(options);
        this.probes = new Map(); // tabId → what getTabValue returned inside tabs.onCreated
        this.windowProbes = []; // what getWindowValue returned inside each tabs.onCreated / windows.onCreated
        this.closedWin = null;
        this.restoredWin = null;
    }

    winTag(windowId) {
        if (windowId === undefined || windowId === this.win) {
            return '';
        }

        if (windowId === this.restoredWin) {
            return '  [restored]';
        }

        return windowId === this.closedWin ? '  [second]' : '  [other window]';
    }

    eventFormatters() {
        return {
            ...super.eventFormatters(),
            'windows.onCreated': ([win]) => `type:${win.type}`,
            'windows.onRemoved': () => 'closed',
            'tabs.onCreated': ([tab]) => () => `${this.known(tab.id)}  index:${tab.index} active:${tab.active} discarded:${tab.discarded} hidden:${tab.hidden}${this.winTag(tab.windowId)}`,
            'tabs.onRemoved': ([tabId, info]) => `${this.known(tabId)}  isWindowClosing:${info.isWindowClosing}${this.winTag(info.windowId)}`,
            'tabs.onActivated': ([info]) => () => `${this.known(info.tabId)}${this.winTag(info.windowId)}`,
            'tabs.onUpdated': ([tabId, changeInfo, tab], {updatedKeys}) => {
                const keys = Object.keys(changeInfo).filter(key => updatedKeys.includes(key));

                if (!keys.length) {
                    this.data.dropped++;
                    return null;
                }

                return () => `${this.known(tabId)}  {${keys.map(key => `${key}: ${changeInfo[key]}`).join(', ')}}${this.winTag(tab.windowId)}`;
            },
        };
    }

    // every tab created from now on is a restored one: the scene is already built, and the harness
    // creates nothing on its own. The read starts synchronously inside the handler, so its result is
    // what an addon's own tabs.onCreated sees; with write, the handler also overwrites the value
    // right after the read, the way STG binds a fresh tab to the window's group
    probeCreated({write = false} = {}) {
        const handler = async tab => {
            const started = this.ms();
            const value = await readValue(tab.id);
            const took = this.ms() - started;

            this.probes.set(tab.id, value);
            this.record('probe getTabValue', () => `${this.known(tab.id)}  ${value}, took ${took} ms`, started);

            if (write) {
                const set = await browser.sessions.setTabValue(tab.id, VALUE_KEY, WRITTEN_VALUE).then(() => 'ok', rejected);
                this.record('probe setTabValue', () => `${this.known(tab.id)}  ${set}`);
            }
        };

        browser.tabs.onCreated.addListener(handler);
        this.listeners.push({target: browser.tabs.onCreated, handler});
    }

    // the window value read from inside the first events of a restored window: tabs.onCreated of
    // its tabs (the first one precedes windows.onCreated, TABGROUPS-BEHAVIOR §18) and windows.onCreated
    probeWindowCreated() {
        const probe = async (windowId, from) => {
            const started = this.ms();
            const value = await readWindowValue(windowId);
            const took = this.ms() - started;

            this.windowProbes.push(value);
            this.record('probe getWindowValue', () => `${from()}  ${value}, took ${took} ms${this.winTag(windowId)}`, started);
        };

        const onTab = tab => probe(tab.windowId, () => `from tabs.onCreated of ${this.known(tab.id)}`);
        const onWindow = win => probe(win.id, () => 'from windows.onCreated');

        browser.tabs.onCreated.addListener(onTab);
        browser.windows.onCreated.addListener(onWindow);
        this.listeners.push({target: browser.tabs.onCreated, handler: onTab}, {target: browser.windows.onCreated, handler: onWindow});
    }

    async setValues(names) {
        for (const name of names) {
            await browser.sessions.setTabValue(this.id(name), VALUE_KEY, `value-${name}`);
        }

        const read = await this.valuesByName(names);

        this.require('the values are set before the close', names.every(name => read[name] === shown(`value-${name}`)), JSON.stringify(read));
    }

    async valuesByName(names) {
        const entries = [];

        for (const name of names) {
            entries.push([name, await readValue(this.id(name))]);
        }

        return Object.fromEntries(entries);
    }

    probesByName(names) {
        return Object.fromEntries(names.map(name => [name, this.probes.get(this.id(name)) ?? 'no tabs.onCreated']));
    }

    describeState(tab) {
        return `discarded:${tab.discarded} hidden:${tab.hidden} status:${tab.status}`;
    }
}

export const testClass = RestoreValueTest;

async function restoreClosedTab(t, name, sceneNames) {
    const closedId = t.id(name);
    const knownSessions = await Sessions.knownSessionIds();

    await t.step(`tabs.remove(${name})`, () => browser.tabs.remove(closedId), {snap: 'closed'});

    t.bind(closedId, `old-${name}`);
    t.note(`${name} after the close, read on the OLD id: ${await readValue(closedId)}`);

    const session = await Sessions.findClosedTabSession(name, knownSessions);
    t.require('the closed tab is in sessions.getRecentlyClosed', session !== null, `no NEW tab session for ${name}`);

    await t.step('sessions.restore(sessionId of the tab)', () => browser.sessions.restore(session.tab.sessionId), {wait: 0, snap: false});

    const tabs = await t.settleRestored(t.win, sceneNames);
    t.require('the tab came back into the scene window', tabs !== null, `no tab named ${name} in the scene window after the restore`);

    const fresh = tabs.find(tab => nameFromUrl(tab.url) === name);

    t.bind(fresh.id, name);
    t.note(`restored ${name}: ${fresh.id === closedId ? 'the SAME id' : 'a fresh id'}, index:${fresh.index}, ${t.describeState(fresh)}`);

    await t.snap('restored');

    return fresh;
}

export const tests = [

{
    id: 'R24.01',
    title: 'a closed tab restored by sessions.restore() — does the value set with sessions.setTabValue on the old id come back on the fresh one, and is it already readable inside tabs.onCreated',
    async run(t) {
        await t.scene(['keep', 'c']);
        await t.setValues(['c']);

        t.watch(WATCH, {updatedKeys: UPDATED_KEYS});
        t.probeCreated();

        await t.snap('before');
        t.expectRow('before', ['keep*', 'c']);

        const fresh = await restoreClosedTab(t, 'c', ['keep', 'c']);

        t.expectRow('closed', ['keep*']);
        t.expectRow('restored', ['keep', 'c*']);
        t.expect('the value is readable inside tabs.onCreated of the restored tab (CREATE-TABS-BEHAVIOR.md §29)', t.probesByName(['c']).c, shown('value-c'));
        t.expect('the value is on the fresh tab after the restore settled (§29)', await readValue(fresh.id), shown('value-c'));
    },
},

{
    id: 'R24.02',
    title: 'a closed window restored by sessions.restore() — the values of the active tab, of a background tab that comes back discarded and of a hidden member; readable inside tabs.onCreated',
    async run(t) {
        await t.scene(['keep']);

        const names = ['p', 'q', 'h1'];
        const winId = await t.buildWindow(names);

        await t.hide(['h1']);
        await t.setValues(names);

        const before = (await browser.tabs.query({windowId: winId})).sort((a, b) => a.index - b.index);

        t.closedWin = winId;

        await t.snapWindow('before (second window)', winId);
        await t.snap('before (scene window)');
        t.expectRow('before (second window)', ['p*', 'q', 'h1(h)']);
        t.expectRow('before (scene window)', ['keep*']);

        t.watch(WATCH, {updatedKeys: UPDATED_KEYS});
        t.probeCreated();

        const knownSessions = await Sessions.knownSessionIds();

        openedWindows.delete(winId);
        await t.step('windows.remove(second)', () => browser.windows.remove(winId), {snap: false});

        t.bindAsOld(before);

        const session = await Sessions.findClosedWindowSession(['p', 'q'], knownSessions);
        t.require('the closed window is in sessions.getRecentlyClosed', session !== null, 'no NEW window session holding p, q');
        t.note(`tabs in the session record: ${session.window.tabs.map(tab => nameFromUrl(tab.url) ?? '(foreign)').join(', ')}`);

        const restored = await t.step('sessions.restore(sessionId of the window)', () => browser.sessions.restore(session.window.sessionId), {wait: 0, snap: false});
        const restoredWinId = restored.window.id;

        openedWindows.add(restoredWinId);
        t.restoredWin = restoredWinId;

        const tabs = await t.settleRestored(restoredWinId, ['p', 'q']);
        t.require('the restored window is populated', tabs !== null, 'the visible tabs never finished loading');

        t.bindFresh(tabs);

        await t.snapWindow('restored (second window)', restoredWinId);
        await t.snap('after (scene window)');
        t.expectRow('restored (second window)', ['p*', 'q', 'h1(h)']);
        t.expectRow('after (scene window)', ['keep*']);

        for (const tab of tabs) {
            const name = nameFromUrl(tab.url);
            name && t.note(`restored ${name}: ${t.describeState(tab)}`);
        }

        const present = names.filter(name => tabs.some(tab => nameFromUrl(tab.url) === name));

        t.require('every tab of the window came back', present.length === names.length, `back: ${present.join(', ')}`);

        const expected = Object.fromEntries(names.map(name => [name, shown(`value-${name}`)]));

        t.expect('the values are readable inside tabs.onCreated, the discarded and the hidden tab included (CREATE-TABS-BEHAVIOR.md §29)', t.probesByName(names), expected);
        t.expect('the values are on the fresh tabs after the restore settled (§29)', await t.valuesByName(names), expected);

        t.untrackWindow(restoredWinId);
        openedWindows.delete(restoredWinId);
        await browser.windows.remove(restoredWinId).catch(() => {});
    },
},

{
    id: 'R24.03',
    title: 'a closed tab restored by sessions.restore() with a sessions.setTabValue WRITE from inside tabs.onCreated — the value written by the handler against the one the restore brings, which is there at the end',
    async run(t) {
        await t.scene(['keep', 'c']);
        await t.setValues(['c']);

        t.watch(WATCH, {updatedKeys: UPDATED_KEYS});
        t.probeCreated({write: true});

        await t.snap('before');
        t.expectRow('before', ['keep*', 'c']);

        const fresh = await restoreClosedTab(t, 'c', ['keep', 'c']);

        t.expectRow('closed', ['keep*']);
        t.expectRow('restored', ['keep', 'c*']);
        t.expect('the restored value is there before the write (CREATE-TABS-BEHAVIOR.md §29)', t.probesByName(['c']).c, shown('value-c'));
        t.expect('the write from inside tabs.onCreated is what the tab holds after the restore settled (§29)', await readValue(fresh.id), shown(WRITTEN_VALUE));
    },
},

{
    id: 'R24.04',
    title: 'a closed window restored by sessions.restore() — does a sessions.setWindowValue value come back on the fresh window id, and is it readable inside the first tabs.onCreated and inside windows.onCreated',
    async run(t) {
        await t.scene(['keep']);

        const names = ['p', 'q'];
        const winId = await t.buildWindow(names);

        await browser.sessions.setWindowValue(winId, VALUE_KEY, 'value-window');

        const read = await readWindowValue(winId);
        t.require('the window value is set before the close', read === shown('value-window'), read);

        const before = (await browser.tabs.query({windowId: winId})).sort((a, b) => a.index - b.index);

        t.closedWin = winId;

        await t.snapWindow('before (second window)', winId);
        await t.snap('before (scene window)');
        t.expectRow('before (second window)', ['p*', 'q']);
        t.expectRow('before (scene window)', ['keep*']);

        t.watch(WATCH, {updatedKeys: UPDATED_KEYS});
        t.probeWindowCreated();

        const knownSessions = await Sessions.knownSessionIds();

        openedWindows.delete(winId);
        await t.step('windows.remove(second)', () => browser.windows.remove(winId), {snap: false});

        t.bindAsOld(before);
        t.note(`after the close, read on the OLD window id: ${await readWindowValue(winId)}`);

        const session = await Sessions.findClosedWindowSession(names, knownSessions);
        t.require('the closed window is in sessions.getRecentlyClosed', session !== null, 'no NEW window session holding p, q');

        const restored = await t.step('sessions.restore(sessionId of the window)', () => browser.sessions.restore(session.window.sessionId), {wait: 0, snap: false});
        const restoredWinId = restored.window.id;

        openedWindows.add(restoredWinId);
        t.restoredWin = restoredWinId;

        const tabs = await t.settleRestored(restoredWinId, names);
        t.require('the restored window is populated', tabs !== null, 'the visible tabs never finished loading');

        t.bindFresh(tabs);

        await t.snapWindow('restored (second window)', restoredWinId);
        await t.snap('after (scene window)');
        t.expectRow('restored (second window)', ['p*', 'q']);
        t.expectRow('after (scene window)', ['keep*']);

        t.note(`restored window: ${restoredWinId === winId ? 'the SAME id' : 'a fresh id'}`);
        t.expect('the window value is readable inside every tabs.onCreated of the restored window and inside windows.onCreated (CREATE-TABS-BEHAVIOR.md §29)', {reads: t.windowProbes.length, values: [...new Set(t.windowProbes)]}, {reads: names.length + 1, values: [shown('value-window')]});
        t.expect('the window value is on the fresh window after the restore settled (§29)', await readWindowValue(restoredWinId), shown('value-window'));

        t.untrackWindow(restoredWinId);
        openedWindows.delete(restoredWinId);
        await browser.windows.remove(restoredWinId).catch(() => {});
    },
},

];
