'use strict';

let tabs = {
        session: {},
        url: {},
        title: {},
        cookieStoreId: {},
        removed: [],
    },
    windows = {
        session: {},
    },
    cache = {};

// TABS
function setTab({id, url, title, cookieStoreId}) {
    if (url) {
        tabs.url[id] = url;
    }

    if (title) {
        tabs.title[id] = title;
    }

    if (cookieStoreId) {
        tabs.cookieStoreId[id] = cookieStoreId;
    }
}

function hasTab(tabId) {
    return !!tabs.url[tabId];
}

function removeTab(tabId) {
    tabs.removed.push(tabId);
    delete tabs.session[tabId];
    delete tabs.url[tabId];
    delete tabs.title[tabId];
    delete tabs.cookieStoreId[tabId];
}

function setTabGroup(tabId, groupId) {
    if (groupId) {
        if (tabs.session[tabId]) {
            tabs.session[tabId].groupId = groupId;
        } else {
            tabs.session[tabId] = {groupId};
        }

        const {BG} = browser.extension.getBackgroundPage();
        return BG.browser.sessions.setTabValue(tabId, 'groupId', groupId);
    }

    return removeTabGroup(tabId);
}

function removeTabGroup(tabId) {
    if (tabs.session[tabId]) {
        delete tabs.session[tabId].groupId;
    }

    const {BG} = browser.extension.getBackgroundPage();
    return BG.browser.sessions.removeTabValue(tabId, 'groupId');
}

function setTabThumbnail(tabId, thumbnail) {
    if (thumbnail) {
        if (tabs.session[tabId]) {
            tabs.session[tabId].thumbnail = thumbnail;
        } else {
            tabs.session[tabId] = {thumbnail};
        }

        const {BG} = browser.extension.getBackgroundPage();
        return BG.browser.sessions.setTabValue(tabId, 'thumbnail', thumbnail);
    }

    return removeTabThumbnail(tabId);
}

function removeTabThumbnail(tabId) {
    if (tabs.session[tabId]) {
        delete tabs.session[tabId].thumbnail;
    }

    const {BG} = browser.extension.getBackgroundPage();
    return BG.browser.sessions.removeTabValue(tabId, 'thumbnail');
}

function setTabFavIcon(tabId, favIconUrl) {
    if (favIconUrl && favIconUrl.startsWith('data')) {
        if (tabs.session[tabId]) {
            tabs.session[tabId].favIconUrl = favIconUrl;
        } else {
            tabs.session[tabId] = {favIconUrl};
        }

        const {BG} = browser.extension.getBackgroundPage();
        return BG.browser.sessions.setTabValue(tabId, 'favIconUrl', favIconUrl);
    }

    return removeTabFavIcon(tabId);
}

function removeTabFavIcon(tabId) {
    if (tabs.session[tabId]) {
        delete tabs.session[tabId].favIconUrl;
    }

    const {BG} = browser.extension.getBackgroundPage();
    return BG.browser.sessions.removeTabValue(tabId, 'favIconUrl');
}

function getTabSession(tabId, key = null) {
    let tabSession = tabs.session[tabId] || {};

    return key ? tabSession[key] : {...tabSession};
}

async function loadTabSession(tab) {
    setTab(tab);

    if (tabs.session[tab.id]) {
        tab.session = {...tabs.session[tab.id]};
    } else {
        const {BG} = browser.extension.getBackgroundPage();

        let [groupId, thumbnail, favIconUrl] = await Promise.all([
            BG.browser.sessions.getTabValue(tab.id, 'groupId'),
            BG.browser.sessions.getTabValue(tab.id, 'thumbnail'),
            BG.browser.sessions.getTabValue(tab.id, 'favIconUrl')
        ]);

        if (tabs.session[tab.id]) {
            groupId = tabs.session[tab.id].groupId = tabs.session[tab.id].groupId || groupId;
            thumbnail = tabs.session[tab.id].thumbnail = tabs.session[tab.id].thumbnail || thumbnail;
            favIconUrl = tabs.session[tab.id].favIconUrl = tabs.session[tab.id].favIconUrl || favIconUrl;
        } else {
            tabs.session[tab.id] = {groupId, thumbnail, favIconUrl};
        }

        tab.session = {groupId, thumbnail, favIconUrl};
    }

    if (tab.session.favIconUrl) {
        tab.favIconUrl = tab.session.favIconUrl;
    } else if (!tab.favIconUrl || tab.favIconUrl.startsWith('chrome://mozapps/skin/')) {
        tab.favIconUrl = '/icons/tab.svg';
    }

    return tab;
}

function getTabCookieStoreId(tabId) {
    return tabs.cookieStoreId[tabId];
}

function getRemovedTabsForCreate(tabIds) {
    return tabIds
        .map(function(tabId) {
            if (!tabs.session[tabId] || !tabs.session[tabId].groupId || !tabs.url[tabId]) {
                removeTab(tabId);
                return false;
            }

            let tab = {
                url: tabs.url[tabId],
                title: tabs.title[tabId],
                cookieStoreId: tabs.cookieStoreId[tabId],
                ...tabs.session[tabId],
            };

            removeTab(tabId);

            return tab;
        })
        .filter(Boolean);
}

function filterRemovedTab({id}) {
    return !tabs.removed.includes(id);
}

// WINDOWS
function hasWindow(windowId) {
    return !!windows.session[windowId];
}

function removeWindow(windowId) {
    delete windows.session[windowId];
}

function getWindowsCount() {
    return Object.keys(windows.session).length;
}

function setWindowGroup(windowId, groupId) {
    if (groupId) {
        if (windows.session[windowId]) {
            windows.session[windowId].groupId = groupId;
        } else {
            windows.session[windowId] = {groupId};
        }

        const {BG} = browser.extension.getBackgroundPage();
        return BG.browser.sessions.setWindowValue(windowId, 'groupId', groupId);
    }

    return removeWindowGroup(windowId);
}

function removeWindowGroup(windowId) {
    if (windows.session[windowId]) {
        delete windows.session[windowId].groupId;
    }

    const {BG} = browser.extension.getBackgroundPage();
    return BG.browser.sessions.removeWindowValue(windowId, 'groupId');
}

function getWindowId(groupId) {
    if (!groupId) {
        return false;
    }

    for (let windowId in windows.session) {
        if (windows.session[windowId].groupId === groupId) {
            return Number(windowId);
        }
    }
}

function getWindowGroup(windowId) {
    return (windows.session[windowId] || {}).groupId;
}

async function loadWindowSession(win) {
    if (windows.session[win.id]) {
        win.session = {...windows.session[win.id]};
    } else {
        const {BG} = browser.extension.getBackgroundPage();

        let groupId = await BG.browser.sessions.getWindowValue(win.id, 'groupId');

        if (windows.session[win.id]) {
            groupId = windows.session[win.id].groupId;
        } else {
            windows.session[win.id] = {groupId};
        }

        win.session = {groupId};
    }

    return win;
}

export default {
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

    getTabCookieStoreId,
    getRemovedTabsForCreate,
    filterRemovedTab,

    // windows
    hasWindow,
    removeWindow,

    getWindowsCount,

    setWindowGroup,
    removeWindowGroup,

    getWindowId,
    getWindowGroup,

    loadWindowSession,
};
