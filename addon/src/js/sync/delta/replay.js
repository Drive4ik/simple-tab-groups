const DEFAULT_COOKIE_STORE_ID = 'firefox-default';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function defaultGroupTitle(groupId) {
    const uid = (groupId == null ? '' : String(groupId)).slice(-4) || '{uid}';
    return `Group ${uid}`;
}

function sanitizeGroupTitle(title, groupId) {
    const str = title == null ? '' : String(title);
    if (!str || str === String(groupId) || UUID_RE.test(str)) {
        return defaultGroupTitle(groupId);
    }
    return str;
}

const ADDITIVE_TAB_FLAGS = ['pinned', 'loaded'];

function preserveAdditiveFlags(incoming, prior) {
    if (!prior) {
        return;
    }
    for (const flag of ADDITIVE_TAB_FLAGS) {
        if (!Object.hasOwn(incoming, flag) && Object.hasOwn(prior, flag)) {
            incoming[flag] = prior[flag];
        }
    }
}

const OPS = {
    TAB_ADD: 'tab.add',
    TAB_MODIFY: 'tab.modify',
    TAB_MOVE: 'tab.move',
    TAB_REMOVE: 'tab.remove',
    GROUP_ADD: 'group.add',
    GROUP_MODIFY: 'group.modify',
    GROUP_MOVE: 'group.move',
    GROUP_REMOVE: 'group.remove',
    OPTION_SET: 'option.set',
    PINNED_ADD: 'pinned.add',
    PINNED_MODIFY: 'pinned.modify',
    PINNED_MOVE: 'pinned.move',
    PINNED_REMOVE: 'pinned.remove',
};

function deepClone(value) {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(deepClone);
    }
    const out = {};
    for (const key of Object.keys(value)) {
        out[key] = deepClone(value[key]);
    }
    return out;
}

function buildOrderedEvents(deltaLogs) {
    const entries = [];

    for (const log of deltaLogs || []) {
        const deviceId = log?.deviceId;
        for (const event of log?.events || []) {
            entries.push({deviceId, event});
        }
    }

    entries.sort((a, b) => {
        const tsA = a.event.ts ?? 0;
        const tsB = b.event.ts ?? 0;
        if (tsA !== tsB) {
            return tsA - tsB;
        }
        if (a.deviceId !== b.deviceId) {
            return a.deviceId < b.deviceId ? -1 : 1;
        }
        return (a.event.seq ?? 0) - (b.event.seq ?? 0);
    });

    return entries;
}

function insertTabAt(group, tab, index) {
    const len = group.tabs.length;
    let at = Number.isInteger(index) ? index : len;
    if (at < 0) {
        at = 0;
    }
    if (at > len) {
        at = len;
    }
    group.tabs.splice(at, 0, tab);
}

function findTab(groups, uid) {
    for (const group of groups) {
        const tabIndex = group.tabs.findIndex(t => t.uid === uid);
        if (tabIndex !== -1) {
            return {group, tabIndex};
        }
    }
    return {group: null, tabIndex: -1};
}

function ensureGroup(groups, groupId) {
    let group = groups.find(g => g.id === groupId);
    if (!group) {
        group = {id: groupId, title: defaultGroupTitle(groupId), tabs: []};
        groups.push(group);
    }
    if (!Array.isArray(group.tabs)) {
        group.tabs = [];
    }
    return group;
}

function applyTabUpsert(groups, event) {
    const incoming = deepClone(event.tab);
    if (!incoming || incoming.uid == null) {
        return;
    }

    if (incoming.cookieStoreId == null) {
        incoming.cookieStoreId = DEFAULT_COOKIE_STORE_ID;
    }

    const existing = findTab(groups, incoming.uid);
    if (existing.group) {
        preserveAdditiveFlags(incoming, existing.group.tabs[existing.tabIndex]);
        existing.group.tabs.splice(existing.tabIndex, 1);
    }

    const target = ensureGroup(groups, event.groupId);
    insertTabAt(target, incoming, incoming.index);
}

function applyTabMove(groups, event) {
    const found = findTab(groups, event.uid);
    if (!found.group) {
        return;
    }

    const [tab] = found.group.tabs.splice(found.tabIndex, 1);

    const target = ensureGroup(groups, event.groupId);
    insertTabAt(target, tab, event.toIndex);
}

function applyTabRemove(groups, event) {
    const found = findTab(groups, event.uid);
    if (found.group) {
        found.group.tabs.splice(found.tabIndex, 1);
    }
}

function insertInListAt(list, tab, index) {
    const len = list.length;
    let at = Number.isInteger(index) ? index : len;
    if (at < 0) {
        at = 0;
    }
    if (at > len) {
        at = len;
    }
    list.splice(at, 0, tab);
}

function applyPinnedUpsert(pinnedTabs, event) {
    const incoming = deepClone(event.tab);
    if (!incoming || incoming.uid == null) {
        return;
    }

    if (incoming.cookieStoreId == null) {
        incoming.cookieStoreId = DEFAULT_COOKIE_STORE_ID;
    }

    const existingIdx = pinnedTabs.findIndex(t => t.uid === incoming.uid);
    if (existingIdx !== -1) {
        preserveAdditiveFlags(incoming, pinnedTabs[existingIdx]);
        pinnedTabs.splice(existingIdx, 1);
    }

    insertInListAt(pinnedTabs, incoming, incoming.index);
}

function applyPinnedMove(pinnedTabs, event) {
    const idx = pinnedTabs.findIndex(t => t.uid === event.uid);
    if (idx === -1) {
        return;
    }
    const [tab] = pinnedTabs.splice(idx, 1);
    insertInListAt(pinnedTabs, tab, event.toIndex);
}

function applyPinnedRemove(pinnedTabs, event) {
    const idx = pinnedTabs.findIndex(t => t.uid === event.uid);
    if (idx !== -1) {
        pinnedTabs.splice(idx, 1);
    }
}

function applyGroupUpsert(groups, event) {
    const incoming = deepClone(event.group);
    if (!incoming || incoming.id == null) {
        return;
    }

    const existing = groups.find(g => g.id === incoming.id);
    const {tabs: incomingTabs, ...props} = incoming;

    if (Object.hasOwn(props, 'title')) {
        props.title = sanitizeGroupTitle(props.title, incoming.id);
    }

    if (existing) {
        Object.assign(existing, props);
        if (!Array.isArray(existing.tabs)) {
            existing.tabs = [];
        }
    } else {
        groups.push({
            ...props,
            tabs: Array.isArray(incomingTabs) ? deepClone(incomingTabs) : [],
        });
    }
}

function applyGroupMove(groups, event) {
    const from = groups.findIndex(g => g.id === event.groupId);
    if (from === -1) {
        return;
    }

    const [group] = groups.splice(from, 1);

    let to = Number.isInteger(event.toIndex) ? event.toIndex : groups.length;
    if (to < 0) {
        to = 0;
    }
    if (to > groups.length) {
        to = groups.length;
    }

    groups.splice(to, 0, group);
}

function applyGroupRemove(groups, event) {
    const idx = groups.findIndex(g => g.id === event.groupId);
    if (idx !== -1) {
        groups.splice(idx, 1);
    }
}

export function replay(baseSnapshot, deltaLogs = []) {
    const groups = deepClone(baseSnapshot?.groups || []).map(group => ({
        ...group,
        tabs: Array.isArray(group.tabs) ? group.tabs : [],
    }));

    const pinnedTabs = Array.isArray(baseSnapshot?.pinnedTabs) ? deepClone(baseSnapshot.pinnedTabs) : [];

    const resolvedOptions = deepClone(baseSnapshot?.options || {});

    const containers = deepClone(baseSnapshot?.containers || {});

    const baseWatermark = baseSnapshot?.watermark || {};

    const watermark = {...baseWatermark};

    const ordered = buildOrderedEvents(deltaLogs);

    for (const {deviceId, event} of ordered) {
        const folded = baseWatermark[deviceId] ?? 0;

        if (event.seq != null && event.seq <= folded) {
            continue;
        }

        switch (event.op) {
            case OPS.TAB_ADD:
            case OPS.TAB_MODIFY:
                applyTabUpsert(groups, event);
                break;
            case OPS.TAB_MOVE:
                applyTabMove(groups, event);
                break;
            case OPS.TAB_REMOVE:
                applyTabRemove(groups, event);
                break;
            case OPS.GROUP_ADD:
            case OPS.GROUP_MODIFY:
                applyGroupUpsert(groups, event);
                break;
            case OPS.GROUP_MOVE:
                applyGroupMove(groups, event);
                break;
            case OPS.GROUP_REMOVE:
                applyGroupRemove(groups, event);
                break;
            case OPS.PINNED_ADD:
            case OPS.PINNED_MODIFY:
                applyPinnedUpsert(pinnedTabs, event);
                break;
            case OPS.PINNED_MOVE:
                applyPinnedMove(pinnedTabs, event);
                break;
            case OPS.PINNED_REMOVE:
                applyPinnedRemove(pinnedTabs, event);
                break;
            case OPS.OPTION_SET:
                if (event.key != null) {
                    resolvedOptions[event.key] = deepClone(event.value);
                }
                break;
            default:
                break;
        }

        if (event.seq != null && (watermark[deviceId] == null || event.seq > watermark[deviceId])) {
            watermark[deviceId] = event.seq;
        }
    }

    for (const group of groups) {
        group.tabs.forEach((tab, position) => {
            tab.index = position;
        });
    }

    pinnedTabs.forEach((tab, position) => {
        tab.index = position;
    });

    return {
        snapshot: {groups, pinnedTabs, options: resolvedOptions, containers, watermark},
        watermark,
    };
}
