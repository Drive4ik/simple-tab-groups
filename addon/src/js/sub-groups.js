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

// the model and the words (sub-group, live group): docs/DESIGN-SUB-GROUPS.md

export const TAB_GROUP_ID_NONE = browser.tabGroups.TAB_GROUP_ID_NONE;

const logger = new Logger('SubGroups');
const settings = await Storage.get(['cloneSubGroupsWhenMovingTabs']);

Listeners.storage.local.onChanged.add(onStorageChanged, {waitListener: false});

function onStorageChanged(changes) {
    if (Storage.isChangedKey('cloneSubGroupsWhenMovingTabs', changes, Boolean)) {
        settings.cloneSubGroupsWhenMovingTabs = changes.cloneSubGroupsWhenMovingTabs.newValue;
    }
}

function createSubGroupId() {
    return self.crypto.randomUUID().slice(0, 8);
}

// by the tabs, not the metadata (docs/DESIGN-SUB-GROUPS.md §2, §8): a group read without its tabs
// throws here. An id is listed under the FIRST group of the list that holds it
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

// docs/DESIGN-SUB-GROUPS.md §8. Returns whether anything was reissued
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

// the ids that were live in the window once (docs/DESIGN-SUB-GROUPS.md §4): windowId → Set of sub-group ids
const materializedByWindow = new Map;

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

// a live group the maps don't know: the id is elected by the members' sessions, else minted (docs/DESIGN-SUB-GROUPS.md §4)
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

// docs/DESIGN-SUB-GROUPS.md §5: nothing under the gate waits for the groups queue
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

// the browser's groupId (a live id) conflicts with the STG groupId key
export function detachTabGroupId(tab) {
    delete tab.groupId;
    return tab;
}

// raw: the browser's groupId is the live membership
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

// hygiene for the snapshots (backup, cloud, undo): a record no tab references is garbage
export function referencedSubGroups({tabs, subGroups}) {
    const referencedIds = new Set(tabs.map(tab => tab.subGroupId));
    return subGroups.filter(subGroup => referencedIds.has(subGroup.id));
}

const mirrorBatch = new BatchProcessor((_windowIds, windowId) => {
    return mirrorWindow(windowId).catch(logger.onCatch(['mirrorWindow failed', windowId], false));
}, {batchDelay: 150});

// the mirror reads settled states only: parked while an operation runs, one pass per window on idle
// (docs/DESIGN-SUB-GROUPS.md §4)
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

    // the adoption votes and the session diff need the sessions
    await Promise.allSettled(winTabs.map(tab => Cache.loadTabSubGroupId(tab.id)));

    const memberTabsByLiveId = Map.groupBy(winTabs, tab => liveIdByTabId.get(tab.id));

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

    // live membership wins; a tab out of every live group is only nominated (docs/DESIGN-SUB-GROUPS.md §4)
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
        // membership lives on the tabs - the UI has to refetch them, a metadata broadcast isn't enough
        Tabs.sendUpdatedGroup(groupId);
    }

    // pending imports stay while a visible tab references them
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

// the second settled pass of the erase (docs/DESIGN-SUB-GROUPS.md §4): anything that changed in between
// drops the candidate
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

    // the freed records are garbage collected by the next mirror pass
    scheduleMirrorWindow(windowId);

    log.stop('cleared:', cleared);
}

export function forgetWindow(windowId) {
    materializedByWindow.delete(windowId);
    deferredClearCandidates.delete(windowId);
    deferredWindows.delete(windowId);
}

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

// docs/DESIGN-SUB-GROUPS.md §6: only the garbage collection changes subGroups here
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

    const memberTabsBySubGroupId = Map.groupBy(group.tabs, tab => tab.subGroupId);

    const appliedSubGroups = [];

    for (const subGroup of subGroups) {
        const memberTabs = memberTabsBySubGroupId.get(subGroup.id) ?? [];
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
            // the members still reference subGroup.id in the sessions, the next apply retries
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

// the unsync tabs policy (docs/DESIGN-SUB-GROUPS.md §3)
export function clearMembership(tabs) {
    logger.log(clearMembership, 'count:', tabs.length);

    return Promise.allSettled(tabs.map(tab => {
        delete tab.subGroupId;
        return Cache.removeTabSubGroupId(Tabs.extractId(tab));
    }));
}

// what a move by the addon means for the movers' sub-groups: docs/DESIGN-SUB-GROUPS.md §7
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

// docs/DESIGN-SUB-GROUPS.md §7: the browser's placement wins, a mover that carried nothing loses its stale session
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
                    // the moved tab objects come from moveNative with the session keys stripped - ask the cache, not the object
                    delete tab.subGroupId;
                    await Cache.removeTabSubGroupId(tab.id);
                }
            }

            for (const [subGroup, memberTabs] of memberTabsBySubGroup) {
                try {
                    for (const tab of memberTabs) {
                        if (Cache.getTabSubGroupId(tab.id) !== subGroup.id) {
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

        // the mirror picks the created sub-groups up into the metadata
        scheduleMirrorWindow(windowId);
    } else {
        const subGroups = group.subGroups.slice();
        const knownIds = new Set(subGroups.map(subGroup => subGroup.id));
        let subGroupsChanged = false;

        await Promise.allSettled(movedTabs.map(async tab => {
            const subGroup = snapshot.get(tab.id);

            if (!subGroup) {
                // the moved tab objects come from moveNative with the session keys stripped - ask the cache, not the object
                if (Cache.getTabSubGroupId(tab.id)) {
                    delete tab.subGroupId;
                    await Cache.removeTabSubGroupId(tab.id);
                }
                return;
            }

            if (Cache.getTabSubGroupId(tab.id) !== subGroup.id) {
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

// docs/DESIGN-SUB-GROUPS.md §9: after a backup restore the storage is the truth, otherwise the browser
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
