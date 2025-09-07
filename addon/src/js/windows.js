import Logger from './logger.js';
import backgroundSelf from './background.js';
import * as Tabs from './tabs.js';
import * as Utils from './utils.js';
import * as Cache from './cache.js';

const logger = new Logger('Windows');

export async function load(withTabs = false, includeFavIconUrl, includeThumbnail) {
    const log = logger.start('load', {withTabs, includeFavIconUrl, includeThumbnail});

    let [tabs, windows] = await Promise.all([
        withTabs ? Tabs.get(null, false, null, undefined, includeFavIconUrl, includeThumbnail) : false,
        browser.windows.getAll({
            windowTypes: [browser.windows.WindowType.NORMAL],
        })
    ]);

    windows = await Promise.all(windows.filter(Utils.isWindowAllow).map(Cache.loadWindowSession));
    windows = windows.filter(Boolean);

    if (withTabs) {
        windows = windows.map(win => (win.tabs = tabs.filter(tab => tab.windowId === win.id), win));
    }

    log.stop();
    return windows.sort(Utils.sortBy('id'));
}

export async function get(windowId = browser.windows.WINDOW_ID_CURRENT) {
    const log = logger.start('get', {windowId});

    const win = await browser.windows.get(windowId).then(Cache.loadWindowSession);

    log.assert(win, 'windowId', windowId, 'not found');
    log.stop(win);
    return win;
}

export async function create(groupId, activeTabId) {
    const log = logger.start('create', {groupId, activeTabId});

    if (!groupId) {
        log.throwError('No group id');
    }

    let groupWindowId = Cache.getWindowId(groupId);

    if (groupWindowId) {
        await backgroundSelf.applyGroup(groupWindowId, groupId, activeTabId);
        log.stop('load exist window', groupWindowId);
    } else {
        backgroundSelf.skipAddGroupToNextNewWindow = true;

        let win = await browser.windows.create();

        await backgroundSelf.applyGroup(win.id, groupId, activeTabId);
        log.stop('load new window', win.id);
    }
}

export function setFocus(windowId) {
    return browser.windows.update(windowId, {
        focused: true,
    }).catch(logger.onCatch(['setFocus', windowId]));
}

export async function getLastFocusedNormalWindow(returnId = true) {
    const log = logger.start('getLastFocusedNormalWindow', {returnId});
    let lastFocusedWindow = await browser.windows.getLastFocused().catch(log.onCatch('windows.getLastFocused', false));

    if (Utils.isWindowAllow(lastFocusedWindow)) {
        if (returnId) {
            log.stop('windowId', lastFocusedWindow.id);
            return lastFocusedWindow.id;
        } else {
            lastFocusedWindow = await Cache.loadWindowSession(lastFocusedWindow);

            if (lastFocusedWindow) {
                log.stop('window', lastFocusedWindow);
                return lastFocusedWindow;
            }
        }
    }

    log.warn('hard way (((');

    const windows = await load(),
        win = windows.find(win => win.focused) || windows.pop();

    log.assert(win, 'normal window not found!');
    log.stop('windowId', win?.id);
    return returnId ? win?.id : win;
}

export async function createPopup(url, createData = {}) {
    const log = logger.start('createPopup', url, {createData});

    createData = {
        url,
        focused: true,
        type: browser.windows.CreateType.POPUP,
        state: browser.windows.WindowState.NORMAL,
        ...createData,
    };

    for (const key in createData) {
        if (createData[key] === null) {
            delete createData[key];
        }
    }

    const win = await browser.windows.create(createData).catch(log.onCatch(createData));

    log.stop('created window', win);

    return win;
}
