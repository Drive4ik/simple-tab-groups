'use strict';

const DEFAULT_COOKIE_STORE_ID = 'firefox-default',
    CONTEXT_MENU_PREFIX_GROUP = 'stg-move-group-id-',
    defaultOptions = {
        groups: [],
        windowsGroup: {},
        lastCreatedGroupPosition: 0,

        // options
        closePopupAfterChangeGroup: true,
        openGroupAfterChange: true,
        showGroupCircleInSearchedTab: true,
        showUrlTooltipOnTabHover: false,
        showNotificationAfterMoveTab: true,
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

        if (1 === args.length && 'object' === type(args[0])) {
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
    b64EncodeUnicode = function(str) {
        // first we use encodeURIComponent to get percent-encoded UTF-8,
        // then we convert the percent encodings into raw bytes which
        // can be fed into btoa.
        return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g,
            function toSolidBytes(match, p1) {
                return String.fromCharCode('0x' + p1);
            }));
    },
    b64DecodeUnicode = function(str) {
        // Going backwards: from bytestream, to percent-encoding, to original string.
        return decodeURIComponent(atob(str).split('').map(function(c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
    },
    notify = function(message, timer, id) {
        if (id) {
            browser.notifications.clear(id);
        } else {
            id = String(Date.now());
        }

        // https://developer.mozilla.org/en-US/Add-ons/WebExtensions/API/notifications/NotificationOptions
        // Only 'type', 'iconUrl', 'title', and 'message' are supported.
        browser.notifications.create(id, {
            type: 'basic',
            iconUrl: '/icons/icon.svg',
            title: browser.i18n.getMessage('extensionName'),
            message: String(message),
        });

        timer && setTimeout(browser.notifications.clear, timer, id);

        return new Promise(function(resolve, reject) {
            let called = false,
                listener = function(id, notificationId) {
                if (id === notificationId) {
                    browser.notifications.onClicked.removeListener(listener);
                    called = true;
                    resolve(id);
                }
            }.bind(null, id);

            setTimeout(() => called ? null : reject, 30000, id);

            browser.notifications.onClicked.addListener(listener);
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

            delete node.dataset.i18n;
        });
    },
    isAllowUrl = function(url) {
        if (!url) {
            return false;
        }

        return ! /^(chrome:|javascript:|data:|file:|view-source:|about(?!\:(blank|newtab|home)))/.test(url);
    },
    on = function(event, query, func) {
        let events = this;

        if (!events[event]) {
            events[event] = [];
            document.body.addEventListener(event, function({target:el}) {
                function checkQueryByElement(element, data) {
                    if (element.matches && element.matches(data.query)) {
                        let elementData = {};

                        Object.keys(element.dataset)
                            .forEach(function(key) {
                                elementData[key] = isFinite(element.dataset[key]) ? parseInt(element.dataset[key], 10) : element.dataset[key];
                            });

                        data.func.call(element, elementData);
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
        get(keys) {
            return browser.storage.local.get(keys)
                .then(function(result) {
                    if (null === keys) {
                        if (Object.keys(result).length === 0) {
                            Object.assign(result, defaultOptions);
                        }
                    } else if ('string' === type(keys)) {
                        if (undefined === result[keys]) {
                            result[keys] = defaultOptions[keys];
                        }
                    } else if (Array.isArray(keys)) {
                        keys.forEach(function(key) {
                            if (undefined === result[key]) {
                                result[key] = defaultOptions[key];
                            }
                        });
                    }

                    return result;
                });
        },
        clear: browser.storage.local.clear,
        remove: browser.storage.local.remove,
        set(keys, dontEventUpdateStorage) {
            // console.log('save data', keys);
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



