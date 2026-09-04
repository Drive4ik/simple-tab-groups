export const NAVIGATION_COMPLETE_STATUS = 'complete';

function hasLiveMark(markExpiry, now) {
    return Number.isFinite(markExpiry) && now < markExpiry;
}

export function isAppliedNavigationEcho({applying, markExpiry, markUrl, observedUrl, observedStatus, now}) {
    if (applying) {
        return true;
    }
    if (!hasLiveMark(markExpiry, now)) {
        return false;
    }
    if (observedStatus !== NAVIGATION_COMPLETE_STATUS) {
        return true;
    }
    if (typeof markUrl === 'string' && typeof observedUrl === 'string') {
        return observedUrl === markUrl;
    }
    return true;
}

export function isAppliedNavigationSettled({markExpiry, observedStatus, now}) {
    return !hasLiveMark(markExpiry, now) || observedStatus === NAVIGATION_COMPLETE_STATUS;
}
