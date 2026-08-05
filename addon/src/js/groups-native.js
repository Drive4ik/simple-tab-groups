import Listeners from './listeners.js\
?tabGroups.onCreated\
&tabGroups.onUpdated\
&tabGroups.onMoved\
&tabGroups.onRemoved\
';
import Logger from './logger.js';
import BatchProcessor from './batch-processor.js';
import * as Cache from './cache.js';
import * as Tabs from './tabs.js';
import * as Groups from './groups.js';

export const TAB_GROUP_ID_NONE = browser.tabGroups.TAB_GROUP_ID_NONE;

const logger = new Logger('GroupsNative');

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

export function createSubGroupId() {
    return self.crypto.randomUUID().slice(0, 8);
}

const liveIdByStableId = new Map;
const stableIdByLiveId = new Map;

// stable ids the browser has materialized in this session. For a visible tab outside any live
// group the mirror clears the session only when its id was live once (the user pulled the tab
// out or deleted the group); an id the browser never knew is a pending import - the session is
// the only thing that will materialize it, so it must stay.
const materializedSubGroupIds = new Set;

function linkLiveGroup(liveId, stableId) {
    const prevLiveId = liveIdByStableId.get(stableId);

    if (prevLiveId !== undefined && prevLiveId !== liveId) {
        stableIdByLiveId.delete(prevLiveId);
    }

    liveIdByStableId.set(stableId, liveId);
    stableIdByLiveId.set(liveId, stableId);
    materializedSubGroupIds.add(stableId);
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
                mirrorBatch.add(windowId, windowId);
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

export function scheduleMirrorWindow(windowId) {
    if (!windowId) {
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

        return toEntry(stableId, groupNative);
    });

    // sessions: the live state wins, except ids the browser never materialized (pending imports)
    let sessionsChanged = false;

    await Promise.allSettled(winTabs.map(tab => {
        const liveId = liveIdByTabId.get(tab.id);
        const sessionId = Cache.getTabNativeGroupId(tab.id);

        const stableId = liveId
            ? stableIdByLiveId.get(liveId)
            : (sessionId && !materializedSubGroupIds.has(sessionId) ? sessionId : undefined);

        if (stableId !== sessionId) {
            sessionsChanged = true;
            return Cache.setTabNativeGroupId(tab.id, stableId);
        }
    }));

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

    if (isSameGroupsNative(group.groupsNative, groupsNative)) {
        log.stop('no metadata changes');
    } else {
        await Groups.update(groupId, {groupsNative});
        log.stop('updated, count:', groupsNative.length);
    }
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

// the only way to hide tabs: a hidden tab must not stay in a live native group, the group's
// header would remain in the tab bar (docs/TABGROUPS-BEHAVIOR.md §4). The sessions keep the
// membership, so the sub-groups are recreated on the next apply.
// clearMembership=true - the sub-groups are consciously destroyed (unsync tabs policy)
export function hideTabs(tabs, {clearMembership = false, skipTrackingFlag = false} = {}) {
    tabs = Array.isArray(tabs) ? tabs : [tabs];

    // tabs may be an array of ids - then there is no window to gate,
    // the mirror will just resync after the fact
    const windowId = tabs.find(tab => tab.windowId)?.windowId;

    const operation = () => hideTabsNow(tabs, clearMembership, skipTrackingFlag);

    return windowId ? withWindowGate(windowId, operation) : operation();
}

async function hideTabsNow(tabs, clearMembership, skipTrackingFlag) {
    const log = logger.start(hideTabsNow, 'count:', tabs.length, {clearMembership, skipTrackingFlag});

    if (!tabs.length) {
        log.stop('tabs are empty');
        return;
    }

    await Tabs.ungroup(tabs, true);
    await Tabs.hideNative(tabs, skipTrackingFlag);

    if (clearMembership) {
        await Promise.allSettled(tabs.map(tab => {
            delete tab.groupNativeId;
            return Cache.removeTabNativeGroupId(Tabs.extractId(tab));
        }));
    }

    log.stop();
}

// SNAPSHOT/RESTORE: tabs moved between STG groups carry their sub-group with them - the stable id
// in the session travels with the tab. Snapshot the metadata before the move: tabId → meta.
// Meta comes from any group's groupsNative, or from the live browser group (unsync tabs in a
// window without an active group).
export async function snapshotMembership(tabs, groups) {
    const metaById = new Map;

    for (const group of groups) {
        for (const entry of group.groupsNative ?? []) {
            metaById.set(entry.id, entry);
        }
    }

    const snapshot = new Map; // tabId → source sub-group meta

    for (const tab of tabs) {
        const stableId = Cache.getTabNativeGroupId(tab.id);

        if (!stableId) {
            continue;
        }

        let meta = metaById.get(stableId);

        if (!meta) {
            const liveId = liveIdByStableId.get(stableId);
            const live = liveId ? await browser.tabGroups.get(liveId).catch(() => null) : null;

            if (live) {
                meta = toEntry(stableId, live);
                metaById.set(stableId, meta);
            }
        }

        if (meta) {
            snapshot.set(tab.id, meta);
        }
    }

    return snapshot.size ? snapshot : null;
}

// restore the carried membership after the move: the session already holds the sub-group id,
// so only the metadata entry and (for a loaded group) the live group need to be ensured.
// The browser's own placement wins: a tab that landed inside another native span keeps it.
export async function restoreMembership(group, movedTabs, snapshot = null) {
    snapshot ??= new Map;

    const windowId = Cache.getWindowId(group.id);
    const log = logger.start(restoreMembership, 'group:', group.id, {windowId}, 'carried:', snapshot.size);

    if (windowId) {
        if (!snapshot.size) {
            log.stop('nothing to restore');
            return;
        }

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

                if (meta && liveIdByTabId.get(tab.id) === TAB_GROUP_ID_NONE) {
                    memberTabsByMeta.getOrInsert(meta, []).push(tab);
                }
            }

            for (const [meta, memberTabs] of memberTabsByMeta) {
                try {
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

        await Promise.allSettled(movedTabs.map(tab => {
            const meta = snapshot.get(tab.id);

            if (!meta) {
                // moved out of its sub-group (same-group reorder), or a carried id without
                // metadata anywhere - drop the membership. The moved tab objects come from
                // moveNative with the session keys stripped - ask the cache, not the object
                if (Cache.getTabNativeGroupId(tab.id)) {
                    delete tab.groupNativeId;
                    return Cache.removeTabNativeGroupId(tab.id);
                }
                return;
            }

            // the session already holds meta.id - only the metadata entry has to follow the tab
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
