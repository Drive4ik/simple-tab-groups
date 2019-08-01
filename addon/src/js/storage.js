'use strict';

import utils from './utils';
import constants from './constants';

export default {
    async get(data) {
        let result = await browser.storage.local.get(data);

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
