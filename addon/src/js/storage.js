(function() {
    'use strict';

    function noop() {}

    const logger = new Logger('Storage');

    window.storage = {
        async get(keys, errorCounter = 0) {
            const log = logger.start('get', keys, {errorCounter});

            let keysData;
            if (!keys) {
                keysData = DEFAULT_OPTIONS;
            } else if (Array.isArray(keys)) {
                keysData = keys.reduce((acc, key) => (acc[key] = DEFAULT_OPTIONS[key], acc), {});
            } else if (typeof keys === 'string') {
                keysData = {[keys]: DEFAULT_OPTIONS[keys]};
            } else { // if keys is object
                keysData = keys;
            }

            let result = null;

            try {
                result = await browser.storage.local.get(keysData);
            } catch (e) {
                errorCounter++;

                if (errorCounter > 100) {
                    openHelp('db-error-reinstall');
                    log.throwError('db-error-reinstall', e);
                }

                log.error("can't read keys");

                await utils.wait(200);
                return this.get(keys, errorCounter);
            }

            return log.stop(), result;
        },
        async set(data) {
            const log = logger.start('set', Object.keys(data));

            if (data.groups) {
                data.groups.forEach(group => !group.isArchive && (group.tabs = []));
            }

            let result = await browser.storage.local.set(data);

            return log.stop(), result;
        },
        remove: browser.storage.local.remove,
        clear: browser.storage.local.clear,
    };

})();
