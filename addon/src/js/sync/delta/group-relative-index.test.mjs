/**
 * Standalone node test for the pure GROUP-RELATIVE index helper the capture layer uses.
 *
 * Plain `node group-relative-index.test.mjs` (STG has no test runner). Imports the
 * import-free module directly — no extension host — and asserts the within-group
 * positional math the delta tab.add/tab.modify/tab.move records depend on. Exits non-zero
 * on the first failure. Lives here so `node src/js/sync/delta/*.test.mjs` picks it up.
 */

import {computeGroupRelativeIndex} from './group-relative-index.js';

let passed = 0;
const failures = [];

function check(name, cond, detail) {
    if (cond) {
        passed++;
        console.log(`  PASS  ${name}`);
    } else {
        failures.push(name);
        console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

// A window where group 'g1' owns tabs 10 and 30, group 'g2' owns 20, and 40 is ungrouped.
// Browser-absolute indexes are interleaved (pinned/other groups shift them); the helper
// must return the position WITHIN the group, ignoring the absolute index.
const windowTabs = [
    {id: 10, index: 1},
    {id: 20, index: 2},
    {id: 30, index: 3},
    {id: 40, index: 4},
];
const groupOf = {10: 'g1', 20: 'g2', 30: 'g1', 40: undefined};
const getTabGroup = id => groupOf[id];

check('first tab of its group → 0 (not its absolute index 1)',
    computeGroupRelativeIndex(windowTabs, getTabGroup, 10, 'g1') === 0);

check('second tab of its group → 1 (not its absolute index 3)',
    computeGroupRelativeIndex(windowTabs, getTabGroup, 30, 'g1') === 1);

check('only tab of a different group → 0',
    computeGroupRelativeIndex(windowTabs, getTabGroup, 20, 'g2') === 0);

check('tab not in the requested group → null',
    computeGroupRelativeIndex(windowTabs, getTabGroup, 20, 'g1') === null);

check('ungrouped tab → null',
    computeGroupRelativeIndex(windowTabs, getTabGroup, 40, 'g1') === null);

check('unknown tab id → null',
    computeGroupRelativeIndex(windowTabs, getTabGroup, 999, 'g1') === null);

// position is by browser index order, NOT array order: feed them out of order.
{
    const unordered = [
        {id: 30, index: 3},
        {id: 10, index: 1},
    ];
    check('order is by browser index, not array order',
        computeGroupRelativeIndex(unordered, getTabGroup, 10, 'g1') === 0 &&
        computeGroupRelativeIndex(unordered, getTabGroup, 30, 'g1') === 1);
}

// guard inputs: null/missing args → null (caller omits index ⇒ replay appends at end).
check('missing groupId → null', computeGroupRelativeIndex(windowTabs, getTabGroup, 10, undefined) === null);
check('non-array windowTabs → null', computeGroupRelativeIndex(null, getTabGroup, 10, 'g1') === null);
check('non-function resolver → null', computeGroupRelativeIndex(windowTabs, null, 10, 'g1') === null);
check('empty window → null', computeGroupRelativeIndex([], getTabGroup, 10, 'g1') === null);

// ---------------------------------------------------------------------------

if (failures.length) {
    console.error(`\n${failures.length} failed, ${passed} passed`);
    console.error('FAILURES:', failures);
    process.exit(1);
} else {
    console.log(`\n${passed} passed, 0 failed`);
}
