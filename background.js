(function() {
    'use strict';

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
            .then(function(res) {
                let [result, winId] = res,
                newGroup = result.groups.slice(-1).pop(); // get last group

                if (winId) {
                    result.windowsGroup[winId] = newGroup.id;
                }

                return storage.set(result)
                    .then(() => resetGroups ? result.groups : newGroup);
            });
    }

    function saveGroup(savedGroup, dontEventUpdateStorage) {
        return storage.get({
                groups: [],
            })
            .then(function(result) {
                return storage.set({
                    groups: result.groups.map(group => savedGroup.id == group.id ? savedGroup : group),
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

    function removeTab(tabToRemove, group, isCurrentGroup) {
        let tabIndex = group.tabs.indexOf(tabToRemove);

        group.tabs.splice(tabIndex, 1);

        return saveGroup(group)
            .then(function() {
                if (isCurrentGroup) {
                    return getNotPinnedTabs()
                        .then(tabs => browser.tabs.remove(tabs[tabIndex].id));
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

                if (!group.tabs.length && !hasAnotherTabs) { // TODO fix bug with tabs
                    group.tabs.push({
                        url: 'about:blank',
                    });

                    return saveGroup(group, true)
                        .then(() => data);
                }

                return data;
            })
            .then(function(result) {
                result.windowsGroup[result.currentWindowId] = group.id;

                return storage.set({
                        windowsGroup: result.windowsGroup,
                    })
                    .then(function() {
                        if (group.tabs.length) {
                            return new Promise(function(resolve, reject) {
                                Promise.all(group.tabs.map(function(tab) {
                                        return browser.tabs.create({
                                            url: tab.url,
                                        });
                                    }))
                                    .then(resolve)
                                    .catch(resolve);
                            });
                        }
                    })
                    .then(function() {
                        if (result.currentWindowTabs.length) {
                            return new Promise(function(resolve) {
                                browser.tabs.remove(result.currentWindowTabs.map(tab => tab.id))
                                    .then(resolve)
                                    .catch(resolve);
                            });
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
                } catch (e) { };
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
            return getCurrentData()
                .then(function(result) {
                    let destGroup = result.groups.find(testUrl.bind(null, changeInfo.url));

                    if (destGroup && destGroup.id !== result.currentGroup.id) {
                        destGroup.tabs.push(mapTab(tabInfo));

                        return saveGroup(destGroup)
                            .then(function() {
                                let message = browser.i18n.getMessage('moveTabToGroupMessage', [
                                    destGroup.title,
                                    (tabInfo.title || tabInfo.url)
                                ]);
                                notify(message, 5000);

                                browser.tabs.remove(tabInfo.id);
                            });
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

    storage.get({
            groups: [],
        })
        .then(result => result.groups)
        .then(function(groups) {
            if (groups.length) { // TODO fix bug when current window is new
                return saveCurrentTabs();
            }

            return addGroup()
                .then(() => saveCurrentTabs());
        })
        .then(addTabEvents);

    browser.contextMenus.create({
        id: 'openSettings',
        title: browser.i18n.getMessage('openSettings'),
        onclick: () => browser.runtime.openOptionsPage(),
        contexts: ['browser_action'],
        icons: {
            16: 'icons/settings.svg',
            32: 'icons/settings.svg',
        },
    });


    window.background = {
        getCurrentData,
        getNotPinnedTabs,

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
