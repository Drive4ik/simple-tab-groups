(function() {
    'use strict';

    let errorCounter = 0;

    window.storage = {
        async get(data) {
            console.log('START storage.get', data);

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

            if (null === data) {
                result = {...utils.clone(DEFAULT_OPTIONS), ...result};
            } else if ('string' === utils.type(data)) {
                if (undefined === result[data]) {
                    result[data] = utils.clone(DEFAULT_OPTIONS[data]);
                }
            } else if (Array.isArray(data)) {
                data.forEach(key => undefined === result[key] ? result[key] = utils.clone(DEFAULT_OPTIONS[key]) : null);
            }

            console.log('STOP storage.get');

            return result;
        },
        async set(data) {
            console.log('START storage.set');

            if (data.groups) {
                data.groups.forEach(group => !group.isArchive && (group.tabs = []));
            }

            try {
                await browser.storage.local.set(data);
            } catch (e) {
                // https://bugzilla.mozilla.org/show_bug.cgi?id=1601365

                console.error(e);

                let message = null,
                    {os} = await browser.runtime.getPlatformInfo();

                if (e && e.message) {
                    message = e.message;
                }

                if (message === 'An unexpected error occurred' && os === 'linux') {
                    let existData = await this.get(null);

                    let newData = {
                        ...existData,
                        ...data,
                    };

                    await browser.storage.local.clear();

                    await browser.storage.local.set(newData);
                } else {
                    throw e;
                }

            }

            console.log('STOP storage.set');

            // return browser.storage.local.set(data);
        },
        remove: browser.storage.local.remove,
        clear: browser.storage.local.clear,
    };

})();
