/**
 * Standalone node test for the group-pinned ordering invariant (convergence regression).
 *
 * Plain `node group-pinned-convergence.test.mjs` script (STG has no test runner), same
 * style as plan-sync.test.mjs / replay.test.mjs. It reproduces the divergence the pure
 * planner model tests missed: group-pinned tabs are REAL browser-pinned tabs, so the
 * browser always keeps them as a leading prefix of the window; a resolved snapshot that
 * interleaves a group-pinned tab among unpinned tabs is physically unreachable, so the
 * apply layer re-hoists it and the next capture re-diverges — perpetual tabsToMove.
 *
 * The fix canonicalizes replay's resolved snapshot (stable pinned-first partition per
 * group). Because the physical post-apply capture is also pinned-first, the diff then
 * converges to zero moves and stays converged.
 *
 * Exits non-zero on the first failure. Not matched by eslint (config targets .js).
 */

import {replay, partitionPinnedTabsFirst} from './replay.js';
import {planSync} from './plan-sync.js';

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

const SELF = 'devSelf';
const REMOTE = 'devRemote';

// ---------------------------------------------------------------------------
// The helper stably partitions pinned-first, preserving relative order within
// each partition.
// ---------------------------------------------------------------------------
{
    const ordered = partitionPinnedTabsFirst([
        {uid: 'x'},
        {uid: 'b', pinned: true},
        {uid: 'a'},
        {uid: 'c', pinned: true},
    ]);
    check('partition: pinned tabs form a leading prefix, order preserved within partitions',
        ordered.map(t => t.uid).join(',') === 'b,c,x,a', JSON.stringify(ordered.map(t => t.uid)));
}

// ---------------------------------------------------------------------------
// Divergence scenario: base [A, B]; a group-pin event on B (tab.modify pinned:true)
// and a peer add of X at the front. A naive replay yields interleaved [X, B(pinned), A];
// the canonicalization must reorder it to pinned-first [B, X, A].
// ---------------------------------------------------------------------------
const pulledSnapshot = {
    groups: [{
        id: 'g1', title: 'G1', tabs: [
            {uid: 'A', url: 'http://a', index: 0},
            {uid: 'B', url: 'http://b', index: 1},
        ],
    }],
    pinnedTabs: [],
    watermark: {},
};

const pulledDeltaLogs = [{
    deviceId: REMOTE,
    events: [
        // peer pins B in place (still at index 1 among unpinned tabs)...
        {seq: 1, ts: 100, op: 'tab.modify', groupId: 'g1', tab: {uid: 'B', url: 'http://b', index: 1, pinned: true}},
        // ...then adds X at the front, shoving the pinned B into the middle.
        {seq: 2, ts: 200, op: 'tab.add', groupId: 'g1', tab: {uid: 'X', url: 'http://x', index: 0}},
    ],
}];

{
    const {snapshot} = replay(pulledSnapshot, pulledDeltaLogs, {});
    const order = snapshot.groups[0].tabs.map(t => t.uid);
    check('replay canonicalizes the interleaved group-pinned tab to a leading prefix',
        order.join(',') === 'B,X,A', JSON.stringify(order));
    const b = snapshot.groups[0].tabs.find(t => t.uid === 'B');
    check('canonicalized pinned tab keeps pinned:true and index 0',
        b?.pinned === true && b?.index === 0, JSON.stringify(b));
}

// ---------------------------------------------------------------------------
// Convergence: the physical post-apply capture is pinned-first [B, X, A]. Feeding
// that as localState must yield ZERO tabsToMove / tabsToCreate, and stay converged
// on a second round.
// ---------------------------------------------------------------------------
function pinnedFirstLocalState() {
    return {
        groups: [{
            id: 'g1', title: 'G1', tabs: [
                {uid: 'B', id: 2, url: 'http://b', index: 0, pinned: true},
                {uid: 'X', id: 3, url: 'http://x', index: 1},
                {uid: 'A', id: 1, url: 'http://a', index: 2},
            ],
        }],
        pinnedTabs: [],
    };
}

const priorBaseline = {tabUids: ['A', 'B'], groupIds: ['g1'], optionKeys: [], pinnedUids: []};

{
    const {browserOps} = planSync({
        pulledSnapshot,
        pulledDeltaLogs,
        localPendingEvents: [],
        selfDeviceId: SELF,
        localState: pinnedFirstLocalState(),
        priorBaseline,
    });
    check('convergence round 1: no tabsToMove against the pinned-first capture',
        browserOps.tabsToMove.length === 0, JSON.stringify(browserOps.tabsToMove));
    check('convergence round 1: no tabsToCreate',
        browserOps.tabsToCreate.length === 0, JSON.stringify(browserOps.tabsToCreate));
    check('convergence round 1: no tabsToRemove',
        browserOps.tabsToRemove.length === 0, JSON.stringify(browserOps.tabsToRemove));
}

{
    const {browserOps} = planSync({
        pulledSnapshot,
        pulledDeltaLogs,
        localPendingEvents: [],
        selfDeviceId: SELF,
        localState: pinnedFirstLocalState(),
        priorBaseline,
    });
    check('convergence round 2: stays converged (no tabsToMove / tabsToCreate)',
        browserOps.tabsToMove.length === 0 && browserOps.tabsToCreate.length === 0,
        JSON.stringify({move: browserOps.tabsToMove, create: browserOps.tabsToCreate}));
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.error('FAILURES:', failures.join(', '));
    process.exit(1);
}
