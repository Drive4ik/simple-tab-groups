export function isPinnedNeedingGroupPin(tab) {
    return Boolean(tab) && tab.pinned === true;
}

export function partitionTabIdsForMove(tabIds, getTab) {
    const groupPinTabIds = [];
    const normalTabIds = [];

    for (const id of tabIds) {
        if (isPinnedNeedingGroupPin(getTab(id))) {
            groupPinTabIds.push(id);
        } else {
            normalTabIds.push(id);
        }
    }

    return {groupPinTabIds, normalTabIds};
}
