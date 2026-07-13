export const LOCAL_ONLY_OPTION_KEY_PREFIXES = Object.freeze(['sync', 'autoBackup']);

export const LOCAL_ONLY_OPTION_KEYS = Object.freeze(['temporaryContainerTitle', 'autoSyncEnable']);

export function isSyncedOptionKey(key) {
    if (LOCAL_ONLY_OPTION_KEYS.includes(key)) {
        return false;
    }
    return !LOCAL_ONLY_OPTION_KEY_PREFIXES.some(prefix => key.startsWith(prefix));
}

export function syncedOptionKeys(allOptionKeys) {
    return (allOptionKeys || []).filter(isSyncedOptionKey);
}
