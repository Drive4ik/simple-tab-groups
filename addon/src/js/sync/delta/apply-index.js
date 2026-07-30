export function resolveAbsoluteTabIndex(destGroupTabIndices, groupRelativeIndex) {
    const finiteIndices = (Array.isArray(destGroupTabIndices) ? destGroupTabIndices : [])
        .filter(Number.isFinite);

    if (!finiteIndices.length || !Number.isInteger(groupRelativeIndex)) {
        return -1;
    }

    return Math.min(...finiteIndices) + groupRelativeIndex;
}
