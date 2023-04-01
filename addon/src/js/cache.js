
import * as Constants from './constants.js';
import * as Utils from './utils.js';
import backgroundSelf from './background.js';
import cacheStorage, {createStorage} from './cache-storage.js';

cacheStorage.cacheTabs ??= createStorage({
    tabs: {},
    lastTabsState: {},
    windows: {},
});

const tabs = cacheStorage.cacheTabs.tabs;
const lastTabsState = cacheStorage.cacheTabs.lastTabsState; // bug https://bugzilla.mozilla.org/show_bug.cgi?id=1818392
const windows = cacheStorage.cacheTabs.windows;

export function setLastTabState({id, url, title, status, hidden, pinned, favIconUrl}) {
    lastTabsState[id] = {id, url, title, status, hidden, pinned, favIconUrl};
}

// don't forget for pinned tabs events
export function getRealTabStateChanged(tab) {
    let changeInfo = null;

    if (lastTabsState[tab.id]) {
        Constants.ON_UPDATED_TAB_PROPERTIES.forEach(key => {
            if (tab[key] !== lastTabsState[tab.id][key]) {
                changeInfo ??= {};
                changeInfo[key] = tab[key];
            }
        });
    }

    return changeInfo;
}

export function clear() {
    for(let key in tabs) delete tabs[key];
    for(let key in lastTabsState) delete lastTabsState[key];
    for(let key in windows) delete windows[key];
}

// TABS
export function setTab({id, url, title, favIconUrl, cookieStoreId, openerTabId, status}) {
    tabs[id] ??= {id, cookieStoreId};

    setLastTabState(arguments[0]);

    tabs[id].openerTabId = openerTabId;

    if (status === browser.tabs.TabStatus.LOADING && tabs[id].url && Utils.isUrlEmpty(url)) {
        return;
    }

    tabs[id].url = url;
    tabs[id].title = title || url;
    tabs[id].favIconUrl = Utils.isAvailableFavIconUrl(favIconUrl) ? favIconUrl : null;
}

export function hasTab(tabId) {
    return !!tabs[tabId];
}

export function removeTab(tabId) {
    delete tabs[tabId];
    delete lastTabsState[tabId];
}

// groupId
async function loadTabGroup(tabId) {
    if (tabs[tabId]) {
        if (tabs[tabId].groupId) {
            return tabs[tabId].groupId;
        }

        return tabs[tabId].groupId = await browser.sessions.getTabValue(tabId, 'groupId');
    }
}

export async function setTabGroup(tabId, groupId) {
    if (groupId) {
        if (tabs[tabId]) {
            tabs[tabId].groupId = groupId;
        } else {
            tabs[tabId] = {groupId};
        }

        return browser.sessions.setTabValue(tabId, 'groupId', groupId);
    }
}

export function getTabGroup(tabId) {
    return tabs[tabId]?.groupId;
}

export async function removeTabGroup(tabId) {
    delete tabs[tabId]?.groupId;
    return browser.sessions.removeTabValue(tabId, 'groupId').catch(() => {});
}

// favIconUrl
async function loadTabFavIcon(tabId) {
    if (tabs[tabId]) {
        if (tabs[tabId].favIconUrl) {
            return tabs[tabId].favIconUrl;
        }

        return tabs[tabId].favIconUrl = await browser.sessions.getTabValue(tabId, 'favIconUrl');
    }
}

export async function setTabFavIcon(tabId, favIconUrl) {
    if (favIconUrl?.startsWith('data:')) {
        if (tabs[tabId]) {
            tabs[tabId].favIconUrl = favIconUrl;
        } else {
            tabs[tabId] = {favIconUrl};
        }

        return browser.sessions.setTabValue(tabId, 'favIconUrl', favIconUrl);
    }
}

export function getTabFavIcon(tabId) {
    return tabs[tabId]?.favIconUrl;
}

export async function removeTabFavIcon(tabId) {
    delete tabs[tabId]?.favIconUrl;
    return browser.sessions.removeTabValue(tabId, 'favIconUrl').catch(() => {});
}

// thumbnail
async function loadTabThumbnail(tabId) {
    if (backgroundSelf.options.showTabsWithThumbnailsInManageGroups && tabs[tabId]) {
        if (tabs[tabId].thumbnail) {
            return tabs[tabId].thumbnail;
        }

        return tabs[tabId].thumbnail = await browser.sessions.getTabValue(tabId, 'thumbnail');
    }
}

export async function setTabThumbnail(tabId, thumbnail) {
    if (backgroundSelf.options.showTabsWithThumbnailsInManageGroups && thumbnail) {
        if (tabs[tabId]) {
            tabs[tabId].thumbnail = thumbnail;
        } else {
            tabs[tabId] = {thumbnail};
        }

        return browser.sessions.setTabValue(tabId, 'thumbnail', thumbnail);
    }
}

export function getTabThumbnail(tabId) {
    return tabs[tabId]?.thumbnail;
}

export async function removeTabThumbnail(tabId) {
    delete tabs[tabId]?.thumbnail;
    return browser.sessions.removeTabValue(tabId, 'thumbnail').catch(() => {});
}

// tab
export function getTabSession(tabId, key = null) {
    if (key) {
        return tabs[tabId] ? tabs[tabId][key] : null;
    }

    return tabs[tabId] ? {...tabs[tabId]} : {};
}

export async function loadTabSession(tab, includeFavIconUrl = true, includeThumbnail = true) {
    setTab(tab);

    await Promise.all([
        loadTabGroup(tab.id),
        includeFavIconUrl ? loadTabFavIcon(tab.id) : null,
        includeThumbnail ? loadTabThumbnail(tab.id) : null,
    ]);

    return applyTabSession(tab);
}

export async function setTabSession(tab) {
    await Promise.all([
        setTabGroup(tab.id, tab.groupId),
        setTabFavIcon(tab.id, tab.favIconUrl),
        setTabThumbnail(tab.id, tab.thumbnail),
    ]);

    return tab;
}

export function applySession(toObj, fromObj) {
    fromObj.groupId && (toObj.groupId = fromObj.groupId);
    fromObj.favIconUrl && (toObj.favIconUrl = fromObj.favIconUrl);
    fromObj.thumbnail && (toObj.thumbnail = fromObj.thumbnail);

    return toObj;
}

export function applyTabSession(tab) {
    return applySession(tab, tabs[tab.id] || {});
}

export function removeTabSession(tabId) {
    return Promise.all([
        removeTabGroup(tabId),
        removeTabFavIcon(tabId),
        removeTabThumbnail(tabId),
    ]);
}

export function getTabsSessionAndRemove(tabIds) {
    return tabIds
        .map(tabId => {
            if (!tabs[tabId]?.groupId || !tabs[tabId]?.url) {
                removeTab(tabId);
                return false;
            }

            let tab = {...tabs[tabId]};

            removeTab(tabId);

            return tab;
        })
        .filter(Boolean);
}

// WINDOWS
export function setWindowGroup(windowId, groupId) {
    windows[windowId] ??= {};
    windows[windowId].groupId = groupId;

    return browser.sessions.setWindowValue(windowId, 'groupId', groupId);
}

export function getWindowId(groupId) {
    for (let windowId in windows) {
        if (groupId && windows[windowId].groupId === groupId) {
            return Number(windowId);
        }
    }
}

export function getWindowGroup(windowId) {
    return windows[windowId]?.groupId;
}

export function removeWindow(windowId) {
    delete windows[windowId];
}

export function removeWindowGroup(windowId) {
    delete windows[windowId].groupId;
    return browser.sessions.removeWindowValue(windowId, 'groupId').catch(() => {});
}

export async function loadWindowSession(win) {
    windows[win.id] ??= {};
    win.groupId = windows[win.id].groupId = await browser.sessions.getWindowValue(win.id, 'groupId');

    return win;
}

export async function removeWindowSession(windowId) {
    await removeWindowGroup(windowId);
    removeWindow(windowId);
}
