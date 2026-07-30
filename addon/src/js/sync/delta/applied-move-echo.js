export function isAppliedMoveEcho({applying, markExpiry, now}) {
    if (applying) {
        return true;
    }
    if (!Number.isFinite(markExpiry) || now >= markExpiry) {
        return false;
    }
    return true;
}
