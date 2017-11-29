(function() {
    'use strict';

    let isTabCurrentlyRemoving = false,
        currentlyLoadingGroups = {}; // windowId: true

    function getWindow(windowId = browser.windows.WINDOW_ID_CURRENT) {
        return browser.windows.get(windowId, {
            windowTypes: ['normal'],
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
        };
    }

    function createGroup(id) {
        return {
            id,
            title: browser.i18n.getMessage('newGroupTitle', id),
            iconColor: 'hsla(' + (Math.random() * 360).toFixed(0) + ', 100%, 50%, 1)',
            tabs: [],
            moveNewTabsToThisGroupByRegExp: '',
        };
    }

    function getData(windowId, mapTabs) {
        return Promise.all([
                storage.get(['groups', 'windowsGroup']),
                getWindow(windowId),
                getTabs(windowId, mapTabs),
            ])
            .then(function([result, win, tabs]) {
                return {
                    groups: result.groups,
                    windowsGroup: result.windowsGroup,
                    windowId: win.id,
                    tabs: tabs,
                    currentGroup: result.groups.find(group => group.id === result.windowsGroup[win.id]) || {}, // empty obj use on init bg and saveTabs
                };
            });
    }

    function addGroup(resetGroups = false, windowId = null) { // if reset groups then return all groups else return new group
        return storage.get(['groups', 'lastCreatedGroupPosition', 'windowsGroup'])
            .then(function(result) {
                result.lastCreatedGroupPosition++;

                if (resetGroups) {
                    result.groups = [];
                    result.windowsGroup = {};
                }

                let isFirstGroup = 0 === result.groups.length;

                result.groups.push(createGroup(result.lastCreatedGroupPosition));

                let promArr = [result];

                if (isFirstGroup) {
                    promArr.push(getWindow().then(win => win.id));
                } else if (windowId) {
                    promArr.push(windowId);
                }

                return Promise.all(promArr);
            })
            .then(function([result, winId]) {
                let newGroup = result.groups.slice(-1).pop(); // get last group

                if (winId) {
                    result.windowsGroup[winId] = newGroup.id;
                }

                return storage.set(result)
                    .then(() => newGroup);
            })
            .then(function(result) {
                removeMoveTabMenus().then(createMoveTabMenus);

                return result;
            });
    }

    // groups : Object or array of Object
    function saveGroup(groups, sendEventUpdateStorage) {
        return storage.get('groups')
            .then(function(result) {
                groups = Array.isArray(groups) ? groups : [groups];

                return storage.set({
                    groups: result.groups.map(group => groups.find(({id}) => id === group.id) || group),
                }, sendEventUpdateStorage);
            });
    }

    function removeGroup(oldGroup) {
        return new Promise(function(resolve) {
                storage.get(['groups', 'windowsGroup']).then(function(result) {
                    let oldGroupIndex = result.groups.findIndex(group => oldGroup.id === group.id),
                        getNewGroupIndex = function(oldIndex, newGroupsLength) {
                            return (oldIndex > newGroupsLength - 1) ? (newGroupsLength - 1) : oldIndex;
                        };

                    for (let windowId in result.windowsGroup) {
                        if (result.windowsGroup[windowId] === oldGroup.id) {
                            delete result.windowsGroup[windowId];
                        }
                    }

                    result.groups.splice(oldGroupIndex, 1);

                    isGroupLoadInWindow(oldGroup)
                        .then(function(oldGroupWindow) {
                            getWindow().then(function(currentWindow) {
                                if (currentWindow.id === oldGroupWindow.id) {
                                    if (!result.groups.length) { // if remove last group
                                        addGroup(true) // reset all groups
                                            .then(newGroup => loadGroup(undefined, newGroup))
                                            .then(resolve);
                                    } else {
                                        storage.set(result)
                                            .then(function() {
                                                let newGroupIndex = getNewGroupIndex(oldGroupIndex, result.groups.length);
                                                return loadGroup(undefined, result.groups[newGroupIndex]);
                                            })
                                            .then(resolve);
                                    }
                                } else {
                                    browser.windows.remove(oldGroupWindow.id)
                                        .then(function() {
                                            storage.set(result).then(resolve);
                                        });
                                }
                            });
                        })
                        .catch(function() {
                            storage.set(result).then(resolve);
                        });
                });
            })
            .then(removeMoveTabMenus)
            .then(createMoveTabMenus);
    }

    function moveGroup(group, position = 'up') {
        return storage.get('groups')
            .then(function({groups}) {
                let index = groups.findIndex(({id}) => id === group.id);

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
                }

                return storage.set({
                    groups,
                });
            })
            .then(removeMoveTabMenus)
            .then(createMoveTabMenus);
    }

    function isGroupLoadInWindow(group) { // reject if not load group
        return storage.get('windowsGroup')
            .then(function({windowsGroup}) {
                for (var winId in windowsGroup) {
                    if (windowsGroup[winId] === group.id) {
                        return browser.windows.get(Number(winId));
                    }
                }

                throw `Group ${group.title} not load in any window`;
            });
    }

    function addTab(group, cookieStoreId) {
        return new Promise(function(resolve, reject) {
            isGroupLoadInWindow(group)
                .then(function(win) {
                    return browser.tabs.create({ // after this - will trigger events on create tab and add tab in group
                            active: false,
                            url: 'about:blank',
                            cookieStoreId,
                            windowId: win.id,
                        })
                        .then(resolve, reject);
                })
                .catch(function() {
                    group.tabs.push({
                        active: false,
                        url: 'about:blank',
                        cookieStoreId,
                    });

                    return saveGroup(group)
                        .then(resolve, reject);
                });
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
        return new Promise(function(resolve) {
            isGroupLoadInWindow(group)
                .then(function(win) {
                    return removeCurrentTabByIndex(win.id, tabIndex, 1 === group.tabs.length)
                        .then(resolve);
                })
                .catch(function() {
                    group.tabs.splice(tabIndex, 1);
                    saveGroup(group).then(resolve);
                });
        });
    }

    function loadGroup(windowId = browser.windows.WINDOW_ID_CURRENT, group, isCurrentGroup = false, activeTabIndex = -1) {
        if (isCurrentGroup) {
            return getTabs(windowId)
                .then(function(tabs) {
                    if (tabs[activeTabIndex]) {
                        return browser.tabs.update(tabs[activeTabIndex].id, {
                            active: true,
                        });
                    }
                });
        }

        removeTabEvents();

        let tempEmptyTabIdPromise = null;

        browser.runtime.sendMessage({
            loadingGroupPosition: 10,
        });

        return Promise.all([
                getData(windowId),
                hasAnotherTabs(windowId)
            ])
            .then(function([result, hasAnotherTabs]) {
                if (currentlyLoadingGroups[result.windowId]) {
                    throw browser.i18n.getMessage('errorAnotherGroupAreLoading');
                }

                browser.runtime.sendMessage({
                    loadingGroupPosition: 30,
                });

                currentlyLoadingGroups[result.windowId] = true;

                if (result.tabs.length || !hasAnotherTabs) { // create empty tab (for quickly change group and not blinking)
                    tempEmptyTabIdPromise = browser.tabs.create({
                            active: true,
                            url: 'about:blank',
                            windowId: windowId,
                        })
                        .then(tab => tab.id);
                }

                if (!group.tabs.length && !hasAnotherTabs) {
                    group.tabs.push({
                        active: true,
                        url: 'about:blank',
                    });

                    let indexGroup = result.groups.findIndex(gr => gr.id === group.id);
                    result.groups[indexGroup].tabs = group.tabs;

                    return saveGroup(group, false)
                        .then(() => result);
                }

                return result;
            })
            .catch(error => notify(error, false, 'error-load-group-notification'))
            .then(function(result) { // remove tabs
                browser.runtime.sendMessage({
                    loadingGroupPosition: 50,
                });

                return browser.tabs.remove(result.tabs.map(tab => tab.id))
                    .then(() => result)
                    .catch(() => loadGroup(undefined, result.currentGroup)); // maybe not ever called
            })
            .then(function(result) { // create tabs
                browser.runtime.sendMessage({
                    loadingGroupPosition: 70,
                });

                if (group.tabs.length) {
                    return Promise.all(group.tabs.map(function(tab, tabIndex) {
                            return browser.tabs.create({
                                active: -1 === activeTabIndex ? Boolean(tab.active) : tabIndex === activeTabIndex,
                                url: tab.url,
                                windowId: windowId,
                                cookieStoreId: tab.cookieStoreId || DEFAULT_COOKIE_STORE_ID,
                            });
                        }))
                        .then(() => result, notify);
                }

                return result;
            })
            .then(function(result) {
                browser.runtime.sendMessage({
                    loadingGroupPosition: 90,
                });

                if (tempEmptyTabIdPromise) {
                    tempEmptyTabIdPromise.then(browser.tabs.remove);
                }

                browser.menus.update(CONTEXT_MENU_PREFIX_GROUP + result.windowsGroup[result.windowId], {
                    enabled: true,
                });
                browser.menus.update(CONTEXT_MENU_PREFIX_GROUP + group.id, {
                    enabled: false,
                });

                result.windowsGroup[result.windowId] = group.id;

                return storage.set({
                        windowsGroup: result.windowsGroup,
                    })
                    .then(() => result);
            })
            .then(function(result) {
                delete currentlyLoadingGroups[result.windowId];

                browser.runtime.sendMessage({
                    loadingGroupPosition: false,
                });

                updateBrowserActionIcon();

                addTabEvents();
            });
    }

    function saveTabs(windowId = browser.windows.WINDOW_ID_CURRENT, excludeTabIds = [], sendEventUpdateStorage) {
        return getData(windowId, false)
            .then(function(result) {
                if (!result.currentGroup.id) {
                    console.error('not found group for window %s', result.windowId);
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

                return saveGroup(result.currentGroup, sendEventUpdateStorage);
            });
    }

    function isCatchedUrl(url, group) {
        if (!group.moveNewTabsToThisGroupByRegExp) {
            return false;
        }

        return group.moveNewTabsToThisGroupByRegExp
            .split(/\s*\n\s*/)
            .filter(Boolean)
            .some(function(regExpStr) {
                try {
                    return new RegExp(regExpStr).test(url);
                } catch (e) { };
            });
    }

    function onActivatedTab({tabId}) {
        browser.tabs.get(tabId)
            .then(function({incognito}) {
                if (incognito) {
                    return;
                }

                if (!isTabCurrentlyRemoving) {
                    saveTabs();
                }
            });
    }

    let currentlyMovingTabs = []; // tabIds

    function onUpdatedTab(tabId, changeInfo, tab) {
        if (tab.status === 'loading' && isEmptyUrl(tab.url)) {
            return;
        }

        if (tab.incognito || !isAllowUrl(tab.url)) {
            return;
        }

        if (!tab.pinned && !isEmptyUrl(tab.url) && !currentlyMovingTabs.includes(tabId)) {
            return getData(tab.windowId)
                .then(function({groups, currentGroup, tabs}) {
                    if (currentlyMovingTabs.includes(tabId)) {
                        return;
                    }

                    let destGroup = groups.find(isCatchedUrl.bind(null, tab.url));

                    if (destGroup && destGroup.id !== currentGroup.id) {
                        currentlyMovingTabs.push(tabId);

                        let tabIndex = tabs.findIndex(tab => tab.id === tabId);
                        return moveTabToGroup(tab, tabIndex, currentGroup.id, destGroup.id)
                            .then(function() {
                                currentlyMovingTabs.splice(currentlyMovingTabs.indexOf(tabId), 1);
                            });
                    }

                    return saveTabs(tab.windowId);
                });
        }

        if ('pinned' in changeInfo || /*'url' in changeInfo || */'complete' === tab.status) {
            saveTabs(tab.windowId);
        }
    }

    function getGroupByWindowId(windowId) { // windowId - real window id
        return storage.get(['groups', 'windowsGroup'])
            .then(({groups, windowsGroup}) => groups.find(group => group.id === windowsGroup[windowId]));
    }

    function onRemovedTab(removedTabId, {isWindowClosing, windowId}) { // TODO add ignore incognito
        if (isWindowClosing) {
            return;
        }

        browser.windows.get(windowId)
            .then(function({incognito}) {
                if (incognito) {
                    return;
                }

                isTabCurrentlyRemoving = true;

                saveTabs(windowId, [removedTabId])
                    .then(() => isTabCurrentlyRemoving = false);
            });
    }

    function onMovedTab(tabId, {windowId}) {
        browser.windows.get(windowId)
            .then(function({incognito}) {
                if (incognito) {
                    return;
                }

                saveTabs(windowId, [], false); // no need event because popup are hidded when tabs is moved
            });
    }

    let detachEventPromise = null;

    function onAttachedTab(tabId, {newWindowId}) {
        detachEventPromise.then(function() {
            getGroupByWindowId(newWindowId)
                .then(function(group) {
                    if (group) {
                        saveTabs(newWindowId, [], false);
                    } else {
                        Promise.all([
                                addGroup(undefined, newWindowId),
                                browser.tabs.get(tabId)
                            ])
                            .then(function([newGroup, tab]) {
                                newGroup.tabs.push(mapTab(tab));
                                return saveGroup(newGroup);
                            });
                    }
                });
        });
    }

    function onDetachedTab(tabId, {oldWindowId}) {
        detachEventPromise = new Promise(function(resolve) {
            getGroupByWindowId(oldWindowId)
                .then(function(group) {
                    group.tabs = group.tabs.filter(tab => tab.id !== tabId);
                    return saveGroup(group);
                })
                .then(resolve);
        });
    }

    function addTabEvents() {
        browser.tabs.onActivated.addListener(onActivatedTab);
        browser.tabs.onUpdated.addListener(onUpdatedTab);
        browser.tabs.onRemoved.addListener(onRemovedTab);

        browser.tabs.onMoved.addListener(onMovedTab);

        browser.tabs.onAttached.addListener(onAttachedTab);
        browser.tabs.onDetached.addListener(onDetachedTab);
    }

    function removeTabEvents() {
        browser.tabs.onActivated.removeListener(onActivatedTab);
        browser.tabs.onUpdated.removeListener(onUpdatedTab);
        browser.tabs.onRemoved.removeListener(onRemovedTab);

        browser.tabs.onMoved.removeListener(onMovedTab);

        browser.tabs.onAttached.removeListener(onAttachedTab);
        browser.tabs.onDetached.removeListener(onDetachedTab);
    }

    function moveTabToGroup(tab, tabIndex, srcGroupId, destGroupId) {
        return storage.get('groups')
            .then(function({groups}) {
                let srcGroup = groups.find(({id}) => id === srcGroupId),
                    destGroup = groups.find(({id}) => id === destGroupId),
                    mappedTab = mapTab(tab),
                    groupsToSave = [],
                    promises = [],
                    createdTabId = null,
                    destWinId = null,
                    createdTabIndex = null;

                promises.push(new Promise(function(resolve) {
                    isGroupLoadInWindow(srcGroup)
                        .then(function(win) {
                            return removeCurrentTabByIndex(win.id, tabIndex, 1 === srcGroup.tabs.length);
                        })
                        .then(resolve)
                        .catch(function() {
                            srcGroup.tabs.splice(tabIndex, 1);
                            groupsToSave.push(srcGroup);
                            resolve();
                        });
                }));

                promises.push(new Promise(function(resolve) {
                    isGroupLoadInWindow(destGroup)
                        .then(function(win) {
                            destWinId = win.id;
                            return browser.tabs.create({
                                    active: false,
                                    url: tab.url,
                                    windowId: win.id,
                                    cookieStoreId: tab.cookieStoreId || DEFAULT_COOKIE_STORE_ID,
                                })
                                .then(tab => createdTabId = tab.id)
                                .then(resolve);
                        })
                        .catch(function() {
                            createdTabIndex = destGroup.tabs.push(mappedTab) - 1;
                            groupsToSave.push(destGroup);
                            resolve();
                        });
                }));

                return Promise.all(promises)
                    .then(function() {
                        if (groupsToSave.length) {
                            return saveGroup(groupsToSave);
                        }
                    })
                    .then(() => storage.get('showNotificationAfterMoveTab'))
                    .then(function({showNotificationAfterMoveTab}) { // show notification
                        if (!showNotificationAfterMoveTab) {
                            return;
                        }

                        let title = mappedTab.title.length > 50 ? (mappedTab.title.slice(0, 50) + '...') : mappedTab.title,
                            message = browser.i18n.getMessage('moveTabToGroupMessage', [destGroup.title, title]);

                        return notify(message)
                            .then(function() {
                                if (destWinId && createdTabId) {
                                    return browser.windows.update(destWinId, {
                                            focused: true,
                                        })
                                        .then(function() {
                                            return browser.tabs.update(createdTabId, {
                                                active: true,
                                            });
                                        });
                                }

                                return loadGroup(undefined, destGroup, false, createdTabIndex);
                            });
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

                            getData()
                                .then(function(result) {
                                    let tabIndex = result.tabs.findIndex(({id}) => id === tab.id);

                                    if (tabIndex > -1) {
                                        moveTabToGroup(tab, tabIndex, result.currentGroup.id, destGroupId);
                                    }
                                })
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
                                let tabIndex = result.tabs.findIndex(({id}) => id === tab.id),
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

    function updateBrowserActionIcon() {
        getData().then(function({currentGroup}) {
            browser.browserAction.setTitle({
                title: currentGroup.title + ' - ' + browser.i18n.getMessage('extensionName'),
            });

            browser.browserAction.setIcon({
                path: getBrowserActionSvgPath(currentGroup.iconColor),
            });
        });
    }

    browser.windows.onFocusChanged.addListener(function(windowId) {
        if (browser.windows.WINDOW_ID_NONE === windowId) {
            resetBrowserActionIcon();
            return removeMoveTabMenus();
        }

        browser.windows.getLastFocused({
                windowTypes: ['normal'],
            })
            .then(function(win) {
                if (win.incognito) {
                    browser.browserAction.disable();
                    resetBrowserActionIcon();
                    removeMoveTabMenus();
                } else {
                    browser.browserAction.enable();
                    updateBrowserActionIcon();
                    removeMoveTabMenus().then(createMoveTabMenus);
                }
            });
    });

    browser.menus.create({
        id: 'openSettings',
        title: browser.i18n.getMessage('openSettings'),
        onclick: () => browser.runtime.openOptionsPage(),
        contexts: ['browser_action'],
        icons: {
            16: 'icons/settings.svg',
            32: 'icons/settings.svg',
        },
    });

    getData()
        .then(function(result) {
            if (!result.groups.length || !result.currentGroup.id) {
                return addGroup(undefined, result.windowId)
                    .then(() => saveTabs());
            }

            return saveTabs();
        })
        .then(updateBrowserActionIcon)
        .then(createMoveTabMenus)
        .then(addTabEvents);


    window.background = {
        getData,
        getTabs,
        moveTabToGroup,

        removeMoveTabMenus,
        createMoveTabMenus,
        updateBrowserActionIcon,
        isGroupLoadInWindow,

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

})()
