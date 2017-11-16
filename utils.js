'use strict';

let type = function(obj) {
        return Object.prototype.toString.call(obj).replace(/(^\[.+\ |\]$)/g, '').toLowerCase();
    },
    format = function(str) {
        if (!str) {
            return '';
        }

        let args = [].slice.call(arguments, 1);

        if (1 === args.length && 'object' == type(args[0])) {
            args = args[0];
        }

        return str.replace(/{{(.+?)}}/g, function(match, key) {
            return key
                .split('.')
                .reduce((accum, key) => accum[key], args) || match;
        });
    },
    translatePage = function() {
        Array.from(document.querySelectorAll('[data-i18n]')).forEach(function(node) {
            node.dataset.i18n
                .trim()
                .split(/\s*\|\s*/)
                .filter(Boolean)
                .forEach(function(langStr) {
                    let [langKey, attr, langParam] = langStr.split(/\s*\:\s*/);
                    attr = attr || 'innerText';
                    node[attr] = browser.i18n.getMessage(langKey, langParam);
                });

            // delete node.dataset.i18n;
        });
    },
    storage = {
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
