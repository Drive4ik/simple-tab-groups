export const PENDING_PREFIX = 'deltaOfflineRemovePending:';

export function pendingKey(deviceId) {
    return PENDING_PREFIX + deviceId;
}

export function loadPendingOfflineRemoves(store, deviceId) {
    const raw = store[pendingKey(deviceId)];
    if (!raw) {
        return [];
    }
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function persistPendingOfflineRemoves(store, deviceId, removes) {
    store[pendingKey(deviceId)] = JSON.stringify(removes);
}

export function dropPendingOfflineRemoves(store, deviceId) {
    delete store[pendingKey(deviceId)];
}

export function takePendingOfflineRemoves(store, deviceId) {
    const removes = loadPendingOfflineRemoves(store, deviceId);
    dropPendingOfflineRemoves(store, deviceId);
    return removes;
}
