import Logger from '/js/logger.js';
import Lang from '/js/lang.js';
import Notification from '/js/notification.js';
import * as Constants from '/js/constants.js';
import {ALARM_NAME_RETRY} from '../cloud/cloud.js?can-do-synchronization';
import * as DeltaLog from './delta-log.js';
import {getDeviceId} from './device-id.js';
import {storage} from './sync-marks.js';
import {
    loadPendingOfflineRemoves,
    persistPendingOfflineRemoves,
    dropPendingOfflineRemoves,
} from './offline-remove-record.js';

const logger = new Logger('DeltaOfflineRemove');

const NOTIFICATION_ID = 'delta-offline-remove-confirm';

export function loadDeferredOfflineRemoves(deviceId) {
    return loadPendingOfflineRemoves(storage, deviceId);
}

export function persistDeferredOfflineRemoves(deviceId, removes) {
    persistPendingOfflineRemoves(storage, deviceId, removes);
}

export function dropDeferredOfflineRemoves(deviceId) {
    dropPendingOfflineRemoves(storage, deviceId);
}

export function pendingOfflineRemoveCount() {
    return loadDeferredOfflineRemoves(getDeviceId()).length;
}

export async function notifyDeferredOfflineRemoves(count) {
    return Notification(Lang('offlineRemoveConfirmMessage', [String(count)]), {
        id: NOTIFICATION_ID,
        title: 'offlineRemoveConfirmTitle',
        iconUrl: '/icons/exclamation-triangle-yellow.svg',
        module: ['tabs', 'createUrlOnce', `${Constants.PAGES.OFFLINE_REMOVE_CONFIRM}?count=${count}`],
        expires: Notification.MAX_EXPIRES,
    });
}

export async function confirmOfflineRemovals() {
    const deviceId = getDeviceId();
    const removes = loadDeferredOfflineRemoves(deviceId);

    await Notification.clear(NOTIFICATION_ID).catch(() => {});

    if (!removes.length) {
        return {ok: true, applied: 0};
    }

    const appended = await DeltaLog.appendMany(removes);
    dropDeferredOfflineRemoves(deviceId);

    logger.info('user confirmed deferred offline removals; queued for propagation', {count: appended.length});

    await browser.alarms.create(ALARM_NAME_RETRY, {delayInMinutes: 0.1})
        .catch(e => logger.warn('cant schedule sync after offline-remove confirm; will run on next periodic alarm', String(e)));

    return {ok: true, applied: appended.length};
}

export async function discardOfflineRemovals() {
    const deviceId = getDeviceId();
    dropDeferredOfflineRemoves(deviceId);
    await Notification.clear(NOTIFICATION_ID).catch(() => {});
    logger.info('user discarded deferred offline removals; tabs kept');
    return {ok: true};
}
