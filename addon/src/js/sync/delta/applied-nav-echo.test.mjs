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
 */

import {
    isAppliedNavigationEcho,
    isAppliedNavigationLandedOffTarget,
    isAppliedNavigationSettled,
    NAVIGATION_COMPLETE_STATUS,
    NAVIGATION_LOADING_STATUS,
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
// (supersede / removal / settle) are exercised through the same predicates.
function createMarkStore() {
    const marks = new Map();
    return {
        mark(tabId, url, now) {
            marks.set(tabId, {expiry: now + SAFETY_MS, url});
        },
        clear(tabId) {
            marks.delete(tabId);
        },
        consume(tabId, observedUrl, observedStatus, now, applying = false) {
            const mark = marks.get(tabId);
            const echo = isAppliedNavigationEcho({
                applying,
                markExpiry: mark?.expiry,
                markUrl: mark?.url,
                observedUrl,
                observedStatus,
                now,
            });
            if (mark != null && isAppliedNavigationSettled({markExpiry: mark.expiry, observedStatus, now})) {
                marks.delete(tabId);
            }
            return echo;
        },
        settle(tabId, observedUrl, observedStatus, now, applying = false) {
            const mark = marks.get(tabId);
            if (mark == null) {
                return false;
            }
            if (!isAppliedNavigationSettled({markExpiry: mark.expiry, observedStatus, now})) {
                return false;
            }
            marks.delete(tabId);
            return isAppliedNavigationLandedOffTarget({
                applying,
                markExpiry: mark.expiry,
                markUrl: mark.url,
                observedUrl,
                observedStatus,
                now,
            });
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
check('bound expiry RETIRES the mark without any completion',
    isAppliedNavigationSettled({markExpiry: NOW, observedStatus: LOADING, now: NOW}) === true);
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
    check('stuck nav: mark retired by the bound',
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
    check('stuck load: the bound retires the mark',
        store.has(8) === false);
    check('stuck load: with the mark gone, the ordinary content path captures the real landing',
        store.consume(8, 'http://elsewhere', COMPLETE, NOW + SAFETY_MS + 1_000) === false);
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
    check('stuck load: the bound retires that mark too',
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
// tab landed — reporting it would push a mid-flight url and navigate every peer to it. Staying
// silent costs nothing: the url the tab really lands on is a url CHANGE, which the ordinary
// content path captures on its own.
{
    const store = createMarkStore();
    store.mark(12, 'http://target', NOW);
    check('unfinished redirect: the hop at +5s is suppressed',
        store.consume(12, 'http://redirect', LOADING, NOW + 5_000) === true);
    check('unfinished redirect: an unrelated event past the bound, still loading, asks for nothing',
        store.settle(12, 'http://redirect', LOADING, NOW + SAFETY_MS + 5_000) === false);
    check('unfinished redirect: that event still retires the mark',
        store.has(12) === false);
    check('unfinished redirect: the real landing url is captured through the content path',
        store.consume(12, 'http://final', COMPLETE, NOW + SAFETY_MS + 9_000) === false);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
