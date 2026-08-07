import {LOAD_WAIT, SCENE_URL, TAB_GROUP_ID_NONE} from '../constants.js';
import {wait} from '../test.js';

export const note = `Round 07 — facts for the native-groups audit.
(A) does the Tab object resolved by tabs.move carry hidden:true for a hidden tab — same window and cross-window;
(B) what ungroup and hide really do to the active tab of a group;
(C) membership of a tab created at the end of the strip when the strip ends with a group span,
and under newTabPosition=afterCurrent when the active tab is a member;
(D) does an ARRAY tabs.move onto a member's slot join every moved tab (§1 is verified for a single tab only);
(E) what tabs.ungroup does to a HIDDEN member;
(F) tabs.create at the FIRST member's slot: the occupant is a member, yet R7.12 (hidden tabs
before the span) got no membership — R7.13 is the control with visible neighbours.`;

export const tests = [

{
    id: 'R7.01',
    title: 'tabs.move of a hidden tab, same window — hidden flag on the resolved object',
    async run(t) {
        await t.scene(['a', 'mover', 'b']);
        await t.hide(['mover']);
        await t.snap('before');

        const moved = await t.step('tabs.move(mover, {index: 0})', () => browser.tabs.move(t.id('mover'), {index: 0}));
        const movedTab = Array.isArray(moved) ? moved[0] : moved;

        t.expectRow('after', ['mover(h)', 'a*', 'b']);
        t.expect('the moved tab is still hidden', movedTab.hidden, true);

        t.note(`resolved object: hidden:${movedTab.hidden} index:${movedTab.index} groupId:${movedTab.groupId}`);

        const fresh = await browser.tabs.get(t.id('mover'));
        t.note(`fresh tabs.get: hidden:${fresh.hidden} index:${fresh.index}`);
        t.expect('the resolved object agrees with a fresh tabs.get on hidden', movedTab.hidden, fresh.hidden);
    },
},

{
    id: 'R7.02',
    title: 'tabs.move array [hidden, visible] to another window, index -1 — hidden flags on the resolved objects',
    async run(t) {
        await t.scene(['a', 'mover', 'vis']);
        await t.hide(['mover']);
        await t.snap('before');

        const win2 = await browser.windows.create({url: SCENE_URL});

        try {
            await wait(LOAD_WAIT);

            const moved = await t.step('tabs.move([mover(h), vis], {windowId: win2, index: -1})', () => {
                return browser.tabs.move(t.ids(['mover', 'vis']), {windowId: win2.id, index: -1});
            }, {snap: 'after (window 1)'});

            for (const movedTab of moved) {
                t.note(`resolved ${t.known(movedTab.id)}: hidden:${movedTab.hidden} index:${movedTab.index} inWin2:${movedTab.windowId === win2.id} groupId:${movedTab.groupId}`);
            }

            for (const name of ['mover', 'vis']) {
                const fresh = await browser.tabs.get(t.id(name));
                t.note(`fresh tabs.get ${name}: hidden:${fresh.hidden} index:${fresh.index} inWin2:${fresh.windowId === win2.id}`);
            }

            t.expectRow('after (window 1)', ['a*']);
            t.expect('a hidden tab arrives VISIBLE in the other window', moved.map(movedTab => movedTab.hidden), [false, false]);
            t.expect('a fresh tabs.get agrees', (await browser.tabs.get(t.id('mover'))).hidden, false);
        } finally {
            await browser.windows.remove(win2.id).catch(() => {});
        }
    },
},

{
    id: 'R7.03',
    title: 'ungroup + hide when the active tab is inside the group',
    async run(t) {
        await t.scene(['x', 'a', 'b', 'c']);
        await t.group(['a', 'b', 'c'], {title: 'G'});
        await t.activate('a');

        t.watch(['tabGroups.onRemoved', 'tabs.onUpdated'], {updatedKeys: ['groupId', 'hidden']});
        await t.snap('before');

        await t.step('tabs.ungroup([a, b, c])  — a is active', () => browser.tabs.ungroup(t.ids(['a', 'b', 'c'])), {snap: 'after ungroup'});

        const afterUngroup = await browser.tabs.get(t.id('a'));
        t.note(`a after ungroup: groupId:${afterUngroup.groupId} active:${afterUngroup.active}`);

        t.expectRow('after ungroup', ['x', 'a*', 'b', 'c']);
        t.expect('the active member left the group like any other', afterUngroup.groupId, TAB_GROUP_ID_NONE);
        t.expect('the group is gone', (await t.groupsInfo()).length, 0);

        const hidden = await t.step('tabs.hide([a, b, c])  — a is active', () => t.hide(['a', 'b', 'c'], {settle: false}), {snap: 'after hide'});
        t.note(`tabs.hide resolved with [${hidden.map(id => t.known(id)).join(', ')}]`);

        t.expectRow('after hide', ['x', 'a*', 'b(h)', 'c(h)']);
        t.expect('tabs.hide silently skipped the active tab', hidden.map(id => t.known(id)), ['b', 'c']);

        const hiddenAgain = await t.step('activate(x), then tabs.hide([a])', async () => {
            await t.activate('x', {settle: false});
            return t.hide(['a'], {settle: false});
        }, {snap: 'after activate x + hide a'});

        t.note(`second tabs.hide resolved with [${hiddenAgain.map(id => t.known(id)).join(', ')}]`);

        t.expectRow('after activate x + hide a', ['x*', 'a(h)', 'b(h)', 'c(h)']);
        t.expect('the former active tab hides normally once something else is active', hiddenAgain.map(id => t.known(id)), ['a']);
    },
},

{
    id: 'R7.04',
    title: 'tabs.create at the very end of a strip that ends with a group span — does the new tab join?',
    async run(t) {
        await t.scene(['keep1', 'gr1', 'gr2']);
        await t.group(['gr1', 'gr2'], {title: 'G'});

        const applied = await t.setting('newTabPosition', 'atEnd');
        t.note(`newTabPosition: requested atEnd, applied ${applied.applied}`);

        t.watch(['tabs.onCreated', 'tabs.onUpdated', 'tabs.onMoved'], {updatedKeys: ['groupId']});
        await t.snap('before');

        const explicit = await t.step('tabs.create(new1, {index: 3})  — index == strip length, previous occupant: none', () => {
            return t.create('new1', {index: 3});
        });

        const freshExplicit = await browser.tabs.get(explicit.id);
        t.note(`new1 (explicit index 3): index:${freshExplicit.index} group:${t.square(freshExplicit.groupId) || freshExplicit.groupId}`);

        t.expectRow('after', ['keep1*', '🟥 gr1', '🟥 gr2', '➕new1']);
        t.expect('appended with an explicit index did not join', freshExplicit.groupId, TAB_GROUP_ID_NONE);

        const appended = await t.step('tabs.create(new2)  — no index, atEnd', () => t.create('new2'));

        const freshAppended = await browser.tabs.get(appended.id);
        t.note(`new2 (no index, atEnd): index:${freshAppended.index} group:${t.square(freshAppended.groupId) || freshAppended.groupId}`);

        t.expectRow('after 2', ['keep1*', '🟥 gr1', '🟥 gr2', '➕new1', '➕new2']);
        t.expect('appended with no index did not join', freshAppended.groupId, TAB_GROUP_ID_NONE);
    },
},

{
    id: 'R7.05',
    title: 'tabs.create under afterCurrent when the active tab is a MIDDLE member — position and membership',
    async run(t) {
        await t.scene(['keep1', 'gr1', 'gr2', 'gr3', 'keep2']);
        await t.group(['gr1', 'gr2', 'gr3'], {title: 'G'});
        await t.activate('gr2');

        const applied = await t.setting('newTabPosition', 'afterCurrent');
        t.note(`newTabPosition: requested afterCurrent, applied ${applied.applied}`);

        t.watch(['tabs.onCreated', 'tabs.onUpdated', 'tabs.onMoved'], {updatedKeys: ['groupId']});
        await t.snap('before');

        const created = await t.step('tabs.create(new1)  — no index, active tab is gr2 inside the span', () => t.create('new1'));

        const fresh = await browser.tabs.get(created.id);
        t.note(`new1: index:${fresh.index} group:${t.square(fresh.groupId) || fresh.groupId}`);

        t.expectRow('after', ['keep1', '🟥 gr1', '🟥 gr2*', '🟥 ➕new1', '🟥 gr3', 'keep2']);
        t.expect('born inside the group right after the active member', [fresh.index, fresh.groupId !== TAB_GROUP_ID_NONE], [3, true]);
    },
},

{
    id: 'R7.06',
    title: 'tabs.create under afterCurrent when the active tab is the LAST member of a span at the end of the strip',
    async run(t) {
        await t.scene(['keep1', 'gr1', 'gr2']);
        await t.group(['gr1', 'gr2'], {title: 'G'});
        await t.activate('gr2');

        const applied = await t.setting('newTabPosition', 'afterCurrent');
        t.note(`newTabPosition: requested afterCurrent, applied ${applied.applied}`);

        t.watch(['tabs.onCreated', 'tabs.onUpdated', 'tabs.onMoved'], {updatedKeys: ['groupId']});
        await t.snap('before');

        const created = await t.step('tabs.create(new1)  — no index, active tab is gr2, the last tab of the strip', () => t.create('new1'));

        const fresh = await browser.tabs.get(created.id);
        t.note(`new1: index:${fresh.index} group:${t.square(fresh.groupId) || fresh.groupId}`);

        t.expectRow('after', ['keep1', '🟥 gr1', '🟥 gr2*', '🟥 ➕new1']);
        t.expect('appended past the end and still joined', [fresh.index, fresh.groupId !== TAB_GROUP_ID_NONE], [3, true]);
    },
},

{
    id: 'R7.07',
    title: 'ARRAY tabs.move onto a member slot — do ALL moved tabs join, and what happens on the way back',
    async run(t) {
        await t.scene(['m1', 'm2', 'keep1', 'gr1', 'gr2', 'gr3', 'keep2']);
        await t.group(['gr1', 'gr2', 'gr3'], {title: 'G'});

        t.watch(['tabs.onMoved', 'tabs.onUpdated', 'tabGroups.onRemoved'], {updatedKeys: ['groupId']});
        await t.snap('before');

        await t.step('tabs.move([m1, m2], {index: 4})  — that slot held 🟥 gr2', () => {
            return browser.tabs.move(t.ids(['m1', 'm2']), {index: 4});
        });

        const joined = [];

        for (const name of ['m1', 'm2']) {
            const fresh = await browser.tabs.get(t.id(name));
            joined.push(fresh.groupId !== TAB_GROUP_ID_NONE);
            t.note(`${name} after move in: index:${fresh.index} group:${t.square(fresh.groupId) || fresh.groupId}`);
        }

        t.expectRow('after', ['keep1', '🟥 gr1', '🟥 gr2', '🟥 m1*', '🟥 m2', '🟥 gr3', 'keep2']);
        t.expect('every moved tab joined', joined, [true, true]);

        await t.step('tabs.move([m1, m2], {index: 0})  — back out, onto an outsider slot', () => {
            return browser.tabs.move(t.ids(['m1', 'm2']), {index: 0});
        });

        const left = [];

        for (const name of ['m1', 'm2']) {
            const fresh = await browser.tabs.get(t.id(name));
            left.push(fresh.groupId === TAB_GROUP_ID_NONE);
            t.note(`${name} after move out: index:${fresh.index} group:${t.square(fresh.groupId) || fresh.groupId}`);
        }

        t.note(`groups left: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);

        t.expectRow('after 2', ['m1*', 'm2', 'keep1', '🟥 gr1', '🟥 gr2', '🟥 gr3', 'keep2']);
        t.expect('every moved tab left, the group survived', [...left, (await t.groupsInfo()).length], [true, true, 1]);
    },
},

{
    id: 'R7.08',
    title: 'tabs.ungroup of a HIDDEN member — does it resolve, lose the group, move the tab',
    async run(t) {
        await t.scene(['keep1', 'gr1', 'gr2', 'gr3']);
        await t.group(['gr1', 'gr2', 'gr3'], {title: 'G'});
        await t.hide(['gr2']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated', 'tabGroups.onRemoved'], {updatedKeys: ['groupId', 'hidden']});
        await t.snap('before (gr2 hidden, still a member)');

        await t.step('tabs.ungroup([gr2])  — gr2 is hidden', () => browser.tabs.ungroup([t.id('gr2')]));

        const afterUngroup = await browser.tabs.get(t.id('gr2'));
        t.note(`gr2 after ungroup: hidden:${afterUngroup.hidden} index:${afterUngroup.index} group:${t.square(afterUngroup.groupId) || afterUngroup.groupId}`);

        t.expectRow('after', ['keep1*', '🟥 gr1', '🟥 gr3', 'gr2(h)']);
        t.expect('lost the group, moved after the last member, stayed hidden',
            [afterUngroup.groupId, afterUngroup.index, afterUngroup.hidden], [TAB_GROUP_ID_NONE, 3, true]);

        await t.step('tabs.ungroup([gr1, gr3])  — the remaining visible members', () => {
            return browser.tabs.ungroup(t.ids(['gr1', 'gr3']));
        });

        t.note(`groups left: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);

        t.expectRow('after 2', ['keep1*', 'gr1', 'gr3', 'gr2(h)']);
        t.expect('the group is gone', (await t.groupsInfo()).length, 0);

        await t.step('tabs.show([gr2])', () => t.show(['gr2'], {settle: false}));

        const shown = await browser.tabs.get(t.id('gr2'));
        t.note(`gr2 after show: hidden:${shown.hidden} index:${shown.index} group:${t.square(shown.groupId) || shown.groupId}`);

        t.expectRow('after 3', ['keep1*', 'gr1', 'gr3', 'gr2']);
        t.expect('shown in place, no further move', [shown.index, shown.hidden], [3, false]);
    },
},

{
    id: 'R7.12',
    title: 'tabs.create at a member slot that sits right after hidden tabs — §7 with hidden neighbours',
    async run(t) {
        await t.scene(['hid1', 'hid2', 'gr1', 'gr2']);
        await t.group(['gr1', 'gr2'], {title: 'G'});
        await t.activate('gr1');
        await t.hide(['hid1', 'hid2']);

        t.watch(['tabs.onCreated', 'tabs.onUpdated', 'tabs.onMoved'], {updatedKeys: ['groupId', 'hidden']});
        await t.snap('before');

        const created = await t.step('tabs.create(new1, {index: 2})  — that slot held 🟥 gr1', () => {
            return t.create('new1', {index: 2});
        });

        const fresh = await browser.tabs.get(created.id);
        t.note(`new1: index:${fresh.index} group:${t.square(fresh.groupId) || fresh.groupId} hidden:${fresh.hidden}`);

        t.expectRow('after', ['hid1(h)', 'hid2(h)', '➕new1', '🟥 gr1*', '🟥 gr2']);
        t.expect('landed before the span, no membership', [fresh.index, fresh.groupId], [2, TAB_GROUP_ID_NONE]);
    },
},

{
    id: 'R7.13',
    title: 'tabs.create at the FIRST member slot, visible neighbours — control for R7.12',
    async run(t) {
        await t.scene(['x1', 'x2', 'gr1', 'gr2']);
        await t.group(['gr1', 'gr2'], {title: 'G'});

        t.watch(['tabs.onCreated', 'tabs.onUpdated', 'tabs.onMoved'], {updatedKeys: ['groupId', 'hidden']});
        await t.snap('before');

        const created = await t.step('tabs.create(new1, {index: 2})  — that slot held 🟥 gr1, the first member', () => {
            return t.create('new1', {index: 2});
        });

        const fresh = await browser.tabs.get(created.id);
        t.note(`new1: index:${fresh.index} group:${t.square(fresh.groupId) || fresh.groupId}`);

        t.expectRow('after', ['x1*', 'x2', '➕new1', '🟥 gr1', '🟥 gr2']);
        t.expect('landed before the span, no membership', [fresh.index, fresh.groupId], [2, TAB_GROUP_ID_NONE]);
    },
},

];
