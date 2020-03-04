'use strict';

let tabs = {},
    tabSessionLoaded = {},
    removedTabs = [],
    windows = {};

function clear() {
    tabs = {};
    tabSessionLoaded = {};
    removedTabs = [];
    windows = {};
}

function applySession(toObj, fromObj) {
    fromObj.groupId && (toObj.groupId = fromObj.groupId);
    fromObj.favIconUrl && (toObj.favIconUrl = fromObj.favIconUrl);
    fromObj.thumbnail && (toObj.thumbnail = fromObj.thumbnail);

    return toObj;
}

// TABS
function setTab({id, url, title, cookieStoreId}) {
    if (!tabs[id]) {
        tabs[id] = {};
    }

    tabs[id].url = url;
    tabs[id].title = title;
    tabs[id].cookieStoreId = cookieStoreId;
}

function hasTab(tabId) {
    return !!tabs[tabId];
}

function removeTab(tabId) {
    removedTabs.push(tabId);
    delete tabSessionLoaded[tabId];
    delete tabs[tabId];
}

function setTabGroup(tabId, groupId) {
    if (groupId) {
        if (tabs[tabId]) {
            if (tabs[tabId].groupId === groupId) {
                return;
            }

            tabs[tabId].groupId = groupId;
        } else {
            tabs[tabId] = {groupId};
        }

        return browser.sessions.setTabValue(tabId, 'groupId', groupId);
    }

    return removeTabGroup(tabId);
}

function removeTabGroup(tabId) {
    if (tabs[tabId]) {
        delete tabs[tabId].groupId;
    }

    return browser.sessions.removeTabValue(tabId, 'groupId');
}

function setTabThumbnail(tabId, thumbnail) {
    if (thumbnail) {
        if (tabs[tabId]) {
            if (tabs[tabId].thumbnail === thumbnail) {
                return;
            }

            tabs[tabId].thumbnail = thumbnail;
        } else {
            tabs[tabId] = {thumbnail};
        }

        return browser.sessions.setTabValue(tabId, 'thumbnail', thumbnail);
    }

    return removeTabThumbnail(tabId);
}

function removeTabThumbnail(tabId) {
    if (tabs[tabId]) {
        delete tabs[tabId].thumbnail;
    }

    return browser.sessions.removeTabValue(tabId, 'thumbnail');
}

function setTabFavIcon(tabId, favIconUrl) {
    if (favIconUrl && favIconUrl.startsWith('data:')) {
        if (tabs[tabId]) {
            if (tabs[tabId].favIconUrl === favIconUrl) {
                return;
            }

            tabs[tabId].favIconUrl = favIconUrl;
        } else {
            tabs[tabId] = {favIconUrl};
        }

        return browser.sessions.setTabValue(tabId, 'favIconUrl', favIconUrl);
    }

    return removeTabFavIcon(tabId);
}

function removeTabFavIcon(tabId) {
    if (tabs[tabId]) {
        delete tabs[tabId].favIconUrl;
    }

    return browser.sessions.removeTabValue(tabId, 'favIconUrl');
}

function getTabSession(tabId, key = null) {
    if (key) {
        return tabs[tabId] ? tabs[tabId][key] : null;
    }

    return tabs[tabId] ? applySession({}, tabs[tabId]) : {};
}

async function loadTabSession(tab) {
    setTab(tab);

    if (!tabSessionLoaded[tab.id]) {
        let [groupId, favIconUrl, thumbnail] = await Promise.all([
            browser.sessions.getTabValue(tab.id, 'groupId'),
            browser.sessions.getTabValue(tab.id, 'favIconUrl'),
            browser.sessions.getTabValue(tab.id, 'thumbnail'),
        ]);

        tabSessionLoaded[tab.id] = true;

        applySession(tabs[tab.id], {groupId, favIconUrl, thumbnail});
    }

    applyTabSession(tab);

    return tab;
}

async function setTabSession(tab) {
    await Promise.all([
        setTabGroup(tab.id, tab.groupId),
        setTabFavIcon(tab.id, tab.favIconUrl),
        setTabThumbnail(tab.id, tab.thumbnail),
    ]);

    tabSessionLoaded[tab.id] = true;

    return applyTabSession(tab);
}

function applyTabSession(tab) {
    return applySession(tab, tabs[tab.id] || {});
}

function removeTabSession(tabId) {
    return Promise.all([removeTabGroup(tabId), removeTabThumbnail(tabId), removeTabFavIcon(tabId)]);
}

function getTabsSessionAndRemove(tabIds) {
    return tabIds
        .map(function(tabId) {
            if (!tabs[tabId] || !tabs[tabId].groupId || !tabs[tabId].url) {
                removeTab(tabId);
                return false;
            }

            let tab = {...tabs[tabId]};

            removeTab(tabId);

            return tab;
        })
        .filter(Boolean);
}

function filterRemovedTab({id}) {
    return !removedTabs.includes(id);
}

// WINDOWS
function hasWindow(windowId) {
    return !!windows[windowId];
}

function removeWindow(windowId) {
    delete windows[windowId];
}

function setWindowGroup(windowId, groupId) {
    if (groupId) {
        if (windows[windowId]) {
            if (windows[windowId].groupId === groupId) {
                return;
            }

            windows[windowId].groupId = groupId;
        } else {
            windows[windowId] = {groupId};
        }

        return browser.sessions.setWindowValue(windowId, 'groupId', groupId);
    }

    return removeWindowGroup(windowId);
}

function removeWindowGroup(windowId) {
    if (windows[windowId]) {
        delete windows[windowId].groupId;
    }

    return browser.sessions.removeWindowValue(windowId, 'groupId');
}

function getWindowId(groupId) {
    if (!groupId) {
        return false;
    }

    for (let windowId in windows) {
        if (windows[windowId].groupId === groupId) {
            return Number(windowId);
        }
    }
}

function getWindowGroup(windowId) {
    return windows[windowId] ? windows[windowId].groupId : null;
}

async function loadWindowSession(win) {
    if (!windows[win.id]) {
        windows[win.id] = {};

        let groupId = await browser.sessions.getWindowValue(win.id, 'groupId');

        groupId && (windows[win.id].groupId = groupId);
    }

    windows[win.id].groupId && (win.groupId = windows[win.id].groupId);

    return win;
}

function removeWindowSession(windowId) {
    removeWindow(windowId);
    return removeWindowGroup(windowId);
}

export default {
    clear,
    applySession,

    // tabs
    setTab,
    hasTab,
    removeTab,

    setTabGroup,
    removeTabGroup,

    setTabThumbnail,
    removeTabThumbnail,

    setTabFavIcon,
    removeTabFavIcon,

    getTabSession,
    loadTabSession,
    setTabSession,
    applyTabSession,
    removeTabSession,

    getTabsSessionAndRemove,
    filterRemovedTab,

    // windows
    hasWindow,
    removeWindow,

    setWindowGroup,
    removeWindowGroup,

    getWindowId,
    getWindowGroup,

    loadWindowSession,
    removeWindowSession,
};
