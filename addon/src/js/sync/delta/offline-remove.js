import Logger from '/js/logger.js';
import Lang from '/js/lang.js';
import Notification from '/js/notification.js';
import {ALARM_NAME_RETRY} from '../cloud/cloud.js?can-do-synchronization';
import * as DeltaLog from './delta-log.js';
import {getDeviceId} from './device-id.js';
import {storage} from './sync-marks.js';

const logger = new Logger('DeltaOfflineRemove');

const PENDING_PREFIX = 'deltaOfflineRemovePending:';

const NOTIFICATION_ID = 'delta-offline-remove-confirm';

function pendingKey(deviceId) {
    return PENDING_PREFIX + deviceId;
}

export function loadDeferredOfflineRemoves(deviceId) {
    const raw = storage[pendingKey(deviceId)];
    if (!raw) {
        return [];
    }
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function persistDeferredOfflineRemoves(deviceId, removes) {
    storage[pendingKey(deviceId)] = JSON.stringify(removes);
}

export function dropDeferredOfflineRemoves(deviceId) {
    delete storage[pendingKey(deviceId)];
}

export async function notifyDeferredOfflineRemoves(count) {
    return Notification(Lang('offlineRemoveConfirmMessage', [String(count)]), {
        id: NOTIFICATION_ID,
        title: 'offlineRemoveConfirmTitle',
        iconUrl: '/icons/exclamation-triangle-yellow.svg',
        module: ['sync/delta/offline-remove', 'confirmOfflineRemovals'],
        expires: Notification.MAX_EXPIRES,
    });
}

export async function confirmOfflineRemovals() {
    const deviceId = getDeviceId();
    const removes = loadDeferredOfflineRemoves(deviceId);

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
    logger.info('user discarded deferred offline removals');
    return {ok: true};
}
