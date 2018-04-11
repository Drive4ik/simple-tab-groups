'use strict';

import storage from './storage';
import * as constants from './constants';

let tagsToReplace = {
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
    '&': '&amp;',
};

function keyId(obj) {
    return obj.id;
}

function type(obj) {
    return Object.prototype.toString.call(obj).replace(/(^\[.+\ |\]$)/g, '').toLowerCase();
}

function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function format(str, ...args) {
    if (!str) {
        return '';
    }

    if (1 === args.length && ['object', 'error'].includes(type(args[0]))) {
        args = args[0];
    }

    return str.replace(/{{(.+?)}}/g, function(match, key) {
        let val = key
            .split('.')
            .reduce((accum, key) => (accum && accum[key]), args);

        if (val || val === '' || val === 0) {
            return val;
        } else if (undefined === val) {
            return '';
            // return key;
        }

        return match;
    });
}

function objectReplaceKeyValue(obj) {
    let result = {};

    Object.keys(obj).forEach(function(key) {
        result[obj[key]] = key;
    });

    return result;
}

function safeHtml(html) {
    let regExp = new RegExp('[' + Object.keys(tagsToReplace).join('') + ']', 'g');
    return (html || '').replace(regExp, tag => tagsToReplace[tag] || tag);
}

function unSafeHtml(html) {
    let replasedTags = objectReplaceKeyValue(tagsToReplace),
        regExp = new RegExp('(' + Object.keys(replasedTags).join('|') + ')', 'g');
    return (html || '').replace(regExp, tag => replasedTags[tag] || tag);
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

function b64DecodeUnicode(str) {
    // Going backwards: from bytestream, to percent-encoding, to original string.
    return decodeURIComponent(atob(str).split('').map(function(c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
}

function notify(message, timer = 20000, id) {
    if (id) {
        browser.notifications.clear(id);
    } else {
        id = String(Date.now());
    }

    if ('error' === type(message)) {
        message.stack = message.stack.split('@').join('\n');
        message = message.toString() + format('\n{{fileName}} {{lineNumber}}:{{columnNumber}}\n{{stack}}', message);
        timer = 60000;
    }

    // https://developer.mozilla.org/en-US/Add-ons/WebExtensions/API/notifications/NotificationOptions
    // Only 'type', 'iconUrl', 'title', and 'message' are supported.
    browser.notifications.create(id, {
        type: 'basic',
        iconUrl: '/icons/icon.svg',
        title: browser.i18n.getMessage('extensionName'),
        message: message,
    });

    setTimeout(browser.notifications.clear, timer, id);

    return new Promise(function(resolve, reject) {
        let called = false,
            listener = function(id, notificationId) {
                if (id === notificationId) {
                    browser.notifications.onClicked.removeListener(listener);
                    called = true;
                    resolve(id);
                }
            }.bind(null, id);

        setTimeout(() => !called && reject(), timer, id);

        browser.notifications.onClicked.addListener(listener);
    });
}

function isAllowSender(request, sender) {
    if (sender.id !== browser.runtime.getManifest().applications.gecko.id || request.isExternalMessage || (sender.tab && isTabIncognito(sender.tab))) {
        return false;
    }

    return true;
}

function isAllowExternalRequestAndSender(request, sender, extensionRules = {}) {
    // all allowed action ids
    // 'load-next-group',
    // 'load-prev-group',
    // 'load-first-group',
    // 'load-last-group',
    // 'load-custom-group',
    // 'add-new-group',
    // 'delete-current-group',
    // 'open-manage-groups',

    let extension = constants.EXTENSIONS_WHITE_LIST[sender.id];

    if (!extension) {
        return false;
    }

    Object.assign(extensionRules, extension);

    if (!request || 'object' !== type(request)) {
        return false;
    }

    let requestKeys = Object.keys(request),
        allowedRequestKeys = extension.allowedRequests.concat(['areYouHere']);

    if (!requestKeys.length || !requestKeys.every(key => allowedRequestKeys.includes(key))) {
        return false;
    }

    if (request.runAction) {
        return extension.allowedActionIds.includes(request.runAction.id);
    }

    return true;
}

function isUrlEmpty(url) {
    return ['about:blank', 'about:newtab', 'about:home'].includes(url);
}

function isUrlAllow(url) {
    if (!url) {
        return false;
    }

    return /^((https?|ftp|moz-extension):|about:(blank|newtab|home))/.test(url);
}

function isWindowAllow(win) {
    return 'normal' === win.type && !win.incognito;
}

function isTabAllowToCreate(tab) {
    return /^((https?|ftp|moz-extension):|about:(blank|home))/.test(tab.url);
}

function isTabIncognito(tab) {
    return tab.incognito;
}

function isTabNotIncognito(tab) {
    return !isTabIncognito(tab);
}

function isTabPinned(tab) {
    return tab.pinned;
}

function isTabNotPinned(tab) {
    return !isTabPinned(tab);
}

function isTabHidden(tab) {
    return tab.hidden;
}

function isTabVisible(tab) {
    return !isTabHidden(tab);
}

function isTabCanBeHidden(rawTab) {
    return !isTabPinned(rawTab) && !rawTab.sharingState.camera && !rawTab.sharingState.microphone;
}

function isTabCanNotBeHidden(rawTab) {
    return !isTabCanBeHidden(rawTab);
}

function getNextIndex(currentIndex, count, textPosition = 'next') {
    if (!count) {
        return false;
    }

    if (1 === count) {
        return 0;
    }

    if (0 > currentIndex) {
        return 'next' === textPosition ? 0 : count - 1;
    } else if (count - 1 < currentIndex) {
        return 'next' === textPosition ? count - 1 : 0;
    }

    let nextIndex = null;

    if ('prev' === textPosition) {
        nextIndex = currentIndex ? (currentIndex - 1) : (count - 1);
    } else if ('next' === textPosition) {
        nextIndex = currentIndex === count - 1 ? 0 : currentIndex + 1;
    }

    return nextIndex;
}

function toCamelCase(str) {
    return str.replace(/^([A-Z])|[\s_-](\w)/g, function(match, p1, p2) {
        return p2 ? p2.toUpperCase() : p1.toLowerCase();
    });
}

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function createGroupTitle(title, groupId) {
    title = (title || '').trim();

    if (!title) {
        title = browser.i18n.getMessage('newGroupTitle', groupId);
    }

    return safeHtml(title);
}

function checkVisibleElement(element) {
    let rect = element.getBoundingClientRect(),
        viewHeight = Math.max(document.documentElement.clientHeight, window.innerHeight);

    return !(rect.bottom < 0 || rect.top - viewHeight >= 0);
}

function isDefaultCookieStoreId(cookieStoreId) {
    return constants.DEFAULT_COOKIE_STORE_ID === cookieStoreId || !cookieStoreId || constants.PRIVATE_COOKIE_STORE_ID === cookieStoreId;
}

async function normalizeCookieStoreId(cookieStoreId, containers) {
    if (isDefaultCookieStoreId(cookieStoreId)) {
        return constants.DEFAULT_COOKIE_STORE_ID;
    }

    if (!containers) {
        containers = await loadContainers();
    }

    let isContainerFound = await getContainer(cookieStoreId, containers);
    return isContainerFound ? cookieStoreId : constants.DEFAULT_COOKIE_STORE_ID;
}

async function getContainer(cookieStoreId, containers) {
    if (!containers) {
        containers = await loadContainers();
    }

    return containers.find(container => container.cookieStoreId === cookieStoreId);
}

async function loadContainers() {
    return await browser.contextualIdentities.query({}).catch(function() {}) || [];
}

function randomColor() {
    return 'hsla(' + (Math.random() * 360).toFixed(0) + ', 100%, 50%, 1)';
}

function safeColor(color) {
    let div = document.createElement('div');
    div.style.backgroundColor = color;
    return div.style.backgroundColor;
}

async function getGroupIconUrl(group = { iconViewType: 'main-squares' }) {
    if (group.iconUrl) {
        return group.iconUrl;
    }

    if (!group.iconColor) {
        group.iconColor = 'transparent';
    }

    let options = await storage.get('browserActionIconColor'),
        iconsUrls = {
            'main-squares': browser.runtime.getManifest().browser_action.default_icon,
            circle: '/icons/circle.svg',
            squares: '/icons/squares.svg',
            'old-tab-groups': '/icons/old-tab-groups.svg',
        },
        replaceData = {
            [constants.DEFAULT_OPTIONS.browserActionIconColor]: options.browserActionIconColor,
            transparent: group.iconColor,
            '{stroke}': 'transparent' === group.iconColor ? `stroke="${options.browserActionIconColor}" stroke-width="1"` : '',
        };

    let iconBlob = await fetch(iconsUrls[group.iconViewType]),
        iconSvg = await iconBlob.text();

    for (let key in replaceData) {
        iconSvg = iconSvg.replace(key, replaceData[key]);
    }

    return convertSvgToUrl(iconSvg);
}

function convertSvgToUrl(svg) {
    return 'data:image/svg+xml;base64,' + b64EncodeUnicode(svg);
}

function resizeImage(img, height, width, useTransparency = true) { // img: new Image()
    let canvas = document.createElement('canvas'),
        canvasCtx = canvas.getContext('2d');

    if (!useTransparency) {
        canvas.mozOpaque = true;
    }

    canvas.width = width;
    canvas.height = height;

    canvasCtx.drawImage(img, 0, 0, width, height);

    return canvas.toDataURL();
}

function extractKeys(obj, keys, clone = false) {
    let newObj = {};

    keys.forEach(key => newObj[key] = clone ? clone(obj[key]) : obj[key]);

    return newObj;
}

export {
    keyId,
    type,
    clone,
    format,
    extractKeys,

    safeHtml,
    unSafeHtml,

    isDefaultCookieStoreId,
    normalizeCookieStoreId,
    getContainer,
    loadContainers,

    notify,

    isAllowSender,
    isAllowExternalRequestAndSender,
    isUrlEmpty,
    isUrlAllow,
    isWindowAllow,
    isTabAllowToCreate,
    isTabIncognito,
    isTabNotIncognito,
    isTabPinned,
    isTabNotPinned,
    isTabHidden,
    isTabVisible,
    isTabCanBeHidden,
    isTabCanNotBeHidden,

    getNextIndex,
    toCamelCase,
    capitalize,

    createGroupTitle,
    checkVisibleElement,
    getGroupIconUrl,

    safeColor,
    randomColor,

    resizeImage,
};
