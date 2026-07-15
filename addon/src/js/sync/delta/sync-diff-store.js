import * as Constants from '/js/constants.js';
import * as Storage from '/js/storage.js';
import Notification from '/js/notification.js';
import {computeSyncDiff, isEmptySyncDiff} from './sync-diff.js';

export const SYNC_DIFF_HISTORY_KEY = 'syncDiffHistory';

const MIN_DEPTH = 1;
const MAX_DEPTH = 200;
const DEFAULT_DEPTH = 20;

function boundedDepth(depth) {
    const value = Math.floor(Number(depth));
    if (!Number.isFinite(value)) {
        return DEFAULT_DEPTH;
    }
    return Math.min(Math.max(value, MIN_DEPTH), MAX_DEPTH);
}

export async function getSyncDiffHistory() {
    const {[SYNC_DIFF_HISTORY_KEY]: history} = await Storage.get({[SYNC_DIFF_HISTORY_KEY]: []});
    return Array.isArray(history) ? history : [];
}

export async function clearSyncDiffHistory() {
    await Storage.set({[SYNC_DIFF_HISTORY_KEY]: []});
}

export async function recordSyncDiff(before, after, depth) {
    const diff = computeSyncDiff(before, after);

    if (isEmptySyncDiff(diff)) {
        return null;
    }

    const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: Date.now(),
        summary: diff.summary,
        counts: diff.counts,
        tabs: diff.tabs,
        groups: diff.groups,
        options: diff.options,
    };

    const history = await getSyncDiffHistory();
    history.unshift(entry);
    history.length = Math.min(history.length, boundedDepth(depth));

    await Storage.set({[SYNC_DIFF_HISTORY_KEY]: history});

    return entry;
}

export async function notifySyncDiff(entry) {
    return Notification(entry.summary, {
        title: 'syncDiffNotificationTitle',
        module: ['tabs', 'createUrlOnce', `${Constants.PAGES.SYNC_DIFF}?entry=${entry.id}`],
    });
}
