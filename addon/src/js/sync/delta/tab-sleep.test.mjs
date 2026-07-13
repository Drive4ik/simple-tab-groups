/**
 * Standalone node test for the PURE sleep decision (`tab-sleep.js`).
 *
 * Plain `node tab-sleep.test.mjs` (STG has no test runner). The module is pure (no
 * `browser.*` / `constants.js`), so it imports directly. Proves the two-axis matrix:
 *   GROUP (non-pinned):
 *     - syncSleepNewTabs OFF ⇒ group tabs load (legacy);
 *     - syncSleepNewTabs ON ⇒ group tabs sleep, unless
 *     - syncActivatePreviouslyActiveTabs ON AND the record was `loaded` on the source.
 *   PINNED (independent axis):
 *     - load by default; sleep ONLY when syncSleepPinnedTabs is ON (regardless of
 *       syncSleepNewTabs, because Firefox can't create a discarded pinned tab and STG
 *       only sleeps it via opt-in create-then-discard).
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs).
 */

import {shouldSleepSyncedTab, SLEEP_OPTION_KEYS} from './tab-sleep.js';

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

const asleep = {};               // a record that was asleep on the source (no `loaded`)
const wasLoaded = {loaded: true}; // a record loaded on the source

// --- PINNED axis: load by default, sleep only via syncSleepPinnedTabs -------
{
    check('pinned: default (no flag) ⇒ loaded', shouldSleepSyncedTab(asleep, true, {syncSleepNewTabs: true}) === false);
    check('pinned: syncSleepPinnedTabs ON ⇒ asleep', shouldSleepSyncedTab(asleep, true, {syncSleepPinnedTabs: true}) === true);
    check('pinned: syncSleepPinnedTabs ON even when group-sleep OFF ⇒ asleep',
        shouldSleepSyncedTab(asleep, true, {syncSleepNewTabs: false, syncSleepPinnedTabs: true}) === true);
    check('pinned: group-sleep ON but pinned flag OFF ⇒ loaded',
        shouldSleepSyncedTab(wasLoaded, true, {syncSleepNewTabs: true, syncSleepPinnedTabs: false}) === false);
}

// --- GROUP axis: syncSleepNewTabs OFF ⇒ nothing sleeps ----------------------
{
    const opts = {syncSleepNewTabs: false};
    check('sleep-off: group asleep-source ⇒ loaded', shouldSleepSyncedTab(asleep, false, opts) === false);
    check('sleep-off: source-loaded group ⇒ loaded', shouldSleepSyncedTab(wasLoaded, false, opts) === false);
}

// --- GROUP axis: syncSleepNewTabs ON ⇒ group tabs sleep ---------------------
{
    const opts = {syncSleepNewTabs: true};
    check('default: group asleep-source ⇒ asleep', shouldSleepSyncedTab(asleep, false, opts) === true);
    check('default: source-loaded group ⇒ asleep (prev flag off)', shouldSleepSyncedTab(wasLoaded, false, opts) === true);
}

// --- syncActivatePreviouslyActiveTabs: only source-loaded GROUP tabs wake ----
{
    const opts = {syncSleepNewTabs: true, syncActivatePreviouslyActiveTabs: true};
    check('activate-prev: source-loaded group ⇒ loaded', shouldSleepSyncedTab(wasLoaded, false, opts) === false);
    check('activate-prev: asleep-source group ⇒ asleep', shouldSleepSyncedTab(asleep, false, opts) === true);
    check('activate-prev: loaded !== true (falsy) ⇒ asleep', shouldSleepSyncedTab({loaded: false}, false, opts) === true);
    // pinned is its own axis — the prev-active flag does NOT wake/sleep pinned
    check('activate-prev: pinned still loaded by default', shouldSleepSyncedTab(wasLoaded, true, opts) === false);
}

// --- robustness: missing options bag / record ------------------------------
{
    check('no options: group ⇒ loaded (legacy)', shouldSleepSyncedTab(asleep, false) === false);
    check('no options: pinned ⇒ loaded', shouldSleepSyncedTab(asleep, true) === false);
    check('null record + group-sleep on ⇒ asleep', shouldSleepSyncedTab(null, false, {syncSleepNewTabs: true}) === true);
    check('null record + activate-prev ⇒ asleep (no loaded field)',
        shouldSleepSyncedTab(null, false, {syncSleepNewTabs: true, syncActivatePreviouslyActiveTabs: true}) === true);
}

// --- SLEEP_OPTION_KEYS lists exactly the three read keys --------------------
{
    check('SLEEP_OPTION_KEYS has the three keys',
        SLEEP_OPTION_KEYS.length === 3
        && SLEEP_OPTION_KEYS.includes('syncSleepNewTabs')
        && SLEEP_OPTION_KEYS.includes('syncSleepPinnedTabs')
        && SLEEP_OPTION_KEYS.includes('syncActivatePreviouslyActiveTabs'));
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
