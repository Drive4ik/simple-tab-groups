import * as Constants from '/js/constants.js';
import * as Storage from '/js/storage.js';
import Notification from '/js/notification.js';
import {isEmptySyncDiff} from './sync-diff.js';

export const SYNC_DIFF_HISTORY_KEY = 'syncDiffHistory';
export const SYNC_DIFF_VIEW_SETTINGS_KEY = 'syncDiffViewSettings';

export const DEFAULT_SYNC_DIFF_VIEW_SETTINGS = Object.freeze({
    groupByGroups: true,
    showAdded: true,
    showRemoved: true,
    showChanged: true,
    hideMoves: false,
    collapsedGroups: [],
});

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

export async function getSyncDiffViewSettings() {
    const {[SYNC_DIFF_VIEW_SETTINGS_KEY]: stored} = await Storage.get({[SYNC_DIFF_VIEW_SETTINGS_KEY]: {}});
    return {...DEFAULT_SYNC_DIFF_VIEW_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {})};
}

export async function setSyncDiffViewSettings(settings) {
    const merged = {...DEFAULT_SYNC_DIFF_VIEW_SETTINGS, ...settings};
    await Storage.set({[SYNC_DIFF_VIEW_SETTINGS_KEY]: merged});
    return merged;
}

export async function recordSyncDiff(diff, depth) {
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

export async function notifyEmptySyncDiff() {
    return Notification('syncNotifyEmptyDiffNotificationMessage', {
        title: 'syncNotifyEmptyDiffNotificationTitle',
    });
}
