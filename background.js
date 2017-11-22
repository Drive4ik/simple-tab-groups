(function() {
    'use strict';

    let moveTabToGroupMenusIds = [];

    const notAllowedURLs = /^(chrome:|javascript:|data:|file:|view-source:|about(?!\:(blank|newtab|home)))/;

    function filterTabs(tabs) {
        return Array.from(tabs)
            .filter(tab => !notAllowedURLs.test(tab.url) && !tab.pinned)
    }

    function getCurrentWindow(populate) {
        populate = Boolean(populate);

        return browser.windows.getCurrent({
                populate: populate,
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
            .then(tabs => tabs.some(tab => tab.pinned || notAllowedURLs.test(tab.url)));
    }

    function mapTab(tab) {
        tab.url = tab.url || 'about:blank';
        tab.url = 'about:newtab' === tab.url ? 'about:blank' : tab.url;

        return {
            id: tab.id,
            title: tab.title || tab.url,
            url: tab.url,
            favIconUrl: tab.favIconUrl,
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

    function getCurrentData() {
        return Promise.all([
                storage.get({
                    groups: [],
                    windowsGroup: {},
                }),
                getCurrentWindow(true)
            ])
            .then(function(result) {
                let [data, currentWindow] = result;

                return {
                    groups: data.groups,
                    windowsGroup: data.windowsGroup,
                    currentWindowId: currentWindow.id,
                    currentWindowTabs: currentWindow.tabs,
                    currentGroup: data.groups.find(group => group.id == data.windowsGroup[currentWindow.id]) || {}, // ???????????????? need empty obj ?
                };
            });
    }

    function addGroup(resetGroups, windowId) { // if reset groups then return all groups else return new group
        return storage.get({
                groups: [],
                lastCreatedGroupPosition: 0,
                windowsGroup: {},
            })
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
            });
    }

    // saveGroups : Object or array of Object
    function saveGroup(saveGroups, dontEventUpdateStorage) {
        return storage.get({
                groups: [],
            })
            .then(function(result) {
                let groups = [];

                if (Array.isArray(saveGroups)) {
                    groups = result.groups.map(function(group) {
                        let groupIndex = saveGroups.findIndex(gr => gr.id === group.id);
                        return groupIndex > -1 ? saveGroups[groupIndex] : group;
                    });
                } else {
                    groups = result.groups.map(group => saveGroups.id == group.id ? saveGroups : group);
                }

                return storage.set({
                    groups,
                }, dontEventUpdateStorage);
            });
    }

    function removeGroup(oldGroup) {
        let isCurrentGroup = null;

        return getCurrentData()
            .then(function(result) {
                isCurrentGroup = oldGroup.id == result.currentGroup.id;

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
                    return loadGroup(groups[0], false, 0);
                }
            });
    }

    function addTab(group) {
        return getCurrentData()
            .then(function(result) {
                if (group.id == result.currentGroup.id) { // after this - will trigger events on create tab and add tab in group
                    return browser.tabs.create({
                        active: false,
                        url: 'about:blank',
                    });
                }

                group.tabs.push({
                    url: 'about:blank',
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

    function setActiveTab(activeTabIndex) {
        return getNotPinnedTabs()
            .then(function(tabs) {
                if (tabs[activeTabIndex]) {
                    return browser.tabs.update(tabs[activeTabIndex].id, {
                        active: true,
                    });
                }
            });
    }

    function loadGroup(group, isCurrentGroup, activeTabIndex) {
        if (isCurrentGroup) {
            return setActiveTab(activeTabIndex);
        }

        removeTabEvents();

        return Promise.all([
                getCurrentData(),
                hasAnotherTabs()
            ])
            .then(function(result) {
                let [data, hasAnotherTabs] = result;

                if (!group.tabs.length && !hasAnotherTabs) {
                    group.tabs.push({
                        url: 'about:blank',
                    });

                    let indexGroup = data.groups.findIndex(gr => gr.id == group.id);
                    data.groups[indexGroup].tabs = group.tabs;

                    return saveGroup(group, true)
                        .then(() => data);
                }

                return data;
            })
            .then(function(result) {
                let currentWindowTabsIds = result.currentWindowTabs.map(tab => tab.id);

                result.windowsGroup[result.currentWindowId] = group.id;

                return storage.set({
                        windowsGroup: result.windowsGroup,
                    })
                    .then(function() {
                        if (group.tabs.length) {
                            return new Promise(function(resolve) {
                                Promise.all(group.tabs.map(function(tab) {
                                        return browser.tabs.create({
                                            active: false,
                                            url: tab.url,
                                        });
                                    }))
                                    .then(() => setTimeout(resolve, 100))
                                    .catch(() => setTimeout(resolve, 100));
                            });
                        }
                    })
                    .then(function() {
                        if (currentWindowTabsIds.length) {
                            return browser.tabs.remove(currentWindowTabsIds);
                        }
                    });
            })
            .then(() => setActiveTab(activeTabIndex))
            .then(addTabEvents);
    }

    // @excludeTabIds : Array of integer
    // @addTabs : array of tabs
    function saveCurrentTabs(excludeTabIds, addTabs, dontEventUpdateStorage) {
        return getCurrentData()
            .then(function(result) {
                excludeTabIds = excludeTabIds || [];
                addTabs = addTabs || [];

                result.currentGroup.tabs = result.currentWindowTabs
                    .filter(tab => !excludeTabIds.includes(tab.id))
                    .concat(addTabs.map(mapTab));

                return saveGroup(result.currentGroup, dontEventUpdateStorage);
            });
    }

    function testUrl(url, group) {
        if (!group.moveNewTabsToThisGroupByRegExp.trim().length) {
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

    function onCreatedTab(tab) {
        saveCurrentTabs(null, [tab], true);
    }

    function onUpdatedTab(tabId, changeInfo, tabInfo) {
        let saveCurrentTabsIfNeed = function() {
            if ( /*changeInfo.favIconUrl ||*/ changeInfo.status === 'complete' || 'pinned' in changeInfo) {
                saveCurrentTabs();
            }
        };

        if (changeInfo.url && !tabInfo.pinned && !notAllowedURLs.test(changeInfo.url)) {
            return Promise.all([
                    getCurrentData(),
                    getNotPinnedTabs(),
                ])
                .then(function(result) {
                    let [data, tabs] = result;

                    let destGroup = data.groups.find(testUrl.bind(null, changeInfo.url));

                    if (destGroup && destGroup.id !== data.currentGroup.id) {
                        let tabIndex = tabs.findIndex(tab => tab.id === tabId);
                        return moveTabToGroup(tabInfo, tabIndex, data.currentGroup.id, destGroup.id);
                    }

                    return saveCurrentTabs();
                });
        }

        saveCurrentTabsIfNeed();
    }

    function onRemovedTab(removedTabId, removeInfo) {
        if (removeInfo.isWindowClosing) {
            return;
        }

        saveCurrentTabs([removedTabId]);
    }

    function onMovedTab(tabId, moveInfo) {
        saveCurrentTabs(null, null, true); // no need event because popup isHidded when tabs is moved
    }

    function onAttachedTab(tabId, attachInfo) {
        setTimeout(function(tabId, attachInfo) {
            Promise.all([
                    storage.get({
                        groups: [],
                        windowsGroup: {},
                    }),
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
        storage.get({
                groups: [],
                windowsGroup: {},
            })
            .then(function(result) {
                result.groups.some(function(group) {
                    if (group.id == result.windowsGroup[detachInfo.oldWindowId]) {
                        group.tabs = group.tabs.filter(tab => tab.id != tabId);
                        return saveGroup(group);
                    }
                });
            });
    }

    function addTabEvents() {
        browser.tabs.onCreated.addListener(onCreatedTab);
        browser.tabs.onUpdated.addListener(onUpdatedTab);
        browser.tabs.onRemoved.addListener(onRemovedTab);

        browser.tabs.onMoved.addListener(onMovedTab);

        browser.tabs.onAttached.addListener(onAttachedTab);
        browser.tabs.onDetached.addListener(onDetachedTab);
    }

    function removeTabEvents() {
        browser.tabs.onCreated.removeListener(onCreatedTab);
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
            .then(function(result) {
                let destGroup = result.groups.find(group => group.id == destGroupId),
                    srcGroup = result.groups.find(group => group.id == srcGroupId),
                    currentGroupId = result.currentGroup.id,
                    mappedTab = mapTab(tab),
                    groupsToSave = [];
                promise = Promise.resolve();

                // add tab
                if (currentGroupId == destGroupId) {
                    promise = browser.tabs.create({
                        active: false,
                        url: tab.url,
                    });
                } else {
                    destGroup.tabs.push(mappedTab);
                    groupsToSave.push(destGroup);
                }

                // remove tab
                promise
                    .then(function() {
                        if (currentGroupId == srcGroupId) {
                            return removeCurrentTabByIndex(tabIndex, 1 === srcGroup.tabs.length)
                                .then(() => result);
                        } else {
                            srcGroup.tabs.splice(tabIndex, 1);
                            groupsToSave.push(srcGroup);
                        }
                    })
                    .then(storage.get(defaultOptions))
                    .then(function(options) { // show notification
                        if (!options.showNotificationAfterMoveTab) {
                            return;
                        }

                        let message = browser.i18n.getMessage('moveTabToGroupMessage', [destGroup.title, mappedTab.title]);

                        return notify(message, 60000)
                            .then(getCurrentData)
                            .then(function(result) {
                                let group = result.groups.find(gr => gr.id == destGroupId),
                                    isCurrentGroup = result.currentGroup.id == destGroupId;

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

    function prepareMoveTabMenus() {
        let oldMenusRemoved = new Promise(function(resolve) {
            if (moveTabToGroupMenusIds.length) {
                Promise.all(moveTabToGroupMenusIds.map(browser.menus.remove))
                    .then(resolve)
                    .catch(resolve);
            }

            resolve();
        });

        Promise.all([
                getCurrentData(),
                oldMenusRemoved
            ])
            .then(function(result) {
                let [data] = result;

                moveTabToGroupMenusIds = [];

                moveTabToGroupMenusIds.push(browser.menus.create({
                    id: 'stg-move-tab-helper',
                    title: 'Move tab to group:',
                    enabled: false,
                    contexts: ['tab'],
                }));

                data.groups.forEach(function(group) {
                    moveTabToGroupMenusIds.push(browser.menus.create({
                        id: 'stg-move-group-id-' + group.id,
                        title: group.title,
                        enabled: group.id !== data.currentGroup.id,
                        icons: {
                            16: createSvgColoredIcon(group.iconColor),
                        },
                        contexts: ['tab'],
                        onclick: function(destGroupId, info, tab) {
                            getCurrentData()
                                .then(function(result) {
                                    let tabIndex = result.currentWindowTabs.findIndex(t => t.id === tab.id);

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
                    title: 'New Group',
                    icons: {
                        16: '/icons/group-new.svg',
                    },
                    onclick: function(info, tab) {
                        addGroup()
                            .then(function(newGroup) {
                                newGroup.tabs.push(mapTab(tab));
                                return saveGroup(newGroup, true);
                            })
                            .then(getCurrentData)
                            .then(function(result) {
                                let tabIndex = result.currentWindowTabs.findIndex(t => t.id === tab.id),
                                    isLastTabInGroup = result.currentGroup.tabs.length > 1;

                                if (tabIndex > -1) {
                                    removeCurrentTabByIndex(tabIndex, isLastTabInGroup);
                                }
                            });
                    },
                }));
            });
    }

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
        .then(prepareMoveTabMenus)
        .then(addTabEvents);


    window.background = {
        getCurrentData,
        getNotPinnedTabs,
        createSvgColoredIcon,
        moveTabToGroup,
        prepareMoveTabMenus,

        loadGroup,

        mapTab,
        notAllowedURLs,

        addTab,
        removeTab,

        createGroup,
        addGroup,
        saveGroup,
        removeGroup,
    };

})()
