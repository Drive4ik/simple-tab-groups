(function() {
    'use strict';

    window.storage = {
        async get(keys, errorCounter = 0) {
            !errorCounter && console.log('START storage.get', keys);

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
                    throw e;
                }

                console.error("Error: storage.get errorCounter: %s, can't read keys", errorCounter, keys);

                await utils.wait(200);
                return this.get(keys, errorCounter);
            }

            console.log('STOP storage.get');

            return result;
        },
        async set(data) {
            console.log('START storage.set');

            if (data.groups) {
                data.groups.forEach(group => !group.isArchive && (group.tabs = []));
            }

            let result = await browser.storage.local.set(data);

            console.log('STOP storage.set');

            return result;
        },
        remove: browser.storage.local.remove,
        clear: browser.storage.local.clear,
    };

})();
