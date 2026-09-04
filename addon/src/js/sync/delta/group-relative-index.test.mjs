/**
 * Standalone node test for the pure GROUP-RELATIVE index helper the capture layer uses.
 *
 * Plain `node group-relative-index.test.mjs` (STG has no test runner). Imports the module
 * directly — it only pulls in the equally pure url-sync.js, no extension host — and asserts
 * the within-group positional math the delta tab.add/tab.modify/tab.move records depend on.
 * The numbering space MUST match buildLocalState (local-state.js): non-syncable tabs are
 * dropped and the survivors are renumbered densely, otherwise replay inserts a tab into a
 * filtered list using an unfiltered index and the peers ping-pong the tab order forever.
 * Exits non-zero on the first failure. Lives here so `node src/js/sync/delta/*.test.mjs`
 * picks it up.
 */

import {computeGroupRelativeIndex} from './group-relative-index.js';
import {isUrlSyncable, unwrapStubUrl} from './url-sync.js';

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

const stubFor = url => `moz-extension://abcd-1234-uuid/help/stg-unsupported-url.html?url=${encodeURIComponent(url)}`;

// A window where group 'g1' owns tabs 10 and 30, group 'g2' owns 20, and 40 is ungrouped.
// Browser-absolute indexes are interleaved (pinned/other groups shift them); the helper
// must return the position WITHIN the group, ignoring the absolute index.
const windowTabs = [
    {id: 10, index: 1, url: 'http://a/'},
    {id: 20, index: 2, url: 'http://b/'},
    {id: 30, index: 3, url: 'http://c/'},
    {id: 40, index: 4, url: 'http://d/'},
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
        {id: 30, index: 3, url: 'http://c/'},
        {id: 10, index: 1, url: 'http://a/'},
    ];
    check('order is by browser index, not array order',
        computeGroupRelativeIndex(unordered, getTabGroup, 10, 'g1') === 0 &&
        computeGroupRelativeIndex(unordered, getTabGroup, 30, 'g1') === 1);
}

// --- the filtered numbering space -------------------------------------------
// Non-syncable tabs (about:newtab, about:blank, bare moz-extension pages) never reach the
// synced snapshot, so they must not consume a position here either.
{
    const mixedGroup = [
        {id: 1, index: 0, url: 'about:newtab'},
        {id: 2, index: 1, url: 'http://one/'},
        {id: 3, index: 2, url: 'moz-extension://uuid/manage/manage.html'},
        {id: 4, index: 3, url: 'http://two/'},
        {id: 5, index: 4, url: 'about:blank'},
        {id: 6, index: 5, url: stubFor('https://three/')},
    ];
    const inG1 = () => 'g1';

    check('non-syncable tab BEFORE the target does not consume a position',
        computeGroupRelativeIndex(mixedGroup, inG1, 2, 'g1') === 0);

    check('non-syncable tab BETWEEN syncable tabs does not consume a position',
        computeGroupRelativeIndex(mixedGroup, inG1, 4, 'g1') === 1);

    check('non-syncable tabs before AND between are both skipped',
        computeGroupRelativeIndex(mixedGroup, inG1, 6, 'g1') === 2);

    check('non-syncable target tab (about:newtab) → null',
        computeGroupRelativeIndex(mixedGroup, inG1, 1, 'g1') === null);

    check('non-syncable target tab (bare moz-extension page) → null',
        computeGroupRelativeIndex(mixedGroup, inG1, 3, 'g1') === null);

    check('non-syncable target tab (about:blank) → null',
        computeGroupRelativeIndex(mixedGroup, inG1, 5, 'g1') === null);

    check('a trailing non-syncable tab does not change the earlier positions',
        computeGroupRelativeIndex(mixedGroup, inG1, 2, 'g1') === 0 &&
        computeGroupRelativeIndex(mixedGroup, inG1, 4, 'g1') === 1);

    // The exact numbering buildLocalState produces: filter, then `index: mappedTabs.length`.
    const localStateIndexes = new Map();
    for (const tab of [...mixedGroup].sort((a, b) => a.index - b.index)) {
        if (isUrlSyncable(unwrapStubUrl(tab.url))) {
            localStateIndexes.set(tab.id, localStateIndexes.size);
        }
    }
    const parity = [...localStateIndexes].every(([id, index]) =>
        computeGroupRelativeIndex(mixedGroup, inG1, id, 'g1') === index);
    check('capture index matches the buildLocalState numbering for every syncable tab', parity);
}

{
    const allNonSyncable = [
        {id: 7, index: 0, url: 'about:newtab'},
        {id: 8, index: 1, url: 'about:newtab'},
    ];
    check('group of only non-syncable tabs → null',
        computeGroupRelativeIndex(allNonSyncable, () => 'g1', 7, 'g1') === null);
}

check('group not present in the window → null',
    computeGroupRelativeIndex(windowTabs, getTabGroup, 10, 'g-not-here') === null);

// guard inputs: null/missing args → null (caller omits index ⇒ replay appends at end).
check('missing groupId → null', computeGroupRelativeIndex(windowTabs, getTabGroup, 10, undefined) === null);
check('non-array windowTabs → null', computeGroupRelativeIndex(null, getTabGroup, 10, 'g1') === null);
check('non-function resolver → null', computeGroupRelativeIndex(windowTabs, null, 10, 'g1') === null);
check('empty window → null', computeGroupRelativeIndex([], getTabGroup, 10, 'g1') === null);
check('tab without a url → null', computeGroupRelativeIndex([{id: 10, index: 0}], getTabGroup, 10, 'g1') === null);

// ---------------------------------------------------------------------------

if (failures.length) {
    console.error(`\n${failures.length} failed, ${passed} passed`);
    console.error('FAILURES:', failures);
    process.exit(1);
} else {
    console.log(`\n${passed} passed, 0 failed`);
}
