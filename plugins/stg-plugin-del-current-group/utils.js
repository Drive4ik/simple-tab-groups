
import * as Constants from './constants.js';
import ls, {TYPE_SESSION} from './ls.js';

const notificationsStorage = ls.create('notify', TYPE_SESSION);

browser.notifications.onClicked.addListener(notificationsOnClickedListener);

function notificationsOnClickedListener(notificationId) {
    const onClick = notificationsStorage.get(notificationId);

    if (onClick?.action === 'open-tab') {
        browser.tabs.create({
            active: onClick.active === undefined ? true : onClick.active,
            url: onClick.url,
        });
    } else if (onClick?.action === 'open-options') {
        browser.runtime.openOptionsPage();
    } else if (onClick?.action) {
        console.error('invalid notifications action:', onClick.action);
    }
}

export async function notify(notificationId, message, {
        title = browser.i18n.getMessage('extensionName'),
        iconUrl = '/icons/icon.svg',
        timerSec = 25,
        onClick = {},
    } = {}) {

    if (!notificationId) {
        throw Error('"notificationId" is required');
    }

    notificationId = String(notificationId);
    message = String(message);

    await browser.notifications.clear(notificationId);

    // https://developer.mozilla.org/en-US/Add-ons/WebExtensions/API/notifications/NotificationOptions
    // Only 'type', 'iconUrl', 'title', and 'message' are supported.
    await browser.notifications.create(notificationId, {
        type: 'basic',
        iconUrl,
        title,
        message,
    });

    if (Number.isFinite(timerSec)) {
        if (timerSec > 25) {
            timerSec = 25;
        } else if (timerSec < 3) {
            timerSec = 3;
        }
    } else {
        timerSec = undefined;
    }

    if (timerSec) {
        setTimeout(notificationId => browser.notifications.clear(notificationId), timerSec * 1000, notificationId);
    }

    if (onClick.action) {
        notificationsStorage.set(notificationId, onClick, timerSec);
    }
}

export function sendExternalMessage(action, data = {}) {
    return browser.runtime.sendMessage(Constants.STG_ID, {
        action,
        ...data,
    });
}

export function convertSvgToUrl(svg) {
    return 'data:image/svg+xml;base64,' + b64EncodeUnicode(svg);
}

function b64EncodeUnicode(str) {
    // first we use encodeURIComponent to get percent-encoded UTF-8,
    // then we convert the percent encodings into raw bytes which
    // can be fed into btoa.
    return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g,
        function toSolidBytes(match, p1) {
            return String.fromCharCode('0x' + p1);
        }));
}
