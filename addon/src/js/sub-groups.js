import Listeners from './listeners.js\
?tabGroups.onCreated\
&tabGroups.onUpdated\
&tabGroups.onMoved\
&tabGroups.onRemoved\
&storage.local.onChanged\
';
import Logger from './logger.js';
import Queue from './queue.js';
import BatchProcessor from './batch-processor.js';
import * as Cache from './cache.js';
import * as Operations from './operations.js';
import * as Storage from './storage.js';
import * as Tabs from './tabs.js';
import * as Groups from './groups.js';

export const TAB_GROUP_ID_NONE = browser.tabGroups.TAB_GROUP_ID_NONE;

const logger = new Logger('SubGroups');
const settings = await Storage.get(['cloneSubGroupsWhenMovingTabs']);

Listeners.storage.local.onChanged.add(onStorageChanged, {waitListener: false});

function onStorageChanged(changes) {
    if (Storage.isChangedKey('cloneSubGroupsWhenMovingTabs', changes, Boolean)) {
        settings.cloneSubGroupsWhenMovingTabs = changes.cloneSubGroupsWhenMovingTabs.newValue;
    }
}

// The words (one thing - one word, everywhere in the addon):
// - sub-group: STG's record of a browser tab group inside an STG group - a stable string id
//   (createSubGroupId) and the metadata {id, title, collapsed, color}. subGroup, subGroupId,
//   group.subGroups, tab.subGroupId.
// - live group: the browser's tab group as it is right now, and its numeric id from
//   browser.tabGroups. liveGroup, liveId. Ephemeral: a re-created group gets a new id
//   (docs/BEHAVIOR-TABGROUPS.md §5), so live ids never leave the runtime.
// - native: only the name of the browser feature in the docs and the UI, and the browser API.
//
// Membership model (browser behavior details: docs/BEHAVIOR-TABGROUPS.md):
// - session value 'subGroupId' on a tab = the sub-group id of the tab. The single source of truth
//   for membership: survives addon/browser restarts and travels with the tab everywhere -
//   Tabs.prepareForSave carries it into backup/cloud/archive/undo, Tabs.create writes it back.
// - group.subGroups = [{id, title, collapsed, color}] - the sub-group metadata, keyed by the same
//   ids, array order is meaningless (visual order comes from tab order). The same format is
//   stored in storage, backup, cloud and archive - there is no other representation.
// - the maps below translate live ids to sub-group ids and back.
// - the mirror records live membership immediately, but ERASES a session only through a deferred
//   settled re-check (clearWindowSessionsNow): the id must have been live in that window before
//   and the tab must still be visible and out of every live group. Detection is state-based -
//   any mirror pass re-nominates, nothing depends on catching an event exactly once.
// - a move by the addon (loaded or unloaded groups alike): a sub-group whose EVERY member is in
//   the moved set travels with them under the same id - the addon's counterpart of the browser's
//   header drag, which STG's UI does not have. A partial move loses the sub-group, except a
//   partial move to ANOTHER group with cloneSubGroupsWhenMovingTabs on - then it is CLONED there
//   under a fresh id. Landing inside another sub-group's span always wins.
//   One id never lives in two STG groups (snapshotMembership/restoreMembership, collectSubGroupIds/reissueSubGroupIds).

function createSubGroupId() {
    return self.crypto.randomUUID().slice(0, 8);
}

// the sub-group ids the groups hold, by group id, for reissueSubGroupIds. A group holds the ids its
// tabs carry (membership lives on the tabs; a metadata entry without members is garbage until apply
// collects it), so the groups come WITH their tabs - a group read without them throws here. One id
// never lives in two STG groups, so an id is listed under the FIRST group of the list that holds it:
// the order of the list decides which group keeps a duplicated id
export function collectSubGroupIds(groups) {
    const subGroupIdsByGroupId = new Map;
    const listedIds = new Set;

    for (const {id, tabs} of groups) {
        const subGroupIds = subGroupIdsByGroupId.getOrInsert(id, new Set);

        for (const {subGroupId} of tabs) {
            if (subGroupId && !listedIds.has(subGroupId)) {
                listedIds.add(subGroupId);
                subGroupIds.add(subGroupId);
            }
        }
    }

    return subGroupIdsByGroupId;
}

// one sub-group id never lives in two STG groups: a group that comes in from outside (restoreBackup,
// the undo of a removal, the cloud merge) gets a fresh id for every sub-group whose id another group
// holds - the same fresh id in the metadata and on every tab that carries it, in every copy of the
// group (the local and the cloud one). Returns whether anything was reissued
export function reissueSubGroupIds(copies, subGroupIdsByGroupId) {
    copies = Array.isArray(copies) ? copies : [copies];

    const groupId = copies[0].id;

    if (copies.some(copy => copy.id !== groupId)) {
        throw new Error(`reissueSubGroupIds: copies of different groups: ${copies.map(copy => copy.id)}`);
    }

    const takenIds = new Set(subGroupIdsByGroupId.entries().flatMap(([holderId, ids]) => holderId === groupId ? [] : ids));
    const newIdByOldId = new Map;
    const reissue = id => takenIds.has(id) ? newIdByOldId.getOrInsertComputed(id, createSubGroupId) : id;

    for (const copy of copies) {
        copy.subGroups.forEach(subGroup => subGroup.id = reissue(subGroup.id));

        for (const tab of copy.tabs) {
            if (tab.subGroupId) {
                tab.subGroupId = reissue(tab.subGroupId);
            }
        }
    }

    return newIdByOldId.size > 0;
}

const liveIdBySubGroupId = new Map;
const subGroupIdByLiveId = new Map;

// sub-group ids the browser has materialized, per window. For a visible tab outside any live group
// the mirror may clear the session only when its id was live once in THAT window (the user
// pulled the tab out or destroyed the group there); an id the window never knew is a pending
// import - the session is the only thing that will materialize it, so it must stay
const materializedByWindow = new Map; // windowId → Set of sub-group ids

function markMaterialized(windowId, subGroupId) {
    materializedByWindow.getOrInsertComputed(windowId, () => new Set).add(subGroupId);
}

function isMaterialized(windowId, subGroupId) {
    return materializedByWindow.get(windowId)?.has(subGroupId) ?? false;
}

function linkLiveGroup(liveId, subGroupId) {
    const prevLiveId = liveIdBySubGroupId.get(subGroupId);

    if (prevLiveId !== undefined && prevLiveId !== liveId) {
        subGroupIdByLiveId.delete(prevLiveId);
    }

    liveIdBySubGroupId.set(subGroupId, liveId);
    subGroupIdByLiveId.set(liveId, subGroupId);
}

function unlinkLiveGroup(liveId) {
    const subGroupId = subGroupIdByLiveId.get(liveId);

    subGroupIdByLiveId.delete(liveId);

    if (liveIdBySubGroupId.get(subGroupId) === liveId) {
        liveIdBySubGroupId.delete(subGroupId);
    }
}

// a live group the maps don't know: after a browser/addon restart or created by the user.
// its sub-group id is elected by the members' sessions (majority), otherwise a new one is minted
function adoptLiveGroup(liveId, memberTabs = []) {
    const votes = new Map;

    for (const tab of memberTabs) {
        const subGroupId = Cache.getTabSubGroupId(tab.id);

        if (subGroupId && !liveIdBySubGroupId.has(subGroupId)) {
            votes.set(subGroupId, (votes.get(subGroupId) ?? 0) + 1);
        }
    }

    const subGroupId = votes.size
        ? [...votes.entries()].reduce((max, vote) => vote[1] > max[1] ? vote : max)[0]
        : createSubGroupId();

    linkLiveGroup(liveId, subGroupId);

    return subGroupId;
}

// window gate = per-window serialization + suppression of the mirror for the duration of our own
// operations. Mirror triggers arriving while the gate is held mark the window dirty, and one
// mirror pass runs automatically after the gate is released - no event is ever lost.
// Nothing under the gate waits for the groups queue: a gated operation returns the subGroups
// it has collected, and the write goes after the gate is released
const windowQueue = new Queue('SubGroups');
const gatedWindows = new Map; // windowId → {dirty}

function withWindowGate(windowId, name, operation) {
    return windowQueue.run(name, async () => {
        const gate = {dirty: false};

        gatedWindows.set(windowId, gate);

        try {
            return await operation();
        } finally {
            gatedWindows.delete(windowId);

            if (gate.dirty) {
                scheduleMirrorWindow(windowId);
            }
        }
    }, windowId);
}

// listeners
function onCreated(liveGroup) {
    scheduleMirrorWindow(liveGroup.windowId);
}

function onUpdated(liveGroup) {
    scheduleMirrorWindow(liveGroup.windowId);
}

function onMoved(liveGroup) {
    scheduleMirrorWindow(liveGroup.windowId);
}

function onRemoved(liveGroup, removeInfo) {
    unlinkLiveGroup(liveGroup.id);

    if (removeInfo.isWindowClosing) {
        return;
    }

    scheduleMirrorWindow(liveGroup.windowId);
}

export function addListeners(options) {
    Listeners.tabGroups.onCreated.add(onCreated, options);
    Listeners.tabGroups.onUpdated.add(onUpdated, options);
    Listeners.tabGroups.onMoved.add(onMoved, options);
    Listeners.tabGroups.onRemoved.add(onRemoved, options);
}

export function removeListeners() {
    Listeners.tabGroups.onCreated.remove(onCreated);
    Listeners.tabGroups.onUpdated.remove(onUpdated);
    Listeners.tabGroups.onMoved.remove(onMoved);
    Listeners.tabGroups.onRemoved.remove(onRemoved);
}

// methods

// raw browser tab objects carry the browser's groupId (a live id) - it conflicts with the STG
// groupId key and is ephemeral anyway; the membership comes from the session (Cache.applyTabSession)
export function detachTabGroupId(tab) {
    delete tab.groupId;
    return tab;
}

// the browser's own tab objects: the live membership is their groupId, and the addon's view strips it
function queryWindowTabs(windowId) {
    return Tabs.query({windowId, pinned: false, hidden: false}, {raw: true});
}

function toSubGroup(subGroupId, {title, collapsed, color}) {
    return {id: subGroupId, title, collapsed, color};
}

function isSameSubGroups(subGroupsA, subGroupsB) {
    if (subGroupsA.length !== subGroupsB.length) {
        return false;
    }

    const byId = new Map(subGroupsA.map(subGroup => [subGroup.id, subGroup]));

    return subGroupsB.every(subGroup => {
        const other = byId.get(subGroup.id);
        return other &&
            other.title === subGroup.title &&
            other.collapsed === subGroup.collapsed &&
            other.color === subGroup.color;
    });
}

// drop the sub-groups no tab references - hygiene for backup/cloud/undo snapshots
// (the stored groups get the same garbage collection in apply)
export function referencedSubGroups({tabs, subGroups}) {
    const referencedIds = new Set(tabs.map(tab => tab.subGroupId));
    return subGroups.filter(subGroup => referencedIds.has(subGroup.id));
}

const mirrorBatch = new BatchProcessor((_windowIds, windowId) => {
    return mirrorWindow(windowId).catch(logger.onCatch(['mirrorWindow failed', windowId], false));
}, {batchDelay: 150});

// the mirror reads only settled states: while a composite operation is in flight, every trigger
// parks its window here and one pass per window runs on idle. Without this the mirror observes
// transient mid-operation states (tabs visible and ungrouped a moment before hide) and honestly
// records them as user actions
const deferredWindows = new Set;

Operations.onIdle(function mirrorDeferredWindows() {
    for (const windowId of deferredWindows) {
        mirrorBatch.add(windowId, windowId);
    }

    deferredWindows.clear();
});

function deferMirror(windowId) {
    if (Operations.isBusy()) {
        deferredWindows.add(windowId);
        return true;
    }

    return false;
}

export function scheduleMirrorWindow(windowId) {
    if (!windowId) {
        return;
    }

    if (deferMirror(windowId)) {
        return;
    }

    const gate = gatedWindows.get(windowId);

    if (gate) {
        gate.dirty = true;
    } else {
        mirrorBatch.add(windowId, windowId);
    }
}

async function mirrorWindow(windowId) {
    const changes = await withWindowGate(windowId, 'mirror', () => mirrorWindowNow(windowId));

    if (changes) {
        await Groups.update(changes.groupId, () => deferMirror(windowId) ? {} : {subGroups: changes.subGroups});
    }
}

async function mirrorWindowNow(windowId) {
    const log = logger.start(mirrorWindowNow, windowId);

    if (deferMirror(windowId)) {
        log.stop('deferred, operations are busy (1/3)');
        return;
    }

    const [winTabs, liveGroups] = await Promise.all([
        queryWindowTabs(windowId),
        browser.tabGroups.query({windowId}),
    ]);

    const liveIdByTabId = new Map(winTabs.map(tab => {
        return [tab.id, tab.groupId === TAB_GROUP_ID_NONE ? undefined : tab.groupId];
    }));

    // adoption votes and the session diff below need the sessions
    await Promise.allSettled(winTabs.map(tab => Cache.loadTabSubGroupId(tab.id)));

    const memberTabsByLiveId = new Map(liveGroups.map(liveGroup => [liveGroup.id, []]));

    for (const tab of winTabs) {
        memberTabsByLiveId.get(liveIdByTabId.get(tab.id))?.push(tab);
    }

    const liveSubGroups = liveGroups.map(liveGroup => {
        const subGroupId = subGroupIdByLiveId.get(liveGroup.id)
            ?? adoptLiveGroup(liveGroup.id, memberTabsByLiveId.get(liveGroup.id));

        markMaterialized(windowId, subGroupId);

        return toSubGroup(subGroupId, liveGroup);
    });

    // an operation that started while we were reading makes every conclusion below stale
    if (deferMirror(windowId)) {
        log.stop('deferred, operations are busy (2/3)');
        return;
    }

    // sessions: live membership wins immediately; a visible tab OUT of every live group is only
    // NOMINATED to lose its session - the erase happens in a settled re-check
    // (clearWindowSessionsNow), so a transient mid-gesture or crashed-flow state costs nothing
    let sessionsChanged = false;
    const clearCandidates = new Map; // tabId → sessionId at nomination time

    await Promise.allSettled(winTabs.map(tab => {
        const liveId = liveIdByTabId.get(tab.id);
        const sessionId = Cache.getTabSubGroupId(tab.id);

        if (liveId) {
            const subGroupId = subGroupIdByLiveId.get(liveId);

            if (subGroupId !== sessionId) {
                sessionsChanged = true;
                return Cache.setTabSubGroupId(tab.id, subGroupId);
            }
        } else if (sessionId && isMaterialized(windowId, sessionId)) {
            clearCandidates.set(tab.id, sessionId);
        }
    }));

    if (clearCandidates.size) {
        scheduleClearWindow(windowId, clearCandidates);
    }

    const groupId = Cache.getWindowGroup(windowId);

    if (!groupId) {
        log.stop('no active group, sessions only');
        return;
    }

    const {group} = await Groups.load(groupId);

    if (!group) {
        log.stop('group not found');
        return;
    }

    if (sessionsChanged) {
        // membership lives on the tabs - the UI has to refetch them, metadata broadcast isn't enough
        Tabs.sendUpdatedGroup(groupId);
    }

    // pending sub-groups (imported, not materialized yet) stay while a visible tab references them
    const liveSubGroupIds = new Set(liveSubGroups.map(subGroup => subGroup.id));
    const referencedIds = new Set(winTabs.map(tab => Cache.getTabSubGroupId(tab.id)));
    const subGroups = liveSubGroups;

    for (const subGroup of group.subGroups) {
        if (!liveSubGroupIds.has(subGroup.id) && referencedIds.has(subGroup.id)) {
            subGroups.push(subGroup);
        }
    }

    if (deferMirror(windowId)) {
        log.stop('deferred, operations are busy (3/3)');
        return;
    }

    if (isSameSubGroups(group.subGroups, subGroups)) {
        log.stop('no metadata changes');
        return;
    }

    log.stop('metadata changed, count:', subGroups.length);

    return {groupId, subGroups};
}

// deferred erasing: the mirror only nominates, the session is removed by this second settled
// pass - the tab must still be visible, still out of every live group and still carry the same
// id. Anything that changed in between (rehidden, regrouped, moved away, session rewritten)
// silently drops the candidate; a still-real pull-out is re-nominated by any next mirror pass
const deferredClearCandidates = new Map; // windowId → Map(tabId → sessionId)

const clearBatch = new BatchProcessor((candidates, windowId) => {
    return clearWindowSessions(windowId, candidates)
        .catch(logger.onCatch(['clearWindowSessions failed', windowId], false));
}, {batchDelay: 150, useMap: true});

Operations.onIdle(function clearDeferredWindows() {
    for (const [windowId, candidates] of deferredClearCandidates) {
        scheduleClearWindow(windowId, candidates);
    }

    deferredClearCandidates.clear();
});

function scheduleClearWindow(windowId, candidates) {
    for (const candidate of candidates) {
        clearBatch.add(candidate, windowId);
    }
}

function deferClearWindow(windowId, candidates) {
    const deferred = deferredClearCandidates.getOrInsertComputed(windowId, () => new Map);

    for (const [tabId, sessionId] of candidates) {
        deferred.set(tabId, sessionId);
    }
}

function clearWindowSessions(windowId, candidates) {
    return withWindowGate(windowId, 'clear-sessions', () => clearWindowSessionsNow(windowId, candidates));
}

async function clearWindowSessionsNow(windowId, pending) {
    if (Operations.isBusy()) {
        deferClearWindow(windowId, pending);
        return;
    }

    const winTabs = await queryWindowTabs(windowId);

    // an operation that started while we were reading makes the nomination stale - put it back
    if (Operations.isBusy()) {
        deferClearWindow(windowId, pending);
        return;
    }

    const log = logger.start(clearWindowSessionsNow, windowId, 'candidates:', pending.size);

    let cleared = 0;

    for (const tab of winTabs) {
        const sessionId = pending.get(tab.id);

        if (!sessionId || tab.groupId !== TAB_GROUP_ID_NONE) {
            continue;
        }

        if (Cache.getTabSubGroupId(tab.id) !== sessionId) {
            continue;
        }

        cleared++;
        await Cache.removeTabSubGroupId(tab.id);
    }

    if (!cleared) {
        log.stop('nothing confirmed');
        return;
    }

    const groupId = Cache.getWindowGroup(windowId);

    if (groupId) {
        // membership lives on the tabs - the UI has to refetch them
        Tabs.sendUpdatedGroup(groupId);
    }

    // the freed sub-groups are garbage collected by the next mirror pass
    scheduleMirrorWindow(windowId);

    log.stop('cleared:', cleared);
}

// the window is gone - its per-window bookkeeping goes with it
export function forgetWindow(windowId) {
    materializedByWindow.delete(windowId);
    deferredClearCandidates.delete(windowId);
    deferredWindows.delete(windowId);
}

// check for apply(): live window state already matches the group - nothing to recreate
async function isLiveStateSame(windowId, {tabs: groupTabs, subGroups}) {
    const liveGroups = await browser.tabGroups.query({windowId});

    const liveGroupBySubGroupId = new Map;

    for (const liveGroup of liveGroups) {
        const subGroupId = subGroupIdByLiveId.get(liveGroup.id);

        if (!subGroupId) {
            return false; // the mirror hasn't adopted it yet - re-apply
        }

        liveGroupBySubGroupId.set(subGroupId, liveGroup);
    }

    if (liveGroupBySubGroupId.size !== subGroups.length) {
        return false;
    }

    for (const subGroup of subGroups) {
        const liveGroup = liveGroupBySubGroupId.get(subGroup.id);

        if (!liveGroup || liveGroup.title !== subGroup.title || liveGroup.collapsed !== subGroup.collapsed || liveGroup.color !== subGroup.color) {
            return false;
        }
    }

    const subGroupIds = new Set(subGroups.map(subGroup => subGroup.id));
    const expectedByTabId = new Map(groupTabs.map(tab => {
        return [tab.id, subGroupIds.has(tab.subGroupId) ? tab.subGroupId : undefined];
    }));

    const winTabs = await queryWindowTabs(windowId);

    return winTabs.every(tab => {
        const liveSubGroupId = tab.groupId === TAB_GROUP_ID_NONE ? undefined : subGroupIdByLiveId.get(tab.groupId);
        const expectedId = expectedByTabId.has(tab.id) ? expectedByTabId.get(tab.id) : undefined;
        return liveSubGroupId === expectedId;
    });
}

// (re)create the group's sub-groups in the window from per-tab membership. The ids are stable,
// so the sessions stay untouched and only garbage collection can change subGroups.
// Sub-groups without members are dropped here (garbage collection).
export async function apply(windowId, group) {
    const subGroups = await withWindowGate(windowId, 'apply', () => applyNow(windowId, group));

    if (subGroups) {
        await Groups.update(group.id, {subGroups});
    }
}

async function applyNow(windowId, group) {
    const {subGroups} = group;
    const log = logger.start(applyNow, windowId, 'group:', group.id, 'count:', subGroups.length);

    if (!group.tabs.length) {
        log.stop('tabs are empty');
        return;
    }

    await Promise.all(group.tabs.map(tab => Cache.loadTabSession(tab)));

    if (await isLiveStateSame(windowId, group)) {
        log.stop('live state already matches');
        return;
    }

    await Tabs.ungroup(group.tabs);

    const memberTabsBySubGroupId = new Map(subGroups.map(subGroup => [subGroup.id, []]));

    for (const tab of group.tabs) {
        memberTabsBySubGroupId.get(tab.subGroupId)?.push(tab);
    }

    const appliedSubGroups = [];

    for (const subGroup of subGroups) {
        const memberTabs = memberTabsBySubGroupId.get(subGroup.id);
        const visibleMemberTabs = memberTabs.filter(tab => !tab.hidden);

        if (!visibleMemberTabs.length) {
            if (memberTabs.length) {
                appliedSubGroups.push(subGroup); // members exist but aren't visible - keep as is
            }
            // no members at all - dropped (garbage collection)
            continue;
        }

        try {
            const liveId = await Tabs.group(visibleMemberTabs, windowId);

            await browser.tabGroups.update(liveId, {
                collapsed: subGroup.collapsed,
                color: subGroup.color,
                title: subGroup.title,
            });

            linkLiveGroup(liveId, subGroup.id);
            markMaterialized(windowId, subGroup.id);
            appliedSubGroups.push(subGroup);
        } catch (e) {
            // the members still reference subGroup.id in the sessions, next apply retries
            appliedSubGroups.push(subGroup);
            log.logError(['cant apply sub-group', subGroup], e);
        }
    }

    if (isSameSubGroups(group.subGroups, appliedSubGroups)) {
        log.stop();
        return;
    }

    group.subGroups = appliedSubGroups;

    log.stop('metadata changed, count:', appliedSubGroups.length);

    return appliedSubGroups;
}

export async function hasLiveGroups(windowId) {
    const liveGroups = await browser.tabGroups.query({windowId});
    return liveGroups.length > 0;
}

// the sub-groups are consciously destroyed for these tabs (unsync tabs policy)
export function clearMembership(tabs) {
    logger.log(clearMembership, 'count:', tabs.length);

    return Promise.allSettled(tabs.map(tab => {
        delete tab.subGroupId;
        return Cache.removeTabSubGroupId(Tabs.extractId(tab));
    }));
}

// SNAPSHOT/RESTORE: what a move by the addon means for the movers' sub-groups. The census of a
// sub-group is its sessions - visible, hidden and unsync tabs alike. A sub-group whose every
// member is in the moved set travels as itself: same id, wherever it goes - the addon's
// counterpart of the browser's header drag, which STG's UI does not have. A partial move within
// the sub-group's own STG group follows the browser rule - the movers lose it; a partial move
// to ANOTHER group follows the cloneSubGroupsWhenMovingTabs setting - off: the movers lose it,
// on: the sub-group is CLONED into the target under a fresh id. Landing inside another
// sub-group's span wins over all of this (the browser's placement / destSubGroupId). The record
// comes from any group's subGroups, or from the live group (unsync tabs in a window without an
// active group).
export async function snapshotMembership(movedTabs, groups, targetGroupId) {
    if (!movedTabs.length) {
        return null;
    }

    const subGroupById = new Map;

    for (const group of groups) {
        for (const subGroup of group.subGroups) {
            subGroupById.set(subGroup.id, subGroup);
        }
    }

    const allTabs = await Tabs.query({pinned: false});

    const memberIdsBySubGroupId = new Map;

    for (const tab of allTabs) {
        const subGroupId = Cache.getTabSubGroupId(tab.id);
        subGroupId && memberIdsBySubGroupId.getOrInsert(subGroupId, new Set).add(tab.id);
    }

    const movedIds = new Set(movedTabs.map(tab => tab.id));

    async function resolveCarriedSubGroup(subGroupId, sameGroup) {
        let subGroup = subGroupById.get(subGroupId);

        if (!subGroup) {
            const liveId = liveIdBySubGroupId.get(subGroupId);
            const liveGroup = liveId ? await browser.tabGroups.get(liveId).catch(() => null) : null;

            if (!liveGroup) {
                return null;
            }

            subGroup = toSubGroup(subGroupId, liveGroup);
        }

        const memberIds = memberIdsBySubGroupId.get(subGroupId) ?? movedIds;
        const wholeMove = memberIds.isSubsetOf(movedIds);

        if (wholeMove) {
            return subGroup;
        }

        if (sameGroup) {
            return null; // the browser rule; there is no cloning inside one group
        }

        return settings.cloneSubGroupsWhenMovingTabs ? {...subGroup, id: createSubGroupId()} : null;
    }

    const carriedSubGroup = new Map; // source sub-group id → the sub-group in the target, null = the movers lose it
    const snapshot = new Map; // tabId → the sub-group in the target

    for (const tab of movedTabs) {
        const subGroupId = Cache.getTabSubGroupId(tab.id);

        if (!subGroupId) {
            continue;
        }

        if (!carriedSubGroup.has(subGroupId)) {
            carriedSubGroup.set(subGroupId, await resolveCarriedSubGroup(subGroupId, tab.groupId === targetGroupId));
        }

        const subGroup = carriedSubGroup.get(subGroupId);

        if (subGroup) {
            snapshot.set(tab.id, subGroup);
        }
    }

    return snapshot.size ? snapshot : null;
}

// restore the carried membership after the move: write the (possibly cloned) sub-group id into
// the sessions, ensure the metadata record and (for a loaded group) the live group. A mover that
// carried nothing loses its stale session - its sub-group stayed behind or was dropped by the
// snapshot rules. The browser's own placement wins: a tab that landed inside another live span
// keeps it.
export async function restoreMembership(group, movedTabs, snapshot = null) {
    snapshot ??= new Map;

    const windowId = Cache.getWindowId(group.id);
    const log = logger.start(restoreMembership, 'group:', group.id, {windowId}, 'carried:', snapshot.size);

    if (windowId) {
        await withWindowGate(windowId, 'restore-membership', async () => {
            const [winTabs, liveGroups] = await Promise.all([
                queryWindowTabs(windowId),
                browser.tabGroups.query({windowId}),
            ]);

            const liveIdByTabId = new Map(winTabs.map(tab => [tab.id, tab.groupId]));
            const liveIdsInWindow = new Set(liveGroups.map(liveGroup => liveGroup.id));
            const memberTabsBySubGroup = new Map;

            for (const tab of movedTabs) {
                const subGroup = snapshot.get(tab.id);

                if (liveIdByTabId.get(tab.id) !== TAB_GROUP_ID_NONE) {
                    continue;
                }

                if (subGroup) {
                    memberTabsBySubGroup.getOrInsert(subGroup, []).push(tab);
                } else if (Cache.getTabSubGroupId(tab.id)) {
                    // the moved tab objects come from moveNative with the session keys
                    // stripped - ask the cache, not the object
                    delete tab.subGroupId;
                    await Cache.removeTabSubGroupId(tab.id);
                }
            }

            for (const [subGroup, memberTabs] of memberTabsBySubGroup) {
                try {
                    for (const tab of memberTabs) {
                        if (Cache.getTabSubGroupId(tab.id) !== subGroup.id) {
                            // a clone travels under its fresh id
                            tab.subGroupId = subGroup.id;
                            await Cache.setTabSubGroupId(tab.id, subGroup.id);
                        }
                    }

                    // the sub-group was carried here earlier and is still live - join it
                    const existingLiveId = liveIdBySubGroupId.get(subGroup.id);
                    const joinLiveId = liveIdsInWindow.has(existingLiveId) ? existingLiveId : null;

                    const liveId = await Tabs.group(memberTabs, windowId, {joinLiveGroupId: joinLiveId});

                    if (!joinLiveId) {
                        await browser.tabGroups.update(liveId, {
                            collapsed: subGroup.collapsed,
                            color: subGroup.color,
                            title: subGroup.title,
                        });

                        linkLiveGroup(liveId, subGroup.id);
                        markMaterialized(windowId, subGroup.id);
                    }
                } catch (e) {
                    log.logError(['cant restore sub-group', subGroup], e);
                }
            }
        });

        // the mirror picks the created sub-groups up into the active group's metadata
        scheduleMirrorWindow(windowId);
    } else {
        const subGroups = group.subGroups.slice();
        const knownIds = new Set(subGroups.map(subGroup => subGroup.id));
        let subGroupsChanged = false;

        await Promise.allSettled(movedTabs.map(async tab => {
            const subGroup = snapshot.get(tab.id);

            if (!subGroup) {
                // the moved tab objects come from moveNative with the session keys
                // stripped - ask the cache, not the object
                if (Cache.getTabSubGroupId(tab.id)) {
                    delete tab.subGroupId;
                    await Cache.removeTabSubGroupId(tab.id);
                }
                return;
            }

            if (Cache.getTabSubGroupId(tab.id) !== subGroup.id) {
                // a clone travels under its fresh id
                tab.subGroupId = subGroup.id;
                await Cache.setTabSubGroupId(tab.id, subGroup.id);
            }

            if (!knownIds.has(subGroup.id)) {
                knownIds.add(subGroup.id);
                subGroups.push({...subGroup});
                subGroupsChanged = true;
            }
        }));

        if (subGroupsChanged) {
            await Groups.update(group.id, {subGroups});
        }
    }

    log.stop();
}

// startup / restore entry point for a window
export async function reconcileWindow(windowId, afterRestoring = false) {
    const log = logger.start(reconcileWindow, windowId, {afterRestoring});

    if (afterRestoring) {
        const groupId = Cache.getWindowGroup(windowId);
        const {group} = groupId ? await Groups.load(groupId, true) : {};

        if (group) {
            await apply(windowId, group);
            log.stop('applied sub-groups');
        } else {
            log.stop('no active group');
        }
    } else {
        await mirrorWindow(windowId);
        log.stop('mirrored from browser');
    }
}
