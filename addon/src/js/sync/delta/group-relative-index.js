export function computeGroupRelativeIndex(windowTabs, getTabGroupFn, tabId, groupId) {
    if (!Array.isArray(windowTabs) || typeof getTabGroupFn !== 'function' || !groupId) {
        return null;
    }

    const groupTabs = windowTabs
        .filter(t => getTabGroupFn(t.id) === groupId)
        .sort((a, b) => a.index - b.index);

    const position = groupTabs.findIndex(t => t.id === tabId);
    return position === -1 ? null : position;
}
