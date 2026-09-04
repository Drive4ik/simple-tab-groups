import {storage} from './sync-marks.js';
import * as PendingNav from './pending-nav.js';

export function recordPendingNavTarget(uid, liveTab, target) {
    return PendingNav.recordPendingNav(storage, uid, liveTab, target, Date.now());
}

export function getPendingNavTarget(uid) {
    return PendingNav.getPendingNav(storage, uid);
}

export function clearPendingNavTarget(uid) {
    return PendingNav.clearPendingNav(storage, uid);
}

export function pendingNavTargetsByUid() {
    return PendingNav.pendingNavTargets(storage);
}

export function gcPendingNavTargets(aliveUids) {
    return PendingNav.gcPendingNav(storage, {aliveUids, now: Date.now()}).size;
}
