import {ACTION_WAIT, NOISY_UPDATE_KEYS, TAB_GROUP_ID_NONE} from '../constants.js';
import {wait} from '../test.js';
import {TabsTest, sceneUrl, nameFromUrl, openedWindows} from '../tabs.js';

export const note = `Round 08 — MANUAL MOUSE GESTURES. Every test stops with instructions:
do the gesture with the mouse in the scene window, wait for the tab bar to settle,
then answer T.visualAnswer('done') — or describe what you saw if anything looked odd.
Events from ALL windows are recorded here (a gesture may span windows), tagged [other window].
The point of the round: which events the browser emits for USER gestures — every event fact
in TABGROUPS-BEHAVIOR.md so far comes from API calls only.`;

const WATCH_ALL = [
    'tabs.onCreated', 'tabs.onMoved', 'tabs.onUpdated', 'tabs.onRemoved',
    'tabs.onDetached', 'tabs.onAttached',
    'tabGroups.onCreated', 'tabGroups.onUpdated', 'tabGroups.onMoved', 'tabGroups.onRemoved',
];

class GestureTest extends TabsTest {
    winTag(windowId) {
        return windowId === undefined || windowId === this.win ? '' : '  [other window]';
    }

    eventFormatters() {
        return {
            ...super.eventFormatters(),
            'tabs.onMoved': ([tabId, info]) => {
                return `${this.known(tabId)}  ${info.fromIndex} → ${info.toIndex}${this.winTag(info.windowId)}`;
            },
            'tabs.onRemoved': ([tabId, info]) => {
                return `${this.known(tabId)}  isWindowClosing:${info.isWindowClosing}${this.winTag(info.windowId)}`;
            },
            'tabs.onDetached': ([tabId, info]) => {
                return `${this.known(tabId)}  from index:${info.oldPosition}${this.winTag(info.oldWindowId)}`;
            },
            'tabs.onAttached': ([tabId, info]) => {
                return `${this.known(tabId)}  to index:${info.newPosition}${this.winTag(info.newWindowId)}`;
            },
            'tabs.onUpdated': ([tabId, changeInfo, tab], {updatedKeys}) => {
                const keys = Object.keys(changeInfo).filter(key => {
                    return updatedKeys ? updatedKeys.includes(key) : !NOISY_UPDATE_KEYS.includes(key);
                });

                if (!keys.length) {
                    this.data.dropped++;
                    return null;
                }

                const shown = keys.map(key => {
                    const value = changeInfo[key];
                    return key === 'groupId' ? `groupId: ${this.square(value) || value}` : `${key}: ${value}`;
                });

                return `${this.known(tabId)}  {${shown.join(', ')}}${this.winTag(tab.windowId)}`;
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
    }
}

export const testClass = GestureTest;

export const tests = [

{
    id: 'R8.01',
    title: 'mouse: drag a member out of its group, same window — events and final state',
    async run(t) {
        await t.scene(['keep1', 'gr1', 'gr2', 'gr3', 'keep2']);
        await t.group(['gr1', 'gr2', 'gr3'], {title: 'G'});

        t.watch(WATCH_ALL, {updatedKeys: ['groupId', 'hidden']});
        await t.snap('before');

        t.act('USER: drag gr2 out of the group, drop it at the very end (after keep2)');
        await t.ask('Drag tab gr2 OUT of the group with the mouse and drop it at the very end of the strip, after keep2. Then T.visualAnswer("done")');
        await t.settled();
        await t.snap('after');

        const fresh = await browser.tabs.get(t.id('gr2'));
        t.note(`gr2 after the drag: index:${fresh.index} group:${t.square(fresh.groupId) || fresh.groupId}`);

        t.expectRow('after', ['keep1', '🟥 gr1', '🟥 gr3', 'keep2', 'gr2*']);
        t.expect('the dragged member left the group', fresh.groupId, TAB_GROUP_ID_NONE);
    },
},

{
    id: 'R8.02',
    title: 'mouse: drag the LAST member out — does the group die, which events say so',
    async run(t) {
        await t.scene(['keep1', 'gr1', 'keep2']);
        await t.group(['gr1'], {title: 'G'});

        t.watch(WATCH_ALL, {updatedKeys: ['groupId', 'hidden']});
        await t.snap('before');

        t.act('USER: drag gr1 (the only member) out of the group, drop it after keep2');
        await t.ask('Drag gr1 — the only member — OUT of the group, drop it after keep2. Then T.visualAnswer("done")');
        await t.settled();
        await t.snap('after');

        const fresh = await browser.tabs.get(t.id('gr1'));
        t.note(`gr1 after the drag: index:${fresh.index} group:${t.square(fresh.groupId) || fresh.groupId}`);
        t.note(`groups left: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);

        t.expectRow('after', ['keep1', 'keep2', 'gr1*']);
        t.expect('the group died with its last member', [fresh.groupId, (await t.groupsInfo()).length], [TAB_GROUP_ID_NONE, 0]);
    },
},

{
    id: 'R8.03',
    title: 'mouse: drag an outsider INTO the span — events for a user join',
    async run(t) {
        await t.scene(['keep1', 'gr1', 'gr2', 'mover']);
        await t.group(['gr1', 'gr2'], {title: 'G'});

        t.watch(WATCH_ALL, {updatedKeys: ['groupId', 'hidden']});
        await t.snap('before');

        t.act('USER: drag mover INTO the group, drop it between gr1 and gr2');
        await t.ask('Drag tab mover INTO the group, drop it between gr1 and gr2. Then T.visualAnswer("done")');
        await t.settled();
        await t.snap('after');

        const fresh = await browser.tabs.get(t.id('mover'));
        t.note(`mover after the drag: index:${fresh.index} group:${t.square(fresh.groupId) || fresh.groupId}`);

        t.expectRow('after', ['keep1', '🟥 gr1', '🟥 mover*', '🟥 gr2']);
        t.expect('the dragged outsider joined', fresh.groupId !== TAB_GROUP_ID_NONE, true);
    },
},

{
    id: 'R8.04',
    title: 'mouse: drag the WHOLE group by its header to another position — do member events flap',
    async run(t) {
        await t.scene(['keep1', 'gr1', 'gr2', 'keep2', 'keep3']);
        await t.group(['gr1', 'gr2'], {title: 'G'});

        t.watch(WATCH_ALL, {updatedKeys: ['groupId', 'hidden']});
        await t.snap('before');

        t.act('USER: drag the group by its header to the very end of the strip');
        await t.ask('Grab the GROUP HEADER and drag the whole group to the very end of the strip (after keep3). Then T.visualAnswer("done")');
        await t.settled();
        await t.snap('after');

        const stillGrouped = [];

        for (const name of ['gr1', 'gr2']) {
            const fresh = await browser.tabs.get(t.id(name));
            stillGrouped.push(fresh.groupId !== TAB_GROUP_ID_NONE);
            t.note(`${name} after the drag: index:${fresh.index} group:${t.square(fresh.groupId) || fresh.groupId}`);
        }

        t.expectRow('after', ['keep1*', 'keep2', 'keep3', '🟥 gr1', '🟥 gr2']);
        t.expect('membership never flapped', stillGrouped, [true, true]);
    },
},

{
    id: 'R8.05',
    title: 'menu: the ungroup item of the group header context menu — events per member',
    async run(t) {
        await t.scene(['keep1', 'gr1', 'gr2', 'gr3']);
        await t.group(['gr1', 'gr2', 'gr3'], {title: 'G'});

        t.watch(WATCH_ALL, {updatedKeys: ['groupId', 'hidden']});
        await t.snap('before');

        t.act('USER: header context menu → ungroup');
        await t.ask('Right-click the group header and pick the UNGROUP item (Ungroup Tabs). Then T.visualAnswer("done")');
        await t.settled();
        await t.snap('after');

        t.note(`groups left: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);

        t.expectRow('after', ['keep1*', 'gr1', 'gr2', 'gr3']);
        t.expect('every member ungrouped in place, the group is gone', (await t.groupsInfo()).length, 0);
    },
},

{
    id: 'R8.06',
    title: 'menu: the delete item of the group header context menu — do the tabs close or ungroup',
    async run(t) {
        await t.scene(['keep1', 'gr1', 'gr2', 'gr3']);
        await t.group(['gr1', 'gr2', 'gr3'], {title: 'G'});

        t.watch(WATCH_ALL, {updatedKeys: ['groupId', 'hidden']});
        await t.snap('before');

        t.act('USER: header context menu → delete group');
        await t.ask('Right-click the group header and pick the DELETE item (Delete Group). If the browser asks for confirmation — confirm, and mention it in the answer. Then T.visualAnswer("done")');
        await t.settled();
        await t.snap('after');

        t.note(`groups left: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);

        t.expectRow('after', ['keep1*']);
        t.expect('the members were CLOSED, not ungrouped', (await t.query()).length, 1);
    },
},

{
    id: 'R8.07',
    title: 'UI: collapse, expand, rename, recolor — what tabGroups.onUpdated carries for each',
    async run(t) {
        await t.scene(['keep1', 'gr1', 'gr2']);
        await t.group(['gr1', 'gr2'], {title: 'G'});

        t.watch(WATCH_ALL, {updatedKeys: ['groupId', 'hidden']});
        await t.snap('before');

        const meta = async () => (await browser.tabGroups.query({windowId: t.win}))[0];

        t.act('USER: collapse the group (click its header)');
        await t.ask('COLLAPSE the group by clicking its header. Then T.visualAnswer("done")');
        await t.settled();
        await t.snap('after collapse');
        t.expect('collapsed', (await meta()).collapsed, true);

        t.act('USER: expand the group back (click its header)');
        await t.ask('EXPAND the group back by clicking its header. Then T.visualAnswer("done")');
        await t.settled();
        await t.snap('after expand');
        t.expect('expanded', (await meta()).collapsed, false);

        t.act('USER: rename the group to Renamed');
        await t.ask('RENAME the group to exactly "Renamed" (double-click the header or use its context menu). Then T.visualAnswer("done")');
        await t.settled();
        await t.snap('after rename');
        t.expect('renamed', (await meta()).title, 'Renamed');

        t.act('USER: change the group color to orange');
        await t.ask('Change the group COLOR to ORANGE via the header context menu. Then T.visualAnswer("done")');
        await t.settled();
        await t.snap('after recolor');
        t.expect('recolored', (await meta()).color, 'orange');

        t.note(`groups now: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
    },
},

{
    id: 'R8.08',
    title: 'menu: move group to a new window — events, membership and the group id on the other side',
    async run(t) {
        await t.scene(['keep1', 'gr1', 'gr2', 'keep2']);
        const liveId = await t.group(['gr1', 'gr2'], {title: 'G'});

        t.watch(WATCH_ALL, {updatedKeys: ['groupId', 'hidden']});
        await t.snap('before');

        t.act('USER: header context menu → move group to new window');
        await t.ask('Right-click the group header and pick MOVE GROUP TO NEW WINDOW. Then T.visualAnswer("done")');
        await t.settled();
        await wait(ACTION_WAIT);
        await t.snap('after (scene window)');

        const movedTo = (await browser.tabs.get(t.id('gr1'))).windowId;

        if (movedTo !== t.win) {
            await t.describeWindow('the new window', movedTo);
        }

        for (const groupNative of await browser.tabGroups.query({})) {
            t.note(`live group anywhere: ${t.square(groupNative.id)} title:${JSON.stringify(groupNative.title)} — a NEW square means a NEW group id`);
        }

        const memberships = [];

        for (const name of ['gr1', 'gr2']) {
            const fresh = await browser.tabs.get(t.id(name));
            memberships.push(fresh.groupId);
            t.note(`${name}: group:${t.square(fresh.groupId) || fresh.groupId}${fresh.windowId === t.win ? '' : ' [other window]'}`);
        }

        t.expectRow('after (scene window)', ['keep1*', 'keep2']);
        t.expect('the group arrived intact, with the SAME live id', memberships, [liveId, liveId]);
        t.expect('the group left the scene window', movedTo !== t.win, true);
    },
},

{
    id: 'R8.09',
    title: 'mouse: drag a single MEMBER into another window — does membership survive the trip',
    async run(t) {
        await t.scene(['keep1', 'gr1', 'gr2', 'keep2']);
        await t.group(['gr1', 'gr2'], {title: 'G'});

        const win2 = await browser.windows.create({url: sceneUrl('target')});
        openedWindows.add(win2.id);

        try {
            await wait(ACTION_WAIT);

            t.watch(WATCH_ALL, {updatedKeys: ['groupId', 'hidden']});
            await t.snap('before');

            t.act('USER: drag gr2 from the scene window into the second window');
            await t.ask('A second window is open (tab "target"). Drag tab gr2 from the FIRST window into the SECOND window\'s tab strip with the mouse. Then T.visualAnswer("done")');
            await t.settled();
            await wait(ACTION_WAIT);
            await t.snap('after (scene window)');

            await t.describeWindow('the second window', win2.id);

            const fresh = await browser.tabs.get(t.id('gr2'));
            t.note(`gr2 after the drag: group:${t.square(fresh.groupId) || fresh.groupId} inSecondWindow:${fresh.windowId === win2.id}`);
            t.note(`groups in the scene window: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);

            t.expectRow('after (scene window)', ['keep1', '🟥 gr1', 'keep2*']);
            t.expect('arrived UNGROUPED in the other window', [fresh.groupId, fresh.windowId === win2.id], [TAB_GROUP_ID_NONE, true]);
            t.expect('the source group survived', (await t.groupsInfo()).length, 1);
        } finally {
            await browser.windows.remove(win2.id).catch(() => {});
            openedWindows.delete(win2.id);
        }
    },
},

];
