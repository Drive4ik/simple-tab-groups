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
 */

import {isAppliedNavigationEcho, isAppliedNavigationSettled, NAVIGATION_COMPLETE_STATUS} from './applied-nav-echo.js';

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
const LOADING = 'loading';
const COMPLETE = NAVIGATION_COMPLETE_STATUS;

// A faithful pure model of the mark store in delta-capture.js, so mark lifecycle scenarios
// (supersede / removal / settle) are exercised through the same two predicates.
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
check('completion with a url-less mark ⇒ ECHO (safe default)',
    isAppliedNavigationEcho({applying: false, markExpiry: NOW + SAFETY_MS, observedUrl: 'http://y', observedStatus: COMPLETE, now: NOW}) === true);
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

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
