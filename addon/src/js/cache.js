'use strict';

let tabs = {
        session: {},
        url: {},
        title: {},
        cookieStoreId: {},
    },
    windows = {
        session: {},
    },
    cache = {};

// TABS
function setTab({id, url, title, cookieStoreId, incognito}) {
    if (incognito) { // TMP
        throw Error('tab is incognito');
    }

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

        return browser.sessions.setTabValue(tabId, 'groupId', groupId);
    }

    return removeTabGroup(tabId);
}

function removeTabGroup(tabId) {
    if (tabs.session[tabId]) {
        delete tabs.session[tabId].groupId;
    }

    return browser.sessions.removeTabValue(tabId, 'groupId');
}

function setTabThumbnail(tabId, thumbnail) {
    if (thumbnail) {
        if (tabs.session[tabId]) {
            tabs.session[tabId].thumbnail = thumbnail;
        } else {
            tabs.session[tabId] = {thumbnail};
        }

        return browser.sessions.setTabValue(tabId, 'thumbnail', thumbnail);
    }

    return removeTabThumbnail(tabId);
}

function removeTabThumbnail(tabId) {
    if (tabs.session[tabId]) {
        delete tabs.session[tabId].thumbnail;
    }

    return browser.sessions.removeTabValue(tabId, 'thumbnail');
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
        let [groupId, thumbnail] = await Promise.all([browser.sessions.getTabValue(tab.id, 'groupId'), browser.sessions.getTabValue(tab.id, 'thumbnail')]);

        if (tabs.session[tab.id]) {
            groupId = tabs.session[tab.id].groupId || groupId;
            thumbnail = tabs.session[tab.id].thumbnail || thumbnail;
        } else {
            tabs.session[tab.id] = {groupId, thumbnail};
        }

        tab.session = {groupId, thumbnail};
    }

    return tab;
}

function getRemovedTabsForCreate(tabIds) {
    return tabIds
        .map(function(tabId) {
            if (!tabs.session[tabId] || !tabs.session[tabId].groupId || !tabs.url[tabId]) {
                removeTab(tabId);
                return false;
            }

            let tab = {
                groupId: tabs.session[tabId].groupId,
                title: tabs.title[tabId],
                url: tabs.url[tabId],
                cookieStoreId: tabs.cookieStoreId[tabId],
            };

            removeTab(tabId);

            return tab;
        })
        .filter(Boolean);
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

        return browser.sessions.setWindowValue(windowId, 'groupId', groupId);
    }

    return removeWindowGroup(windowId);
}

function removeWindowGroup(windowId) {
    if (windows.session[windowId]) {
        delete windows.session[windowId].groupId;
    }

    return browser.sessions.removeWindowValue(windowId, 'groupId');
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
        let groupId = await browser.sessions.getWindowValue(win.id, 'groupId');

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

    getTabSession,
    loadTabSession,

    getRemovedTabsForCreate,

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
