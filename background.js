(function() {
    'use strict';

    let _groups = [],
        currentlyLoadingGroups = {}; // windowId: true

    // return storage.get(null).then(console.log);

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

    function createGroup(id, windowId = null) {
        return {
            id,
            title: browser.i18n.getMessage('newGroupTitle', id),
            iconColor: randomColor(),
            iconUrl: null,
            tabs: [],
            catchTabRules: '',
            windowId: windowId,
        };
    }

    async function addGroup(windowId = null, resetGroups = false, returnNewGroupIndex = true, bindCurrentStateToThisGroup = false) {
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
            _groups[newGroupIndex].windowId = win.id;
        }

        if (0 === newGroupIndex && bindCurrentStateToThisGroup) {
            if (!win) {
                win = await getWindow();
            }

            _groups[newGroupIndex].windowId = win.id;

            let tabs = await getTabs(win.id);

            if (tabs.length) {
                _groups[newGroupIndex].tabs = tabs.map(mapTab);
            }

            updateBrowserActionData();
        }

        storage.set(options);

        saveGroupsToStorage();
        updateMoveTabMenus();

        return returnNewGroupIndex ? newGroupIndex : _groups[newGroupIndex];
    }

    // groups : Object or array of Object
    function saveGroup(group) {
        if (!group || (Array.isArray(group) && !group.length)) {
            return;
        }

        let groups = Array.isArray(group) ? group : [group];
        _groups = _groups.map(g => groups.find(({ id }) => id === g.id) || g);

        saveGroupsToStorage();
    }

    async function removeGroup(groupId) {
        let groupIndex = _groups.findIndex(gr => gr.id === groupId),
            groupWindowId = _groups[groupIndex].windowId;

        _groups.splice(groupIndex, 1);

        saveGroupsToStorage();

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
            throw Error;
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

                            if (options.enableFastGroupSwitching && !isEmptyUrl(tab.url) && !tab.active) {
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
            isStgNewTabUrl(tab.url) ||
            (tab.pinned && undefined === changeInfo.pinned)) { // pinned tabs are not supported
            return;
        }

        let savedTabIndex = group.tabs.findIndex(t => t.id === tabId);

        // console.log('onUpdatedTab\n tabId:', tabId, JSON.stringify(changeInfo) + '\n', JSON.stringify({ // TODO comment
        //     status: tab.status,
        //     url: tab.url,
        //     title: tab.title,
        // }));

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
            if (isAllowUrl(changeInfo.url) && !isEmptyUrl(changeInfo.url)) {
                let destGroup = _groups.find(gr => isCatchedUrl(changeInfo.url, gr));

                if (destGroup && destGroup.id !== group.id) {
                    currentlyMovingTabs.push(tabId);

                    if (-1 === savedTabIndex) {
                        let tabs = await getTabs(windowId);
                        savedTabIndex = tabs.findIndex(tab => tab.id === tabId);
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

        if (oldTabIndex === newTabIndex || -1 === oldTabIndex || -1 === newTabIndex || -1 === oldSavedTabIndex) {
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
            createdTabIndex = null;

        if (oldGroupId) {
            oldGroup = _groups.find(gr => gr.id === oldGroupId);
            tab = oldGroup.tabs[oldTabIndex];
        } else {
            let tabs = await getTabs();
            tab = mapTab(tabs[oldTabIndex]);
        }

        if (!tab) {
            return notify('TAB NOT fffound');
        }

        if (oldGroupId === newGroupId) { // if it's same group
            let win = await getWindowByGroup(newGroup);

            if (win) {
                let tabs = await getTabs(newGroup.windowId);

                await browser.tabs.move(tabs[oldTabIndex].id, {
                    index: -1 === newTabIndex ? -1 : tabs[newTabIndex].index,
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
                    let tabs = await browser.tabs.query({
                        windowId: newGroup.windowId,
                        pinned: false,
                    });

                    if (tabs[newTabIndex]) {
                        newTabObj.index = tabs[newTabIndex].index;
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
            contexts: ['tab'],
            onclick: function(info, tab) {
                if (tab.incognito) {
                    return;
                }

                let group = _groups.find(gr => gr.windowId === tab.windowId);

                if (!group) {
                    return;
                }

                group.iconUrl = tab.favIconUrl || null;

                updateBrowserActionData(group.windowId);
                updateMoveTabMenus(group.windowId);

                saveGroupsToStorage();
            }
        }));

        moveTabToGroupMenusIds.push(browser.menus.create({
            id: 'stg-move-tab-separator',
            type: 'separator',
            contexts: ['tab'],
        }));

        moveTabToGroupMenusIds.push(browser.menus.create({
            id: 'stg-move-tab-helper',
            title: browser.i18n.getMessage('moveTabToGroupDisabledTitle') + ':',
            enabled: false,
            contexts: ['tab'],
        }));

        _groups.forEach(function(group) {
            moveTabToGroupMenusIds.push(browser.menus.create({
                id: CONTEXT_MENU_PREFIX_GROUP + group.id,
                title: unSafeHtml(group.title),
                enabled: currentGroup ? group.id !== currentGroup.id : true,
                icons: {
                    16: createGroupSvgIconUrl(group),
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
        });

        moveTabToGroupMenusIds.push(browser.menus.create({
            id: 'stg-move-tab-new-group',
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

    function setBrowserActionData(currentGroup) {
        if (!currentGroup) {
            resetBrowserActionData();
            return;
        }

        browser.browserAction.setTitle({
            title: currentGroup.title + ' - ' + EXTENSION_NAME,
        });

        browser.browserAction.setIcon({
            path: getBrowserActionSvgPath(currentGroup),
        });
    }

    function resetBrowserActionData() {
        browser.browserAction.setTitle({
            title: MANIFEST.browser_action.default_title,
        });

        browser.browserAction.setIcon({
            path: MANIFEST.browser_action.default_icon,
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

        loadGroup(_groups[groupIndex].windowId, nextGroupIndex);
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
        let manageUrl = browser.extension.getURL('/manage/manage.html'),
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
            32: 'chrome://browser/skin/settings.svg',
        },
    });

    browser.runtime.onMessage.addListener(async function(request, sender, sendResponse) {
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
            let currentWindow = await getWindow(),
                currentGroup = _groups.find(gr => gr.windowId === currentWindow.id);

            if ('load-next-group' === request.runAction.id) {
                if (currentGroup) {
                    loadGroupPosition('next');
                }
            } else if ('load-prev-group' === request.runAction.id) {
                if (currentGroup) {
                    loadGroupPosition('prev');
                }
            } else if ('load-first-group' === request.runAction.id) {
                if (_groups[0]) {
                    loadGroup(currentWindow.id, 0);
                }
            } else if ('load-last-group' === request.runAction.id) {
                if (_groups[_groups.length - 1]) {
                    loadGroup(currentWindow.id, _groups.length - 1);
                }
            } else if ('load-custom-group' === request.runAction.id) {
                let groupIndex = _groups.findIndex(gr => gr.id === request.runAction.groupId);

                if (-1 !== groupIndex) {
                    loadGroup(currentWindow.id, groupIndex);
                }
            } else if ('add-new-group' === request.runAction.id) {
                addGroup();
            } else if ('delete-current-group' === request.runAction.id) {
                if (currentGroup) {
                    removeGroup(currentGroup.id);
                }
            } else if ('open-manage-groups' === request.runAction.id) {
                openManageGroups();
            }
        }
    });

    window.background = {
        inited: false,

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

        addTab,
        removeTab,

        createGroup,
        moveGroup,
        addGroup,
        saveGroup,
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


            getWindow().then(win => lastFocusedNormalWindow = win);

            function compareWinTabs(tabs, tab, tabIndex) {
                if (tab.url === tabs[tabIndex].url) {
                    return true;
                }

                if (isStgNewTabUrl(tabs[tabIndex].url)) {
                    return tab.url === revokeStgNewTabUrl(tabs[tabIndex].url);
                }
            }

            _groups = data.groups.map(function(group) {
                if (!group.windowId) {
                    return group;
                }

                let winCandidate = windows.find(function(win) {
                    if ('normal' !== win.type || win.incognito) {
                        return false;
                    }

                    if (group.windowId === win.id) {
                        return true;
                    }

                    let tabs = win.tabs.filter(isAllowTab);
                    if (group.tabs.length && group.tabs.length === tabs.length && group.tabs.every(compareWinTabs.bind(null, tabs))) {
                        return true;
                    }
                });

                if (winCandidate) {
                    group.windowId = winCandidate.id;
                    group.tabs = winCandidate.tabs
                        .filter(isAllowTab)
                        .map(function(tab, index) {
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

                return group;
            });

            window.background.inited = true;

            await storage.set({
                lastCreatedGroupPosition: data.lastCreatedGroupPosition,
                groups: _groups,
            });

            updateNewTabUrls();
            updateBrowserActionData();
            createMoveTabMenus();
            addEvents();
        })
        .catch(notify);

})()
