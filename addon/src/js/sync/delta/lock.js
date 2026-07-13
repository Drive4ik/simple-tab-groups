export const LOCK_TTL_MS = 120000;

export const LOCK_CONFIRM_DELAY_MS = 1500;

export function isLockStale(lock, serverNow) {
    const expiresAt = Number(lock?.expiresAt);
    if (!Number.isFinite(expiresAt)) {
        return true;
    }
    return serverNow >= expiresAt;
}

export function canWriteLock(lock, selfDeviceId, serverNow) {
    if (isLockStale(lock, serverNow)) {
        return true;
    }
    return lock?.deviceId === selfDeviceId;
}

export function didWinLock(confirmedLock, selfDeviceId) {
    return confirmedLock?.deviceId === selfDeviceId;
}

export function makeLockStamp(selfDeviceId, serverNow, ttlMs = LOCK_TTL_MS) {
    return {deviceId: selfDeviceId, expiresAt: serverNow + ttlMs};
}
