
import * as Constants from './constants.js';

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

export function unixNow() {
    return Math.floor(Date.now() / 1000);
}

export async function resetAlarm(
    name,
    isEnable,
    intervalKey,
    intervalValue,
    lastAlarmRunUnixTime,
    minDelayMinutes
) {
    lastAlarmRunUnixTime ||= unixNow();
    minDelayMinutes ||= 0.5;

    await browser.alarms.clear(name);

    if (!isEnable) {
        return;
    }

    let periodInMinutes;

    if (Constants.INTERVAL_KEY.minutes === intervalKey) {
        periodInMinutes = intervalValue;
    } else if (Constants.INTERVAL_KEY.hours === intervalKey) {
        periodInMinutes = intervalValue * 60;
    } else if (Constants.INTERVAL_KEY.days === intervalKey) {
        periodInMinutes = intervalValue * 60 * 24;
    }

    const minutesNow = Math.floor(unixNow() / 60);
    const minutesWhenBackup = periodInMinutes + Math.floor(lastAlarmRunUnixTime / 60);

    const delayInMinutes = minutesWhenBackup > minutesNow
        ? minutesWhenBackup - minutesNow
        : minDelayMinutes;

    await browser.alarms.create(name, {
        delayInMinutes,
        periodInMinutes,
    });
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

export async function createMenu(createProperties, silentRemoveBefore = true) {
    const {promise, resolve, reject} = Promise.withResolvers();

    const {icon} = createProperties;

    delete createProperties.icon;

    if (icon) {
        createProperties.icons = {16: icon};
    }

    if (silentRemoveBefore) {
        await browser.menus.remove(createProperties.id).catch(() => {});
    }

    browser.menus.create(createProperties, () => {
        if (browser.runtime.lastError) {
            reject(browser.runtime.lastError);
        } else {
            resolve();
        }
    });

    return promise;
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
