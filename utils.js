'use strict';

const EXTENSION_NAME = 'Simple Tab Groups',
    MANIFEST = browser.runtime.getManifest(),
    DEFAULT_COOKIE_STORE_ID = 'firefox-default',
    PRIVATE_COOKIE_STORE_ID = 'firefox-private',
    CONTEXT_MENU_PREFIX_GROUP = 'stg-move-group-id-',
    NEW_TAB_URL = '/stg-newtab/newtab.html',
    DEFAULT_OPTIONS = {
        groups: [],
        lastCreatedGroupPosition: 0,
        version: '1.0',

        // options
        closePopupAfterChangeGroup: true,
        openGroupAfterChange: true,
        showGroupCircleInSearchedTab: true,
        showUrlTooltipOnTabHover: false,
        showNotificationAfterMoveTab: true,
        createNewGroupAfterAttachTabToNewWindow: true,
        openManageGroupsInTab: true,
        showConfirmDialogBeforeGroupDelete: true,
        enableFastGroupSwitching: true,
        enableFavIconsForNotLoadedTabs: true,

        enableKeyboardShortcutLoadNextPrevGroup: true,
        enableKeyboardShortcutLoadByIndexGroup: true,
    },
    onlyOptionsKeys = (function() {
        return Object.keys(DEFAULT_OPTIONS).filter(key => 'boolean' === typeof DEFAULT_OPTIONS[key]);
    })();

let $ = document.querySelector.bind(document),
    $$ = selector => Array.from(document.querySelectorAll(selector)),
    type = function(obj) {
        return Object.prototype.toString.call(obj).replace(/(^\[.+\ |\]$)/g, '').toLowerCase();
    },
    format = function(str, ...args) {
        if (!str) {
            return '';
        }

        if (1 === args.length && 'object' === type(args[0])) {
            args = args[0];
        }

        return str.replace(/{{(.+?)}}/g, function(match, key) {
            let val = key
                .split('.')
                .reduce((accum, key) => (accum && accum[key]), args);

            if (val || val === '' || val === 0) {
                return val;
            } else if (undefined === val) {
                return '';
                // return key;
            }

            return match;
        });
    },
    randomColor = function() {
        return 'hsla(' + (Math.random() * 360).toFixed(0) + ', 100%, 50%, 1)';
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
            title: EXTENSION_NAME,
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

            setTimeout(() => !called && reject(), 30000, id);

            browser.notifications.onClicked.addListener(listener);
        });
    },
    translatePage = function() { // TODO: move to another file
        $$('[data-i18n]').forEach(function(node) {
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

        document.querySelector('html').setAttribute('lang', browser.i18n.getUILanguage().substring(0, 2));
    },
    isEmptyUrl = function(url) {
        return ['about:blank', 'about:newtab', 'about:home'].includes(url);
    },
    isAllowUrl = function(url) {
        if (!url) {
            return false;
        }

        return /^((https?|ftp|moz-extension):|about:(blank|newtab|home))/.test(url);
    },
    isAllowTab = function(tab) {
        if (!tab || tab.pinned || tab.incognito) {
            return false;
        }

        return isAllowUrl(tab.url);
    },
    isExtensionNewTabUrl = function(url) {
        if (!url) {
            return false;
        }

        if (url.startsWith(browser.extension.getURL(NEW_TAB_URL))) {
            return true;
        }

        let pregNewTabUrl = NEW_TAB_URL.replace(/\//g, '\\/').replace(/\./, '\\.'),
            reg = new RegExp('^moz-extension:\/\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' + pregNewTabUrl);

        if (reg.test(url)) {
            return true;
        }

        return false;
    },
    getStgTabNewUrl = function(tab, enableFavIconsForNotLoadedTabs = DEFAULT_OPTIONS.enableFavIconsForNotLoadedTabs) {
        let params = new URLSearchParams;

        params.set('url', tab.url);
        params.set('title', tab.title || tab.url);

        if (enableFavIconsForNotLoadedTabs) {
            params.set('favIconUrl', tab.favIconUrl);
        }

        return browser.extension.getURL(NEW_TAB_URL) + '?' + params.toString();
    },
    getNextIndex = function(currentIndex, count, textPosition = 'next') {
        if (!count) {
            return false;
        }

        if (1 === count) {
            return 0;
        }

        if (0 > currentIndex) {
            return 'next' === textPosition ? 0 : count - 1;
        } else if (count - 1 < currentIndex) {
            return 'next' === textPosition ? count - 1 : 0;
        }

        let nextIndex = null;

        if ('prev' === textPosition) {
            nextIndex = currentIndex ? (currentIndex - 1) : (count - 1);
        } else if ('next' === textPosition) {
            nextIndex = currentIndex === count - 1 ? 0 : currentIndex + 1;
        }

        return nextIndex;
    },
    dispatchEvent = function(eventName, element) {
        if (!element) {
            return false
        }

        element.dispatchEvent(new Event(eventName, {
            bubbles: true,
            cancelable: true,
        }));
    },
    dataFromElement = function(element) {
        let data = {};

        Object.keys(element.dataset)
            .forEach(function(key) {
                if (isFinite(element.dataset[key])) {
                    data[key] = parseInt(element.dataset[key], 10);
                } else if ('true' === element.dataset[key]) {
                    data[key] = true;
                } else if ('false' === element.dataset[key]) {
                    data[key] = false;
                } else {
                    data[key] = element.dataset[key];
                }
            });

        return data;
    },
    checkVisibleElement = function(element) {
        let rect = element.getBoundingClientRect(),
            viewHeight = Math.max(document.documentElement.clientHeight, window.innerHeight);

        return !(rect.bottom < 0 || rect.top - viewHeight >= 0);
    },
    normalizeCookieStoreId = function(cookieStoreId, containers) {
        if (!cookieStoreId || PRIVATE_COOKIE_STORE_ID === cookieStoreId || DEFAULT_COOKIE_STORE_ID === cookieStoreId) {
            return DEFAULT_COOKIE_STORE_ID;
        }

        let isContainerFound = containers.some(container => container.cookieStoreId === cookieStoreId);
        return isContainerFound ? cookieStoreId : DEFAULT_COOKIE_STORE_ID;
    },
    loadContainers = async function() {
        let containers = [];

        try {
            containers = await browser.contextualIdentities.query({});
            if (!containers) {
                containers = [];
            }
        } catch (e) {}

        return containers.map(function(container) {
            if (!container.iconUrl) {
                container.iconUrl = `chrome://browser/content/usercontext-${container.icon}.svg`;
            }

            return container;
        });
    },
    on = function(eventsStr, query, func, extendNode = null, translatePage = true) {
        let events = this;

        eventsStr
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .forEach(function(eventStr) {
                if (!events[eventStr]) {
                    events[eventStr] = [];
                    document.body.addEventListener(eventStr, function(event) {
                        let result = undefined;

                        function checkQueryByElement(element, data) {
                            if (element.matches && element.matches(data.query)) {
                                Object.assign(element, data.extendNode);
                                result = data.func.call(element, event, dataFromElement(element));
                                data.translatePage && translatePage();
                                return true;
                            }
                        }

                        let el = event.target,
                            found = events[eventStr].some(data => checkQueryByElement(el, data));

                        if (!found) {
                            while (el.parentNode) {
                                found = events[eventStr].some(data => checkQueryByElement(el.parentNode, data));

                                if (found) {
                                    break;
                                }

                                el = el.parentNode;
                            }
                        }

                        return result;
                    }, false);
                }

                events[eventStr].push({
                    query,
                    func,
                    extendNode,
                });
            });
    },
    storage = { // TODO: move to another file
        get(keys) {
            return browser.storage.local.get(keys)
                .then(function(result) {
                    if (null === keys) {
                        result = Object.assign({}, DEFAULT_OPTIONS, result);
                    } else if ('string' === type(keys)) {
                        if (undefined === result[keys]) {
                            result[keys] = DEFAULT_OPTIONS[keys];
                        }
                    } else if (Array.isArray(keys)) {
                        keys.forEach(function(key) {
                            if (undefined === result[key]) {
                                result[key] = DEFAULT_OPTIONS[key];
                            }
                        });
                    }

                    return result;
                });
        },
        clear: browser.storage.local.clear,
        remove: browser.storage.local.remove,
        set(keys) {
            return browser.storage.local.set(keys)
                .then(function() {
                    let eventObj = {},
                        doCallEvent = false;

                    if (onlyOptionsKeys.some(key => key in keys)) {
                        doCallEvent = eventObj.optionsUpdated = true;
                    }

                    if (doCallEvent) {
                        browser.runtime.sendMessage(eventObj);
                    }
                });
        },
    },
    createGroupSvgIconUrl = function(group) {
        if (group.iconUrl) {
            return group.iconUrl;
        }

        if (group.iconColor) {
            let colorSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle fill="${group.iconColor}" cx="8" cy="8" r="8" /></svg>`;
            return 'data:image/svg+xml;base64,' + b64EncodeUnicode(colorSvg);
        }

        return '';
    },
    getBrowserActionSvgPath = function(group) {

        let iconSvg = `
            <svg width="32" height="32" xmlns="http://www.w3.org/2000/svg">
                <g fill="#606060">
                    <rect height="8" width="8" y="0" x="0" />
                    <rect height="8" width="8" y="0" x="12" />
                    <rect height="8" width="8" y="12" x="24" />
                    <rect height="8" width="8" y="12" x="0" />
                    <rect height="8" width="8" y="12" x="12" />
                    <rect height="8" width="8" y="0" x="24" />
                    <rect height="8" width="8" y="24" x="0" />
                    <rect height="8" width="8" y="24" x="12" />
                    <rect height="8" width="8" y="24" x="24" />
                    <path transform="rotate(-90, 18, 18)" d="m3.87079,31.999319l0,-28.125684l28.126548,28.125684l-28.126548,0z" fill="${group.iconColor}" />
                </g>
            </svg>
        `,
        imgSvg = `<svg version="1.1" width="96" height="96" xmlns="http://www.w3.org/2000/svg">
            <g>
                <g fill="#606060">
                    <rect width="24" height="24" />
                    <rect x="36" y="0" width="24" height="24" />
                    <rect x="0" y="36" width="24" height="24" />
                    <rect x="0" y="72" width="24" height="24" />
                    <rect x="72" y="0" width="24" height="24" />
                </g>
                <image height="60" width="60" y="36" x="36" xlink:href="${group.iconUrl}" />
            </g>
        </svg>
        `;

        if (group.iconUrl) {
            return group.iconUrl;
            // return convertSvgToUrl(imgSvg);
        }

        if (group.iconColor) {
            return convertSvgToUrl(iconSvg);
        }

        return MANIFEST.browser_action.default_icon;
    },
    convertSvgToUrl = function(svg) {
        let blobIcon = new Blob([svg], {
            type: 'image/svg+xml',
        });

        return URL.createObjectURL(blobIcon);
    };
