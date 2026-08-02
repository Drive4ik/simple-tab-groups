// Round 03c — §3: a group created on an already-hidden tab. The API half was confirmed in R2.12;
// this is the tab-bar half. Run with:  await T.start('round-03c')

export const tests = [

{
    name: 'R3.04 §3 — a group whose only tab was hidden BEFORE grouping',
    async run(t) {
        await t.scene(['x1', 'hid', 'x2']);
        await t.hide(['hid']);

        t.watch(['tabs.onUpdated', 'tabGroups.onCreated']);
        await t.snap('before');

        await t.group(['hid']);
        t.act('tabs.group({tabIds: [hid]})  // hid was already hidden');
        await T.wait(500);
        await t.snap('after');

        t.note(`groups: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
        t.note('R2.15 already showed the header stays when tabs are hidden AFTER grouping — this is the other order');

        t.ask('is a group header visible in the tab bar, even though its only tab is hidden?');
        t.ask('does it have a title, or is it empty?');
    },
    keepOpen: true,
},

];
