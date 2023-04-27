import './js/cache-storage.js';
import * as Constants from './js/constants.js';
import * as Messages from './js/messages.js';
import Logger, { catchFunc, addLog, showLog, getLogs, clearLogs, getErrors, clearErrors } from './js/logger.js';
import * as Utils from './js/utils.js';
import JSON from './js/json.js';
import * as Urls from './js/urls.js';
import * as Containers from './js/containers.js';
import * as Storage from './js/storage.js';
import * as Cache from './js/cache.js';
import * as File from './js/file.js';
import * as Menus from './js/menus.js';
import * as Groups from './js/groups.js';
import * as Tabs from './js/tabs.js';
import * as Windows from './js/windows.js';
import * as Management from './js/management.js';
import * as Hotkeys from './js/hotkeys.js';

self.IS_TEMPORARY = false;

if (self.localStorage.enableDebug == 2) { // if debug was auto-enabled - disable on next start addon/browser
    delete self.localStorage.enableDebug;
}

self.logger = new Logger('BG');

self.loggerFuncs = {
    getLogs,
    clearLogs,
    getErrors,
    clearErrors,
};

self.sendMessage = Messages.initBackground(onBackgroundMessage);

self.inited = false;

self.options = {};

let reCreateTabsOnRemoveWindow = [],
    menuIds = [],
    excludeTabIds = new Set,
    ignoreExtForReopenContainer = new Set,

    groupsHistory = (function () {
        let index = -1,
            groupIds = [];

        function normalize(groups) {
            groupIds = groupIds.filter((groupId, groupIndex) => {
                const found = groups.some(group => group.id === groupId);

                if (!found) {
                    if (groupIndex < index) {
                        index--;
                    }
                }

                return found;
            });

            if (index > groupIds.length - 1) {
                index = groupIds.length - 1;
            }
        }

        return {
            next(groups) {
                normalize(groups);

                if (groupIds[index + 1]) {
                    return groupIds[++index];
                }
            },
            prev(groups) {
                normalize(groups);

                if (groupIds[index - 1]) {
                    return groupIds[--index];
                }
            },
            add(groupId) {
                const nextIndex = index + 1;
                groupIds.splice(nextIndex, groupIds.length - index, groupId);
                index = nextIndex;
            },
        };
    })();

async function createTabsSafe(tabs, tryRestoreOpeners, hideTabs = true) {
    const log = logger.start('createTabsSafe', { tryRestoreOpeners, hideTabs }, tabs.map(tab => Utils.extractKeys(tab, [
        'id',
        'cookieStoreId',
        'openerTabId',
        'groupId',
        // 'favIconUrl',
        // 'thumbnail',
    ])));

    if (!tabs.length) {
        log.stop('no tabs');
        return [];
    }

    const groupIds = tabs.map(tab => tab.groupId).filter(Utils.onlyUniqueFilter),
        groupIdForNextTab = (groupIds.length === 1 && groupIds[0]) ? groupIds[0] : null;

    if (groupIdForNextTab) {
        self.groupIdForNextTab = groupIdForNextTab;
    }

    let isEnabledTreeTabsExt = Constants.TREE_TABS_EXTENSIONS.some(id => Management.isEnabled(id)),
        oldNewTabIds = {},
        newTabs = [];

    tabs.forEach(function (tab) {
        delete tab.active;
        delete tab.index;
        delete tab.windowId;
    });

    self.skipCreateTab = true;

    if (tryRestoreOpeners && isEnabledTreeTabsExt && tabs.some(tab => tab.openerTabId)) {
        log.log('tryRestoreOpeners');
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
        log.log('creating tabs');
        tabs.forEach(tab => delete tab.openerTabId);
        newTabs = await Promise.all(tabs.map(Tabs.createNative));
    }

    self.skipCreateTab = false;

    self.groupIdForNextTab = null;

    newTabs = await Promise.all(newTabs.map(Cache.setTabSession));

    newTabs = await Tabs.moveNative(newTabs, {
        index: -1,
    });

    if (hideTabs) {
        const tabsToHide = newTabs.filter(tab => !tab.pinned && tab.groupId && !Cache.getWindowId(tab.groupId));

        log.log('hide tabs', tabsToHide);

        await Tabs.safeHide(tabsToHide);
    }

    log.stop();

    return newTabs;
}

function sendExternalMessage(...args) {
    if (!self.inited) {
        logger.warn('sendExternalMessage addon not yet loaded');
        return;
    }

    const message = Messages.normalizeSendData(...args);

    Object.keys(Constants.EXTENSIONS_WHITE_LIST).forEach(exId => {
        if (
            Constants.EXTENSIONS_WHITE_LIST[exId].postActions.includes(message.action) &&
            Management.isEnabled(exId)
        ) {
            Messages.sendExternalMessage(exId, message);
        }
    });
}

let _loadingGroupInWindow = new Set; // windowId: true;
async function applyGroup(windowId, groupId, activeTabId, applyFromHistory = false) {
    const log = logger.start('applyGroup', 'groupId:', groupId, 'windowId:', windowId, 'activeTabId:', activeTabId);

    windowId = windowId || await Windows.getLastFocusedNormalWindow();

    if (_loadingGroupInWindow.has(windowId)) {
        log.stopError('window in loading state now', windowId);
        return false;
    }

    if (groupId && (!Number.isSafeInteger(groupId) || groupId < 1)) {
        log.throwError(['Invalid group id:', groupId]);
    }

    if (activeTabId && (!Number.isSafeInteger(activeTabId) || activeTabId < 1)) {
        activeTabId = null;
    }

    _loadingGroupInWindow.add(windowId);

    const groupWindowId = Cache.getWindowId(groupId);

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

            const { group: groupToShow, groups } = await Groups.load(groupId, true),
                oldGroupId = Cache.getWindowGroup(windowId),
                groupToHide = groups.find(gr => gr.id === oldGroupId),
                tabsIdsToRemove = new Set;

            if (!groupToShow) {
                log.throwError('groupToShow not found');
            }

            if (groupToShow.isArchive) {
                Utils.notify(['groupIsArchived', groupToShow.title]);
                throw '';
            }

            if (groupToHide?.tabs.some(Utils.isTabCanNotBeHidden)) {
                Utils.notify(['notPossibleSwitchGroupBecauseSomeTabShareMicrophoneOrCamera']);
                throw '';
            }

            await loadingBrowserAction(true, windowId).catch(log.onCatch('loadingBrowserAction'));

            // show tabs
            if (groupToShow.tabs.length) {
                let tabIds = groupToShow.tabs.map(Tabs.extractId);

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
                    Tabs.setMute(groupToShow.tabs, false).catch(log.onCatch('Tabs.setMute', false));
                }
            }

            // link group with window
            await Cache.setWindowGroup(windowId, groupToShow.id);

            // hide tabs
            await hideTabs(groupToHide?.tabs);

            let activeTabGroupToHide = groupToHide?.tabs.find(tab => tab.active);

            async function hideTabs(tabs = []) {
                await Tabs.safeHide(tabs);

                if (groupToHide) {
                    if (groupToHide.muteTabsWhenGroupCloseAndRestoreWhenOpen) {
                        Tabs.setMute(tabs, true).catch(log.onCatch('Tabs.setMute', false));
                    }

                    if (groupToHide.discardTabsAfterHide) {
                        if (groupToHide.discardExcludeAudioTabs) {
                            tabs = tabs.filter(tab => !tab.audible);
                        }

                        Tabs.discard(tabs).catch(log.onCatch('Tabs.discard', false));
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
                    Utils.notify(['tabsInThisWindowWereHidden'], undefined, 'tabsInThisWindowWereHidden');
                }
            }

            // set active tab
            if (activeTabId) {
                await Tabs.setActive(activeTabId);

                if (!groupToHide) {
                    let tabs = await Tabs.get(windowId);

                    tabs = tabs.filter(tab => !tab.groupId);

                    if (tabs.length === 1 && Utils.isUrlEmpty(tabs[0].url)) {
                        tabsIdsToRemove.add(tabs[0].id);
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
                        if (tabs.length === 1 && Utils.isUrlEmpty(tabs[0].url)) {
                            tabsIdsToRemove.add(tabs[0].id);
                        } else {
                            await hideUnSyncTabs(tabs);
                        }
                    } else {
                        if (tabs.length === 1 && Utils.isUrlEmpty(tabs[0].url)) {
                            await Cache.setTabGroup(tabs[0].id, groupToShow.id);
                            addTabs.push(Cache.applyTabSession(tabs[0]));
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

                groupToHide.tabs.forEach(tab => tab.url === Urls.MANAGE_TABS_URL && tabsIdsToRemove.add(tab.id));
            }

            await Tabs.remove(Array.from(tabsIdsToRemove));

            await updateMoveTabMenus();

            await updateBrowserActionData(groupToShow.id);

            if (!applyFromHistory) {
                groupsHistory.add(groupId);
            }
        }

        sendMessage('group-loaded', {
            groupId,
            windowId,
            addTabs,
        });

        sendExternalMessage('group-loaded', {
            groupId,
            windowId,
        });

        result = true;
    } catch (e) {
        result = false;

        if (e) {
            errorEventHandler.call(log, e);

            await updateBrowserActionData(null, windowId);

            if (!groupWindowId) {
                excludeTabIds.clear();
            }
        }
    }

    _loadingGroupInWindow.delete(windowId);

    result ? log.stop() : log.stopError();

    return result;
}

async function applyGroupByPosition(textPosition, groups, currentGroupId) {
    if (1 >= groups.length || !currentGroupId) {
        return false;
    }

    let currentGroupIndex = groups.findIndex(group => group.id === currentGroupId);

    if (-1 === currentGroupIndex) {
        currentGroupIndex = 'next' === textPosition ? (groups.length - 1) : 0;
    }

    let nextGroupIndex = Utils.getNextIndex(currentGroupIndex, groups.length, textPosition);

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
    logger.log('onActivated', activeInfo)
}

const onCreatedTab = catchFunc(async function(tab) {
    const log = logger.start('onCreatedTab', tab);

    Cache.setTab(tab);

    if (self.skipCreateTab) {
        return log.stop('skip tab', tab.id);
    }

    if (Utils.isTabPinned(tab)) {
        return log.stop('skip pinned tab', tab.id);
    }

    const groupId = Cache.getWindowGroup(tab.windowId);

    if (groupId) {
        Cache.setTabGroup(tab.id, groupId).catch(log.onCatch(['cant set group', groupId, 'to tab', tab.id], false));
    }

    log.stop();
});

function addExcludeTabIds(tabIds) {
    tabIds.forEach(excludeTabIds.add, excludeTabIds);
}

function removeExcludeTabIds(tabIds) {
    tabIds.forEach(excludeTabIds.delete, excludeTabIds);
}

const onUpdatedTab = catchFunc(async function(tabId, changeInfo, tab) {
    if (excludeTabIds.has(tab.id)) {
        Cache.setTab(tab);
        logger.log('onUpdatedTab 🛑 tab was excluded', tab.id);
        return;
    }

    changeInfo = Cache.getRealTabStateChanged(tab);

    Cache.setTab(tab);

    if (!changeInfo) {
        logger.log('onUpdatedTab 🛑 changeInfo keys was not changed', tab.id);
        return;
    }

    if (Utils.isTabPinned(tab) && !changeInfo.hasOwnProperty('pinned')) {
        logger.log('onUpdatedTab 🛑 tab is pinned', tab.id);
        return;
    }

    const log = logger.start('onUpdatedTab', tabId, { changeInfo });

    const tabGroupId = Cache.getTabGroup(tab.id),
        winGroupId = Cache.getWindowGroup(tab.windowId);

    if (changeInfo.favIconUrl/*  && (tabGroupId || winGroupId) */) {
        await Cache.setTabFavIcon(tab.id, changeInfo.favIconUrl).catch(log.onCatch(['cant set favIcon', tab, changeInfo], false));
    }

    if (changeInfo.hasOwnProperty('pinned') || changeInfo.hasOwnProperty('hidden')) {
        if (changeInfo.pinned || changeInfo.hidden) {
            changeInfo.pinned && log.log('remove group', tabGroupId, 'for pinned tab', tab.id);
            changeInfo.hidden && log.log('remove group', tabGroupId, 'for hidden tab', tab.id);
            Cache.removeTabGroup(tab.id)
                .catch(log.onCatch(['[0] cant remove group from tab', tab.id], false));
        } else {

            if (false === changeInfo.pinned) {
                if (winGroupId) {
                    log.log('set group', winGroupId, ' for unhidden tab', tab.id);
                    Cache.setTabGroup(tab.id, winGroupId)
                        .catch(log.onCatch(['[1] cant set group', winGroupId, 'to tab', tab.id], false));
                } else {
                    log.log('remove group', tabGroupId, 'for unhidden tab', tab.id);
                    Cache.removeTabGroup(tab.id)
                        .catch(log.onCatch(['[1] cant remove group from tab', tab.id], false));
                }
            } else if (false === changeInfo.hidden) {
                log.log('tab is showing', tab.id);

                if (tabGroupId) {
                    if (winGroupId) {
                        const { group: winGroup } = await Groups.load(winGroupId, true);

                        if (winGroup.tabs.length) {
                            log.stop('applyGroup for tab', tab.id);
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

                    await Tabs.safeHide(tab);
                } else {
                    if (winGroupId) {
                        log.log('set group', winGroupId, ' for unhidden tab', tab.id);
                        Cache.setTabGroup(tab.id, winGroupId)
                            .catch(log.onCatch(['[2] cant set group', winGroupId, 'to tab', tab.id], false));
                    } else {
                        log.log('remove group', tabGroupId, 'for unhidden tab', tab.id);
                        Cache.removeTabGroup(tab.id)
                            .catch(log.onCatch(['[2] cant remove group from tab', tab.id], false));
                    }
                }
            }
        }

        return log.stop();
    }

    if (Utils.isTabLoaded(changeInfo)/*  && (tabGroupId || winGroupId) */) {
        await Tabs.updateThumbnail(tab.id);
    }

    log.stop();
});

function onRemovedTab(tabId, { isWindowClosing, windowId }) {
    const log = logger.start('onRemovedTab', tabId, { isWindowClosing, windowId });

    if (isWindowClosing) {
        reCreateTabsOnRemoveWindow.push(tabId);
        log.stop('add to reCreateTabsOnRemoveWindow');
    } else {
        Cache.removeTab(tabId);
        log.stop('tab removed from Cache');
    }
}

let openerTabTimer = 0;
function onMovedTab(tabId) {
    /* if (excludeTabIds.has(tabId)) {
        console.log('🛑 onMovedTab', tabId);
        return;
    }

    if (Cache.getTabGroup(tabId)) {
        clearTimeout(openerTabTimer);
        openerTabTimer = setTimeout(() => Tabs.get().catch(() => {}), 500); // load visible tabs of current window for set openerTabId
    } */
}

function onAttachedTab(tabId, { newWindowId }) {
    if (excludeTabIds.has(tabId)) {
        logger.log('🛑 onAttachedTab', { tabId, newWindowId });
        return;
    }

    const newTabGroupId = Cache.getWindowGroup(newWindowId);

    if (newTabGroupId) {
        logger.log('onAttachedTab', { tabId, newWindowId, newTabGroupId });

        Cache.setTabGroup(tabId, Cache.getWindowGroup(newWindowId));
    } else {
        logger.log('onAttachedTab remove tab group', { tabId, newWindowId, newTabGroupId });

        Cache.removeTabGroup(tabId);
    }
}

let windowIdsForRestoring = new Set,
    grandRestoringPromise = null;
async function GrandRestoreWindows({ id }, needRestoreMissedTabsMap) {
    windowIdsForRestoring.add(id);

    needRestoreMissedTabsMap?.set(id, windowIdsForRestoring.size === 1);

    if (grandRestoringPromise) {
        await grandRestoringPromise;
        return;
    }

    let [
        windows,
        { groups },
        { tabsToRestore = [] }
    ] = await Promise.all([
        Windows.load(true),
        Groups.load(),
        Storage.get('tabsToRestore')
    ]);

    await Promise.all(windows.map(win => loadingBrowserAction(true, win.id)));

    let tabsToRestoreChanged = false;
    function deleteTabsToRestoreByGroup({ id }) {
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

                const group = JSON.clone(gr);

                group.tabs = win.tabs.filter(tab => tab.groupId === group.id);

                if (!group.tabs.length) {
                    return;
                }

                group.tabs.forEach(tab => {
                    if (tab.active && Utils.isUrlEmpty(tab.url)) {
                        tab.url = Utils.normalizeUrl(Cache.getTabSession(tab.id, 'url'));
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

            const lastAccessGroup = new Map;

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
            const minGroupLastAccessed = Math.min(...lastAccessGroup.keys());

            groupToKeep = lastAccessGroup.get(minGroupLastAccessed);

            lastAccessGroup.delete(minGroupLastAccessed);
            const otherGroups = lastAccessGroup;

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
                let allOtherTabs = Utils.concatTabs(Array.from(otherGroups.values()));

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
            await Cache.removeWindowSession(tabToDelete.windowId);
            await Tabs.createTempActiveTab(tabToDelete.windowId, false);
        }
    }));

    // перемещаем недостающие вкладки из других окон
    let excludeTabIds = [];
    for (let groupToKeep of groupsAlreadyRestored.values()) {
        if (!groupToKeep.tabs.some(tab => tab.windowId !== groupToKeep.window.id)) {
            continue;
        }

        let tabIds = groupToKeep.tabs.map(Tabs.extractId);

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
    }
    removeExcludeTabIds(excludeTabIds);

    await Tabs.remove(Array.from(tabsToDelete.keys()));

    if (tabsToRestoreChanged) {
        if (tabsToRestore.length) {
            await Storage.set({ tabsToRestore });
        } else {
            needRestoreMissedTabsMap?.clear();
            await Storage.remove('tabsToRestore');
        }
    }

    await Promise.all(windows.map(win => loadingBrowserAction(false, win.id)));

    windowIdsForRestoring.clear();
}

const onCreatedWindow = catchFunc(async function (win) {
    const log = logger.start(['info', 'onCreatedWindow'], win.id, 'skip created:', self.skipAddGroupToNextNewWindow);

    if (self.skipAddGroupToNextNewWindow) {
        self.skipAddGroupToNextNewWindow = false;
        log.stop();
        return;
    }

    if (!Utils.isWindowAllow(win)) {
        log.stop('window is not allow');
        return;
    }

    await loadingBrowserAction(true, win.id);

    log.log('start grand restore for', win.id);

    // для того чтоб один раз вызвалось tryRestoreMissedTabs
    let needRestoreMissedTabsMap = new Map;

    grandRestoringPromise = GrandRestoreWindows(win, needRestoreMissedTabsMap);
    try {
        await grandRestoringPromise;
        grandRestoringPromise = null;
    } catch (e) {
        grandRestoringPromise = null;
        log.runError('GrandRestoreWindows', e);
        log.stopError();
        return;
    }

    log.log('grand restore for', win.id, 'finish');

    await Cache.loadWindowSession(win);

    if (!win.groupId && options.createNewGroupWhenOpenNewWindow) {
        log.log('add group to window', win.id);
        await Groups.add(win.id);
    }

    await loadingBrowserAction(false, win.id);

    if (needRestoreMissedTabsMap.get(win.id)) {
        log.log('run tryRestoreMissedTabs');
        await tryRestoreMissedTabs().catch(log.onCatch('tryRestoreMissedTabs'));
    }

    log.stop();
});

function onFocusChangedWindow(windowId) {
    !self.IS_TEMPORARY && logger.log('onFocusChangedWindow', windowId);

    if (browser.windows.WINDOW_ID_NONE !== windowId && options.showContextMenuOnTabs) {
        Menus.update('set-tab-icon-as-group-icon', {
            enabled: Boolean(Cache.getWindowGroup(windowId)),
        });
    }
}

const onRemovedWindow = catchFunc(async function (windowId) {
    const log = logger.start(['info', 'onRemovedWindow'], windowId);

    let groupId = Cache.getWindowGroup(windowId);

    if (groupId) {
        sendMessage('window-closed', { windowId });
    }

    Cache.removeWindow(windowId);

    let tabsToRestore = Cache.getTabsSessionAndRemove(reCreateTabsOnRemoveWindow);

    reCreateTabsOnRemoveWindow = [];

    if (tabsToRestore.length) {
        log.info('start merge tabs');
        let { tabsToRestore: prevRestore } = await Storage.get({ tabsToRestore: [] });
        tabsToRestore = tabsToRestore.filter(tab => !prevRestore.some(t => t.groupId === tab.groupId && t.url === tab.url && t.cookieStoreId === tab.cookieStoreId));
        await Storage.set({
            tabsToRestore: [...prevRestore, ...tabsToRestore]
        });

        log.info('stop merge tabs > start restoring tabs');

        restoringMissedTabsPromise = tryRestoreMissedTabs();
        await restoringMissedTabsPromise.catch(log.onCatch('tryRestoreMissedTabs'));
        restoringMissedTabsPromise = null;
        log.info('stop restoring tabs');
    }

    log.stop();
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
    const restoreGroup = async function (group) {
        Menus.remove(Constants.CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP + group.id);
        browser.notifications.clear(Constants.CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP + group.id);

        const { groups } = await Groups.load();

        groups.push(group);

        Groups.normalizeContainersInGroups(groups);

        const tabs = group.tabs;

        await Groups.save(groups);

        await updateMoveTabMenus();

        if (tabs.length && !group.isArchive) {
            await loadingBrowserAction();

            group.tabs = await createTabsSafe(Groups.setNewTabsParams(tabs, group), true);

            await loadingBrowserAction(false);
        }

        sendMessage('group-added', { group });

    }.bind(null, JSON.clone(groupToRemove));

    await Menus.create({
        id: Constants.CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP + groupToRemove.id,
        title: browser.i18n.getMessage('undoRemoveGroupItemTitle', groupToRemove.title),
        contexts: [Menus.ContextType.ACTION],
        icons: Groups.getIconUrl(groupToRemove, 16),
        onClick: restoreGroup,
    });

    if (options.showNotificationAfterGroupDelete) {
        Utils.notify(
            ['undoRemoveGroupNotification', groupToRemove.title],
            7,
            Constants.CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP + groupToRemove.id,
            undefined,
            restoreGroup
        );
    }
}

async function updateMoveTabMenus() {
    await removeMoveTabMenus();
    await createMoveTabMenus();
}

async function removeMoveTabMenus() {
    if (menuIds.length) {
        await Promise.all(menuIds.map(Menus.remove));
        menuIds = [];
    }
}

async function createMoveTabMenus() {
    let hasBookmarksPermission = await browser.permissions.contains(Constants.PERMISSIONS.BOOKMARKS);

    if (!options.showContextMenuOnTabs && !options.showContextMenuOnLinks && !hasBookmarksPermission) {
        return;
    }

    const log = logger.start('createMoveTabMenus')

    await removeMoveTabMenus();

    const { groups } = await Groups.load(),
        temporaryContainer = Containers.get(Constants.TEMPORARY_CONTAINER);

    hasBookmarksPermission && menuIds.push(await Menus.create({
        id: 'stg-open-bookmark-parent',
        title: browser.i18n.getMessage('openBookmarkInGroup'),
        contexts: [Menus.ContextType.BOOKMARK],
    }));

    options.showContextMenuOnTabs && menuIds.push(await Menus.create({
        id: 'stg-move-tab-parent',
        title: browser.i18n.getMessage('moveTabToGroupDisabledTitle'),
        contexts: [Menus.ContextType.TAB],
    }));

    options.showContextMenuOnLinks && menuIds.push(await Menus.create({
        id: 'stg-open-link-parent',
        title: browser.i18n.getMessage('openLinkInGroupDisabledTitle'),
        contexts: [Menus.ContextType.LINK],
    }));

    options.showContextMenuOnTabs && menuIds.push(await Menus.create({
        title: temporaryContainer.name,
        icon: temporaryContainer.iconUrl,
        parentId: 'stg-move-tab-parent',
        contexts: [Menus.ContextType.TAB],
        async onClick(info, tab) {
            if (!Utils.isUrlAllowToCreate(tab.url)) {
                Utils.notify(['thisUrlsAreNotSupported', tab.url], 7, 'thisUrlsAreNotSupported');
                return;
            }

            await Tabs.createNative({
                ...tab,
                active: info.button.RIGHT,
                cookieStoreId: Constants.TEMPORARY_CONTAINER,
            });
        },
    }));

    options.showContextMenuOnTabs && menuIds.push(await Menus.create({
        id: 'set-tab-icon-as-group-icon',
        title: browser.i18n.getMessage('setTabIconAsGroupIcon'),
        icon: '/icons/image.svg',
        parentId: 'stg-move-tab-parent',
        contexts: [Menus.ContextType.TAB],
        async onClick(info, tab) {
            const groupId = Cache.getWindowGroup(tab.windowId);

            if (!groupId) {
                Menus.disable(info.menuItemId);
                return;
            }

            Cache.applyTabSession(tab);

            tab = Utils.normalizeTabFavIcon(tab);

            await Groups.setIconUrl(groupId, tab.favIconUrl);
        },
    }));

    options.showContextMenuOnTabs && groups.length && menuIds.push(await Menus.create({
        type: Menus.ItemType.SEPARATOR,
        parentId: 'stg-move-tab-parent',
        contexts: [Menus.ContextType.TAB],
    }));

    options.showContextMenuOnLinks && menuIds.push(await Menus.create({
        title: temporaryContainer.name,
        icon: temporaryContainer.iconUrl,
        parentId: 'stg-open-link-parent',
        contexts: [Menus.ContextType.LINK],
        async onClick(info) {
            if (!Utils.isUrlAllowToCreate(info.linkUrl)) {
                return;
            }

            if (!Utils.isUrlAllowToCreate(info.linkUrl)) {
                Utils.notify(['thisUrlsAreNotSupported', info.linkUrl], 7, 'thisUrlsAreNotSupported');
                return;
            }

            await Tabs.createNative({
                url: info.linkUrl,
                title: info.linkText,
                active: info.button.RIGHT,
                cookieStoreId: Constants.TEMPORARY_CONTAINER,
            });
        },
    }));

    options.showContextMenuOnLinks && groups.length && menuIds.push(await Menus.create({
        type: Menus.ItemType.SEPARATOR,
        parentId: 'stg-open-link-parent',
        contexts: [Menus.ContextType.LINK],
    }));

    hasBookmarksPermission && menuIds.push(await Menus.create({
        title: temporaryContainer.name,
        icon: temporaryContainer.iconUrl,
        parentId: 'stg-open-bookmark-parent',
        contexts: [Menus.ContextType.BOOKMARK],
        async onClick(info) {
            if (!info.bookmarkId) {
                Utils.notify(['bookmarkNotAllowed'], 7, 'bookmarkNotAllowed');
                return;
            }

            const [bookmark] = await browser.bookmarks.get(info.bookmarkId);

            if (bookmark.type !== browser.bookmarks.BookmarkTreeNodeType.BOOKMARK) {
                Utils.notify(['bookmarkNotAllowed'], 7, 'bookmarkNotAllowed');
                return;
            }

            if (!Utils.isUrlAllowToCreate(bookmark.url)) {
                Utils.notify(['thisUrlsAreNotSupported', bookmark.url], 7, 'thisUrlsAreNotSupported');
                return;
            }

            await Tabs.createNative({
                url: bookmark.url,
                title: bookmark.title,
                active: info.button.RIGHT,
                cookieStoreId: Constants.TEMPORARY_CONTAINER,
            });
        },
    }));

    hasBookmarksPermission && groups.length && menuIds.push(await Menus.create({
        type: Menus.ItemType.SEPARATOR,
        parentId: 'stg-open-bookmark-parent',
        contexts: [Menus.ContextType.BOOKMARK],
    }));

    await Promise.all(groups.map(async group => {
        if (group.isArchive) {
            return;
        }

        const groupId = group.id,
            groupIcon = Groups.getIconUrl(group),
            groupTitle = String(Groups.getTitle(group, 'withSticky withActiveGroup withContainer'));

        options.showContextMenuOnTabs && menuIds.push(await Menus.create({
            title: groupTitle,
            icon: groupIcon,
            parentId: 'stg-move-tab-parent',
            contexts: [Menus.ContextType.TAB],
            async onClick(info, tab) {
                const tabIds = await Tabs.getHighlightedIds(tab.windowId, tab);

                await Tabs.move(tabIds, groupId, {
                    ...group,
                    showTabAfterMovingItIntoThisGroup: info.button.RIGHT,
                });

                if (!info.button.RIGHT && info.modifiers.includes('Ctrl')) { // todo make util for modifier with MAC
                    await Tabs.discard(tabIds);
                }
            },
        }));

        options.showContextMenuOnLinks && menuIds.push(await Menus.create({
            title: groupTitle,
            icon: groupIcon,
            parentId: 'stg-open-link-parent',
            contexts: [Menus.ContextType.LINK],
            async onClick(info) {
                if (!Utils.isUrlAllowToCreate(info.linkUrl)) {
                    Utils.notify(['thisUrlsAreNotSupported', info.linkUrl], 7, 'thisUrlsAreNotSupported');
                    return;
                }

                const newTab = await Tabs.add(groupId, undefined, info.linkUrl, info.linkText);

                if (info.button.RIGHT) {
                    await applyGroup(newTab.windowId, groupId, newTab.id);
                }
            },
        }));

        hasBookmarksPermission && menuIds.push(await Menus.create({
            title: groupTitle,
            icon: groupIcon,
            parentId: 'stg-open-bookmark-parent',
            contexts: [Menus.ContextType.BOOKMARK],
            async onClick(info) {
                if (!info.bookmarkId) {
                    Utils.notify(['bookmarkNotAllowed'], 7, 'bookmarkNotAllowed');
                    return;
                }

                await loadingBrowserAction();

                const [bookmark] = await browser.bookmarks.getSubTree(info.bookmarkId),
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
                    const { group } = await Groups.load(groupId),
                        [firstTab] = await createTabsSafe(Groups.setNewTabsParams(tabsToCreate, group));

                    await loadingBrowserAction(false);

                    if (info.button.RIGHT) {
                        await applyGroup(undefined, groupId, firstTab.id);
                    } else {
                        Utils.notify(['tabsCreatedCount', tabsToCreate.length], 7);
                    }
                } else {
                    await loadingBrowserAction(false);
                    Utils.notify(['tabsNotCreated'], 7);
                }
            },
        }));
    }));

    options.showContextMenuOnTabs && menuIds.push(await Menus.create({
        title: browser.i18n.getMessage('createNewGroup'),
        icon: '/icons/group-new.svg',
        parentId: 'stg-move-tab-parent',
        contexts: [Menus.ContextType.TAB],
        async onClick(info, tab) {
            const tabIds = await Tabs.getHighlightedIds(tab.windowId, tab);

            await onBackgroundMessage({
                action: 'add-new-group',
                proposalTitle: tab.title,
                tabIds: tabIds,
                windowId: info.button.RIGHT ? tab.windowId : undefined,
            }, self);
        },
    }));

    options.showContextMenuOnLinks && menuIds.push(await Menus.create({
        title: browser.i18n.getMessage('createNewGroup'),
        icon: '/icons/group-new.svg',
        parentId: 'stg-open-link-parent',
        contexts: [Menus.ContextType.LINK],
        async onClick(info) {
            if (!Utils.isUrlAllowToCreate(info.linkUrl)) {
                Utils.notify(['thisUrlsAreNotSupported', info.linkUrl], 7, 'thisUrlsAreNotSupported');
                return;
            }

            let { ok, group } = await onBackgroundMessage({
                action: 'add-new-group',
                proposalTitle: info.linkText,
            }, self);

            if (!ok) {
                group = await Groups.add(undefined, undefined, info.linkText);
                ok = true;
            }

            if (ok && group) {
                let newTab = await Tabs.add(group.id, undefined, info.linkUrl, info.linkText);

                if (info.button.RIGHT) {
                    await applyGroup(undefined, group.id, newTab.id);
                }
            }
        },
    }));

    hasBookmarksPermission && menuIds.push(await Menus.create({
        title: browser.i18n.getMessage('createNewGroup'),
        icon: '/icons/group-new.svg',
        parentId: 'stg-open-bookmark-parent',
        contexts: [Menus.ContextType.BOOKMARK],
        async onClick(info) {
            if (!info.bookmarkId) {
                Utils.notify(['bookmarkNotAllowed'], 7, 'bookmarkNotAllowed');
                return;
            }

            let [bookmark] = await browser.bookmarks.get(info.bookmarkId);

            if (bookmark.type === browser.bookmarks.BookmarkTreeNodeType.BOOKMARK) {
                if (!Utils.isUrlAllowToCreate(bookmark.url)) {
                    Utils.notify(['bookmarkNotAllowed'], 7, 'bookmarkNotAllowed');
                    return;
                }

                let { ok, group } = await onBackgroundMessage({
                    action: 'add-new-group',
                    proposalTitle: bookmark.title,
                }, self);

                if (!ok) {
                    group = await Groups.add(undefined, undefined, bookmark.title);
                    ok = true;
                }

                if (ok && group) {
                    let newTab = await Tabs.add(group.id, undefined, bookmark.url, bookmark.title);

                    if (info.button.RIGHT) {
                        await applyGroup(undefined, group.id, newTab.id);
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

                await loadingBrowserAction(false);

                if (groupsCreatedCount) {
                    Utils.notify(['groupsCreatedCount', groupsCreatedCount], 7);
                } else {
                    Utils.notify(['noGroupsCreated'], 7);
                }
            } else {
                Utils.notify(['bookmarkNotAllowed'], 7, 'bookmarkNotAllowed');
            }
        },
    }));

    hasBookmarksPermission && menuIds.push(await Menus.create({
        title: browser.i18n.getMessage('exportAllGroupsToBookmarks'),
        icon: '/icons/bookmark.svg',
        contexts: [Menus.ContextType.ACTION],
        async onClick() {
            await exportAllGroupsToBookmarks(true);
        },
    }));

    menuIds.push(await Menus.create({
        title: browser.i18n.getMessage('reopenTabsWithTemporaryContainersInNew'),
        icon: Containers.temporaryContainerOptions.iconUrl,
        contexts: [Menus.ContextType.ACTION],
        async onClick(info) {
            const allTabs = await Tabs.get(null, null, null, undefined, true, true),
                tabsToCreate = [];

            const tabsIdsToRemove = allTabs
                .filter(tab => Containers.isTemporary(tab.cookieStoreId))
                .map(function (tab) {
                    tabsToCreate.push({
                        ...tab,
                        cookieStoreId: Constants.TEMPORARY_CONTAINER,
                    });

                    return tab.id;
                });

            if (tabsToCreate.length) {
                await loadingBrowserAction();

                // create tabs
                self.skipCreateTab = true;

                let newTabs = await Promise.all(tabsToCreate.map(Tabs.createNative));

                self.skipCreateTab = false;

                newTabs = await Promise.all(newTabs.map(Cache.setTabSession));

                let tabsToHide = newTabs.filter(tab => tab.groupId && !Cache.getWindowId(tab.groupId));

                await Tabs.safeHide(tabsToHide);

                // remove old tabs
                await Tabs.remove(tabsIdsToRemove);

                // remove temporary containers
                if (info.button.RIGHT) {
                    await Containers.removeUnusedTemporaryContainers(newTabs);
                }

                await loadingBrowserAction(false);
            }
        },
    }));

    log.stop();
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
    const hasBookmarksPermission = await browser.permissions.contains(Constants.PERMISSIONS.BOOKMARKS);

    if (!hasBookmarksPermission) {
        return;
    }

    let rootBookmark = {
        id: options.defaultBookmarksParent,
    };

    let likeGroup = {
        title: browser.i18n.getMessage('extensionName'),
        bookmarkId: window.localStorage.mainBookmarksFolderId,
    };

    rootBookmark = await findGroupBookmark(likeGroup, rootBookmark.id, createIfNeed);

    if (!rootBookmark) {
        return;
    }

    window.localStorage.mainBookmarksFolderId = rootBookmark.id;

    return findGroupBookmark(group, rootBookmark.id, createIfNeed);
}

async function removeGroupBookmark(group) {
    const groupBookmarkFolder = await getGroupBookmark(group);

    if (groupBookmarkFolder) {
        await browser.bookmarks.removeTree(groupBookmarkFolder.id);
    }
}

async function updateGroupBookmarkTitle(group) {
    const groupBookmarkFolder = await getGroupBookmark(group);

    if (groupBookmarkFolder) {
        await browser.bookmarks.update(groupBookmarkFolder.id, {
            title: group.title,
        });
    }
}

async function exportGroupToBookmarks(group, groupIndex, showMessages = true) {
    const hasBookmarksPermission = await browser.permissions.contains(Constants.PERMISSIONS.BOOKMARKS);

    if (!hasBookmarksPermission) {
        showMessages && Utils.notify(['noAccessToBookmarks'], undefined, undefined, undefined, Urls.openOptionsPage);
        logger.log('exportGroupToBookmarks no bookmarks permission');
        return false;
    }

    const log = logger.start('exportGroupToBookmarks', { groupId: group?.id || group, showMessages });

    if (!group) {
        log.throwError('group has invalid type');
    }

    if (Number.isSafeInteger(group)) {
        ({ group, groupIndex } = await Groups.load(group, true));
    }

    if (!group) {
        showMessages && Utils.notify(['groupNotFound']);
        log.stopError('group not found');
        return false;
    }

    if (showMessages) {
        await loadingBrowserAction(true);
    }

    const { BOOKMARK, FOLDER, SEPARATOR } = browser.bookmarks.BookmarkTreeNodeType;

    const { bookmarkId: oldGroupGookmarkId } = group,
        groupBookmarkFolder = await getGroupBookmark(group, true);

    if (groupBookmarkFolder.parentId === window.localStorage.mainBookmarksFolderId && groupBookmarkFolder.index !== groupIndex) {
        await browser.bookmarks.move(groupBookmarkFolder.id, {
            index: groupIndex,
        });
    }

    const bookmarksToRemove = [];

    if (group.leaveBookmarksOfClosedTabs) {
        group.tabs.forEach(function (tab) {
            groupBookmarkFolder.children = groupBookmarkFolder.children.filter(function (bookmark) {
                if (bookmark.type === BOOKMARK) {
                    if (bookmark.url === tab.url) {
                        bookmarksToRemove.push(bookmark.id);
                        return false;
                    }

                    return true;
                }
            });
        });

        await Promise.all(bookmarksToRemove.map(id => browser.bookmarks.remove(id).catch(() => { })));

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
            let duplicatedSeparators = children.filter(function (separator, index) {
                return separator.type === SEPARATOR && children[index - 1] && children[index - 1].type === SEPARATOR;
            });

            if (children[children.length - 1].type === SEPARATOR && !duplicatedSeparators.includes(children[children.length - 1])) {
                duplicatedSeparators.push(children[children.length - 1]);
            }

            if (duplicatedSeparators.length) {
                await Promise.all(duplicatedSeparators.map(separator => browser.bookmarks.remove(separator.id).catch(() => { })));
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
                bookmark = groupBookmarkFolder.children.find(function ({ id, type, url }) {
                    return !foundedBookmarks.has(id) && type === BOOKMARK && url === tab.url;
                });

            if (bookmark) {
                foundedBookmarks.add(bookmark.id);
                await browser.bookmarks.move(bookmark.id, { index });
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

        groupBookmarkFolder.children.forEach(({ id, type }) => type !== FOLDER && !foundedBookmarks.has(id) && bookmarksToRemove.push(id));

        await Promise.all(bookmarksToRemove.map(id => browser.bookmarks.remove(id).catch(() => { })));
    }

    if (oldGroupGookmarkId !== groupBookmarkFolder.id) {
        await Groups.update(group.id, {
            bookmarkId: groupBookmarkFolder.id,
        });
    }

    if (showMessages) {
        await loadingBrowserAction(false);
        Utils.notify(['groupExportedToBookmarks', group.title], 7);
    }

    log.stop();

    return true;
}

async function setBrowserAction(windowId, title, icon, enable, isSticky) {
    const log = logger.start('setBrowserAction', { windowId, title, icon, enable, isSticky });

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
            await browser.browserAction.enable();
        } else {
            await browser.browserAction.disable();
        }
    }

    const manifestAction = Constants.MANIFEST.manifest_version === 3
        ? Constants.MANIFEST.action
        : Constants.MANIFEST.browser_action;

    const winObj = windowId ? { windowId } : {};

    await Promise.all([
        browser.browserAction.setTitle({
            ...winObj,
            title: title || manifestAction.default_title,
        }).catch(log.onCatch('setTitle', false)),
        browser.browserAction.setBadgeText({
            ...winObj,
            text: isSticky ? Constants.STICKY_SYMBOL : '',
        }).catch(log.onCatch('setBadgeText', false)),
        browser.browserAction.setIcon({
            ...winObj,
            path: icon || manifestAction.default_icon,
        }).catch(log.onCatch('setIcon', false)),
    ]);

    log.stop();
}

async function updateBrowserActionData(groupId, windowId) {
    const log = logger.start('updateBrowserActionData', { groupId, windowId });

    if (groupId) {
        windowId = Cache.getWindowId(groupId);
    } else if (windowId) {
        groupId = Cache.getWindowGroup(windowId);
    }

    if (!windowId) {
        return log.stop(null, 'no window id');
    }

    log.log({ groupId, windowId })

    let group;

    if (groupId) {
        ({ group } = await Groups.load(groupId));
    }

    if (group) {
        log.log('group found');
        await setBrowserAction(windowId, Utils.sliceText(Groups.getTitle(group, 'withContainer'), 43) + ' - STG', Groups.getIconUrl(group), true, group.isSticky); // todo make this args as obj
    } else {
        log.log('group NOT found');
        await setBrowserAction(windowId, undefined, undefined, true);
    }

    await prependWindowTitle(windowId, group);

    log.stop();
}

async function prependWindowTitle(windowId, group = null) {
    if (windowId) {
        let titlePreface = '';

        if (group?.prependTitleToWindow) {
            const emoji = Groups.getEmojiIcon(group);

            if (emoji) {
                titlePreface = `${emoji} - `;
            } else {
                titlePreface = `${Utils.sliceText(group.title, 25)} - `;
            }
        }

        await browser.windows.update(windowId, { titlePreface })
            .catch(logger.onCatch(['prependWindowTitle', { windowId, titlePreface }], false));
    }
}

let _tabsLazyMovingMap = new Map,
    _tabsLazyMovingTimer = 0;

function addTabToLazyMove(tabId, groupId) {
    clearTimeout(_tabsLazyMovingTimer);

    _tabsLazyMovingMap.set(tabId, groupId);

    _tabsLazyMovingTimer = window.setTimeout(catchFunc(async function () {
        let tabsEntries = Array.from(_tabsLazyMovingMap.entries());

        _tabsLazyMovingMap.clear();

        let moveData = tabsEntries.reduce((acc, [tabId, groupId]) => {
            acc[groupId] ??= [];
            acc[groupId].push(tabId);
            return acc;
        }, {}),
            { groups } = await Groups.load();

        for (let groupId in moveData) {
            groupId = Number(groupId);
            await Tabs.move(moveData[groupId], groupId, groups.find(gr => gr.id === groupId));
        }
    }), 100);
}

let canceledRequests = new Set;
const onBeforeTabRequest = catchFunc(async function ({ tabId, url, cookieStoreId, originUrl, requestId, frameId }) {
    const log = logger.start('onBeforeTabRequest', { tabId, url, cookieStoreId, originUrl, requestId, frameId });

    if (frameId !== 0 || tabId === browser.tabs.TAB_ID_NONE || Containers.isTemporary(cookieStoreId)) {
        log.stop('exclude');
        return {};
    }

    if (canceledRequests.has(requestId)) {
        log.stop('stop by requestId', requestId);
        return {
            cancel: true,
        };
    }

    originUrl = originUrl || '';

    if (originUrl.startsWith(Constants.STG_BASE_URL)) {
        originUrl = 'stg://';
    }

    if (excludeTabIds.has(tabId)) {
        log.stop('tab is excluded', { tabId, url, originUrl });
        return {};
    }

    if (!Cache.getTabGroup(tabId)) {
        log.stop('tab doesnt have a group', { tabId, url, originUrl });
        return {};
    }

    log.log({ tabId, url, originUrl });

    await Utils.wait(100);

    let tab = await Tabs.getOne(tabId);

    if (!tab) {
        log.stopWarn('tab not found', tabId);
        return {};
    }

    if (Utils.isTabPinned(tab)) {
        log.stop('tab is pinned');
        return {};
    }

    tab.url = url;

    if (Utils.isUrlEmpty(tab.url)) {
        delete tab.title;
    }

    Cache.applyTabSession(tab);

    if (!tab.groupId) {
        log.stop('tab does not have group id');
        return {};
    }

    log.log(tab);

    const {
        group: tabGroup,
        notArchivedGroups,
    } = await Groups.load(tab.groupId);

    const destGroup = Groups.getCatchedForTab(notArchivedGroups, tabGroup, tab);

    if (destGroup) {
        tab = await Tabs.getOne(tabId);

        if (!tab) {
            log.stopWarn('tab not found', tabId);
            return {};
        }

        if (new URL(tab.url).origin !== new URL(url).origin) {
            tab.favIconUrl = null;
            Cache.removeTabThumbnail(tab.id);
        }

        tab.url = url;
        tab.status = browser.tabs.TabStatus.COMPLETE;
        Cache.setTab(tab);

        addTabToLazyMove(tab.id, destGroup.id);
        log.stop('move tab from groupId:', tabGroup.id, 'to groupId:', destGroup.id);
        return {};
    }

    const newTabContainer = Tabs.getNewTabContainer(tab, tabGroup);

    if (tab.cookieStoreId === newTabContainer) {
        log.stop('cookieStoreId is equal');
        return {};
    }

    const originExt = Management.getExtensionByUUID(originUrl.slice(0, 50)) || {};

    function getNewAddonTabUrl(asInfo) {
        const params = {
            url: tab.url,
            anotherCookieStoreId: tab.cookieStoreId,
            destCookieStoreId: newTabContainer,
            conflictedExtId: originExt.id,
            groupId: tabGroup.id,
        };

        if (asInfo) {
            params.asInfo = true;
        }

        return Utils.setUrlSearchParams(Urls.getURL('open-in-container', true), params);
    }

    if (Constants.IGNORE_EXTENSIONS_FOR_REOPEN_TAB_IN_CONTAINER.includes(originExt.id) && originExt.enabled) {
        let showNotif = +window.localStorage.ignoreExtensionsForReopenTabInContainer || 0;

        if (showNotif < 10) {
            window.localStorage.ignoreExtensionsForReopenTabInContainer = ++showNotif;
            let str = browser.i18n.getMessage('helpPageOpenInContainerMainTitle', Containers.get(newTabContainer, 'name'));

            str = str.replace(/(\<.+?\>)/g, '') + '\n\n' + browser.i18n.getMessage('clickHereForInfo');

            Utils.notify(str, undefined, undefined, undefined, function () {
                Tabs.create({
                    active: true,
                    url: getNewAddonTabUrl(true),
                    groupId: tabGroup.id,
                });
            });
        }

        log.stop('ignore tab, by extension', originExt.id);
        return {};
    }

    canceledRequests.add(requestId);
    setTimeout(requestId => canceledRequests.delete(requestId), 2000, requestId);

    Promise.resolve().then(async () => {
        const newTabParams = {
            ...tab,
            cookieStoreId: newTabContainer,
            ...Groups.getNewTabParams(tabGroup),
        };

        if (originUrl.startsWith('moz-extension')) {
            if (tab.hidden) {
                //
            } else {
                if (!ignoreExtForReopenContainer.has(originExt.id) && originExt.enabled) {
                    newTabParams.active = true;
                    newTabParams.url = getNewAddonTabUrl();
                }
            }
        }

        const newTab = await Tabs.create(newTabParams);

        log.log('remove tab', tab);
        Tabs.remove(tab);

        if (tab.hidden) {
            log.log('hide tab', newTab);
            Tabs.safeHide(newTab);
        }
    });

    log.stop('reopen tab');
    return {
        cancel: true,
    };
});

const onPermissionsChanged = catchFunc(async function ({ origins, permissions }) {
    logger.log('onPermissionsChanged', { origins, permissions });
    await updateMoveTabMenus(); // TODO ???
});

// wait for reload addon if found update
browser.runtime.onUpdateAvailable.addListener(() => Utils.safeReloadAddon());

function addListenerOnBeforeRequest() {
    if (!browser.webRequest.onBeforeRequest.hasListener(onBeforeTabRequest)) {
        logger.log('addListenerOnBeforeRequest');

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
        logger.log('removeListenerOnBeforeRequest');
        browser.webRequest.onBeforeRequest.removeListener(onBeforeTabRequest);
    }
}

function addEvents() {
    logger.info('addEvents');

    browser.tabs.onActivated.addListener(onActivatedTab)
    browser.tabs.onCreated.addListener(onCreatedTab);
    browser.tabs.onUpdated.addListener(onUpdatedTab, {
        properties: Constants.ON_UPDATED_TAB_PROPERTIES,
    });
    browser.tabs.onRemoved.addListener(onRemovedTab);
    browser.tabs.onMoved.addListener(onMovedTab);

    browser.tabs.onAttached.addListener(onAttachedTab);

    browser.windows.onCreated.addListener(onCreatedWindow);
    browser.windows.onFocusChanged.addListener(onFocusChangedWindow);
    browser.windows.onRemoved.addListener(onRemovedWindow);

    browser.permissions.onAdded.addListener(onPermissionsChanged);
    browser.permissions.onRemoved.addListener(onPermissionsChanged);

}

function removeEvents() {
    logger.info('removeEvents');

    browser.tabs.onActivated.removeListener(onActivatedTab);
    browser.tabs.onCreated.removeListener(onCreatedTab);
    browser.tabs.onUpdated.removeListener(onUpdatedTab);
    browser.tabs.onRemoved.removeListener(onRemovedTab);
    browser.tabs.onMoved.removeListener(onMovedTab);

    browser.tabs.onAttached.removeListener(onAttachedTab);

    browser.windows.onCreated.removeListener(onCreatedWindow);
    browser.windows.onFocusChanged.removeListener(onFocusChangedWindow);
    browser.windows.onRemoved.removeListener(onRemovedWindow);

    browser.permissions.onAdded.removeListener(onPermissionsChanged);
    browser.permissions.onRemoved.removeListener(onPermissionsChanged);

    removeListenerOnBeforeRequest();
}

window.addEventListener('unload', removeEvents);

browser.commands.onCommand.addListener(function (name) {
    onBackgroundMessage(name, self);
});

browser.runtime.onMessage.addListener(onBackgroundMessage);

browser.runtime.onMessageExternal.addListener(async function onMessageExternal(request, sender) {
    const log = logger.start(['info', 'onMessageExternal'], `RECEIVED-EXTERNAL-ACTION#${request?.action}`, { request, sender });

    if (request?.action === 'ignore-ext-for-reopen-container') {
        ignoreExtForReopenContainer.add(sender.id);
        log.stop('add to ignore', sender.id, 'done');
        return {
            ok: true,
        };
    }

    if (!self.inited) {
        log.stop('background not inited');
        return {
            ok: false,
            error: `[STG] I'm not loaded yet.`,
        };
    }

    const extensionRules = {};

    if (!Utils.isAllowExternalRequestAndSender(request, sender, extensionRules)) {
        log.stop('sender is not allowed');
        return {
            ok: false,
            error: '[STG] Your extension/action does not in white list. If you want to add your extension/action to white list - please contact with me.',
            yourExtentionRules: extensionRules,
        };
    }

    if (!request?.action || typeof request.action !== 'string') {
        log.stop('unknown action');
        return {
            ok: false,
            error: 'unknown action',
        };
    }

    const result = await onBackgroundMessage(request, sender);

    log.stop();

    return result;
});

const INTERNAL_MODULES_NAMES = new Set([
    'BG.saveOptions',
    'BG.restoreBackup',
    'BG.clearAddon',
    'BG.runMigrateForData',
    'Tabs',
    'Groups',
    'Windows',
]);

const INTERNAL_MODULES = {
    BG: self,
    Tabs,
    Groups,
    Windows,
};
/*
self.BG.callModule = async function(moduleName, ...args) {
    let [module, funcName] = moduleName.split('.');

    args = JSON.clone(args);

    try {
        return await INTERNAL_MODULES[module][funcName](...args);
    } catch (e) {
        logger.throwError([
            'callModule:', moduleName,
            'args:', args,
        ], e);
    }
} */

function isStgSender(sender) {
    return sender === self ||
        sender.id === browser.runtime.id ||
        sender.sender?.id === browser.runtime.id;
}

self.onBackgroundMessage = onBackgroundMessage;

async function onBackgroundMessage(message, sender) {
    const isSTGMessage = isStgSender(sender);
    const senderToLogs = isSTGMessage ? browser.runtime.id : sender;

    let result = {
        ok: false,
    };

    const data = typeof message === 'string' ? { action: message } : message;

    if (!data?.action) {
        result.error = '[STG] invalid "action"';
        logger.error('onBackgroundMessage', result.error, data, senderToLogs);
        return result;
    }

    // simple messages
    switch (data.action) {
        case 'are-you-here':
            result.ok = self.inited;
            return result;

        case 'save-log':
            addLog(data.log);
            showLog.call(data.logger, data.log, data.options);
            result.ok = true;
            return result;

        case 'show-error-notification':
            const isMessageSended = sendMessage('show-error-notification');

            Utils.notify(
                ['whatsWrongMessage'],
                undefined,
                'whatsWrongMessage',
                '/icons/exclamation-triangle-yellow.svg',
                () => !isMessageSended && Urls.openDebugPage()
            ).catch(() => { });

            result.ok = true;
            return result;

        case 'safe-reload-addon':
            Utils.safeReloadAddon();
            result.ok = true;
            return result;

        case 'ignore-ext-for-reopen-container':
            ignoreExtForReopenContainer.add(data.id);
            result.ok = true;
            return result;

        default: break;
    }

    if (isSTGMessage) {
        let [module, funcName] = data.action.split('.');

        if (INTERNAL_MODULES_NAMES.has(module) || INTERNAL_MODULES_NAMES.has(data.action)) {
            logger.log('onBackgroundMessage internal module', data.action);

            try {
                return await INTERNAL_MODULES[module][funcName](...data.args);
            } catch (e) {
                logger.throwError([
                    'onBackgroundMessage call internal module:', data.action,
                    'args:', data.args,
                    'sender:', senderToLogs,
                    'from stack:', data.from,
                ], e);
            }
        }
    }

    const log = logger.start(
        ['info', 'onBackgroundMessage'],
        ...(isSTGMessage ? [`ACTION#${data.action}`] : [sender.id, `RECEIVED-EXTERNAL-ACTION#${data.action}`, data])
    );

    try {
        let currentWindow = await Windows.getLastFocusedNormalWindow(false),
            {
                group: currentGroup,
                groups,
                notArchivedGroups,
            } = await Groups.load(currentWindow.groupId);

        if (data.windowId === browser.windows.WINDOW_ID_CURRENT) {
            data.windowId = currentWindow.id;
        }

        log.log('check action');

        switch (data.action) {
            case 'get-groups-list':
                result.groupsList = groups.map(Groups.mapForExternalExtension);
                result.ok = true;
                break;
            case 'load-next-group':
                result.ok = await applyGroupByPosition('next', notArchivedGroups, currentGroup?.id);
                break;
            case 'load-prev-group':
                result.ok = await applyGroupByPosition('prev', notArchivedGroups, currentGroup?.id);
                break;
            case 'load-next-unloaded-group':
                {
                    let unloadedGroups = notArchivedGroups.filter(group => !Cache.getWindowId(group.id) || group.id === currentGroup?.id);
                    result.ok = await applyGroupByPosition('next', unloadedGroups, currentGroup?.id);
                }
                break;
            case 'load-prev-unloaded-group':
                {
                    let unloadedGroups = notArchivedGroups.filter(group => !Cache.getWindowId(group.id) || group.id === currentGroup?.id);
                    result.ok = await applyGroupByPosition('prev', unloadedGroups, currentGroup?.id);
                }
                break;
            case 'load-next-non-empty-group':
                ({ notArchivedGroups } = await Groups.load(null, true))
                result.ok = await applyGroupByPosition('next', notArchivedGroups.filter(group => group.tabs.length), currentGroup?.id);
                break;
            case 'load-prev-non-empty-group':
                ({ notArchivedGroups } = await Groups.load(null, true))
                result.ok = await applyGroupByPosition('prev', notArchivedGroups.filter(group => group.tabs.length), currentGroup?.id);
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
                if (Number.isSafeInteger(data.groupId) && data.groupId > 0) {
                    let groupToLoad = groups.find(group => group.id === data.groupId);

                    if (groupToLoad) {
                        if (groupToLoad.isArchive) {
                            result.error = browser.i18n.getMessage('groupIsArchived', groupToLoad.title);
                            Utils.notify(result.error, 7, 'groupIsArchived');
                        } else {
                            if (data.windowId) {
                                if (data.windowId === 'new') {
                                    await Windows.create(data.groupId, data.tabId);
                                    result.ok = true;
                                } else if (Number.isSafeInteger(data.windowId) && data.windowId > 0) {
                                    result.ok = await applyGroup(data.windowId, data.groupId, data.tabId);
                                } else {
                                    result.error = 'Invalid window id';
                                }
                            } else {
                                result.ok = await applyGroup(currentWindow.id, data.groupId, data.tabId);
                            }
                        }
                    } else {
                        delete data.groupId;
                        result = await onBackgroundMessage(data, sender);
                    }
                } else if ('new' === data.groupId) {
                    let { ok, group } = await onBackgroundMessage({
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
                            disableGroupIds: [currentGroup?.id].filter(Boolean),
                        });

                        result.ok = true;
                    } else {
                        result.error = browser.i18n.getMessage('impossibleToAskUserAboutAction', [activeTab.title, browser.i18n.getMessage('hotkeyActionTitleLoadCustomGroup')]);
                        Utils.notify(result.error, 15, 'impossibleToAskUserAboutAction', undefined, Urls.openNotSupportedUrlHelper);
                    }
                }
                break;
            case 'unload-group':
                if (currentGroup) {
                    result.ok = await Groups.unload(currentGroup.id);
                }
                break;
            case 'add-new-group':
                if (!options.alwaysAskNewGroupName || data.title) {
                    let newGroup = await Groups.add(data.windowId, data.tabIds, data.title);

                    result.ok = true;
                    result.group = Groups.mapForExternalExtension(newGroup);
                } else {
                    let activeTab = await Tabs.getActive(),
                        { lastCreatedGroupPosition } = await Storage.get('lastCreatedGroupPosition');

                    if (Tabs.isCanSendMessage(activeTab)) {
                        let title = await Tabs.sendMessage(activeTab.id, {
                            action: 'show-prompt',
                            promptTitle: browser.i18n.getMessage('createNewGroup'),
                            value: data.proposalTitle || browser.i18n.getMessage('newGroupTitle', lastCreatedGroupPosition + 1),
                        });

                        if (title) {
                            result = await onBackgroundMessage({
                                action: 'add-new-group',
                                title: title,
                                tabIds: data.tabIds,
                                windowId: data.windowId,
                            }, sender);
                        } else {
                            result.error = 'title in empty - skip create group';
                        }
                    } else {
                        result = await onBackgroundMessage({
                            action: 'add-new-group',
                            title: data.proposalTitle || browser.i18n.getMessage('newGroupTitle', lastCreatedGroupPosition + 1),
                            tabIds: data.tabIds,
                            windowId: data.windowId,
                        }, sender);

                        if (options.alwaysAskNewGroupName) {
                            result.error = browser.i18n.getMessage('impossibleToAskUserAboutAction', [activeTab.title, browser.i18n.getMessage('createNewGroup')]);
                            Utils.notify(result.error, 15, 'impossibleToAskUserAboutAction', undefined, Urls.openNotSupportedUrlHelper);
                        }
                    }
                }
                break;
            case 'rename-group':
                if (!groups.length) {
                    result.error = browser.i18n.getMessage('noGroupsAvailable');
                    Utils.notify(result.error, 7, 'noGroupsAvailable');
                } else if (!data.groupId) {
                    let activeTab = await Tabs.getActive();

                    if (Tabs.isCanSendMessage(activeTab)) {
                        Tabs.sendMessage(activeTab.id, {
                            action: 'show-groups-popup',
                            popupAction: 'rename-group',
                            popupTitle: browser.i18n.getMessage('hotkeyActionTitleRenameGroup'),
                            groups: groups.map(Groups.mapForExternalExtension),
                            focusedGroupId: currentGroup?.id,
                            disableNewGroupItem: true,
                        });

                        result.ok = true;
                    } else {
                        result.error = browser.i18n.getMessage('impossibleToAskUserAboutAction', [activeTab.title, browser.i18n.getMessage('hotkeyActionTitleRenameGroup')]);
                        Utils.notify(result.error, 15, 'impossibleToAskUserAboutAction', undefined, Urls.openNotSupportedUrlHelper);
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
                                result = await onBackgroundMessage(data, sender);
                            } else {
                                result.error = 'title in empty - skip rename group';
                            }
                        } else {
                            result.error = browser.i18n.getMessage('impossibleToAskUserAboutAction', [activeTab.title, browser.i18n.getMessage('hotkeyActionTitleRenameGroup')]);
                            Utils.notify(result.error, 15, 'impossibleToAskUserAboutAction', undefined, Urls.openNotSupportedUrlHelper);
                        }
                    } else {
                        result = await onBackgroundMessage('rename-group', sender);
                    }
                } else if (data.groupId && data.title && typeof data.title === 'string') {
                    let groupToRename = groups.find(group => group.id === data.groupId);

                    if (groupToRename) {
                        Groups.update(groupToRename.id, {
                            title: data.title,
                        });
                        result.ok = true;
                    } else {
                        result = await onBackgroundMessage('rename-group', sender);
                    }
                } else {
                    result = await onBackgroundMessage('rename-group', sender);
                }
                break;
            case 'export-group-to-bookmarks':
                if (data.groupId) {
                    let groupToExport = groups.find(group => group.id === data.groupId);

                    if (groupToExport) {
                        result.ok = await exportGroupToBookmarks(data.groupId, undefined, data.showMessages);

                        if (!result.ok) {
                            result.error = browser.i18n.getMessage('noAccessToBookmarks');
                        }
                    } else {
                        delete data.groupId;
                    }
                }

                if (!data.groupId) {
                    let activeTab = await Tabs.getActive();

                    if (Tabs.isCanSendMessage(activeTab)) {
                        Tabs.sendMessage(activeTab.id, {
                            action: 'show-groups-popup',
                            popupAction: 'export-group-to-bookmarks',
                            popupTitle: browser.i18n.getMessage('exportGroupToBookmarks'),
                            groups: groups.map(Groups.mapForExternalExtension),
                            focusedGroupId: currentGroup?.id,
                            disableNewGroupItem: true,
                        });

                        result.ok = true;
                    } else {
                        result.error = browser.i18n.getMessage('impossibleToAskUserAboutAction', [activeTab.title, browser.i18n.getMessage('hotkeyActionTitleRenameGroup')]);
                        Utils.notify(result.error, 15, 'impossibleToAskUserAboutAction', undefined, Urls.openNotSupportedUrlHelper);
                    }
                }
                break;
            case 'delete-current-group':
                if (currentGroup) {
                    await Groups.remove(currentGroup.id);

                    if (!isSTGMessage && sender?.id) {
                        Utils.notify(['groupRemovedByExtension', [currentGroup.title, Utils.getSupportedExternalExtensionName(sender.id)]]);
                    }

                    result.ok = true;
                } else {
                    result.error = browser.i18n.getMessage('windowNotHaveGroup');
                }

                break;
            case 'open-manage-groups':
                await Urls.openManageGroups();
                result.ok = true;
                break;
            case 'open-options-page':
                await Urls.openOptionsPage();
                result.ok = true;
                break;
            case 'move-selected-tabs-to-custom-group':
                let activeTab = await Tabs.getActive(),
                    tabIds = await Tabs.getHighlightedIds(activeTab.windowId, undefined, null);

                if (Number.isSafeInteger(data.groupId) && 0 < data.groupId) {
                    let groupMoveTo = groups.find(group => group.id === data.groupId);

                    if (groupMoveTo) {
                        if (groupMoveTo.isArchive) {
                            result.error = browser.i18n.getMessage('groupIsArchived', groupMoveTo.title);
                            Utils.notify(result.error, 7, 'groupIsArchived');
                        } else {
                            await Tabs.move(tabIds, data.groupId, groupMoveTo);
                            result.ok = true;
                        }
                    } else {
                        delete data.groupId;
                        result = await onBackgroundMessage(data, sender);
                    }
                } else if ('new' === data.groupId) {
                    let { ok } = await onBackgroundMessage({
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
                        Utils.notify(result.error, 15, 'impossibleToAskUserAboutAction', undefined, Urls.openNotSupportedUrlHelper);
                    }
                }
                break;
            case 'discard-group':
                ({ groups, notArchivedGroups } = await Groups.load(null, true));

                let groupToDiscard = groups.find(group => group.id === data.groupId);

                if (groupToDiscard) {
                    if (groupToDiscard.isArchive) {
                        result.error = browser.i18n.getMessage('groupIsArchived', groupToDiscard.title);
                        Utils.notify(result.error, 7, 'groupIsArchived');
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
                            focusedGroupId: currentGroup?.id,
                            disableNewGroupItem: true,
                        });

                        result.ok = true;
                    } else {
                        result.error = browser.i18n.getMessage('impossibleToAskUserAboutAction', [activeTab.title, browser.i18n.getMessage('hotkeyActionTitleDiscardGroup')]);
                        Utils.notify(result.error, 15, 'impossibleToAskUserAboutAction', undefined, Urls.openNotSupportedUrlHelper);
                    }
                }
                break;
            case 'discard-other-groups':
                {
                    let { notArchivedGroups } = await Groups.load(null, true);

                    let tabs = notArchivedGroups.reduce(function (acc, gr) {
                        if (gr.id !== currentGroup?.id && !Cache.getWindowId(gr.id)) {
                            acc.push(...gr.tabs);
                        }
                        return acc;
                    }, []);

                    await Tabs.discard(tabs);

                    result.ok = true;
                }
                break;
            case 'reload-all-tabs-in-current-group':
                if (currentGroup) {
                    let { group } = await Groups.load(currentGroup.id, true);
                    await Tabs.reload(group.tabs);
                    result.ok = true;
                }

                break;
            case 'create-temp-tab':
                await Tabs.createNative({
                    active: data.active,
                    cookieStoreId: Constants.TEMPORARY_CONTAINER,
                });

                result.ok = true;

                break;
            case 'get-current-group':
                if (data.windowId) {
                    let groupId = Cache.getWindowGroup(data.windowId),
                        group = groups.find(gr => gr.id === groupId);

                    if (group) {
                        group = Groups.mapForExternalExtension(group);
                    }

                    result.group = group || null;
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
                result.ok = await createBackup(data.includeTabFavIcons === true, data.includeTabThumbnails === true);
                break;
            default:
                throw Error(`Action '${data.action}' is wrong`);
        }

    } catch (e) {
        result.error = '[STG] ' + String(e);
        log.runError(e.message || e, e);
    }

    result.error ? log.stopError() : log.stop();

    return result;
}

async function saveOptions(_options) {
    const log = logger.start('saveOptions', _options);

    if (!self.inited) {
        log.stopError('background not yet inited');
        return null;
    }

    _options = JSON.clone(_options);

    let optionsKeys = Object.keys(_options);

    if (!optionsKeys.every(key => Constants.ALL_OPTIONS_KEYS.includes(key))) {
        log.throwError(['some key in save options are not supported:', optionsKeys]);
    }

    Object.assign(options, _options);

    await Storage.set(_options);

    if (optionsKeys.includes('hotkeys')) {
        const tabs = await Tabs.get(null, null, null, {
            discarded: false,
        }),
            actionData = JSON.clone({
                action: 'update-hotkeys',
                hotkeys: options.hotkeys,
            });

        tabs.forEach(tab => Tabs.sendMessage(tab.id, actionData));
    }

    if (optionsKeys.some(key => ['autoBackupEnable', 'autoBackupIntervalKey', 'autoBackupIntervalValue'].includes(key))) {
        resetAutoBackup();
    }

    if (optionsKeys.includes('temporaryContainerTitle')) {
        await Containers.updateTemporaryContainerTitle(options.temporaryContainerTitle);
    }

    if (optionsKeys.some(key => ['showContextMenuOnTabs', 'showContextMenuOnLinks'].includes(key))) {
        await updateMoveTabMenus();
    }

    sendMessage('options-updated');

    log.stop();
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

    let now = Utils.unixNow(),
        timer = 0,
        value = Number(options.autoBackupIntervalValue);

    if (isNaN(value) || value < 1) {
        throw Error(errorEventMessage('invalid autoBackupIntervalValue', options));
    }

    let intervalSec = null;

    if (Constants.AUTO_BACKUP_INTERVAL_KEY.minutes === options.autoBackupIntervalKey) {
        if (value > 59) {
            throw Error(errorEventMessage('invalid autoBackupIntervalValue', options));
        }

        intervalSec = Constants.MINUTE_SEC;
    } else if (Constants.AUTO_BACKUP_INTERVAL_KEY.hours === options.autoBackupIntervalKey) {
        if (value > 24) {
            throw Error(errorEventMessage('invalid autoBackupIntervalValue', options));
        }

        intervalSec = Constants.HOUR_SEC;
    } else if (Constants.AUTO_BACKUP_INTERVAL_KEY.days === options.autoBackupIntervalKey) {
        if (value > 30) {
            throw Error(errorEventMessage('invalid autoBackupIntervalValue', options));
        }

        if (value === 1) {
            // if backup will create every day - overwrite backups every 2 hours in order to keep as recent changes as possible
            intervalSec = Constants.HOUR_SEC * 2;
        } else {
            intervalSec = Constants.DAY_SEC;
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
    const [
        data,
        { groups },
    ] = await Promise.all([
        Storage.get(),
        Groups.load(null, true, includeTabFavIcons, includeTabThumbnails),
    ]);

    if (isAutoBackup && (!groups.length || groups.every(gr => !gr.tabs.length))) {
        logger.warn('skip create auto backup, groups are empty');
        return false;
    }

    if (includeTabThumbnails) {
        includeTabThumbnails = options.showTabsWithThumbnailsInManageGroups;
    }

    let pinnedTabs = await Tabs.get(null, true, null);

    pinnedTabs = pinnedTabs.filter(tab => Utils.isUrlAllowToCreate(tab.url));

    if (pinnedTabs.length) {
        data.pinnedTabs = Tabs.prepareForSave(pinnedTabs);
    }

    const containersToExport = new Set;

    data.groups = groups.map(group => {
        group.tabs = Tabs.prepareForSave(group.tabs, false, includeTabFavIcons, includeTabThumbnails);

        group.tabs.forEach(({ cookieStoreId }) => {
            if (cookieStoreId && !Containers.isTemporary(cookieStoreId)) {
                containersToExport.add(cookieStoreId);
            }
        });

        if (group.newTabContainer !== Constants.TEMPORARY_CONTAINER &&
            group.newTabContainer !== Constants.DEFAULT_COOKIE_STORE_ID
        ) {
            containersToExport.add(group.newTabContainer);
        }

        group.catchTabContainers.forEach(containersToExport.add, containersToExport);

        return group;
    });

    if (containersToExport.size) {
        const allContainers = Containers.getAll();

        data.containers = {};

        containersToExport.forEach(cookieStoreId => data.containers[cookieStoreId] = allContainers[cookieStoreId]);
    }

    if (isAutoBackup) {
        data.autoBackupLastBackupTimeStamp = options.autoBackupLastBackupTimeStamp = Utils.unixNow();

        File.backup(data, true, options.autoBackupByDayIndex);

        exportAllGroupsToBookmarks(false, true);

        Storage.set({
            autoBackupLastBackupTimeStamp: data.autoBackupLastBackupTimeStamp,
        });
    } else {
        await File.backup(data, false);
    }

    return true;
}

async function restoreBackup(data, clearAddonDataBeforeRestore = false) {
    removeEvents();

    sendMessage('lock-addon');

    await loadingBrowserAction();

    const currentData = {};

    let { lastCreatedGroupPosition } = await Storage.get('lastCreatedGroupPosition');

    if (!lastCreatedGroupPosition) {
        clearAddonDataBeforeRestore = true;
    }

    if (clearAddonDataBeforeRestore) {
        lastCreatedGroupPosition = 0;
    }

    if (!Number.isSafeInteger(data.lastCreatedGroupPosition)) {
        data.lastCreatedGroupPosition = 0;
    }

    lastCreatedGroupPosition = Math.max(lastCreatedGroupPosition, data.lastCreatedGroupPosition);

    if (clearAddonDataBeforeRestore) {
        await clearAddon(false);

        // await Utils.wait(1000);
    }

    if (data.temporaryContainerTitle) {
        await Containers.updateTemporaryContainerTitle(data.temporaryContainerTitle);
    }

    if (clearAddonDataBeforeRestore) {
        options.showTabsWithThumbnailsInManageGroups = Constants.DEFAULT_OPTIONS.showTabsWithThumbnailsInManageGroups;
    }

    if (data.hasOwnProperty('showTabsWithThumbnailsInManageGroups')) {
        options.showTabsWithThumbnailsInManageGroups = data.showTabsWithThumbnailsInManageGroups;
    }

    if (clearAddonDataBeforeRestore) {
        currentData.groups = [];
        currentData.hotkeys = [];
    } else {
        [
            { hotkeys: currentData.hotkeys },
            { groups: currentData.groups },
        ] = await Promise.all([
            Storage.get('hotkeys'),
            Groups.load(null, true, true, options.showTabsWithThumbnailsInManageGroups),
        ]);
    }

    data.groups ??= [];
    data.hotkeys ??= [];

    data.groups.forEach(groupToRestore => {
        if (!currentData.groups.some(currentGroup => currentGroup.id === groupToRestore.moveToGroupIfNoneCatchTabRules)) {
            groupToRestore.moveToGroupIfNoneCatchTabRules = null;
        }
    });

    const neededContainers = new Set;

    function prepareTab(newTabParams, tab) {
        delete tab.active;
        delete tab.windowId;
        delete tab.index;
        delete tab.pinned;

        if (tab.cookieStoreId && !Containers.isTemporary(tab.cookieStoreId)) {
            neededContainers.add(tab.cookieStoreId);
        }

        Object.assign(tab, newTabParams);
    }

    const defaultGroupProps = clearAddonDataBeforeRestore ? data.defaultGroupProps : options.defaultGroupProps;

    data.groups = data.groups.map(group => {
        let newGroupId = null;

        if (Number.isSafeInteger(group.id)) {
            if (group.id > lastCreatedGroupPosition) {
                lastCreatedGroupPosition = group.id;
            }

            newGroupId = clearAddonDataBeforeRestore ? group.id : (++lastCreatedGroupPosition);
        } else {
            newGroupId = ++lastCreatedGroupPosition;
        }

        const newGroup = Groups.create(newGroupId, group.title, defaultGroupProps);

        if (group.id) {
            data.hotkeys.forEach(hotkey => hotkey.groupId === group.id ? (hotkey.groupId = newGroup.id) : null);
        }

        delete group.id;

        for (const key in group) {
            if (newGroup.hasOwnProperty(key)) {
                newGroup[key] = group[key];
            }
        }

        const newTabParams = Groups.getNewTabParams(newGroup);
        newGroup.tabs.forEach(prepareTab.bind(null, newTabParams));

        return newGroup;
    });

    data.groups = [...currentData.groups, ...data.groups];
    data.hotkeys = [...currentData.hotkeys, ...data.hotkeys];

    data.hotkeys = data.hotkeys.filter((hotkey, index, self) => {
        return self.findIndex(h => h.value === hotkey.value) === index;
    });

    data.lastCreatedGroupPosition = lastCreatedGroupPosition;

    if (data.containers) {
        const containersStorageMap = new Map;

        for (const [cookieStoreId, value] of Object.entries(data.containers)) {
            if (!neededContainers.has(cookieStoreId)) {
                continue;
            }

            const newCookieStoreId = await Containers.findExistOrCreateSimilar(cookieStoreId, value, containersStorageMap);

            if (newCookieStoreId !== cookieStoreId) {
                data.groups.forEach(group => {
                    if (group.newTabContainer === cookieStoreId) {
                        group.newTabContainer = newCookieStoreId;
                    }

                    group.catchTabContainers = group.catchTabContainers.map(csId => csId === cookieStoreId ? newCookieStoreId : csId);
                });
            }
        }
    }

    delete data.containers;

    const allTabs = await Tabs.get(null, false, null, undefined, true, options.showTabsWithThumbnailsInManageGroups);

    await syncTabs(data.groups, allTabs);

    if (Array.isArray(data.pinnedTabs)) {
        const currentPinnedTabs = await Tabs.get(null, true, null);

        data.pinnedTabs = data.pinnedTabs.filter(function (tab) {
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

    let result;

    if (clearAddonDataBeforeRestore) {
        const defaultOptions = JSON.clone(Constants.DEFAULT_OPTIONS);

        result = Object.assign(defaultOptions, data);
    } else {
        result = data;
    }

    await Storage.set(result);

    await Utils.wait(200);

    browser.runtime.reload(); // reload addon
}

async function clearAddon(reloadAddonOnFinish = true) {
    if (reloadAddonOnFinish) {
        await loadingBrowserAction();

        sendMessage('lock-addon');
    }

    removeEvents();

    const [tabs, windows] = await Promise.all([Tabs.get(null, null, null), Windows.load()]);

    await Promise.all(tabs.map(tab => Cache.removeTabSession(tab.id)));
    await Promise.all(windows.map(win => Cache.removeWindowSession(win.id)));

    await Storage.clear();

    Cache.clear();

    window.localStorage.clear();

    if (reloadAddonOnFinish) {
        browser.runtime.reload(); // reload addon
    }
}

async function exportAllGroupsToBookmarks(showFinishMessage, isAutoBackup) {
    const hasBookmarksPermission = await browser.permissions.contains(Constants.PERMISSIONS.BOOKMARKS);

    if (!hasBookmarksPermission) {
        logger.log('exportAllGroupsToBookmarks no bookmarks permission');
        return;
    }

    const log = logger.start('exportAllGroupsToBookmarks', { showFinishMessage, isAutoBackup });

    if (showFinishMessage) {
        await loadingBrowserAction();
    }

    const { groups } = await Groups.load(null, true);

    for (const [groupIndex, group] of groups.entries()) {
        if (isAutoBackup && !group.exportToBookmarksWhenAutoBackup) {
            log.log('skip group', group.id);
            continue;
        }

        await exportGroupToBookmarks(group, groupIndex, false);
    }

    if (showFinishMessage) {
        loadingBrowserAction(false);

        Utils.notify(['allGroupsExportedToBookmarks']);
    }

    log.stop();
}

self.saveOptions = saveOptions;

self.createTabsSafe = createTabsSafe;

self.addUndoRemoveGroupItem = addUndoRemoveGroupItem;

self.excludeTabIds = excludeTabIds;
self.addExcludeTabIds = addExcludeTabIds;
self.removeExcludeTabIds = removeExcludeTabIds;

self.sendExternalMessage = sendExternalMessage;

self.updateBrowserActionData = updateBrowserActionData;
self.updateMoveTabMenus = updateMoveTabMenus;

self.loadingBrowserAction = loadingBrowserAction;

self.updateGroupBookmarkTitle = updateGroupBookmarkTitle;
self.removeGroupBookmark = removeGroupBookmark;
self.applyGroup = applyGroup;

self.addListenerOnBeforeRequest = addListenerOnBeforeRequest;
self.removeListenerOnBeforeRequest = removeListenerOnBeforeRequest;

self.runMigrateForData = runMigrateForData;

self.restoreBackup = restoreBackup;
self.clearAddon = clearAddon;

self.groupIdForNextTab = null;

self.skipCreateTab = false;
self.skipAddGroupToNextNewWindow = false;


async function runMigrateForData(data) {
    const log = logger.create('runMigrateForData');

    const currentVersion = Constants.MANIFEST.version;

    const resultMigrate = {
        data,
        migrated: false,
        error: null,
    };

    if (data.version === currentVersion) {
        log.stop('data.version === currentVersion', currentVersion);
        return resultMigrate;
    } else if (!data.version) {
        log.throwError('invalid data version');
    }

    const migrations = [
        {
            version: '1.8.1',
            remove: ['windowsGroup'],
            migration() {
                data.groups = data.groups.map(function (group) {
                    group.windowId = null;

                    group.catchTabRules = group.moveNewTabsToThisGroupByRegExp || '';
                    delete group.moveNewTabsToThisGroupByRegExp;

                    delete group.classList;
                    delete group.colorCircleHtml;
                    delete group.isExpanded;

                    if (group.iconColor === undefined || group.iconColor === 'undefined') { // fix missed group icons :)
                        group.iconColor = Utils.randomColor();
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
                data.groups = data.groups.map(function (group) {
                    group.tabs = group.tabs.filter(Boolean);
                    return group;
                });
            },
        },
        {
            version: '2.4',
            migration() {
                data.groups = data.groups.map(function (group) {
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
                data.groups = data.groups.map(function (group) {
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
                data.groups.forEach(group => group.title = Utils.unSafeHtml(group.title));

                let tabs = await browser.tabs.query({
                    url: 'moz-extension://*/stg-newtab/newtab.html*',
                });

                if (tabs.length) {
                    tabs.forEach(tab => delete tab.openerTabId);

                    await Promise.all(tabs.map(tab => Tabs.createNative(Utils.normalizeTabUrl(tab))));

                    await Utils.wait(100);

                    await Tabs.remove(tabs);

                    await Utils.wait(100);
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
                data.hotkeys.forEach(function (hotkey) {
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

                data.groups.forEach(function (group) {
                    group.muteTabsWhenGroupCloseAndRestoreWhenOpen = false;
                    group.showTabAfterMovingItIntoThisGroup = false;

                    group.tabs.forEach(function (tab) {
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
                data.groups.forEach(function (group) {
                    delete group.windowId;
                    group.dontDiscardTabsAfterHideThisGroup = false;
                });

                let windows = await Windows.load(true, true, true);

                if (!windows.length) {
                    throw browser.i18n.getMessage('notFoundWindowsAddonStoppedWorking');
                }

                let notifId = await Utils.notify(['loading']);

                await Promise.all(windows.map(win => Tabs.createTempActiveTab(win.id, false, 'about:blank')));

                data.groups.forEach(function (group) {
                    group.tabs.forEach(function (tab) {
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

                let allTabs = Utils.concatTabs(windows);

                if (allTabs.length) {
                    await Tabs.hide(allTabs);
                }

                data.groups = await syncTabs(data.groups, allTabs);

                browser.notifications.clear(notifId);

                await Utils.wait(1000);
            },
        },
        {
            version: '4.1',
            remove: [],
            migration() {
                data.groups.forEach(group => group.newTabContainer = null);

                migrations.some(function (prevMigration) {
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

                data.groups.forEach(function (group) {
                    group.isArchive = false;

                    group.tabs.forEach(function (tab) {
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
                data.groups.forEach(function (group) {
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
                data.groups.forEach(function (group) {
                    if (!group.newTabContainer) {
                        group.newTabContainer = Constants.DEFAULT_COOKIE_STORE_ID;
                        group.ifDifferentContainerReOpen = false;
                    }

                    group.excludeContainersForReOpen = [];
                });
            },
        },
        {
            version: '4.5.2',
            migration() {
                data.groups.forEach(function (group) {
                    data.groups.forEach(function (gr) {
                        if (gr.title === group.title && gr.id !== group.id) {
                            gr.title += ` ${gr.id}`;
                        }
                    });
                });

                data.hotkeys.forEach(function (hotkey) {
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
                let latestExampleGroup = Groups.create(),
                    latestExampleGroupKeys = Object.keys(latestExampleGroup).filter(key => !['id', 'title', 'tabs'].includes(key));

                data.groups.forEach(function (group) {
                    latestExampleGroupKeys
                        .forEach(key => !group.hasOwnProperty(key) && (group[key] = JSON.clone(latestExampleGroup[key])));
                });

                await restoreOldExtensionUrls(function ({ url, cookieStoreId }) {
                    if (!url.includes('open-in-container')) {
                        return url;
                    }

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
                data.theme = data.enableDarkTheme ? 'dark' : Constants.DEFAULT_OPTIONS.theme;
                data.groups.forEach(group => {
                    group.title = String(group.title);
                    group.bookmarkId = null;
                });

                let hasBookmarksPermission = await browser.permissions.contains(Constants.PERMISSIONS.BOOKMARKS);

                if (!hasBookmarksPermission) {
                    return;
                }

                let _bookmarkFolderFromTitle = async function (title, parentId) {
                    let bookmarks = await browser.bookmarks.search({ title });

                    return bookmarks.find(b => b.type === browser.bookmarks.BookmarkTreeNodeType.FOLDER && b.parentId === parentId);
                };

                let _getBookmarkGroup = async function (title) {
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
        {
            version: '4.8.1',
            remove: ['showNotificationAfterMoveTab'],
            async migration() {
                data.groups.forEach(group => {
                    group.showNotificationAfterMovingTabIntoThisGroup = data.showNotificationAfterMoveTab;
                    group.showOnlyActiveTabAfterMovingItIntoThisGroup = false;
                });

                data.closePopupAfterSelectTab = false;
            },
        },
        {
            version: '5.1',
            remove: [
                'defaultGroupIconViewType',
                'defaultGroupIconColor',
                'discardTabsAfterHide',
                'discardAfterHideExcludeAudioTabs',
                'prependGroupTitleToWindowTitle',
                'autoBackupGroupsToFile',
                'autoBackupGroupsToBookmarks',
                'leaveBookmarksOfClosedTabs',
            ],
            async migration() {
                data.groups.forEach(group => {
                    group.discardTabsAfterHide = !!data.discardTabsAfterHide && !group.dontDiscardTabsAfterHideThisGroup;
                    delete group.dontDiscardTabsAfterHideThisGroup;

                    group.discardExcludeAudioTabs = !!group.discardTabsAfterHide && !!data.discardAfterHideExcludeAudioTabs;

                    group.prependTitleToWindow = !!data.prependGroupTitleToWindowTitle;

                    group.exportToBookmarksWhenAutoBackup = !!data.autoBackupGroupsToBookmarks;
                    group.leaveBookmarksOfClosedTabs = !!data.leaveBookmarksOfClosedTabs;
                });

                data.defaultGroupProps = {};

                if (data.defaultGroupIconViewType && data.defaultGroupIconViewType !== Constants.DEFAULT_GROUP_ICON_VIEW_TYPE) {
                    data.defaultGroupProps.iconViewType = data.defaultGroupIconViewType;
                }

                if (data.defaultGroupIconColor && data.defaultGroupIconColor !== '') {
                    data.defaultGroupProps.iconColor = data.defaultGroupIconColor;
                }

                if (data.discardTabsAfterHide) {
                    data.defaultGroupProps.discardTabsAfterHide = true;
                }

                if (data.discardTabsAfterHide && data.discardAfterHideExcludeAudioTabs) {
                    data.defaultGroupProps.discardExcludeAudioTabs = true;
                }

                if (data.prependGroupTitleToWindowTitle) {
                    data.defaultGroupProps.prependTitleToWindow = true;
                }

                if (data.autoBackupGroupsToBookmarks) {
                    data.defaultGroupProps.exportToBookmarksWhenAutoBackup = true;
                }

                if (data.autoBackupGroupsToBookmarks && data.leaveBookmarksOfClosedTabs) {
                    data.defaultGroupProps.leaveBookmarksOfClosedTabs = true;
                }
            },
        },
        {
            version: '5.2',
            async migration() {
                // migrate groups
                const mainGroupId = data.groups.find(group => group.isMain)?.id;

                data.groups.forEach(group => {
                    if (group.moveToMainIfNotInCatchTabRules && mainGroupId) {
                        group.moveToGroupIfNoneCatchTabRules = mainGroupId;
                    } else {
                        group.moveToGroupIfNoneCatchTabRules = null;
                    }

                    delete group.isMain;
                    delete group.moveToMainIfNotInCatchTabRules;
                });

                // migrate hotkeys
                const keysMap = new Map([
                    [110, 'Decimal'],
                    [109, 'Subtract'],
                    [106, 'Multiply'],
                    [111, 'Divide'],
                    [222, 'Quote'],
                    [192, 'Backquote'],
                    [13, 'Enter'],
                    [191, 'Slash'],
                    [220, 'Backslash'],
                    [61, 'Equal'],
                    [173, 'Minus'],
                    [32, 'Space'],
                    [188, 'Comma'],
                    [190, 'Period'],
                    [59, 'Semicolon'],

                    ...['Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'Enter'].map(value => [value, value]),
                ]);

                function normalizeHotkeyKey({ key, keyCode }) {
                    return keysMap.get(keyCode) || keysMap.get(key) || key.toUpperCase();
                }

                data.hotkeys.forEach(hotkey => {
                    const valueParts = [];

                    if (hotkey.ctrlKey) {
                        valueParts.push(Utils.IS_MAC ? 'MacCtrl' : 'Ctrl');
                    }

                    if (hotkey.metaKey) {
                        valueParts.push('Command');
                    }

                    if (hotkey.altKey) {
                        valueParts.push('Alt');
                    }

                    if (hotkey.shiftKey) {
                        valueParts.push('Shift');
                    }

                    valueParts.push(normalizeHotkeyKey(hotkey));

                    hotkey.value = valueParts.join('+');

                    delete hotkey.ctrlKey;
                    delete hotkey.shiftKey;
                    delete hotkey.altKey;
                    delete hotkey.metaKey;
                    delete hotkey.key;
                    delete hotkey.keyCode;
                });
            },
        },
    ];

    // start migration
    const keysToRemoveFromStorage = new Set;

    // if data version < required latest migrate version then need migration
    if (-1 === Utils.compareVersions(data.version, migrations[migrations.length - 1].version)) {

        for (const migration of migrations) {
            if (-1 === Utils.compareVersions(data.version, migration.version)) {
                log.log('start migration to version', migration.version);

                await migration.migration();

                log.log('stop migration to version', migration.version);

                migration.remove?.forEach(keysToRemoveFromStorage.add, keysToRemoveFromStorage);
            }
        }

    } else if (1 === Utils.compareVersions(data.version, currentVersion)) {
        const [currentMajor, currentMinor = 0, currentPatch = 0] = currentVersion.split('.'),
            [dataMajor, dataMinor = 0, dataPatch = 0] = data.version.split('.');

        if (
            dataMajor > currentMajor ||
            (dataMajor == currentMajor && dataMinor > currentMinor) ||
            (dataMajor == currentMajor && dataMinor == currentMinor && dataPatch > currentPatch)
        ) {
            resultMigrate.error = browser.i18n.getMessage('updateAddonToLatestVersion');
            log.stopError(resultMigrate.error, 'data.version:', data.version, 'currentVersion:', currentVersion);
            return resultMigrate;
        }
    }

    data.version = currentVersion;

    if (keysToRemoveFromStorage.size) {
        keysToRemoveFromStorage.forEach(key => delete data[key]);
        log.log('remove keys in storage', Array.from(keysToRemoveFromStorage));
        await Storage.remove(Array.from(keysToRemoveFromStorage));
    }
    // end migration

    resultMigrate.migrated = true;
    log.stop('migrated', true);
    return resultMigrate;
}

async function syncTabs(groups, allTabs) {
    logger.info('syncTabs');

    const containersStorageMap = new Map;

    for (const group of groups) {
        if (group.isArchive) {
            continue;
        }

        let tabs = [],
            newTabs = [],
            newTabParams = Groups.getNewTabParams(group);

        for (const tab of group.tabs) {
            tab.groupId = group.id;

            tab.cookieStoreId = await Containers.findExistOrCreateSimilar(tab.cookieStoreId, null, containersStorageMap);

            const winTabIndex = allTabs.findIndex(winTab => winTab.url === tab.url && winTab.cookieStoreId === tab.cookieStoreId);

            if (winTabIndex !== -1) {
                const [winTab] = allTabs.splice(winTabIndex, 1);

                Cache.applySession(winTab, tab);

                tabs.push(Cache.setTabSession(winTab));
            } else {
                tabs.push(null);
                newTabs.push({
                    ...tab,
                    openerTabId: null,
                    ...Cache.applySession({}, tab),
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
                windowId: Cache.getWindowId(group.id) || group.tabs[0].windowId,
            });
        }
    }

    return groups;
}

let restoringMissedTabsPromise = null; // need when remove window
async function tryRestoreMissedTabs() {
    const log = logger.start(['info', 'tryRestoreMissedTabs']);

    if (restoringMissedTabsPromise) {
        await restoringMissedTabsPromise.catch(() => { });
    }

    let [
        { tabsToRestore: tabsToRestoreNotModified },
        windows,
    ] = await Promise.all([
        Storage.get({ tabsToRestore: [] }),
        Windows.load(),
    ]);

    if (!tabsToRestoreNotModified.length || !windows.length) {
        log.stop('not found tabs/windows for restore');
        return;
    }

    let tabsToRestore = JSON.clone(tabsToRestoreNotModified);

    log.log('restoring tabs:', tabsToRestore);

    await Promise.all(windows.map(win => loadingBrowserAction(true, win.id)));

    let [allTabs, { groups }] = await Promise.all([Tabs.get(null, false, null), Groups.load()]),
        groupNewTabParams = groups
            .filter(g => !g.isArchive)
            .reduce((acc, group) => (acc[group.id] = Groups.getNewTabParams(group), acc), {}),
        foundTab = new Set;

    // normalize tab urls
    allTabs.forEach(tab => {
        if (Utils.isTabLoading(tab) && Utils.isUrlEmpty(tab.url)) {
            tab.url = Utils.normalizeUrl(Cache.getTabSession(tab.id, 'url'));
        }
    });

    // strict find exist tabs
    tabsToRestore = tabsToRestore
        .map(function (tab) {
            if (!groupNewTabParams[tab.groupId]) {
                return;
            }

            tab = Utils.normalizeTabUrl(tab);

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
        log.runError('cant createTabsSafe', e);
        log.stopError();
        return;
    }

    log.log('filter and save tabs which was restored');

    let { tabsToRestore: tabsInDB } = await Storage.get({ tabsToRestore: [] });
    tabsInDB = tabsInDB.filter(t => {
        return !tabsToRestoreNotModified.some(tab => t.groupId === tab.groupId && t.url === tab.url && t.cookieStoreId === tab.cookieStoreId);
    });
    if (tabsInDB.length) {
        await Storage.set({ tabsToRestore: tabsInDB });
    } else {
        await Storage.remove('tabsToRestore');
    }

    if (tabsToRestore.length) {
        sendMessage('groups-updated');
    }

    await Promise.all(windows.map(win => loadingBrowserAction(false, win.id)));

    log.stop();
}

async function restoreOldExtensionUrls(parseUrlFunc) {
    let tabs = await browser.tabs.query({
        url: Constants.STG_HELP_PAGES.map(page => `moz-extension://*/help/${page}.html*`),
    });

    await Promise.all(tabs
        .map(async function ({ id, url }) {
            let oldUrl = url;

            if (parseUrlFunc) {
                url = parseUrlFunc(arguments[0]);
            }

            if (!url.startsWith(Constants.STG_BASE_URL) || oldUrl !== url) {
                await browser.tabs.update(id, {
                    url: Constants.STG_BASE_URL + url.slice(Constants.STG_BASE_URL.length),
                    loadReplace: true,
                }).catch(() => { });
            }
        })
    );
}

// { reason: "update", previousVersion: "3.0.1", temporary: true }
// { reason: "install", temporary: true }
browser.runtime.onInstalled.addListener(function ({ reason, previousVersion, temporary }) {
    const log = logger.start('onInstalled', { reason, previousVersion, temporary });

    // browser.runtime.onInstalled.removeListener(onInstalled);

    // if (!self.inited) {
    //     setTimeout(onInstalled, 150, {previousVersion, reason, temporary});
    //     return log.stop('background not inited');
    // }

    if (temporary) {
        self.IS_TEMPORARY = true;
        log.log('addon is temp');
    } else if (
        reason === browser.runtime.OnInstalledReason.INSTALL ||
        (
            reason === browser.runtime.OnInstalledReason.UPDATE &&
            Utils.compareVersions(previousVersion, '5.0') === -1
        )
    ) {
        log.log('open welcome');
        Urls.openUrl('welcome');
    }

    log.stop();
});

async function initializeGroupWindows(windows, currentGroupIds) {
    let tabsToShow = [],
        tabsToHide = [],
        moveTabsToWin = {};

    windows.forEach(function (win) {
        let otherWindows = windows.filter(w => w.id !== win.id),
            duplicateGroupWindows = otherWindows.filter(w => w.groupId && w.groupId === win.groupId);

        if (win.groupId && (!currentGroupIds.includes(win.groupId) || duplicateGroupWindows.length)) {
            duplicateGroupWindows.push(win);

            duplicateGroupWindows.forEach(function (w) {
                delete w.groupId;
                Cache.removeWindowSession(w.id);
            });
        }

        win.tabs.forEach(function (tab) {
            if (tab.groupId && !currentGroupIds.includes(tab.groupId)) {
                delete tab.groupId;
                Cache.removeTabGroup(tab.id);
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
                    if (Utils.isTabLoading(tab) || tab.url.startsWith('file:') || tab.lastAccessed > self.localStorage.START_TIME) {
                        tab.groupId = win.groupId;
                        Cache.setTabGroup(tab.id, win.groupId);
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

        logger.log('[initializeGroupWindows] moveTabsToWin length', moveTabsToWin[windowId].length);
    }

    if (tabsToShow.length) {
        await Tabs.show(tabsToShow);

        tabsToShow.forEach(tab => tab.hidden = false);

        logger.log('[initializeGroupWindows] tabsToShow length', tabsToShow.length);
    }

    if (tabsToHide.length) {
        let activeTabsToHide = tabsToHide.filter(tab => tab.active);

        for (let tabToHide of activeTabsToHide) {
            let visibleTabs = windows.reduce(function (acc, win) {
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

        logger.log('[initializeGroupWindows] tabsToHide length', tabsToHide.length);
    }
}

async function init() {
    const log = logger.start(['info', '[init]']);

    self.localStorage.START_TIME = Date.now();

    try {
        let data = await Storage.getForMigrate();

        const dataChanged = new Set;

        await Containers.init(data.temporaryContainerTitle);

        log.log('containers inited');

        await Management.init();

        log.log('Management inited');

        Management.detectConflictedExtensions();

        const resultMigrate = await runMigrateForData(data);

        if (resultMigrate.migrated) {
            data = resultMigrate.data;
            dataChanged.add(true);
            log.log('runMigrateForData finish');
        } else if (resultMigrate.error) {
            Utils.notify(resultMigrate.error);
            throw '';
        }

        Utils.assignKeys(options, data, Constants.ALL_OPTIONS_KEYS);

        dataChanged.add(Groups.normalizeContainersInGroups(data.groups));

        if (dataChanged.has(true)) {
            log.log('data was changed, save data');
            await Storage.set(data);
        }

        let windows = await Windows.load();

        if (!windows.length) {
            log.error('no windows found');
            window.localStorage.notFoundWindowsAddonStoppedWorking = 1;
            Utils.notify(['notFoundWindowsAddonStoppedWorking']);
            browser.windows.onCreated.addListener(() => browser.runtime.reload());
            throw '';
        } else if (window.localStorage.notFoundWindowsAddonStoppedWorking) {
            log.log('try run grand restore');
            try {
                await Promise.all(windows.map(async win => {
                    grandRestoringPromise = GrandRestoreWindows(win);
                    await grandRestoringPromise;
                    grandRestoringPromise = null;
                }));
            } catch (e) {
                log.runError('cant grand restore', e);
                browser.runtime.reload();
                return;
            }

            log.log('grand restore finish');

            delete window.localStorage.notFoundWindowsAddonStoppedWorking;
        }

        await tryRestoreMissedTabs();

        windows = await Windows.load(true);

        await initializeGroupWindows(windows, data.groups.map(g => g.id));

        await Promise.all(windows.map(async win => {
            await updateBrowserActionData(null, win.id);

            if (win.groupId) {
                groupsHistory.add(win.groupId);
            }
        }));

        let tabs = Utils.concatTabs(windows);

        await Containers.removeUnusedTemporaryContainers(tabs);

        log.log('Containers.removeUnusedTemporaryContainers finish');

        await restoreOldExtensionUrls();

        log.log('restoreOldExtensionUrls finish');

        window.setTimeout(resetAutoBackup, 10000);

        createMoveTabMenus(data.groups);

        log.log('createMoveTabMenus finish');

        addEvents();

        if (Groups.isNeedBlockBeforeRequest(data.groups)) {
            log.log('addListenerOnBeforeRequest');
            addListenerOnBeforeRequest();
        }

        Groups.load(null, true, true).catch(log.onCatch('cant load groups')); // load favIconUrls, speed up first run popup

        if (window.localStorage.isBackupRestoring) {
            delete window.localStorage.isBackupRestoring;
            Utils.notify(['backupSuccessfullyRestored']);
        }

        await setBrowserAction(undefined, undefined, undefined, true);

        self.inited = true;

        // send message for addon pages if it's open
        sendMessage('i-am-back');

        // send message for addon plugins
        sendExternalMessage('i-am-back');

        log.stop();

        // if (self.IS_TEMPORARY && !Logger.logs.some(l => l['console.error'])) {
        //     console.clear();
        // }

        // Urls.openUrl('/popup/popup.html#sidebar');
    } catch (e) {
        setActionToReloadAddon();

        if (e) {
            errorEventHandler.call(log, e);
            log.stopError('with errors');
        } else {
            log.stop(String(e));
        }
    }
}

function setActionToReloadAddon() {
    setBrowserAction(undefined, 'lang:clickHereToReloadAddon', '/icons/exclamation-triangle-yellow.svg', true).catch(() => { });

    browser.browserAction.setPopup({
        popup: '',
    });

    browser.browserAction.onClicked.addListener(() => browser.runtime.reload());
}

browser.browserAction.setBadgeBackgroundColor({
    color: 'transparent',
});

setBrowserAction(undefined, 'loading', undefined, false);

// delay startup to avoid errors with extensions "Facebook Container", "Firefox Multi-Account Containers" etc.
// TransactionInactiveError: A request was placed against a transaction which is currently not active, or which is finished.
// An unexpected error occurred
// etc.

setTimeout(init, 200);
