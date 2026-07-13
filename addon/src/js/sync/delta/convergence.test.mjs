/**
 * Standalone node regression tests for the sync CONVERGENCE invariant: repeated syncs with no
 * real change must converge to ZERO browser ops (and a redirect must converge to its target,
 * not re-navigate forever). These reproduce the "browser freezes after sync / tabs load
 * infinitely" pains in pure, importable terms.
 *
 * Plain `node convergence.test.mjs` (STG has no test runner). Imports only the PURE modules:
 *   - planSync (the diff) for the no-op / loaded-mismatch convergence;
 *   - isAppliedNavigationEcho for the redirect-vs-echo decision;
 *   - liveUrlMatchesSource / shouldNavigateLiveTabUrl / isUrlSyncable / unwrapStubUrl for the
 *     apply-side stamp + no-op + url-less guards.
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs); it uses node
 * globals (process, console) the browser config bans.
 */

import {planSync} from './plan-sync.js';
import {isAppliedNavigationEcho} from './applied-nav-echo.js';
import {
    isUrlSyncable,
    unwrapStubUrl,
    liveUrlMatchesSource,
    shouldNavigateLiveTabUrl,
} from './url-sync.js';

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

const SELF = 'devSelf';
// the moz-extension "unsupported URL" stub for a privileged about: page (UUID is irrelevant —
// unwrapStubUrl matches by path suffix). Mirrors tabs.js createUnsupportedUrlPage, which builds
// the url via URL.searchParams.set (so the original — incl. any #fragment — is percent-encoded
// into the `url=` query value, not parsed as the stub's own fragment).
const stubFor = url => {
    const u = new URL('moz-extension://abc-123/help/stg-unsupported-url.html');
    u.searchParams.set('url', url);
    return u.href;
};

// ===========================================================================
// (i) Applying a content update TWICE is a no-op the 2nd time (live url already matches).
//     First apply: cloud says http://new, live still http://old ⇒ tabsToUpdate{url:new} AND the
//     apply navigates (live != target). Second apply (live now http://new): the planner emits no
//     tabsToUpdate at all, and even if it did, the apply-side no-op guard would not navigate.
// ===========================================================================
{
    const pulledSnapshot = {
        groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://new', title: 'T', index: 0}]}],
        watermark: {},
    };
    // FIRST sync: local still at the old url.
    const first = planSync({
        pulledSnapshot, pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF,
        localState: {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://old', title: 'T', index: 0}]}]},
    });
    const firstUpd = first.browserOps.tabsToUpdate.find(u => u.uid === 't1');
    check('(i) first apply emits a tabsToUpdate{url} (live != cloud)',
        !!firstUpd && firstUpd.target.url === 'http://new', JSON.stringify(first.browserOps.tabsToUpdate));
    check('(i) first apply WOULD navigate the live tab (old → new)',
        shouldNavigateLiveTabUrl('http://old', 'http://new') === true);

    // SECOND sync: local now reflects the applied url. Planner must emit ZERO ops for t1.
    const second = planSync({
        pulledSnapshot, pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF,
        localState: {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://new', title: 'T', index: 0}]}]},
    });
    check('(i) second apply emits NO tabsToUpdate for the converged tab',
        !second.browserOps.tabsToUpdate.some(u => u.uid === 't1'), JSON.stringify(second.browserOps.tabsToUpdate));
    check('(i) second apply emits NO move/create for the converged tab',
        !second.browserOps.tabsToMove.some(m => m.uid === 't1')
        && !second.browserOps.tabsToCreate.some(t => t.uid === 't1'));
    check('(i) apply-side no-op guard: navigating to the url already live is a NO-OP',
        shouldNavigateLiveTabUrl('http://new', 'http://new') === false);
    check('(i) no-op guard is stub-aware: a stub-rendered about: tab already at target ⇒ no-op',
        shouldNavigateLiveTabUrl(stubFor('about:config'), 'about:config') === false);
}

// ===========================================================================
// (ii) Redirect X→Y CONVERGES: the cloud must LEARN Y (no perpetual re-navigation). The narrowed
//      echo guard suppresses only the echo of the EXACT applied url X, but CAPTURES a redirect to
//      a different url Y so it is pushed and the cloud converges. Once cloud==Y==live, the planner
//      emits nothing.
// ===========================================================================
{
    const NOW = 1_000_000;
    const live = NOW + 2_000; // mark still live
    // applied X, settle observed at X ⇒ plain echo ⇒ SUPPRESS (don't re-capture our own write).
    check('(ii) settle at the EXACT applied url is an echo (suppressed)',
        isAppliedNavigationEcho({applying: false, markExpiry: live, markUrl: 'http://x', observedUrl: 'http://x', now: NOW}) === true);
    // applied X, server redirected to Y ⇒ NOT an echo ⇒ CAPTURE (cloud learns Y).
    check('(ii) redirect to a DIFFERENT url is NOT an echo (captured ⇒ cloud converges to Y)',
        isAppliedNavigationEcho({applying: false, markExpiry: live, markUrl: 'http://x', observedUrl: 'http://y', now: NOW}) === false);
    // in-apply changes are always echoes regardless of url (STG's own writes).
    check('(ii) any change WHILE applying is an echo',
        isAppliedNavigationEcho({applying: true, markExpiry: live, markUrl: 'http://x', observedUrl: 'http://y', now: NOW}) === true);
    // a user navigation after the mark expires is captured (A6 preserved).
    check('(ii) post-window user navigation is captured (not an echo)',
        isAppliedNavigationEcho({applying: false, markExpiry: NOW - 1, markUrl: 'http://x', observedUrl: 'http://z', now: NOW}) === false);
    // legacy url-less mark falls back to window-based suppression (safe default).
    check('(ii) url-less live mark falls back to window suppression',
        isAppliedNavigationEcho({applying: false, markExpiry: live, now: NOW}) === true);

    // Convergence proof at the planner level: once the cloud has learned the redirect target Y,
    // a tab that is locally at Y produces ZERO update ops (no more re-nav).
    const conv = planSync({
        pulledSnapshot: {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://y', index: 0}]}], watermark: {}},
        pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF,
        localState: {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://y', index: 0}]}]},
    });
    check('(ii) cloud converged to redirect target ⇒ no tabsToUpdate (loop ends)',
        !conv.browserOps.tabsToUpdate.some(u => u.uid === 't1'), JSON.stringify(conv.browserOps.tabsToUpdate));
}

// ===========================================================================
// (iii) loaded-MISMATCH on an intentionally-asleep tab emits NO update. The source had the tab
//       loaded (record carries loaded:true); this device created it discarded so buildLocalState
//       omits loaded. `loaded` is excluded from the content diff, so this never-converging diff is
//       no longer emitted (it used to re-emit tabsToUpdate{loaded:true} every cycle).
// ===========================================================================
{
    const planned = planSync({
        pulledSnapshot: {
            groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://a', title: 'A', loaded: true, index: 0}]}],
            watermark: {},
        },
        pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF,
        // local tab created asleep ⇒ NO `loaded` field (mirrors buildLocalState for a discarded tab).
        localState: {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://a', title: 'A', index: 0}]}]},
    });
    check('(iii) loaded-only mismatch on an asleep tab emits NO tabsToUpdate',
        !planned.browserOps.tabsToUpdate.some(u => u.uid === 't1'), JSON.stringify(planned.browserOps.tabsToUpdate));

    // sanity: a REAL content change (url) on the same shape still emits (loaded exclusion doesn't
    // suppress genuine changes).
    const realChange = planSync({
        pulledSnapshot: {
            groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://changed', title: 'A', loaded: true, index: 0}]}],
            watermark: {},
        },
        pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF,
        localState: {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://a', title: 'A', index: 0}]}]},
    });
    const upd = realChange.browserOps.tabsToUpdate.find(u => u.uid === 't1');
    check('(iii) a real url change still emits tabsToUpdate (loaded exclusion is targeted)',
        !!upd && upd.target.url === 'http://changed' && !('loaded' in upd.target), JSON.stringify(upd));
}

// ===========================================================================
// (iv) An about:/STUB created tab is matched (so it gets STAMPED) and is NOT re-created next cycle.
//      The apply renders a privileged about: source as the moz-extension stub, so the created tab's
//      live url is the stub while source.url is about:…  — liveUrlMatchesSource decodes the stub so
//      the stamp matches (without it the tab is left unstamped → re-created every cycle = the flood).
// ===========================================================================
{
    check('(iv) stub-rendered about: created tab MATCHES its about: source (⇒ gets stamped)',
        liveUrlMatchesSource(stubFor('about:memory#start1'), 'about:memory#start1') === true);
    check('(iv) plain http created tab matches its source url',
        liveUrlMatchesSource('http://a', 'http://a') === true);
    check('(iv) a genuinely different url does NOT match (no mis-stamp)',
        liveUrlMatchesSource('http://a', 'http://b') === false);
    check('(iv) a real moz-extension url (not a stub) matches itself',
        liveUrlMatchesSource('moz-extension://uuid/options/options.html#backup', 'moz-extension://uuid/options/options.html#backup') === true);

    // Convergence proof: once the about: tab is stamped with the remote uid, a later sync sees it
    // as already-local (uid present in localState) ⇒ no tabsToCreate ⇒ no re-create flood.
    const planned = planSync({
        pulledSnapshot: {
            groups: [{id: 'g1', title: 'G1', tabs: [{uid: 'about1', url: 'about:memory#start1', index: 0}]}],
            watermark: {},
        },
        pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF,
        // local tab carries the SAME uid (it was stamped on create) and the unwrapped about: url
        // (buildLocalState decodes the stub back to the original about: identity).
        localState: {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 'about1', url: 'about:memory#start1', index: 0}]}]},
    });
    check('(iv) a stamped about: tab is NOT re-created next cycle',
        !planned.browserOps.tabsToCreate.some(t => t.uid === 'about1'), JSON.stringify(planned.browserOps.tabsToCreate));
}

// ===========================================================================
// (v) A url-less / trivial-blank record never yields a bare tab. The apply create guard gates on
//     isUrlSyncable(unwrapStubUrl(url)); these inputs all fail it, so no Tabs.create({}) is issued.
// ===========================================================================
{
    check('(v) empty url is NOT syncable (guard drops the create)', isUrlSyncable(unwrapStubUrl('')) === false);
    check('(v) undefined url is NOT syncable', isUrlSyncable(unwrapStubUrl(undefined)) === false);
    check('(v) about:blank is NOT syncable', isUrlSyncable(unwrapStubUrl('about:blank')) === false);
    check('(v) about:newtab is NOT syncable', isUrlSyncable(unwrapStubUrl('about:newtab')) === false);
    // a REAL url passes the guard (so legitimate creates are unaffected).
    check('(v) a real http url IS syncable (legit create allowed)', isUrlSyncable(unwrapStubUrl('http://a')) === true);
    check('(v) a privileged about: url IS syncable (rendered as stub, not dropped)',
        isUrlSyncable(unwrapStubUrl('about:debugging#/runtime/this-firefox')) === true);
    // a stub-rendered about: tab's LIVE url decodes to a syncable about: url (so re-sync keeps it).
    check('(v) a stub url decodes to a syncable about: url (not treated as url-less)',
        isUrlSyncable(unwrapStubUrl(stubFor('about:debugging'))) === true);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.error('FAILURES:\n  ' + failures.join('\n  '));
    process.exit(1);
}
