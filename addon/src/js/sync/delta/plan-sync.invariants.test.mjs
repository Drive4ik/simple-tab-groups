/**
 * Machine-checked NO-DATA-LOSS invariants for the pure sync planner (Feature 2).
 *
 * The whole point of delta sync's removal gate is that the planner can NEVER emit a
 * removal for anything this device did not previously reconcile as synced. This test
 * asserts that property directly — over representative cases AND a large set of
 * deterministic, randomized cases — so a future refactor that loosens the gate fails
 * here loudly instead of silently shipping data loss.
 *
 * Like the sibling *.test.mjs files this is a plain `node plan-sync.invariants.test.mjs`
 * script (STG has no test runner). It imports only the pure planner. It uses a small
 * seeded LCG instead of Math.random so every run is identical and any failure is
 * reproducible from the printed input. Exits non-zero on the first failing invariant.
 *
 * Invariants checked for `planSync(...).browserOps` / `.optionsToApply`:
 *   A. every id in tabsToRemove ∈ priorBaseline.tabUids; every id in pinnedToRemove ∈
 *      priorBaseline.pinnedUids; every id in groupsToRemove ∈ priorBaseline.groupIds.
 *   B. with an EMPTY or MISSING baseline, all three remove lists are empty.
 *   C. a local-only item (in localState, absent from baseline, absent from resolved) is
 *      NEVER in any remove list.
 *   D. optionsToApply only ever SETS values (it has no shape to delete an option key):
 *      it is a plain object whose values are not the `undefined` deletion sentinel.
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs); it
 * uses node globals (process, console) the browser config bans.
 */

import {planSync} from './plan-sync.js';

let passed = 0;
const failures = [];

function check(name, cond, detail) {
    if (cond) {
        passed++;
    } else {
        failures.push(name);
        console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

// --- deterministic PRNG (32-bit LCG, glibc constants). Seeded by a constant so the
// generated cases — and therefore any failure — are identical on every run. ----------
function makeRng(seed) {
    let state = seed >>> 0;
    return function next() {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return state / 0x100000000; // [0, 1)
    };
}

const rngInt = (rng, n) => Math.floor(rng() * n);
const pick = (rng, arr) => arr[rngInt(rng, arr.length)];
const chance = (rng, p) => rng() < p;

const SELF = 'devSelf';
const REMOTE = 'devRemote';

// ---------------------------------------------------------------------------
// Shared invariant assertion run on every (case) input. Returns a list of human
// readable violations (empty = all invariants hold). Each violation embeds the
// offending input so a regression is debuggable straight from the test output.
// ---------------------------------------------------------------------------
function assertInvariants(label, input, expectEmptyRemovals) {
    let plan;
    try {
        plan = planSync(input);
    } catch (e) {
        return [`${label}: planSync threw ${e && e.stack || e}\nINPUT=${JSON.stringify(input)}`];
    }

    const ops = plan.browserOps || {};
    const baseTabUids = new Set(input.priorBaseline?.tabUids || []);
    const baseGroupIds = new Set(input.priorBaseline?.groupIds || []);
    const basePinnedUids = new Set(input.priorBaseline?.pinnedUids || []);

    const violations = [];
    const fail = msg => violations.push(`${label}: ${msg}\nINPUT=${JSON.stringify(input)}\nOPS=${JSON.stringify({
        groupsToRemove: ops.groupsToRemove,
        tabsToRemove: ops.tabsToRemove,
        pinnedToRemove: ops.pinnedToRemove,
        optionsToApply: plan.optionsToApply,
    })}`);

    // INVARIANT A: nothing removed that wasn't previously reconciled-as-synced.
    for (const t of ops.tabsToRemove || []) {
        if (!baseTabUids.has(t.uid)) {
            fail(`INVARIANT A: tabsToRemove uid ${JSON.stringify(t.uid)} not in priorBaseline.tabUids`);
        }
    }
    for (const g of ops.groupsToRemove || []) {
        if (!baseGroupIds.has(g.id)) {
            fail(`INVARIANT A: groupsToRemove id ${JSON.stringify(g.id)} not in priorBaseline.groupIds`);
        }
    }
    for (const p of ops.pinnedToRemove || []) {
        if (!basePinnedUids.has(p.uid)) {
            fail(`INVARIANT A: pinnedToRemove uid ${JSON.stringify(p.uid)} not in priorBaseline.pinnedUids`);
        }
    }

    // INVARIANT B: empty/missing baseline ⇒ no removals at all.
    if (expectEmptyRemovals) {
        if ((ops.tabsToRemove || []).length || (ops.groupsToRemove || []).length || (ops.pinnedToRemove || []).length) {
            fail('INVARIANT B: empty/missing baseline produced a non-empty remove list');
        }
    }

    // INVARIANT C: a local-only item (present locally, absent from baseline AND absent
    // from resolved) must never be removed. Implied by A for baseline-absent items, but
    // we assert it directly so the intent is machine-checked, not just inferred.
    const resolved = plan.resolvedSnapshot || {};
    const resolvedTabUids = new Set();
    const resolvedGroupIds = new Set((resolved.groups || []).map(g => g.id));
    for (const g of resolved.groups || []) {
        for (const t of g.tabs || []) {
            resolvedTabUids.add(t.uid);
        }
    }
    const resolvedPinnedUids = new Set((resolved.pinnedTabs || []).map(p => p.uid));

    for (const g of input.localState?.groups || []) {
        const localOnlyGroup = !baseGroupIds.has(g.id) && !resolvedGroupIds.has(g.id);
        if (localOnlyGroup && (ops.groupsToRemove || []).some(r => r.id === g.id)) {
            fail(`INVARIANT C: local-only group ${JSON.stringify(g.id)} was removed`);
        }
        for (const t of g.tabs || []) {
            const localOnlyTab = !baseTabUids.has(t.uid) && !resolvedTabUids.has(t.uid);
            if (localOnlyTab && (ops.tabsToRemove || []).some(r => r.uid === t.uid)) {
                fail(`INVARIANT C: local-only tab ${JSON.stringify(t.uid)} was removed`);
            }
        }
    }
    for (const p of input.localState?.pinnedTabs || []) {
        const localOnlyPinned = !basePinnedUids.has(p.uid) && !resolvedPinnedUids.has(p.uid);
        if (localOnlyPinned && (ops.pinnedToRemove || []).some(r => r.uid === p.uid)) {
            fail(`INVARIANT C: local-only pinned ${JSON.stringify(p.uid)} was removed`);
        }
    }

    // INVARIANT D: optionsToApply only sets values; it has no deletion mechanism.
    const opts = plan.optionsToApply;
    if (opts != null) {
        if (typeof opts !== 'object' || Array.isArray(opts)) {
            fail(`INVARIANT D: optionsToApply is not a plain object: ${JSON.stringify(opts)}`);
        } else {
            for (const [key, value] of Object.entries(opts)) {
                // a deletion would have to surface as an undefined value (the only way a
                // {key: value} set-bag could represent "remove this key"). Assert it never does.
                if (value === undefined) {
                    fail(`INVARIANT D: optionsToApply[${JSON.stringify(key)}] is undefined (looks like a delete)`);
                }
            }
        }
    }

    return violations;
}

// ===========================================================================
// PART 1 — representative hand-written cases (incl. the empty/missing-baseline
// and local-only edge cases the invariants specifically target).
// ===========================================================================
{
    // 1a. EMPTY baseline + remote remove of a tab the device knows locally: must NOT
    //     remove (baseline authorizes nothing). Invariant B.
    const input = {
        pulledSnapshot: {groups: [{id: 'g1', title: 'G1', tabs: []}], watermark: {}},
        pulledDeltaLogs: [{deviceId: REMOTE, events: [{seq: 1, ts: 100, op: 'tab.remove', groupId: 'g1', uid: 't1'}]}],
        localPendingEvents: [],
        selfDeviceId: SELF,
        localState: {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://a', index: 0}]}]},
        priorBaseline: {tabUids: [], groupIds: [], pinnedUids: []},
    };
    const v = assertInvariants('rep:empty-baseline-remote-remove', input, true);
    check('representative: empty baseline never removes (invariant B)', v.length === 0, v[0]);
}
{
    // 1b. MISSING baseline (priorBaseline omitted entirely). Invariant B.
    const input = {
        pulledSnapshot: {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://a', index: 0}]}], watermark: {}},
        pulledDeltaLogs: [{deviceId: REMOTE, events: [{seq: 1, ts: 100, op: 'tab.remove', groupId: 'g1', uid: 't1'}]}],
        localPendingEvents: [],
        selfDeviceId: SELF,
        localState: {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://a', index: 0}]}]},
        // priorBaseline intentionally absent
    };
    const v = assertInvariants('rep:missing-baseline', input, true);
    check('representative: missing baseline never removes (invariant B)', v.length === 0, v[0]);
}
{
    // 1c. local-only group+tab+pinned (not in baseline, not in cloud) must survive even
    //     while another, baselined item is legitimately removed. Invariants A + C.
    const input = {
        pulledSnapshot: {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://a', index: 0}]}], pinnedTabs: [{uid: 'p1', url: 'http://p1', index: 0}], watermark: {}},
        pulledDeltaLogs: [{deviceId: REMOTE, events: [
            {seq: 1, ts: 100, op: 'tab.remove', groupId: 'g1', uid: 't1'},
            {seq: 2, ts: 100, op: 'pinned.remove', uid: 'p1'},
        ]}],
        localPendingEvents: [],
        selfDeviceId: SELF,
        localState: {
            groups: [
                {id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://a', index: 0}]},
                {id: 'gLocal', title: 'Local', tabs: [{uid: 'tLocal', url: 'http://local', index: 0}]},
            ],
            pinnedTabs: [{uid: 'p1', url: 'http://p1', index: 0}, {uid: 'pLocal', url: 'http://plocal', index: 1}],
        },
        priorBaseline: {tabUids: ['t1'], groupIds: ['g1'], pinnedUids: ['p1']},
    };
    const v = assertInvariants('rep:local-only-survives', input, false);
    check('representative: local-only items survive a legit removal (invariants A+C)', v.length === 0, v.join('\n'));
}
{
    // 1d. legitimate removal (baselined + removed remotely + resolved drops it) is allowed
    //     and DOES appear — sanity that the gate isn't vacuously empty. Invariant A holds.
    const input = {
        pulledSnapshot: {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://a', index: 0}]}], watermark: {}},
        pulledDeltaLogs: [{deviceId: REMOTE, events: [{seq: 1, ts: 100, op: 'tab.remove', groupId: 'g1', uid: 't1'}]}],
        localPendingEvents: [],
        selfDeviceId: SELF,
        localState: {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://a', index: 0}]}]},
        priorBaseline: {tabUids: ['t1'], groupIds: ['g1'], pinnedUids: []},
    };
    const plan = planSync(input);
    const v = assertInvariants('rep:legit-remove', input, false);
    check('representative: legit baselined removal is allowed (invariant A)',
        v.length === 0 && plan.browserOps.tabsToRemove.some(t => t.uid === 't1'),
        v.join('\n') || JSON.stringify(plan.browserOps.tabsToRemove));
}
{
    // 1e. option.set events only ever SET values — never a delete. Invariant D.
    const input = {
        pulledSnapshot: {groups: [], watermark: {}},
        pulledDeltaLogs: [{deviceId: REMOTE, events: [
            {seq: 1, ts: 100, op: 'option.set', key: 'showArchivedGroups', value: false},
            {seq: 2, ts: 200, op: 'option.set', key: 'fullPopupWidth', value: true},
        ]}],
        localPendingEvents: [],
        selfDeviceId: SELF,
        localState: {groups: [], options: {showArchivedGroups: true, fullPopupWidth: false}},
        priorBaseline: {tabUids: [], groupIds: [], pinnedUids: [], optionKeys: []},
    };
    const v = assertInvariants('rep:option-set', input, true);
    check('representative: optionsToApply only sets values (invariant D)', v.length === 0, v.join('\n'));
}

// ===========================================================================
// PART 2 — deterministic randomized fuzzing. Generate a large batch of varied
// inputs (snapshot, local state, baseline incl. empty/missing, pulled deltas)
// and assert A–D on every one.
// ===========================================================================
{
    const rng = makeRng(0x5715CAFE); // constant seed ⇒ reproducible
    const CASES = 300;

    // a small pool of stable ids so baseline/snapshot/local/delta references overlap
    // enough to actually exercise the removal gate (random unique ids would never collide).
    const groupIds = ['g1', 'g2', 'g3'];
    const tabUids = ['t1', 't2', 't3', 't4', 't5'];
    const pinnedUids = ['p1', 'p2', 'p3'];
    const optionKeys = ['showArchivedGroups', 'fullPopupWidth', 'openGroupAfterChange'];

    const randSubset = (rng2, arr, p) => arr.filter(() => chance(rng2, p));

    const mkTab = (rng2, uid, index) => ({uid, url: `http://${uid}`, title: uid, index});
    const mkPinned = (rng2, uid, index) => ({uid, url: `http://${uid}`, title: uid, index});

    const mkGroups = (rng2, gids, uidPool) => gids.map(id => {
        const uids = randSubset(rng2, uidPool, 0.5);
        return {id, title: id.toUpperCase(), tabs: uids.map((uid, i) => mkTab(rng2, uid, i))};
    });

    let failedCases = 0;
    let exercisedRemoval = 0; // count cases that actually produced a removal (gate not vacuous)

    for (let i = 0; i < CASES; i++) {
        // --- base snapshot: a random subset of groups, each with a random subset of tabs.
        const snapGroupIds = randSubset(rng, groupIds, 0.7);
        const pulledSnapshot = {
            groups: mkGroups(rng, snapGroupIds, tabUids),
            pinnedTabs: randSubset(rng, pinnedUids, 0.5).map((uid, i) => mkPinned(rng, uid, i)),
            watermark: {},
        };

        // --- pulled remote delta log: a mix of removes/adds/option.sets so resolved state
        // diverges from local (which is what can trigger removals).
        const remoteEvents = [];
        let seq = 1;
        for (const uid of randSubset(rng, tabUids, 0.4)) {
            const gid = pick(rng, groupIds);
            if (chance(rng, 0.5)) {
                remoteEvents.push({seq: seq++, ts: 100 + seq, op: 'tab.remove', groupId: gid, uid});
            } else {
                remoteEvents.push({seq: seq++, ts: 100 + seq, op: 'tab.add', groupId: gid, tab: mkTab(rng, uid, 0)});
            }
        }
        for (const id of randSubset(rng, groupIds, 0.3)) {
            remoteEvents.push({seq: seq++, ts: 100 + seq, op: 'group.remove', groupId: id});
        }
        for (const uid of randSubset(rng, pinnedUids, 0.4)) {
            remoteEvents.push({seq: seq++, ts: 100 + seq, op: 'pinned.remove', uid});
        }
        for (const key of randSubset(rng, optionKeys, 0.4)) {
            remoteEvents.push({seq: seq++, ts: 100 + seq, op: 'option.set', key, value: chance(rng, 0.5)});
        }
        const pulledDeltaLogs = remoteEvents.length ? [{deviceId: REMOTE, events: remoteEvents}] : [];

        // --- local pending self events (occasionally), so the planner also merges self-side
        // pending changes. Kept small.
        const localPendingEvents = [];
        if (chance(rng, 0.4)) {
            const uid = pick(rng, tabUids);
            const gid = pick(rng, groupIds);
            localPendingEvents.push({seq: 1, ts: 50, op: chance(rng, 0.5) ? 'tab.add' : 'tab.remove', groupId: gid, uid, tab: mkTab(rng, uid, 0)});
        }

        // --- local live state: random groups/tabs/pinned, partly overlapping the snapshot.
        const localGroupIds = randSubset(rng, groupIds, 0.8);
        const localState = {
            groups: mkGroups(rng, localGroupIds, tabUids),
            pinnedTabs: randSubset(rng, pinnedUids, 0.6).map((uid, i) => mkPinned(rng, uid, i)),
            options: optionKeys.reduce((o, k) => (o[k] = chance(rng, 0.5), o), {}),
        };

        // --- baseline: one of {missing, empty, random subset}. The first two exercise
        // invariant B; the random subset exercises A and C with a non-trivial gate.
        const baselineKind = rngInt(rng, 3);
        let priorBaseline;
        let expectEmptyRemovals = false;
        if (baselineKind === 0) {
            priorBaseline = undefined; // MISSING
            expectEmptyRemovals = true;
        } else if (baselineKind === 1) {
            priorBaseline = {tabUids: [], groupIds: [], pinnedUids: [], optionKeys: []}; // EMPTY
            expectEmptyRemovals = true;
        } else {
            priorBaseline = {
                tabUids: randSubset(rng, tabUids, 0.6),
                groupIds: randSubset(rng, groupIds, 0.6),
                pinnedUids: randSubset(rng, pinnedUids, 0.6),
                optionKeys: randSubset(rng, optionKeys, 0.6),
            };
        }

        const input = {pulledSnapshot, pulledDeltaLogs, localPendingEvents, selfDeviceId: SELF, localState};
        if (priorBaseline !== undefined) {
            input.priorBaseline = priorBaseline;
        }

        const violations = assertInvariants(`fuzz#${i}`, input, expectEmptyRemovals);
        if (violations.length) {
            failedCases++;
            if (failedCases <= 5) {
                console.log(`  FAIL  ${violations[0]}`);
            }
        } else {
            const plan = planSync(input);
            if ((plan.browserOps.tabsToRemove || []).length
                || (plan.browserOps.groupsToRemove || []).length
                || (plan.browserOps.pinnedToRemove || []).length) {
                exercisedRemoval++;
            }
        }
    }

    check(`fuzz: all ${CASES} randomized cases satisfy invariants A-D`, failedCases === 0, `${failedCases} cases failed`);
    // guard against a vacuous pass: at least some cases must actually have produced a
    // (legitimate, baselined) removal, proving the gate is being exercised, not just empty.
    check('fuzz: removal gate is actually exercised (non-vacuous)', exercisedRemoval > 0, `exercisedRemoval=${exercisedRemoval}`);
    console.log(`  info  fuzz produced a removal in ${exercisedRemoval}/${CASES} cases`);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
