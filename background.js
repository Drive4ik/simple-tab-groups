(function() {
    'use strict';

    let _groups = [],
        currentlyLoadingGroups = {}; // windowId: true

    // return storage.get(null).then(console.log);

    async function saveGroupsToStorage(updateMenuItems = false) {
        browser.runtime.sendMessage({
            groupsUpdated: true,
        });

        await storage.set({
            groups: _groups,
        });

        if (true === updateMenuItems) {
            updateMoveTabMenus();
        }
    }

    async function getWindow(windowId = browser.windows.WINDOW_ID_CURRENT) {
        try {
            return await browser.windows.get(windowId);
        } catch (e) {}
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
        url = url || 'about:blank';
        return 'about:newtab' === url ? 'about:blank' : url;
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

    async function addGroup(windowId = null, resetGroups = false, returnNewGroupIndex = true) {
        let options = await storage.get('lastCreatedGroupPosition');

        options.lastCreatedGroupPosition++;

        if (resetGroups) {
            _groups = [];
        }

        let newGroupIndex = _groups.length;

        _groups.push(createGroup(options.lastCreatedGroupPosition, windowId));

        storage.set(options);

        saveGroupsToStorage(true);

        return returnNewGroupIndex ? newGroupIndex : _groups[newGroupIndex];
    }

    // groups : Object or array of Object
    function saveGroup(group, updateMenuItems) {
        if (!group || (Array.isArray(group) && !group.length)) {
            return;
        }

        let groups = Array.isArray(group) ? group : [group];
        _groups = _groups.map(g => groups.find(({ id }) => id === g.id) || g);
        saveGroupsToStorage(updateMenuItems);
    }

    async function removeGroup(oldGroup) {
        let oldGroupIndex = _groups.findIndex(group => oldGroup.id === group.id),
            getNewGroupIndex = function(oldIndex, newGroupsLength) {
                return (oldIndex > newGroupsLength - 1) ? (newGroupsLength - 1) : oldIndex;
            };

        if (-1 === oldGroupIndex) {
            return;
        }

        _groups.splice(oldGroupIndex, 1);
        saveGroupsToStorage();

        let oldGroupWindow = await getWindowByGroup(oldGroup);

        if (!oldGroupWindow) {
            return;
        }

        let currentWindow = await getWindow();

        if (oldGroupWindow.id === currentWindow.id) {
            let newGroupIndex = null;

            if (!_groups.length) { // if remove last group
                newGroupIndex = await addGroup(currentWindow.id, true) // reset all groups
            } else {
                newGroupIndex = getNewGroupIndex(oldGroupIndex, _groups.length);
            }

            await loadGroup(currentWindow.id, newGroupIndex);
        } else {
            await browser.windows.remove(oldGroupWindow.id);
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

        saveGroupsToStorage(true);
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

        group.tabs.push(newTab);

        saveGroupsToStorage();
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

    async function loadGroup(windowId, groupIndex, activeTabIndex = -1) {
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

                let oldTabIds = [],
                    tempEmptyTabId = null,
                    tempEmptyTabPromise = Promise.resolve(),
                    tabs = await getTabs(windowId),
                    isHasAnotherTabs = await hasAnotherTabs(windowId);

                browser.runtime.sendMessage({
                    loadingGroupPosition: 20,
                });

                group.tabs = group.tabs.filter(isAllowTab);

                oldTabIds = tabs.map(tab => tab.id);

                let oldGroup = _groups.find(gr => gr.windowId === windowId);
                if (oldGroup) {
                    oldGroup.windowId = null;
                }

                group.windowId = windowId;

                if (oldTabIds.length || !isHasAnotherTabs) { // create empty tab (for quickly change group and not blinking)
                    tempEmptyTabPromise = browser.tabs.create({
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

                await tempEmptyTabPromise

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
                                url = getStgTabNewUrl(tab, options.enableFavIconsForNotLoadedTabs);
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
        return new Promise(function(resolve) {
            browser.tabs.captureVisibleTab(windowId, {
                    format: 'png',
                })
                .then(function(thumbnailBase64) {
                    let img = new Image();

                    img.onload = function() {
                        resolve(resizeImage(img, 192, Math.floor(img.width * 192 / img.height), false));
                    };

                    img.src = thumbnailBase64;
                })
                .catch(function() {
                    resolve(null);
                });
        });
    }

    async function updateTabThumbnail(windowId, tabId) {
        let group = _groups.find(gr => gr.windowId === windowId);

        if (!group) {
            return;
        }

        let tabs = await getTabs(windowId),
            tabIndex = tabs.findIndex(tab => tab.active);

        if (-1 === tabIndex || tabs[tabIndex].id !== tabId) {
            return;
        }

        // if (!group.tabs[tabIndex]) {
        //     return console.error('updateTabThumbnail error: tabIndex not found', tabIndex, group);
        // }

        if (group.tabs[tabIndex].thumbnail) {
            return;
        }

        if (tabs[tabIndex].status === 'complete') {
            group.tabs[tabIndex].thumbnail = await getVisibleTabThumbnail(windowId);
            saveGroupsToStorage();
        }
    }

    async function onActivatedTab({ tabId, windowId }) {
        // console.log('onActivatedTab', { tabId, windowId });

        let group = _groups.find(gr => gr.windowId === windowId);

        if (!group) {
            return;
        }

        let activeTab = await browser.tabs.get(tabId);

        if (activeTab.incognito) {
            return;
        }

        let tabs = await getTabs(windowId),
            activeTabIndex = tabs.findIndex(tab => tab.id === activeTab.id);

        group.tabs = group.tabs.map(function(tab, index) {
            tab.active = index === activeTabIndex;
            return tab;
        });

        saveGroupsToStorage();
    }
/*
    async function onCreatedTab(tab) {
        console.log('onCreatedTab', tab);

        if (currentlyAddingTabs.includes(tab.id) || tab.incognito) {
            return;
        }

        let group = _groups.find(gr => gr.windowId === tab.windowId);

        if (!group) {
            return;
        }

        if (group.tabs.some(t => t.id === tab.id)) { // reject tabs if its created in update tab func (bug FF? call update tab event before create tab)
            return;
        }

        let tabs = await getTabs(tab.windowId),
            newTabIndex = tabs.findIndex(t => t.id === tab.id);

        if (-1 === newTabIndex) {
            return;
        }

        group.tabs.splice(newTabIndex, 0, mapTab(tab));

        saveGroupsToStorage();
    }
*/
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
            isExtensionNewTabUrl(tab.url) ||
            (tab.pinned && undefined === changeInfo.pinned)) { // pinned tabs are not supported
            return;
        }

        let savedTabIndex = group.tabs.findIndex(t => t.id === tabId);

        // console.log('onUpdatedTab\n tabId:', tabId, JSON.stringify(changeInfo) + '\n', JSON.stringify({
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
                    group.tabs[savedTabIndex].cookieStoreId = tab.cookieStoreId;
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

        let win = await browser.windows.getLastFocused({
            windowTypes: ['normal'],
        });

        if (win.incognito) {
            browser.browserAction.disable();
            resetBrowserActionData();
            removeMoveTabMenus();
        } else if (!lastFocusedWinId || lastFocusedWinId !== win.id) {
            browser.browserAction.enable();
            updateBrowserActionData(windowId);
            updateMoveTabMenus();
        }

        if ('normal' === win.type && !win.incognito) {
            lastFocusedNormalWindow = win;
        }

        lastFocusedWinId = win.id;
    }

    // function moveTabToGroup(tab, tabIndex, srcGroupId, destGroupId, showNotificationAfterMoveTab = true) {
    function moveTabToGroup(oldTabIndex, newTabIndex = -1, oldGroupId, newGroupId, showNotificationAfterMoveTab = true) {
        let oldGroup = _groups.find(({ id }) => id === oldGroupId),
            newGroup = _groups.find(({ id }) => id === newGroupId),
            tab = oldGroup.tabs[oldTabIndex],
            groupsToSave = [],
            promises = [],
            createdTabId = null,
            createdTabIndex = null;

        if (!tab) {
            notify('Error: wrong oldTabIndex in moveTabToGroup');
            return Promise.reject();
        }

        if (oldGroupId === newGroupId) { // if it's same group
            promises.push(getWindowByGroup(newGroup)
                .then(function(win) {
                    if (win) {
                        return getTabs(newGroup.windowId)
                            .then(function(tabs) {
                                return browser.tabs.move(tabs[oldTabIndex].id, {
                                    windowId: newGroup.windowId,
                                    index: -1 === newTabIndex ? -1 : tabs[newTabIndex].index,
                                });
                            });
                    } else {
                        if (-1 === newTabIndex) { // push to end of group
                            newTabIndex = newGroup.tabs.length;
                        }

                        if (newTabIndex !== oldTabIndex) {
                            newGroup.tabs.splice(newTabIndex, 0, newGroup.tabs.splice(oldTabIndex, 1)[0]);
                            groupsToSave.push(newGroup);
                        }
                    }
                }));
        } else { // if it's different group
            promises.push(getWindowByGroup(oldGroup)
                .then(function(win) {
                    if (win) {
                        return removeCurrentTabByIndex(oldGroup.windowId, oldTabIndex);
                    } else {
                        oldGroup.tabs.splice(oldTabIndex, 1);
                        groupsToSave.push(oldGroup);
                    }
                })
            );

            promises.push(getWindowByGroup(newGroup)
                .then(function(win) {
                    if (win) {
                        return new Promise(function(resolve) {
                                if (-1 === newTabIndex) {
                                    resolve(-1);
                                } else {
                                    browser.tabs.query({
                                            windowId: newGroup.windowId,
                                            pinned: false,
                                        })
                                        .then(tabs => tabs[newTabIndex].index)
                                        .then(resolve);
                                }
                            })
                            .then(async function(newBrowserTabIndex) {
                                let containers = await loadContainers(),
                                    createTabObj = {
                                        active: false,
                                        url: tab.url,
                                        windowId: newGroup.windowId,
                                        cookieStoreId: normalizeCookieStoreId(tab.cookieStoreId, containers),
                                    };

                                if (-1 !== newBrowserTabIndex) {
                                    createTabObj.index = newBrowserTabIndex;
                                }

                                return browser.tabs.create(createTabObj)
                                    .then(({ id }) => createdTabId = id);
                            });
                    } else {
                        if (-1 === newTabIndex) {
                            createdTabIndex = newGroup.tabs.push(tab) - 1;
                        } else {
                            newGroup.tabs.splice(newTabIndex, 0, tab);
                            createdTabIndex = newTabIndex;
                        }

                        groupsToSave.push(newGroup);
                    }
                })
            );
        }

        return Promise.all(promises)
            .then(() => saveGroup(groupsToSave))
            .then(() => storage.get('showNotificationAfterMoveTab'))
            .then(function(options) { // show notification
                if (!options.showNotificationAfterMoveTab || !showNotificationAfterMoveTab) {
                    return;
                }

                let title = tab.title.length > 50 ? (tab.title.slice(0, 50) + '...') : tab.title,
                    message = browser.i18n.getMessage('moveTabToGroupMessage', [newGroup.title, title]);

                notify(message).then(function(createdTabId, createdTabIndex, newGroup) {
                    if (createdTabId) {
                        setFocusOnWindow(newGroup.windowId)
                            .then(function() {
                                browser.tabs.update(createdTabId, {
                                    active: true,
                                });
                            });
                    } else {
                        setFocusOnWindow(lastFocusedNormalWindow.id)
                            .then(function() {
                                let groupIndex = _groups.findIndex(group => group.id === newGroup.id);
                                loadGroup(lastFocusedNormalWindow.id, groupIndex, createdTabIndex);
                            });
                    }
                }.bind(null, createdTabId, createdTabIndex, newGroup));
            });
    }

    let moveTabToGroupMenusIds = [];

    async function updateMoveTabMenus() {
        await removeMoveTabMenus();
        await createMoveTabMenus();
    }

    async function removeMoveTabMenus() {
        if (!moveTabToGroupMenusIds.length) {
            return;
        }

        await Promise.all(moveTabToGroupMenusIds.map(id => browser.menus.remove(id)));

        moveTabToGroupMenusIds = [];
    }

    async function createMoveTabMenus() {
        let win = await getWindow(),
            currentGroup = _groups.find(gr => gr.windowId === win.id);

        if (!currentGroup) {
            return;
        }

        moveTabToGroupMenusIds.push(browser.menus.create({
            id: 'stg-set-tab-icon-as-group-icon',
            title: browser.i18n.getMessage('setTabIconAsGroupIcon'),
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
            title: browser.i18n.getMessage('moveTabToGroupDisabledTitle'),
            enabled: false,
            contexts: ['tab'],
        }));

        _groups.forEach(function(group) {
            moveTabToGroupMenusIds.push(browser.menus.create({
                id: CONTEXT_MENU_PREFIX_GROUP + group.id,
                title: unSafeHtml(group.title),
                enabled: group.id !== currentGroup.id,
                icons: {
                    16: createGroupSvgIconUrl(group),
                },
                contexts: ['tab'],
                onclick: async function(destGroupId, info, tab) {
                    if (tab.incognito) {
                        return;
                    }

                    let group = _groups.find(gr => gr.windowId === tab.windowId);

                    if (!group) {
                        return;
                    }

                    let tabs = await getTabs(tab.windowId),
                        tabIndex = tabs.findIndex(({ id }) => id === tab.id);

                    if (-1 !== tabIndex) {
                        moveTabToGroup(tabIndex, undefined, group.id, destGroupId);
                    }
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
                if (tab.incognito) {
                    return;
                }

                let tabs = await getTabs(tab.windowId),
                    tabIndex = tabs.findIndex(({ id }) => id === tab.id);

                if (-1 === tabIndex) {
                    return;
                }

                let newGroupIndex = await addGroup();

                _groups[newGroupIndex].tabs.push(mapTab(tab));

                saveGroupsToStorage();

                let currentGroup = _groups.find(gr => gr.windowId === tab.windowId);

                if (currentGroup && currentGroup.windowId) {
                    removeCurrentTabByIndex(currentGroup.windowId, tabIndex);
                }
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
        // browser.tabs.onCreated.addListener(onCreatedTab);
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
        // browser.tabs.onCreated.removeListener(onCreatedTab);
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

    async function loadGroupByIndex(groupIndex) {
        if (!_groups[groupIndex]) {
            return;
        }

        let win = await getWindow();
        loadGroup(win.id, groupIndex);
    }

    async function initBrowserCommands() {
        browser.commands.onCommand.removeListener(browserCommandsLoadNextPrevGroupHandler);
        browser.commands.onCommand.removeListener(browserCommandsLoadByIndexGroupHandler);

        let options = await storage.get(['enableKeyboardShortcutLoadNextPrevGroup', 'enableKeyboardShortcutLoadByIndexGroup'])

        if (options.enableKeyboardShortcutLoadNextPrevGroup) {
            browser.commands.onCommand.addListener(browserCommandsLoadNextPrevGroupHandler);
        }

        if (options.enableKeyboardShortcutLoadByIndexGroup) {
            browser.commands.onCommand.addListener(browserCommandsLoadByIndexGroupHandler);
        }
    }

    function browserCommandsLoadNextPrevGroupHandler(command) {
        if ('group-prev' === command || 'group-next' === command) {
            loadGroupPosition(command.split('-').pop());
        }
    }

    function browserCommandsLoadByIndexGroupHandler(command) {
        if (command.startsWith('group-index')) {
            loadGroupByIndex(command.split('-').pop() - 1);
        }
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

    window.background = {
        inited: false,

        initBrowserCommands,

        getGroups: () => _groups,

        getWindow,
        getWindowByGroup,

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
        let keysToRemoveFromStorage = [];

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

            delete data.windowsGroup;
            keysToRemoveFromStorage.push('windowsGroup');
        }

        if (0 > data.version.localeCompare('2.1.2')) {
            data.groups = data.groups.map(function(group) {
                group.tabs = group.tabs.filter(Boolean);
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

            return [data, windows];
        })
        .then(function([data, windows]) {
            let newGroupCreated = false,
                winIds = windows.map(win => win.id);

            windows.forEach(function(win) {
                if ('normal' !== win.type || win.incognito) {
                    return;
                }

                if (!lastFocusedNormalWindow) {
                    lastFocusedNormalWindow = win;
                }

                let tabs = win.tabs.filter(isAllowTab);

                if (!data.groups.some(group => group.windowId === win.id)) { // if not found group for current window
                    let lastActiveGroupIndex = data.groups.findIndex(group => group.windowId !== null);

                    // if found last active group and tabs in last active group are equal
                    if (-1 !== lastActiveGroupIndex &&
                        data.groups[lastActiveGroupIndex].tabs.length === tabs.length &&
                        data.groups[lastActiveGroupIndex].tabs.every((tab, index) => tab.url === tabs[index].url)
                    ) {
                        data.groups[lastActiveGroupIndex].windowId = win.id;
                    } else { // add new group
                        if (!newGroupCreated) {
                            data.lastCreatedGroupPosition++;

                            newGroupCreated = true;

                            data.groups.push(createGroup(data.lastCreatedGroupPosition, win.id));
                            // notify('Group not found for this window or tabs not equal', 3000);
                        }
                    }
                }


                let groupIndex = data.groups.findIndex(group => group.windowId === win.id);

                if (-1 !== groupIndex) {
                    data.groups[groupIndex].tabs = tabs.map(function(tab) {
                        let mappedTab = mapTab(tab),
                            tabInGroup = data.groups[groupIndex].tabs.find(t => t.url === tab.url && t.thumbnail);

                        if (tabInGroup) {
                            mappedTab.thumbnail = tabInGroup.thumbnail;
                        }

                        if (isExtensionNewTabUrl(mappedTab.url)) {
                            mappedTab.url = new URL(mappedTab.url).searchParams.get('url') || 'about:blank';
                        }

                        return mappedTab;
                    });
                }
            });

            _groups = data.groups.map(function(group) { // clear unused window ids
                if (group.windowId && !winIds.includes(group.windowId)) {
                    group.windowId = null;
                }

                return group;
            });

            window.background.inited = true;

            return storage.set({
                lastCreatedGroupPosition: data.lastCreatedGroupPosition,
                groups: _groups,
            });
        })
        .then(() => updateBrowserActionData())
        .then(createMoveTabMenus)
        .then(initBrowserCommands)
        .then(addEvents)
        .catch(notify);

})()
