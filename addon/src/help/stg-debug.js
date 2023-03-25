import './translate-help-pages.js';

window.logger = new Logger('stg-debug');

const $ = document.querySelector.bind(document),
    wasAutoDebug = window.localStorage.enableDebug == 2,
    debugStatus = $('#debugStatus'),
    enableDebugButton = $('#enableDebug'),
    disableDebugButton = $('#disableDebug');

enableDebugButton.classList.toggle('hidden', !!window.localStorage.enableDebug);
disableDebugButton.classList.toggle('hidden', !window.localStorage.enableDebug);

if (wasAutoDebug) {
    debugStatus.classList.add('auto-enabled');
    $('#mainTitle').innerText = browser.i18n.getMessage('helpPageStgDebugAutoDebugMainTitle');
} else if (window.localStorage.enableDebug) {
    debugStatus.classList.add('enabled');
}

function onClosePage() {
    if (wasAutoDebug) {
        delete window.localStorage.enableDebug;
        Messages.sendMessage('safe-reload-addon');
    }
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

const normalizeAndClear = function(obj) {
    if (Array.isArray(obj)) {
        return obj.map(normalizeAndClear);
    } else if ('object' === utils.type(obj)) {
        for (let key in obj) {
            if (['title', 'icon', 'icons', 'iconUrl', 'favIconUrl', 'thumbnail', 'filename', 'catchTabRules'].includes(key)) {
                obj[key] = obj[key] ? ('some ' + key) : obj[key];
            } else {
                obj[key] = normalizeAndClear(obj[key]);
            }
        }

        return obj;
    } else if (String(obj).startsWith('data:image')) {
        return 'some data:image';
    } else if (String(obj).startsWith('http')) {
        return this.urls[obj] || (this.urls[obj] = 'URL_' + this.urlIndex++);
    } else if (String(obj).startsWith('file:')) {
        return this.urls[obj] || (this.urls[obj] = 'FILE_' + this.urlIndex++);
    } else if (typeof obj === 'string' && obj.includes(this.addonUrlPrefix)) {
        return obj.replaceAll(this.addonUrlPrefix, '');
    }

    return obj;
}.bind({
    urls: {},
    urlIndex: 1,
    addonUrlPrefix: browser.runtime.getURL(''),
});

async function saveConsoleLogs() {
    let [
            info,
            {logs, errorLogs},
            {groupsList: groups},
            windows
        ] = await Promise.all([
            utils.getInfo(),
            Messages.sendMessage('get-logger-logs'),
            Messages.sendMessage('get-groups-list'),
            browser.windows.getAll({
                windowTypes: [browser.windows.WindowType.NORMAL],
                populate: true,
            }),
        ]);

    const tabKeys = ['id', 'url', 'hidden', 'discarded', 'pinned', 'status', 'cookieStoreId', 'groupId'];

    await Promise.all(windows.map(async win => {
        await cache.loadWindowSession(win);

        await Promise.all(win.tabs.map(tab => cache.loadTabSession(tab, true, false)));
    }));

    windows.forEach(win => win.tabs = win.tabs.map(tab => utils.assignKeys({}, tab, tabKeys)));

    let savedId = await file.save({
        info,
        windows: normalizeAndClear(windows),
        groups: normalizeAndClear(groups),
        logs: normalizeAndClear(logs),
        errorLogs: normalizeAndClear(errorLogs),
    }, 'STG-debug-logs.json');

    if (savedId) {
        Messages.sendMessage('clear-logger-logs');
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
