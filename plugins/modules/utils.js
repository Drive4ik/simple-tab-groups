
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
        iconUrl = 'icons/icon.svg',
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

function normalizeSendData(action, data = {}) {
    if (typeof action === 'object' && arguments.length === 1) {
        return action;
    }

    return {action, ...data};
}

export function sendMessage(...args) {
    return browser.runtime.sendMessage(normalizeSendData(...args));
}

export function sendExternalMessage(...args) {
    return browser.runtime.sendMessage(Constants.STG_ID, normalizeSendData(...args));
}

export async function createMenu(createProperties) {
    return new Promise((resolve, reject) => {
        const {icon} = createProperties;

        delete createProperties.icon;

        if (icon) {
            createProperties.icons = {16: icon};
        }

        browser.menus.create(createProperties, () => {
            if (browser.runtime.lastError) {
                console.error('error creating menu item:', browser.runtime.lastError);
                reject(browser.runtime.lastError);
            } else {
                resolve();
            }
        })
    });
}

export function convertSvgToUrl(svg) {
    return toBase64(svg, 'image/svg+xml');
}

export function toBase64(str, type) {
    return `data:${type};base64,` + base64Encode(str);
}

export function base64Encode(str) {
    const bytes = new TextEncoder().encode(str);
    return btoa(String.fromCodePoint(...bytes));
}

export function base64Decode(str) {
    const bytes = Uint8Array.from(Array.from(atob(str), char => char.codePointAt(0)));
    return new TextDecoder().decode(bytes);
}

export async function readFileAsText(fileNode) {
    return new Promise((resolve, reject) => {
        if (0 === fileNode.size) {
            reject('empty file');
            return;
        }

        if (fileNode.size > 700e6) {
            reject('700MB backup? I don\'t believe you');
            return;
        }

        const reader = new FileReader();

        reader.addEventListener('loadend', () => resolve(reader.result));
        reader.addEventListener('error', reject);

        reader.readAsText(fileNode, 'utf-8');
    });
}
