(function() {
    'use strict';

    // TODO
    // refactor for fully support multi windows
    // fix bugs create new tab
// storage.get(null).then(console.log);
    let isTabCurrentlyRemoving = false,
        currentlyLoadingGroups = {}; // windowId: true

    function getCurrentWindow() {
        return browser.windows.getCurrent({
            windowTypes: ['normal'],
        });
    }

    function getNotPinnedTabs(filterTabs = true, mapTabs = true) {
        return browser.tabs.query({
                currentWindow: true,
                pinned: false,
            })
            .then(function(tabs) {
                tabs = Array.from(tabs);

                if (filterTabs) {
                    tabs = tabs.filter(tab => isAllowUrl(tab.url));
                }

                if (mapTabs) {
                    tabs = tabs.map(mapTab);
                }

                return tabs;
            });
    }

    function hasAnotherTabs(eachFunc = 'some') {
        return browser.tabs.query({
                currentWindow: true,
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

    function getCurrentData(filterTabs, mapTabs) {
        return Promise.all([
                storage.get(['groups', 'windowsGroup']),
                getCurrentWindow(),
                getNotPinnedTabs(filterTabs, mapTabs),
            ])
            .then(function([result, currentWindow, tabs]) {
                return {
                    groups: result.groups,
                    windowsGroup: result.windowsGroup,
                    currentWindowId: currentWindow.id,
                    currentWindowTabs: tabs,
                    currentGroup: result.groups.find(group => group.id === result.windowsGroup[currentWindow.id]) || {}, // empty obj use on init bg and saveCurrentTabs
                };
            });
    }

    function addGroup(resetGroups = false, windowId = null) { // if reset groups then return all groups else return new group
        return storage.get(['groups', 'lastCreatedGroupPosition', 'windowsGroup'])
            .then(function(result) {
                result.lastCreatedGroupPosition++;

                if (resetGroups) {
                    result.groups = [];
                }

                let isFirstGroup = 0 === result.groups.length;

                result.groups.push(createGroup(result.lastCreatedGroupPosition));

                let promArr = [result];

                if (isFirstGroup) {
                    promArr.push(getCurrentWindow().then(win => win.id));
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
                    .then(() => resetGroups ? result.groups : newGroup);
            })
            .then(result => removeMoveTabMenus().then(() => result))
            .then(result => createMoveTabMenus().then(() => result));
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
        let isCurrentGroup = null;

        return getCurrentData()
            .then(function(result) {
                isCurrentGroup = oldGroup.id === result.currentGroup.id;

                if (1 === result.groups.length) { // if remove last group
                    return addGroup(true); // reset, crete new group and return all groups
                }

                result.groups = result.groups.filter(group => oldGroup.id !== group.id);

                return storage.set({
                        groups: result.groups,
                    })
                    .then(() => result.groups);
            })
            .then(function(groups) {
                if (isCurrentGroup) {
                    return loadGroup(groups[0], false, -1);
                }
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
                .then(function({id: windowId}) {
                    return browser.tabs.create({ // after this - will trigger events on create tab and add tab in group
                            active: false,
                            url: 'about:blank',
                            cookieStoreId,
                            windowId,
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

    function removeCurrentTabByIndex(tabIndex, isLastTabInGroup) {
        return Promise.all([
                getNotPinnedTabs(),
                hasAnotherTabs()
            ])
            .then(function([tabs, hasAnotherTabs]) {
                let tabId = tabs[tabIndex].id;

                if (!hasAnotherTabs && isLastTabInGroup) {
                    return browser.tabs.create({
                            url: 'about:blank',
                        })
                        .then(() => tabId);
                }

                return tabId;
            })
            .then(browser.tabs.remove);
    }

    function removeTab(tabToRemove, group, isCurrentGroup) { // TODO refactor this
        let tabIndex = group.tabs.indexOf(tabToRemove);

        group.tabs.splice(tabIndex, 1);

        return saveGroup(group)
            .then(function() {
                if (isCurrentGroup) {
                    return removeCurrentTabByIndex(tabIndex, !group.tabs.length);
                } else {
                    return new Promise(function(resolve) { // find tab in other window
                        Promise.all([
                                browser.tabs.get(tabToRemove.id),
                                getCurrentWindow()
                            ])
                            .then(function([tab, win]) {
                                if (tab.windowId !== win.id) {
                                    browser.tabs.remove(tab.id);
                                }

                                resolve();
                            })
                            .catch(resolve);
                    });
                }
            });
    }

    function loadGroup(group, isCurrentGroup, activeTabIndex) {
        if (isCurrentGroup) {
            return getNotPinnedTabs()
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
                getCurrentData(),
                hasAnotherTabs()
            ])
            .then(function([result, hasAnotherTabs]) {
                if (currentlyLoadingGroups[result.currentWindowId]) {
                    throw browser.i18n.getMessage('errorAnotherGroupAreLoading');
                }

                browser.runtime.sendMessage({
                    loadingGroupPosition: 30,
                });

                currentlyLoadingGroups[result.currentWindowId] = true;

                tempEmptyTabIdPromise = browser.tabs.create({
                        active: true,
                        url: 'about:blank',
                    })
                    .then(tab => tab.id);

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
                return browser.tabs.remove(result.currentWindowTabs.map(tab => tab.id))
                    .then(() => result)
                    .catch(() => loadGroup(result.currentGroup, true, -1));
            })
            .then(function(result) {
                browser.runtime.sendMessage({
                    loadingGroupPosition: 50,
                });

                return result;
            })
            .then(function(result) { // create tabs
                if (group.tabs.length) {
                    return Promise.all(group.tabs.map(function(tab, tabIndex) {
                            return browser.tabs.create({
                                active: -1 === activeTabIndex ? Boolean(tab.active) : tabIndex === activeTabIndex,
                                url: tab.url,
                                cookieStoreId: tab.cookieStoreId || DEFAULT_COOKIE_STORE_ID,
                            });
                        }))
                        .then(() => result, () => result);
                }

                return result;
            })
            .then(function(result) {
                browser.runtime.sendMessage({
                    loadingGroupPosition: 90,
                });

                return result;
            })
            .then(function(result) {
                tempEmptyTabIdPromise.then(browser.tabs.remove);

                browser.menus.update(CONTEXT_MENU_PREFIX_GROUP + result.windowsGroup[result.currentWindowId], {
                    enabled: true,
                });
                browser.menus.update(CONTEXT_MENU_PREFIX_GROUP + group.id, {
                    enabled: false,
                });

                result.windowsGroup[result.currentWindowId] = group.id;

                return storage.set({
                        windowsGroup: result.windowsGroup,
                    })
                    .then(() => result);
            })
            .then(function(result) {
                delete currentlyLoadingGroups[result.currentWindowId];

                browser.runtime.sendMessage({
                    loadingGroupPosition: false,
                });

                addTabEvents();
            });
    }

    function saveCurrentTabs(excludeTabIds = [], sendEventUpdateStorage) {
        return getCurrentData(undefined, false)
            .then(function(result) {
                if (!result.currentGroup.id) {
                    return;
                }

                result.currentGroup.tabs = result.currentWindowTabs
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
                } catch (e) {};
            });
    }

    function onActivatedTab(activeInfo) {
        if (!isTabCurrentlyRemoving) {
            saveCurrentTabs();
        }
    }

    function onUpdatedTab(tabId, changeInfo, tab) {
        if (tab.status === 'loading' && isEmptyUrl(tab.url)) {
            return;
        }

        if (tab.incognito || !isAllowUrl(tab.url)) {
            return;
        }

        if (!tab.pinned && !isEmptyUrl(tab.url)) {
            return getCurrentData()
                .then(function(result) {
                    let destGroup = result.groups.find(isCatchedUrl.bind(null, tab.url));

                    if (destGroup && destGroup.id !== result.currentGroup.id) {
                        let tabIndex = result.currentWindowTabs.findIndex(tab => tab.id === tabId);
                        return moveTabToGroup(tab, tabIndex, result.currentGroup.id, destGroup.id);
                    }

                    return saveCurrentTabs();
                });
        }

        if ('pinned' in changeInfo || /*'url' in changeInfo || */'complete' === tab.status) {
            saveCurrentTabs();
        }
    }

    function getGroupByWindowId(windowId) {
        return storage.get(['groups', 'windowsGroup'])
            .then(({groups, windowsGroup}) => groups.find(group => group.id === windowsGroup[windowId]));
    }

    // removeInfo: {windowId, isWindowClosing}
    function onRemovedTab(removedTabId, {isWindowClosing, windowId}) {
        if (isWindowClosing) {
            return;
        }

        isTabCurrentlyRemoving = true;

        saveCurrentTabs([removedTabId])
            .then(() => isTabCurrentlyRemoving = false);
    }

    function onMovedTab(tabId, moveInfo) {
        saveCurrentTabs([], true); // no need event because popup isHidded when tabs is moved
    }

    function onAttachedTab(tabId, attachInfo) {
        setTimeout(function(tabId, attachInfo) {
            Promise.all([
                    storage.get(['groups', 'windowsGroup']),
                    browser.tabs.get(tabId)
                ])
                .then(function(result) {
                    let [data, tab] = result;

                    if (!data.windowsGroup[attachInfo.newWindowId]) {
                        return addGroup(false, attachInfo.newWindowId)
                            .then(function(newGroup) {
                                newGroup.tabs.push(mapTab(tab));
                                return saveGroup(newGroup);
                            });
                    }

                    saveCurrentTabs();
                });
        }, 300, tabId, attachInfo);
    }

    function onDetachedTab(tabId, detachInfo) {
        storage.get(['groups', 'windowsGroup'])
            .then(function(result) {
                result.groups.some(function(group) {
                    if (group.id === result.windowsGroup[detachInfo.oldWindowId]) {
                        group.tabs = group.tabs.filter(tab => tab.id != tabId);
                        return saveGroup(group);
                    }
                });
            });
    }

    function addTabEvents() {
        // browser.tabs.onCreated.addListener(onCreatedTab);
        browser.tabs.onActivated.addListener(onActivatedTab);
        browser.tabs.onUpdated.addListener(onUpdatedTab);
        browser.tabs.onRemoved.addListener(onRemovedTab);

        browser.tabs.onMoved.addListener(onMovedTab);

        browser.tabs.onAttached.addListener(onAttachedTab);
        browser.tabs.onDetached.addListener(onDetachedTab);
    }

    function removeTabEvents() {
        // browser.tabs.onCreated.removeListener(onCreatedTab);
        browser.tabs.onActivated.removeListener(onActivatedTab);
        browser.tabs.onUpdated.removeListener(onUpdatedTab);
        browser.tabs.onRemoved.removeListener(onRemovedTab);

        browser.tabs.onMoved.removeListener(onMovedTab);

        browser.tabs.onAttached.removeListener(onAttachedTab);
        browser.tabs.onDetached.removeListener(onDetachedTab);
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

    function moveTabToGroup(tab, tabIndex, srcGroupId, destGroupId) {
        return getCurrentData()
            .then(function({groups, currentGroup}) {
                let destGroup = groups.find(({id}) => id === destGroupId),
                    srcGroup = groups.find(({id}) => id === srcGroupId),
                    mappedTab = mapTab(tab),
                    groupsToSave = [],
                    createdTabId = 0,
                    createdTabIndex = -1;

                // work with storage
                if (currentGroup.id !== destGroupId) {
                    createdTabIndex = destGroup.tabs.push(mappedTab) - 1;
                    groupsToSave.push(destGroup);
                }

                if (currentGroup.id !== srcGroupId) {
                    srcGroup.tabs.splice(tabIndex, 1);
                    groupsToSave.push(srcGroup);
                }

                return saveGroup(groupsToSave)
                    .then(function() {
                        if (currentGroup.id === destGroupId) {
                            return browser.tabs.create({
                                    active: false,
                                    url: tab.url,
                                    cookieStoreId: tab.cookieStoreId || DEFAULT_COOKIE_STORE_ID,
                                })
                                .then(tab => createdTabId = tab.id);
                        } else if (currentGroup.id === srcGroupId) {
                            return removeCurrentTabByIndex(tabIndex, 1 === srcGroup.tabs.length);
                        }
                    })
                    .then(() => storage.get('showNotificationAfterMoveTab'))
                    .then(function({showNotificationAfterMoveTab}) { // show notification
                        if (!showNotificationAfterMoveTab) {
                            return;
                        }

                        let message = browser.i18n.getMessage('moveTabToGroupMessage', [destGroup.title, mappedTab.title]);

                        return notify(message)
                            .then(() => getCurrentData())
                            .then(function({groups, currentGroup}) {
                                let group = groups.find(({id}) => id === destGroupId),
                                    isCurrentGroup = currentGroup.id === destGroupId;

                                if (isCurrentGroup && createdTabId) {
                                    return browser.tabs.update(createdTabId, {
                                        active: true,
                                    });
                                }

                                return loadGroup(group, isCurrentGroup, createdTabIndex);
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
        return getCurrentData()
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
                            16: createSvgColoredIcon(group.iconColor),
                        },
                        contexts: ['tab'],
                        onclick: function(destGroupId, info, tab) {
                            if (tab.incognito) {
                                return;
                            }

                            getCurrentData()
                                .then(function(result) {
                                    let tabIndex = result.currentWindowTabs.findIndex(({id}) => id === tab.id);

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
                            .then(() => getCurrentData())
                            .then(function(result) {
                                let tabIndex = result.currentWindowTabs.findIndex(({id}) => id === tab.id),
                                    isLastTabInGroup = result.currentGroup.tabs.length > 1;

                                if (tabIndex > -1) {
                                    removeCurrentTabByIndex(tabIndex, isLastTabInGroup);
                                }
                            });
                    },
                }));
            });
    }

    browser.windows.onFocusChanged.addListener(function(windowId) {
        if (browser.windows.WINDOW_ID_NONE === windowId) {
            return removeMoveTabMenus();
        }

        browser.windows.getLastFocused({
                windowTypes: ['normal'],
            })
            .then(function(win) {
                if (win.incognito) {
                    browser.browserAction.disable();
                    removeMoveTabMenus();
                } else {
                    browser.browserAction.enable();
                    removeMoveTabMenus().then(createMoveTabMenus);
                }
            });
    });

    function createSvgColoredIcon(color) {
        if (!color) {
            return '';
        }

        let svg = `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" width="124px" height="124px" viewBox="0 0 124 124" style="enable-background:new 0 0 124 124;" xml:space="preserve"><g><circle fill="${color}" cx="62" cy="62" r="62"/></g></svg>`;

        return 'data:image/svg+xml;base64,' + b64EncodeUnicode(svg);
    }


    getCurrentData()
        .then(function(result) {
            if (!result.groups.length || !result.currentGroup.id) {
                return addGroup(undefined, result.currentWindowId)
                    .then(() => saveCurrentTabs());
            }

            return saveCurrentTabs();
        })
        .then(createMoveTabMenus)
        .then(addTabEvents);


    window.background = {
        getCurrentData,
        getNotPinnedTabs,
        createSvgColoredIcon,
        moveTabToGroup,

        removeMoveTabMenus,
        createMoveTabMenus,

        loadGroup,

        mapTab,

        addTab,
        removeTab,

        createGroup,
        addGroup,
        saveGroup,
        removeGroup,
    };

})()
