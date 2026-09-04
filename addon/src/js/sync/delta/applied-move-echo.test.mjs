/**
 * Standalone node test for the PURE sync-applied move echo decision
 * (`applied-move-echo.js`).
 *
 * Plain `node applied-move-echo.test.mjs` (STG has no test runner). The module is pure (no
 * `browser.*` / cache), so it imports directly.
 *
 * Regression for the "index storm" echo (#6): reconcile's own reorder emits `onMoved`
 * events that settle ~70ms later — AFTER the transient skip flag is cleared and often after
 * the apply pass. Captured as fresh `tab.move` ops they bloat the log and trigger another
 * reorder round next sync. A move that lands while apply is in progress OR within the
 * trailing apply window (against a mark armed when apply issued the move) is an echo and
 * must be SUPPRESSED, while a genuine USER move made outside that causal window must sync.
 */

import {isAppliedMoveEcho} from './applied-move-echo.js';

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

const NOW = 1_000_000; // fixed clock

// --- in-apply: synchronous suppression regardless of any mark ------------------------------
check('in-apply, no mark ⇒ ECHO (suppress)',
    isAppliedMoveEcho({applying: true, markExpiry: undefined, now: NOW}) === true);
check('in-apply wins even with an expired mark ⇒ ECHO',
    isAppliedMoveEcho({applying: true, markExpiry: NOW - 1, now: NOW}) === true);

// --- settle AFTER the apply pass, within the trailing window: live mark ⇒ ECHO (the churn) -
check('not applying, live mark (now < expiry) ⇒ ECHO (suppress reconcile move echo)',
    isAppliedMoveEcho({applying: false, markExpiry: NOW + 4_000, now: NOW}) === true);
check('not applying, live mark at the very edge (now just below expiry) ⇒ ECHO',
    isAppliedMoveEcho({applying: false, markExpiry: NOW + 1, now: NOW}) === true);

// --- genuine USER move: not applying, no/expired mark ⇒ NOT an echo (must sync) ------------
check('not applying, no mark ⇒ USER move (capture)',
    isAppliedMoveEcho({applying: false, markExpiry: undefined, now: NOW}) === false);
check('not applying, mark expired exactly (now === expiry) ⇒ USER move (capture)',
    isAppliedMoveEcho({applying: false, markExpiry: NOW, now: NOW}) === false);
check('not applying, mark long expired ⇒ USER move (capture)',
    isAppliedMoveEcho({applying: false, markExpiry: NOW - 10_000, now: NOW}) === false);

// --- robustness: a non-finite markExpiry is treated as no mark -----------------------------
check('not applying, markExpiry = NaN ⇒ USER move (capture)',
    isAppliedMoveEcho({applying: false, markExpiry: NaN, now: NOW}) === false);
check('not applying, markExpiry = null ⇒ USER move (capture)',
    isAppliedMoveEcho({applying: false, markExpiry: null, now: NOW}) === false);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
