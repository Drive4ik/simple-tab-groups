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
    };

function clear() {
    tabs.session = {};
    tabs.url = {};
    tabs.title = {};
    tabs.cookieStoreId = {};
    tabs.removed = [];

    windows.session = {};
}

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
            if (tabs.session[tabId].groupId === groupId) {
                return;
            }

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
            if (tabs.session[tabId].thumbnail === thumbnail) {
                return;
            }

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
            if (tabs.session[tabId].favIconUrl === favIconUrl) {
                return;
            }

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

async function setTabSession(tab) {
    let {groupId, favIconUrl, thumbnail} = tab,
        promises = [];

    if (groupId) {
        if (tab.pinned) {
            console.error('[STG] Error: tab is pinned and can\'t set group id');
        } else {
            promises.push(setTabGroup(tab.id, groupId));
        }
    }

    if (favIconUrl) {
        promises.push(setTabFavIcon(tab.id, favIconUrl));
    }

    if (thumbnail) {
        promises.push(setTabThumbnail(tab.id, thumbnail));
    }

    await Promise.all(promises);

    delete tab.groupId;
    delete tab.thumbnail;

    return loadTabSession(tab);
}

function removeTabSession(tabId) {
    return Promise.all([removeTabGroup(tabId), removeTabThumbnail(tabId), removeTabFavIcon(tabId)]);
}

function getTabCookieStoreId(tabId) {
    return tabs.cookieStoreId[tabId];
}

function getTabsSessionAndRemove(tabIds) {
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
            if (windows.session[windowId].groupId === groupId) {
                return;
            }

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

function removeWindowSession(windowId) {
    return removeWindowGroup(windowId);
}

export default {
    clear,

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
    removeTabSession,

    getTabCookieStoreId,
    getTabsSessionAndRemove,
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
    removeWindowSession,
};
