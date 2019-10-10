
(function() {
    let keys = Object.keys(console),
        noop = function() {},
        logs = [],
        _console = {},
        browserFuncs = {};

    const addonUrlPrefix = browser.extension.getURL('');

    function getStack(e, start = 2, to = 6) {
        return e.stack.split(addonUrlPrefix).join('').split('@').slice(start, to).map(s => s.trim().replace('\n', ' -> '));
    }

    keys.forEach(key => _console[key] = console[key].bind(console));

    function log(key, ...args) {
        if (window.localStorage.enableLogging) {
            let stack = Array.isArray(this) ? this : getStack(new Error());

            let date = new Date;
            logs.push({
                key,
                stack,
                time: `${date.toLocaleString()} (${date.getMilliseconds()} ms)`,
                args: JSON.parse(JSON.stringify(args)),
            });
        }

        let keyFunc = key.startsWith('console') && key.split('.')[1];

        keyFunc && _console[keyFunc] ? _console[keyFunc](...args) : _console.debug(`[${key}]:`, ...args);
    }

    console.restart = function() {
        keys.forEach(key => console[key] = window.localStorage.enableDebug ? log.bind(null, `console.${key}`) : (window.IS_PRODUCTION ? noop : _console[key]));

        if (Object.keys(browserFuncs).length || (window.localStorage.enableDebug && window.localStorage.enableLogging)) {
            bindObj(browser);
        }
    };

    console.getLogs = function() {
        let result = JSON.parse(JSON.stringify(logs));
        logs = [];
        return result;
    };

    const excludeKeys = ['i18n', 'management', 'permissions', 'runtime', 'menus', 'extension', 'sidebarAction', 'browserAction', 'theme', 'commands', 'test'];

    function bindObj(obj, ...keys) {
        for (let k in obj) {
            if (k.includes('Listener') || excludeKeys.includes(k) || k.startsWith('on')) {
                continue;
            }

            if (!Array.isArray(obj[k]) && 'object' === typeof obj[k]) {
                bindObj(obj[k], ...keys, k);
            } else if ('function' === typeof obj[k]) {
                let key = [...keys, k].join('.');

                if (!browserFuncs[key]) {
                    browserFuncs[key] = obj[k];
                }

                if (window.localStorage.enableDebug && window.localStorage.enableLogging) {
                    obj[k] = async function(key, ...args) {
                        log('run ' + key, ...args);

                        let stack = getStack(new Error()),
                            now = Date.now(),
                            result = await browserFuncs[key](...args);

                        stack.unshift('time: ' + (Date.now() - now) + ' ms');

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
