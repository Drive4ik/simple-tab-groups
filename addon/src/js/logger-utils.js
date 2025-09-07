
import * as Constants from './constants.js';

const UNNECESSARY_LOG_STRINGS = [
    Constants.STG_BASE_URL + 'js/',
    Constants.STG_BASE_URL,
    'async*',
    'Async*',
];

function removeUnnecessaryStrings(str) {
    return UNNECESSARY_LOG_STRINGS.reduce((s, strToDel) => s.replaceAll(strToDel, ''), String(str));
}

const DELETE_LOG_LINE_INCLUDES = [
    'vue.runtime.esm.js',
];

const DELETE_LOG_LINE_STARTS_WITH = [
    'Log',
    'normalizeError',
    'setLoggerFuncs',
    'sendMessage',
    'sendExternalMessage',
];

export function getStack(e, start = 0, to = 50) {
    return removeUnnecessaryStrings(e.stack)
        .split('\n')
        .filter(Boolean)
        .filter(line => !DELETE_LOG_LINE_INCLUDES.some(str => line.includes(str)))
        .filter(line => !DELETE_LOG_LINE_STARTS_WITH.some(str => line.startsWith(str)))
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
