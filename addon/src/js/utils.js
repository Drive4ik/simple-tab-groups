'use strict';

import storage from './storage';
import * as constants from './constants';
import * as npmCompareVersions from 'compare-versions';

let tagsToReplace = {
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
    '&': '&amp;',
};

function keyId({id}) {
    return id;
}

function unixNow() {
    return Math.round(Date.now() / 1000);
}

function type(obj) {
    return Object.prototype.toString.call(obj).replace(/(^\[.+\ |\]$)/g, '').toLowerCase();
}

function clone(obj = null) {
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

function formatBytes(bytes, decimals = 2) {
    if (0 === bytes) {
        return '0 Bytes';
    }

    let k = 1024,
        sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'],
        i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
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

function sliceText(text, length = 50) {
    return (text && text.length > length) ? (text.slice(0, length - 3) + '...') : (text || '');
}

function notify(message, timer = 20000, id) {
    if (id) {
        browser.notifications.clear(id);
    } else {
        id = String(Date.now());
    }

    if ('error' === type(message)) {
        let prefix = browser.extension.getURL('');
        message.stack = message.stack.split('@').map(path => path.replace(prefix, '').trim()).filter(Boolean).join('\n');
        message.fileName = message.fileName.replace(prefix, '');
        message = message.toString() + `\n${message.fileName} ${message.lineNumber}:${message.columnNumber}\n${message.stack}`;
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
    if (sender.id !== browser.runtime.getManifest().applications.gecko.id || !request || request.isExternalMessage || (sender.tab && isTabIncognito(sender.tab))) {
        return false;
    }

    return true;
}

function isAllowExternalRequestAndSender(request, sender, extensionRules = {}) {
    let extension = constants.EXTENSIONS_WHITE_LIST[sender.id];

    if (!extension) {
        return false;
    }

    Object.assign(extensionRules, extension);

    if (!request || 'object' !== type(request)) {
        extensionRules.error = 'request is wrong';
        return false;
    }

    return extension.getActions.includes(request.action);
}

function getSupportedExternalExtensionName(extId) {
    return constants.EXTENSIONS_WHITE_LIST[extId] ? constants.EXTENSIONS_WHITE_LIST[extId].title : 'Unknown';
}

function isUrlEmpty(url) {
    return ['about:blank', 'about:newtab', 'about:home'].includes(url);
}

function isWindowAllow(win) {
    return 'normal' === win.type && !win.incognito;
}

function isUrlAllowToCreate(url) {
    return url ? /^((https?|ftp|moz-extension):|about:blank)/.test(url) : true;
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
    return !isTabPinned(rawTab) && !rawTab.sharingState.screen && !rawTab.sharingState.camera && !rawTab.sharingState.microphone;
}

function isTabCanNotBeHidden(rawTab) {
    return !isTabCanBeHidden(rawTab);
}

function getTabTitle(tab, withUrl) {
    let title = tab.title || tab.url || 'about:blank';

    if (withUrl && tab.url && title !== tab.url) {
        title += '\n' + tab.url;
    }

    return title;
}

function getNextIndex(index, length, textPosition = 'next') {
    if (!length || 0 > length) {
        return false;
    }

    if (1 === length) {
        return 0;
    }

    if ('next' === textPosition) {
        return (index + 1) % length;
    } else if ('prev' === textPosition) {
        return 0 === index ? length - 1 : index - 1;
    } else {
        throw Error(`invalid textPosition: ${textPosition}`);
    }
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
    return title || browser.i18n.getMessage('newGroupTitle', groupId);
}

// -1 : a < b
// 0 : a === b
// 1 : a > b
function compareStrings(a, b, numeric = true) {
    return String(a).localeCompare(String(b), [], {
        numeric: numeric,
    });
}

// -1 : a < b
// 0 : a === b
// 1 : a > b
function compareVersions(a, b) {
    return npmCompareVersions(String(a), String(b));
}

function isElementVisible(element) {
    let rect = element.getBoundingClientRect();

    // Only completely visible elements return true:
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
    // Partially visible elements return true:
    // let isVisible = elemTop < window.innerHeight && elemBottom >= 0;
    // return isVisible;
}

function isDefaultCookieStoreId(cookieStoreId) {
    return constants.DEFAULT_COOKIE_STORE_ID === cookieStoreId || !cookieStoreId || constants.PRIVATE_COOKIE_STORE_ID === cookieStoreId;
}

function normalizeCookieStoreId(cookieStoreId, containers) {
    if (isDefaultCookieStoreId(cookieStoreId)) {
        return constants.DEFAULT_COOKIE_STORE_ID;
    }

    let isContainerFound = containers.some(container => container.cookieStoreId === cookieStoreId);
    return isContainerFound ? cookieStoreId : constants.DEFAULT_COOKIE_STORE_ID;
}

async function loadContainers() {
    // CONTAINER PROPS:
    // color: "blue"
    // ​​colorCode: "#37adff"
    // ​​cookieStoreId: "firefox-container-1"
    // ​​icon: "fingerprint"
    // ​​iconUrl: "resource://usercontext-content/fingerprint.svg"
    // ​​name: "Personal"

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

function getGroupIconUrl(group = { iconViewType: 'main-squares' }) {
    if (group.iconUrl) {
        return group.iconUrl;
    }

    if (!group.iconColor) {
        group.iconColor = 'transparent';
    }

    let stroke = 'transparent' === group.iconColor ? 'stroke="#606060" stroke-width="1"' : '';

    let icons = {
        'main-squares': `
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
                <g fill="context-fill" fill-opacity="context-fill-opacity">
                    <rect height="8" width="8" y="0" x="0" />
                    <rect height="8" width="8" y="0" x="12" />
                    <rect height="8" width="8" y="12" x="24" />
                    <rect height="8" width="8" y="12" x="0" />
                    <rect height="8" width="8" y="12" x="12" />
                    <rect height="8" width="8" y="0" x="24" />
                    <rect height="8" width="8" y="24" x="0" />
                    <rect height="8" width="8" y="24" x="12" />
                    <rect height="8" width="8" y="24" x="24" />
                    <path transform="rotate(-90, 18, 18)" d="m3.87079,31.999319l0,-28.125684l28.126548,28.125684l-28.126548,0z" fill="${group.iconColor}" />
                </g>
            </svg>
        `,
        circle: `
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
                <circle fill="${group.iconColor}" cx="8" cy="8" r="8" ${stroke} />
            </svg>
        `,
        squares: `
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
                <g fill="context-fill" fill-opacity="context-fill-opacity">
                    <rect x="1" y="1" width="6" height="6" rx="1" ry="1"></rect>
                    <rect x="9" y="1" width="6" height="6" rx="1" ry="1"></rect>
                    <rect x="1" y="9" width="6" height="6" rx="1" ry="1"></rect>
                    <rect x="9" y="9" width="6" height="6" rx="1" ry="1" fill="${group.iconColor}"></rect>
                </g>
            </svg>
        `,
        'old-tab-groups': `
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
                <g fill="context-fill" fill-opacity="context-fill-opacity">
                    <rect width="9" height="6" x="1" y="1" rx="1"></rect>
                    <rect width="4" height="6" x="11" y="1" rx="1"></rect>
                    <rect width="5" height="7" x="1" y="8" rx="1"></rect>
                    <rect width="8" height="7" x="7" y="8" rx="1" fill="${group.iconColor}"></rect>
                </g>
            </svg>
        `,
    };

    return convertSvgToUrl(icons[group.iconViewType]);
}

function convertSvgToUrl(svg) {
    return 'data:image/svg+xml;base64,' + b64EncodeUnicode(svg);
}

function resizeImage(img, height, width, useTransparency = true) { // img: new Image()
    let canvas = document.createElement('canvas'),
        context = canvas.getContext('2d');

    if (!useTransparency) {
        canvas.mozOpaque = true;
    }

    canvas.width = width;
    canvas.height = height;

    context.drawImage(img, 0, 0, width, height);

    return isCanvasBlank(canvas, useTransparency) ? null : canvas.toDataURL();
}

function isCanvasBlank(canvas, useTransparency) {
    let blank = document.createElement('canvas'),
        canvasDataUrl = canvas.toDataURL();

    if (!useTransparency) {
        blank.mozOpaque = true;
    }

    blank.width = canvas.width;
    blank.height = canvas.height;

    let isEmpty = canvasDataUrl === blank.toDataURL();

    if (!isEmpty) {
        let blankContext = blank.getContext('2d');

        blankContext.fillStyle = 'rgb(255, 255, 255)';
        blankContext.fillRect(0, 0, blank.width, blank.height);

        isEmpty = canvasDataUrl === blank.toDataURL();
    }

    return isEmpty;
}

function makeSafeUrlForThumbnail(tabUrl) {
    return tabUrl ? tabUrl.split('#', 1).shift() : '';
}

// needle need to be "LowerCased"
function mySearchFunc(needle, haystack, extendedSearch = false) {
    haystack = 'string' === typeof haystack ? haystack.toLowerCase() : '';

    if (!extendedSearch) {
        return haystack.includes(needle);
    }

    let lastFindIndex = -1;

    return needle
        .split('')
        .every(function(char) {
            if (' ' === char) {
                return true;
            }

            lastFindIndex = haystack.indexOf(char, lastFindIndex + 1);
            return -1 !== lastFindIndex;
        });
}

function onlyUniqueFilter(value, index, self) {
    return self.indexOf(value) === index;
}

function extractKeys(obj, keys, useClone = false) {
    let newObj = {};

    keys.forEach(key => newObj[key] = (useClone ? clone(obj[key]) : obj[key]));

    return newObj;
}

function wait(ms = 200) {
    return new Promise(resolve => setTimeout(resolve, ms, ms));
}

async function waitDownload(id, maxWaitSec = 5) {
    let downloadObj = null;

    for (let i = 0; i < maxWaitSec * 5; i++) {
        [downloadObj] = await browser.downloads.search({id});

        if (downloadObj && 'in_progress' !== downloadObj.state) {
            break;
        }

        await wait(200);
    }

    return downloadObj ? downloadObj.state : null;
}

export {
    keyId,
    unixNow,
    type,
    clone,
    format,
    formatBytes,
    extractKeys,
    onlyUniqueFilter,

    safeHtml,
    unSafeHtml,

    sliceText,

    isDefaultCookieStoreId,
    normalizeCookieStoreId,
    loadContainers,

    notify,

    getSupportedExternalExtensionName,

    isAllowSender,
    isAllowExternalRequestAndSender,
    isUrlEmpty,
    isWindowAllow,
    isUrlAllowToCreate,
    isTabIncognito,
    isTabNotIncognito,
    isTabPinned,
    isTabNotPinned,
    isTabHidden,
    isTabVisible,
    isTabCanBeHidden,
    isTabCanNotBeHidden,

    getTabTitle,

    getNextIndex,
    toCamelCase,
    capitalize,
    compareStrings,
    compareVersions,

    createGroupTitle,
    isElementVisible,
    getGroupIconUrl,

    safeColor,
    randomColor,

    resizeImage,

    makeSafeUrlForThumbnail,

    mySearchFunc,

    wait,
    waitDownload,
};
