'use strict';

import {DEFAULT_OPTIONS} from './constants';
import * as utils from './utils';

export default {
    get: function(data) {
        return browser.storage.local.get(data)
            .then(function(result) {
                if (null === data) {
                    result = Object.assign({}, utils.clone(DEFAULT_OPTIONS), result);
                } else if ('string' === utils.type(data)) {
                    if (undefined === result[data]) {
                        result[data] = utils.clone(DEFAULT_OPTIONS[data]);
                    }
                } else if (Array.isArray(data)) {
                    data.forEach(key => undefined === result[key] ? result[key] = utils.clone(DEFAULT_OPTIONS[key]) : null);
                }

                return result;
            });
    },
    clear: browser.storage.local.clear,
    remove: browser.storage.local.remove,
    async set(data) {
        if ('groups' in data) {
            if (Array.isArray(data.groups)) {
                data.groups.forEach(function(group) {
                    if (group.tabs.includes(null)) {
                        group.tabs = group.tabs.filter(Boolean); // prevent save wrong tabs, TODO find the place where it happens
                    }
                });
            } else {
                utils.notify('Groups is not an array. Saving canceled.\nPlease contact me by email:\ndrive4ik@gmail.com');
                return Promise.reject();
            }
        }

        return browser.storage.local.set(data);
    },
}
