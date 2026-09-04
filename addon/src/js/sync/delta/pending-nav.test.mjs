/**
 * Standalone node test for the DEFERRED apply-side navigation store (`pending-nav.js`).
 *
 * Plain `node pending-nav.test.mjs` (STG has no test runner). The module is pure and takes the
 * key-value store as an argument, so a plain object stands in for the prefixed localStorage the
 * background page hands it.
 *
 * Context: `planTabContentApply` refuses an incoming url/title for a DISCARDED tab, because
 * navigating a discarded tab would wake it and writing the target into the cache is a lie the
 * browser reverts (see tab-content-apply.test.mjs). Refusing alone loses the peer's edit forever
 * and re-emits the same unapplyable `tabsToUpdate` on every sync cycle. This module remembers the
 * refused target per uid so it can be delivered when the tab wakes, and so the diff can stop
 * re-emitting it in the meantime.
 *
 * Only a NAVIGATION is deferrable. A tab's title belongs to its page: Firefox exposes no API to
 * set it, so the one thing the wake path can do — write the peer's title into the cache — arms
 * `lastTabsState` with a value the woken page immediately contradicts, and the very next
 * `onUpdated` pushes the real title back out as a local edit. A target carrying a title but no
 * url is therefore never recorded here; `resolveTabContentChanges` (plan-sync.js) does not emit
 * one in the first place, so nothing recurs either.
 *
 * The load-bearing property is that a USER navigation always beats a stale pending target, while a
 * change the user did not make never counts as one: the entry records the url the tab really had
 * when the refusal happened, so a live url that still matches it is evidence the user did nothing
 * (Firefox refreshes a discarded tab's title from the session store on its own). A live url that
 * moved — or an entry with no recorded url to compare against — drops the target rather than risk
 * overwriting the page the user chose.
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs); it uses node
 * globals (process, console) the browser config bans.
 */

import {
    PENDING_NAV_KEY,
    PENDING_NAV_MAX_ENTRIES,
    PENDING_NAV_MAX_AGE_MS,
    DROPPED_USER_NAVIGATION,
    DROPPED_EXPIRED,
    loadPendingNav,
    recordPendingNav,
    getPendingNav,
    clearPendingNav,
    pendingNavTargets,
    gcPendingNav,
    planPendingNavOnTabUpdate,
} from './pending-nav.js';
import {planTabContentApply, REFUSED_DISCARDED, REFUSED_UNSYNCABLE_URL} from './tab-content-apply.js';

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

const NOW = 1_700_000_000_000;

const discardedTab = extra => ({id: 1, url: 'http://old', title: 'Old', discarded: true, ...extra});
const wokenTab = extra => discardedTab({discarded: false, ...extra});

// the apply path: refuse a discarded tab, then remember the target
function applyContentUpdate(store, uid, liveTab, target, now = NOW) {
    const plan = planTabContentApply(liveTab, target);

    if (Object.hasOwn(target, 'url') || Object.hasOwn(target, 'title')) {
        if (plan.refusal === REFUSED_DISCARDED) {
            recordPendingNav(store, uid, liveTab, target, now);
        } else {
            clearPendingNav(store, uid);
        }
    }

    return plan;
}

// the tabs.js onUpdated path: resolve whatever is pending for the tab
function onTabUpdated(store, uid, liveTab, {woke = false, contentChanged = false, now = NOW} = {}) {
    const plan = planPendingNavOnTabUpdate(getPendingNav(store, uid), liveTab, {woke, contentChanged, now});
    if (plan.clear) {
        clearPendingNav(store, uid);
    }
    return plan;
}

// --- registration: a refused discarded-tab update becomes a pending target -------------------
{
    const store = {};
    const plan = applyContentUpdate(store, 'u1', discardedTab(), {url: 'http://new', title: 'New'});
    const entry = getPendingNav(store, 'u1');

    check('refusing a discarded tab registers the target as pending',
        plan.refusal === REFUSED_DISCARDED && entry !== null
        && entry.url === 'http://new' && entry.title === 'New',
        JSON.stringify({plan, entry}));
    check('the pending entry records the url the tab really had',
        entry.liveUrl === 'http://old', JSON.stringify(entry));
    check('the pending entry is timestamped for the age bound',
        entry.ts === NOW, JSON.stringify(entry));
}
{
    const store = {};
    applyContentUpdate(store, 'u1', wokenTab(), {url: 'http://new'});
    check('a loaded tab is navigated for real ⇒ nothing is deferred',
        getPendingNav(store, 'u1') === null, JSON.stringify(store));
}
{
    const store = {};
    applyContentUpdate(store, 'u1', discardedTab(), {favIconUrl: 'http://icon'});
    check('a favIcon-only target defers nothing',
        getPendingNav(store, 'u1') === null, JSON.stringify(store));
}
{
    const store = {};
    const plan = applyContentUpdate(store, 'u1', discardedTab(), {title: 'New'});
    check('a title-only target is still refused on a discarded tab',
        plan.refusal === REFUSED_DISCARDED && plan.title === 'Old', JSON.stringify(plan));
    check('a title-only target defers nothing — a title is not a navigation',
        getPendingNav(store, 'u1') === null, JSON.stringify(store));

    const onWake = onTabUpdated(store, 'u1', wokenTab(), {woke: true});
    check('waking the tab delivers nothing, so nothing is written behind the browser\'s back',
        onWake.clear === false && onWake.navigate === false && onWake.title === undefined,
        JSON.stringify(onWake));
    check('the plan has no content-write channel at all',
        !Object.hasOwn(onWake, 'writeContent'), JSON.stringify(onWake));
    check('and no suppression entry is left dangling behind the refusal',
        JSON.stringify(pendingNavTargets(store)) === '{}' && store[PENDING_NAV_KEY] === undefined,
        JSON.stringify(store));
}
{
    const store = {};
    recordPendingNav(store, 'u1', discardedTab(), {url: 'http://new'}, NOW);
    applyContentUpdate(store, 'u1', discardedTab(), {title: 'New'});
    check('a title-only target does NOT wipe an already pending navigation',
        getPendingNav(store, 'u1')?.url === 'http://new', JSON.stringify(store));
}
{
    const store = {};
    recordPendingNav(store, 'u1', discardedTab(), {url: 'http://new'}, NOW);
    applyContentUpdate(store, 'u1', discardedTab(), {favIconUrl: 'http://icon'});
    check('a favIcon-only target does NOT wipe an already pending url',
        getPendingNav(store, 'u1')?.url === 'http://new', JSON.stringify(store));
}
{
    const store = {};
    applyContentUpdate(store, 'u1', discardedTab(), {url: 'http://new'});
    applyContentUpdate(store, 'u1', discardedTab(), {url: 'http://newer'});
    check('a newer peer target replaces the pending one',
        getPendingNav(store, 'u1')?.url === 'http://newer', JSON.stringify(store));
}
{
    const store = {};
    applyContentUpdate(store, null, discardedTab(), {url: 'http://new'});
    check('a tab without a uid cannot defer anything',
        store[PENDING_NAV_KEY] === undefined, JSON.stringify(store));
}

// --- persistence: the store is a plain key-value record, so it survives a background restart --
{
    const store = {};
    recordPendingNav(store, 'u1', discardedTab(), {url: 'http://new', title: 'New'}, NOW);

    check('the entry is written under a single stable key',
        typeof store[PENDING_NAV_KEY] === 'string' && Object.keys(store).length === 1,
        JSON.stringify(store));

    const afterRestart = loadPendingNav({...store});
    check('a fresh read of the same storage recovers the entry (background restart)',
        afterRestart.get('u1')?.url === 'http://new' && afterRestart.get('u1')?.title === 'New',
        JSON.stringify([...afterRestart]));
}
{
    const store = {[PENDING_NAV_KEY]: '{not json'};
    check('a corrupt record loads as empty instead of throwing', loadPendingNav(store).size === 0);
}
{
    const store = {[PENDING_NAV_KEY]: JSON.stringify({u1: {ts: NOW}, u2: {url: 'http://x', ts: NOW}})};
    const pending = loadPendingNav(store);
    check('an entry carrying neither url nor title is dropped on load',
        pending.size === 1 && pending.has('u2'), JSON.stringify([...pending]));
}
{
    const store = {[PENDING_NAV_KEY]: JSON.stringify({u1: {title: 'Only a title', ts: NOW}})};
    check('a title-only entry written by an older build is dropped on load',
        loadPendingNav(store).size === 0, JSON.stringify([...loadPendingNav(store)]));
}

// --- delivery: the target is applied when the tab wakes, then forgotten ----------------------
{
    const store = {};
    applyContentUpdate(store, 'u1', discardedTab(), {url: 'http://new', title: 'New'});

    const stillAsleep = onTabUpdated(store, 'u1', discardedTab(), {contentChanged: false});
    check('while the tab stays discarded the target keeps waiting',
        stillAsleep.navigate === false && stillAsleep.clear === false
        && getPendingNav(store, 'u1') !== null,
        JSON.stringify(stillAsleep));

    const onWake = onTabUpdated(store, 'u1', wokenTab(), {woke: true});
    check('waking the tab navigates it to the deferred target',
        onWake.navigate === true && onWake.url === 'http://new', JSON.stringify(onWake));
    check('the pending entry is cleared once applied',
        getPendingNav(store, 'u1') === null, JSON.stringify(store));

    const afterWake = onTabUpdated(store, 'u1', wokenTab({url: 'http://new'}), {contentChanged: true});
    check('nothing is applied twice',
        afterWake.navigate === false && afterWake.clear === false, JSON.stringify(afterWake));
}
{
    const store = {};
    applyContentUpdate(store, 'u1', discardedTab(), {url: 'http://new'});
    const onWake = onTabUpdated(store, 'u1', wokenTab({title: 'Loading…'}), {woke: true, contentChanged: true});
    check('a title change arriving WITH the wake is not mistaken for a user edit',
        onWake.navigate === true && onWake.url === 'http://new', JSON.stringify(onWake));
}
{
    const store = {};
    applyContentUpdate(store, 'u1', discardedTab(), {url: 'http://new'});
    const missedWake = onTabUpdated(store, 'u1', wokenTab(), {woke: false});
    check('a wake missed while the background was down is still delivered on a later event',
        missedWake.navigate === true && missedWake.url === 'http://new', JSON.stringify(missedWake));
}
{
    const store = {};
    applyContentUpdate(store, 'u1', discardedTab(), {url: 'http://new', title: 'New'});
    const onWake = onTabUpdated(store, 'u1', wokenTab(), {woke: true});
    check('a url+title target still navigates and writes nothing behind the browser\'s back',
        onWake.navigate === true && onWake.url === 'http://new' && onWake.title === 'New',
        JSON.stringify(onWake));
    check('the url+title entry is forgotten once delivered',
        getPendingNav(store, 'u1') === null, JSON.stringify(store));
}
{
    const store = {};
    applyContentUpdate(store, 'u1', discardedTab(), {url: 'http://new'});
    const onWake = onTabUpdated(store, 'u1', wokenTab({url: 'http://new'}), {woke: true});
    check('a tab that woke up already at the target is not navigated again',
        onWake.navigate === false && onWake.clear === true, JSON.stringify(onWake));
}

// --- THE correctness property: a user navigation beats the stale pending target --------------
{
    const store = {};
    applyContentUpdate(store, 'u1', discardedTab(), {url: 'http://new'});

    const userEdit = onTabUpdated(store, 'u1', wokenTab({url: 'http://user-typed'}), {contentChanged: true});
    check('a user content change before the wake drops the pending target',
        userEdit.navigate === false && userEdit.clear === true
        && userEdit.reason === DROPPED_USER_NAVIGATION,
        JSON.stringify(userEdit));
    check('the user edit leaves nothing that could overwrite it later',
        getPendingNav(store, 'u1') === null, JSON.stringify(store));
}
{
    const store = {};
    applyContentUpdate(store, 'u1', discardedTab(), {url: 'http://new'});

    const onWake = onTabUpdated(store, 'u1', wokenTab({url: 'http://user-typed'}), {woke: true});
    check('a tab whose url no longer matches the refusal is never navigated (user won)',
        onWake.navigate === false && onWake.reason === DROPPED_USER_NAVIGATION,
        JSON.stringify(onWake));
}
{
    const store = {};
    applyContentUpdate(store, 'u1', discardedTab(), {url: 'http://new', title: 'New'});

    const sessionTitle = onTabUpdated(store, 'u1', discardedTab({title: 'Restored from the session store'}), {contentChanged: true});
    check('a session-store title on a still-discarded tab is not a user edit',
        sessionTitle.clear === false && getPendingNav(store, 'u1')?.url === 'http://new',
        JSON.stringify(sessionTitle));

    const onWake = onTabUpdated(store, 'u1', wokenTab({title: 'Restored from the session store'}), {woke: true});
    check('the target survives the session-store noise and lands on the real wake',
        onWake.navigate === true && onWake.url === 'http://new' && getPendingNav(store, 'u1') === null,
        JSON.stringify(onWake));
}
{
    const store = {};
    applyContentUpdate(store, 'u1', discardedTab(), {url: 'http://new'});

    const userNav = onTabUpdated(store, 'u1', discardedTab({url: 'http://user-typed'}), {contentChanged: true});
    check('a url the user moved to before the wake drops the pending target',
        userNav.clear === true && userNav.reason === DROPPED_USER_NAVIGATION
        && getPendingNav(store, 'u1') === null,
        JSON.stringify(userNav));
}
{
    const store = {};
    recordPendingNav(store, 'u1', {id: 1, discarded: true}, {url: 'http://new'}, NOW);

    const onWake = onTabUpdated(store, 'u1', wokenTab(), {woke: true});
    check('an entry with no recorded live url is dropped instead of guessing',
        onWake.navigate === false && onWake.clear === true && onWake.reason === DROPPED_USER_NAVIGATION,
        JSON.stringify(onWake));
}

// --- a tab that is already awake must not keep suppressing the diff ---------------------------
{
    const store = {};
    applyContentUpdate(store, 'u1', discardedTab(), {url: 'http://new', title: 'New'});

    gcPendingNav(store, {aliveUids: new Set(['u1']), awakeUids: new Set(['u1']), now: NOW});

    check('a tab found already awake retires its stale pending target',
        getPendingNav(store, 'u1') === null, JSON.stringify(store));
    check('the retired target stops suppressing the plan',
        JSON.stringify(pendingNavTargets(store)) === '{}', JSON.stringify(store));
}
{
    const store = {};
    applyContentUpdate(store, 'u1', discardedTab(), {url: 'http://new'});

    gcPendingNav(store, {aliveUids: new Set(['u1']), awakeUids: new Set(), now: NOW});

    check('a tab that is still asleep keeps its pending target through GC',
        getPendingNav(store, 'u1')?.url === 'http://new', JSON.stringify(store));
}

{
    const store = {};
    const stub = 'moz-extension://abc-123/help/stg-unsupported-url.html?url=about%3Aconfig';
    applyContentUpdate(store, 'u1', discardedTab({url: stub}), {url: 'http://new'});
    const onWake = onTabUpdated(store, 'u1', wokenTab({url: stub}), {woke: true});
    check('a stub-rendered live url is not mistaken for a user navigation',
        onWake.navigate === true && onWake.url === 'http://new', JSON.stringify(onWake));
}

// --- a deferred target that can no longer be reached is dropped, not retried forever ---------
{
    const store = {};
    recordPendingNav(store, 'u1', discardedTab(), {url: 'about:newtab'}, NOW);
    const onWake = onTabUpdated(store, 'u1', wokenTab(), {woke: true});
    check('a non-syncable deferred target is refused and dropped on wake',
        onWake.navigate === false && onWake.clear === true && onWake.reason === REFUSED_UNSYNCABLE_URL,
        JSON.stringify(onWake));
    check('the non-syncable target does not linger in the store',
        getPendingNav(store, 'u1') === null, JSON.stringify(store));
}
{
    const store = {};
    recordPendingNav(store, 'u1', discardedTab(), {url: 'http://new'}, NOW);
    const expired = onTabUpdated(store, 'u1', discardedTab(), {now: NOW + PENDING_NAV_MAX_AGE_MS + 1});
    check('a target pending for far too long is dropped even while the tab sleeps',
        expired.navigate === false && expired.clear === true && expired.reason === DROPPED_EXPIRED,
        JSON.stringify(expired));
}

// --- the diff input: while a target is pending the resolved value is not re-emitted -----------
{
    const store = {};
    applyContentUpdate(store, 'u1', discardedTab(), {url: 'http://new', title: 'New'});
    const targets = pendingNavTargets(store);
    check('the diff gets a plain uid → target record',
        JSON.stringify(targets) === JSON.stringify({u1: {url: 'http://new', title: 'New'}}),
        JSON.stringify(targets));
    check('bookkeeping fields are not leaked to the diff',
        !Object.hasOwn(targets.u1, 'ts') && !Object.hasOwn(targets.u1, 'liveUrl'),
        JSON.stringify(targets));
}

// --- GC: entries for tabs that are gone, or that outlived the bound, must not accumulate ------
{
    const store = {};
    recordPendingNav(store, 'alive', discardedTab(), {url: 'http://a'}, NOW);
    recordPendingNav(store, 'closed', discardedTab(), {url: 'http://b'}, NOW);

    gcPendingNav(store, {aliveUids: new Set(['alive']), now: NOW});

    check('GC drops the entry of a tab that no longer exists',
        getPendingNav(store, 'closed') === null, JSON.stringify(store));
    check('GC keeps the entry of a tab that is still there',
        getPendingNav(store, 'alive')?.url === 'http://a', JSON.stringify(store));
}
{
    const store = {};
    recordPendingNav(store, 'fresh', discardedTab(), {url: 'http://a'}, NOW);
    recordPendingNav(store, 'ancient', discardedTab(), {url: 'http://b'}, NOW - PENDING_NAV_MAX_AGE_MS - 1);

    gcPendingNav(store, {aliveUids: new Set(['fresh', 'ancient']), now: NOW});

    check('GC drops an entry that has been pending far too long',
        getPendingNav(store, 'ancient') === null && getPendingNav(store, 'fresh') !== null,
        JSON.stringify(store));
}
{
    const store = {};
    gcPendingNav(store, {aliveUids: new Set(), now: NOW});
    check('GC of an empty store leaves no key behind', store[PENDING_NAV_KEY] === undefined);
}
{
    const store = {};
    recordPendingNav(store, 'only', discardedTab(), {url: 'http://a'}, NOW);
    clearPendingNav(store, 'only');
    check('clearing the last entry removes the storage key entirely',
        store[PENDING_NAV_KEY] === undefined, JSON.stringify(store));
}
{
    const store = {};
    const overflow = PENDING_NAV_MAX_ENTRIES + 25;
    for (let i = 0; i < overflow; i++) {
        recordPendingNav(store, `u${i}`, discardedTab(), {url: `http://${i}`}, NOW + i);
    }
    const pending = loadPendingNav(store);
    check('the store is capped at the entry bound',
        pending.size === PENDING_NAV_MAX_ENTRIES, String(pending.size));
    check('the cap keeps the newest entries',
        pending.has(`u${overflow - 1}`) && !pending.has('u0'), JSON.stringify([...pending.keys()].slice(0, 3)));
}

// --- convergence: the peer's edit is delivered exactly once, without churn --------------------
{
    const store = {};
    let tab = discardedTab();
    let refusals = 0;

    for (let i = 0; i < 5; i++) {
        const plan = applyContentUpdate(store, 'u1', tab, {url: 'http://new'});
        if (plan.refusal) {
            refusals++;
        }
        tab = {...tab, url: plan.url, title: plan.title};
    }

    check('repeated applies against the sleeping tab never mutate its recorded content',
        refusals === 5 && tab.url === 'http://old', JSON.stringify({refusals, tab}));

    const onWake = onTabUpdated(store, 'u1', {...tab, discarded: false}, {woke: true});
    check('the peer edit finally lands when the user wakes the tab',
        onWake.navigate === true && onWake.url === 'http://new', JSON.stringify(onWake));

    const settled = onTabUpdated(store, 'u1', {...tab, url: 'http://new', discarded: false}, {contentChanged: true});
    check('after delivery there is nothing left to replay',
        settled.clear === false && loadPendingNav(store).size === 0, JSON.stringify(settled));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
