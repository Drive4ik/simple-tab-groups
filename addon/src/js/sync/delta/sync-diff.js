const MAX_TEXT_LENGTH = 500;
const MAX_ARRAY_LENGTH = 50;
const GROUP_FIELDS = ['title', 'isArchive', 'iconColor', 'iconViewType', 'isSticky'];
const TAB_CONTENT_FIELDS = ['url', 'title'];
const TAB_POSITION_FIELDS = ['index', 'group'];
const TAB_FIELDS = [...TAB_CONTENT_FIELDS, ...TAB_POSITION_FIELDS];
const PINNED_GROUP_REF = 'pinned';

function clip(value, depth = 0) {
    if (typeof value === 'string') {
        const stripped = value.startsWith('data:') ? 'data:[stripped]' : value;
        return stripped.length > MAX_TEXT_LENGTH ? stripped.slice(0, MAX_TEXT_LENGTH) + '…' : stripped;
    }
    if (value == null || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (depth >= 3) {
        return '[nested]';
    }
    if (Array.isArray(value)) {
        return value.slice(0, MAX_ARRAY_LENGTH).map(item => clip(item, depth + 1));
    }
    if (typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value)) {
            out[key] = clip(value[key], depth + 1);
        }
        return out;
    }
    return String(value);
}

function equalValue(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

function indexTabs(snapshot) {
    const byUid = new Map();

    for (const group of snapshot?.groups || []) {
        const tabs = Array.isArray(group.tabs) ? group.tabs : [];
        tabs.forEach((tab, index) => {
            if (tab?.uid != null) {
                byUid.set(tab.uid, {
                    uid: tab.uid,
                    url: tab.url,
                    title: tab.title,
                    index,
                    group: group.id,
                    groupTitle: group.title,
                });
            }
        });
    }

    (snapshot?.pinnedTabs || []).forEach((tab, index) => {
        if (tab?.uid != null) {
            byUid.set(tab.uid, {
                uid: tab.uid,
                url: tab.url,
                title: tab.title,
                index,
                group: PINNED_GROUP_REF,
                groupTitle: PINNED_GROUP_REF,
            });
        }
    });

    return byUid;
}

function fieldChanges(before, after, fields) {
    const changes = [];
    for (const field of fields) {
        if (!equalValue(before[field], after[field])) {
            changes.push({field, from: clip(before[field]), to: clip(after[field])});
        }
    }
    return changes;
}

function diffTabs(before, after) {
    const beforeTabs = indexTabs(before);
    const afterTabs = indexTabs(after);
    const result = [];

    for (const [uid, tab] of afterTabs) {
        if (!beforeTabs.has(uid)) {
            result.push({uid, kind: 'added', url: clip(tab.url), title: clip(tab.title), group: tab.group, groupTitle: clip(tab.groupTitle)});
        } else {
            const before = beforeTabs.get(uid);
            const changes = fieldChanges(before, tab, TAB_FIELDS);
            if (changes.length) {
                const contentChanged = changes.some(change => TAB_CONTENT_FIELDS.includes(change.field));
                result.push({
                    uid,
                    kind: 'changed',
                    ...(contentChanged ? {} : {moveOnly: true}),
                    url: clip(tab.url),
                    title: clip(tab.title),
                    group: tab.group,
                    groupTitle: clip(tab.groupTitle),
                    fromGroup: before.group,
                    fromGroupTitle: clip(before.groupTitle),
                    changes,
                });
            }
        }
    }

    for (const [uid, tab] of beforeTabs) {
        if (!afterTabs.has(uid)) {
            result.push({uid, kind: 'removed', url: clip(tab.url), title: clip(tab.title), group: tab.group, groupTitle: clip(tab.groupTitle)});
        }
    }

    return result;
}

function indexGroups(snapshot) {
    const byId = new Map();
    for (const group of snapshot?.groups || []) {
        if (group?.id != null) {
            byId.set(group.id, group);
        }
    }
    return byId;
}

function diffGroups(before, after) {
    const beforeGroups = indexGroups(before);
    const afterGroups = indexGroups(after);
    const result = [];

    for (const [id, group] of afterGroups) {
        if (!beforeGroups.has(id)) {
            result.push({id, kind: 'added', title: clip(group.title)});
        } else {
            const changes = fieldChanges(beforeGroups.get(id), group, GROUP_FIELDS);
            if (changes.length) {
                result.push({id, kind: 'changed', title: clip(group.title), changes});
            }
        }
    }

    for (const [id, group] of beforeGroups) {
        if (!afterGroups.has(id)) {
            result.push({id, kind: 'removed', title: clip(group.title)});
        }
    }

    return result;
}

function diffOptions(before, after) {
    const beforeOptions = before?.options || {};
    const afterOptions = after?.options || {};
    const keys = new Set([...Object.keys(beforeOptions), ...Object.keys(afterOptions)]);
    const result = [];

    for (const key of keys) {
        const inBefore = Object.prototype.hasOwnProperty.call(beforeOptions, key);
        const inAfter = Object.prototype.hasOwnProperty.call(afterOptions, key);

        if (inBefore && !inAfter) {
            result.push({key, kind: 'removed', from: clip(beforeOptions[key])});
        } else if (!inBefore && inAfter) {
            result.push({key, kind: 'added', to: clip(afterOptions[key])});
        } else if (!equalValue(beforeOptions[key], afterOptions[key])) {
            result.push({key, kind: 'changed', from: clip(beforeOptions[key]), to: clip(afterOptions[key])});
        }
    }

    return result;
}

function countKinds(entries) {
    const counts = {added: 0, removed: 0, changed: 0, moved: 0};
    for (const entry of entries) {
        counts[entry.kind] += 1;
        if (entry.kind === 'changed' && entry.moveOnly) {
            counts.moved += 1;
        }
    }
    return counts;
}

function formatSegment(counts, noun) {
    const total = counts.added + counts.removed + counts.changed;
    if (!total) {
        return null;
    }

    const contentChanged = counts.changed - counts.moved;
    const parts = [];
    if (counts.added) {
        parts.push('+' + counts.added);
    }
    if (counts.removed) {
        parts.push('−' + counts.removed);
    }
    if (contentChanged) {
        parts.push('~' + contentChanged);
    }
    if (counts.moved) {
        parts.push('↔' + counts.moved);
    }

    return parts.join(' ') + ' ' + noun + (total === 1 ? '' : 's');
}

export function summarizeSyncDiff({tabs, groups, options}) {
    const segments = [
        formatSegment(countKinds(tabs), 'tab'),
        formatSegment(countKinds(groups), 'group'),
        formatSegment(countKinds(options), 'option'),
    ].filter(Boolean);

    return segments.join(', ');
}

export function computeSyncDiff(before, after) {
    const tabs = diffTabs(before, after);
    const groups = diffGroups(before, after);
    const options = diffOptions(before, after);

    return {
        tabs,
        groups,
        options,
        counts: {
            tabs: countKinds(tabs),
            groups: countKinds(groups),
            options: countKinds(options),
        },
        summary: summarizeSyncDiff({tabs, groups, options}),
    };
}

export function isEmptySyncDiff(diff) {
    return !diff.tabs.length && !diff.groups.length && !diff.options.length;
}
