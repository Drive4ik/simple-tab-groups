export function shouldSleepSyncedTab(tabRecord, isPinned, options = {}) {
    if (isPinned) {
        return options.syncSleepPinnedTabs === true;
    }

    if (!options.syncSleepNewTabs) {
        return false;
    }

    if (options.syncActivatePreviouslyActiveTabs && tabRecord && tabRecord.loaded === true) {
        return false;
    }

    return true;
}

export const SLEEP_OPTION_KEYS = Object.freeze([
    'syncSleepNewTabs',
    'syncSleepPinnedTabs',
    'syncActivatePreviouslyActiveTabs',
]);
