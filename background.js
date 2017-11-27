(function() {
    'use strict';

    // TODO
    // fix bugs loadGroup
    // fix bugs contexmenu with other window
    // fix bugs create new tab

    function filterTabs(tabs) {
        return Array.from(tabs)
            .filter(tab => isAllowUrl(tab.url) && !tab.pinned);
    }

    function getCurrentWindow(populate = false) {
        return browser.windows.getCurrent({
                populate: Boolean(populate),
                windowTypes: ['normal'],
            })
            .then(function(currentWindow) {
                if (populate) {
                    return {
                        id: currentWindow.id,
                        tabs: filterTabs(currentWindow.tabs).map(mapTab),
                    };
                }

                return currentWindow;
            });
    }

    function getTabs(options, dontUseMapTab) {
        return browser.tabs.query(Object.assign(options, {
                currentWindow: true,
            }))
            .then(filterTabs)
            .then(tabs => dontUseMapTab ? tabs : tabs.map(mapTab));
    }

    function getNotPinnedTabs(dontUseMapTab) {
        return getTabs({
            pinned: false,
        }, dontUseMapTab);
    }

    function hasAnotherTabs() {
        return browser.tabs.query({
                currentWindow: true,
            })
            .then(tabs => tabs.some(tab => tab.pinned || !isAllowUrl(tab.url)));
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
            catchRegExpRules: '',
        };
    }

    function getCurrentData() {
        return Promise.all([
                storage.get(['groups', 'windowsGroup']),
                getCurrentWindow(true)
            ])
            .then(function(result) {
                let [data, currentWindow] = result;

                return {
                    groups: data.groups,
                    windowsGroup: data.windowsGroup,
                    currentWindowId: currentWindow.id,
                    currentWindowTabs: currentWindow.tabs,
                    currentGroup: data.groups.find(group => group.id === data.windowsGroup[currentWindow.id]) || {}, // ???????????????? need empty obj ?
                };
            });
    }

    function addGroup(resetGroups, windowId) { // if reset groups then return all groups else return new group
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
            .then(function(result) {
                let [data, winId] = result,
                newGroup = data.groups.slice(-1).pop(); // get last group

                if (winId) {
                    data.windowsGroup[winId] = newGroup.id;
                }

                return storage.set(data)
                    .then(() => resetGroups ? data.groups : newGroup);
            })
            .then(result => removeMoveTabMenus().then(() => result))
            .then(result => createMoveTabMenus().then(() => result));
    }

    // groups : Object or array of Object
    function saveGroup(groups, dontEventUpdateStorage) {
        return storage.get('groups')
            .then(function(result) {
                groups = Array.isArray(groups) ? groups : [groups];

                return storage.set({
                    groups: result.groups.map(group => groups.find(({id}) => id === group.id) || group),
                }, dontEventUpdateStorage);
            });
    }

    function removeGroup(oldGroup) {
        let isCurrentGroup = null;

        return getCurrentData()
            .then(function(result) {
                isCurrentGroup = oldGroup.id === result.currentGroup.id;

                if (1 === result.groups.length) { // remove last group
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

    function addTab(group, cookieStoreId) {
        return getCurrentData()
            .then(function(result) {
                if (group.id === result.currentGroup.id) { // after this - will trigger events on create tab and add tab in group
                    return browser.tabs.create({
                        active: false,
                        url: 'about:blank',
                        cookieStoreId,
                    });
                }

                group.tabs.push({
                    url: 'about:blank',
                    cookieStoreId,
                });

                return saveGroup(group);
            });
    }

    function removeCurrentTabByIndex(tabIndex, isLastTabInGroup) {
        return Promise.all([
                getNotPinnedTabs(),
                hasAnotherTabs()
            ])
            .then(function(result) {
                let [tabs, hasAnotherTabs] = result,
                tabId = tabs[tabIndex].id;

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

    function removeTab(tabToRemove, group, isCurrentGroup) {
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
                            .then(function(result) {
                                let [tab, win] = result;

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

    // function setActiveTab(activeTabIndex) {
    //     if (activeTabIndex < 0) {
    //         return;
    //     }

    //     return getNotPinnedTabs()
    //         .then(function(tabs) {
    //             if (tabs[activeTabIndex]) {
    //                 return browser.tabs.update(tabs[activeTabIndex].id, {
    //                     active: true,
    //                 });
    //             }
    //         });
    // }



    let loadingGroups = {}; // windowId: true

    // if activeTabIndex === -1 active last active tab
    function loadGroup(group, isCurrentGroup, activeTabIndex) {
        // if (-1 === activeTabIndex) {
        //     activeTabIndex = group.tabs.findIndex(tab => tab.active);
        // }

        if (isCurrentGroup) {
            // return setActiveTab(activeTabIndex);
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

        let currentWindowId = null,
            tempEmptyTabIdPromise = null;

        return Promise.all([
                getCurrentData(),
                hasAnotherTabs()
            ])
            // .catch(notify)
            .then(function([result, hasAnotherTabs]) {
                if (loadingGroups[result.currentWindowId]) {
                    throw 'Another group loading...';
                }

                currentWindowId = result.currentWindowId;
                loadingGroups[result.currentWindowId] = true;

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

                    return saveGroup(group, true)
                        .then(() => result);
                }

                return result;
            })
            .catch(notify)
            .then(function(result) { // remove tabs
                return browser.tabs.remove(result.currentWindowTabs.map(tab => tab.id))
                    .then(() => result)
                    .catch(() => loadGroup(result.currentGroup, true, -1));
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
                });
            })
            .then(() => delete loadingGroups[currentWindowId])
            .then(addTabEvents);
    }

    // @excludeTabIds : Array of integer
    // @addTabs : array of tabs
    function saveCurrentTabs(excludeTabIds, addTabs, dontEventUpdateStorage) {
        return getCurrentData()
            .then(function(result) {
                excludeTabIds = excludeTabIds || [];
                addTabs = addTabs || [];

                if (!result.currentGroup.id) {
                    return;
                }

                result.currentGroup.tabs = result.currentWindowTabs
                    .filter(tab => !excludeTabIds.includes(tab.id))
                    .concat(addTabs.map(mapTab));

                return saveGroup(result.currentGroup, dontEventUpdateStorage);
            });
    }

    function isCatchedUrl(url, group) {
        if (!group.catchRegExpRules.trim().length) {
            return false;
        }

        return group.catchRegExpRules
            .split(/\s*\n\s*/)
            .filter(Boolean)
            .some(function(regExpStr) {
                try {
                    return new RegExp(regExpStr).test(url);
                } catch (e) {};
            });
    }

    // function onCreatedTab(tab) {
    //     console.log('onCreatedTab', tab);
    //     // console.log('browser.windows.WINDOW_ID_CURRENT', browser.windows.WINDOW_ID_CURRENT);
    //     // if (tab.incognito) {
    //     //     return;
    //     // }

    //     // saveCurrentTabs(null, [tab], true);
    // }

    function onUpdatedTab(tabId, changeInfo, tab) {
        // console.log('onUpdatedTab', tab);

        if (tab.status === 'loading' && tab.url === 'about:blank') {
            return;
        }

        if (tab.incognito || !isAllowUrl(tab.url)) {
            return;
        }


        // if (!changeInfo.url || tab.incognito || !isAllowUrl(changeInfo.url)) {
        //     return;
        // }

        if (changeInfo.url && !tab.pinned) {
            return Promise.all([
                    getCurrentData(),
                    getNotPinnedTabs(),
                ])
                .then(function(result) {
                    let [data, tabs] = result;

                    let destGroup = data.groups.find(isCatchedUrl.bind(null, changeInfo.url));

                    if (destGroup && destGroup.id !== data.currentGroup.id) {
                        let tabIndex = tabs.findIndex(tab => tab.id === tabId);
                        return moveTabToGroup(tab, tabIndex, data.currentGroup.id, destGroup.id);
                    }

                    // return saveCurrentTabs();
                });
        }

        if ('pinned' in changeInfo || /*'url' in changeInfo || */'complete' === changeInfo.status) {
            saveCurrentTabs();
        }
    }

    function onRemovedTab(removedTabId, removeInfo) {
        if (removeInfo.isWindowClosing) {
            return;
        }

        saveCurrentTabs([removedTabId]);
    }

    function onMovedTab(tabId, moveInfo) {
        // console.log('onMovedTab', moveInfo);
        saveCurrentTabs(null, null, true); // no need event because popup isHidded when tabs is moved
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
        browser.tabs.onUpdated.addListener(onUpdatedTab);
        browser.tabs.onRemoved.addListener(onRemovedTab);

        browser.tabs.onMoved.addListener(onMovedTab);

        browser.tabs.onAttached.addListener(onAttachedTab);
        browser.tabs.onDetached.addListener(onDetachedTab);
    }

    function removeTabEvents() {
        // browser.tabs.onCreated.removeListener(onCreatedTab);
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
                    createdTabId = null;

                // work with storage
                if (currentGroup.id !== destGroupId) {
                    destGroup.tabs.push(mappedTab);
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

                        return notify(message, 60000)
                            .then(getCurrentData)
                            .then(function({groups, currentGroup}) {
                                let group = groups.find(({id}) => id === destGroupId),
                                    isCurrentGroup = currentGroup.id === destGroupId;

                                if (isCurrentGroup && createdTabId) {
                                    return browser.tabs.update(createdTabId, {
                                        active: true,
                                    });
                                }

                                return loadGroup(group, isCurrentGroup, group.tabs.length - 1);
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
                                return saveGroup(newGroup, true);
                            })
                            .then(getCurrentData)
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

    let isLastWindowAreIncognito = null;
    browser.windows.onFocusChanged.addListener(function(windowId) {
        if (-1 === windowId) {
            return;
        }

        browser.windows.getLastFocused({
                windowTypes: ['normal'],
            })
            .then(function(win) {
                if (win.incognito && isLastWindowAreIncognito) {
                    return;
                }

                if (win.incognito) {
                    isLastWindowAreIncognito = true;
                    browser.browserAction.disable();
                    removeMoveTabMenus();
                } else if (isLastWindowAreIncognito) {
                    isLastWindowAreIncognito = false;
                    browser.browserAction.enable();
                    createMoveTabMenus();
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
                return addGroup(false, result.currentWindowId)
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
