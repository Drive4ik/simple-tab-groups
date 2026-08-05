import {TAB_GROUP_ID_NONE} from '../constants.js';

export const note = `Round 03 — §5 (group ids, collapsed) and §6 (surviving a browser restart).

PRECONDITION for R3.05: about:preferences → Startup → "Open previous windows and tabs" must be ON,
otherwise the scene window is gone after the restart and the test proves nothing.`;

export const tests = [

{
    id: 'R3.01',
    title: '§5 — is a native group id mutable, and does a re-created group get a new one',
    async run(t) {
        await t.scene(['x1', 'gr1', 'gr2', 'x2']);

        const firstId = await t.group(['gr1', 'gr2']);
        await t.snap('grouped');

        try {
            await browser.tabGroups.update(firstId, {id: firstId + 1000});
            t.note('tabGroups.update({id}) did NOT throw');
        } catch (error) {
            t.note(`tabGroups.update({id}) threw: ${error.message}`);
        }

        const afterUpdate = (await browser.tabGroups.query({windowId: t.win}))[0];
        t.expect('group id unchanged after tabGroups.update({id})', afterUpdate.id === firstId, true);

        await t.step('tabs.ungroup([gr1, gr2])', () => t.ungroup(['gr1', 'gr2'], {settle: false}), {snap: 'ungrouped'});

        const secondId = await t.step(
            'tabs.group({tabIds: [gr1, gr2]})  // same tabs, grouped again',
            () => t.group(['gr1', 'gr2'], null, {settle: false}),
            {snap: 'regrouped'},
        );

        t.expect('a re-created group gets a different id', secondId !== firstId, true);
    },
},

{
    id: 'R3.02',
    title: '§5 — collapsed:true with the ACTIVE tab INSIDE the group',
    async run(t) {
        await t.scene(['x1', 'gr1', 'gr2', 'gr3', 'x2']);
        const groupId = await t.group(['gr1', 'gr2', 'gr3']);
        await t.activate('gr2');

        t.watch(['tabs.onUpdated', 'tabGroups.onUpdated']);
        await t.snap('before');

        await t.step('tabGroups.update(🟥, {collapsed: true})', () => browser.tabGroups.update(groupId, {collapsed: true}), {snap: 'collapsed'});

        t.expectRow('collapsed', ['x1', '🟥 gr1', '🟥 gr2*', '🟥 gr3', 'x2']);
        t.note(`hidden flags while collapsed: ${await t.hiddenFlags()}`);

        await t.ask('while gr2 is the active tab, which tabs of the collapsed 🟥 group are visible in the tab bar?');

        await t.step('tabs.update(x1, {active: true})  // active tab moves OUT of the collapsed group', () => t.activate('x1', {settle: false}), {snap: 'active moved out'});

        t.note(`hidden flags after activating x1: ${await t.hiddenFlags()}`);

        await t.ask('after activating x1, is any tab of the collapsed 🟥 group still visible in the tab bar?');
    },
},

{
    id: 'R3.03',
    title: '§5 — collapsed:true with the ACTIVE tab OUTSIDE the group',
    async run(t) {
        await t.scene(['x1', 'gr1', 'gr2', 'gr3', 'x2']);
        const groupId = await t.group(['gr1', 'gr2', 'gr3']);

        t.watch(['tabs.onUpdated', 'tabGroups.onUpdated']);
        await t.snap('before');

        await t.step('tabGroups.update(🟥, {collapsed: true})  // x1 is active, outside the group', () => browser.tabGroups.update(groupId, {collapsed: true}), {snap: 'collapsed'});

        t.expectRow('collapsed', ['x1*', '🟥 gr1', '🟥 gr2', '🟥 gr3', 'x2']);
        t.expect('collapsing hides nothing from the API', (await t.query()).filter(tab => tab.hidden).length, 0);
        t.note(`hidden flags while collapsed: ${await t.hiddenFlags()}`);
        t.note('the whole group goes from the bar, yet every tab still reports hidden:false');

        await t.ask('is any tab of the collapsed 🟥 group visible in the tab bar right now?');
        await t.ask('is the 🟥 group header itself still visible?');
    },
},

{
    id: 'R3.04',
    title: '§3 — a group whose only tab was hidden BEFORE grouping',
    async run(t) {
        await t.scene(['x1', 'hid', 'x2']);
        await t.hide(['hid']);

        t.watch(['tabs.onUpdated', 'tabGroups.onCreated']);
        await t.snap('before');

        await t.step('tabs.group({tabIds: [hid]})  // hid was already hidden', () => t.group(['hid'], null, {settle: false}));

        t.expectRow('after', ['x1*', '🟥 hid(h)', 'x2']);
        t.note('R2.15 showed the header stays when tabs are hidden AFTER grouping — this is the other order');

        await t.ask('is a group header visible in the tab bar, even though its only tab is hidden?');
        await t.ask('does it have a title, or is it empty?');
    },
},

{
    id: 'R3.05',
    title: '§6 — do native groups survive a browser restart',
    async run(t) {
        await t.scene(['x1', 'gr1', 'gr2', 'x2', 'gr3', 'gr4']);
        await t.group(['gr1', 'gr2'], {title: 'first', color: 'red'});
        await t.group(['gr3', 'gr4'], {title: 'second', color: 'green'});

        await t.snap('before restart');

        await t.restart();
    },
    async afterRestart(t) {
        await t.snap('after restart');

        t.expectRow('after restart', ['x1*', '🟥 gr1', '🟥 gr2', 'x2', '🟩 gr3', '🟩 gr4']);

        const groups = await t.groupsInfo();
        const titles = groups.map(group => group.match(/title:"([^"]*)"/)?.[1]).sort();

        t.note(`groups after the restart: ${groups.join(' | ') || '(none)'}`);
        t.expect('both group titles came back', titles, ['first', 'second']);

        const tabs = await t.query();
        const grouped = tabs.filter(tab => tab.groupId !== TAB_GROUP_ID_NONE).map(tab => t.nameOf(tab)).sort();

        t.expect('the same four tabs are still grouped', grouped, ['gr1', 'gr2', 'gr3', 'gr4']);
        t.note('squares are re-assigned after a restart — native group ids are new, the titles are what match up');
    },
},

];
