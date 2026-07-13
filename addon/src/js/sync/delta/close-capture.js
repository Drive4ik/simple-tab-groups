export function closedTabCapturePlan({uid, groupId, wasPinned}, isPinnedGroupId) {
    if (!uid) {
        return {removeFromGroupId: null, retirePinnedUid: null};
    }

    if (groupId) {
        return {
            removeFromGroupId: groupId,
            retirePinnedUid: wasPinned === true && isPinnedGroupId(groupId) ? uid : null,
        };
    }

    return {
        removeFromGroupId: null,
        retirePinnedUid: wasPinned === true ? uid : null,
    };
}
