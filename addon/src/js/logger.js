
import * as Constants from './constants.js';
import JSON from './json.js';
import * as Utils from './utils.js';
import Messages from './messages.js';
import {normalizeError, getStack} from './logger-utils.js';

const consoleKeys = ['log', 'info', 'warn', 'error', 'debug', 'assert'];

const connectToBG = function(log) {
    let prefixes = log?.prefixes.join(' ') || '';
    return this.messagePort ??= Messages.connectToBackground(`${prefixes} Logger`);
}.bind({
    messagePort: null,
})

const logs = [];

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

        const uniq = Utils.getRandomInt(),
            logger = new Logger(startArgs.shift(), this.prefixes.slice());

        logger.enabled = this.enabled;
        logger.scope = uniq;
        logger.stopMessage = `STOP ${logger.scope}`;

        logger[cKey](`START ${logger.scope}`, ...startArgs);

        logger.stop = (...args) => {
            logger.log.call(logger, logger.stopMessage, ...args);
            return args[0];
        };

        logger.stopError = (...args) => {
            logger.error.call(logger, logger.stopMessage, ...args);
            return args[0];
        };

        return logger;
    }.bind(this);

    this.create = this.start; // alias

    this.onCatch = function(message, throwError = true) {
        return (error) => {
            if (typeof message === 'string') {
                message = `Catch error on: ${message}`;
            } else if (Array.isArray(message)) {
                message.unshift(`Catch error on:`);
            }

            error ??= typeof message === 'object' ? new Error(JSON.stringify(message)) : new Error(message);

            const args = [...[message].flat(), normalizeError(error)];

            if (window.localStorage.enableDebug && !this.fromErrorEventHandler) {
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

            // !ни в коем случае не делай ретурн !!! повлияет на tabs.filter(Boolean)
        }
    }.bind(this);

    this.onError = function(...args) {
        return this.onCatch(...args);
    }.bind(this);

    this.throwError = function(message, error) {
        this.onError(message, true)(error);
        return this;
    }.bind(this);

    this.runError = function(message, error) {
        this.onError(message, false)(error);
        return this;
    }.bind(this);

    this.isEnabled = function(cKey) {
        return this.enabled || !!localStorage.enableDebug || cKey === 'error' || cKey === 'assert';
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

function Log(cKey, ...args) {
    setLoggerFuncs.call(this);

    if (!this.isEnabled(cKey)) {
        return;
    }

    if (cKey === 'assert' && args[0]) {
        return;
    }

    const argsToLog = [this.prefixes.join('.'), ...args];

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
        connectToBG(this).sendMessage('save-log', {
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

    if (!this.isEnabled(cKey)) {
        return;
    }

    if (self.localStorage.enableDebug || self.IS_TEMPORARY) {
        let argsToConsole = cKey === 'assert'
            ? [args[0], this.prefixes.join('.'), ...args.slice(1)]
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
        return JSON.parse(self.localStorage.errorLogs || null) || [];
    },
    add(error) {
        const errorLogs = Errors.get();

        errorLogs.push(error);

        self.localStorage.errorLogs = JSON.stringify(errorLogs.slice(-50));
    },
    clear() {
        delete self.localStorage.errorLogs;
    },
};

export function getErrors() {
    return Errors.get();
}

export function clearErrors() {
    Errors.clear();
}

export function getLogs() {
    return logs.slice(-3000);
}

export function clearLogs() {
    logs.length = 0;
}

export function catchFunc(asyncFunc) {
    const fromStack = new Error().stack;

    return async function() {
        try {
            return await asyncFunc(...Array.from(arguments));
        } catch (e) {
            e.message = `[catchFunc]: ${e.message}`;
            e.stack = [fromStack, 'Native error stack:', e.stack].join('\n');
            e.arguments = JSON.clone(Array.from(arguments));
            self.errorEventHandler(e);
        }
    };
}

function errorEventHandler(event) {
    event.preventDefault?.();
    event.stopImmediatePropagation?.();

    self.localStorage.enableDebug = 2;

    const logger = this instanceof Logger ? this : self.logger;

    if (logger) {
        logger.fromErrorEventHandler = true;
        logger.runError(event.message, event);
    } else {
        console.error(event.message, event);
    }

    showErrorNotificationMessage(logger);
}

function showErrorNotificationMessage(logger) {
    if (Constants.IS_BACKGROUND_PAGE) {
        self.onBackgroundMessage('show-error-notification', self);
    } else {
        connectToBG(logger).sendMessage('show-error-notification');
    }
}

self.errorEventHandler = errorEventHandler; // add to self if need remove Listener
self.unhandledrejection = e => self.errorEventHandler(e.reason); // add to self if need remove Listener

self.addEventListener('error', self.errorEventHandler);
self.addEventListener('unhandledrejection', self.unhandledrejection);
