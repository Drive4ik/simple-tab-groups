/**
 * Standalone node test for the delta-log OVERFLOW/DRAIN fix. Plain `node overflow-drain.test.mjs`
 * (STG has no test runner).
 *
 * The bug (confirmed on a real profile): the per-device delta log was pinned at its cap and could
 * never drain. `dropOverflow()` blindly spliced the oldest events, and the `onOverflow` handler
 * reset the sync bookkeeping (`lastPushedSeq`/`pendingTruncateSeq`), which guaranteed the deferred
 * truncation handshake never confirmed — the log re-overflowed and reset again forever.
 *
 * The pure truncation decision (`compaction.resolveDeferredTruncation` + `selfFoldedSeq`) is
 * import-free and used directly. The impure pieces — `dropOverflow`'s floor rule (delta-log.js)
 * and the compaction/confirm wiring (delta-sync.js) pull in browser globals — so, exactly as the
 * sibling `deferred-truncation.test.mjs` does, we model that small deterministic flow here over an
 * in-memory cloud + local log and pin the invariants:
 *   - a non-destructive `onOverflow` PRESERVES the markers, so deferred truncation drains the log
 *     below the cap over the normal cycles (no reset spiral);
 *   - `dropOverflow` NEVER drops the un-synced tail (seq above the cloud-confirmed floor);
 *   - when the log exceeds the cap with an un-synced excess, a drain-broken SIGNAL fires instead
 *     of silently discarding.
 */

import {
    resolveDeferredTruncation,
    selfFoldedSeq,
    truncateSelfEvents,
} from './compaction.js';

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

const SELF = 'self';
const MAX_EVENTS = 10;
const ev = seq => ({seq, op: 'tab.add', uid: `u${seq}`});

// Faithful model of delta-log.js `dropOverflow()` with the floor rule: only head events whose seq
// is at/below the safe-drop floor (= highest seq durable in the cloud) may be dropped, and never
// more than the overflow. Any remaining excess is the un-drainable un-synced tail.
function dropOverflow(events, floor) {
    if (events.length <= MAX_EVENTS) {
        return {droppedThroughSeq: 0, drainBrokenExcess: 0};
    }
    const overflow = events.length - MAX_EVENTS;
    let droppableHead = 0;
    while (droppableHead < events.length && events[droppableHead].seq <= floor) {
        droppableHead += 1;
    }
    const toDrop = Math.min(overflow, droppableHead);
    let droppedThroughSeq = 0;
    if (toDrop > 0) {
        const dropped = events.splice(0, toDrop);
        droppedThroughSeq = dropped[dropped.length - 1].seq;
    }
    const excess = events.length - MAX_EVENTS;
    return {droppedThroughSeq, drainBrokenExcess: excess > 0 ? excess : 0};
}

function makeWorld() {
    return {
        cloud: {
            snapshotWatermark: {[SELF]: 0},
            selfDelta: [],
        },
        local: {
            log: [],
            lastPushedSeq: 0,
            pendingTruncate: 0,
        },
        signals: {overflows: [], drainBroken: []},
    };
}

// the safe-drop floor delta-sync injects: the highest self seq durable in the cloud (= lastPushedSeq).
function safeDropFloor(w) {
    return w.local.lastPushedSeq;
}

function applyOverflow(w) {
    const {droppedThroughSeq, drainBrokenExcess} = dropOverflow(w.local.log, safeDropFloor(w));
    if (droppedThroughSeq) {
        w.signals.overflows.push(droppedThroughSeq);
    }
    if (drainBrokenExcess) {
        w.signals.drainBroken.push(drainBrokenExcess);
    }
    return {droppedThroughSeq, drainBrokenExcess};
}

// One PUSH+COMPACTION cycle: push the un-synced tail to the cloud self-delta, advance lastPushedSeq,
// fold up to newSelfWatermark in the snapshot, record the DEFERRED truncation marker. The
// non-destructive overflow backstop runs at the end and must NOT touch the markers.
function pushCompactionCycle(w, newSelfWatermark) {
    w.cloud.selfDelta = w.local.log.slice();
    w.local.lastPushedSeq = w.local.log.reduce((max, e) => (e.seq > max ? e.seq : max), w.local.lastPushedSeq);
    w.cloud.snapshotWatermark = {[SELF]: newSelfWatermark};
    const folded = selfFoldedSeq({[SELF]: newSelfWatermark}, SELF, w.local.lastPushedSeq);
    if (folded > 0) {
        w.local.pendingTruncate = Math.max(w.local.pendingTruncate, folded);
    }
    applyOverflow(w);
}

// One RECONCILE cycle: confirm-or-defer the pending truncation against the pulled snapshot
// watermark; on confirm, clearUpTo locally + truncate the cloud self-delta + clear the marker.
function reconcileCycle(w) {
    const {confirmed, truncateSeq} = resolveDeferredTruncation(
        w.local.pendingTruncate, w.cloud.snapshotWatermark, SELF);
    if (confirmed && truncateSeq > 0) {
        w.local.log = w.local.log.filter(e => e.seq > truncateSeq);
        w.cloud.selfDelta = truncateSelfEvents(w.cloud.selfDelta, truncateSeq);
        w.local.pendingTruncate = 0;
    }
    applyOverflow(w);
    return {confirmed, truncateSeq};
}

// ===================== drain: overflow, then deferred truncation drains below cap =====
{
    const w = makeWorld();
    w.local.log = Array.from({length: 12}, (_, i) => ev(i + 1));

    // compaction folds+pushes the whole log; the backstop drops only cloud-durable head events.
    pushCompactionCycle(w, 12);

    check('drain: markers preserved across overflow (lastPushedSeq)', w.local.lastPushedSeq === 12);
    check('drain: markers preserved across overflow (pendingTruncate)', w.local.pendingTruncate === 12,
        `pendingTruncate=${w.local.pendingTruncate}`);
    check('drain: backstop bounded the log to the cap', w.local.log.length === MAX_EVENTS,
        `len=${w.local.log.length}`);
    check('drain: backstop dropped only cloud-durable head events', w.signals.overflows.length === 1
        && w.signals.overflows[0] === 2, JSON.stringify(w.signals.overflows));
    check('drain: no drain-broken signal (everything was durable)', w.signals.drainBroken.length === 0,
        JSON.stringify(w.signals.drainBroken));

    // a later cycle pulls the surviving snapshot (watermark[self]=12) and CONFIRMS the truncation.
    const r = reconcileCycle(w);
    check('drain: deferred truncation confirmed', r.confirmed === true && r.truncateSeq === 12);
    check('drain: deferred truncation drained the log BELOW the cap', w.local.log.length === 0,
        `len=${w.local.log.length}`);
    check('drain: marker cleared after confirm', w.local.pendingTruncate === 0);
    check('drain: NO reset spiral — no repeated overflow after draining', w.signals.overflows.length === 1
        && w.signals.drainBroken.length === 0);
}

// ===================== convergence over many cycles (no death-spiral) =================
{
    const w = makeWorld();
    let nextSeq = 1;

    // steady state: each round captures a burst, pushes+compacts, then a reconcile confirms.
    for (let round = 0; round < 20; round++) {
        for (let i = 0; i < 8; i++) {
            w.local.log.push(ev(nextSeq++));
        }
        const highest = nextSeq - 1;
        pushCompactionCycle(w, highest);
        reconcileCycle(w);
    }

    check('converge: the log stays bounded and drains every round', w.local.log.length <= MAX_EVENTS,
        `len=${w.local.log.length}`);
    check('converge: drain never broke (all pushes succeeded)', w.signals.drainBroken.length === 0,
        JSON.stringify(w.signals.drainBroken.slice(0, 5)));
}

// ===================== un-synced tail is NEVER dropped by dropOverflow ================
{
    // log 1..12, but only 1..5 are durable in the cloud (lastPushedSeq = 5). overflow = 2.
    const events = Array.from({length: 12}, (_, i) => ev(i + 1));
    const {droppedThroughSeq, drainBrokenExcess} = dropOverflow(events, 5);

    check('tail: drops only up to the floor', droppedThroughSeq === 2, `droppedThroughSeq=${droppedThroughSeq}`);
    check('tail: the un-synced tail (seq > floor) survives',
        events.length === MAX_EVENTS && events[0].seq === 3 && events.every(e => e.seq > 2),
        `first=${events[0].seq} len=${events.length}`);
    check('tail: no drain-broken (the durable head absorbed the whole overflow)', drainBrokenExcess === 0);
}

// ===================== drain-broken SIGNAL fires when the excess is un-synced =========
{
    // log 1..12, only seq 1 is durable (lastPushedSeq = 1). overflow = 2 but only 1 is droppable.
    const events = Array.from({length: 12}, (_, i) => ev(i + 1));
    const {droppedThroughSeq, drainBrokenExcess} = dropOverflow(events, 1);

    check('broken: drops the single durable head event', droppedThroughSeq === 1, `droppedThroughSeq=${droppedThroughSeq}`);
    check('broken: the un-synced tail is kept (log overshoots the cap, no loss)',
        events.length === MAX_EVENTS + 1 && events[0].seq === 2, `len=${events.length} first=${events[0]?.seq}`);
    check('broken: drain-broken signal reports the un-drainable excess', drainBrokenExcess === 1,
        `drainBrokenExcess=${drainBrokenExcess}`);
}

// ===================== nothing durable: never drop, always signal ====================
{
    // offline / bad token: lastPushedSeq = 0, so no event is durable — drop nothing, signal.
    const events = Array.from({length: 13}, (_, i) => ev(i + 1));
    const before = events.map(e => e.seq);
    const {droppedThroughSeq, drainBrokenExcess} = dropOverflow(events, 0);

    check('offline: nothing is dropped', droppedThroughSeq === 0 && events.length === 13
        && JSON.stringify(events.map(e => e.seq)) === JSON.stringify(before));
    check('offline: drain-broken reports the full over-cap excess', drainBrokenExcess === 3,
        `drainBrokenExcess=${drainBrokenExcess}`);
}

// ============================ summary ========================================
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.error('FAILED:', failures.join(', '));
    process.exit(1);
}
