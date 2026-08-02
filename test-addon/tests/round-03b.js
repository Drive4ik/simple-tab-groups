// Round 03b — §5: collapsed with the ACTIVE TAB OUTSIDE the group, and §3/§4: the tab-bar header
// of a group whose only tab is hidden. Run with:  await T.start('round-03b')

export const tests = [

{
    name: 'R3.03 §5 — collapsed:true with the ACTIVE tab OUTSIDE the group',
    async run(t) {
        await t.scene(['x1', 'gr1', 'gr2', 'gr3', 'x2']);
        const groupId = await t.group(['gr1', 'gr2', 'gr3']);

        t.watch(['tabs.onUpdated', 'tabGroups.onUpdated']);
        await t.snap('before');

        await browser.tabGroups.update(groupId, {collapsed: true});
        t.act('tabGroups.update(🟥, {collapsed: true})  // x1 is active, outside the group');
        await T.wait(500);
        await t.snap('collapsed');

        const tabs = await t.query();
        t.note(`hidden flags while collapsed: ${tabs.map(tab => `${t.cell(tab)}=${tab.hidden}`).join(', ')}`);
        t.note('docs claim: the whole group is hidden from the bar, yet every tab still reports hidden:false');
        t.note(`groups: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);

        t.ask('is any tab of the collapsed 🟥 group visible in the tab bar right now?');
        t.ask('is the 🟥 group header itself still visible?');
    },
    keepOpen: true,
},

];
