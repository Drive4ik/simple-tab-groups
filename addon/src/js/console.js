(function() {
    'use strict';

    let keys = Object.keys(console),
        checkTime = () => console.lastUsage = Date.now(),
        logs = [],
        _console = {},
        browserFuncs = {};

    checkTime();

    keys.forEach(key => _console[key] = console[key].bind(console));

    function clone(obj) {
        return JSON.parse(JSON.stringify(obj));
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
        return e.stack.split(addonUrlPrefix).join('').split('@').slice(start, to).map(s => s.trim().replace('\n', ' <- '));
    }

    console.getErrorStack = getErrorStack;

    function log(key, ...args) {
        checkTime();

        args = clone(args);

        logs.push({
            key,
            time: (new Date).toISOString(),
            stack: Array.isArray(this) ? clone(this) : getErrorStack(new Error()),
            args,
        });

        let keyFunc = key.startsWith('console') && key.split('.')[1];

        (keyFunc && _console[keyFunc]) ? _console[keyFunc](...args) : _console.debug(`[${key}]:`, ...args);
    }

    let autoLogsTimer = null;
    console.logError = function(error) {
        error = clone(error);

        if (!window.localStorage.enableDebug) {
            window.localStorage.enableDebug = 2; // auto anable debug mode if error
            console.restart();
        }

        if (window.localStorage.enableDebug == 2) {
            clearTimeout(autoLogsTimer);

            autoLogsTimer = setTimeout(function() { // delete autoenable error logs after 5 min after last error
                if (window.localStorage.enableDebug == 2) {
                    delete window.localStorage.enableDebug;
                    console.restart();
                }
            }, 5 * 60 * 1000);
        }

        addErrorLog(error);

        logs.push(error);

        _console.error(`[STG] ${error.message}`, error);
    }

    console.restart = function() {
        keys.forEach(key => console[key] = window.localStorage.enableDebug ? log.bind(null, `console.${key}`) : (window.IS_PRODUCTION ? checkTime : _console[key]));

        bindBrowser(browser);
    };

    console.getLogs = function() {
        let result = clone(logs);
        logs = [];
        return [...result, 'errorLogs:', ...getErrorLogs(true)];
    };

    const excludeKeys = ['i18n', 'management', 'permissions', 'runtime', 'menus', 'extension', 'sidebarAction', 'browserAction', 'theme', 'commands', 'test', 'webRequest'];

    function bindBrowser(obj, ...keys) {
        for (let k in obj) {
            if (k.includes('Listener') || excludeKeys.includes(k) || k.startsWith('on')) {
                continue;
            }

            if (!Array.isArray(obj[k]) && 'object' === typeof obj[k]) {
                bindBrowser(obj[k], ...keys, k);
            } else if ('function' === typeof obj[k]) {
                let key = [...keys, k].join('.');

                if (!browserFuncs[key]) {
                    browserFuncs[key] = obj[k];
                }

                if (window.localStorage.enableDebug) {
                    obj[k] = async function(key, ...args) {
                        log('[before] ' + key, ...args);

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

})();
