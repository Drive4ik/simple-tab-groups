/**
 * Standalone node test for the legacy-pin → pinned-group sync migration.
 *
 * Like the other delta tests, this is a plain `node pinned-migration.test.mjs` script (STG
 * has no test runner). It covers the coherence rules that make ordinary pins converge to
 * the pinned group: bootstrap retirement of legacy `pinnedTabs` entries, folding of
 * migrated pinned records into the group representation during planning, the no-duplicate
 * / no-resurrection planner guards, and the close-capture routing used by tabs.js
 * onRemoved. Exits non-zero on the first failure.
 */

import {planSync, computeBootstrapEvents} from './plan-sync.js';
import {closedTabCapturePlan} from './close-capture.js';

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
const REMOTE = 'devRemote';
const PG = '70696e6e-6564-4000-8000-000000000001';
const isPinnedGroupId = groupId => groupId === PG;

function pinnedGroup(tabs) {
    return {id: PG, title: 'Pinned', isPinnedGroup: true, tabs};
}

function findGroupTab(snapshot, uid) {
    for (const group of snapshot.groups || []) {
        const tab = (group.tabs || []).find(t => t.uid === uid);
        if (tab) {
            return {group, tab};
        }
    }
    return {group: null, tab: null};
}

// ---------------------------------------------------------------------------
// 1. Absorption migration via bootstrap: a uid that was last pushed as a legacy
//    pin (baseline.pinnedUids) and is now a pinned-group tab gets a tab.add into
//    the group AND a pinned.remove retiring the legacy entry — add BEFORE remove.
// ---------------------------------------------------------------------------
{
    const localState = {
        groups: [pinnedGroup([{uid: 'p1', url: 'http://a', index: 0, pinned: true}])],
        pinnedTabs: [],
        options: {},
    };
    const baseline = {tabUids: [], groupIds: [], optionKeys: [], pinnedUids: ['p1']};

    const events = computeBootstrapEvents(localState, baseline, new Set(), new Set(), new Set());

    const addIdx = events.findIndex(e => e.op === 'tab.add' && e.tab?.uid === 'p1' && e.groupId === PG);
    const removeIdx = events.findIndex(e => e.op === 'pinned.remove' && e.uid === 'p1');

    check('absorption: bootstrap emits tab.add into the pinned group', addIdx !== -1, JSON.stringify(events));
    check('absorption: bootstrap emits pinned.remove retiring the legacy entry', removeIdx !== -1, JSON.stringify(events));
    check('absorption: tab.add is ordered BEFORE pinned.remove (modification beats deletion)',
        addIdx !== -1 && removeIdx !== -1 && addIdx < removeIdx, `add@${addIdx} remove@${removeIdx}`);
    check('absorption: no pinned.add re-emitted for the migrated uid',
        !events.some(e => e.op === 'pinned.add' && e.tab?.uid === 'p1'), JSON.stringify(events));
}

// ---------------------------------------------------------------------------
// 1b. Retirement also fires when the group tab.add is already known (uid already
//     in baseline.tabUids or in the local log) but the legacy pin entry is not
//     yet retired.
// ---------------------------------------------------------------------------
{
    const localState = {
        groups: [pinnedGroup([{uid: 'p1', url: 'http://a', index: 0, pinned: true}])],
        pinnedTabs: [],
        options: {},
    };
    const baseline = {tabUids: ['p1'], groupIds: [PG], optionKeys: [], pinnedUids: ['p1']};

    const events = computeBootstrapEvents(localState, baseline, new Set(['p1']), new Set([PG]), new Set());

    check('retirement without re-add: pinned.remove emitted for already-synced group tab',
        events.some(e => e.op === 'pinned.remove' && e.uid === 'p1'), JSON.stringify(events));
    check('retirement without re-add: no duplicate tab.add',
        !events.some(e => e.op === 'tab.add' && e.tab?.uid === 'p1'), JSON.stringify(events));
}

// ---------------------------------------------------------------------------
// 2. planSync end-to-end absorption: cloud still carries the uid in the legacy
//    pinnedTabs collection, local has it as a pinned-group tab. The uid must move
//    to the group representation without loss and without duplicate ops.
// ---------------------------------------------------------------------------
{
    const pulledSnapshot = {
        groups: [],
        pinnedTabs: [{uid: 'p1', url: 'http://a', title: 'A', index: 0, lastModified: 100}],
        watermark: {},
    };
    const localPendingEvents = [
        {seq: 1, ts: 100, op: 'group.add', group: {id: PG, title: 'Pinned', isPinnedGroup: true}},
        {seq: 2, ts: 101, op: 'tab.add', groupId: PG, tab: {uid: 'p1', url: 'http://a', index: 0, pinned: true, lastModified: 100}},
        {seq: 3, ts: 102, op: 'pinned.remove', uid: 'p1'},
    ];
    const localState = {
        groups: [pinnedGroup([{uid: 'p1', url: 'http://a', index: 0, pinned: true, lastModified: 100}])],
        pinnedTabs: [],
        options: {},
    };
    const priorBaseline = {tabUids: [], groupIds: [], optionKeys: [], pinnedUids: ['p1']};

    const {browserOps, resolvedSnapshot} = planSync({
        pulledSnapshot, pulledDeltaLogs: [], localPendingEvents, selfDeviceId: SELF, localState, priorBaseline,
    });

    const {tab} = findGroupTab(resolvedSnapshot, 'p1');
    check('migration: uid lives in the pinned group of the resolved snapshot', !!tab && tab.url === 'http://a');
    check('migration: legacy pinnedTabs collection is empty after fold',
        resolvedSnapshot.pinnedTabs.length === 0, JSON.stringify(resolvedSnapshot.pinnedTabs));
    check('migration: no pinnedToCreate (no duplicate native pin)',
        browserOps.pinnedToCreate.length === 0, JSON.stringify(browserOps.pinnedToCreate));
    check('migration: no pinnedToRemove', browserOps.pinnedToRemove.length === 0, JSON.stringify(browserOps.pinnedToRemove));
    check('migration: no tabsToCreate / tabsToRemove',
        browserOps.tabsToCreate.length === 0 && browserOps.tabsToRemove.length === 0,
        JSON.stringify({c: browserOps.tabsToCreate, r: browserOps.tabsToRemove}));
}

// ---------------------------------------------------------------------------
// 2b. Stale legacy entry with NO retirement event yet (remote snapshot still has
//     it, local already migrated): the fold alone must prevent duplicate creation.
//     This is the exact incident shape: pinnedToCreate used to mint duplicate pins.
// ---------------------------------------------------------------------------
{
    const pulledSnapshot = {
        groups: [pinnedGroup([{uid: 'p1', url: 'http://a', index: 0, pinned: true, lastModified: 100}])],
        pinnedTabs: [{uid: 'p1', url: 'http://a', index: 0, lastModified: 50}],
        watermark: {},
    };
    const localState = {
        groups: [pinnedGroup([{uid: 'p1', url: 'http://a', index: 0, pinned: true, lastModified: 100}])],
        pinnedTabs: [],
        options: {},
    };

    const {browserOps, resolvedSnapshot} = planSync({
        pulledSnapshot, pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF, localState,
        priorBaseline: {tabUids: ['p1'], groupIds: [PG], optionKeys: [], pinnedUids: ['p1']},
    });

    check('incident guard: stale legacy entry folds away, pinnedToCreate stays empty',
        browserOps.pinnedToCreate.length === 0, JSON.stringify(browserOps.pinnedToCreate));
    check('incident guard: resolved pinnedTabs empty', resolvedSnapshot.pinnedTabs.length === 0);
    check('incident guard: no other destructive ops',
        browserOps.tabsToRemove.length === 0 && browserOps.pinnedToRemove.length === 0
            && browserOps.tabsToCreate.length === 0,
        JSON.stringify(browserOps));
}

// ---------------------------------------------------------------------------
// 3. Remote PINNED_MODIFY on a migrated uid: newer content maps onto the group
//    tab (url/title update), no unpin, no duplicate, no pinned-collection ops.
// ---------------------------------------------------------------------------
{
    const pulledSnapshot = {
        groups: [pinnedGroup([{uid: 'p1', url: 'http://old', title: 'Old', index: 0, pinned: true, lastModified: 100}])],
        pinnedTabs: [],
        watermark: {},
    };
    const pulledDeltaLogs = [
        {deviceId: REMOTE, events: [
            {seq: 1, ts: 200, op: 'pinned.modify', tab: {uid: 'p1', url: 'http://new', title: 'New', index: 0, lastModified: 200}},
        ]},
    ];
    const localState = {
        groups: [pinnedGroup([{uid: 'p1', url: 'http://old', title: 'Old', index: 0, pinned: true, lastModified: 100}])],
        pinnedTabs: [],
        options: {},
    };

    const {browserOps, resolvedSnapshot} = planSync({
        pulledSnapshot, pulledDeltaLogs, localPendingEvents: [], selfDeviceId: SELF, localState,
        priorBaseline: {tabUids: ['p1'], groupIds: [PG], optionKeys: [], pinnedUids: []},
    });

    const update = browserOps.tabsToUpdate.find(u => u.uid === 'p1');
    check('pinned.modify on migrated uid: content maps onto the group tab',
        update?.target?.url === 'http://new' && update?.target?.title === 'New', JSON.stringify(browserOps.tabsToUpdate));
    check('pinned.modify on migrated uid: no pinned flag change (no unpin)',
        !update || !Object.hasOwn(update.target, 'pinned'), JSON.stringify(update));
    check('pinned.modify on migrated uid: no pinned-collection ops',
        browserOps.pinnedToCreate.length === 0 && browserOps.pinnedToUpdate.length === 0
            && browserOps.pinnedToMove.length === 0 && browserOps.pinnedToRemove.length === 0,
        JSON.stringify(browserOps));
    check('pinned.modify on migrated uid: resolved snapshot keeps a single group copy',
        resolvedSnapshot.pinnedTabs.length === 0 && findGroupTab(resolvedSnapshot, 'p1').tab?.url === 'http://new');
}

// ---------------------------------------------------------------------------
// 3b. STALE remote PINNED_MODIFY (older lastModified than the group tab): the
//     group representation wins, nothing is applied.
// ---------------------------------------------------------------------------
{
    const pulledSnapshot = {
        groups: [pinnedGroup([{uid: 'p1', url: 'http://current', index: 0, pinned: true, lastModified: 300}])],
        pinnedTabs: [],
        watermark: {},
    };
    const pulledDeltaLogs = [
        {deviceId: REMOTE, events: [
            {seq: 1, ts: 200, op: 'pinned.modify', tab: {uid: 'p1', url: 'http://stale', index: 0, lastModified: 200}},
        ]},
    ];
    const localState = {
        groups: [pinnedGroup([{uid: 'p1', url: 'http://current', index: 0, pinned: true, lastModified: 300}])],
        pinnedTabs: [],
        options: {},
    };

    const {browserOps, resolvedSnapshot} = planSync({
        pulledSnapshot, pulledDeltaLogs, localPendingEvents: [], selfDeviceId: SELF, localState,
        priorBaseline: {tabUids: ['p1'], groupIds: [PG], optionKeys: [], pinnedUids: []},
    });

    check('stale pinned.modify: group content wins, no tab update',
        !browserOps.tabsToUpdate.some(u => u.uid === 'p1'), JSON.stringify(browserOps.tabsToUpdate));
    check('stale pinned.modify: resolved group tab keeps its url',
        findGroupTab(resolvedSnapshot, 'p1').tab?.url === 'http://current');
    check('stale pinned.modify: still no pinned-collection ops',
        browserOps.pinnedToCreate.length === 0 && browserOps.pinnedToUpdate.length === 0,
        JSON.stringify(browserOps));
}

// ---------------------------------------------------------------------------
// 4. Close of a pinned-group tab: onRemoved routes to a group TAB_REMOVE plus a
//    retirement of the legacy pinned entry — never a lone pinned.remove.
// ---------------------------------------------------------------------------
{
    const closed = closedTabCapturePlan({uid: 'p1', groupId: PG, wasPinned: true}, isPinnedGroupId);
    check('close pinned-group tab: emits TAB_REMOVE to the pinned group', closed.removeFromGroupId === PG, JSON.stringify(closed));
    check('close pinned-group tab: also retires the legacy pinned entry', closed.retirePinnedUid === 'p1', JSON.stringify(closed));

    const normal = closedTabCapturePlan({uid: 't1', groupId: 'g1', wasPinned: false}, isPinnedGroupId);
    check('close normal group tab: TAB_REMOVE to its group only',
        normal.removeFromGroupId === 'g1' && normal.retirePinnedUid === null, JSON.stringify(normal));

    const groupPinnedElsewhere = closedTabCapturePlan({uid: 't2', groupId: 'g1', wasPinned: true}, isPinnedGroupId);
    check('close group-pinned tab of a normal group: no legacy retirement',
        groupPinnedElsewhere.removeFromGroupId === 'g1' && groupPinnedElsewhere.retirePinnedUid === null,
        JSON.stringify(groupPinnedElsewhere));

    const legacyPin = closedTabCapturePlan({uid: 'p2', groupId: null, wasPinned: true}, isPinnedGroupId);
    check('close unabsorbed legacy pin: pinned.remove only',
        legacyPin.removeFromGroupId === null && legacyPin.retirePinnedUid === 'p2', JSON.stringify(legacyPin));

    const noUid = closedTabCapturePlan({uid: null, groupId: PG, wasPinned: true}, isPinnedGroupId);
    check('close without uid: no capture ops',
        noUid.removeFromGroupId === null && noUid.retirePinnedUid === null, JSON.stringify(noUid));
}

// ---------------------------------------------------------------------------
// 4b. Convergence after the close: with TAB_REMOVE + pinned.remove in the log,
//     the uid is fully retired — no resurrection via the legacy collection.
// ---------------------------------------------------------------------------
{
    const pulledSnapshot = {
        groups: [pinnedGroup([
            {uid: 'p1', url: 'http://a', index: 0, pinned: true, lastModified: 100},
            {uid: 'p2', url: 'http://b', index: 1, pinned: true, lastModified: 100},
        ])],
        pinnedTabs: [{uid: 'p1', url: 'http://a', index: 0, lastModified: 100}],
        watermark: {},
    };
    const localPendingEvents = [
        {seq: 10, ts: 500, op: 'tab.remove', groupId: PG, uid: 'p1'},
        {seq: 11, ts: 501, op: 'pinned.remove', uid: 'p1'},
    ];
    const localState = {
        groups: [pinnedGroup([{uid: 'p2', url: 'http://b', index: 0, pinned: true, lastModified: 100}])],
        pinnedTabs: [],
        options: {},
    };

    const {browserOps, resolvedSnapshot} = planSync({
        pulledSnapshot, pulledDeltaLogs: [], localPendingEvents, selfDeviceId: SELF, localState,
        priorBaseline: {tabUids: ['p1', 'p2'], groupIds: [PG], optionKeys: [], pinnedUids: ['p1']},
    });

    check('closed pin is gone from the resolved groups', !findGroupTab(resolvedSnapshot, 'p1').tab);
    check('closed pin is gone from the resolved pinnedTabs', !resolvedSnapshot.pinnedTabs.some(t => t.uid === 'p1'));
    check('closed pin is NOT resurrected (no creates)',
        browserOps.pinnedToCreate.length === 0 && browserOps.tabsToCreate.length === 0, JSON.stringify(browserOps));
    check('surviving pin is untouched (no removes)',
        browserOps.tabsToRemove.length === 0 && browserOps.pinnedToRemove.length === 0, JSON.stringify(browserOps));
}

// ---------------------------------------------------------------------------
// 5. Local not yet migrated (uid is still a live legacy pin locally) while the
//    cloud already carries the group representation: adopt, don't duplicate and
//    don't close the live pin.
// ---------------------------------------------------------------------------
{
    const pulledSnapshot = {
        groups: [pinnedGroup([{uid: 'p1', url: 'http://a', index: 0, pinned: true, lastModified: 100}])],
        pinnedTabs: [],
        watermark: {},
    };
    const localState = {
        groups: [],
        pinnedTabs: [{uid: 'p1', url: 'http://a', index: 0, lastModified: 100}],
        options: {},
    };

    const {browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF, localState,
        priorBaseline: {tabUids: [], groupIds: [], optionKeys: [], pinnedUids: ['p1']},
    });

    check('unmigrated local pin: no duplicate group-tab create',
        !browserOps.tabsToCreate.some(t => t.uid === 'p1'), JSON.stringify(browserOps.tabsToCreate));
    check('unmigrated local pin: live pin is NOT closed',
        browserOps.pinnedToRemove.length === 0, JSON.stringify(browserOps.pinnedToRemove));
}

// ---------------------------------------------------------------------------

if (failures.length) {
    console.error(`\n${failures.length} failed, ${passed} passed`);
    console.error('FAILURES:', failures);
    process.exit(1);
} else {
    console.log(`\n${passed} passed, 0 failed`);
}
