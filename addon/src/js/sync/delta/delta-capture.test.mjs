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

const DeltaCapture = await import('./delta-capture.js');
const {
    optionsChanged,
    runApplying,
    isApplying,
    markAppliedMove,
    consumeAppliedMoveEcho,
    markAppliedNavigation,
    clearAppliedNavigation,
    settleAppliedNavigation,
    settleAppliedNavigationOnDiscard,
    tabModified,
    pinnedModified,
    tabRemoved,
} = DeltaCapture;
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
    await runApplying(async () => {
        check('isApplying reflects the active sync', isApplying() === true);

        await optionsChanged({closePopupAfterSelectTab: false}, {fromSync: true});
        check('sync-originated write is skipped (no echo into the log)', globalThis.__appended.length === 0);

        // --- 3. a USER change during that same apply window is STILL captured (the fix) ----
        await optionsChanged({closePopupAfterSelectTab: true});
    });

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
    check('apply-armed move settling after the apply pass ⇒ echo (suppress)',
        consumeAppliedMoveEcho(101) === true);
    // The mark is consumed on read, so a genuine LATER user move of the SAME tab syncs.
    check('mark consumed on read ⇒ next move of the same tab is a USER move (capture)',
        consumeAppliedMoveEcho(101) === false);

    // A move of a tab apply never touched is a USER move even right after apply.
    check('unmarked tab ⇒ USER move (capture)',
        consumeAppliedMoveEcho(202) === false);

    // While apply is in progress every move is an echo (matches the existing isApplying gate).
    await runApplying(() => check('in-apply move (no mark) ⇒ echo (suppress)',
        consumeAppliedMoveEcho(303) === true));
    check('after the apply pass, an unmarked tab is a USER move (capture)',
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

// --- 11. an applied navigation that completes on its target asks for no capture --------
{
    reset();
    globalThis.__tabFacts = {12: {uid: 'u12', groupId: 1}};

    markAppliedNavigation(12, 'https://applied.test/');

    check('the completion on the applied target asks for no capture',
        settleAppliedNavigation(12, 'https://applied.test/', 'complete') === false);
    check('a tab with no live mark asks for no capture',
        settleAppliedNavigation(12, 'https://applied.test/', 'complete') === false);
}

// --- 12. a USER navigation landing mid-load still reaches the log ----------------------
// tabs.js drives capture off title/url changes, so the completing event of the user's own
// navigation ('complete' with an unchanged title) carries nothing the capture path reacts
// to. The settle decision is what tells tabs.js the tab landed off the applied target.
{
    reset();
    globalThis.__tabFacts = {13: {uid: 'u13', groupId: 1}};

    markAppliedNavigation(13, 'https://applied.test/');

    await tabModified({id: 13, url: 'https://user.test/', title: 'U', windowId: 1, discarded: false, status: 'loading'});
    check('the mid-load user url is suppressed (still indistinguishable from a redirect hop)',
        globalThis.__appended.length === 0);

    check('the status-only completion off the applied target asks for a capture',
        settleAppliedNavigation(13, 'https://user.test/', 'complete') === true);

    await tabModified({id: 13, url: 'https://user.test/', title: 'U', windowId: 1, discarded: false, status: 'complete'});
    check('the user navigation is captured instead of being reverted by the next sync',
        globalThis.__appended.length === 1 && globalThis.__appended[0].tab.url === 'https://user.test/');
}

// --- 13. a deferred wake navigation arms only the tab it navigates ---------------------
// pending-nav-wake wraps its wake-time navigation in runApplying. That switch must not
// leave a post-apply window in which any tab that changes gets suppressed.
{
    reset();
    globalThis.__tabFacts = {14: {uid: 'u14', groupId: 1}, 15: {uid: 'u15', groupId: 1}};

    markAppliedNavigation(14, 'https://woken.test/');
    await runApplying(() => {});

    check('arming is not a global switch',
        !Object.hasOwn(DeltaCapture, 'shouldArmAppliedNavigation')
        && !Object.hasOwn(DeltaCapture, 'armAppliedNavigation'));

    check('the woken tab keeps the mark for its own applied navigation',
        settleAppliedNavigation(14, 'https://woken.test/', 'complete') === false);

    await tabModified({id: 15, url: 'https://user.test/', title: 'U', windowId: 1, discarded: false, status: 'complete'});
    check('a second, unrelated tab changing right after the wake is captured',
        globalThis.__appended.length === 1 && globalThis.__appended[0].tab.url === 'https://user.test/');
}

// --- 14. an EXPIRED mark alone is no evidence ------------------------------------------
// An applied navigation whose completion never arrives leaves its mark sitting until the
// safety bound. Past the bound the mark can attribute nothing by itself, so it must neither
// suppress a real user navigation nor make an unrelated onUpdated (`audible`, `favIconUrl`,
// a bare `status` — no url, no title) on a tab still sitting at the applied target look like
// a landing off it.
{
    reset();
    globalThis.__tabFacts = {16: {uid: 'u16', groupId: 1}, 17: {uid: 'u17', groupId: 1}};

    markAppliedNavigation(16, 'https://stuck.test/');
    markAppliedNavigation(17, 'https://stuck.test/');

    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;

    try {
        check('an unrelated event past the safety bound asks for no capture',
            settleAppliedNavigation(16, 'https://stuck.test/', 'complete') === false);
        check('and nothing reached the log for it',
            globalThis.__appended.length === 0);

        await tabModified({id: 17, url: 'https://user.test/', title: 'U', windowId: 1, discarded: false, status: 'loading'});
        check('an expired mark does not suppress a real user navigation either',
            globalThis.__appended.length === 1 && globalThis.__appended[0].tab.url === 'https://user.test/');
    } finally {
        Date.now = realNow;
    }
}

// --- 15. a FAILED deferred navigation leaves no live mark behind -----------------------
// pending-nav-wake arms the mark before `browser.tabs.update`. When that call throws no
// navigation ever happens, so the mark must go with it — otherwise it blinds the tab for
// the whole safety bound and then lingers as an expired one.
{
    reset();
    globalThis.__tabFacts = {18: {uid: 'u18', groupId: 1}};

    globalThis.browser = {
        tabs: {
            query: async () => [],
            update: async () => {
                throw new Error('cant navigate');
            },
        },
    };

    const {recordPendingNavTarget} = await import('./pending-nav-store.js');
    const {resolvePendingNav} = await import('./pending-nav-wake.js');

    const liveTab = {id: 18, url: 'https://old.test/', title: 'Old', windowId: 1, discarded: false};
    recordPendingNavTarget('u18', liveTab, {url: 'https://deferred.test/'});

    check('the failed deferred navigation reports no delivery',
        await resolvePendingNav(liveTab, {woke: true}) === false);
    await tabModified({id: 18, url: 'https://user.test/', title: 'U', windowId: 1, discarded: false, status: 'loading'});
    check('the tab is not blinded by the mark of a navigation that never ran',
        globalThis.__appended.length === 1 && globalThis.__appended[0].tab.url === 'https://user.test/');

    check('no mark survives the failure (a live one would report a landing off target)',
        settleAppliedNavigation(18, 'https://user.test/', 'complete') === false);

    delete globalThis.browser;
}

// --- 16. a redirect whose load completes PAST the safety bound -------------------------
// The applied navigation redirects; the hop arrives with `status: 'loading'` and is
// suppressed as part of our own navigation, which keeps the mark and leaves the new url in
// the cache. The load then completes after the bound, so that event carries only `status`.
// If the expired mark reported nothing, the real landing url would never be captured and
// the next diff would navigate the tab back to the applied target — a visible revert.
{
    reset();
    globalThis.__tabFacts = {19: {uid: 'u19', groupId: 1}};

    markAppliedNavigation(19, 'https://target.test/');

    await tabModified({id: 19, url: 'https://redirect.test/', title: 'R', windowId: 1, discarded: false, status: 'loading'});
    check('the redirect hop is suppressed as part of the applied navigation',
        globalThis.__appended.length === 0);

    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;

    try {
        check('the status-only completion past the bound asks for a capture at the landing url',
            settleAppliedNavigation(19, 'https://redirect.test/', 'complete') === true);

        await tabModified({id: 19, url: 'https://redirect.test/', title: 'R', windowId: 1, discarded: false, status: 'complete'});
        check('the redirect landing reaches the log instead of being reverted to the applied url',
            globalThis.__appended.length === 1 && globalThis.__appended[0].tab.url === 'https://redirect.test/');
    } finally {
        Date.now = realNow;
    }
}

// --- 17. an expired mark whose tab never left the applied target stays silent ----------
{
    reset();
    globalThis.__tabFacts = {20: {uid: 'u20', groupId: 1}};

    markAppliedNavigation(20, 'https://target.test/');

    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;

    try {
        check('an expired mark on a tab still at the applied target asks for nothing',
            settleAppliedNavigation(20, 'https://target.test/', 'complete') === false);
        check('and the retired mark cannot report anything on the next event either',
            settleAppliedNavigation(20, 'https://elsewhere.test/', 'complete') === false);
        check('nothing reached the log',
            globalThis.__appended.length === 0);
    } finally {
        Date.now = realNow;
    }
}

// --- 18. the same redirect, still LOADING past the safety bound ------------------------
// The hop was suppressed and left in the cache, so an unrelated event past the bound
// (`favIconUrl`, `audible` — no url, no title) reaches the settle decision carrying the hop
// url and `status: 'loading'`. The tab has not landed there: reporting it would push a
// mid-flight url and drag every peer onto it. But that event must not SPEND the mark either
// — the tab is still in flight, and the settle decision on the event that ends the flight is
// the only report of where it really landed.
{
    reset();
    globalThis.__tabFacts = {23: {uid: 'u23', groupId: 1}};

    markAppliedNavigation(23, 'https://target.test/');

    await tabModified({id: 23, url: 'https://hop.test/', title: 'H', windowId: 1, discarded: false, status: 'loading'});
    check('the hop is suppressed as part of the applied navigation',
        globalThis.__appended.length === 0);

    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;

    try {
        check('an unrelated event past the bound, still loading, asks for no capture',
            settleAppliedNavigation(23, 'https://hop.test/', 'loading') === false);
        check('no mid-flight url reached the log',
            globalThis.__appended.length === 0);
        check('a second in-flight event past the bound still asks for nothing',
            settleAppliedNavigation(23, 'https://hop.test/', 'loading') === false);

        await tabModified({id: 23, url: 'https://final.test/', title: 'F', windowId: 1, discarded: false, status: 'complete'});
        check('the url the tab finally lands on is captured through the ordinary content path',
            globalThis.__appended.length === 1 && globalThis.__appended[0].tab.url === 'https://final.test/');
    } finally {
        Date.now = realNow;
    }
}

// --- 18b. the redirect LANDS on the hop url, past the safety bound ---------------------
// The tab lands exactly where the suppressed hop already put it in the cache, so the
// completing event carries only `status` — the ordinary content path never sees a change and
// the settle decision is the only thing that can push `https://hop.test/`. When a still-loading
// event past the bound spends the mark, that url is lost for good: remote keeps the applied
// target and the next diff navigates the tab back off the page the user is reading.
{
    reset();
    globalThis.__tabFacts = {24: {uid: 'u24', groupId: 1}};

    markAppliedNavigation(24, 'https://target.test/');

    await tabModified({id: 24, url: 'https://hop.test/', title: 'H', windowId: 1, discarded: false, status: 'loading'});
    check('the hop is suppressed as part of the applied navigation',
        globalThis.__appended.length === 0);

    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;

    try {
        check('the still-loading event past the bound asks for no capture',
            settleAppliedNavigation(24, 'https://hop.test/', 'loading') === false);

        const landedOffAppliedTarget = settleAppliedNavigation(24, 'https://hop.test/', 'complete');
        check('the status-only completion at the SAME hop url asks for a capture',
            landedOffAppliedTarget === true);

        if (landedOffAppliedTarget) {
            await tabModified({id: 24, url: 'https://hop.test/', title: 'H', windowId: 1, discarded: false, status: 'complete'});
        }
        check('the hop url reaches the log instead of being reverted to the applied target',
            globalThis.__appended.length === 1 && globalThis.__appended[0].tab.url === 'https://hop.test/');

        check('the landing retired the mark, so the next event reports nothing',
            settleAppliedNavigation(24, 'https://hop.test/', 'complete') === false);
    } finally {
        Date.now = realNow;
    }
}

// --- 18c. a mark now outlives the bound, so the TAB bounds its lifetime ----------------
// tabs.js settles-and-drops the mark on `changeInfo.discarded === true` and onRemoved clears
// it unconditionally, so an in-flight mark that the bound no longer retires still cannot
// outlive the tab it belongs to, nor be inherited by a recycled tab id.
{
    reset();
    globalThis.__tabFacts = {25: {uid: 'u25', groupId: 1}, 26: {uid: 'u26', groupId: 1}};

    markAppliedNavigation(25, 'https://target.test/');
    markAppliedNavigation(26, 'https://target.test/');

    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;

    try {
        check('the discarded tab still holds its in-flight mark before the discard',
            settleAppliedNavigation(25, 'https://hop.test/', 'loading') === false);
        settleAppliedNavigationOnDiscard(25, 'https://hop.test/');
        check('the discard drops it, so no later completion reports a landing',
            settleAppliedNavigation(25, 'https://hop.test/', 'complete') === false);

        check('the removed tab still holds its in-flight mark before onRemoved',
            settleAppliedNavigation(26, 'https://hop.test/', 'loading') === false);
        clearAppliedNavigation(26);
        check('onRemoved drops it, so a recycled tab id starts clean',
            settleAppliedNavigation(26, 'https://hop.test/', 'complete') === false);

        check('nothing reached the log',
            globalThis.__appended.length === 0);
    } finally {
        Date.now = realNow;
    }
}

// --- 19. a tab with NO applied-navigation mark never reports a landing -----------------
// The landing decision compares the observed url with the url THIS device applied. A tab
// that was never navigated by an apply — or whose mark was dropped when it discarded —
// has no applied target, so its url can only be a plain user navigation and the settle
// decision must stay out of it.
{
    reset();
    globalThis.__tabFacts = {21: {uid: 'u21', groupId: 1}, 22: {uid: 'u22', groupId: 1}};

    check('a tab that was never navigated by an apply asks for nothing',
        settleAppliedNavigation(21, 'https://user.test/', 'complete') === false);

    markAppliedNavigation(22, 'https://target.test/');
    clearAppliedNavigation(22);

    check('a dropped mark leaves no target to have landed off',
        settleAppliedNavigation(22, 'https://user.test/', 'complete') === false);
    check('nothing reached the log',
        globalThis.__appended.length === 0);
}

// --- 20. the completing event arrives while an apply pass is still in flight -----------
// `applyDepth` is global and held for the whole apply pass, and tabs.js `onUpdated` is not
// gated on it, so the completion of a redirect on an unrelated tab routinely lands inside
// the window. No landing can be attributed during an apply — but the mark must not be spent
// there either: the hop url is already in the cache, so the completing event carries only
// `status` and the settle decision is the only thing that can ever push it.
{
    reset();
    globalThis.__tabFacts = {27: {uid: 'u27', groupId: 1}};

    markAppliedNavigation(27, 'https://target.test/');

    await tabModified({id: 27, url: 'https://hop.test/', title: 'H', windowId: 1, discarded: false, status: 'loading'});
    check('the hop is suppressed as part of the applied navigation',
        globalThis.__appended.length === 0);

    await runApplying(() => check('a completion inside the apply pass asks for no capture',
        settleAppliedNavigation(27, 'https://hop.test/', 'complete') === false));

    const landedOffAppliedTarget = settleAppliedNavigation(27, 'https://hop.test/', 'complete');
    check('the apply pass did not spend the mark, so the landing is still reported',
        landedOffAppliedTarget === true);

    if (landedOffAppliedTarget) {
        await tabModified({id: 27, url: 'https://hop.test/', title: 'H', windowId: 1, discarded: false, status: 'complete'});
    }
    check('the hop url reaches the log instead of being reverted to the applied target',
        globalThis.__appended.length === 1 && globalThis.__appended[0].tab.url === 'https://hop.test/');

    check('that landing retired the mark',
        settleAppliedNavigation(27, 'https://hop.test/', 'complete') === false);
}

// --- 21. a loading event inside an apply pass keeps the mark too -----------------------
{
    reset();
    globalThis.__tabFacts = {28: {uid: 'u28', groupId: 1}};

    markAppliedNavigation(28, 'https://target.test/');

    await runApplying(() => check('a loading event inside the apply pass asks for no capture',
        settleAppliedNavigation(28, 'https://hop.test/', 'loading') === false));

    check('the mark survives the apply pass and reports the eventual landing',
        settleAppliedNavigation(28, 'https://hop.test/', 'complete') === true);
    check('nothing reached the log by itself',
        globalThis.__appended.length === 0);
}

// --- 22. the apply window is owned by `runApplying`, so it can never leak ------------
// `applyDepth` used to be raised and lowered by two separate exports, and a throw between
// them left it raised for the rest of the background session: `isApplying()` stayed true,
// every capture entry point early-returned and no local change ever reached the delta log
// again. There is no longer a way to raise it without a `finally` that lowers it.
{
    reset();
    globalThis.__tabFacts = {29: {uid: 'u29', groupId: 1}};

    check('there is no unpaired way into the apply window',
        !Object.hasOwn(DeltaCapture, 'beginApply') && !Object.hasOwn(DeltaCapture, 'endApply'));

    let thrown = null;
    try {
        await runApplying(async () => {
            check('the apply window is open inside the callback', isApplying() === true);
            throw new Error('storage read failed');
        });
    } catch (e) {
        thrown = e;
    }

    check('a rejecting apply callback still propagates', thrown?.message === 'storage read failed');
    check('and the apply window is closed again', isApplying() === false);

    await tabModified({id: 29, url: 'https://after-throw.test/', title: 'A', windowId: 1, discarded: false, status: 'complete'});
    check('capture keeps working after an apply pass threw',
        globalThis.__appended.length === 1 && globalThis.__appended[0].tab.url === 'https://after-throw.test/');
}

// --- 23. a synchronous throw and nesting unwind the counter just as cleanly -----------
{
    reset();
    globalThis.__tabFacts = {30: {uid: 'u30', groupId: 1}};

    await runApplying(async () => {
        await runApplying(() => {}).catch(() => {});
        check('the outer apply window survives the inner one closing', isApplying() === true);
    });
    check('both windows closed', isApplying() === false);

    await runApplying(() => {
        throw new Error('sync throw');
    }).catch(() => {});
    check('a synchronous throw closes the window too', isApplying() === false);

    await runApplying(async () => {
        await runApplying(() => {
            throw new Error('inner throw');
        }).catch(() => {});
        check('the inner throw did not close the outer window', isApplying() === true);
    });
    check('the outer window closed after the inner throw', isApplying() === false);

    await tabModified({id: 30, url: 'https://nested.test/', title: 'N', windowId: 1, discarded: false, status: 'complete'});
    check('capture keeps working after nested apply passes threw',
        globalThis.__appended.length === 1 && globalThis.__appended[0].tab.url === 'https://nested.test/');
}

// --- 24. a leaked apply window would also freeze every applied-navigation mark --------
// `applying` gates `isAppliedNavigationSettled`, so a stuck counter makes every mark
// immortal and `consumeAppliedNavigationEcho` keeps suppressing on those tabs forever.
{
    reset();
    globalThis.__tabFacts = {31: {uid: 'u31', groupId: 1}};

    markAppliedNavigation(31, 'https://target.test/');

    await runApplying(async () => {
        throw new Error('apply blew up');
    }).catch(() => {});

    check('the mark can still be settled after the failed apply pass',
        settleAppliedNavigation(31, 'https://hop.test/', 'complete') === true);

    await tabModified({id: 31, url: 'https://hop.test/', title: 'H', windowId: 1, discarded: false, status: 'complete'});
    check('and the landing reaches the log',
        globalThis.__appended.length === 1 && globalThis.__appended[0].tab.url === 'https://hop.test/');
}

// --- 25. a discard IS a landing: the deferred retirement no longer swallows the url ----
// Retirement is deferred while applying, so a mark whose completion landed inside an apply
// pass survives with most of the safety bound left. The user then navigates that tab away:
// the loading event is suppressed as an echo, and if the tab is discarded before the load
// completes the mark used to be dropped with no verdict — tabs.js reports no content change
// on a discard, so the url the user is on never reached the delta log and the next apply
// pulled the tab back to the applied target. A discard ends the flight: the url the tab
// holds at that moment is the url it sits on and the one it will restore to.
{
    reset();
    globalThis.__tabFacts = {32: {uid: 'u32', groupId: 1}};

    markAppliedNavigation(32, 'https://applied.test/');

    await runApplying(() => check('the completion inside the apply pass spends nothing',
        settleAppliedNavigation(32, 'https://applied.test/', 'complete') === false));

    await tabModified({id: 32, url: 'https://user.test/', title: 'U', windowId: 1, discarded: false, status: 'loading'});
    check('the user navigation under the surviving mark is suppressed',
        globalThis.__appended.length === 0);

    const landedOffAppliedTarget = settleAppliedNavigationOnDiscard(32, 'https://user.test/');
    check('the discard is a landing, and it is off the applied target',
        landedOffAppliedTarget === true);

    if (landedOffAppliedTarget) {
        await tabModified({id: 32, url: 'https://user.test/', title: 'U', windowId: 1, discarded: true, status: 'complete'});
    }
    check('the user url reaches the log instead of being reverted to the applied target',
        globalThis.__appended.length === 1 && globalThis.__appended[0].tab.url === 'https://user.test/');
    check('and it is recorded as the sleeping tab it now is',
        globalThis.__appended[0]?.tab.loaded === false);

    check('the discard spent the mark, so nothing can report on it again',
        settleAppliedNavigation(32, 'https://user.test/', 'complete') === false);
}

// --- 26. a discard with no live mark stays out of it -----------------------------------
{
    reset();
    globalThis.__tabFacts = {33: {uid: 'u33', groupId: 1}, 34: {uid: 'u34', groupId: 1}};

    check('a tab no apply ever navigated reports nothing when it discards',
        settleAppliedNavigationOnDiscard(33, 'https://user.test/') === false);

    markAppliedNavigation(34, 'https://applied.test/');
    clearAppliedNavigation(34);
    check('a dropped mark leaves no target the discard could have landed off',
        settleAppliedNavigationOnDiscard(34, 'https://user.test/') === false);

    check('nothing reached the log', globalThis.__appended.length === 0);
}

// --- 27. a discard while genuinely on the applied target is not a capture --------------
{
    reset();
    globalThis.__tabFacts = {35: {uid: 'u35', groupId: 1}};

    markAppliedNavigation(35, 'https://applied.test/');

    check('the tab discarded where the apply put it asks for no capture',
        settleAppliedNavigationOnDiscard(35, 'https://applied.test/') === false);
    check('and the mark went with the discard',
        settleAppliedNavigation(35, 'https://elsewhere.test/', 'complete') === false);
    check('nothing reached the log', globalThis.__appended.length === 0);
}

// --- 28. a discard INSIDE an apply pass still attributes nothing ------------------------
// `applying` enters at exactly one place, so no verdict is produced during a pass: the url
// the tab holds mid-apply may be the one this very pass is navigating away from. The mark
// is dropped regardless, because the discard bounds its lifetime.
{
    reset();
    globalThis.__tabFacts = {36: {uid: 'u36', groupId: 1}};

    markAppliedNavigation(36, 'https://applied.test/');

    await runApplying(() => check('a discard inside the apply pass reports nothing',
        settleAppliedNavigationOnDiscard(36, 'https://stale.test/') === false));

    check('the discard still dropped the mark',
        settleAppliedNavigation(36, 'https://stale.test/', 'complete') === false);
    check('nothing reached the log', globalThis.__appended.length === 0);
}

// --- 29. a discard past the safety bound reports the url the tab holds ------------------
{
    reset();
    globalThis.__tabFacts = {37: {uid: 'u37', groupId: 1}};

    markAppliedNavigation(37, 'https://applied.test/');

    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;

    try {
        check('an expired mark still names the target the discard landed off',
            settleAppliedNavigationOnDiscard(37, 'https://user.test/') === true);
        check('and the mark is spent',
            settleAppliedNavigation(37, 'https://user.test/', 'complete') === false);
    } finally {
        Date.now = realNow;
    }
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
