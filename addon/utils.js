'use strict';

const INNER_HTML = 'innerHTML',
    MANIFEST = browser.runtime.getManifest(),
    DEFAULT_COOKIE_STORE_ID = 'firefox-default',
    PRIVATE_COOKIE_STORE_ID = 'firefox-private',
    CONTEXT_MENU_PREFIX_GROUP = 'stg-move-group-id-',
    CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP = 'stg-undo-remove-group-id-',
    NEW_TAB_URL = '/stg-newtab/newtab.html',
    EXTENSIONS_WHITE_LIST = {
        'stg-plugin-create-new-group@drive4ik': {
            allowedRequests: [
                'runAction',
            ],
            allowedActionIds: [
                'add-new-group',
                'load-last-group',
            ],
        },
        'stg-plugin-load-custom-group@drive4ik': {
            allowedRequests: [
                'runAction',
                'getGroupsList',
            ],
            allowedActionIds: [
                'load-custom-group',
            ],
        },
    },
    DEFAULT_OPTIONS = {
        groups: [],
        lastCreatedGroupPosition: 0,
        browserActionIconColor: '#606060',
        version: '1.0',

        // options
        enableFastGroupSwitching: false,
        enableFavIconsForNotLoadedTabs: true,
        closePopupAfterChangeGroup: true,
        openGroupAfterChange: true,
        showGroupIconWhenSearchATab: true,
        showUrlTooltipOnTabHover: true,
        showNotificationAfterMoveTab: true,
        createNewGroupAfterAttachTabToNewWindow: true,
        openManageGroupsInTab: true,
        showConfirmDialogBeforeGroupDelete: true,
        individualWindowForEachGroup: false,
        openNewWindowWhenCreateNewGroup: false,
        showNotificationIfGroupsNotSyncedAtStartup: true,

        hotkeys: [
            {
                ctrlKey: true,
                shiftKey: false,
                altKey: false,
                key: '`',
                keyCode: 192,
                action: {
                    id: 'load-next-group',
                },
            },
            {
                ctrlKey: true,
                shiftKey: true,
                altKey: false,
                key: '~',
                keyCode: 192,
                action: {
                    id: 'load-prev-group',
                },
            },
        ],
    },
    onlyBoolOptionsKeys = (function() {
        return Object.keys(DEFAULT_OPTIONS).filter(key => 'boolean' === typeof DEFAULT_OPTIONS[key]);
    })(),
    allOptionsKeys = onlyBoolOptionsKeys.concat(['hotkeys', 'browserActionIconColor']);

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
    notify = function(message, timer = 20000, id) {
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

        setTimeout(browser.notifications.clear, timer, id);

        return new Promise(function(resolve, reject) {
            let called = false,
                listener = function(id, notificationId) {
                    if (id === notificationId) {
                        browser.notifications.onClicked.removeListener(listener);
                        called = true;
                        resolve(id);
                    }
                }.bind(null, id);

            setTimeout(() => !called && reject(), timer, id);

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
    isAllowSender = function(sender) {
        if (sender.tab && sender.tab.incognito) {
            return false;
        }

        return true;
    },
    isAllowExternalRequestAndSender = function(request, sender, extensionRules = {}) {
        // all allowed action ids
        // 'load-next-group',
        // 'load-prev-group',
        // 'load-first-group',
        // 'load-last-group',
        // 'load-custom-group',
        // 'add-new-group',
        // 'delete-current-group',
        // 'open-manage-groups',

        let extension = EXTENSIONS_WHITE_LIST[sender.id];

        if (!extension) {
            return false;
        }

        Object.assign(extensionRules, extension);

        if (!request || 'object' !== type(request)) {
            return false;
        }

        let requestKeys = Object.keys(request),
            allowedRequestKeys = extension.allowedRequests.concat(['areYouHere']);

        if (!requestKeys.length || !requestKeys.every(key => allowedRequestKeys.includes(key))) {
            return false;
        }

        if (request.runAction) {
            return extension.allowedActionIds.includes(request.runAction.id);
        }

        return true;
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
    isStgNewTabUrl = function(url, extendResult = {}) {
        if (!url || !url.startsWith('moz-extension')) {
            return false;
        }

        if (url.startsWith(browser.extension.getURL(NEW_TAB_URL))) {
            return true;
        }

        let pregNewTabUrl = NEW_TAB_URL.replace(/\//g, '\\/').replace(/\./, '\\.'),
            reg = new RegExp('^moz-extension:\/\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' + pregNewTabUrl);

        if (reg.test(url)) {
            extendResult.isOldUrl = true;
            return true;
        }

        return false;
    },
    createStgTabNewUrl = function(tab, enableFavIconsForNotLoadedTabs = DEFAULT_OPTIONS.enableFavIconsForNotLoadedTabs) {
        let params = new URLSearchParams;

        params.set('url', tab.url);
        params.set('title', tab.title || tab.url);

        if (enableFavIconsForNotLoadedTabs) {
            params.set('favIconUrl', tab.favIconUrl);
        }

        return browser.extension.getURL(NEW_TAB_URL) + '?' + params.toString();
    },
    revokeStgNewTabUrl = function(url) {
        return new URL(url).searchParams.get('url');
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
    parseHtml = function(html) {
        let template = document.createElement('template');
        template[INNER_HTML] = html;
        return template.content.firstElementChild;
    },
    toCamelCase = function(str) {
        return str.replace(/^([A-Z])|[\s_-](\w)/g, function(match, p1, p2) {
            return p2 ? p2.toUpperCase() : p1.toLowerCase();
        });
    },
    capitalize = function(str) {
        return str.charAt(0).toUpperCase() + str.slice(1);
    },
    createGroupTitle = function(title, groupId) {
        title = (title || '').trim();

        if (!title) {
            title = browser.i18n.getMessage('newGroupTitle', groupId);
        }

        return safeHtml(title);
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
        get(data) {
            return browser.storage.local.get(data)
                .then(function(result) {
                    if (null === data) {
                        result = Object.assign({}, DEFAULT_OPTIONS, result);
                    } else if ('string' === type(data)) {
                        if (undefined === result[data]) {
                            result[data] = DEFAULT_OPTIONS[data];
                        }
                    } else if (Array.isArray(data)) {
                        data.forEach(function(key) {
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
        async set(data) {
            await browser.storage.local.set(data);

            let eventObj = {},
                doCallEvent = false,
                optionsKeys = Object.keys(data).filter(key => allOptionsKeys.includes(key));

            if (optionsKeys.length) {
                eventObj.optionsUpdated = optionsKeys;
                doCallEvent = true;
            }

            if (doCallEvent) {
                browser.runtime.sendMessage(eventObj);
            }
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
    getBrowserActionSvgPath = async function(group) {
        if (group && group.iconUrl) {
            return group.iconUrl;
        }

        let iconSvgBlob = await fetch(MANIFEST.browser_action.default_icon),
            iconSvg = await iconSvgBlob.text(),
            options = await storage.get('browserActionIconColor');

        if (DEFAULT_OPTIONS.browserActionIconColor !== options.browserActionIconColor) {
            iconSvg = iconSvg.replace(DEFAULT_OPTIONS.browserActionIconColor, options.browserActionIconColor);
        }

        if (group && group.iconColor) {
            iconSvg = iconSvg.replace('transparent', group.iconColor);
        }

        return convertSvgToUrl(iconSvg);
    },
    convertSvgToUrl = function(svg) {
        let blobIcon = new Blob([svg], {
            type: 'image/svg+xml',
        });

        return URL.createObjectURL(blobIcon);
    },
    resizeImage = function(img, height, width, useTransparency = true) { // img: new Image()
        let canvas = document.createElement('canvas'),
            canvasCtx = canvas.getContext('2d');

        if (!useTransparency) {
            canvas.mozOpaque = true;
        }

        canvas.width = width;
        canvas.height = height;

        canvasCtx.drawImage(img, 0, 0, width, height);

        return canvas.toDataURL();
    };
