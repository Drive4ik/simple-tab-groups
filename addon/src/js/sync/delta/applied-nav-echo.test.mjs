/**
 * Standalone node test for the PURE sync-applied navigation echo decision
 * (`applied-nav-echo.js`).
 *
 * Plain `node applied-nav-echo.test.mjs` (STG has no test runner). The module is pure (no
 * `browser.*` / cache), so it imports directly.
 *
 * Regression for the A6 url-capture churn: a url change applied to a LOADED tab by the
 * transport navigates via `browser.tabs.update`, whose `onUpdated` settle/redirect fires
 * ASYNCHRONOUSLY after `endApply()`. That echo must be SUPPRESSED, while a genuine USER
 * navigation made outside the apply's causal window must still SYNC.
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs).
 */

import {isAppliedNavigationEcho} from './applied-nav-echo.js';

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

// --- in-apply: the synchronous suppression (isApplying) is preserved -----------------------
check('in-apply, no mark ⇒ ECHO (suppress)',
    isAppliedNavigationEcho({applying: true, markExpiry: undefined, now: NOW}) === true);
check('in-apply wins even with an expired mark ⇒ ECHO',
    isAppliedNavigationEcho({applying: true, markExpiry: NOW - 1, now: NOW}) === true);

// --- async settle/redirect AFTER endApply: live mark ⇒ ECHO (the churn we fix) -------------
check('not applying, live mark (now < expiry) ⇒ ECHO (suppress redirect echo)',
    isAppliedNavigationEcho({applying: false, markExpiry: NOW + 4_000, now: NOW}) === true);
check('not applying, live mark at the very edge (now just below expiry) ⇒ ECHO',
    isAppliedNavigationEcho({applying: false, markExpiry: NOW + 1, now: NOW}) === true);

// --- genuine USER navigation: not applying, no/expired mark ⇒ NOT an echo (must sync) -------
check('not applying, no mark ⇒ USER nav (capture)',
    isAppliedNavigationEcho({applying: false, markExpiry: undefined, now: NOW}) === false);
check('not applying, mark expired exactly (now === expiry) ⇒ USER nav (capture)',
    isAppliedNavigationEcho({applying: false, markExpiry: NOW, now: NOW}) === false);
check('not applying, mark long expired ⇒ USER nav (capture)',
    isAppliedNavigationEcho({applying: false, markExpiry: NOW - 10_000, now: NOW}) === false);

// --- robustness: a non-finite markExpiry is treated as no mark -----------------------------
check('not applying, markExpiry = NaN ⇒ USER nav (capture)',
    isAppliedNavigationEcho({applying: false, markExpiry: NaN, now: NOW}) === false);
check('not applying, markExpiry = null ⇒ USER nav (capture)',
    isAppliedNavigationEcho({applying: false, markExpiry: null, now: NOW}) === false);

// --- the full echo-vs-user-nav PROOF as a single scenario ----------------------------------
// 1) apply navigates tab → in-apply onUpdated (the navigation start). applying = true ⇒ echo.
check('scenario: navigation-start during apply ⇒ suppressed',
    isAppliedNavigationEcho({applying: true, markExpiry: NOW, now: NOW}) === true);
// 2) url-less mark, settle after endApply within window ⇒ window-based suppression (legacy default).
check('scenario: url-less mark settle within window ⇒ suppressed',
    isAppliedNavigationEcho({applying: false, markExpiry: NOW + 3_000, now: NOW}) === true);
// 3) later, the user navigates the SAME tab; mark has expired ⇒ NOT echo ⇒ syncs.
check('scenario: later USER navigation after window ⇒ captured (syncs)',
    isAppliedNavigationEcho({applying: false, markExpiry: NOW - 5_000, now: NOW}) === false);

// --- URL-NARROWED suppression (convergence fix for "loads infinitely") ----------------------
// applied url X; settle observed at X ⇒ plain echo of our own write ⇒ SUPPRESS.
check('url-narrowed: settle at the EXACT applied url ⇒ suppressed',
    isAppliedNavigationEcho({applying: false, markExpiry: NOW + 3_000, markUrl: 'http://x', observedUrl: 'http://x', now: NOW}) === true);
// applied url X; server redirected to Y ⇒ NOT an echo ⇒ CAPTURE so the cloud converges to Y.
check('url-narrowed: redirect to a DIFFERENT url ⇒ captured (cloud converges, no perpetual re-nav)',
    isAppliedNavigationEcho({applying: false, markExpiry: NOW + 3_000, markUrl: 'http://x', observedUrl: 'http://y', now: NOW}) === false);
// in-apply suppression ignores the url entirely (STG's own writes).
check('url-narrowed: in-apply change is an echo regardless of url',
    isAppliedNavigationEcho({applying: true, markExpiry: NOW + 3_000, markUrl: 'http://x', observedUrl: 'http://y', now: NOW}) === true);
// an EXPIRED mark with urls is still not an echo (user nav outside the window syncs).
check('url-narrowed: expired mark ⇒ captured even with urls',
    isAppliedNavigationEcho({applying: false, markExpiry: NOW - 1, markUrl: 'http://x', observedUrl: 'http://x', now: NOW}) === false);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
