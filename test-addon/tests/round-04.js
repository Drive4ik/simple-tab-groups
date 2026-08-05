import {TAB_GROUP_ID_NONE} from '../constants.js';

export const note = `Round 04 — §5 collapsed seen from the tab bar, §6 hidden tabs across a browser restart.

PRECONDITION for R4.03: about:preferences → Startup → "Open previous windows and tabs" must be ON.`;

export const tests = [

{
    id: 'R4.01',
    title: '§5 — collapsed while the active tab is INSIDE the group',
    async run(t) {
        await t.scene(['x1', 'gr1', 'gr2', 'gr3', 'x2']);
        const groupId = await t.group(['gr1', 'gr2', 'gr3']);
        await t.activate('gr2');

        t.watch(['tabs.onUpdated', 'tabGroups.onUpdated']);
        await t.snap('before');

        await t.step('tabGroups.update(🟥, {collapsed: true})  // gr2 is active, inside the group', () => browser.tabGroups.update(groupId, {collapsed: true}), {snap: 'collapsed'});

        t.expectRow('collapsed', ['x1', '🟥 gr1', '🟥 gr2*', '🟥 gr3', 'x2']);
        t.expect('collapsing hides nothing from the API', (await t.query()).filter(tab => tab.hidden).length, 0);
        t.note(`hidden flags: ${await t.hiddenFlags()}`);

        await t.ask('is the active tab gr2 visible in the tab bar right now?');
        await t.ask('are gr1 and gr3 visible, or only gr2?');
    },
},

{
    id: 'R4.02',
    title: '§5 — activating a tab inside an already collapsed group',
    async run(t) {
        await t.scene(['x1', 'gr1', 'gr2', 'gr3', 'x2']);
        const groupId = await t.group(['gr1', 'gr2', 'gr3']);

        await browser.tabGroups.update(groupId, {collapsed: true});
        await t.settled();

        t.watch(['tabs.onUpdated', 'tabs.onActivated', 'tabGroups.onUpdated']);
        await t.snap('collapsed, x1 active');

        await t.step('tabs.update(gr2, {active: true})  // gr2 is inside the collapsed group', () => t.activate('gr2', {settle: false}), {snap: 'gr2 active'});

        t.expectRow('gr2 active', ['x1', '🟥 gr1', '🟥 gr2*', '🟥 gr3', 'x2']);
        t.expect('the group still reports itself collapsed', (await browser.tabGroups.query({windowId: t.win}))[0].collapsed, true);
        t.note(`hidden flags: ${await t.hiddenFlags()}`);

        await t.ask('did the whole 🟥 group expand, or is only gr2 shown next to the header?');
        await t.ask('tabGroups still reports the group as collapsed (see the groups line) — does the tab bar agree?');
    },
},

{
    id: 'R4.03',
    title: '§6 — do hidden tabs and their membership survive a browser restart',
    async run(t) {
        await t.scene(['x1', 'gr1', 'hid1', 'gr2', 'hid2', 'x2']);
        await t.group(['gr1', 'hid1', 'gr2'], {title: 'survivor', color: 'red'});

        await t.step('tabs.hide([hid1, hid2])  // hid1 is inside the group, hid2 is not', () => t.hide(['hid1', 'hid2'], {settle: false}), {snap: 'before restart'});

        t.note(`hidden flags: ${await t.hiddenFlags()}`);

        await t.restart();
    },
    async afterRestart(t) {
        await t.snap('after restart');

        t.expectRow('after restart', ['x1*', '🟥 gr1', '🟥 hid1(h)', '🟥 gr2', 'hid2(h)', 'x2']);

        const tabs = await t.query();
        const hidden = tabs.filter(tab => tab.hidden).map(tab => t.nameOf(tab)).sort();
        const grouped = tabs.filter(tab => tab.groupId !== TAB_GROUP_ID_NONE).map(tab => t.nameOf(tab)).sort();

        t.note(`hidden after the restart: ${hidden.join(', ') || '(none)'}`);
        t.note(`grouped after the restart: ${grouped.join(', ') || '(none)'}`);
        t.note(`hidden flags: ${await t.hiddenFlags()}`);
        t.note('hid1 was a group member, hid2 was not — that is what separates "hidden survived" from "membership survived"');
    },
},

];
