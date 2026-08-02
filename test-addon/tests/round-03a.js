// Round 03a — §5: can a native group id be changed / reused, and collapsed with the ACTIVE TAB
// INSIDE the group. Run with:  await T.start('round-03a')
// The second test leaves its window open with a question.

export const tests = [

{
    name: 'R3.01 §5 — is a native group id mutable, and does a re-created group get a new one',
    async run(t) {
        await t.scene(['x1', 'gr1', 'gr2', 'x2']);

        const firstId = await t.group(['gr1', 'gr2']);
        t.note(`group created, live id recorded (not printed — ids are ephemeral)`);
        await t.snap('grouped');

        try {
            await browser.tabGroups.update(firstId, {id: firstId + 1000});
            t.note('tabGroups.update({id}) did NOT throw');
        } catch (error) {
            t.note(`tabGroups.update({id}) threw: ${error.message}`);
        }

        const afterUpdate = (await browser.tabGroups.query({windowId: t.win}))[0];
        t.note(`id unchanged after update attempt: ${afterUpdate.id === firstId}`);

        await t.ungroup(['gr1', 'gr2']);
        t.act('tabs.ungroup([gr1, gr2])');
        await t.snap('ungrouped');
        t.note(`groups after ungroup: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);

        const secondId = await t.group(['gr1', 'gr2']);
        t.act('tabs.group({tabIds: [gr1, gr2]})  // same tabs, grouped again');
        await t.snap('regrouped');
        t.note(`re-created group got a different id: ${secondId !== firstId}`);
    },
},

{
    name: 'R3.02 §5 — collapsed:true with the ACTIVE tab INSIDE the group',
    async run(t) {
        await t.scene(['x1', 'gr1', 'gr2', 'gr3', 'x2']);
        const groupId = await t.group(['gr1', 'gr2', 'gr3']);
        await t.activate('gr2');

        t.watch(['tabs.onUpdated', 'tabGroups.onUpdated']);
        await t.snap('before');

        await browser.tabGroups.update(groupId, {collapsed: true});
        t.act('tabGroups.update(🟥, {collapsed: true})');
        await T.wait(500);
        await t.snap('collapsed');

        const tabs = await t.query();
        t.note(`hidden flags while collapsed: ${tabs.map(tab => `${t.cell(tab)}=${tab.hidden}`).join(', ')}`);
        t.note(`groups: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);

        await t.activate('x1');
        t.act('tabs.update(x1, {active: true})  // active tab moves OUT of the collapsed group');
        await T.wait(500);
        await t.snap('active moved out');

        const after = await t.query();
        t.note(`hidden flags after activating x1: ${after.map(tab => `${t.cell(tab)}=${tab.hidden}`).join(', ')}`);

        t.ask('while gr2 was the active tab, which tabs of the collapsed 🟥 group were visible in the tab bar?');
        t.ask('after activating x1, is any tab of the collapsed 🟥 group still visible in the tab bar?');
    },
    keepOpen: true,
},

];
