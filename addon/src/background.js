'use strict';

import constants from './js/constants';
import containers from './js/containers';
import utils from './js/utils';
import storage from './js/storage';
import file from './js/file';
import cache from './js/cache';
import Groups from './js/groups';
import Tabs from './js/tabs';
import Windows from './js/windows';

window.IS_PRODUCTION = IS_PRODUCTION;

if (2 == window.localStorage.enableDebug) { // if debug was auto-enabled - disable on next start addon/browser
    delete window.localStorage.enableDebug;
}
console.restart();

const addonUrlPrefix = browser.extension.getURL('');
const manageTabsPageUrl = browser.extension.getURL(constants.MANAGE_TABS_URL);
const manifest = browser.runtime.getManifest();
const noop = function() {};

let options = {},
    reCreateTabsOnRemoveWindow = [],
    menuIds = [],
    excludeTabsIds = [],

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

window.addEventListener('error', utils.errorEventHandler);

async function createTabsSafe(tabs, {
        withRemoveEvents = true,
        sendMessageEachTab = true,
    } = {}) {

    if (withRemoveEvents) {
        removeEvents();
    }

    let newTabs = await Promise.all(tabs.map(function(tab) {
        delete tab.active;
        delete tab.index;
        delete tab.windowId;

        return Tabs.createNative(tab);
    }));

    newTabs = await Promise.all(newTabs.map(cache.setTabSession));

    let tabsToHide = newTabs.filter(tab => !tab.pinned && tab.groupId && !cache.getWindowId(tab.groupId)),
        tabsToHideIds = tabsToHide.map(utils.keyId);

    if (tabsToHideIds.length) {
        if (!withRemoveEvents) {
            addExcludeTabsIds(tabsToHideIds);
        }

        await browser.tabs.hide(tabsToHideIds);

        if (!withRemoveEvents) {
            removeExcludeTabsIds(tabsToHideIds);
        }

        tabsToHide.forEach(tab => tab.hidden = true);
    }

    if (withRemoveEvents) {
        addEvents();
    }

    if (sendMessageEachTab) {
        let groupTabs = {};

        newTabs.forEach(function(tab) {
            if (tab.groupId) {
                if (groupTabs[tab.groupId]) {
                    groupTabs[tab.groupId].push(tab);
                } else {
                    groupTabs[tab.groupId] = [tab];
                }
            }
        });

        for (let groupId in groupTabs) {
            sendMessage({
                action: 'tabs-added',
                groupId: Number(groupId),
                tabs: groupTabs[groupId],
            });
        }
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

    Object.keys(constants.EXTENSIONS_WHITE_LIST)
        .forEach(function(exId) {
            if (constants.EXTENSIONS_WHITE_LIST[exId].postActions.includes(data.action)) {
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
        if (groupWindowId) {
            if (activeTabId) {
                Tabs.setActive(activeTabId);
            }

            Windows.setFocus(groupWindowId);
        } else {
            // magic

            let [groupToShow, groups] = await Groups.load(groupId, true),
                oldGroupId = cache.getWindowGroup(windowId),
                groupToHide = groups.find(gr => gr.id === oldGroupId);

            if (!groupToShow) {
                throw Error(utils.errorEventMessage('applyGroup: groupToShow not found', {groupId, activeTabId}));
            }

            if (groupToShow.isArchive) {
                utils.notify(browser.i18n.getMessage('groupIsArchived', groupToShow.title));
                throw '';
            }

            if (groupToHide && groupToHide.tabs.some(utils.isTabCanNotBeHidden)) {
                utils.notify(browser.i18n.getMessage('notPossibleSwitchGroupBecauseSomeTabShareMicrophoneOrCamera'));
                throw '';
            }

            loadingBrowserAction(true, windowId);

            removeEvents();

            // show tabs
            if (groupToShow.tabs.length) {
                let tabIds = groupToShow.tabs.map(utils.keyId);

                if (!groupToShow.tabs.every(tab => tab.windowId === windowId)) {
                    groupToShow.tabs = await Tabs.moveNative(groupToShow.tabs, {
                        index: -1,
                        windowId: windowId,
                    });
                }

                await browser.tabs.show(tabIds);

                if (groupToShow.muteTabsWhenGroupCloseAndRestoreWhenOpen) {
                    Tabs.setMute(groupToShow.tabs, false);
                }

                // set active tab
                if (activeTabId) {
                    await Tabs.setActive(activeTabId);
                    sendMessage({
                        action: 'tab-updated',
                        tab: {
                            id: activeTabId,
                            discarded: false,
                        },
                    });
                } else if (groupToHide && groupToHide.tabs.some(tab => tab.active)) {
                    let tabToActive = await Tabs.setActive(undefined, groupToShow.tabs);
                    sendMessage({
                        action: 'tab-updated',
                        tab: {
                            id: tabToActive.id,
                            discarded: false,
                        },
                    });
                }
            } else {
                let pinnedTabs = await Tabs.get(windowId, true),
                    activeTab = await Tabs.setActive(undefined, pinnedTabs);

                if (!activeTab) {
                    await Tabs.create({
                        active: true,
                        windowId,
                        ...Groups.getNewTabParams(groupToShow),
                    });
                }
            }

            cache.setWindowGroup(windowId, groupToShow.id);

            // hide tabs
            if (groupToHide && groupToHide.tabs.length) {
                let tabsIdsToRemove = [];

                groupToHide.tabs = groupToHide.tabs.filter(function(tab) {
                    if (tab.url === manageTabsPageUrl) {
                        tabsIdsToRemove.push(tab.id);
                        return false;
                    }

                    return true;
                });

                if (groupToHide.tabs.length) {
                    if (groupToHide.muteTabsWhenGroupCloseAndRestoreWhenOpen) {
                        Tabs.setMute(groupToHide.tabs, true);
                    }

                    let tabIds = groupToHide.tabs.map(utils.keyId);

                    let hideTabsResult = await browser.tabs.hide(tabIds);

                    console.assert(hideTabsResult.length === tabIds.length, 'some tabs not hide');

                    if (options.discardTabsAfterHide && !groupToHide.dontDiscardTabsAfterHideThisGroup) {
                        Tabs.discard(tabIds);
                        tabIds.forEach(function(tabId) {
                            sendMessage({
                                action: 'tab-updated',
                                tab: {
                                    id: tabId,
                                    discarded: true,
                                },
                            });
                        });
                    }
                }

                if (tabsIdsToRemove.length) {
                    Tabs.remove(tabsIdsToRemove);
                    tabsIdsToRemove.forEach(tabId => onRemovedTab(tabId, {}));
                }
            }

            // set group id for tabs which may has opened without groupId (new window without group, etc...)
            if (!groupToHide) {
                let sendGroupUpdateMessage = false,
                    tabs = await Tabs.get(windowId);

                tabs.forEach(function(tab) {
                    if (tab.groupId !== groupToShow.id) {
                        tab.groupId = groupToShow.id;
                        cache.setTabGroup(tab.id, groupToShow.id);
                        sendGroupUpdateMessage = true;
                    }
                });

                if (sendGroupUpdateMessage) {
                    sendMessage({
                        action: 'group-updated',
                        group: {
                            id: groupToShow.id,
                            tabs,
                        },
                    });
                }
            }

            updateMoveTabMenus();

            updateBrowserActionData(groupToShow.id);

            if (!applyFromHistory) {
                groupsHistory.add(groupId);
            }

            addEvents();
        }

        sendMessage({
            action: 'group-loaded',
            groupId,
            windowId,
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
            utils.errorEventHandler(e);

            updateBrowserActionData(null, windowId);

            if (!groupWindowId) {
                removeEvents();
                addEvents();
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

async function onActivatedTab({ previousTabId, tabId, windowId }) {
    console.log('onActivatedTab', { previousTabId, tabId, windowId });

    if (cache.getTabSession(tabId, 'groupId')) {
        sendMessage({
            action: 'tab-updated',
            tab: {
                id: tabId,
                active: true,
            },
        });

        Tabs.updateThumbnail(tabId);
    }

    if (previousTabId && cache.getTabSession(previousTabId, 'groupId')) {
        sendMessage({
            action: 'tab-updated',
            tab: {
                id: previousTabId,
                active: false,
            },
        });
    }
}

function _isCatchedUrl(url, catchTabRules) {
    if (!catchTabRules) {
        return false;
    }

    return catchTabRules
        .trim()
        .split(/\s*\n\s*/)
        .map(regExpStr => regExpStr.trim())
        .filter(Boolean)
        .some(function(regExpStr) {
            try {
                return new RegExp(regExpStr).test(url);
            } catch (e) {};
        });
}

function _getCatchedGroupForTab(groups, tab, checkTabAsNew = false) {
    return groups.find(function(group) {
        if (group.catchTabContainers.includes(tab.cookieStoreId)) {
            return true;
        }

        if (_isCatchedUrl(tab.url, group.catchTabRules)) {
            return true;
        }

        if (checkTabAsNew && 'about:blank' === tab.url && utils.isTabLoaded(tab) && _isCatchedUrl(tab.title, group.catchTabRules)) {
            return true;
        }
    });
}

async function onCreatedTab(tab) {
    console.log('onCreatedTab', tab);

    cache.setTab(tab);

    if (utils.isTabPinned(tab)) {
        return;
    }

    let groupId = cache.getWindowGroup(tab.windowId);

    if (groupId) {
        cache.setTabGroup(tab.id, groupId);
        updateGroupTabsEvent(groupId);
    }
}

function addExcludeTabsIds(tabIds) {
    excludeTabsIds.push(...tabIds);
}

function removeExcludeTabsIds(tabIds) {
    excludeTabsIds = excludeTabsIds.filter(tabId => !tabIds.includes(tabId));
}

function onUpdatedTab(tabId, changeInfo, tab) {
    let excludeTab = excludeTabsIds.includes(tab.id);

    if (!excludeTab && [ // browser.tabs.onUpdated.addListener filter changed props of tabs not working... :(
            browser.tabs.UpdatePropertyName.ATTENTION,
            browser.tabs.UpdatePropertyName.AUDIBLE,
            browser.tabs.UpdatePropertyName.ISARTICLE,
            browser.tabs.UpdatePropertyName.MUTEDINFO,
            browser.tabs.UpdatePropertyName.SHARINGSTATE,
        ].some(key => key in changeInfo)) {
        excludeTab = true;
    }

    console.log('onUpdatedTab %s tabId: %s, changeInfo:', (excludeTab ? '🛑' : ''), tab.id, changeInfo);

    if (excludeTab) {
        return;
    }

    if (utils.isTabPinned(tab) && undefined === changeInfo.pinned) {
        console.log('onUpdatedTab 🛑 tab is pinned tabId: %s, changeInfo:', tab.id, changeInfo);
        return;
    }

    if (!cache.hasTab(tab.id)) {
        console.log('onUpdatedTab 🛑 tab not yet created tabId: %s, changeInfo:', tab.id);
        return;
    }

    cache.setTab(tab);
/*
    if (undefined === changeInfo.discarded) { // discarded not work when tab loading
        changeInfo.discarded = false;
    }
*/
    let tabGroupId = cache.getTabSession(tab.id, 'groupId'),
        winGroupId = cache.getWindowGroup(tab.windowId);

    if (changeInfo.favIconUrl && (tabGroupId || winGroupId)) {
        changeInfo.favIconUrl = utils.normalizeFavIcon(changeInfo.favIconUrl);
        cache.setTabFavIcon(tab.id, changeInfo.favIconUrl);
    }

    if ('pinned' in changeInfo || 'hidden' in changeInfo) {
        if (changeInfo.pinned || changeInfo.hidden) {
            if (tabGroupId) {
                cache.removeTabGroup(tab.id);

                sendMessage({
                    action: 'tabs-removed',
                    tabIds: [tab.id],
                });
            }
        } else {

            if (false === changeInfo.pinned) {
                cache.setTabGroup(tab.id, winGroupId);
            } else if (false === changeInfo.hidden) {
                if (tabGroupId) {
                    applyGroup(tab.windowId, tabGroupId, tab.id);
                    return;
                } else {
                    cache.setTabGroup(tab.id, winGroupId);
                }
            }

            if (winGroupId) {
                sendMessage({
                    action: 'tabs-added',
                    groupId: winGroupId,
                    tabs: [cache.applyTabSession(tab)],
                });
            }
        }

        return;
    }

    if (tabGroupId || winGroupId) {
        if (utils.isTabLoaded(changeInfo)) {
            Tabs.updateThumbnail(tab.id);
        }

        sendMessage({
            action: 'tab-updated',
            tab: {
                id: tab.id,
                ...changeInfo,
            },
        });
    }
}

async function checkTemporaryContainer(cookieStoreId, excludeTabId) {
    let tabs = await Tabs.get(null, null, null, {cookieStoreId});

    if (!tabs.filter(tab => tab.id !== excludeTabId).length) {
        await containers.remove(cookieStoreId);
    }
}

let lazyRemoveTabIds = [],
    lazyRemoveTabTimer = 0;

function lazyRemoveTabEvent(tabId) {
    clearTimeout(lazyRemoveTabTimer);

    lazyRemoveTabIds.push(tabId);

    lazyRemoveTabTimer = setTimeout(function() {
        sendMessage({
            action: 'tabs-removed',
            tabIds: lazyRemoveTabIds,
        });

        lazyRemoveTabIds = [];
    }, 100);
}

function onRemovedTab(tabId, {isWindowClosing, windowId}) {
    let excludeTab = excludeTabsIds.includes(tabId);

    console.log('onRemovedTab', (excludeTab && '🛑'), {tabId, isWindowClosing, windowId});

    if (excludeTab) {
        cache.removeTab(tabId);
        return;
    }

    lazyRemoveTabEvent(tabId);

    if (isWindowClosing) {
        reCreateTabsOnRemoveWindow.push(tabId);
    } else {
        let {cookieStoreId} = cache.getTabSession(tabId);

        if (containers.isTemporary(cookieStoreId)) {
            setTimeout(checkTemporaryContainer, 100, cookieStoreId, tabId);
        }

        cache.removeTab(tabId);
    }
}

let _onMovedTabsTimers = {};
function updateGroupTabsEvent(groupId) {
    if (_onMovedTabsTimers[groupId]) {
        clearTimeout(_onMovedTabsTimers[groupId]);
    }

    _onMovedTabsTimers[groupId] = setTimeout(async function(groupId) {
        delete _onMovedTabsTimers[groupId];

        let [{tabs}] = await Groups.load(groupId, true);

        sendMessage({
            action: 'group-updated',
            group: {
                id: groupId,
                tabs,
            },
        });
    }, 200, groupId);
}

async function onMovedTab(tabId, { windowId, fromIndex, toIndex }) {
    let groupId = cache.getTabSession(tabId, 'groupId');

    console.log('onMovedTab', {tabId, windowId, fromIndex, toIndex, groupId});

    if (groupId) {
        updateGroupTabsEvent(groupId);
    }
}

function onDetachedTab(tabId, { oldWindowId }) { // notice: call before onAttached
    console.log('onDetachedTab', { tabId, oldWindowId });
}

function onAttachedTab(tabId, { newWindowId, newPosition }) {
    let excludeTab = excludeTabsIds.includes(tabId);

    console.log('onAttachedTab', (excludeTab && '🛑'), { tabId, newWindowId, newPosition });

    if (excludeTab) {
        return;
    }

    let groupId = cache.getWindowGroup(newWindowId);

    cache.setTabGroup(tabId, groupId);

    if (groupId) {
        updateGroupTabsEvent(groupId);
    }
}

async function onCreatedWindow(win) {
    console.log('onCreatedWindow', win);

    if (utils.isWindowAllow(win)) {
        win = await cache.loadWindowSession(win);

        if (win.groupId) {
            await cache.removeWindowSession(win.id);

            updateBrowserActionData(null, win.id);

            let winTabs = await Tabs.get(win.id, null, null);
            winTabs.forEach(tab => cache.removeTabGroup(tab.id));
        } else if (options.createNewGroupWhenOpenNewWindow && window.BG.canAddGroupToWindowAfterItCreated) {
            await Groups.add(win.id);
        }

        await tryRestoreMissedTabs(false);
    } else {
        let winTabs = await Tabs.get(win.id, null, null, {
            windowType: null,
        });

        addExcludeTabsIds(winTabs.map(utils.keyId));
    }
}

let _lastFocusedWinId = null;
function onFocusChangedWindow(windowId) {
    // console.log('onFocusChangedWindow', windowId);

    if (browser.windows.WINDOW_ID_NONE === windowId) {
        return;
    }

    if (_lastFocusedWinId !== windowId) {
        updateMoveTabMenus();
    }

    _lastFocusedWinId = windowId;
}

async function onRemovedWindow(windowId) {
    console.log('onRemovedWindow windowId:', windowId);

    cache.removeWindow(windowId);

    if (reCreateTabsOnRemoveWindow.length) {
        let tabsToRestore = cache.getTabsSessionAndRemove(reCreateTabsOnRemoveWindow);

        reCreateTabsOnRemoveWindow = [];

        if (tabsToRestore.length) {
            await storage.set({tabsToRestore});

            let windows = await Windows.load(true);

            windows = windows.filter(function(win) {
                if (win.id === windowId) { // just in case
                    return false;
                }

                // exclude wrong popup window type and tab with extension url
                if (win.tabs.length === 1 && win.tabs[0].url.startsWith('moz-extension')) {
                    return false;
                }

                return true;
            });

            if (windows.length) {
                windows.forEach(win => loadingBrowserAction(true, win.id));

                try {
                    await tryRestoreMissedTabs(true);

                    windows.forEach(win => loadingBrowserAction(false, win.id));
                } catch (e) {
                    console.error('error create tabs: %s, tabsToRestore: %s', e, utils.stringify(tabsToRestore));
                    await utils.wait(500);
                    browser.runtime.reload();
                }
            }
        }
    }
}

let _currentWindowForLoadingBrowserAction = null;
async function loadingBrowserAction(start = true, windowId) {
    if (start) {
        _currentWindowForLoadingBrowserAction = windowId || await Windows.getLastFocusedNormalWindow();

        setBrowserAction(_currentWindowForLoadingBrowserAction, 'loading', undefined, false);
    } else {
        if (windowId) {
            _currentWindowForLoadingBrowserAction = windowId;
        }

        updateBrowserActionData(null, _currentWindowForLoadingBrowserAction);
    }
}

async function addUndoRemoveGroupItem(groupToRemove) {
    let restoreGroup = async function(group) {
        browser.menus.remove(Groups.CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP + group.id);
        browser.notifications.clear(Groups.CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP + group.id);

        let groups = await Groups.load();

        groups.push(group);

        await Groups.save(groups);

        updateMoveTabMenus();

        if (group.tabs.length && !group.isArchive) {
            await loadingBrowserAction();

            await createTabsSafe(Groups.setNewTabsParams(group.tabs, group), {
                sendMessageEachTab: false,
            });

            await loadingBrowserAction(false);
        }

        sendMessage({
            action: 'groups-updated',
        });

    }.bind(null, utils.clone(groupToRemove));

    browser.menus.create({
        id: Groups.CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP + groupToRemove.id,
        title: browser.i18n.getMessage('undoRemoveGroupItemTitle', groupToRemove.title),
        contexts: [browser.menus.ContextType.BROWSER_ACTION],
        icons: utils.getGroupIconUrl(groupToRemove, 16),
        onclick: restoreGroup,
    });

    if (options.showNotificationAfterGroupDelete) {
        utils.notify(
                browser.i18n.getMessage('undoRemoveGroupNotification', groupToRemove.title),
                undefined,
                Groups.CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP + groupToRemove.id,
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
        await Promise.all(menuIds.map(id => browser.menus.remove(id).catch(noop)));
        menuIds = [];
    }
}

async function createMoveTabMenus() {
    let hasBookmarksPermission = await browser.permissions.contains(constants.PERMISSIONS.BOOKMARKS);

    if (!options.showContextMenuOnTabs && !options.showContextMenuOnLinks && !hasBookmarksPermission) {
        return;
    }

    let windowId = await Windows.getLastFocusedNormalWindow();

    let groupId = cache.getWindowGroup(windowId),
        [currentGroup, groups] = await Groups.load(groupId || -1);

    await removeMoveTabMenus();

    hasBookmarksPermission && menuIds.push(browser.menus.create({
        id: 'stg-open-bookmark-in-group-parent',
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

    groups.forEach(function(group) {
        let groupIcon = utils.getGroupIconUrl(group, 16),
            groupTitle = String(utils.getGroupTitle(group, 'withActiveGroup withContainer'));

        options.showContextMenuOnTabs && menuIds.push(browser.menus.create({
            enabled: !group.isArchive,
            title: groupTitle,
            icons: groupIcon,
            parentId: 'stg-move-tab-parent',
            contexts: [browser.menus.ContextType.TAB],
            onclick: async function(info, tab) {
                let setActive = 2 === info.button,
                    tabIds = await Tabs.getHighlightedIds(tab.windowId, tab);

                await Tabs.move(tabIds, group.id, undefined, undefined, setActive);

                if (!setActive && info.modifiers.includes('Ctrl')) {
                    Tabs.discard(tabIds);
                }
            },
        }));

        options.showContextMenuOnLinks && menuIds.push(browser.menus.create({
            enabled: !group.isArchive,
            title: groupTitle,
            icons: groupIcon,
            parentId: 'stg-open-link-parent',
            contexts: [browser.menus.ContextType.LINK],
            onclick: async function(info) {
                if (!utils.isUrlAllowToCreate(info.linkUrl)) {
                    return;
                }

                let setActive = 2 === info.button,
                    newTab = await Tabs.add(group.id, undefined, info.linkUrl, info.linkText);

                if (setActive) {
                    applyGroup(newTab.windowId, group.id, newTab.id);
                }
            },
        }));

        hasBookmarksPermission && menuIds.push(browser.menus.create({
            enabled: !group.isArchive,
            title: groupTitle,
            icons: groupIcon,
            parentId: 'stg-open-bookmark-in-group-parent',
            contexts: [browser.menus.ContextType.BOOKMARK],
            onclick: async function(info) {
                if (!info.bookmarkId) {
                    utils.notify(browser.i18n.getMessage('bookmarkNotAllowed'));
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
                    let [firstTab] = await createTabsSafe(Groups.setNewTabsParams(tabsToCreate, group));

                    loadingBrowserAction(false);

                    if (setActive) {
                        applyGroup(undefined, group.id, firstTab.id);
                    } else {
                        utils.notify(browser.i18n.getMessage('tabsCreatedCount', tabsToCreate.length), 7000);
                    }
                } else {
                    loadingBrowserAction(false);
                    utils.notify(browser.i18n.getMessage('tabsNotCreated'), 7000);
                }
            },
        }));
    });

    options.showContextMenuOnTabs && menuIds.push(browser.menus.create({
        title: browser.i18n.getMessage('createNewGroup'),
        icons: {
            16: '/icons/group-new.svg',
        },
        parentId: 'stg-move-tab-parent',
        contexts: [browser.menus.ContextType.TAB],
        onclick: async function(info, tab) {
            let setActive = 2 === info.button,
                tabIds = await Tabs.getHighlightedIds(tab.windowId, tab);

            Groups.add(undefined, tabIds, undefined, setActive);
        },
    }));

    options.showContextMenuOnTabs && menuIds.push(browser.menus.create({
        type: browser.menus.ItemType.SEPARATOR,
        parentId: 'stg-move-tab-parent',
        contexts: [browser.menus.ContextType.TAB],
    }));

    options.showContextMenuOnTabs && menuIds.push(browser.menus.create({
        title: browser.i18n.getMessage('setTabIconAsGroupIcon'),
        enabled: Boolean(currentGroup),
        icons: {
            16: '/icons/image.svg',
        },
        parentId: 'stg-move-tab-parent',
        contexts: [browser.menus.ContextType.TAB],
        onclick: function(info, tab) {
            let groupId = cache.getWindowGroup(tab.windowId);

            if (!groupId) {
                return;
            }

            let iconUrl = utils.normalizeFavIcon(cache.getTabSession(tab.id, 'favIconUrl'));

            Groups.update(groupId, {iconUrl});
        }
    }));

    options.showContextMenuOnLinks && menuIds.push(browser.menus.create({
        title: browser.i18n.getMessage('createNewGroup'),
        icons: {
            16: '/icons/group-new.svg',
        },
        parentId: 'stg-open-link-parent',
        contexts: [browser.menus.ContextType.LINK],
        onclick: async function(info) {
            if (!utils.isUrlAllowToCreate(info.linkUrl)) {
                return;
            }

            let setActive = 2 === info.button,
                newGroup = await Groups.add(),
                newTab = await Tabs.add(newGroup.id, undefined, info.linkUrl, info.linkText);

            if (setActive) {
                applyGroup(undefined, newGroup.id, newTab.id);
            }
        },
    }));

    hasBookmarksPermission && menuIds.push(browser.menus.create({
        title: browser.i18n.getMessage('createNewGroup'),
        icons: {
            16: '/icons/group-new.svg',
        },
        parentId: 'stg-open-bookmark-in-group-parent',
        contexts: [browser.menus.ContextType.BOOKMARK],
        onclick: async function(info) {
            if (!info.bookmarkId) {
                utils.notify(browser.i18n.getMessage('bookmarkNotAllowed'));
                return;
            }

            let [bookmark] = await browser.bookmarks.get(info.bookmarkId);

            if (bookmark.type !== browser.bookmarks.BookmarkTreeNodeType.BOOKMARK || !utils.isUrlAllowToCreate(bookmark.url)) {
                utils.notify(browser.i18n.getMessage('bookmarkNotAllowed'));
                return;
            }

            let setActive = 2 === info.button,
                newGroup = await Groups.add(),
                newTab = await Tabs.add(newGroup.id, undefined, bookmark.url, bookmark.title);

            if (setActive) {
                applyGroup(undefined, newGroup.id, newTab.id);
            }
        },
    }));

    hasBookmarksPermission && menuIds.push(browser.menus.create({
        type: browser.menus.ItemType.SEPARATOR,
        parentId: 'stg-open-bookmark-in-group-parent',
        contexts: [browser.menus.ContextType.BOOKMARK],
    }));

    hasBookmarksPermission && menuIds.push(browser.menus.create({
        title: browser.i18n.getMessage('importBookmarkFolderAsNewGroup'),
        icons: {
            16: '/icons/bookmark-o.svg',
        },
        parentId: 'stg-open-bookmark-in-group-parent',
        contexts: [browser.menus.ContextType.BOOKMARK],
        onclick: async function(info) {
            if (!info.bookmarkId) {
                utils.notify(browser.i18n.getMessage('bookmarkNotAllowed'));
                return;
            }

            let [folder] = await browser.bookmarks.getSubTree(info.bookmarkId),
                groupsCreatedCount = 0;

            if (folder.type !== browser.bookmarks.BookmarkTreeNodeType.FOLDER) {
                utils.notify(browser.i18n.getMessage('bookmarkNotAllowed'));
                return;
            }

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
                utils.notify(browser.i18n.getMessage('groupsCreatedCount', groupsCreatedCount), 7000);
            } else {
                utils.notify(browser.i18n.getMessage('noGroupsCreated'), 7000);
            }
        },
    }));

    hasBookmarksPermission && menuIds.push(browser.menus.create({
        title: browser.i18n.getMessage('exportAllGroupsToBookmarks'),
        icons: {
            16: '/icons/bookmark.svg',
        },
        contexts: [browser.menus.ContextType.BROWSER_ACTION],
        onclick: () => exportAllGroupsToBookmarks(true),
    }));
}

async function _getBookmarkFolderFromTitle(title, parentId, index) {
    let bookmarks = await browser.bookmarks.search({
            title,
        }),
        bookmark = bookmarks.find(b => b.type === browser.bookmarks.BookmarkTreeNodeType.FOLDER && b.parentId === parentId);

    if (!bookmark) {
        let bookmarkData = {
            title,
            parentId,
            type: browser.bookmarks.BookmarkTreeNodeType.FOLDER,
        };

        if (Number.isFinite(index)) {
            bookmarkData.index = index;
        }

        bookmark = await browser.bookmarks.create(bookmarkData);
    }

    if (bookmark) {
        bookmark.children = await browser.bookmarks.getChildren(bookmark.id);
    }

    return bookmark;
}

async function exportGroupToBookmarks(group, groupIndex, showMessages = true) {
    let hasBookmarksPermission = await browser.permissions.contains(constants.PERMISSIONS.BOOKMARKS);

    if (!hasBookmarksPermission) {
        showMessages && utils.notify(browser.i18n.getMessage('noAccessToBookmarks'), undefined, undefined, undefined, () => browser.runtime.openOptionsPage());
        return;
    }

    if (!group) {
        throw TypeError('group has invalid type in exportGroupToBookmarks');
    }

    if (Number.isFinite(group)) {
        let [gr, groups, index] = await Groups.load(group, true);
        group = gr;
        groupIndex = index;
    }

    if (!group.tabs.length) {
        showMessages && utils.notify(browser.i18n.getMessage('groupWithoutTabs'));
        return;
    }

    if (showMessages) {
        loadingBrowserAction(true);
    }

    let rootFolder = {
        id: options.defaultBookmarksParent,
    };

    if (options.exportGroupToMainBookmarkFolder) {
        rootFolder = await _getBookmarkFolderFromTitle(options.autoBackupBookmarksFolderName, options.defaultBookmarksParent);
    }

    groupIndex = options.exportGroupToMainBookmarkFolder ? groupIndex : undefined;

    let groupBookmarkFolder = await _getBookmarkFolderFromTitle(group.title, rootFolder.id, groupIndex);

    if (groupBookmarkFolder.children.length) {
        let bookmarksToRemove = [];

        if (options.leaveBookmarksOfClosedTabs) {
            group.tabs.forEach(function(tab) {
                groupBookmarkFolder.children = groupBookmarkFolder.children.filter(function(bookmark) {
                    if (bookmark.type === browser.bookmarks.BookmarkTreeNodeType.BOOKMARK) {
                        if (bookmark.url === tab.url) {
                            bookmarksToRemove.push(bookmark);
                            return false;
                        }

                        return true;
                    }
                });
            });
        } else {
            bookmarksToRemove = groupBookmarkFolder.children.filter(bookmark => bookmark.type !== browser.bookmarks.BookmarkTreeNodeType.FOLDER);
        }

        await Promise.all(bookmarksToRemove.map(bookmark => browser.bookmarks.remove(bookmark.id).catch(noop)));

        let children = await browser.bookmarks.getChildren(groupBookmarkFolder.id);

        if (children.length) {
            if (children[0].type !== browser.bookmarks.BookmarkTreeNodeType.SEPARATOR) {
                await browser.bookmarks.create({
                    type: browser.bookmarks.BookmarkTreeNodeType.SEPARATOR,
                    index: 0,
                    parentId: groupBookmarkFolder.id,
                });
            }

            // found and remove duplicated separators
            let duplicatedSeparators = children.filter(function(separator, index) {
                return separator.type === browser.bookmarks.BookmarkTreeNodeType.SEPARATOR &&
                    children[index - 1] &&
                    children[index - 1].type === browser.bookmarks.BookmarkTreeNodeType.SEPARATOR;
            });

            if (children[children.length - 1].type === browser.bookmarks.BookmarkTreeNodeType.SEPARATOR && !duplicatedSeparators.includes(children[children.length - 1])) {
                duplicatedSeparators.push(children[children.length - 1]);
            }

            if (duplicatedSeparators.length) {
                await Promise.all(duplicatedSeparators.map(separator => browser.bookmarks.remove(separator.id).catch(noop)));
            }
        }
    }

    for (let index in group.tabs) {
        await browser.bookmarks.create({
            title: group.tabs[index].title,
            url: group.tabs[index].url,
            type: browser.bookmarks.BookmarkTreeNodeType.BOOKMARK,
            index: Number(index),
            parentId: groupBookmarkFolder.id,
        });
    }

    if (showMessages) {
        loadingBrowserAction(false);
        utils.notify(browser.i18n.getMessage('groupExportedToBookmarks', group.title), 7000);
    }

    return true;
}

function setBrowserAction(windowId, title, icon, enable) {
    console.info('setBrowserAction', {windowId, title, icon, enable});

    let winObj = windowId ? {windowId} : {};

    if ('loading' === title) {
        title = 'lang:loading';
        icon = 'loading';
    }

    if (title && title.startsWith('lang:')) {
        title = browser.i18n.getMessage(title.slice(5));
    }

    browser.browserAction.setTitle({
        ...winObj,
        title: title || manifest.browser_action.default_title,
    });

    if ('loading' === icon) {
        icon = '/icons/animate-spinner.svg';
    }

    browser.browserAction.setIcon({
        ...winObj,
        path: icon || manifest.browser_action.default_icon,
    });

    if (undefined !== enable) {
        if (enable) {
            browser.browserAction.enable();
        } else {
            browser.browserAction.disable();
        }
    }
}

async function updateBrowserActionData(groupId, windowId) {
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
        [group] = await Groups.load(groupId);
    }

    if (group) {
        setBrowserAction(windowId, utils.sliceText(utils.getGroupTitle(group, 'withContainer'), 43) + ' - STG', utils.getGroupIconUrl(group), true);
        prependWindowTitle(windowId, group.title);
    } else {
        setBrowserAction(windowId, undefined, undefined, true);
        prependWindowTitle(windowId);
    }
}

function prependWindowTitle(windowId, title) {
    if (options.prependGroupTitleToWindowTitle && windowId) {
        browser.windows.update(windowId, {
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
            tabIds: [],
            showTabAfterMovingItIntoThisGroup,
        };
    }

    if (!_tabsLazyMoving[groupId].tabIds.includes(tabId)) {
        _tabsLazyMoving[groupId].tabIds.push(tabId);
    }

    _tabsLazyMovingTimer = window.setTimeout(async function() {
        let groups = Object.values(_tabsLazyMoving);

        _tabsLazyMoving = {};

        for (let group of groups) {
            await Tabs.move(group.tabIds, group.id, undefined, undefined, group.showTabAfterMovingItIntoThisGroup);
        }
    }, 100);
}

async function onBeforeTabRequest({tabId, url, originUrl}) {
    let excludeTab = excludeTabsIds.includes(tabId) || tabId < 1;

    console.log('onBeforeTabRequest %s tabId: %s, url: %s', (excludeTab ? '🛑' : ''), tabId, url);

    if (excludeTab) {
        return;
    }

    let tab = await browser.tabs.get(tabId);

    if (utils.isTabPinned(tab)) {
        console.log('onBeforeTabRequest 🛑 cancel, tab is pinned');
        return;
    }

    if (containers.isTemporary(tab.cookieStoreId)) {
        console.log('onBeforeTabRequest 🛑 cancel, container is temporary', tab.cookieStoreId);
        return;
    }

    let oldUrl = tab.url;

    tab.url = url;

    cache.applyTabSession(tab);

    console.log('onBeforeRequest tab', tab);

    let [tabGroup, groups] = await Groups.load(tab.groupId || -1);

    if (!tabGroup) {
        return;
    }

    groups = groups.filter(group => !group.isArchive);

    if (!tabGroup.isSticky && tabGroup.newTabContainer !== containers.TEMPORARY_CONTAINER) {
        let destGroup = _getCatchedGroupForTab(groups, tab);

        if (destGroup && destGroup.id !== tabGroup.id) {
            console.log('onBeforeTabRequest move tab from groupId %d -> %d', tabGroup.id, destGroup.id);
            addTabToLazyMove(tab.id, destGroup.id, destGroup.showTabAfterMovingItIntoThisGroup);
            return;
        }
    }

    if (
        !tabGroup.newTabContainer ||
        tabGroup.newTabContainer === tab.cookieStoreId ||
        (!containers.isDefault(tab.cookieStoreId) && !tabGroup.ifNotDefaultContainerReOpenInNew)
    ) {
        return;
    }

    if (originUrl && originUrl.startsWith('moz-extension') && !originUrl.startsWith(addonUrlPrefix)) {
        console.log('onBeforeTabRequest 🛑 cancel by another addon', originUrl);
        return;
    }

    console.log('onBeforeTabRequest create tab', tab);

    Tabs.remove(tab.id);

    let newTabPromise = Tabs.create({
        url: tab.url,
        title: utils.isUrlEmpty(oldUrl) ? null : tab.title,
        favIconUrl: tab.favIconUrl,
        cookieStoreId: tab.cookieStoreId,
        thumbnail: tab.thumbnail,
        active: tab.active,
        index: tab.index,
        windowId: tab.windowId,
        ...Groups.getNewTabParams(tabGroup),
    });

    if (tab.hidden) {
        newTabPromise.then(async function({id}) {
            addExcludeTabsIds([id]);
            await browser.tabs.hide(id);
            removeExcludeTabsIds([id]);
        });
    }

    return {
        cancel: true,
    };
}

// wait for reload addon if found update
browser.runtime.onUpdateAvailable.addListener(function() {
    let interval = setInterval(function() {
        if (console.lastUsage < (Date.now() - 1000 * 10)) {
            clearInterval(interval);
            browser.runtime.reload();
        }
    }, 1000);
});

function addEvents() {
    browser.tabs.onCreated.addListener(onCreatedTab);
    browser.tabs.onActivated.addListener(onActivatedTab);
    browser.tabs.onMoved.addListener(onMovedTab);
    browser.tabs.onUpdated.addListener(onUpdatedTab, {
        // urls: ['<all_urls>'],
        // properties: [
        //     browser.tabs.UpdatePropertyName.DISCARDED, // not work if tab load
        //     browser.tabs.UpdatePropertyName.FAVICONURL,
        //     browser.tabs.UpdatePropertyName.HIDDEN,
        //     browser.tabs.UpdatePropertyName.PINNED,
        //     browser.tabs.UpdatePropertyName.TITLE,
        //     browser.tabs.UpdatePropertyName.STATUS,
        // ],
    });
    browser.tabs.onRemoved.addListener(onRemovedTab);

    browser.tabs.onAttached.addListener(onAttachedTab);
    browser.tabs.onDetached.addListener(onDetachedTab);

    browser.windows.onCreated.addListener(onCreatedWindow);
    browser.windows.onFocusChanged.addListener(onFocusChangedWindow);
    browser.windows.onRemoved.addListener(onRemovedWindow);

    browser.webRequest.onBeforeRequest.addListener(onBeforeTabRequest,
        {
            urls: ['<all_urls>'],
            types: [browser.webRequest.ResourceType.MAIN_FRAME],
        },
        [browser.webRequest.OnBeforeRequestOptions.BLOCKING]
    );
}

function removeEvents() {
    browser.tabs.onCreated.removeListener(onCreatedTab);
    browser.tabs.onActivated.removeListener(onActivatedTab);
    browser.tabs.onMoved.removeListener(onMovedTab);
    browser.tabs.onUpdated.removeListener(onUpdatedTab);
    browser.tabs.onRemoved.removeListener(onRemovedTab);

    browser.tabs.onAttached.removeListener(onAttachedTab);
    browser.tabs.onDetached.removeListener(onDetachedTab);

    browser.windows.onCreated.removeListener(onCreatedWindow);
    browser.windows.onFocusChanged.removeListener(onFocusChangedWindow);
    browser.windows.onRemoved.removeListener(onRemovedWindow);

    browser.webRequest.onBeforeRequest.removeListener(onBeforeTabRequest);
}

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

browser.runtime.onMessage.addListener(request => runAction(request));

browser.runtime.onMessageExternal.addListener(async function(request, sender) {
    let extensionRules = {};

    if (!window.BG.inited) {
        return {
            ok: false,
            error: '[STG] I am not yet loaded',
        };
    }

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

    return runAction(request, sender.id);
});

browser.commands.onCommand.addListener(function(command) {
    runAction({
        action: command,
    });
});

async function runAction(data, externalExtId) {
    let result = {
        ok: false,
    };

    if (!data.action) {
        result.error = '[STG] "action" is empty';
        return result;
    }

    console.info('runAction data:', data);

    try {
        let currentWindow = await Windows.getLastFocusedNormalWindow(false),
            actionWithTabs = ['discard-group', 'discard-other-groups', 'reload-all-tabs-in-current-group'],
            loadCurrentGroupWithTabs = currentWindow.groupId ? actionWithTabs.includes(data.action) : false,
            [currentGroup, groups] = await Groups.load(currentWindow.groupId || -1, loadCurrentGroupWithTabs),
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
                            utils.notify(result.error, 7000);
                        } else {
                            result.ok = await applyGroup(currentWindow.id, data.groupId);
                        }
                    } else {
                        data.groupId = 0;
                        result = await runAction(data, externalExtId);
                    }
                } else if ('new' === data.groupId) {
                    await Groups.add(undefined, undefined, data.title);
                    result = await runAction({
                        action: 'load-last-group',
                    }, externalExtId);
                } else {
                    let activeTab = await Tabs.getActive();

                    if (Tabs.isCanSendMessage(activeTab)) {
                        Tabs.sendMessage(activeTab.id, {
                            action: 'show-groups-popup',
                            popupAction: 'load-custom-group',
                            popupTitleLang: 'hotkeyActionTitleLoadCustomGroup',
                            groups: groups.map(Groups.mapForExternalExtension),
                            disableGroupIds: [currentGroup.id, ...groups.filter(group => group.isArchive).map(utils.keyId)],
                        });

                        result.ok = true;
                    } else {
                        result.error = browser.i18n.getMessage('thisTabIsNotSupported');
                        utils.notify(result.error, 7000);
                    }
                }
                break;
            case 'add-new-group':
                let newGroup = await Groups.add();
                result.ok = true;
                result.group = Groups.mapForExternalExtension(newGroup);
                break;
            case 'delete-current-group':
                if (currentGroup.id) {
                    await Groups.remove(currentGroup.id);

                    if (externalExtId) {
                        utils.notify(browser.i18n.getMessage('groupRemovedByExtension', [currentGroup.title, utils.getSupportedExternalExtensionName(externalExtId)]));
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
            case 'move-active-tab-to-custom-group':
                let activeTab = await Tabs.getActive();

                if (utils.isTabPinned(activeTab)) {
                    result.error = browser.i18n.getMessage('pinnedTabsAreNotSupported');
                    utils.notify(result.error, 7000);
                } else if (utils.isTabCanNotBeHidden(activeTab)) {
                    result.error = browser.i18n.getMessage('thisTabsCanNotBeHidden', utils.getTabTitle(activeTab, false, 25));
                    utils.notify(result.error, 7000);
                } else {
                    if (Number.isFinite(data.groupId) && 0 < data.groupId) {
                        if (groups.some(group => group.id === data.groupId)) {
                            let groupMoveTo = groups.find(group => group.id === data.groupId);

                            if (groupMoveTo.isArchive) {
                                result.error = browser.i18n.getMessage('groupIsArchived', groupMoveTo.title);
                                utils.notify(result.error, 7000);
                            } else {
                                await Tabs.move([activeTab.id], data.groupId);
                                result.ok = true;
                            }
                        } else {
                            data.groupId = 0;
                            result = await runAction(data, externalExtId);
                        }
                    } else if ('new' === data.groupId) {
                        await Groups.add(undefined, [activeTab.id], data.title);
                        result.ok = true;
                    } else {
                        if (Tabs.isCanSendMessage(activeTab)) {
                            Tabs.sendMessage(activeTab.id, {
                                action: 'show-groups-popup',
                                popupAction: 'move-active-tab-to-custom-group',
                                popupTitleLang: 'moveTabToGroupDisabledTitle',
                                groups: groups.map(Groups.mapForExternalExtension),
                                disableGroupIds: groups.filter(group => group.isArchive).map(utils.keyId),
                                focusedGroupId: activeTab.groupId,
                            });

                            result.ok = true;
                        } else {
                            result.error = browser.i18n.getMessage('thisTabIsNotSupported');
                            utils.notify(result.error, 7000);
                        }
                    }
                }
                break;
            case 'discard-group':
                let groupToDiscard = groups.find(group => group.id === data.groupId);

                if (groupToDiscard) {
                    if (groupToDiscard.isArchive) {
                        result.error = browser.i18n.getMessage('groupIsArchived', groupToDiscard.title);
                        utils.notify(result.error, 7000);
                    } else {
                        await Tabs.discard(groupToDiscard.tabs.map(utils.keyId));
                        result.ok = true;
                    }
                } else {
                    let activeTab = await Tabs.getActive();

                    if (Tabs.isCanSendMessage(activeTab)) {
                        Tabs.sendMessage(activeTab.id, {
                            action: 'show-groups-popup',
                            popupAction: 'discard-group',
                            popupTitleLang: 'discardGroupTitle',
                            groups: groups.map(Groups.mapForExternalExtension),
                            focusedGroupId: currentGroup.id,
                            disableGroupIds: groups.filter(group => group.isArchive).map(utils.keyId),
                            disableNewGroupItem: true,
                        });

                        result.ok = true;
                    } else {
                        result.error = browser.i18n.getMessage('thisTabIsNotSupported');
                        utils.notify(result.error, 7000);
                    }
                }
                break;
            case 'discard-other-groups':
                let tabIds = notArchivedGroups.reduce((acc, gr) => [...acc, ...(gr.id === currentGroup.id ? [] : gr.tabs.map(utils.keyId))], []);

                await Tabs.discard(tabIds);

                result.ok = true;
                break;
            case 'reload-all-tabs-in-current-group':
                if (currentGroup.id) {
                    await Tabs.reload(currentGroup.tabs.map(utils.keyId));
                    result.ok = true;
                }

                break;
            case 'create-temp-tab':
                await Tabs.createNative({
                    active: data.active,
                    cookieStoreId: containers.TEMPORARY_CONTAINER,
                });

                result.ok = true;

                break;
            case 'get-current-group':
                if (data.windowId) {
                    let groupId = cache.getWindowGroup(data.windowId);

                    if (groupId) {
                        let [group] = await Groups.load(groupId);

                        result.group = Groups.mapForExternalExtension(group);
                    } else {
                        result.group = null;
                    }

                    result.ok = true;
                } else {
                    throw 'windowId is required';
                }

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

    console.debug('save options', _options);

    let optionsKeys = Object.keys(_options);

    if (!optionsKeys.every(key => constants.allOptionsKeys.includes(key))) {
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

    if (isNaN(value) || 1 > value || 20 < value) {
        throw Error(utils.errorEventMessage('invalid autoBackupIntervalValue', options));
    }

    let intervalSec = null,
        overwrite = false;

    if ('hours' === options.autoBackupIntervalKey) {
        intervalSec = constants.HOUR_SEC;
    } else if ('days' === options.autoBackupIntervalKey) {
        if (1 === value) {
            // if backup will create every day - overwrite backups every 2 hours in order to keep as recent changes as possible
            overwrite = true;
            intervalSec = constants.HOUR_SEC * 2;
        } else {
            intervalSec = constants.DAY_SEC;
        }
    } else {
        throw Error(utils.errorEventMessage('invalid autoBackupIntervalKey', options));
    }

    let timeToBackup = value * intervalSec + options.autoBackupLastBackupTimeStamp;

    if (now > timeToBackup) {
        createBackup(options.autoBackupIncludeTabThumbnails, options.autoBackupIncludeTabFavIcons, true, overwrite);
        timer = value * intervalSec;
    } else {
        timer = timeToBackup - now;
    }

    _autoBackupTimer = setTimeout(resetAutoBackup, (timer + 10) * 1000);
}

async function createBackup(includeTabThumbnails, includeTabFavIcons, isAutoBackup = false, overwrite = false) {
    let [data, groups] = await Promise.all([storage.get(null), Groups.load(null, true)]);

    if (isAutoBackup && !data.groups.length) {
        return;
    }

    if (includeTabThumbnails) {
        includeTabThumbnails = options.showTabsWithThumbnailsInManageGroups;
    }

    let pinnedTabs = await Tabs.get(null, true, null);

    if (pinnedTabs.length) {
        data.pinnedTabs = Tabs.prepareForSave(pinnedTabs);
    }

    let containersToExport = [];

    data.groups = groups.map(function(group) {
        group.tabs = Tabs.prepareForSave(group.tabs, false, includeTabFavIcons, includeTabThumbnails);

        group.tabs.forEach(function({cookieStoreId}) {
            if (!containers.isDefault(cookieStoreId) && !containersToExport.includes(cookieStoreId)) {
                containersToExport.push(cookieStoreId);
            }
        });

        containersToExport.push(...group.catchTabContainers, group.newTabContainer);

        return group;
    });

    let allContainers = containers.getAll();

    data.containers = {};

    containersToExport.filter(Boolean).forEach(function(cookieStoreId) {
        if (cookieStoreId !== containers.TEMPORARY_CONTAINER && !data.containers[cookieStoreId]) {
            data.containers[cookieStoreId] = allContainers[cookieStoreId];
        }
    });

    if (isAutoBackup) {
        data.autoBackupLastBackupTimeStamp = options.autoBackupLastBackupTimeStamp = utils.unixNow();

        if (options.autoBackupGroupsToFile) {
            file.backup(data, true, overwrite);
        }

        if (options.autoBackupGroupsToBookmarks) {
            exportAllGroupsToBookmarks();
        }

        storage.set({
            autoBackupLastBackupTimeStamp: data.autoBackupLastBackupTimeStamp,
        });
    } else {
        await file.backup(data, false, overwrite);
    }
}

async function restoreBackup(data, clearAddonDataBeforeRestore = false) {
    removeEvents();

    await loadingBrowserAction();

    let {os} = await browser.runtime.getPlatformInfo(),
        isMac = os === browser.runtime.PlatformOs.MAC;

    if (true === clearAddonDataBeforeRestore) {
        await clearAddon(false);

        await utils.wait(1000);

        await containers.init();
    }

    let currentData = await storage.get(null),
        lastCreatedGroupPosition = Math.max(currentData.lastCreatedGroupPosition, data.lastCreatedGroupPosition || 0);

    currentData.groups = await Groups.load(null, true);

    if (!Array.isArray(data.hotkeys)) {
        data.hotkeys = [];
    } else if (!isMac) {
        data.hotkeys.forEach(hotkey => hotkey.metaKey = false);
    }

    data.groups = data.groups.map(function(group) {
        let newGroup = Groups.create(++lastCreatedGroupPosition, group.title);

        data.hotkeys.forEach(hotkey => hotkey.groupId === group.id ? (hotkey.groupId = newGroup.id) : null);

        delete group.id;
        delete group.title;

        newGroup = {
            ...newGroup,
            ...group,
        };

        let newTabParams = Groups.getNewTabParams(newGroup);

        newGroup.tabs = group.tabs
            .map(function(tab) {
                delete tab.active;
                delete tab.windowId;
                delete tab.index;
                delete tab.pinned;

                return Object.assign(tab, newTabParams);
            });

        if ('string' === typeof group.catchTabRules && group.catchTabRules.length) {
            newGroup.catchTabRules = group.catchTabRules;
        }

        return newGroup;
    });

    data = {
        ...currentData,
        ...data,
        lastCreatedGroupPosition,
        groups: [...currentData.groups, ...data.groups],
        hotkeys: [...currentData.hotkeys, ...data.hotkeys],
    };

    if (data.containers) {
        for (let cookieStoreId in data.containers) {
            let newCookieStoreId = await containers.normalize(cookieStoreId, data.containers[cookieStoreId]);

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

    let windows = await Windows.load(true);

    await syncTabs(data.groups, windows);

    if (Array.isArray(data.pinnedTabs)) {
        let currentPinnedTabs = await Tabs.get(null, true, null);

        data.pinnedTabs = data.pinnedTabs.filter(function(tab) {
            tab.pinned = true;
            return !currentPinnedTabs.some(t => t.url === tab.url);
        });

        if (data.pinnedTabs.length) {
            await createTabsSafe(data.pinnedTabs, {
                withRemoveEvents: false,
            });
        }
    }

    delete data.pinnedTabs;

    data.isBackupRestoring = true;

    await storage.set(data);

    await utils.wait(200);

    browser.runtime.reload(); // reload addon
}

async function clearAddon(reloadAddonOnFinish = true) {
    if (reloadAddonOnFinish) {
        await loadingBrowserAction();
    }

    removeEvents();

    let [tabs, windows] = await Promise.all([Tabs.get(null, null, null), Windows.load()]);

    await Promise.all(tabs.map(tab => cache.removeTabSession(tab.id)));
    await Promise.all(windows.map(win => cache.removeWindowSession(win.id)));

    await storage.clear();

    cache.clear();

    if (tabs.length) {
        await browser.tabs.show(tabs.map(utils.keyId));
    }

    window.localStorage.clear();

    if (reloadAddonOnFinish) {
        browser.runtime.reload(); // reload addon
    }
}

async function exportAllGroupsToBookmarks(showFinishMessage) {
    let hasBookmarksPermission = await browser.permissions.contains(constants.PERMISSIONS.BOOKMARKS);

    if (!hasBookmarksPermission) {
        return;
    }

    if (showFinishMessage) {
        await loadingBrowserAction();
    }

    let groups = await Groups.load(null, true);

    for (let groupIndex in groups) {
        await exportGroupToBookmarks(groups[groupIndex], groupIndex, false);
    }

    if (showFinishMessage) {
        loadingBrowserAction(false);

        utils.notify(browser.i18n.getMessage('allGroupsExportedToBookmarks'));
    }
}

window.BG = {
    inited: false,
    startTime: Date.now(),

    cache,
    openManageGroups,

    getOptions: () => utils.clone(options),
    saveOptions,

    containers,
    normalizeContainersInGroups,

    Groups,
    Windows,

    createTabsSafe,

    addUndoRemoveGroupItem,

    addExcludeTabsIds,
    removeExcludeTabsIds,

    sendMessage,
    sendExternalMessage,

    setBrowserAction,
    updateBrowserActionData,
    updateMoveTabMenus,

    loadingBrowserAction,

    exportGroupToBookmarks,
    applyGroup,

    runMigrateForData,

    createBackup,
    restoreBackup,
    clearAddon,

    canAddGroupToWindowAfterItCreated: true,

    browser,

    console,
    async saveConsoleLogs() {
        let urls = {},
            index = 1;

        let logs = console.getLogs();

        function normalize(obj) {
            if (Array.isArray(obj)) {
                return obj.map(normalize);
            } else if ('object' === utils.type(obj)) {
                for (let key in obj) {
                    if (['title', 'icon', 'icons', 'iconUrl', 'favIconUrl', 'thumbnail'].includes(key)) {
                        obj[key] = obj[key] ? ('some ' + key) : obj[key];
                    } else {
                        obj[key] = normalize(obj[key]);
                    }
                }

                return obj;
            } else if (String(obj).startsWith('data:image')) {
                return 'some data:image';
            } else if (String(obj).startsWith('http')) {
                return urls[obj] || (urls[obj] = 'URL_' + index++);
            }

            return obj;
        }

        logs = normalize(logs);

        return file.save({
            info: await utils.getInfo(),
            logs: logs,
        }, 'STG-debug-logs.json');
    },
};

function openHelp(page) {
    let url = browser.extension.getURL(`/help/${page}.html`);
    return Tabs.createUrlOnce(url);
}

async function runMigrateForData(data) {
    let currentVersion = manifest.version;

    if (data.version === currentVersion) {
        return data;
    }

    if (data.version === constants.DEFAULT_OPTIONS.version) {
        data.version = currentVersion;
        return data;
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
                if ('showGroupCircleInSearchedTab' in data) {
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
            migration() {
                data.groups.forEach(group => group.title = utils.unSafeHtml(group.title));
            },
        },
        {
            version: '3.0.9',
            migration() {
                data.hotkeys.forEach(hotkey => 'metaKey' in hotkey ? null : hotkey.metaKey = false);
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
            migration() {
                data.withoutSession = true;

                data.groups.forEach(function(group) {
                    delete group.windowId;
                    group.dontDiscardTabsAfterHideThisGroup = false;
                });
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
        let [currentMajor, currentMinor] = currentVersion.split('.'),
            [dataMajor, dataMinor] = data.version.split('.');

        if (dataMajor > currentMajor || (dataMajor == currentMajor && dataMinor > currentMinor)) {
            throw browser.i18n.getMessage('updateAddonToLatestVersion');
        }
    }

    data.version = currentVersion;

    if (keysToRemoveFromStorage.length) {
        keysToRemoveFromStorage.forEach(key => delete data[key]);
        await storage.remove(keysToRemoveFromStorage);
    }
    // end migration

    return data;
}

async function syncTabs(groups, windows, hideAllTabs = false) {
    let allTabs = windows.reduce((acc, win) => [...acc, ...win.tabs], []);

    if (hideAllTabs && allTabs.length) {
        await browser.tabs.hide(allTabs.map(utils.keyId));
    }

    for (let group of groups) {
        if (group.isArchive) {
            continue;
        }

        let tabs = [],
            newTabParams = Groups.getNewTabParams(group);

        for (let tab of group.tabs) {
            tab.groupId = group.id;

            tab.cookieStoreId = await containers.normalize(tab.cookieStoreId);

            let winTabIndex = allTabs.findIndex(winTab => winTab.url === tab.url && winTab.cookieStoreId === tab.cookieStoreId);

            if (winTabIndex !== -1) {
                let [winTab] = allTabs.splice(winTabIndex, 1);

                cache.applySession(winTab, tab);

                tabs.push(cache.setTabSession(winTab));
            } else {
                tabs.push(Tabs.create({
                    title: tab.title,
                    url: tab.url,
                    cookieStoreId: tab.cookieStoreId,
                    ...cache.applySession({}, tab),
                    ...newTabParams,
                }, false));
            }
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

function isStgNewTabUrl(url) {
    return url.startsWith('moz-extension') && url.includes('/stg-newtab/newtab.html');
}

async function removeSTGNewTabUrls(windows) {
    return Promise.all(windows.map(async function(win) {
        await Promise.all(win.tabs.map(async function(winTab) {
            if (isStgNewTabUrl(winTab.url)) {
                winTab.url = utils.normalizeUrl(winTab.url);

                if (winTab.url) {
                    await browser.tabs.update(winTab.id, {
                        url: winTab.url,
                        loadReplace: true,
                    });
                }
            }
        }));

        return win;
    }));
}

async function tryRestoreMissedTabs(withRemoveEvents = false) {
    // try to restore missed tabs
    let {tabsToRestore} = await storage.get('tabsToRestore');

    if (!tabsToRestore) {
        return;
    }

    if (tabsToRestore.length) {
        let groups = await Groups.load(null, true),
            groupsObj = {},
            foundTabIds = [];

        console.log('tryRestoreMissedTabs tabsToRestore', tabsToRestore);

        groups.forEach(function(group) {
            groupsObj[group.id] = {
                tabs: group.tabs,
                newTabParams: Groups.getNewTabParams(group),
            };
        });

        tabsToRestore = tabsToRestore
            .map(function(tab) {
                if (groupsObj[tab.groupId]) {
                    let winTab = groupsObj[tab.groupId].tabs.find(function(t) {
                        if (utils.isTabLoading(t) && utils.isUrlEmpty(t.url)) {
                            return true;
                        }

                        return !foundTabIds.includes(t.id) && t.url === tab.url && t.cookieStoreId === tab.cookieStoreId;
                    });

                    if (winTab) {
                        foundTabIds.push(winTab.id);
                    } else {
                        return Object.assign(tab, groupsObj[tab.groupId].newTabParams);
                    }
                }
            })
            .filter(Boolean);

        if (tabsToRestore.length) {
            await createTabsSafe(tabsToRestore, {
                withRemoveEvents: withRemoveEvents,
            });
        }
    }

    await storage.remove('tabsToRestore');
}

async function normalizeContainersInGroups(groups = null) {
    let _groups = groups ? groups : await Groups.load(),
        allContainers = containers.getAll();

    _groups.forEach(function(group) {
        let oldNewTabContainer = group.newTabContainer,
            oldCatchTabContainersLength = group.catchTabContainers.length;

        if (group.newTabContainer && group.newTabContainer !== containers.TEMPORARY_CONTAINER) {
            group.newTabContainer = containers.get(group.newTabContainer, 'cookieStoreId');
        }

        if (containers.isDefault(group.newTabContainer)) {
            group.newTabContainer = null;
        }

        group.catchTabContainers = group.catchTabContainers.filter(cookieStoreId => allContainers[cookieStoreId]);

        if (!groups && (
            oldNewTabContainer !== group.newTabContainer ||
            oldCatchTabContainersLength !== group.catchTabContainers.length
        )) {
            sendMessage({
                action: 'group-updated',
                group: {
                    id: group.id,
                    newTabContainer: group.newTabContainer,
                    catchTabContainers: group.catchTabContainers,
                },
            });
        }
    });

    return groups ? _groups : Groups.save(_groups);
}

// { reason: "update", previousVersion: "3.0.1", temporary: true }
// { reason: "install", temporary: true }
browser.runtime.onInstalled.addListener(function onInstalled({previousVersion, reason, temporary}) {
    if (!window.BG.inited) {
        setTimeout(onInstalled, 300, {previousVersion, reason, temporary});
        return;
    }

    if (temporary) {
        window.IS_PRODUCTION = false;
        console.restart();
        return;
    }

    if (browser.runtime.OnInstalledReason.INSTALL === reason ||
        (browser.runtime.OnInstalledReason.UPDATE === reason && -1 === utils.compareVersions(previousVersion, '4.0'))) {
        openHelp('welcome-v4');
    }
});

async function init() {
    let isAllowedIncognitoAccess = await browser.extension.isAllowedIncognitoAccess();

    if (isAllowedIncognitoAccess) {
        openHelp('disable-incognito');
        throw '';
    }

    let data = await storage.get(null);

    if (!Array.isArray(data.groups)) {
        utils.notify(browser.i18n.getMessage('ffFailedAndLostDataMessage'));

        data.groups = [];
    }

    await containers.init();

    try {
        data = await runMigrateForData(data); // run migration for data
    } catch (e) {
        utils.notify(String(e));
        throw '';
    }

    data.groups = await normalizeContainersInGroups(data.groups);

    options = utils.extractKeys(data, constants.allOptionsKeys, true);

    let windows = await Windows.load(true);

    if (!windows.length) {
        utils.notify(browser.i18n.getMessage('nowFoundWindowsAddonStoppedWorking'));
        throw '';
    }

    if (windows.some(win => win.tabs.some(tab => isStgNewTabUrl(tab.url)))) {
        windows = await removeSTGNewTabUrls(windows);
    }

    if (data.withoutSession) { // if version < 4
        let tempTabs = await Promise.all(windows.map(win => Tabs.createTempActiveTab(win.id)));

        data.groups = await syncTabs(data.groups, windows, true);

        tempTabs = tempTabs.filter(Boolean);

        if (tempTabs.length) {
            await Tabs.remove(tempTabs.map(utils.keyId));
        }

        windows = await Windows.load(true);
    }

    delete data.withoutSession;

    await Promise.all(windows.map(async function(win) {
        if (win.groupId && !data.groups.some(group => group.id === win.groupId)) {
            delete win.groupId;
            await cache.removeWindowSession(win.id);
        }

        if (win.groupId) {
            let showedTabs = [],
                tabsToShow = [],
                tabsToHide = [],
                moveTabsToWin = {};

            win.tabs.forEach(function(tab) {
                if (tab.groupId === win.groupId) {
                    if (tab.hidden) {
                        tabsToShow.push(tab);
                    }

                    showedTabs.push(tab);
                } else {
                    if (tab.groupId) {
                        if (data.groups.some(group => group.id === tab.groupId)) {
                            let tabsWin = windows.find(w => w.groupId === tab.groupId);

                            if (tabsWin) {
                                if (!moveTabsToWin[tabsWin.id]) {
                                    moveTabsToWin[tabsWin.id] = [];
                                }

                                moveTabsToWin[tabsWin.id].push(tab);

                                if (tab.hidden) {
                                    tabsToShow.push(tab);
                                }

                                return;
                            }
                        } else {
                            delete tab.groupId;
                            cache.removeTabGroup(tab.id);
                        }
                    } else if (!tab.hidden) {
                        if (utils.isTabLoading(tab) || tab.url.startsWith('file:') || tab.lastAccessed > window.BG.startTime) {
                            tab.groupId = win.groupId;
                            cache.setTabGroup(tab.id, win.groupId);
                            return;
                        }
                    }

                    if (!tab.hidden) {
                        tabsToHide.push(tab);
                    }
                }
            });

            for (let winId in moveTabsToWin) {
                await Tabs.moveNative(moveTabsToWin[winId], {
                    index: -1,
                    windowId: Number(winId),
                });
            }

            if (tabsToShow.length) {
                await browser.tabs.show(tabsToShow.map(utils.keyId));
            }

            if (tabsToHide.length) {
                if (tabsToHide.some(tab => tab.active)) {
                    if (showedTabs.length) {
                        await Tabs.setActive(undefined, showedTabs);
                    } else {
                        await Tabs.createTempActiveTab(win.id, false);
                    }
                }

                await browser.tabs.hide(tabsToHide.map(utils.keyId));
            }
        } else {
            let tabsToHide = [];

            win.tabs.forEach(function(tab) {
                if (tab.groupId) {
                    if (data.groups.some(group => tab.groupId === group.id)) {
                        tabsToHide.push(tab);
                    } else {
                        delete tab.groupId;
                        cache.removeTabGroup(tab.id);
                    }
                }
            });

            if (tabsToHide.length) {
                if (tabsToHide.some(tab => tab.active)) {
                    let visibleTabs = win.tabs.filter(tab => !tab.hidden && !tab.groupId);

                    if (visibleTabs.length) {
                        await Tabs.setActive(null, visibleTabs);
                    } else {
                        await Tabs.createTempActiveTab(win.id, false);
                    }
                }

                await browser.tabs.hide(tabsToHide.map(utils.keyId));
            }
        }
    }));

    if (data.isBackupRestoring) {
        delete data.isBackupRestoring;
        await storage.remove('isBackupRestoring');
        utils.notify(browser.i18n.getMessage('backupSuccessfullyRestored'));
    }

    await storage.set(data);

    resetAutoBackup();

    windows = await Windows.load();

    windows.forEach(function(win) {
        updateBrowserActionData(null, win.id);

        if (win.groupId) {
            groupsHistory.add(win.groupId);
        }
    });

    await tryRestoreMissedTabs(false);

    createMoveTabMenus();

    addEvents();

    window.BG.inited = true;
}

setBrowserAction(undefined, 'loading', undefined, false);

init()
    .then(function() {
        // send message for addon plugins
        sendExternalMessage({
            action: 'i-am-back',
        });

        // send message for addon options page if it's open
        sendMessage({
            action: 'i-am-back',
        });

        setBrowserAction(undefined, undefined, undefined, true);
    })
    .catch(function(e) {
        setBrowserAction(undefined, 'lang:clickHereToReloadAddon', '/icons/exclamation-triangle-yellow.svg', true);

        browser.browserAction.setPopup({
            popup: '',
        });

        browser.browserAction.onClicked.addListener(() => browser.runtime.reload());

        if (e) {
            utils.errorEventHandler(e);
        }
    });
