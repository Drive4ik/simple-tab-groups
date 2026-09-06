/**
 * Standalone node test for the PURE sync-applied navigation echo decision
 * (`applied-nav-echo.js`).
 *
 * Plain `node applied-nav-echo.test.mjs` (STG has no test runner). The module is pure (no
 * `browser.*` / cache), so it imports directly.
 *
 * Suppression is CAUSAL, not wall-clock: a url applied by the transport via
 * `browser.tabs.update` suppresses capture for that tab until the navigation reports
 * `status === 'complete'`. Everything the load does on the way there (redirects, title
 * settling, url canonicalisation) is a resolution of OUR navigation, not a user edit. The
 * expiry is only a safety bound for a navigation that never completes.
 *
 * Suppression requires a KNOWN applied target url. A mark without one cannot attribute the
 * observed state to us, so it never suppresses: a spurious push converges, a swallowed user
 * edit does not.
 *
 * Past the bound the mark itself stops being evidence, but the url it recorded does not: the
 * observed url compared against the applied target still says whether the tab landed
 * elsewhere. So an expired mark decides on that comparison alone — differing url ⇒ capture,
 * equal url ⇒ silence, and no usable url on either side ⇒ silence.
 *
 * A landing is only ever reported for a navigation this device applied. With NO mark at all
 * there is nothing to have landed off, whatever url the caller passes as the target.
 *
 * Past the bound the url is evidence only once the tab is no longer in flight: a load still
 * reporting `loading` is somewhere on the way, not somewhere it landed, and pushing that hop
 * would navigate every peer to a url this tab is about to leave. `loading` is the only status
 * that buys silence — an absent or unrecognised one is read as "not in flight", because losing
 * a real landing reverts the page the user is looking at, while a redundant capture of the url
 * the tab is already showing costs one event.
 *
 * Retiring the mark asks the SAME question: a mark is spent exactly when the tab stops being in
 * flight, which is the moment the landing verdict is decided. `isAppliedNavigationLandedOffTarget`
 * is built on `isAppliedNavigationSettled`, so the two cannot drift apart. A mark spent while the
 * tab was still loading past the bound would be a permanent loss: the completion that follows
 * carries only `status`, so nothing would be left to report the url the tab actually landed on.
 *
 * An apply pass in flight defers that whole question. `applyDepth` is global and held across a
 * whole sync apply, so events from tabs the apply never touched routinely arrive inside it; while
 * it is held nothing can be attributed, so no landing is reported — and therefore no mark may be
 * spent either. `applying` enters at exactly ONE place, `isAppliedNavigationSettled`, and both the
 * retirement and the landing verdict come out of a single `resolveAppliedNavigationSettlement`
 * call, so a caller cannot consume a mark and receive no verdict.
 *
 * A DISCARD ends the flight, but it does not say whose flight it ended. A discard that interrupts
 * an applied load before that load committed leaves the tab on the url the apply was navigating
 * AWAY from — reporting that as a landing pushes the pre-apply url to every peer and reverts the
 * change this device had just applied. The url the tab holds is evidence only for a navigation
 * that was seen to reach its target at least once; `markTargetReached` records that observation,
 * and `isAppliedNavigationDiscardedOffTarget` refuses a verdict without it. Everything else it
 * inherits from the landing verdict, `applying` included, so the discard cannot disagree with it.
 */

import {
    isAppliedNavigationDiscardedOffTarget,
    isAppliedNavigationEcho,
    isAppliedNavigationLandedOffTarget,
    isAppliedNavigationSettled,
    NAVIGATION_COMPLETE_STATUS,
    NAVIGATION_LOADING_STATUS,
    resolveAppliedNavigationSettlement,
} from './applied-nav-echo.js';

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
const SAFETY_MS = 60_000;
const LOADING = NAVIGATION_LOADING_STATUS;
const COMPLETE = NAVIGATION_COMPLETE_STATUS;

// A faithful pure model of the mark store in delta-capture.js, so mark lifecycle scenarios
// (supersede / removal / settle / discard) are exercised through the same predicates. `mark`
// carries the same guards as `markAppliedNavigation`, and every url-bearing observation records
// whether the applied navigation was seen at its target, so the model can only reach states
// production reaches.
function noteReachedTarget(mark, observedUrl) {
    if (mark != null && mark.url === observedUrl) {
        mark.targetReached = true;
    }
}

function createMarkStore() {
    const marks = new Map();
    return {
        mark(tabId, url, now) {
            if (!Number.isFinite(tabId) || typeof url !== 'string') {
                return;
            }
            marks.set(tabId, {expiry: now + SAFETY_MS, url, targetReached: false});
        },
        clear(tabId) {
            marks.delete(tabId);
        },
        discard(tabId, observedUrl, now, applying = false) {
            const mark = marks.get(tabId);
            marks.delete(tabId);
            if (mark == null) {
                return false;
            }
            return isAppliedNavigationDiscardedOffTarget({
                applying,
                markExpiry: mark.expiry,
                markUrl: mark.url,
                markTargetReached: mark.targetReached,
                observedUrl,
                now,
            });
        },
        consume(tabId, observedUrl, observedStatus, now, applying = false) {
            const mark = marks.get(tabId);
            noteReachedTarget(mark, observedUrl);
            const echo = isAppliedNavigationEcho({
                applying,
                markExpiry: mark?.expiry,
                markUrl: mark?.url,
                observedUrl,
                observedStatus,
                now,
            });
            if (mark != null && isAppliedNavigationSettled({applying, markExpiry: mark.expiry, observedStatus, now})) {
                marks.delete(tabId);
            }
            return echo;
        },
        settle(tabId, observedUrl, observedStatus, now, applying = false) {
            const mark = marks.get(tabId);
            if (mark == null) {
                return false;
            }
            noteReachedTarget(mark, observedUrl);
            const {retireMark, landedOffTarget} = resolveAppliedNavigationSettlement({
                applying,
                markExpiry: mark.expiry,
                markUrl: mark.url,
                observedUrl,
                observedStatus,
                now,
            });
            if (retireMark) {
                marks.delete(tabId);
            }
            return landedOffTarget;
        },
        has(tabId) {
            return marks.has(tabId);
        },
    };
}

// --- in-apply: the synchronous suppression (isApplying) is preserved -----------------------
check('in-apply, no mark ⇒ ECHO (suppress)',
    isAppliedNavigationEcho({applying: true, markExpiry: undefined, now: NOW}) === true);
check('in-apply wins even with an expired mark ⇒ ECHO',
    isAppliedNavigationEcho({applying: true, markExpiry: NOW - 1, now: NOW}) === true);
check('in-apply is an echo regardless of url or status',
    isAppliedNavigationEcho({applying: true, markExpiry: NOW + SAFETY_MS, markUrl: 'http://x', observedUrl: 'http://y', observedStatus: COMPLETE, now: NOW}) === true);
check('in-apply nothing SETTLES and nothing LANDS, whatever the status or the bound',
    [NOW - 10_000, NOW, NOW + SAFETY_MS].every(markExpiry =>
        [COMPLETE, LOADING, undefined, 'unloaded'].every(status =>
            isAppliedNavigationSettled({applying: true, markExpiry, observedStatus: status, now: NOW}) === false
            && isAppliedNavigationLandedOffTarget({applying: true, markExpiry, markUrl: 'http://x', observedUrl: 'http://y', observedStatus: status, now: NOW}) === false)));
check('in-apply the settlement resolver retires nothing',
    [NOW - 10_000, NOW, NOW + SAFETY_MS].every(markExpiry =>
        [COMPLETE, LOADING, undefined, 'unloaded'].every(status => {
            const settlement = resolveAppliedNavigationSettlement({applying: true, markExpiry, markUrl: 'http://x', observedUrl: 'http://y', observedStatus: status, now: NOW});
            return settlement.retireMark === false && settlement.landedOffTarget === false;
        })));
check('the settlement resolver always pairs the retirement with the verdict it produced',
    [true, false].flatMap(applying =>
        [NOW - 10_000, NOW, NOW + SAFETY_MS, undefined].flatMap(markExpiry =>
            [COMPLETE, LOADING, undefined, 'unloaded'].flatMap(status =>
                ['http://x', 'http://y', undefined].map(observedUrl =>
                    ({applying, markExpiry, markUrl: 'http://x', observedUrl, observedStatus: status, now: NOW})))))
        .every(observation => {
            const settlement = resolveAppliedNavigationSettlement(observation);
            return settlement.retireMark === isAppliedNavigationSettled(observation)
                && settlement.landedOffTarget === isAppliedNavigationLandedOffTarget(observation)
                && (settlement.landedOffTarget === false || settlement.retireMark === true);
        }));

// --- in-flight: anything before completion is part of OUR navigation -----------------------
check('in-flight, loading at the applied url ⇒ ECHO',
    isAppliedNavigationEcho({applying: false, markExpiry: NOW + SAFETY_MS, markUrl: 'http://x', observedUrl: 'http://x', observedStatus: LOADING, now: NOW}) === true);
check('in-flight, loading at an INTERMEDIATE redirect url ⇒ ECHO (not a user edit)',
    isAppliedNavigationEcho({applying: false, markExpiry: NOW + SAFETY_MS, markUrl: 'http://x', observedUrl: 'http://redirect', observedStatus: LOADING, now: NOW}) === true);
check('in-flight, title settle with no status ⇒ ECHO',
    isAppliedNavigationEcho({applying: false, markExpiry: NOW + SAFETY_MS, markUrl: 'http://x', observedUrl: 'http://x', now: NOW}) === true);
check('in-flight far past the OLD 4s wall clock, still before the bound ⇒ ECHO',
    isAppliedNavigationEcho({applying: false, markExpiry: NOW + SAFETY_MS - 4_000, markUrl: 'http://x', observedUrl: 'http://x', observedStatus: LOADING, now: NOW}) === true);

// --- completion arriving BEFORE the bound --------------------------------------------------
check('completion at the applied url ⇒ ECHO (our own write)',
    isAppliedNavigationEcho({applying: false, markExpiry: NOW + SAFETY_MS, markUrl: 'http://x', observedUrl: 'http://x', observedStatus: COMPLETE, now: NOW}) === true);
check('completion at a DIFFERENT url ⇒ CAPTURE (cloud converges to the redirect target)',
    isAppliedNavigationEcho({applying: false, markExpiry: NOW + SAFETY_MS, markUrl: 'http://x', observedUrl: 'http://y', observedStatus: COMPLETE, now: NOW}) === false);
check('completion with a url-less mark ⇒ CAPTURE (no applied target to attribute it to)',
    isAppliedNavigationEcho({applying: false, markExpiry: NOW + SAFETY_MS, observedUrl: 'http://y', observedStatus: COMPLETE, now: NOW}) === false);
check('loading with a url-less mark ⇒ CAPTURE (a target-less mark never blinds the tab)',
    isAppliedNavigationEcho({applying: false, markExpiry: NOW + SAFETY_MS, observedUrl: 'http://y', observedStatus: LOADING, now: NOW}) === false);
check('a url-less mark cannot blind the tab for the whole safety bound',
    isAppliedNavigationEcho({applying: false, markExpiry: NOW + SAFETY_MS, observedUrl: 'http://y', now: NOW}) === false);
check('completion RETIRES the mark before the bound',
    isAppliedNavigationSettled({markExpiry: NOW + SAFETY_MS, observedStatus: COMPLETE, now: NOW}) === true);
check('a loading event does NOT retire the mark',
    isAppliedNavigationSettled({markExpiry: NOW + SAFETY_MS, observedStatus: LOADING, now: NOW}) === false);

// --- the BOUND expiring first (navigation that never completes) ----------------------------
check('bound expired, loading ⇒ CAPTURE (a stuck nav cannot suppress forever)',
    isAppliedNavigationEcho({applying: false, markExpiry: NOW, markUrl: 'http://x', observedUrl: 'http://x', observedStatus: LOADING, now: NOW}) === false);
check('bound long expired ⇒ CAPTURE',
    isAppliedNavigationEcho({applying: false, markExpiry: NOW - 10_000, markUrl: 'http://x', observedUrl: 'http://x', observedStatus: COMPLETE, now: NOW}) === false);
check('bound expiry alone does NOT retire the mark while the tab is still loading',
    isAppliedNavigationSettled({markExpiry: NOW, observedStatus: LOADING, now: NOW}) === false);
check('past the bound a COMPLETED event retires the mark',
    isAppliedNavigationSettled({markExpiry: NOW, observedStatus: COMPLETE, now: NOW}) === true);
check('past the bound a status-less event retires the mark (not in flight)',
    isAppliedNavigationSettled({markExpiry: NOW, observedStatus: undefined, now: NOW}) === true);
check('past the bound an unrecognised status retires the mark',
    isAppliedNavigationSettled({markExpiry: NOW, observedStatus: 'unloaded', now: NOW}) === true);
// `isAppliedNavigationLandedOffTarget` is `settled && urlsDiffer` by construction, so asserting
// that the two merely AGREE is an identity that holds for any `isAppliedNavigationSettled` — the
// pre-81f7a6f one included. What has to be pinned is the value each of them takes per status.
const RETIREMENT_TABLE_PAST_THE_BOUND = [
    [COMPLETE, true],
    [LOADING, false],
    [undefined, true],
    ['unloaded', true],
];
const RETIREMENT_TABLE_BEFORE_THE_BOUND = [
    [COMPLETE, true],
    [LOADING, false],
    [undefined, false],
    ['unloaded', false],
];
check('retirement and the landing verdict take the EXPECTED value on every status past the bound',
    RETIREMENT_TABLE_PAST_THE_BOUND.every(([status, settled]) =>
        isAppliedNavigationSettled({applying: false, markExpiry: NOW, observedStatus: status, now: NOW}) === settled
        && isAppliedNavigationLandedOffTarget({applying: false, markExpiry: NOW, markUrl: 'http://x', observedUrl: 'http://y', observedStatus: status, now: NOW}) === settled));
check('retirement and the landing verdict take the EXPECTED value on every status before the bound',
    RETIREMENT_TABLE_BEFORE_THE_BOUND.every(([status, settled]) =>
        isAppliedNavigationSettled({applying: false, markExpiry: NOW + SAFETY_MS, observedStatus: status, now: NOW}) === settled
        && isAppliedNavigationLandedOffTarget({applying: false, markExpiry: NOW + SAFETY_MS, markUrl: 'http://x', observedUrl: 'http://y', observedStatus: status, now: NOW}) === settled));
check('no mark, not applying ⇒ CAPTURE (genuine user navigation)',
    isAppliedNavigationEcho({applying: false, markExpiry: undefined, observedStatus: COMPLETE, now: NOW}) === false);
check('markExpiry = NaN is treated as no mark ⇒ CAPTURE',
    isAppliedNavigationEcho({applying: false, markExpiry: NaN, now: NOW}) === false);
check('markExpiry = null is treated as no mark ⇒ CAPTURE',
    isAppliedNavigationEcho({applying: false, markExpiry: null, now: NOW}) === false);

// --- scenario: a slow load that settles LONG after the old 4s window ------------------------
{
    const store = createMarkStore();
    store.mark(1, 'http://x', NOW);
    check('slow load: loading at +9s ⇒ suppressed',
        store.consume(1, 'http://x', LOADING, NOW + 9_000) === true);
    check('slow load: title settle at +18s ⇒ suppressed',
        store.consume(1, 'http://x', LOADING, NOW + 18_000) === true);
    check('slow load: completion at +25s ⇒ suppressed',
        store.consume(1, 'http://x', COMPLETE, NOW + 25_000) === true);
    check('slow load: mark retired by completion',
        store.has(1) === false);
    check('slow load: a later USER navigation is captured',
        store.consume(1, 'http://user', COMPLETE, NOW + 26_000) === false);
}

// --- scenario: the BOUND expires first ------------------------------------------------------
{
    const store = createMarkStore();
    store.mark(2, 'http://x', NOW);
    check('stuck nav: still suppressed just before the bound',
        store.consume(2, 'http://x', LOADING, NOW + SAFETY_MS - 1) === true);
    check('stuck nav: captured once the bound passes',
        store.consume(2, 'http://x', LOADING, NOW + SAFETY_MS) === false);
    check('stuck nav: the bound stops the suppression but the still-loading tab KEEPS the mark',
        store.has(2) === true);
    check('stuck nav: the eventual completion retires it',
        store.consume(2, 'http://x', COMPLETE, NOW + SAFETY_MS + 1_000) === false);
    check('stuck nav: mark retired once the tab stopped loading',
        store.has(2) === false);
}

// --- scenario: a redirect resolves to a DIFFERENT url ---------------------------------------
{
    const store = createMarkStore();
    store.mark(3, 'http://x', NOW);
    check('redirect: intermediate hop suppressed',
        store.consume(3, 'http://hop', LOADING, NOW + 200) === true);
    check('redirect: completion at y captured so the cloud converges',
        store.consume(3, 'http://y', COMPLETE, NOW + 700) === false);
    check('redirect: mark retired by completion',
        store.has(3) === false);
}

// --- scenario: a SUPERSEDING navigation -----------------------------------------------------
{
    const store = createMarkStore();
    store.mark(4, 'http://first', NOW);
    store.mark(4, 'http://second', NOW + 500);
    check('supersede: a late event from the ABANDONED first nav is suppressed',
        store.consume(4, 'http://first', LOADING, NOW + 600) === true);
    check('supersede: completion at the SECOND applied url ⇒ suppressed',
        store.consume(4, 'http://second', COMPLETE, NOW + 900) === true);
    check('supersede: mark retired by completion',
        store.has(4) === false);
    check('supersede: the bound is measured from the SECOND navigation',
        isAppliedNavigationSettled({markExpiry: NOW + 500 + SAFETY_MS, observedStatus: LOADING, now: NOW + SAFETY_MS + 1}) === false);
}

// --- scenario: the tab is REMOVED mid-flight ------------------------------------------------
{
    const store = createMarkStore();
    store.mark(5, 'http://x', NOW);
    check('removal: mark exists while the nav is in flight',
        store.has(5) === true);
    store.clear(5);
    check('removal: mark dropped, no state left behind',
        store.has(5) === false);
    check('removal: a recycled tab id is treated as a genuine user navigation',
        store.consume(5, 'http://other', COMPLETE, NOW + 1_000) === false);
}

// --- scenario: the completing event carries ONLY `status` (title and url unchanged) --------
// tabs.js drives capture off title/url changes, so the completing event of an applied
// navigation reaches the capture path through the SETTLE decision instead. Landing on the
// applied target asks for nothing; landing anywhere else asks for a capture.
{
    const store = createMarkStore();
    store.mark(6, 'http://x', NOW);
    check('status-only completion at the applied target ⇒ no capture asked for',
        store.settle(6, 'http://x', COMPLETE, NOW + 3_000) === false);
    check('status-only completion retires the mark',
        store.has(6) === false);
}

// --- scenario: a USER navigation typed while the applied load is still in flight ------------
{
    const store = createMarkStore();
    store.mark(7, 'http://applied', NOW);
    check('user nav: the in-flight url event is suppressed (indistinguishable from a redirect)',
        store.consume(7, 'http://user', LOADING, NOW + 800) === true);
    check('user nav: the status-only completion asks for a CAPTURE (landed off target)',
        store.settle(7, 'http://user', COMPLETE, NOW + 2_500) === true);
    check('user nav: the mark is retired by that completion',
        store.has(7) === false);
    check('user nav: nothing suppresses the tab afterwards',
        store.consume(7, 'http://user2', COMPLETE, NOW + 3_000) === false);
}

// --- scenario: an applied load that NEVER completes ------------------------------------------
{
    const store = createMarkStore();
    store.mark(8, 'http://stuck', NOW);
    check('stuck load: settle asks for nothing while the bound is live',
        store.settle(8, 'http://stuck', LOADING, NOW + 10_000) === false);
    check('stuck load: the mark survives a non-completing event',
        store.has(8) === true);
    check('stuck load: past the bound a url off the applied target, STILL LOADING, is not a landing',
        store.settle(8, 'http://elsewhere', LOADING, NOW + SAFETY_MS) === false);
    check('stuck load: a tab still in flight does not spend its mark',
        store.has(8) === true);
    check('stuck load: the completion that follows reports the real landing',
        store.settle(8, 'http://elsewhere', COMPLETE, NOW + SAFETY_MS + 1_000) === true);
    check('stuck load: that landing retires the mark',
        store.has(8) === false);
    check('stuck load: the ordinary content path is free again',
        store.consume(8, 'http://elsewhere', COMPLETE, NOW + SAFETY_MS + 2_000) === false);
}
{
    const store = createMarkStore();
    store.mark(82, 'http://stuck', NOW);
    check('stuck load: past the bound a COMPLETED url off the applied target is CAPTURED',
        store.settle(82, 'http://elsewhere', COMPLETE, NOW + SAFETY_MS) === true);
    check('stuck load: that completion retires the mark',
        store.has(82) === false);
}
{
    const store = createMarkStore();
    store.mark(81, 'http://stuck', NOW);
    check('stuck load: past the bound, still ON the applied target ⇒ nothing to push',
        store.settle(81, 'http://stuck', LOADING, NOW + SAFETY_MS) === false);
    check('stuck load: still loading on the target keeps the mark too',
        store.has(81) === true);
    check('stuck load: completing on the applied target asks for nothing',
        store.settle(81, 'http://stuck', COMPLETE, NOW + SAFETY_MS + 1_000) === false);
    check('stuck load: and retires the mark',
        store.has(81) === false);
}

// --- regression: the mark must NOT latch onto a pre-navigation url --------------------------
// The old store kept the FIRST url it ever saw, so an incidental onUpdated arming the mark
// with the pre-navigation url defeated suppression for the very navigation it covered.
{
    const store = createMarkStore();
    store.mark(9, 'http://before', NOW);
    store.mark(9, 'http://applied', NOW + 10);
    check('latch regression: the applied url replaces the pre-navigation url',
        store.consume(9, 'http://applied', COMPLETE, NOW + 1_200) === true);
    check('latch regression: the mark is retired by that completion',
        store.has(9) === false);
}

// --- the LANDED-OFF-TARGET decision --------------------------------------------------------
// Retiring a mark and reporting a landing elsewhere are two different questions. The echo
// predicate answers "may this event be suppressed"; its negation is NOT "the tab landed off
// the applied target", because a mark past its bound can no longer attribute a still-loading
// state to us. What survives the bound is the recorded target url: comparing it with the
// observed url is evidence in its own right, whether or not the mark is still live.
check('live mark, completion at a DIFFERENT url ⇒ LANDED OFF TARGET (the 3c837c1 property)',
    isAppliedNavigationLandedOffTarget({applying: false, markExpiry: NOW + SAFETY_MS, markUrl: 'http://x', observedUrl: 'http://y', observedStatus: COMPLETE, now: NOW}) === true);
check('live mark, completion at the applied url ⇒ silent',
    isAppliedNavigationLandedOffTarget({applying: false, markExpiry: NOW + SAFETY_MS, markUrl: 'http://x', observedUrl: 'http://x', observedStatus: COMPLETE, now: NOW}) === false);
check('live mark, still loading elsewhere ⇒ silent (the landing has not happened yet)',
    isAppliedNavigationLandedOffTarget({applying: false, markExpiry: NOW + SAFETY_MS, markUrl: 'http://x', observedUrl: 'http://hop', observedStatus: LOADING, now: NOW}) === false);
check('live mark, status-less event elsewhere ⇒ silent (only the completion ends the wait)',
    isAppliedNavigationLandedOffTarget({applying: false, markExpiry: NOW + SAFETY_MS, markUrl: 'http://x', observedUrl: 'http://hop', now: NOW}) === false);
check('live mark, unknown status elsewhere ⇒ silent',
    isAppliedNavigationLandedOffTarget({applying: false, markExpiry: NOW + SAFETY_MS, markUrl: 'http://x', observedUrl: 'http://hop', observedStatus: 'unloaded', now: NOW}) === false);
check('EXPIRED mark at a DIFFERENT url ⇒ LANDED OFF TARGET (the url is still evidence)',
    isAppliedNavigationLandedOffTarget({applying: false, markExpiry: NOW, markUrl: 'http://x', observedUrl: 'http://y', observedStatus: COMPLETE, now: NOW}) === true);
check('EXPIRED mark, STILL LOADING at a different url ⇒ silent (a hop in flight is not a landing)',
    isAppliedNavigationLandedOffTarget({applying: false, markExpiry: NOW, markUrl: 'http://x', observedUrl: 'http://y', observedStatus: LOADING, now: NOW}) === false);
check('EXPIRED mark, no status at a DIFFERENT url ⇒ LANDED OFF TARGET (only `loading` buys silence)',
    isAppliedNavigationLandedOffTarget({applying: false, markExpiry: NOW, markUrl: 'http://x', observedUrl: 'http://y', now: NOW}) === true);
check('EXPIRED mark, UNKNOWN status at a different url ⇒ LANDED OFF TARGET',
    isAppliedNavigationLandedOffTarget({applying: false, markExpiry: NOW, markUrl: 'http://x', observedUrl: 'http://y', observedStatus: 'unloaded', now: NOW}) === true);
check('EXPIRED mark at the applied url ⇒ silent (nothing happened worth pushing)',
    isAppliedNavigationLandedOffTarget({applying: false, markExpiry: NOW, markUrl: 'http://x', observedUrl: 'http://x', observedStatus: COMPLETE, now: NOW}) === false);
check('EXPIRED mark, status-less event at the applied url ⇒ silent',
    isAppliedNavigationLandedOffTarget({applying: false, markExpiry: NOW - 10_000, markUrl: 'http://x', observedUrl: 'http://x', now: NOW}) === false);
check('EXPIRED mark, no observed url (an `audible`-only event) ⇒ silent',
    isAppliedNavigationLandedOffTarget({applying: false, markExpiry: NOW - 10_000, markUrl: 'http://x', observedUrl: undefined, now: NOW}) === false);
check('EXPIRED mark with NO recorded target url ⇒ silent (nothing to compare against)',
    isAppliedNavigationLandedOffTarget({applying: false, markExpiry: NOW - 10_000, observedUrl: 'http://y', observedStatus: COMPLETE, now: NOW}) === false);
check('an EXPIRED mark still yields no SUPPRESSION, whichever way the landing went',
    isAppliedNavigationEcho({applying: false, markExpiry: NOW - 1, markUrl: 'http://x', observedUrl: 'http://y', observedStatus: COMPLETE, now: NOW}) === false
    && isAppliedNavigationEcho({applying: false, markExpiry: NOW - 1, markUrl: 'http://x', observedUrl: 'http://x', observedStatus: COMPLETE, now: NOW}) === false);
check('no mark at all ⇒ silent',
    isAppliedNavigationLandedOffTarget({applying: false, markExpiry: undefined, observedUrl: 'http://y', observedStatus: COMPLETE, now: NOW}) === false);
check('NO MARK but both urls present ⇒ silent (a landing needs a navigation we applied)',
    isAppliedNavigationLandedOffTarget({applying: false, markExpiry: undefined, markUrl: 'http://x', observedUrl: 'http://y', observedStatus: COMPLETE, now: NOW}) === false);
check('no mark, both urls, still loading ⇒ silent',
    isAppliedNavigationLandedOffTarget({applying: false, markExpiry: undefined, markUrl: 'http://x', observedUrl: 'http://y', observedStatus: LOADING, now: NOW}) === false);
check('no mark, both urls, no status ⇒ silent',
    isAppliedNavigationLandedOffTarget({applying: false, markUrl: 'http://x', observedUrl: 'http://y', now: NOW}) === false);
check('markExpiry = NaN is no mark ⇒ silent even with both urls',
    isAppliedNavigationLandedOffTarget({applying: false, markExpiry: NaN, markUrl: 'http://x', observedUrl: 'http://y', observedStatus: COMPLETE, now: NOW}) === false);
check('markExpiry = null is no mark ⇒ silent even with both urls',
    isAppliedNavigationLandedOffTarget({applying: false, markExpiry: null, markUrl: 'http://x', observedUrl: 'http://y', observedStatus: COMPLETE, now: NOW}) === false);
check('in-apply ⇒ silent (our own write, never a user landing)',
    isAppliedNavigationLandedOffTarget({applying: true, markExpiry: NOW + SAFETY_MS, markUrl: 'http://x', observedUrl: 'http://y', observedStatus: COMPLETE, now: NOW}) === false);

// --- scenario: an UNRELATED event on a tab whose mark expired long ago ----------------------
// `audible` / `favIconUrl` / a bare `status` carry no url or title, so tabs.js only reaches the
// capture path through the settle decision. A forgotten mark must not turn one into a push:
// the tab is still sitting on the applied target, so there is nothing to report.
{
    const store = createMarkStore();
    store.mark(10, 'http://stuck', NOW);
    check('forgotten mark: an unrelated event past the bound asks for nothing',
        store.settle(10, 'http://stuck', COMPLETE, NOW + SAFETY_MS + 300_000) === false);
    check('forgotten mark: that event retires the mark',
        store.has(10) === false);
    check('forgotten mark: a real user navigation afterwards is still captured',
        store.consume(10, 'http://user', COMPLETE, NOW + SAFETY_MS + 300_001) === false);
}

// --- scenario: a redirect whose load completes PAST the safety bound -------------------------
// The site redirects, the hop is suppressed as part of our navigation and keeps the mark, and
// the completion only arrives after the bound. That completing event carries nothing but
// `status`, so the settle decision is the only chance to record where the tab really landed.
// Losing it means the next diff resolves the tab back to the applied target and navigates the
// user away from the page they are looking at.
{
    const store = createMarkStore();
    store.mark(11, 'http://target', NOW);
    check('slow redirect: the hop at +5s is suppressed',
        store.consume(11, 'http://redirect', LOADING, NOW + 5_000) === true);
    check('slow redirect: the mark survives the hop',
        store.has(11) === true);
    check('slow redirect: the status-only completion past the bound is CAPTURED at the real url',
        store.settle(11, 'http://redirect', COMPLETE, NOW + SAFETY_MS + 5_000) === true);
    check('slow redirect: that completion retires the mark',
        store.has(11) === false);
    check('slow redirect: nothing suppresses the tab afterwards',
        store.consume(11, 'http://redirect', COMPLETE, NOW + SAFETY_MS + 6_000) === false);
}

// --- scenario: the same redirect, but the load is STILL RUNNING past the bound ---------------
// The hop url sits in the cache, so an unrelated event (`favIconUrl`, `audible`) past the bound
// reaches the settle decision with the hop url and `status: 'loading'`. The hop is not where the
// tab landed — reporting it would push a mid-flight url and navigate every peer to it. But that
// event must NOT spend the mark either: the tab is still in flight, and the only report of where
// it finally lands is the settle decision on the event that ends the flight.
{
    const store = createMarkStore();
    store.mark(12, 'http://target', NOW);
    check('unfinished redirect: the hop at +5s is suppressed',
        store.consume(12, 'http://redirect', LOADING, NOW + 5_000) === true);
    check('unfinished redirect: an unrelated event past the bound, still loading, asks for nothing',
        store.settle(12, 'http://redirect', LOADING, NOW + SAFETY_MS + 5_000) === false);
    check('unfinished redirect: a tab still in flight keeps its mark',
        store.has(12) === true);
    check('unfinished redirect: repeated in-flight events never spend it',
        store.settle(12, 'http://redirect', LOADING, NOW + SAFETY_MS + 6_000) === false
        && store.consume(12, 'http://redirect', LOADING, NOW + SAFETY_MS + 7_000) === false
        && store.has(12) === true);
    check('unfinished redirect: the completion at a DIFFERING url is reported as the landing',
        store.settle(12, 'http://final', COMPLETE, NOW + SAFETY_MS + 9_000) === true);
    check('unfinished redirect: that landing retires the mark',
        store.has(12) === false);
}

// --- scenario: the load completes at the SAME url the hop left in the cache -------------------
// The redirect target IS where the tab lands, so the completing event changes nothing but
// `status`. The ordinary content path sees no url or title change and never runs; the settle
// decision is the ONLY thing that can put `http://redirect` into the log. Spending the mark on
// the earlier still-loading event loses that url for good and the next diff navigates the tab
// back to `http://target`.
{
    const store = createMarkStore();
    store.mark(13, 'http://target', NOW);
    check('equal-url landing: the hop at +5s is suppressed',
        store.consume(13, 'http://redirect', LOADING, NOW + 5_000) === true);
    check('equal-url landing: the still-loading event past the bound asks for nothing',
        store.settle(13, 'http://redirect', LOADING, NOW + SAFETY_MS + 5_000) === false);
    check('equal-url landing: it keeps the mark',
        store.has(13) === true);
    check('equal-url landing: the completion at the SAME hop url is still reported',
        store.settle(13, 'http://redirect', COMPLETE, NOW + SAFETY_MS + 9_000) === true);
    check('equal-url landing: the mark is retired by it',
        store.has(13) === false);
    check('equal-url landing: nothing suppresses the tab afterwards',
        store.consume(13, 'http://redirect', COMPLETE, NOW + SAFETY_MS + 10_000) === false);
}

// --- scenario: the tab is DISCARDED or REMOVED while still in flight past the bound ------------
// A mark now outlives the bound whenever the tab keeps reporting `loading`, so what bounds its
// lifetime is the tab: tabs.js settles-and-drops it on `changeInfo.discarded === true` and
// onRemoved drops it unconditionally. Neither leaves an entry behind for a recycled tab id to
// inherit. That holds wherever the tab is: a mark still loading at a url OFF the applied target
// survives the bound just as one sitting on it does, and the discard drops it either way — only
// the verdict differs, because a navigation never seen at its target has nothing to report.
{
    const store = createMarkStore();
    store.mark(16, 'http://target', NOW);
    check('in-flight discard: a mark still loading at a DIFFERENT url survives the bound',
        store.settle(16, 'http://redirect', LOADING, NOW + SAFETY_MS + 1_000) === false
        && store.has(16) === true);
    check('in-flight discard: it reports nothing, the applied target was never reached',
        store.discard(16, 'http://redirect', NOW + SAFETY_MS + 1_500) === false);
    check('in-flight discard: the discard drops it all the same',
        store.has(16) === false);
}
// The tab below was seen at the applied target, so the applied navigation did reach it and the
// url the tab holds at the discard is evidence.
{
    const store = createMarkStore();
    store.mark(14, 'http://target', NOW);
    check('in-flight discard: the mark is alive past the bound',
        store.settle(14, 'http://target', LOADING, NOW + SAFETY_MS + 1_000) === false
        && store.has(14) === true);
    check('in-flight discard: the discard reports the url the tab holds',
        store.discard(14, 'http://redirect', NOW + SAFETY_MS + 1_500) === true);
    check('in-flight discard: the discard drops it',
        store.has(14) === false);
    check('in-flight discard: a later completion reports no landing',
        store.settle(14, 'http://redirect', COMPLETE, NOW + SAFETY_MS + 2_000) === false);
    check('in-flight discard: and suppresses nothing',
        store.consume(14, 'http://redirect', COMPLETE, NOW + SAFETY_MS + 3_000) === false);
}
{
    const store = createMarkStore();
    store.mark(15, 'http://target', NOW);
    check('in-flight removal: the mark is alive past the bound',
        store.settle(15, 'http://redirect', LOADING, NOW + SAFETY_MS + 1_000) === false
        && store.has(15) === true);
    store.clear(15);
    check('in-flight removal: onRemoved drops it',
        store.has(15) === false);
    check('in-flight removal: a recycled tab id starts clean',
        store.consume(15, 'http://other', COMPLETE, NOW + SAFETY_MS + 2_000) === false
        && store.settle(15, 'http://other', COMPLETE, NOW + SAFETY_MS + 2_000) === false);
}

// --- scenario: the completion arrives while a sync APPLY PASS is in flight --------------------
// `applyDepth` is held for the whole apply pass and tabs.js `onUpdated` is not gated on it, so an
// event from a tab the apply never touched lands inside the window. The verdict cannot be given
// there — during an apply nothing is attributable — so the mark must survive to be decided by the
// next event outside the pass. Spending it here is the `81f7a6f` loss all over again: the hop url
// sits in the cache, the completing event carries only `status`, and nothing else can report it.
{
    const store = createMarkStore();
    store.mark(40, 'http://target', NOW);
    check('apply-pass settle: the hop is suppressed as part of the applied navigation',
        store.consume(40, 'http://redirect', LOADING, NOW + 5_000) === true);
    check('apply-pass settle: the completion inside the pass asks for nothing',
        store.settle(40, 'http://redirect', COMPLETE, NOW + 6_000, true) === false);
    check('apply-pass settle: and does NOT spend the mark',
        store.has(40) === true);
    check('apply-pass settle: the first event after the pass reports the landing',
        store.settle(40, 'http://redirect', COMPLETE, NOW + 7_000) === true);
    check('apply-pass settle: that landing retires the mark',
        store.has(40) === false);
}
{
    const store = createMarkStore();
    store.mark(41, 'http://target', NOW);
    check('apply-pass loading: a loading event inside the pass asks for nothing',
        store.settle(41, 'http://hop', LOADING, NOW + 1_000, true) === false);
    check('apply-pass loading: and keeps the mark',
        store.has(41) === true);
    check('apply-pass loading: a loading event past the bound inside the pass keeps it too',
        store.settle(41, 'http://hop', LOADING, NOW + SAFETY_MS, true) === false
        && store.has(41) === true);
    check('apply-pass loading: the completion after the pass reports the landing',
        store.settle(41, 'http://hop', COMPLETE, NOW + SAFETY_MS + 1_000) === true);
    check('apply-pass loading: that landing retires the mark',
        store.has(41) === false);
}
{
    const store = createMarkStore();
    store.mark(42, 'http://target', NOW);
    check('apply-pass echo path: an event inside the pass is suppressed',
        store.consume(42, 'http://redirect', COMPLETE, NOW + 800, true) === true);
    check('apply-pass echo path: and does not spend the mark either',
        store.has(42) === true);
    check('apply-pass echo path: the completion after the pass still converges the cloud',
        store.consume(42, 'http://redirect', COMPLETE, NOW + 1_600) === false);
    check('apply-pass echo path: which retires the mark',
        store.has(42) === false);
}

// --- scenario: a discard that CANCELLED the applied load, before it ever committed -------------
// `browser.tabs.update` resolves when the load STARTS. A group switch with
// `discardTabsAfterHide`, or Firefox unloading the tab on its own, can end that load before it
// commits: the tab is left on the url the apply was navigating away from, with `changeInfo`
// carrying nothing but `discarded`. Reading that as a landing pushes the pre-apply url and
// reverts, on every peer, the change this device had just applied — and on the pending-nav-wake
// path the deferred target is already cleared, so nothing is left to retry and the peer's change
// is lost for good.
{
    const store = createMarkStore();
    store.mark(50, 'http://target', NOW);
    check('cancelled load: the discard of a load that never committed is no landing',
        store.discard(50, 'http://before-apply', NOW + 1_000) === false);
    check('cancelled load: the discard still bounds the mark',
        store.has(50) === false);
}
{
    const store = createMarkStore();
    store.mark(51, 'http://target', NOW);
    check('cancelled load: not even the hop of a redirect that never reached the target counts',
        store.consume(51, 'http://hop', LOADING, NOW + 500) === true
        && store.discard(51, 'http://hop', NOW + 800) === false);
}
{
    const store = createMarkStore();
    store.mark(52, 'http://target', NOW);
    check('cancelled load: past the bound a navigation that never committed is still no landing',
        store.discard(52, 'http://before-apply', NOW + SAFETY_MS + 1_000) === false);
}

// --- scenario: a discard AFTER the applied navigation reached its target -----------------------
// This is the window 59f339b closed and it must stay closed. Once the tab has been seen at the
// applied target, the mark can only survive because the settlement was deferred — by an apply
// pass, or by a completion that carried nothing the cache had not already recorded. Whatever url
// the tab holds when it discards is then the url it sits on and the one it restores to on wake,
// so a user navigation made under the surviving mark is not swallowed.
{
    const store = createMarkStore();
    store.mark(53, 'http://target', NOW);
    check('reached target: the completion inside the apply pass spends nothing',
        store.settle(53, 'http://target', COMPLETE, NOW + 1_000, true) === false
        && store.has(53) === true);
    check('reached target: the user navigation under the surviving mark is suppressed',
        store.consume(53, 'http://user', LOADING, NOW + 2_000) === true);
    check('reached target: the discard names the url the user is on',
        store.discard(53, 'http://user', NOW + 3_000) === true);
    check('reached target: and spends the mark',
        store.has(53) === false);
}
{
    const store = createMarkStore();
    store.mark(54, 'http://target', NOW);
    check('reached target: a tab discarded where the apply put it asks for no capture',
        store.settle(54, 'http://target', COMPLETE, NOW + 1_000, true) === false
        && store.discard(54, 'http://target', NOW + 2_000) === false);
}
{
    const store = createMarkStore();
    store.mark(55, 'http://target', NOW);
    check('reached target: a discard INSIDE an apply pass still attributes nothing',
        store.settle(55, 'http://target', COMPLETE, NOW + 1_000, true) === false
        && store.discard(55, 'http://user', NOW + 2_000, true) === false);
    check('reached target: and the discard dropped the mark anyway',
        store.has(55) === false);
}
{
    const store = createMarkStore();
    check('discard: with no mark at all there is nothing to have landed off',
        store.discard(56, 'http://user', NOW) === false);
}

// --- every prior round, re-run through the mark store now that retirement moved ----------------
// Each round fixed a real defect; none of them may be traded for the deferral fix.
{
    const store = createMarkStore();
    store.mark(30, 'http://target', NOW);
    check('round 3c837c1: a user navigation landing during an applied load is reported',
        store.consume(30, 'http://user', LOADING, NOW + 800) === true
        && store.settle(30, 'http://user', COMPLETE, NOW + 2_500) === true
        && store.has(30) === false);
}
{
    const store = createMarkStore();
    store.mark(31, 'http://target', NOW);
    check('round fix/expired-nav-mark: an expired mark alone neither suppresses nor reports',
        store.settle(31, 'http://target', COMPLETE, NOW + SAFETY_MS) === false
        && store.consume(31, 'http://user', COMPLETE, NOW + SAFETY_MS + 1) === false);
    // A target-less mark is not a state the store can hold: `markAppliedNavigation` early-returns
    // without a url, so the scenario "a target-less mark reports nothing past the bound" is
    // unreachable. The predicate's totality on a target-less observation is covered directly by
    // `EXPIRED mark with NO recorded target url ⇒ silent` below.
    const urlless = createMarkStore();
    urlless.mark(32, undefined, NOW);
    urlless.mark(undefined, 'http://target', NOW);
    check('round fix/expired-nav-mark: the store never records a mark without an applied target',
        urlless.has(32) === false && urlless.has(undefined) === false);
}
{
    const store = createMarkStore();
    store.mark(33, 'http://target', NOW);
    check('round 012eb8f: past the bound the observed url off the target is still evidence',
        store.settle(33, 'http://elsewhere', COMPLETE, NOW + SAFETY_MS) === true);
}
{
    const store = createMarkStore();
    store.mark(34, 'http://target', NOW);
    check('round 963eb33: past the bound a STILL LOADING url off the target is not a landing',
        store.settle(34, 'http://hop', LOADING, NOW + SAFETY_MS) === false);
    check('round 963eb33: and the tab kept in flight keeps its only chance to report',
        store.has(34) === true);
}
{
    const store = createMarkStore();
    check('round a211c81: with no mark at all nothing ever landed off a target',
        store.settle(35, 'http://elsewhere', COMPLETE, NOW) === false);
}
{
    const store = createMarkStore();
    store.mark(36, 'http://target', NOW);
    check('round 81f7a6f: a mark is never spent while the tab is in flight',
        store.settle(36, 'http://hop', LOADING, NOW + SAFETY_MS + 1_000) === false
        && store.has(36) === true
        && store.settle(36, 'http://hop', COMPLETE, NOW + SAFETY_MS + 2_000) === true
        && store.has(36) === false);
}
{
    const store = createMarkStore();
    store.mark(37, 'http://target', NOW);
    check('round dd0f724: a discard during an apply pass enters `applying` at the one place too',
        store.settle(37, 'http://target', COMPLETE, NOW + 1_000, true) === false
        && store.discard(37, 'http://user', NOW + 2_000, true) === false);
}
{
    const store = createMarkStore();
    store.mark(38, 'http://target', NOW);
    check('round 59f339b: a discard after the applied navigation landed still reports the url',
        store.settle(38, 'http://target', COMPLETE, NOW + 1_000, true) === false
        && store.discard(38, 'http://user', NOW + 2_000) === true);
}
{
    const store = createMarkStore();
    store.mark(39, 'http://target', NOW);
    check('round fix/discard-cancelled-navigation: a discard that cancelled the load reports nothing',
        store.discard(39, 'http://before-apply', NOW + 1_000) === false);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
