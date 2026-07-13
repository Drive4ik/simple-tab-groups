export function isAppliedNavigationEcho({applying, markExpiry, markUrl, observedUrl, now}) {
    if (applying) {
        return true;
    }
    if (!Number.isFinite(markExpiry) || now >= markExpiry) {
        return false;
    }
    if (typeof markUrl === 'string' && typeof observedUrl === 'string') {
        return observedUrl === markUrl;
    }
    return true;
}
