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

const {
    optionsChanged,
    beginApply,
    endApply,
    isApplying,
    markAppliedMove,
    consumeAppliedMoveEcho,
    tabModified,
    pinnedModified,
    tabRemoved,
} = await import('./delta-capture.js');
const {contentMark} = await import('./content-marks.js');

globalThis.__contentMarks = {};
globalThis.__tabFacts = {};

function reset() {
    globalThis.__appended.length = 0;
    globalThis.__contentMarks = {};
    globalThis.__tabFacts = {};
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

// --- 6. last-synced content gate: capture is edge-triggered, not level-triggered ------
{
    // A tab whose content still equals what the last sync agreed on is NOT re-pushed:
    // the drift-back that fed the two-device url/title ping-pong stops here.
    reset();
    globalThis.__tabFacts = {7: {uid: 'u7', groupId: 1, lastModified: 5}};
    globalThis.__contentMarks = {u7: contentMark({url: 'https://a.test/', title: 'A'})};

    await tabModified({id: 7, url: 'https://a.test/', title: 'A', windowId: 1, discarded: true});
    check('content equal to the last-synced value is not captured',
        globalThis.__appended.length === 0);

    // A genuine user edit to a DIFFERENT value is always captured.
    await tabModified({id: 7, url: 'https://a.test/next', title: 'A', windowId: 1, discarded: false});
    check('a user edit to a different url is captured',
        globalThis.__appended.length === 1
        && globalThis.__appended[0].op === 'TAB_MODIFY'
        && globalThis.__appended[0].tab.url === 'https://a.test/next');

    // The capture itself becomes the newest thing the sync layer knows for that uid, so
    // navigating BACK to the older agreed value is still a real change and must sync.
    await tabModified({id: 7, url: 'https://a.test/', title: 'A', windowId: 1, discarded: false});
    check('navigating back to the previously agreed value after a local edit is captured',
        globalThis.__appended.length === 2
        && globalThis.__appended[1].tab.url === 'https://a.test/');

    // ...and the re-emission of that very same value is a no-op again.
    await tabModified({id: 7, url: 'https://a.test/', title: 'A', windowId: 1, discarded: false});
    check('re-emitting the just-captured value is not captured twice',
        globalThis.__appended.length === 2);
}

// --- 7. a uid with no mark yet behaves exactly as today --------------------------------
{
    reset();
    globalThis.__tabFacts = {8: {uid: 'u8', groupId: 1}};

    await tabModified({id: 8, url: 'https://a.test/', title: 'A', windowId: 1, discarded: false});
    check('an unmarked uid is captured as before',
        globalThis.__appended.length === 1 && globalThis.__appended[0].op === 'TAB_MODIFY');
}

// --- 8. a group-pin flip is content, not drift -----------------------------------------
{
    reset();
    globalThis.__tabFacts = {9: {uid: 'u9', groupId: 1, groupPinned: true}};
    globalThis.__contentMarks = {u9: contentMark({url: 'https://a.test/', title: 'A', pinned: false})};

    await tabModified({id: 9, url: 'https://a.test/', title: 'A', windowId: 1, discarded: false});
    check('a group-pin change with unchanged url/title is captured',
        globalThis.__appended.length === 1 && globalThis.__appended[0].tab.pinned === true);
}

// --- 9. the same gate guards the browser-pinned capture path ---------------------------
{
    reset();
    globalThis.__tabFacts = {10: {uid: 'u10'}};
    globalThis.__contentMarks = {u10: contentMark({url: 'https://p.test/', title: 'P'})};

    await pinnedModified({id: 10, url: 'https://p.test/', title: 'P', index: 0, discarded: true});
    check('a pinned tab still at the last-synced content is not captured',
        globalThis.__appended.length === 0);

    await pinnedModified({id: 10, url: 'https://p.test/other', title: 'P', index: 0, discarded: false});
    check('a pinned tab edited to a different url is captured',
        globalThis.__appended.length === 1 && globalThis.__appended[0].op === 'PINNED_MODIFY');
}

// --- 10. removing a tab drops its mark (bounded store, no stale suppression) -----------
{
    reset();
    globalThis.__tabFacts = {11: {uid: 'u11', groupId: 1}};
    globalThis.__contentMarks = {u11: contentMark({url: 'https://a.test/', title: 'A'})};

    await tabRemoved('u11', 1);
    check('TAB_REMOVE forgets the uid mark',
        !Object.hasOwn(globalThis.__contentMarks, 'u11'));
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
