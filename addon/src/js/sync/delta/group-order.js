export function liveGroupTabOrder(liveTabs) {
    return (Array.isArray(liveTabs) ? liveTabs : [])
        .filter(t => t && t.id != null)
        .map(t => ({id: t.id, index: Number.isFinite(t.index) ? t.index : Infinity}))
        .sort((a, b) => a.index - b.index)
        .map(t => t.id);
}

export function groupTabsAlreadyOrdered(orderedIds, liveTabs) {
    if (!Array.isArray(orderedIds) || !orderedIds.length) {
        return true;
    }

    const live = liveGroupTabOrder(liveTabs);
    if (live.length !== orderedIds.length) {
        return false;
    }

    return orderedIds.every((id, i) => id === live[i]);
}
