(function() {
    'use strict';

    let isTabCurrentlyRemoving = false,
        currentlyLoadingGroups = {}; // windowId: true

    // return storage.remove('activeTabIndex');
    // return storage.set({version: '1.0', windowsGroup: {5:29}});

    // storage.get(null).then(console.log);
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

                let isFirstGroup = 1 === result.groups.length,
                    promises = [result];

                if (1 === result.groups.length) {
                    promises.push(getWindow().then(win => win.id));
                } else if (windowId) {
                    promises.push(windowId);
                }



                // if (windowId) {
                //     promises.push(windowId);
                // } else {
                //     promises.push(getWindow().then(win => win.id));
                // }

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
    function saveGroup(groups, sendEventUpdateStorage) {
        return storage.get('groups')
            .then(function(result) {
                groups = Array.isArray(groups) ? groups : [groups];

                return storage.set({
                    groups: result.groups.map(group => groups.find(({ id }) => id === group.id) || group),
                }, sendEventUpdateStorage);
            });
    }

    function removeGroup(oldGroup) {
        return new Promise(function(resolve) {
                storage.get('groups').then(function(result) {
                    let oldGroupIndex = result.groups.findIndex(group => oldGroup.id === group.id),
                        getNewGroupIndex = function(oldIndex, newGroupsLength) {
                            return (oldIndex > newGroupsLength - 1) ? (newGroupsLength - 1) : oldIndex;
                        };

                    result.groups.splice(oldGroupIndex, 1);

                    isGroupLoadInWindow(oldGroup)
                        .then(function(oldGroupWindow) {
                            getWindow().then(function(currentWindow) {
                                if (oldGroupWindow.id === currentWindow.id) {
                                    if (!result.groups.length) { // if remove last group
                                        addGroup(true, currentWindow.id) // reset all groups
                                            .then(newGroup => loadGroup(currentWindow.id, newGroup))
                                            .then(resolve);
                                    } else {
                                        storage.set(result)
                                            .then(function() {
                                                let newGroupIndex = getNewGroupIndex(oldGroupIndex, result.groups.length);
                                                return loadGroup(currentWindow.id, result.groups[newGroupIndex]);
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
                }

                return storage.set({
                    groups,
                });
            })
            .then(removeMoveTabMenus)
            .then(createMoveTabMenus);
    }

    function isGroupLoadInWindow(group, withTabs = false, filterTabs = true) { // reject if not load group
        if (!group.windowId) {
            return Promise.reject();
        }

        return browser.windows.get(group.windowId, {
                populate: withTabs,
                windowTypes: ['normal'],
            })
            .then(function(win) {
                if (withTabs && filterTabs) {
                    win.tabs = win.tabs.filter(tab => isAllowUrl(tab.url));
                }

                return win;
            });
    }

    function addTab(group, cookieStoreId) {
        return new Promise(function(resolve, reject) {
            isGroupLoadInWindow(group)
                .then(function() {
                    return browser.tabs.create({ // after this - will trigger events on create tab and add tab in group
                            active: false,
                            url: 'about:blank',
                            cookieStoreId,
                            windowId: group.windowId,
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
        return new Promise(function(resolve, reject) {
            isGroupLoadInWindow(group)
                .then(function() {
                    removeCurrentTabByIndex(group.windowId, tabIndex, 1 === group.tabs.length)
                        .then(resolve, reject);
                })
                .catch(function() {
                    group.tabs.splice(tabIndex, 1);
                    saveGroup(group).then(resolve, reject);
                });
        });
    }

    function loadGroup(windowId, group, activeTabIndex = -1) {
        if (currentlyLoadingGroups[windowId]) {
            notify(browser.i18n.getMessage('errorAnotherGroupAreLoading'), false, 'error-load-group-notification');
            return Promise.reject();
        }
storage.get('groups').then(console.log);
browser.windows.getAll().then(console.log);

        return new Promise(function(resolve, reject) {
                isGroupLoadInWindow(group, true) // return window with tabs
                    .then(function(groupWindow) {
                        if (group.windowId === groupWindow.id) {
                            if (groupWindow.tabs[activeTabIndex]) {
                                browser.tabs.update(groupWindow.tabs[activeTabIndex].id, {
                                    active: true,
                                });
                                resolve();
                            } else {
                                console.log(1);
                                reject();
                            }
                        } else {
                            notify(browser.i18n.getMessage('errorThisGroupAlreadyLoadedInOtherWindow'));
                            reject();
                        }
                    })
                    .catch(function() {
                        // magic

                        currentlyLoadingGroups[windowId] = true;

                        removeEvents();

                        browser.runtime.sendMessage({
                            loadingGroupPosition: 10,
                        });

                        let tempEmptyTabId = null,
                            tempEmptyTabIdPromise = Promise.resolve(),
                            indexGroup = null;

                        Promise.all([
                                getData(windowId),
                                hasAnotherTabs(windowId)
                            ])
                            .then(function([result, hasAnotherTabs]) {
                                browser.runtime.sendMessage({
                                    loadingGroupPosition: 20,
                                });

                                indexGroup = result.groups.findIndex(gr => gr.id === group.id);

                                result.groups = result.groups.map(function(gr) {
                                    if (gr.windowId === windowId) {
                                        gr.windowId = null;
                                    } else if (gr.id === group.id) {
                                        gr.windowId = windowId;
                                    }

                                    // gr.windowId = gr.id === group.id ? windowId : null;
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
                            })
                            .catch(notify)
                            .then(resolve, reject);
                    });
            })
            .catch(function() {
                delete currentlyLoadingGroups[windowId];
            });
    }

    function saveTabs(windowId = browser.windows.WINDOW_ID_CURRENT, excludeTabIds = [], sendEventUpdateStorage) {
        return getData(windowId, false)
            .then(function(result) {
                if (!result.currentGroup.id) {
                    console.error('not found group for window %s', result.windowId);
                    return;
                }

                // console.log('saveTabs windowId: ', windowId, result.currentGroup, result.tabs.length);

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

    function onActivatedTab({ tabId }) {
        browser.tabs.get(tabId)
            .then(function({ incognito }) {
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
                .then(function({ groups, currentGroup, tabs }) {
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

        if ('pinned' in changeInfo || /*'url' in changeInfo || */ 'complete' === tab.status) {
            saveTabs(tab.windowId);
        }
    }

    function getGroupByWindowId(windowId) { // windowId - real window id
        return storage.get('groups')
            .then(({ groups }) => groups.find(group => group.windowId === windowId));
    }

    function onRemovedTab(removedTabId, { isWindowClosing, windowId }) {
        if (isWindowClosing) {
            return;
        }

        browser.windows.get(windowId)
            .then(function({ incognito }) {
                if (incognito) {
                    return;
                }

                isTabCurrentlyRemoving = true;
                console.log('onRemovedTab');
                saveTabs(windowId, [removedTabId])
                    .then(() => isTabCurrentlyRemoving = false);
            });
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

    let detachEventPromise = null;

    function onAttachedTab(tabId, { newWindowId }) {
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

    function onDetachedTab(tabId, { oldWindowId }) {
        detachEventPromise = new Promise(function(resolve) {
            getGroupByWindowId(oldWindowId)
                .then(function(group) {
                    group.tabs = group.tabs.filter(tab => tab.id !== tabId);
                    return saveGroup(group);
                })
                .then(resolve);
        });
    }

    function onFocusChangedWindow(windowId) {
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
                    updateBrowserActionData();
                    removeMoveTabMenus().then(createMoveTabMenus);
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
    }

    function removeEvents() {
        browser.tabs.onActivated.removeListener(onActivatedTab);
        browser.tabs.onUpdated.removeListener(onUpdatedTab);
        browser.tabs.onRemoved.removeListener(onRemovedTab);

        browser.tabs.onMoved.removeListener(onMovedTab);

        browser.tabs.onAttached.removeListener(onAttachedTab);
        browser.tabs.onDetached.removeListener(onDetachedTab);

        browser.windows.onFocusChanged.removeListener(onFocusChangedWindow);
    }

    function moveTabToGroup(tab, tabIndex, srcGroupId, destGroupId, showNotificationAfterMoveTab = true) {
        return storage.get('groups')
            .then(function({ groups }) {
                let srcGroup = groups.find(({ id }) => id === srcGroupId),
                    destGroup = groups.find(({ id }) => id === destGroupId),
                    mappedTab = mapTab(tab),
                    groupsToSave = [],
                    promises = [],
                    createdTabId = null,
                    createdTabIndex = null;

                promises.push(new Promise(function(resolve) {
                    isGroupLoadInWindow(srcGroup)
                        .then(function() {
                            return removeCurrentTabByIndex(srcGroup.windowId, tabIndex, 1 === srcGroup.tabs.length);
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
                        .then(function() {
                            return browser.tabs.create({
                                    active: false,
                                    url: tab.url,
                                    windowId: destGroup.windowId,
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
                    .then(function(options) { // show notification
                        if (!options.showNotificationAfterMoveTab || !showNotificationAfterMoveTab) {
                            return;
                        }

                        let title = mappedTab.title.length > 50 ? (mappedTab.title.slice(0, 50) + '...') : mappedTab.title,
                            message = browser.i18n.getMessage('moveTabToGroupMessage', [destGroup.title, title]);

                        notify(message).then(function(createdTabId, createdTabIndex, destGroup) {
                            if (createdTabId) {
                                browser.windows.update(destGroup.windowId, {
                                        focused: true,
                                    })
                                    .then(function() {
                                        return browser.tabs.update(createdTabId, {
                                            active: true,
                                        });
                                    });
                            } else {
                                browser.windows.getLastFocused({
                                        windowTypes: ['normal'],
                                    })
                                    .then(win => loadGroup(win.id, destGroup, createdTabIndex));
                            }
                        }.bind(null, createdTabId, createdTabIndex, destGroup));
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
                                    moveTabToGroup(tab, tabIndex, result.currentGroup.id, destGroupId);
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

    // initialization
    Promise.all([
            storage.get(null),
            getWindow()
        ])
        .then(function([result, win]) { // migration
            let manifestVerion = browser.runtime.getManifest().version,
                keysToRemoveFromStorage = [];

            if (result.version === manifestVerion) {
                return [result, win];
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
                .then(() => storage.set(result))
                .then(() => [result, win]);
        })
        .catch(notify)
        .then(function([result, win]) {
            // console.log('result, win', result, win);
            if (!result.groups.some(group => group.windowId === win.id)) {
                return addGroup(undefined, win.id)
                    .then(() => saveTabs(win.id));
            }

            return saveTabs(win.id);
        })
        .then(updateBrowserActionData)
        .then(createMoveTabMenus)
        .then(addEvents);

    // getData()
    //     .then(function(result) {
    //         if (!result.groups.length || !result.currentGroup.id) {
    //             return addGroup(undefined, result.windowId)
    //                 .then(() => saveTabs());
    //         }

    //         return saveTabs();
    //     })
    //     .then(updateBrowserActionData)
    //     .then(createMoveTabMenus)
    //     .then(addEvents);


    window.background = {
        getData,
        getTabs,
        moveTabToGroup,

        removeMoveTabMenus,
        createMoveTabMenus,
        updateBrowserActionData,
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
