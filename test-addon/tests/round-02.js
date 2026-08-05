import {TAB_GROUP_ID_NONE} from '../constants.js';

export const note = `Round 02 — the membership rule on tabs.move (R1.05 contradicted the docs), then §3 and §4.

Matrix A pins down which rule decides membership:
  H1 — the moved tab inherits the group of whatever occupied the TARGET index before the move
  H2 — the moved tab joins only if the FINAL order puts it strictly between two members
Each test prints who occupied the target index, so both can be checked against one output.`;

const FROM_BELOW = ['mover', 'gr1', 'gr2', 'gr3', 'high1', 'high2'];
const FROM_ABOVE = ['low1', 'gr1', 'gr2', 'gr3', 'high1', 'mover'];

const membership = (id, {from, target, scene, after}) => ({
    id,
    title: `membership — move from index ${from} to {index: ${target}}`,
    async run(t) {
        await t.scene(scene);
        await t.group(['gr1', 'gr2', 'gr3']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated']);

        const before = await t.query();
        t.note(`index ${target} before the move held: ${t.cell(before[target])}`);
        t.note(`group span before the move: ${before.filter(tab => tab.groupId !== TAB_GROUP_ID_NONE).map(tab => tab.index).join(',')}`);

        await t.snap('before');

        await t.step(`tabs.move(mover, {index: ${target}})`, () => browser.tabs.move(t.id('mover'), {index: target}));

        const mover = (await t.query()).find(tab => tab.id === t.id('mover'));
        t.note(`mover ended at index ${mover.index}, joined: ${mover.groupId !== TAB_GROUP_ID_NONE}`);

        t.expect('the mover landed at the requested index', mover.index, target);
        t.expectRow('after', after);
    },
});

export const tests = [

membership('R2.01', {from: 0, target: 1, scene: FROM_BELOW, after: ['🟥 gr1', '🟥 mover*', '🟥 gr2', '🟥 gr3', 'high1', 'high2']}),
membership('R2.02', {from: 0, target: 2, scene: FROM_BELOW, after: ['🟥 gr1', '🟥 gr2', '🟥 mover*', '🟥 gr3', 'high1', 'high2']}),
membership('R2.03', {from: 0, target: 3, scene: FROM_BELOW, after: ['🟥 gr1', '🟥 gr2', '🟥 gr3', '🟥 mover*', 'high1', 'high2']}),
membership('R2.04', {from: 0, target: 4, scene: FROM_BELOW, after: ['🟥 gr1', '🟥 gr2', '🟥 gr3', 'high1', 'mover*', 'high2']}),
membership('R2.05', {from: 5, target: 1, scene: FROM_ABOVE, after: ['low1*', '🟥 mover', '🟥 gr1', '🟥 gr2', '🟥 gr3', 'high1']}),
membership('R2.06', {from: 5, target: 2, scene: FROM_ABOVE, after: ['low1*', '🟥 gr1', '🟥 mover', '🟥 gr2', '🟥 gr3', 'high1']}),
membership('R2.07', {from: 5, target: 3, scene: FROM_ABOVE, after: ['low1*', '🟥 gr1', '🟥 gr2', '🟥 mover', '🟥 gr3', 'high1']}),
membership('R2.08', {from: 5, target: 4, scene: FROM_ABOVE, after: ['low1*', '🟥 gr1', '🟥 gr2', '🟥 gr3', 'mover', 'high1']}),

{
    id: 'R2.09',
    title: '§3 — tabs.group over non-adjacent tabs, natural order',
    async run(t) {
        await t.scene(['gr1', 'x1', 'gr2', 'x2', 'gr3']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated', 'tabGroups.onCreated']);
        await t.snap('before');

        await t.step('tabs.group({tabIds: [gr1, gr2, gr3]})', () => t.group(['gr1', 'gr2', 'gr3'], null, {settle: false}));

        t.expectRow('after', ['🟥 gr1*', '🟥 gr2', '🟥 gr3', 'x1', 'x2']);
    },
},

{
    id: 'R2.10',
    title: '§3 — tabs.group with tabIds in a shuffled order',
    async run(t) {
        await t.scene(['gr1', 'x1', 'gr2', 'x2', 'gr3']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated', 'tabGroups.onCreated']);
        await t.snap('before');

        await t.step('tabs.group({tabIds: [gr3, gr1, gr2]})', () => t.group(['gr3', 'gr1', 'gr2'], null, {settle: false}));

        t.expectRow('after', ['x1', 'x2', '🟥 gr3', '🟥 gr1*', '🟥 gr2']);
        t.note('the group forms around the FIRST tab of tabIds — that tab never moves, the others are pulled to it');
    },
},

{
    id: 'R2.11',
    title: '§3 — tabs.ungroup on part of a group, and the event order',
    async run(t) {
        await t.scene(['x1', 'gr1', 'gr2', 'gr3', 'gr4', 'x2']);
        await t.group(['gr1', 'gr2', 'gr3', 'gr4']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated', 'tabGroups.onRemoved']);
        await t.snap('before');

        await t.step('tabs.ungroup([gr2, gr3])', () => browser.tabs.ungroup(t.ids(['gr2', 'gr3'])));

        t.expectRow('after', ['x1*', '🟥 gr1', '🟥 gr4', 'gr2', 'gr3', 'x2']);
        t.note('they move right after the last remaining member, array order kept, onMoved for each then onUpdated {groupId: -1}');
    },
},

{
    id: 'R2.12',
    title: '§3 — tabs.group on a hidden tab',
    async run(t) {
        await t.scene(['x1', 'hid', 'x2']);
        await t.hide(['hid']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated', 'tabGroups.onCreated']);
        await t.snap('before');

        await t.step('tabs.group({tabIds: [hid]})  // hid is hidden', () => t.group(['hid'], null, {settle: false}));

        t.expectRow('after', ['x1*', '🟥 hid(h)', 'x2']);
        t.note('the tab-bar side of this is the 👁️ question of R3.04');
    },
},

{
    id: 'R2.13',
    title: '§4 — hide and show a group member',
    async run(t) {
        await t.scene(['x1', 'gr1', 'gr2', 'x2']);
        await t.group(['gr1', 'gr2']);

        t.watch(['tabs.onUpdated', 'tabGroups.onRemoved']);
        await t.snap('before');

        await t.step('tabs.hide([gr2])', () => t.hide(['gr2'], {settle: false}), {snap: 'after hide'});
        t.expectRow('after hide', ['x1*', '🟥 gr1', '🟥 gr2(h)', 'x2']);

        await t.step('tabs.show([gr2])', () => t.show(['gr2'], {settle: false}), {snap: 'after show'});
        t.expectRow('after show', ['x1*', '🟥 gr1', '🟥 gr2', 'x2']);
    },
},

{
    id: 'R2.14',
    title: '§4 — move a HIDDEN tab into a visible group span',
    async run(t) {
        await t.scene(['x1', 'hid', 'gr1', 'gr2', 'x2']);
        await t.group(['gr1', 'gr2']);
        await t.hide(['hid']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated']);
        await t.snap('before');

        await t.step('tabs.move(hid, {index: 2})  // hid is hidden', () => browser.tabs.move(t.id('hid'), {index: 2}));

        t.expectRow('after', ['x1*', '🟥 gr1', '🟥 hid(h)', '🟥 gr2', 'x2']);
    },
},

{
    id: 'R2.15',
    title: '§4 — hide EVERY member of a group',
    async run(t) {
        await t.scene(['x1', 'gr1', 'gr2', 'x2']);
        await t.group(['gr1', 'gr2']);

        t.watch(['tabs.onUpdated', 'tabGroups.onRemoved']);
        await t.snap('before');

        await t.step('tabs.hide([gr1, gr2])', () => t.hide(['gr1', 'gr2'], {settle: false}));

        t.expectRow('after', ['x1*', '🟥 gr1(h)', '🟥 gr2(h)', 'x2']);
        t.expect('the group is still there with every tab hidden', (await t.groupsInfo()).length, 1);

        await t.ask('the group has no visible tabs left — is its header still shown in the tab bar?');
    },
},

];
