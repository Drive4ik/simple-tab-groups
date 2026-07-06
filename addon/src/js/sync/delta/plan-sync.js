import {replay} from './replay.js';
import {isSyncedOptionKey} from './option-keys.js';
import {deepClone} from './deep-clone.js';

function buildFullLogs(pulledDeltaLogs, localPendingEvents, selfDeviceId) {
    const logs = deepClone(pulledDeltaLogs || []);

    let selfLog = logs.find(log => log.deviceId === selfDeviceId);
    if (!selfLog) {
        selfLog = {deviceId: selfDeviceId, events: []};
        logs.push(selfLog);
    }
    if (!Array.isArray(selfLog.events)) {
        selfLog.events = [];
    }

    const highestPulledSeq = selfLog.events.reduce((max, e) => (e.seq > max ? e.seq : max), 0);

    for (const event of localPendingEvents || []) {
        if (event.seq == null || event.seq > highestPulledSeq) {
            selfLog.events.push(deepClone(event));
        }
    }

    return {fullLogs: logs, selfEvents: selfLog.events};
}

function indexTabs(snapshot) {
    const byUid = new Map();
    for (const group of snapshot.groups || []) {
        const tabs = Array.isArray(group.tabs) ? group.tabs : [];
        tabs.forEach((tab, index) => {
            if (tab.uid != null) {
                byUid.set(tab.uid, {groupId: group.id, index, tab});
            }
        });
    }
    return byUid;
}

function groupProps(group) {
    const {tabs, ...props} = group;
    void tabs;
    return props;
}

function stableStringify(props) {
    const keys = Object.keys(props).sort();
    return JSON.stringify(keys.map(k => [k, props[k]]));
}

function normalizeBaseline(priorBaseline) {
    const src = priorBaseline || {};
    return {
        tabUids: new Set(src.tabUids || []),
        groupIds: new Set(src.groupIds || []),
        optionKeys: new Set(src.optionKeys || []),
        pinnedUids: new Set(src.pinnedUids || []),
    };
}

const TAB_CONTENT_FIELDS = ['url', 'title', 'cookieStoreId', 'pinned'];

const MIGRATED_PIN_CONTENT_FIELDS = ['url', 'title', 'cookieStoreId', 'favIconUrl', 'lastModified'];

function foldMigratedPinsIntoGroups(snapshot) {
    const groupTabsByUid = indexTabs(snapshot);
    const pinnedTabs = Array.isArray(snapshot.pinnedTabs) ? snapshot.pinnedTabs : [];

    snapshot.pinnedTabs = pinnedTabs.filter(pin => {
        const migrated = pin && pin.uid != null ? groupTabsByUid.get(pin.uid) : null;
        if (!migrated) {
            return true;
        }
        if ((pin.lastModified ?? 0) > (migrated.tab.lastModified ?? 0)) {
            for (const field of MIGRATED_PIN_CONTENT_FIELDS) {
                if (Object.hasOwn(pin, field)) {
                    migrated.tab[field] = deepClone(pin[field]);
                }
            }
        }
        return false;
    });

    snapshot.pinnedTabs.forEach((tab, position) => {
        tab.index = position;
    });
}

function resolveTabContentChanges(resolved, local) {
    const changed = {};
    for (const field of TAB_CONTENT_FIELDS) {
        if (field === 'pinned' || field === 'loaded') {
            if ((resolved[field] === true) !== (local[field] === true)) {
                changed[field] = resolved[field] === true;
            }
        } else if ((resolved[field] ?? null) !== (local[field] ?? null)) {
            changed[field] = deepClone(resolved[field]);
        }
    }
    return changed;
}

function diffToBrowserOps(resolvedSnapshot, localState, priorBaseline = {tabUids: new Set(), groupIds: new Set(), pinnedUids: new Set()}) {
    const resolvedGroups = resolvedSnapshot.groups || [];
    const localGroups = (localState && localState.groups) || [];

    const localGroupById = new Map(localGroups.map(g => [g.id, g]));
    const resolvedGroupById = new Map(resolvedGroups.map(g => [g.id, g]));

    const groupsToCreate = [];
    const groupsToRemove = [];
    const groupsToUpdate = [];

    for (const group of resolvedGroups) {
        const local = localGroupById.get(group.id);
        if (!local) {
            const {tabs, ...props} = group;
            void tabs;
            groupsToCreate.push(deepClone(props));
        } else if (stableStringify(groupProps(group)) !== stableStringify(groupProps(local))) {
            groupsToUpdate.push(deepClone(groupProps(group)));
        }
    }

    for (const group of localGroups) {
        if (!resolvedGroupById.has(group.id) && priorBaseline.groupIds.has(group.id)) {
            groupsToRemove.push({id: group.id});
        }
    }

    const resolvedTabs = indexTabs(resolvedSnapshot);
    const localTabs = indexTabs({groups: localGroups});

    const indexPinned = list => {
        const byUid = new Map();
        (Array.isArray(list) ? list : []).forEach((tab, index) => {
            if (tab && tab.uid != null) {
                byUid.set(tab.uid, {index, tab});
            }
        });
        return byUid;
    };

    const resolvedPinned = indexPinned(resolvedSnapshot.pinnedTabs);
    const localPinned = indexPinned(localState && localState.pinnedTabs);

    const tabsToCreate = [];
    const tabsToRemove = [];
    const tabsToMove = [];
    const tabsToUpdate = [];

    for (const [uid, {groupId, index, tab}] of resolvedTabs) {
        const local = localTabs.get(uid);
        if (!local) {
            if (localPinned.has(uid)) {
                continue;
            }
            tabsToCreate.push({
                ...deepClone(tab),
                target: {groupId, index},
            });
        } else {
            if (local.groupId !== groupId || local.index !== index) {
                tabsToMove.push({
                    uid,
                    target: {groupId, index},
                });
            }
            const changed = resolveTabContentChanges(tab, local.tab);
            if (Object.keys(changed).length) {
                tabsToUpdate.push({uid, target: changed});
            }
        }
    }

    for (const [uid, {groupId}] of localTabs) {
        if (!resolvedTabs.has(uid) && priorBaseline.tabUids.has(uid)) {
            tabsToRemove.push({uid, groupId});
        }
    }

    const pinnedToCreate = [];
    const pinnedToRemove = [];
    const pinnedToMove = [];
    const pinnedToUpdate = [];

    for (const [uid, {index, tab}] of resolvedPinned) {
        if (localTabs.has(uid)) {
            continue;
        }
        const local = localPinned.get(uid);
        if (!local) {
            pinnedToCreate.push({
                ...deepClone(tab),
                target: {index},
            });
        } else {
            if (local.index !== index) {
                pinnedToMove.push({uid, target: {index}});
            }
            const changed = resolveTabContentChanges(tab, local.tab);
            delete changed.pinned;
            if (Object.keys(changed).length) {
                pinnedToUpdate.push({uid, target: changed});
            }
        }
    }

    for (const [uid] of localPinned) {
        if (!resolvedPinned.has(uid) && !resolvedTabs.has(uid) && priorBaseline.pinnedUids.has(uid)) {
            pinnedToRemove.push({uid});
        }
    }

    const groupsOrder = computeGroupsOrder(resolvedGroups, localGroups);

    return {
        groupsToCreate, groupsToRemove, groupsToUpdate,
        tabsToCreate, tabsToRemove, tabsToMove, tabsToUpdate, groupsOrder,
        pinnedToCreate, pinnedToRemove, pinnedToMove, pinnedToUpdate,
    };
}

function computeGroupsOrder(resolvedGroups, localGroups) {
    const localIds = new Set(localGroups.map(g => g.id));
    const resolvedIds = new Set(resolvedGroups.map(g => g.id));

    const resolvedShared = resolvedGroups.map(g => g.id).filter(id => localIds.has(id));
    const localShared = localGroups.map(g => g.id).filter(id => resolvedIds.has(id));

    const sameOrder = resolvedShared.length === localShared.length
        && resolvedShared.every((id, i) => id === localShared[i]);

    if (sameOrder) {
        return null;
    }

    return resolvedGroups.map(g => g.id);
}

function diffOptionsToApply(resolvedOptions, localOptions) {
    const resolved = resolvedOptions || {};
    const local = localOptions || {};
    const toApply = {};

    for (const key of Object.keys(resolved)) {
        if (!isSyncedOptionKey(key)) {
            continue;
        }
        if (JSON.stringify(resolved[key]) !== JSON.stringify(local[key])) {
            toApply[key] = deepClone(resolved[key]);
        }
    }

    return toApply;
}

export function planSync({pulledSnapshot, pulledDeltaLogs, localPendingEvents, selfDeviceId, localState, priorBaseline, defaultGroupTitle}) {
    const {fullLogs, selfEvents} = buildFullLogs(pulledDeltaLogs, localPendingEvents, selfDeviceId);

    const {snapshot: resolvedSnapshot, watermark: newWatermark} = replay(pulledSnapshot || {groups: []}, fullLogs, {defaultGroupTitle});

    foldMigratedPinsIntoGroups(resolvedSnapshot);

    const pulledSelfLog = (pulledDeltaLogs || []).find(log => log.deviceId === selfDeviceId);
    const pulledSelfCount = pulledSelfLog && Array.isArray(pulledSelfLog.events) ? pulledSelfLog.events.length : 0;

    const deltaFileToWrite = selfEvents.length > pulledSelfCount
        ? {deviceId: selfDeviceId, events: selfEvents}
        : null;

    const baseline = normalizeBaseline(priorBaseline);

    const browserOps = diffToBrowserOps(resolvedSnapshot, localState || {groups: []}, baseline);

    const optionsToApply = diffOptionsToApply(resolvedSnapshot.options, (localState || {}).options);

    return {
        resolvedSnapshot,
        newWatermark,
        deltaFileToWrite,
        browserOps,
        optionsToApply,
    };
}

export function computeBootstrapEvents(localState, priorBaseline, knownLocalLogUids, knownLocalLogGroupRecordIds, knownLocalLogOptionKeys) {
    const baseline = normalizeBaseline(priorBaseline);
    const logUids = new Set(knownLocalLogUids || []);
    const logGroupRecordIds = new Set(knownLocalLogGroupRecordIds || []);
    const logOptionKeys = new Set(knownLocalLogOptionKeys || []);

    const events = [];
    const groups = (localState && localState.groups) || [];

    const groupTabUids = new Set();

    for (const group of groups) {
        if (group.id == null) {
            continue;
        }

        if (!baseline.groupIds.has(group.id) && !logGroupRecordIds.has(group.id)) {
            const {tabs, ...props} = group;
            void tabs;
            events.push({op: 'group.add', group: deepClone(props)});
        }

        for (const tab of Array.isArray(group.tabs) ? group.tabs : []) {
            if (tab.uid == null) {
                continue;
            }
            groupTabUids.add(tab.uid);
            if (!baseline.tabUids.has(tab.uid) && !logUids.has(tab.uid)) {
                events.push({op: 'tab.add', groupId: group.id, tab: deepClone(tab)});
            }
        }
    }

    const localOptions = (localState && localState.options) || {};
    for (const key of Object.keys(localOptions)) {
        if (!baseline.optionKeys.has(key) && !logOptionKeys.has(key)) {
            events.push({op: 'option.set', key, value: deepClone(localOptions[key])});
        }
    }

    const localPinnedTabs = (localState && localState.pinnedTabs) || [];
    for (const tab of Array.isArray(localPinnedTabs) ? localPinnedTabs : []) {
        if (tab.uid == null) {
            continue;
        }
        if (groupTabUids.has(tab.uid)) {
            continue;
        }
        if (!baseline.pinnedUids.has(tab.uid) && !logUids.has(tab.uid)) {
            events.push({op: 'pinned.add', tab: deepClone(tab)});
        }
    }

    for (const uid of groupTabUids) {
        if (baseline.pinnedUids.has(uid)) {
            events.push({op: 'pinned.remove', uid});
        }
    }

    return events;
}

export function baselineFromSnapshot(snapshot) {
    const tabUids = [];
    const groupIds = [];

    for (const group of (snapshot && snapshot.groups) || []) {
        if (group.id != null) {
            groupIds.push(group.id);
        }
        for (const tab of Array.isArray(group.tabs) ? group.tabs : []) {
            if (tab.uid != null) {
                tabUids.push(tab.uid);
            }
        }
    }

    const optionKeys = Object.keys((snapshot && snapshot.options) || {});

    const pinnedUids = [];
    for (const tab of Array.isArray(snapshot && snapshot.pinnedTabs) ? snapshot.pinnedTabs : []) {
        if (tab.uid != null) {
            pinnedUids.push(tab.uid);
        }
    }

    return {tabUids, groupIds, optionKeys, pinnedUids};
}
