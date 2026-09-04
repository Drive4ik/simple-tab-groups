export const NAVIGATION_COMPLETE_STATUS = 'complete';
export const NAVIGATION_LOADING_STATUS = 'loading';

function hasMark(markExpiry) {
    return Number.isFinite(markExpiry);
}

function hasLiveMark(markExpiry, now) {
    return hasMark(markExpiry) && now < markExpiry;
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

export function isAppliedNavigationSettled({markExpiry, observedStatus, now}) {
    if (hasLiveMark(markExpiry, now)) {
        return observedStatus === NAVIGATION_COMPLETE_STATUS;
    }
    return observedStatus !== NAVIGATION_LOADING_STATUS;
}

export function isAppliedNavigationLandedOffTarget({applying, markExpiry, markUrl, observedUrl, observedStatus, now}) {
    if (applying || !hasMark(markExpiry)) {
        return false;
    }
    if (!isAppliedNavigationSettled({markExpiry, observedStatus, now})) {
        return false;
    }
    return observedUrlDiffersFromTarget(markUrl, observedUrl);
}
