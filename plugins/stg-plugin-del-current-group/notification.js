import Listeners from './listeners.js\
?notifications.onClicked\
&alarms.onAlarm\
';
import * as Constants from './constants.js';

const MIN_EXPIRES = 5;
const MAX_EXPIRES = 2 * 60;
const DEFAULT_EXPIRES = MAX_EXPIRES;
const ALARM_PREFIX = 'hide-notification-';

if (Constants.IS_BACKGROUND_PAGE) {
    Listeners.notifications.onClicked(onClicked);
    Listeners.alarms.onAlarm(onAlarm);
}

async function onClicked(notificationId) {
    try {
        const notification = JSON.parse(notificationId);

        if (notification.action === 'open-options') {
            await browser.runtime.openOptionsPage();
        } else if (notification.tab) {
            notification.tab.active ??= true;
            await browser.tabs.create(notification.tab);
        } else if (notification.module) {
            const moduleName = notification.module.name.includes('.js')
                ? notification.module.name
                : `./${notification.module.name}.js`;

            const module = await import(moduleName);
            const method = module[notification.module.method ?? 'default'];
            const args = notification.module.args ?? [];

            await method(...args);
        }
    } catch (e) {
        if (e.name === 'SyntaxError' && e.message.toLowerCase().includes('json')) {
            // do nothing
        } else {
            throw e;
        }
    }
}

function onAlarm({name}) {
    if (name.startsWith(ALARM_PREFIX)) {
        const notificationId = name.slice(ALARM_PREFIX.length);
        clear(notificationId);
    }
}

function translate(message) {
    if (typeof message === 'string') {
        if (message.includes(' ')) {
            // untranslatable string
            return message;
        } else {
            return browser.i18n.getMessage(message) || message;
        }
    } else if (Array.isArray(message)) {
        const [messageName, ...substitutions] = message;
        return browser.i18n.getMessage(messageName, substitutions.flat(Infinity));
    } else {
        return String(message);
    }
}

export default async function Notification(message, options = {}) {
    if (!message) {
        throw new Error('Notification message is required');
    }

    const notification = {
        ...options,
        message: translate(message),
        title: translate(options.title || 'extensionName'),
        iconUrl: options.iconUrl ?? Constants.MANIFEST.action.default_icon,
    };

    const notificationId = notification.id ? String(notification.id) : JSON.stringify(notification);

    await clear(notificationId);

    // https://developer.mozilla.org/en-US/Add-ons/WebExtensions/API/notifications/NotificationOptions
    // Only 'type', 'iconUrl', 'title', and 'message' are supported.
    await browser.notifications.create(notificationId, {
        type: 'basic',
        iconUrl: notification.iconUrl,
        title: notification.title,
        message: notification.message,
    });

    await clearWhenExpired(notificationId, notification.expires);

    return notificationId;
}

async function clearWhenExpired(notificationId, expires) {
    expires = Math.min(Math.max(expires, MIN_EXPIRES), MAX_EXPIRES) || DEFAULT_EXPIRES;

    const alarmId = ALARM_PREFIX + notificationId;
    await browser.alarms.clear(alarmId);
    await browser.alarms.create(alarmId, {
        when: Date.now() + expires * 1000,
    });
}

Notification.clear = clear;

export async function clear(notificationId) {
    await browser.notifications.clear(notificationId);
}
