// Round 02 — the membership rule on tabs.move (R1.05 contradicted the docs), then §3 and §4.
// Run with:  await T.start('round-02')
//
// Matrix A pins down which rule decides membership:
//   H1 — the moved tab inherits the group of whatever occupied the TARGET index before the move
//   H2 — the moved tab joins only if the FINAL order puts it strictly between two members
// Each test prints who occupied the target index, so both can be checked against one output.

const membershipTest = (id, {from, target, scene}) => ({
    name: `${id} membership — move from index ${from} to {index: ${target}}`,
    async run(t) {
        await t.scene(scene);
        await t.group(['gr1', 'gr2', 'gr3']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated']);

        const before = await t.query();
        t.note(`index ${target} before the move held: ${t.cell(before[target])}`);
        t.note(`group span before the move: ${before.filter(tab => tab.groupId !== T.TAB_GROUP_ID_NONE).map(tab => tab.index).join(',')}`);

        await t.snap('before');

        await browser.tabs.move(t.id('mover'), {index: target});
        t.act(`tabs.move(mover, {index: ${target}})`);
        await T.wait(500);

        await t.snap('after');

        const after = await t.query();
        const mover = after.find(tab => tab.id === t.id('mover'));
        t.note(`mover ended at index ${mover.index}, joined: ${mover.groupId !== T.TAB_GROUP_ID_NONE}`);
        t.note(`groups: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
    },
});

const FROM_BELOW = ['mover', 'gr1', 'gr2', 'gr3', 'high1', 'high2'];
const FROM_ABOVE = ['low1', 'gr1', 'gr2', 'gr3', 'high1', 'mover'];

export const tests = [

membershipTest('R2.01', {from: 0, target: 1, scene: FROM_BELOW}),
membershipTest('R2.02', {from: 0, target: 2, scene: FROM_BELOW}),
membershipTest('R2.03', {from: 0, target: 3, scene: FROM_BELOW}),
membershipTest('R2.04', {from: 0, target: 4, scene: FROM_BELOW}),
membershipTest('R2.05', {from: 5, target: 1, scene: FROM_ABOVE}),
membershipTest('R2.06', {from: 5, target: 2, scene: FROM_ABOVE}),
membershipTest('R2.07', {from: 5, target: 3, scene: FROM_ABOVE}),
membershipTest('R2.08', {from: 5, target: 4, scene: FROM_ABOVE}),

{
    name: 'R2.09 §3 — tabs.group over non-adjacent tabs, natural order',
    async run(t) {
        await t.scene(['gr1', 'x1', 'gr2', 'x2', 'gr3']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated', 'tabGroups.onCreated']);
        await t.snap('before');

        await t.group(['gr1', 'gr2', 'gr3']);
        t.act('tabs.group({tabIds: [gr1, gr2, gr3]})');
        await T.wait(500);

        await t.snap('after');
        t.note(`groups: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
    },
},

{
    name: 'R2.10 §3 — tabs.group with tabIds in a shuffled order',
    async run(t) {
        await t.scene(['gr1', 'x1', 'gr2', 'x2', 'gr3']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated', 'tabGroups.onCreated']);
        await t.snap('before');

        await t.group(['gr3', 'gr1', 'gr2']);
        t.act('tabs.group({tabIds: [gr3, gr1, gr2]})');
        await T.wait(500);

        await t.snap('after');
        t.note('docs claim: the group forms at the position of the FIRST tab of tabIds, tabIds order is kept');
        t.note(`groups: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
    },
},

{
    name: 'R2.11 §3 — tabs.ungroup on part of a group, and the event order',
    async run(t) {
        await t.scene(['x1', 'gr1', 'gr2', 'gr3', 'gr4', 'x2']);
        await t.group(['gr1', 'gr2', 'gr3', 'gr4']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated', 'tabGroups.onRemoved']);
        await t.snap('before');

        await browser.tabs.ungroup(t.ids(['gr2', 'gr3']));
        t.act('tabs.ungroup([gr2, gr3])');
        await T.wait(500);

        await t.snap('after');
        t.note('docs claim: they move right after the last member, array order kept, onMoved for each then onUpdated {groupId: -1}');
        t.note(`groups: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
    },
},

{
    name: 'R2.12 §3 — tabs.group on a hidden tab',
    async run(t) {
        await t.scene(['x1', 'hid', 'x2']);
        await t.hide(['hid']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated', 'tabGroups.onCreated']);
        await t.snap('before');

        await t.group(['hid']);
        t.act('tabs.group({tabIds: [hid]})  // hid is hidden');
        await T.wait(500);

        await t.snap('after');
        t.note(`groups: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
        t.note('the tab-bar side of this is a 👁️ question, asked in its own run');
    },
},

{
    name: 'R2.13 §4 — hide and show a group member',
    async run(t) {
        await t.scene(['x1', 'gr1', 'gr2', 'x2']);
        await t.group(['gr1', 'gr2']);

        t.watch(['tabs.onUpdated', 'tabGroups.onRemoved']);
        await t.snap('before');

        await t.hide(['gr2']);
        t.act('tabs.hide([gr2])');
        await t.snap('after hide');
        t.note(`groups after hide: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);

        await t.show(['gr2']);
        t.act('tabs.show([gr2])');
        await t.snap('after show');
        t.note(`groups after show: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
    },
},

{
    name: 'R2.14 §4 — move a HIDDEN tab into a visible group span',
    async run(t) {
        await t.scene(['x1', 'hid', 'gr1', 'gr2', 'x2']);
        await t.group(['gr1', 'gr2']);
        await t.hide(['hid']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated']);
        await t.snap('before');

        await browser.tabs.move(t.id('hid'), {index: 2});
        t.act('tabs.move(hid, {index: 2})  // hid is hidden');
        await T.wait(500);

        await t.snap('after');
        t.note(`groups: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
    },
},

{
    name: 'R2.15 §4 — hide EVERY member of a group',
    async run(t) {
        await t.scene(['x1', 'gr1', 'gr2', 'x2']);
        await t.group(['gr1', 'gr2']);

        t.watch(['tabs.onUpdated', 'tabGroups.onRemoved']);
        await t.snap('before');

        await t.hide(['gr1', 'gr2']);
        t.act('tabs.hide([gr1, gr2])');
        await t.snap('after');

        t.note(`groups with every tab hidden: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
        t.ask('the group has no visible tabs left — is its header still shown in the tab bar?');
    },
    keepOpen: true,
},

];
