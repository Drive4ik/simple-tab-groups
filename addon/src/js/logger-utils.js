
import '/js/prefixed-storage.js';
import * as Constants from './constants.js';
import JSON from './json.js';

const mainStorage = localStorage.create(Constants.MODULES.BACKGROUND);

const MAX_LENGTH = 1024 * 100; // a string, or the JSON of an object
const HEAD_LENGTH = 100;

const UNNECESSARY_LOG_STRINGS = [
    Constants.STG_BASE_URL + 'js/',
    Constants.STG_BASE_URL,
    'async*',
    'Async*',
];

const DELETE_STACK_LINE_INCLUDES = [
    'vue.runtime.esm.js',
    'listeners.js',
    'logger.js',
    'logger-utils.js',
    'json.js',
];

const DELETE_STACK_LINE_STARTS_WITH = [
    'sendMessage',
    'sendExternalMessage',
    'getArgumentsModuleCall',
];

const KEEP_STACK_LINE_INCLUDES = [
    'host.js',
    'tabs.js',
];

function removeUnnecessaryStrings(str) {
    return UNNECESSARY_LOG_STRINGS.reduce((s, strToDel) => s.replaceAll(strToDel, ''), String(str));
}

export function getStack(e, start = 0, to = 50) {
    return removeUnnecessaryStrings(e.stack)
        .split('\n')
        .filter(Boolean)
        .filter(line => !DELETE_STACK_LINE_INCLUDES.some(str => line.includes(str)))
        .filter(line => !DELETE_STACK_LINE_STARTS_WITH.some(str => line.startsWith(str)) || KEEP_STACK_LINE_INCLUDES.some(str => line.includes(str)))
        .slice(start, to);
}

function isSimilarErrorObject(obj) {
    return obj?.name !== undefined && obj?.message !== undefined;
}

function isResponseObject(obj) {
    return obj instanceof Response;
}

function responseToObject(response) {
    return {
        ok: response.ok,
        type: response.type,
        status: response.status,
        statusText: response.statusText,
        redirected: response.redirected,
        headers: mainStorage.debugMode === Constants.DEBUG.MANUAL
            ? Object.fromEntries(response.headers.entries())
            : 'deny',
    };
}

export function nativeErrorToObject(nativeError) {
    if (!isSimilarErrorObject(nativeError)) {
        nativeError = toError(nativeError); // a thrown string or null
    }

    const fileName = nativeError.fileName ?? nativeError.filename; // a DOMException names the field filename
    let cause;

    if (isSimilarErrorObject(nativeError.cause)) {
        cause = nativeErrorToObject(nativeError.cause);
    } else if (isResponseObject(nativeError.cause)) {
        cause = responseToObject(nativeError.cause);
    } else {
        cause = nativeError.cause;
    }

    return {
        name: nativeError.name,
        message: nativeError.message,
        lang: nativeError.lang,
        fileName: fileName && removeUnnecessaryStrings(fileName),
        lineNumber: nativeError.lineNumber,
        columnNumber: nativeError.columnNumber,
        cause: cause,
        stack: getStack(nativeError).join('\n'),
    };
}

export function objectToNativeError(obj) {
    const options = {};

    if (obj.cause) {
        options.cause = isSimilarErrorObject(obj.cause) ? objectToNativeError(obj.cause) : obj.cause;
    }

    const error = new Error(obj.message, options);
    error.name = obj.name || 'objectToNativeError';
    error.message = obj.message;
    error.lang = obj.lang;
    error.fileName = obj.fileName;
    error.lineNumber = obj.lineNumber;
    error.columnNumber = obj.columnNumber;
    if (obj.stack) {
        error.stack = obj.stack;
    }
    return error;
}

function normalizeError(nativeError) {
    // a PageStack, a refusal the browser answers from its parent process, an error without a stack:
    // wrapped so that the record keeps a stack (docs/DESIGN-LOGGER.md §4, docs/BEHAVIOR-ERRORS.md §1, §3)
    if (
        !String(nativeError.name).toLowerCase().includes('error') ||
        nativeError.fileName === 'undefined' ||
        !nativeError.stack?.length
    ) {
        const {stack = ''} = nativeError;
        nativeError = new Error(JSON.stringify(nativeErrorToObject(nativeError)));
        if (!stack.length) {
            nativeError.stack = stack + `\nFORCE STACK\n` + nativeError.stack;
        }
    }

    return {
        time: (new Date).toISOString(),
        ...nativeErrorToObject(nativeError),
        stack: getStack(nativeError),
    };
}

export function getFuncName(func) {
    return func.name || String(func).slice(0, 50);
}

export function toError(event) {
    let error = event;

    if (event instanceof Event) {
        event.preventDefault();
        event.stopImmediatePropagation();

        error = event instanceof PromiseRejectionEvent ? event.reason : (event.error ?? event.message);
    }

    if (!Error.isError(error)) {
        error = new Error(String(error));
    }

    return error;
}

export function normalizeArgumentValue(value) {
    if (typeof value === 'string') return cutString(value);
    if (typeof value === 'function') return getFuncName(value);
    if (!value || typeof value !== 'object') return value;

    const json = JSON.stringify(value, replacer);

    if (json.length > MAX_LENGTH) {
        const shape = Array.isArray(value) ? `${value.length} items` : Object.keys(value).join(', ');

        return `VERY_BIG_OBJECT_LENGTH_${json.length}: ${shape}`;
    }

    return JSON.parse(json);
}

function replacer(key, value) {
    if (Error.isError(value)) return normalizeError(value);
    if (typeof value === 'function') return getFuncName(value);
    if (typeof value === 'string') return cutString(value);
    return value;
}

function cutString(str) {
    if (str.length > MAX_LENGTH) {
        return `VERY_BIG_STRING_LENGTH_${str.length}: ${str.slice(0, HEAD_LENGTH)}`;
    }

    return str;
}

export class PageStack extends Error {
    constructor(message = '') {
        super(message);

        this.name = 'PageStack';
        this.fileName = self.location.href;
        this.lineNumber = 0;
        this.columnNumber = 0;
    }
}
