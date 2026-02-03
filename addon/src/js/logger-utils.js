
import * as Constants from './constants.js';
import JSON from './json.js';

const UNNECESSARY_LOG_STRINGS = [
    Constants.STG_BASE_URL + 'js/',
    Constants.STG_BASE_URL,
    'async*',
    'Async*',
];

function removeUnnecessaryStrings(str) {
    return UNNECESSARY_LOG_STRINGS.reduce((s, strToDel) => s.replaceAll(strToDel, ''), String(str));
}

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

export function getStack(e, start = 0, to = 50) {
    return removeUnnecessaryStrings(e.stack)
        .split('\n')
        .filter(Boolean)
        .filter(line => !DELETE_STACK_LINE_INCLUDES.some(str => line.includes(str)))
        .filter(line => !DELETE_STACK_LINE_STARTS_WITH.some(str => line.startsWith(str)))
        .slice(start, to);
}

export function nativeErrorToObj(nativeError) {
    return {
        name: nativeError.name,
        message: nativeError.message,
        fileName: removeUnnecessaryStrings(nativeError.fileName),
        lineNumber: nativeError.lineNumber,
        columnNumber: nativeError.columnNumber,
        stack: getStack(nativeError).join('\n'),
        arguments: nativeError.arguments,
    };
}

export function objToNativeError(obj) {
    const error = new Error(obj.message);
    error.name = obj.name || 'objToNativeError';
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
    let nativeError = event.error || event;

    if (
        !nativeError ||
        typeof nativeError === 'string' ||
        !String(nativeError?.name).toLowerCase().includes('error') ||
        nativeError.fileName === 'undefined' ||
        !nativeError.stack?.length
    ) {
        let {stack = ''} = nativeError;
        nativeError = new Error(JSON.stringify(nativeErrorToObj(nativeError)));
        if (!stack.length) {
            nativeError.stack = stack + `\nFORCE STACK\n` + nativeError.stack;
        }
    }

    return {
        time: (new Date).toISOString(),
        ...nativeErrorToObj(nativeError),
        stack: getStack(nativeError),
    };
}

const MAX_STRING_LENGTH = 1024 * 1024 * 0.1; // ~100KB

export function normalizeArgumentValue(value) {
    if (value instanceof Error) return normalizeError(value);
    if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
        return 'VERY_BIG_STRING_LENGTH_' + value.length + ': ' + value.slice(0, 200);
    }
    if (Array.isArray(value)) return value.map(normalizeArgumentValue);
    if (value && typeof value === 'object') {
        const clone = JSON.clone(value);
        for (const [key, val] of Object.entries(clone)) {
            clone[key] = normalizeArgumentValue(val);
        }
        return clone;
    }
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
