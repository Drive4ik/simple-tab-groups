'use strict';

const defaultOptions = {
    closePopupAfterChangeGroup: true,
    openGroupAfterChange: true,
    showGroupCircleInSearchedTab: true,
    showUrlTooltipOnTabHover: false,
};

let $ = document.querySelector.bind(document),
    type = function(obj) {
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
            let val = key
                .split('.')
                .reduce((accum, key) => accum[key], args);

            if (val || val === '' || val === 0) {
                return val;
            }

            return match;
        });
    },
    tagsToReplace = {
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
        '&': '&amp;',
    },
    objectReplaceKeyValue = function(obj) {
        let result = {};

        Object.keys(obj).forEach(function(key) {
            result[obj[key]] = key;
        });

        return result;
    },
    safeHtml = function(html) {
        let regExp = new RegExp('[' + Object.keys(tagsToReplace).join('') + ']', 'g');
        return (html || '').replace(regExp, tag => tagsToReplace[tag] || tag);
    },
    unSafeHtml = function(html) {
        let replasedTags = objectReplaceKeyValue(tagsToReplace),
            regExp = new RegExp('(' + Object.keys(replasedTags).join('|') + ')', 'g');
        return (html || '').replace(regExp, tag => replasedTags[tag] || tag);
    },
    notify = function(message, timer) {
        let id = String(Date.now());

        // https://developer.mozilla.org/en-US/Add-ons/WebExtensions/API/notifications/NotificationOptions
        // Only 'type', 'iconUrl', 'title', and 'message' are supported.
        browser.notifications.create(id, {
            type: 'basic',
            iconUrl: browser.extension.getURL('icons/icon.svg'),
            title: browser.i18n.getMessage('extensionName'),
            message: String(message),
        });

        timer && setTimeout(() => browser.notifications.clear(id), timer);
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

            delete node.dataset.i18n;
        });
    },
    on = function(event, query, func) {
        let events = this;

        if (!events[event]) {
            events[event] = [];
            document.body.addEventListener(event, function(e) {
                let el = e.target;

                function checkQueryByElement(element, data) {
                    if (element.matches && element.matches(data.query)) {
                        data.func.call(element, element.dataset);
                        translatePage();
                        return true;
                    }
                }

                let found = events[event].some(data => checkQueryByElement(el, data));

                if (!found) {
                    while (el.parentNode) {
                        found = events[event].some(data => checkQueryByElement(el.parentNode, data));

                        if (found) {
                            break;
                        }

                        el = el.parentNode;
                    }
                }
            }, false);
        }

        events[event].push({
            query,
            func,
        });
    },
    storage = {
        get: browser.storage.local.get,
        clear: browser.storage.local.clear,
        remove: browser.storage.local.remove,
        set(keys, dontEventUpdateStorage) {
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
