(function() {
    'use strict';

    let errorCounter = 0;

    window.storage = {
        async get(data) {
            console.log('START storage.get', data);

            if (!data) {
                data = DEFAULT_OPTIONS;
            } else if (Array.isArray(data)) {
                data = data.reduce(acc, key => (acc[key] = DEFAULT_OPTIONS[key], acc), {});
            } else { // if data is string key
                data = {[data]: DEFAULT_OPTIONS[data]};
            }

            let result = null;

            try {
                result = await browser.storage.local.get(data);
            } catch (e) {
                errorCounter++;

                if (errorCounter > 100) {
                    errorCounter = 0;
                    throw e;
                }

                await utils.wait(200);
                return this.get(data);
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
