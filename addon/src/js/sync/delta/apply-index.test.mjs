/**
 * Standalone node test for the pure relative→absolute move-index helper used by the delta
 * APPLY path. `apply-engine.js` is browser-dependent and cannot be imported under node, so the
 * coordinate math it performs before `Tabs.moveNative` is exercised here via the pure module.
 *
 * A synced tab.move target carries a GROUP-RELATIVE index (0 = first tab of its group), but
 * `moveNative`'s index is WINDOW-ABSOLUTE, and one STG window holds the hidden tabs of other
 * groups too. The helper converts relative→absolute as base(destGroup) + relative, where base
 * is the minimum absolute index among the destination group's tabs — the same notion
 * `reconcileGroupTabOrders` uses.
 *
 * Plain `node apply-index.test.mjs` (STG has no test runner). Exits non-zero on first failure.
 */

import {resolveAbsoluteTabIndex} from './apply-index.js';

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

// A window where group g2 owns absolute indices 3,4,5,6 (another group g1 owns 0,1,2 before it).
// A within-group reorder to relative position 2 must land at absolute 5 (base 3 + 2), NOT the
// raw relative 2 (which is inside g1).
const g2Indices = [3, 4, 5, 6];

check('within-group reorder → base + relative (absolute), not raw relative',
    resolveAbsoluteTabIndex(g2Indices, 2) === 5,
    String(resolveAbsoluteTabIndex(g2Indices, 2)));

check('within-group reorder to first slot → base itself',
    resolveAbsoluteTabIndex(g2Indices, 0) === 3);

check('within-group reorder to last slot → base + relative',
    resolveAbsoluteTabIndex(g2Indices, 3) === 6);

// base is the MINIMUM absolute index, regardless of array order.
check('base is min absolute index, order-independent',
    resolveAbsoluteTabIndex([6, 3, 5, 4], 1) === 4);

// Cross-group move: destination group currently owns absolute 10,11 (base 10). The incoming tab
// is not counted in the destination indices; it lands at base + relative.
check('cross-group move lands at base(destGroup) + relative',
    resolveAbsoluteTabIndex([10, 11], 1) === 11,
    String(resolveAbsoluteTabIndex([10, 11], 1)));

check('cross-group move appending past current tabs → base + relative',
    resolveAbsoluteTabIndex([10, 11], 2) === 12);

// Empty destination group: no base to anchor to → append at window end (-1), matching STG's
// native move-into-group default (`index: params.newTabIndex ?? -1`).
check('empty destination group → -1 (append at window end)',
    resolveAbsoluteTabIndex([], 0) === -1);

check('destination group with no finite indices → -1 (append)',
    resolveAbsoluteTabIndex([NaN, undefined], 0) === -1);

// Guards: a missing/non-integer relative index cannot form base+NaN → append.
check('non-integer relative index → -1 (append)',
    resolveAbsoluteTabIndex(g2Indices, undefined) === -1);

check('non-array indices → -1 (append)',
    resolveAbsoluteTabIndex(null, 1) === -1);

check('relative index 0 with a real base is honored (not treated as missing)',
    resolveAbsoluteTabIndex([5], 0) === 5);

// ---------------------------------------------------------------------------

if (failures.length) {
    console.error(`\n${failures.length} failed, ${passed} passed`);
    console.error('FAILURES:', failures);
    process.exit(1);
} else {
    console.log(`\n${passed} passed, 0 failed`);
}
