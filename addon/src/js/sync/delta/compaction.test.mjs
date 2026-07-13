/**
 * Standalone node test for the PURE compaction policy + its safety invariants (Phase P4).
 *
 * Like the sibling delta tests this is a plain `node compaction.test.mjs` script (STG has
 * no test runner). It imports the pure modules directly (compaction.js / replay.js /
 * plan-sync.js — all import-free / browser-free by contract) and proves the SAFETY
 * properties compaction rides on:
 *   - compaction produces a base EQUAL to a full replay (no second/divergent fold path);
 *   - replay(new base + remaining deltas) == replay(original base + all deltas) — folding +
 *     truncation loses NOTHING, even for events trimmed from the self log;
 *   - the >100 trigger fires only when the UNFOLDED count exceeds the threshold;
 *   - truncate-then-replay equivalence (watermark dedup skips trimmed events, no double-apply);
 *   - the snapshot-write / own-log-truncation DECISION an idle cycle makes writes no snapshot.
 *
 * Exits non-zero on the first failed assertion so it can gate a manual check.
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs); it uses
 * node globals (process, console) the browser config bans.
 */

import {
    COMPACTION_THRESHOLD,
    countUnfoldedEvents,
    evaluateCompaction,
    selfFoldedSeq,
    truncateSelfEvents,
    isLogFullyFolded,
    selectOrphanDeltaFilesToDelete,
} from './compaction.js';
import {replay} from './replay.js';
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

function eq(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

// Normalize a resolved snapshot for state comparison: only the durable cloud BASE fields
// matter (groups/pinned/options/containers + watermark). Order within is authoritative.
function baseState(snapshot) {
    return {
        groups: snapshot.groups,
        pinnedTabs: snapshot.pinnedTabs,
        options: snapshot.options,
        containers: snapshot.containers,
        watermark: snapshot.watermark,
    };
}

// --- a realistic multi-device delta set --------------------------------------
// device A: builds a group g1 with two tabs, renames the group, moves a tab.
// device B: adds a group g2 with a tab, sets an option, then removes one of A's tabs.
function buildScenario() {
    const base = {groups: [], pinnedTabs: [], options: {}, containers: {}, watermark: {}};

    const logA = {
        deviceId: 'A',
        events: [
            {seq: 1, ts: 100, op: 'group.add', group: {id: 'g1', title: 'One'}},
            {seq: 2, ts: 110, op: 'tab.add', groupId: 'g1', tab: {uid: 't1', url: 'https://a/1', title: 'a1', index: 0}},
            {seq: 3, ts: 120, op: 'tab.add', groupId: 'g1', tab: {uid: 't2', url: 'https://a/2', title: 'a2', index: 1}},
            {seq: 4, ts: 200, op: 'group.modify', group: {id: 'g1', title: 'One renamed'}},
            {seq: 5, ts: 260, op: 'tab.move', groupId: 'g1', uid: 't2', toIndex: 0},
        ],
    };
    const logB = {
        deviceId: 'B',
        events: [
            {seq: 1, ts: 130, op: 'group.add', group: {id: 'g2', title: 'Two'}},
            {seq: 2, ts: 140, op: 'tab.add', groupId: 'g2', tab: {uid: 't3', url: 'https://b/3', title: 'b3', index: 0}},
            {seq: 3, ts: 150, op: 'option.set', key: 'showContextMenuOnTabs', value: true},
            {seq: 4, ts: 250, op: 'tab.remove', groupId: 'g1', uid: 't1'},
        ],
    };

    return {base, logs: [logA, logB]};
}

// ============================================================================
// 1. COMPACTION PRODUCES A BASE EQUAL TO FULL REPLAY (single fold path)
// ============================================================================
{
    const {base, logs} = buildScenario();

    // The "compacted base" is simply the resolved snapshot from replay (this is exactly
    // what delta-sync.js persists on a compaction cycle — there is no second fold path).
    const {snapshot: compactedBase} = replay(base, logs);

    // A direct, independent full replay of the same inputs.
    const {snapshot: fullReplay} = replay(base, logs);

    check('compaction base == full replay (groups/pinned/options/watermark)',
        eq(baseState(compactedBase), baseState(fullReplay)),
        JSON.stringify(baseState(compactedBase)));

    // The advanced watermark is the highest folded seq per device.
    check('compacted watermark advances to highest folded seq per device',
        compactedBase.watermark.A === 5 && compactedBase.watermark.B === 4,
        JSON.stringify(compactedBase.watermark));
}

// ============================================================================
// 2. replay(new base + REMAINING deltas) == replay(original base + all deltas)
//    Fold A fully, fold B fully, then TRUNCATE both logs to empty (all folded).
//    A behind/returning device's view = new base + its remaining (here: none) deltas.
// ============================================================================
{
    const {base, logs} = buildScenario();

    // Full replay of the original (the ground truth).
    const {snapshot: original} = replay(base, logs);

    // Compact: new base = resolved snapshot; advance watermark; truncate folded events.
    const {snapshot: newBase} = replay(base, logs);

    // Truncate every device's log up to its advanced watermark (simulate the gist after a
    // round where EVERY device compacted its own file — the maximal-truncation case).
    const remainingLogs = logs.map(log => ({
        deviceId: log.deviceId,
        events: log.events.filter(e => e.seq > (newBase.watermark[log.deviceId] ?? 0)),
    }));

    check('all events folded ⇒ remaining logs are empty',
        remainingLogs.every(l => l.events.length === 0),
        JSON.stringify(remainingLogs));

    // Replay the NEW base + remaining deltas (the new base ALREADY carries its watermark).
    const {snapshot: afterCompaction} = replay(newBase, remainingLogs);

    check('replay(newBase + remaining) == replay(original) [groups/pinned/options]',
        eq({groups: afterCompaction.groups, pinnedTabs: afterCompaction.pinnedTabs, options: afterCompaction.options},
           {groups: original.groups, pinnedTabs: original.pinnedTabs, options: original.options}),
        JSON.stringify({a: afterCompaction.groups, o: original.groups}));
}

// ============================================================================
// 2b. PARTIAL truncation: only device A compacts its OWN file; B's file is left
//     intact (the own-log-only rule). Result must still equal the full replay,
//     proving B's now-below-watermark events are skipped (not double-applied).
// ============================================================================
{
    const {base, logs} = buildScenario();
    const {snapshot: original} = replay(base, logs);

    const {snapshot: newBase} = replay(base, logs);

    // Device A truncates ONLY its own log; device B's stale file lingers UNCHANGED.
    const remainingLogs = logs.map(log => {
        if (log.deviceId === 'A') {
            return {deviceId: 'A', events: log.events.filter(e => e.seq > newBase.watermark.A)};
        }
        return {deviceId: log.deviceId, events: log.events.slice()}; // B left intact
    });

    check('own-log-only: A truncated, B left intact (B still has 4 events)',
        remainingLogs.find(l => l.deviceId === 'A').events.length === 0
        && remainingLogs.find(l => l.deviceId === 'B').events.length === 4);

    const {snapshot: afterCompaction} = replay(newBase, remainingLogs);

    check('replay(newBase + B-stale) == full replay (watermark skips B-stale, no double-apply)',
        eq(baseState(afterCompaction), baseState(original)),
        JSON.stringify({a: baseState(afterCompaction), o: baseState(original)}));
}

// ============================================================================
// 3. >100 TRIGGER: fires only when the UNFOLDED count EXCEEDS the threshold.
// ============================================================================
{
    // build a single log with exactly N events, base watermark 0 ⇒ all N unfolded.
    const makeLog = n => ({
        deviceId: 'A',
        events: Array.from({length: n}, (_, i) => ({seq: i + 1, ts: i, op: 'option.set', key: 'k' + i, value: i})),
    });

    check('threshold constant is 100', COMPACTION_THRESHOLD === 100);

    check('exactly 100 unfolded ⇒ NO compaction (must EXCEED)',
        evaluateCompaction([makeLog(100)], {}).shouldCompact === false);

    check('101 unfolded ⇒ compaction',
        evaluateCompaction([makeLog(101)], {}).shouldCompact === true);

    check('unfoldedCount reported correctly',
        evaluateCompaction([makeLog(101)], {}).unfoldedCount === 101);

    // base watermark already folded the first 100 ⇒ only 1 unfolded ⇒ no compaction.
    check('events at/below base watermark are NOT counted (match replay dedup)',
        countUnfoldedEvents([makeLog(101)], {A: 100}) === 1);

    check('watermark dedup ⇒ below-threshold ⇒ no compaction',
        evaluateCompaction([makeLog(101)], {A: 100}).shouldCompact === false);

    // unfolded across MULTIPLE devices sums.
    check('unfolded count sums across all device logs',
        countUnfoldedEvents([makeLog(60), {deviceId: 'B', events: makeLog(60).events}], {}) === 120);

    // null-seq events count as unfolded (can never be <= a numeric watermark).
    check('null-seq event counts as unfolded',
        countUnfoldedEvents([{deviceId: 'A', events: [{op: 'option.set', key: 'k', value: 1}]}], {A: 99}) === 1);
}

// ============================================================================
// 4. TRUNCATE-THEN-REPLAY equivalence + selfFoldedSeq / truncateSelfEvents.
//    Prove the watermark in the NEW base makes replay skip the trimmed self events
//    even when the (now stale) self file is replayed against the new base again.
// ============================================================================
{
    const {base, logs} = buildScenario();
    const {snapshot: newBase} = replay(base, logs);

    // Self = A. Everything pushed (lastPushedSeq=5) ⇒ may truncate up to folded self (5).
    check('selfFoldedSeq = min(foldedSelf, lastPushedSeq) [all pushed]',
        selfFoldedSeq(newBase.watermark, 'A', 5) === 5);

    // Only seq<=3 pushed ⇒ truncate only up to 3 (never trim the unpushed/unfolded tail).
    check('selfFoldedSeq clamps to lastPushedSeq (unpushed tail protected)',
        selfFoldedSeq(newBase.watermark, 'A', 3) === 3);

    // never-synced self device ⇒ folded 0 ⇒ truncate nothing.
    check('selfFoldedSeq for unknown device is 0',
        selfFoldedSeq(newBase.watermark, 'Z', 99) === 0);

    // truncateSelfEvents keeps only seq > foldedSeq.
    const selfFull = logs.find(l => l.deviceId === 'A').events;
    check('truncateSelfEvents drops folded head (foldedSeq=5 ⇒ none left)',
        truncateSelfEvents(selfFull, 5).length === 0);
    check('truncateSelfEvents keeps unfolded tail (foldedSeq=3 ⇒ seq 4,5 kept)',
        eq(truncateSelfEvents(selfFull, 3).map(e => e.seq), [4, 5]));
    check('truncateSelfEvents keeps null-seq events (cannot prove folded)',
        truncateSelfEvents([{op: 'x'}, {seq: 2, op: 'y'}], 5).length === 1
        && truncateSelfEvents([{op: 'x'}, {seq: 2, op: 'y'}], 5)[0].op === 'x');

    // Equivalence: replay original vs replay(newBase + truncated self + intact B).
    const {snapshot: original} = replay(base, logs);
    const truncatedSelf = {deviceId: 'A', events: truncateSelfEvents(selfFull, 5)};
    const intactB = logs.find(l => l.deviceId === 'B');
    const {snapshot: afterTrunc} = replay(newBase, [truncatedSelf, intactB]);
    check('truncate-then-replay == full replay (self trimmed, B intact)',
        eq(baseState(afterTrunc), baseState(original)),
        JSON.stringify({a: baseState(afterTrunc), o: baseState(original)}));
}

// ============================================================================
// 5. IDLE CYCLE writes NO snapshot. The push-step DECISION is
//    `writeSnapshot = shouldCompact || !snapshotExists`. Re-derive it for the
//    idle case (few unfolded events, snapshot already exists) and assert false.
// ============================================================================
{
    // Re-implement the transport's gate predicate (kept identical to delta-sync.js step 8).
    const writeSnapshotGate = (shouldCompact, snapshotExists) => shouldCompact || !snapshotExists;

    const {base, logs} = buildScenario(); // 9 unfolded events, well under threshold

    const {shouldCompact} = evaluateCompaction(logs, base.watermark);
    check('idle cycle: under threshold ⇒ shouldCompact false', shouldCompact === false);

    check('idle cycle + snapshot exists ⇒ NO snapshot write',
        writeSnapshotGate(shouldCompact, true) === false);

    check('first sync (snapshot absent) ⇒ snapshot IS written even without compaction',
        writeSnapshotGate(false, false) === true);

    check('compaction cycle ⇒ snapshot IS written',
        writeSnapshotGate(true, true) === true);

    // And the truncation decision: an idle cycle truncates nothing (truncateUpToSeq=0).
    const truncateUpToSeq = shouldCompact ? selfFoldedSeq({}, 'A', 5) : 0;
    check('idle cycle: own-log truncation seq is 0 (no truncation)', truncateUpToSeq === 0);
}

// ============================================================================
// 6. END-TO-END via planSync: the resolved snapshot a compaction would persist
//    equals a full replay, and its newWatermark is the advanced (folded) watermark.
// ============================================================================
{
    const {base, logs} = buildScenario();
    const plan = planSync({
        pulledSnapshot: base,
        pulledDeltaLogs: logs,
        localPendingEvents: [],
        selfDeviceId: 'A',
        localState: {groups: [], pinnedTabs: [], options: {}},
        priorBaseline: {tabUids: [], groupIds: [], pinnedUids: [], optionKeys: []},
    });

    const {snapshot: fullReplay} = replay(base, logs);

    check('planSync.resolvedSnapshot (the base compaction persists) == full replay',
        eq(baseState(plan.resolvedSnapshot), baseState(fullReplay)),
        JSON.stringify({p: baseState(plan.resolvedSnapshot), r: baseState(fullReplay)}));

    check('planSync.newWatermark == advanced (folded) watermark',
        eq(plan.newWatermark, fullReplay.watermark),
        JSON.stringify(plan.newWatermark));
}

// ============================================================================
// 7. ORPHAN DELTA-FILE GC (isLogFullyFolded + selectOrphanDeltaFilesToDelete).
//    The whole point is data-loss safety: delete a NON-SELF device's delta file ONLY when
//    every event in it is already folded into the base (seq <= watermark[device]); keep it
//    on ANY doubt; never touch the self file; never mutate the watermark.
// ============================================================================
{
    const ev = seq => ({seq, op: 'noop'});

    // --- isLogFullyFolded: the per-event predicate (inverse of replay's skip test) ---
    check('isLogFullyFolded: empty log is fully folded',
        isLogFullyFolded([], 5) === true);
    check('isLogFullyFolded: all events seq <= watermark ⇒ folded',
        isLogFullyFolded([ev(1), ev(3), ev(5)], 5) === true);
    check('isLogFullyFolded: boundary seq == watermark is folded',
        isLogFullyFolded([ev(5)], 5) === true);
    check('isLogFullyFolded: ANY event seq > watermark ⇒ NOT folded',
        isLogFullyFolded([ev(1), ev(6)], 5) === false);
    check('isLogFullyFolded: a null seq is treated as UNFOLDED (never deletable)',
        isLogFullyFolded([ev(1), {seq: null, op: 'x'}], 5) === false);
    check('isLogFullyFolded: missing watermark (0 default) keeps any real event',
        isLogFullyFolded([ev(1)], 0) === false);

    // --- selectOrphanDeltaFilesToDelete: the selection policy ---
    const watermark = {A: 10, B: 4, C: 7};

    // A fully-folded NON-SELF file IS selected for deletion (B: all events <= 4).
    {
        const logs = [
            {name: 'STG-sync-delta-B.json', deviceId: 'B', events: [ev(1), ev(2), ev(4)]},
        ];
        check('orphan-GC: fully-folded non-self file is selected',
            eq(selectOrphanDeltaFilesToDelete(logs, watermark, 'A'), ['STG-sync-delta-B.json']));
    }

    // A file with ANY unfolded event is NOT selected (C has seq 8 > watermark 7).
    {
        const logs = [
            {name: 'STG-sync-delta-C.json', deviceId: 'C', events: [ev(6), ev(7), ev(8)]},
        ];
        check('orphan-GC: file with an unfolded event is NOT selected',
            eq(selectOrphanDeltaFilesToDelete(logs, watermark, 'A'), []));
    }

    // The SELF device's file is NEVER selected, even when fully folded.
    {
        const logs = [
            {name: 'STG-sync-delta-A.json', deviceId: 'A', events: [ev(1), ev(10)]}, // all <= 10
        ];
        check('orphan-GC: self file is never selected (even fully folded)',
            eq(selectOrphanDeltaFilesToDelete(logs, watermark, 'A'), []));
    }

    // Mixed batch: select only the fully-folded non-self files; keep self + the unfolded one.
    {
        const logs = [
            {name: 'STG-sync-delta-A.json', deviceId: 'A', events: [ev(10)]},          // self ⇒ keep
            {name: 'STG-sync-delta-B.json', deviceId: 'B', events: [ev(2), ev(4)]},    // folded ⇒ delete
            {name: 'STG-sync-delta-C.json', deviceId: 'C', events: [ev(7), ev(99)]},  // unfolded ⇒ keep
            {name: 'STG-sync-delta-D.json', deviceId: 'D', events: []},               // empty, wm 0 ⇒ delete
        ];
        check('orphan-GC: mixed batch selects only fully-folded non-self files',
            eq(selectOrphanDeltaFilesToDelete(logs, watermark, 'A'), ['STG-sync-delta-B.json', 'STG-sync-delta-D.json']));
    }

    // Bias to keep: a missing file name or null deviceId is skipped (never deleted).
    {
        const logs = [
            {name: undefined, deviceId: 'B', events: [ev(1)]},
            {name: 'STG-sync-delta-X.json', deviceId: null, events: [ev(1)]},
        ];
        check('orphan-GC: missing name or null deviceId is never selected (bias to keep)',
            eq(selectOrphanDeltaFilesToDelete(logs, watermark, 'A'), []));
    }

    // Watermark ENTRIES are never mutated by the selection (rule 3).
    {
        const wm = {A: 10, B: 4};
        const wmBefore = JSON.stringify(wm);
        selectOrphanDeltaFilesToDelete(
            [{name: 'STG-sync-delta-B.json', deviceId: 'B', events: [ev(2)]}], wm, 'A',
        );
        check('orphan-GC: selection does NOT mutate the watermark (entries kept forever)',
            JSON.stringify(wm) === wmBefore);
    }

    // RETURNING-DEVICE SAFETY (the replay skip invariant): after B's file is deleted, if B
    // returns and re-pushes its full local log (seq 1..N, all <= watermark[B]), replay folds
    // it into the SAME base — every re-pushed event is skipped (seq <= watermark) so the state
    // is unchanged (no double-apply, no resurrection). We prove the invariant directly: a base
    // whose watermark[B]=4 replayed against B's re-pushed log {1..4} yields the base unchanged.
    {
        const base = {
            groups: [{id: 1, title: 'g', tabs: [{uid: 't1', url: 'u', title: 'T', index: 0}]}],
            watermark: {B: 4},
            containers: {},
        };
        const rePushed = [{deviceId: 'B', events: [
            {seq: 1, ts: 1, op: 'tab.add', groupId: 1, tab: {uid: 't1', url: 'u', title: 'T', index: 0}},
            {seq: 4, ts: 4, op: 'tab.modify', groupId: 1, uid: 't1', tab: {title: 'HACKED'}},
        ]}];
        const {snapshot: after} = replay(base, rePushed);
        check('orphan-GC: returning device re-push (seq <= watermark) is fully skipped by replay',
            eq(baseState(after).groups, baseState(base).groups),
            JSON.stringify(baseState(after).groups));
    }
}

// ----------------------------------------------------------------------------
console.log('');
if (failures.length) {
    console.log(`${passed} passed, ${failures.length} FAILED:`);
    for (const f of failures) {
        console.log(`  - ${f}`);
    }
    process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
