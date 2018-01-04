(function() {
    'use strict';

    let _groups = [],
        tmpWindowTabs = {}, // windowId: tabs array of tab
        currentlyLoadingGroups = {}; // windowId: true

    // return storage.get(null).then(console.log);

    function saveTemporaryTabs(windowId, tabs) { // real windowId
        if (tabs) {
            tmpWindowTabs[windowId] = tabs;
            return;
        }

        getTabs(windowId).then(tabs => tmpWindowTabs[windowId] = tabs);
    }

    function getTemporaryTabs(windowId) { // real windowId
        return tmpWindowTabs[windowId] || [];
    }

    async function saveGroupsToStorage(updateMenuItems = false) {
        browser.runtime.sendMessage({
            groupsUpdated: true,
        });

        await storage.set({
            groups: _groups,
        });

        if (true === updateMenuItems) {
            await updateMoveTabMenus();
        }
    }

    function getWindow(windowId = browser.windows.WINDOW_ID_CURRENT) {
        return browser.windows.get(windowId);
    }

    function setFocusOnWindow(windowId) {
        return browser.windows.update(windowId, {
            focused: true,
        });
    }

    async function getTabs(windowId = browser.windows.WINDOW_ID_CURRENT) {
        if (!windowId && windowId !== browser.windows.WINDOW_ID_CURRENT) {
            console.error('wrong windowId in getTabs func');
            return [];
        }

        try {
            let tabs = await browser.tabs.query({
                windowId,
                pinned: false,
            });

            return tabs.filter(tab => isAllowUrl(tab.url));
        } catch (e) {
            return [];
        }
    }

    function hasAnotherTabs(windowId = browser.windows.WINDOW_ID_CURRENT, eachFunc = 'some') {
        return browser.tabs.query({
                windowId,
            })
            .then(tabs => tabs[eachFunc](tab => tab.pinned || !isAllowUrl(tab.url)));
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
            tabs: [],
            catchTabRules: '',
            windowId: windowId,
        };
    }

    function addGroup(windowId = null, resetGroups = false, returnNewGroupIndex = true) {
        return storage.get('lastCreatedGroupPosition')
            .then(function({ lastCreatedGroupPosition }) {
                lastCreatedGroupPosition++;

                if (resetGroups) {
                    _groups = [];
                }

                let newGroupIndex = _groups.length;

                _groups.push(createGroup(lastCreatedGroupPosition, windowId));

                storage.set({
                    lastCreatedGroupPosition,
                });

                saveGroupsToStorage(true);

                return returnNewGroupIndex ? newGroupIndex : _groups[newGroupIndex];
            });
    }

    // groups : Object or array of Object
    function saveGroup(group, updateMenuItems) {
        if (!group || !group.length) {
            return;
        }

        let groups = Array.isArray(group) ? group : [group];
        _groups = _groups.map(g => groups.find(({ id }) => id === g.id) || g);
        saveGroupsToStorage(updateMenuItems);
    }

    function removeGroup(oldGroup) {
        let oldGroupIndex = _groups.findIndex(group => oldGroup.id === group.id),
            getNewGroupIndex = function(oldIndex, newGroupsLength) {
                return (oldIndex > newGroupsLength - 1) ? (newGroupsLength - 1) : oldIndex;
            };

        _groups.splice(oldGroupIndex, 1);

        return Promise.all([
                getWindowByGroup(oldGroup),
                getWindow()
            ])
            .then(function([oldGroupWindow, currentWindow]) {
                if (!oldGroupWindow) {
                    return;
                }

                if (oldGroupWindow.id === currentWindow.id) {
                    if (!_groups.length) { // if remove last group
                        return addGroup(currentWindow.id, true) // reset all groups
                            .then(newGroupIndex => loadGroup(currentWindow.id, newGroupIndex));
                    } else {
                        let newGroupIndex = getNewGroupIndex(oldGroupIndex, _groups.length);
                        return loadGroup(currentWindow.id, newGroupIndex);
                    }
                } else {
                    return browser.windows.remove(oldGroupWindow.id);
                }
            })
            .then(saveGroupsToStorage.bind(null, true));
    }

    function moveGroup(groupId, position = 'up') {
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

        return saveGroupsToStorage(true);
    }

    function getWindowByGroup(group) {
        if (!group.windowId) {
            return Promise.resolve();
        }

        return new Promise(function(resolve) {
            browser.windows.get(group.windowId, {
                    populate: false,
                    windowTypes: ['normal'],
                })
                .then(win => resolve(win))
                .catch(() => resolve());
        });
    }

    function addTab(group, cookieStoreId) {
        return getWindowByGroup(group)
            .then(function(win) {
                if (win) {
                    return browser.tabs.create({ // after this - will trigger events on create tab and add tab in group
                        active: false,
                        url: 'about:blank',
                        cookieStoreId,
                        windowId: group.windowId,
                    });
                } else {
                    let groupIndex = _groups.findIndex(gr => gr.id === group.id);
                    _groups[groupIndex].tabs.push({
                        active: false,
                        url: 'about:blank',
                        cookieStoreId,
                    });

                    return saveGroupsToStorage();
                }
            });
    }

    function removeCurrentTabByIndex(windowId, tabIndex) {
        return Promise.all([
                getTabs(windowId),
                hasAnotherTabs(windowId)
            ])
            .then(function([tabs, isHasAnotherTabs]) {
                let tabId = tabs[tabIndex].id;

                if (!isHasAnotherTabs && 1 === tabs.length) {
                    return browser.tabs.create({
                            active: true,
                            windowId,
                            url: 'about:blank',
                        })
                        .then(() => tabId);
                }

                return tabId;
            })
            .then(browser.tabs.remove);
    }

    function removeTab(tabIndex, group) {
        return getWindowByGroup(group)
            .then(function(win) {
                if (win) {
                    return removeCurrentTabByIndex(group.windowId, tabIndex);
                } else {
                    let groupIndex = _groups.findIndex(gr => gr.id === group.id);
                    _groups[groupIndex].tabs.splice(tabIndex, 1);
                    return saveGroupsToStorage();
                }
            });
    }

    function loadGroup(windowId, groupIndex, activeTabIndex = -1) {
        if (!windowId) { // if click on notification after moving tab to window which is now closed :)
            // console.error('loadGroup: wrong windowId');
            return Promise.reject();
        }

        if (currentlyLoadingGroups[windowId]) {
            notify(browser.i18n.getMessage('errorAnotherGroupAreLoading'), 5000, 'error-load-group-notification');
            return Promise.reject();
        }

        if (!_groups[groupIndex]) {
            return Promise.reject('group index not found ' + groupIndex);
        }

        currentlyLoadingGroups[windowId] = true;

        return getWindowByGroup(_groups[groupIndex])
            .then(function(win) {
                if (win) {
                    if (-1 === activeTabIndex) {
                        setFocusOnWindow(win.id);
                    } else {
                        getTabs(win.id)
                            .then(function(tabs) {
                                return browser.tabs.update(tabs[activeTabIndex].id, {
                                    active: true,
                                });
                            })
                            .then(function() {
                                setFocusOnWindow(win.id);
                            });
                    }
                } else {
                    // magic

                    removeEvents();

                    browser.runtime.sendMessage({
                        loadingGroupPosition: 10,
                    });

                    let oldTabIds = [],
                        tempEmptyTabId = null,
                        tempEmptyTabPromise = Promise.resolve();

                    return Promise.all([
                            getTabs(windowId),
                            hasAnotherTabs(windowId)
                        ])
                        .then(function([tabs, isHasAnotherTabs]) {
                            browser.runtime.sendMessage({
                                loadingGroupPosition: 20,
                            });

                            oldTabIds = tabs.map(tab => tab.id);

                            let oldGroupIndex = _groups.findIndex(group => group.windowId === windowId);

                            if (-1 !== oldGroupIndex) {
                                _groups[oldGroupIndex].windowId = null;
                            }

                            _groups[groupIndex].windowId = windowId;

                            if (oldTabIds.length || !isHasAnotherTabs) { // create empty tab (for quickly change group and not blinking)
                                tempEmptyTabPromise = browser.tabs.create({
                                        active: true,
                                        url: 'about:blank',
                                        windowId: windowId,
                                    })
                                    .then(tab => tempEmptyTabId = tab.id);
                            }

                            if (!_groups[groupIndex].tabs.length && !isHasAnotherTabs) {
                                _groups[groupIndex].tabs.push({
                                    active: true,
                                    url: 'about:blank',
                                    cookieStoreId: DEFAULT_COOKIE_STORE_ID,
                                });
                            }

                            return tempEmptyTabPromise;
                        })
                        .then(function() { // remove tabs
                            browser.runtime.sendMessage({
                                loadingGroupPosition: 50,
                            });

                            if (oldTabIds.length) {
                                return browser.tabs.remove(oldTabIds);
                            }
                        })
                        .then(function() { // create tabs
                            browser.runtime.sendMessage({
                                loadingGroupPosition: 90,
                            });

                            if (_groups[groupIndex].tabs.length) {
                                return Promise.all(_groups[groupIndex].tabs.map(function(tab, tabIndex) {
                                    tab.active = -1 === activeTabIndex ? Boolean(tab.active) : tabIndex === activeTabIndex;

                                    return browser.tabs.create({
                                        active: tab.active,
                                        url: tab.url,
                                        windowId: windowId,
                                        cookieStoreId: tab.cookieStoreId || DEFAULT_COOKIE_STORE_ID,
                                    });
                                }))
                                .then(newTabs => newTabs.forEach((tab, tabIndex) => _groups[groupIndex].tabs[tabIndex].id = tab.id)); // update tabs id
                            }
                        })
                        // .then(function(tabs) { // TODO - add discard tabs (bugs found)
                        //     if (browser.tabs.discard && tabs) {
                        //         let discardedTabs = tabs.filter(tab => !tab.active).map(tab => tab.id);
                        //         return browser.tabs.discard(discardedTabs);
                        //     }
                        // })
                        .then(function() {
                            if (tempEmptyTabId) {
                                return browser.tabs.remove(tempEmptyTabId);
                            }
                        })
                        .then(function() {
                            browser.runtime.sendMessage({
                                loadingGroupPosition: false,
                            });

                            saveGroupsToStorage();

                            saveTemporaryTabs(windowId);

                            updateBrowserActionData(windowId);

                            addEvents();
                        });
                }
            })
            .then(function() {
                delete currentlyLoadingGroups[windowId];

                browser.notifications.clear('error-load-group-notification');
            })
            .catch(function(e) {
                delete currentlyLoadingGroups[windowId];
                notify(e);
                throw e;
            });

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
                        let _resizeCanvas = document.createElement('canvas'); // resize image
                        _resizeCanvas.mozOpaque = true;

                        let _resizeCanvasCtx = _resizeCanvas.getContext('2d');

                        let height = 192,
                            width = Math.floor(img.width * 192 / img.height);

                        _resizeCanvas.width = width;
                        _resizeCanvas.height = height;
                        _resizeCanvasCtx.drawImage(img, 0, 0, width, height);

                        resolve(_resizeCanvas.toDataURL());
                    };

                    img.src = thumbnailBase64;
                })
                .catch(function() {
                    resolve(null);
                });
        });
    }

    async function updateTabThumbnail(windowId, tabId, tabs = null) {
        let group = _groups.find(group => group.windowId === windowId);

        if (!group) {
            return;
        }

        if (!tabs) {
            tabs = await getTabs(windowId);
        }

        let tabIndex = tabs.findIndex(tab => tab.active);

        if (-1 === tabIndex || tabs[tabIndex].id !== tabId) {
            return;
        }

        // if (group.tabs[tabIndex].thumbnail && group.tabs[tabIndex].url === tabs[tabIndex].url) {
        //     return;
        // }

        // if (!group.tabs[tabIndex]) {
        //     return console.error('updateTabThumbnail error: tabIndex not found', tabIndex, group.tabs, group);
        // }

        if (group.tabs[tabIndex].thumbnail && group.tabs[tabIndex].url === tabs[tabIndex].url) {
            return;
        }

        if (tabs[tabIndex].status === 'complete') {
            group.tabs[tabIndex].thumbnail = await getVisibleTabThumbnail(windowId);
            saveGroupsToStorage();
        }
    }


    async function onActivatedTab({ tabId, windowId }) {
        console.log('onActivatedTab', { tabId, windowId });

        let groupIndex = _groups.findIndex(group => group.windowId === windowId);

        if (-1 === groupIndex) {
            return;
        }

        try {
            await browser.tabs.get(tabId);
        } catch (e) {
            return;
        }

        let tabs = await getTabs(windowId),
            activeTabIndex = tabs.findIndex(tab => tab.id === tabId);

        _groups[groupIndex].tabs = _groups[groupIndex].tabs.map(function(tab, index) {
            tab.active = index === activeTabIndex;
            return tab;
        });

        updateTabThumbnail(windowId, tabId, tabs);
        saveGroupsToStorage();
    }

    async function onCreatedTab(tab) {
        console.log('onCreatedTab', tab);

        if (currentlyAddingTabs.includes(tab.id)) {
            return;
        }

        let groupIndex = _groups.findIndex(group => group.windowId === tab.windowId);

        if (-1 === groupIndex) {
            return;
        }

        let tabs = await getTabs(tab.windowId),
            newTabIndex = tabs.findIndex(t => t.id === tab.id);

        if (-1 === newTabIndex) {
            return;
        }

        _groups[groupIndex].tabs.splice(newTabIndex, 0, mapTab(tab));

        saveTemporaryTabs(tab.windowId, tabs); // save locale tabs
        saveGroupsToStorage();
    }

    let currentlyMovingTabs = [], // tabIds // expample: open tab from bookmark and move it to other group: many calls method onUpdatedTab
        currentlyAddingTabs = [];

    async function onUpdatedTab(tabId, changeInfo, tab) {
        let windowId = tab.windowId,
            groupIndex = _groups.findIndex(group => group.windowId === windowId);

        if (-1 === groupIndex ||
            currentlyLoadingGroups[windowId] ||
            currentlyMovingTabs.includes(tabId) || // reject processing tabs
            currentlyAddingTabs.includes(tabId) || // reject processing tabs
            'isArticle' in changeInfo || // not supported reader mode now
            'discarded' in changeInfo || // not supported discard tabs now
            (tab.pinned && undefined === changeInfo.pinned)) { // pinned tabs are not supported
            return;
        }

        if (Object.keys(changeInfo).length === 1 && changeInfo.favIconUrl && tab.status === 'complete' && tab.url === 'about:newtab') {
            return; // bug FF: call update tab event before create tab event :(
        }

        let savedTabIndex = _groups[groupIndex].tabs.findIndex(t => t.id === tabId);

        console.log('onUpdatedTab\n', JSON.stringify(changeInfo)+'\n', JSON.stringify({
            status: tab.status,
            url: tab.url,
            title: tab.title,
        }));

        if ('pinned' in changeInfo) {
            if (isAllowUrl(tab.url)) {
                if (changeInfo.pinned) {
                    if (-1 !== savedTabIndex) {
                        _groups[groupIndex].tabs.splice(savedTabIndex, 1); // remove pinned tab
                    }
                } else {
                    _groups[groupIndex].tabs.unshift(mapTab(tab)); // add unpinned tab
                }

                saveGroupsToStorage();
                saveTemporaryTabs(windowId);
            }

            return;
        }

        if ('loading' === changeInfo.status && changeInfo.url) {
            if (isAllowUrl(changeInfo.url) && !isEmptyUrl(changeInfo.url)) {
                let destGroup = _groups.find(group => isCatchedUrl(changeInfo.url, group));

                if (destGroup && destGroup.id !== _groups[groupIndex].id) {
                    currentlyMovingTabs.push(tabId);

                    if (-1 === savedTabIndex) {
                        let tabs = await getTabs(windowId);
                        savedTabIndex = tabs.findIndex(tab => tab.id === tabId);
                        _groups[groupIndex].tabs.splice(savedTabIndex, 0, mapTab(tab));
                    } else {
                        _groups[groupIndex].tabs[savedTabIndex] = mapTab(tab);
                    }

                    await moveTabToGroup(savedTabIndex, undefined, _groups[groupIndex].id, destGroup.id);

                    currentlyMovingTabs.splice(currentlyMovingTabs.indexOf(tabId), 1);
                }
            }
        } else if ('complete' === tab.status) {
            if (isAllowUrl(tab.url)) { // if loading allowed tab

                if (-1 === savedTabIndex) { // if update NOT allowed tab -> to allowed tab
                    currentlyAddingTabs.push(tabId);

                    let tabs = await getTabs(windowId),
                        tabIndex = tabs.findIndex(t => t.id === tabId); // find new tab index

                    _groups[groupIndex].tabs.splice(tabIndex, 0, mapTab(tab)); // add new tab to position if prev tab are not allowed

                    currentlyAddingTabs.splice(currentlyAddingTabs.indexOf(tabId), 1);
                } else {
                    if (_groups[groupIndex].tabs[savedTabIndex].url !== tab.url) {
                        _groups[groupIndex].tabs[savedTabIndex].thumbnail = null;
                    }

                    _groups[groupIndex].tabs[savedTabIndex].title = tab.title;
                    _groups[groupIndex].tabs[savedTabIndex].url = tab.url;
                    _groups[groupIndex].tabs[savedTabIndex].active = tab.active;
                    _groups[groupIndex].tabs[savedTabIndex].favIconUrl = tab.favIconUrl;
                    _groups[groupIndex].tabs[savedTabIndex].cookieStoreId = tab.cookieStoreId;
                }

                saveGroupsToStorage();
            } else { // if loading tab are NOT supported
                if (-1 === savedTabIndex) { // if prev tab are not found (it's not allowed)
                    // do nothing
                } else {
                    _groups[groupIndex].tabs.splice(savedTabIndex, 1); // if found prev tab index - remove this tab (loading not allow url instead of allow)
                    saveGroupsToStorage();
                }
            }

            updateTabThumbnail(windowId, tabId);
        }

        saveTemporaryTabs(windowId);
    }

    function onRemovedTab(tabId, { isWindowClosing, windowId }) {
        console.log('onRemovedTab', arguments);

        if (isWindowClosing) {
            return;
        }

        let groupIndex = _groups.findIndex(group => group.windowId === windowId);

        if (-1 === groupIndex) {
            return;
        }

        let removedTabIndex = _groups[groupIndex].tabs.findIndex(tab => tab.id === tabId);

        if (-1 === removedTabIndex) { // if tab is no allowed
            return;
        }

        _groups[groupIndex].tabs.splice(removedTabIndex, 1);

        saveTemporaryTabs(windowId); // save locale tabs
        saveGroupsToStorage();
    }

    function onMovedTab(tabId, { windowId, fromIndex, toIndex }) {
        // console.log('onMovedTab', arguments);

        let groupIndex = _groups.findIndex(group => group.windowId === windowId);

        if (-1 === groupIndex) {
            return;
        }

        Promise.all([
                browser.tabs.get(tabId),
                getTabs(windowId)
            ])
            .then(function([tab, tabs]) {

                let isAllowedTab = isAllowUrl(tab.url);

                if (tab.pinned || tab.incognito || !isAllowedTab) {
                    if (!isAllowedTab && !tab.pinned && !tab.incognito) { // save only needed window tabs
                        saveTemporaryTabs(windowId, tabs);
                    }

                    return;
                }

                let oldTabIndex = getTemporaryTabs(windowId).findIndex(tab => tab.index === fromIndex),
                    newTabIndex = tabs.findIndex(tab => tab.index === toIndex);

                if (oldTabIndex === newTabIndex) { // position not changed
                    return;
                }

                _groups[groupIndex].tabs.splice(newTabIndex, 0, _groups[groupIndex].tabs.splice(oldTabIndex, 1)[0]);

                saveTemporaryTabs(windowId, tabs); // save locale tabs

                saveGroupsToStorage();
            });
    }

    function onAttachedTab(tabId, { newWindowId }) {
        Promise.all([
                browser.tabs.get(tabId),
                getTabs(newWindowId),
                storage.get('createNewGroupAfterAttachTabToNewWindow')
            ])
            .then(function([tab, tabs, { createNewGroupAfterAttachTabToNewWindow }]) {
                let groupIndex = _groups.findIndex(group => group.windowId === newWindowId),
                    tabIndex = tabs.findIndex(({ id }) => id === tabId);

                if (-1 === tabIndex) { // if tab not allowed
                    // BUG: in nightly ff attached tab has new tab id :(
                    tabId = Math.max.apply(Math, tabs.map(tab => tab.id));
                    tabIndex = tabs.findIndex(({ id }) => id === tabId);

                    if (tab.url !== tabs[tabIndex].url) {
                        return;
                    }
                }

                if (-1 === groupIndex) {
                    if (createNewGroupAfterAttachTabToNewWindow) {
                        saveTemporaryTabs(newWindowId, tabs);

                        addGroup(newWindowId)
                            .then(function(newGroupIndex) {
                                if (isAllowUrl(tab.url)) {
                                    _groups[newGroupIndex].tabs.push(mapTab(tab));
                                    saveGroupsToStorage();
                                }
                            });
                    }
                } else {
                    saveTemporaryTabs(newWindowId, tabs);

                    if (isAllowUrl(tab.url)) {
                        _groups[groupIndex].tabs.splice(tabIndex, 0, mapTab(tab));
                        saveGroupsToStorage();
                    }
                }
            });
    }

    function onDetachedTab(tabId, { oldWindowId }) {
        let oldGroupIndex = _groups.findIndex(group => group.windowId === oldWindowId);

        if (-1 === oldGroupIndex) {
            return;
        }

        let tabIndex = _groups[oldGroupIndex].tabs.findIndex(tab => tab.id === tabId);

        if (-1 === tabIndex) { // if tab is not allowed
            // BUG: in nightly ff onDetachedTab tabid is wrong :(
            /*
            let tabs = getTemporaryTabs(oldWindowId);
            tabId = Math.max.apply(Math, tabs.map(tab => tab.id));
            tabIndex = tabs.findIndex(({ id }) => id === tabId);

            if (tab.url !== tabs[tabIndex].url) {
                return;
            }
            /**/
            return;
        }

        _groups[oldGroupIndex].tabs.splice(tabIndex, 1);
        saveGroupsToStorage();

        saveTemporaryTabs(oldWindowId);
    }

    let lastFocusedWinId = null,
        lastFocusedNormalWindow = null; // fix bug with browser.windows.getLastFocused({windowTypes: ['normal']}), maybe find exists bug??

    function onFocusChangedWindow(windowId) {
        if (browser.windows.WINDOW_ID_NONE === windowId) {
            return;
        }

        browser.windows.getLastFocused({
                windowTypes: ['normal'],
            })
            .then(function(win) {
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
            });
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
                            })
                            .then(() => saveTemporaryTabs(win.id));
                    } else {
                        if (-1 === newTabIndex) { // push to end of group
                            newGroup.tabs.push(tab); // if is last tab - work ok :)
                            newGroup.tabs.splice(oldTabIndex, 1);
                        } else {
                            newGroup.tabs.splice(newTabIndex, 0, newGroup.tabs.splice(oldTabIndex, 1)[0]);
                        }
                        groupsToSave.push(newGroup);
                    }
                }));
        } else { // if it's different group
            promises.push(getWindowByGroup(oldGroup)
                .then(function(win) {
                    if (win) {
                        return removeCurrentTabByIndex(oldGroup.windowId, oldTabIndex)
                            .then(() => saveTemporaryTabs(win.id));
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
                            .then(function(newBrowserTabIndex) {
                                let createTabObj = {
                                    active: false,
                                    url: tab.url,
                                    windowId: newGroup.windowId,
                                    cookieStoreId: tab.cookieStoreId || DEFAULT_COOKIE_STORE_ID,
                                };

                                if (-1 !== newBrowserTabIndex) {
                                    createTabObj.index = newBrowserTabIndex;
                                }

                                return browser.tabs.create(createTabObj)
                                    .then(({ id }) => createdTabId = id);
                            })
                            .then(() => saveTemporaryTabs(win.id));
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

        moveTabToGroupMenusIds = [];

        await Promise.all(moveTabToGroupMenusIds.map(id => browser.menus.remove(id)));
    }

    async function createMoveTabMenus() {
        let win = await getWindow(),
            currentGroup = _groups.find(group => group.windowId === win.id);

        if (!currentGroup) {
            console.error('group for createMoveTabMenus not found');
            return;
        }

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
                    16: createGroupSvgColoredIcon(group.iconColor),
                },
                contexts: ['tab'],
                onclick: async function(destGroupId, info, tab) {
                    if (tab.incognito) {
                        return;
                    }

                    let group = _groups.find(group => group.windowId === tab.windowId),
                        tabs = await getTabs(tab.windowId),
                        tabIndex = tabs.findIndex(({ id }) => id === tab.id);

                    if (group && -1 !== tabIndex) {
                        moveTabToGroup(tabIndex, undefined, group.id, destGroupId);
                    }
                }.bind(null, group.id),
            }));
        });

        moveTabToGroupMenusIds.push(browser.menus.create({
            id: 'stg-move-tab-separator',
            type: 'separator',
            contexts: ['tab'],
        }));

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

                let currentGroup = _groups.find(group => group.windowId === tab.windowId);

                if (currentGroup && currentGroup.windowId) {
                    removeCurrentTabByIndex(currentGroup.windowId, tabIndex);
                }
            },
        }));
    }

    function setBrowserActionData(currentGroup) {
        if (!currentGroup) {
            return resetBrowserActionData();
        }

        browser.browserAction.setTitle({
            title: currentGroup.title + ' - ' + EXTENSION_NAME,
        });

        browser.browserAction.setIcon({
            path: getBrowserActionSvgPath(currentGroup.iconColor),
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

    function updateBrowserActionData(windowId) {
        if (windowId) {
            setBrowserActionData(_groups.find(group => group.windowId === windowId));
        } else {
            getWindow()
                .then(win => _groups.find(group => group.windowId === win.id))
                .then(setBrowserActionData);
        }
    }

    function onRemovedWindow(windowId) {
        let group = _groups.find(group => group.windowId === windowId);

        if (group) {
            group.windowId = null;
            saveGroupsToStorage();
        }
    }

    function addEvents() {
        browser.tabs.onCreated.addListener(onCreatedTab);
        browser.tabs.onActivated.addListener(onActivatedTab);
        browser.tabs.onUpdated.addListener(onUpdatedTab);
        browser.tabs.onRemoved.addListener(onRemovedTab);

        browser.tabs.onMoved.addListener(onMovedTab);

        browser.tabs.onAttached.addListener(onAttachedTab);
        browser.tabs.onDetached.addListener(onDetachedTab);

        browser.windows.onFocusChanged.addListener(onFocusChangedWindow);
        browser.windows.onRemoved.addListener(onRemovedWindow);
    }

    function removeEvents() {
        browser.tabs.onCreated.removeListener(onCreatedTab);
        browser.tabs.onActivated.removeListener(onActivatedTab);
        browser.tabs.onUpdated.removeListener(onUpdatedTab);
        browser.tabs.onRemoved.removeListener(onRemovedTab);

        browser.tabs.onMoved.removeListener(onMovedTab);

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

        loadGroup,

        mapTab,

        addTab,
        removeTab,

        createGroup,
        moveGroup,
        addGroup,
        saveGroup,
        removeGroup,
    };

    // initialization
    Promise.all([
            storage.get(null),
            browser.windows.getAll({
                populate: true,
                windowTypes: ['normal'],
            })
        ])
        .then(async function([result, windows]) { // migration
            let keysToRemoveFromStorage = [];

            if (result.version === MANIFEST.version) {
                return [result, windows];
            }

            let compareVersion = result.version.localeCompare(MANIFEST.version);

            if (1 === compareVersion) {
                throw 'Please, update addon to latest version';
            }

            // start migration
            if (0 >= result.version.localeCompare('1.8.1')) {
                result.groups = result.groups.map(function(group) {
                    group.windowId = result.windowsGroup[win.id] === group.id ? win.id : null;

                    group.catchTabRules = group.moveNewTabsToThisGroupByRegExp || '';
                    delete group.moveNewTabsToThisGroupByRegExp;

                    delete group.classList;
                    delete group.colorCircleHtml;

                    if (group.iconColor === undefined || group.iconColor === 'undefined') { // fix missed group icons :)
                        group.iconColor = randomColor();
                    }

                    return group;
                });

                delete result.windowsGroup;
                keysToRemoveFromStorage.push('windowsGroup');
            }

            if (0 >= result.version.localeCompare('1.8.2')) {
                // some code;
            }

            result.version = MANIFEST.version;

            if (keysToRemoveFromStorage.length) {
                await storage.remove(keysToRemoveFromStorage);
            }

            await storage.set(result, false);

            return [result, windows];

            // return new Promise(function(resolve) {
            //         if (keysToRemoveFromStorage.length) {
            //             storage.remove(keysToRemoveFromStorage).then(resolve);
            //         } else {
            //             resolve();
            //         }
            //     })
            //     .then(() => storage.set(result, false))
            //     .then(() => [result, windows]);
        })
        .then(function([result, windows]) {
            getWindow().then(win => lastFocusedNormalWindow = win);

            let newGroupCreated = false;

            windows.forEach(function(win) {
                if ('normal' !== win.type) {
                    return;
                }

                let tabs = win.tabs.filter(tab => isAllowUrl(tab.url));

                saveTemporaryTabs(win.id, tabs);

                if (!result.groups.some(group => group.windowId === win.id)) { // if not found group for current window
                    let lastActiveGroupIndex = result.groups.findIndex(group => group.windowId !== null);

                    // if found last active group and tabs in last active group are equal
                    if (-1 !== lastActiveGroupIndex &&
                        result.groups[lastActiveGroupIndex].tabs.length === tabs.length &&
                        result.groups[lastActiveGroupIndex].tabs.every((tab, index) => tab.url === tabs[index].url)
                    ) {
                        result.groups[lastActiveGroupIndex].windowId = win.id;
                    } else { // add new group
                        if (!newGroupCreated) {
                            result.lastCreatedGroupPosition++;

                            newGroupCreated = true;

                            result.groups.push(createGroup(result.lastCreatedGroupPosition, win.id));
                            // notify('Group not found for this window or tabs not equal', 3000);

                        }
                    }
                }


                let groupIndex = result.groups.findIndex(group => group.windowId === win.id);

                if (-1 !== groupIndex) {
                    result.groups[groupIndex].tabs = tabs.map(function(tab) {
                        let mappedTab = mapTab(tab),
                            tabInGroup = result.groups[groupIndex].tabs.find(t => t.url === tab.url && t.thumbnail);

                        if (tabInGroup) {
                            mappedTab.thumbnail = tabInGroup.thumbnail;
                        }

                        return mappedTab;
                    });
                }
            });

            _groups = result.groups;

            window.background.inited = true;

            return storage.set({
                lastCreatedGroupPosition: result.lastCreatedGroupPosition,
                groups: result.groups,
            });
        })
        .then(() => updateBrowserActionData())
        .then(createMoveTabMenus)
        .then(initBrowserCommands)
        .then(addEvents)
        .catch(notify);

})()
