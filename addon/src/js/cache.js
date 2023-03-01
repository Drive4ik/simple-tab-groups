(function() {
    'use strict';

    let tabs = {},
        lastTabsState = {}, // bug https://bugzilla.mozilla.org/show_bug.cgi?id=1818392
        removedTabs = new Set,
        windows = {};

    function setLastTabState({id, url, title, status, hidden, pinned, favIconUrl}) {
        lastTabsState[id] = {id, url, title, status, hidden, pinned, favIconUrl};
    }

    // don't forget for pinned tabs events
    function getRealTabStateChanged(tab) {
        let changeInfo = null;

        if (lastTabsState[tab.id]) {
            ON_UPDATED_TAB_PROPERTIES.forEach(key => {
                if (tab[key] !== lastTabsState[tab.id][key]) {
                    changeInfo ??= {};
                    changeInfo[key] = tab[key];
                }
            });
        }

        return changeInfo;
    }

    function clear() {
        tabs = {};
        lastTabsState = {};
        removedTabs.clear();
        windows = {};
    }

    function applySession(toObj, fromObj) {
        fromObj.groupId && (toObj.groupId = fromObj.groupId);
        fromObj.favIconUrl && (toObj.favIconUrl = fromObj.favIconUrl);
        fromObj.thumbnail && (toObj.thumbnail = fromObj.thumbnail);

        return toObj;
    }

    // TABS
    function setTab({id, url, title, cookieStoreId, openerTabId, status}) {
        if (!tabs[id]) {
            tabs[id] = {id, cookieStoreId};
        }

        setLastTabState(arguments[0]);

        tabs[id].openerTabId = openerTabId;

        if (status === browser.tabs.TabStatus.LOADING && tabs[id].url && utils.isUrlEmpty(url)) {
            return;
        }

        tabs[id].url = url;
        tabs[id].title = title || url;
    }

    function hasTab(tabId) {
        return !!tabs[tabId];
    }

    function removeTab(tabId) {
        removedTabs.add(tabId);
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

    async function setTabGroup(tabId, groupId) {
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

    function getTabGroup(tabId) {
        return tabs[tabId]?.groupId;
    }

    async function removeTabGroup(tabId) {
        if (tabs[tabId]?.groupId) {
            delete tabs[tabId].groupId;
        }

        return browser.sessions.removeTabValue(tabId, 'groupId');
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

    async function setTabFavIcon(tabId, favIconUrl) {
        if (favIconUrl?.startsWith('data:')) {
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

    function getTabFavIcon(tabId) {
        return tabs[tabId]?.favIconUrl;
    }

    async function removeTabFavIcon(tabId) {
        if (tabs[tabId]?.favIconUrl) {
            delete tabs[tabId].favIconUrl;
            return browser.sessions.removeTabValue(tabId, 'favIconUrl');
        }
    }

    // thumbnail
    async function loadTabThumbnail(tabId) {
        if (!BG.options.showTabsWithThumbnailsInManageGroups) {
            return;
        }

        if (tabs[tabId]) {
            if (tabs[tabId].thumbnail) {
                return tabs[tabId].thumbnail;
            }

            return tabs[tabId].thumbnail = await browser.sessions.getTabValue(tabId, 'thumbnail');
        }
    }

    async function setTabThumbnail(tabId, thumbnail) {
        if (!BG.options.showTabsWithThumbnailsInManageGroups) {
            return;
        }

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

    function getTabThumbnail(tabId) {
        return tabs[tabId]?.thumbnail;
    }

    async function removeTabThumbnail(tabId) {
        if (tabs[tabId]?.thumbnail) {
            delete tabs[tabId].thumbnail;
            return browser.sessions.removeTabValue(tabId, 'thumbnail');
        }
    }

    // tab
    function getTabSession(tabId, key = null) {
        if (key) {
            return tabs[tabId] ? tabs[tabId][key] : null;
        }

        return tabs[tabId] ? {...tabs[tabId]} : {};
    }

    async function loadTabSession(tab, includeFavIconUrl = true, includeThumbnail = true) {
        setTab(tab);

        if (utils.isAvailableFavIconUrl(tab.favIconUrl) && !tabs[tab.id].favIconUrl) {
            tabs[tab.id].favIconUrl = tab.favIconUrl;
        }

        await Promise.all([
            loadTabGroup(tab.id),
            includeFavIconUrl ? loadTabFavIcon(tab.id) : null,
            includeThumbnail ? loadTabThumbnail(tab.id) : null,
        ]);

        return applyTabSession(tab);
    }

    async function setTabSession(tab) {
        await Promise.all([
            setTabGroup(tab.id, tab.groupId),
            setTabFavIcon(tab.id, tab.favIconUrl),
            setTabThumbnail(tab.id, tab.thumbnail),
        ]);

        return tab;
    }

    function applyTabSession(tab) {
        return applySession(tab, tabs[tab.id] || {});
    }

    function removeTabSession(tabId) {
        return Promise.all([
            removeTabGroup(tabId),
            removeTabFavIcon(tabId),
            removeTabThumbnail(tabId),
        ]);
    }

    function getTabsSessionAndRemove(tabIds) {
        return tabIds
            .map(function(tabId) {
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
            if (windows[windowId].groupId) {
                delete windows[windowId].groupId;
                return browser.sessions.removeWindowValue(windowId, 'groupId');
            }
        }
    }

    function getWindowId(groupId) {
        if (!groupId) {
            return null;
        }

        for (let windowId in windows) {
            if (windows[windowId].groupId === groupId) {
                return Number(windowId);
            }
        }

        return null;
    }

    function getWindowGroup(windowId) {
        return windows[windowId] ? windows[windowId].groupId : null;
    }

    async function loadWindowSession(win) {
        if (!windows[win.id]) {
            windows[win.id] = {
                groupId: await browser.sessions.getWindowValue(win.id, 'groupId'),
            };
        }

        if (windows[win.id]?.groupId) {
            win.groupId = windows[win.id].groupId;
        }

        return win;
    }

    async function removeWindowSession(windowId) {
        await removeWindowGroup(windowId);
        removeWindow(windowId);
    }

    window.cache = {
        setLastTabState,
        getRealTabStateChanged,

        clear,
        applySession,

        // tabs
        setTab,
        hasTab,
        removeTab,

        setTabGroup,
        getTabGroup,
        removeTabGroup,

        setTabFavIcon,
        getTabFavIcon,
        removeTabFavIcon,

        setTabThumbnail,
        getTabThumbnail,
        removeTabThumbnail,

        getTabSession,
        loadTabSession,
        setTabSession,
        applyTabSession,
        removeTabSession,

        getTabsSessionAndRemove,
        removedTabs,

        // windows
        removeWindow,

        setWindowGroup,
        removeWindowGroup,

        getWindowId,
        getWindowGroup,

        loadWindowSession,
        removeWindowSession,
    };

})();
