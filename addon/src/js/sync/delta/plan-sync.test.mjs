/**
 * Standalone node test for the pure sync planner (P3a).
 *
 * Like replay.test.mjs, this is a plain `node plan-sync.test.mjs` script (STG has no
 * test runner). It imports the pure modules directly (no extension host) and asserts
 * the planner's `deltaFileToWrite` / `browserOps` shape across the scenarios in the
 * P3a task. Exits non-zero on the first failure.
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs); it
 * uses node globals (process, console) the browser config bans.
 */

import {planSync, computeBootstrapEvents, baselineFromSnapshot} from './plan-sync.js';
import {isSyncedOptionKey, syncedOptionKeys} from './option-keys.js';

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

function buildLogGroupRecordIds(events) {
    const ids = new Set();
    for (const event of events) {
        if (event.group?.id != null) {
            ids.add(event.group.id);
        }
    }
    return ids;
}

// ---------------------------------------------------------------------------
// 1. A local PENDING add: the tab already exists locally (the user just made it),
//    so it must NOT appear in browserOps.tabsToCreate, but it MUST appear in
//    deltaFileToWrite (it has to be pushed to the cloud).
// ---------------------------------------------------------------------------
{
    const pulledSnapshot = {groups: [{id: 'g1', title: 'G1', tabs: []}], watermark: {}};
    const pulledDeltaLogs = []; // nothing pushed yet
    const localPendingEvents = [
        {seq: 1, ts: 100, op: 'tab.add', groupId: 'g1', tab: {uid: 't1', url: 'http://a', index: 0}},
    ];
    const localState = {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://a', index: 0}]}]};

    const {browserOps, deltaFileToWrite} = planSync({
        pulledSnapshot, pulledDeltaLogs, localPendingEvents, selfDeviceId: SELF, localState,
    });

    const inCreate = browserOps.tabsToCreate.some(t => t.uid === 't1');
    check('local pending add is NOT in tabsToCreate (already local)', !inCreate, JSON.stringify(browserOps.tabsToCreate));
    check('local pending add IS in deltaFileToWrite',
        !!deltaFileToWrite && deltaFileToWrite.deviceId === SELF && deltaFileToWrite.events.some(e => e.tab?.uid === 't1'),
        JSON.stringify(deltaFileToWrite));
}

// ---------------------------------------------------------------------------
// 2. A remote add (present in a pulled delta) not present locally → tabsToCreate.
// ---------------------------------------------------------------------------
{
    const pulledSnapshot = {groups: [{id: 'g1', title: 'G1', tabs: []}], watermark: {}};
    const pulledDeltaLogs = [
        {deviceId: REMOTE, events: [
            {seq: 1, ts: 100, op: 'tab.add', groupId: 'g1', tab: {uid: 'r1', url: 'http://r', index: 0}},
        ]},
    ];
    const localState = {groups: [{id: 'g1', title: 'G1', tabs: []}]};

    const {browserOps, deltaFileToWrite} = planSync({
        pulledSnapshot, pulledDeltaLogs, localPendingEvents: [], selfDeviceId: SELF, localState,
    });

    const created = browserOps.tabsToCreate.find(t => t.uid === 'r1');
    check('remote add appears in tabsToCreate', !!created, JSON.stringify(browserOps.tabsToCreate));
    check('remote add tabsToCreate carries target {groupId,index}',
        created?.target?.groupId === 'g1' && created?.target?.index === 0, JSON.stringify(created));
    check('no self events to push ⇒ deltaFileToWrite is null', deltaFileToWrite === null, JSON.stringify(deltaFileToWrite));
}

// ---------------------------------------------------------------------------
// 2b. IDEMPOTENT CREATE (anti-duplication).
//   PLANNER contract: a resolved tab whose uid is present in localState is NEVER emitted
//   as a tabsToCreate (it can only move/update). This is the first line of defense.
//   APPLY-LAYER guard: the SECOND line of defense lives in delta-sync.js applyBrowserOps /
//   applyPinnedOps — it builds a live-by-uid index and SKIPS creating any tabsToCreate /
//   pinnedToCreate whose uid is already live. That guard handles uid drift (a fresh
//   session-restore uid in the live cache that disagrees with the snapshot localState the
//   planner diffed) which the planner cannot see. delta-sync.js is impure (browser deps,
//   no test-runner import — see delta-sync-helpers.test.mjs header), so its guard is not
//   unit-tested here; we assert the planner contract and replicate the guard's predicate
//   to lock its behavior.
// ---------------------------------------------------------------------------
{
    // PLANNER: a uid already in localState is never re-created.
    const pulledSnapshot = {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 'live1', url: 'http://a', index: 0}]}], watermark: {}};
    const localState = {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 'live1', url: 'http://a', index: 0}]}]};
    const {browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF, localState,
    });
    check('idempotent create: a uid present locally is NOT in tabsToCreate',
        !browserOps.tabsToCreate.some(t => t.uid === 'live1'), JSON.stringify(browserOps.tabsToCreate));

    // APPLY-LAYER guard predicate (replicated): given a live-by-uid index, a create whose
    // uid is already live is dropped; one whose uid is new is kept. (Mirrors the
    // `liveByUidForCreate.has(tab.uid)` skip in applyBrowserOps / applyPinnedOps.)
    const liveByUid = new Map([['live1', 101]]);
    const skipIfLive = tab => !(tab.uid != null && liveByUid.has(tab.uid));
    check('idempotent create guard: drops a create whose uid is already live',
        !skipIfLive({uid: 'live1', url: 'http://a'}), 'live1 should be skipped');
    check('idempotent create guard: keeps a create whose uid is NOT live',
        skipIfLive({uid: 'new1', url: 'http://b'}), 'new1 should be created');
}

// ---------------------------------------------------------------------------
// 3. A remote remove (tab in base, removed by remote delta) → tabsToRemove.
// ---------------------------------------------------------------------------
{
    const pulledSnapshot = {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://a', index: 0}]}], watermark: {}};
    const pulledDeltaLogs = [
        {deviceId: REMOTE, events: [
            {seq: 1, ts: 100, op: 'tab.remove', groupId: 'g1', uid: 't1'},
        ]},
    ];
    // local still has the tab (hasn't applied the remote remove yet)
    const localState = {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://a', index: 0}]}]};

    const {browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs, localPendingEvents: [], selfDeviceId: SELF, localState,
        priorBaseline: {tabUids: ['t1'], groupIds: ['g1']}, // t1 was synced before
    });

    const removed = browserOps.tabsToRemove.find(t => t.uid === 't1');
    check('remote remove appears in tabsToRemove', !!removed, JSON.stringify(browserOps.tabsToRemove));
    check('remote remove tabsToRemove carries local groupId', removed?.groupId === 'g1', JSON.stringify(removed));
}

// ---------------------------------------------------------------------------
// 4. Conflicting modify resurrects (rule 1): self removed a tab, remote modified
//    it later. Resolved keeps the tab; locally it is gone ⇒ tabsToCreate (resurrected).
// ---------------------------------------------------------------------------
{
    const pulledSnapshot = {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://a', index: 0}]}], watermark: {}};
    const pulledDeltaLogs = [
        {deviceId: REMOTE, events: [
            {seq: 1, ts: 300, op: 'tab.modify', groupId: 'g1', tab: {uid: 't1', url: 'http://a2', index: 0}},
        ]},
    ];
    // self removed t1 locally (pending) and it's gone from live state
    const localPendingEvents = [
        {seq: 1, ts: 100, op: 'tab.remove', groupId: 'g1', uid: 't1'},
    ];
    const localState = {groups: [{id: 'g1', title: 'G1', tabs: []}]};

    const {resolvedSnapshot, browserOps, deltaFileToWrite} = planSync({
        pulledSnapshot, pulledDeltaLogs, localPendingEvents, selfDeviceId: SELF, localState,
    });

    const resolvedT1 = resolvedSnapshot.groups[0].tabs.find(t => t.uid === 't1');
    check('conflict: resolved snapshot resurrects t1 (modify beats delete)',
        !!resolvedT1 && resolvedT1.url === 'http://a2', JSON.stringify(resolvedT1));
    const created = browserOps.tabsToCreate.find(t => t.uid === 't1');
    check('conflict: resurrected tab surfaces in tabsToCreate (absent locally)',
        !!created && created.url === 'http://a2', JSON.stringify(browserOps.tabsToCreate));
    check('conflict: self pending remove is still pushed in deltaFileToWrite',
        !!deltaFileToWrite && deltaFileToWrite.events.some(e => e.op === 'tab.remove' && e.uid === 't1'),
        JSON.stringify(deltaFileToWrite));
}

// ---------------------------------------------------------------------------
// 4b. tabsToMove: a tab present both sides but in a different group/index.
// ---------------------------------------------------------------------------
{
    const pulledSnapshot = {
        groups: [
            {id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://a', index: 0}]},
            {id: 'g2', title: 'G2', tabs: []},
        ],
        watermark: {},
    };
    const pulledDeltaLogs = [
        {deviceId: REMOTE, events: [
            {seq: 1, ts: 100, op: 'tab.move', groupId: 'g2', uid: 't1', toIndex: 0},
        ]},
    ];
    const localState = {groups: [
        {id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://a', index: 0}]},
        {id: 'g2', title: 'G2', tabs: []},
    ]};

    const {browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs, localPendingEvents: [], selfDeviceId: SELF, localState,
    });

    const moved = browserOps.tabsToMove.find(t => t.uid === 't1');
    check('tab moved across groups appears in tabsToMove', !!moved, JSON.stringify(browserOps.tabsToMove));
    check('tabsToMove carries target {groupId,index}',
        moved?.target?.groupId === 'g2' && moved?.target?.index === 0, JSON.stringify(moved));
}

// ---------------------------------------------------------------------------
// 4c. group ops by id: remote group.add → groupsToCreate; a LOCAL-ONLY group the
//     cloud never knew is KEPT (never removed); a cloud-known group dropped in
//     resolved IS removed. (Regression: data-loss bug removed local-only groups.)
// ---------------------------------------------------------------------------
{
    const pulledSnapshot = {groups: [{id: 'g1', title: 'G1', tabs: []}], watermark: {}};
    const pulledDeltaLogs = [
        {deviceId: REMOTE, events: [
            {seq: 1, ts: 100, op: 'group.add', group: {id: 'g2', title: 'G2 new'}},
        ]},
    ];
    // local has g1 and an extra local-only g3 (cloud never saw g3), but not g2
    const localState = {groups: [
        {id: 'g1', title: 'G1', tabs: []},
        {id: 'g3', title: 'G3 local-only', tabs: []},
    ]};

    const {browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs, localPendingEvents: [], selfDeviceId: SELF, localState,
    });

    check('remote group.add appears in groupsToCreate by id',
        browserOps.groupsToCreate.some(g => g.id === 'g2'), JSON.stringify(browserOps.groupsToCreate));
    check('local-only group is NOT removed (regression: no data loss)',
        !browserOps.groupsToRemove.some(g => g.id === 'g3'), JSON.stringify(browserOps.groupsToRemove));
}

// 4c-bis. A cloud-known group removed elsewhere IS removed locally.
{
    const pulledSnapshot = {groups: [{id: 'g1', title: 'G1', tabs: []}], watermark: {}};
    const pulledDeltaLogs = [
        {deviceId: REMOTE, events: [
            {seq: 1, ts: 100, op: 'group.remove', groupId: 'g1'},
        ]},
    ];
    const localState = {groups: [{id: 'g1', title: 'G1', tabs: []}]};

    const {browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs, localPendingEvents: [], selfDeviceId: SELF, localState,
        priorBaseline: {tabUids: [], groupIds: ['g1']}, // g1 was synced before
    });

    check('cloud-known group deleted elsewhere IS in groupsToRemove',
        browserOps.groupsToRemove.some(g => g.id === 'g1'), JSON.stringify(browserOps.groupsToRemove));
}

// 4c-ter. A LOCAL-ONLY tab the cloud never knew is KEPT (never removed).
{
    const pulledSnapshot = {groups: [{id: 'g1', title: 'G1', tabs: []}], watermark: {}};
    const pulledDeltaLogs = []; // cloud knows no tabs at all
    // local group has a pre-existing tab with a uid the cloud has never seen
    const localState = {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 'local1', url: 'http://x', index: 0}]}]};

    const {browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs, localPendingEvents: [], selfDeviceId: SELF, localState,
    });

    check('local-only tab is NOT removed (regression: this was the data-loss bug)',
        !browserOps.tabsToRemove.some(t => t.uid === 'local1'), JSON.stringify(browserOps.tabsToRemove));
}

// ---------------------------------------------------------------------------
// 4d. group.modify with changed props → groupsToUpdate (additive identity-only
//     changes that don't alter props produce no spurious update).
// ---------------------------------------------------------------------------
{
    const pulledSnapshot = {groups: [{id: 'g1', title: 'Old', tabs: []}], watermark: {}};
    const pulledDeltaLogs = [
        {deviceId: REMOTE, events: [
            {seq: 1, ts: 100, op: 'group.modify', group: {id: 'g1', title: 'New title'}},
        ]},
    ];
    const localState = {groups: [{id: 'g1', title: 'Old', tabs: []}]};

    const {browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs, localPendingEvents: [], selfDeviceId: SELF, localState,
    });

    check('changed group props surface in groupsToUpdate',
        browserOps.groupsToUpdate.some(g => g.id === 'g1' && g.title === 'New title'),
        JSON.stringify(browserOps.groupsToUpdate));
}

// ===========================================================================
// BASELINE SCENARIOS — the per-device baseline gate replaces the cloud-known gate.
// Removal rule: a local item absent from resolved is removed ONLY if it is in this
// device's priorBaseline (synced-before ⇒ delete elsewhere). Items not in baseline
// are never removed (new-local) and are bootstrap-uploaded.
// ===========================================================================

// B1. FIRST SYNC (empty baseline): a local-only tab is NOT removed, AND
//     computeBootstrapEvents emits a tab.add for it (data-loss safe + uploads).
{
    const pulledSnapshot = {groups: [{id: 'g1', title: 'G1', tabs: []}], watermark: {}};
    const localState = {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://a', index: 0}]}]};
    const priorBaseline = {tabUids: [], groupIds: []}; // first sync — nothing synced yet

    const {browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF, localState, priorBaseline,
    });
    check('first sync: local-only tab is NOT in tabsToRemove',
        !browserOps.tabsToRemove.some(t => t.uid === 't1'), JSON.stringify(browserOps.tabsToRemove));

    // g1 IS in baseline-less resolved (it's in the snapshot) so only t1 bootstraps.
    const boot = computeBootstrapEvents(localState, priorBaseline, [], ['g1']);
    check('first sync: computeBootstrapEvents emits tab.add for the local-only tab',
        boot.some(e => e.op === 'tab.add' && e.tab?.uid === 't1' && e.groupId === 'g1'), JSON.stringify(boot));
}

// B2. OFFLINE-RETURN DELETE (the key case): tab uid IS in baseline, absent from
//     resolved, NO local modify ⇒ tabsToRemove (delete propagates; NOT re-uploaded).
{
    // snapshot/deltas no longer prove t1 ever existed (compaction folded the delete),
    // but this device's baseline remembers it was synced.
    const pulledSnapshot = {groups: [{id: 'g1', title: 'G1', tabs: []}], watermark: {}};
    const localState = {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://a', index: 0}]}]};
    const priorBaseline = {tabUids: ['t1'], groupIds: ['g1']};

    const {browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF, localState, priorBaseline,
    });
    check('offline-return delete: baseline tab absent from resolved IS in tabsToRemove',
        browserOps.tabsToRemove.some(t => t.uid === 't1'), JSON.stringify(browserOps.tabsToRemove));

    // and it is NOT re-uploaded: computeBootstrapEvents skips it (it's in the baseline).
    const boot = computeBootstrapEvents(localState, priorBaseline, [], []);
    check('offline-return delete: deleted-elsewhere tab is NOT bootstrap-uploaded',
        !boot.some(e => e.op === 'tab.add' && e.tab?.uid === 't1'), JSON.stringify(boot));
}

// B3. OFFLINE-RETURN WITH LOCAL MODIFY: uid in baseline, but a local pending
//     tab.modify resurrects it into resolved (modify beats delete) ⇒ NOT removed.
{
    const pulledSnapshot = {groups: [{id: 'g1', title: 'G1', tabs: []}], watermark: {}};
    const localPendingEvents = [
        {seq: 1, ts: 100, op: 'tab.modify', groupId: 'g1', tab: {uid: 't1', url: 'http://a-edited', index: 0}},
    ];
    const localState = {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://a-edited', index: 0}]}]};
    const priorBaseline = {tabUids: ['t1'], groupIds: ['g1']};

    const {resolvedSnapshot, browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs: [], localPendingEvents, selfDeviceId: SELF, localState, priorBaseline,
    });
    check('offline-return + modify: resolved resurrects t1 (modify beats delete)',
        resolvedSnapshot.groups[0].tabs.some(t => t.uid === 't1'), JSON.stringify(resolvedSnapshot.groups[0].tabs));
    check('offline-return + modify: t1 is NOT in tabsToRemove (modification wins)',
        !browserOps.tabsToRemove.some(t => t.uid === 't1'), JSON.stringify(browserOps.tabsToRemove));
}

// B4. NEW-LOCAL OFFLINE: uid NOT in baseline ⇒ NOT removed; bootstrap emits it.
{
    const pulledSnapshot = {groups: [{id: 'g1', title: 'G1', tabs: []}], watermark: {}};
    const localState = {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 'newlocal', url: 'http://new', index: 0}]}]};
    const priorBaseline = {tabUids: ['someOtherOldUid'], groupIds: ['g1']};

    const {browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF, localState, priorBaseline,
    });
    check('new-local offline: uid not in baseline is NOT removed',
        !browserOps.tabsToRemove.some(t => t.uid === 'newlocal'), JSON.stringify(browserOps.tabsToRemove));

    const boot = computeBootstrapEvents(localState, priorBaseline, [], ['g1']);
    check('new-local offline: computeBootstrapEvents emits the new tab',
        boot.some(e => e.op === 'tab.add' && e.tab?.uid === 'newlocal'), JSON.stringify(boot));
}

// B5. computeBootstrapEvents idempotency + ordering.
{
    const localState = {groups: [
        {id: 'gNew', title: 'New group', tabs: [{uid: 'tNew', url: 'http://n', index: 0}, {uid: 'tInLog', url: 'http://l', index: 1}]},
    ]};
    // gNew + tNew are brand new; tInLog already referenced by the local log.
    const boot = computeBootstrapEvents(localState, {tabUids: [], groupIds: []}, ['tInLog'], []);

    check('bootstrap: emits group.add for the new group',
        boot.some(e => e.op === 'group.add' && e.group?.id === 'gNew'), JSON.stringify(boot));
    check('bootstrap: emits tab.add for the new tab',
        boot.some(e => e.op === 'tab.add' && e.tab?.uid === 'tNew'), JSON.stringify(boot));
    check('bootstrap: skips a tab already in the local log (idempotent)',
        !boot.some(e => e.op === 'tab.add' && e.tab?.uid === 'tInLog'), JSON.stringify(boot));
    check('bootstrap: group.add ordered before its tab',
        boot.findIndex(e => e.op === 'group.add' && e.group?.id === 'gNew')
            < boot.findIndex(e => e.op === 'tab.add' && e.tab?.uid === 'tNew'), JSON.stringify(boot));
    check('bootstrap: group.add carries no tabs',
        !('tabs' in (boot.find(e => e.op === 'group.add')?.group || {})), JSON.stringify(boot));

    // re-running with everything now in the baseline yields nothing (idempotent).
    const boot2 = computeBootstrapEvents(localState, {tabUids: ['tNew', 'tInLog'], groupIds: ['gNew']}, [], []);
    check('bootstrap: everything in baseline ⇒ no events (idempotent)', boot2.length === 0, JSON.stringify(boot2));
}

// B5b. group.add dedup keys off the group-RECORD set, not any group reference.
{
    const localState = {groups: [
        {id: 'gPre', title: 'Real Title', tabs: [{uid: 'tPre', url: 'http://p', index: 0}]},
    ]};

    const recordSet = buildLogGroupRecordIds([
        {op: 'tab.move', groupId: 'gPre', uid: 'tPre'},
        {op: 'tab.remove', groupId: 'gPre', uid: 'tOld'},
    ]);
    check('capture: tab-level events do NOT put the group into the record set',
        !recordSet.has('gPre'), JSON.stringify([...recordSet]));

    const bootFromTabRefs = computeBootstrapEvents(localState, {tabUids: [], groupIds: []}, [], recordSet);
    check('bootstrap: a group referenced only by tab-level events still emits group.add with its title',
        bootFromTabRefs.some(e => e.op === 'group.add' && e.group?.id === 'gPre' && e.group?.title === 'Real Title'),
        JSON.stringify(bootFromTabRefs));

    const recordSetWithAdd = buildLogGroupRecordIds([
        {op: 'group.add', group: {id: 'gPre', title: 'Real Title'}},
    ]);
    check('capture: a group.add event DOES put the group into the record set',
        recordSetWithAdd.has('gPre'), JSON.stringify([...recordSetWithAdd]));

    const bootWithRecord = computeBootstrapEvents(localState, {tabUids: [], groupIds: []}, [], recordSetWithAdd);
    check('bootstrap: a group already carrying a group.add in the log is not re-emitted',
        !bootWithRecord.some(e => e.op === 'group.add' && e.group?.id === 'gPre'),
        JSON.stringify(bootWithRecord));
}

// B6. baselineFromSnapshot collects the right ids/uids.
{
    const snapshot = {groups: [
        {id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://a'}, {uid: 't2', url: 'http://b'}]},
        {id: 'g2', title: 'G2', tabs: [{uid: 't3', url: 'http://c'}]},
        {id: 'g3', title: 'G3', tabs: []},
    ]};
    const baseline = baselineFromSnapshot(snapshot);
    check('baselineFromSnapshot collects all group ids',
        ['g1', 'g2', 'g3'].every(id => baseline.groupIds.includes(id)) && baseline.groupIds.length === 3,
        JSON.stringify(baseline.groupIds));
    check('baselineFromSnapshot collects all tab uids',
        ['t1', 't2', 't3'].every(u => baseline.tabUids.includes(u)) && baseline.tabUids.length === 3,
        JSON.stringify(baseline.tabUids));
}

// ---------------------------------------------------------------------------
// GROUP-SCOPED PINNED TABS — the `pinned` flag on a GROUP tab record (pinned only
// while its group is active). It rides the existing group tab.add/tab.modify ops; it
// must round-trip through replay + plan and is NEVER a global pinned.* op.
// ---------------------------------------------------------------------------

// gp1. A remote tab.add carrying pinned:true → tabsToCreate carries pinned:true, and
//      it is a GROUP tab (target.groupId set), NOT a global pinned op.
{
    const pulledSnapshot = {groups: [{id: 'g1', title: 'G1', tabs: []}], pinnedTabs: [], watermark: {}};
    const pulledDeltaLogs = [
        {deviceId: REMOTE, events: [
            {seq: 1, ts: 100, op: 'tab.add', groupId: 'g1', tab: {uid: 'gp1', url: 'http://gp', index: 0, pinned: true}},
        ]},
    ];
    const localState = {groups: [{id: 'g1', title: 'G1', tabs: []}], pinnedTabs: []};

    const {resolvedSnapshot, browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs, localPendingEvents: [], selfDeviceId: SELF, localState,
    });

    const resolved = resolvedSnapshot.groups[0].tabs.find(t => t.uid === 'gp1');
    check('group-pinned: replay preserves pinned:true on the group tab',
        resolved?.pinned === true, JSON.stringify(resolved));
    const created = browserOps.tabsToCreate.find(t => t.uid === 'gp1');
    check('group-pinned: surfaces in tabsToCreate as a GROUP tab with pinned:true',
        created?.pinned === true && created?.target?.groupId === 'g1', JSON.stringify(created));
    check('group-pinned: never leaks into the global pinned ops',
        !browserOps.pinnedToCreate.some(t => t.uid === 'gp1')
            && !(resolvedSnapshot.pinnedTabs || []).some(t => t.uid === 'gp1'),
        JSON.stringify({pinnedToCreate: browserOps.pinnedToCreate, pinnedTabs: resolvedSnapshot.pinnedTabs}));
}

// gp2. Toggling the flag is a tab.modify: a remote tab.modify with pinned:true on a tab
//      already present both sides flips the resolved record and does not create/remove.
{
    const pulledSnapshot = {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 'gp2', url: 'http://gp2', index: 0}]}], pinnedTabs: [], watermark: {}};
    const pulledDeltaLogs = [
        {deviceId: REMOTE, events: [
            {seq: 1, ts: 200, op: 'tab.modify', groupId: 'g1', tab: {uid: 'gp2', url: 'http://gp2', index: 0, pinned: true}},
        ]},
    ];
    // local has the tab WITHOUT the pin yet
    const localState = {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 'gp2', id: 5, url: 'http://gp2', index: 0}]}], pinnedTabs: []};

    const {resolvedSnapshot, browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs, localPendingEvents: [], selfDeviceId: SELF, localState,
    });

    const resolved = resolvedSnapshot.groups[0].tabs.find(t => t.uid === 'gp2');
    check('group-pinned toggle: tab.modify flips pinned:true in resolved',
        resolved?.pinned === true, JSON.stringify(resolved));
    // same group + same index ⇒ no move/create/remove churn (the flag change is content)
    check('group-pinned toggle: no spurious create/remove/move for the toggled tab',
        !browserOps.tabsToCreate.some(t => t.uid === 'gp2')
            && !browserOps.tabsToRemove.some(t => t.uid === 'gp2')
            && !browserOps.tabsToMove.some(t => t.uid === 'gp2'),
        JSON.stringify(browserOps));
}

// gp3. Local pending tab.modify carrying pinned:true is pushed (deltaFileToWrite) and
//      the flag survives replay into the resolved snapshot.
{
    const pulledSnapshot = {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 'gp3', url: 'http://gp3', index: 0}]}], pinnedTabs: [], watermark: {}};
    const localPendingEvents = [
        {seq: 1, ts: 300, op: 'tab.modify', groupId: 'g1', tab: {uid: 'gp3', url: 'http://gp3', index: 0, pinned: true}},
    ];
    const localState = {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 'gp3', id: 7, url: 'http://gp3', index: 0, pinned: true}]}], pinnedTabs: []};

    const {resolvedSnapshot, deltaFileToWrite} = planSync({
        pulledSnapshot, pulledDeltaLogs: [], localPendingEvents, selfDeviceId: SELF, localState,
    });

    check('group-pinned: local pending pin-toggle is pushed with pinned:true',
        !!deltaFileToWrite && deltaFileToWrite.events.some(e => e.op === 'tab.modify' && e.tab?.uid === 'gp3' && e.tab?.pinned === true),
        JSON.stringify(deltaFileToWrite));
    const resolved = resolvedSnapshot.groups[0].tabs.find(t => t.uid === 'gp3');
    check('group-pinned: pushed pin flag survives replay',
        resolved?.pinned === true, JSON.stringify(resolved));
}

// ---------------------------------------------------------------------------
// TAB-ORDER REGRESSION: a remote append (group [A,B,C] + remote add X at end) must
// yield ONE tabsToCreate (X) and ZERO tabsToMove for A/B/C — i.e. the receiving side
// does not re-shuffle its existing tabs. Local already has A,B,C in group order.
// ---------------------------------------------------------------------------
{
    const pulledSnapshot = {groups: [{id: 'g1', title: 'G1', tabs: [
        {uid: 'A', index: 0}, {uid: 'B', index: 1}, {uid: 'C', index: 2},
    ]}], watermark: {}};
    const pulledDeltaLogs = [{deviceId: REMOTE, events: [
        {seq: 1, ts: 100, op: 'tab.add', groupId: 'g1', tab: {uid: 'X', url: 'http://x', index: 3}},
    ]}];
    // local mirrors the base in group order (group-relative indices 0,1,2)
    const localState = {groups: [{id: 'g1', title: 'G1', tabs: [
        {uid: 'A', id: 1, index: 0}, {uid: 'B', id: 2, index: 1}, {uid: 'C', id: 3, index: 2},
    ]}]};

    const {browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs, localPendingEvents: [], selfDeviceId: SELF, localState,
    });

    check('append add: exactly one tabsToCreate',
        browserOps.tabsToCreate.length === 1 && browserOps.tabsToCreate[0].uid === 'X',
        JSON.stringify(browserOps.tabsToCreate.map(t => t.uid)));
    check('append add: created X targets group-relative index 3',
        browserOps.tabsToCreate[0].target.index === 3, JSON.stringify(browserOps.tabsToCreate[0].target));
    check('append add: ZERO tabsToMove for existing A/B/C',
        browserOps.tabsToMove.length === 0, JSON.stringify(browserOps.tabsToMove));
}

// ---------------------------------------------------------------------------
// GROUP ORDER — remote reorder. Base/local group order [G1,G2,G3]; a remote
// group.modify event sequence does not by itself reorder, so we drive the resolved
// order via the BASE snapshot order [G3,G1,G2] (the authoritative order). Local is
// [G1,G2,G3] → diff must emit groupsOrder = [G3,G1,G2].
// ---------------------------------------------------------------------------
{
    const pulledSnapshot = {groups: [
        {id: 'G3', title: 'G3', tabs: []},
        {id: 'G1', title: 'G1', tabs: []},
        {id: 'G2', title: 'G2', tabs: []},
    ], watermark: {}};
    const localState = {groups: [
        {id: 'G1', title: 'G1', tabs: []},
        {id: 'G2', title: 'G2', tabs: []},
        {id: 'G3', title: 'G3', tabs: []},
    ]};

    const {browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF, localState,
    });

    check('reorder: groupsOrder = resolved order [G3,G1,G2]',
        JSON.stringify(browserOps.groupsOrder) === JSON.stringify(['G3', 'G1', 'G2']),
        JSON.stringify(browserOps.groupsOrder));
    check('reorder: no spurious group create/remove',
        browserOps.groupsToCreate.length === 0 && browserOps.groupsToRemove.length === 0);
}

// ---------------------------------------------------------------------------
// GROUP ORDER — same order ⇒ no reorder (groupsOrder null). Identity-only.
// ---------------------------------------------------------------------------
{
    const pulledSnapshot = {groups: [
        {id: 'G1', title: 'G1', tabs: []}, {id: 'G2', title: 'G2', tabs: []},
    ], watermark: {}};
    const localState = {groups: [
        {id: 'G1', title: 'G1', tabs: []}, {id: 'G2', title: 'G2', tabs: []},
    ]};
    const {browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF, localState,
    });
    check('same order: groupsOrder is null', browserOps.groupsOrder === null,
        JSON.stringify(browserOps.groupsOrder));
}

// ---------------------------------------------------------------------------
// GROUP ORDER — a new remote group appends (resolved order [G1,G2,Gnew]); the
// shared groups [G1,G2] are already in order, so groupsOrder stays null (creation,
// not reorder), and Gnew surfaces as groupsToCreate.
// ---------------------------------------------------------------------------
{
    const pulledSnapshot = {groups: [
        {id: 'G1', title: 'G1', tabs: []},
        {id: 'G2', title: 'G2', tabs: []},
        {id: 'Gnew', title: 'Gnew', tabs: []},
    ], watermark: {}};
    const localState = {groups: [
        {id: 'G1', title: 'G1', tabs: []}, {id: 'G2', title: 'G2', tabs: []},
    ]};
    const {browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF, localState,
    });
    check('new remote group: groupsToCreate has Gnew',
        browserOps.groupsToCreate.length === 1 && browserOps.groupsToCreate[0].id === 'Gnew');
    check('new remote group: shared order unchanged ⇒ groupsOrder null',
        browserOps.groupsOrder === null, JSON.stringify(browserOps.groupsOrder));
}

// ---------------------------------------------------------------------------
// GROUP ORDER — reorder + local-only group must NOT be lost by the reorder. Resolved
// order [G2,G1]; local [G1,G2,Glocal] where Glocal is never-synced (not in baseline,
// so not removed). groupsOrder = [G2,G1]; the transport's reorderGroups (tested below
// inline) keeps Glocal appended at the end.
// ---------------------------------------------------------------------------
{
    const pulledSnapshot = {groups: [
        {id: 'G2', title: 'G2', tabs: []}, {id: 'G1', title: 'G1', tabs: []},
    ], watermark: {}};
    const localState = {groups: [
        {id: 'G1', title: 'G1', tabs: []},
        {id: 'G2', title: 'G2', tabs: []},
        {id: 'Glocal', title: 'Glocal', tabs: []},
    ]};
    const {browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF, localState,
    });
    check('reorder w/ local-only: groupsOrder = [G2,G1]',
        JSON.stringify(browserOps.groupsOrder) === JSON.stringify(['G2', 'G1']),
        JSON.stringify(browserOps.groupsOrder));
    check('reorder w/ local-only: Glocal not removed (never synced)',
        browserOps.groupsToRemove.length === 0, JSON.stringify(browserOps.groupsToRemove));

    // mirror of delta-sync.js reorderGroups: place ordered ids first, append the rest.
    const reorderGroups = (groups, order) => {
        const byId = new Map(groups.map(g => [g.id, g]));
        const placed = new Set();
        const result = [];
        for (const id of order) {
            const g = byId.get(id);
            if (g && !placed.has(id)) { result.push(g); placed.add(id); }
        }
        for (const g of groups) {
            if (!placed.has(g.id)) { result.push(g); placed.add(g.id); }
        }
        return result;
    };
    const saved = reorderGroups(localState.groups, browserOps.groupsOrder).map(g => g.id);
    check('reorder w/ local-only: saved order = [G2,G1,Glocal] (local-only kept last)',
        JSON.stringify(saved) === JSON.stringify(['G2', 'G1', 'Glocal']), JSON.stringify(saved));
}

// ---------------------------------------------------------------------------
// ARCHIVED GROUP INBOUND CREATE — a remote archived group absent locally must be
// created WITH its snapshot tabs carried on groupsToCreate, and its tabs must NOT
// be spawned as live tabs (no windowId): they stay OUT of tabsToCreate.
// ---------------------------------------------------------------------------
{
    const pulledSnapshot = {
        groups: [{
            id: 'gArch', title: 'Archived', isArchive: true,
            tabs: [
                {uid: 'a1', url: 'http://a1', title: 'A1', index: 0, lastModified: 10},
                {uid: 'a2', url: 'http://a2', title: 'A2', index: 1, lastModified: 20},
            ],
        }],
        watermark: {},
    };
    const localState = {groups: []};

    const {browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF, localState,
    });

    const createdGroup = browserOps.groupsToCreate.find(g => g.id === 'gArch');
    check('archived inbound create: group appears in groupsToCreate with isArchive',
        !!createdGroup && createdGroup.isArchive === true, JSON.stringify(browserOps.groupsToCreate));
    check('archived inbound create: groupsToCreate carries the snapshot tabs',
        Array.isArray(createdGroup?.tabs) && createdGroup.tabs.length === 2
            && createdGroup.tabs.every(t => ['a1', 'a2'].includes(t.uid)),
        JSON.stringify(createdGroup?.tabs));
    check('archived inbound create: archived tabs are NOT spawned as live tabsToCreate',
        !browserOps.tabsToCreate.some(t => t.uid === 'a1' || t.uid === 'a2'),
        JSON.stringify(browserOps.tabsToCreate));
}

// A remote NON-archived group inbound create keeps carrying NO tabs on groupsToCreate
// (byte-identical to prior behavior) and its tabs DO surface in tabsToCreate.
{
    const pulledSnapshot = {
        groups: [{
            id: 'gLive', title: 'Live', tabs: [{uid: 'l1', url: 'http://l1', index: 0}],
        }],
        watermark: {},
    };
    const localState = {groups: []};

    const {browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF, localState,
    });

    const createdGroup = browserOps.groupsToCreate.find(g => g.id === 'gLive');
    check('live inbound create: groupsToCreate carries NO tabs key',
        !!createdGroup && !('tabs' in createdGroup), JSON.stringify(createdGroup));
    check('live inbound create: its tab DOES surface in tabsToCreate',
        browserOps.tabsToCreate.some(t => t.uid === 'l1'), JSON.stringify(browserOps.tabsToCreate));
}

// ---------------------------------------------------------------------------
// purity: planSync must not mutate its inputs.
// ---------------------------------------------------------------------------
{
    const pulledSnapshot = {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', index: 0}]}], watermark: {}};
    const pulledDeltaLogs = [{deviceId: REMOTE, events: [{seq: 1, ts: 100, op: 'tab.remove', groupId: 'g1', uid: 't1'}]}];
    const localPendingEvents = [{seq: 1, ts: 50, op: 'tab.add', groupId: 'g1', tab: {uid: 't9', index: 1}}];
    const localState = {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', index: 0}]}]};

    const snap = JSON.stringify(pulledSnapshot);
    const logs = JSON.stringify(pulledDeltaLogs);
    const pend = JSON.stringify(localPendingEvents);
    const local = JSON.stringify(localState);

    planSync({pulledSnapshot, pulledDeltaLogs, localPendingEvents, selfDeviceId: SELF, localState});

    check('planSync does not mutate pulledSnapshot', JSON.stringify(pulledSnapshot) === snap);
    check('planSync does not mutate pulledDeltaLogs', JSON.stringify(pulledDeltaLogs) === logs);
    check('planSync does not mutate localPendingEvents', JSON.stringify(localPendingEvents) === pend);
    check('planSync does not mutate localState', JSON.stringify(localState) === local);
}

// ---------------------------------------------------------------------------
// OPTIONS: synced-key predicate — sync*/autoBackup* are local-only, the rest sync.
// ---------------------------------------------------------------------------
{
    check('predicate: syncProvider is NOT synced', isSyncedOptionKey('syncProvider') === false);
    check('predicate: syncEnable is NOT synced', isSyncedOptionKey('syncEnable') === false);
    check('predicate: autoBackupEnable is NOT synced', isSyncedOptionKey('autoBackupEnable') === false);
    check('predicate: autoBackupFilePath is NOT synced', isSyncedOptionKey('autoBackupFilePath') === false);
    check('predicate: defaultGroupProps IS synced', isSyncedOptionKey('defaultGroupProps') === true);
    check('predicate: hotkeys IS synced', isSyncedOptionKey('hotkeys') === true);
    check('predicate: colorScheme IS synced', isSyncedOptionKey('colorScheme') === true);

    const filtered = syncedOptionKeys(['colorScheme', 'syncProvider', 'autoBackupEnable', 'hotkeys', 'defaultGroupProps']);
    check('syncedOptionKeys: drops sync*/autoBackup*, keeps the rest',
        JSON.stringify(filtered) === JSON.stringify(['colorScheme', 'hotkeys', 'defaultGroupProps']),
        JSON.stringify(filtered));
}

// ---------------------------------------------------------------------------
// OPTIONS: a key changed REMOTELY appears in optionsToApply; unchanged keys absent.
// ---------------------------------------------------------------------------
{
    const pulledSnapshot = {groups: [], options: {}, watermark: {}};
    const pulledDeltaLogs = [{deviceId: REMOTE, events: [
        {seq: 1, ts: 100, op: 'option.set', key: 'colorScheme', value: 'dark'},
    ]}];
    const localState = {groups: [], options: {colorScheme: 'light', fullPopupWidth: false}};

    const plan = planSync({pulledSnapshot, pulledDeltaLogs, localPendingEvents: [], selfDeviceId: SELF, localState});

    check('optionsToApply contains remotely-changed key', plan.optionsToApply.colorScheme === 'dark',
        JSON.stringify(plan.optionsToApply));
    check('optionsToApply omits unchanged local-only key (fullPopupWidth)',
        !('fullPopupWidth' in plan.optionsToApply), JSON.stringify(plan.optionsToApply));
}

// resolved value equal to local ⇒ NOT in optionsToApply (no spurious write)
{
    const pulledSnapshot = {groups: [], options: {}, watermark: {}};
    const pulledDeltaLogs = [{deviceId: REMOTE, events: [
        {seq: 1, ts: 100, op: 'option.set', key: 'colorScheme', value: 'dark'},
    ]}];
    const localState = {groups: [], options: {colorScheme: 'dark'}};

    const plan = planSync({pulledSnapshot, pulledDeltaLogs, localPendingEvents: [], selfDeviceId: SELF, localState});
    check('optionsToApply omits key whose resolved == local',
        Object.keys(plan.optionsToApply).length === 0, JSON.stringify(plan.optionsToApply));
}

// SECURITY: option.set for local-only keys in a (tampered) pulled log ⇒ never applied
{
    const pulledSnapshot = {groups: [], options: {}, watermark: {}};
    const pulledDeltaLogs = [{deviceId: REMOTE, events: [
        {seq: 1, ts: 100, op: 'option.set', key: 'syncBackupBeforeApply', value: false},
        {seq: 2, ts: 101, op: 'option.set', key: 'autoSyncEnable', value: true},
        {seq: 3, ts: 102, op: 'option.set', key: 'autoBackupEnable', value: false},
        {seq: 4, ts: 103, op: 'option.set', key: 'colorScheme', value: 'dark'},
    ]}];
    const localState = {groups: [], options: {syncBackupBeforeApply: true, autoSyncEnable: false, autoBackupEnable: true, colorScheme: 'light'}};

    const plan = planSync({pulledSnapshot, pulledDeltaLogs, localPendingEvents: [], selfDeviceId: SELF, localState});

    check('optionsToApply drops local-only key syncBackupBeforeApply from tampered log',
        !('syncBackupBeforeApply' in plan.optionsToApply), JSON.stringify(plan.optionsToApply));
    check('optionsToApply drops local-only key autoSyncEnable from tampered log',
        !('autoSyncEnable' in plan.optionsToApply), JSON.stringify(plan.optionsToApply));
    check('optionsToApply drops local-only key autoBackupEnable from tampered log',
        !('autoBackupEnable' in plan.optionsToApply), JSON.stringify(plan.optionsToApply));
    check('optionsToApply still applies synced key alongside dropped ones',
        plan.optionsToApply.colorScheme === 'dark', JSON.stringify(plan.optionsToApply));
}

// SECURITY: local-only options carried by the pulled snapshot itself ⇒ never applied
{
    const pulledSnapshot = {groups: [], options: {syncProvider: 'evil', autoBackupFilePath: '../../etc', colorScheme: 'dark'}, watermark: {}};
    const localState = {groups: [], options: {syncProvider: 'github-gist', autoBackupFilePath: 'STG-backups/', colorScheme: 'light'}};

    const plan = planSync({pulledSnapshot, pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF, localState});

    check('optionsToApply drops local-only keys carried by the snapshot',
        !('syncProvider' in plan.optionsToApply) && !('autoBackupFilePath' in plan.optionsToApply),
        JSON.stringify(plan.optionsToApply));
    check('optionsToApply keeps synced key carried by the snapshot',
        plan.optionsToApply.colorScheme === 'dark', JSON.stringify(plan.optionsToApply));
}

// object-valued option diff by content (defaultGroupProps)
{
    const pulledSnapshot = {groups: [], options: {}, watermark: {}};
    const pulledDeltaLogs = [{deviceId: REMOTE, events: [
        {seq: 1, ts: 100, op: 'option.set', key: 'defaultGroupProps', value: {iconColor: 'blue'}},
    ]}];
    const localState = {groups: [], options: {defaultGroupProps: {iconColor: 'red'}}};

    const plan = planSync({pulledSnapshot, pulledDeltaLogs, localPendingEvents: [], selfDeviceId: SELF, localState});
    check('optionsToApply diffs object value by content',
        JSON.stringify(plan.optionsToApply.defaultGroupProps) === JSON.stringify({iconColor: 'blue'}),
        JSON.stringify(plan.optionsToApply));
}

// ---------------------------------------------------------------------------
// OPTIONS BOOTSTRAP: synced local option keys not in baseline/log ⇒ option.set events.
// ---------------------------------------------------------------------------
{
    const localState = {groups: [], options: {colorScheme: 'dark', fullPopupWidth: true}};
    const events = computeBootstrapEvents(localState, undefined, undefined, undefined, undefined);

    const optSets = events.filter(e => e.op === 'option.set');
    check('bootstrap: emits option.set for each local option on empty baseline',
        optSets.length === 2, JSON.stringify(optSets));
    const byKey = Object.fromEntries(optSets.map(e => [e.key, e.value]));
    check('bootstrap: option.set carries colorScheme value', byKey.colorScheme === 'dark', JSON.stringify(byKey));
    check('bootstrap: option.set carries fullPopupWidth value', byKey.fullPopupWidth === true, JSON.stringify(byKey));
}

// bootstrap idempotency: key in baseline OR already logged ⇒ no option.set
{
    const localState = {groups: [], options: {colorScheme: 'dark', fullPopupWidth: true}};
    const baseline = {tabUids: [], groupIds: [], optionKeys: ['colorScheme']};
    const events = computeBootstrapEvents(localState, baseline, [], [], ['fullPopupWidth']);
    const optSets = events.filter(e => e.op === 'option.set');
    check('bootstrap: skips option in baseline AND option already logged',
        optSets.length === 0, JSON.stringify(optSets));
}

// baselineFromSnapshot collects option keys
{
    const snapshot = {groups: [{id: 'g1', tabs: [{uid: 't1'}]}], options: {colorScheme: 'dark', hotkeys: []}};
    const baseline = baselineFromSnapshot(snapshot);
    check('baselineFromSnapshot collects optionKeys',
        JSON.stringify(baseline.optionKeys.sort()) === JSON.stringify(['colorScheme', 'hotkeys']),
        JSON.stringify(baseline.optionKeys));
}

// ---------------------------------------------------------------------------
// PINNED TABS — flat global list keyed by uid; baseline-gated removal like group tabs.
// ---------------------------------------------------------------------------

// pinned: a remote pinned.add not present locally → pinnedToCreate {target:{index}}.
{
    const pulledSnapshot = {groups: [], pinnedTabs: [], watermark: {}};
    const pulledDeltaLogs = [
        {deviceId: REMOTE, events: [
            {seq: 1, ts: 100, op: 'pinned.add', tab: {uid: 'p1', url: 'http://p1', index: 0}},
        ]},
    ];
    const localState = {groups: [], pinnedTabs: []};

    const {browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs, localPendingEvents: [], selfDeviceId: SELF, localState,
    });

    const created = browserOps.pinnedToCreate.find(t => t.uid === 'p1');
    check('remote pinned.add appears in pinnedToCreate', !!created, JSON.stringify(browserOps.pinnedToCreate));
    check('pinnedToCreate carries target {index} and no groupId',
        created?.target?.index === 0 && created?.target?.groupId === undefined, JSON.stringify(created));
    check('pinned create does NOT leak into tabsToCreate (not a group tab)',
        !browserOps.tabsToCreate.some(t => t.uid === 'p1'), JSON.stringify(browserOps.tabsToCreate));
}

// pinned: local pinned tab gone from resolved AND in baseline.pinnedUids → pinnedToRemove.
{
    const pulledSnapshot = {groups: [], pinnedTabs: [{uid: 'p1', url: 'http://p1', index: 0}], watermark: {}};
    const pulledDeltaLogs = [
        {deviceId: REMOTE, events: [
            {seq: 1, ts: 100, op: 'pinned.remove', uid: 'p1'},
        ]},
    ];
    const localState = {groups: [], pinnedTabs: [{uid: 'p1', url: 'http://p1', index: 0}]};

    const {browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs, localPendingEvents: [], selfDeviceId: SELF, localState,
        priorBaseline: {pinnedUids: ['p1']}, // p1 was synced before ⇒ delete elsewhere ⇒ remove
    });

    check('cloud-known pinned removed elsewhere IS in pinnedToRemove',
        browserOps.pinnedToRemove.some(t => t.uid === 'p1'), JSON.stringify(browserOps.pinnedToRemove));
}

// pinned: a LOCAL-ONLY pinned tab the device never synced is KEPT (baseline gate).
{
    const pulledSnapshot = {groups: [], pinnedTabs: [], watermark: {}};
    const localState = {groups: [], pinnedTabs: [{uid: 'pLocal', url: 'http://x', index: 0}]};

    const {browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF, localState,
        priorBaseline: {pinnedUids: []}, // never synced ⇒ keep, never remove
    });

    check('local-only pinned NOT removed (baseline gate)',
        !browserOps.pinnedToRemove.some(t => t.uid === 'pLocal'), JSON.stringify(browserOps.pinnedToRemove));
}

// pinned: a pinned tab at a different index both sides → pinnedToMove {target:{index}}.
{
    const pulledSnapshot = {
        groups: [],
        pinnedTabs: [{uid: 'p1', index: 0}, {uid: 'p2', index: 1}],
        watermark: {},
    };
    const pulledDeltaLogs = [
        {deviceId: REMOTE, events: [
            {seq: 1, ts: 100, op: 'pinned.move', uid: 'p2', toIndex: 0},
        ]},
    ];
    const localState = {groups: [], pinnedTabs: [{uid: 'p1', index: 0}, {uid: 'p2', index: 1}]};

    const {browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs, localPendingEvents: [], selfDeviceId: SELF, localState,
    });

    // resolved order is p2(0), p1(1); both indices differ from local ⇒ both move.
    const movedP2 = browserOps.pinnedToMove.find(t => t.uid === 'p2');
    check('reordered pinned tab appears in pinnedToMove', !!movedP2, JSON.stringify(browserOps.pinnedToMove));
    check('pinnedToMove carries target {index}', movedP2?.target?.index === 0, JSON.stringify(movedP2));
}

// pinned modify-beats-delete resurrects: self removed a pinned tab, remote modified it
// later → resolved keeps it; absent locally ⇒ pinnedToCreate; self pending push kept.
{
    const pulledSnapshot = {groups: [], pinnedTabs: [{uid: 'p1', url: 'http://p1', index: 0}], watermark: {}};
    const pulledDeltaLogs = [
        {deviceId: REMOTE, events: [
            {seq: 1, ts: 300, op: 'pinned.modify', tab: {uid: 'p1', url: 'http://p1b', index: 0}},
        ]},
    ];
    const localPendingEvents = [
        {seq: 1, ts: 100, op: 'pinned.remove', uid: 'p1'},
    ];
    const localState = {groups: [], pinnedTabs: []};

    const {resolvedSnapshot, browserOps, deltaFileToWrite} = planSync({
        pulledSnapshot, pulledDeltaLogs, localPendingEvents, selfDeviceId: SELF, localState,
    });

    const resolvedP1 = (resolvedSnapshot.pinnedTabs || []).find(t => t.uid === 'p1');
    check('pinned conflict: resolved resurrects p1 (modify beats delete)',
        !!resolvedP1 && resolvedP1.url === 'http://p1b', JSON.stringify(resolvedP1));
    check('pinned conflict: resurrected pinned surfaces in pinnedToCreate',
        browserOps.pinnedToCreate.some(t => t.uid === 'p1' && t.url === 'http://p1b'), JSON.stringify(browserOps.pinnedToCreate));
    check('pinned conflict: self pending pinned.remove is still pushed',
        !!deltaFileToWrite && deltaFileToWrite.events.some(e => e.op === 'pinned.remove' && e.uid === 'p1'),
        JSON.stringify(deltaFileToWrite));
}

// bootstrap: a local-only pinned tab on an EMPTY baseline emits a pinned.add.
{
    const localState = {groups: [], pinnedTabs: [{uid: 'pNew', url: 'http://pn', index: 0}]};
    const boot = computeBootstrapEvents(localState, {pinnedUids: []}, [], []);
    check('bootstrap emits pinned.add for local-only pinned on empty baseline',
        boot.some(e => e.op === 'pinned.add' && e.tab?.uid === 'pNew'), JSON.stringify(boot));
}

// bootstrap: pinned skipped when already in baseline.pinnedUids OR already in log uids.
{
    const localState = {groups: [], pinnedTabs: [{uid: 'pInBase', index: 0}, {uid: 'pInLog', index: 1}]};
    const boot = computeBootstrapEvents(localState, {pinnedUids: ['pInBase']}, ['pInLog'], []);
    check('bootstrap skips pinned in baseline', !boot.some(e => e.tab?.uid === 'pInBase'), JSON.stringify(boot));
    check('bootstrap skips pinned already logged (uid namespace)', !boot.some(e => e.tab?.uid === 'pInLog'), JSON.stringify(boot));
}

// baselineFromSnapshot collects pinned uids.
{
    const snapshot = {groups: [{id: 'g1', tabs: [{uid: 't1'}]}], pinnedTabs: [{uid: 'p1'}, {uid: 'p2'}]};
    const baseline = baselineFromSnapshot(snapshot);
    check('baselineFromSnapshot collects pinnedUids',
        JSON.stringify(baseline.pinnedUids.sort()) === JSON.stringify(['p1', 'p2']), JSON.stringify(baseline.pinnedUids));
}

// BASELINE PERSISTENCE ROUND-TRIP (regression): the transport persists the baseline as
// JSON arrays and reloads it next round; `pinnedUids` MUST survive that round-trip, or the
// pinned removal gate (in baseline AND absent from resolved ⇒ remove) can never fire and a
// pinned tab deleted on another device is never removed here. This mirrors delta-sync.js
// saveBaseline/loadBaseline inline (those live in the impure transport, untestable under
// node) and then feeds the reloaded baseline through planSync to prove removal propagates.
{
    // mirror of delta-sync.js saveBaseline → JSON → loadBaseline (the persisted shape).
    const saveBaseline = b => JSON.stringify({
        tabUids: b.tabUids || [], groupIds: b.groupIds || [],
        optionKeys: b.optionKeys || [], pinnedUids: b.pinnedUids || [],
    });
    const loadBaseline = raw => {
        const p = JSON.parse(raw);
        return {
            tabUids: p.tabUids || [], groupIds: p.groupIds || [],
            optionKeys: p.optionKeys || [], pinnedUids: p.pinnedUids || [],
        };
    };

    // round 1 reconciled a global pinned tab p1 as synced → baseline must remember it.
    const resolvedAfterRound1 = {groups: [], pinnedTabs: [{uid: 'p1', url: 'http://p1', index: 0}]};
    const persisted = saveBaseline(baselineFromSnapshot(resolvedAfterRound1));
    const reloaded = loadBaseline(persisted);
    check('baseline persistence: pinnedUids survives the save→JSON→load round-trip',
        Array.isArray(reloaded.pinnedUids) && reloaded.pinnedUids.includes('p1'), persisted);

    // round 2: another device removed p1; resolved no longer has it. With pinnedUids
    // correctly reloaded, the removal gate fires (without it, the bug, p1 leaks forever).
    const pulledSnapshot = {groups: [], pinnedTabs: [], watermark: {}};
    const localState = {groups: [], pinnedTabs: [{uid: 'p1', url: 'http://p1', index: 0}]};
    const {browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF, localState,
        priorBaseline: reloaded,
    });
    check('baseline persistence: reloaded pinnedUids lets a deleted-elsewhere pinned tab be removed',
        browserOps.pinnedToRemove.some(t => t.uid === 'p1'), JSON.stringify(browserOps.pinnedToRemove));
}

// ---------------------------------------------------------------------------
// TU1. tabsToUpdate: a CONTENT change (url/title/favIcon) to a tab that ALREADY exists
//   locally is emitted as a tabsToUpdate op (the half-wired-sync fix). No spurious move.
// ---------------------------------------------------------------------------
{
    const pulledSnapshot = {
        groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://new', title: 'New', favIconUrl: 'data:fav2', index: 0}]}],
        watermark: {},
    };
    const localState = {
        groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://old', title: 'Old', favIconUrl: 'data:fav1', index: 0}]}],
    };
    const {browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF, localState,
    });
    const upd = browserOps.tabsToUpdate.find(u => u.uid === 't1');
    check('tabsToUpdate emitted for a content change to an EXISTING tab', !!upd, JSON.stringify(browserOps.tabsToUpdate));
    check('tabsToUpdate carries the changed url/title (favIcon is NOT a change-trigger)',
        upd && upd.target.url === 'http://new' && upd.target.title === 'New' && !('favIconUrl' in upd.target),
        JSON.stringify(upd));
    check('tabsToUpdate does NOT spuriously move a tab whose placement is unchanged',
        !browserOps.tabsToMove.some(m => m.uid === 't1'), JSON.stringify(browserOps.tabsToMove));
    check('tabsToCreate is empty for an existing-tab content change',
        !browserOps.tabsToCreate.some(t => t.uid === 't1'), JSON.stringify(browserOps.tabsToCreate));
}

// TU1b. favicon CHURN guard: a favicon-ONLY difference (url/title/everything else equal)
//   must NOT emit a tabsToUpdate — buildLocalState reads the live favicon while the cloud
//   snapshot holds a possibly-folded value, so triggering on it would churn every cycle.
//   A real url/title difference (with the same favicon difference present) STILL emits.
{
    // favicon-only diff ⇒ no op (group tab AND pinned tab).
    const faviconOnly = planSync({
        pulledSnapshot: {
            groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://x', title: 'X', favIconUrl: 'data:fav2', index: 0}]}],
            pinnedTabs: [{uid: 'p1', url: 'http://p', title: 'P', favIconUrl: 'data:pf2', index: 0}],
            watermark: {},
        },
        pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF,
        localState: {
            groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://x', title: 'X', favIconUrl: 'data:fav1', index: 0}]}],
            pinnedTabs: [{uid: 'p1', url: 'http://p', title: 'P', favIconUrl: 'data:pf1', index: 0}],
        },
    });
    check('favicon-only difference emits NO tabsToUpdate (group tab)',
        !faviconOnly.browserOps.tabsToUpdate.some(u => u.uid === 't1'),
        JSON.stringify(faviconOnly.browserOps.tabsToUpdate));
    check('favicon-only difference emits NO pinnedToUpdate (pinned tab)',
        !faviconOnly.browserOps.pinnedToUpdate.some(u => u.uid === 'p1'),
        JSON.stringify(faviconOnly.browserOps.pinnedToUpdate));

    // a real url/title diff (favicon also differs) STILL emits — favicon just rides along absent.
    const realChange = planSync({
        pulledSnapshot: {
            groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://new', title: 'New', favIconUrl: 'data:fav2', index: 0}]}],
            watermark: {},
        },
        pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF,
        localState: {
            groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://old', title: 'Old', favIconUrl: 'data:fav1', index: 0}]}],
        },
    });
    const ru = realChange.browserOps.tabsToUpdate.find(u => u.uid === 't1');
    check('a url/title difference STILL emits a tabsToUpdate (favicon excluded from target)',
        ru && ru.target.url === 'http://new' && ru.target.title === 'New' && !('favIconUrl' in ru.target),
        JSON.stringify(ru));
}

// TU2. an unchanged existing tab emits NO tabsToUpdate (no churn). A tab that ALSO moved
//   AND changed content appears in BOTH tabsToMove and tabsToUpdate.
{
    // `indexTabs` keys index by ARRAY POSITION, so to make `moved` differ in placement we
    // put it at a different array slot on each side (resolved: pos 0; local: pos 1).
    const pulledSnapshot = {
        groups: [{id: 'g1', title: 'G1', tabs: [
            {uid: 'moved', url: 'http://changed', title: 'Changed'},
            {uid: 'same', url: 'http://x', title: 'X'},
        ]}],
        watermark: {},
    };
    const localState = {
        groups: [{id: 'g1', title: 'G1', tabs: [
            {uid: 'same', url: 'http://x', title: 'X'},
            {uid: 'moved', url: 'http://orig', title: 'Orig'}, // different array slot AND content
        ]}],
    };
    const {browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF, localState,
    });
    check('no tabsToUpdate for an unchanged existing tab',
        !browserOps.tabsToUpdate.some(u => u.uid === 'same'), JSON.stringify(browserOps.tabsToUpdate));
    check('a moved+changed tab is in BOTH tabsToMove and tabsToUpdate',
        browserOps.tabsToMove.some(m => m.uid === 'moved') && browserOps.tabsToUpdate.some(u => u.uid === 'moved'),
        JSON.stringify({move: browserOps.tabsToMove, update: browserOps.tabsToUpdate}));
}

// TU3. group-pin FLIP round-trips: a remote tab.modify flipping pinned true→false replays
//   to pinned:false and the planner emits a tabsToUpdate {pinned:false} against a locally
//   still-pinned tab (emit → replay/diff → apply-op). And true→true is a no-op.
{
    // base already has the tab pinned (as a prior synced state); a remote modify un-pins it.
    const pulledSnapshot = {
        groups: [{id: 'g1', title: 'G1', tabs: [{uid: 'gp', url: 'http://gp', index: 0, pinned: true}]}],
        watermark: {},
    };
    const pulledDeltaLogs = [
        {deviceId: REMOTE, events: [
            {seq: 1, ts: 500, op: 'tab.modify', groupId: 'g1', tab: {uid: 'gp', url: 'http://gp', index: 0, pinned: false}},
        ]},
    ];
    const localState = {
        groups: [{id: 'g1', title: 'G1', tabs: [{uid: 'gp', url: 'http://gp', index: 0, pinned: true}]}],
    };
    const {resolvedSnapshot, browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs, localPendingEvents: [], selfDeviceId: SELF, localState,
    });
    const resolvedTab = resolvedSnapshot.groups[0].tabs.find(t => t.uid === 'gp');
    check('group-pin flip: remote un-pin replays to pinned:false', resolvedTab?.pinned === false, JSON.stringify(resolvedTab));
    const upd = browserOps.tabsToUpdate.find(u => u.uid === 'gp');
    check('group-pin flip: planner emits tabsToUpdate {pinned:false} for the still-pinned local tab',
        upd && upd.target.pinned === false, JSON.stringify(upd));

    // reverse: resolved pinned:true, local already pinned:true ⇒ no pinned change emitted.
    const noChange = planSync({
        pulledSnapshot, pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF,
        localState: {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 'gp', url: 'http://gp', index: 0, pinned: true}]}]},
    });
    check('group-pin flip: no tabsToUpdate when local and resolved pin states match',
        !noChange.browserOps.tabsToUpdate.some(u => u.uid === 'gp'), JSON.stringify(noChange.browserOps.tabsToUpdate));
}

// TU4. additive-flag normalization: a resolved tab WITHOUT pinned vs a local tab WITHOUT
//   pinned must NOT manufacture a pinned change (absent == false). Only a genuine on/off
//   transition (or a real content change) emits an op.
{
    const pulledSnapshot = {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't', url: 'http://x', title: 'X', index: 0}]}], watermark: {}};
    const localState = {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't', url: 'http://x', title: 'X', index: 0}]}]};
    const {browserOps} = planSync({pulledSnapshot, pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF, localState});
    check('absent-vs-absent additive flags do not manufacture a tabsToUpdate',
        !browserOps.tabsToUpdate.length, JSON.stringify(browserOps.tabsToUpdate));
}

// TU5. pinnedToUpdate: a CONTENT change to an EXISTING global pinned tab is emitted, with
//   the group-pin/loaded flags filtered out (they don't apply to a global pinned tab).
{
    const pulledSnapshot = {
        groups: [],
        pinnedTabs: [{uid: 'p1', url: 'http://p1-new', title: 'P1 New', favIconUrl: 'data:pf2', index: 0, loaded: true}],
        watermark: {},
    };
    const localState = {
        groups: [],
        pinnedTabs: [{uid: 'p1', url: 'http://p1-old', title: 'P1 Old', favIconUrl: 'data:pf1', index: 0}],
    };
    const {browserOps} = planSync({pulledSnapshot, pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF, localState});
    const upd = browserOps.pinnedToUpdate.find(u => u.uid === 'p1');
    check('pinnedToUpdate emitted for a content change to an existing global pinned tab', !!upd, JSON.stringify(browserOps.pinnedToUpdate));
    check('pinnedToUpdate carries url/title (favIcon is NOT a change-trigger)', upd && upd.target.url === 'http://p1-new'
        && upd.target.title === 'P1 New' && !('favIconUrl' in upd.target), JSON.stringify(upd));
    check('pinnedToUpdate filters out the loaded flag (not applicable to global pinned)',
        upd && !('loaded' in upd.target) && !('pinned' in upd.target), JSON.stringify(upd));
    check('pinnedToUpdate does not spuriously move/create the tab',
        !browserOps.pinnedToMove.some(m => m.uid === 'p1') && !browserOps.pinnedToCreate.some(t => t.uid === 'p1'),
        JSON.stringify({move: browserOps.pinnedToMove, create: browserOps.pinnedToCreate}));
}

// TU6. CLOBBER-SAFETY through the full planner: a remote tab.modify that OMITS pinned must
//   not wipe a previously-synced pinned:true (preserved by replay), so the planner sees
//   resolved pinned:true and — local also pinned:true — emits NO un-pin. But a remote modify
//   carrying EXPLICIT pinned:false DOES un-pin (resolved false ⇒ tabsToUpdate {pinned:false}).
{
    const base = {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 'gp', url: 'http://gp', index: 0, pinned: true}]}], watermark: {}};
    const localState = {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 'gp', url: 'http://gp', index: 0, pinned: true}]}]};

    // (a) unrelated content modify OMITS pinned ⇒ preserved ⇒ no un-pin.
    const omit = planSync({
        pulledSnapshot: base,
        pulledDeltaLogs: [{deviceId: REMOTE, events: [
            {seq: 1, ts: 700, op: 'tab.modify', groupId: 'g1', tab: {uid: 'gp', url: 'http://gp-new', index: 0}},
        ]}],
        localPendingEvents: [], selfDeviceId: SELF, localState,
    });
    const omitResolved = omit.resolvedSnapshot.groups[0].tabs.find(t => t.uid === 'gp');
    check('clobber-safe: a content modify omitting pinned preserves resolved pinned:true', omitResolved?.pinned === true, JSON.stringify(omitResolved));
    check('clobber-safe: no spurious un-pin emitted (no pinned key in tabsToUpdate)',
        !omit.browserOps.tabsToUpdate.some(u => 'pinned' in (u.target || {})), JSON.stringify(omit.browserOps.tabsToUpdate));
    check('clobber-safe: the omitting modify still propagates its url change',
        omit.browserOps.tabsToUpdate.some(u => u.uid === 'gp' && u.target.url === 'http://gp-new'), JSON.stringify(omit.browserOps.tabsToUpdate));

    // (b) explicit newer pinned:false ⇒ genuine un-pin propagates.
    const unpin = planSync({
        pulledSnapshot: base,
        pulledDeltaLogs: [{deviceId: REMOTE, events: [
            {seq: 1, ts: 700, op: 'tab.modify', groupId: 'g1', tab: {uid: 'gp', url: 'http://gp', index: 0, pinned: false}},
        ]}],
        localPendingEvents: [], selfDeviceId: SELF, localState,
    });
    const unpinResolved = unpin.resolvedSnapshot.groups[0].tabs.find(t => t.uid === 'gp');
    check('clobber-safe: an EXPLICIT newer pinned:false still un-pins (flag is clearable)', unpinResolved?.pinned === false, JSON.stringify(unpinResolved));
    check('clobber-safe: the genuine un-pin emits tabsToUpdate {pinned:false}',
        unpin.browserOps.tabsToUpdate.some(u => u.uid === 'gp' && u.target.pinned === false), JSON.stringify(unpin.browserOps.tabsToUpdate));
}

// ---------------------------------------------------------------------------
// REGRESSION (group-normal-tabs sync data loss): a NORMAL (non-pinned) grouped tab
// present in localState but absent from baseline+log MUST bootstrap as a tab.add, the
// same as a group-pinned tab in the same group. The original bug was that normal
// grouped tabs failed to replicate while group-pinned tabs did; this pins the pure
// seam so the normal tab can never be silently dropped from the pushed events.
// ---------------------------------------------------------------------------
{
    const localState = {groups: [{id: 'g1', title: 'G1', tabs: [
        {uid: 'normal1', url: 'http://normal', index: 0},                 // NORMAL grouped tab
        {uid: 'gpin1', url: 'http://gpin', index: 1, pinned: true},       // group-pinned tab
    ]}]};
    // g1 already synced (in baseline), both tabs are brand-new (NOT in baseline, NOT in log).
    const priorBaseline = {tabUids: [], groupIds: ['g1']};
    const boot = computeBootstrapEvents(localState, priorBaseline, [], ['g1']);

    check('group-normal-tabs regression: NORMAL grouped tab bootstraps as tab.add',
        boot.some(e => e.op === 'tab.add' && e.tab?.uid === 'normal1' && e.groupId === 'g1' && !e.tab.pinned),
        JSON.stringify(boot));
    check('group-normal-tabs regression: group-pinned tab also bootstraps (symmetric route)',
        boot.some(e => e.op === 'tab.add' && e.tab?.uid === 'gpin1' && e.groupId === 'g1' && e.tab.pinned === true),
        JSON.stringify(boot));

    // and once the normal tab's uid IS in this device's log (the explicit tab.add now
    // emitted by Tabs.move), bootstrap must NOT double-add it — idempotency holds.
    const bootAfterLog = computeBootstrapEvents(localState, priorBaseline, ['normal1'], ['g1']);
    check('group-normal-tabs regression: logged normal tab is NOT double-bootstrapped',
        !bootAfterLog.some(e => e.op === 'tab.add' && e.tab?.uid === 'normal1'),
        JSON.stringify(bootAfterLog));
}

// ---------------------------------------------------------------------------
// E2: RESET vs CLOUD-WATERMARK TRAP. After a local reset, this device re-issues low
// seqs while the cloud snapshot still carries watermark[self]=N. replay() (run inside
// planSync) dedups every event with seq <= watermark, so a re-issued add at a low seq
// is SILENTLY DROPPED — the bug. The fix fast-forwards the device's log strictly above
// the watermark, after which the SAME event survives. We observe this end-to-end through
// the resolved snapshot from a PEER's perspective (the peer pulls SELF's delta + the
// stale watermark, exactly the state replay dedups against).
// ---------------------------------------------------------------------------
{
    // stale cloud base: SELF folded up to seq 10; an existing tab t0 already in the base.
    const pulledSnapshot = {
        groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't0', url: 'http://0', index: 0}]}],
        watermark: {[SELF]: 10},
    };
    // peer (REMOTE) is planning; it has no local groups yet so it just absorbs the base + deltas.
    const localState = {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't0', url: 'http://0', index: 0}]}]};

    // TRAP: SELF re-issued its add at seq 2 (<= watermark 10) after a reset.
    const trapped = planSync({
        pulledSnapshot,
        pulledDeltaLogs: [{deviceId: SELF, events: [
            {seq: 2, ts: 200, op: 'tab.add', groupId: 'g1', tab: {uid: 'tNew', url: 'http://new', index: 1}},
        ]}],
        localPendingEvents: [],
        selfDeviceId: REMOTE,
        localState,
    });
    const trappedHasNew = (trapped.resolvedSnapshot.groups.find(g => g.id === 'g1')?.tabs || [])
        .some(t => t.uid === 'tNew');
    check('E2 trap reproduced: re-issued add at seq<=watermark is dedup-dropped', !trappedHasNew,
        JSON.stringify(trapped.resolvedSnapshot.groups));

    // CURED: the same add fast-forwarded above the watermark (to seq 11) now survives replay.
    const cured = planSync({
        pulledSnapshot,
        pulledDeltaLogs: [{deviceId: SELF, events: [
            {seq: 11, ts: 200, op: 'tab.add', groupId: 'g1', tab: {uid: 'tNew', url: 'http://new', index: 1}},
        ]}],
        localPendingEvents: [],
        selfDeviceId: REMOTE,
        localState,
    });
    const curedHasNew = (cured.resolvedSnapshot.groups.find(g => g.id === 'g1')?.tabs || [])
        .some(t => t.uid === 'tNew');
    check('E2 fix: add fast-forwarded above watermark survives replay', curedHasNew,
        JSON.stringify(cured.resolvedSnapshot.groups));
}

// ---------------------------------------------------------------------------
// REGRESSION (pinned-sync-leak H2): bootstrap must NOT emit a `pinned.add` for a uid that
// is also emitted as a group `tab.add` in the same bootstrap. A uid is EITHER a group tab
// OR a global pin, never both; a double-identity makes the peer create a DUPLICATE pinned
// copy of a tab that's also a group tab (the observed bitbucket×4 / claude×2 duplicates).
// ---------------------------------------------------------------------------
{
    // a leaked group-pinned tab (uid 'dup') appears in BOTH the group's tabs AND pinnedTabs.
    const localState = {
        groups: [{id: 'g1', title: 'G1', tabs: [
            {uid: 'dup', url: 'https://x', index: 0},
            {uid: 'onlyGroup', url: 'https://y', index: 1},
        ]}],
        pinnedTabs: [
            {uid: 'dup', url: 'https://x', index: 0},      // <- double identity (must be skipped)
            {uid: 'onlyPinned', url: 'https://z', index: 1}, // <- genuine global pin
        ],
    };
    const events = computeBootstrapEvents(localState, {}, [], [], []);

    const tabAdds = events.filter(e => e.op === 'tab.add').map(e => e.tab.uid);
    const pinAdds = events.filter(e => e.op === 'pinned.add').map(e => e.tab.uid);

    check('bootstrap: group tab.add emitted for the group-scoped uid', tabAdds.includes('dup'), JSON.stringify(tabAdds));
    check('bootstrap: NO duplicate pinned.add for a uid that is a group tab.add (H2)',
        !pinAdds.includes('dup'), JSON.stringify(pinAdds));
    check('bootstrap: a genuine global pin still bootstraps as pinned.add',
        pinAdds.includes('onlyPinned'), JSON.stringify(pinAdds));
    check('bootstrap: exactly one identity per uid (no dup across tab.add + pinned.add)',
        new Set([...tabAdds, ...pinAdds]).size === [...tabAdds, ...pinAdds].length,
        JSON.stringify({tabAdds, pinAdds}));
}

// ---------------------------------------------------------------------------
// REGRESSION (pinned-sync-leak H3): the pinned-order-churn case CONVERGES. With the leak
// fixed, the global pinned region is globals-only, so local pinned indices line up with the
// resolved snapshot's pinned order and the planner emits NO pinnedToMove. The pre-fix bug
// interleaved a leaked group-pinned tab into the local pinned set, shifting the globals'
// indices and emitting a perpetual pinnedToMove every cycle ("some tabs were not moved").
// ---------------------------------------------------------------------------
{
    // resolved (peer) global pinned order: [pa, pb, pc] at 0,1,2.
    const pulledSnapshot = {
        groups: [],
        pinnedTabs: [
            {uid: 'pa', url: 'https://a', index: 0},
            {uid: 'pb', url: 'https://b', index: 1},
            {uid: 'pc', url: 'https://c', index: 2},
        ],
        watermark: {},
    };

    // CONVERGED local state: same globals at the SAME indices (this is what getLivePinnedTabs
    // now yields — globals only, no leaked group-pinned tab shifting the slots).
    const convergedLocal = {groups: [], pinnedTabs: [
        {uid: 'pa', url: 'https://a', index: 0},
        {uid: 'pb', url: 'https://b', index: 1},
        {uid: 'pc', url: 'https://c', index: 2},
    ]};
    const converged = planSync({
        pulledSnapshot, pulledDeltaLogs: [], localPendingEvents: [],
        selfDeviceId: SELF, localState: convergedLocal,
        priorBaseline: {pinnedUids: ['pa', 'pb', 'pc']},
    });
    check('pinned order converges: globals-only local set emits NO pinnedToMove (H3)',
        converged.browserOps.pinnedToMove.length === 0, JSON.stringify(converged.browserOps.pinnedToMove));
    check('pinned order converges: no spurious create/remove either',
        converged.browserOps.pinnedToCreate.length === 0 && converged.browserOps.pinnedToRemove.length === 0,
        JSON.stringify(converged.browserOps));

    // CONTRAST (pre-fix shape): a leaked group-pinned tab interleaved at index 0 shifts the
    // globals to 1,2,3 — the planner then emits pinnedToMove for every global. This is the
    // churn the fix removes; we assert the planner WOULD churn on the leaked input so the
    // regression test is meaningful (the fix is in getLivePinnedTabs, which now never
    // produces this input).
    const leakedLocal = {groups: [], pinnedTabs: [
        {uid: 'LEAK', url: 'https://leak', index: 0}, // leaked group-pinned tab (active group)
        {uid: 'pa', url: 'https://a', index: 1},
        {uid: 'pb', url: 'https://b', index: 2},
        {uid: 'pc', url: 'https://c', index: 3},
    ]};
    const leaked = planSync({
        pulledSnapshot, pulledDeltaLogs: [], localPendingEvents: [],
        selfDeviceId: SELF, localState: leakedLocal,
        priorBaseline: {pinnedUids: ['pa', 'pb', 'pc']},
    });
    check('pre-fix contrast: leaked group-pinned tab WOULD churn pinnedToMove (now prevented upstream)',
        leaked.browserOps.pinnedToMove.length > 0, JSON.stringify(leaked.browserOps.pinnedToMove));
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.error('FAILURES:', failures.join(', '));
    process.exit(1);
}
