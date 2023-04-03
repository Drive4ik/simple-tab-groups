
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

    if (timerSec > 25) {
        timerSec = 25;
    } else if (timerSec < 3) {
        timerSec = 3;
    }

    setTimeout(notificationId => browser.notifications.clear(notificationId), timerSec * 1000, notificationId);

    if (onClick.action) {
        notificationsStorage.set(notificationId, onClick, timerSec);
    }
}
