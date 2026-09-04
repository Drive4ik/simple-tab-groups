export const NAVIGATION_COMPLETE_STATUS = 'complete';

function hasLiveMark(markExpiry, now) {
    return Number.isFinite(markExpiry) && now < markExpiry;
}

export function isAppliedNavigationEcho({applying, markExpiry, markUrl, observedUrl, observedStatus, now}) {
    if (applying) {
        return true;
    }
    if (!hasLiveMark(markExpiry, now) || typeof markUrl !== 'string') {
        return false;
    }
    if (observedStatus !== NAVIGATION_COMPLETE_STATUS) {
        return true;
    }
    return observedUrl === markUrl;
}

export function isAppliedNavigationLandedOffTarget({applying, markExpiry, markUrl, observedUrl, observedStatus, now}) {
    if (!hasLiveMark(markExpiry, now)) {
        return false;
    }
    return !isAppliedNavigationEcho({applying, markExpiry, markUrl, observedUrl, observedStatus, now});
}

export function isAppliedNavigationSettled({markExpiry, observedStatus, now}) {
    return !hasLiveMark(markExpiry, now) || observedStatus === NAVIGATION_COMPLETE_STATUS;
}
