export const MASS_REMOVE_MIN_BASELINE = 8;
export const MASS_REMOVE_FRACTION = 0.5;
export const MASS_REMOVE_ABSOLUTE = 50;

export function isMassOfflineRemoval(removeCount, baselineSize) {
    if (removeCount <= 0) {
        return false;
    }
    if (removeCount >= MASS_REMOVE_ABSOLUTE) {
        return true;
    }
    if (baselineSize >= MASS_REMOVE_MIN_BASELINE && removeCount >= Math.ceil(baselineSize * MASS_REMOVE_FRACTION)) {
        return true;
    }
    return false;
}

export function partitionOfflineRemoves(removes, baselineSize) {
    const list = Array.isArray(removes) ? removes : [];
    if (isMassOfflineRemoval(list.length, baselineSize)) {
        return {apply: [], deferred: list.slice()};
    }
    return {apply: list.slice(), deferred: []};
}
