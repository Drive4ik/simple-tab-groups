import './prefixed-storage.js';

import * as Constants from './constants.js';
import JSON from './json.js';
import * as Utils from './utils.js';
import * as Messages from './messages.js';
import {normalizeError, getStack} from './logger-utils.js';

const prefixGlue = '.'; // ➡️  →

const storage = localStorage.create(Constants.MODULES.LOGGER);
const mainStorage = localStorage.create(Constants.MODULES.BACKGROUND);

const logs = [];

const backgroundConnect = Constants.IS_BACKGROUND_PAGE
    ? null
    : Messages.connectToBackground(Constants.MODULES.LOGGER);

export default function Logger(prefix, prefixes = []) {
    if (this) { // create new logger with prefix
        this.scope = null;
        this.stopMessage = null;
        this.prefixes ??= prefixes;
        this.enabled = true;

        if (prefix) {
            this.prefixes.push(prefix);
        }

        this.indentConfig = indentConfig;

        setLoggerFuncs.call(this);

        return this;
    } else {
        Log.apply(new Logger, Array.from(arguments));
    }
}

function setLoggerFuncs() {
    const consoleKeys = ['log', 'info', 'warn', 'error', 'debug', 'assert'];

    if (consoleKeys.every(cKey => typeof this[cKey] === 'function')) {
        return;
    }

    consoleKeys.forEach(cKey => this[cKey] = Log.bind(this, cKey));

    this.start = function(...startArgs) {
        let cKey = 'log';

        if (Array.isArray(startArgs[0])) {
            cKey = startArgs[0].shift();
            startArgs = [...startArgs[0], ...startArgs.slice(1)];
        }

        const logger = new Logger(startArgs.shift(), this.prefixes.slice());

        logger.enabled = this.enabled;
        logger.scope = Utils.getRandomInt();
        logger.stopMessage = `STOP ${logger.scope}`;

        logger[cKey](`START ${logger.scope}`, ...startArgs);

        logger.stop = (...args) => logger.log(logger.stopMessage, ...args);
        logger.stopWarn = (...args) => logger.warn(logger.stopMessage, ...args);
        logger.stopError = (...args) => logger.error(logger.stopMessage, ...args);

        return logger;
    }.bind(this);

    this.onCatch = function(message, throwError = true) {
        if (Array.isArray(message)) {
            message = message.map(value => {
                if (Array.isArray(value)) {
                    return value.slice();
                } else if (value === Object(value)) {
                    return cloneObjectOnlyPrimitiveValues(value);
                }

                return value;
            });
        } else if (message === Object(message)) {
            message = cloneObjectOnlyPrimitiveValues(message);
        }

        return (error) => {
            if (typeof message === 'string') {
                message = `Catch error on: ${message}`;
            } else if (Array.isArray(message)) {
                message.unshift(`Catch error on:`);
            }

            error ??= typeof message === 'object' ? new Error(JSON.stringify(message)) : new Error(message);

            const args = [...[message].flat(), normalizeError(error)];

            // fromErrorEventHandler need for prevent loop throw/catch
            if (mainStorage.IS_TEMPORARY && mainStorage.enableDebug && !this.fromErrorEventHandler) {
                throwError = true;
            }

            this.enable();

            delete this.fromErrorEventHandler;

            if (throwError && this.stopMessage) {
                args.unshift(this.stopMessage);
            }

            this.error(...args);

            if (throwError) {
                throw error;
            }

            return undefined; // ! important, depends on tabs.filter(Boolean)
        }
    }.bind(this);

    this.throwError = function(message, error) {
        this.onCatch(message, true)(error);
        return this;
    }.bind(this);

    this.logError = function(message, error) {
        this.onCatch(message, false)(error);
        return this;
    }.bind(this);

    this.isEnabled = function(cKey) {
        return this.enabled || !!mainStorage.enableDebug || cKey === 'error' || cKey === 'assert';
    }.bind(this);

    this.enable = function() {
        this.enabled = true;
        return this;
    }.bind(this);

    this.disable = function() {
        this.enabled = false;
        return this;
    }.bind(this);
}

function cloneObjectOnlyPrimitiveValues(obj) {
    const result = {};
    for (const key in obj) {
        if (typeof obj[key] !== 'object') {
            result[key] = obj[key];
        }
    }
    return result;
}

function Log(cKey, ...args) {
    setLoggerFuncs.call(this);

    if (!this.isEnabled(cKey)) {
        return;
    }

    if (cKey === 'assert' && args[0]) {
        return;
    }

    const argsToLog = [this.prefixes.join(prefixGlue), ...args];

    if (this.scope && !args.some(l => l?.includes?.(this.scope))) {
        argsToLog.push(`SCOPE ${this.scope}`);
    }

    const log = {
        [`console.${cKey}`]: JSON.clone(argsToLog),
        indentIndex: calcIndent.call(this.indentConfig, argsToLog),
        time: Date.now(),
        stack: getStack(new Error),
    };

    if (cKey === 'error') {
        Errors.add(log);
    }

    if (Constants.IS_BACKGROUND_PAGE) {
        addLog(log);
    } else {
        backgroundConnect.sendMessage('save-log', {
            log,
            logger: JSON.clone(this),
            options: {
                cKey,
                args: JSON.clone(args),
            },
        });
    }

    showLog.call(this, log, {cKey, args});
}

export function addLog(log) {
    logs.push(log);
}

export function showLog(log, {cKey, args}) {
    setLoggerFuncs.call(this);

    // if (!this.isEnabled(cKey)) {
    if (!this.enabled) {
        return;
    }

    if (mainStorage.enableDebug || mainStorage.IS_TEMPORARY) {
        let argsToConsole = cKey === 'assert'
            ? [args[0], this.prefixes.join(prefixGlue), ...args.slice(1)]
            : log[`console.${cKey}`].slice();

        if (!console[cKey]) {
            cKey = 'log';
        }

        let indentStr = getIndentAndRemoveScope.call(this.indentConfig, log.indentIndex, argsToConsole);

        if (log.indentIndex) {
            argsToConsole.splice((cKey === 'assert' ? 1 : 0), 0, indentStr);
        }

        argsToConsole.push('(' + log.stack.slice(0, 2).join(' ◁ ') + ')');

        console[cKey].call(console, ...argsToConsole);
    }
}

function getAction(args) {
    let action, key,
        argIndex = args.findIndex(arg => {
            [, action, key] = scopeActionRegExp.exec(arg) || [];
            return action;
        });

    return {action, key, argIndex};
}

const indentConfig = {
    indentSymbol: '   ',
    startSymbol: '▷', // 🔻⚡️
    stopSymbol: '◁', // 🔺⭕️
    index: 0,
    indexByKey: {},
};

const scopeActionRegExp = /(START|STOP|SCOPE) (\d+)/;

function calcIndent(args) {
    let {action, key} = getAction.call(this, args),
        indentCount = this.index;

    if (action === 'START') {
        indentCount = this.indexByKey[key] = this.index++;
    } else if (action === 'STOP') {
        indentCount = this.indexByKey[key];

        if (this.index > 0) {
            this.index--;
        }
    } else if (action === 'SCOPE') {
        indentCount = this.indexByKey[key];
    }

    return indentCount;
}

function getIndentAndRemoveScope(indentCount, args) {
    let {action, argIndex} = getAction.call(this, args);

    if (action === 'START') {
        args[argIndex] = this.startSymbol;
    } else if (action === 'STOP') {
        args[argIndex] = this.stopSymbol;
    } else if (action === 'SCOPE') {
        args.splice(argIndex, 1);
    }

    return this.indentSymbol.repeat(indentCount);
}

const Errors = {
    get() {
        return storage.errors ?? [];
    },
    add(error) {
        const errors = Errors.get();

        errors.push(error);

        storage.errors = errors.slice(-50);
    },
    clear() {
        delete storage.errors;
    },
};

export function getErrors() {
    return Errors.get();
}

export function clearErrors() {
    Errors.clear();
}

export function getLogs() {
    return logs.slice(-5_000);
}

export function clearLogs() {
    logs.length = 0;
}

export function catchFunc(asyncFunc, logger) {
    const name = asyncFunc.name || 'anonymous';
    const fromStack = new Error().stack;

    return async function() {
        try {
            return await asyncFunc.call(this, ...arguments);
        } catch (e) {
            e.message = `catchFunc(${name}), error message: ${e.message}`;
            e.stack = [fromStack, 'Native error stack:', e.stack].join('\n');
            e.arguments = JSON.clone(Array.from(arguments));
            errorEventHandler.call(logger, e);
        }
    };
}

export function errorEventHandler(event) {
    event.preventDefault?.();
    event.stopImmediatePropagation?.();

    mainStorage.enableDebug = Constants.DEBUG.AUTO;

    const logger = this instanceof Logger ? this : self.logger;

    if (logger) {
        logger.fromErrorEventHandler = true;
        logger.logError(event.message, event);
    } else {
        console.error(event.message, event);
    }

    showErrorNotificationMessage(logger);
}

function showErrorNotificationMessage(logger) {
    if (Constants.IS_BACKGROUND_PAGE) {
        self.onBackgroundMessage('show-error-notification', self);
    } else {
        backgroundConnect.sendMessage('show-error-notification');
    }
}

self.addEventListener('error', errorEventHandler);
self.addEventListener('unhandledrejection', e => errorEventHandler(e.reason));
