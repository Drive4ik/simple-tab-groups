export function isResolvedSpuriouslyEmpty(resolvedSnapshot, localState) {
    const resolvedEmpty = (resolvedSnapshot?.groups || []).length === 0
        && (resolvedSnapshot?.pinnedTabs || []).length === 0;
    const localHasState = (localState?.groups || []).length > 0
        || (localState?.pinnedTabs || []).length > 0;
    return resolvedEmpty && localHasState;
}

export function shouldWriteSnapshot({shouldCompact, snapshotExists, suppressEmptyResolve}) {
    if (suppressEmptyResolve) {
        return false;
    }
    return shouldCompact || !snapshotExists;
}
