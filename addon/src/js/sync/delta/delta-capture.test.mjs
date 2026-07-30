/**
 * Standalone node test for the delta-capture OPTION_SET gate (the sync-vs-user race fix).
 *
 * Plain `node delta-capture.test.mjs` (STG has no test runner). The contract under test
 * lives INSIDE the browser-impure `delta-capture.js` (`optionsChanged`'s decision to skip
 * capture), so re-implementing it would not test the fix. Instead we load the REAL module
 * and stub only its browser-dependent imports via `delta-capture.test.loader.mjs`
 * (registered below), collecting appended events on `globalThis.__appended`.
 *
 * The bug: `optionsChanged` skipped capture whenever `isApplying()` was true, which stays
 * true for the whole sync-apply window. That correctly suppressed the echo of an
 * apply-written option, but ALSO silently dropped a user's own option edit made while a
 * sync happened to be applying. The fix threads an explicit `{fromSync}` marker: skip only
 * a sync-originated write; capture a user write even mid-apply.
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs); it uses
 * node globals (process, console, module.register) the browser config bans.
 */

import {register} from 'node:module';

register(new URL('./delta-capture.test.loader.mjs', import.meta.url));

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

globalThis.__appended = [];

const {optionsChanged, beginApply, endApply, isApplying, markAppliedMove, consumeAppliedMoveEcho} = await import('./delta-capture.js');

function reset() {
    globalThis.__appended.length = 0;
}

// --- 1. a user-initiated option change is captured while no sync is applying -----------
{
    reset();
    await optionsChanged({closePopupAfterSelectTab: true});

    check('user change (no sync) is captured', globalThis.__appended.length === 1);
    check('captured as an OPTION_SET with the new value',
        globalThis.__appended[0]?.op === 'OPTION_SET'
        && globalThis.__appended[0]?.key === 'closePopupAfterSelectTab'
        && globalThis.__appended[0]?.value === true);
}

// --- 2. a sync-originated write during apply is NOT captured (no echo) -----------------
{
    reset();
    beginApply();
    check('isApplying reflects the active sync', isApplying() === true);

    await optionsChanged({closePopupAfterSelectTab: false}, {fromSync: true});
    check('sync-originated write is skipped (no echo into the log)', globalThis.__appended.length === 0);

    // --- 3. a USER change during that same apply window is STILL captured (the fix) ----
    await optionsChanged({closePopupAfterSelectTab: true});
    endApply();

    check('user change mid-apply is captured despite the active sync', globalThis.__appended.length === 1);
    check('the mid-apply user change carries the user value',
        globalThis.__appended[0]?.key === 'closePopupAfterSelectTab'
        && globalThis.__appended[0]?.value === true);
}

// --- 4. non-synced option keys never enter the OPTION_SET log --------------------------
{
    reset();
    await optionsChanged({syncEnable: true, closePopupAfterSelectTab: false});

    check('local-only keys (syncEnable) are filtered out',
        globalThis.__appended.length === 1 && globalThis.__appended[0].key === 'closePopupAfterSelectTab');
}

// --- 5. applied-move echo gate (#6): reconcile's own moves are not recaptured ----------
{
    // A move armed by apply and settling within the trailing window ⇒ echo (suppress).
    markAppliedMove(101);
    check('apply-armed move settling after endApply ⇒ echo (suppress)',
        consumeAppliedMoveEcho(101) === true);
    // The mark is consumed on read, so a genuine LATER user move of the SAME tab syncs.
    check('mark consumed on read ⇒ next move of the same tab is a USER move (capture)',
        consumeAppliedMoveEcho(101) === false);

    // A move of a tab apply never touched is a USER move even right after apply.
    check('unmarked tab ⇒ USER move (capture)',
        consumeAppliedMoveEcho(202) === false);

    // While apply is in progress every move is an echo (matches the existing isApplying gate).
    beginApply();
    check('in-apply move (no mark) ⇒ echo (suppress)',
        consumeAppliedMoveEcho(303) === true);
    endApply();
    check('after endApply, an unmarked tab is a USER move (capture)',
        consumeAppliedMoveEcho(303) === false);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
