import Listeners from './listeners.js\
?tabGroups.onCreated\
&tabGroups.onUpdated\
&tabGroups.onMoved\
&tabGroups.onRemoved\
&storage.local.onChanged\
';
import Logger from './logger.js';
import BatchProcessor from './batch-processor.js';
import * as Cache from './cache.js';
import * as Operations from './operations.js';
import * as Storage from './storage.js';
import * as Tabs from './tabs.js';
import * as Groups from './groups.js';

export const TAB_GROUP_ID_NONE = browser.tabGroups.TAB_GROUP_ID_NONE;

const logger = new Logger('GroupsNative');
const settings = await Storage.get(['cloneSubGroupsWhenMovingTabs']);

Listeners.storage.local.onChanged.add(onStorageChanged, {waitListener: false});

function onStorageChanged(changes) {
    if (Storage.isChangedBooleanKey('cloneSubGroupsWhenMovingTabs', changes)) {
        settings.cloneSubGroupsWhenMovingTabs = changes.cloneSubGroupsWhenMovingTabs.newValue;
    }
}

// Membership model (browser behavior details: docs/TABGROUPS-BEHAVIOR.md):
// - session value 'groupNativeId' on a tab = stable string id of its sub-group. The single source
//   of truth for membership: survives addon/browser restarts and travels with the tab everywhere -
//   Tabs.prepareForSave carries it into backup/cloud/archive/undo, Tabs.create writes it back.
// - group.groupsNative = [{id, title, collapsed, color}] - sub-group metadata, keyed by the same
//   stable ids, array order is meaningless (visual order comes from tab order). The same format
//   is stored in storage, backup, cloud and archive - there is no other representation.
// - live browser group ids are ephemeral (a re-created group gets a new id, see
//   docs/TABGROUPS-BEHAVIOR.md §5) and never leave the runtime: the maps below translate them
//   to stable ids and back.
// - the mirror records live membership immediately, but ERASES a session only through a deferred
//   settled re-check (clearWindowSessionsNow): the id must have been live in that window before
//   and the tab must still be visible and out of every live group. Detection is state-based -
//   any mirror pass re-nominates, nothing depends on catching an event exactly once.
// - a move by the addon (loaded or unloaded groups alike): a sub-group whose EVERY member is in
//   the moved set travels with them under the same stable id - the addon's counterpart of the
//   browser's header drag, which STG's UI does not have. A partial move loses the sub-group,
//   except a partial move to ANOTHER group with cloneSubGroupsWhenMovingTabs on - then it is
//   CLONED there under a fresh stable id. Landing inside another sub-group's span always wins.
//   One id never lives in two STG groups (snapshotMembership/restoreMembership).

export function createSubGroupId() {
    return self.crypto.randomUUID().slice(0, 8);
}

const liveIdByStableId = new Map;
const stableIdByLiveId = new Map;

// stable ids the browser has materialized, per window. For a visible tab outside any live group
// the mirror may clear the session only when its id was live once in THAT window (the user
// pulled the tab out or destroyed the group there); an id the window never knew is a pending
// import - the session is the only thing that will materialize it, so it must stay
const materializedByWindow = new Map; // windowId → Set of stable ids

function markMaterialized(windowId, stableId) {
    materializedByWindow.getOrInsertComputed(windowId, () => new Set).add(stableId);
}

function isMaterialized(windowId, stableId) {
    return materializedByWindow.get(windowId)?.has(stableId) ?? false;
}

function linkLiveGroup(liveId, stableId) {
    const prevLiveId = liveIdByStableId.get(stableId);

    if (prevLiveId !== undefined && prevLiveId !== liveId) {
        stableIdByLiveId.delete(prevLiveId);
    }

    liveIdByStableId.set(stableId, liveId);
    stableIdByLiveId.set(liveId, stableId);
}

function unlinkLiveGroup(liveId) {
    const stableId = stableIdByLiveId.get(liveId);

    stableIdByLiveId.delete(liveId);

    if (liveIdByStableId.get(stableId) === liveId) {
        liveIdByStableId.delete(stableId);
    }
}

// a live group the maps don't know: after a browser/addon restart or created by the user.
// its stable id is elected by the members' sessions (majority), otherwise a new one is minted
function adoptLiveGroup(liveId, memberTabs = []) {
    const votes = new Map;

    for (const tab of memberTabs) {
        const stableId = Cache.getTabNativeGroupId(tab.id);

        if (stableId && !liveIdByStableId.has(stableId)) {
            votes.set(stableId, (votes.get(stableId) ?? 0) + 1);
        }
    }

    const stableId = votes.size
        ? [...votes.entries()].reduce((max, vote) => vote[1] > max[1] ? vote : max)[0]
        : createSubGroupId();

    linkLiveGroup(liveId, stableId);

    return stableId;
}

const windowQueues = new Map;

function queueWindowOperation(windowId, operation) {
    const turn = windowQueues.getOrInsertComputed(windowId, () => Promise.resolve())
        .then(operation, operation);

    windowQueues.set(windowId, turn);

    turn.catch(() => {}).finally(() => {
        if (windowQueues.get(windowId) === turn) {
            windowQueues.delete(windowId);
        }
    });

    return turn;
}

// window gate = per-window serialization + suppression of the mirror for the duration of our own
// operations. Mirror triggers arriving while the gate is held mark the window dirty, and one
// mirror pass runs automatically after the gate is released - no event is ever lost
const gatedWindows = new Map; // windowId → {dirty}

function withWindowGate(windowId, operation) {
    return queueWindowOperation(windowId, async () => {
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
    });
}

// listeners
function onCreated(groupNative) {
    scheduleMirrorWindow(groupNative.windowId);
}

function onUpdated(groupNative) {
    scheduleMirrorWindow(groupNative.windowId);
}

function onMoved(groupNative) {
    scheduleMirrorWindow(groupNative.windowId);
}

function onRemoved(groupNative, removeInfo) {
    unlinkLiveGroup(groupNative.id);

    if (removeInfo.isWindowClosing) {
        return;
    }

    scheduleMirrorWindow(groupNative.windowId);
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

// raw browser tab objects carry the native groupId - it conflicts with the STG groupId key and
// is ephemeral anyway; the membership comes from the session (Cache.applyTabSession)
export function detachTabGroupId(tab) {
    delete tab.groupId;
    return tab;
}

function toEntry(stableId, {title, collapsed, color}) {
    return {id: stableId, title, collapsed, color};
}

function isSameGroupsNative(groupsNativeA = [], groupsNativeB = []) {
    if (groupsNativeA.length !== groupsNativeB.length) {
        return false;
    }

    const byId = new Map(groupsNativeA.map(entry => [entry.id, entry]));

    return groupsNativeB.every(entry => {
        const other = byId.get(entry.id);
        return other &&
            other.title === entry.title &&
            other.collapsed === entry.collapsed &&
            other.color === entry.color;
    });
}

// drop metadata entries no tab references - hygiene for backup/cloud/undo snapshots
// (the stored groups get the same garbage collection in apply)
export function referencedGroupsNative({tabs, groupsNative = []}) {
    const referencedIds = new Set(tabs.map(tab => tab.groupNativeId));
    return groupsNative.filter(entry => referencedIds.has(entry.id));
}

const mirrorBatch = new BatchProcessor((_windowIds, windowId) => {
    return mirrorWindow(windowId).catch(logger.onCatch(['mirrorWindow failed', windowId], false));
}, 150);

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

function mirrorWindow(windowId) {
    return withWindowGate(windowId, () => mirrorWindowNow(windowId));
}

async function mirrorWindowNow(windowId) {
    const log = logger.start(mirrorWindowNow, windowId);

    if (deferMirror(windowId)) {
        log.stop('deferred, operations are busy (1/3)');
        return;
    }

    const [winTabs, liveGroups] = await Promise.all([
        browser.tabs.query({windowId, pinned: false, hidden: false}),
        browser.tabGroups.query({windowId}),
    ]);

    const liveIdByTabId = new Map(winTabs.map(tab => {
        return [tab.id, tab.groupId === TAB_GROUP_ID_NONE ? undefined : tab.groupId];
    }));

    // adoption votes and the session diff below need the sessions
    await Promise.allSettled(winTabs.map(tab => Cache.loadTabNativeGroupId(tab.id)));

    const memberTabsByLiveId = new Map(liveGroups.map(groupNative => [groupNative.id, []]));

    for (const tab of winTabs) {
        memberTabsByLiveId.get(liveIdByTabId.get(tab.id))?.push(tab);
    }

    const liveEntries = liveGroups.map(groupNative => {
        const stableId = stableIdByLiveId.get(groupNative.id)
            ?? adoptLiveGroup(groupNative.id, memberTabsByLiveId.get(groupNative.id));

        markMaterialized(windowId, stableId);

        return toEntry(stableId, groupNative);
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
        const sessionId = Cache.getTabNativeGroupId(tab.id);

        if (liveId) {
            const stableId = stableIdByLiveId.get(liveId);

            if (stableId !== sessionId) {
                sessionsChanged = true;
                return Cache.setTabNativeGroupId(tab.id, stableId);
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
    const liveStableIds = new Set(liveEntries.map(entry => entry.id));
    const referencedIds = new Set(winTabs.map(tab => Cache.getTabNativeGroupId(tab.id)));
    const groupsNative = liveEntries;

    for (const entry of group.groupsNative ?? []) {
        if (!liveStableIds.has(entry.id) && referencedIds.has(entry.id)) {
            groupsNative.push(entry);
        }
    }

    if (deferMirror(windowId)) {
        log.stop('deferred, operations are busy (3/3)');
        return;
    }

    if (isSameGroupsNative(group.groupsNative, groupsNative)) {
        log.stop('no metadata changes');
    } else {
        await Groups.update(groupId, {groupsNative});
        log.stop('updated, count:', groupsNative.length);
    }
}

// deferred erasing: the mirror only nominates, the session is removed by this second settled
// pass - the tab must still be visible, still out of every live group and still carry the same
// id. Anything that changed in between (rehidden, regrouped, moved away, session rewritten)
// silently drops the candidate; a still-real pull-out is re-nominated by any next mirror pass
const clearCandidatesByWindow = new Map; // windowId → Map(tabId → sessionId)
const deferredClearWindows = new Set;

const clearBatch = new BatchProcessor((_windowIds, windowId) => {
    return clearWindowSessions(windowId).catch(logger.onCatch(['clearWindowSessions failed', windowId], false));
}, 150);

Operations.onIdle(function clearDeferredWindows() {
    for (const windowId of deferredClearWindows) {
        clearBatch.add(windowId, windowId);
    }

    deferredClearWindows.clear();
});

function scheduleClearWindow(windowId, candidates) {
    const pending = clearCandidatesByWindow.getOrInsertComputed(windowId, () => new Map);

    for (const [tabId, sessionId] of candidates) {
        pending.set(tabId, sessionId);
    }

    clearBatch.add(windowId, windowId);
}

function clearWindowSessions(windowId) {
    return withWindowGate(windowId, () => clearWindowSessionsNow(windowId));
}

async function clearWindowSessionsNow(windowId) {
    if (Operations.isBusy()) {
        deferredClearWindows.add(windowId);
        return;
    }

    const pending = clearCandidatesByWindow.get(windowId);

    if (!pending?.size) {
        return;
    }

    clearCandidatesByWindow.delete(windowId);

    const winTabs = await browser.tabs.query({windowId, pinned: false, hidden: false});

    // an operation that started while we were reading makes the nomination stale - put it back
    if (Operations.isBusy()) {
        clearCandidatesByWindow.set(windowId, pending);
        deferredClearWindows.add(windowId);
        return;
    }

    const log = logger.start(clearWindowSessionsNow, windowId, 'candidates:', pending.size);

    let cleared = 0;

    for (const tab of winTabs) {
        const sessionId = pending.get(tab.id);

        if (!sessionId || tab.groupId !== TAB_GROUP_ID_NONE) {
            continue;
        }

        if (Cache.getTabNativeGroupId(tab.id) !== sessionId) {
            continue;
        }

        cleared++;
        await Cache.removeTabNativeGroupId(tab.id).catch(() => {});
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

    // the freed metadata entries are garbage collected by the next mirror pass
    scheduleMirrorWindow(windowId);

    log.stop('cleared:', cleared);
}

// the window is gone - its per-window bookkeeping goes with it
export function forgetWindow(windowId) {
    materializedByWindow.delete(windowId);
    clearCandidatesByWindow.delete(windowId);
    deferredClearWindows.delete(windowId);
    deferredWindows.delete(windowId);
}

// check for apply(): live window state already matches the group - nothing to recreate
async function isLiveStateSame(windowId, {tabs: groupTabs, groupsNative = []}) {
    const liveGroups = await browser.tabGroups.query({windowId});

    const liveMetaByStableId = new Map;

    for (const groupNative of liveGroups) {
        const stableId = stableIdByLiveId.get(groupNative.id);

        if (!stableId) {
            return false; // the mirror hasn't adopted it yet - re-apply
        }

        liveMetaByStableId.set(stableId, groupNative);
    }

    if (liveMetaByStableId.size !== groupsNative.length) {
        return false;
    }

    for (const entry of groupsNative) {
        const live = liveMetaByStableId.get(entry.id);

        if (!live || live.title !== entry.title || live.collapsed !== entry.collapsed || live.color !== entry.color) {
            return false;
        }
    }

    const entryIds = new Set(groupsNative.map(entry => entry.id));
    const expectedByTabId = new Map(groupTabs.map(tab => {
        return [tab.id, entryIds.has(tab.groupNativeId) ? tab.groupNativeId : undefined];
    }));

    const winTabs = await browser.tabs.query({windowId, pinned: false, hidden: false});

    return winTabs.every(tab => {
        const liveStableId = tab.groupId === TAB_GROUP_ID_NONE ? undefined : stableIdByLiveId.get(tab.groupId);
        const expectedId = expectedByTabId.has(tab.id) ? expectedByTabId.get(tab.id) : undefined;
        return liveStableId === expectedId;
    });
}

// (re)create the group's sub-groups in the window from per-tab membership. The ids are stable,
// so the sessions stay untouched and only garbage collection can change groupsNative.
// Sub-groups without members are dropped here (garbage collection).
export function apply(windowId, group) {
    return withWindowGate(windowId, () => applyNow(windowId, group));
}

async function applyNow(windowId, group) {
    const groupsNative = group.groupsNative ?? [];
    const log = logger.start(applyNow, windowId, 'group:', group.id, 'count:', groupsNative.length);

    if (!group.tabs.length) {
        log.stop('tabs are empty');
        return;
    }

    await Promise.all(group.tabs.map(tab => Cache.loadTabSession(tab, false, false)));

    if (await isLiveStateSame(windowId, group)) {
        log.stop('live state already matches');
        return;
    }

    await Tabs.ungroup(group.tabs, true);

    const memberTabsByEntryId = new Map(groupsNative.map(entry => [entry.id, []]));

    for (const tab of group.tabs) {
        memberTabsByEntryId.get(tab.groupNativeId)?.push(tab);
    }

    const appliedGroupsNative = [];

    for (const entry of groupsNative) {
        const memberTabs = memberTabsByEntryId.get(entry.id);
        const visibleMemberTabs = memberTabs.filter(tab => !tab.hidden);

        if (!visibleMemberTabs.length) {
            if (memberTabs.length) {
                appliedGroupsNative.push(entry); // members exist but aren't visible - keep as is
            }
            // no members at all - dropped (garbage collection)
            continue;
        }

        try {
            const liveId = await Tabs.group(visibleMemberTabs, windowId, true);

            await browser.tabGroups.update(liveId, {
                collapsed: entry.collapsed,
                color: entry.color,
                title: entry.title,
            });

            linkLiveGroup(liveId, entry.id);
            markMaterialized(windowId, entry.id);
            appliedGroupsNative.push(entry);
        } catch (e) {
            // the members still reference entry.id in the sessions, next apply retries
            appliedGroupsNative.push(entry);
            log.logError(['cant apply native group', entry], e);
        }
    }

    if (!isSameGroupsNative(group.groupsNative, appliedGroupsNative)) {
        group.groupsNative = appliedGroupsNative;
        await Groups.update(group.id, {groupsNative: appliedGroupsNative});
    }

    log.stop();
}

// detach tabs from LIVE native groups; the membership sessions stay untouched, so the sub-groups
// are recreated on the next apply. Mandatory before Tabs.hide of a tab that can sit in a live
// group: the header of a group whose tabs are all hidden stays in the tab bar
// (docs/TABGROUPS-BEHAVIOR.md §4). Works on hidden members too (§12)
export async function ungroup(tabs) {
    tabs = Array.isArray(tabs) ? tabs : [tabs];

    const log = logger.start(ungroup, 'count:', tabs.length);

    if (!tabs.length) {
        log.stop('tabs are empty');
        return;
    }

    const tabsByWindow = new Map;
    const noWindowTabs = [];

    for (const tab of tabs) {
        if (tab.windowId) {
            tabsByWindow.getOrInsert(tab.windowId, []).push(tab);
        } else {
            // bare ids carry no window to gate - the mirror will resync after the fact
            noWindowTabs.push(tab);
        }
    }

    await Promise.all([
        ...[...tabsByWindow].map(([windowId, windowTabs]) => {
            return withWindowGate(windowId, () => Tabs.ungroup(windowTabs, true));
        }),
        noWindowTabs.length ? Tabs.ungroup(noWindowTabs, true) : null,
    ]);

    log.stop();
}

// the sub-groups are consciously destroyed for these tabs (unsync tabs policy)
export function clearMembership(tabs) {
    logger.log(clearMembership, 'count:', tabs.length);

    return Promise.allSettled(tabs.map(tab => {
        delete tab.groupNativeId;
        return Cache.removeTabNativeGroupId(Tabs.extractId(tab));
    }));
}

// SNAPSHOT/RESTORE: what a move by the addon means for the movers' sub-groups. The census of a
// sub-group is its sessions - visible, hidden and unsync tabs alike. A sub-group whose every
// member is in the moved set travels as itself: same stable id, wherever it goes - the addon's
// counterpart of the browser's header drag, which STG's UI does not have. A partial move within
// the sub-group's own STG group follows the browser rule - the movers lose it; a partial move
// to ANOTHER group follows the cloneSubGroupsWhenMovingTabs setting - off: the movers lose it,
// on: the sub-group is CLONED into the target under a fresh stable id. Landing inside another
// sub-group's span wins over all of this (the browser's placement / destGroupNativeId). Meta
// comes from any group's groupsNative, or from the live browser group (unsync tabs in a window
// without an active group).
export async function snapshotMembership(movedTabs, groups, targetGroupId) {
    if (!movedTabs.length) {
        return null;
    }

    const metaById = new Map;

    for (const group of groups) {
        for (const entry of group.groupsNative ?? []) {
            metaById.set(entry.id, entry);
        }
    }

    const allTabs = await browser.tabs.query({pinned: false});

    await Promise.allSettled(allTabs.map(tab => Cache.loadTabNativeGroupId(tab.id)));

    const memberIdsByStableId = new Map;

    for (const tab of allTabs) {
        const stableId = Cache.getTabNativeGroupId(tab.id);
        stableId && memberIdsByStableId.getOrInsert(stableId, new Set).add(tab.id);
    }

    const movedIds = new Set(movedTabs.map(tab => tab.id));

    async function resolveCarriedMeta(stableId, sameGroup) {
        let meta = metaById.get(stableId);

        if (!meta) {
            const liveId = liveIdByStableId.get(stableId);
            const live = liveId ? await browser.tabGroups.get(liveId).catch(() => null) : null;

            if (!live) {
                return null;
            }

            meta = toEntry(stableId, live);
        }

        const memberIds = memberIdsByStableId.get(stableId) ?? movedIds;
        const wholeMove = [...memberIds].every(id => movedIds.has(id));

        if (wholeMove) {
            return meta;
        }

        if (sameGroup) {
            return null; // the browser rule; there is no cloning inside one group
        }

        return settings.cloneSubGroupsWhenMovingTabs ? {...meta, id: createSubGroupId()} : null;
    }

    const carriedMeta = new Map; // source stable id → meta in the target, null = the movers lose it
    const snapshot = new Map; // tabId → sub-group meta in the target

    for (const tab of movedTabs) {
        const stableId = Cache.getTabNativeGroupId(tab.id);

        if (!stableId) {
            continue;
        }

        if (!carriedMeta.has(stableId)) {
            carriedMeta.set(stableId, await resolveCarriedMeta(stableId, tab.groupId === targetGroupId));
        }

        const meta = carriedMeta.get(stableId);

        if (meta) {
            snapshot.set(tab.id, meta);
        }
    }

    return snapshot.size ? snapshot : null;
}

// restore the carried membership after the move: write the (possibly cloned) sub-group id into
// the sessions, ensure the metadata entry and (for a loaded group) the live group. A mover that
// carried nothing loses its stale session - its sub-group stayed behind or was dropped by the
// snapshot rules. The browser's own placement wins: a tab that landed inside another native
// span keeps it.
export async function restoreMembership(group, movedTabs, snapshot = null) {
    snapshot ??= new Map;

    const windowId = Cache.getWindowId(group.id);
    const log = logger.start(restoreMembership, 'group:', group.id, {windowId}, 'carried:', snapshot.size);

    if (windowId) {
        await withWindowGate(windowId, async () => {
            const [winTabs, liveGroups] = await Promise.all([
                browser.tabs.query({windowId, pinned: false, hidden: false}),
                browser.tabGroups.query({windowId}),
            ]);

            const liveIdByTabId = new Map(winTabs.map(tab => [tab.id, tab.groupId]));
            const liveIdsInWindow = new Set(liveGroups.map(groupNative => groupNative.id));
            const memberTabsByMeta = new Map;

            for (const tab of movedTabs) {
                const meta = snapshot.get(tab.id);

                if (liveIdByTabId.get(tab.id) !== TAB_GROUP_ID_NONE) {
                    continue;
                }

                if (meta) {
                    memberTabsByMeta.getOrInsert(meta, []).push(tab);
                } else if (Cache.getTabNativeGroupId(tab.id)) {
                    // the moved tab objects come from moveNative with the session keys
                    // stripped - ask the cache, not the object
                    delete tab.groupNativeId;
                    await Cache.removeTabNativeGroupId(tab.id);
                }
            }

            for (const [meta, memberTabs] of memberTabsByMeta) {
                try {
                    for (const tab of memberTabs) {
                        if (Cache.getTabNativeGroupId(tab.id) !== meta.id) {
                            // a clone travels under its fresh id
                            tab.groupNativeId = meta.id;
                            await Cache.setTabNativeGroupId(tab.id, meta.id);
                        }
                    }

                    // the sub-group was carried here earlier and is still live - join it
                    const existingLiveId = liveIdByStableId.get(meta.id);
                    const joinLiveId = liveIdsInWindow.has(existingLiveId) ? existingLiveId : null;

                    const liveId = await Tabs.group(memberTabs, windowId, true, joinLiveId);

                    if (!joinLiveId) {
                        await browser.tabGroups.update(liveId, {
                            collapsed: meta.collapsed,
                            color: meta.color,
                            title: meta.title,
                        });

                        linkLiveGroup(liveId, meta.id);
                        markMaterialized(windowId, meta.id);
                    }
                } catch (e) {
                    log.logError(['cant restore native group', meta], e);
                }
            }
        });

        // the mirror picks the created sub-groups up into the active group's metadata
        scheduleMirrorWindow(windowId);
    } else {
        const groupsNative = group.groupsNative?.slice() ?? [];
        const knownIds = new Set(groupsNative.map(entry => entry.id));
        let groupsNativeChanged = false;

        await Promise.allSettled(movedTabs.map(async tab => {
            const meta = snapshot.get(tab.id);

            if (!meta) {
                // the moved tab objects come from moveNative with the session keys
                // stripped - ask the cache, not the object
                if (Cache.getTabNativeGroupId(tab.id)) {
                    delete tab.groupNativeId;
                    await Cache.removeTabNativeGroupId(tab.id);
                }
                return;
            }

            if (Cache.getTabNativeGroupId(tab.id) !== meta.id) {
                // a clone travels under its fresh id
                tab.groupNativeId = meta.id;
                await Cache.setTabNativeGroupId(tab.id, meta.id);
            }

            if (!knownIds.has(meta.id)) {
                knownIds.add(meta.id);
                groupsNative.push({...meta});
                groupsNativeChanged = true;
            }
        }));

        if (groupsNativeChanged) {
            await Groups.update(group.id, {groupsNative});
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
            log.stop('applied native groups');
        } else {
            log.stop('no active group');
        }
    } else {
        await mirrorWindow(windowId);
        log.stop('mirrored from browser');
    }
}
