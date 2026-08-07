import {ACTION_WAIT, POLL_WAIT, SETTLE_TIMEOUT, TAB_GROUP_ID_NONE} from '../constants.js';
import {wait} from '../test.js';
import {TabsTest, sceneUrl, nameFromUrl, openedWindows} from '../tabs.js';

export const note = `Round 09 — MANUAL: windows born from moved tabs and windows restored from close.
Every fact so far watched only tabs.* / tabGroups.* — this round adds windows.onCreated/onRemoved
and records events from ALL windows, tagged [winA]/[winB]. It settles: the order of
windows.onCreated vs the first tabs.onAttached, whether the initial tab of a freshly created
window ever fires tabs.onCreated, whether a session-restored window is populated only through
tabs.onCreated with fresh ids, and what happens to hidden tabs on both trips.
Recorded in TABGROUPS-BEHAVIOR.md §17, §18. Gesture instructions come as questions during the
run: do the gesture, wait for the tab bar to settle, then T.visualAnswer('done') — or describe
what you saw if anything looked odd.`;

const WATCH_ALL = [
    'windows.onCreated', 'windows.onRemoved',
    'tabs.onCreated', 'tabs.onMoved', 'tabs.onUpdated', 'tabs.onRemoved',
    'tabs.onActivated', 'tabs.onDetached', 'tabs.onAttached',
    'tabGroups.onCreated', 'tabGroups.onUpdated', 'tabGroups.onMoved', 'tabGroups.onRemoved',
];

class WindowsTest extends TabsTest {
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
                return `${this.winName(win.id)}  type:${win.type}`;
            },
            'windows.onRemoved': ([windowId]) => {
                return this.winName(windowId);
            },
            'tabs.onCreated': ([tab]) => {
                return () => `${this.known(tab.id)}  index:${tab.index} group:${this.square(tab.groupId) || tab.groupId}${this.winTag(tab.windowId)}`;
            },
            'tabs.onMoved': ([tabId, info]) => {
                return `${this.known(tabId)}  ${info.fromIndex} → ${info.toIndex}${this.winTag(info.windowId)}`;
            },
            'tabs.onRemoved': ([tabId, info]) => {
                return () => `${this.known(tabId)}  isWindowClosing:${info.isWindowClosing}${this.winTag(info.windowId)}`;
            },
            'tabs.onActivated': ([info]) => {
                return () => `${this.known(info.tabId)}  previous:${info.previousTabId ? this.known(info.previousTabId) : '-'}${this.winTag(info.windowId)}`;
            },
            'tabs.onDetached': ([tabId, info]) => {
                return `${this.known(tabId)}  from index:${info.oldPosition}${this.winTag(info.oldWindowId)}`;
            },
            'tabs.onAttached': ([tabId, info]) => {
                return `${this.known(tabId)}  to index:${info.newPosition}${this.winTag(info.newWindowId)}`;
            },
            'tabs.onUpdated': ([tabId, changeInfo, tab], {updatedKeys}) => {
                const keys = Object.keys(changeInfo).filter(key => updatedKeys.includes(key));

                if (!keys.length) {
                    this.data.dropped++;
                    return null;
                }

                const shown = keys.map(key => {
                    const value = changeInfo[key];
                    return key === 'groupId' ? `groupId: ${this.square(value) || value}` : `${key}: ${value}`;
                });

                return () => `${this.known(tabId)}  {${shown.join(', ')}}${this.winTag(tab.windowId)}`;
            },
            'tabGroups.': ([group]) => {
                return `${this.square(group.id)}  title:${JSON.stringify(group.title ?? '')} color:${group.color} collapsed:${group.collapsed}${this.winTag(group.windowId)}`;
            },
        };
    }

    async describeWindow(label, windowId) {
        const tabs = (await browser.tabs.query({windowId})).sort((a, b) => a.index - b.index);

        const cells = tabs.map(tab => {
            const name = nameFromUrl(tab.url) ?? this.known(tab.id);
            const square = this.square(tab.groupId);
            return (square ? `${square} ` : '') + name + (tab.active ? '*' : '') + (tab.hidden ? '(h)' : '');
        });

        this.note(`${label}: ${cells.join(' | ')}`);

        const groups = await browser.tabGroups.query({windowId});

        for (const group of groups) {
            this.note(`${label} group: ${this.square(group.id)} title:${JSON.stringify(group.title ?? '')} color:${group.color} collapsed:${group.collapsed}`);
        }

        return tabs;
    }

    async buildWindow(names) {
        const win = await browser.windows.create({url: sceneUrl(names[0])});

        openedWindows.add(win.id);

        const first = win.tabs?.length ? win.tabs : await browser.tabs.query({windowId: win.id});

        this.bind(first[0].id, names[0]);

        for (let index = 1; index < names.length; index++) {
            const tab = await browser.tabs.create({
                windowId: win.id,
                url: sceneUrl(names[index]),
                index,
                active: false,
            });

            this.bind(tab.id, names[index]);
        }

        await this.waitWindowLoaded(win.id, names);

        return win.id;
    }

    async waitWindowLoaded(windowId, names) {
        const started = Date.now();

        while (Date.now() - started < SETTLE_TIMEOUT) {
            const tabs = await browser.tabs.query({windowId}).catch(() => []);
            const loaded = names.filter(name => tabs.some(tab => nameFromUrl(tab.url) === name));

            if (loaded.length === names.length) {
                return tabs.sort((a, b) => a.index - b.index);
            }

            await wait(POLL_WAIT);
        }

        this.note(`window ${this.winName(windowId)}: not all tabs loaded after ${SETTLE_TIMEOUT} ms`);
        return null;
    }

    async findWindowWith(names) {
        const started = Date.now();

        while (Date.now() - started < SETTLE_TIMEOUT) {
            for (const win of await browser.windows.getAll({windowTypes: ['normal']})) {
                if (win.id === this.win) {
                    continue;
                }

                const tabs = (await browser.tabs.query({windowId: win.id})).sort((a, b) => a.index - b.index);
                const found = names.filter(name => tabs.some(tab => nameFromUrl(tab.url) === name));

                if (found.length === names.length) {
                    return {windowId: win.id, tabs};
                }
            }

            await wait(POLL_WAIT);
        }

        return null;
    }
}

export const testClass = WindowsTest;

export const tests = [

{
    id: 'R9.01',
    title: 'menu: move group to a new window — windows.onCreated vs the attaches, the initial tab of the new window',
    async run(t) {
        await t.scene(['keep1', 'gr1', 'gr2', 'gr3', 'keep2']);
        const liveId = await t.group(['gr1', 'gr2', 'gr3'], {title: 'G'});

        t.watch(WATCH_ALL, {updatedKeys: ['groupId', 'hidden']});
        await t.snap('before');

        t.act('USER: header context menu → move group to new window');
        await t.ask('Right-click the group header and pick MOVE GROUP TO NEW WINDOW. Wait for the new window to open and settle, then T.visualAnswer("done")');
        await t.settled();
        await wait(ACTION_WAIT);
        await t.snap('after (scene window)');

        const movedTo = (await browser.tabs.get(t.id('gr1'))).windowId;

        if (movedTo !== t.win) {
            await t.describeWindow(`the new window (${t.winName(movedTo)})`, movedTo);
        }

        const memberships = [];

        for (const name of ['gr1', 'gr2', 'gr3']) {
            const fresh = await browser.tabs.get(t.id(name));
            memberships.push(fresh.groupId);
        }

        t.note('key events (§17): windows.onCreated FIRST, then the attaches; the initial tab fires NO tabs.onCreated, only tabs.onRemoved after the attaches');

        t.expectRow('after (scene window)', ['keep1*', 'keep2']);
        t.expect('the group left the scene window', movedTo !== t.win, true);
        t.expect('the group arrived intact, with the SAME live id (R8.08)', memberships, [liveId, liveId, liveId]);
    },
},

{
    id: 'R9.02',
    title: 'menu: move group to a new window while ONE MEMBER IS HIDDEN — does the hidden member travel',
    async run(t) {
        await t.scene(['keep1', 'gr1', 'hid1', 'gr2', 'keep2']);
        await t.group(['gr1', 'hid1', 'gr2'], {title: 'G'});
        await t.hide(['hid1']);

        t.watch(WATCH_ALL, {updatedKeys: ['groupId', 'hidden']});
        await t.snap('before');

        t.act('USER: header context menu → move group to new window (one member is hidden)');
        await t.ask('The group has three tabs, one of them (hid1) is hidden by the add-on. Right-click the group header and pick MOVE GROUP TO NEW WINDOW. Wait for quiet, then T.visualAnswer("done") — and mention it if the hidden tab APPEARED anywhere on screen');
        await t.settled();
        await wait(ACTION_WAIT);
        await t.snap('after (scene window)');

        const movedTo = (await browser.tabs.get(t.id('gr1'))).windowId;

        if (movedTo !== t.win) {
            await t.describeWindow(`the new window (${t.winName(movedTo)})`, movedTo);
        }

        const hid = await browser.tabs.get(t.id('hid1'));
        t.note(`hid1 after the move: window:${t.winName(hid.windowId)} hidden:${hid.hidden} group:${t.square(hid.groupId) || hid.groupId} index:${hid.index}`);
        t.note('key events (§17): NO tabs.onUpdated {hidden} anywhere — the reveal is silent');

        t.expectRow('after (scene window)', ['keep1*', 'keep2']);
        t.expect('the hidden member traveled and arrived VISIBLE, still a member', [hid.windowId !== t.win, hid.hidden, hid.groupId !== TAB_GROUP_ID_NONE], [true, false, true]);
    },
},

{
    id: 'R9.03',
    title: 'mouse: drag a single MEMBER out to empty space — a new window from one tab, attach or create',
    async run(t) {
        await t.scene(['keep1', 'gr1', 'gr2', 'keep2']);
        await t.group(['gr1', 'gr2'], {title: 'G'});

        t.watch(WATCH_ALL, {updatedKeys: ['groupId', 'hidden']});
        await t.snap('before');

        t.act('USER: drag gr2 out of the window to empty desktop space → its own new window');
        await t.ask('Drag tab gr2 with the mouse OUT of the window (drop it on empty desktop space) so the browser creates a NEW window for it. Wait for quiet, then T.visualAnswer("done")');
        await t.settled();
        await wait(ACTION_WAIT);
        await t.snap('after (scene window)');

        const fresh = await browser.tabs.get(t.id('gr2'));

        if (fresh.windowId !== t.win) {
            await t.describeWindow(`the new window (${t.winName(fresh.windowId)})`, fresh.windowId);
        }

        t.note(`gr2 after the drag: window:${t.winName(fresh.windowId)} group:${t.square(fresh.groupId) || fresh.groupId}`);
        t.note(`groups left in the scene window: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
        t.note('key events (§17): the attach is delivered BEFORE windows.onCreated; no tabs.onCreated for gr2; no initial tab in the new window at all');

        t.expect('the tab left the scene window', fresh.windowId !== t.win, true);
        t.expect('arrived UNGROUPED (§16 extended to the new-window case)', fresh.groupId, TAB_GROUP_ID_NONE);
        t.expect('the source group survived', (await t.groupsInfo()).length, 1);
    },
},

{
    id: 'R9.04',
    title: 'undo close window (Ctrl+Shift+N): fresh ids or attaches, the group and the hidden tabs on the way back',
    async run(t) {
        await t.scene(['keep1']);

        const names = ['res1', 'resGr1', 'resHid1', 'resGr2', 'resHid2'];
        const winId = await t.buildWindow(names);

        t.nameWindow(winId, 'second');

        const liveIdBefore = await browser.tabs.group({
            tabIds: t.ids(['resGr1', 'resHid1', 'resGr2']),
            createProperties: {windowId: winId},
        });

        await browser.tabGroups.update(liveIdBefore, {title: 'R', color: 'blue'});

        await browser.tabs.hide(t.ids(['resHid1', 'resHid2']));
        await wait(ACTION_WAIT);

        const before = await t.describeWindow('second window before close', winId);
        const idsBefore = new Set(before.map(tab => tab.id));

        t.watch(WATCH_ALL, {updatedKeys: ['groupId', 'hidden']});

        t.act('USER: close the second window with its X button');
        await t.ask('Close the SECOND window (the one with the res… tabs) with its X button. Then T.visualAnswer("done")');
        openedWindows.delete(winId);
        await wait(ACTION_WAIT);

        t.act('USER: Ctrl+Shift+N — undo close window');
        await t.ask('Restore the window you just closed: Ctrl+Shift+N (or Menu → History → Recently Closed Windows). Wait for it to fully open, then T.visualAnswer("done")');

        const restored = await t.findWindowWith(['res1', 'resGr1', 'resGr2']);
        t.require('the closed window came back', restored !== null, 'no window with the res… tabs appeared');

        t.nameWindow(restored.windowId, 'restored');
        await t.settled();
        await wait(ACTION_WAIT);

        const after = await t.describeWindow('restored window', restored.windowId);

        for (const tab of after) {
            const name = nameFromUrl(tab.url);
            name && t.bind(tab.id, name);
        }

        const reused = after.filter(tab => idsBefore.has(tab.id)).length;
        t.note(`tab ids reused after the restore: ${reused} of ${after.length} (0 = all fresh)`);
        t.note('key events (§18): populated ONLY through tabs.onCreated, no attaches; the first tabs.onCreated is delivered BEFORE windows.onCreated; the group returns via tabGroups.onCreated');

        const restoredGroups = await browser.tabGroups.query({windowId: restored.windowId});

        t.expect('every tab id is fresh', reused, 0);
        t.expect('the group came back with the SAME live id', restoredGroups.map(group => group.id), [liveIdBefore]);
        t.expect('hidden tabs came back hidden, the rest visible', after.map(tab => `${nameFromUrl(tab.url) ?? '?'}${tab.hidden ? '(h)' : ''}`), ['res1', 'resGr1', 'resHid1(h)', 'resGr2', 'resHid2(h)']);
    },
},

{
    id: 'R9.05',
    title: 'API: windows.create({tabId}) with a group member — which events carry the tab out',
    async run(t) {
        await t.scene(['keep1', 'gr1', 'gr2', 'keep2']);
        await t.group(['gr1', 'gr2'], {title: 'G'});

        t.watch(WATCH_ALL, {updatedKeys: ['groupId', 'hidden']});
        await t.snap('before');

        const win = await t.step('windows.create({tabId: gr2})', () => browser.windows.create({tabId: t.id('gr2')}));

        openedWindows.add(win.id);

        try {
            await wait(ACTION_WAIT);
            await t.snap('after (scene window)');
            await t.describeWindow(`the new window (${t.winName(win.id)})`, win.id);

            const fresh = await browser.tabs.get(t.id('gr2'));
            t.note(`gr2 after the call: window:${t.winName(fresh.windowId)} group:${t.square(fresh.groupId) || fresh.groupId}`);
            t.note(`groups left in the scene window: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
            t.note('key events (§17): same shape as the mouse drag — attach delivered BEFORE windows.onCreated, no onCreated, no initial tab');

            t.expect('the tab left the scene window', fresh.windowId, win.id);
            t.expect('arrived UNGROUPED', fresh.groupId, TAB_GROUP_ID_NONE);
            t.expect('the source group survived', (await t.groupsInfo()).length, 1);
        } finally {
            await browser.windows.remove(win.id).catch(() => {});
            openedWindows.delete(win.id);
        }
    },
},

];
