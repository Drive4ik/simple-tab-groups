
import * as Constants from './constants.js';
import * as ConstantsBrowser from '/js/constants-browser.js';
import JSON from './json.js';

export const INNER_HTML = 'innerHTML';

export function unixNow() {
    return Math.floor(Date.now() / 1000);
}

const TYPE_REGEXP = /(^\[.+\ |\]$)/g;
export function type(obj) {
    return Object.prototype.toString.call(obj).replace(TYPE_REGEXP, '').toLowerCase();
}

export function isDeadObject(obj) {
    try {
        type(obj);
        return false;
    } catch (e) {
        return e instanceof TypeError;
    }
}

// if last element is Boolean true - remove empty keys, else
// aaa {a|b} ccc => aaa b ccc
export function format(str, ...args) {
    str = String(str);
    if (!str) return str;

    const lastArg = args[args.length - 1];

    let removeEmptyKeys = false;
    let processValueFunc = value => value;

    if (lastArg === true) {
        removeEmptyKeys = args.pop();
    } else if (typeof lastArg === 'function') { // if last argument is function = call this func for every value in set
        processValueFunc = args.pop();
    }

    args = args.map((arg, key) => arg === Object(arg) ? arg : {[key]: arg});

    const [
        BRACKET_START = '{',
        BRACKET_END = '}',
        KEYS_DELIMITER = '|',
        KEY_PARTS_DELIMITER = '.',
    ] = Array.isArray(this) ? this : [];

    const regexpEscape = RegExp.escape ? RegExp.escape : s => s.split('').map(s => `\\${s}`).join('');
    const BRACKET_START_ESCAPED = regexpEscape(BRACKET_START);
    const BRACKET_END_ESCAPED = regexpEscape(BRACKET_END);

    const replaceRegExp = new RegExp(`${BRACKET_START_ESCAPED}((?!${BRACKET_END_ESCAPED}).+?)${BRACKET_END_ESCAPED}`, 'g');

    return str.replace(replaceRegExp, (match, fullKey) => {
        const keys = fullKey.split(KEYS_DELIMITER);

        const result = args.reduce((accum, data) => {
            if (accum === undefined) {
                for (const [keyIndex, key] of keys.entries()) {
                    const value = key.split(KEY_PARTS_DELIMITER).map(k => k.trim()).reduce((acc, keyPart) => {
                        if (acc === Object(acc)) {
                            return processValueFunc(acc[keyPart], keyPart, key, keyIndex, keys.length, str);
                        }
                    }, data);

                    if (value !== undefined) {
                        return value;
                    }
                }
            }

            return accum;
        }, undefined);

        if (result !== undefined) {
            return result;
        }

        if (keys.length > 1) {
            return keys[keys.length - 1];
        }

        if (removeEmptyKeys) {
            return '';
        }

        return match;
    });
}

export function isEqualPrimitiveArrays(array1, array2) {
    return array1.length === array2.length
        && JSON.stringify(array1.slice().sort()) === JSON.stringify(array2.slice().sort());
}

export function isPrimitive(value) {
    return value !== Object(value);
}

/* function formatBytes(bytes, decimals = 2) {
    if (0 === bytes) {
        return '0 Bytes';
    }

    let k = 1024,
        sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'],
        i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
} */

export function safeHtml(html) {
    const div = document.createElement('div');
    div.textContent = html ?? '';
    return div[INNER_HTML];
}

export function unSafeHtml(html) {
    const div = document.createElement('div');
    div[INNER_HTML] = html ?? '';
    return div.textContent;
}

export function base64Encode(str) {
    const bytes = new TextEncoder().encode(str);
    return btoa(String.fromCodePoint(...bytes));
}

export function base64Decode(str) {
    const bytes = Uint8Array.from(Array.from(atob(str), char => char.codePointAt(0)));
    return new TextDecoder().decode(bytes);
}

export function sliceText(text, length = 50) {
    return (text?.length > length) ? (text.slice(0, length - 3) + '...') : (text || '');
}

export async function sha256Hex(str) {
    const data = new TextEncoder().encode(str);
    const hashBuffer = await self.crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export function isAllowExternalRequestAndSender(request, sender, extensionRules = {}) {
    // if (sender?.id?.startsWith('test-stg-action')) {
    //     return true;
    // }

    let extension = Constants.EXTENSIONS_WHITE_LIST[sender.id];

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

export function getSupportedExternalExtensionName(extId) {
    return Constants.EXTENSIONS_WHITE_LIST[extId] ? Constants.EXTENSIONS_WHITE_LIST[extId].title : 'Unknown';
}

const invalidBrowserFavIconUrlsRegExp = /^chrome:\/\/(mozapps|devtools)\/skin\//;
export function isAvailableFavIconUrl(favIconUrl) {
    if (!favIconUrl) {
        return false;
    }

    if (invalidBrowserFavIconUrlsRegExp.test(favIconUrl)) {
        return false;
    }

    return true;
}

export function normalizeTabFavIcon(tab) {
    if (!isAvailableFavIconUrl(tab.favIconUrl)) {
        tab.favIconUrl = ConstantsBrowser.DEFAULT_FAVICON;
    }

    return tab;
}

export function isWindowAllow(win) {
    return win?.type === browser.windows.WindowType.NORMAL;
}

const createTabUrlRegexp = /^((http|moz-extension|view-source)|about:blank)/,
    emptyUrlsArray = new Set(['about:blank', 'about:newtab', 'about:home']);

export function isUrlEmpty(url) {
    return emptyUrlsArray.has(url);
}

export function isUrlAllowToCreate(url) {
    return createTabUrlRegexp.test(url);
}

const readerUrl = 'about:reader?url=';
export function normalizeUrl(url) {
    if (!url || typeof url !== 'string') {
        return '';
    } else if (url.startsWith('moz-extension')) {
        const urlObj = new URL(url),
            urlStr = urlObj.searchParams.get('url') || urlObj.searchParams.get('u') || urlObj.searchParams.get('go');

        return urlStr ? normalizeUrl(urlStr) : url;
    } else if (url.startsWith(readerUrl)) {
        return decodeURIComponent(url.slice(readerUrl.length));
    }

    return url;
}

export function normalizeTabUrl(tab) {
    tab.url = normalizeUrl(tab.url);

    return tab;
}

const UUID_REGEXP = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUUID(uuid) {
    return UUID_REGEXP.test(uuid);
}

export function isTabPinned(tab) {
    return tab.pinned === true;
}

export function isTabNotPinned(tab) {
    return !isTabPinned(tab);
}

export function isTabCanBeHidden(tab) {
    return !isTabPinned(tab) && tab.sharingState && !tab.sharingState.screen && !tab.sharingState.camera && !tab.sharingState.microphone;
}

export function isTabCanNotBeHidden(tab) {
    return !isTabCanBeHidden(tab);
}

export function isTabLoaded(tab) {
    return tab.status === browser.tabs.TabStatus.COMPLETE;
}

export function isTabLoading(tab) {
    return tab.status === browser.tabs.TabStatus.LOADING;
}

export function concatTabs(windowsOrGroups) {
    return windowsOrGroups.reduce((acc, wg) => [...acc, ...wg.tabs], []);
}

export function getLastActiveTab(tabs) {
    return tabs.find(tab => tab.active) || tabs.slice().sort(sortBy('lastAccessed')).pop();
}

export function getNextIndex(index, length, textPosition = 'next') {
    if (!length || length < 0) {
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

export function toCamelCase(str) {
    return str.replace(/^([A-Z])|[\s_-](\w)/g, function(match, p1, p2) {
        return p2 ? p2.toUpperCase() : p1.toLowerCase();
    });
}

export function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

export function sortBy(key, numeric, reverse) {
    return (objA, objB) => {
        return reverse ?
            compareStrings(objB[key], objA[key], numeric) :
            compareStrings(objA[key], objB[key], numeric);
    };
}

export function scrollTo(node) {
    if (typeof node === 'string') {
        node = document.querySelector(node);
    }

    node?.scrollIntoView({
        block: 'center',
        behavior: 'smooth',
    });
}

// -1 : a < b
// 0 : a === b
// 1 : a > b
export function compareStrings(a, b, numeric = true) {
    return String(a).localeCompare(String(b), [], {
        numeric: numeric,
    });
}

export function isElementVisible(element) {
    let rect = element.getBoundingClientRect();

    // Only completely visible elements return true:
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
    // Partially visible elements return true:
    // let isVisible = elemTop < window.innerHeight && elemBottom >= 0;
    // return isVisible;
}

export function getRandomInt(min = 1, max = Number.MAX_SAFE_INTEGER, step = 1) {
    const randomBuffer = new Uint32Array(1);

    self.crypto.getRandomValues(randomBuffer);

    const randomNumber = randomBuffer[0] / (0xffffffff + 1);

    min = Math.ceil(min);
    max = Math.floor(max);

    const result = Math.floor(randomNumber * (max - min + 1)) + min;

    if ((result % step) !== 0 && min <= step && max >= step) {
        return getRandomInt(min, max, step);
    }

    return result;
}

export function clamp(value, min = 0, max = 999) {
    if (min >= max) {
        throw new Error('invalid clamp args');
    }

    value = parseFloat(value, 10);

    if (isNaN(value)) {
        value = min;
    }

    return Math.min(Math.max(value, min), max);
}

export function randomColor() {
    return 'hsl(' + getRandomInt(0, 360, 10) + ', 100%, 50%)';
}

export function safeColor(color) {
    let div = document.createElement('div');
    div.style.backgroundColor = color;
    return div.style.backgroundColor;
}

export function convertSvgToUrl(svg) {
    return 'data:image/svg+xml;base64,' + base64Encode(svg);
}

export function isSvg(url) {
    return url.startsWith('data:image/svg+xml');
}

export function normalizeSvg(svgUrl) {
    let svg = null;

    if (svgUrl.startsWith('data:image/svg+xml;base64,')) {
        const [, svgBase64] = svgUrl.split('data:image/svg+xml;base64,');
        svg = base64Decode(svgBase64);
    } else {
        const [, svgURI] = svgUrl.split('data:image/svg+xml,');
        svg = decodeURIComponent(svgURI);
    }

    const div = document.createElement('div');

    div[INNER_HTML] = svg;

    const svgNode = div.querySelector('svg');

    [...svgNode.children].forEach(node => {
        if (!node.attributes.fill || node.attributes.fill.textContent === 'currentColor') {
            node.setAttribute('fill', 'context-fill');
        }
    });

    return convertSvgToUrl(div[INNER_HTML]);
}

export function normalizeGroupIcon(iconUrl) {
    return new Promise(function(resolve, reject) {
        if (isSvg(iconUrl)) {
            resolve(normalizeSvg(iconUrl));
        } else {
            let img = new Image();

            img.addEventListener('load', () => {
                if (img.height > 64 || img.width > 64) {
                    resolve(resizeImage(img, 64, 64));
                } else {
                    resolve(iconUrl);
                }
            });

            img.addEventListener('error', () => reject('Error load icon'));

            img.src = iconUrl;
        }
    });
}

export function resizeImage(img, height, width, useTransparency = true, ...canvasParams) { // img: new Image()
    const canvas = document.createElement('canvas'),
        context = canvas.getContext('2d');

    if (!useTransparency) {
        canvas.mozOpaque = true;
    }

    canvas.width = width;
    canvas.height = height;

    context.drawImage(img, 0, 0, width, height);

    return isCanvasBlank(canvas, useTransparency, ...canvasParams) ? null : canvas.toDataURL(...canvasParams);
}

function isCanvasBlank(canvas, useTransparency, ...canvasParams) {
    const blank = document.createElement('canvas'),
        canvasDataUrl = canvas.toDataURL(...canvasParams);

    if (!useTransparency) {
        blank.mozOpaque = true;
    }

    blank.width = canvas.width;
    blank.height = canvas.height;

    let isEmpty = canvasDataUrl === blank.toDataURL(...canvasParams);

    if (!isEmpty) {
        const blankContext = blank.getContext('2d');

        blankContext.fillStyle = 'rgb(255, 255, 255)';
        blankContext.fillRect(0, 0, blank.width, blank.height);

        isEmpty = canvasDataUrl === blank.toDataURL(...canvasParams);
    }

    return isEmpty;
}

// needle need to be "LowerCased"
export function mySearchFunc(needle, haystack, extendedSearch = false) {
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

export function onlyUniqueFilter(value, index, self) {
    return self.indexOf(value) === index;
}

export function onlyUniqueFilterLast(value, index, self) {
    return self.lastIndexOf(value) === index;
}

export function assignKeys(toObj, fromObj, keys) {
    keys.forEach(key => toObj[key] = fromObj[key]);
    return toObj;
}

export function extractKeys(obj, keys, useClone = false) {
    const newObj = {};

    keys.forEach(key => newObj[key] = (useClone ? JSON.clone(obj[key]) : obj[key]));

    return newObj;
}

export function arrayToObj(arr, primaryKey = 'id', accum = {}) {
    arr.forEach(obj => accum[obj[primaryKey]] = obj);
    return accum;
}

export function wait(ms = 200) {
    return new Promise(resolve => setTimeout(resolve, ms, ms));
}

export function getNameFromPath(path) {
    return new URL(path).pathname.split('/').pop().split('.').slice(0, -1).join('.');
}

/* a < b : - index of version type (major=-1, minor=-2...)
   a > b : + index of version type (major=1, minor=2...)
   a = b : 0 */
export function compareNumericVersions(a, b) {
    const partsA = a.split('.');
    const partsB = b.split('.');

    const maxLen = Math.max(partsA.length, partsB.length);

    for (let i = 0; i < maxLen; i++) {
        const nA = parseInt(partsA[i], 10) || 0;
        const nB = parseInt(partsB[i], 10) || 0;

        if (nA < nB) return -(i + 1);
        if (nA > nB) return (i + 1);
    }

    return 0;
}

export function safeReloadAddon(sec = 3) {
    return setTimeout(() => browser.runtime.reload(), sec * 1000);
}

export const UI_LANG = browser.i18n.getUILanguage();

export const DATE_LOCALE_VARIABLES = Object.freeze({
    get 'date-full'() {
        return (new Date).toLocaleString(UI_LANG, {dateStyle: 'full'});
    },
    get 'date-medium'() {
        return (new Date).toLocaleString(UI_LANG, {dateStyle: 'medium'});
    },
    get 'date-short'() {
        return (new Date).toLocaleString(UI_LANG, {dateStyle: 'short'});
    },
    get 'time-medium'() {
        return (new Date).toLocaleString(UI_LANG, {timeStyle: 'medium'});
    },
    get 'time-short'() {
        return (new Date).toLocaleString(UI_LANG, {timeStyle: 'short'});
    },
    get 'year-numeric'() {
        return (new Date).toLocaleString(UI_LANG, {year: 'numeric'});
    },
    get 'year-2-digit'() {
        return (new Date).toLocaleString(UI_LANG, {year: '2-digit'});
    },
    get 'month-numeric'() {
        return (new Date).toLocaleString(UI_LANG, {month: 'numeric'});
    },
    get 'month-long'() {
        return (new Date).toLocaleString(UI_LANG, {month: 'long'});
    },
    get 'month-short'() {
        return (new Date).toLocaleString(UI_LANG, {month: 'short'});
    },
    get 'weekday'() {
        return (new Date).toLocaleString(UI_LANG, {weekday: 'long'});
    },
    get 'weekday-short'() {
        return (new Date).toLocaleString(UI_LANG, {weekday: 'short'});
    },
    get 'day-numeric'() {
        return (new Date).toLocaleString(UI_LANG, {day: 'numeric'});
    },
    get 'day-2-digit'() {
        return (new Date).toLocaleString(UI_LANG, {day: '2-digit'});
    },
    get 'day-period'() {
        return (new Date).toLocaleString(UI_LANG, {dayPeriod: 'long'});
    },
    get 'hour-numeric'() {
        return (new Date).toLocaleString(UI_LANG, {hour: 'numeric'});
    },
    get 'hour-2-digit'() {
        return (new Date).toLocaleString(UI_LANG, {hour: '2-digit'});
    },
    get 'hour-minute-ampm'() {
        return (new Date).toLocaleString(UI_LANG, {hour: 'numeric', minute: 'numeric', hour12: true});
    },
    get 'minute'() {
        return (new Date).toLocaleString(UI_LANG, {minute: '2-digit'});
    },
    get 'second'() {
        return (new Date).toLocaleString(UI_LANG, {second: '2-digit'});
    },
});

export function insertVariable(node, value, variable) {
    return value.slice(0, node.selectionStart) +
        `{${variable}}` +
        value.slice(node.selectionEnd, value.length);
}

export function getFilePathVariables() {
    const variables =  {
        ...DATE_LOCALE_VARIABLES,
        'ff-version': Constants.BROWSER.version,
    };

    for (const key in variables) {
        variables[key] = variables[key]
            .replaceAll(':', '-')
            .replaceAll('/', '-');
    }

    return variables;
}

export function relativeTime(input, lang = UI_LANG, style = 'long', numeric = 'auto') {
    const date = (input instanceof Date) ? input : new Date(input);
    const formatter = new Intl.RelativeTimeFormat(lang, {style, numeric});
    const ranges = {
        year: 3600 * 24 * 365,
        month: 3600 * 24 * 30,
        week: 3600 * 24 * 7,
        day: 3600 * 24,
        hour: 3600,
        minute: 60,
        second: 1,
    };

    const secondsElapsed = (date.getTime() - Date.now()) / 1000;

    for (const key in ranges) {
        if (ranges[key] < Math.abs(secondsElapsed)) {
            const delta = secondsElapsed / ranges[key];
            return formatter.format(Math.round(delta), key);
        }
    }

    return formatter.format(0, 'second');
}
