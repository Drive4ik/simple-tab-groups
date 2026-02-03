
import Listeners, {getExtensionStartTime} from '/js/listeners.js\
?onExtensionStart\
&tabs.onActivated\
&tabs.onCreated\
&tabs.onUpdated=[{"properties":["title","status","favIconUrl","hidden","pinned","discarded","audible"]}]\
&tabs.onRemoved\
&tabs.onMoved\
&tabs.onDetached\
&tabs.onAttached\
&webRequest.onBeforeRequest=[{"urls":["<all_urls>"],"types":["main_frame"]},["blocking"]]\
&windows.onCreated\
&windows.onFocusChanged\
&windows.onRemoved\
&runtime.onConnect\
&runtime.onMessage\
&runtime.onMessageExternal\
&runtime.onInstalled\
&browserAction.onClicked\
&commands.onCommand\
&alarms.onAlarm\
';
import '/js/prefixed-storage.js';
import * as Constants from '/js/constants.js';
import * as Browser from '/js/browser.js';
import * as Messages from '/js/messages.js';
import Logger, {
    catchFunc,
    addLog,
    showLog,
    getLogs,
    clearLogs,
    getErrors,
    clearErrors,
    errorEventHandler,
} from '/js/logger.js';
import {
    objToNativeError
} from '/js/logger-utils.js';
import * as Utils from '/js/utils.js';
import Notification from '/js/notification.js';
import JSON from '/js/json.js';
import BatchProcessor from '/js/batch-processor.js';
import Lang from '/js/lang.js';
import * as Urls from '/js/urls.js';
import * as Containers from '/js/containers.js';
import * as Storage from '/js/storage.js';
import * as Cache from '/js/cache.js';
import * as File from '/js/file.js';
import * as Host from '/js/host.js';
import * as Menus from '/js/menus.js';
import * as Groups from '/js/groups.js';
import * as Tabs from '/js/tabs.js';
import * as Windows from '/js/windows.js';
import * as Management from '/js/management.js';
import * as Bookmarks from '/js/bookmarks.js';
import * as Permissions from '/js/permissions.js';
import * as BrowserSettings from '/js/browser-settings.js';
import * as Cloud from '/js/sync/cloud/cloud.js';

const storage = localStorage.create(Constants.MODULES.BACKGROUND);

delete storage.inited;
storage.IS_TEMPORARY = false;

if (storage.enableDebug === Constants.DEBUG.AUTO) { // if debug was auto-enabled - disable on next start addon/browser
    delete storage.enableDebug;
}

const logger = self.logger = new Logger(Constants.MODULES.BACKGROUND);

self.loggerFuncs = {
    getLogs,
    clearLogs,
    getErrors,
    clearErrors,
};

self.options = {};

let reCreateTabsOnRemoveWindow = [],
    ignoreExtForReopenContainer = new Set([...Constants.SAFE_EXTENSIONS_FOR_REOPEN_TAB_IN_CONTAINER]),

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

// TODO temp
self.CacheTabs = Cache.tabs;
self.CacheLastTabsState = Cache.lastTabsState;
self.CacheWindows = Cache.windows;

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

    let isEnabledTreeTabsExt = Constants.TREE_TABS_EXTENSIONS.some(id => Management.isEnabled(id)),
        oldNewTabIds = {},
        newTabs = [];

    tabs.forEach(function (tab) {
        delete tab.active;
        delete tab.index;
        delete tab.windowId;
    });

    if (tryRestoreOpeners && isEnabledTreeTabsExt && tabs.some(tab => tab.openerTabId)) {
        log.log('tryRestoreOpeners');
        for (const tab of tabs) {
            if (tab.id && tab.openerTabId) {
                tab.openerTabId = oldNewTabIds[tab.openerTabId];
            }

            const newTab = await Tabs.create(tab);

            if (tab.id) {
                oldNewTabIds[tab.id] = newTab.id;
            }

            newTabs.push(newTab);
        }
    } else {
        log.log('creating tabs');
        tabs.forEach(tab => delete tab.openerTabId);
        newTabs = await Promise.all(tabs.map(Tabs.create));
    }

    newTabs = await Tabs.moveNative(newTabs, {
        index: -1,
    });

    if (hideTabs) {
        const tabsToHide = newTabs.filter(tab => !tab.pinned && tab.groupId && !Cache.getWindowId(tab.groupId));

        log.log('hide tabs', tabsToHide);

        await Tabs.hide(tabsToHide, true);
    }

    log.stop();

    return newTabs;
}

function sendExternalMessage(...args) {
    if (!storage.inited) {
        logger.warn('sendExternalMessage addon not yet loaded');
        return;
    }

    const message = Messages.normalizeSendData(...args);

    for (const [exId, params] of Object.entries(Constants.EXTENSIONS_WHITE_LIST)) {
        if (params.postActions?.includes(message.action) && Management.isEnabled(exId)) {
            Messages.sendExternalMessage(exId, message);
        }
    }
}

let _loadingGroupInWindow = new Set; // windowId: true;
async function applyGroup(windowId, groupId, activeTabId, applyFromHistory = false) {
    const log = logger.start('applyGroup', 'groupId:', groupId, 'windowId:', windowId, 'activeTabId:', activeTabId);

    windowId = windowId || await Windows.getLastFocusedNormalWindow();

    if (!windowId) {
        log.stopError('no window was found for applyGroup');
        return false;
    } else if (_loadingGroupInWindow.has(windowId)) {
        log.stopWarn('window in loading state now', windowId);
        return false;
    }

    _loadingGroupInWindow.add(windowId);

    const groupWindowId = Cache.getWindowId(groupId);

    let result = null;

    try {
        const addTabs = [];

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
                Notification(['groupIsArchived', groupToShow.title]);
                throw '';
            }

            if (groupToHide?.tabs.some(Utils.isTabCanNotBeHidden)) {
                Notification('notPossibleSwitchGroupBecauseSomeTabShareMicrophoneOrCamera');
                throw '';
            }

            await Browser.actionLoading();

            // show tabs
            if (groupToShow.tabs.length) {
                if (!groupToShow.tabs.every(tab => tab.windowId === windowId)) {
                    const skippedTabs = skipTabsTracking(groupToShow.tabs);
                    groupToShow.tabs = await Tabs.moveNative(groupToShow.tabs, {
                        index: -1,
                        windowId: windowId,
                    });
                    continueTabsTracking(skippedTabs);
                }

                await Tabs.show(groupToShow.tabs, true);

                if (groupToShow.muteTabsWhenGroupCloseAndRestoreWhenOpen) {
                    await Tabs.setMute(groupToShow.tabs, false);
                }
            }

            // link group with window
            await Cache.setWindowGroup(windowId, groupToShow.id);

            // hide tabs
            await hideTabs(groupToHide?.tabs);

            const activeTabGroupToHide = groupToHide?.tabs.find(tab => tab.active);

            async function hideTabs(tabs = []) {
                await Tabs.hide(tabs, true);

                if (groupToHide) {
                    if (groupToHide.muteTabsWhenGroupCloseAndRestoreWhenOpen) {
                        await Tabs.setMute(tabs, true);
                    }

                    if (groupToHide.discardTabsAfterHide) {
                        if (groupToHide.discardExcludeAudioTabs) {
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

                await Tabs.hide(tabs, true);

                let showNotif = storage.showTabsInThisWindowWereHidden ?? 0;
                if (showNotif < 5) {
                    storage.showTabsInThisWindowWereHidden = ++showNotif;
                    Notification('tabsInThisWindowWereHidden');
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
                            await Cache.setTabGroup(tabs[0].id, groupToShow.id)
                                .catch(log.onCatch(["can't set group", groupToShow.id, tabs[0]], false));
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

            await Browser.actionLoading(false);

            if (!applyFromHistory) {
                groupsHistory.add(groupId);
            }
        }

        sendMessageFromBackground('group-loaded', {
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

            await Browser.actionGroup(null, windowId);

            if (!groupWindowId) {
                self.skipTabs.tracking.clear();
            }
        }
    } finally {
        _loadingGroupInWindow.delete(windowId);
    }

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

const onActivatedTab = function({tabId, windowId, previousTabId = null}) {
    if (self.skipTabs.tracking.has(tabId) || self.skipTabs.tracking.has(previousTabId) || self.skipTabs.removed.has(tabId) || self.skipTabs.removed.has(previousTabId)) {
        return;
    }

    logger.log('onActivated', {tabId, windowId, previousTabId})

    sendMessageFromBackground('tab-updated', {
        tabId: tabId,
        changeInfo: {
            active: true,
        },
    });

    if (previousTabId) {
        sendMessageFromBackground('tab-updated', {
            tabId: previousTabId,
            changeInfo: {
                active: false,
            },
        });
    }
}

const tabsUpdatedBatch = new BatchProcessor(async (groupId) => {
    logger.log('tabsUpdatedBatch', groupId);

    if (groupId === 'unsync') {
        const windows = await Windows.load(true, true, options.showTabsWithThumbnailsInManageGroups);
        sendMessageFromBackground('unsync-tabs-updated', {windows});
    } else {
        const {group} = await Groups.load(groupId, true, true, options.showTabsWithThumbnailsInManageGroups);

        sendMessageFromBackground('tabs-updated', {
            groupId,
            tabs: group.tabs,
        });
    }
});

self.skipTabs = {
    created: new Set,
    tracking: new Set,
    removed: new Set,
};

self.skipTabsTracking = skipTabsTracking;
self.continueTabsTracking = continueTabsTracking;

function skipTabsTracking(tabs, accum = new Set) {
    tabs.forEach(tab => {
        const id = Tabs.extractId(tab);
        self.skipTabs.tracking.add(id);
        accum.add(id);
    });

    return accum;
}

function continueTabsTracking(tabs, accum = null) {
    tabs.forEach(tab => {
        const id = Tabs.extractId(tab);
        self.skipTabs.tracking.delete(id);
        accum?.delete(id);
    });
}

const onCreatedTab = catchFunc(async function onCreatedTab(tab) {
    await Utils.wait(50);

    if (self.skipTabs.created.has(tab.id)) {
        return;
    }

    delete tab.groupId; // TODO tmp

    logger.log('onCreatedTab', tab);

    Cache.setTab(tab);

    if (Utils.isTabPinned(tab)) {
        logger.log('onCreatedTab 🛑 skip pinned tab', tab.id);
        return;
    }

    await Cache.setTabGroup(tab.id, null, tab.windowId)
        .catch(logger.onCatch("onCreatedTab can't set group", false));

    Cache.applyTabSession(tab);

    tabsUpdatedBatch.add(tab.groupId || 'unsync', tab.id);
}, logger);

const onUpdatedTab = catchFunc(async function onUpdatedTab(tabId, changeInfo, tab) {
    if (self.skipTabs.removed.has(tab.id)) {
        return;
    }

    if (self.skipTabs.tracking.has(tab.id)) {
        Cache.setTab(tab);
        return;
    }

    delete tab.groupId; // TODO tmp

    const log = logger.start('onUpdatedTab', tabId, changeInfo);

    changeInfo = Cache.getRealTabStateChanged(tab);

    Cache.setTab(tab);

    if (!changeInfo) {
        log.stop('🛑 changeInfo keys was not changed');
        return;
    }

    if (Utils.isTabPinned(tab) && !changeInfo.hasOwnProperty('pinned')) {
        log.stop('🛑 tab is pinned');
        return;
    }

    if (changeInfo.favIconUrl) {
        await Cache.setTabFavIcon(tab.id, changeInfo.favIconUrl)
            .catch(log.onCatch(['cant set favIcon', tab, changeInfo], false));
    }

    if (changeInfo.hasOwnProperty('pinned') || changeInfo.hasOwnProperty('hidden')) {
        if (changeInfo.pinned || changeInfo.hidden) {
            changeInfo.pinned && log.log('remove group for pinned tab', tab.id);
            changeInfo.hidden && log.log('remove group for hidden tab', tab.id);

            await Cache.removeTabGroup(tab.id).catch(() => {});
        } else if (changeInfo.pinned === false) {
            log.log('tab is unpinned', tab.id);

            await Cache.setTabGroup(tab.id, null, tab.windowId)
                .catch(log.onCatch(["can't set group to tab, !pinned", tab.id], false));
        } else if (changeInfo.hidden === false) {
            log.log('tab is showing', tab.id);

            Cache.applyTabSession(tab);

            if (tab.groupId) {
                log.log('call applyGroup for tab', tab.id, 'groupId', tab.groupId);
                await applyGroup(tab.windowId, tab.groupId, tab.id)
                    .catch(log.onCatch(["can't applyGroup", tab.groupId], false));
            } else {
                log.log('call setTabGroup for tab', tab.id);
                await Cache.setTabGroup(tab.id, null, tab.windowId)
                    .catch(log.onCatch(["can't set group to tab, !hidden", tab.id], false));
            }
        }

        log.stop();
        return;
    }

    sendMessageFromBackground('tab-updated', {
        tabId: tab.id,
        changeInfo,
    });

    if (options.showTabsWithThumbnailsInManageGroups && Utils.isTabLoaded(changeInfo)) {
        await Tabs.updateThumbnail(tab.id);
    }

    log.stop();
}, logger);

function onRemovedTab(tabId, {isWindowClosing, windowId}) {
    const silent = self.skipTabs.removed.has(tabId);

    self.skipTabs.removed.add(tabId); // BUG https://bugzilla.mozilla.org/show_bug.cgi?id=1396758

    const groupId = Cache.getTabGroup(tabId);

    tabsUpdatedBatch.delete(groupId || 'unsync', tabId);

    if (silent) {
        Cache.removeTab(tabId);
        return;
    }

    logger.log('onRemovedTab', tabId, {isWindowClosing, windowId, groupId});

    if (isWindowClosing) {
        reCreateTabsOnRemoveWindow.push(tabId);
    } else {
        Cache.removeTab(tabId);
        sendMessageFromBackground('tab-removed', {
            tabId,
            groupId,
        });
    }
}

function onMovedTab(tabId) {
    if (self.skipTabs.tracking.has(tabId) || self.skipTabs.removed.has(tabId)) {
        return;
    }

    const groupId = Cache.getTabGroup(tabId);

    logger.log('onMovedTab', {tabId, groupId});

    tabsUpdatedBatch.add(groupId || 'unsync', tabId);

    /*
    if (Cache.getTabGroup(tabId)) {
        clearTimeout(openerTabTimer);
        openerTabTimer = setTimeout(() => Tabs.get().catch(() => {}), 500); // load visible tabs of current window for set openerTabId
    } */
}

async function onDetachedTab(tabId, {oldWindowId}) { // notice: called before onAttached
    if (self.skipTabs.tracking.has(tabId) || self.skipTabs.removed.has(tabId)) {
        return;
    }

    const groupId = Cache.getWindowGroup(oldWindowId);

    logger.log('onDetachedTab', {tabId, oldWindowId, groupId});

    tabsUpdatedBatch.add(groupId || 'unsync', tabId);
}

async function onAttachedTab(tabId, {newWindowId}) { // called when tabs.move()
    if (self.skipTabs.tracking.has(tabId) || self.skipTabs.removed.has(tabId)) {
        return;
    }

    const log = logger.start('onAttachedTab', {tabId, newWindowId});

    await Cache.setTabGroup(tabId, null, newWindowId)
        .catch(log.onCatch("can't set group"));

    const groupId = Cache.getTabGroup(tabId);

    log.log('attached tab groupId', groupId);

    tabsUpdatedBatch.add(groupId || 'unsync', tabId);

    log.stop();
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

    const log = logger.start('GrandRestoreWindows restore windows:', Array.from(windowIdsForRestoring));

    let [
        windows,
        { groups },
        { tabsToRestore = [] }
    ] = await Promise.all([
        Windows.load(true),
        Groups.load(),
        Storage.get('tabsToRestore')
    ]);

    await Browser.actionLoading();

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
    const skippedTabs = new Set;
    for (let groupToKeep of groupsAlreadyRestored.values()) {
        if (!groupToKeep.tabs.some(tab => tab.windowId !== groupToKeep.window.id)) {
            continue;
        }

        skipTabsTracking(groupToKeep.tabs, skippedTabs);

        groupToKeep.tabs = await Tabs.moveNative(groupToKeep.tabs, {
            windowId: groupToKeep.window.id,
            index: -1,
        });

        if (groupToKeep.window.groupId === groupToKeep.id) {
            await Tabs.show(groupToKeep.tabs);

            if (groupToKeep.deleteTabAfterMove) {
                await Tabs.setActive(null, groupToKeep.tabs.filter(tab => !tabsToDelete.has(tab.id)));
                await Tabs.remove(groupToKeep.deleteTabAfterMove, true);
            }
        } else {
            await Tabs.hide(groupToKeep.tabs);
        }
    }
    continueTabsTracking(skippedTabs);

    await Tabs.remove(Array.from(tabsToDelete.keys()));

    if (tabsToRestoreChanged) {
        if (tabsToRestore.length) {
            await Storage.set({ tabsToRestore });
        } else {
            needRestoreMissedTabsMap?.clear();
            await Storage.remove('tabsToRestore');
        }
    }

    await Browser.actionLoading(false);

    windowIdsForRestoring.clear();

    log.stop();
}

const onCreatedWindow = catchFunc(async function onCreatedWindow(win) {
    const log = logger.start(['info', 'onCreatedWindow'], win.id, 'skip created:', self.skipAddGroupToNextNewWindow);

    Cache.setWindow(win);

    if (self.skipAddGroupToNextNewWindow) {
        self.skipAddGroupToNextNewWindow = false;
        log.stop();
        return;
    }

    if (!Utils.isWindowAllow(win)) {
        log.stop('window is not allow');
        return;
    }

    await Browser.actionLoading();

    log.log('start grand restore for', win.id);

    // для того чтоб один раз вызвалось tryRestoreMissedTabs
    let needRestoreMissedTabsMap = new Map;

    grandRestoringPromise = GrandRestoreWindows(win, needRestoreMissedTabsMap);
    try {
        await grandRestoringPromise;
        grandRestoringPromise = null;
    } catch (e) {
        grandRestoringPromise = null;
        log.logError('GrandRestoreWindows', e);
        log.stopError();
        return;
    }

    log.log('grand restore for', win.id, 'finish');

    win = await Windows.get(win.id).catch(log.onCatch(['window not found', win], false));

    if (!win) {
        log.stopError('window not found');
        return;
    }

    if (!win.groupId && options.createNewGroupWhenOpenNewWindow) {
        log.log('create new group into window', win.id);
        if (!await Groups.add(win.id)) {
            await Browser.actionLoading(false);
        }
    } else {
        await Browser.actionLoading(false);
    }

    if (needRestoreMissedTabsMap.get(win.id)) {
        log.log('run tryRestoreMissedTabs');
        await tryRestoreMissedTabs().catch(log.onCatch('tryRestoreMissedTabs'));
    }

    log.stop();
}, logger);

function onFocusChangedWindow(windowId) {
    !storage.IS_TEMPORARY && logger.log('onFocusChangedWindow', windowId);

    if (browser.windows.WINDOW_ID_NONE !== windowId && options.showContextMenuOnTabs) {
        Menus.update('set-tab-icon-as-group-icon', {
            enabled: Boolean(Cache.getWindowGroup(windowId)),
        }).catch(() => {});
    }
}

const onRemovedWindow = catchFunc(async function onRemovedWindow(windowId) {
    const log = logger.start(['info', 'onRemovedWindow'], windowId);

    let groupId = Cache.getWindowGroup(windowId);

    if (groupId) {
        sendMessageFromBackground('window-closed', { windowId });
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
}, logger);

async function updateMoveTabMenus() {
    const log = logger.start('updateMoveTabMenus');

    const menusToRemove = [
        Menus.ContextType.BOOKMARK,
        Menus.ContextType.TAB,
        Menus.ContextType.LINK,
        'exportAllGroupsToBookmarks',
        'reopenTabsWithTemporaryContainersInNew',
    ];

    for (const id of menusToRemove) {
        if (Menus.has(id)) {
            await Menus.remove(id);
        }
    }

    const hasBookmarksPermission = await Bookmarks.hasPermission();

    if (!options.showContextMenuOnTabs && !options.showContextMenuOnLinks && !hasBookmarksPermission) {
        log.stop('there are no menu creation permissions/options');
        return;
    }

    const {groups} = await Groups.load();

    hasBookmarksPermission && await Menus.create({
        id: Menus.ContextType.BOOKMARK,
        title: Lang('openBookmarkInGroup'),
        contexts: [Menus.ContextType.BOOKMARK],
    });

    options.showContextMenuOnTabs && await Menus.create({
        id: Menus.ContextType.TAB,
        title: Lang('moveTabToGroupDisabledTitle'),
        contexts: [Menus.ContextType.TAB],
    });

    options.showContextMenuOnLinks && await Menus.create({
        id: Menus.ContextType.LINK,
        title: Lang('openLinkInGroupDisabledTitle'),
        contexts: [Menus.ContextType.LINK],
    });

    options.showContextMenuOnTabs && await Menus.create({
        title: Containers.TEMPORARY.name,
        icon: Containers.TEMPORARY.iconUrl,
        parentId: Menus.ContextType.TAB,
        contexts: [Menus.ContextType.TAB],
        async onClick(info, tab) {
            if (!Utils.isUrlAllowToCreate(tab.url)) {
                Notification(['thisUrlsAreNotSupported', tab.url]);
                return;
            }

            await Tabs.create({
                ...tab,
                active: info.button.RIGHT,
                cookieStoreId: Constants.TEMPORARY_CONTAINER,
            });
        },
    });

    options.showContextMenuOnTabs && await Menus.create({
        id: 'set-tab-icon-as-group-icon',
        title: Lang('setTabIconAsGroupIcon'),
        icon: '/icons/image.svg',
        parentId: Menus.ContextType.TAB,
        contexts: [Menus.ContextType.TAB],
        async onClick(info, tab) {
            const groupId = Cache.getWindowGroup(tab.windowId);

            if (!groupId) {
                Menus.update(info.menuItemId, {enabled: false});
                return;
            }

            Cache.applyTabSession(tab);

            tab = Utils.normalizeTabFavIcon(tab);

            await Groups.setIconUrl(groupId, tab.favIconUrl);
        },
    });

    options.showContextMenuOnTabs && groups.length && await Menus.create({
        type: Menus.ItemType.SEPARATOR,
        parentId: Menus.ContextType.TAB,
        contexts: [Menus.ContextType.TAB],
    });

    options.showContextMenuOnLinks && await Menus.create({
        title: Containers.TEMPORARY.name,
        icon: Containers.TEMPORARY.iconUrl,
        parentId: Menus.ContextType.LINK,
        contexts: [Menus.ContextType.LINK],
        async onClick(info) {
            if (!Utils.isUrlAllowToCreate(info.linkUrl)) {
                return;
            }

            if (!Utils.isUrlAllowToCreate(info.linkUrl)) {
                Notification(['thisUrlsAreNotSupported', info.linkUrl]);
                return;
            }

            await Tabs.create({
                url: info.linkUrl,
                title: info.linkText,
                active: info.button.RIGHT,
                cookieStoreId: Constants.TEMPORARY_CONTAINER,
            });
        },
    });

    options.showContextMenuOnLinks && groups.length && await Menus.create({
        type: Menus.ItemType.SEPARATOR,
        parentId: Menus.ContextType.LINK,
        contexts: [Menus.ContextType.LINK],
    });

    hasBookmarksPermission && await Menus.create({
        title: Containers.TEMPORARY.name,
        icon: Containers.TEMPORARY.iconUrl,
        parentId: Menus.ContextType.BOOKMARK,
        contexts: [Menus.ContextType.BOOKMARK],
        async onClick(info) {
            if (!info.bookmarkId) {
                Notification('bookmarkNotAllowed');
                return;
            }

            const [bookmark] = await browser.bookmarks.get(info.bookmarkId);

            if (bookmark.type !== browser.bookmarks.BookmarkTreeNodeType.BOOKMARK) {
                Notification('bookmarkNotAllowed');
                return;
            }

            if (!Utils.isUrlAllowToCreate(bookmark.url)) {
                Notification(['thisUrlsAreNotSupported', bookmark.url]);
                return;
            }

            await Tabs.create({
                url: bookmark.url,
                title: bookmark.title,
                active: info.button.RIGHT,
                cookieStoreId: Constants.TEMPORARY_CONTAINER,
            });
        },
    });

    hasBookmarksPermission && groups.length && await Menus.create({
        type: Menus.ItemType.SEPARATOR,
        parentId: Menus.ContextType.BOOKMARK,
        contexts: [Menus.ContextType.BOOKMARK],
    });

    for (const group of groups) {
        if (group.isArchive) {
            continue;
        }

        const groupId = group.id,
            groupIcon = Groups.getIconUrl(group),
            groupTitle = String(Groups.getTitle(group, 'withSticky withActiveGroup withContainer'));

        options.showContextMenuOnTabs && await Menus.create({
            title: groupTitle,
            icon: groupIcon,
            parentId: Menus.ContextType.TAB,
            contexts: [Menus.ContextType.TAB],
            async onClick(info, tab) {
                const tabIds = await Tabs.getHighlightedIds(tab.windowId, tab);

                await Tabs.move(tabIds, groupId, {
                    showTabAfterMovingItIntoThisGroup: info.button.RIGHT,
                });

                if (!info.button.RIGHT && info.modifiers.includes('Ctrl')) { // todo make util for modifier with MAC
                    await Tabs.discard(tabIds);
                }
            },
        });

        options.showContextMenuOnLinks && await Menus.create({
            title: groupTitle,
            icon: groupIcon,
            parentId: Menus.ContextType.LINK,
            contexts: [Menus.ContextType.LINK],
            async onClick(info) {
                if (!Utils.isUrlAllowToCreate(info.linkUrl)) {
                    Notification(['thisUrlsAreNotSupported', info.linkUrl]);
                    return;
                }

                const newTab = await Tabs.add(groupId, undefined, info.linkUrl, info.linkText);

                if (info.button.RIGHT) {
                    await applyGroup(newTab.windowId, groupId, newTab.id);
                }
            },
        });

        hasBookmarksPermission && await Menus.create({
            title: groupTitle,
            icon: groupIcon,
            parentId: Menus.ContextType.BOOKMARK,
            contexts: [Menus.ContextType.BOOKMARK],
            async onClick(info) {
                if (!info.bookmarkId) {
                    Notification('bookmarkNotAllowed');
                    return;
                }

                await Browser.actionLoading();

                const [bookmark] = await browser.bookmarks.getSubTree(info.bookmarkId);
                const tabsToCreate = [];

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
                    const {group} = await Groups.load(groupId);
                    const [firstTab] = await createTabsSafe(Groups.setNewTabsParams(tabsToCreate, group));

                    await Browser.actionLoading(false);

                    if (info.button.RIGHT) {
                        await applyGroup(undefined, groupId, firstTab.id);
                    } else {
                        Notification(['tabsCreatedCount', tabsToCreate.length]);
                    }
                } else {
                    await Browser.actionLoading(false);
                    Notification('tabsNotCreated');
                }
            },
        });
    }

    options.showContextMenuOnTabs && await Menus.create({
        title: Lang('createNewGroup'),
        icon: '/icons/group-new.svg',
        parentId: Menus.ContextType.TAB,
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
    });

    options.showContextMenuOnLinks && await Menus.create({
        title: Lang('createNewGroup'),
        icon: '/icons/group-new.svg',
        parentId: Menus.ContextType.LINK,
        contexts: [Menus.ContextType.LINK],
        async onClick(info) {
            if (!Utils.isUrlAllowToCreate(info.linkUrl)) {
                Notification(['thisUrlsAreNotSupported', info.linkUrl]);
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
    });

    hasBookmarksPermission && await Menus.create({
        title: Lang('createNewGroup'),
        icon: '/icons/group-new.svg',
        parentId: Menus.ContextType.BOOKMARK,
        contexts: [Menus.ContextType.BOOKMARK],
        async onClick(info) {
            if (!info.bookmarkId) {
                Notification('bookmarkNotAllowed');
                return;
            }

            let [bookmark] = await browser.bookmarks.get(info.bookmarkId);

            if (bookmark.type === browser.bookmarks.BookmarkTreeNodeType.BOOKMARK) {
                if (!Utils.isUrlAllowToCreate(bookmark.url)) {
                    Notification('bookmarkNotAllowed');
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

                await Browser.actionLoading();
                await addBookmarkFolderAsGroup(folder);
                await Browser.actionLoading(false);

                if (groupsCreatedCount) {
                    Notification(['groupsCreatedCount', groupsCreatedCount]);
                } else {
                    Notification('noGroupsCreated');
                }
            } else {
                Notification('bookmarkNotAllowed');
            }
        },
    });

    hasBookmarksPermission && await Menus.create({
        id: 'exportAllGroupsToBookmarks',
        title: Lang('exportAllGroupsToBookmarks'),
        icon: '/icons/bookmark.svg',
        contexts: [Menus.ContextType.BROWSER_ACTION],
        async onClick() {
            await Browser.actionLoading();

            const {groups} = await Groups.load(null, true);

            await Bookmarks.exportGroups(groups);

            await Browser.actionLoading(false);

            // Notification('allGroupsExportedToBookmarks'); // ? maybe not needed anymore
        },
    });

    await Menus.create({
        id: 'reopenTabsWithTemporaryContainersInNew',
        title: Lang('reopenTabsWithTemporaryContainersInNew'),
        icon: Containers.TEMPORARY.iconUrl,
        contexts: [Menus.ContextType.BROWSER_ACTION],
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
                await Browser.actionLoading();

                const newTabs = await Promise.all(tabsToCreate.map(Tabs.create));

                const tabsToHide = newTabs.filter(tab => tab.groupId && !Cache.getWindowId(tab.groupId));

                await Tabs.hide(tabsToHide, true);

                // remove old tabs
                await Tabs.remove(tabsIdsToRemove);

                // remove temporary containers
                if (info.button.RIGHT) {
                    await Containers.removeUnusedTemporaryContainers(newTabs);
                }

                await Browser.actionLoading(false);
            }
        },
    });

    log.stop();
}

const moveTabsBatch = new BatchProcessor(async (groupId, tabIds) => {
    const log = logger.start('moveTabsBatch', {groupId, tabIds});
    await Tabs.move(tabIds, groupId).catch(log.onCatch('moveTabsBatch'));
    log.stop();
});

const canceledRequests = new Set;
const onBeforeTabRequest = catchFunc(async function onBeforeTabRequest({tabId, url, cookieStoreId, originUrl, requestId, frameId}) {
    const log = logger.start('onBeforeTabRequest', {tabId, url, cookieStoreId, originUrl, requestId, frameId});

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

    if (self.skipTabs.tracking.has(tabId)) {
        log.stop('🛑 tab was skiped from tracking', {tabId, url, originUrl});
        return {};
    }

    if (!Cache.getTabGroup(tabId)) {
        log.stop("tab doesn't have a group", {tabId, url, originUrl});
        return {};
    }

    log.log({tabId, url, originUrl});

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
            Cache.removeTabThumbnail(tab.id).catch(() => {});
        }

        tab.url = url;
        tab.status = browser.tabs.TabStatus.COMPLETE;
        Cache.setTab(tab);

        moveTabsBatch.add(destGroup.id, tab.id);
        log.stop('move tab from groupId:', tabGroup.id, 'to groupId:', destGroup.id);
        return {};
    }

    const newTabContainer = Tabs.getNewTabContainer(tab, tabGroup);

    if (tab.cookieStoreId === newTabContainer) {
        log.stop('cookieStoreId is equal');
        return {};
    }

    const originExt = Management.getExtensionByUUID(Management.extractUUID(originUrl)) || {};

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

        return Urls.setUrlSearchParams(Urls.getURL('open-in-container', true), params);
    }

    if (Constants.CONFLICTED_EXTENSIONS_FOR_REOPEN_TAB_IN_CONTAINER.includes(originExt.id) && originExt.enabled) {
        let showNotif = storage.ignoreExtensionsForReopenTabInContainer ?? 0;

        if (showNotif < 3) {
            storage.ignoreExtensionsForReopenTabInContainer = ++showNotif;

            const str = Lang('__MSG_helpPageOpenInContainerMainTitle__\n\n__MSG_clickHereForInfo__', {
                helpPageOpenInContainerMainTitle: Containers.get(newTabContainer).name,
            }, {html: false});

            Notification(str, {
                module: ['tabs', 'create', {
                    active: true,
                    url: getNewAddonTabUrl(true),
                    groupId: tabGroup.id,
                }],
            });
        }

        log.stop('deny reopen tab in required conteiner by extension', originExt.id);
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
            Tabs.hide(newTab, true);
        }
    });

    log.stop('reopen tab');
    return {
        cancel: true,
    };
}, logger);

const onPermissionsAdded = catchFunc(async function onPermissionsAdded(permissions) {
    const log = logger.start('onPermissionsAdded', permissions);

    if (Permissions.hasAny(permissions, Permissions.BOOKMARKS)) {
        await updateMoveTabMenus();
    }

    if (Permissions.hasAny(permissions, Permissions.BROWSER_SETTINGS)) {
        await BrowserSettings.set(options.browserSettings);
    }

    log.stop();
}, logger);

const onPermissionsRemoved = catchFunc(async function onPermissionsRemoved(permissions) {
    const log = logger.start('onPermissionsRemoved', permissions);

    if (Permissions.hasAny(permissions, Permissions.NATIVE_MESSAGING)) {
        if (options.autoBackupLocation === Constants.AUTO_BACKUP_LOCATIONS.HOST) {
            await saveOptions({
                autoBackupLocation: Constants.AUTO_BACKUP_LOCATIONS.DOWNLOADS,
            });
        }
    }

    log.stop();
}, logger);

async function onAlarm({name}) {
    const log = logger.start('onAlarm', {name});

    if (name === LOCAL_BACKUP_ALARM_NAME) {
        await createBackup(options.autoBackupIncludeTabFavIcons, options.autoBackupIncludeTabThumbnails, true)
            .catch(log.onCatch(["can't createBackup()", {
                autoBackupIncludeTabFavIcons: options.autoBackupIncludeTabFavIcons,
                autoBackupIncludeTabThumbnails: options.autoBackupIncludeTabThumbnails,
            }]));
    } else if (name === CLOUD_SYNC_ALARM_NAME) {
        await cloudSync(true)
            .catch(log.onCatch("can't cloudSync(true)"));
    }

    log.stop();
}

// wait for reload addon if found update
// Listeners.runtime.onUpdateAvailable(() => Utils.safeReloadAddon());

function addListenerOnBeforeRequest() {
    logger.log('addListenerOnBeforeRequest');
    Listeners.webRequest.onBeforeRequest(onBeforeTabRequest);
}

function removeListenerOnBeforeRequest() {
    logger.log('removeListenerOnBeforeRequest');
    Listeners.webRequest.onBeforeRequest();
}

function addEvents() {
    logger.info('addEvents');

    Listeners.tabs.onActivated(onActivatedTab);
    Listeners.tabs.onCreated(onCreatedTab);
    Listeners.tabs.onUpdated(onUpdatedTab);
    Listeners.tabs.onRemoved(onRemovedTab);
    Listeners.tabs.onMoved(onMovedTab);
    Listeners.tabs.onDetached(onDetachedTab);
    Listeners.tabs.onAttached(onAttachedTab);

    Listeners.windows.onCreated(onCreatedWindow);
    Listeners.windows.onFocusChanged(onFocusChangedWindow);
    Listeners.windows.onRemoved(onRemovedWindow);

    Permissions.onAdded(onPermissionsAdded);
    Permissions.onRemoved(onPermissionsRemoved);

    Listeners.alarms.onAlarm(onAlarm);
}

function removeEvents() {
    logger.info('removeEvents');

    Listeners.tabs.onActivated();
    Listeners.tabs.onCreated();
    Listeners.tabs.onUpdated();
    Listeners.tabs.onRemoved();
    Listeners.tabs.onMoved();
    Listeners.tabs.onDetached();
    Listeners.tabs.onAttached();

    Listeners.windows.onCreated();
    Listeners.windows.onFocusChanged();
    Listeners.windows.onRemoved();

    Permissions.onAdded();
    Permissions.onRemoved();

    Listeners.alarms.onAlarm();

    removeListenerOnBeforeRequest();
}

// window.addEventListener('unload', removeEvents);

self.sendMessageFromBackground = Messages.sendMessageFromBackground;

Listeners.runtime.onConnect(Messages.createListenerOnConnectedBackground(onBackgroundMessage));
Listeners.runtime.onMessage(onBackgroundMessage);
Listeners.commands.onCommand(name => onBackgroundMessage(name, self));

Listeners.runtime.onMessageExternal(async function onMessageExternal(request, sender) {
    const log = logger.start(['info', 'onMessageExternal'], `RECEIVED-EXTERNAL-ACTION#${request?.action}`, { request, sender });

    if (request?.action === 'ignore-ext-for-reopen-container') {
        ignoreExtForReopenContainer.add(sender.id);
        log.stop('add to ignore', sender.id, 'done');
        return {
            ok: true,
        };
    }

    if (!storage.inited) {
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
    'BG.cloudSync',
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
            result.ok = storage.inited === true;
            return result;

        case 'save-log':
            addLog(data.log);
            showLog.call(data.logger, data.log, data.options);
            result.ok = true;
            return result;

        case 'show-error-notification':
            sendMessageFromBackground('show-error-notification');

            Notification('whatsWrongMessage', {
                iconUrl: '/icons/exclamation-triangle-yellow.svg',
                module: 'urls@openDebugPage',
                expires: Notification.MAX_EXPIRES,
            });

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
        const [moduleName, funcName] = data.action.split('.');

        if (INTERNAL_MODULES_NAMES.has(moduleName) || INTERNAL_MODULES_NAMES.has(data.action)) {
            logger.info('onBackgroundMessage internal module', `ACTION#${data.action}`);

            try {
                return await INTERNAL_MODULES[moduleName][funcName](...data.args);
            } catch (e) {
                logger.throwError([
                    'onBackgroundMessage call internal module:', `ACTION#${data.action}`,
                    'args:', data.args,
                    // 'sender:', senderToLogs,
                    objToNativeError(data.breadcrumbs),
                ], e);
            }
        }
    }

    const log = logger.start(
        ['info', 'onBackgroundMessage'],
        ...(isSTGMessage ? [`ACTION#${data.action}`] : [sender.id, `RECEIVED-EXTERNAL-ACTION#${data.action}`, data])
    );

    try {
        const currentWindow = await Windows.getLastFocusedNormalWindow(false);

        if (!currentWindow) {
            throw new Error('no windows found');
        }

        const {
            group: currentGroup,
            groups,
            notArchivedGroups,
        } = await Groups.load(currentWindow.groupId);

        if (data.windowId === browser.windows.WINDOW_ID_CURRENT) {
            data.windowId = currentWindow.id;
        }

        log.log('check action, data:', data);

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
                {
                    const { notArchivedGroups } = await Groups.load(null, true);
                    result.ok = await applyGroupByPosition('next', notArchivedGroups.filter(group => group.tabs.length), currentGroup?.id);
                }
                break;
            case 'load-prev-non-empty-group':
                {
                    const { notArchivedGroups } = await Groups.load(null, true);
                    result.ok = await applyGroupByPosition('prev', notArchivedGroups.filter(group => group.tabs.length), currentGroup?.id);
                }
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
                if (data.groupId === 'new') {
                    let {ok, group} = await onBackgroundMessage({
                        action: 'add-new-group',
                        proposalTitle: data.title,
                    }, sender);

                    if (ok) {
                        result.ok = await applyGroup(currentWindow.id, group.id);
                    }
                } else if (data.groupId) {
                    let groupToLoad = groups.find(group => group.id === data.groupId);

                    if (groupToLoad) {
                        if (groupToLoad.isArchive) {
                            result.error = Lang('groupIsArchived', groupToLoad.title);
                            Notification(result.error);
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
                } else {
                    let activeTab = await Tabs.getActive();

                    if (Tabs.isCanSendMessage(activeTab)) {
                        Tabs.sendMessage(activeTab.id, {
                            action: 'show-groups-popup',
                            popupAction: 'load-custom-group',
                            popupTitle: Lang('hotkeyActionTitleLoadCustomGroup'),
                            groups: notArchivedGroups.map(Groups.mapForExternalExtension),
                            disableGroupIds: [currentGroup?.id].filter(Boolean),
                        });

                        result.ok = true;
                    } else {
                        result.error = Lang('impossibleToAskUserAboutAction', [
                            activeTab.title,
                            Lang('hotkeyActionTitleLoadCustomGroup'),
                        ]);
                        Notification(result.error, {
                            module: 'urls@openNotSupportedUrlHelper',
                        });
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
                    const newGroup = await Groups.add(data.windowId, data.tabIds, data.title);

                    result.ok = true;
                    result.group = Groups.mapForExternalExtension(newGroup);
                } else {
                    const activeTab = await Tabs.getActive();
                    const {defaultGroupProps} = await Groups.getDefaults();
                    data.proposalTitle = Groups.createTitle(data.proposalTitle, null, defaultGroupProps);

                    if (Tabs.isCanSendMessage(activeTab)) {
                        const title = await Tabs.sendMessage(activeTab.id, {
                            action: 'show-prompt',
                            promptTitle: Lang('createNewGroup'),
                            value: data.proposalTitle,
                        });

                        if (title) {
                            result = await onBackgroundMessage({
                                action: 'add-new-group',
                                title: title,
                                tabIds: data.tabIds,
                                windowId: data.windowId,
                            }, sender);
                        } else {
                            result.error = 'title is empty - skip create group';
                        }
                    } else {
                        result = await onBackgroundMessage({
                            action: 'add-new-group',
                            title: data.proposalTitle,
                            tabIds: data.tabIds,
                            windowId: data.windowId,
                        }, sender);

                        if (options.alwaysAskNewGroupName) {
                            result.error = Lang('impossibleToAskUserAboutAction', [
                                activeTab.title,
                                Lang('createNewGroup'),
                            ]);
                            Notification(result.error, {
                                module: 'urls@openNotSupportedUrlHelper',
                            });
                        }
                    }
                }
                break;
            case 'rename-group':
                if (!groups.length) {
                    result.error = Lang('noGroupsAvailable');
                    Notification(result.error);
                } else if (!data.groupId) {
                    let activeTab = await Tabs.getActive();

                    if (Tabs.isCanSendMessage(activeTab)) {
                        Tabs.sendMessage(activeTab.id, {
                            action: 'show-groups-popup',
                            popupAction: 'rename-group',
                            popupTitle: Lang('hotkeyActionTitleRenameGroup'),
                            groups: groups.map(Groups.mapForExternalExtension),
                            focusedGroupId: currentGroup?.id,
                            disableNewGroupItem: true,
                        });

                        result.ok = true;
                    } else {
                        result.error = Lang('impossibleToAskUserAboutAction', [
                            activeTab.title,
                            Lang('hotkeyActionTitleRenameGroup'),
                        ]);
                        Notification(result.error, {
                            module: 'urls@openNotSupportedUrlHelper',
                        });
                    }
                } else if (data.groupId && !data.title) {
                    let groupToRename = groups.find(group => group.id === data.groupId);

                    if (groupToRename) {
                        let activeTab = await Tabs.getActive();

                        if (Tabs.isCanSendMessage(activeTab)) {
                            let title = await Tabs.sendMessage(activeTab.id, {
                                action: 'show-prompt',
                                promptTitle: Lang('hotkeyActionTitleRenameGroup'),
                                value: groupToRename.title,
                            });

                            if (title) {
                                data.title = title;
                                result = await onBackgroundMessage(data, sender);
                            } else {
                                result.error = 'title in empty - skip rename group';
                            }
                        } else {
                            result.error = Lang('impossibleToAskUserAboutAction', [
                                activeTab.title,
                                Lang('hotkeyActionTitleRenameGroup'),
                            ]);
                            Notification(result.error, {
                                module: 'urls@openNotSupportedUrlHelper',
                            });
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
                if (!await Bookmarks.hasPermission()) {
                    result.error = Lang('noAccessToBookmarks');
                    break;
                }

                if (data.groupId) {
                    const {
                        group: groupToExport,
                        groupIndex,
                    } = await Groups.load(data.groupId, true);

                    if (groupToExport) {
                        await Browser.actionLoading();
                        result.ok = await Bookmarks.exportGroup(groupToExport, groupIndex);
                        await Browser.actionLoading(false);

                        if (data.showMessages) {
                            Notification(['groupExportedToBookmarks', groupToExport.title]);
                        }
                    } else {
                        // delete data.groupId;
                        result.error = Lang('groupNotFound');
                    }
                }

                if (!data.groupId) {
                    let activeTab = await Tabs.getActive();

                    if (Tabs.isCanSendMessage(activeTab)) {
                        Tabs.sendMessage(activeTab.id, {
                            action: 'show-groups-popup',
                            popupAction: 'export-group-to-bookmarks',
                            popupTitle: Lang('exportGroupToBookmarks'),
                            groups: groups.map(Groups.mapForExternalExtension),
                            focusedGroupId: currentGroup?.id,
                            disableNewGroupItem: true,
                        });

                        result.ok = true;
                    } else {
                        result.error = Lang('impossibleToAskUserAboutAction', [
                            activeTab.title,
                            Lang('hotkeyActionTitleRenameGroup'),
                        ]);
                        Notification(result.error, {
                            module: 'urls@openNotSupportedUrlHelper',
                        });
                    }
                }
                break;
            case 'remove-group-from-bookmarks':
                if (!await Bookmarks.hasPermission()) {
                    result.error = Lang('noAccessToBookmarks');
                    break;
                }

                if (data.groupId) {
                    const {group} = await Groups.load(data.groupId);

                    if (group) {
                        await Browser.actionLoading();
                        result.ok = await Bookmarks.removeGroup(group);
                        await Browser.actionLoading(false);
                    } else {
                        result.error = Lang('groupNotFound');
                    }
                } else {
                    result.error = Lang('groupNotFound');
                }
                break;
            case 'delete-current-group':
                if (currentGroup) {
                    await Groups.remove(currentGroup.id);

                    if (!isSTGMessage && sender?.id) {
                        Notification([
                            'groupRemovedByExtension',
                            currentGroup.title,
                            Utils.getSupportedExternalExtensionName(sender.id),
                        ]);
                    }

                    result.ok = true;
                } else {
                    result.error = Lang('windowNotHaveGroup');
                }

                break;
            case 'open-manage-groups':
                await Urls.openManageGroups();
                result.ok = true;
                break;
            case 'open-options-page':
                await Urls.openOptionsPage(data.section);
                result.ok = true;
                break;
            case 'move-selected-tabs-to-custom-group':
                let activeTab = await Tabs.getActive(),
                    tabIds = await Tabs.getHighlightedIds(activeTab.windowId, undefined, null);

                if (data.groupId === 'new') {
                    let {ok} = await onBackgroundMessage({
                        action: 'add-new-group',
                        title: data.title,
                        proposalTitle: activeTab.title,
                        tabIds: tabIds,
                    }, sender);

                    result.ok = ok;
                } else if (data.groupId) {
                    let groupMoveTo = groups.find(group => group.id === data.groupId);

                    if (groupMoveTo) {
                        if (groupMoveTo.isArchive) {
                            result.error = Lang('groupIsArchived', groupMoveTo.title);
                            Notification(result.error);
                        } else {
                            await Tabs.move(tabIds, data.groupId);
                            result.ok = true;
                        }
                    } else {
                        delete data.groupId;
                        result = await onBackgroundMessage(data, sender);
                    }
                } else {
                    if (Tabs.isCanSendMessage(activeTab)) {
                        Tabs.sendMessage(activeTab.id, {
                            action: 'show-groups-popup',
                            popupAction: data.action,
                            popupTitle: Lang('hotkeyActionTitleMoveSelectedTabsToCustomGroup'),
                            groups: notArchivedGroups.map(Groups.mapForExternalExtension),
                            focusedGroupId: activeTab.groupId,
                        });

                        result.ok = true;
                    } else {
                        result.error = Lang('impossibleToAskUserAboutAction', [
                            activeTab.title,
                            Lang('hotkeyActionTitleMoveSelectedTabsToCustomGroup'),
                        ]);
                        Notification(result.error, {
                            module: 'urls@openNotSupportedUrlHelper',
                        });
                    }
                }
                break;
            case 'discard-group':
                {
                    const { groups, notArchivedGroups } = await Groups.load(null, true);

                    let groupToDiscard = groups.find(group => group.id === data.groupId);

                    if (groupToDiscard) {
                        if (groupToDiscard.isArchive) {
                            result.error = Lang('groupIsArchived', groupToDiscard.title);
                            Notification(result.error);
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
                                popupTitle: Lang('hotkeyActionTitleDiscardGroup'),
                                groups: notArchivedGroups.map(Groups.mapForExternalExtension),
                                focusedGroupId: currentGroup?.id,
                                disableNewGroupItem: true,
                            });

                            result.ok = true;
                        } else {
                            result.error = Lang('impossibleToAskUserAboutAction', [
                                activeTab.title,
                                Lang('hotkeyActionTitleDiscardGroup'),
                            ]);
                            Notification(result.error, {
                                module: 'urls@openNotSupportedUrlHelper',
                            });
                        }
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
                await Tabs.create({
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

                if (!group || !data.cookieStoreId || Containers.get(data.cookieStoreId).cookieStoreId !== data.cookieStoreId) {
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
            case 'get-startup-data':
                {
                    const includeThumbnail = data.manage
                        ? options.showTabsWithThumbnailsInManageGroups
                        : false;

                    [
                        result.windows,
                        {groups: result.groups},
                    ] = await Promise.all([
                        Windows.load(true, true, includeThumbnail),
                        Groups.load(null, true, true, includeThumbnail),
                    ]);

                    result.ok = true;
                }

                break;
            default:
                throw Error(`Action '${data.action}' is wrong`);
        }

    } catch (e) {
        result.error = '[STG] ' + String(e);
        log.logError(e.message || e, e);
    }

    result.error ? log.stopError(result.error) : log.stop();

    return result;
}

async function saveOptions(_options) {
    const log = logger.start('saveOptions');

    if (!storage.inited) {
        log.stopError('background not yet inited');
        return;
    }

    const optionsToSave = {};

    for (const [key, value] of Object.entries(_options)) {
        if (Constants.ALL_OPTION_KEYS.includes(key)) {
            optionsToSave[key] = Utils.isPrimitive(value) ? value : JSON.clone(value);
        } else if (Constants.DEFAULT_OPTIONS[key] === undefined) {
            log.throwError(`option key "${key}" is unknown`);
        }
    }

    const optionsKeys = Object.keys(optionsToSave);

    if (!optionsKeys.length) {
        log.stop('options not found');
        return;
    }

    await Storage.set(optionsToSave);

    Object.assign(options, optionsToSave);

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
        await resetLocalBackupAlarm();
    }

    if (optionsKeys.some(key => ['syncEnable', 'syncOptionsLocation', 'syncIntervalKey', 'syncIntervalValue'].includes(key))) {
        await resetSyncAlarm();
    }

    if (optionsKeys.includes('temporaryContainerTitle')) {
        await Containers.updateTemporaryContainerTitle(options.temporaryContainerTitle);
    }

    if (optionsKeys.some(key => ['showContextMenuOnTabs', 'showContextMenuOnLinks'].includes(key))) {
        await updateMoveTabMenus();
    }

    sendMessageFromBackground('options-updated', {
        keys: optionsKeys,
    });

    log.stop();
}

const LOCAL_BACKUP_ALARM_NAME = 'local-backup';

async function resetLocalBackupAlarm() {
    await resetAlarm(
        LOCAL_BACKUP_ALARM_NAME,
        options.autoBackupEnable,
        options.autoBackupIntervalKey,
        options.autoBackupIntervalValue,
        storage.autoBackupLastTimeStamp
    );
}

const CLOUD_SYNC_ALARM_NAME = 'cloud-sync';

async function resetSyncAlarm() {
    await resetAlarm(
        CLOUD_SYNC_ALARM_NAME,
        options.syncEnable,
        options.syncIntervalKey,
        options.syncIntervalValue,
        storage.autoSyncLastTimeStamp
    );
}

async function resetAlarm(
    name,
    isEnable,
    intervalKey,
    intervalValue,
    lastAlarmRunUnixTime = Utils.unixNow(),
    minDelayMinutes = 0.5
) {
    const log = logger.start('resetAlarm', {name, isEnable, intervalKey, intervalValue, lastAlarmRunUnixTime, minDelayMinutes});

    await browser.alarms.clear(name);

    if (!isEnable) {
        log.stop(name, 'is disabled');
        return;
    }

    let periodInMinutes;

    if (Constants.INTERVAL_KEY.minutes === intervalKey) {
        periodInMinutes = intervalValue;
    } else if (Constants.INTERVAL_KEY.hours === intervalKey) {
        periodInMinutes = intervalValue * 60;
    } else if (Constants.INTERVAL_KEY.days === intervalKey) {
        periodInMinutes = intervalValue * 60 * 24;
    }

    const minutesNow = Math.floor(Utils.unixNow() / 60);
    const minutesWhenBackup = periodInMinutes + Math.floor(lastAlarmRunUnixTime / 60);

    const delayInMinutes = minutesWhenBackup > minutesNow
        ? minutesWhenBackup - minutesNow
        : minDelayMinutes;

    await browser.alarms.create(name, {
        delayInMinutes,
        periodInMinutes,
    });

    log.stop();
}

async function createBackup(includeTabFavIcons, includeTabThumbnails, isAutoBackup = false) {
    const log = logger.start('createBackup', {includeTabFavIcons, includeTabThumbnails, isAutoBackup});

    const data = await Storage.get();
    const {groups} = await Groups.load(null, true, includeTabFavIcons, includeTabThumbnails);

    if (isAutoBackup && (!groups.length || groups.filter(gr => !gr.isArchive).every(gr => !gr.tabs.length))) {
        log.stopWarn('skip create auto backup, groups are empty');
        return false;
    }

    if (includeTabThumbnails) {
        includeTabThumbnails = options.showTabsWithThumbnailsInManageGroups;
    }

    let pinnedTabs = await Tabs.get(null, true, null);

    pinnedTabs = pinnedTabs.filter(tab => Utils.isUrlAllowToCreate(tab.url));

    if (pinnedTabs.length) {
        Management.replaceMozExtensionTabUrls(pinnedTabs, 'id');
        data.pinnedTabs = Tabs.prepareForSave(pinnedTabs); // TODO remove from all
    }

    // const containersToExport = new Set;

    data.groups = groups.map(group => {
        if (!group.isArchive) {
            Management.replaceMozExtensionTabUrls(group.tabs, 'id');
        }

        group.tabs = Tabs.prepareForSave(group.tabs, false, includeTabFavIcons, includeTabThumbnails);

        // group.tabs.forEach(({ cookieStoreId }) => {
        //     if (cookieStoreId && !Containers.isTemporary(cookieStoreId)) {
        //         containersToExport.add(cookieStoreId);
        //     }
        // });

        // if (group.newTabContainer !== Constants.TEMPORARY_CONTAINER &&
        //     group.newTabContainer !== Constants.DEFAULT_COOKIE_STORE_ID
        // ) {
        //     containersToExport.add(group.newTabContainer);
        // }

        // group.catchTabContainers.forEach(containersToExport.add, containersToExport);

        return group;
    });

    // if (containersToExport.size) {
    //     const allContainers = Containers.query({temporaryContainer: true});

    //     data.containers = {};

    //     containersToExport.forEach(cookieStoreId => data.containers[cookieStoreId] = allContainers[cookieStoreId]);
    // }

    data.containers = Containers.getToExport(data);

    if (isAutoBackup) {
        if (data.autoBackupLocation === Constants.AUTO_BACKUP_LOCATIONS.DOWNLOADS) {
            await File.saveBackup(data, true);
        } else {
            await Host.saveBackup(data);
        }

        await Bookmarks.exportGroups(data.groups).catch(log.onCatch('cant create bookmarks', false));

        storage.autoBackupLastTimeStamp = Utils.unixNow();
    } else {
        await File.saveBackup(data, false);
    }

    log.stop();

    return true;
}

// data may not be a full backup, but a partial of it
async function restoreBackup(data, clearAddonDataBeforeRestore = false) {
    removeEvents();

    sendMessageFromBackground('lock-addon');

    await Browser.actionLoading();

    const currentData = {};

    if (clearAddonDataBeforeRestore) {
        await clearAddon(false);

        // await Utils.wait(1000);
    }

    Containers.mapDefaultContainer(data, Constants.DEFAULT_COOKIE_STORE_ID);

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

    const existGroupIds = new Set(currentData.groups.map(({id}) => id));
    const restoreGroupIds = new Set(data.groups.map(({id}) => id));

    for (const groupToRestore of data.groups) {
        if (
            groupToRestore.moveToGroupIfNoneCatchTabRules &&
            !existGroupIds.has(groupToRestore.moveToGroupIfNoneCatchTabRules) &&
            !restoreGroupIds.has(groupToRestore.moveToGroupIfNoneCatchTabRules)
        ) {
            groupToRestore.moveToGroupIfNoneCatchTabRules = null;
        }
    }

    const neededContainers = new Set;
    const defaultGroupProps = clearAddonDataBeforeRestore ? data.defaultGroupProps : options.defaultGroupProps;

    data.groups = data.groups.map(group => {
        const newGroupId = existGroupIds.has(group.id)
            ? Groups.createId()
            : (group.id || Groups.createId());

        const newGroup = Groups.create(newGroupId, group.title, defaultGroupProps);

        for (const key in group) {
            if (key === 'id') {
                continue;
            }

            if (newGroup.hasOwnProperty(key)) {
                newGroup[key] = group[key];
            }
        }

        if (!newGroup.isArchive) {
            Management.replaceMozExtensionTabUrls(newGroup.tabs, 'uuid');
        }

        for (const tab of newGroup.tabs) {
            if (Containers.isDefault(tab.cookieStoreId) || Containers.isTemporary(tab.cookieStoreId)) {
                continue;
            }

            neededContainers.add(tab.cookieStoreId);
        }

        return newGroup;
    });

    data.groups = [...currentData.groups, ...data.groups];
    data.hotkeys = [...currentData.hotkeys, ...data.hotkeys];

    data.hotkeys = data.hotkeys.filter((hotkey, index, self) => {
        return self.findIndex(h => h.value === hotkey.value) === index;
    });

    if (data.containers) {
        const containersStorageMap = new Map;

        for (const [cookieStoreId, value] of Object.entries(data.containers)) {
            if (!neededContainers.has(cookieStoreId)) {
                continue;
            }

            const newCookieStoreId = await Containers.findExistOrCreateSimilar(cookieStoreId, value, containersStorageMap);

            if (newCookieStoreId !== cookieStoreId) {
                for (const group of data.groups) {
                    if (group.newTabContainer === cookieStoreId) {
                        group.newTabContainer = newCookieStoreId;
                    }

                    group.excludeContainersForReOpen = group.excludeContainersForReOpen
                        .map(csId => csId === cookieStoreId ? newCookieStoreId : csId);

                    group.catchTabContainers = group.catchTabContainers
                        .map(csId => csId === cookieStoreId ? newCookieStoreId : csId);
                }
            }
        }
    }

    delete data.containers;

    const allTabs = await Tabs.get(null, false, null, undefined, true, options.showTabsWithThumbnailsInManageGroups);

    await syncTabs(data.groups, allTabs);

    if (Array.isArray(data.pinnedTabs)) {
        const currentPinnedTabs = await Tabs.get(null, true, null);

        Management.replaceMozExtensionTabUrls(currentPinnedTabs, 'id');

        data.pinnedTabs = data.pinnedTabs.filter(tab => {
            tab.pinned = true;
            return !currentPinnedTabs.some(t => t.url === tab.url);
        });

        if (data.pinnedTabs.length) {
            Management.replaceMozExtensionTabUrls(data.pinnedTabs, 'uuid');
            await createTabsSafe(data.pinnedTabs, false, false);
        }
    }

    delete data.pinnedTabs;

    let result;

    if (clearAddonDataBeforeRestore) {
        const defaultOptions = JSON.clone(Constants.DEFAULT_OPTIONS);

        result = Object.assign(defaultOptions, data);
    } else {
        result = data;
    }

    await Storage.set(result);

    await Utils.wait(200);

    storage.isBackupRestoring = true;

    browser.runtime.reload(); // reload addon
}

async function clearAddon(reloadAddonOnFinish = true) {
    if (reloadAddonOnFinish) {
        await Browser.actionLoading();
        sendMessageFromBackground('lock-addon');
    }

    removeEvents();

    const [tabs, windows] = await Promise.all([Tabs.get(null, null, null), Windows.load()]);

    await Promise.all(tabs.map(tab => Cache.removeTabSession(tab.id)));
    await Promise.all(windows.map(win => Cache.removeWindowSession(win.id)));

    await Storage.clear();

    Cache.clear();

    localStorage.clear();

    if (reloadAddonOnFinish) {
        browser.runtime.reload(); // reload addon
    }
}

async function cloudSync(auto = false, trust = null, revision = null) {
    if (cloudSync.inProgress) {
        return;
    }

    cloudSync.inProgress = true;

    const log = logger.start('cloudSync', {auto});

    let ok = false;

    try {
        sendMessageFromBackground('sync-start');

        const syncResult = await Cloud.sync(trust, revision, progress => {
            log.log('progress', progress);
            sendMessageFromBackground('sync-progress', {progress});
        });

        ok = true;

        sendMessageFromBackground('sync-end', syncResult);

        log.stop();
        return syncResult;
    } catch (e) {
        if (auto) {
            const isInvalidToken = e.id === 'githubInvalidToken';
            const isNetworkError = e.message.startsWith('NetworkError');

            if (!isNetworkError && !isInvalidToken) {
                Notification(e, {
                    module: ['urls', 'openOptionsPage', 'backup sync'],
                });
            }
        }

        log.logError('cant sync', e);
        log.stopError();
        sendMessageFromBackground('sync-error', {
            id: e.id,
            name: e.name,
            message: e.message,
        });
    } finally {
        sendMessageFromBackground('sync-finish', {ok});
        cloudSync.inProgress = false;
    }
}

self.saveOptions = saveOptions;

self.createTabsSafe = createTabsSafe;

self.sendExternalMessage = sendExternalMessage;

self.updateMoveTabMenus = updateMoveTabMenus;

self.applyGroup = applyGroup;

self.addListenerOnBeforeRequest = addListenerOnBeforeRequest;
self.removeListenerOnBeforeRequest = removeListenerOnBeforeRequest;

self.runMigrateForData = runMigrateForData;

self.restoreBackup = restoreBackup;
self.clearAddon = clearAddon;

self.cloudSync = cloudSync;

self.skipAddGroupToNextNewWindow = false;


async function runMigrateForData(data, applyToCurrentInstance = true) {
    const log = logger.start('runMigrateForData', {version: data.version, applyToCurrentInstance});

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

                if (applyToCurrentInstance) {
                    let tabs = await browser.tabs.query({
                        url: 'moz-extension://*/stg-newtab/newtab.html*',
                    });

                    if (tabs.length) {
                        tabs.forEach(tab => delete tab.openerTabId);
                        tabs.forEach(tab => delete tab.groupId); // TODO temp

                        await Promise.all(tabs.map(tab => Tabs.create(Utils.normalizeTabUrl(tab))));

                        await Utils.wait(100);

                        await Tabs.remove(tabs);

                        await Utils.wait(100);
                    }
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

                let windows;

                if (applyToCurrentInstance) {
                    windows = await Windows.load(true, true, true);

                    if (!windows.length) {
                        throw Lang('notFoundWindowsAddonStoppedWorking');
                    }

                    Notification('loading', {id: 'loading'});

                    await Promise.all(windows.map(win => Tabs.createTempActiveTab(win.id, false, 'about:blank')));
                }

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

                if (applyToCurrentInstance) {
                    let allTabs = Utils.concatTabs(windows);

                    if (allTabs.length) {
                        await Tabs.hide(allTabs, true);
                    }

                    data.groups = await syncTabs(data.groups, allTabs);

                    Notification.clear('loading');

                    await Utils.wait(1000);
                }
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
                if (applyToCurrentInstance) {
                    localStorage.clear();
                }

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

                if (applyToCurrentInstance) {
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
                }
            },
        },
        {
            version: '4.7.2',
            remove: ['enableDarkTheme', 'autoBackupBookmarksFolderName'],
            async migration() {
                data.theme = data.enableDarkTheme ? 'dark' : Constants.DEFAULT_OPTIONS.colorScheme;
                data.groups.forEach(group => {
                    group.title = String(group.title);
                    group.bookmarkId = null;
                });

                if (!applyToCurrentInstance) {
                    return;
                }

                let hasBookmarksPermission = await Bookmarks.hasPermission();

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
                    localStorage.mainBookmarksFolderId = rootFolder.id;
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
                        valueParts.push(Constants.IS_MAC ? 'MacCtrl' : 'Ctrl');
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
        {
            version: '5.5',
            remove: [
                'autoBackupLastBackupTimeStamp',
                'lastCreatedGroupPosition',
                'autoBackupFolderName',
                'autoBackupByDayIndex',
                'theme',
            ],
            async migration() {
                for (const group of data.groups) {
                    group.dontUploadToCloud = false;
                    delete group.leaveBookmarksOfClosedTabs;
                    group.exportToBookmarks = group.exportToBookmarksWhenAutoBackup;
                    delete group.exportToBookmarksWhenAutoBackup;
                    delete group.bookmarkId;

                    if (group.isArchive) {
                        Management.replaceMozExtensionTabUrls(group.tabs, 'id');
                    }
                }

                delete data.defaultGroupProps.leaveBookmarksOfClosedTabs;

                if (data.defaultGroupProps.exportToBookmarksWhenAutoBackup !== undefined) {
                    data.defaultGroupProps.exportToBookmarks = data.defaultGroupProps.exportToBookmarksWhenAutoBackup;
                }

                delete data.defaultGroupProps.exportToBookmarksWhenAutoBackup;

                data.showArchivedGroups = localStorage.showArchivedGroupsInPopup === '1';

                data.colorScheme = data.theme;

                data.browserSettings = {};

                if (applyToCurrentInstance) {
                    storage.autoBackupLastTimeStamp = data.autoBackupLastBackupTimeStamp;
                    storage.mainBookmarksFolderId = localStorage.mainBookmarksFolderId;
                    storage.showTabsInThisWindowWereHidden = Number(localStorage.showTabsInThisWindowWereHidden) || 0;

                    delete localStorage.START_TIME;
                    delete localStorage.autoBackupLastTimeStamp;
                    delete localStorage.mainBookmarksFolderId;
                    delete localStorage.showArchivedGroupsInPopup;
                    delete localStorage.showTabsInThisWindowWereHidden;
                    delete localStorage.optionsSection;
                    delete localStorage.enableDebug;

                    try {
                        let errorLogs = localStorage.errorLogs;
                        delete localStorage.errorLogs;
                        errorLogs = JSON.parse(errorLogs);

                        if (Array.isArray(errorLogs) && errorLogs.length) {
                            localStorage.create(Constants.MODULES.LOGGER).errors = errorLogs;
                        }
                    } catch {}
                }

                // ! MIGRATE group ids from small int to UUID

                const blankUUID = '00000000-0000-0000-0000-000000000000';

                function createGroupUUID({id, title}) {
                    const partGroupUUID = [...title]
                        .map(char => char.codePointAt(0))
                        .reduce((acc, codePoint) => acc + codePoint, id)
                        .toString(16);

                    return blankUUID.slice(0, -partGroupUUID.length) + partGroupUUID;
                }

                const groupIdsMap = new Map;

                for (const group of data.groups) {
                    groupIdsMap.set(group.id, createGroupUUID(group));
                    group.id = groupIdsMap.get(group.id);
                }

                for (const group of data.groups) {
                    if (group.moveToGroupIfNoneCatchTabRules) {
                        group.moveToGroupIfNoneCatchTabRules = groupIdsMap.get(group.moveToGroupIfNoneCatchTabRules) || null;
                    }
                }

                if (data.defaultGroupProps.moveToGroupIfNoneCatchTabRules) {
                    data.defaultGroupProps.moveToGroupIfNoneCatchTabRules = groupIdsMap.get(data.defaultGroupProps.moveToGroupIfNoneCatchTabRules);
                }

                if (!data.defaultGroupProps.moveToGroupIfNoneCatchTabRules) {
                    delete data.defaultGroupProps.moveToGroupIfNoneCatchTabRules;
                }

                // replace {index} => {uid} for default group title
                if (data.defaultGroupProps.title) {
                    data.defaultGroupProps.title = Utils.format(data.defaultGroupProps.title, {index: '{uid}'});
                }

                for (const hotkey of data.hotkeys) {
                    hotkey.groupId = groupIdsMap.get(hotkey.groupId) || null;
                }

                if (applyToCurrentInstance) {
                    // update group id for all windows
                    const windows = await browser.windows.getAll({
                        windowTypes: [browser.windows.WindowType.NORMAL],
                    });

                    await Promise.allSettled(windows.map(async win => {
                        const groupId = await browser.sessions.getWindowValue(win.id, 'groupId');
                        const newGroupId = groupIdsMap.get(groupId);

                        if (newGroupId) {
                            await browser.sessions.setWindowValue(win.id, 'groupId', newGroupId);
                        } else {
                            await browser.sessions.removeWindowValue(win.id, 'groupId');
                        }
                    }));

                    // update group id for all tabs
                    const tabs = await browser.tabs.query({
                        pinned: false,
                        windowType: browser.windows.WindowType.NORMAL,
                    });

                    await Promise.allSettled(tabs.map(async tab => {
                        delete tab.groupId; // TODO temp
                        const groupId = await browser.sessions.getTabValue(tab.id, 'groupId');
                        const newGroupId = groupIdsMap.get(groupId);

                        if (groupId) {
                            if (newGroupId) {
                                await browser.sessions.setTabValue(tab.id, 'groupId', newGroupId);
                            } else {
                                await browser.sessions.removeTabValue(tab.id, 'groupId');
                            }
                        }
                    }));

                    // migrate STG addons
                    const STG_GROUP_NOTES_ID = 'stg-plugin-group-notes@drive4ik';
                    const result = await Messages.sendExternalMessage(STG_GROUP_NOTES_ID, {
                        action: 'get-backup',
                    });

                    if (result?.backup) {
                        const notesData = {};
                        const keyStart = 'group-';

                        for (const [key, value] of Object.entries(result.backup)) {
                            let groupId;

                            if (Number(key) == key) {
                                groupId = Number(key);
                            } else if (key.startsWith(keyStart)) {
                                const keyPart = key.slice(keyStart.length);

                                if (keyPart.length === blankUUID.length) {
                                    continue;
                                }

                                groupId = Number(keyPart);
                            }

                            const newGroupId = groupIdsMap.get(groupId);

                            if (newGroupId) {
                                notesData[`${keyStart}${newGroupId}`] = value;
                            }
                        }

                        if (Object.keys(notesData).length) {
                            await Messages.sendExternalMessage(STG_GROUP_NOTES_ID, {
                                action: 'set-backup',
                                backup: notesData,
                            });
                        }
                    }
                }

                // migrate backup folder to file path
                data.autoBackupFilePath = data.autoBackupFolderName || '';

                if (
                    !data.autoBackupFolderName.length ||
                    /^STG\-backups\-FF\-[a-z\d\.]+$/.test(data.autoBackupFolderName) ||
                    /^STG\-backups\-(win|linux|mac|openbsd)\-\d+$/.test(data.autoBackupFolderName)
                ) {
                    data.autoBackupFilePath = `STG-backups-FF-{ff-version}/`;
                } else {
                    data.autoBackupFilePath += '/';
                }

                if (data.autoBackupByDayIndex) {
                    data.autoBackupFilePath += `auto-stg-backup-day-of-month-{day-2-digit}@drive4ik`;
                } else {
                    data.autoBackupFilePath += `STG-backup {date-full} {time-short}@drive4ik`;
                }
            },
        },
    ];

    // start migration
    const keysToRemoveFromStorage = new Set;

    // if data version < required latest migrate version then need migration
    if (Utils.compareNumericVersions(data.version, migrations[migrations.length - 1].version) < 0) {

        for (const migration of migrations) {
            if (Utils.compareNumericVersions(data.version, migration.version) < 0) {
                log.log('start migration to version', migration.version);

                await migration.migration();

                log.log('stop migration to version', migration.version);

                migration.remove?.forEach(keysToRemoveFromStorage.add, keysToRemoveFromStorage);
            }
        }

    } else {
        const versionDiffIndex = Utils.compareNumericVersions(data.version, currentVersion);

        if (versionDiffIndex > 0 && versionDiffIndex <= 3) {
            resultMigrate.error = 'updateAddonToLatestVersion';
            log.stopError(resultMigrate.error, 'data.version:', data.version, 'currentVersion:', currentVersion);
            return resultMigrate;
        }
    }

    data.version = currentVersion;

    if (keysToRemoveFromStorage.size) {
        keysToRemoveFromStorage.forEach(key => delete data[key]);
        log.log('remove keys in storage', Array.from(keysToRemoveFromStorage));
        if (applyToCurrentInstance) {
            await Storage.remove(Array.from(keysToRemoveFromStorage));
        }
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

                tabs.push(Cache.setTabSession(winTab, tab));
            } else {
                tabs.push(null);

                delete tab.active;
                delete tab.windowId;
                delete tab.index;
                delete tab.pinned;

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
    for (const group of groups) {
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

    await Browser.actionLoading();

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
        log.logError('cant createTabsSafe', e);
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
        sendMessageFromBackground('groups-updated');
    }

    await Browser.actionLoading(false);

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
Listeners.runtime.onInstalled(({reason, previousVersion, temporary}) => {
    const log = logger.start('runtime.onInstalled', {reason, previousVersion, temporary});

    if (temporary) {
        storage.IS_TEMPORARY = true;
        log.log('addon is temp');
    } else if (
        reason === browser.runtime.OnInstalledReason.INSTALL ||
        (
            reason === browser.runtime.OnInstalledReason.UPDATE &&
            Utils.compareNumericVersions(previousVersion, '5.0') < 0
        )
    ) {
        log.log('open welcome');
        Urls.openUrl('welcome');
    }

    log.stop();
});

async function initializeGroupWindows(windows, currentGroupIds) {
    const log = logger.start('initializeGroupWindows windows count:', windows.length);

    const EXTENSION_START_TIME = await getExtensionStartTime();

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
                Cache.removeTabGroup(tab.id).catch(log.onCatch(['cant removeTabGroup', tab.id], false));
            }

            if (tab.groupId) {
                // TODO create bug in bugzilla: if set tab session, disable addon, move tab to other window, enable addon - session will empty
                let tabWin = otherWindows.find(w => w.groupId === tab.groupId);

                if (tabWin) {
                    moveTabsToWin[tabWin.id] ??= [];
                    moveTabsToWin[tabWin.id].push(tab);

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
                    if (Utils.isTabLoading(tab) || tab.url.startsWith('file:') || tab.lastAccessed > EXTENSION_START_TIME) {
                        Cache.setTabGroup(tab.id, win.groupId)
                            .then(() => tab.groupId = win.groupId)
                            .catch(log.onCatch(["can't setTabGroup", tab.id, 'group', win.groupId], false));
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

    for (const [windowId, tabs] in Object.entries(moveTabsToWin)) {
        await Tabs.moveNative(tabs, {
            index: -1,
            windowId: Number(windowId),
        });

        log.log('moveTabsToWin length', tabs.length);
    }

    if (tabsToShow.length) {
        await Tabs.show(tabsToShow, true);

        tabsToShow.forEach(tab => tab.hidden = false);

        log.log('tabsToShow length', tabsToShow.length);
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

        await Tabs.hide(tabsToHide, true);

        log.log('tabsToHide length', tabsToHide.length);
    }

    log.stop();
}

async function init() {
    const log = logger.start(['info', '[init]']);

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
            Notification(resultMigrate.error);
            throw '';
        }

        Utils.assignKeys(options, data, Constants.ALL_OPTION_KEYS);

        if (await BrowserSettings.hasPermission()) {
            await BrowserSettings.set(options.browserSettings);
        }

        dataChanged.add(Groups.normalizeContainersInGroups(data.groups));

        if (data.autoBackupLocation === Constants.AUTO_BACKUP_LOCATIONS.HOST) {
            if (Constants.IS_WINDOWS && await Host.hasPermission()) {
                Host.checkVersion().catch(e => {
                    Notification(e, {
                        tab: {
                            url: Constants.HOST.DOWNLOAD_URL,
                        },
                    });
                });
            } else {
                data.autoBackupLocation = Constants.AUTO_BACKUP_LOCATIONS.DOWNLOADS;
                dataChanged.add(true);
            }
        }

        if (dataChanged.has(true)) {
            log.log('data was changed, save data');
            await Storage.set(data);
        }

        let windows = await Windows.load();

        if (!windows.length) {
            log.error('no windows found');
            storage.notFoundWindowsAddonStoppedWorking = 1;
            // Notification('notFoundWindowsAddonStoppedWorking');
            Listeners.windows.onCreated(() => browser.runtime.reload());
            throw '';
        } else if (storage.notFoundWindowsAddonStoppedWorking) {
            log.warn('try run grand restore, attempt:', storage.notFoundWindowsAddonStoppedWorking);

            try {
                await Promise.all(windows.map(async win => {
                    grandRestoringPromise = GrandRestoreWindows(win);
                    await grandRestoringPromise;
                    grandRestoringPromise = null;
                }));
            } catch (e) {
                log.logError('cant grand restore', e);
                if (storage.notFoundWindowsAddonStoppedWorking++ < 10) {
                    browser.runtime.reload();
                } else {
                    await setActionToReloadAddon();
                }
                log.stop();
                return;
            }

            log.info('grand restore finish');

            delete storage.notFoundWindowsAddonStoppedWorking;
        }

        await tryRestoreMissedTabs();

        windows = await Windows.load(true);

        await initializeGroupWindows(windows, data.groups.map(g => g.id));

        windows.filter(win => win.groupId).forEach(win => groupsHistory.add(win.groupId));

        let tabs = Utils.concatTabs(windows);

        await Containers.removeUnusedTemporaryContainers(tabs);

        log.log('Containers.removeUnusedTemporaryContainers finish');

        await restoreOldExtensionUrls();

        log.log('restoreOldExtensionUrls finish');

        resetLocalBackupAlarm();
        resetSyncAlarm();

        await updateMoveTabMenus();

        log.log('updateMoveTabMenus finish');

        addEvents();

        if (Groups.isNeedBlockBeforeRequest(data.groups)) {
            log.log('addListenerOnBeforeRequest');
            addListenerOnBeforeRequest();
        }

        if (storage.isBackupRestoring) {
            delete storage.isBackupRestoring;
            Notification('backupSuccessfullyRestored');
        }

        await Browser.actionLoading(false);

        storage.inited = true;

        // send message for addon pages if it's open
        sendMessageFromBackground('i-am-back');

        // send message for addon plugins
        sendExternalMessage('i-am-back');

        log.log('loading groups for creating cache...');
        await Groups.load(null, true, true); // load favIconUrls, speed up first run popup

        // Urls.openUrl('/popup/popup.html#sidebar');
        // Urls.openUrl('/popup/popup.html');

        // Urls.openOptionsPage();
        // Urls.openOptionsPage('backup');
        // Urls.openDebugPage();
        // Urls.openUrl('welcome');

        log.stop();
    } catch (e) {
        await setActionToReloadAddon();

        if (e) {
            errorEventHandler.call(log, e);
            log.stopError('with errors');
        } else {
            log.stop();
        }
    }
}

async function setActionToReloadAddon() {
    await Browser.actionAllWindows({
        title: 'clickHereToReloadAddon',
        icon: 'icons/exclamation-triangle-yellow.svg',
        popup: '',
        enable: true,
    });

    Listeners.browserAction.onClicked(() => browser.runtime.reload());
}

Listeners.onExtensionStart(async () => {
    await Browser.action({
        title: 'loading',
        badgeBackgroundColor: 'transparent',
    });

    // delay startup to avoid errors with extensions "Facebook Container", "Firefox Multi-Account Containers" etc.
    // TransactionInactiveError: A request was placed against a transaction which is currently not active, or which is finished.
    // An unexpected error occurred
    // etc.
    self.setTimeout(init, 200);
});
