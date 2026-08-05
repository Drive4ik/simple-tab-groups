import {LOAD_WAIT, SCENE_URL, TAB_GROUP_ID_NONE} from '../constants.js';
import {wait} from '../test.js';

export const note = `Round 07 — facts for the native-groups audit.
(A) does the Tab object resolved by tabs.move carry hidden:true for a hidden tab — same window and cross-window;
(B) what ungroup and hide really do to the active tab of a group.`;

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

];
