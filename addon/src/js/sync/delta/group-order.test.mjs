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

import {liveGroupTabOrder, groupTabsAlreadyOrdered, planGroupReorderMoves} from './group-order.js';

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

// --- planGroupReorderMoves: the (tabId → absolute targetIndex) reorder plan --------------
// The plan is what `reconcileGroupTabOrders` issues one move at a time (awaited in order):
// orderedIds[k] → {index: minIndex + k}. Because each target is at-or-left of the tab's
// current position (the placed block only ever grows leftmost-first), every move is a pure
// leftward insertion, which Firefox's single-tab `tabs.move` lays down deterministically at
// the requested index. `fxMove` below simulates that single-tab semantics so we can assert
// the plan converges to ascending `orderedIds`, even across gaps from other groups' tabs.
function fxMove(order, id, index) {
    const arr = order.slice();
    const c = arr.indexOf(id);
    if (c === -1) {
        return arr;
    }
    arr.splice(c, 1);
    const pos = Math.max(0, Math.min(index, arr.length));
    arr.splice(pos, 0, id);
    return arr;
}

function applyPlan(initialOrder, plan) {
    return plan.reduce((order, move) => fxMove(order, move.id, move.index), initialOrder);
}

// Already ordered (contiguous) ⇒ empty plan (guard holds, reconcile is a no-op).
check('plan: already ordered contiguous ⇒ empty plan',
    eq(planGroupReorderMoves([1, 2, 3], [{id: 1, index: 0}, {id: 2, index: 1}, {id: 3, index: 2}], 0), []));

// Already ordered but with gaps (other groups' hidden tabs interleave) ⇒ still empty plan:
// relative order already matches, so contiguity is NOT forced.
check('plan: already ordered with gaps ⇒ empty plan',
    eq(planGroupReorderMoves([1, 2, 3], [{id: 1, index: 5}, {id: 2, index: 8}, {id: 3, index: 11}], 5), []));

// Degenerate inputs ⇒ empty plan.
check('plan: empty orderedIds ⇒ empty plan', eq(planGroupReorderMoves([], [{id: 1, index: 0}], 0), []));
check('plan: non-finite minIndex ⇒ empty plan',
    eq(planGroupReorderMoves([1, 2], [{id: 2, index: 0}, {id: 1, index: 1}], NaN), []));

// Reversed live order ⇒ plan targets minIndex+k, and simulating it lands ascending.
{
    const orderedIds = [1, 2, 3];
    const live = [{id: 3, index: 0}, {id: 2, index: 1}, {id: 1, index: 2}];
    const plan = planGroupReorderMoves(orderedIds, live, 0);
    check('plan: reversed ⇒ targets are minIndex+k',
        plan.every((m, k) => m.index === 0 + k) && plan.length === 3,
        JSON.stringify(plan));
    const result = applyPlan([3, 2, 1], plan);
    check('plan: reversed ⇒ simulated result is ascending orderedIds',
        eq(result, [1, 2, 3]), JSON.stringify(result));
}

// Interleaved with foreign hidden tabs (indices with gaps), scrambled relative order ⇒
// sequential targets minIndex+k; simulating on the FULL window lays the group ascending and
// contiguous at minIndex..minIndex+n-1 without corrupting the foreign tabs' relative order.
{
    const orderedIds = [1, 2, 3];
    // window: f@0 f@1 id3@2 f@3 id1@4 f@5 id2@6  → group base (minIndex) = 2
    const live = [{id: 3, index: 2}, {id: 1, index: 4}, {id: 2, index: 6}];
    const minIndex = 2;
    const plan = planGroupReorderMoves(orderedIds, live, minIndex);
    check('plan: interleaved ⇒ targets minIndex+k',
        eq(plan.map(m => m.index), [2, 3, 4]), JSON.stringify(plan));
    const initialWindow = ['fa', 'fb', 3, 'fc', 1, 'fd', 2];
    const result = applyPlan(initialWindow, plan);
    const groupIds = new Set([1, 2, 3]);
    check('plan: interleaved ⇒ group relative order is ascending after simulate',
        eq(result.filter(x => groupIds.has(x)), [1, 2, 3]), JSON.stringify(result));
    check('plan: interleaved ⇒ group lands contiguous at minIndex..minIndex+n-1',
        orderedIds.every((id, k) => result.indexOf(id) === minIndex + k), JSON.stringify(result));
    check('plan: interleaved ⇒ foreign tabs keep their relative order',
        eq(result.filter(x => !groupIds.has(x)), ['fa', 'fb', 'fc', 'fd']), JSON.stringify(result));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
