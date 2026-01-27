import Listeners from './listeners.js\
?notifications.onClicked\
&alarms.onAlarm\
';
import * as Constants from './constants.js';

export const MIN_EXPIRES = 5;
export const MAX_EXPIRES = 10 * 60;
const DEFAULT_EXPIRES = 45;
const PREFIX = 'notification-';
const ALARM_PREFIX = 'hide-notification-';
const MODULES = {
    browser,
};

if (Constants.IS_BACKGROUND_PAGE) {
    Listeners.notifications.onClicked(onClicked);
    Listeners.alarms.onAlarm(onAlarm);
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

    if (notification.action === 'open-options') {
        await browser.runtime.openOptionsPage();
        return;
    }

    if (notification.tab) {
        notification.tab.active ??= true;
        await browser.tabs.create(notification.tab);
        return;
    }

    if (notification.module) {
        /* module name/url is case sensitive!
        string - 'module-name@someFunc'   arguments are not supported!
        array - ['module-name', 'someFunc', 'arg1', 'arg2', {arg3: true}]
        object - {
            name: 'module-name',
            method: 'someFunc',
            args: ['arg1', 'arg2', {arg3: true}],
        }
        */
        let moduleName;
        let moduleMethod;
        let moduleArgs;

        if (typeof notification.module === 'string') {
            notification.module = notification.module.split('@', 2);
        }

        if (Array.isArray(notification.module)) {
            [moduleName, moduleMethod, ...moduleArgs] = notification.module;
        } else {
            moduleName = notification.module.name;
            moduleMethod = notification.module.method;
            moduleArgs = notification.module.args;
        }

        moduleName = MODULES[moduleName] ? moduleName : `./${moduleName}.js`;
        moduleMethod ||= 'default';
        moduleArgs ||= [];

        try {
            const module = await (MODULES[moduleName] ?? import(moduleName));
            const methodParts = moduleMethod.split('.');
            const method = methodParts.reduce((obj, key) => obj?.[key], module)
                ?? methodParts.reduce((obj, key) => obj?.[key], module.default);

            await method(...moduleArgs);
        } catch (e) {
            if (notification.logError) {
                if (self.logger) {
                    self.logger.logError(e, e);
                } else {
                    console.error(e);
                }
            }
        }

        return;
    }
}

async function onAlarm({name}) {
    if (name.startsWith(ALARM_PREFIX)) {
        const notificationId = name.slice(ALARM_PREFIX.length);
        await clear(notificationId);
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
