import './translate-help-pages.js';

import Messages from '/js/messages.js';
import backgroundSelf from '/js/background.js';
import * as Constants from '/js/constants.js';
import * as BrowserConstants from '/js/browser-constants.js';
import * as File from '/js/file.js';
import * as Cache from '/js/cache.js';

const $ = document.querySelector.bind(document),
    wasAutoDebug = isAutoDebug(),
    debugStatus = $('#debugStatus'),
    enableDebugButton = $('#enableDebug'),
    disableDebugButton = $('#disableDebug');

$('#debugStatusIcon').src = BrowserConstants.getContainerIconUrl('circle');

reloadState();

Messages.connectToBackground('stg-debug', 'show-error-notification', () => {
    reloadState();
    browser.windows.update(browser.windows.WINDOW_ID_CURRENT, {focused: true});
});

function reloadState() {
    enableDebugButton.classList.toggle('hidden', !!window.localStorage.enableDebug);
    disableDebugButton.classList.toggle('hidden', !window.localStorage.enableDebug);

    if (wasAutoDebug || isAutoDebug()) {
        debugStatus.classList = 'auto-enabled';
        $('#mainTitle').innerText = browser.i18n.getMessage('helpPageStgDebugAutoDebugMainTitle');
    } else if (window.localStorage.enableDebug) {
        debugStatus.classList = 'enabled';
    }
}

function isAutoDebug() {
    return window.localStorage.enableDebug == 2;
}

function enableDebug() {
    window.localStorage.enableDebug = 1;
    debugStatus.classList = 'enabled';
    enableDebugButton.classList.add('hidden');
    disableDebugButton.classList.remove('hidden');
}

async function disableDebug() {
    delete window.localStorage.enableDebug;
    debugStatus.classList = '';
    enableDebugButton.classList.remove('hidden');
    disableDebugButton.classList.add('hidden');
    await saveConsoleLogs();
}

const normalizeAndClear = function(obj, objKey) {
    if (Array.isArray(obj)) {
        return obj.map(normalizeAndClear);
    } else if (typeof obj === 'object') {
        for (let key in obj) {
            if (['title', 'icon', 'icons', 'iconUrl', 'favIconUrl', 'thumbnail', 'filename', 'catchTabRules'].includes(key)) {
                obj[key] = obj[key] ? ('some ' + key) : obj[key];
            } else {
                obj[key] = normalizeAndClear(obj[key], key);
            }
        }

        return obj;
    } else if (String(obj).startsWith('data:image')) {
        return 'some data:image';
    } else if (String(obj).startsWith('http')) {
        return this.urls[obj] || (this.urls[obj] = 'URL_' + this.urlIndex++);
    } else if (String(obj).startsWith('file:')) {
        return this.urls[obj] || (this.urls[obj] = 'FILE_' + this.urlIndex++);
    } else if (typeof obj === 'string' && obj.includes(Constants.STG_BASE_URL) && objKey !== 'UUID') {
        return obj.replaceAll(Constants.STG_BASE_URL, '');
    }

    return obj;
}.bind({
    urls: {},
    urlIndex: 1,
});

let CRITICAL_ERRORS = [];
function onCatch(message, resultObjType, ...args) {
    return nativeError => {
        const ERROR = {
            error: {
                message: `can't load ${message}: ` + nativeError?.message,
                errorFileName: nativeError?.fileName,
                lineNumber: nativeError?.lineNumber,
                columnNumber: nativeError?.columnNumber,
                stack: nativeError?.stack?.split?.('\n'),
            },
            args,
        };

        CRITICAL_ERRORS.push(ERROR);

        if (resultObjType === Array) {
            return [ERROR];
        }

        return ERROR;
    }
}

async function saveConsoleLogs() {
    const [
            browserInfo,
            platformInfo,
            extensions,
            storage,
            permissionBookmarks,
            windows,
            tabs,
        ] = await Promise.all([
            browser.runtime.getBrowserInfo().catch(onCatch('getBrowserInfo', Object)),
            browser.runtime.getPlatformInfo().catch(onCatch('getPlatformInfo', Object)),
            browser.management.getAll().catch(onCatch('management', Array)),
            browser.storage.local.get().catch(onCatch('storage', Object)),
            browser.permissions.contains(Constants.PERMISSIONS.BOOKMARKS).catch(onCatch('permissions BOOKMARKS', Object)),
            browser.windows.getAll({
                windowTypes: [browser.windows.WindowType.NORMAL],
            }).catch(onCatch('windows', Array)),
            browser.tabs.query({}).catch(onCatch('tabs', Array)),
        ]);

    const Logger = backgroundSelf.logger.constructor;

    const logs = Logger.logs.slice(-500);
    const errorLogs = Logger.getErrors();

    const loadedWindows = await Promise.all(
        windows.map(win => win?.id && Cache.loadWindowSession(win).catch(onCatch('window', Object, win)))
    );

    const loadedTabs = await Promise.all(
        tabs.map(tab => tab?.id && Cache.loadTabSession(tab, false, false).catch(onCatch('tab', Object, tab)))
    );

    const filteredExtensions = (function() {
        try {
            return extensions
                .filter(({id, enabled, type}) => !id.endsWith('@search.mozilla.org') && enabled && type === browser.management.ExtensionType.EXTENSION)
                .map(({id, name, version, hostPermissions}) => ({id, name, version, hostPermissions}))
        } catch (e) {
            return onCatch('filter extensions', Array, extensions)(e);
        }
    })();

    const LOGS_OBJ = normalizeAndClear({
        CRITICAL_ERRORS,
        addon: {
            version: Constants.MANIFEST.version,
            upTime: self.localStorage.START_TIME
                ? Math.ceil((Date.now() - self.localStorage.START_TIME) / 1000) + ' sec'
                : 'unknown',
            UUID: Constants.STG_BASE_URL,
            permissions: {
                bookmarks: permissionBookmarks,
            },
            storage,
        },
        browserInfo: {
            browserAndOS: {
                ...platformInfo,
                ...browserInfo,
            },
            extensions: filteredExtensions,
        },
        windows: loadedWindows,
        tabs: loadedTabs,
        logs,
        errorLogs,
    });

    let savedId = await File.save(LOGS_OBJ, 'STG-debug-logs.json');

    if (savedId) {
        Logger.clearLogs();
    }
}

function onClosePage() {
    if (wasAutoDebug || isAutoDebug()) {
        delete window.localStorage.enableDebug;
        Messages.sendMessage('safe-reload-addon');
    }
}

async function closePage() {
    onClosePage();
    let tab = await browser.tabs.getCurrent();
    await browser.tabs.remove(tab.id);
}

enableDebugButton.addEventListener('click', enableDebug);
disableDebugButton.addEventListener('click', disableDebug);
$('#closePage').addEventListener('click', closePage);

window.addEventListener('unload', onClosePage);
