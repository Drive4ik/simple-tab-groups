/**
 * Standalone node test for DEFERRED SELF-TRUNCATION (Part C: feat sync-deferred-truncation),
 * the crash-safe data-loss backstop. Plain `node deferred-truncation.test.mjs` (no runner).
 *
 * The PURE decision (compaction.resolveDeferredTruncation + selfFoldedSeq/truncateSelfEvents)
 * is import-free/browser-free and imported directly. The CYCLE wiring lives in delta-sync.js
 * (which pulls in tabs/groups and can't load under node), so — exactly as the sibling tests do
 * — we model that small, deterministic flow here over an in-memory cloud + local log and pin
 * the invariant: a compaction cycle records a marker but does NOT truncate (events stay in the
 * cloud self-delta); a later cycle truncates ONLY once the pulled snapshot watermark confirms
 * durability; a CLOBBERED snapshot leaves the marker and the events recoverable; re-runs
 * converge.
 */

import {
    resolveDeferredTruncation,
    resolveSelfDeltaFile,
    selfFoldedSeq,
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
const ev = seq => ({seq, op: 'tab.add', uid: `u${seq}`});

// ===================== pure resolveDeferredTruncation ========================
{
    // nothing pending
    check('resolve: no pending marker ⇒ not confirmed',
        JSON.stringify(resolveDeferredTruncation(0, {[SELF]: 10}, SELF)) === JSON.stringify({confirmed: false, truncateSeq: 0}));
    check('resolve: null pending ⇒ not confirmed',
        resolveDeferredTruncation(null, {[SELF]: 10}, SELF).confirmed === false);

    // confirmed: cloud watermark covers the pending seq (our snapshot survived / superseded)
    check('resolve: watermark >= pending ⇒ confirmed at pending seq',
        JSON.stringify(resolveDeferredTruncation(5, {[SELF]: 5}, SELF)) === JSON.stringify({confirmed: true, truncateSeq: 5}));
    check('resolve: watermark ABOVE pending (later snapshot) ⇒ confirmed',
        resolveDeferredTruncation(5, {[SELF]: 9}, SELF).confirmed === true);

    // clobbered: watermark rolled back below pending ⇒ keep deferring
    check('resolve: watermark below pending (CLOBBERED) ⇒ NOT confirmed',
        JSON.stringify(resolveDeferredTruncation(5, {[SELF]: 2}, SELF)) === JSON.stringify({confirmed: false, truncateSeq: 0}));
    check('resolve: missing self watermark (treated 0) ⇒ NOT confirmed',
        resolveDeferredTruncation(5, {}, SELF).confirmed === false);
}

// ===================== cycle model: write defers, later confirms =============
// Minimal model of the delta-sync compaction/reconciliation flow over an in-memory cloud
// (snapshot + self delta file) and a local log. Mirrors the storage marker + the push block.
function makeWorld() {
    return {
        cloud: {
            snapshotWatermark: {[SELF]: 0}, // STG-sync-snapshot.json watermark[self]
            selfDelta: [],                  // STG-sync-delta-self.json events
        },
        local: {
            log: [],                        // DeltaLog events
            lastPushedSeq: 0,
            pendingTruncate: 0,             // deltaPendingTruncateSeq:self
        },
    };
}

// One COMPACTION cycle: write the full self log to the cloud + record the deferred marker; do
// NOT truncate locally. (newWatermark[self] is the highest self seq folded into the snapshot.)
function compactionCycle(w, newSelfWatermark) {
    // the snapshot we WRITE folds the self log up to newSelfWatermark.
    w.cloud.snapshotWatermark = {[SELF]: newSelfWatermark};
    // cloud self-delta = the FULL self log (NO truncation in the writing cycle).
    w.cloud.selfDelta = w.local.log.slice();
    // record the deferred marker = selfFoldedSeq (clamped to lastPushedSeq), keep the larger.
    const folded = selfFoldedSeq({[SELF]: newSelfWatermark}, SELF, w.local.lastPushedSeq);
    if (folded > 0) {
        w.local.pendingTruncate = Math.max(w.local.pendingTruncate, folded);
    }
}

// One RECONCILE cycle: given the pulled snapshot watermark, confirm-or-defer. On confirm,
// truncate the local log + the cloud self-delta and clear the marker. `newEvents` are the
// events captured since the last push — planSync only produces a deltaFileToWrite when the
// self log actually grew, so an idle confirm cycle has none. Returns the outcome.
function reconcileCycle(w, {newEvents = []} = {}) {
    const {confirmed, truncateSeq} = resolveDeferredTruncation(
        w.local.pendingTruncate, w.cloud.snapshotWatermark, SELF);

    const cloudSelfTruncateSeq = confirmed ? truncateSeq : 0;

    const deltaFileToWrite = newEvents.length
        ? {deviceId: SELF, events: w.cloud.selfDelta.concat(newEvents)}
        : null;

    const selfDeltaFile = resolveSelfDeltaFile(
        deltaFileToWrite, w.cloud.selfDelta, cloudSelfTruncateSeq, SELF);

    if (selfDeltaFile) {
        w.cloud.selfDelta = selfDeltaFile.events;
    }

    if (confirmed && truncateSeq > 0) {
        w.local.log = w.local.log.filter(e => e.seq > truncateSeq);     // clearUpTo
        w.local.pendingTruncate = 0;                                    // clear marker
    }

    return {confirmed, truncateSeq, wroteSelfDelta: !!selfDeltaFile};
}

// the union of (cloud snapshot folded effect) + (cloud self-delta) must always still represent
// every event — i.e. no event is "lost" (only in a possibly-clobbered snapshot). We check that
// every seq up to the highest is recoverable from EITHER the cloud delta OR a confirmed fold.
function everyEventRecoverable(w, highestSeq, confirmedFoldSeq) {
    for (let s = 1; s <= highestSeq; s++) {
        const inCloudDelta = w.cloud.selfDelta.some(e => e.seq === s);
        const inConfirmedFold = s <= confirmedFoldSeq; // durably in a snapshot we confirmed
        if (!inCloudDelta && !inConfirmedFold) {
            return false;
        }
    }
    return true;
}

// --- happy path: compaction defers, next cycle confirms + truncates ----------
{
    const w = makeWorld();
    w.local.log = [ev(1), ev(2), ev(3), ev(4), ev(5)];
    w.local.lastPushedSeq = 5;

    compactionCycle(w, 5); // snapshot folds self up to seq 5

    check('compaction cycle: marker recorded', w.local.pendingTruncate === 5);
    check('compaction cycle: local log NOT truncated (full copy kept)', w.local.log.length === 5);
    check('compaction cycle: cloud self-delta keeps ALL events (deferred)',
        w.cloud.selfDelta.length === 5);
    check('compaction cycle: every event still recoverable from the cloud delta',
        everyEventRecoverable(w, 5, 0) === true);

    // a later cycle pulls the (surviving) snapshot whose watermark[self]=5 ⇒ confirm.
    const r = reconcileCycle(w);
    check('reconcile (survived): confirmed at seq 5', r.confirmed === true && r.truncateSeq === 5);
    check('reconcile (survived): local log truncated', w.local.log.length === 0);
    check('reconcile (survived): cloud self-delta truncated', w.cloud.selfDelta.length === 0);
    check('reconcile (survived): marker cleared', w.local.pendingTruncate === 0);
    check('reconcile (survived): events recoverable via confirmed fold (no loss)',
        everyEventRecoverable(w, 5, 5) === true);

    // idempotent re-run: nothing pending ⇒ no-op, still converged.
    const r2 = reconcileCycle(w);
    check('reconcile re-run: idempotent no-op', r2.confirmed === false
        && w.local.log.length === 0 && w.local.pendingTruncate === 0);
}

// --- CLOBBER path: peer overwrote our snapshot with an older one -------------
{
    const w = makeWorld();
    w.local.log = [ev(1), ev(2), ev(3)];
    w.local.lastPushedSeq = 3;

    compactionCycle(w, 3); // we fold up to 3 and record the marker (full delta still in cloud)
    check('clobber setup: marker recorded at 3', w.local.pendingTruncate === 3);

    // a peer CLOBBERS the snapshot with an older base whose watermark[self] rolled back to 1.
    w.cloud.snapshotWatermark = {[SELF]: 1};

    const r = reconcileCycle(w);
    check('reconcile (clobbered): NOT confirmed', r.confirmed === false);
    check('reconcile (clobbered): local log NOT truncated', w.local.log.length === 3);
    check('reconcile (clobbered): cloud self-delta still holds the events', w.cloud.selfDelta.length === 3);
    check('reconcile (clobbered): marker preserved for a later cycle', w.local.pendingTruncate === 3);
    // NO LOSS: the just-deferred events are still in the cloud self-delta (watermark only
    // confirms up to seq 1, but the delta carries 1..3), so a replay re-folds them.
    check('reconcile (clobbered): every event recoverable from the cloud delta (NO LOSS)',
        everyEventRecoverable(w, 3, 1) === true);

    // CONVERGENCE: once a later snapshot catches the watermark back up to >= 3, it confirms.
    w.cloud.snapshotWatermark = {[SELF]: 3};
    const r2 = reconcileCycle(w);
    check('reconcile (recovered): confirms once watermark catches up', r2.confirmed === true);
    check('reconcile (recovered): local log truncated', w.local.log.length === 0);
    check('reconcile (recovered): marker cleared', w.local.pendingTruncate === 0);
}

// --- clamp to lastPushedSeq: never mark an unpushed/unfolded tail ------------
{
    const w = makeWorld();
    w.local.log = [ev(1), ev(2), ev(3), ev(4), ev(5)]; // captured 5, but only 3 pushed
    w.local.lastPushedSeq = 3;

    // even though the snapshot's watermark[self] is 5, selfFoldedSeq clamps the marker to the
    // pushed seq (3) — events 4,5 aren't in the cloud yet, so they must never be trimmed.
    compactionCycle(w, 5);
    check('clamp: marker clamped to lastPushedSeq (3, not 5)', w.local.pendingTruncate === 3);

    const r = reconcileCycle(w);
    check('clamp: confirm truncates only up to the pushed/folded seq 3', r.truncateSeq === 3);
    check('clamp: unpushed tail (4,5) survives in the local log',
        w.local.log.length === 2 && w.local.log.every(e => e.seq > 3));
}

// --- two compactions before a confirm: marker keeps the larger seq -----------
{
    const w = makeWorld();
    w.local.log = [ev(1), ev(2)];
    w.local.lastPushedSeq = 2;
    compactionCycle(w, 2);
    check('two-compactions: first marker = 2', w.local.pendingTruncate === 2);

    // more events captured + pushed, a SECOND compaction before the first ever confirmed.
    w.local.log.push(ev(3), ev(4));
    w.local.lastPushedSeq = 4;
    compactionCycle(w, 4);
    check('two-compactions: marker advanced to the larger seq (4)', w.local.pendingTruncate === 4);

    const r = reconcileCycle(w);
    check('two-compactions: confirm truncates up to the latest folded seq (4)',
        r.confirmed === true && r.truncateSeq === 4 && w.local.log.length === 0);
}

// ===================== the CLOUD self-delta drains too =======================
// The confirmed truncation used to be applied to the cloud self-delta only as a side effect
// of a push that was happening anyway: no new events ⇒ no deltaFileToWrite ⇒ the folded
// prefix stayed in the gist forever, and every later push re-uploaded it. resolveSelfDeltaFile
// makes the confirmed truncation a write in its own right. It is exactly as safe as the local
// clearUpTo it already gates: both fire only once the pulled snapshot watermark proves the
// cloud snapshot durably carries those events.
{
    // pure: a push in flight ⇒ push the union, trimmed by a confirmed truncation
    const pushing = resolveSelfDeltaFile({deviceId: SELF, events: [ev(1), ev(2), ev(3)]}, [ev(1)], 2, SELF);
    check('selfDeltaFile: pushing ⇒ the union is written, trimmed at the confirmed seq',
        pushing.deviceId === SELF && pushing.events.map(e => e.seq).join() === '3');

    const pushingUnconfirmed = resolveSelfDeltaFile({deviceId: SELF, events: [ev(1), ev(2)]}, [ev(1)], 0, SELF);
    check('selfDeltaFile: pushing without a confirmed truncation ⇒ nothing is trimmed',
        pushingUnconfirmed.events.map(e => e.seq).join() === '1,2');

    // pure: nothing to push, but a confirmed truncation can still shrink the cloud file
    const drainOnly = resolveSelfDeltaFile(null, [ev(1), ev(2), ev(3)], 2, SELF);
    check('selfDeltaFile: no push + confirmed truncation ⇒ rewrite the file without the fold',
        drainOnly?.deviceId === SELF && drainOnly.events.map(e => e.seq).join() === '3');

    check('selfDeltaFile: no push + nothing confirmed ⇒ no write at all',
        resolveSelfDeltaFile(null, [ev(1), ev(2)], 0, SELF) === null);

    check('selfDeltaFile: no push + already-trimmed cloud file ⇒ no wasted write',
        resolveSelfDeltaFile(null, [ev(3), ev(4)], 2, SELF) === null);

    check('selfDeltaFile: no push + a fully folded cloud file ⇒ emptied, not left fat',
        resolveSelfDeltaFile(null, [ev(1), ev(2)], 2, SELF)?.events.length === 0);

    check('selfDeltaFile: no push + no cloud file ⇒ nothing to drain',
        resolveSelfDeltaFile(null, undefined, 5, SELF) === null);

    // cycle: compaction, then an IDLE confirm cycle (no new events) drains the gist
    {
        const w = makeWorld();
        w.local.log = [ev(1), ev(2), ev(3)];
        w.local.lastPushedSeq = 3;

        compactionCycle(w, 3);
        check('drain: the compaction cycle leaves the full log in the gist', w.cloud.selfDelta.length === 3);

        const r = reconcileCycle(w);
        check('drain: an idle confirm cycle rewrites the gist file without the folded prefix',
            r.confirmed === true && r.wroteSelfDelta === true && w.cloud.selfDelta.length === 0);
        check('drain: no event is lost — all three are durably folded into the snapshot',
            everyEventRecoverable(w, 3, 3) === true);

        const r2 = reconcileCycle(w);
        check('drain: the next idle cycle writes nothing (converged)', r2.wroteSelfDelta === false);
    }

    // cycle: a later push after the drain carries only the un-folded tail
    {
        const w = makeWorld();
        w.local.log = [ev(1), ev(2), ev(3)];
        w.local.lastPushedSeq = 3;

        compactionCycle(w, 3);
        reconcileCycle(w);

        reconcileCycle(w, {newEvents: [ev(4)]});
        check('drain: a later push uploads only the tail, not the folded history',
            w.cloud.selfDelta.map(e => e.seq).join() === '4');
    }

    // a CLOBBERED snapshot must not drain anything
    {
        const w = makeWorld();
        w.local.log = [ev(1), ev(2), ev(3)];
        w.local.lastPushedSeq = 3;

        compactionCycle(w, 3);
        w.cloud.snapshotWatermark = {[SELF]: 1};

        const r = reconcileCycle(w);
        check('drain: an unconfirmed (clobbered) cycle never shrinks the gist file',
            r.confirmed === false && r.wroteSelfDelta === false && w.cloud.selfDelta.length === 3);
        check('drain: every event stays recoverable from the cloud delta',
            everyEventRecoverable(w, 3, 1) === true);
    }

    // the un-pushed tail is never drained (the clamp still governs what may go)
    {
        const w = makeWorld();
        w.local.log = [ev(1), ev(2), ev(3), ev(4), ev(5)];
        w.local.lastPushedSeq = 3;

        compactionCycle(w, 5);
        const r = reconcileCycle(w);
        check('drain: only the pushed+folded prefix leaves the gist; 4,5 stay',
            r.truncateSeq === 3 && w.cloud.selfDelta.map(e => e.seq).join() === '4,5');
        check('drain: the un-pushed tail survives locally too',
            w.local.log.map(e => e.seq).join() === '4,5');
    }
}

// ============================ summary ========================================
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.error('FAILED:', failures.join(', '));
    process.exit(1);
}
