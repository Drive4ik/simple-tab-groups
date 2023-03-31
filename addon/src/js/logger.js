
import * as Constants from './constants.js';
import JSON from './json.js';
import Messages from './messages.js';

const consoleKeys = ['log', 'info', 'warn', 'error', 'debug', 'assert'];

const connectToBG = function(log) {
    let prefixes = log?.prefixes.join(' ') || '';
    return this.messagePort ??= Messages.connectToBackground(`${prefixes} Logger`);
}.bind({
    messagePort: null,
})

Logger.logs = [];

export default function Logger(prefix, prefixes = []) {
    if (this) { // create new logger with prefix
        this.scope = null;
        this.stopMessage = null;
        this.prefixes ??= prefixes;

        if (prefix) {
            this.prefixes.push(prefix);
        }

        this.indentConfig = indentConfig;

        setLoggerFuncs.call(this);

        return this;
    } else {
        Logger.prototype.addLog.apply(new Logger, Array.from(arguments));
    }
}

function setLoggerFuncs() {
    consoleKeys.forEach(cKey => this[cKey] = Logger.prototype.addLog.bind(this, cKey));

    this.start = function(...startArgs) {
        let cKey = 'log';

        if (Array.isArray(startArgs[0])) {
            cKey = startArgs[0].shift();
            startArgs = [...startArgs[0], ...startArgs.slice(1)];
        }

        const uniq = getRandomInt(),
            logger = new Logger(startArgs.shift(), this.prefixes.slice());

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

            let args = [...[message].flat(), normalizeError(error)];

            if (window.localStorage.enableDebug && !this.fromErrorEventHandler) {
                throwError = true;
            }

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
        return this.onError(message, true)(error);
    }.bind(this);

    this.runError = function(message, error) {
        return this.onError(message, false)(error);
    }.bind(this);

    return this;
}

Logger.prototype.addLog = function(cKey, ...args) {
    if (!Array.isArray(this.prefixes)) {
        return console.error('invalid logger scope');
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
        Errors.set(log);
    }

    if (Constants.IS_BACKGROUND_PAGE) {
        Logger.logs.push(log);
        Logger.prototype.showLog.call(this, log, {cKey, args});
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
}

Logger.prototype.showLog = function(log, {cKey, args}) {
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
};

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
};

const Errors = {
    get(clearAfter) {
        let errorLogs = JSON.parse(self.localStorage.errorLogs || null) || [];

        if (clearAfter) {
            delete self.localStorage.errorLogs;
        }

        return errorLogs;
    },
    set(error) {
        let errorLogs = this.get();

        errorLogs.push(error);

        self.localStorage.errorLogs = JSON.stringify(errorLogs.slice(-50));
    },
};

Logger.getErrors = Errors.get.bind(Errors);

Logger.clearLogs = () => {
    Logger.logs = Logger.logs.slice(-150);
    Logger.getErrors(true);
};

Logger.normalizeError = normalizeError;
function normalizeError(event) {
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

function nativeErrorToObj(nativeError) {
    return {
        message: nativeError.message,
        fileName: nativeError.fileName?.replace(Constants.STG_BASE_URL, ''),
        lineNumber: nativeError.lineNumber,
        columnNumber: nativeError.columnNumber,
        stack: getStack(nativeError).join('\n'),
        arguments: nativeError.arguments,
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

const DELETE_LOG_STARTS_WITH = [
    'Logger',
    'normalizeError',
    'setLoggerFuncs',
    'sendMessage',
    'sendExternalMessage',
    './js/logger.js',
];

const UNNECESSARY_LOG_STRINGS = [
    Constants.STG_BASE_URL,
    'async*',
    '../node_modules/vue-loader/lib/index.js??vue-loader-options!./popup/Popup.vue?vue&type=script&lang=js&',
    '../node_modules/vue-loader/lib/index.js??vue-loader-options!./manage/Manage.vue?vue&type=script&lang=js&',
    '../node_modules/vue-loader/lib/index.js??vue-loader-options!./options/Options.vue?vue&type=script&lang=js&',
];

function getStack(e, start = 0, to = 50) {
    return UNNECESSARY_LOG_STRINGS
        .reduce((str, strToDel) => String(str).replaceAll(strToDel, ''), e.stack)
        .trim()
        .split('\n')
        .filter(Boolean)
        .filter(str => !DELETE_LOG_STARTS_WITH.some(unlogStr => str.startsWith(unlogStr)))
        .slice(start, to);
}

function getRandomInt(min = 1, max = Number.MAX_SAFE_INTEGER) {
    const randomBuffer = new Uint32Array(1);

    self.crypto.getRandomValues(randomBuffer);

    let randomNumber = randomBuffer[0] / (0xffffffff + 1);

    min = Math.ceil(min);
    max = Math.floor(max);

    return Math.floor(randomNumber * (max - min + 1)) + min;
}

self.errorEventHandler = errorEventHandler; // add to self if need remove Listener
self.unhandledrejection = e => self.errorEventHandler(e.reason); // add to self if need remove Listener

self.addEventListener('error', self.errorEventHandler);
self.addEventListener('unhandledrejection', self.unhandledrejection);
