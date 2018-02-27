(function() {
    'use strict';

    let errorLogs = [],
        _groups = [],
        allThumbnails = {};

browser.tabs.query({
    // windowId: windowId,
}).then(console.log);

// setTimeout(function() {
//     browser.tabs.move(574, {index:2});
// }, 5000);

    // return storage.get(null).then(console.log);
    // return browser.windows.getAll({
    //                 windowTypes: ['normal'],
    //             }).then(console.log);
    // browser.tabs.create({
    //     url: 'about:newtab',
    // });

    let log = function(message = 'log', data = null, showNotification = true) {
        try {
            throw Error(message);
        } catch (e) {
            let prefix = browser.extension.getURL('');

            errorLogs.push({
                message: message,
                data: data,
                fromLine: e.stack.split('@').map(l => l.split(prefix).join('')),
            });

            if (showNotification) {
                notify(browser.i18n.getMessage('whatsWrongMessage'))
                    .then(() => browser.runtime.openOptionsPage());
            }
        }
    };

    async function saveGroupsToStorage() {
        browser.runtime.sendMessage({
            groupsUpdated: true,
        });

        await storage.set({
            groups: _groups,
        });
    }

    async function getWindow(windowId = browser.windows.WINDOW_ID_CURRENT) {
        try {
            return await browser.windows.get(windowId);
        } catch (e) {}
    }

    async function createWindow(createData = {}) {
        let win = await browser.windows.create(createData);

        if ('normal' === win.type) {
            lastFocusedNormalWindow = win;
        }

        lastFocusedWinId = win.id;

        return win;
    }

    function setFocusOnWindow(windowId) {
        return browser.windows.update(windowId, {
            focused: true,
        });
    }

    async function getTabs(windowId = browser.windows.WINDOW_ID_CURRENT, status = 'v') { // v: visible, h: hidden, null: all
        try {
            let tabs = await browser.tabs.query({
                windowId: windowId,
                pinned: false,
            });

            tabs = tabs.filter(isTabNotIncognito);

            if ('v' === status) {
                return tabs.filter(isTabVisible);
            } else if ('h' === status) {
                return tabs.filter(isTabHidden);
            } else if (!status) {
                return tabs;
            }
        } catch (e) {
            console.error(e);
            return [];
        }
    }

    function getPinnedTabs(windowId = browser.windows.WINDOW_ID_CURRENT) {
        return browser.tabs.query({
            windowId: windowId,
            pinned: true,
        });
    }

    function normalizeUrl(url) {
        if (!url || 'about:newtab' === url || 'about:blank' === url) {
            return 'about:blank';
        }

        return url;
    }

    function mapTab(tab) {
        tab.url = normalizeUrl(tab.url);

        return {
            id: tab.id,
            title: tab.title || tab.url,
            url: tab.url,
            active: tab.active,
            favIconUrl: tab.favIconUrl,
            cookieStoreId: tab.cookieStoreId,
            thumbnail: getTabThumbnail(tab),
        };
    }

    function getTabThumbnail(tab) {
        return tab.thumbnail || allThumbnails[tab.url] || null;
    }

    function getTabFavIconUrl(tab, useTabsFavIconsFromGoogleS2Converter) {
        let safedFavIconUrl = '';

        if (tab.url.startsWith('moz-extension') || tab.url.startsWith('about')) {
            safedFavIconUrl = tab.favIconUrl;
        } else {
            safedFavIconUrl = useTabsFavIconsFromGoogleS2Converter ? ('http://www.google.com/s2/favicons?domain_url=' + encodeURIComponent(tab.url)) : tab.favIconUrl;
        }

        if (!safedFavIconUrl) {
            safedFavIconUrl = '/icons/tab.svg';
        }

        return safedFavIconUrl;
    }

    function createGroup(id, windowId = null) {
        return {
            id: id,
            title: browser.i18n.getMessage('newGroupTitle', id),
            iconColor: randomColor(),
            iconUrl: null,
            iconViewType: 'main-squares',
            tabs: [],
            catchTabRules: '',
            catchTabContainers: [],
            isSticky: false,
            windowId: windowId || null,
        };
    }

    async function addGroup(windowId, resetGroups = false, returnNewGroupIndex = true) {
        let options = await storage.get('lastCreatedGroupPosition');

        options.lastCreatedGroupPosition++;

        if (resetGroups) {
            _groups = [];
        }

        let newGroupIndex = _groups.length;

        _groups.push(createGroup(options.lastCreatedGroupPosition, windowId));

        if (0 === newGroupIndex) {
            let tabs = await getTabs(windowId);

            if (tabs.length) {
                _groups[0].tabs = tabs.map(mapTab);
            }

            updateBrowserActionData(windowId);
        }

        storage.set(options);

        sendExternalMessage({
            groupAdded: true,
            groupId: _groups[newGroupIndex].id,
        });

        updateMoveTabMenus(windowId);
        saveGroupsToStorage();

        return returnNewGroupIndex ? newGroupIndex : _groups[newGroupIndex];
    }

    async function updateGroup(groupId, updateData) {
        let groupIndex = _groups.findIndex(gr => gr.id === groupId);

        if (-1 === groupIndex) {
            return;
        }

        Object.assign(_groups[groupIndex], JSON.parse(JSON.stringify(updateData))); // JSON need for fix bug: dead object after close tab which create object

        saveGroupsToStorage();

        sendExternalMessage({
            groupUpdated: true,
            groupId: groupId,
        });
    }

    function sendExternalMessage(data, allowedRequestKeys = ['getGroupsList']) {
        Object.keys(EXTENSIONS_WHITE_LIST)
            .forEach(function(exId) {
                if (allowedRequestKeys.some(key => EXTENSIONS_WHITE_LIST[exId].allowedRequests.includes(key))) {
                    browser.runtime.sendMessage(exId, data);
                }
            });
    }

    async function addUndoRemoveGroupItem(group) {
        browser.menus.create({
            id: CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP + group.id,
            title: browser.i18n.getMessage('undoRemoveGroupItemTitle', unSafeHtml(group.title)),
            contexts: ['browser_action'],
            icons: {
                16: await getGroupIconUrl(group),
            },
            onclick: function(info) {
                browser.menus.remove(info.menuItemId);

                group.windowId = null;
                _groups.push(group);

                updateMoveTabMenus();
                saveGroupsToStorage();
            },
        });
    }

    async function createTempActiveTab(windowId = browser.windows.WINDOW_ID_CURRENT) {
        let pinnedTabs = await getPinnedTabs(windowId);

        if (pinnedTabs.length) {
            browser.tabs.update(pinnedTabs[pinnedTabs.length - 1].id, {
                active: true,
            });
        } else {
            return browser.tabs.create({
                url: 'about:blank',
                pinned: true,
                active: true,
                windowId: windowId,
            });
        }
    }

    async function removeGroup(groupId) {
        let groupIndex = _groups.findIndex(gr => gr.id === groupId),
            group = _groups[groupIndex],
            groupWindowId = group.windowId;

        addUndoRemoveGroupItem(group);

        _groups.splice(groupIndex, 1);

        saveGroupsToStorage();

        sendExternalMessage({
            groupDeleted: true,
            groupId: groupId,
        });

        let oldGroupWindow = await getWindow(groupWindowId);

        if (!oldGroupWindow) {
            updateMoveTabMenus();
            return;
        }

        let currentWindow = await getWindow();

        if (currentWindow.id !== groupWindowId) {
            updateMoveTabMenus();
            return await browser.windows.remove(groupWindowId);
        }

        // currentWindow === groupWindow
        let newGroupIndex = (groupIndex > _groups.length - 1) ? (_groups.length - 1) : groupIndex,
            windows = await browser.windows.getAll({
                windowTypes: ['normal'],
            }),
            otherWindow = windows.find(win => isWindowAllow(win) && win.id !== currentWindow.id);

        if (-1 === newGroupIndex) {
            if (otherWindow) {
                await browser.windows.remove(currentWindow.id);
                await setFocusOnWindow(otherWindow.id);
            } else {
                let tabs = await getTabs(currentWindow.id);

                if (tabs.length) {
                    let pinnedTabs = await getPinnedTabs(currentWindow.id);

                    if (!pinnedTabs.length) {
                        await browser.tabs.create({
                            active: true,
                        });
                    }

                    await browser.tabs.remove(tabs.map(keyId));
                }

                updateMoveTabMenus();
                updateBrowserActionData();
            }
        } else {
            if (_groups[newGroupIndex].windowId) {
                await browser.windows.remove(currentWindow.id);
                await setFocusOnWindow(_groups[newGroupIndex].windowId);
            } else {
                if (otherWindow) {
                    await browser.windows.remove(currentWindow.id);
                    await setFocusOnWindow(otherWindow.id);
                } else {

                    let tabsToRemoveIds = []; // TODO fix its...

                    group.windowId = null;
                    group.tabs.forEach(function(tab) {
                        if (tab.id) {
                            tabsToRemoveIds.push(tab.id);
                        }

                        tab.id = null;
                    });

                    if (tabsToRemoveIds.length) {
                        let tempEmptyTab = await createTempActiveTab();

                        await browser.tabs.remove(tabsToRemoveIds);

                        if (tempEmptyTab) {
                            await browser.tabs.remove(tempEmptyTab.id);
                        }
                    }

                    await loadGroup(currentWindow.id, newGroupIndex);
                }
            }
        }
    }

    async function moveGroup(groupId, position = 'up') {
        let groupIndex = _groups.findIndex(group => group.id === groupId);

        if ('up' === position) {
            if (0 === groupIndex) {
                return;
            }

            _groups.splice(groupIndex - 1, 0, _groups.splice(groupIndex, 1)[0]);
        } else if ('down' === position) {
            if (groupIndex === _groups.length - 1) {
                return;
            }

            _groups.splice(groupIndex + 1, 0, _groups.splice(groupIndex, 1)[0]);
        } else if ('number' === type(position)) {
            _groups.splice(position, 0, _groups.splice(groupIndex, 1)[0]);
        }

        saveGroupsToStorage();
        updateMoveTabMenus();
    }

    async function saveCurrentTabs(windowId, excludeTabId) {
        let group = _groups.find(gr => gr.windowId === windowId);

        if (!group) {
            return;
        }

        let tabs = await getTabs(windowId);

        if (excludeTabId) {
            if (!tabs.some(tab => tab.id === excludeTabId)) {
                return;
            }
        }

        console.info('saving tabs in window id:', windowId, JSON.parse(JSON.stringify(tabs)));

        // let syncTabIds = _groups
        //     .filter(gr => gr.id !== group.id)
        //     .reduce((acc, gr) => acc.concat(gr.tabs.filter(keyId).map(keyId)), []); // dont savetabs if its are already saved in other groups

        // if (excludeTabId) {
        //     syncTabIds.push(excludeTabId);
        // }

        group.tabs = tabs
            .filter(tab => tab.id !== excludeTabId)
            .map(mapTab);

        saveGroupsToStorage();
    }

    async function addTab(groupId, cookieStoreId) {
        let group = _groups.find(gr => gr.id === groupId),
            newTab = {
                active: false,
                url: 'about:blank',
                cookieStoreId,
            };

        if (group.windowId) {
            try {
                newTab = await browser.tabs.create({
                    active: false,
                    cookieStoreId,
                    windowId: group.windowId,
                });
            } catch (e) {
                notify(e);
                return;
            }

            newTab = mapTab(newTab);
        }

        if (!currentlyAddingTabs.includes(newTab.id)) {
            group.tabs.push(newTab);
            saveGroupsToStorage();
        }
    }

    async function removeTab(groupId, tabIndex) {
        let group = _groups.find(gr => gr.id === groupId),
            tabId = group.tabs[tabIndex].id;

        if (tabId) {
            let tab = await browser.tabs.get(tabId);

            if (tab.hidden) {
                group.tabs.splice(tabIndex, 1);
                saveGroupsToStorage();
            } else {
                let tabs = await getTabs(tab.windowId),
                    pinnedTabs = await getPinnedTabs(tab.windowId);

                if (!pinnedTabs.length && 1 === tabs.length) {
                    await browser.tabs.create({
                        active: true,
                        windowId: tab.windowId,
                    });
                }
            }

            await browser.tabs.remove(tabId);
        } else {
            group.tabs.splice(tabIndex, 1);
            saveGroupsToStorage();
        }
    }

    async function loadGroup(windowId, groupIndex, activeTabIndex = -1) {
        if (!windowId) { // if click on notification after moving tab to window which is now closed :)
            throw Error('loadGroup: wrong windowId');
        }

        let group = _groups[groupIndex];

        if (!group) {
            throw Error('group index not found ' + groupIndex);
        }

        try {
            if (group.windowId) {
                if (-1 === activeTabIndex) {
                    setFocusOnWindow(group.windowId);
                } else {
                    let tabId = null;

                    if (group.tabs[activeTabIndex].id) {
                        tabId = group.tabs[activeTabIndex].id;
                    } else {
                        let tabs = await getTabs(group.windowId);
                        tabId = tabs[activeTabIndex].id;
                    }

                    await browser.tabs.update(tabId, {
                        active: true,
                    });

                    setFocusOnWindow(group.windowId);
                }
            } else {
                // magic

                let tmpWin = await getWindow(windowId);
                if (tmpWin.incognito) {
                    throw Error('does\'nt support private windows');
                }

                removeEvents();

                let oldTabIds = [],
                    pinnedTabs = await getPinnedTabs(windowId),
                    pinnedTabsLength = pinnedTabs.length;

                let oldGroup = _groups.find(gr => gr.windowId === windowId);
                if (oldGroup) {
                    oldGroup.windowId = null;
                    oldTabIds = oldGroup.tabs.map(keyId);
                }

                group.windowId = windowId;
                group.tabs = group.tabs.filter(tab => tab.id || isTabAllowToCreate(tab)); // remove missed unsupported tabs

                if (!group.tabs.length && !pinnedTabsLength && oldGroup) {
                    group.tabs.push({
                        url: 'about:blank',
                        active: true,
                        cookieStoreId: DEFAULT_COOKIE_STORE_ID,
                    });
                }

                let tempEmptyTab = await createTempActiveTab(windowId); // create empty tab (for quickly change group and not blinking)

                if (tempEmptyTab) {
                    pinnedTabsLength++;
                }

                if (oldTabIds.length) {
                    await browser.tabs.hide(oldTabIds); // dont close active tabs: its will be moved to end of group
                }

                if (group.tabs.length) {
                    let containers = await loadContainers(),
                        findActiveTab = false,
                        hiddenTabsIds = group.tabs.filter(keyId).map(keyId);

                    if (hiddenTabsIds.length) {
                        await browser.tabs.move(hiddenTabsIds, {
                            index: pinnedTabsLength,
                            windowId: windowId,
                        });
                        await browser.tabs.show(hiddenTabsIds);
                    }

                    await Promise.all(group.tabs.map(async function(tab, tabIndex) {
                        if (!tab.id) {
                            let isTabActive = -1 === activeTabIndex ? Boolean(tab.active) : tabIndex === activeTabIndex;

                            if (isTabActive) {
                                findActiveTab = true;
                            }

                            let newTab = await browser.tabs.create({
                                active: isTabActive,
                                index: pinnedTabsLength + tabIndex,
                                url: tab.url,
                                windowId: windowId,
                                cookieStoreId: await getTabCookieStoreId(tab, containers),
                            });

                            tab.id = newTab.id;
                        }
                    }));

                    if (!findActiveTab) {
                        group.tabs.some(function(tab, tabIndex) { // make tab is active
                            let isTabActive = -1 === activeTabIndex ? Boolean(tab.active) : tabIndex === activeTabIndex;
                            if (isTabActive) {
                                browser.tabs.update(tab.id, {
                                    active: true,
                                });
                                return true;
                            }
                        });
                    }
                }

                if (tempEmptyTab) {
                    await browser.tabs.remove(tempEmptyTab.id);
                }

                let options = await storage.get('discardTabsAfterHide');

                if (options.discardTabsAfterHide && oldTabIds.length) {
                    await browser.tabs.discard(oldTabIds);
                }

                await saveCurrentTabs(windowId);

                updateMoveTabMenus(windowId);

                updateBrowserActionData(windowId);

                addEvents();
            }
        } catch (e) {
            notify(e);
            throw Error(String(e));
        }
    }

    function isCatchedUrl(url, group) {
        if (!group.catchTabRules) {
            return false;
        }

        return group.catchTabRules
            .split(/\s*\n\s*/)
            .filter(Boolean)
            .some(function(regExpStr) {
                try {
                    return new RegExp(regExpStr).test(url);
                } catch (e) {};
            });
    }

    function getVisibleTabThumbnail(windowId) {
        return new Promise(async function(resolve) {
            try {
                let thumbnailBase64 = await browser.tabs.captureVisibleTab(windowId, {
                        format: 'png',
                    }),
                    img = new Image();

                img.onload = function() {
                    resolve(resizeImage(img, 192, Math.floor(img.width * 192 / img.height), false));
                };

                img.src = thumbnailBase64;
            } catch (e) {
                resolve(null);
            }
        });
    }

    async function updateTabThumbnail(windowId, tabId) {
        let group = _groups.find(gr => gr.windowId === windowId);

        if (!group) {
            return;
        }

        let tabs = await getTabs(windowId),
            tabIndex = tabs.findIndex(tab => tab.active);

        if (-1 === tabIndex ||
            tabs[tabIndex].id !== tabId ||
            !group.tabs[tabIndex] ||
            group.tabs[tabIndex].id !== tabId ||
            group.tabs[tabIndex].thumbnail ||
            tabs[tabIndex].status !== 'complete') {
            return;
        }

        group.tabs[tabIndex].thumbnail = await getVisibleTabThumbnail(windowId);

        if (group.tabs[tabIndex].thumbnail && !allThumbnails[group.tabs[tabIndex].url]) {
            allThumbnails[group.tabs[tabIndex].url] = group.tabs[tabIndex].thumbnail;
        }

        saveGroupsToStorage();
    }

    async function onActivatedTab({ tabId, windowId }) {
        console.log('onActivatedTab', { tabId, windowId });

        let group = _groups.find(gr => gr.windowId === windowId);

        if (!group) {
            return;
        }

        group.tabs = group.tabs.map(function(tab, index) {
            tab.active = tab.id === tabId;

            if (tab.active && !tab.thumbnail) {
                updateTabThumbnail(windowId, tabId);
            }

            return tab;
        });

        saveGroupsToStorage();
    }

    async function onCreatedTab(tab) {
        console.log('onCreatedTab', tab);

        saveCurrentTabs(tab.windowId);
    }

    let currentlyMovingTabs = [], // tabIds // expample: open tab from bookmark and move it to other group: many calls method onUpdatedTab
        currentlyAddingTabs = [];

    async function onUpdatedTab(tabId, changeInfo, tab) {
        let windowId = tab.windowId,
            group = _groups.find(gr => gr.windowId === windowId);

        if (!group ||
            tab.incognito ||
            currentlyMovingTabs.includes(tabId) || // reject processing tabs
            currentlyAddingTabs.includes(tabId) || // reject processing tabs
            'isArticle' in changeInfo || // not supported reader mode now
            'discarded' in changeInfo || // not supported discard tabs now
            (tab.pinned && undefined === changeInfo.pinned)) { // pinned tabs are not supported
            return;
        }

        console.log('onUpdatedTab\n tabId:', tabId, JSON.stringify(changeInfo) + '\n', JSON.stringify({ // TODO comment
            status: tab.status,
            url: tab.url,
            title: tab.title,
        }));

        if ('hidden' in changeInfo) { // if other programm hide or show tabs
            if (changeInfo.hidden) {
                saveCurrentTabs(windowId);
            } else {
                let descTabIndex = -1,
                    descGroupIndex = _groups.findIndex(function(gr) {
                        descTabIndex = gr.tabs.findIndex(t => t.id === tabId);

                        if (-1 !== descTabIndex) {
                            return true;
                        }
                    });

                if (-1 === descGroupIndex) {
                    saveCurrentTabs(windowId);
                } else {
                    loadGroup(windowId, descGroupIndex, descTabIndex);
                }
            }

            return;
        }

        if ('pinned' in changeInfo) {
            saveCurrentTabs(windowId);
            return;
        }

        let savedTabIndex = group.tabs.findIndex(t => t.id === tabId);

        if ('loading' === changeInfo.status && changeInfo.url) {
            if (!group.isSticky && isUrlAllow(changeInfo.url) && !isUrlEmpty(changeInfo.url)) {
                let destGroup = _groups.find(gr => gr.catchTabContainers.includes(tab.cookieStoreId)) || _groups.find(gr => isCatchedUrl(changeInfo.url, gr));

                if (destGroup && destGroup.id !== group.id) {
                    currentlyMovingTabs.push(tabId);

                    group.tabs[savedTabIndex] = mapTab(tab);

                    await moveTabToGroup(savedTabIndex, undefined, group.id, destGroup.id);

                    currentlyMovingTabs.splice(currentlyMovingTabs.indexOf(tabId), 1);
                }
            }
        } else if ('complete' === tab.status) {
            await saveCurrentTabs(windowId);

            if (!group.tabs[savedTabIndex].thumbnail) {
                updateTabThumbnail(windowId, tabId);
            }
        }
    }

    async function onRemovedTab(tabId, { isWindowClosing, windowId }) {
        if (isWindowClosing) {
            return;
        }

        console.log('onRemovedTab', arguments);

        saveCurrentTabs(windowId, tabId);
    }

    async function onMovedTab(tabId, { windowId, fromIndex, toIndex }) {
        console.log('onMovedTab', arguments);
        saveCurrentTabs(windowId);
    }

    async function onAttachedTab(tabId, { newWindowId }) {
        saveCurrentTabs(newWindowId);
    }

    async function onDetachedTab(tabId, { oldWindowId }) {
        saveCurrentTabs(oldWindowId);
    }

    let lastFocusedWinId = null,
        lastFocusedNormalWindow = MAIN_WINDOW_ID; // fix bug with browser.windows.getLastFocused({windowTypes: ['normal']}), maybe find exists bug??

    async function onFocusChangedWindow(windowId) {
        if (browser.windows.WINDOW_ID_NONE === windowId) {
            return;
        }

        let win = await getWindow(windowId);

        if (win.incognito) {
            browser.browserAction.disable();
            resetBrowserActionData();
            removeMoveTabMenus();
        } else if (!lastFocusedWinId || lastFocusedWinId !== windowId) {
            browser.browserAction.enable();
            updateBrowserActionData(windowId);
            updateMoveTabMenus(windowId);
        }

        if (isWindowAllow(win)) {
            lastFocusedNormalWindow = win;
        }

        lastFocusedWinId = windowId;
    }

    async function _realHideTab(tabId) {
        let tempEmptyTab = null,
            tab = await browser.tabs.get(tabId);

        if (tab.hidden) {
            return;
        }

        if (tab.active) {
            tempEmptyTab = await createTempActiveTab(tab.windowId);
        }

        await browser.tabs.hide(tabId);

        if (tempEmptyTab) {
            await browser.tabs.remove(tempEmptyTab.id);
        }
    }

    // if oldGroupId === null, move tab from current window without group
    async function moveTabToGroup(oldTabIndex, newTabIndex = -1, oldGroupId = null, newGroupId, showNotificationAfterMoveTab = true) {
        let oldGroup = null,
            newGroup = _groups.find(gr => gr.id === newGroupId),
            tab = null,
            callSaveGroups = false,
            pushToEnd = -1 === newTabIndex,
            newTabRealIndex = null;

        if (pushToEnd) {
            newTabIndex = newGroup.tabs.length;
        }

        if (newGroup.windowId) {
            let pinnedTabs = await getPinnedTabs(newGroup.windowId);
            newTabRealIndex = pushToEnd ? -1 : pinnedTabs.length + newTabIndex;
        }

        if (oldGroupId) {
            oldGroup = _groups.find(gr => gr.id === oldGroupId);
            tab = oldGroup.tabs[oldTabIndex];
        } else {
            let tabs = await getTabs();
            tab = mapTab(tabs[oldTabIndex]);
        }


        if (oldGroupId === newGroupId) { // if it's same group
            if (newGroup.windowId) {
                await browser.tabs.move(tab.id, {
                    index: newTabRealIndex,
                });
            } else {
                if (newTabIndex !== oldTabIndex) {
                    newGroup.tabs.splice(newTabIndex, 0, newGroup.tabs.splice(oldTabIndex, 1)[0]);
                    callSaveGroups = true;
                }
            }
        } else { // if it's different group

            if (tab.id) {
                let rawTab = await browser.tabs.get(tab.id);

                if (oldGroup) {
                    if (oldGroup.windowId) {
                        // tab is NOT HIDDEN
                        if (newGroup.windowId) {
                            await browser.tabs.move(tab.id, {
                                index: newTabRealIndex,
                                windowId: newGroup.windowId,
                            });
                        } else {
                            await _realHideTab(tab.id);
                            newGroup.tabs.splice(newTabIndex, 0, tab);
                            callSaveGroups = true;
                        }
                    } else {
                        // tab is HIDDEN
                        if (newGroup.windowId) {
                            oldGroup.tabs.splice(oldTabIndex, 1);

                            await browser.tabs.move(tab.id, {
                                index: newTabRealIndex,
                                windowId: newGroup.windowId,
                            });

                            await browser.tabs.show(tab.id);
                        } else {
                            newGroup.tabs.splice(newTabIndex, 0, oldGroup.tabs.splice(oldTabIndex, 1)[0]);
                            callSaveGroups = true;
                        }
                    }
                } else {
                    if (newGroup.windowId) {
                        await browser.tabs.move(tab.id, {
                            index: newTabRealIndex,
                            windowId: newGroup.windowId,
                        });
                    } else {
                        await _realHideTab(tab.id);
                        newGroup.tabs.splice(newTabIndex, 0, tab);
                        callSaveGroups = true;
                    }
                }
            } else {
                if (!isTabAllowToCreate(tab)) {
                    notify(browser.i18n.getMessage('thisTabIsNotSupported', 10000));
                    return;
                }

                if (oldGroup) {
                    oldGroup.tabs.splice(oldTabIndex, 1);
                    callSaveGroups = true;
                }

                // add tab
                if (newGroup.windowId) {
                    callSaveGroups = false;

                    await browser.tabs.create({
                        active: false,
                        url: tab.url,
                        index: newTabRealIndex,
                        windowId: newGroup.windowId,
                        cookieStoreId: await getTabCookieStoreId(tab),
                    });
                } else {
                    newGroup.tabs.splice(newTabIndex, 0, tab);
                    callSaveGroups = true;
                }
            }

        }

        if (callSaveGroups) {
            saveGroupsToStorage();
        }


        if (!showNotificationAfterMoveTab) {
            return;
        }

        let options = await storage.get('showNotificationAfterMoveTab');
        if (!options.showNotificationAfterMoveTab) {
            return;
        }

        let title = tab.title.length > 50 ? (tab.title.slice(0, 50) + '...') : tab.title,
            message = browser.i18n.getMessage('moveTabToGroupMessage', [newGroup.title, title]);

        notify(message).then(async function(newTabIndex, newGroup) {
            let groupIndex = _groups.findIndex(group => group.id === newGroup.id);

            if (_groups[groupIndex].tabs[newTabIndex]) {
                // await setFocusOnWindow(lastFocusedNormalWindow.id);
                loadGroup(lastFocusedNormalWindow.id, groupIndex, newTabIndex);
            }
        }.bind(null, newTabIndex, newGroup));
    }

    let moveTabToGroupMenusIds = [];

    async function updateMoveTabMenus(windowId) {
        await removeMoveTabMenus();
        await createMoveTabMenus(windowId);
    }

    async function removeMoveTabMenus() {
        if (!moveTabToGroupMenusIds.length) {
            return;
        }

        await Promise.all(moveTabToGroupMenusIds.map(id => browser.menus.remove(id)));

        moveTabToGroupMenusIds = [];
    }

    async function createMoveTabMenus(windowId) {
        if (!windowId) {
            let win = await getWindow();
            windowId = win.id;
        }

        let currentGroup = _groups.find(gr => gr.windowId === windowId);

        moveTabToGroupMenusIds.push(browser.menus.create({
            id: 'stg-set-tab-icon-as-group-icon',
            title: browser.i18n.getMessage('setTabIconAsGroupIcon'),
            enabled: Boolean(currentGroup),
            icons: {
                16: '/icons/image.svg',
            },
            documentUrlPatterns: ['<all_urls>'],
            contexts: ['tab'],
            onclick: function(info, tab) {
                if (tab.incognito) {
                    notify(browser.i18n.getMessage('privateAndPinnedTabsAreNotSupported', 10000));
                    return;
                }

                if (!isUrlAllow(tab.url)) {
                    notify(browser.i18n.getMessage('thisTabIsNotSupported', 10000));
                    return;
                }

                let group = _groups.find(gr => gr.windowId === tab.windowId);

                if (!group) {
                    return;
                }

                group.iconUrl = getTabFavIconUrl(tab);

                updateBrowserActionData(group.windowId);
                updateMoveTabMenus(group.windowId);

                saveGroupsToStorage();
            }
        }));

        moveTabToGroupMenusIds.push(browser.menus.create({
            id: 'stg-move-tab-helper',
            title: browser.i18n.getMessage('moveTabToGroupDisabledTitle'),
            contexts: ['tab'],
            icons: {
                16: MANIFEST.browser_action.default_icon,
            },
            documentUrlPatterns: ['<all_urls>'],
        }));

        await Promise.all(_groups.map(async function(group) {
            moveTabToGroupMenusIds.push(browser.menus.create({
                id: CONTEXT_MENU_PREFIX_GROUP + group.id,
                parentId: 'stg-move-tab-helper',
                title: unSafeHtml(group.title),
                enabled: currentGroup ? group.id !== currentGroup.id : true,
                icons: {
                    16: await getGroupIconUrl(group),
                },
                contexts: ['tab'],
                onclick: async function(destGroupId, info, tab) {
                    if (tab.incognito || tab.pinned) {
                        notify(browser.i18n.getMessage('privateAndPinnedTabsAreNotSupported', 10000));
                        return;
                    }

                    let tabs = await getTabs(tab.windowId),
                        tabIndex = tabs.findIndex(({ id }) => id === tab.id);

                    if (-1 === tabIndex) {
                        notify(browser.i18n.getMessage('thisTabIsNotSupported', 10000));
                        return;
                    }

                    let oldGroup = _groups.find(gr => gr.windowId === tab.windowId)

                    moveTabToGroup(tabIndex, undefined, (oldGroup && oldGroup.id), destGroupId);
                }.bind(null, group.id),
            }));
        }));

        if (_groups.length) {
            moveTabToGroupMenusIds.push(browser.menus.create({
                id: 'stg-move-tab-separator',
                parentId: 'stg-move-tab-helper',
                type: 'separator',
                contexts: ['tab'],
            }));
        }

        moveTabToGroupMenusIds.push(browser.menus.create({
            id: 'stg-move-tab-new-group',
            parentId: 'stg-move-tab-helper',
            contexts: ['tab'],
            title: browser.i18n.getMessage('createNewGroup'),
            icons: {
                16: '/icons/group-new.svg',
            },
            onclick: async function(info, tab) {
                if (tab.incognito || tab.pinned) {
                    notify(browser.i18n.getMessage('privateAndPinnedTabsAreNotSupported', 10000));
                    return;
                }

                let tabs = await getTabs(tab.windowId),
                    tabIndex = tabs.findIndex(({ id }) => id === tab.id);

                if (-1 === tabIndex) {
                    notify(browser.i18n.getMessage('thisTabIsNotSupported', 10000));
                    return;
                }

                let oldGroup = _groups.find(gr => gr.windowId === tab.windowId),
                    newGroup = await addGroup(undefined, undefined, false);

                moveTabToGroup(tabIndex, undefined, (oldGroup && oldGroup.id), newGroup.id);
            },
        }));
    }

    async function setBrowserActionData(currentGroup) {
        if (!currentGroup) {
            resetBrowserActionData();
            return;
        }

        browser.browserAction.setTitle({
            title: unSafeHtml(currentGroup.title) + ' - ' + browser.i18n.getMessage('extensionName'),
        });

        browser.browserAction.setIcon({
            path: await getGroupIconUrl(currentGroup),
        });
    }

    async function resetBrowserActionData() {
        browser.browserAction.setTitle({
            title: MANIFEST.browser_action.default_title,
        });

        browser.browserAction.setIcon({
            path: await getGroupIconUrl(),
        });
    }

    async function updateBrowserActionData(windowId) {
        if (!windowId) {
            let win = await getWindow();
            windowId = win.id;
        }

        setBrowserActionData(_groups.find(gr => gr.windowId === windowId));
    }

    async function onRemovedWindow(windowId) {
        let group = _groups.find(gr => gr.windowId === windowId);

        if (group) {
            group.windowId = null;
            group.tabs.forEach(tab => tab.id = null);
            saveGroupsToStorage();
        }

        if (lastFocusedNormalWindow.id === windowId) {
            lastFocusedNormalWindow = await getWindow();
        }
    }

    function addEvents() {
        browser.tabs.onCreated.addListener(onCreatedTab);
        browser.tabs.onActivated.addListener(onActivatedTab);
        browser.tabs.onMoved.addListener(onMovedTab);
        browser.tabs.onUpdated.addListener(onUpdatedTab);
        browser.tabs.onRemoved.addListener(onRemovedTab);

        browser.tabs.onAttached.addListener(onAttachedTab);
        browser.tabs.onDetached.addListener(onDetachedTab);

        browser.windows.onFocusChanged.addListener(onFocusChangedWindow);
        browser.windows.onRemoved.addListener(onRemovedWindow);
    }

    function removeEvents() {
        browser.tabs.onCreated.removeListener(onCreatedTab);
        browser.tabs.onActivated.removeListener(onActivatedTab);
        browser.tabs.onMoved.removeListener(onMovedTab);
        browser.tabs.onUpdated.removeListener(onUpdatedTab);
        browser.tabs.onRemoved.removeListener(onRemovedTab);

        browser.tabs.onAttached.removeListener(onAttachedTab);
        browser.tabs.onDetached.removeListener(onDetachedTab);

        browser.windows.onFocusChanged.removeListener(onFocusChangedWindow);
        browser.windows.onRemoved.removeListener(onRemovedWindow);
    }

    async function loadGroupPosition(textPosition) {
        if (1 === _groups.length) {
            return;
        }

        let win = await getWindow(),
            groupIndex = _groups.findIndex(group => group.windowId === win.id);

        if (-1 === groupIndex) {
            return;
        }

        let nextGroupIndex = getNextIndex(groupIndex, _groups.length, textPosition);

        if (false === nextGroupIndex) {
            return;
        }

        await loadGroup(_groups[groupIndex].windowId, nextGroupIndex);
    }

    function sortGroups(vector = 'asc') {
        if (!['asc', 'desc'].includes(vector)) {
            return;
        }

        let options = {
            numeric: true,
        };

        _groups = _groups.sort(function(a, b) {
            if ('asc' === vector) {
                return a.title.localeCompare(b.title, [], options);
            } else if ('desc' === vector) {
                return b.title.localeCompare(a.title, [], options);
            }
        });

        saveGroupsToStorage();
        updateMoveTabMenus();
    }

    async function openManageGroups(windowScreen) {
        let manageUrl = browser.extension.getURL(MANAGE_TABS_URL),
            options = await storage.get('openManageGroupsInTab'),
            currentWindow = await getWindow();

        if (options.openManageGroupsInTab) {
            let tabs = await browser.tabs.query({
                windowId: currentWindow.id,
                url: manageUrl,
            });

            if (tabs.length) { // if manage tab is found
                browser.tabs.update(tabs[0].id, {
                    active: true,
                });
            } else {
                browser.tabs.create({
                    active: true,
                    url: manageUrl,
                });
            }
        } else {
            let allWindows = await browser.windows.getAll({
                populate: true,
                windowTypes: ['popup'],
            });

            let isFoundWindow = allWindows.some(function(win) {
                if ('popup' === win.type && 1 === win.tabs.length && manageUrl === win.tabs[0].url) { // if manage popup is now open
                    BG.setFocusOnWindow(win.id);
                    return true;
                }
            });

            if (isFoundWindow) {
                return;
            }

            let createData = {
                url: manageUrl,
                type: 'popup',
            };

            if (windowScreen) {
                createData.left = 0;
                createData.top = 0;
                createData.width = windowScreen.availWidth;
                createData.height = windowScreen.availHeight;
            }

            createWindow(createData);
        }
    }

    browser.menus.create({
        id: 'openSettings',
        title: browser.i18n.getMessage('openSettings'),
        onclick: () => browser.runtime.openOptionsPage(),
        contexts: ['browser_action'],
        icons: {
            16: 'chrome://browser/skin/settings.svg',
        },
    });

    browser.runtime.onMessage.addListener(function(request, sender, sendResponse) {
        if (!isAllowSender(sender)) {
            return {
                unsubscribe: true,
            };
        }

        if (request.optionsUpdated && request.optionsUpdated.includes('hotkeys')) {
            let customRequest = {
                updateHotkeys: true,
            };

            browser.tabs.query({}).then(tabs => tabs.forEach(tab => !tab.incognito && browser.tabs.sendMessage(tab.id, customRequest)));
        }

        if (request.runAction) {
            runAction(request.runAction);
        }
    });

    browser.runtime.onMessageExternal.addListener(function(request, sender, sendResponse) {
        let extensionRules = {};

        if (!isAllowExternalRequestAndSender(request, sender, extensionRules)) {
            sendResponse({
                ok: false,
                error: '[STG] Your extension/action does not in white list. If you want to add your extension/action to white list - please contact with me.',
                yourExtentionRules: extensionRules,
            });
            return;
        }

        if (request.areYouHere) {
            sendResponse({
                ok: true,
            });
        } else if (request.getGroupsList) {
            sendResponse(new Promise(async function(resolve) {
                resolve({
                    ok: true,
                    groupsList: await Promise.all(_groups.map(async function(group) {
                        return {
                            id: group.id,
                            title: unSafeHtml(group.title),
                            iconUrl: await getGroupIconUrl(group),
                        };
                    })),
                });
            }));
        } else if (request.runAction) {
            sendResponse(runAction(request.runAction));
        }
    });

    async function runAction(action) {
        let result = {
            ok: false,
        };

        if (!action || !action.id) {
            result.error = '[STG] Action id is empty';
            return result;
        }

        let currentWindow = await getWindow(),
            currentGroup = _groups.find(gr => gr.windowId === currentWindow.id);

        try {
            if ('load-next-group' === action.id) {
                if (currentGroup) {
                    await loadGroupPosition('next');
                    result.ok = true;
                }
            } else if ('load-prev-group' === action.id) {
                if (currentGroup) {
                    await loadGroupPosition('prev');
                    result.ok = true;
                }
            } else if ('load-first-group' === action.id) {
                if (_groups[0]) {
                    await loadGroup(currentWindow.id, 0);
                    result.ok = true;
                }
            } else if ('load-last-group' === action.id) {
                if (_groups[_groups.length - 1]) {
                    await loadGroup(currentWindow.id, _groups.length - 1);
                    result.ok = true;
                }
            } else if ('load-custom-group' === action.id) {
                let groupIndex = _groups.findIndex(gr => gr.id === action.groupId);

                if (-1 === groupIndex) {
                    throw Error('group id not found');
                } else {
                    await loadGroup(currentWindow.id, groupIndex);
                    result.ok = true;
                }
            } else if ('add-new-group' === action.id) {
                await addGroup();
                result.ok = true;
            } else if ('delete-current-group' === action.id) {
                if (currentGroup) {
                    await removeGroup(currentGroup.id);
                    result.ok = true;
                }
            } else if ('open-manage-groups' === action.id) {
                await openManageGroups();
                result.ok = true;
            }
        } catch (e) {
            result.error = '[STG] ' + String(e);
        }

        return result;
    }

    window.background = {
        inited: false,

        log,
        getLogs: () => errorLogs,

        openManageGroups,

        getGroups: () => _groups,

        createWindow,
        getWindow,

        getTabs,
        moveTabToGroup,

        createMoveTabMenus,
        updateMoveTabMenus,
        removeMoveTabMenus,

        updateBrowserActionData,
        setFocusOnWindow,
        getLastFocusedNormalWindow: () => lastFocusedNormalWindow,

        sortGroups,
        loadGroup,

        mapTab,
        getTabFavIconUrl,
        getTabThumbnail,

        addTab,
        removeTab,

        createGroup,
        moveGroup,
        addGroup,
        updateGroup,
        removeGroup,

        reloadGroups: async function() {
            let data = await storage.get('groups');
            _groups = data.groups;
        },
        runMigrateForData,
    };

    async function runMigrateForData(data, result = {}) {
        if (data.version === MANIFEST.version) {
            return data;
        }

        let compareVersion = data.version.localeCompare(MANIFEST.version);

        if (1 === compareVersion) {
            result.errorMessage = 'Please, update addon to latest version';
            return false;
        }

        // start migration
        let keysToRemoveFromStorage = [],
            removeKey = function(key) {
                delete data[key];
                keysToRemoveFromStorage.push(key);
            };

        if (0 > data.version.localeCompare('1.8.1')) {
            result.dataChanged = true;

            data.groups = data.groups.map(function(group) {
                group.windowId = data.windowsGroup[win.id] === group.id ? win.id : null;

                group.catchTabRules = group.moveNewTabsToThisGroupByRegExp || '';
                delete group.moveNewTabsToThisGroupByRegExp;

                delete group.classList;
                delete group.colorCircleHtml;
                delete group.isExpanded;

                if (group.iconColor === undefined || group.iconColor === 'undefined') { // fix missed group icons :)
                    group.iconColor = randomColor();
                }

                return group;
            });

            removeKey('windowsGroup');
        }

        if (0 > data.version.localeCompare('2.2')) {
            if ('showGroupCircleInSearchedTab' in data) {
                result.dataChanged = true;
                data.showGroupIconWhenSearchATab = data.showGroupCircleInSearchedTab;
                removeKey('showGroupCircleInSearchedTab');
            }
        }

        if (0 > data.version.localeCompare('2.3')) {
            result.dataChanged = true;

            data.groups = data.groups.map(function(group) { // final fix nulls ...
                let tabsLengthBefore = group.tabs.length;

                group.tabs = group.tabs.filter(Boolean);

                if (group.tabs.length !== tabsLengthBefore) {
                    result.dataChanged = true;
                }

                return group;
            });

            removeKey('enableKeyboardShortcutLoadNextPrevGroup');
            removeKey('enableKeyboardShortcutLoadByIndexGroup');
        }

        if (0 > data.version.localeCompare('2.4')) {
            result.dataChanged = true;

            data.groups = data.groups.map(function(group) {
                if (!group.catchTabContainers) {
                    group.catchTabContainers = [];
                }

                return group;
            });
        }

        if (0 > data.version.localeCompare('2.4.5')) {
            result.dataChanged = true;

            data.groups = data.groups.map(function(group) {
                if (!group.iconColor.trim()) {
                    group.iconColor = 'transparent';
                }

                group.iconViewType = 'main-squares';

                return group;
            });
        }

        if (0 > data.version.localeCompare('3.0')) { // TODO write migration with options
            // result.dataChanged = true;

            // data.groups = data.groups.map(function(group) {
            //     if (!group.iconColor.trim()) {
            //         group.iconColor = 'transparent';
            //     }

            //     group.iconViewType = 'main-squares';

            //     return group;
            // });
        }



        data.version = MANIFEST.version;

        if (keysToRemoveFromStorage.length) {
            await storage.remove(keysToRemoveFromStorage);
        }
        // end migration

        return data;
    }

    // initialization
    Promise.all([
            storage.get(null),
            browser.windows.getAll({
                populate: true,
                windowTypes: ['normal'],
            })
        ])
        .then(async function([data, windows]) {
            let resultMigration = {};

            data = await runMigrateForData(data, resultMigration); // migration data

            if (resultMigration.errorMessage) {
                throw Error(resultMigration.errorMessage);
            }

            if (resultMigration.dataChanged) {
                await storage.set(data);
            }


            // NEW CODE
            windows = windows
                .filter(isWindowAllow)
                .map(function(win) {
                    win.tabs = win.tabs.filter(isTabNotPinned);
                    return win;
                });

            lastFocusedNormalWindow = windows.find(win => win.id === MAIN_WINDOW_ID) || windows[0];

            // temporary save all tabs thumblails for other tabs
            data.groups.forEach(function(group) {
                group.tabs.forEach(function(tab) {
                    if (tab.thumbnail && !allThumbnails[tab.url]) {
                        allThumbnails[tab.url] = tab.thumbnail;
                    }
                });
            });

            // step 1: sync groups with window id
            data.groups
                .filter(group => group.windowId)
                .forEach(function(group) {
                    let groupWin = windows.find(win => win.id === group.windowId);

                    if (!groupWin) {
                        groupWin = windows.find(function(win) {
                            let winTabs = win.tabs.filter(isTabVisible);

                            if (winTabs.length < group.tabs.length) {
                                return false;
                            }

                            let equalGroupTabs = group.tabs.filter(function(tab, tabIndex) {
                                let findTab = winTabs.some(t => t.url === tab.url);

                                if (!findTab && winTabs[tabIndex].active) {
                                    findTab = true;
                                }

                                return findTab;
                            });

                            return equalGroupTabs.length === group.tabs.length;
                        });
                    }

                    if (groupWin) {
                        group.windowId = groupWin.id;
                        group.tabs = groupWin.tabs
                            .filter(isTabVisible)
                            .map(mapTab);
                    } else {
                        group.windowId = null;
                        group.tabs.forEach(tab => tab.id = null);
                    }
                });

            let syncedTabsIds = [],
                syncAllTabsInGroup = [];

            windows.forEach(function(win) {
                let winTabs = win.tabs.filter(isTabHidden);

                data.groups
                    .filter(group => !group.windowId)
                    .forEach(function(group) {
                        if (!group.tabs.length) {
                            syncAllTabsInGroup.push(group.id);
                        }

                        if (syncAllTabsInGroup.includes(group.id)) {
                            return;
                        }

                        let findAllTabs = group.tabs.every(tab => winTabs.some(t => !syncedTabsIds.includes(t.id) && t.url === tab.url));

                        if (findAllTabs) {
                            syncAllTabsInGroup.push(group.id);
                            group.tabs.forEach(function(tab) {
                                let winTab = winTabs.find(t => !syncedTabsIds.includes(t.id) && t.url === tab.url);

                                if (!winTab) {
                                    log('WFT???', {winTabs, tab});
                                }

                                tab.id = winTab.id;
                                syncedTabsIds.push(tab.id);
                            });
                        } else {
                            group.tabs.forEach(tab => tab.id = null);
                        }

                        // group.tabs.forEach(function(tab) {
                        //     let winTab = winTabs.find(t => !syncedTabsIds.includes(t.id) && t.url === tab.url);

                        //     if (winTab) {
                        //         tab.id = winTab.id;
                        //         syncedTabsIds.push(tab.id);
                        //     } else {
                        //         tab.id = null;
                        //     }
                        // });
                    });


            });



            // // step 2: sync groups which not have window id by tabs urls
            // data.groups
            //     .filter(group => !group.windowId)
            //     .forEach(function(group) {
            //         windows.forEach(function(win) {
            //             let winTabs = win.tabs.filter(isTabHidden);

            //             group.tabs.forEach(function(tab) {
            //                 let winTab = winTabs.find(t => !syncedTabsIds.includes(t.id) && t.url === tab.url);

            //                 if (winTab) {
            //                     tab.id = winTab.id;
            //                     syncedTabsIds.push(tab.id);
            //                 } else {
            //                     tab.id = null;
            //                 }
            //             });
            //         });
            //     });

            // step 3: hide tabs if it's in not loaded groups
            // let tabsToHide = [];
            // data.groups
            //     .forEach(function(group) {
            //         if (group.windowId) {
            //             return;
            //         }

            //         tabsToHide = tabsToHide.concat(group.tabs.filter(keyId).map(keyId));
            //     });

            // if (tabsToHide.length) {
            //     await browser.tabs.hide(tabsToHide);
            // }


            // TODO if no one group are synced

            _groups = data.groups;

            await storage.set({
                lastCreatedGroupPosition: data.lastCreatedGroupPosition,
                groups: _groups,
            });

            updateBrowserActionData();
            createMoveTabMenus();

            addEvents();

            Object.keys(EXTENSIONS_WHITE_LIST)
                .forEach(function(exId) {
                    browser.runtime.sendMessage(exId, {
                        IAmBack: true,
                    });
                });

            window.background.inited = true;

        })
        .catch(notify);

})()
