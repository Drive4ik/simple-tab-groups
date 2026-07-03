import * as Constants from '/js/constants.js';

export const storage = localStorage.create(Constants.MODULES.CLOUD);

const LAST_PUSHED_SEQ_PREFIX = 'deltaLastPushedSeq:';
const RESET_PENDING_PREFIX = 'deltaResetPending:';
const PENDING_TRUNCATE_PREFIX = 'deltaPendingTruncateSeq:';
const BASELINE_PREFIX = 'deltaBaseline:';

export const PRE_APPLY_BACKUP_SLOTS = 5;
export const PRE_APPLY_BACKUP_SLOT_KEY = 'deltaPreApplyBackupSlot';

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

export function maxSeq(events, seed) {
    return events.reduce((max, e) => (e.seq > max ? e.seq : max), seed);
}

export function loadBaseline(deviceId) {
    const raw = storage[baselineKey(deviceId)];
    if (!raw) {
        return {tabUids: new Set(), groupIds: new Set(), optionKeys: new Set(), pinnedUids: new Set()};
    }
    try {
        const parsed = JSON.parse(raw);
        return {
            tabUids: new Set(parsed.tabUids || []),
            groupIds: new Set(parsed.groupIds || []),
            optionKeys: new Set(parsed.optionKeys || []),
            pinnedUids: new Set(parsed.pinnedUids || []),
        };
    } catch {
        return {tabUids: new Set(), groupIds: new Set(), optionKeys: new Set(), pinnedUids: new Set()};
    }
}

export function saveBaseline(deviceId, baseline) {
    storage[baselineKey(deviceId)] = JSON.stringify({
        tabUids: baseline.tabUids || [],
        groupIds: baseline.groupIds || [],
        optionKeys: baseline.optionKeys || [],
        pinnedUids: baseline.pinnedUids || [],
    });
}
