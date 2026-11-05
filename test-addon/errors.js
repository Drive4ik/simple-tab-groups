import {Test} from './test.js';

const OWN_ORIGIN = browser.runtime.getURL('');
const OWN_UUID = new URL(OWN_ORIGIN).host;

// the own uuid and the cache token of a round file never reach the report
const mask = text => text.replaceAll(OWN_ORIGIN, '<own page>/').replaceAll(OWN_UUID, '<uuid>').replace(/\?v=\d+/g, '');

// a property of an error as the browser gives it: absent, undefined, or its type and value
function present(object, prop) {
    if (!(prop in object)) {
        return 'absent';
    }

    const value = object[prop];

    return value === undefined ? 'undefined' : `${typeof value} ${JSON.stringify(value)}`;
}

// a line or a column: only whether there is one, the number itself depends on the file of the test
function position(object, prop) {
    const value = object[prop];

    if (typeof value !== 'number') {
        return present(object, prop);
    }

    return value > 0 ? 'number >0' : 'number 0';
}

// the stack as a count of frames and the first frame without its line and column
function stack(error) {
    const text = String(error.stack ?? '');

    if (!text.length) {
        return 'empty';
    }

    const lines = text.split('\n').filter(Boolean);

    return `${lines.length} frame(s), first: ${lines[0].replace(/:\d+:\d+$/, '')}`;
}

// Error.isError may throw instead of answering
export function isError(value) {
    try {
        return String(Error.isError(value));
    } catch (error) {
        return `throws ${error.name}: ${error.message}`;
    }
}

const FIELDS = {
    'Error.isError': error => isError(error),
    'instanceof Error': error => String(error instanceof Error),
    'instanceof DOMException': error => String(error instanceof DOMException),
    name: error => present(error, 'name'),
    message: error => present(error, 'message'),
    fileName: error => present(error, 'fileName'),
    filename: error => present(error, 'filename'),
    lineNumber: error => position(error, 'lineNumber'),
    columnNumber: error => position(error, 'columnNumber'),
    stack: error => stack(error),
    cause: error => present(error, 'cause'),
    code: error => present(error, 'code'),
    result: error => present(error, 'result'),
    'own keys': error => `[${Object.keys(error).join(', ')}]`,
};

// the fields the logger of the add-on reads from an error, in one line; keys - a subset of them, for an expectation
export function shape(error, keys = Object.keys(FIELDS)) {
    return mask(keys.map(key => `${key}: ${FIELDS[key](error)}`).join('; '));
}

// what an operation on a value gives: its result, or the error it throws
export function outcome(run) {
    try {
        return `gives ${JSON.stringify(run())}`;
    } catch (error) {
        return `throws ${error.name}: ${error.message}`;
    }
}

export class ErrorsTest extends Test {
    constructor(options) {
        super(options);
        this.mask = mask;
    }

    // there is no state table for errors: the action goes into the event log as its own line,
    // so the shapes that follow are read under the action that produced them
    act(text) {
        super.act(text);
        this.record('action', text, 0);
    }

    async close() {}
}
