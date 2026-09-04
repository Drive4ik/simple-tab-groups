import {liveUrlMatchesSource, unwrapStubUrl} from './url-sync.js';
import {planTabContentApply} from './tab-content-apply.js';

export const PENDING_NAV_KEY = 'deltaPendingNav';
export const PENDING_NAV_MAX_ENTRIES = 500;
export const PENDING_NAV_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const DROPPED_USER_NAVIGATION = 'userNavigation';
export const DROPPED_EXPIRED = 'expired';

function normalizeTs(ts) {
    const value = Number(ts);
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function targetOf(source) {
    const target = {};
    if (Object.hasOwn(source, 'url')) {
        target.url = source.url;
    }
    if (Object.hasOwn(source, 'title')) {
        target.title = source.title;
    }
    return target;
}

function isNavigationTarget(target) {
    return Object.hasOwn(target, 'url');
}

function normalizeEntry(uid, raw) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    const target = targetOf(raw);
    if (!isNavigationTarget(target)) {
        return null;
    }

    return {
        uid,
        ...target,
        liveUrl: typeof raw.liveUrl === 'string' ? raw.liveUrl : null,
        ts: normalizeTs(raw.ts),
    };
}

export function loadPendingNav(store) {
    const pending = new Map();
    const raw = store[PENDING_NAV_KEY];

    if (!raw) {
        return pending;
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return pending;
    }

    if (!parsed || typeof parsed !== 'object') {
        return pending;
    }

    for (const [uid, value] of Object.entries(parsed)) {
        const entry = normalizeEntry(uid, value);
        if (entry) {
            pending.set(uid, entry);
        }
    }

    return pending;
}

export function serializePendingNav(pending) {
    let entries = [...pending.values()];

    if (entries.length > PENDING_NAV_MAX_ENTRIES) {
        entries = entries.slice().sort((a, b) => b.ts - a.ts).slice(0, PENDING_NAV_MAX_ENTRIES);
    }

    const record = {};
    for (const {uid, ...rest} of entries) {
        record[uid] = rest;
    }
    return record;
}

function writePendingNav(store, pending) {
    const record = serializePendingNav(pending);

    if (Object.keys(record).length) {
        store[PENDING_NAV_KEY] = JSON.stringify(record);
    } else {
        delete store[PENDING_NAV_KEY];
    }
}

export function recordPendingNav(store, uid, liveTab, target, now) {
    if (uid == null) {
        return null;
    }

    const deferred = targetOf(target || {});
    if (!isNavigationTarget(deferred)) {
        return null;
    }

    const entry = {
        uid: String(uid),
        ...deferred,
        liveUrl: typeof liveTab?.url === 'string' ? unwrapStubUrl(liveTab.url) : null,
        ts: normalizeTs(now),
    };

    const pending = loadPendingNav(store);
    pending.set(entry.uid, entry);
    writePendingNav(store, pending);

    return entry;
}

export function getPendingNav(store, uid) {
    if (uid == null) {
        return null;
    }
    return loadPendingNav(store).get(String(uid)) || null;
}

export function clearPendingNav(store, uid) {
    if (uid == null) {
        return false;
    }

    const pending = loadPendingNav(store);
    if (!pending.delete(String(uid))) {
        return false;
    }

    writePendingNav(store, pending);
    return true;
}

export function pendingNavTargets(store) {
    const targets = {};
    for (const [uid, entry] of loadPendingNav(store)) {
        targets[uid] = targetOf(entry);
    }
    return targets;
}

function toUidSet(uids) {
    if (uids == null) {
        return null;
    }
    return uids instanceof Set ? uids : new Set(uids);
}

export function gcPendingNav(store, {aliveUids, awakeUids, now} = {}) {
    const alive = toUidSet(aliveUids);
    const awake = toUidSet(awakeUids);
    const cutoff = Number.isFinite(now) ? now - PENDING_NAV_MAX_AGE_MS : null;

    const pending = loadPendingNav(store);

    for (const [uid, entry] of pending) {
        if (alive && !alive.has(uid)) {
            pending.delete(uid);
        } else if (awake && awake.has(uid)) {
            pending.delete(uid);
        } else if (cutoff !== null && entry.ts < cutoff) {
            pending.delete(uid);
        }
    }

    writePendingNav(store, pending);

    return pending;
}

function leftTheRefusalUrl(entry, liveTab) {
    if (entry.liveUrl == null || typeof liveTab?.url !== 'string') {
        return true;
    }
    return !liveUrlMatchesSource(liveTab.url, entry.liveUrl);
}

export function planPendingNavOnTabUpdate(entry, liveTab, {woke = false, contentChanged = false, now} = {}) {
    const keepWaiting = {navigate: false, clear: false, url: undefined, title: undefined, reason: null};

    if (!entry) {
        return keepWaiting;
    }

    if (entry.ts > 0 && Number.isFinite(now) && (now - entry.ts) > PENDING_NAV_MAX_AGE_MS) {
        return {...keepWaiting, clear: true, reason: DROPPED_EXPIRED};
    }

    const userMoved = leftTheRefusalUrl(entry, liveTab);

    if (contentChanged && !woke && userMoved) {
        return {...keepWaiting, clear: true, reason: DROPPED_USER_NAVIGATION};
    }

    if (!liveTab || liveTab.discarded !== false) {
        return keepWaiting;
    }

    if (userMoved) {
        return {...keepWaiting, clear: true, reason: DROPPED_USER_NAVIGATION};
    }

    const plan = planTabContentApply(liveTab, targetOf(entry));

    return {
        navigate: plan.navigate,
        clear: true,
        url: plan.url,
        title: plan.title,
        reason: plan.refusal,
    };
}
