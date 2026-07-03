import {ALARM_NAME_RETRY} from '../cloud/cloud.js?can-do-synchronization';

const USER_DEFER_RESCHEDULE_MINUTES = 0.2;

const LOCK_CONTENDED_RESCHEDULE_MINUTES = 0.5;

async function rescheduleSoon(log, delayInMinutes, reason) {
    try {
        await browser.alarms.create(ALARM_NAME_RETRY, {delayInMinutes});
    } catch (e) {
        log.warn(`cant reschedule ${reason} sync; will run on next periodic alarm`, String(e));
    }
}

export function rescheduleSoonAfterDefer(log) {
    return rescheduleSoon(log, USER_DEFER_RESCHEDULE_MINUTES, 'deferred');
}

export function rescheduleSoonAfterLockContention(log) {
    return rescheduleSoon(log, LOCK_CONTENDED_RESCHEDULE_MINUTES, 'lock-contended');
}
