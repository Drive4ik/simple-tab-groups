export const COMPACTION_THRESHOLD = 100;

export function countUnfoldedEvents(pulledDeltaLogs, baseWatermark = {}) {
    const wm = baseWatermark || {};
    let count = 0;

    for (const log of pulledDeltaLogs || []) {
        const folded = wm[log?.deviceId] ?? 0;
        for (const event of log?.events || []) {
            if (event.seq == null || event.seq > folded) {
                count += 1;
            }
        }
    }

    return count;
}

export function evaluateCompaction(pulledDeltaLogs, baseWatermark = {}, threshold = COMPACTION_THRESHOLD) {
    const unfoldedCount = countUnfoldedEvents(pulledDeltaLogs, baseWatermark);
    return {shouldCompact: unfoldedCount > threshold, unfoldedCount};
}

export function selfFoldedSeq(newWatermark, selfDeviceId, lastPushedSeq = 0) {
    const foldedSelf = (newWatermark || {})[selfDeviceId] ?? 0;
    const pushed = Number.isFinite(lastPushedSeq) ? lastPushedSeq : 0;
    return Math.min(foldedSelf, pushed);
}

export function truncateSelfEvents(selfEvents, foldedSeq) {
    return (selfEvents || []).filter(event => event.seq == null || event.seq > foldedSeq);
}

export function resolveDeferredTruncation(pendingTruncateSeq, cloudSnapshotWatermark = {}, selfDeviceId) {
    const pending = Number(pendingTruncateSeq);
    if (!Number.isFinite(pending) || pending <= 0) {
        return {confirmed: false, truncateSeq: 0};
    }
    const cloudSelfWatermark = Number((cloudSnapshotWatermark || {})[selfDeviceId]) || 0;
    if (cloudSelfWatermark >= pending) {
        return {confirmed: true, truncateSeq: pending};
    }
    return {confirmed: false, truncateSeq: 0};
}

export function isLogFullyFolded(events, folded = 0) {
    const wm = Number.isFinite(folded) ? folded : 0;
    for (const event of events || []) {
        if (event.seq == null || event.seq > wm) {
            return false;
        }
    }
    return true;
}

export function selectOrphanDeltaFilesToDelete(pulledDeltaLogs, watermark = {}, selfDeviceId = null) {
    const wm = watermark || {};
    const toDelete = [];

    for (const log of pulledDeltaLogs || []) {
        const deviceId = log?.deviceId;
        const name = log?.name;

        if (!name || deviceId == null || deviceId === selfDeviceId) {
            continue;
        }

        const folded = wm[deviceId] ?? 0;
        if (isLogFullyFolded(log?.events, folded)) {
            toDelete.push(name);
        }
    }

    return toDelete;
}
