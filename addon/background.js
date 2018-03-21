(function() {
    'use strict';

    let errorLogs = [],
        _groups = [],
        currentlyLoadingGroups = {}; // windowId: true

    // return storage.get(null).then(console.log);

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

    async function getTabs(windowId = browser.windows.WINDOW_ID_CURRENT) {
        try {
            let tabs = await browser.tabs.query({
                windowId,
                pinned: false,
            });

            return tabs.filter(isAllowTab);
        } catch (e) {
            // console.error(e);
            return [];
        }
    }

    async function hasAnotherTabs(windowId = browser.windows.WINDOW_ID_CURRENT) {
        let tabs = await browser.tabs.query({
            windowId,
        });

        return tabs.some(tab => tab.pinned || !isAllowUrl(tab.url));
    }

    function normalizeUrl(url) {
        if (!url || 'about:newtab' === url || 'about:blank' === url) {
            return 'about:blank';
        }

        if (isStgNewTabUrl(url)) {
            return revokeStgNewTabUrl(url);
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
            thumbnail: null,
        };
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
            id,
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

    async function addGroup(windowId, resetGroups = false, returnNewGroupIndex = true, saveCurrentTabsToThisGroup = false) {
        let options = await storage.get(['lastCreatedGroupPosition', 'openNewWindowWhenCreateNewGroup']);

        options.lastCreatedGroupPosition++;

        if (resetGroups) {
            _groups = [];
        }

        let newGroupIndex = _groups.length,
            win = null;

        _groups.push(createGroup(options.lastCreatedGroupPosition, windowId));

        if (options.openNewWindowWhenCreateNewGroup && !windowId) {
            win = await createWindow();
            _groups[newGroupIndex].windowId = windowId = win.id;

            updateBrowserActionData(windowId);
        }

        if (0 === newGroupIndex || saveCurrentTabsToThisGroup) {
            if (!win) {
                win = await getWindow(windowId);

                windowId = win.id;

                let oldGroup = _groups.find(gr => gr.windowId === windowId);
                if (oldGroup) {
                    oldGroup.windowId = null;
                }

                _groups[newGroupIndex].windowId = windowId;
            }

            let tabs = await getTabs(windowId);

            if (tabs.length) {
                _groups[newGroupIndex].tabs = tabs.map(mapTab);
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

    async function removeGroup(groupId) {
        let groupIndex = _groups.findIndex(gr => gr.id === groupId),
            groupWindowId = _groups[groupIndex].windowId;

        addUndoRemoveGroupItem(_groups[groupIndex]);

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
            otherWindow = windows.find(win => win.type === 'normal' && win.id !== currentWindow.id);

        if (-1 === newGroupIndex) {
            if (otherWindow) {
                await browser.windows.remove(currentWindow.id);
                await setFocusOnWindow(otherWindow.id);
            } else {
                let tabs = await getTabs(currentWindow.id);

                if (tabs.length) {
                    let isHasAnotherTabs = await hasAnotherTabs(currentWindow.id);

                    if (!isHasAnotherTabs) {
                        await browser.tabs.create({
                            active: true,
                        });
                    }

                    await browser.tabs.remove(tabs.map(t => t.id));
                }

                updateMoveTabMenus();
                updateBrowserActionData();
            }
        } else {
            let newGroupWindow = await getWindowByGroup(_groups[newGroupIndex]);

            if (newGroupWindow) {
                await browser.windows.remove(currentWindow.id);
                await setFocusOnWindow(newGroupWindow.id);
            } else {
                if (otherWindow) {
                    await browser.windows.remove(currentWindow.id);
                    await setFocusOnWindow(otherWindow.id);
                } else {
                    await loadGroup(currentWindow.id, newGroupIndex, undefined, true);
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

    async function getWindowByGroup(group) {
        if (group.windowId) {
            return getWindow(group.windowId);
        }
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

    async function removeCurrentTabByIndex(windowId, tabIndex) {
        let tabs = await getTabs(windowId),
            isHasAnotherTabs = await hasAnotherTabs(windowId),
            tabId = null;

        // if (!tabs[tabIndex]) { // TMP if bug found
        //     console.error('tabIndex not found in removeCurrentTabByIndex, tabIndex: ' + tabIndex);

        //     let group = _groups.find(gr => gr.windowId === windowId);
        //     if (group && group.tabs[tabIndex]) {
        //         group.tabs.splice(tabIndex, 1);
        //         saveGroupsToStorage();
        //     }
        //     return;
        // }

        tabId = tabs[tabIndex].id;

        if (!isHasAnotherTabs && 1 === tabs.length) {
            await browser.tabs.create({
                active: true,
                windowId,
            });
        }

        await browser.tabs.remove(tabId);
    }

    async function removeTab(tabIndex, group) {
        let win = await getWindowByGroup(group);

        if (win) {
            return removeCurrentTabByIndex(win.id, tabIndex);
        } else {
            let rawGroup = _groups.find(gr => gr.id === group.id);

            rawGroup.tabs.splice(tabIndex, 1);

            saveGroupsToStorage();
        }
    }

    async function loadGroup(windowId, groupIndex, activeTabIndex = -1, anywayLoadInThisWindowId = false) {
        if (!windowId) { // if click on notification after moving tab to window which is now closed :)
            throw Error('loadGroup: wrong windowId');
        }

        if (currentlyLoadingGroups[windowId]) {
            notify(browser.i18n.getMessage('errorAnotherGroupAreLoading'), 5000, 'error-load-group-notification');
            throw Error('another group currently loading');
        }

        if (!_groups[groupIndex]) {
            throw Error('group index not found ' + groupIndex);
        }

        currentlyLoadingGroups[windowId] = true;

        let group = _groups[groupIndex],
            win = await getWindowByGroup(group);

        try {
            if (win) {
                if (-1 === activeTabIndex) {
                    setFocusOnWindow(win.id);
                } else {
                    let tabs = await getTabs(win.id);

                    await browser.tabs.update(tabs[activeTabIndex].id, {
                        active: true,
                    });

                    setFocusOnWindow(win.id);
                }
            } else {
                // magic

                let tmpWin = await getWindow(windowId);
                if (tmpWin.incognito) {
                    throw Error('does\'nt support private windows');
                }

                removeEvents();

                browser.runtime.sendMessage({
                    loadingGroupPosition: 10,
                });

                let options = await storage.get('individualWindowForEachGroup');

                if (options.individualWindowForEachGroup && !anywayLoadInThisWindowId) {
                    delete currentlyLoadingGroups[windowId];

                    let win = await createWindow();
                    windowId = win.id;

                    currentlyLoadingGroups[windowId] = true;
                }

                let oldTabIds = [],
                    tempEmptyTabId = null,
                    tempEmptyTabPromise = Promise.resolve(),
                    tabs = await getTabs(windowId),
                    isHasAnotherTabs = await hasAnotherTabs(windowId);

                browser.runtime.sendMessage({
                    loadingGroupPosition: 20,
                });

                oldTabIds = tabs.map(tab => tab.id);

                let oldGroup = _groups.find(gr => gr.windowId === windowId);
                if (oldGroup) {
                    oldGroup.windowId = null;
                }

                group.windowId = windowId;

                if (oldTabIds.length || !isHasAnotherTabs) { // create empty tab (for quickly change group and not blinking)
                    tempEmptyTabPromise = browser.tabs.create({
                            url: 'about:blank',
                            active: true,
                            windowId: windowId,
                        })
                        .then(tab => tempEmptyTabId = tab.id);
                }

                if (!group.tabs.length && !isHasAnotherTabs) {
                    group.tabs.push({
                        active: true,
                        url: 'about:blank',
                        cookieStoreId: DEFAULT_COOKIE_STORE_ID,
                    });
                }

                await tempEmptyTabPromise;

                browser.runtime.sendMessage({
                    loadingGroupPosition: 50,
                });

                if (oldTabIds.length) {
                    await browser.tabs.remove(oldTabIds);
                }

                browser.runtime.sendMessage({
                    loadingGroupPosition: 90,
                });

                if (group.tabs.length) {
                    let options = await storage.get(['enableFastGroupSwitching', 'enableFavIconsForNotLoadedTabs']),
                        containers = await loadContainers();

                    await Promise.all(group.tabs.map(function(tab, tabIndex) {
                            tab.active = -1 === activeTabIndex ? Boolean(tab.active) : tabIndex === activeTabIndex;

                            let url = tab.url;

                            if (options.enableFastGroupSwitching) {
                                url = createStgTabNewUrl(tab, options.enableFavIconsForNotLoadedTabs);
                            }

                            return browser.tabs.create({
                                active: tab.active,
                                url: url,
                                windowId: windowId,
                                cookieStoreId: normalizeCookieStoreId(tab.cookieStoreId, containers),
                            });
                        }))
                        .then(newTabs => newTabs.forEach((tab, tabIndex) => group.tabs[tabIndex].id = tab.id)); // update tabs id
                }

                // if (browser.tabs.discard && tabs) { // TODO - add discard tabs (bugs found)
                //     let discardedTabs = tabs.filter(tab => !tab.active).map(tab => tab.id);
                //     await browser.tabs.discard(discardedTabs);
                // }

                if (tempEmptyTabId) {
                    await browser.tabs.remove(tempEmptyTabId);
                }

                browser.runtime.sendMessage({
                    loadingGroupPosition: false,
                });

                saveGroupsToStorage();

                updateMoveTabMenus(windowId);

                updateBrowserActionData(windowId);

                addEvents();
            }

            delete currentlyLoadingGroups[windowId];

            browser.notifications.clear('error-load-group-notification');

        } catch (e) {
            delete currentlyLoadingGroups[windowId];
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

        saveGroupsToStorage();
    }

    async function onActivatedTab({ tabId, windowId }) {
        // console.log('onActivatedTab', { tabId, windowId });

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
        // console.log('onCreatedTab', tab);

        if (currentlyAddingTabs.includes(tab.id) || tab.incognito) {
            return;
        }

        let group = _groups.find(gr => gr.windowId === tab.windowId);

        if (!group) {
            return;
        }

        let tabs = await getTabs(tab.windowId),
            newTabIndex = tabs.findIndex(t => t.id === tab.id);

        if (-1 === newTabIndex || currentlyAddingTabs.includes(tab.id) || group.tabs.some(t => t.id === tab.id)) {
            return;
        }

        group.tabs.splice(newTabIndex, 0, mapTab(tab));

        saveGroupsToStorage();
    }

    let currentlyMovingTabs = [], // tabIds // expample: open tab from bookmark and move it to other group: many calls method onUpdatedTab
        currentlyAddingTabs = [];

    async function onUpdatedTab(tabId, changeInfo, tab) {
        let windowId = tab.windowId,
            group = _groups.find(gr => gr.windowId === windowId);

        if (!group ||
            tab.incognito ||
            currentlyLoadingGroups[windowId] ||
            currentlyMovingTabs.includes(tabId) || // reject processing tabs
            currentlyAddingTabs.includes(tabId) || // reject processing tabs
            'isArticle' in changeInfo || // not supported reader mode now
            'discarded' in changeInfo || // not supported discard tabs now
            (tab.pinned && undefined === changeInfo.pinned)) { // pinned tabs are not supported
            return;
        }

        let savedTabIndex = group.tabs.findIndex(t => t.id === tabId);

        // console.log('onUpdatedTab\n tabId:', tabId, JSON.stringify(changeInfo) + '\n', JSON.stringify({ // TODO comment
        //     status: tab.status,
        //     url: tab.url,
        //     title: tab.title,
        // }));

        if (isStgNewTabUrl(tab.url)) {
            tab.url = revokeStgNewTabUrl(tab.url);
        }

        if ('pinned' in changeInfo) {
            if (isAllowUrl(tab.url)) {
                if (changeInfo.pinned) {
                    if (-1 !== savedTabIndex) {
                        group.tabs.splice(savedTabIndex, 1); // remove pinned tab
                    }
                } else {
                    group.tabs.unshift(mapTab(tab)); // add unpinned tab
                }

                saveGroupsToStorage();
            }

            return;
        }

        if ('loading' === changeInfo.status && changeInfo.url) {
            if (!group.isSticky && isAllowUrl(changeInfo.url) && !isEmptyUrl(changeInfo.url)) {
                let destGroup = _groups.find(gr => gr.catchTabContainers.includes(tab.cookieStoreId)) || _groups.find(gr => isCatchedUrl(changeInfo.url, gr));

                if (destGroup && destGroup.id !== group.id) {
                    currentlyMovingTabs.push(tabId);

                    if (-1 === savedTabIndex) {
                        let tabs = await getTabs(windowId);
                        savedTabIndex = tabs.findIndex(t => t.id === tabId);
                        group.tabs.splice(savedTabIndex, 0, mapTab(tab));
                    } else {
                        group.tabs[savedTabIndex] = mapTab(tab);
                    }

                    await moveTabToGroup(savedTabIndex, undefined, group.id, destGroup.id);

                    currentlyMovingTabs.splice(currentlyMovingTabs.indexOf(tabId), 1);
                }
            }
        } else if ('complete' === tab.status) {
            if (isAllowUrl(tab.url)) { // if loading allowed tab
                if (-1 === savedTabIndex) { // if update NOT allowed tab -> to allowed tab
                    currentlyAddingTabs.push(tabId);

                    let tabs = await getTabs(windowId),
                        tabIndex = tabs.findIndex(t => t.id === tabId); // find new tab index

                    if (-1 === tabIndex) {
                        currentlyAddingTabs.splice(currentlyAddingTabs.indexOf(tabId), 1);
                        return;
                    }

                    group.tabs.splice(tabIndex, 0, mapTab(tab)); // add new tab to position if prev tab are not allowed

                    currentlyAddingTabs.splice(currentlyAddingTabs.indexOf(tabId), 1);
                } else {
                    if (group.tabs[savedTabIndex].url !== tab.url) {
                        group.tabs[savedTabIndex].thumbnail = null;
                    }

                    group.tabs[savedTabIndex].id = tab.id;
                    group.tabs[savedTabIndex].title = tab.title;
                    group.tabs[savedTabIndex].url = normalizeUrl(tab.url);
                    group.tabs[savedTabIndex].active = tab.active;
                    group.tabs[savedTabIndex].favIconUrl = tab.favIconUrl;
                }

                saveGroupsToStorage();

                updateTabThumbnail(windowId, tabId);
            } else { // if url NOT supported
                if (-1 === savedTabIndex) { // if prev tab are not found (it's not allowed)
                    // do nothing
                } else {
                    group.tabs.splice(savedTabIndex, 1); // if found prev tab index - remove this tab (loading not allow url instead of allow)
                    saveGroupsToStorage();
                }
            }
        }
    }

    async function onRemovedTab(tabId, { isWindowClosing, windowId }) {
        // console.log('onRemovedTab', arguments);

        if (isWindowClosing) {
            return;
        }

        let group = _groups.find(gr => gr.windowId === windowId);

        if (!group) {
            return;
        }

        let removedTabIndex = group.tabs.findIndex(tab => tab.id === tabId);

        if (-1 === removedTabIndex) { // if tab is no allowed
            return;
        }

        group.tabs.splice(removedTabIndex, 1);

        saveGroupsToStorage();
    }

    async function onMovedTab(tabId, { windowId, fromIndex, toIndex }) {
        // console.log('onMovedTab', tabId, { windowId, fromIndex, toIndex });

        let group = _groups.find(gr => gr.windowId === windowId);

        if (!group) {
            return;
        }

        let tabs = await getTabs(windowId),
            oldTabIndex = tabs.findIndex(t => t.index === fromIndex),
            newTabIndex = tabs.findIndex(t => t.index === toIndex),
            oldSavedTabIndex = group.tabs.findIndex(tab => tab.id === tabId);

        if (-1 === oldTabIndex || -1 === newTabIndex || -1 === oldSavedTabIndex) {
            return;
        }

        group.tabs.splice(newTabIndex, 0, group.tabs.splice(oldSavedTabIndex, 1)[0]);

        saveGroupsToStorage();
    }

    async function onAttachedTab(tabId, { newWindowId }) {
        let tab = await browser.tabs.get(tabId),
            tabs = await getTabs(newWindowId),
            group = _groups.find(gr => gr.windowId === newWindowId),
            tabIndex = tabs.findIndex(({ id }) => id === tabId),
            newTabId = tabId;

        if (-1 === tabIndex) { // if tab not allowed
            // FF BUG: attached tab has new tab id :( https://bugzilla.mozilla.org/show_bug.cgi?id=1426872 https://bugzilla.mozilla.org/show_bug.cgi?id=1398272
            newTabId = Math.max.apply(Math, tabs.map(tab => tab.id));
            tabIndex = tabs.findIndex(({ id }) => id === newTabId);

            if (tab.url !== tabs[tabIndex].url) { // if tab really not allowed, FF BUG
                return;
            }
        }

        if (!group) {
            let options = await storage.get('createNewGroupAfterAttachTabToNewWindow');

            if (options.createNewGroupAfterAttachTabToNewWindow) {
                let newGroupIndex = await addGroup(newWindowId);

                if (isAllowTab(tab)) {
                    _groups[newGroupIndex].tabs.push(mapTab(tab));
                    saveGroupsToStorage();
                }
            }
        } else {
            if (isAllowTab(tab)) {
                if (group.tabs.some(t => t.id === newTabId)) { // if tab are added in another func (FF WTF??? call update tab event before attached?)
                    group.tabs[tabIndex] = mapTab(tab);
                } else {
                    group.tabs.splice(tabIndex, 0, mapTab(tab));
                }

                group.tabs[tabIndex].id = tabId; // TMP FF bug 1426872

                saveGroupsToStorage();
            }
        }
    }

    // FF BUG: onDetached tabid is wrong https://bugzilla.mozilla.org/show_bug.cgi?id=1426872 https://bugzilla.mozilla.org/show_bug.cgi?id=1398272
    async function onDetachedTab(tabId, { oldWindowId }) {
        let oldGroup = _groups.find(gr => gr.windowId === oldWindowId);

        if (!oldGroup) {
            return;
        }

        let tabIndex = oldGroup.tabs.findIndex(tab => tab.id === tabId);

        if (-1 === tabIndex) { // if tab is not allowed
            return;
        }

        oldGroup.tabs.splice(tabIndex, 1);
        saveGroupsToStorage();
    }

    let lastFocusedWinId = null,
        lastFocusedNormalWindow = null; // fix bug with browser.windows.getLastFocused({windowTypes: ['normal']}), maybe find exists bug??

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

        if ('normal' === win.type && !win.incognito) {
            lastFocusedNormalWindow = win;
        }

        lastFocusedWinId = windowId;
    }

    // if oldGroupId === null, move tab from current window without group
    async function moveTabToGroup(oldTabIndex, newTabIndex = -1, oldGroupId = null, newGroupId, showNotificationAfterMoveTab = true) {
        let oldGroup = null,
            newGroup = _groups.find(gr => gr.id === newGroupId),
            tab = null,
            callSaveGroups = false,
            createdTabId = null,
            createdTabIndex = null,
            tmpTabs = [];

        if (oldGroupId) {
            oldGroup = _groups.find(gr => gr.id === oldGroupId);
            tab = oldGroup.tabs[oldTabIndex];
        } else {
            tmpTabs = await getTabs();
            tab = mapTab(tmpTabs[oldTabIndex]);
        }

        if (!tab) { // tmp
            return log('error moveTabToGroup: tab not found', [oldTabIndex, newTabIndex, oldGroupId, newGroupId, showNotificationAfterMoveTab, (oldGroup && oldGroup.tabs.length), tmpTabs.length]);
        }

        if (oldGroupId === newGroupId) { // if it's same group
            let win = await getWindowByGroup(newGroup);

            if (win) {
                tmpTabs = await getTabs(newGroup.windowId);

                await browser.tabs.move(tmpTabs[oldTabIndex].id, {
                    index: -1 === newTabIndex ? -1 : tmpTabs[newTabIndex].index,
                });
            } else {
                if (-1 === newTabIndex) { // push to end of group
                    newTabIndex = newGroup.tabs.length;
                }

                if (newTabIndex !== oldTabIndex) {
                    newGroup.tabs.splice(newTabIndex, 0, newGroup.tabs.splice(oldTabIndex, 1)[0]);
                    callSaveGroups = true;
                }
            }
        } else { // if it's different group
            if (oldGroupId) { // remove tab
                let win = await getWindowByGroup(oldGroup);

                if (win) {
                    await removeCurrentTabByIndex(oldGroup.windowId, oldTabIndex);
                } else {
                    oldGroup.tabs.splice(oldTabIndex, 1);
                    callSaveGroups = true;
                }
            } else {
                await removeCurrentTabByIndex(undefined, oldTabIndex);
            }

            // add tab
            let win = await getWindowByGroup(newGroup);
            if (win) {
                let containers = await loadContainers(),
                    newTabObj = {
                        active: false,
                        url: tab.url,
                        windowId: newGroup.windowId,
                        cookieStoreId: normalizeCookieStoreId(tab.cookieStoreId, containers),
                    };

                if (-1 !== newTabIndex) {
                    tmpTabs = await browser.tabs.query({
                        windowId: newGroup.windowId,
                        pinned: false,
                    });

                    if (tmpTabs[newTabIndex]) {
                        newTabObj.index = tmpTabs[newTabIndex].index;
                    }
                }

                let newTab = await browser.tabs.create(newTabObj);

                createdTabId = newTab.id;

            } else {
                if (-1 === newTabIndex) {
                    createdTabIndex = newGroup.tabs.push(tab) - 1;
                } else {
                    newGroup.tabs.splice(newTabIndex, 0, tab);
                    createdTabIndex = newTabIndex;
                }

                callSaveGroups = true;
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

        notify(message).then(async function(createdTabId, createdTabIndex, newGroup) {
            await setFocusOnWindow(createdTabId ? newGroup.windowId : lastFocusedNormalWindow.id);

            if (createdTabId) {
                browser.tabs.update(createdTabId, {
                    active: true,
                });
            } else {
                let groupIndex = _groups.findIndex(group => group.id === newGroup.id);
                loadGroup(lastFocusedNormalWindow.id, groupIndex, createdTabIndex);
            }
        }.bind(null, createdTabId, createdTabIndex, newGroup));
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

                if (!isAllowUrl(tab.url)) {
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

    async function updateNewTabUrls() {
        let options = await storage.get(['enableFastGroupSwitching', 'enableFavIconsForNotLoadedTabs']),
            windows = await browser.windows.getAll({
                populate: true,
                windowTypes: ['normal'],
            });

        windows.forEach(function(win) {
            if ('normal' !== win.type || win.incognito) {
                return;
            }

            win.tabs.forEach(function(tab) {
                let extendResult = {};

                if (isStgNewTabUrl(tab.url, extendResult)) {
                    if (!extendResult.isOldUrl && options.enableFastGroupSwitching) {
                        return;
                    }

                    tab.url = revokeStgNewTabUrl(tab.url);

                    browser.tabs.update(tab.id, {
                        url: options.enableFastGroupSwitching ? createStgTabNewUrl(tab, options.enableFavIconsForNotLoadedTabs) : tab.url,
                        // loadReplace: true, // FF >= 57
                    });
                }
            });
        });
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

    function setLoadingToBrowserAction() {
        browser.browserAction.setIcon({
            path: '/icons/animate-spinner.svg',
        });
    }

    window.background = {
        inited: false,

        log,
        getLogs: () => errorLogs,

        openManageGroups,

        getGroups: () => _groups,

        createWindow,
        getWindow,
        getWindowByGroup,

        getTabs,
        moveTabToGroup,
        updateNewTabUrls,

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



        data.version = MANIFEST.version;

        if (keysToRemoveFromStorage.length) {
            await storage.remove(keysToRemoveFromStorage);
        }
        // end migration

        return data;
    }

    setLoadingToBrowserAction();

    // fix FF bug on browser.windows.getAll ... function not return all windows
    async function getAllWindows() {
        let allTabs = await browser.tabs.query({
            pinned: false,
        });

        return Promise.all(
            allTabs
                .reduce((acc, tab) => acc.includes(tab.windowId) ? acc : acc.concat([tab.windowId]), [])
                .map(winId => browser.windows.get(winId))
        );
    }

    // initialization
    storage.get(null)
        .then(async function(data) {
            let resultMigration = {};

            data = await runMigrateForData(data, resultMigration); // migration data

            if (resultMigration.errorMessage) {
                throw Error(resultMigration.errorMessage);
            }

            if (resultMigration.dataChanged) {
                await storage.set(data);
            }

            // fix FF bug on browser.windows.getAll ... function not return all windows
            let windows = await getAllWindows();

            windows = windows.filter(win => 'normal' === win.type && !win.incognito);

            lastFocusedNormalWindow = windows.find(win => win.focused) || windows[0];
            lastFocusedWinId = lastFocusedNormalWindow.id;

            async function getWindows() {
                // loading all tabs in all windows - FF bug on browser.windows.getAll with populate true and open window from shortcut on desktop
                return Promise.all(windows.map(async function(win) {
                    let tabs = await browser.tabs.query({
                        windowId: win.id,
                        pinned: false,
                    });

                    win.tabs = tabs
                        .filter(isAllowTab)
                        .map(function(tab) {
                            tab.url = normalizeUrl(tab.url);
                            return tab;
                        });

                    return win;
                }));
            }

            let tryCounter = 0;

            // wait load tabs
            await new Promise(function(resolve) {
                let timer = setInterval(async function() {
                    windows = await getWindows();

                    let someWinNotSync = windows.some(win => win.tabs.some(winTab => winTab.status === 'loading' && isEmptyUrl(winTab.url)));

                    tryCounter++;

                    if (!someWinNotSync || tryCounter > 30) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 1000);
            });


            let winTabs = {};
            windows.forEach(win => winTabs[win.id] = win.tabs);

            let syncedWinIds = [],
                groupHasBeenSync = true;

            data.groups.forEach(function(group) {
                if (!group.windowId) {
                    return;
                }

                let winCandidate = windows
                    .filter(win => !syncedWinIds.includes(win.id))
                    .find(function(win) {
                        if (win.id === group.windowId) {
                            syncedWinIds.push(win.id);
                            return true;
                        }

                        if (!group.tabs.length) {
                            return false;
                        }

                        if (winTabs[win.id].length < group.tabs.length) {
                            return false;
                        }

                        let syncedTabIds = [],
                            isTabsEqual = group.tabs.every(function(tab, tabIndex) {
                                let findTab = winTabs[win.id].find(t => !syncedTabIds.includes(t.id) && t.url === tab.url);

                                if (!findTab && winTabs[win.id][tabIndex] && winTabs[win.id][tabIndex].active) {
                                    findTab = winTabs[win.id][tabIndex];
                                }

                                if (findTab) {
                                    syncedTabIds.push(findTab.id);
                                }

                                return !!findTab;
                            });

                        if (isTabsEqual) {
                            syncedWinIds.push(win.id);
                            return true;
                        }

                        return false;
                    });

                if (winCandidate) {
                    group.windowId = winCandidate.id;
                    group.tabs = winTabs[winCandidate.id]
                        .map(function(tab, tabIndex) { // need if window id is equal but tabs are not equal
                            let mappedTab = mapTab(tab),
                                tabInGroup = group.tabs.find(t => t.url === mappedTab.url && t.thumbnail);

                            if (tabInGroup) {
                                mappedTab.thumbnail = tabInGroup.thumbnail;
                            }

                            return mappedTab;
                        });
                } else {
                    group.windowId = null;
                }

                if (!group.windowId) {
                    groupHasBeenSync = false;
                }
            });

            if (data.showNotificationIfGroupsNotSyncedAtStartup && !groupHasBeenSync && 0 === data.groups.filter(gr => gr.windowId).length) {
                notify(browser.i18n.getMessage('noOneGroupWasNotSynchronized'));
            }

            _groups = data.groups;

            await storage.set({
                groups: data.groups,
            });

            updateNewTabUrls();

            updateBrowserActionData();
            createMoveTabMenus();

            addEvents();

            window.background.inited = true;

            Object.keys(EXTENSIONS_WHITE_LIST)
                .forEach(function(exId) {
                    browser.runtime.sendMessage(exId, {
                        IAmBack: true,
                    });
                });
        })
        .catch(notify);

})()
