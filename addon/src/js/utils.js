(function() {
    'use strict';

    const tagsToReplace = {
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
        '&': '&amp;',
    };

    async function getInfo() {
        let [
            browserInfo,
            platformInfo,
            permissionBookmarks,
            options,
        ] = await Promise.all([
            browser.runtime.getBrowserInfo(),
            browser.runtime.getPlatformInfo(),
            browser.permissions.contains(PERMISSIONS.BOOKMARKS),
            storage.get(ALL_OPTIONS_KEYS),
        ]);

        return {
            version: manifest.version,
            upTime: (Math.ceil((Date.now() - BG.startTime) / 1000)) + ' sec',
            browserAndOS: {
                ...platformInfo,
                ...browserInfo,
            },
            UUID: browser.extension.getURL(''),
            permissions: {
                bookmarks: permissionBookmarks,
            },
            options: options,
        };
    }

    function keyId({id}) {
        return id;
    }

    function unixNow() {
        return Math.round(Date.now() / 1000);
    }

    function type(obj) {
        return Object.prototype.toString.call(obj).replace(/(^\[.+\ |\]$)/g, '').toLowerCase();
    }

    function getCircularReplacer() {
        const seen = new WeakSet();

        return (key, value) => {
            if (typeof value === 'object' && value !== null) {
                if (seen.has(value)) {
                    return;
                }

                seen.add(value);
            }

            return value;
        };
    }

    function stringify(obj = null, space = null) {
        return JSON.stringify(obj, getCircularReplacer(), space);
    }

    function clone(obj = null) {
        return JSON.parse(stringify(obj));
    }

    function format(str, ...args) {
        if (!str) {
            return '';
        }

        if (1 === args.length && ['object', 'error'].includes(type(args[0]))) {
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
    }

    function formatBytes(bytes, decimals = 2) {
        if (0 === bytes) {
            return '0 Bytes';
        }

        let k = 1024,
            sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'],
            i = Math.floor(Math.log(bytes) / Math.log(k));

        return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
    }

    function objectReplaceKeyValue(obj) {
        let result = {};

        Object.keys(obj).forEach(function(key) {
            result[obj[key]] = key;
        });

        return result;
    }

    function safeHtml(html) {
        let regExp = new RegExp('[' + Object.keys(tagsToReplace).join('') + ']', 'g');
        return (html || '').replace(regExp, tag => tagsToReplace[tag] || tag);
    }

    function unSafeHtml(html) {
        let replasedTags = objectReplaceKeyValue(tagsToReplace),
            regExp = new RegExp('(' + Object.keys(replasedTags).join('|') + ')', 'g');
        return (html || '').replace(regExp, tag => replasedTags[tag] || tag);
    }

    function b64EncodeUnicode(str) {
        // first we use encodeURIComponent to get percent-encoded UTF-8,
        // then we convert the percent encodings into raw bytes which
        // can be fed into btoa.
        return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g,
            function toSolidBytes(match, p1) {
                return String.fromCharCode('0x' + p1);
            }));
    }

    function b64DecodeUnicode(str) {
        // Going backwards: from bytestream, to percent-encoding, to original string.
        return decodeURIComponent(atob(str).split('').map(function(c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
    }

    function sliceText(text, length = 50) {
        return (text && text.length > length) ? (text.slice(0, length - 3) + '...') : (text || '');
    }

    async function notify(message, timer = 20000, id = null, iconUrl = null, onClick = null, onClose = null) {
        if (id) {
            await browser.notifications.clear(id);
        } else {
            id = String(Date.now());
        }

        // https://developer.mozilla.org/en-US/Add-ons/WebExtensions/API/notifications/NotificationOptions
        // Only 'type', 'iconUrl', 'title', and 'message' are supported.
        await browser.notifications.create(id, {
            type: 'basic',
            iconUrl: iconUrl || '/icons/icon.svg',
            title: browser.i18n.getMessage('extensionName'),
            message: String(message),
        });

        let rejectTimer = null,
            listener = function(id, calledId) {
                if (id !== calledId) {
                    return;
                }

                browser.notifications.onClicked.removeListener(listener);
                browser.notifications.onClosed.removeListener(onClosedListener);

                clearTimeout(rejectTimer);
                onClick && onClick(id);
            }.bind(null, id),
            onClosedListener = function(id, calledId, calledBy) {
                if (id !== calledId) {
                    return;
                }

                browser.notifications.onClicked.removeListener(listener);
                browser.notifications.onClosed.removeListener(onClosedListener);
                browser.notifications.clear(id);

                if (calledBy !== 'timeout') {
                    clearTimeout(rejectTimer);
                    onClose && onClose(id);
                }
            }.bind(null, id);

        rejectTimer = setTimeout(onClosedListener, timer, id, 'timeout');

        browser.notifications.onClicked.addListener(listener);
        browser.notifications.onClosed.addListener(onClosedListener);

        return id;
    }

    function isAllowExternalRequestAndSender(request, sender, extensionRules = {}) {
        let extension = EXTENSIONS_WHITE_LIST[sender.id];

        if (!extension) {
            return false;
        }

        Object.assign(extensionRules, extension);

        if (!request || 'object' !== type(request)) {
            extensionRules.error = 'request is wrong';
            return false;
        }

        return extension.getActions.includes(request.action);
    }

    function getSupportedExternalExtensionName(extId) {
        return EXTENSIONS_WHITE_LIST[extId] ? EXTENSIONS_WHITE_LIST[extId].title : 'Unknown';
    }

    function normalizeTabFavIcon(tab) {
        if (tab.favIconUrl) {
            tab.favIconUrl = tab.favIconUrl.startsWith('chrome://mozapps/skin/') ? '/icons/tab.svg' : tab.favIconUrl;
        } else {
            tab.favIconUrl = '/icons/tab.svg';
        }

        return tab;
    }

    function isWindowAllow({type}) {
        return browser.windows.WindowType.NORMAL === type;
    }

    const createTabUrlRegexp = /^((https?|ftp|moz-extension):|about:blank)/,
        emptyUrlsArray = new Set(['about:blank', 'about:newtab', 'about:home']);

    function isUrlEmpty(url) {
        return emptyUrlsArray.has(url);
    }

    function isUrlAllowToCreate(url) {
        return createTabUrlRegexp.test(url);
    }

    function normalizeUrl(url) {
        if (url && url.startsWith('moz-extension')) {
            let urlObj = new URL(url),
                urlStr = urlObj.searchParams.get('url') || urlObj.searchParams.get('u') || urlObj.searchParams.get('go');

            return urlStr ? normalizeUrl(urlStr) : url;
        }

        return url || '';
    }

    function normalizeTabUrl(tab) {
        tab.url = normalizeUrl(tab.url);
        return tab;
    }

    function setUrlSearchParams(url, params = {}) {
        let urlObj = new URL(url);

        for (let i in params) {
            urlObj.searchParams.set(i, params[i]);
        }

        return urlObj.href;
    }

    function isTabPinned(tab) {
        return tab.pinned;
    }

    function isTabNotPinned(tab) {
        return !isTabPinned(tab);
    }

    function isTabCanBeHidden(tab) {
        return !isTabPinned(tab) && tab.sharingState && !tab.sharingState.screen && !tab.sharingState.camera && !tab.sharingState.microphone;
    }

    function isTabCanNotBeHidden(tab) {
        return !isTabCanBeHidden(tab);
    }

    function isTabLoaded({status}) {
        return browser.tabs.TabStatus.COMPLETE === status;
    }

    function isTabLoading({status}) {
        return browser.tabs.TabStatus.LOADING === status;
    }

    function createGroupTitle(title, groupId) {
        return String(title || browser.i18n.getMessage('newGroupTitle', groupId));
    }

    function getLastActiveTab(tabs) {
        return tabs.find(tab => tab.active) || tabs.slice().sort(sortBy('lastAccessed')).pop();
    }

    function getGroupTitle({id, title, isArchive, tabs, newTabContainer}, args = '') {
        let withActiveGroup = args.includes('withActiveGroup'),
            withCountTabs = args.includes('withCountTabs'),
            withActiveTab = args.includes('withActiveTab'),
            withContainer = args.includes('withContainer'),
            withTabs = args.includes('withTabs');

        if (withActiveGroup) {
            if (cache.getWindowId(id)) {
                title = ACTIVE_SYMBOL + ' ' + title;
            } else if (isArchive) {
                title = DISCARDED_SYMBOL + ' ' + title;
            }
        }

        if (withContainer && newTabContainer) {
            title = '[' + containers.get(newTabContainer, 'name') + '] ' + title;
        }

        tabs = tabs.slice();

        if (withCountTabs) {
            title += ' (' + groupTabsCountMessage(tabs, isArchive) + ')';
        }

        if (withActiveTab && tabs.length && !isArchive) {
            let activeTab = getLastActiveTab(tabs);

            if (activeTab) {
                title += ' ' + (activeTab.discarded ? DISCARDED_SYMBOL : ACTIVE_SYMBOL) + ' ' + getTabTitle(activeTab);
            }
        }

        if (withTabs && tabs.length) {
            title += ':\n' + tabs
                .slice(0, 30)
                .map(tab => getTabTitle(tab, false, 70, true))
                .join('\n');

            if (tabs.length > 30) {
                title += '\n...';
            }
        }

        if (window.localStorage.enableDebug) {
            title = `#${id} ${title}`;
        }

        return title;
    }

    function getTabTitle({id, index, title, url, discarded}, withUrl = false, sliceLength = 0, withTabActive = false) {
        title = title || url || 'about:blank';

        if (withUrl && url && title !== url) {
            title += '\n' + url;
        }

        if (withTabActive && !discarded && id) {
            title = ACTIVE_SYMBOL + ' ' + title;
        }

        if (window.localStorage.enableDebug && id) {
            title = `#${id}:${index} ${title}`;
        }

        return sliceLength ? sliceText(title, sliceLength) : title;
    }

    function groupTabsCountMessage(tabs, groupIsArchived, withActiveTabs = false) {
        if (!groupIsArchived && (withActiveTabs || BG.getOptions('showExtendGroupsPopupWithActiveTabs'))) {
            let activeTabs = tabs.filter(tab => !tab.discarded && tab.id).length;
            return browser.i18n.getMessage('groupTabsCountActive', [activeTabs, tabs.length]);
        } else {
            return browser.i18n.getMessage('groupTabsCount', tabs.length);
        }
    }

    function getNextIndex(index, length, textPosition = 'next') {
        if (!length || 0 > length) {
            return false;
        }

        if (1 === length) {
            return 0;
        }

        if ('next' === textPosition) {
            return (index + 1) % length;
        } else if ('prev' === textPosition) {
            return 0 === index ? length - 1 : index - 1;
        } else {
            throw Error(`invalid textPosition: ${textPosition}`);
        }
    }

    function toCamelCase(str) {
        return str.replace(/^([A-Z])|[\s_-](\w)/g, function(match, p1, p2) {
            return p2 ? p2.toUpperCase() : p1.toLowerCase();
        });
    }

    function capitalize(str) {
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    function sortBy(key, numeric, reverse) {
        return function(objA, objB) {
            return reverse ? compareStrings(objB[key], objA[key], numeric) : compareStrings(objA[key], objB[key], numeric);
        };
    }

    function scrollTo(node) {
        if ('string' === type(node)) {
            node = document.querySelector(node);
        }

        node && node.scrollIntoView({
            block: 'center',
            behavior: 'smooth',
        });
    }

    // -1 : a < b
    // 0 : a === b
    // 1 : a > b
    function compareStrings(a, b, numeric = true) {
        return String(a).localeCompare(String(b), [], {
            numeric: numeric,
        });
    }

    // -1 : a < b
    // 0 : a === b
    // 1 : a > b
    function compareVersions(a, b) {
        return npmCompareVersions(String(a), String(b));
    }

    function isElementVisible(element) {
        let rect = element.getBoundingClientRect();

        // Only completely visible elements return true:
        return rect.top >= 0 && rect.bottom <= window.innerHeight;
        // Partially visible elements return true:
        // let isVisible = elemTop < window.innerHeight && elemBottom >= 0;
        // return isVisible;
    }

    function getRandomInt(min, max) {
        return Math.floor(Math.random() * (max - min + 1) + min);
    }

    function randomColor() {
        return 'hsla(' + getRandomInt(0, 360) + ', 100%, 50%, 1)';
    }

    function safeColor(color) {
        let div = document.createElement('div');
        div.style.backgroundColor = color;
        return div.style.backgroundColor;
    }

    function getGroupIconUrl(group = {iconViewType: DEFAULT_OPTIONS.defaultGroupIconViewType}, keyInObj = null) {
        let result = null;

        if (group.iconUrl) {
            result = group.iconUrl;
        } else {
            if (!group.iconColor) {
                group.iconColor = 'transparent';
            }

            let stroke = 'transparent' === group.iconColor ? 'stroke="#606060" stroke-width="1"' : '';

            let icons = {
                'main-squares': `
                <svg width="128" height="128" xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg">
                    <g fill="context-fill" fill-opacity="context-fill-opacity">
                        <rect height="32" width="32" />
                        <rect height="32" width="32" x="48" />
                        <rect height="32" width="32" x="96" y="48" />
                        <rect height="32" width="32" y="48" />
                        <rect height="32" width="32" x="48" y="48" />
                        <rect height="32" width="32" x="96" />
                        <rect height="32" width="32" y="96" />
                        <rect height="32" width="32" x="48" y="96" />
                        <rect height="32" width="32" x="96" y="96" />
                        <path transform="rotate(-90, 73, 71)" fill="${group.iconColor}" d="m16.000351,126.001527l0,-110.000003l108.999285,110.000003l-108.999285,0z"/>
                    </g>
                </svg>
            `,
                circle: `
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
                    <circle fill="${group.iconColor}" cx="8" cy="8" r="8" ${stroke} />
                </svg>
            `,
                squares: `
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
                    <g fill="context-fill" fill-opacity="context-fill-opacity">
                        <rect x="1" y="1" width="6" height="6" rx="1" ry="1"></rect>
                        <rect x="9" y="1" width="6" height="6" rx="1" ry="1"></rect>
                        <rect x="1" y="9" width="6" height="6" rx="1" ry="1"></rect>
                        <rect x="9" y="9" width="6" height="6" rx="1" ry="1" fill="${group.iconColor}"></rect>
                    </g>
                </svg>
            `,
                'old-tab-groups': `
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
                    <g fill="context-fill" fill-opacity="context-fill-opacity">
                        <rect width="9" height="6" x="1" y="1" rx="1"></rect>
                        <rect width="4" height="6" x="11" y="1" rx="1"></rect>
                        <rect width="5" height="7" x="1" y="8" rx="1"></rect>
                        <rect width="8" height="7" x="7" y="8" rx="1" fill="${group.iconColor}"></rect>
                    </g>
                </svg>
            `,
            };

            result = convertSvgToUrl(icons[group.iconViewType]);
        }

        if (keyInObj) {
            return {
                [keyInObj]: result,
            };
        }

        return result;
    }

    function convertSvgToUrl(svg) {
        return 'data:image/svg+xml;base64,' + b64EncodeUnicode(svg);
    }

    function resizeImage(img, height, width, useTransparency = true, ...canvasParams) { // img: new Image()
        let canvas = document.createElement('canvas'),
            context = canvas.getContext('2d');

        if (!useTransparency) {
            canvas.mozOpaque = true;
        }

        canvas.width = width;
        canvas.height = height;

        context.drawImage(img, 0, 0, width, height);

        return isCanvasBlank(canvas, useTransparency, ...canvasParams) ? null : canvas.toDataURL(...canvasParams);
    }

    function isCanvasBlank(canvas, useTransparency, ...canvasParams) {
        let blank = document.createElement('canvas'),
            canvasDataUrl = canvas.toDataURL(...canvasParams);

        if (!useTransparency) {
            blank.mozOpaque = true;
        }

        blank.width = canvas.width;
        blank.height = canvas.height;

        let isEmpty = canvasDataUrl === blank.toDataURL(...canvasParams);

        if (!isEmpty) {
            let blankContext = blank.getContext('2d');

            blankContext.fillStyle = 'rgb(255, 255, 255)';
            blankContext.fillRect(0, 0, blank.width, blank.height);

            isEmpty = canvasDataUrl === blank.toDataURL(...canvasParams);
        }

        return isEmpty;
    }

    // needle need to be "LowerCased"
    function mySearchFunc(needle, haystack, extendedSearch = false) {
        haystack = 'string' === typeof haystack ? haystack.toLowerCase() : '';

        if (!extendedSearch) {
            return haystack.includes(needle);
        }

        let lastFindIndex = -1;

        return needle
            .split('')
            .every(function(char) {
                if (' ' === char) {
                    return true;
                }

                lastFindIndex = haystack.indexOf(char, lastFindIndex + 1);
                return -1 !== lastFindIndex;
            });
    }

    function onlyUniqueFilter(value, index, self) {
        return self.indexOf(value) === index;
    }

    function extractKeys(obj, keys, useClone = false) {
        let newObj = {};

        keys.forEach(key => newObj[key] = (useClone ? clone(obj[key]) : obj[key]));

        return newObj;
    }

    function wait(ms = 200) {
        return new Promise(resolve => setTimeout(resolve, ms, ms));
    }

    async function waitDownload(id, maxWaitSec = 10) {
        let downloadObj = null;

        for (let i = 0; i < maxWaitSec * 5; i++) {
            [downloadObj] = await browser.downloads.search({id});

            if (downloadObj && browser.downloads.State.IN_PROGRESS !== downloadObj.state) {
                break;
            }

            await wait(200);
        }

        return downloadObj || {};
    }

    window.utils = {
        getInfo,

        keyId,
        unixNow,
        type,
        stringify,
        clone,
        format,
        formatBytes,
        extractKeys,
        onlyUniqueFilter,

        safeHtml,
        unSafeHtml,

        sliceText,

        notify,

        normalizeTabFavIcon,

        getSupportedExternalExtensionName,

        isAllowExternalRequestAndSender,
        isWindowAllow,
        isUrlEmpty,
        isUrlAllowToCreate,
        normalizeUrl,
        normalizeTabUrl,
        setUrlSearchParams,
        isTabPinned,
        isTabNotPinned,
        isTabCanBeHidden,
        isTabCanNotBeHidden,
        isTabLoaded,
        isTabLoading,

        createGroupTitle,
        getLastActiveTab,
        getGroupTitle,
        getTabTitle,
        groupTabsCountMessage,

        getNextIndex,
        toCamelCase,
        capitalize,
        sortBy,
        scrollTo,
        compareStrings,

        isElementVisible,
        getGroupIconUrl,

        safeColor,
        getRandomInt,
        randomColor,

        resizeImage,

        mySearchFunc,

        wait,
        waitDownload,
    };

})();
