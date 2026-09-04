/**
 * Standalone node test for the pure relative→absolute move-index helper used by the delta
 * APPLY path. `apply-engine.js` is browser-dependent and cannot be imported under node, so the
 * coordinate math it performs before `Tabs.moveNative` is exercised here via the pure module.
 *
 * A synced tab.move target carries a GROUP-RELATIVE index in the SYNCABLE space: 0 = first
 * SYNCABLE tab of its group, because the snapshot the diff indexes (`buildLocalState` /
 * `indexTabs`) drops non-syncable tabs and renumbers the survivors densely — the same space
 * `computeGroupRelativeIndex` captures in. `moveNative`'s index is WINDOW-ABSOLUTE, one STG
 * window also holds the hidden tabs of other groups, and a group may itself hold non-syncable
 * tabs (about:newtab, about:blank …) that occupy absolute slots but no relative position.
 *
 * The helper therefore maps relative R onto the absolute index of the R-th SYNCABLE tab of the
 * destination group. `min(indices) + R` — the old formula — only agreed with that when the
 * group was contiguous AND wholly syncable.
 *
 * Contract:
 *   - input is the destination group's live tabs ({index, url}), in any order;
 *   - R < syncableCount  → absolute index of the R-th syncable tab;
 *   - R >= syncableCount → one past the last syncable tab (append at the group's end);
 *   - no syncable tab / no usable R → -1 (append at window end), matching STG's native
 *     move-into-group default (`index: params.newTabIndex ?? -1`).
 *
 * Plain `node apply-index.test.mjs` (STG has no test runner). Exits non-zero on first failure.
 */

import {resolveAbsoluteTabIndex} from './apply-index.js';
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

let nextTabId = 1;
const syncable = index => ({id: nextTabId++, index, url: `https://example.com/${index}`});
const nonSyncable = index => ({id: nextTabId++, index, url: 'about:newtab'});

// --- unchanged behaviour: a wholly syncable, contiguous group -----------------------------
// Group g2 owns absolute indices 3,4,5,6 (another group owns 0,1,2 before it). Every answer
// below is exactly what `min + relative` produced before the filtered-space fix.
const g2Tabs = [syncable(3), syncable(4), syncable(5), syncable(6)];

check('all-syncable group: within-group reorder → base + relative (absolute), not raw relative',
    resolveAbsoluteTabIndex(g2Tabs, 2) === 5,
    String(resolveAbsoluteTabIndex(g2Tabs, 2)));

check('all-syncable group: reorder to first slot → base itself',
    resolveAbsoluteTabIndex(g2Tabs, 0) === 3);

check('all-syncable group: reorder to last slot → base + relative',
    resolveAbsoluteTabIndex(g2Tabs, 3) === 6);

check('all-syncable group: order-independent (tabs handed over unsorted)',
    resolveAbsoluteTabIndex([syncable(6), syncable(3), syncable(5), syncable(4)], 1) === 4);

check('all-syncable group: cross-group move lands at base(destGroup) + relative',
    resolveAbsoluteTabIndex([syncable(10), syncable(11)], 1) === 11,
    String(resolveAbsoluteTabIndex([syncable(10), syncable(11)], 1)));

check('all-syncable group: appending past current tabs → one past the last tab',
    resolveAbsoluteTabIndex([syncable(10), syncable(11)], 2) === 12);

check('all-syncable group: relative 0 with a real base is honored (not treated as missing)',
    resolveAbsoluteTabIndex([syncable(5)], 0) === 5);

// --- non-syncable tabs inside the group ---------------------------------------------------
// Window: g@3 = about:newtab, g@4, g@5, g@6. The syncable space is [4,5,6]; relative 0 is
// absolute 4, NOT the old min+0 = 3 (the about:newtab slot).
{
    const tabs = [nonSyncable(3), syncable(4), syncable(5), syncable(6)];
    check('non-syncable BEFORE the target → skipped, relative 0 → first syncable slot',
        resolveAbsoluteTabIndex(tabs, 0) === 4, String(resolveAbsoluteTabIndex(tabs, 0)));
    check('non-syncable before the target → relative 2 → third syncable slot',
        resolveAbsoluteTabIndex(tabs, 2) === 6, String(resolveAbsoluteTabIndex(tabs, 2)));
}

// Window: g@3, g@4 = about:newtab, g@5, g@6. The syncable space is [3,5,6]; relative 1 is
// absolute 5, where the old min+1 = 4 landed on the about:newtab slot.
{
    const tabs = [syncable(3), nonSyncable(4), syncable(5), syncable(6)];
    check('non-syncable BETWEEN base and target → relative 1 → absolute 5 (old code said 4)',
        resolveAbsoluteTabIndex(tabs, 1) === 5, String(resolveAbsoluteTabIndex(tabs, 1)));
    check('non-syncable between base and target → relative 2 → absolute 6',
        resolveAbsoluteTabIndex(tabs, 2) === 6, String(resolveAbsoluteTabIndex(tabs, 2)));
    check('non-syncable between base and target → relative 0 is still the base',
        resolveAbsoluteTabIndex(tabs, 0) === 3);
}

// Window: g@3, g@4, g@5 = about:newtab. A non-syncable tab past the target shifts nothing.
{
    const tabs = [syncable(3), syncable(4), nonSyncable(5)];
    check('non-syncable AFTER the target → no shift',
        resolveAbsoluteTabIndex(tabs, 1) === 4, String(resolveAbsoluteTabIndex(tabs, 1)));
    check('non-syncable after the target → append lands one past the last SYNCABLE tab',
        resolveAbsoluteTabIndex(tabs, 2) === 5, String(resolveAbsoluteTabIndex(tabs, 2)));
}

// about:blank / about:home are non-syncable too; other about: urls are syncable.
{
    const tabs = [
        {id: 900, index: 3, url: 'about:blank'},
        {id: 901, index: 4, url: 'about:config'},
        {id: 902, index: 5, url: 'about:home'},
        {id: 903, index: 6, url: 'https://example.com/'},
    ];
    check('about:blank/about:home skipped, about:config counted',
        resolveAbsoluteTabIndex(tabs, 0) === 4 && resolveAbsoluteTabIndex(tabs, 1) === 6,
        `${resolveAbsoluteTabIndex(tabs, 0)}/${resolveAbsoluteTabIndex(tabs, 1)}`);
}

// A stub page is judged by the url it wraps — the same unwrapping the capture side applies.
{
    const tabs = [
        {id: 910, index: 3, url: 'moz-extension://abc/help/stg-unsupported-url.html?url=ftp%3A%2F%2Fhost%2Ff'},
        {id: 911, index: 4, url: 'about:newtab'},
        {id: 912, index: 5, url: 'https://example.com/'},
    ];
    check('stub page wrapping a non-syncable url stays non-syncable',
        resolveAbsoluteTabIndex(tabs, 0) === 5, String(resolveAbsoluteTabIndex(tabs, 0)));
}

// --- non-contiguous group: other groups' HIDDEN tabs interleave ----------------------------
// Window: f@0 f@1 g@2 f@3 g@4 g@5 f@6 g@7 → the group's syncable absolute indices are
// [2,4,5,7]. The old min+R walked straight into the foreign tabs at 3 and 6.
{
    const tabs = [syncable(2), syncable(4), syncable(5), syncable(7)];
    check('non-contiguous group: relative 1 → absolute 4, not min+1 = 3 (a foreign tab)',
        resolveAbsoluteTabIndex(tabs, 1) === 4, String(resolveAbsoluteTabIndex(tabs, 1)));
    check('non-contiguous group: relative 3 → absolute 7, not min+3 = 5',
        resolveAbsoluteTabIndex(tabs, 3) === 7, String(resolveAbsoluteTabIndex(tabs, 3)));
    check('non-contiguous group: append → one past the last group tab (8), not min+4 = 6',
        resolveAbsoluteTabIndex(tabs, 4) === 8, String(resolveAbsoluteTabIndex(tabs, 4)));
}

// Non-contiguous AND holding a non-syncable tab: f@0 g@1 f@2 g@3=about:newtab f@4 g@5 g@6.
{
    const tabs = [syncable(1), nonSyncable(3), syncable(5), syncable(6)];
    check('non-contiguous group with a non-syncable member: relative 1 → absolute 5',
        resolveAbsoluteTabIndex(tabs, 1) === 5, String(resolveAbsoluteTabIndex(tabs, 1)));
    check('non-contiguous group with a non-syncable member: relative 2 → absolute 6',
        resolveAbsoluteTabIndex(tabs, 2) === 6, String(resolveAbsoluteTabIndex(tabs, 2)));
}

// --- R past the end, empty and all-non-syncable groups -------------------------------------
check('relative index past the end → one past the last syncable tab (append inside the group)',
    resolveAbsoluteTabIndex([syncable(3), syncable(4)], 7) === 5,
    String(resolveAbsoluteTabIndex([syncable(3), syncable(4)], 7)));

check('empty destination group → -1 (append at window end)',
    resolveAbsoluteTabIndex([], 0) === -1);

check('all-non-syncable destination group → -1 (append at window end), not min of their slots',
    resolveAbsoluteTabIndex([nonSyncable(3), nonSyncable(4)], 0) === -1,
    String(resolveAbsoluteTabIndex([nonSyncable(3), nonSyncable(4)], 0)));

check('destination group with no finite indices → -1 (append)',
    resolveAbsoluteTabIndex([{id: 920, index: NaN, url: 'https://a/'}, {id: 921, url: 'https://b/'}], 0) === -1);

// Guards: a missing/non-integer/negative relative index cannot name a slot → append.
check('non-integer relative index → -1 (append)',
    resolveAbsoluteTabIndex(g2Tabs, undefined) === -1);

check('fractional relative index → -1 (append)',
    resolveAbsoluteTabIndex(g2Tabs, 1.5) === -1);

check('negative relative index → -1 (append)',
    resolveAbsoluteTabIndex(g2Tabs, -1) === -1);

check('non-array destination tabs → -1 (append)',
    resolveAbsoluteTabIndex(null, 1) === -1);

check('null entries in the tab list are ignored',
    resolveAbsoluteTabIndex([null, syncable(4), undefined, syncable(6)], 1) === 6);

// --- the move actually lands where the peer meant ------------------------------------------
// `fxMove` mirrors the single-tab `browser.tabs.move` semantics already simulated in
// group-order.test.mjs: the tab is pulled out of the window array and reinserted at the
// requested index. Every move on this path is a SINGLE-tab move — the array form that laid the
// group down reversed in the "reconcile-order-reversal" incident is never used here.
function fxMove(order, id, index) {
    const arr = order.slice();
    const current = arr.indexOf(id);
    if (current === -1) {
        return arr;
    }
    arr.splice(current, 1);
    arr.splice(Math.max(0, Math.min(index, arr.length)), 0, id);
    return arr;
}

{
    // Window slice starting at absolute 3: A@3 (syncable), N@4 (about:newtab), B@5 (syncable).
    // The peer says A must be the SECOND syncable tab of the group, i.e. after B.
    const base = 3;
    const A = {id: 1, index: 3, url: 'https://a/'};
    const N = {id: 2, index: 4, url: 'about:newtab'};
    const B = {id: 3, index: 5, url: 'https://b/'};
    const groupTabs = [A, N, B];
    const syncableIds = new Set([A.id, B.id]);
    const initial = [A.id, N.id, B.id];
    const syncableOrder = order => JSON.stringify(order.filter(id => syncableIds.has(id)));

    const fixed = fxMove(initial, A.id, resolveAbsoluteTabIndex(groupTabs, 1) - base);
    check('simulate: relative 1 lands A after B in the syncable order',
        syncableOrder(fixed) === JSON.stringify([B.id, A.id]), JSON.stringify(fixed));

    const oldFormula = Math.min(A.index, N.index, B.index) + 1;
    const broken = fxMove(initial, A.id, oldFormula - base);
    check('simulate: the old min+relative index leaves A FIRST — the ping-pong',
        syncableOrder(broken) === JSON.stringify([A.id, B.id]), JSON.stringify(broken));
}

// --- parity: capture → apply round trip is the identity ------------------------------------
// For every syncable tab of a mixed group, the relative index the CAPTURE side records must
// resolve back to that tab's own absolute index on the APPLY side. Violating this invariant is
// what produced the cross-device index ping-pong.
{
    const groupId = 'g-mixed';
    const otherGroupId = 'g-other';
    const windowTabs = [
        {id: 101, index: 0, url: 'https://other/0', group: otherGroupId},
        {id: 102, index: 1, url: 'about:newtab', group: groupId},
        {id: 103, index: 2, url: 'https://mixed/a', group: groupId},
        {id: 104, index: 3, url: 'https://other/1', group: otherGroupId},
        {id: 105, index: 4, url: 'about:blank', group: groupId},
        {id: 106, index: 5, url: 'https://mixed/b', group: groupId},
        {id: 107, index: 6, url: 'about:config', group: groupId},
        {id: 108, index: 7, url: 'https://other/2', group: otherGroupId},
        {id: 109, index: 8, url: 'https://mixed/c', group: groupId},
    ];
    const groupOfTab = new Map(windowTabs.map(t => [t.id, t.group]));
    const getTabGroup = id => groupOfTab.get(id);
    const groupTabs = windowTabs.filter(t => t.group === groupId);
    const syncableIds = [103, 106, 107, 109];

    const relatives = syncableIds.map(id => computeGroupRelativeIndex(windowTabs, getTabGroup, id, groupId));
    check('parity: capture numbers the syncable tabs of a mixed group densely from 0',
        JSON.stringify(relatives) === JSON.stringify([0, 1, 2, 3]), JSON.stringify(relatives));

    const roundTrips = syncableIds.every(id => {
        const relative = computeGroupRelativeIndex(windowTabs, getTabGroup, id, groupId);
        return resolveAbsoluteTabIndex(groupTabs, relative) === windowTabs.find(t => t.id === id).index;
    });
    check('parity: computeGroupRelativeIndex → resolveAbsoluteTabIndex is the identity for every syncable tab',
        roundTrips);

    check('parity: a non-syncable member of the group has no relative index at all',
        computeGroupRelativeIndex(windowTabs, getTabGroup, 102, groupId) === null
        && computeGroupRelativeIndex(windowTabs, getTabGroup, 105, groupId) === null);

    check('parity: appending past the mixed group lands one past its last syncable tab',
        resolveAbsoluteTabIndex(groupTabs, 4) === 9, String(resolveAbsoluteTabIndex(groupTabs, 4)));
}

// ---------------------------------------------------------------------------

if (failures.length) {
    console.error(`\n${failures.length} failed, ${passed} passed`);
    console.error('FAILURES:', failures);
    process.exit(1);
} else {
    console.log(`\n${passed} passed, 0 failed`);
}
