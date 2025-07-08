
import * as Utils from '/js/utils.js';

const notificationsMap = new Map;

export default async function(message, options = {}) {
    if (typeof message === 'string') {
        if (message.includes(' ')) {
            // untranslatable string
        } else {
            message = browser.i18n.getMessage(message) || message;
        }
    } else if (Array.isArray(message)) {
        const [messageName, ...substitutions] = message;
        message = browser.i18n.getMessage(messageName, substitutions.flat(Infinity));
    } else {
        message = String(message);
    }

    if (options.data) {
        message = Utils.format(message, options.data);
    }

    if (options.id) {
        await clear(options.id);
    }

    options.id ??= message.replace(/[^\w]/g, '').slice(-100, 100);
    options.time ??= 20;
    options.iconUrl ??= '/icons/icon.svg';
    options.title ??= browser.i18n.getMessage('extensionName');
    options.data ??= null; // message format data
    options.onClick ??= null;
    options.onClose ??= null;

    // https://developer.mozilla.org/en-US/Add-ons/WebExtensions/API/notifications/NotificationOptions
    // Only 'type', 'iconUrl', 'title', and 'message' are supported.
    await browser.notifications.create(options.id, {
        type: 'basic',
        iconUrl: options.iconUrl,
        title: options.title,
        message: message || `empty message for: ${options.id}`,
    });

    options.timeoutId = setTimeout(() => clear(options.id), options.time * 1000);

    notificationsMap.set(options.id, options);

    return options.id;
}

export async function clear(notificationId) {
    const options = notificationsMap.get(notificationId);

    notificationsMap.delete(notificationId);

    if (options) {
        clearTimeout(options.timeoutId);
        await browser.notifications.clear(notificationId);
    }
}

browser.notifications.onClicked.addListener((notificationId) => {
    const options = notificationsMap.get(notificationId);

    if (options) {
        clear(notificationId);
        options.onClick?.(notificationId);
    }
});

browser.notifications.onClosed.addListener((notificationId, byUser) => {
    const options = notificationsMap.get(notificationId);

    if (options) {
        clear(notificationId);
        options.onClose?.(notificationId);
    }
});
