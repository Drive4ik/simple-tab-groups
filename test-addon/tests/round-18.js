import {NOISY_UPDATE_KEYS} from '../constants.js';
import {nameFromUrl, openedWindows} from '../tabs.js';
import {OpenerTest, OPENER_KEYS} from '../opener.js';
import * as Sessions from '../sessions.js';

export const note = `Round 18 — sessions.restore() and tab.openerTabId: the API behind "undo close
window" (Ctrl+Shift+N) and "undo close tab" (Ctrl+Shift+T). TABGROUPS-BEHAVIOR §18 (R9.04)
established that an undo-closed window is populated through tabs.onCreated with fresh ids; this
round drives the same restore through the API and reads what the fresh tabs report as their
opener, whether the session record itself carries one, and what a single restored tab does while
its opener is still alive with the SAME id. Every cell prints the opener as a suffix right after
the name: c1→p means c1.openerTabId points at p. After a close the dead ids are renamed old-…, so
a link printed as old-p points at the DEAD pre-close id and a plain p at the live tab — the two
hypotheses stay apart in every row, note and event line.`;

class RestoreOpenerTest extends OpenerTest {
    constructor(options) {
        super(options);
        this.winLabels = new Map();
    }

    nameWindow(windowId, label) {
        this.winLabels.set(windowId, label);
        return label;
    }

    winName(windowId) {
        if (windowId === this.win) {
            return 'scene';
        }

        if (!this.winLabels.has(windowId)) {
            this.winLabels.set(windowId, `win${String.fromCharCode(65 + this.winLabels.size)}`);
        }

        return this.winLabels.get(windowId);
    }

    winTag(windowId) {
        return windowId === undefined || windowId === this.win ? '' : `  [${this.winName(windowId)}]`;
    }

    eventFormatters() {
        return {
            ...super.eventFormatters(),
            'windows.onCreated': ([win]) => {
                return () => `${this.winName(win.id)}  type:${win.type}`;
            },
            'windows.onRemoved': ([windowId]) => {
                return this.winName(windowId);
            },
            'tabs.onCreated': ([tab]) => {
                return () => `${this.known(tab.id)}  index:${tab.index} opener:${this.describeOpener(tab)}${this.winTag(tab.windowId)}`;
            },
            'tabs.onRemoved': ([tabId, info]) => {
                return `${this.known(tabId)}  isWindowClosing:${info.isWindowClosing}${this.winTag(info.windowId)}`;
            },
            'tabs.onActivated': ([info]) => {
                return () => `${this.known(info.tabId)}  previous:${info.previousTabId ? this.known(info.previousTabId) : '-'}${this.winTag(info.windowId)}`;
            },
            'tabs.onUpdated': ([tabId, changeInfo, tab], {updatedKeys}) => {
                const keys = Object.keys(changeInfo).filter(key => {
                    return updatedKeys ? updatedKeys.includes(key) : !NOISY_UPDATE_KEYS.includes(key);
                });

                if (!keys.length) {
                    this.data.dropped++;
                    return null;
                }

                return () => {
                    const shown = keys.map(key => {
                        const value = changeInfo[key];
                        const named = key === 'openerTabId' ? (value === -1 ? 'none' : this.known(value)) : value;
                        return `${key}: ${named}`;
                    });

                    return `${this.known(tabId)}  {${shown.join(', ')}}${this.winTag(tab.windowId)}`;
                };
            },
        };
    }

    bindAsOld(tabs) {
        for (const tab of tabs) {
            const name = nameFromUrl(tab.url);
            name && this.bind(tab.id, `old-${name}`);
        }
    }

    async settleRestored(windowId, names) {
        this.trackWindow(windowId);

        const tabs = await this.waitWindowLoaded(windowId, names);
        const settled = await this.settled();
        const action = this.data.rows.findLast(row => row.kind === 'action');

        if (action && !action.timing) {
            action.timing = `settled ${settled.ms} ms`;
        }

        return tabs;
    }

    describeSessionTab(tab) {
        const name = nameFromUrl(tab.url) ?? '(foreign)';
        const opener = 'openerTabId' in tab ? `openerTabId ${this.known(tab.openerTabId)}` : 'no openerTabId field';
        const hidden = tab.hidden === undefined ? 'no hidden field' : `hidden:${tab.hidden}`;

        return `session record of ${name}: ${opener}, ${hidden}`;
    }
}

export const testClass = RestoreOpenerTest;

export const tests = [

{
    id: 'R18.01',
    title: 'a closed window restored by sessions.restore() — do the fresh tabs come back with their openerTabId, does the session record carry one, the hidden member on the way back',
    async run(t) {
        await t.scene(['keep1']);

        const names = ['p', 'c1', 'c2', 'x', 'h1'];
        const winId = await t.buildWindow(names);

        t.nameWindow(winId, 'second');

        await t.setOpeners([['c1', 'p'], ['c2', 'c1'], ['h1', 'p']], winId);
        await t.hide(['h1']);

        const before = (await browser.tabs.query({windowId: winId})).sort((a, b) => a.index - b.index);
        const idsBefore = new Set(before.map(tab => tab.id));

        await t.snapWindow('before (second window)', winId);
        await t.snap('before (scene window)');
        t.expectRow('before (second window)', ['p*', 'c1→p', 'c2→c1', 'x', 'h1→p(h)']);
        t.expectRow('before (scene window)', ['keep1*']);

        t.watch(['windows.onCreated', 'windows.onRemoved', 'tabs.onCreated', 'tabs.onRemoved', 'tabs.onUpdated', 'tabs.onActivated'], {updatedKeys: [...OPENER_KEYS, 'hidden']});

        const knownSessions = await Sessions.knownSessionIds();

        await t.step('windows.remove(second)', () => {
            openedWindows.delete(winId);
            return browser.windows.remove(winId);
        }, {snap: false});

        t.bindAsOld(before);

        const session = await Sessions.findClosedWindowSession(['p', 'c1', 'c2', 'x'], knownSessions);
        t.require('the closed window is in sessions.getRecentlyClosed', session !== null, 'no NEW window session holding p, c1, c2, x');

        for (const tab of session.window.tabs) {
            t.note(t.describeSessionTab(tab));
        }

        t.note(`keys of one session tab record: ${Object.keys(session.window.tabs[0]).sort().join(', ')}`);
        t.expect('the session records carry no openerTabId field (§15)', session.window.tabs.some(tab => 'openerTabId' in tab), false);

        const restored = await t.step('sessions.restore(sessionId of the window)', () => browser.sessions.restore(session.window.sessionId), {wait: 0, snap: false});
        const restoredWinId = restored.window.id;

        openedWindows.add(restoredWinId);
        t.nameWindow(restoredWinId, 'restored');

        const tabs = await t.settleRestored(restoredWinId, ['p', 'c1', 'c2', 'x']);
        t.require('the restored window is populated', tabs !== null, 'the visible tabs never finished loading');

        const after = (await browser.tabs.query({windowId: restoredWinId})).sort((a, b) => a.index - b.index);

        for (const tab of after) {
            const name = nameFromUrl(tab.url);
            name && t.bind(tab.id, name);
        }

        await t.snapWindow('restored (second window)', restoredWinId);
        await t.snap('after (scene window)');

        const reused = after.filter(tab => idsBefore.has(tab.id)).length;
        t.note(`tab ids reused after the restore: ${reused} of ${after.length} (0 = all fresh)`);

        for (const tab of after) {
            t.note(`restored ${nameFromUrl(tab.url) ?? '?'}: opener ${t.describeOpener(tab)}, hidden:${tab.hidden}`);
        }

        t.expectRow('restored (second window)', ['p*', 'c1', 'c2', 'x', 'h1(h)']);
        t.expectRow('after (scene window)', ['keep1*']);
        t.expect('every tab id is fresh (§15)', reused, 0);
        t.expect('openers after the restore: absent on every tab (§15)', Object.fromEntries(after.map(tab => [nameFromUrl(tab.url) ?? '?', t.describeOpener(tab)])), {p: 'absent', c1: 'absent', c2: 'absent', x: 'absent', h1: 'absent'});

        t.untrackWindow(restoredWinId);
        await browser.windows.remove(restoredWinId).catch(() => {});
        openedWindows.delete(restoredWinId);
    },
},

{
    id: 'R18.02',
    title: 'a closed tab restored by sessions.restore() while its opener stays alive with the SAME id — does the link come back; the child of the closed tab stays cut',
    async run(t) {
        await t.scene(['x', 'p', 'c', 'd']);
        await t.setOpeners([['c', 'p'], ['d', 'c']]);

        const closedId = t.id('c');

        t.watch(['tabs.onCreated', 'tabs.onRemoved', 'tabs.onUpdated', 'tabs.onActivated'], {updatedKeys: OPENER_KEYS});
        await t.snap('before');
        t.expectRow('before', ['x*', 'p', 'c→p', 'd→c']);

        const knownSessions = await Sessions.knownSessionIds();

        await t.step('tabs.remove(c)', () => browser.tabs.remove(closedId), {snap: 'closed'});
        t.expect('the child of the closed tab lost its link (§6)', await t.opener('d'), 'absent');
        t.expectRow('closed', ['x*', 'p', 'd']);

        t.bind(closedId, 'old-c');

        const session = await Sessions.findClosedTabSession('c', knownSessions);
        t.require('the closed tab is in sessions.getRecentlyClosed', session !== null, 'no NEW tab session for c');

        t.note(t.describeSessionTab(session.tab));
        t.note(`keys of the session tab record: ${Object.keys(session.tab).sort().join(', ')}`);
        t.expect('the session record carries no openerTabId field (§16)', 'openerTabId' in session.tab, false);

        await t.step('sessions.restore(sessionId of the tab)', () => browser.sessions.restore(session.tab.sessionId), {wait: 0, snap: false});

        const tabs = await t.settleRestored(t.win, ['x', 'p', 'c', 'd']);
        t.require('the tab came back into the scene window', tabs !== null, 'no tab named c in the scene window after the restore');

        const fresh = (await t.query()).find(tab => nameFromUrl(tab.url) === 'c');

        t.note(`restored c: ${fresh.id === closedId ? 'the SAME id' : 'a fresh id'}, index:${fresh.index}, opener ${t.describeOpener(fresh)}`);
        t.bind(fresh.id, 'c');

        await t.snap('restored');

        t.expectRow('restored', ['x', 'p', 'c*', 'd']);
        t.expect('restored with a fresh id and NO link to the still-alive opener (§16)', {freshId: fresh.id !== closedId, opener: t.describeOpener(fresh)}, {freshId: true, opener: 'absent'});
        t.expect('nobody got re-linked (§16)', await t.openersByName(), {c: 'absent', d: 'absent', p: 'absent', x: 'absent'});
    },
},

];
