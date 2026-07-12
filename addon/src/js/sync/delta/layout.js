export const RESERVED_FILE_PREFIX = 'STG-sync-';

export const SNAPSHOT_FILE_NAME = 'STG-sync-snapshot.json';

export const DELTA_FILE_PREFIX = 'STG-sync-delta-';

export const FAVICON_FILE_PREFIX = 'STG-sync-favicons-';

export const LOCK_FILE_NAME = 'STG-sync-lock.json';

const FILE_SUFFIX = '.json';

export function deltaFileName(deviceId) {
    return `${DELTA_FILE_PREFIX}${deviceId}${FILE_SUFFIX}`;
}

export function deviceIdFromDeltaFileName(fileName) {
    if (typeof fileName !== 'string' || !fileName.startsWith(DELTA_FILE_PREFIX) || !fileName.endsWith(FILE_SUFFIX)) {
        return null;
    }
    return fileName.slice(DELTA_FILE_PREFIX.length, -FILE_SUFFIX.length) || null;
}

export function favIconFileName(deviceId) {
    return `${FAVICON_FILE_PREFIX}${deviceId}${FILE_SUFFIX}`;
}

export function deviceIdFromFavIconFileName(fileName) {
    if (typeof fileName !== 'string' || !fileName.startsWith(FAVICON_FILE_PREFIX) || !fileName.endsWith(FILE_SUFFIX)) {
        return null;
    }
    return fileName.slice(FAVICON_FILE_PREFIX.length, -FILE_SUFFIX.length) || null;
}

export function isReservedFileName(fileName) {
    return typeof fileName === 'string' && fileName.startsWith(RESERVED_FILE_PREFIX);
}
