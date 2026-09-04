export const NAVIGATION_COMPLETE_STATUS = 'complete';

function hasLiveMark(markExpiry, now) {
    return Number.isFinite(markExpiry) && now < markExpiry;
}

function observedUrlDiffersFromTarget(markUrl, observedUrl) {
    return typeof markUrl === 'string' && typeof observedUrl === 'string' && observedUrl !== markUrl;
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
    if (applying) {
        return false;
    }
    if (hasLiveMark(markExpiry, now) && observedStatus !== NAVIGATION_COMPLETE_STATUS) {
        return false;
    }
    return observedUrlDiffersFromTarget(markUrl, observedUrl);
}

export function isAppliedNavigationSettled({markExpiry, observedStatus, now}) {
    return !hasLiveMark(markExpiry, now) || observedStatus === NAVIGATION_COMPLETE_STATUS;
}
