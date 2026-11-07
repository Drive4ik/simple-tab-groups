import './prefixed-storage.js';

import * as Constants from './constants.js';
import JSON from './json.js';
import * as Messages from './messages.js';
import * as Broadcast from './broadcast.js';
import * as DebugBroadcast from './broadcast.js?channel=debug';
import {normalizeArgumentValue, getStack, getFuncName, toError} from './logger-utils.js';

const prefixGlue = '.'; // ➡️  →

const storage = localStorage.create(Constants.MODULES.LOGGER);
const mainStorage = localStorage.create(Constants.MODULES.BACKGROUND);

// the flags every record is gated by, read from the storage once: setDebug and setTemporaryInstall write them, the debug channel brings a change to every document (docs/DESIGN-LOGGER.md §6)
let debugMode = mainStorage.debugMode ?? null;
let isTemporaryInstall = mainStorage.IS_TEMPORARY ?? false;

onDebugChanged(mode => debugMode = mode);

const MAX_LOGS = 10_000;
const LOGS_TRIM_STEP = 100; // the list grows this far past MAX_LOGS before it is cut back
const MAX_ERRORS = 50;
const STACK_FRAMES = 5; // of the place a line was written; an error object keeps its own stack whole
const logs = [];
const writtenErrors = new WeakSet; // the Error objects already written as warn or error: the first line decides the level, the catchers' lines stay in the file

const backgroundConnect = Constants.IS_BACKGROUND_PAGE
    ? null
    : Messages.connectToBackground(Constants.MODULES.LOGGER);

const ACTION = Object.freeze({
    START: 'START',
    STOP: 'STOP',
});

const START_LEVELS = new Set(['log', 'info', 'warn', 'debug', 'error']);

const indentConfig = {
    indentSymbol: '   ',
    actionSymbol: {
        [ACTION.START]: '▷', // 🔻⚡️
        [ACTION.STOP]: '◁', // 🔺⭕️
    },
    index: 0,
};

export default class Logger {
    prefixes;
    scope = null;
    #enabled;
    #debugOnly;
    #indent = null;
    #started = false;

    constructor(prefix, {prefixes = [], enabled = true, debugOnly = false} = {}) {
        this.prefixes = [...prefixes, prefix].filter(Boolean);
        this.#enabled = enabled;
        this.#debugOnly = debugOnly;
    }

    get #level() {
        return this.#debugOnly ? 'debug' : 'log';
    }

    create(prefix) {
        return new Logger(prefix, {
            prefixes: this.prefixes,
            enabled: this.#enabled,
            debugOnly: this.#debugOnly,
        });
    }

    enable() {
        this.#enabled = true;
        return this;
    }

    disable() {
        this.#enabled = false;
        return this;
    }

    log(...args) {
        return this.#log(this.#level, args);
    }

    info(...args) {
        return this.#log('info', args);
    }

    warn(...args) {
        return this.#log('warn', args);
    }

    debug(...args) {
        return this.#log('debug', args);
    }

    assert(...args) {
        return this.#log('assert', args);
    }

    error(...args) {
        this.#log('error', args);

        const error = args.findLast(Error.isError) ?? new Error(args.join(' '));
        writtenErrors.add(error);
        return error;
    }

    start(...args) {
        let level = this.#level;

        if (Array.isArray(args[0])) {
            [level, ...args] = [...args[0], ...args.slice(1)];

            if (!START_LEVELS.has(level)) {
                throw this.error(`unknown level of START: ${level}`);
            }
        }

        const log = this.create(normalizeArgumentValue(args.shift()));

        log.scope = Number.parseInt(self.crypto.randomUUID().slice(-12), 16); // 48 random bits

        log.#started = log.#log(level, args, ACTION.START);

        log[Symbol.dispose] = () => log.stop();

        return log;
    }

    stop(...args) {
        if (this.#started) {
            this.#started = false;
            this.#write(this.#level, args, ACTION.STOP);
        }
    }

    catch(...args) {
        return error => {
            throw this.error('Catch error on:', ...args, error);
        };
    }

    catchSilent(...args) {
        return error => {
            this.error('[silent] Catch error on:', ...args, error);
            return undefined; // ! important, depends on tabs.filter(Boolean)
        };
    }

    catchFunc(func) {
        const logger = this;
        const name = getFuncName(func);
        const wrapStack = new Error().stack;

        return async function(...args) {
            try {
                return await func.call(this, ...args);
            } catch (e) {
                const error = toError(e);
                error.stack = [wrapStack, 'Native error stack:', error.stack].join('\n');
                logger.handleError(error, `catchFunc(${name}):`, {args});
            }
        };
    }

    handleError(event, ...details) {
        const error = toError(event);

        setDebug(Constants.DEBUG.AUTO);
        this.error(...details, error);
        Broadcast.send('show-error-notification');
    }

    #allows(level, args) {
        if (level === 'assert') return !args[0];
        if (level === 'error' || level === 'warn') return true;
        if (level === 'debug' && !debugMode) return false;
        return this.#enabled || debugMode === Constants.DEBUG.MANUAL;
    }

    #log(level, args, action = null) {
        if (!this.#allows(level, args)) {
            return false;
        }

        this.#write(level, args, action);

        return true;
    }

    #write(level, args, action = null) {
        const errors = args.filter(Error.isError);

        const log = {
            level,
            prefix: this.prefixes.join(prefixGlue),
            args: args.map(normalizeArgumentValue),
            scope: this.scope,
            action,
            indentIndex: this.#calcIndent(action),
            time: Date.now(),
            stack: getStack(new Error, 0, STACK_FRAMES),
        };

        if ((level === 'error' || level === 'warn') && !errors.some(error => writtenErrors.has(error))) {
            if (level === 'error') {
                Errors.add(log);
            }

            errors.forEach(error => writtenErrors.add(error));
        }

        if (Constants.IS_BACKGROUND_PAGE) {
            Logs.add(log);
        } else {
            backgroundConnect.postMessage('save-log', {log});
        }

        showLog(log);
    }

    #calcIndent(action) {
        if (action === ACTION.START) {
            this.#indent = indentConfig.index++;
        } else if (action === ACTION.STOP && indentConfig.index > 0) {
            indentConfig.index--;
        }

        return this.#indent ?? indentConfig.index;
    }
}

function isDebugging() {
    return Boolean(debugMode) || isTemporaryInstall;
}

export function showLog(log) {
    if (!isDebugging()) {
        return;
    }

    const {level, prefix} = log;
    const args = [...log.args];
    const condition = level === 'assert' ? [args.shift()] : []; // console.assert takes the condition first

    if (log.action) {
        args.unshift(indentConfig.actionSymbol[log.action]);
    }

    args.unshift(prefix);

    if (log.indentIndex) {
        args.unshift(indentConfig.indentSymbol.repeat(log.indentIndex));
    }

    args.push('(' + log.stack.slice(0, 2).join(' ◁ ') + ')');

    console[level](...condition, ...args);
}

export const Logs = {
    add(log) {
        logs.push(log);

        if (logs.length > MAX_LOGS + LOGS_TRIM_STEP) {
            logs.splice(0, logs.length - MAX_LOGS);
        }
    },
    get() {
        return structuredClone(logs.slice(-MAX_LOGS)); // a copy, like Errors.get: the debug page rewrites the records it saves
    },
    clear() {
        logs.length = 0;
    },
};

export const Errors = {
    add(log) {
        const errors = [...Errors.get(), log].slice(-MAX_ERRORS);

        while (errors.length) {
            try {
                storage.errors = errors;
                return;
            } catch {
                errors.shift(); // the quota of localStorage: the oldest give way
            }
        }

        console.error('the quota of localStorage, the error record is lost:', log);
    },
    get() {
        return JSON.clone(storage.errors) ?? [];
    },
    clear() {
        delete storage.errors;
    },
};

window.clearLogs = () => {
    Logs.clear();
    console.clear();
}; // for tests

// the one writer of the debug flag; the change reaches every page and the background (docs/DESIGN-LOGGER.md §6)
export function setDebug(mode = null) {
    if (mode !== null && !Object.values(Constants.DEBUG).includes(mode)) {
        throw new Error(`unknown debug mode: ${mode}`);
    }

    if ((mainStorage.debugMode ?? null) === mode) {
        return;
    }

    if (mode) {
        mainStorage.debugMode = mode;
    } else {
        delete mainStorage.debugMode;
    }

    DebugBroadcast.send({action: 'changed', mode});
}

export function onDebugChanged(func) {
    return DebugBroadcast.on('changed', ({mode}) => func(mode));
}

export function setTemporaryInstall(value) {
    mainStorage.IS_TEMPORARY = isTemporaryInstall = Boolean(value);
}

function errorEventHandler(event) {
    const logger = self.logger ?? new Logger(Constants.PAGES.current);

    logger.handleError(event);
}

self.addEventListener('error', errorEventHandler);
self.addEventListener('unhandledrejection', errorEventHandler);
