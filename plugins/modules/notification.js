import Listeners from './listeners.js\
?notifications.onClicked\
&alarms.onAlarm\
';
import * as Constants from './constants.js';
import Lang from './lang.js';
import runModule from './module-runner.js';

export const MIN_EXPIRES = 5;
export const MAX_EXPIRES = 10 * 60;
const DEFAULT_EXPIRES = 45;
const PREFIX = 'notification-';
const ALARM_PREFIX = 'hide-notification-';

if (new URL(import.meta.url).searchParams.has('addListeners')) {
    addListeners();
}

export function addListeners() {
    Listeners.notifications.onClicked.add(onClicked);
    Listeners.alarms.onAlarm.add(onAlarm);
}

export function removeListeners() {
    Listeners.notifications.onClicked.remove(onClicked);
    Listeners.alarms.onAlarm.remove(onAlarm);
}

function wrapId(notificationId) {
    return PREFIX + notificationId;
}

function isWrappedId(wrappedId) {
    return wrappedId.startsWith(PREFIX);
}

function extractId(wrappedId) {
    return wrappedId.slice(PREFIX.length);
}

async function onClicked(wrappedId) {
    if (!isWrappedId(wrappedId)) {
        return;
    }

    const notificationId = extractId(wrappedId);

    const notification = await load(notificationId);

    await remove(notificationId);

    if (notification.module) {
        try {
            await runModule(notification.module);
        } catch (e) {
            if (notification.logError) {
                if (self.logger) {
                    self.logger.logError(e, e);
                } else {
                    console.error(e);
                }
            }
        }
    }
}

async function onAlarm({name}) {
    if (name.startsWith(ALARM_PREFIX)) {
        const notificationId = name.slice(ALARM_PREFIX.length);
        await clear(notificationId);
    }
}

export default async function Notification(message, options = {}) {
    if (!message) {
        throw new Error('Notification message is required');
    }

    const notification = {
        ...options,
        message: Lang(message, null, {html: false}),
        title: Lang(options.title || 'extensionName', null, {html: false}),
        iconUrl: options.iconUrl ?? (Constants.MANIFEST.action ?? Constants.MANIFEST.browser_action).default_icon,
    };

    notification.id = notification.id ? String(notification.id) : self.crypto.randomUUID();

    await clear(notification.id);

    await save(notification);

    await create(notification);

    await clearWhenExpired(notification.id, notification.expires);

    return notification.id;
}

async function save(notification) {
    await browser.storage.session.set({
        [wrapId(notification.id)]: notification,
    });
}

async function load(notificationId) {
    const wrappedId = wrapId(notificationId);
    const {[wrappedId]: notification} = await browser.storage.session.get(wrappedId);
    return notification;
}

async function remove(notificationId) {
    await browser.storage.session.remove(wrapId(notificationId));
}

async function clearWhenExpired(notificationId, expires) {
    expires = Math.min(Math.max(expires, MIN_EXPIRES), MAX_EXPIRES) || DEFAULT_EXPIRES;

    const name = ALARM_PREFIX + notificationId;
    await browser.alarms.clear(name);
    await browser.alarms.create(name, {
        when: Date.now() + expires * 1000,
    });
}

Notification.MIN_EXPIRES = MIN_EXPIRES;
Notification.MAX_EXPIRES = MAX_EXPIRES;
Notification.clear = clear;
Notification.addListeners = addListeners;
Notification.removeListeners = removeListeners;

async function create({id, iconUrl, title, message}) {
    // https://developer.mozilla.org/en-US/Add-ons/WebExtensions/API/notifications/NotificationOptions
    // Only 'type', 'iconUrl', 'title', and 'message' are supported.
    return await browser.notifications.create(wrapId(id), {
        type: 'basic',
        iconUrl,
        title,
        message,
    });
}

export async function clear(notificationId) {
    await browser.notifications.clear(wrapId(notificationId));
    await remove(notificationId);
}
