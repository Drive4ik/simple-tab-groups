/**
 * Standalone node test for the PURE reconcile no-op guard (`group-order.js`).
 *
 * Plain `node group-order.test.mjs` (STG has no test runner). The module is pure (no
 * `browser.*` / cache), so it imports directly.
 *
 * Regression for the "index storm": `reconcileGroupTabOrders` used to call
 * `Tabs.moveNative` for every group on every sync, physically re-laying tabs that were
 * already in the resolved order (and echoing those moves back into the delta log).
 * `groupTabsAlreadyOrdered` compares the group's CURRENT physical order (its live tabs
 * sorted by `.index`) against the resolved order so reconcile only moves when they differ.
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs); it uses
 * node globals (process, console) the browser config bans.
 */

import {liveGroupTabOrder, groupTabsAlreadyOrdered} from './group-order.js';

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

function eq(a, b) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

// --- liveGroupTabOrder: physical order is `.index`, NOT array order ------------------------
check('live order follows .index, not array order',
    eq(liveGroupTabOrder([{id: 3, index: 2}, {id: 1, index: 0}, {id: 2, index: 1}]), [1, 2, 3]));
check('tabs without an id are dropped',
    eq(liveGroupTabOrder([{id: 1, index: 0}, {index: 1}, {id: 2, index: 2}]), [1, 2]));
check('a tab with a non-finite index sorts last (deterministic)',
    eq(liveGroupTabOrder([{id: 2, index: 5}, {id: 1}]), [2, 1]));
check('non-array input ⇒ empty', eq(liveGroupTabOrder(null), []));

// --- groupTabsAlreadyOrdered: the no-op guard ---------------------------------------------
// Already in resolved order (array order differs, index order matches) ⇒ SKIP the move.
check('already ordered (index order == resolved) ⇒ skip (true), despite scrambled array',
    groupTabsAlreadyOrdered([1, 2, 3], [{id: 3, index: 2}, {id: 1, index: 0}, {id: 2, index: 1}]) === true);
check('already ordered, array happens to match too ⇒ skip (true)',
    groupTabsAlreadyOrdered([1, 2, 3], [{id: 1, index: 0}, {id: 2, index: 1}, {id: 3, index: 2}]) === true);

// Out of order ⇒ must reorder.
check('physical order differs from resolved ⇒ reorder (false)',
    groupTabsAlreadyOrdered([1, 2, 3], [{id: 2, index: 0}, {id: 1, index: 1}, {id: 3, index: 2}]) === false);
check('reversed ⇒ reorder (false)',
    groupTabsAlreadyOrdered([1, 2, 3], [{id: 3, index: 0}, {id: 2, index: 1}, {id: 1, index: 2}]) === false);

// Length mismatch ⇒ not "already ordered" (reconcile decides with the full id list).
check('length mismatch ⇒ reorder (false)',
    groupTabsAlreadyOrdered([1, 2, 3], [{id: 1, index: 0}, {id: 2, index: 1}]) === false);

// Degenerate inputs are safe no-ops (nothing to do).
check('empty orderedIds ⇒ treated as already ordered (skip)',
    groupTabsAlreadyOrdered([], [{id: 1, index: 0}]) === true);
check('non-array orderedIds ⇒ treated as already ordered (skip)',
    groupTabsAlreadyOrdered(null, [{id: 1, index: 0}]) === true);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
