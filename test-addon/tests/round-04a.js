// Round 04a — §5: collapse a group while the ACTIVE tab is inside it, and STOP there.
// R3.02 asked about this state after already moving the active tab away, so the answer was lost.
// Run with:  await T.start('round-04a')

export const tests = [

{
    name: 'R4.01 §5 — collapsed while the active tab is INSIDE the group',
    async run(t) {
        await t.scene(['x1', 'gr1', 'gr2', 'gr3', 'x2']);
        const groupId = await t.group(['gr1', 'gr2', 'gr3']);
        await t.activate('gr2');

        t.watch(['tabs.onUpdated', 'tabGroups.onUpdated']);
        await t.snap('before');

        await browser.tabGroups.update(groupId, {collapsed: true});
        t.act('tabGroups.update(🟥, {collapsed: true})  // gr2 is active, inside the group');
        await T.wait(500);
        await t.snap('collapsed — window left here');

        const tabs = await t.query();
        t.note(`hidden flags: ${tabs.map(tab => `${t.cell(tab)}=${tab.hidden}`).join(', ')}`);
        t.note(`groups: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
        t.note('nothing happens after this snapshot — the window shows exactly the state in question');

        t.ask('is the active tab gr2 visible in the tab bar right now?');
        t.ask('are gr1 and gr3 visible, or only gr2?');
    },
    keepOpen: true,
},

];
