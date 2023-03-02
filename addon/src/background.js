'use strict';

window.START_TIME = Date.now();
window.IS_TEMPORARY = false;

if (2 == window.localStorage.enableDebug) { // if debug was auto-enabled - disable on next start addon/browser
    delete window.localStorage.enableDebug;
}
console.restart();

const manageTabsPageUrl = browser.runtime.getURL(MANAGE_TABS_URL);

let options = {},
    reCreateTabsOnRemoveWindow = [],
    menuIds = [],
    excludeTabIds = new Set,
    ignoreExtForReopenContainer = new Set,

    groupsHistory = (function() {
        let index = -1,
            groupIds = [];

        return {
            next(groups) {
                groupIds = groupIds.filter(groupId => groups.some(group => group.id === groupId));

                if (!groupIds[index + 1]) {
                    return;
                }

                return groupIds[++index];
            },
            prev(groups) {
                groupIds = groupIds.filter(groupId => groups.some(group => group.id === groupId));

                if (!groupIds[index - 1]) {
                    return;
                }

                return groupIds[--index];
            },
            add(groupId) {
                index = groupIds.push(groupId) - 1;
            },
        };
    })();

async function createTabsSafe(tabs, tryRestoreOpeners, hideTabs = true) {
    if (!tabs.length) {
        return [];
    }

    console.log('createTabsSafe count:', tabs.length);

    let groupIds = tabs.map(tab => tab.groupId).filter(utils.onlyUniqueFilter),
        groupIdForNextTabs = (groupIds.length === 1 && groupIds[0]) ? groupIds[0] : null;

    if (groupIdForNextTabs) {
        BG.groupIdForNextTab = groupIdForNextTabs;
    }

    let isEnabledTreeTabsExt = TREE_TABS_EXTENSIONS.some(Management.isEnabled),
        oldNewTabIds = {},
        newTabs = [];

    tabs.forEach(function(tab) {
        delete tab.active;
        delete tab.index;
        delete tab.windowId;
    });

    BG.skipCreateTab = true;

    if (tryRestoreOpeners && isEnabledTreeTabsExt && tabs.some(tab => tab.openerTabId)) {
        for (let tab of tabs) {
            if (tab.id && tab.openerTabId) {
                tab.openerTabId = oldNewTabIds[tab.openerTabId];
            }

            let newTab = await Tabs.createNative(tab);

            if (tab.id) {
                oldNewTabIds[tab.id] = newTab.id;
            }

            newTabs.push(newTab);
        }
    } else {
        tabs.forEach(tab => delete tab.openerTabId);
        newTabs = await Promise.all(tabs.map(Tabs.createNative));
    }

    BG.skipCreateTab = false;

    BG.groupIdForNextTab = null;

    newTabs = await Promise.all(newTabs.map(cache.setTabSession));

    let beforeTabsLength = newTabs.length;

    newTabs = await Tabs.moveNative(newTabs, {
        index: -1,
    });

    if (newTabs.length !== beforeTabsLength) {
        throw Error('tabs length after creating are not equals');
    }

    if (hideTabs) {
        let tabsToHide = newTabs.filter(tab => !tab.pinned && tab.groupId && !cache.getWindowId(tab.groupId));

        await Tabs.safeHide(tabsToHide);
    }

    return newTabs;
}

function sendMessage(data) {
    if (!window.BG.inited) {
        console.warn('addon not yet loaded');
        return;
    }

    console.info('BG event [%s]', data.action, data);

    browser.runtime.sendMessage(data).catch(noop);
}

function sendExternalMessage(data) {
    if (!window.BG.inited) {
        console.warn('addon not yet loaded');
        return;
    }

    console.info('BG event external [%s]', data.action, data);

    Object.keys(EXTENSIONS_WHITE_LIST)
        .forEach(function(exId) {
            if (EXTENSIONS_WHITE_LIST[exId].postActions.includes(data.action)) {
                browser.runtime.sendMessage(exId, data).catch(noop);
            }
        });
}

let _loadingGroupInWindow = {}; // windowId: true;
async function applyGroup(windowId, groupId, activeTabId, applyFromHistory = false) {
    windowId = windowId || await Windows.getLastFocusedNormalWindow();

    if (_loadingGroupInWindow[windowId]) {
        return false;
    }

    console.log('applyGroup args groupId: %s, windowId: %s, activeTab: %s', groupId, windowId, activeTabId);

    _loadingGroupInWindow[windowId] = true;

    let groupWindowId = cache.getWindowId(groupId);

    console.time('load-group-' + groupId);

    let result = null;

    try {
        let addTabs = [];

        if (groupWindowId) {
            if (activeTabId) {
                Tabs.setActive(activeTabId);
            }

            Windows.setFocus(groupWindowId);
        } else {
            // magic

            let {group: groupToShow, groups} = await Groups.load(groupId, true),
                oldGroupId = cache.getWindowGroup(windowId),
                groupToHide = groups.find(gr => gr.id === oldGroupId),
                tabsIdsToRemove = [];

            if (!groupToShow) {
                throw Error(errorEventMessage('applyGroup: groupToShow not found', {groupId, activeTabId}));
            }

            if (groupToShow.isArchive) {
                utils.notify(['groupIsArchived', groupToShow.title]);
                throw '';
            }

            if (groupToHide?.tabs.some(utils.isTabCanNotBeHidden)) {
                utils.notify(['notPossibleSwitchGroupBecauseSomeTabShareMicrophoneOrCamera']);
                throw '';
            }

            loadingBrowserAction(true, windowId);

            // show tabs
            if (groupToShow.tabs.length) {
                let tabIds = groupToShow.tabs.map(utils.keyId);

                addExcludeTabIds(tabIds);

                if (!groupToShow.tabs.every(tab => tab.windowId === windowId)) {
                    groupToShow.tabs = await Tabs.moveNative(groupToShow.tabs, {
                        index: -1,
                        windowId: windowId,
                    });
                }

                await Tabs.show(tabIds);

                removeExcludeTabIds(tabIds);

                if (groupToShow.muteTabsWhenGroupCloseAndRestoreWhenOpen) {
                    Tabs.setMute(groupToShow.tabs, false);
                }
            }

            // link group with window
            cache.setWindowGroup(windowId, groupToShow.id);

            // hide tabs
            await hideTabs(groupToHide?.tabs);

            let activeTabGroupToHide = groupToHide?.tabs.find(tab => tab.active);

            async function hideTabs(tabs = []) {
                await Tabs.safeHide(tabs);

                if (groupToHide) {
                    if (groupToHide.muteTabsWhenGroupCloseAndRestoreWhenOpen) {
                        Tabs.setMute(tabs, true);
                    }

                    if (options.discardTabsAfterHide && !groupToHide.dontDiscardTabsAfterHideThisGroup) {
                        if (options.discardAfterHideExcludeAudioTabs) {
                            tabs = tabs.filter(tab => !tab.audible);
                        }

                        Tabs.discard(tabs);
                    }
                }
            }

            async function hideUnSyncTabs(tabs) {
                if (!tabs.length) {
                    return;
                }

                await Tabs.hide(tabs);

                let showNotif = +window.localStorage.showTabsInThisWindowWereHidden || 0;
                if (showNotif < 5) {
                    window.localStorage.showTabsInThisWindowWereHidden = ++showNotif;
                    utils.notify(['tabsInThisWindowWereHidden'], undefined, 'tabsInThisWindowWereHidden');
                }
            }

            // set active tab
            if (activeTabId) {
                await Tabs.setActive(activeTabId);

                if (!groupToHide) {
                    let tabs = await Tabs.get(windowId);

                    tabs = tabs.filter(tab => !tab.groupId);

                    if (tabs.length === 1 && utils.isUrlEmpty(tabs[0].url)) {
                        tabsIdsToRemove.push(tabs[0].id);
                    } else {
                        await hideUnSyncTabs(tabs);
                    }
                }
            } else if (groupToHide) {
                if (activeTabGroupToHide) {
                    let tabToActive = await Tabs.setActive(null, groupToShow.tabs);

                    if (!tabToActive) {
                        // group to show has no any tabs, try select pinned tab or create new one
                        let pinnedTabs = await Tabs.get(windowId, true),
                            activePinnedTab = await Tabs.setActive(null, pinnedTabs);

                        if (!activePinnedTab) {
                            await Tabs.create({
                                active: true,
                                windowId,
                                ...Groups.getNewTabParams(groupToShow),
                            });
                        }
                    }
                } else {
                    // some pinned tab active, do nothing
                }
            } else {
                let tabs = await Tabs.get(windowId, null); // get tabs with pinned

                // remove tabs without group
                tabs = tabs.filter(tab => !tab.groupId);

                let activePinnedTab = await Tabs.setActive(null, tabs.filter(tab => tab.pinned));

                // find other not pinned tabs
                tabs = tabs.filter(tab => !tab.pinned);

                if (activePinnedTab) {
                    await hideUnSyncTabs(tabs);
                } else {
                    // no pinned tabs found, some tab without group is active

                    if (groupToShow.tabs.length) {
                        // set active group tab
                        await Tabs.setActive(null, groupToShow.tabs);

                        // if has one empty tab - remove it
                        if (tabs.length === 1 && utils.isUrlEmpty(tabs[0].url)) {
                            tabsIdsToRemove.push(tabs[0].id);
                        } else {
                            await hideUnSyncTabs(tabs);
                        }
                    } else {
                        if (tabs.length === 1 && utils.isUrlEmpty(tabs[0].url)) {
                            await cache.setTabGroup(tabs[0].id, groupToShow.id);
                            addTabs.push(cache.applyTabSession(tabs[0]));
                        } else {
                            await Tabs.create({
                                active: true,
                                windowId,
                                ...Groups.getNewTabParams(groupToShow),
                            });

                            await hideUnSyncTabs(tabs);
                        }
                    }
                }
            }

            if (groupToHide) {
                if (activeTabGroupToHide) {
                    await hideTabs([activeTabGroupToHide]);
                }

                groupToHide.tabs.forEach(tab => tab.url === manageTabsPageUrl && tabsIdsToRemove.push(tab.id));
            }

            Tabs.remove(tabsIdsToRemove);

            updateMoveTabMenus(groups);

            updateBrowserActionData(groupToShow.id, undefined, groups);

            if (!applyFromHistory) {
                groupsHistory.add(groupId);
            }
        }

        sendMessage({
            action: 'group-loaded',
            groupId,
            windowId,
            addTabs,
        });

        sendExternalMessage({
            action: 'group-loaded',
            groupId,
            windowId,
        });

        result = true;
    } catch (e) {
        result = false;

        console.error('🛑 ERROR applyGroup', e);

        if (e) {
            errorEventHandler(e);

            updateBrowserActionData(null, windowId);

            if (!groupWindowId) {
                excludeTabIds.clear();
            }
        }
    }

    delete _loadingGroupInWindow[windowId];

    console.timeEnd('load-group-' + groupId);

    return result;
}

async function applyGroupByPosition(textPosition, groups, currentGroupId) {
    if (1 >= groups.length) {
        return false;
    }

    let currentGroupIndex = groups.findIndex(group => group.id === currentGroupId);

    if (-1 === currentGroupIndex) {
        currentGroupIndex = 'next' === textPosition ? (groups.length - 1) : 0;
    }

    let nextGroupIndex = utils.getNextIndex(currentGroupIndex, groups.length, textPosition);

    return applyGroup(undefined, groups[nextGroupIndex].id);
}


async function applyGroupByHistory(textPosition, groups) {
    if (1 >= groups.length) {
        return false;
    }

    let nextGroupId = 'next' === textPosition ? groupsHistory.next(groups) : groupsHistory.prev(groups);

    if (!nextGroupId) {
        return false;
    }

    return applyGroup(undefined, nextGroupId, undefined, true);
}

const onActivatedTab = function(activeInfo) {
    console.log('onActivated', activeInfo)
}

const onCreatedTab = utils.catchFunc(async function(tab) {
    console.log('onCreatedTab', tab);

    cache.setTab(tab);

    if (BG.skipCreateTab) {
        return;
    }

    if (utils.isTabPinned(tab)) {
        return;
    }

    let groupId = cache.getWindowGroup(tab.windowId);

    if (groupId) {
        cache.setTabGroup(tab.id, groupId);
    }
});

function addExcludeTabIds(tabIds) {
    tabIds.forEach(excludeTabIds.add, excludeTabIds);
}

function removeExcludeTabIds(tabIds) {
    tabIds.forEach(excludeTabIds.delete, excludeTabIds);
}

const onUpdatedTab = utils.catchFunc(async function(tabId, changeInfo, tab) {
    if (excludeTabIds.has(tab.id)) {
        console.log('🛑 onUpdatedTab tab was excluded tabId', tab.id);
        cache.setTab(tab);
        return;
    }

    changeInfo = cache.getRealTabStateChanged(tab);

    if (!changeInfo) {
        console.log('🛑 onUpdatedTab tabId', tab.id, 'changeInfo keys was not changed.');
        cache.setTab(tab);
        return;
    }

    console.log('onUpdatedTab tabId', tab.id, 'changeInfo', changeInfo);
    cache.setTab(tab);

    if (utils.isTabPinned(tab) && !changeInfo.hasOwnProperty('pinned')) {
        console.log('🛑 onUpdatedTab tab is pinned tabId: %s:', tab.id);
        return;
    }

    // if (!cache.hasTab(tab.id)) {
    //     console.log('🛑 onUpdatedTab tab not yet created tabId:', tab.id);
    //     return;
    // }

    let tabGroupId = cache.getTabGroup(tab.id),
        winGroupId = cache.getWindowGroup(tab.windowId);

    if (changeInfo.favIconUrl && (tabGroupId || winGroupId)) {
        cache.setTabFavIcon(tab.id, changeInfo.favIconUrl);
    }

    if (changeInfo.hasOwnProperty('pinned') || changeInfo.hasOwnProperty('hidden')) {
        if (changeInfo.pinned || changeInfo.hidden) {
            cache.removeTabGroup(tab.id);
        } else {

            if (false === changeInfo.pinned) {
                cache.setTabGroup(tab.id, winGroupId);
            } else if (false === changeInfo.hidden) {
                if (tabGroupId) {
                    if (winGroupId) {
                        let {group: winGroup} = await Groups.load(winGroupId, true);

                        if (winGroup.tabs.length) {
                            applyGroup(tab.windowId, tabGroupId, tab.id);
                            return;
                        }
                    }

                    let tabs = await Tabs.get(tab.windowId, null);

                    tabs = tabs.filter(tab => !tab.groupId);

                    let activePinnedTab = await Tabs.setActive(null, tabs.filter(tab => tab.pinned));

                    if (!activePinnedTab) {
                        let unSyncTabs = tabs.filter(tab => !tab.pinned);

                        if (unSyncTabs.length) {
                            await Tabs.setActive(null, unSyncTabs);
                        } else {
                            await Tabs.createTempActiveTab(tab.windowId, false);
                        }
                    }

                    Tabs.safeHide(tab).catch(noop);
                } else {
                    cache.setTabGroup(tab.id, winGroupId);
                }
            }
        }

        return;
    }

    if (utils.isTabLoaded(changeInfo) && (tabGroupId || winGroupId)) {
        Tabs.updateThumbnail(tab.id);
    }
});

function onRemovedTab(tabId, {isWindowClosing, windowId}) {
    console.log('onRemovedTab', {tabId, isWindowClosing, windowId});

    if (isWindowClosing) {
        reCreateTabsOnRemoveWindow.push(tabId);
    } else {
        cache.removeTab(tabId);
    }
}

let openerTabTimer = 0;
function onMovedTab(tabId) {
    /* if (excludeTabIds.has(tabId)) {
        console.log('🛑 onMovedTab', tabId);
        return;
    }

    if (cache.getTabGroup(tabId)) {
        clearTimeout(openerTabTimer);
        openerTabTimer = setTimeout(() => Tabs.get().catch(noop), 500); // load visible tabs of current window for set openerTabId
    } */
}

function onAttachedTab(tabId, {newWindowId}) {
    if (excludeTabIds.has(tabId)) {
        console.log('🛑 onAttachedTab', {tabId, newWindowId});
        return;
    }

    console.log('onAttachedTab', {tabId, newWindowId});

    cache.setTabGroup(tabId, cache.getWindowGroup(newWindowId));
}

let windowIdsForRestoring = new Set,
    grandRestoringPromise = null;
async function GrandRestoreWindows({id}, needRestoreMissedTabsMap) {
    windowIdsForRestoring.add(id);

    needRestoreMissedTabsMap?.set(id, windowIdsForRestoring.size === 1);

    if (grandRestoringPromise) {
        await grandRestoringPromise;
        grandRestoringPromise = null;
        return;
    }

    let [
        windows,
        {groups},
        {tabsToRestore = []}
    ] = await Promise.all([
        Windows.load(true),
        Groups.load(),
        storage.get('tabsToRestore')
    ]);

    await Promise.all(windows.map(win => loadingBrowserAction(true, win.id)));

    let tabsToRestoreChanged = false;
    function deleteTabsToRestoreByGroup({id}) {
        let lengthBefore = tabsToRestore.length;
        tabsToRestore = tabsToRestore.filter(tab => tab.groupId !== id);

        if (!tabsToRestoreChanged) {
            tabsToRestoreChanged = lengthBefore !== tabsToRestore.length;
        }
    }

    // prepare windows
    windows.forEach(win => {
        win.groups = groups
            .map(gr => {
                if (gr.isArchive) {
                    return;
                }

                let group = utils.clone(gr);

                group.tabs = win.tabs.filter(tab => tab.groupId === group.id);

                if (!group.tabs.length) {
                    return;
                }

                group.tabs.forEach(tab => {
                    if (tab.active && utils.isUrlEmpty(tab.url)) {
                        tab.url = utils.normalizeUrl(cache.getTabSession(tab.id, 'url'));
                    }
                });

                group.isLoaded = group.id === win.groupId;

                // если группа загружена, ставим минимальный доступ (без конфликтов если она загружена в нескольких окнах одновременно), для того чтоб группа осталась в восстанавливаемом окне, а вкладки из другого окна переместятся туда
                if (group.isLoaded) {
                    group.lastAccessed = win.id;
                } else {
                    // иначе ищем минимальное значение доступа ко вкладке
                    // если оно будет меньше чем доступ этой группы в других окнах - именно эта группа этого окна и останется - вкладки этой группы в других окнах удаляться или переместятся
                    group.lastAccessed = Math.min(...group.tabs.map(tab => tab.lastAccessed));
                }

                group.window = win;

                return group;
            })
            .filter(Boolean);
    });

    let tabsToDelete = new Map,
        tabsToMoving = new Map,
        groupsAlreadyRestored = new Map;

    // restore tabs
    windows.forEach(win => {
        // не восстановленное окно пропускаем
        if (!windowIdsForRestoring.has(win.id)) {
            return;
        }

        // ищем группу которую надо восстановить и оставить, вкладки этой группы в других окнах удалить
        win.groups.forEach(groupToKeep => {
            // чтобы не бегать 2 раза по одной и той же группе
            if (groupsAlreadyRestored.has(groupToKeep.id)) {
                return;
            }

            let lastAccessGroup = new Map;

            // ищем востанавливаемую группу в всех окнах
            windows.forEach(win => {
                win.groups.some(group => group.id === groupToKeep.id && lastAccessGroup.set(group.lastAccessed, group));
            });

            // если группа одна - удаляем все вкладки этой группы из восставновления, которое будет в будущем
            // ведь она уже восcтановилась, нет смысла восстанавливать её вкладки
            if (lastAccessGroup.size === 1) {
                deleteTabsToRestoreByGroup(groupToKeep);
                return;
            }

            // ищем группу с минимальным значением доступа,
            // именно группа этого окна (и все её вкладки) и будет оставлена
            let minGroupLastAccessed = Math.min(...lastAccessGroup.keys());

            groupToKeep = lastAccessGroup.get(minGroupLastAccessed);

            lastAccessGroup.delete(minGroupLastAccessed);
            let otherGroups = lastAccessGroup;

            // ищем вкладки в других окнах, которых нет в окне результующей группы (по урле, не уникально)
            for (let otherGroup of otherGroups.values()) {
                otherGroup.tabs.forEach((oTab, index) => {
                    // удаляем другую вкладку если обе группы загружены, так как юзер мог менять вкладки в другом окне
                    // если вкладка в востанавливаемом окне, удаляем её при условии, если восстанавливаемые окна - не все окна браузера, потому что юзер мог поменять вкладки в окне что осталось
                    if (
                        (groupToKeep.isLoaded && otherGroup.isLoaded) ||
                        (
                            windowIdsForRestoring.has(otherGroup.window.id) &&
                            windowIdsForRestoring.size !== windows.length
                        )
                    ) {
                        tabsToDelete.set(oTab.id, oTab);
                        return;
                    }

                    let found = groupToKeep.tabs.some(tab => tab.url === oTab.url && tab.cookieStoreId === oTab.cookieStoreId);

                    if (found) {
                        tabsToDelete.set(oTab.id, oTab);
                    } else {
                        groupToKeep.tabs.splice(index, 0, oTab);
                        tabsToMoving.set(oTab.id, oTab);
                    }
                });
            }

            // удаляем вкладки ресторед группы которых нет в других группах
            if (otherGroups.size) {
                let allOtherTabs = Array.from(otherGroups.values()).reduce((acc, otherGroup) => [...acc, ...otherGroup.tabs], []);

                groupToKeep.tabs.forEach(tab => {
                    // если вкладка из другого окна - пропускаем
                    if (tabsToMoving.has(tab.id)) {
                        return;
                    }

                    let found = allOtherTabs.some(oTab => oTab.url === tab.url && oTab.cookieStoreId === tab.cookieStoreId);

                    if (!found) {
                        tabsToDelete.set(tab.id, tab);
                    }
                });
            }

            groupsAlreadyRestored.set(groupToKeep.id, groupToKeep);

            deleteTabsToRestoreByGroup(groupToKeep);
        });
    });

    let activeTabs = [];

    tabsToDelete.forEach(tab => tab.active && activeTabs.push(tab));
    tabsToMoving.forEach(tab => tab.active && activeTabs.push(tab));

    // делаем активной другую вкладку и удаляем привязку окна к группе
    await Promise.all(activeTabs.map(async tabToDelete => {
        let win = windows.find(w => w.id === tabToDelete.windowId),
            groupToKeep = groupsAlreadyRestored.get(win.groupId);

        // если удаляемая вкладка находится в нужном окне группы которую оставляем, делаем активной другую вкладку группы
        if (tabToDelete.windowId === groupToKeep.window.id) {
            // ищем неудаляемые вкладки текущего окна
            let tabsToActive = groupToKeep.tabs.filter(tab => !tabsToDelete.has(tab.id) && tab.windowId === tabToDelete.windowId);

            if (tabsToActive.length) {
                await Tabs.setActive(null, tabsToActive);
            } else { // если их нет - делаем активной перемещаемую вкладку, после временной
                let otherMoveTabs = groupToKeep.tabs.filter(tab => tab.windowId !== tabToDelete.windowId);

                if (otherMoveTabs.length) {
                    groupToKeep.deleteTabAfterMove = await Tabs.createTempActiveTab(tabToDelete.windowId, true);
                } else {
                    await Tabs.createTempActiveTab(tabToDelete.windowId, false);
                }
            }
        } else { // если вкладка в другом окне этой группы - удаляем сессию, и делаем пустую вкладку
            await cache.removeWindowSession(tabToDelete.windowId);
            await Tabs.createTempActiveTab(tabToDelete.windowId, false);
        }
    }));

    // перемещаем недостающие вкладки из других окон
    let excludeTabIds = [];
    for (let groupToKeep of groupsAlreadyRestored.values()) {
        if (!groupToKeep.tabs.some(tab => tab.windowId !== groupToKeep.window.id)) {
            continue;
        }

        let tabIds = groupToKeep.tabs.map(utils.keyId);

        excludeTabIds.push(...tabIds);
        addExcludeTabIds(tabIds);

        groupToKeep.tabs = await Tabs.moveNative(groupToKeep.tabs, {
            windowId: groupToKeep.window.id,
            index: -1,
        });

        if (groupToKeep.window.groupId === groupToKeep.id) {
            await Tabs.show(groupToKeep.tabs);

            if (groupToKeep.deleteTabAfterMove) {
                await Tabs.setActive(null, groupToKeep.tabs.filter(tab => !tabsToDelete.has(tab.id)));
                await Tabs.remove(groupToKeep.deleteTabAfterMove);
            }
        } else {
            await Tabs.hide(groupToKeep.tabs);
        }
    };
    removeExcludeTabIds(excludeTabIds);

    await Tabs.remove(Array.from(tabsToDelete.keys()));

    if (tabsToRestoreChanged) {
        if (tabsToRestore.length) {
            await storage.set({tabsToRestore});
        } else {
            needRestoreMissedTabsMap?.clear();
            await storage.remove('tabsToRestore');
        }
    }

    await Promise.all(windows.map(win => loadingBrowserAction(false, win.id)));

    windowIdsForRestoring.clear();
}

const onCreatedWindow = utils.catchFunc(async function(win) {
    console.log('onCreatedWindow', win.id, 'skip created:', BG.skipAddGroupToNextNewWindow);

    if (BG.skipAddGroupToNextNewWindow) {
        BG.skipAddGroupToNextNewWindow = false;
        return;
    }

    if (!utils.isWindowAllow(win)) {
        return;
    }

    await loadingBrowserAction(true, win.id);

    // для того чтоб один раз вызвалось tryRestoreMissedTabs
    let needRestoreMissedTabsMap = new Map;

    grandRestoringPromise = GrandRestoreWindows(win, needRestoreMissedTabsMap);
    try {
        await grandRestoringPromise;
    } catch (e) {
        return;
    }

    await cache.loadWindowSession(win);

    if (!win.groupId && options.createNewGroupWhenOpenNewWindow) {
        await Groups.add(win.id);
    }

    await loadingBrowserAction(false, win.id);

    if (needRestoreMissedTabsMap.get(win.id)) {
        await tryRestoreMissedTabs().catch(noop);
    }
});

function onFocusChangedWindow(windowId) {
    console.log('onFocusChangedWindow', windowId);

    if (browser.windows.WINDOW_ID_NONE !== windowId && options.showContextMenuOnTabs) {
        browser.menus.update('set-tab-icon-as-group-icon', {
            enabled: Boolean(cache.getWindowGroup(windowId)),
        });
    }
}

const onRemovedWindow = utils.catchFunc(async function(windowId) {
    console.log('onRemovedWindow windowId:', windowId);

    let groupId = cache.getWindowGroup(windowId);

    if (groupId) {
        sendMessage({
            action: 'window-closed',
            windowId,
        });
    }

    cache.removeWindow(windowId);

    let tabsToRestore = cache.getTabsSessionAndRemove(reCreateTabsOnRemoveWindow);

    reCreateTabsOnRemoveWindow = [];

    if (tabsToRestore.length) {
        let {tabsToRestore: prevRestore} = await storage.get({tabsToRestore: []});
        tabsToRestore = tabsToRestore.filter(tab => !prevRestore.some(t => t.groupId === tab.groupId && t.url === tab.url && t.cookieStoreId === tab.cookieStoreId));
        await storage.set({
            tabsToRestore: [...prevRestore, ...tabsToRestore]
        });

        restoringMissedTabsPromise = tryRestoreMissedTabs();
        await restoringMissedTabsPromise.catch(noop);
    }
});

let _currentWindowForLoadingBrowserAction = null;
async function loadingBrowserAction(start = true, windowId) {
    if (start) {
        _currentWindowForLoadingBrowserAction = windowId || await Windows.getLastFocusedNormalWindow();

        await setBrowserAction(_currentWindowForLoadingBrowserAction, 'loading', undefined, false);
    } else {
        if (windowId) {
            _currentWindowForLoadingBrowserAction = windowId;
        }

        await updateBrowserActionData(null, _currentWindowForLoadingBrowserAction);
    }
}

async function addUndoRemoveGroupItem(groupToRemove) {
    let restoreGroup = utils.catchFunc(async function(group) {
        browser.menus.remove(CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP + group.id);
        browser.notifications.clear(CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP + group.id);

        let {groups} = await Groups.load();

        group.isMain = false;

        groups.push(group);

        normalizeContainersInGroups(groups);

        let tabs = group.tabs;

        await Groups.save(groups);

        updateMoveTabMenus(groups);

        if (tabs.length && !group.isArchive) {
            await loadingBrowserAction();

            group.tabs = await createTabsSafe(Groups.setNewTabsParams(tabs, group), true);

            await loadingBrowserAction(false);
        }

        sendMessage({
            action: 'group-added',
            group,
        });

    }.bind(null, utils.clone(groupToRemove)));

    browser.menus.create({
        id: CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP + groupToRemove.id,
        title: browser.i18n.getMessage('undoRemoveGroupItemTitle', groupToRemove.title),
        contexts: [browser.menus.ContextType.BROWSER_ACTION],
        icons: utils.getGroupIconUrl(groupToRemove, 16),
        onclick: restoreGroup,
    });

    if (options.showNotificationAfterGroupDelete) {
        utils.notify(
                ['undoRemoveGroupNotification', groupToRemove.title],
                7,
                CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP + groupToRemove.id,
                undefined,
                restoreGroup
            );
    }
}

async function updateMoveTabMenus(groups) {
    await removeMoveTabMenus();
    await createMoveTabMenus(groups);
}

async function removeMoveTabMenus() {
    if (menuIds.length) {
        await Promise.all(menuIds.map(id => browser.menus.remove(id).catch(noop)));
        menuIds = [];
    }
}

async function createMoveTabMenus(groups) {
    let hasBookmarksPermission = await browser.permissions.contains(PERMISSIONS.BOOKMARKS);

    if (!options.showContextMenuOnTabs && !options.showContextMenuOnLinks && !hasBookmarksPermission) {
        return;
    }

    if (!Array.isArray(groups)) {
        ({groups} = await Groups.load());
    }

    await removeMoveTabMenus();

    const temporaryContainer = Containers.get(TEMPORARY_CONTAINER);

    hasBookmarksPermission && menuIds.push(browser.menus.create({
        id: 'stg-open-bookmark-parent',
        title: browser.i18n.getMessage('openBookmarkInGroup'),
        contexts: [browser.menus.ContextType.BOOKMARK],
    }));

    options.showContextMenuOnTabs && menuIds.push(browser.menus.create({
        id: 'stg-move-tab-parent',
        title: browser.i18n.getMessage('moveTabToGroupDisabledTitle'),
        contexts: [browser.menus.ContextType.TAB],
    }));

    options.showContextMenuOnLinks && menuIds.push(browser.menus.create({
        id: 'stg-open-link-parent',
        title: browser.i18n.getMessage('openLinkInGroupDisabledTitle'),
        contexts: [browser.menus.ContextType.LINK],
    }));

    options.showContextMenuOnTabs && menuIds.push(browser.menus.create({
        title: temporaryContainer.name,
        icons: {
            16: temporaryContainer.iconUrl,
        },
        parentId: 'stg-move-tab-parent',
        contexts: [browser.menus.ContextType.TAB],
        onclick: utils.catchFunc(function(info, tab) {
            if (!utils.isUrlAllowToCreate(tab.url)) {
                utils.notify(['thisUrlsAreNotSupported', tab.url], 7, 'thisUrlsAreNotSupported');
                return;
            }

            let setActive = 2 === info.button;

            Tabs.createNative({
                ...tab,
                active: setActive,
                cookieStoreId: TEMPORARY_CONTAINER,
            });
        }),
    }));

    options.showContextMenuOnTabs && menuIds.push(browser.menus.create({
        id: 'set-tab-icon-as-group-icon',
        title: browser.i18n.getMessage('setTabIconAsGroupIcon'),
        icons: {
            16: '/icons/image.svg',
        },
        parentId: 'stg-move-tab-parent',
        contexts: [browser.menus.ContextType.TAB],
        onclick: utils.catchFunc(function(info, tab) {
            let groupId = cache.getWindowGroup(tab.windowId);

            if (!groupId) {
                browser.menus.update(info.menuItemId, {
                    enabled: false,
                });
                return;
            }

            cache.applyTabSession(tab);

            tab = utils.normalizeTabFavIcon(tab);

            Groups.setIconUrl(groupId, tab.favIconUrl);
        }),
    }));

    options.showContextMenuOnTabs && groups.length && menuIds.push(browser.menus.create({
        type: browser.menus.ItemType.SEPARATOR,
        parentId: 'stg-move-tab-parent',
        contexts: [browser.menus.ContextType.TAB],
    }));

    options.showContextMenuOnLinks && menuIds.push(browser.menus.create({
        title: temporaryContainer.name,
        icons: {
            16: temporaryContainer.iconUrl,
        },
        parentId: 'stg-open-link-parent',
        contexts: [browser.menus.ContextType.LINK],
        onclick: utils.catchFunc(async function(info) {
            if (!utils.isUrlAllowToCreate(info.linkUrl)) {
                return;
            }

            if (!utils.isUrlAllowToCreate(info.linkUrl)) {
                utils.notify(['thisUrlsAreNotSupported', info.linkUrl], 7, 'thisUrlsAreNotSupported');
                return;
            }

            let setActive = 2 === info.button;

            Tabs.createNative({
                url: info.linkUrl,
                title: info.linkText,
                active: setActive,
                cookieStoreId: TEMPORARY_CONTAINER,
            });
        }),
    }));

    options.showContextMenuOnLinks && groups.length && menuIds.push(browser.menus.create({
        type: browser.menus.ItemType.SEPARATOR,
        parentId: 'stg-open-link-parent',
        contexts: [browser.menus.ContextType.LINK],
    }));

    hasBookmarksPermission && menuIds.push(browser.menus.create({
        title: temporaryContainer.name,
        icons: {
            16: temporaryContainer.iconUrl,
        },
        parentId: 'stg-open-bookmark-parent',
        contexts: [browser.menus.ContextType.BOOKMARK],
        onclick: utils.catchFunc(async function(info) {
            if (!info.bookmarkId) {
                utils.notify(['bookmarkNotAllowed'], 7, 'bookmarkNotAllowed');
                return;
            }

            let [bookmark] = await browser.bookmarks.get(info.bookmarkId);

            if (bookmark.type !== browser.bookmarks.BookmarkTreeNodeType.BOOKMARK) {
                utils.notify(['bookmarkNotAllowed'], 7, 'bookmarkNotAllowed');
                return;
            }

            if (!utils.isUrlAllowToCreate(bookmark.url)) {
                utils.notify(['thisUrlsAreNotSupported', bookmark.url], 7, 'thisUrlsAreNotSupported');
                return;
            }

            let setActive = 2 === info.button;

            Tabs.createNative({
                url: bookmark.url,
                title: bookmark.title,
                active: setActive,
                cookieStoreId: TEMPORARY_CONTAINER,
            });

        }),
    }));

    hasBookmarksPermission && groups.length && menuIds.push(browser.menus.create({
        type: browser.menus.ItemType.SEPARATOR,
        parentId: 'stg-open-bookmark-parent',
        contexts: [browser.menus.ContextType.BOOKMARK],
    }));

    groups.forEach(function(group) {
        if (group.isArchive) {
            return;
        }

        let groupId = group.id,
            groupIcon = utils.getGroupIconUrl(group, 16),
            groupTitle = String(utils.getGroupTitle(group, 'withSticky withActiveGroup withContainer'));

        options.showContextMenuOnTabs && menuIds.push(browser.menus.create({
            title: groupTitle,
            icons: groupIcon,
            parentId: 'stg-move-tab-parent',
            contexts: [browser.menus.ContextType.TAB],
            onclick: utils.catchFunc(async function(info, tab) {
                let setActive = 2 === info.button,
                    tabIds = await Tabs.getHighlightedIds(tab.windowId, tab);

                await Tabs.move(tabIds, groupId, undefined, undefined, setActive);

                if (!setActive && info.modifiers.includes('Ctrl')) {
                    Tabs.discard(tabIds);
                }
            }),
        }));

        options.showContextMenuOnLinks && menuIds.push(browser.menus.create({
            title: groupTitle,
            icons: groupIcon,
            parentId: 'stg-open-link-parent',
            contexts: [browser.menus.ContextType.LINK],
            onclick: utils.catchFunc(async function(info) {
                if (!utils.isUrlAllowToCreate(info.linkUrl)) {
                    utils.notify(['thisUrlsAreNotSupported', info.linkUrl], 7, 'thisUrlsAreNotSupported');
                    return;
                }

                let setActive = 2 === info.button,
                    newTab = await Tabs.add(groupId, undefined, info.linkUrl, info.linkText);

                if (setActive) {
                    applyGroup(newTab.windowId, groupId, newTab.id);
                }
            }),
        }));

        hasBookmarksPermission && menuIds.push(browser.menus.create({
            title: groupTitle,
            icons: groupIcon,
            parentId: 'stg-open-bookmark-parent',
            contexts: [browser.menus.ContextType.BOOKMARK],
            onclick: utils.catchFunc(async function(info) {
                if (!info.bookmarkId) {
                    utils.notify(['bookmarkNotAllowed'], 7, 'bookmarkNotAllowed');
                    return;
                }

                await loadingBrowserAction();

                let setActive = 2 === info.button,
                    [bookmark] = await browser.bookmarks.getSubTree(info.bookmarkId),
                    tabsToCreate = [];

                if (bookmark.type === browser.bookmarks.BookmarkTreeNodeType.BOOKMARK) {
                    bookmark.children = [bookmark];
                }

                await findBookmarks(bookmark);

                async function findBookmarks(folder) {
                    for (let b of folder.children) {
                        if (b.type === browser.bookmarks.BookmarkTreeNodeType.FOLDER) {
                            await findBookmarks(b);
                        } else if (b.type === browser.bookmarks.BookmarkTreeNodeType.BOOKMARK) {
                            tabsToCreate.push({
                                title: b.title,
                                url: b.url,
                            });
                        }
                    }
                }

                if (tabsToCreate.length) {
                    let {group} = await Groups.load(groupId),
                        [firstTab] = await createTabsSafe(Groups.setNewTabsParams(tabsToCreate, group));

                    loadingBrowserAction(false);

                    if (setActive) {
                        applyGroup(undefined, groupId, firstTab.id);
                    } else {
                        utils.notify(['tabsCreatedCount', tabsToCreate.length], 7);
                    }
                } else {
                    loadingBrowserAction(false);
                    utils.notify(['tabsNotCreated'], 7);
                }
            }),
        }));
    });

    options.showContextMenuOnTabs && menuIds.push(browser.menus.create({
        title: browser.i18n.getMessage('createNewGroup'),
        icons: {
            16: '/icons/group-new.svg',
        },
        parentId: 'stg-move-tab-parent',
        contexts: [browser.menus.ContextType.TAB],
        onclick: utils.catchFunc(async function(info, tab) {
            let setActive = 2 === info.button,
                tabIds = await Tabs.getHighlightedIds(tab.windowId, tab);

            runAction({
                action: 'add-new-group',
                proposalTitle: tab.title,
                tabIds: tabIds,
                showTabsAfterMoving: setActive,
            });
        }),
    }));

    options.showContextMenuOnLinks && menuIds.push(browser.menus.create({
        title: browser.i18n.getMessage('createNewGroup'),
        icons: {
            16: '/icons/group-new.svg',
        },
        parentId: 'stg-open-link-parent',
        contexts: [browser.menus.ContextType.LINK],
        onclick: utils.catchFunc(async function(info) {
            if (!utils.isUrlAllowToCreate(info.linkUrl)) {
                utils.notify(['thisUrlsAreNotSupported', info.linkUrl], 7, 'thisUrlsAreNotSupported');
                return;
            }

            let setActive = 2 === info.button,
                {ok, group} = await runAction({
                    action: 'add-new-group',
                    proposalTitle: info.linkText,
                });

            if (!ok) {
                group = await Groups.add(undefined, undefined, info.linkText);
                ok = true;
            }

            if (ok && group) {
                let newTab = await Tabs.add(group.id, undefined, info.linkUrl, info.linkText);

                if (setActive) {
                    applyGroup(undefined, group.id, newTab.id);
                }
            }
        }),
    }));

    hasBookmarksPermission && menuIds.push(browser.menus.create({
        title: browser.i18n.getMessage('createNewGroup'),
        icons: {
            16: '/icons/group-new.svg',
        },
        parentId: 'stg-open-bookmark-parent',
        contexts: [browser.menus.ContextType.BOOKMARK],
        onclick: utils.catchFunc(async function(info) {
            if (!info.bookmarkId) {
                utils.notify(['bookmarkNotAllowed'], 7, 'bookmarkNotAllowed');
                return;
            }

            let [bookmark] = await browser.bookmarks.get(info.bookmarkId);

            if (bookmark.type === browser.bookmarks.BookmarkTreeNodeType.BOOKMARK) {
                if (!utils.isUrlAllowToCreate(bookmark.url)) {
                    utils.notify(['bookmarkNotAllowed'], 7, 'bookmarkNotAllowed');
                    return;
                }

                let setActive = 2 === info.button,
                    {ok, group} = await runAction({
                        action: 'add-new-group',
                        proposalTitle: bookmark.title,
                    });

                if (!ok) {
                    group = await Groups.add(undefined, undefined, bookmark.title);
                    ok = true;
                }

                if (ok && group) {
                    let newTab = await Tabs.add(group.id, undefined, bookmark.url, bookmark.title);

                    if (setActive) {
                        applyGroup(undefined, group.id, newTab.id);
                    }
                }
            } else if (bookmark.type === browser.bookmarks.BookmarkTreeNodeType.FOLDER) {
                let [folder] = await browser.bookmarks.getSubTree(info.bookmarkId),
                    groupsCreatedCount = 0;

                async function addBookmarkFolderAsGroup(folder) {
                    let tabsToCreate = [];

                    for (let bookmark of folder.children) {
                        if (bookmark.type === browser.bookmarks.BookmarkTreeNodeType.FOLDER) {
                            await addBookmarkFolderAsGroup(bookmark);
                        } else if (bookmark.type === browser.bookmarks.BookmarkTreeNodeType.BOOKMARK) {
                            tabsToCreate.push({
                                title: bookmark.title,
                                url: bookmark.url,
                            });
                        }
                    }

                    if (tabsToCreate.length) {
                        let newGroup = await Groups.add(undefined, undefined, folder.title);

                        await createTabsSafe(Groups.setNewTabsParams(tabsToCreate, newGroup));

                        groupsCreatedCount++;
                    }
                }

                await loadingBrowserAction();

                await addBookmarkFolderAsGroup(folder);

                loadingBrowserAction(false);

                if (groupsCreatedCount) {
                    utils.notify(['groupsCreatedCount', groupsCreatedCount], 7);
                } else {
                    utils.notify(['noGroupsCreated'], 7);
                }
            } else {
                utils.notify(['bookmarkNotAllowed'], 7, 'bookmarkNotAllowed');
            }
        }),
    }));

    hasBookmarksPermission && menuIds.push(browser.menus.create({
        title: browser.i18n.getMessage('exportAllGroupsToBookmarks'),
        icons: {
            16: '/icons/bookmark.svg',
        },
        contexts: [browser.menus.ContextType.BROWSER_ACTION],
        onclick: utils.catchFunc(() => exportAllGroupsToBookmarks(true)),
    }));

    menuIds.push(browser.menus.create({
        title: browser.i18n.getMessage('reopenTabsWithTemporaryContainersInNew'),
        icons: {
            16: 'resource://usercontext-content/chill.svg',
        },
        contexts: [browser.menus.ContextType.BROWSER_ACTION],
        onclick: utils.catchFunc(async function(info) {
            let setActive = 2 === info.button,
                allTabs = await Tabs.get(null, null, null, undefined, true, true),
                tabsToCreate = [];

            let tabsIdsToRemove = allTabs
                .filter(tab => Containers.isTemporary(tab.cookieStoreId))
                .map(function(tab) {
                    tabsToCreate.push({
                        ...tab,
                        cookieStoreId: TEMPORARY_CONTAINER,
                    });

                    return tab.id;
                });

            if (tabsToCreate.length) {
                await loadingBrowserAction();

                // create tabs
                BG.skipCreateTab = true;

                let newTabs = await Promise.all(tabsToCreate.map(Tabs.createNative));

                BG.skipCreateTab = false;

                newTabs = await Promise.all(newTabs.map(cache.setTabSession));

                let tabsToHide = newTabs.filter(tab => tab.groupId && !cache.getWindowId(tab.groupId));

                await Tabs.safeHide(tabsToHide);

                // remove old tabs
                await Tabs.remove(tabsIdsToRemove);

                // remove temporary containers
                if (setActive) {
                    Containers.removeUnusedTemporaryContainers(newTabs);
                }

                loadingBrowserAction(false);
            }
        }),
    }));
}

async function findGroupBookmark(group, parentId, createIfNeed) {
    let bookmark = null;

    if (group.bookmarkId) {
        [bookmark] = await browser.bookmarks.get(group.bookmarkId).catch(() => [bookmark]);
    }

    if (!bookmark && createIfNeed) {
        bookmark = await browser.bookmarks.create({
            title: group.title,
            parentId,
            type: browser.bookmarks.BookmarkTreeNodeType.FOLDER,
        });
    }

    if (bookmark) {
        bookmark.children = await browser.bookmarks.getChildren(bookmark.id);
    }

    return bookmark;
}

async function getGroupBookmark(group, createIfNeed) {
    let hasBookmarksPermission = await browser.permissions.contains(PERMISSIONS.BOOKMARKS);

    if (!hasBookmarksPermission) {
        return;
    }

    let rootBookmark = {
        id: options.defaultBookmarksParent,
    };

    if (options.exportGroupToMainBookmarkFolder) {
        let likeGroup = {
            title: 'STG bookmarks',
            bookmarkId: window.localStorage.mainBookmarksFolderId,
        };

        rootBookmark = await findGroupBookmark(likeGroup, rootBookmark.id, createIfNeed);

        if (!rootBookmark) {
            return;
        }

        window.localStorage.mainBookmarksFolderId = rootBookmark.id;
    }

    return findGroupBookmark(group, rootBookmark.id, createIfNeed);
}

async function removeGroupBookmark(group) {
    let groupBookmarkFolder = await getGroupBookmark(group);

    if (groupBookmarkFolder) {
        await browser.bookmarks.removeTree(groupBookmarkFolder.id);
    }
}

async function updateGroupBookmarkTitle(group) {
    let groupBookmarkFolder = await getGroupBookmark(group);

    if (groupBookmarkFolder) {
        await browser.bookmarks.update(groupBookmarkFolder.id, {
            title: group.title,
        });
    }
}

async function exportGroupToBookmarks(group, groupIndex, showMessages = true) {
    let hasBookmarksPermission = await browser.permissions.contains(PERMISSIONS.BOOKMARKS);

    if (!hasBookmarksPermission) {
        showMessages && utils.notify(['noAccessToBookmarks'], undefined, undefined, undefined, () => browser.runtime.openOptionsPage());
        return;
    }

    if (!group) {
        throw TypeError('group has invalid type in exportGroupToBookmarks');
    }

    if (Number.isFinite(group)) {
        ({group, groupIndex} = await Groups.load(group, true));
    }

    if (showMessages) {
        loadingBrowserAction(true);
    }

    const {BOOKMARK, FOLDER, SEPARATOR} = browser.bookmarks.BookmarkTreeNodeType;

    let {bookmarkId: oldGroupGookmarkId} = group,
        groupBookmarkFolder = await getGroupBookmark(group, true);

    if (options.exportGroupToMainBookmarkFolder) {
        if (groupBookmarkFolder.parentId === window.localStorage.mainBookmarksFolderId && groupBookmarkFolder.index !== groupIndex) {
            await browser.bookmarks.move(groupBookmarkFolder.id, {
                index: groupIndex,
            });
        }
    }

    let bookmarksToRemove = [];

    if (options.leaveBookmarksOfClosedTabs) {
        group.tabs.forEach(function(tab) {
            groupBookmarkFolder.children = groupBookmarkFolder.children.filter(function(bookmark) {
                if (bookmark.type === BOOKMARK) {
                    if (bookmark.url === tab.url) {
                        bookmarksToRemove.push(bookmark.id);
                        return false;
                    }

                    return true;
                }
            });
        });

        await Promise.all(bookmarksToRemove.map(id => browser.bookmarks.remove(id).catch(noop)));

        let children = await browser.bookmarks.getChildren(groupBookmarkFolder.id);

        if (children.length) {
            if (children[0].type !== SEPARATOR) {
                await browser.bookmarks.create({
                    type: SEPARATOR,
                    index: 0,
                    parentId: groupBookmarkFolder.id,
                });
            }

            // found and remove duplicated separators
            let duplicatedSeparators = children.filter(function(separator, index) {
                return separator.type === SEPARATOR && children[index - 1] && children[index - 1].type === SEPARATOR;
            });

            if (children[children.length - 1].type === SEPARATOR && !duplicatedSeparators.includes(children[children.length - 1])) {
                duplicatedSeparators.push(children[children.length - 1]);
            }

            if (duplicatedSeparators.length) {
                await Promise.all(duplicatedSeparators.map(separator => browser.bookmarks.remove(separator.id).catch(noop)));
            }
        }

        for (let index in group.tabs) {
            await browser.bookmarks.create({
                title: group.tabs[index].title,
                url: group.tabs[index].url,
                type: BOOKMARK,
                index: Number(index),
                parentId: groupBookmarkFolder.id,
            });
        }
    } else {
        let foundedBookmarks = new Set;

        for (let index in group.tabs) {
            index = Number(index);

            let tab = group.tabs[index],
                bookmark = groupBookmarkFolder.children.find(function({id, type, url}) {
                    return !foundedBookmarks.has(id) && type === BOOKMARK && url === tab.url;
                });

            if (bookmark) {
                foundedBookmarks.add(bookmark.id);
                await browser.bookmarks.move(bookmark.id, {index});
            } else {
                await browser.bookmarks.create({
                    title: tab.title,
                    url: tab.url,
                    type: BOOKMARK,
                    index,
                    parentId: groupBookmarkFolder.id,
                });
            }
        }

        groupBookmarkFolder.children.forEach(({id, type}) => type !== FOLDER && !foundedBookmarks.has(id) && bookmarksToRemove.push(id));

        await Promise.all(bookmarksToRemove.map(id => browser.bookmarks.remove(id).catch(noop)));
    }

    if (oldGroupGookmarkId !== groupBookmarkFolder.id) {
        await Groups.update(group.id, {
            bookmarkId: groupBookmarkFolder.id,
        });
    }

    if (showMessages) {
        loadingBrowserAction(false);
        utils.notify(['groupExportedToBookmarks', group.title], 7);
    }

    return true;
}

async function setBrowserAction(windowId, title, icon, enable, isSticky) {
    console.info('setBrowserAction', {windowId, title, icon, enable, isSticky});

    let winObj = windowId ? {windowId} : {};

    if ('loading' === title) {
        title = 'lang:loading';
        icon = 'loading';
    }

    if ('loading' === icon) {
        icon = '/icons/animate-spinner.svg';
    }

    if (title?.startsWith('lang:')) {
        title = browser.i18n.getMessage(title.slice(5));
    }

    if (undefined !== enable) {
        if (enable) {
            browser.browserAction.enable();
        } else {
            browser.browserAction.disable();
        }
    }

    await Promise.all([
        browser.browserAction.setTitle({
            ...winObj,
            title: title || manifest.browser_action.default_title,
        }),
        browser.browserAction.setBadgeText({
            ...winObj,
            text: isSticky ? STICKY_SYMBOL : '',
        }),
        browser.browserAction.setIcon({
            ...winObj,
            path: icon || manifest.browser_action.default_icon,
        })
    ]);
}

async function updateBrowserActionData(groupId, windowId, groups) {
    console.log('updateBrowserActionData', {groupId, windowId});

    if (groupId) {
        windowId = cache.getWindowId(groupId);
    } else if (windowId) {
        groupId = cache.getWindowGroup(windowId);
    }

    if (!windowId) {
        return;
    }

    let group = null;

    if (groupId) {
        if (Array.isArray(groups)) {
            group = groups.find(gr => gr.id === groupId);
        } else {
            ({group} = await Groups.load(groupId));
        }
    }

    if (group) {
        await setBrowserAction(windowId, utils.sliceText(utils.getGroupTitle(group, 'withContainer'), 43) + ' - STG', utils.getGroupIconUrl(group), true, group.isSticky); // todo make this args as obj
        await prependWindowTitle(windowId, group.title);
    } else {
        await setBrowserAction(windowId, undefined, undefined, true);
        await prependWindowTitle(windowId);
    }
}

async function prependWindowTitle(windowId, title) {
    if (options.prependGroupTitleToWindowTitle && windowId) {
        await browser.windows.update(windowId, {
            titlePreface: title ? ('[' + utils.sliceText(title, 35) + '] ') : '',
        });
    }
}

let _tabsLazyMoving = {},
    _tabsLazyMovingTimer = 0;

function addTabToLazyMove(tabId, groupId, showTabAfterMovingItIntoThisGroup) {
    clearTimeout(_tabsLazyMovingTimer);

    if (!_tabsLazyMoving[groupId]) {
        _tabsLazyMoving[groupId] = {
            id: groupId,
            tabIds: new Set,
            showTabAfterMovingItIntoThisGroup,
        };
    }

    _tabsLazyMoving[groupId].tabIds.add(tabId);

    _tabsLazyMovingTimer = window.setTimeout(utils.catchFunc(async function() {
        let groups = Object.values(_tabsLazyMoving);

        _tabsLazyMoving = {};

        for (let group of groups) {
            await Tabs.move(Array.from(group.tabIds), group.id, undefined, undefined, group.showTabAfterMovingItIntoThisGroup);
        }
    }), 100);
}

let canceledRequests = new Set;
const onBeforeTabRequest = utils.catchFunc(async function({tabId, url, cookieStoreId, originUrl, requestId, frameId}) {
    if (frameId !== 0 || tabId === -1 || Containers.isTemporary(cookieStoreId)) {
        return {};
    }

    if (canceledRequests.has(requestId)) {
        return {
            cancel: true,
        };
    }

    originUrl = originUrl || '';

    if (originUrl.startsWith(addonUrlPrefix)) {
        originUrl = 'this_addon';
    }

    let excludeTab = excludeTabIds.has(tabId);

    console.log((excludeTab ? '🛑' : ''), 'onBeforeTabRequest tabId', tabId, 'url', url, 'originUrl', originUrl);

    if (excludeTab || !cache.getTabGroup(tabId)) {
        return {};
    }

    await utils.wait(100);

    let tab = await Tabs.getOne(tabId);

    if (!tab) {
        console.warn('onBeforeTabRequest tab %s not found', tabId);
        return {};
    }

    if (utils.isTabPinned(tab)) {
        console.log('🛑 onBeforeTabRequest cancel, tab is pinned');
        return {};
    }

    tab.url = url;

    if (utils.isUrlEmpty(tab.url)) {
        delete tab.title;
    }

    cache.applyTabSession(tab);

    if (!tab.groupId) {
        return {};
    }

    console.log('onBeforeTabRequest tab', tab);

    let {group: tabGroup, groups} = await Groups.load(tab.groupId);

    if (!tabGroup.isSticky) {
        let destGroup = Groups.getCatchedForTab(groups, tabGroup, tab);

        if (destGroup) {
            cache.setTab(tab);
            console.log('onBeforeTabRequest move tab from groupId %s -> %s', tabGroup.id, destGroup.id);
            addTabToLazyMove(tab.id, destGroup.id, destGroup.showTabAfterMovingItIntoThisGroup);
            return {};
        }
    }

    let newTabContainer = Tabs.getNewTabContainer(tab, tabGroup);

    if (tab.cookieStoreId === newTabContainer) {
        return {};
    }

    let originExt = Management.getExtensionByUUID(originUrl.slice(0, 50));

    function getNewAddonTabUrl(asInfo) {
        let params = {
            url: tab.url,
            anotherCookieStoreId: tab.cookieStoreId,
            destCookieStoreId: newTabContainer,
            conflictedExtId: originExt.id,
            groupId: tabGroup.id,
        };

        if (asInfo) {
            params.asInfo = true;
        }

        return utils.setUrlSearchParams(browser.runtime.getURL('/help/open-in-container.html'), params);
    }

    if (IGNORE_EXTENSIONS_FOR_REOPEN_TAB_IN_CONTAINER.includes(originExt?.id)) {
        let showNotif = +window.localStorage.ignoreExtensionsForReopenTabInContainer || 0;

        if (showNotif < 10) {
            window.localStorage.ignoreExtensionsForReopenTabInContainer = ++showNotif;
            let str = browser.i18n.getMessage('helpPageOpenInContainerMainTitle', Containers.get(newTabContainer, 'name'));

            str = str.replace(/(\<.+?\>)/g, '') + '\n\n' + browser.i18n.getMessage('clickHereForInfo');

            utils.notify(str, undefined, undefined, undefined, function() {
                Tabs.create({
                    active: true,
                    url: getNewAddonTabUrl(true),
                    groupId: tabGroup.id,
                });
            });
        }

        return {};
    }

    canceledRequests.add(requestId);
    setTimeout(requestId => canceledRequests.delete(requestId), 2000, requestId);

    Tabs.remove(tab.id).catch(noop);

    Promise.resolve().then(async () => {
        let newTabParams = {
            ...tab,
            cookieStoreId: newTabContainer,
            ...Groups.getNewTabParams(tabGroup),
        };

        if (originUrl.startsWith('moz-extension')) {
            if (tab.hidden) {
                //
            } else {
                if (!ignoreExtForReopenContainer.has(originExt.id)) {
                    newTabParams.active = true;
                    newTabParams.url = getNewAddonTabUrl();
                }
            }
        }

        let newTab = await Tabs.create(newTabParams);
        if (tab.hidden) {
            Tabs.safeHide(newTab);
        }
    });

    return {
        cancel: true,
    };
});

// wait for reload addon if found update
browser.runtime.onUpdateAvailable.addListener(() => utils.safeReloadAddon());

function addListenerOnBeforeRequest() {
    if (!browser.webRequest.onBeforeRequest.hasListener(onBeforeTabRequest)) {
        browser.webRequest.onBeforeRequest.addListener(onBeforeTabRequest,
            {
                urls: ['<all_urls>'],
                types: [browser.webRequest.ResourceType.MAIN_FRAME],
            },
            [browser.webRequest.OnBeforeRequestOptions.BLOCKING]
        );
    }
}

function removeListenerOnBeforeRequest() {
    if (browser.webRequest.onBeforeRequest.hasListener(onBeforeTabRequest)) {
        browser.webRequest.onBeforeRequest.removeListener(onBeforeTabRequest);
    }
}

function addEvents() {
    browser.tabs.onActivated.addListener(onActivatedTab)
    browser.tabs.onCreated.addListener(onCreatedTab);
    browser.tabs.onUpdated.addListener(onUpdatedTab, {
        properties: ON_UPDATED_TAB_PROPERTIES,
    });
    browser.tabs.onRemoved.addListener(onRemovedTab);
    browser.tabs.onMoved.addListener(onMovedTab);

    browser.tabs.onAttached.addListener(onAttachedTab);

    browser.windows.onCreated.addListener(onCreatedWindow);
    browser.windows.onFocusChanged.addListener(onFocusChangedWindow);
    browser.windows.onRemoved.addListener(onRemovedWindow);
}

function removeEvents() {
    browser.tabs.onActivated.removeListener(onActivatedTab);
    browser.tabs.onCreated.removeListener(onCreatedTab);
    browser.tabs.onUpdated.removeListener(onUpdatedTab);
    browser.tabs.onRemoved.removeListener(onRemovedTab);
    browser.tabs.onMoved.removeListener(onMovedTab);

    browser.tabs.onAttached.removeListener(onAttachedTab);

    browser.windows.onCreated.removeListener(onCreatedWindow);
    browser.windows.onFocusChanged.removeListener(onFocusChangedWindow);
    browser.windows.onRemoved.removeListener(onRemovedWindow);

    removeListenerOnBeforeRequest();
}

window.addEventListener('unload', removeEvents);

async function openManageGroups() {
    if (options.openManageGroupsInTab) {
        await Tabs.createUrlOnce(manageTabsPageUrl);
    } else {
        let allWindows = await browser.windows.getAll({
            populate: true,
            windowTypes: [browser.windows.WindowType.POPUP],
        });

        let popupWindow = allWindows.find(win => browser.windows.WindowType.POPUP === win.type && 1 === win.tabs.length && manageTabsPageUrl === win.tabs[0].url);

        if (popupWindow) {
            await Windows.setFocus(popupWindow.id);
        } else {
            await Windows.create({
                url: manageTabsPageUrl,
                type: browser.windows.CreateType.POPUP,
                width: Number(window.localStorage.manageGroupsWindowWidth) || 1000,
                height: Number(window.localStorage.manageGroupsWindowHeight) || 700,
            });
        }
    }
}

function openNotSupportedUrlHelper() {
    Tabs.createUrlOnce('https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/Content_scripts');
}

browser.commands.onCommand.addListener(runAction);

browser.runtime.onMessage.addListener(runAction);

browser.runtime.onMessageExternal.addListener(async function(request, sender) {
    if (request?.action === 'ignore-ext-for-reopen-container') {
        ignoreExtForReopenContainer.add(sender.id);
        return {
            ok: true,
        };
    }

    if (!window.BG.inited) {
        return {
            ok: false,
            error: '[STG] I am not yet loaded',
        };
    }

    let extensionRules = {};

    if (!utils.isAllowExternalRequestAndSender(request, sender, extensionRules)) {
        return {
            ok: false,
            error: '[STG] Your extension/action does not in white list. If you want to add your extension/action to white list - please contact with me.',
            yourExtentionRules: extensionRules,
        };
    }

    if (!request.action) {
        return {
            ok: false,
            error: 'unknown action',
        };
    }

    return runAction(request, sender);
});

async function runAction(data, sender = {}) {
    let result = {
        ok: false,
    };

    if (typeof data === 'string' && data.length) {
        data = {
            action: data,
        };
    }

    if (!data.action) {
        result.error = '[STG] "action" is empty';
        return result;
    }

    console.info('runAction', {data, sender});

    if (data.action === 'ignore-ext-for-reopen-container') {
        ignoreExtForReopenContainer.add(data.id);
        return {
            ok: true,
        };
    }

    try {
        let currentWindow = await Windows.getLastFocusedNormalWindow(false),
            actionWithTabs = [
                'load-next-non-empty-group',
                'load-prev-non-empty-group',
                'discard-group',
                'discard-other-groups',
                'reload-all-tabs-in-current-group',
            ],
            loadCurrentGroupWithTabs = currentWindow.groupId ? actionWithTabs.includes(data.action) : false,
            {group: currentGroup, groups} = await Groups.load(currentWindow.groupId || -1, loadCurrentGroupWithTabs),
            notArchivedGroups = groups.filter(group => !group.isArchive);

        if (!currentGroup) {
            currentGroup = {
                id: 0,
            };
        }

        switch (data.action) {
            case 'are-you-here':
                result.ok = true;
                break;
            case 'get-groups-list':
                result.groupsList = groups.map(Groups.mapForExternalExtension);
                result.ok = true;
                break;
            case 'load-next-group':
                result.ok = await applyGroupByPosition('next', notArchivedGroups, currentGroup.id);
                break;
            case 'load-prev-group':
                result.ok = await applyGroupByPosition('prev', notArchivedGroups, currentGroup.id);
                break;
            case 'load-next-unloaded-group':
                {
                    let unloadedGroups = notArchivedGroups.filter(group => !cache.getWindowId(group.id) || group.id === currentGroup.id);
                    result.ok = await applyGroupByPosition('next', unloadedGroups, currentGroup.id);
                }
                break;
            case 'load-prev-unloaded-group':
                {
                    let unloadedGroups = notArchivedGroups.filter(group => !cache.getWindowId(group.id) || group.id === currentGroup.id);
                    result.ok = await applyGroupByPosition('prev', unloadedGroups, currentGroup.id);
                }
                break;
            case 'load-next-non-empty-group':
                    result.ok = await applyGroupByPosition('next', notArchivedGroups.filter(group => group.tabs.length), currentGroup.id);
                break;
            case 'load-prev-non-empty-group':
                    result.ok = await applyGroupByPosition('prev', notArchivedGroups.filter(group => group.tabs.length), currentGroup.id);
                break;
            case 'load-history-next-group':
                result.ok = await applyGroupByHistory('next', notArchivedGroups);
                break;
            case 'load-history-prev-group':
                result.ok = await applyGroupByHistory('prev', notArchivedGroups);
                break;
            case 'load-first-group':
                if (notArchivedGroups.length) {
                    result.ok = await applyGroup(currentWindow.id, notArchivedGroups.shift().id);
                }
                break;
            case 'load-last-group':
                if (notArchivedGroups.length) {
                    result.ok = await applyGroup(currentWindow.id, notArchivedGroups.pop().id);
                }
                break;
            case 'load-custom-group':
                if (Number.isFinite(data.groupId) && 0 < data.groupId) {
                    if (groups.some(group => group.id === data.groupId)) {
                        let groupToLoad = groups.find(group => group.id === data.groupId);

                        if (groupToLoad.isArchive) {
                            result.error = browser.i18n.getMessage('groupIsArchived', groupToLoad.title);
                            utils.notify(result.error, 7, 'groupIsArchived');
                        } else {
                            result.ok = await applyGroup(currentWindow.id, data.groupId);
                        }
                    } else {
                        delete data.groupId;
                        result = await runAction(data, sender);
                    }
                } else if ('new' === data.groupId) {
                    let {ok, group} = await runAction({
                        action: 'add-new-group',
                        proposalTitle: data.title,
                    }, sender);

                    if (ok) {
                        result.ok = await applyGroup(currentWindow.id, group.id);
                    }
                } else {
                    let activeTab = await Tabs.getActive();

                    if (Tabs.isCanSendMessage(activeTab)) {
                        Tabs.sendMessage(activeTab.id, {
                            action: 'show-groups-popup',
                            popupAction: 'load-custom-group',
                            popupTitle: browser.i18n.getMessage('hotkeyActionTitleLoadCustomGroup'),
                            groups: notArchivedGroups.map(Groups.mapForExternalExtension),
                            disableGroupIds: [currentGroup.id],
                        });

                        result.ok = true;
                    } else {
                        result.error = browser.i18n.getMessage('impossibleToAskUserAboutAction', [activeTab.title, browser.i18n.getMessage('hotkeyActionTitleLoadCustomGroup')]);
                        utils.notify(result.error, 15, 'impossibleToAskUserAboutAction', undefined, openNotSupportedUrlHelper);
                    }
                }
                break;
            case 'unload-group':
                result.ok = await Groups.unload(currentGroup.id);
                break;
            case 'add-new-group':
                if (!options.alwaysAskNewGroupName || data.title) {
                    let newGroup = await Groups.add(undefined, data.tabIds, data.title, data.showTabsAfterMoving);

                    result.ok = true;
                    result.group = Groups.mapForExternalExtension(newGroup);
                } else {
                    let activeTab = await Tabs.getActive(),
                        {lastCreatedGroupPosition} = await storage.get('lastCreatedGroupPosition');

                    if (Tabs.isCanSendMessage(activeTab)) {
                        let title = await Tabs.sendMessage(activeTab.id, {
                            action: 'show-prompt',
                            promptTitle: browser.i18n.getMessage('createNewGroup'),
                            value: data.proposalTitle || browser.i18n.getMessage('newGroupTitle', lastCreatedGroupPosition + 1),
                        });

                        if (title) {
                            result = await runAction({
                                action: 'add-new-group',
                                title: title,
                                tabIds: data.tabIds,
                                showTabsAfterMoving: data.showTabsAfterMoving,
                            }, sender);
                        } else {
                            result.error = 'title in empty - skip create group';
                        }
                    } else {
                        result = await runAction({
                            action: 'add-new-group',
                            title: data.proposalTitle || browser.i18n.getMessage('newGroupTitle', lastCreatedGroupPosition + 1),
                            tabIds: data.tabIds,
                            showTabsAfterMoving: data.showTabsAfterMoving,
                        }, sender);

                        if (options.alwaysAskNewGroupName) {
                            result.error = browser.i18n.getMessage('impossibleToAskUserAboutAction', [activeTab.title, browser.i18n.getMessage('createNewGroup')]);
                            utils.notify(result.error, 15, 'impossibleToAskUserAboutAction', undefined, openNotSupportedUrlHelper);
                        }
                    }
                }
                break;
            case 'rename-group':
                if (!groups.length) {
                    result.error = browser.i18n.getMessage('noGroupsAvailable');
                    utils.notify(result.error, 7, 'noGroupsAvailable');
                } else if (!data.groupId) {
                    let activeTab = await Tabs.getActive();

                    if (Tabs.isCanSendMessage(activeTab)) {
                        Tabs.sendMessage(activeTab.id, {
                            action: 'show-groups-popup',
                            popupAction: 'rename-group',
                            popupTitle: browser.i18n.getMessage('hotkeyActionTitleRenameGroup'),
                            groups: groups.map(Groups.mapForExternalExtension),
                            focusedGroupId: currentGroup.id,
                            disableNewGroupItem: true,
                        });

                        result.ok = true;
                    } else {
                        result.error = browser.i18n.getMessage('impossibleToAskUserAboutAction', [activeTab.title, browser.i18n.getMessage('hotkeyActionTitleRenameGroup')]);
                        utils.notify(result.error, 15, 'impossibleToAskUserAboutAction', undefined, openNotSupportedUrlHelper);
                    }
                } else if (data.groupId && !data.title) {
                    let groupToRename = groups.find(group => group.id === data.groupId);

                    if (groupToRename) {
                        let activeTab = await Tabs.getActive();

                        if (Tabs.isCanSendMessage(activeTab)) {
                            let title = await Tabs.sendMessage(activeTab.id, {
                                action: 'show-prompt',
                                promptTitle: browser.i18n.getMessage('hotkeyActionTitleRenameGroup'),
                                value: groupToRename.title,
                            });

                            if (title) {
                                data.title = title;
                                result = await runAction(data, sender);
                            } else {
                                result.error = 'title in empty - skip rename group';
                            }
                        } else {
                            result.error = browser.i18n.getMessage('impossibleToAskUserAboutAction', [activeTab.title, browser.i18n.getMessage('hotkeyActionTitleRenameGroup')]);
                            utils.notify(result.error, 15, 'impossibleToAskUserAboutAction', undefined, openNotSupportedUrlHelper);
                        }
                    } else {
                        result = await runAction('rename-group', sender);
                    }
                } else if (data.groupId && data.title && typeof data.title === 'string') {
                    let groupToRename = groups.find(group => group.id === data.groupId);

                    if (groupToRename) {
                        Groups.update(groupToRename.id, {
                            title: data.title,
                        });
                        result.ok = true;
                    } else {
                        result = await runAction('rename-group', sender);
                    }
                } else {
                    result = await runAction('rename-group', sender);
                }
                break;
            case 'delete-current-group':
                if (currentGroup.id) {
                    await Groups.remove(currentGroup.id);

                    if (sender.id) {
                        utils.notify(['groupRemovedByExtension', [currentGroup.title, utils.getSupportedExternalExtensionName(sender.id)]]);
                    }

                    result.ok = true;
                } else {
                    throw Error('There are no group in the current window');
                }

                break;
            case 'open-manage-groups':
                await openManageGroups();
                result.ok = true;
                break;
            case 'move-selected-tabs-to-custom-group':
                let activeTab = await Tabs.getActive(),
                    tabIds = await Tabs.getHighlightedIds(activeTab.windowId, undefined, null);

                if (Number.isFinite(data.groupId) && 0 < data.groupId) {
                    if (groups.some(group => group.id === data.groupId)) {
                        let groupMoveTo = groups.find(group => group.id === data.groupId);

                        if (groupMoveTo.isArchive) {
                            result.error = browser.i18n.getMessage('groupIsArchived', groupMoveTo.title);
                            utils.notify(result.error, 7, 'groupIsArchived');
                        } else {
                            await Tabs.move(tabIds, data.groupId);
                            result.ok = true;
                        }
                    } else {
                        delete data.groupId;
                        result = await runAction(data, sender);
                    }
                } else if ('new' === data.groupId) {
                    let {ok} = await runAction({
                        action: 'add-new-group',
                        title: data.title,
                        proposalTitle: activeTab.title,
                        tabIds: tabIds,
                    }, sender);

                    result.ok = ok;
                } else {
                    if (Tabs.isCanSendMessage(activeTab)) {
                        Tabs.sendMessage(activeTab.id, {
                            action: 'show-groups-popup',
                            popupAction: data.action,
                            popupTitle: browser.i18n.getMessage('hotkeyActionTitleMoveSelectedTabsToCustomGroup'),
                            groups: notArchivedGroups.map(Groups.mapForExternalExtension),
                            focusedGroupId: activeTab.groupId,
                        });

                        result.ok = true;
                    } else {
                        result.error = browser.i18n.getMessage('impossibleToAskUserAboutAction', [activeTab.title, browser.i18n.getMessage('hotkeyActionTitleMoveSelectedTabsToCustomGroup')]);
                        utils.notify(result.error, 15, 'impossibleToAskUserAboutAction', undefined, openNotSupportedUrlHelper);
                    }
                }
                break;
            case 'discard-group':
                let groupToDiscard = groups.find(group => group.id === data.groupId);

                if (groupToDiscard) {
                    if (groupToDiscard.isArchive) {
                        result.error = browser.i18n.getMessage('groupIsArchived', groupToDiscard.title);
                        utils.notify(result.error, 7, 'groupIsArchived');
                    } else {
                        await Tabs.discard(groupToDiscard.tabs);
                        result.ok = true;
                    }
                } else {
                    let activeTab = await Tabs.getActive();

                    if (Tabs.isCanSendMessage(activeTab)) {
                        Tabs.sendMessage(activeTab.id, {
                            action: 'show-groups-popup',
                            popupAction: 'discard-group',
                            popupTitle: browser.i18n.getMessage('hotkeyActionTitleDiscardGroup'),
                            groups: notArchivedGroups.map(Groups.mapForExternalExtension),
                            focusedGroupId: currentGroup.id,
                            disableNewGroupItem: true,
                        });

                        result.ok = true;
                    } else {
                        result.error = browser.i18n.getMessage('impossibleToAskUserAboutAction', [activeTab.title, browser.i18n.getMessage('hotkeyActionTitleDiscardGroup')]);
                        utils.notify(result.error, 15, 'impossibleToAskUserAboutAction', undefined, openNotSupportedUrlHelper);
                    }
                }
                break;
            case 'discard-other-groups':
                {
                    let tabs = notArchivedGroups.reduce(function(acc, gr) {
                        if (gr.id !== currentGroup.id && !cache.getWindowId(gr.id)) {
                            acc.push(...gr.tabs);
                        }
                        return acc;
                    }, []);

                    await Tabs.discard(tabs);

                    result.ok = true;
                }
                break;
            case 'reload-all-tabs-in-current-group':
                if (currentGroup.id) {
                    await Tabs.reload(currentGroup.tabs);
                    result.ok = true;
                }

                break;
            case 'create-temp-tab':
                await Tabs.createNative({
                    active: data.active,
                    cookieStoreId: TEMPORARY_CONTAINER,
                });

                result.ok = true;

                break;
            case 'get-current-group':
                if (data.windowId) {
                    let groupId = cache.getWindowGroup(data.windowId);

                    if (groupId) {
                        let {group} = await Groups.load(groupId);

                        result.group = Groups.mapForExternalExtension(group);
                    } else {
                        result.group = null;
                    }

                    result.ok = true;
                } else {
                    throw Error('windowId is required');
                }

                break;
            case 'exclude-container-for-group':
                let group = groups.find(group => group.id === data.groupId);

                if (!group || !data.cookieStoreId || Containers.get(data.cookieStoreId, 'cookieStoreId', true) !== data.cookieStoreId) {
                    throw Error('invalid groupId or cookieStoreId');
                }

                if (!group.excludeContainersForReOpen.includes(data.cookieStoreId)) {
                    group.excludeContainersForReOpen.push(data.cookieStoreId);
                    await Groups.save(groups);
                }

                result.ok = true;

                break;
            case 'create-backup':
                result.ok = await createBackup(true, true, true, true);

                break;
            default:
                throw Error(`Action '${data.action}' is wrong`);
                break;
        }

    } catch (e) {
        result.error = '[STG] ' + String(e);
        console.error(result.error);
    }

    return result;
}

async function saveOptions(_options) {
    if (!window.BG.inited) {
        console.error('background not yet inited');
        return;
    }

    _options = utils.clone(_options);

    console.info('save options', _options);

    let optionsKeys = Object.keys(_options);

    if (!optionsKeys.every(key => ALL_OPTIONS_KEYS.includes(key))) {
        throw Error('some key in save options are not supported: ' + optionsKeys.join(', '));
    }

    Object.assign(options, _options);

    await storage.set(_options);

    if (optionsKeys.includes('hotkeys')) {
        let tabs = await Tabs.get(null, null, null, {
                discarded: false,
            }),
            actionData = {
                action: 'update-hotkeys',
            };

        tabs.forEach(tab => Tabs.sendMessage(tab.id, actionData));
    }

    if (optionsKeys.some(key => ['autoBackupEnable', 'autoBackupIntervalKey', 'autoBackupIntervalValue'].includes(key))) {
        resetAutoBackup();
    }

    if (optionsKeys.includes('prependGroupTitleToWindowTitle')) {
        Windows.load().then(function(windows) {
            windows.forEach(function({id}) {
                if (options.prependGroupTitleToWindowTitle) {
                    updateBrowserActionData(null, id);
                } else {
                    browser.windows.update(id, {
                        titlePreface: '',
                    });
                }
            });
        });
    }

    if (optionsKeys.includes('temporaryContainerTitle')) {
        Containers.updateTemporaryContainerTitle(options.temporaryContainerTitle);
    }

    if (optionsKeys.some(key => ['showContextMenuOnTabs', 'showContextMenuOnLinks'].includes(key))) {
        updateMoveTabMenus();
    }

    sendMessage({
        action: 'options-updated',
    });
}

let _autoBackupTimer = 0;
async function resetAutoBackup() {
    if (_autoBackupTimer) {
        clearTimeout(_autoBackupTimer);
        _autoBackupTimer = 0;
    }

    if (!options.autoBackupEnable) {
        return;
    }

    let now = utils.unixNow(),
        timer = 0,
        value = Number(options.autoBackupIntervalValue);

    if (isNaN(value) || value < 1) {
        throw Error(errorEventMessage('invalid autoBackupIntervalValue', options));
    }

    let intervalSec = null;

    if (AUTO_BACKUP_INTERVAL_KEY.minutes === options.autoBackupIntervalKey) {
        if (value > 59) {
            throw Error(errorEventMessage('invalid autoBackupIntervalValue', options));
        }

        intervalSec = MINUTE_SEC;
    } else if (AUTO_BACKUP_INTERVAL_KEY.hours === options.autoBackupIntervalKey) {
        if (value > 24) {
            throw Error(errorEventMessage('invalid autoBackupIntervalValue', options));
        }

        intervalSec = HOUR_SEC;
    } else if (AUTO_BACKUP_INTERVAL_KEY.days === options.autoBackupIntervalKey) {
        if (value > 30) {
            throw Error(errorEventMessage('invalid autoBackupIntervalValue', options));
        }

        if (value === 1) {
            // if backup will create every day - overwrite backups every 2 hours in order to keep as recent changes as possible
            intervalSec = HOUR_SEC * 2;
        } else {
            intervalSec = DAY_SEC;
        }
    } else {
        throw Error(errorEventMessage('invalid autoBackupIntervalKey', options));
    }

    let timeToBackup = value * intervalSec + options.autoBackupLastBackupTimeStamp;

    if (now > timeToBackup) {
        createBackup(options.autoBackupIncludeTabFavIcons, options.autoBackupIncludeTabThumbnails, true);
        timer = value * intervalSec;
    } else {
        timer = timeToBackup - now;
    }

    _autoBackupTimer = setTimeout(resetAutoBackup, (timer + 10) * 1000);
}

async function createBackup(includeTabFavIcons, includeTabThumbnails, isAutoBackup = false) {
    let [data, {groups}] = await Promise.all([storage.get(), Groups.load(null, true, includeTabFavIcons, includeTabThumbnails)]);

    if (isAutoBackup && (!groups.length || groups.every(gr => !gr.tabs.length))) {
        console.warn('skip create auto backup, groups are empty');
        return false;
    }

    if (includeTabThumbnails) {
        includeTabThumbnails = options.showTabsWithThumbnailsInManageGroups;
    }

    let pinnedTabs = await Tabs.get(null, true, null);

    pinnedTabs = pinnedTabs.filter(tab => utils.isUrlAllowToCreate(tab.url));

    if (pinnedTabs.length) {
        data.pinnedTabs = Tabs.prepareForSave(pinnedTabs);
    }

    let containersToExport = new Set;

    data.groups = groups.map(function(group) {
        group.tabs = Tabs.prepareForSave(group.tabs, false, includeTabFavIcons, includeTabThumbnails);

        group.tabs.forEach(function({cookieStoreId}) {
            if (!Containers.isDefault(cookieStoreId) && !Containers.isTemporary(cookieStoreId)) {
                containersToExport.add(cookieStoreId);
            }
        });

        if (group.newTabContainer !== TEMPORARY_CONTAINER && group.newTabContainer !== DEFAULT_COOKIE_STORE_ID) {
            containersToExport.add(group.newTabContainer);
        }

        group.catchTabContainers.forEach(containersToExport.add, containersToExport);

        return group;
    });

    let allContainers = Containers.getAll();

    data.containers = {};

    containersToExport.forEach(cookieStoreId => data.containers[cookieStoreId] = allContainers[cookieStoreId]);

    if (isAutoBackup) {
        data.autoBackupLastBackupTimeStamp = options.autoBackupLastBackupTimeStamp = utils.unixNow();

        if (options.autoBackupGroupsToFile) {
            file.backup(data, true, options.autoBackupByDayIndex);
        }

        if (options.autoBackupGroupsToBookmarks) {
            exportAllGroupsToBookmarks();
        }

        storage.set({
            autoBackupLastBackupTimeStamp: data.autoBackupLastBackupTimeStamp,
        });
    } else {
        await file.backup(data, false);
    }

    return true;
}

async function restoreBackup(data, clearAddonDataBeforeRestore = false) {
    removeEvents();

    sendMessage({
        action: 'lock-addon',
    });

    await loadingBrowserAction();

    let {os} = await browser.runtime.getPlatformInfo(),
        isMac = os === browser.runtime.PlatformOs.MAC,
        {lastCreatedGroupPosition} = await storage.get('lastCreatedGroupPosition'),
        currentData = {};

    if (!lastCreatedGroupPosition) {
        clearAddonDataBeforeRestore = true;
    }

    if (clearAddonDataBeforeRestore) {
        lastCreatedGroupPosition = 0;
    }

    if (!Number.isInteger(data.lastCreatedGroupPosition)) {
        data.lastCreatedGroupPosition = 0;
    }

    lastCreatedGroupPosition = Math.max(lastCreatedGroupPosition, data.lastCreatedGroupPosition);

    if (clearAddonDataBeforeRestore) {
        await clearAddon(false);

        await utils.wait(1000);
    } else {
        data.groups.forEach(group => group.isMain = false);
    }

    if (data.temporaryContainerTitle) {
        await Containers.updateTemporaryContainerTitle(data.temporaryContainerTitle);
    }

    if (clearAddonDataBeforeRestore) {
        options.showTabsWithThumbnailsInManageGroups = DEFAULT_OPTIONS.showTabsWithThumbnailsInManageGroups;
    }

    if (data.hasOwnProperty('showTabsWithThumbnailsInManageGroups')) {
        options.showTabsWithThumbnailsInManageGroups = data.showTabsWithThumbnailsInManageGroups;
    }

    if (clearAddonDataBeforeRestore) {
        currentData.groups = [];
        currentData.hotkeys = [];
    } else {
        currentData = await storage.get('hotkeys'),
        ({groups: currentData.groups} = await Groups.load(null, true, true, options.showTabsWithThumbnailsInManageGroups));
    }

    if (!Array.isArray(data.hotkeys)) {
        data.hotkeys = [];
    } else if (!isMac) {
        data.hotkeys.forEach(hotkey => hotkey.metaKey = false);
    }

    let neededConteiners = new Set;

    function prepareTab(newTabParams, tab) {
        delete tab.active;
        delete tab.windowId;
        delete tab.index;
        delete tab.pinned;

        if (tab.cookieStoreId && !Containers.isTemporary(tab.cookieStoreId)) {
            neededConteiners.add(tab.cookieStoreId);
        }

        Object.assign(tab, newTabParams);
    }

    data.groups = data.groups.map(function(group) {
        let newGroupId = null;

        if (Number.isInteger(group.id)) {
            if (group.id > lastCreatedGroupPosition) {
                lastCreatedGroupPosition = group.id;
            }

            newGroupId = clearAddonDataBeforeRestore ? group.id : (++lastCreatedGroupPosition);
        } else {
            newGroupId = ++lastCreatedGroupPosition;
        }

        let newGroup = Groups.create(newGroupId, group.title);

        if (group.id) {
            data.hotkeys.forEach(hotkey => hotkey.groupId === group.id ? (hotkey.groupId = newGroup.id) : null);
        }

        delete group.id;

        for (let key in group) {
            if (newGroup.hasOwnProperty(key)) {
                newGroup[key] = group[key];
            }
        }

        let newTabParams = Groups.getNewTabParams(newGroup);
        newGroup.tabs.forEach(prepareTab.bind(null, newTabParams));

        return newGroup;
    });

    data.groups = [...currentData.groups, ...data.groups];
    data.hotkeys = [...currentData.hotkeys, ...data.hotkeys];

    data.hotkeys = data.hotkeys.filter(function(hotkey, index, self) {
        if (HOTKEY_ACTIONS_WITH_CUSTOM_GROUP.includes(hotkey.action) && hotkey.groupId && !data.groups.some(gr => gr.id === hotkey.groupId)) {
            hotkey.groupId = 0;
        }

        return self.findIndex(h => Object.keys(hotkey).every(key => hotkey[key] === h[key])) === index;
    });

    data.lastCreatedGroupPosition = lastCreatedGroupPosition;

    if (data.containers) {
        for (let cookieStoreId in data.containers) {
            if (!neededConteiners.has(cookieStoreId)) {
                continue;
            }

            let newCookieStoreId = await Containers.normalize(cookieStoreId, data.containers[cookieStoreId]);

            if (newCookieStoreId !== cookieStoreId) {
                data.groups.forEach(function(group) {
                    if (group.newTabContainer === cookieStoreId) {
                        group.newTabContainer = newCookieStoreId;
                    }

                    group.catchTabContainers = group.catchTabContainers.map(csId => csId === cookieStoreId ? newCookieStoreId : csId);
                });
            }
        }
    }

    delete data.containers;

    let allTabs = await Tabs.get(null, false, null, undefined, true, options.showTabsWithThumbnailsInManageGroups);

    await syncTabs(data.groups, allTabs);

    if (Array.isArray(data.pinnedTabs)) {
        let currentPinnedTabs = await Tabs.get(null, true, null);

        data.pinnedTabs = data.pinnedTabs.filter(function(tab) {
            delete tab.groupId;
            tab.pinned = true;
            return !currentPinnedTabs.some(t => t.url === tab.url);
        });

        if (data.pinnedTabs.length) {
            await createTabsSafe(data.pinnedTabs, false, false);
        }
    }

    delete data.pinnedTabs;

    window.localStorage.isBackupRestoring = 1;

    await storage.set(data);

    await utils.wait(200);

    browser.runtime.reload(); // reload addon
}

async function clearAddon(reloadAddonOnFinish = true) {
    if (reloadAddonOnFinish) {
        await loadingBrowserAction();

        sendMessage({
            action: 'lock-addon',
        });
    }

    removeEvents();

    let [tabs, windows] = await Promise.all([Tabs.get(null, null, null), Windows.load()]);

    await Promise.all(tabs.map(tab => cache.removeTabSession(tab.id)));
    await Promise.all(windows.map(win => cache.removeWindowSession(win.id)));

    await storage.clear();

    cache.clear();

    window.localStorage.clear();

    if (reloadAddonOnFinish) {
        browser.runtime.reload(); // reload addon
    }
}

async function exportAllGroupsToBookmarks(showFinishMessage) {
    let hasBookmarksPermission = await browser.permissions.contains(PERMISSIONS.BOOKMARKS);

    if (!hasBookmarksPermission) {
        return;
    }

    if (showFinishMessage) {
        await loadingBrowserAction();
    }

    let {groups} = await Groups.load(null, true);

    for (let groupIndex in groups) {
        await exportGroupToBookmarks(groups[groupIndex], Number(groupIndex), false);
    }

    if (showFinishMessage) {
        loadingBrowserAction(false);

        utils.notify(['allGroupsExportedToBookmarks']);
    }
}

window.BG = {
    inited: false,

    cache,
    openManageGroups,

    options,
    saveOptions,

    Containers,
    normalizeContainersInGroups,

    Tabs,
    Groups,
    Windows,

    createTabsSafe,

    addUndoRemoveGroupItem,

    excludeTabIds,
    addExcludeTabIds,
    removeExcludeTabIds,

    sendMessage,
    sendExternalMessage,

    setBrowserAction,
    updateBrowserActionData,
    updateMoveTabMenus,

    loadingBrowserAction,

    exportGroupToBookmarks,
    updateGroupBookmarkTitle,
    removeGroupBookmark,
    applyGroup,

    addListenerOnBeforeRequest,
    removeListenerOnBeforeRequest,

    runMigrateForData,

    createBackup,
    restoreBackup,
    clearAddon,

    groupIdForNextTab: null,

    skipCreateTab: false,
    skipAddGroupToNextNewWindow: false,

    browser,

    console,
};

async function runMigrateForData(data) {
    let currentVersion = manifest.version;

    if (data.version === currentVersion) {
        return false;
    }

    if (data.version === DEFAULT_OPTIONS.version) {
        data.version = currentVersion;
        return true;
    }

    let migrations = [
        {
            version: '1.8.1',
            remove: ['windowsGroup'],
            migration() {
                data.groups = data.groups.map(function(group) {
                    group.windowId = data.windowsGroup[win.id] === group.id ? win.id : null;

                    group.catchTabRules = group.moveNewTabsToThisGroupByRegExp || '';
                    delete group.moveNewTabsToThisGroupByRegExp;

                    delete group.classList;
                    delete group.colorCircleHtml;
                    delete group.isExpanded;

                    if (group.iconColor === undefined || group.iconColor === 'undefined') { // fix missed group icons :)
                        group.iconColor = utils.randomColor();
                    }

                    return group;
                });
            },
        },
        {
            version: '2.2',
            remove: ['showGroupCircleInSearchedTab'],
            migration() {
                if (data.hasOwnProperty('showGroupCircleInSearchedTab')) {
                    data.showGroupIconWhenSearchATab = data.showGroupCircleInSearchedTab;
                }
            },
        },
        {
            version: '2.3',
            remove: ['enableKeyboardShortcutLoadNextPrevGroup', 'enableKeyboardShortcutLoadByIndexGroup'],
            migration() {
                data.groups = data.groups.map(function(group) {
                    group.tabs = group.tabs.filter(Boolean);
                    return group;
                });
            },
        },
        {
            version: '2.4',
            migration() {
                data.groups = data.groups.map(function(group) {
                    if (!group.catchTabContainers) {
                        group.catchTabContainers = [];
                    }

                    return group;
                });
            },
        },
        {
            version: '2.4.5',
            migration() {
                data.groups = data.groups.map(function(group) {
                    if (!group.iconColor.trim()) {
                        group.iconColor = 'transparent';
                    }

                    group.iconViewType = 'main-squares';

                    return group;
                });
            },
        },
        {
            version: '3.0',
            remove: ['enableFastGroupSwitching', 'enableFavIconsForNotLoadedTabs', 'createNewGroupAfterAttachTabToNewWindow', 'individualWindowForEachGroup', 'openNewWindowWhenCreateNewGroup', 'showNotificationIfGroupsNotSyncedAtStartup', 'showGroupIconWhenSearchATab', 'showUrlTooltipOnTabHover'],
            async migration() {
                data.groups.forEach(group => group.title = utils.unSafeHtml(group.title));

                let tabs = await browser.tabs.query({
                    url: 'moz-extension://*/stg-newtab/newtab.html*',
                });

                if (tabs.length) {
                    tabs.forEach(tab => delete tab.openerTabId);

                    await Promise.all(tabs.map(tab => Tabs.createNative(utils.normalizeTabUrl(tab))));

                    await utils.wait(100);

                    await Tabs.remove(tabs);

                    await utils.wait(100);
                }
            },
        },
        {
            version: '3.0.9',
            migration() {
                data.hotkeys.forEach(hotkey => hotkey.hasOwnProperty('metaKey') ? null : hotkey.metaKey = false);
                data.groups.forEach(group => delete group.isExpanded);
            },
        },
        {
            version: '3.0.10',
            remove: ['browserActionIconColor'],
            migration() {
                data.hotkeys.forEach(function(hotkey) {
                    if (hotkey.action.groupId) {
                        hotkey.groupId = hotkey.action.groupId;
                    }

                    hotkey.action = hotkey.action.id;
                });
            },
        },
        {
            version: '3.1',
            migration() {
                if (!data.thumbnails) {
                    data.thumbnails = {};
                }

                data.groups.forEach(function(group) {
                    group.muteTabsWhenGroupCloseAndRestoreWhenOpen = false;
                    group.showTabAfterMovingItIntoThisGroup = false;

                    group.tabs.forEach(function(tab) {
                        if (tab.thumbnail && tab.url && !data.thumbnails[tab.url]) {
                            data.thumbnails[tab.url] = tab.thumbnail;
                        }

                        delete tab.thumbnail;
                    });
                });
            },
        },
        {
            version: '3.3.5',
            migration() {
                data.hotkeys.forEach(hotkey => hotkey.groupId = hotkey.groupId || 0);
            },
        },
        {
            version: '3.4.4',
            remove: ['createThumbnailsForTabs'],
            migration() {
                //
            },
        },
        {
            version: '4.0',
            remove: ['useTabsFavIconsFromGoogleS2Converter', 'doRemoveSTGNewTabUrls', 'thumbnails'],
            async migration() {
                data.groups.forEach(function(group) {
                    delete group.windowId;
                    group.dontDiscardTabsAfterHideThisGroup = false;
                });

                let windows = await Windows.load(true, true, true);

                if (!windows.length) {
                    throw browser.i18n.getMessage('notFoundWindowsAddonStoppedWorking');
                }

                let notifId = await utils.notify(['loading']);

                await Promise.all(windows.map(win => Tabs.createTempActiveTab(win.id, false, 'about:blank')));

                data.groups.forEach(function(group) {
                    group.tabs.forEach(function(tab) {
                        if (tab.session) {
                            if (tab.session.favIconUrl) {
                                tab.favIconUrl = tab.session.favIconUrl;
                            }

                            if (tab.session.thumbnail) {
                                tab.thumbnail = tab.session.thumbnail;
                            }
                        }

                        delete tab.session;
                    });
                });

                let allTabs = utils.getTabs(windows);

                if (allTabs.length) {
                    await Tabs.hide(allTabs);
                }

                data.groups = await syncTabs(data.groups, allTabs);

                browser.notifications.clear(notifId);

                await utils.wait(1000);
            },
        },
        {
            version: '4.1',
            remove: [],
            migration() {
                data.groups.forEach(group => group.newTabContainer = null);

                migrations.some(function(prevMigration) {
                    if (prevMigration === this) {
                        return true;
                    }

                    if (Array.isArray(prevMigration.remove)) {
                        this.remove.push(...prevMigration.remove);
                    }
                }, this);
            },
        },
        {
            version: '4.2',
            remove: ['followToLoadedGroupInSideBar'],
            migration() {
                data.openGroupAfterChange = data.followToLoadedGroupInSideBar;
            },
        },
        {
            version: '4.3.5',
            migration() {
                data.groups.forEach(group => group.ifNotDefaultContainerReOpenInNew = true);
            },
        },
        {
            version: '4.4',
            migration() {
                window.localStorage.clear();

                data.groups.forEach(function(group) {
                    group.isArchive = false;

                    group.tabs.forEach(function(tab) {
                        if (tab.session) {
                            if (tab.session.favIconUrl) {
                                tab.favIconUrl = tab.session.favIconUrl;
                            }

                            if (tab.session.thumbnail) {
                                tab.thumbnail = tab.session.thumbnail;
                            }
                        }

                        delete tab.session;
                    });
                });
            },
        },
        {
            version: '4.4.2.5',
            migration() {
                data.openGroupAfterChange = false;
            },
        },
        {
            version: '4.5',
            remove: ['withoutSession'],
            migration() {
                data.groups.forEach(function(group) {
                    group.isMain = false;
                    group.moveToMainIfNotInCatchTabRules = false;

                    group.ifDifferentContainerReOpen = group.ifNotDefaultContainerReOpenInNew;
                    delete group.ifNotDefaultContainerReOpenInNew;
                });

                data.leaveBookmarksOfClosedTabs = false;

                if (data.autoBackupFolderName.toLowerCase() === 'stg-backups') {
                    data.autoBackupFolderName = '';
                }
            },
        },
        {
            version: '4.5.1',
            migration() {
                data.groups.forEach(function(group) {
                    if (!group.newTabContainer) {
                        group.newTabContainer = DEFAULT_COOKIE_STORE_ID;
                        group.ifDifferentContainerReOpen = false;
                    }

                    group.excludeContainersForReOpen = [];
                });
            },
        },
        {
            version: '4.5.2',
            migration() {
                data.groups.forEach(function(group) {
                    data.groups.forEach(function(gr) {
                        if (gr.title === group.title && gr.id !== group.id) {
                            gr.title += ` ${gr.id}`;
                        }
                    });
                });

                data.hotkeys.forEach(function(hotkey) {
                    if (hotkey.action === 'move-active-tab-to-custom-group') {
                        hotkey.action = 'move-selected-tabs-to-custom-group';
                    }
                });
            },
        },
        {
            version: '4.5.5',
            remove: ['reverseTabsOnCreate'],
            migration() {
                //
            },
        },
        {
            version: '4.7.1',
            async migration() {
                let latestExampleGroup = Groups.create(0),
                    latestExampleGroupKeys = Object.keys(latestExampleGroup).filter(key => !['id', 'title', 'tabs'].includes(key));

                data.groups.forEach(function(group) {
                    latestExampleGroupKeys
                        .forEach(key => !group.hasOwnProperty(key) && (group[key] = utils.clone(latestExampleGroup[key])));
                });

                await restoreOldExtensionUrls(function(url, cookieStoreId) {
                    let urlObj = new URL(url),
                        uuid = urlObj.searchParams.get('uuid');

                    if (uuid) {
                        let ext = Management.getExtensionByUUID(uuid);

                        if (ext) {
                            urlObj.searchParams.set('conflictedExtId', ext.id);
                            urlObj.searchParams.set('destCookieStoreId', cookieStoreId);
                            urlObj.searchParams.delete('uuid');
                            url = urlObj.href;
                        }
                    }

                    return url;
                });
            },
        },
        {
            version: '4.7.2',
            remove: ['enableDarkTheme', 'autoBackupBookmarksFolderName'],
            async migration() {
                data.theme = data.enableDarkTheme ? 'dark' : DEFAULT_OPTIONS.theme;
                data.groups.forEach(group => {
                    group.title = String(group.title);
                    group.bookmarkId = null;
                });

                let hasBookmarksPermission = await browser.permissions.contains(PERMISSIONS.BOOKMARKS);

                if (!hasBookmarksPermission) {
                    return;
                }

                let _bookmarkFolderFromTitle = async function(title, parentId) {
                    let bookmarks = await browser.bookmarks.search({title});

                    return bookmarks.find(b => b.type === browser.bookmarks.BookmarkTreeNodeType.FOLDER && b.parentId === parentId);
                };

                let _getBookmarkGroup = async function(title) {
                    let rootFolder = {
                        id: data.defaultBookmarksParent,
                    };

                    if (data.exportGroupToMainBookmarkFolder) {
                        rootFolder = await _bookmarkFolderFromTitle(data.autoBackupBookmarksFolderName, rootFolder.id);

                        if (!rootFolder) {
                            return;
                        }
                    }

                    return _bookmarkFolderFromTitle(title, rootFolder.id);
                };

                for (let group of data.groups) {
                    let bookmark = await _getBookmarkGroup(group.title);

                    if (bookmark) {
                        group.bookmarkId = bookmark.id;
                    }
                }

                let rootFolder = await _bookmarkFolderFromTitle(data.autoBackupBookmarksFolderName, data.defaultBookmarksParent);
                if (rootFolder) {
                    window.localStorage.mainBookmarksFolderId = rootFolder.id;
                }
            },
        },
    ];

    // start migration
    let keysToRemoveFromStorage = [];

    // if data version < required latest migrate version then need migration
    if (-1 === utils.compareVersions(data.version, migrations[migrations.length - 1].version)) {

        for (let migration of migrations) {
            if (-1 === utils.compareVersions(data.version, migration.version)) {
                await migration.migration();

                if (Array.isArray(migration.remove)) {
                    keysToRemoveFromStorage.push(...migration.remove);
                }
            }
        }

    } else if (1 === utils.compareVersions(data.version, currentVersion)) {
        let [currentMajor, currentMinor, currentPatch] = currentVersion.split('.'),
            [dataMajor, dataMinor, dataPatch] = data.version.split('.');

        if (!currentPatch) {
            currentPatch = 0;
        }

        if (!dataPatch) {
            dataPatch = 0;
        }

        if (
            dataMajor > currentMajor ||
            (dataMajor == currentMajor && dataMinor > currentMinor) ||
            (dataMajor == currentMajor && dataMinor == currentMinor && dataPatch > currentPatch)
        ) {
            throw browser.i18n.getMessage('updateAddonToLatestVersion');
        }
    }

    data.version = currentVersion;

    if (keysToRemoveFromStorage.length) {
        keysToRemoveFromStorage.forEach(key => delete data[key]);
        await storage.remove(keysToRemoveFromStorage);
    }
    // end migration

    return true;
}

async function syncTabs(groups, allTabs) {
    console.log('syncTabs');

    for (let group of groups) {
        if (group.isArchive) {
            continue;
        }

        let tabs = [],
            newTabs = [],
            newTabParams = Groups.getNewTabParams(group);

        for (let tab of group.tabs) {
            tab.groupId = group.id;

            tab.cookieStoreId = await Containers.normalize(tab.cookieStoreId);

            let winTabIndex = allTabs.findIndex(winTab => winTab.url === tab.url && winTab.cookieStoreId === tab.cookieStoreId);

            if (winTabIndex !== -1) {
                let [winTab] = allTabs.splice(winTabIndex, 1);

                cache.applySession(winTab, tab);

                tabs.push(cache.setTabSession(winTab));
            } else {
                tabs.push(null);
                newTabs.push({
                    ...tab,
                    openerTabId: null,
                    ...cache.applySession({}, tab),
                    ...newTabParams,
                });
            }
        }

        if (newTabs.length) {
            newTabs = await createTabsSafe(newTabs, true);

            tabs = tabs.map(tab => tab ? tab : newTabs.shift());
        }

        group.tabs = await Promise.all(tabs);
    }

    // sort tabs
    for (let group of groups) {
        if (group.isArchive) {
            continue;
        }

        if (group.tabs.length) {
            group.tabs = await Tabs.moveNative(group.tabs, {
                index: -1,
                windowId: cache.getWindowId(group.id) || group.tabs[0].windowId,
            });
        }
    }

    return groups;
}

let restoringMissedTabsPromise = null; // need when remove window
async function tryRestoreMissedTabs() {
    if (restoringMissedTabsPromise) {
        await restoringMissedTabsPromise.catch(noop);
        restoringMissedTabsPromise = null;
    }

    let [
        {tabsToRestore: tabsToRestoreNotModified},
        windows,
    ] = await Promise.all([
        storage.get({tabsToRestore: []}),
        Windows.load(),
    ]);

    if (!tabsToRestoreNotModified.length || !windows.length) {
        return;
    }

    let tabsToRestore = utils.clone(tabsToRestoreNotModified);

    console.log('tryRestoreMissedTabs', tabsToRestore);

    await Promise.all(windows.map(win => loadingBrowserAction(true, win.id)));

    let [allTabs, {groups}] = await Promise.all([Tabs.get(null, false, null), Groups.load()]),
        groupNewTabParams = groups
            .filter(g => !g.isArchive)
            .reduce((acc, group) => (acc[group.id] = Groups.getNewTabParams(group), acc), {}),
        foundTab = new Set;

    // normalize tab urls
    allTabs.forEach(tab => {
        if (utils.isTabLoading(tab) && utils.isUrlEmpty(tab.url)) {
            tab.url = utils.normalizeUrl(cache.getTabSession(tab.id, 'url'));
        }
    });

    // strict find exist tabs
    tabsToRestore = tabsToRestore
        .map(function(tab) {
            if (!groupNewTabParams[tab.groupId]) {
                return;
            }

            tab = utils.normalizeTabUrl(tab);

            let winTab = allTabs.find(
                t => !foundTab.has(t) && t.groupId === tab.groupId && t.url === tab.url && t.cookieStoreId === tab.cookieStoreId
            );

            if (winTab) {
                foundTab.add(winTab);
            } else {
                return Object.assign(tab, groupNewTabParams[tab.groupId]);
            }
        })
        .filter(Boolean);

    try {
        await createTabsSafe(tabsToRestore, true);
    } catch (e) {
        setActionToReloadAddon();
        return;
    }

    let {tabsToRestore: tabsInDB} = await storage.get({tabsToRestore: []});
    tabsInDB = tabsInDB.filter(t => {
        return !tabsToRestoreNotModified.some(tab => t.groupId === tab.groupId && t.url === tab.url && t.cookieStoreId === tab.cookieStoreId);
    });
    if (tabsInDB.length) {
        await storage.set({tabsToRestore: tabsInDB});
    } else {
        await storage.remove('tabsToRestore');
    }

    if (tabsToRestore.length) {
        sendMessage({
            action: 'groups-updated',
        });
    }

    await Promise.all(windows.map(win => loadingBrowserAction(false, win.id)));

    console.log('tryRestoreMissedTabs finish');
}

function normalizeContainersInGroups(groups) {
    let allContainers = Containers.getAll(true),
        hasChanges = false;

    groups.forEach(function(group) {
        let oldNewTabContainer = group.newTabContainer,
            oldCatchTabContainersLength = group.catchTabContainers.length,
            oldExcludeContainersForReOpenLength = group.excludeContainersForReOpen.length;

        group.newTabContainer = Containers.get(group.newTabContainer, 'cookieStoreId', true);
        group.catchTabContainers = group.catchTabContainers.filter(cookieStoreId => allContainers[cookieStoreId]);
        group.excludeContainersForReOpen = group.excludeContainersForReOpen.filter(cookieStoreId => allContainers[cookieStoreId]);

        if (
            oldNewTabContainer !== group.newTabContainer ||
            oldCatchTabContainersLength !== group.catchTabContainers.length ||
            oldExcludeContainersForReOpenLength !== group.excludeContainersForReOpen.length
        ) {
            hasChanges = true;

            sendMessage({
                action: 'group-updated',
                group: {
                    id: group.id,
                    newTabContainer: group.newTabContainer,
                    catchTabContainers: group.catchTabContainers,
                    excludeContainersForReOpen: group.excludeContainersForReOpen,
                },
            });
        }
    });

    return hasChanges;
}

async function restoreOldExtensionUrls(parseUrlFunc) {
    let tabs = await browser.tabs.query({
        url: 'moz-extension://*/help/open-in-container.html*',
    });

    await Promise.all(tabs
        .map(async function({id, url, cookieStoreId}) {
            let oldUrl = url;

            if (parseUrlFunc) {
                url = parseUrlFunc(url, cookieStoreId);
            }

            if (!url.startsWith(addonUrlPrefix) || oldUrl !== url) {
                await browser.tabs.update(id, {
                    url: addonUrlPrefix + url.slice(addonUrlPrefix.length),
                    loadReplace: true,
                }).catch(noop);
            }
        })
    );
}

// { reason: "update", previousVersion: "3.0.1", temporary: true }
// { reason: "install", temporary: true }
browser.runtime.onInstalled.addListener(function onInstalled({previousVersion, reason, temporary}) {
    browser.runtime.onInstalled.removeListener(onInstalled);

    if (!window.BG.inited) {
        setTimeout(onInstalled, 300, {previousVersion, reason, temporary});
        return;
    }

    if (temporary) {
        window.IS_TEMPORARY = true;
        console.restart();
        return;
    }

    if (browser.runtime.OnInstalledReason.INSTALL === reason ||
        (browser.runtime.OnInstalledReason.UPDATE === reason && -1 === utils.compareVersions(previousVersion, '4.0'))) {
        openPopup('welcome-v4', false);
    }
});

async function initializeGroupWindows(windows, currentGroupIds) {
    let tabsToShow = [],
        tabsToHide = [],
        moveTabsToWin = {};

    windows.forEach(function(win) {
        let otherWindows = windows.filter(w => w.id !== win.id),
            duplicateGroupWindows = otherWindows.filter(w => w.groupId && w.groupId === win.groupId);

        if (win.groupId && (!currentGroupIds.includes(win.groupId) || duplicateGroupWindows.length)) {
            duplicateGroupWindows.push(win);

            duplicateGroupWindows.forEach(function(w) {
                delete w.groupId;
                cache.removeWindowSession(w.id);
            });
        }

        win.tabs.forEach(function(tab) {
            if (tab.groupId && !currentGroupIds.includes(tab.groupId)) {
                delete tab.groupId;
                cache.removeTabGroup(tab.id);
            }

            if (tab.groupId) {
                // TODO create bug in bugzilla: if set tab session, disable addon, move tab to other window, enable addon - session will empty
                let tabWin = otherWindows.find(w => w.groupId === tab.groupId);

                if (tabWin) {
                    if (moveTabsToWin[tabWin.id]) {
                        moveTabsToWin[tabWin.id].push(tab);
                    } else {
                        moveTabsToWin[tabWin.id] = [tab];
                    }

                    if (tab.hidden) {
                        tabsToShow.push(tab);
                    }
                } else {
                    if (win.groupId === tab.groupId) {
                        if (tab.hidden) {
                            tabsToShow.push(tab);
                        }
                    } else {
                        if (!tab.hidden) {
                            tabsToHide.push(tab);
                        }
                    }
                }
            } else if (win.groupId) {
                if (!tab.hidden) {
                    if (utils.isTabLoading(tab) || tab.url.startsWith('file:') || tab.lastAccessed > START_TIME) {
                        tab.groupId = win.groupId;
                        cache.setTabGroup(tab.id, win.groupId);
                    } else {
                        tabsToHide.push(tab);
                    }
                }
            } else {
                if (tab.hidden) {
                    tabsToShow.push(tab);
                }
            }
        });
    });

    for (let windowId in moveTabsToWin) {
        windowId = Number(windowId);

        await Tabs.moveNative(moveTabsToWin[windowId], {
            index: -1,
            windowId: windowId,
        });

        console.log('[initializeGroupWindows] moveTabsToWin length', moveTabsToWin[windowId].length);
    }

    if (tabsToShow.length) {
        await Tabs.show(tabsToShow);

        tabsToShow.forEach(tab => tab.hidden = false);

        console.log('[initializeGroupWindows] tabsToShow length', tabsToShow.length);
    }

    if (tabsToHide.length) {
        let activeTabsToHide = tabsToHide.filter(tab => tab.active);

        for (let tabToHide of activeTabsToHide) {
            let visibleTabs = windows.reduce(function(acc, win) {
                acc.push(...win.tabs.filter(tab => tabToHide.windowId === tab.windowId && !tab.hidden && !tabsToHide.includes(tab)));

                return acc;
            }, []);

            if (visibleTabs.length) {
                await Tabs.setActive(null, visibleTabs);
            } else {
                await Tabs.createTempActiveTab(tabToHide.windowId, false);
            }
        }

        await Tabs.hide(tabsToHide);

        console.log('[initializeGroupWindows] tabsToHide length', tabsToHide.length);
    }
}

async function init() {
    console.log('[STG] START init');

    try {
        let data = await storage.get(),
            dataChanged = new Set;

        if (!Array.isArray(data.groups)) {
            utils.notify(['ffFailedAndLostDataMessage']);

            data.groups = [];
            dataChanged.add(true);
        }

        await Containers.init(data.temporaryContainerTitle);

        console.log('[STG] containers inited');

        await Management.init();

        console.log('[STG] Management inited');

        await Management.detectConflictedExtensions();

        try {
            let change = await runMigrateForData(data);
            dataChanged.add(change); // run migration for data
            change && console.log('[STG] runMigrateForData finish');
        } catch (e) {
            utils.notify(e);
            throw '';
        }

        utils.assignKeys(options, data, ALL_OPTIONS_KEYS);

        dataChanged.add(normalizeContainersInGroups(data.groups));

        if (dataChanged.has(true)) {
            await storage.set(data);
        }

        let windows = await Windows.load();

        if (!windows.length) {
            window.localStorage.notFoundWindowsAddonStoppedWorking = 1;
            utils.notify(['notFoundWindowsAddonStoppedWorking']);
            browser.windows.onCreated.addListener(() => browser.runtime.reload());
            throw '';
        } else if (window.localStorage.notFoundWindowsAddonStoppedWorking) {
            try {
                await Promise.all(windows.map(async win => {
                    grandRestoringPromise = GrandRestoreWindows(win);
                    await grandRestoringPromise;
                }));
            } catch (e) {
                browser.runtime.reload();
                return;
            }

            delete window.localStorage.notFoundWindowsAddonStoppedWorking;
        }

        await tryRestoreMissedTabs();

        windows = await Windows.load(true);

        await initializeGroupWindows(windows, data.groups.map(utils.keyId));

        windows.forEach(function(win) {
            updateBrowserActionData(null, win.id, data.groups)
                .then(function() {
                    if (win.groupId) {
                        groupsHistory.add(win.groupId);
                    }
                })
                .catch(noop);
        });

        let tabs = utils.getTabs(windows);

        Containers.removeUnusedTemporaryContainers(tabs);

        console.log('[STG] Containers.removeUnusedTemporaryContainers finish');

        await restoreOldExtensionUrls();

        console.log('[STG] restoreOldExtensionUrls finish');

        window.setTimeout(resetAutoBackup, 10000);

        createMoveTabMenus(data.groups);

        console.log('[STG] createMoveTabMenus finish');

        addEvents();

        if (Groups.isNeedBlockBeforeRequest(data.groups)) {
            addListenerOnBeforeRequest();
        }

        Groups.load(null, true, true); // load favIconUrls, speed up first run popup

        if (window.localStorage.isBackupRestoring) {
            delete window.localStorage.isBackupRestoring;
            utils.notify(['backupSuccessfullyRestored']);
        }

        await setBrowserAction(undefined, undefined, undefined, true);

        await browser.browserAction.setBadgeBackgroundColor({
            color: 'transparent',
        });

        window.BG.inited = true;

        // send message for addon pages if it's open
        sendMessage({
            action: 'i-am-back',
        });

        // send message for addon plugins
        sendExternalMessage({
            action: 'i-am-back',
        });

        console.log('[STG] STOP init');
    } catch (e) {
        setActionToReloadAddon();

        if (e) {
            errorEventHandler(e);
        }

        console.log('[STG] STOP init with errors');
    }
}

function setActionToReloadAddon() {
    setBrowserAction(undefined, 'lang:clickHereToReloadAddon', '/icons/exclamation-triangle-yellow.svg', true).catch(noop);

    browser.browserAction.setPopup({
        popup: '',
    });

    browser.browserAction.onClicked.addListener(() => browser.runtime.reload());
}

setBrowserAction(undefined, 'loading', undefined, false);

// delay startup to avoid errors with extensions "Facebook Container", "Firefox Multi-Account Containers" etc.
// TransactionInactiveError: A request was placed against a transaction which is currently not active, or which is finished.
// An unexpected error occurred
// etc.

setTimeout(init, 200);
