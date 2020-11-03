(function() {
    'use strict';

    let keys = Object.keys(console),
        checkTime = () => console.lastUsage = Date.now(),
        logs = [],
        _console = {},
        browserFuncs = {};

    checkTime();

    keys.forEach(key => _console[key] = console[key].bind(console));

    function getCircularReplacer() {
        const seen = new WeakSet();

        return (key, value) => {
            if (typeof value === 'object' && value !== null) {
                if (seen.has(value)) {
                    return;
                }

                seen.add(value);
            }

            return value;
        };
    }

    function clone(obj) {
        return JSON.parse(JSON.stringify(obj, getCircularReplacer()));
    }

    function getErrorLogs(clearAfter) {
        let errorLogs = JSON.parse(window.localStorage.errorLogs || null) || [];

        if (clearAfter) {
            delete window.localStorage.errorLogs;
        }

        return errorLogs;
    }

    function addErrorLog(error) {
        let errorLogs = getErrorLogs();

        errorLogs.push(error);

        window.localStorage.errorLogs = JSON.stringify(errorLogs);
    }

    function getErrorStack(e, start = 1, to = 20) {
        return e.stack.split('\n').filter(Boolean).slice(start, to).map(s => s.trim().replace('@', ' -> ').replace(addonUrlPrefix, ''));
    }

    console.addErrorLog = addErrorLog;
    console.getErrorStack = getErrorStack;

    function log(key, ...args) {
        checkTime();

        args = clone(args);

        if (!window.localStorage.enableDebug) {
            logs = logs.slice(-100);
        }

        logs.push({
            [key]: args,
            time: (new Date).toISOString(),
            stack: Array.isArray(this) ? clone(this) : getErrorStack(new Error()),
        });

        if (window.localStorage.enableDebug) {
            let funcName = key.startsWith('console') && key.split('.')[1];

            (funcName && _console[funcName]) ? _console[funcName](...args) : _console.debug(`[${key}]:`, ...args);
        }
    }

    let autoLogsTimer = null;
    console.logError = function(error) {
        checkTime();

        error = clone(error);

        if (!window.localStorage.enableDebug) {
            window.localStorage.enableDebug = 2; // auto anable debug mode if error
            console.restart();
        }

        if (window.localStorage.enableDebug == 2) {
            clearTimeout(autoLogsTimer);

            // reload addon after 5 min after last error
            autoLogsTimer = setTimeout(utils.safeReloadAddon, 5 * 60 * 1000);
        }

        addErrorLog(error);

        logs.push(error);

        _console.error(`[STG] ${error.message}`, error);
    }

    console.restart = function() {
        keys.forEach(key => console[key] = window.IS_TEMPORARY ? _console[key] : log.bind(null, `console.${key}`));

        // bindBrowser(browser);
    };

    console.getLogs = function() {
        let result = clone(logs);
        logs = [];
        return [...result, 'errorLogs:', ...getErrorLogs(true)];
    };
/*
    const excludeKeys = ['i18n', 'management', 'permissions', 'runtime', 'menus', 'extension', 'sidebarAction', 'browserAction', 'theme', 'commands', 'test', 'webRequest', 'getCurrent', 'windows.get', 'tabs.get'];

    function bindBrowser(obj, ...keys) {
        for (let k in obj) {
            let key = [...keys, k].join('.');

            if (excludeKeys.includes(k) || excludeKeys.includes(key) || k.startsWith('on')) {
                continue;
            }

            if (!Array.isArray(obj[k]) && 'object' === typeof obj[k]) {
                bindBrowser(obj[k], ...keys, k);
            } else if ('function' === typeof obj[k]) {
                if (!browserFuncs[key]) {
                    browserFuncs[key] = obj[k];
                }

                if (window.localStorage.enableDebug) {
                    obj[k] = async function(key, ...args) {
                        log.call([], 'before ' + key, ...args);

                        let stack = getErrorStack(new Error()),
                            now = Date.now(),
                            result = null;

                        result = await browserFuncs[key](...args);

                        stack.unshift('execute time: ' + (Date.now() - now) + ' ms');

                        log.call(stack, key, {args, result});
                        return result;
                    }.bind(null, key);
                } else if (obj[k] !== browserFuncs[key]) {
                    obj[k] = browserFuncs[key];
                }
            }
        }
    }
/**/
})();
