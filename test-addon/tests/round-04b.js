// Round 04b — §5: activate a tab that sits inside an ALREADY collapsed group, and STOP there.
// Run with:  await T.start('round-04b')

export const tests = [

{
    name: 'R4.02 §5 — activating a tab inside an already collapsed group',
    async run(t) {
        await t.scene(['x1', 'gr1', 'gr2', 'gr3', 'x2']);
        const groupId = await t.group(['gr1', 'gr2', 'gr3']);

        await browser.tabGroups.update(groupId, {collapsed: true});
        await T.wait(500);

        t.watch(['tabs.onUpdated', 'tabs.onActivated', 'tabGroups.onUpdated']);
        await t.snap('collapsed, x1 active');

        await t.activate('gr2');
        t.act('tabs.update(gr2, {active: true})  // gr2 is inside the collapsed group');
        await T.wait(500);
        await t.snap('gr2 active — window left here');

        const tabs = await t.query();
        t.note(`hidden flags: ${tabs.map(tab => `${t.cell(tab)}=${tab.hidden}`).join(', ')}`);
        t.note(`groups: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
        t.note('nothing happens after this snapshot — the window shows exactly the state in question');

        t.ask('did the whole 🟥 group expand, or is only gr2 shown next to the header?');
        t.ask('does tabGroups still report the group as collapsed (see the note above) — and does the tab bar agree?');
    },
    keepOpen: true,
},

];
