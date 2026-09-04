/**
 * Standalone node test: no apply pass may ever leave the capture-suppression counter raised.
 *
 * `delta-capture.js` suppresses capture for the whole time an apply is in flight. The counter
 * behind `isApplying()` used to be raised by `beginApply()` and lowered by `endApply()`, two
 * separate calls each call site had to pair by hand. `applyBrowserOps` did not: it raised the
 * counter and then awaited `Storage.get(SLEEP_OPTION_KEYS)` OUTSIDE the `try` whose `finally`
 * held the only `endApply()`. A rejecting storage read therefore threw with the counter stuck
 * up, and since nothing could ever bring it back down, `isApplying()` stayed true for the rest
 * of the background session: every capture entry point early-returned and no local change ever
 * reached the delta log again. `applying` also gates `isAppliedNavigationSettled`, so every
 * applied-navigation mark became immortal on top of that.
 *
 * `DeltaCapture.runApplying(fn)` now owns both halves, so the imbalance is unrepresentable.
 * These cases drive the REAL apply entry points through the loader stubs and assert the
 * counter is back down after every one of them — success, rejection, and rejection at each
 * point that used to sit outside the guarded region.
 *
 * Plain `node apply-depth.test.mjs`; the loader is registered below.
 */

import {register} from 'node:module';

register(new URL('./apply-depth.test.loader.mjs', import.meta.url));

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
globalThis.__contentMarks = {};
globalThis.__tabFacts = {};
globalThis.__stubs = {};

const DeltaCapture = await import('./delta-capture.js');
const {isApplying, tabModified, markAppliedNavigation, settleAppliedNavigation} = DeltaCapture;
const {applyBrowserOps, applyOptions} = await import('./apply-engine.js');
const {applyFavIconMap} = await import('./favicon-file.js');

function reset() {
    globalThis.__appended.length = 0;
    globalThis.__contentMarks = {};
    globalThis.__tabFacts = {};
    globalThis.__stubs = {};
}

function emptyBrowserOps() {
    return {
        groupsToCreate: [],
        groupsToUpdate: [],
        groupsToRemove: [],
        groupsOrder: null,
        tabsToCreate: [],
        tabsToMove: [],
        tabsToUpdate: [],
        tabsToRemove: [],
        pinnedToCreate: [],
        pinnedToMove: [],
        pinnedToUpdate: [],
        pinnedToRemove: [],
    };
}

async function captureAfterwards(tabId, url) {
    globalThis.__tabFacts = {[tabId]: {uid: `u${tabId}`, groupId: 1}};
    await tabModified({id: tabId, url, title: 'T', windowId: 1, discarded: false, status: 'complete'});
    return globalThis.__appended.some(item => item.tab?.url === url);
}

async function rejects(promise) {
    try {
        await promise;
        return null;
    } catch (e) {
        return e;
    }
}

// --- 1. the trace: the sleep-options read rejects -------------------------------------
{
    reset();
    globalThis.__stubs.storageGet = async () => {
        throw new Error('storage read failed');
    };

    const error = await rejects(applyBrowserOps(emptyBrowserOps(), null));

    check('a rejecting sleep-options read still fails the apply',
        error?.message === 'storage read failed');
    check('and the apply window is closed', isApplying() === false);
    check('so the very next local change is still captured',
        await captureAfterwards(41, 'https://after-storage-throw.test/'));
}

// --- 2. a browser call INSIDE the pass rejects -----------------------------------------
{
    reset();
    globalThis.__stubs.groupsLoad = async () => {
        throw new Error('groups load failed');
    };

    const error = await rejects(applyBrowserOps(emptyBrowserOps(), null));

    check('a rejecting call inside the pass fails the apply',
        error?.message === 'groups load failed');
    check('and the apply window is closed', isApplying() === false);
    check('so the very next local change is still captured',
        await captureAfterwards(42, 'https://after-inner-throw.test/'));
}

// --- 3. the ordinary success path --------------------------------------------------------
{
    reset();
    let applyingInsideThePass = null;
    globalThis.__stubs.groupsLoad = async () => {
        applyingInsideThePass = isApplying();
        return {groups: []};
    };

    await applyBrowserOps(emptyBrowserOps(), null);

    check('capture is suppressed while the pass runs', applyingInsideThePass === true);
    check('and the apply window is closed once it finishes', isApplying() === false);
    check('so the very next local change is captured',
        await captureAfterwards(43, 'https://after-success.test/'));
}

// --- 4. a leaked window would freeze every applied-navigation mark too -----------------
// `applying` gates `isAppliedNavigationSettled`, so a stuck counter makes every mark immortal:
// the tab it belongs to stays blind for the rest of the session.
{
    reset();
    markAppliedNavigation(44, 'https://target.test/');
    globalThis.__stubs.storageGet = async () => {
        throw new Error('storage read failed');
    };

    await rejects(applyBrowserOps(emptyBrowserOps(), null));

    check('the mark of a tab the failed pass touched can still be settled',
        settleAppliedNavigation(44, 'https://hop.test/', 'complete') === true);
}

// --- 5. applyOptions ---------------------------------------------------------------------
{
    reset();
    globalThis.__stubs.saveOptions = async () => {
        throw new Error('cant save options');
    };

    await applyOptions({closePopupAfterSelectTab: true});

    check('a throwing option write leaves the apply window closed', isApplying() === false);
    check('so the very next local change is still captured',
        await captureAfterwards(45, 'https://after-options-throw.test/'));
}

// --- 6. the archived-favicon write -------------------------------------------------------
{
    reset();
    globalThis.__stubs.groupsLoadWithArchivedTabs = async () => ({
        groups: [{id: 1, isArchive: true, tabs: [{uid: 'ua', favIconUrl: 'old'}]}],
    });
    globalThis.__stubs.groupsSave = async () => {
        throw new Error('cant save groups');
    };

    await applyFavIconMap({ua: 'new'});

    check('a throwing archived-favicon write leaves the apply window closed', isApplying() === false);
    check('so the very next local change is still captured',
        await captureAfterwards(46, 'https://after-favicon-throw.test/'));
}

// --- 7. the deferred wake navigation -----------------------------------------------------
{
    reset();
    globalThis.__tabFacts = {47: {uid: 'u47', groupId: 1}};
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

    const liveTab = {id: 47, url: 'https://old.test/', title: 'Old', windowId: 1, discarded: false};
    recordPendingNavTarget('u47', liveTab, {url: 'https://deferred.test/'});

    check('the failed deferred navigation reports no delivery',
        await resolvePendingNav(liveTab, {woke: true}) === false);
    check('and the apply window is closed', isApplying() === false);
    check('so the very next local change is still captured',
        await captureAfterwards(48, 'https://after-wake-throw.test/'));

    delete globalThis.browser;
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
