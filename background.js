(function() {
    'use strict';

    let currentlyLoadingGroups = {}; // windowId: true

    // return storage.get(null).then(console.log);

    function getWindow(windowId = browser.windows.WINDOW_ID_CURRENT) {
        return browser.windows.get(windowId, {
            windowTypes: ['normal'],
        });
    }

    function setFocusOnWindow(windowId) {
        return browser.windows.update(windowId, {
            focused: true,
        });
    }

    function getTabs(windowId = browser.windows.WINDOW_ID_CURRENT, mapTabs = true, pinned = false) {
        return browser.tabs.query({
                windowId,
                pinned,
            })
            .then(function(tabs) {
                tabs = tabs.filter(tab => isAllowUrl(tab.url));

                if (mapTabs) {
                    tabs = tabs.map(mapTab);
                }

                return tabs;
            });
    }

    function hasAnotherTabs(windowId = browser.windows.WINDOW_ID_CURRENT, eachFunc = 'some') {
        return browser.tabs.query({
                windowId,
            })
            .then(tabs => tabs[eachFunc](tab => tab.pinned || !isAllowUrl(tab.url)));
    }

    function mapTab(tab) {
        tab.url = tab.url || 'about:blank';
        tab.url = 'about:newtab' === tab.url ? 'about:blank' : tab.url;

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

    function createGroup(id) {
        return {
            id,
            title: browser.i18n.getMessage('newGroupTitle', id),
            iconColor: randomColor(),
            tabs: [],
            catchTabRules: '',
            windowId: null,
        };
    }

    function getData(windowId, mapTabs) {
        return Promise.all([
                storage.get('groups'),
                getWindow(windowId),
                getTabs(windowId, mapTabs),
            ])
            .then(function([result, win, tabs]) {
                return {
                    groups: result.groups,
                    windowId: win.id,
                    tabs: tabs,
                    currentGroup: result.groups.find(group => group.windowId === win.id) || {}, // empty obj use on init bg and saveTabs
                };
            });
    }

    function addGroup(resetGroups = false, windowId = null) {
        return storage.get(['groups', 'lastCreatedGroupPosition'])
            .then(function(result) {
                result.lastCreatedGroupPosition++;

                if (resetGroups) {
                    result.groups = [];
                }

                result.groups.push(createGroup(result.lastCreatedGroupPosition));

                let promises = [result];

                if (1 === result.groups.length) {
                    promises.push(getWindow().then(win => win.id));
                } else if (windowId) {
                    promises.push(windowId);
                }

                return Promise.all(promises);
            })
            .then(function([result, winId]) {
                let newGroupIndex = result.groups.length - 1;

                result.groups[newGroupIndex].windowId = winId || null;

                return storage.set(result)
                    .then(function() {
                        removeMoveTabMenus().then(createMoveTabMenus);
                        return result.groups[newGroupIndex];
                    });
            })
    }

    // groups : Object or array of Object
    function saveGroup(groups) {
        return storage.get('groups')
            .then(function(result) {
                groups = Array.isArray(groups) ? groups : [groups];

                return storage.set({
                    groups: result.groups.map(group => groups.find(({ id }) => id === group.id) || group),
                });
            });
    }

    function removeGroup(oldGroup) {
        return storage.get('groups')
            .then(function(result) {
                let oldGroupIndex = result.groups.findIndex(group => oldGroup.id === group.id),
                    getNewGroupIndex = function(oldIndex, newGroupsLength) {
                        return (oldIndex > newGroupsLength - 1) ? (newGroupsLength - 1) : oldIndex;
                    };

                result.groups.splice(oldGroupIndex, 1);

                return getWindowByGroup(oldGroup)
                    .then(function(oldGroupWindow) {
                        if (oldGroupWindow) {
                            return getWindow()
                                .then(function(currentWindow) {
                                    if (oldGroupWindow.id === currentWindow.id) {
                                        if (!result.groups.length) { // if remove last group
                                            return addGroup(true, currentWindow.id) // reset all groups
                                                .then(newGroup => loadGroup(currentWindow.id, newGroup));
                                        } else {
                                            return storage.set(result)
                                                .then(function() {
                                                    let newGroupIndex = getNewGroupIndex(oldGroupIndex, result.groups.length);
                                                    return loadGroup(currentWindow.id, result.groups[newGroupIndex]);
                                                });
                                        }
                                    } else {
                                        return browser.windows.remove(oldGroupWindow.id)
                                            .then(() => storage.set(result));
                                    }
                                });
                        } else {
                            return storage.set(result);
                        }
                    });
            })
            .then(removeMoveTabMenus)
            .then(createMoveTabMenus);
    }

    function moveGroup(group, position = 'up') {
        return storage.get('groups')
            .then(function({ groups }) {
                let index = groups.findIndex(({ id }) => id === group.id);

                if ('up' === position) {
                    if (!index) {
                        return;
                    }

                    groups.splice(index - 1, 0, groups.splice(index, 1)[0]);
                } else if ('down' === position) {
                    if (index === groups.length - 1) {
                        return;
                    }

                    groups.splice(index + 1, 0, groups.splice(index, 1)[0]);
                } else if ('number' === type(position)) {
                    groups.splice(position, 0, groups.splice(index, 1)[0]);
                }

                return storage.set({
                    groups,
                });
            })
            .then(removeMoveTabMenus)
            .then(createMoveTabMenus);
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
                    group.tabs.push({
                        active: false,
                        url: 'about:blank',
                        cookieStoreId,
                    });

                    return saveGroup(group);
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

    function removeTab(tabToRemove, tabIndex, group) {
        return getWindowByGroup(group)
            .then(function(win) {
                if (win) {
                    return removeCurrentTabByIndex(group.windowId, tabIndex, 1 === group.tabs.length);
                } else {
                    group.tabs.splice(tabIndex, 1);
                    return saveGroup(group);
                }
            });
    }

    function loadGroup(windowId, group, activeTabIndex = -1) {
        if (!windowId) { // if click on notification after moving tab to window which is now closed :)
            return Promise.reject();
        }

        if (currentlyLoadingGroups[windowId]) {
            notify(browser.i18n.getMessage('errorAnotherGroupAreLoading'), 5000, 'error-load-group-notification');
            return Promise.resolve();
        }

        return Promise.all([
                getWindowByGroup(group, true), // return window with tabs
                browser.windows.get(windowId) // if window not exists - notify me
            ])
            .then(function([win]) {
                if (win) {
                    let promise = Promise.resolve();

                    if (-1 !== activeTabIndex) {
                        promise = getTabs(group.windowId, false)
                            .then(function(tabs) {
                                return browser.tabs.update(tabs[activeTabIndex].id, {
                                    active: true,
                                });
                            });
                    }

                    return promise.then(() => setFocusOnWindow(group.windowId));
                } else {
                    // magic

                    currentlyLoadingGroups[windowId] = true;

                    removeEvents();

                    browser.runtime.sendMessage({
                        loadingGroupPosition: 10,
                    });

                    let tempEmptyTabId = null,
                        tempEmptyTabIdPromise = Promise.resolve(),
                        indexGroup = null;

                    return Promise.all([
                            getData(windowId),
                            hasAnotherTabs(windowId)
                        ])
                        .then(function([result, hasAnotherTabs]) {
                            browser.runtime.sendMessage({
                                loadingGroupPosition: 20,
                            });

                            indexGroup = result.groups.findIndex(gr => gr.id === group.id);

                            result.groups = result.groups.map(function(gr) {
                                if (gr.windowId === windowId) { // unmaunt group
                                    gr.windowId = null;
                                } else if (gr.id === group.id) { // mount group
                                    gr.windowId = windowId;
                                }
                                return gr;
                            });

                            if (result.tabs.length || !hasAnotherTabs) { // create empty tab (for quickly change group and not blinking)
                                tempEmptyTabIdPromise = browser.tabs.create({
                                        active: true,
                                        url: 'about:blank',
                                        windowId: windowId,
                                    })
                                    .then(tab => tempEmptyTabId = tab.id);
                            }

                            if (!result.groups[indexGroup].tabs.length && !hasAnotherTabs) {
                                result.groups[indexGroup].tabs.push({
                                    active: true,
                                    url: 'about:blank',
                                });
                            }

                            return result;
                        })
                        .then(result => tempEmptyTabIdPromise.then(() => result))
                        .then(function(result) { // remove tabs
                            browser.runtime.sendMessage({
                                loadingGroupPosition: 50,
                            });

                            if (result.tabs.length) {
                                return browser.tabs.remove(result.tabs.map(tab => tab.id)).then(() => result);
                            }

                            return result;
                        })
                        .then(function(result) { // create tabs
                            browser.runtime.sendMessage({
                                loadingGroupPosition: 90,
                            });

                            if (result.groups[indexGroup].tabs.length) {
                                return Promise.all(result.groups[indexGroup].tabs.map(function(tab, tabIndex) {
                                        return browser.tabs.create({
                                            active: -1 === activeTabIndex ? Boolean(tab.active) : tabIndex === activeTabIndex,
                                            url: tab.url,
                                            windowId: windowId,
                                            cookieStoreId: tab.cookieStoreId || DEFAULT_COOKIE_STORE_ID,
                                        });
                                    }))
                                    .then(() => result);
                            }

                            return result;
                        })
                        .then(function(result) {
                            if (tempEmptyTabId) {
                                return browser.tabs.remove(tempEmptyTabId).then(() => result);
                            }

                            return result;
                        })
                        .then(function(result) {
                            return storage.set({
                                groups: result.groups,
                            });
                        })
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

    function saveTabs(windowId = browser.windows.WINDOW_ID_CURRENT, excludeTabIds = []) {
        return getData(windowId, false)
            .then(function(result) {
                if (!result.currentGroup.id) {
                    return;
                }

                result.currentGroup.tabs = result.tabs
                    .filter(tab => !excludeTabIds.includes(tab.id))
                    .map(function(tab, tabIndex) {
                        if (isEmptyUrl(tab.url) && 'loading' === tab.status) {
                            return result.currentGroup.tabs[tabIndex] ? result.currentGroup.tabs[tabIndex] : mapTab(tab);
                        }

                        return mapTab(tab);
                    });

                return saveGroup(result.currentGroup);
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
        Promise.all([removeTabEventPromise, browser.tabs.get(tabId)])
            .then(function([removedTabId, { incognito }]) {
                if (incognito) {
                    return;
                }

                return saveTabs(windowId, [removedTabId]);
            });
            // .then(() => updateTabThumbnail(windowId, tabId));
    }

    let currentlyMovingTabs = []; // tabIds

    function onUpdatedTab(tabId, changeInfo, tab) {
        if (tab.status === 'loading' && isEmptyUrl(tab.url)) {
            return;
        }

        if (tab.incognito || !isAllowUrl(tab.url)) {
            return;
        }

        if (tab.pinned && undefined === changeInfo.pinned) { // if update pinned tab, it not supported
            return;
        }

        if (!tab.pinned && !isEmptyUrl(tab.url) && !currentlyMovingTabs.includes(tabId)) {
            return getData(tab.windowId)
                .then(function({ groups, currentGroup, tabs }) {
                    if (currentlyMovingTabs.includes(tabId)) {
                        return;
                    }

                    let destGroup = groups.find(isCatchedUrl.bind(null, tab.url));

                    if (destGroup && destGroup.id !== currentGroup.id) {
                        currentlyMovingTabs.push(tabId);

                        let tabIndex = tabs.findIndex(tab => tab.id === tabId);
                        return moveTabToGroup(tabIndex, undefined, currentGroup.id, destGroup.id)
                            .then(function() {
                                currentlyMovingTabs.splice(currentlyMovingTabs.indexOf(tabId), 1);
                            });
                    }

                    return saveTabs(tab.windowId);
                });
        }

        if (undefined !== changeInfo.pinned || 'complete' === tab.status) {
            saveTabs(tab.windowId);
        }
    }

    function getGroupByWindowId(windowId) { // windowId - real window id
        return storage.get('groups')
            .then(({ groups }) => groups.find(group => group.windowId === windowId));
    }

    let removeTabEventPromise = Promise.resolve();

    function onRemovedTab(removedTabId, { isWindowClosing, windowId }) {
        if (isWindowClosing) {
            return;
        }

        removeTabEventPromise = browser.windows.get(windowId)
            .then(function({ incognito }) {
                if (incognito) {
                    return;
                }

                return saveTabs(windowId, [removedTabId]);
            })
            .then(() => removedTabId);
    }

    function onMovedTab(tabId, { windowId }) {
        browser.windows.get(windowId)
            .then(function({ incognito }) {
                if (incognito) {
                    return;
                }

                saveTabs(windowId, [], false); // no need event because popup are hidded when tabs is moved
            });
    }

    let detachTabEventPromise = Promise.resolve(),
        attachTabEventPromise = Promise.resolve();

    function onAttachedTab(tabId, { newWindowId }) {
        attachTabEventPromise = Promise.all([
                detachTabEventPromise,
                storage.get('createNewGroupAfterAttachTabToNewWindow')
            ])
            .then(([, options]) => getGroupByWindowId(newWindowId).then(group => [group, options]))
            .then(function([group, options]) {
                if (group) {
                    return saveTabs(newWindowId, [], false);
                } else {
                    if (options.createNewGroupAfterAttachTabToNewWindow) {
                        return Promise.all([
                                addGroup(undefined, newWindowId),
                                browser.tabs.get(tabId)
                            ])
                            .then(function([newGroup, tab]) {
                                newGroup.tabs.push(mapTab(tab));
                                return saveGroup(newGroup);
                            })
                            .then(updateBrowserActionData);
                    }
                }
            });
    }

    function onDetachedTab(tabId, { oldWindowId }) {
        detachTabEventPromise = attachTabEventPromise
            .then(() => getGroupByWindowId(oldWindowId))
            .then(function(group) {
                if (group) {
                    group.tabs = group.tabs.filter(tab => tab.id !== tabId);
                    return saveGroup(group, false);
                }
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
                    resetBrowserActionIcon();
                    removeMoveTabMenus();
                } else if (!lastFocusedWinId || lastFocusedWinId !== win.id) {
                    browser.browserAction.enable();
                    updateBrowserActionData();
                    removeMoveTabMenus().then(createMoveTabMenus);
                }

                if ('normal' === win.type && !win.incognito) {
                    lastFocusedNormalWindow = win;
                }

                lastFocusedWinId = win.id;
            });
    }

    // function moveTabToGroup(tab, tabIndex, srcGroupId, destGroupId, showNotificationAfterMoveTab = true) {
    function moveTabToGroup(oldTabIndex, newTabIndex = -1, oldGroupId, newGroupId, showNotificationAfterMoveTab = true) {
        return storage.get('groups')
            .then(function({ groups }) {
                let oldGroup = groups.find(({ id }) => id === oldGroupId),
                    newGroup = groups.find(({ id }) => id === newGroupId),
                    tab = oldGroup.tabs[oldTabIndex],
                    groupsToSave = [],
                    promises = [],
                    createdTabId = null,
                    createdTabIndex = null;

                if (oldGroupId === newGroupId) { // if it's same group
                    promises.push(getWindowByGroup(newGroup)
                        .then(function(win) {
                            if (win) {
                                return getTabs(newGroup.windowId, false)
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
                                Promise.all([
                                        storage.get('groups'),
                                        browser.windows.getLastFocused({
                                            windowTypes: ['normal'],
                                        })
                                    ])
                                    .then(function([result, lastWin]) {
                                        setFocusOnWindow(lastWin.id)
                                            .then(function() {
                                                let group = result.groups.find(group => group.id === newGroup.id);
                                                loadGroup(lastWin.id, group, createdTabIndex);
                                            });
                                    });
                            }
                        }.bind(null, createdTabId, createdTabIndex, newGroup));
                    });

            });
    }

    let moveTabToGroupMenusIds = [];

    function removeMoveTabMenus() {
        return Promise.all(moveTabToGroupMenusIds.map(id => browser.menus.remove(id)))
            .then(() => moveTabToGroupMenusIds = []);
    }

    function createMoveTabMenus() {
        return getData()
            .then(function(data) {
                moveTabToGroupMenusIds.push(browser.menus.create({
                    id: 'stg-move-tab-helper',
                    title: browser.i18n.getMessage('moveTabToGroupDisabledTitle'),
                    enabled: false,
                    contexts: ['tab'],
                }));

                data.groups.forEach(function(group) {
                    moveTabToGroupMenusIds.push(browser.menus.create({
                        id: CONTEXT_MENU_PREFIX_GROUP + group.id,
                        title: unSafeHtml(group.title),
                        enabled: group.id !== data.currentGroup.id,
                        icons: {
                            16: createGroupSvgColoredIcon(group.iconColor),
                        },
                        contexts: ['tab'],
                        onclick: function(destGroupId, info, tab) {
                            if (tab.incognito) {
                                return;
                            }

                            getData().then(function(result) {
                                let tabIndex = result.tabs.findIndex(({ id }) => id === tab.id);

                                if (tabIndex > -1) {
                                    moveTabToGroup(tabIndex, undefined, result.currentGroup.id, destGroupId);
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

                        addGroup()
                            .then(function(newGroup) {
                                newGroup.tabs.push(mapTab(tab));
                                return saveGroup(newGroup, false);
                            })
                            .then(() => getData())
                            .then(function(result) {
                                let tabIndex = result.tabs.findIndex(({ id }) => id === tab.id),
                                    isLastTabInGroup = result.currentGroup.tabs.length > 1;

                                if (tabIndex > -1) {
                                    removeCurrentTabByIndex(undefined, tabIndex, isLastTabInGroup);
                                }
                            });
                    },
                }));
            });
    }

    function resetBrowserActionIcon() {
        browser.browserAction.setTitle({
            title: browser.i18n.getMessage('extensionName'),
        });

        browser.browserAction.setIcon({
            path: '/icons/icon.svg',
        });
    }

    function updateBrowserActionData() {
        getData().then(function({ currentGroup }) {
            browser.browserAction.setTitle({
                title: currentGroup.title + ' - ' + browser.i18n.getMessage('extensionName'),
            });

            browser.browserAction.setIcon({
                path: getBrowserActionSvgPath(currentGroup.iconColor),
            });
        });
    }

    function onRemovedWindow(windowId) {
        Promise.all([attachTabEventPromise, detachTabEventPromise])
            .then(() => getGroupByWindowId(windowId))
            .then(function(group) {
                if (group) {
                    group.windowId = null;
                    return saveGroup(group);
                }
            })
            .then(() => browser.windows.getAll())
            .then(function(allWindows) {
                if (1 === allWindows.length && 'popup' === allWindows[0].type) { // remove manage popup window if it's last window
                    browser.windows.remove(allWindows[0].id);
                }
            });
    }

    function addEvents() {
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
        browser.tabs.onActivated.removeListener(onActivatedTab);
        browser.tabs.onUpdated.removeListener(onUpdatedTab);
        browser.tabs.onRemoved.removeListener(onRemovedTab);

        browser.tabs.onMoved.removeListener(onMovedTab);

        browser.tabs.onAttached.removeListener(onAttachedTab);
        browser.tabs.onDetached.removeListener(onDetachedTab);

        browser.windows.onFocusChanged.removeListener(onFocusChangedWindow);
        browser.windows.onRemoved.removeListener(onRemovedWindow);
    }

    function loadGroupPosition(textPosition = 'next') {
        getData().then(function(result) {
            if (1 === result.groups.length) {
                return;
            }

            let currentGroupIndex = result.groups.findIndex(group => group.id === result.currentGroup.id),
                nextGroupIndex = getNextIndex(currentGroupIndex, result.groups.length, textPosition);

            if (-1 === currentGroupIndex || false === nextGroupIndex) {
                return;
            }

            return loadGroup(result.windowId, result.groups[nextGroupIndex]);
        });
    }

    function loadGroupByIndex(groupIndex) {
        getData().then(function(result) {
            if (result.groups[groupIndex]) {
                return loadGroup(result.windowId, result.groups[groupIndex]);
            }
        });
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

        getWindow,
        getData,
        getTabs,
        moveTabToGroup,

        removeMoveTabMenus,
        createMoveTabMenus,
        updateBrowserActionData,
        getWindowByGroup,
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
            getWindow(),
            getTabs(undefined, false)
        ])
        .then(function([result, win, tabs]) { // migration
            let manifestVerion = browser.runtime.getManifest().version,
                keysToRemoveFromStorage = [];

            if (result.version === manifestVerion) {
                return [result, win, tabs];
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
                .then(() => [result, win, tabs]);
        })
        .catch(notify)
        .then(function([result, win, tabs]) {
            window.background.inited = true;

            lastFocusedNormalWindow = win.id;

            if (!result.groups.some(group => group.windowId === win.id)) { // if not found group for current window
                let lastActiveGroup = result.groups.find(group => group.windowId !== null);

                if (lastActiveGroup && lastActiveGroup.tabs.length === tabs.length) { // if found last active group and tabs length is equal, maybe need compare urls?
                    lastActiveGroup.windowId = win.id;
                    return saveGroup(lastActiveGroup);
                }

                return addGroup(undefined, win.id)
                    .then(() => saveTabs(win.id));
            }

            return saveTabs(win.id);
        })
        .then(updateBrowserActionData)
        .then(createMoveTabMenus)
        .then(initBrowserCommands)
        .then(addEvents);

})()
