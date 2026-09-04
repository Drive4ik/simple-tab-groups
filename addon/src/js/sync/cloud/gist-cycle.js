export const GIST_LOOKUP_UNCHANGED = 'unchanged';
export const GIST_LOOKUP_RESOLVED = 'resolved';
export const GIST_LOOKUP_STALE = 'stale';

export function classifyCachedGistLookup(status, gist, usable) {
    if (status === 304) {
        return GIST_LOOKUP_UNCHANGED;
    }

    if (gist && usable) {
        return GIST_LOOKUP_RESOLVED;
    }

    return GIST_LOOKUP_STALE;
}

export const LOCK_CONFIRM_HELD = 'held';
export const LOCK_CONFIRM_CONTESTED = 'contested';
export const LOCK_CONFIRM_UNAVAILABLE = 'unavailable';

export function classifyLockConfirmation(status, gist) {
    if (status === 304) {
        return LOCK_CONFIRM_HELD;
    }

    if (gist) {
        return LOCK_CONFIRM_CONTESTED;
    }

    return LOCK_CONFIRM_UNAVAILABLE;
}
