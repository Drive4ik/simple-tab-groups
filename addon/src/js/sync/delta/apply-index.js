import {isUrlSyncable, unwrapStubUrl} from './url-sync.js';

function syncableTabIndexesInOrder(tabs) {
    return (Array.isArray(tabs) ? tabs : [])
        .filter(tab => tab && Number.isFinite(tab.index) && isUrlSyncable(unwrapStubUrl(tab.url)))
        .map(tab => tab.index)
        .sort((a, b) => a - b);
}

export function resolveAbsoluteTabIndex(destGroupTabs, groupRelativeIndex) {
    const syncableIndexes = syncableTabIndexesInOrder(destGroupTabs);

    if (!syncableIndexes.length || !Number.isInteger(groupRelativeIndex) || groupRelativeIndex < 0) {
        return -1;
    }

    if (groupRelativeIndex >= syncableIndexes.length) {
        return syncableIndexes.at(-1) + 1;
    }

    return syncableIndexes[groupRelativeIndex];
}
