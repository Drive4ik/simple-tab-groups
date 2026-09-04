export const CONTENT_MARK_MAX_ENTRIES = 5000;

function hashText(text, seed) {
    let hash = seed >>> 0;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

export function contentMark(record) {
    const src = record || {};
    const text = `${src.url ?? ''}\n${src.title ?? ''}\n${src.pinned === true ? 1 : 0}`;
    return `${hashText(text, 0x811c9dc5)}.${hashText(text, 0x0badf00d)}`;
}

export function capContentMarks(marks) {
    const uids = Object.keys(marks);
    if (uids.length <= CONTENT_MARK_MAX_ENTRIES) {
        return marks;
    }

    const capped = {};
    for (const uid of uids.slice(0, CONTENT_MARK_MAX_ENTRIES)) {
        capped[uid] = marks[uid];
    }
    return capped;
}

export function contentMarksFromSnapshot(snapshot) {
    const marks = {};

    for (const group of (snapshot && snapshot.groups) || []) {
        for (const tab of Array.isArray(group.tabs) ? group.tabs : []) {
            if (tab && tab.uid != null) {
                marks[tab.uid] = contentMark(tab);
            }
        }
    }

    for (const tab of Array.isArray(snapshot && snapshot.pinnedTabs) ? snapshot.pinnedTabs : []) {
        if (tab && tab.uid != null) {
            marks[tab.uid] = contentMark(tab);
        }
    }

    return capContentMarks(marks);
}

const CONTENT_EVENT_OPS = new Set(['tab.add', 'tab.modify', 'pinned.add', 'pinned.modify']);
const CONTENT_REMOVE_OPS = new Set(['tab.remove', 'pinned.remove']);

export function contentMarksFromEvents(syncedMarks, events) {
    const marks = syncedMarks && typeof syncedMarks === 'object' && !Array.isArray(syncedMarks)
        ? {...syncedMarks}
        : {};

    for (const event of Array.isArray(events) ? events : []) {
        if (CONTENT_EVENT_OPS.has(event?.op) && event.tab?.uid != null) {
            marks[event.tab.uid] = contentMark(event.tab);
        } else if (CONTENT_REMOVE_OPS.has(event?.op) && event?.uid != null) {
            delete marks[event.uid];
        }
    }

    return capContentMarks(marks);
}

export function isSyncedContent(marks, uid, record) {
    if (uid == null || !marks) {
        return false;
    }

    const mark = marks[uid];

    return typeof mark === 'string' && mark === contentMark(record);
}
