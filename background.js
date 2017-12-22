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

    function saveGroupsToStorage(updateMenuItems = false) {
        browser.runtime.sendMessage({
            groupsUpdated: true,
        });

        return storage.set({
                groups: _groups,
            })
            .then(function() {
                if (true === updateMenuItems) {
                    return updateMoveTabMenus();
                }
            });
    }

    function getWindow(windowId = browser.windows.WINDOW_ID_CURRENT) {
        return browser.windows.get(windowId);
    }

    function setFocusOnWindow(windowId) {
        return browser.windows.update(windowId, {
            focused: true,
        });
    }

    function getTabs(windowId = browser.windows.WINDOW_ID_CURRENT) {
        return new Promise(function(resolve) {
            browser.tabs.query({
                    windowId,
                    pinned: false,
                })
                .then(function(tabs) {
                    resolve(tabs.filter(tab => isAllowUrl(tab.url)));
                })
                .catch(function() {
                    resolve([]);
                });
        });
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
            thumbnail: tab.thumbnail || null,
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

                updateMoveTabMenus();

                storage.set({
                    lastCreatedGroupPosition,
                });

                saveGroupsToStorage(true);

                return returnNewGroupIndex ? newGroupIndex : _groups[newGroupIndex];
            });
    }

    // groups : Object or array of Object
    function saveGroup(group) {
        let groups = Array.isArray(group) ? group : [group];
        _groups = _groups.map(g => groups.find(({ id }) => id === g.id) || g);
        return saveGroupsToStorage();
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
        let index = _groups.findIndex(({ id }) => id === groupId);

        if ('up' === position) {
            if (!index) {
                return;
            }

            _groups.splice(index - 1, 0, _groups.splice(index, 1)[0]);
        } else if ('down' === position) {
            if (index === _groups.length - 1) {
                return;
            }

            _groups.splice(index + 1, 0, _groups.splice(index, 1)[0]);
        } else if ('number' === type(position)) {
            _groups.splice(position, 0, _groups.splice(index, 1)[0]);
        }

        return saveGroupsToStorage(true);
    }

    function getGroupByWindowId(windowId) { // TODO remove promise
        return getWindow(windowId)
            .then(function(win) {
                if (!win) {
                    let groupIndex = _groups.findIndex(group => group.windowId === windowId);

                    if (-1 !== groupIndex) {
                        _groups[groupIndex].windowId = null;
                    }

                    console.error('window %s not found', windowId);
                    return;
                }

                return _groups.find(group => group.windowId === win.id);
            });
    }

    function getGroupIndexByWindowId(windowId) {
        return getGroupByWindowId(windowId)
            .then(function(group) {
                if (!group) {
                    return -1;
                }

                return _groups.findIndex(group => group.windowId === windowId);
            });
    }

    function getWindowByGroup(group, withTabs = false, filterTabs = true) {
        if (!group.windowId) {
            return Promise.resolve();
        }

        return new Promise(function(resolve) {
            browser.windows.get(group.windowId, {
                    populate: withTabs,
                    windowTypes: ['normal'],
                })
                .then(function(win) {
                    if (withTabs && filterTabs) {
                        win.tabs = win.tabs.filter(tab => !tab.pinned && isAllowUrl(tab.url));
                    }

                    resolve(win);
                })
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

    function removeCurrentTabByIndex(windowId, tabIndex, isLastTabInGroup) {
        return Promise.all([
                getTabs(windowId),
                hasAnotherTabs(windowId)
            ])
            .then(function([tabs, hasAnotherTabs]) {
                let tabId = tabs[tabIndex].id;

                if (!hasAnotherTabs && isLastTabInGroup) {
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
                    return removeCurrentTabByIndex(group.windowId, tabIndex, 1 === group.tabs.length);
                } else {
                    let groupIndex = _groups.findIndex(gr => gr.id === group.id);
                    _groups[groupIndex].tabs.splice(tabIndex, 1);
                    return saveGroupsToStorage();
                }
            });
    }

    function loadGroup(windowId, groupIndex, activeTabIndex = -1) { // TODO groupIndex
        if (!windowId) { // if click on notification after moving tab to window which is now closed :)
            console.warn('wrong windowId');
            return Promise.reject();
        }

        if (currentlyLoadingGroups[windowId]) {
            notify(browser.i18n.getMessage('errorAnotherGroupAreLoading'), 5000, 'error-load-group-notification');
            return Promise.resolve();
        }

        if (!_groups[groupIndex]) {
            throw 'group index not fonud ' + groupIndex;
        }

        return Promise.all([
                getWindowByGroup(_groups[groupIndex], true), // return window with tabs
                browser.windows.get(windowId) // if window not exists - notify me
            ])
            .then(function([win]) {
                if (win) {
                    let promise = Promise.resolve();

                    if (-1 !== activeTabIndex) {
                        promise = getTabs(win.id)
                            .then(function(tabs) {
                                return browser.tabs.update(tabs[activeTabIndex].id, {
                                    active: true,
                                });
                            });
                    }

                    return promise.then(() => setFocusOnWindow(win.id));
                } else {
                    // magic

                    currentlyLoadingGroups[windowId] = true;

                    removeEvents();

                    browser.runtime.sendMessage({
                        loadingGroupPosition: 10,
                    });

                    let tempEmptyTabId = null,
                        tempEmptyTabIdPromise = Promise.resolve();

                    return Promise.all([
                            getTabs(windowId),
                            hasAnotherTabs(windowId)
                        ])
                        .then(function([tabs, hasAnotherTabs]) {
                            browser.runtime.sendMessage({
                                loadingGroupPosition: 20,
                            });

                            _groups = _groups.map(function(gr) {
                                if (gr.windowId === windowId) { // unmaunt group
                                    gr.windowId = null;
                                } else if (gr.id === _groups[groupIndex].id) { // mount group
                                    gr.windowId = windowId;
                                }
                                return gr;
                            });

                            if (tabs.length || !hasAnotherTabs) { // create empty tab (for quickly change group and not blinking)
                                tempEmptyTabIdPromise = browser.tabs.create({
                                        active: true,
                                        url: 'about:blank',
                                        windowId: windowId,
                                    })
                                    .then(tab => tempEmptyTabId = tab.id);
                            }

                            if (!_groups[groupIndex].tabs.length && !hasAnotherTabs) {
                                _groups[groupIndex].tabs.push({
                                    active: true,
                                    url: 'about:blank',
                                });
                            }

                            saveGroupsToStorage();

                            return tabs;
                        })
                        .then(tabs => tempEmptyTabIdPromise.then(() => tabs))
                        .then(function(tabs) { // remove tabs
                            browser.runtime.sendMessage({
                                loadingGroupPosition: 50,
                            });

                            if (tabs.length) {
                                return browser.tabs.remove(tabs.map(tab => tab.id));
                            }
                        })
                        .then(function() { // create tabs
                            browser.runtime.sendMessage({
                                loadingGroupPosition: 90,
                            });

                            if (_groups[groupIndex].tabs.length) {
                                return Promise.all(_groups[groupIndex].tabs.map(function(tab, tabIndex) {
                                    return browser.tabs.create({
                                        active: -1 === activeTabIndex ? Boolean(tab.active) : tabIndex === activeTabIndex,
                                        url: tab.url,
                                        windowId: windowId,
                                        cookieStoreId: tab.cookieStoreId || DEFAULT_COOKIE_STORE_ID,
                                    });
                                }));
                            }
                        })
                        .then(function() {
                            if (tempEmptyTabId) {
                                return browser.tabs.remove(tempEmptyTabId);
                            }
                        })
                        // .then(() => saveGroupsToStorage())
                        .then(function() {
                            browser.runtime.sendMessage({
                                loadingGroupPosition: false,
                            });

                            updateBrowserActionData();

                            addEvents();

                            delete currentlyLoadingGroups[windowId];
                        });
                }
            })
            .then(function() {
                browser.notifications.clear('error-load-group-notification');
            })
            .catch(function(e) {
                delete currentlyLoadingGroups[windowId];
                notify(e);
                throw e;
            });

    }

    function saveTab(tab) {
        return Promise.all([
                getGroupIndexByWindowId(tab.windowId),
                getTabs(tab.windowId)
            ])
            .then(function([groupIndex, tabs]) {
                if (-1 === groupIndex) {
                    return;
                }

                let tabIndex = tabs.findIndex(t => t.id === tab.id);

                if (-1 === tabIndex || !_groups[groupIndex].tabs[tabIndex]) {
                    return;
                }

                if (_groups[groupIndex].tabs[tabIndex].url !== tab.url) {
                    _groups[groupIndex].tabs[tabIndex].thumbnail = null;
                }

                _groups[groupIndex].tabs[tabIndex].url = normalizeUrl(tab.url);
                _groups[groupIndex].tabs[tabIndex].favIconUrl = tab.favIconUrl;
                _groups[groupIndex].tabs[tabIndex].title = tab.title;
                _groups[groupIndex].tabs[tabIndex].active = tab.active;
                _groups[groupIndex].tabs[tabIndex].cookieStoreId = tab.cookieStoreId;

                return saveGroupsToStorage();
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

    /*
        function getVisibleTabThumbnail(windowId) {
            return new Promise(function(resolve) {
                let _resizeCanvas = document.createElement('canvas');
                _resizeCanvas.mozOpaque = true;

                let _resizeCanvasCtx = _resizeCanvas.getContext('2d');

                browser.tabs.captureVisibleTab(windowId, {
                        format: 'png',
                    })
                    .then(function(_resizeCanvas, _resizeCanvasCtx, thumbnailBase64) { // resize image
                        let img = new Image();

                        img.onload = function() {
                            let height = 192,
                                width = Math.floor(img.width * 192 / img.height);

                            _resizeCanvas.width = width;
                            _resizeCanvas.height = height;
                            _resizeCanvasCtx.drawImage(img, 0, 0, width, height);

                            resolve(_resizeCanvas.toDataURL());
                        };

                        img.src = thumbnailBase64;
                    }.bind(null, _resizeCanvas, _resizeCanvasCtx));
            });
        }

        let waitCompleteLoadingTab = {}; // tabId: promise

        function updateTabThumbnail(windowId, tabId) {
            Promise.all([
                    getGroupByWindowId(windowId),
                    getTabs(windowId, false)
                ])
                .then(function([group, tabs]) {
                    let tabIndex = tabs.findIndex(tab => tab.id === tabId);

                    if (-1 !== tabIndex) {
                        if (tabs[tabIndex].status === 'complete') {
                            getVisibleTabThumbnail(windowId)
                                .then(function(thumbnail) {
                                    group.tabs[tabIndex].thumbnail = thumbnail;
                                    return saveGroup(group);
                                });
                        } else {
                            // waitCompleteLoadingTab[tabId] =
                            new Promise(function(resolve) {
                                waitCompleteLoadingTab[tabId] = resolve;
                            })
                            .then(function() {
                                getVisibleTabThumbnail(windowId)
                                    .then(function(thumbnail) {
                                        group.tabs[tabIndex].thumbnail = thumbnail;
                                        return saveGroup(group);
                                    });
                            });
                        }
                    }
                });
        }
    */

    function onActivatedTab({ tabId, windowId }) {
        // console.log('onActivatedTab', { tabId, windowId });

        Promise.all([
                getGroupIndexByWindowId(windowId),
                getTabs(windowId)
            ])
            .then(function([groupIndex, tabs]) {
                if (-1 === groupIndex) {
                    return;
                }

                let activeTabIndex = tabs.findIndex(tab => tab.id === tabId);

                _groups[groupIndex].tabs = _groups[groupIndex].tabs.map(function(tab, index) {
                    tab.active = index === activeTabIndex;
                    return tab;
                });

                return saveGroupsToStorage();
            });
    }

    function onCreatedTab(tab) {
        console.log('onCreatedTab', tab);
        saveTemporaryTabs(tab.windowId); // save locale tabs

        getGroupIndexByWindowId(tab.windowId)
            .then(function(groupIndex) {

                if (-1 === groupIndex) {
                    return;
                }

                _groups[groupIndex].tabs.push(mapTab(tab));

                saveGroupsToStorage();
            });
    }

    let currentlyMovingTabs = []; // tabIds // expample: open tab from bookmark and move it to other group: many calls method onUpdatedTab

    function onUpdatedTab(tabId, changeInfo, tab) {
        // console.log('onUpdatedTab', arguments);

        let windowId = tab.windowId;

        if (tab.status === 'loading' && isEmptyUrl(tab.url)) {
            return;
        }

        if (tab.incognito || !isAllowUrl(tab.url)) {
            return;
        }

        if (tab.pinned && undefined === changeInfo.pinned) { // pinned tabs are not supported
            return;
        }

        if ('pinned' in changeInfo) {
            return getGroupIndexByWindowId(windowId)
                .then(function(groupIndex) {
                    if (-1 === groupIndex) {
                        return;
                    }

                    if (changeInfo.pinned) {
                        let tabIndex = getTemporaryTabs(windowId).findIndex(tab => tab.id === tabId);
                        _groups[groupIndex].tabs.splice(tabIndex, 1);
                    } else {
                        _groups[groupIndex].tabs.unshift(mapTab(tab));
                    }

                    saveGroupsToStorage();
                })
                .then(() => saveTemporaryTabs(windowId));
        }

        if (!tab.pinned && !isEmptyUrl(tab.url) && !currentlyMovingTabs.includes(tabId)) {
            return Promise.all([
                    getGroupByWindowId(windowId),
                    getTabs(windowId)
                ])
                .then(function([group, tabs]) {
                    if (!group || currentlyMovingTabs.includes(tabId)) {
                        return;
                    }

                    let destGroup = _groups.find(isCatchedUrl.bind(null, tab.url));

                    if (destGroup && destGroup.id !== group.id) {
                        currentlyMovingTabs.push(tabId);

                        let tabIndex = tabs.findIndex(tab => tab.id === tabId);
                        return moveTabToGroup(tabIndex, undefined, group.id, destGroup.id)
                            .then(function() {
                                currentlyMovingTabs.splice(currentlyMovingTabs.indexOf(tabId), 1);
                            });
                    }

                    return saveTab(tab);
                });
        }

        if ('complete' === tab.status) {
            saveTab(tab);
        }
    }

    function onRemovedTab(tabId, { isWindowClosing, windowId }) {
        console.log('onRemovedTab', arguments);

        if (isWindowClosing) {
            return;
        }

        getGroupIndexByWindowId(windowId)
            .then(function(groupIndex) {
                if (-1 === groupIndex) {
                    return;
                }

                let removedTabIndex = getTemporaryTabs(windowId).findIndex(tab => tab.id === tabId);
console.log('onRemovedTab', tabId, getTemporaryTabs(windowId));
                if (-1 === removedTabIndex) { // if tab is no allowed
                    return; // uncomment if remove code above
                }

                saveTemporaryTabs(windowId); // save locale tabs

                _groups[groupIndex].tabs.splice(removedTabIndex, 1);

                return saveGroupsToStorage();
            });
    }

    function onMovedTab(tabId, { windowId, fromIndex, toIndex }) {
        console.log('onMovedTab', arguments);
        Promise.all([
                browser.tabs.get(tabId),
                getGroupIndexByWindowId(windowId),
                getTabs(windowId)
            ])
            .then(function([tab, groupIndex, tabs]) {
                if (-1 === groupIndex) {
                    return;
                }

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
                getGroupIndexByWindowId(newWindowId),
                storage.get('createNewGroupAfterAttachTabToNewWindow')
            ])
            .then(function([tab, tabs, groupIndex, { createNewGroupAfterAttachTabToNewWindow }]) {
                let tabIndex = tabs.findIndex(({ id }) => id === tabId);
console.log('onAttachedTab', tabId, tabIndex, tabs);
                if (-1 === tabIndex) { // if tab not allowed
                    // BUG: in nightly ff attached tab has new tab id :(
                    tabId = Math.max.apply(Math, tabs.map(tab => tab.id));
                    tabIndex = tabs.findIndex(({ id }) => id === tabId);

                    if (tab.url !== tabs[tabIndex].url) {
                        return;
                    }
                }
console.log('onAttachedTab 2', tabId, tabIndex, tabs);
                if (-1 === groupIndex) {
                    if (createNewGroupAfterAttachTabToNewWindow) {
                        saveTemporaryTabs(newWindowId, tabs);

                        addGroup(newWindowId)
                            .then(function(newGroupIndex) {
                                if (isAllowUrl(tab.url)) {
                                    _groups[newGroupIndex].tabs.push(mapTab(tab)); // TODO save all tabs in new attached window
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
        getGroupIndexByWindowId(oldWindowId)
            .then(function(oldGroupIndex) {
                if (-1 === oldGroupIndex) {
                    return;
                }
let tmp = getTemporaryTabs(oldWindowId);
                getTabs(oldWindowId)
                    .then(function(tabs) {
                        console.log('tabs, oldTabs', tabs, tmp);
                    });

                let tabIndex = getTemporaryTabs(oldWindowId).findIndex(tab => tab.id === tabId);
console.log('onDetachedTab', tabId, tabIndex, _groups[oldGroupIndex].tabs, getTemporaryTabs(oldWindowId));
                if (-1 === tabIndex) { // if tab is not allowed
                    // BUG: in nightly ff onDetachedTab tabid is wrong :(
                    let tabs = getTemporaryTabs(oldWindowId);
                    tabId = Math.max.apply(Math, tabs.map(tab => tab.id));
                    tabIndex = tabs.findIndex(({ id }) => id === tabId);

                    if (tab.url !== tabs[tabIndex].url) {
                        return;
                    }
                    // return;
                }

                _groups[oldGroupIndex].tabs.splice(tabIndex, 1);
                saveGroupsToStorage();

                saveTemporaryTabs(oldWindowId);
            });
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
                    updateBrowserActionData();
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
                            });
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
                        return removeCurrentTabByIndex(oldGroup.windowId, oldTabIndex, 1 === oldGroup.tabs.length);
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
            .then(function() {
                if (groupsToSave.length) {
                    return saveGroup(groupsToSave);
                }
            })
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

    function updateMoveTabMenus() {
        return removeMoveTabMenus().then(createMoveTabMenus);
    }

    function removeMoveTabMenus() {
        if (!moveTabToGroupMenusIds.length) {
            return Promise.resolve();
        }

        return Promise.all(moveTabToGroupMenusIds.map(id => browser.menus.remove(id)))
            .then(() => moveTabToGroupMenusIds = []);
    }

    function createMoveTabMenus() {
        return getGroupByWindowId()
            .then(function(currentGroup) {
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
                        onclick: function(destGroupId, info, tab) {
                            if (tab.incognito) {
                                return;
                            }

                            Promise.all([
                                    getGroupByWindowId(tab.windowId),
                                    getTabs()
                                ])
                                .then(function([currentGroup, tabs]) {
                                    let tabIndex = tabs.findIndex(({ id }) => id === tab.id);

                                    if (tabIndex > -1) {
                                        moveTabToGroup(tabIndex, undefined, currentGroup.id, destGroupId);
                                    }
                                });
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
                    onclick: function(info, tab) {
                        if (tab.incognito) {
                            return;
                        }

                        getTabs()
                            .then(function(tabs) {
                                let tabIndex = tabs.findIndex(({ id }) => id === tab.id);

                                if (-1 === tabIndex) {
                                    return;
                                }

                                addGroup()
                                    .then(function(newGroupIndex) {
                                        _groups[newGroupIndex].tabs.push(mapTab(tab));

                                        saveGroupsToStorage();

                                        removeCurrentTabByIndex(currentGroup.windowId, tabIndex, 1 === currentGroup.tabs.length); // TODO find current group
                                    });
                            });
                    },
                }));
            });
    }

    function resetBrowserActionData() {
        browser.browserAction.setTitle({
            title: browser.runtime.getManifest().browser_action.default_title,
        });

        browser.browserAction.setIcon({
            path: browser.runtime.getManifest().browser_action.default_icon,
        });
    }

    function updateBrowserActionData() {
        return getWindow()
            .then(win => getGroupByWindowId(win.id))
            .then(function(currentGroup) {
                if (!currentGroup) {
                    return resetBrowserActionData();
                }

                browser.browserAction.setTitle({
                    title: currentGroup.title + ' - ' + EXTENSION_NAME,
                });

                browser.browserAction.setIcon({
                    path: getBrowserActionSvgPath(currentGroup.iconColor),
                });
            });
    }

    function onRemovedWindow(windowId) {
        Promise.all([
                browser.windows.getAll(),
                getGroupByWindowId(windowId)
            ])
            .then(function([allWindows]) {
                if (1 === allWindows.length && 'popup' === allWindows[0].type) { // remove manage popup window if it's last window, TODO fix this
                    browser.windows.remove(allWindows[0].id);
                }
            });
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

    function loadGroupPosition(textPosition) {
        if (1 === _groups.length) {
            return;
        }

        Promise.all([
                getGroupIndexByWindowId(),
                getWindow()
            ])
            .then(function([groupIndex, win]) {
                if (-1 === groupIndex) {
                    return;
                }

                let nextGroupIndex = getNextIndex(groupIndex, _groups.length, textPosition);

                if (false === nextGroupIndex) {
                    return;
                }

                return loadGroup(win.id, nextGroupIndex);
            });
    }

    function loadGroupByIndex(groupIndex) {
        if (!_groups[groupIndex]) {
            return;
        }

        getWindow().then(win => loadGroup(win.id, groupIndex));
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

    function initBrowserCommands() {
        browser.commands.onCommand.removeListener(browserCommandsLoadNextPrevGroupHandler);
        browser.commands.onCommand.removeListener(browserCommandsLoadByIndexGroupHandler);

        storage.get(['enableKeyboardShortcutLoadNextPrevGroup', 'enableKeyboardShortcutLoadByIndexGroup'])
            .then(function(options) {
                if (options.enableKeyboardShortcutLoadNextPrevGroup) {
                    browser.commands.onCommand.addListener(browserCommandsLoadNextPrevGroupHandler);
                }

                if (options.enableKeyboardShortcutLoadByIndexGroup) {
                    browser.commands.onCommand.addListener(browserCommandsLoadByIndexGroupHandler);
                }
            });
    }

    function browserCommandsLoadNextPrevGroupHandler(command) {
        if ('group-prev' === command || 'group-next' === command) {
            loadGroupPosition(command.split('-').pop());
        }
    }

    function browserCommandsLoadByIndexGroupHandler(command) {
        if (command.startsWith('index-group')) {
            loadGroupByIndex(command.split('-').pop() - 1);
        }
    }

    window.background = {
        inited: false,

        initBrowserCommands,

        getGroups: () => _groups,

        getWindow,
        getWindowByGroup,
        getGroupByWindowId,
        getGroupIndexByWindowId,

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
        .then(function([result, windows]) { // migration
            let manifestVerion = browser.runtime.getManifest().version,
                keysToRemoveFromStorage = [];

            if (result.version === manifestVerion) {
                return [result, windows];
            }

            let compareVersion = result.version.localeCompare(manifestVerion);

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

            result.version = manifestVerion;

            return new Promise(function(resolve) {
                    if (keysToRemoveFromStorage.length) {
                        storage.remove(keysToRemoveFromStorage).then(resolve);
                    } else {
                        resolve();
                    }
                })
                .then(() => storage.set(result, false))
                .then(() => [result, windows]);
        })
        .then(function([result, windows]) {
            // lastFocusedNormalWindow = win; // TODO fix it?

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
        .then(updateBrowserActionData)
        .then(createMoveTabMenus)
        .then(initBrowserCommands)
        .then(addEvents)
        .catch(notify);

})()
