
import '/js/prefixed-storage.js';
import * as Constants from './constants.js';
import JSON from './json.js';

const mainStorage = localStorage.create(Constants.MODULES.BACKGROUND);

const MAX_STRING_LENGTH = 2048;

const UNNECESSARY_LOG_STRINGS = [
    Constants.STG_BASE_URL + 'js/',
    Constants.STG_BASE_URL,
    'async*',
    'Async*',
];

const DELETE_STACK_LINE_INCLUDES = [
    'vue.runtime.esm.js',
    'listeners.js',
];

const DELETE_STACK_LINE_STARTS_WITH = [
    'Log',
    'normalizeError',
    'PageStack',
    'setLoggerFuncs',
    'sendMessage',
    'sendExternalMessage',
    'getArgumentsModuleCall',
    'catchFunc',
];

function removeUnnecessaryStrings(str) {
    return UNNECESSARY_LOG_STRINGS.reduce((s, strToDel) => s.replaceAll(strToDel, ''), String(str));
}

export function getStack(e, start = 0, to = 50) {
    return removeUnnecessaryStrings(e.stack)
        .split('\n')
        .filter(Boolean)
        .filter(line => !DELETE_STACK_LINE_INCLUDES.some(str => line.includes(str)))
        .filter(line => !DELETE_STACK_LINE_STARTS_WITH.some(str => line.startsWith(str)))
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
        headers: mainStorage.enableDebug === Constants.DEBUG.MANUAL
            ? Object.fromEntries(response.headers.entries())
            : 'deny',
    };
}

export function nativeErrorToObject(nativeError) {
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
        fileName: removeUnnecessaryStrings(nativeError.fileName),
        lineNumber: nativeError.lineNumber,
        columnNumber: nativeError.columnNumber,
        cause: cause,
        stack: getStack(nativeError).join('\n'),
        arguments: nativeError.arguments,
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
    error.fileName = obj.fileName;
    error.lineNumber = obj.lineNumber;
    error.columnNumber = obj.columnNumber;
    if (obj.stack) {
        error.stack = obj.stack;
    }
    return error;
}

export function normalizeError(event) {
    let nativeError = event?.error || event || {};

    if (
        typeof nativeError === 'string' ||
        !String(nativeError.name).toLowerCase().includes('error') ||
        nativeError.fileName === 'undefined' ||
        !nativeError.stack?.length
    ) {
        let {stack = ''} = nativeError;
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

export function normalizeArgumentValue(value, seen = new WeakSet()) {
    if (value instanceof Error) return normalizeError(value);
    if (typeof value === 'string') {
        if (value.startsWith('data:')) {
            return 'data:<' + value.length + '>';
        }
        if (value.length > MAX_STRING_LENGTH) {
            return '<str:' + value.length + '>: ' + value.slice(0, 200);
        }
        return value;
    }
    if (Array.isArray(value)) {
        if (seen.has(value)) return undefined;
        seen.add(value);
        return value.map(item => normalizeArgumentValue(item, seen));
    }
    if (value && typeof value === 'object') {
        if (seen.has(value)) return undefined;
        seen.add(value);
        const normalized = {};
        for (const [key, val] of Object.entries(value)) {
            normalized[key] = normalizeArgumentValue(val, seen);
        }
        return normalized;
    }
    if (typeof value === 'function') return getFuncName(value);
    return value;
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
