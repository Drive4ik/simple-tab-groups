export const note = `Round 15 — a plain array tabs.move to an EXPLICIT index inside one window, no native groups.
TABGROUPS-BEHAVIOR.md §21 (R1.19) shows the array landing as a block only when every other mover
stands BEYOND the target index. Not covered: movers standing BEFORE the target, the set gathered
at its smallest index in reverse, and hidden outsiders sitting inside the set. These are exactly
the calls STG makes to collect a group into a block (Tabs.ensureSorted): the target is the first
tab's own index (cloud sync, backup restore) or the smallest index of the set (createMultiple).
Every test prints the resolved objects and a fresh tabs.query — the fact is the final order
(MOVE-TABS-BEHAVIOR.md §5).`;

const HIDDEN_KEYS = ['hidden'];

const indexOf = name => async t => (await browser.tabs.get(t.id(name))).index;

const smallestIndexOf = names => async t => {
    const tabs = await Promise.all(t.ids(names).map(id => browser.tabs.get(id)));
    return Math.min(...tabs.map(tab => tab.index));
};

const gatherTest = (id, title, {scene, hidden = [], movers, target, comment, after}) => ({
    id,
    title,
    async run(t) {
        await t.scene(scene);

        if (hidden.length) {
            await t.hide(hidden);
        }

        t.watch(['tabs.onMoved', 'tabs.onUpdated'], {updatedKeys: HIDDEN_KEYS});
        await t.snap('before');

        const index = await target(t);

        const resolved = await t.step(`tabs.move([${movers.join(', ')}], {index: ${index}})  // ${comment}`, () => {
            return browser.tabs.move(t.ids(movers), {index});
        });

        t.note(`resolved: ${resolved.map(tab => `${t.nameOf(tab)} index:${tab.index} hidden:${tab.hidden}`).join(', ')}`);
        t.note(`fresh tabs.query: ${(await t.query()).map(tab => `${t.nameOf(tab)}:${tab.index}`).join(', ')}`);

        t.expectRow('after', after);
    },
});

export const tests = [

gatherTest('R15.01', 'gathered at the FIRST mover\'s own slot, the rest stand beyond it with a HIDDEN outsider block in between — the cloud-sync scene', {
    scene: ['g0', 'g1', 'h0', 'h1', 'h2', 'gnew'],
    hidden: ['h0', 'h1', 'h2'],
    movers: ['g0', 'g1', 'gnew'],
    target: indexOf('g0'),
    comment: 'index of g0 itself',
    after: ['g0*', 'g1', 'gnew', 'h0(h)', 'h1(h)', 'h2(h)'],
}),

gatherTest('R15.02', 'the set stands in REVERSE order, gathered at its SMALLEST index — the createMultiple safety net', {
    scene: ['x', 'c', 'b', 'a', 'y'],
    movers: ['a', 'b', 'c'],
    target: smallestIndexOf(['a', 'b', 'c']),
    comment: 'the smallest index of the set, held by c',
    after: ['x*', 'a', 'b', 'c', 'y'],
}),

gatherTest('R15.03', 'gathered at the FIRST mover\'s own slot when the other mover stands BEFORE it', {
    scene: ['x', 'a', 'b', 'y'],
    movers: ['b', 'a'],
    target: indexOf('b'),
    comment: 'index of b itself, a stands before it',
    after: ['x*', 'b', 'a', 'y'],
}),

gatherTest('R15.04', 'gathered at the FIRST mover\'s own slot with movers on BOTH sides of it', {
    scene: ['p', 'x', 'q', 'y', 'r'],
    movers: ['q', 'p', 'r'],
    target: indexOf('q'),
    comment: 'index of q itself, p stands before it, r beyond',
    after: ['x', 'q', 'p*', 'r', 'y'],
}),

];
