/**
 * Standalone node test for the EMPTY-RESOLVE snapshot-write gate (data-loss guard #3).
 * Plain `node empty-snapshot-write-gate.test.mjs` — STG has no test runner.
 *
 * The pure gate (snapshot-write-gate.js) is imported and exercised directly. delta-sync.js
 * itself is impure (browser modules) and cannot be imported under node, so the orchestrator's
 * write/marker decision is re-modeled here from the same source — the same convention the
 * other delta tests use (delta-sync-helpers / conditional-fetch). Keep the model in sync with
 * the filesToWrite + `if (shouldCompact && writeSnapshot)` branches in delta-sync.js.
 *
 * Regression: a spuriously-empty resolve on a first-sync or compaction cycle must NOT publish
 * an empty base snapshot over a non-existent/non-empty prior, and must NOT record a deferred
 * self-truncation marker (which a later peer watermark would confirm and strand data).
 */

import {isResolvedSpuriouslyEmpty, shouldWriteSnapshot} from './snapshot-write-gate.js';
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

// --- model of delta-sync.js write/marker decision (kept in sync) -------------
function orchestrateCloudWrite({shouldCompact, snapshotExists, suppressEmptyResolve, deltaFileToWrite, hasFoldableSelf}) {
    const writeSnapshot = shouldWriteSnapshot({shouldCompact, snapshotExists, suppressEmptyResolve});

    const filesToWrite = {};
    if (writeSnapshot) {
        filesToWrite['STG-sync-snapshot.json'] = {};
    }
    if (deltaFileToWrite) {
        filesToWrite['STG-sync-delta-self.json'] = {};
    }

    const recordedTruncationMarker = shouldCompact && writeSnapshot && hasFoldableSelf;

    return {
        wroteSnapshot: !!filesToWrite['STG-sync-snapshot.json'],
        pushedDelta: !!filesToWrite['STG-sync-delta-self.json'],
        recordedTruncationMarker,
    };
}

// ---------------------------------------------------------------------------
// 1. isResolvedSpuriouslyEmpty contract
// ---------------------------------------------------------------------------
{
    check('spurious: empty resolved + local groups ⇒ true',
        isResolvedSpuriouslyEmpty({groups: [], pinnedTabs: []}, {groups: [{id: 'g1'}], pinnedTabs: []}) === true);

    check('spurious: empty resolved + local pinned ⇒ true',
        isResolvedSpuriouslyEmpty({groups: [], pinnedTabs: []}, {groups: [], pinnedTabs: [{uid: 'p1'}]}) === true);

    check('spurious: non-empty resolved ⇒ false (real convergence)',
        isResolvedSpuriouslyEmpty({groups: [{id: 'g1'}], pinnedTabs: []}, {groups: [{id: 'g1'}]}) === false);

    check('spurious: empty resolved + empty local ⇒ false (legit empty)',
        isResolvedSpuriouslyEmpty({groups: [], pinnedTabs: []}, {groups: [], pinnedTabs: []}) === false);

    check('spurious: missing fields never crash ⇒ false',
        isResolvedSpuriouslyEmpty({}, {}) === false);
}

// ---------------------------------------------------------------------------
// 2. shouldWriteSnapshot: suppression overrides BOTH write branches
// ---------------------------------------------------------------------------
{
    check('gate: first sync (no snapshot) writes',
        shouldWriteSnapshot({shouldCompact: false, snapshotExists: false, suppressEmptyResolve: false}) === true);

    check('gate: compaction writes',
        shouldWriteSnapshot({shouldCompact: true, snapshotExists: true, suppressEmptyResolve: false}) === true);

    check('gate: steady state (snapshot exists, no compaction) does not write',
        shouldWriteSnapshot({shouldCompact: false, snapshotExists: true, suppressEmptyResolve: false}) === false);

    check('gate: spurious empty SUPPRESSES first-sync write',
        shouldWriteSnapshot({shouldCompact: false, snapshotExists: false, suppressEmptyResolve: true}) === false);

    check('gate: spurious empty SUPPRESSES compaction write',
        shouldWriteSnapshot({shouldCompact: true, snapshotExists: true, suppressEmptyResolve: true}) === false);
}

// ---------------------------------------------------------------------------
// 3. orchestrator: spurious empty publishes NO destructive base + strands no watermark,
//    yet non-destructive delta push still proceeds.
// ---------------------------------------------------------------------------
{
    const firstSync = orchestrateCloudWrite({
        shouldCompact: false, snapshotExists: false, suppressEmptyResolve: true,
        deltaFileToWrite: true, hasFoldableSelf: true,
    });
    check('first-sync spurious empty: NO snapshot written', firstSync.wroteSnapshot === false);
    check('first-sync spurious empty: NO truncation marker recorded', firstSync.recordedTruncationMarker === false);
    check('first-sync spurious empty: delta still pushed (non-destructive)', firstSync.pushedDelta === true);

    const compaction = orchestrateCloudWrite({
        shouldCompact: true, snapshotExists: true, suppressEmptyResolve: true,
        deltaFileToWrite: true, hasFoldableSelf: true,
    });
    check('compaction spurious empty: NO snapshot written', compaction.wroteSnapshot === false);
    check('compaction spurious empty: NO destructive watermark advance (no marker)', compaction.recordedTruncationMarker === false);
    check('compaction spurious empty: delta still pushed', compaction.pushedDelta === true);

    const healthyCompaction = orchestrateCloudWrite({
        shouldCompact: true, snapshotExists: true, suppressEmptyResolve: false,
        deltaFileToWrite: true, hasFoldableSelf: true,
    });
    check('healthy compaction: snapshot written', healthyCompaction.wroteSnapshot === true);
    check('healthy compaction: truncation marker recorded', healthyCompaction.recordedTruncationMarker === true);
}

// ---------------------------------------------------------------------------
// 4. end-to-end: a resolve that comes out empty while local holds groups (e.g. the pulled
//    base carried removals our own log had not caught up to) feeds the real planner, and the
//    gate refuses to overwrite the cloud with that empty snapshot on either write path.
// ---------------------------------------------------------------------------
{
    const SELF = 'self';
    const localState = {
        groups: [{id: 'g1', title: 'G1', tabs: [{uid: 'u1', url: 'https://a', index: 0}]}],
        pinnedTabs: [],
    };
    const pulledSnapshot = {groups: [], pinnedTabs: [], watermark: {}};

    const plan = planSync({
        pulledSnapshot, pulledDeltaLogs: [], localPendingEvents: [],
        selfDeviceId: SELF, localState, priorBaseline: {groupIds: ['g1'], tabUids: ['u1']},
    });

    const suppress = isResolvedSpuriouslyEmpty(plan.resolvedSnapshot, localState);
    check('e2e: planner resolves empty while local has a group ⇒ suppression engaged', suppress === true);
    check('e2e: gate blocks the first-sync empty overwrite',
        shouldWriteSnapshot({shouldCompact: false, snapshotExists: false, suppressEmptyResolve: suppress}) === false);
    check('e2e: gate blocks the compaction empty overwrite',
        shouldWriteSnapshot({shouldCompact: true, snapshotExists: true, suppressEmptyResolve: suppress}) === false);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.error('FAILED:', failures.join(', '));
    process.exit(1);
}
