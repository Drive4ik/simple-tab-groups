
import * as Constants from './constants.js';

const UNNECESSARY_LOG_STRINGS = [
    Constants.STG_BASE_URL,
    'async*',
    'Async*',
    '../node_modules/vue-loader/lib/index.js??vue-loader-options!./popup/Popup.vue?vue&type=script&lang=js&',
    '../node_modules/vue-loader/lib/index.js??vue-loader-options!./manage/Manage.vue?vue&type=script&lang=js&',
    '../node_modules/vue-loader/lib/index.js??vue-loader-options!./options/Options.vue?vue&type=script&lang=js&',
];

function removeUnnecessaryStrings(str) {
    return UNNECESSARY_LOG_STRINGS.reduce((s, strToDel) => s.replaceAll(strToDel, ''), String(str));
}

const DELETE_LOG_STARTS_WITH = [
    'Logger',
    'normalizeError',
    'setLoggerFuncs',
    'sendMessage',
    'sendExternalMessage',
];

export function getStack(e, start = 0, to = 50) {
    return removeUnnecessaryStrings(e.stack)
        .trim()
        .split('\n')
        .filter(Boolean)
        .filter(str => !DELETE_LOG_STARTS_WITH.some(unlogStr => str.startsWith(unlogStr)))
        .slice(start, to);
}

export function nativeErrorToObj(nativeError) {
    return {
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
