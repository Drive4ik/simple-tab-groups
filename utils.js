'use strict';

let storage = {
    get: browser.storage.local.get,
    clear: browser.storage.local.clear,
    remove: browser.storage.local.remove,
    set(keys) {
        let dontEventUpdateStorage = false;

        if (keys.dontEventUpdateStorage) {
            dontEventUpdateStorage = true;
            delete keys.dontEventUpdateStorage;
        } else if ('dontEventUpdateStorage' in keys) {
            delete keys.dontEventUpdateStorage;
        }

        return browser.storage.local.set(keys)
            .then(function() {
                if (dontEventUpdateStorage) {
                    return keys;
                }

                if ('groups' in keys || 'activeTabIndex' in keys || 'windowsGroup' in keys) {
                    browser.runtime.sendMessage({
                        storageUpdated: true,
                    });
                }

                return keys;
            });
    },
};