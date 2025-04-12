import './translate-help-pages.js';
import '/js/prefixed-storage.js';

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
    enableDebugButton.classList.toggle('hidden', !!backgroundSelf.storage.enableDebug);
    disableDebugButton.classList.toggle('hidden', !backgroundSelf.storage.enableDebug);

    if (wasAutoDebug || isAutoDebug()) {
        debugStatus.classList = 'auto-enabled';
        $('#mainTitle').innerText = browser.i18n.getMessage('helpPageStgDebugAutoDebugMainTitle');
    } else if (backgroundSelf.storage.enableDebug) {
        debugStatus.classList = 'enabled';
    }
}

function isAutoDebug() {
    return backgroundSelf.storage.enableDebug == 2;
}

function enableDebug() {
    backgroundSelf.storage.enableDebug = 1;
    debugStatus.classList = 'enabled';
    enableDebugButton.classList.add('hidden');
    disableDebugButton.classList.remove('hidden');
}

async function disableDebug() {
    delete backgroundSelf.storage.enableDebug;
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
            platformInfo,
            extensions,
            storage,
            permissionBookmarks,
            windows,
            tabs,
        ] = await Promise.all([
            browser.runtime.getPlatformInfo().catch(onCatch('getPlatformInfo', Object)),
            browser.management.getAll().catch(onCatch('management', Array)),
            browser.storage.local.get().catch(onCatch('storage', Object)),
            browser.permissions.contains(Constants.PERMISSIONS.BOOKMARKS).catch(onCatch('permissions BOOKMARKS', Object)),
            browser.windows.getAll({
                windowTypes: [browser.windows.WindowType.NORMAL],
            }).catch(onCatch('windows', Array)),
            browser.tabs.query({}).catch(onCatch('tabs', Array)),
        ]);

    const {
        getLogs,
        clearLogs,
        getErrors,
        clearErrors,
    } = backgroundSelf.loggerFuncs;

    const logs = getLogs();
    const errorLogs = getErrors();

    let loadedWindows = await Promise.all(windows.map(Cache.loadWindowSession));
    loadedWindows = loadedWindows.filter(Boolean);

    let loadedTabs = await Promise.all(tabs.map(Cache.loadTabSession));
    loadedTabs = loadedTabs.filter(Boolean);

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
            upTime: backgroundSelf.storage.START_TIME
                ? Math.ceil((Date.now() - backgroundSelf.storage.START_TIME) / 1000) + ' sec'
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
                ...Constants.BROWSER,
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
        clearLogs();
        clearErrors();
    }
}

function onClosePage() {
    if (wasAutoDebug || isAutoDebug()) {
        delete backgroundSelf.storage.enableDebug;
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
