import * as Constants from '/js/constants.js';
import * as DeltaLog from './delta-log.js';
import {contentMarksFromEvents} from './content-marks.js';
import {PENDING_NAV_KEY} from './pending-nav.js';
import {pendingKey as offlineRemovePendingKey} from './offline-remove-record.js';

export const storage = localStorage.create(Constants.MODULES.CLOUD);

const LAST_PUSHED_SEQ_PREFIX = 'deltaLastPushedSeq:';
const RESET_PENDING_PREFIX = 'deltaResetPending:';
const PENDING_TRUNCATE_PREFIX = 'deltaPendingTruncateSeq:';
const BASELINE_PREFIX = 'deltaBaseline:';
const FAVICON_MAP_PREFIX = 'deltaFavIconMap:';
const CONTENT_MARKS_PREFIX = 'deltaContentMarks:';

export const PRE_APPLY_BACKUP_SLOTS = 5;
export const PRE_APPLY_BACKUP_SLOT_KEY = 'deltaPreApplyBackupSlot';

export const lastSyncErrorKey = 'deltaLastSyncError';

export function preApplyBackupFilePath(template, slot) {
    return template.replaceAll('{slot}', String(slot));
}

export function lastPushedSeqKey(deviceId) {
    return LAST_PUSHED_SEQ_PREFIX + deviceId;
}

export function baselineKey(deviceId) {
    return BASELINE_PREFIX + deviceId;
}

export function resetPendingKey(deviceId) {
    return RESET_PENDING_PREFIX + deviceId;
}

export function pendingTruncateKey(deviceId) {
    return PENDING_TRUNCATE_PREFIX + deviceId;
}

export function favIconMapKey(deviceId) {
    return FAVICON_MAP_PREFIX + deviceId;
}

export function contentMarksKey(deviceId) {
    return CONTENT_MARKS_PREFIX + deviceId;
}

let cachedContentMarksDeviceId = null;
let cachedContentMarks = null;

export function invalidateContentMarks() {
    cachedContentMarksDeviceId = null;
    cachedContentMarks = null;
}

function storedContentMarks(deviceId) {
    const raw = storage[contentMarksKey(deviceId)];
    const marks = raw?.marks;

    return {
        seq: Number(raw?.seq) || 0,
        marks: marks && typeof marks === 'object' && !Array.isArray(marks) ? marks : {},
    };
}

export async function loadContentMarks(deviceId) {
    if (cachedContentMarksDeviceId === deviceId && cachedContentMarks) {
        return cachedContentMarks;
    }

    const {seq, marks} = storedContentMarks(deviceId);
    const eventsSinceMarks = await DeltaLog.getEventsSince(seq);

    cachedContentMarks = contentMarksFromEvents(marks, eventsSinceMarks);
    cachedContentMarksDeviceId = deviceId;

    return cachedContentMarks;
}

export function rememberContentMark(deviceId, uid, mark) {
    if (uid == null || !mark || cachedContentMarksDeviceId !== deviceId || !cachedContentMarks) {
        return;
    }
    cachedContentMarks[uid] = mark;
}

export function forgetContentMark(deviceId, uid) {
    if (uid == null || cachedContentMarksDeviceId !== deviceId || !cachedContentMarks) {
        return;
    }
    delete cachedContentMarks[uid];
}

export function saveContentMarks(deviceId, marks, seq) {
    storage[contentMarksKey(deviceId)] = {seq: Number(seq) || 0, marks};
    invalidateContentMarks();
}

export function clearDeviceSyncState(deviceId) {
    delete storage[baselineKey(deviceId)];
    delete storage[lastPushedSeqKey(deviceId)];
    delete storage[pendingTruncateKey(deviceId)];
    delete storage[favIconMapKey(deviceId)];
    delete storage[contentMarksKey(deviceId)];
    delete storage[offlineRemovePendingKey(deviceId)];
    delete storage[PENDING_NAV_KEY];
    delete storage[lastSyncErrorKey];

    invalidateContentMarks();
}

export function maxSeq(events, seed) {
    return events.reduce((max, e) => (e.seq > max ? e.seq : max), seed);
}

function emptyTombstones() {
    return {tabs: [], pinned: []};
}

function normalizeTombstones(raw) {
    const src = raw || {};
    return {
        tabs: Array.isArray(src.tabs) ? src.tabs : [],
        pinned: Array.isArray(src.pinned) ? src.pinned : [],
    };
}

function emptyBaseline() {
    return {
        tabUids: new Set(),
        groupIds: new Set(),
        optionKeys: new Set(),
        pinnedUids: new Set(),
        tabGroups: {},
        tombstones: emptyTombstones(),
    };
}

export function loadBaseline(deviceId) {
    const raw = storage[baselineKey(deviceId)];
    if (!raw) {
        return emptyBaseline();
    }
    try {
        const parsed = JSON.parse(raw);
        return {
            tabUids: new Set(parsed.tabUids || []),
            groupIds: new Set(parsed.groupIds || []),
            optionKeys: new Set(parsed.optionKeys || []),
            pinnedUids: new Set(parsed.pinnedUids || []),
            tabGroups: parsed.tabGroups && typeof parsed.tabGroups === 'object' ? parsed.tabGroups : {},
            tombstones: normalizeTombstones(parsed.tombstones),
        };
    } catch {
        return emptyBaseline();
    }
}

export function saveBaseline(deviceId, baseline) {
    storage[baselineKey(deviceId)] = JSON.stringify({
        tabUids: baseline.tabUids || [],
        groupIds: baseline.groupIds || [],
        optionKeys: baseline.optionKeys || [],
        pinnedUids: baseline.pinnedUids || [],
        tabGroups: baseline.tabGroups || {},
        tombstones: normalizeTombstones(baseline.tombstones),
    });
}
