import {isUrlSyncable, unwrapStubUrl} from './url-sync.js';

function positionedTabs(tabs) {
    return (Array.isArray(tabs) ? tabs : [])
        .filter(tab => tab && Number.isFinite(tab.index));
}

function syncableTabIndexesInOrder(tabs) {
    return positionedTabs(tabs)
        .filter(tab => isUrlSyncable(unwrapStubUrl(tab.url)))
        .map(tab => tab.index)
        .sort((a, b) => a - b);
}

export function resolveAbsoluteTabIndex(destGroupTabs, groupRelativeIndex) {
    if (!Number.isInteger(groupRelativeIndex) || groupRelativeIndex < 0) {
        return -1;
    }

    const syncableIndexes = syncableTabIndexesInOrder(destGroupTabs);

    if (syncableIndexes.length) {
        return groupRelativeIndex < syncableIndexes.length
            ? syncableIndexes[groupRelativeIndex]
            : syncableIndexes.at(-1) + 1;
    }

    const occupiedIndexes = positionedTabs(destGroupTabs).map(tab => tab.index);

    return occupiedIndexes.length ? Math.min(...occupiedIndexes) : -1;
}

export function resolvePinnedMoveIndex(livePinnedTabs, movedTab, pinnedRelativeIndex) {
    const windowId = movedTab?.windowId;

    if (!Number.isFinite(windowId)) {
        return -1;
    }

    const ownWindowPinned = (Array.isArray(livePinnedTabs) ? livePinnedTabs : [])
        .filter(tab => tab && tab.windowId === windowId);

    return resolveAbsoluteTabIndex(ownWindowPinned, pinnedRelativeIndex);
}
