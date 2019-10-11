'use strict';

import utils from './utils';
import constants from './constants';

let errorCounter = 0;

export default {
    async get(data) {
        let result = null;

        try {
            result = await browser.storage.local.get(data);

            if (!result) {
                throw Error('managed storage is not set, browser.storage.local.get result = undefined');
            }
        } catch (e) {
            errorCounter++;

            if (errorCounter > 100) {
                console.error(e);
                throw e;
            }

            await utils.wait(200);
            return this.get(data);
        }

        if (null === data) {
            result = {...utils.clone(constants.DEFAULT_OPTIONS), ...result};
        } else if ('string' === utils.type(data)) {
            if (undefined === result[data]) {
                result[data] = utils.clone(constants.DEFAULT_OPTIONS[data]);
            }
        } else if (Array.isArray(data)) {
            data.forEach(key => undefined === result[key] ? result[key] = utils.clone(constants.DEFAULT_OPTIONS[key]) : null);
        }

        return result;
    },
    clear: browser.storage.local.clear,
    remove: browser.storage.local.remove,
    async set(data) {
        if (data.groups) {
            data.groups.forEach(group => group.tabs = []);
        }

        return browser.storage.local.set(data);
    },
}
