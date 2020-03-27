'use strict';

window.IS_TEMPORARY = false;

if (2 == window.localStorage.enableDebug) { // if debug was auto-enabled - disable on next start addon/browser
    delete window.localStorage.enableDebug;
}
console.restart();

const manageTabsPageUrl = browser.extension.getURL(MANAGE_TABS_URL);

let options = {},
    reCreateTabsOnRemoveWindow = [],
    menuIds = [],
    excludeTabsIds = new Set,

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

async function createTabsSafe(tabs) {
    if (options.reverseTabsOnCreate) {
        tabs.reverse();
    }

    let groupIds = tabs.map(tab => tab.groupId).filter(utils.onlyUniqueFilter),
        groupIdForNextTabs = (groupIds.length === 1 && groupIds[0]) ? groupIds[0] : null;

    if (groupIdForNextTabs) {
        BG.groupIdForNextTab = groupIdForNextTabs;
    }

    BG.skipCreateTab = true;

    let newTabs = await Promise.all(tabs.map(function(tab) {
        delete tab.active;
        delete tab.index;
        delete tab.windowId;

        return Tabs.createNative(tab);
    }));

    BG.skipCreateTab = false;

    BG.groupIdForNextTab = null;

    if (options.reverseTabsOnCreate) {
        newTabs.reverse();
    }

    newTabs = await Promise.all(newTabs.map(cache.setTabSession));

    let tabsToHide = newTabs.filter(tab => !tab.pinned && tab.groupId && !cache.getWindowId(tab.groupId)),
        tabsToHideIds = tabsToHide.map(utils.keyId);

    if (tabsToHideIds.length) {
        addExcludeTabIds(tabsToHideIds);
        await browser.tabs.hide(tabsToHideIds);
        removeExcludeTabIds(tabsToHideIds);

        tabsToHide.forEach(tab => tab.hidden = true);
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
                throw Error(errorEventMessage('applyGroup: groupToShow not found', {groupId, activeTabId}));
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

            // show tabs
            if (groupToShow.tabs.length) {
                let tabIds = groupToShow.tabs.map(utils.keyId);

                addExcludeTabIds(tabIds);

                if (!groupToShow.tabs.every(tab => tab.windowId === windowId)) {
                    // find new tabId, for temp fix bug https://bugzilla.mozilla.org/show_bug.cgi?id=1580879
                    let activeTabIndex = activeTabId ? groupToShow.tabs.findIndex(tab => tab.id === activeTabId) : null;

                    groupToShow.tabs = await Tabs.moveNative(groupToShow.tabs, {
                        index: -1,
                        windowId: windowId,
                    });

                    // for bug https://bugzilla.mozilla.org/show_bug.cgi?id=1580879
                    removeExcludeTabIds(tabIds);
                    tabIds = groupToShow.tabs.map(utils.keyId);
                    addExcludeTabIds(tabIds);

                    if (activeTabId) {
                        activeTabId = groupToShow.tabs[activeTabIndex].id;
                    }
                }

                await browser.tabs.show(tabIds);

                removeExcludeTabIds(tabIds);

                if (groupToShow.muteTabsWhenGroupCloseAndRestoreWhenOpen) {
                    Tabs.setMute(groupToShow.tabs, false);
                }
            }

            // set active tab
            if (activeTabId) {
                await Tabs.setActive(activeTabId);

                if (!groupToHide) {
                    let tabs = await Tabs.get(windowId);

                    tabs = tabs.filter(tab => !tab.groupId);

                    if (tabs.length === 1 && utils.isUrlEmpty(tabs[0].url)) {
                        Tabs.remove(tabs[0].id);
                    } else if (tabs.length) {
                        await browser.tabs.hide(tabs.map(utils.keyId));
                        utils.notify(browser.i18n.getMessage('tabsInThisWindowWereHidden'), undefined, 'tabsInThisWindowWereHidden');
                    }
                }
            } else if (groupToHide) {
                if (groupToHide.tabs.some(tab => tab.active)) {
                    let tabToActive = await Tabs.setActive(undefined, groupToShow.tabs);

                    if (!tabToActive) {
                        // group to show has no any tabs, try select pinned tab or create new one
                        let pinnedTabs = await Tabs.get(windowId, true),
                            activePinnedTab = await Tabs.setActive(undefined, pinnedTabs);

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

                let activePinnedTab = await Tabs.setActive(undefined, tabs.filter(tab => tab.pinned));

                // find other not pinned tabs
                tabs = tabs.filter(tab => !tab.pinned);

                let hideUnSyncTabs = false;

                if (activePinnedTab) {
                    hideUnSyncTabs = true;
                } else {
                    // no pinned tabs found, some tab without group is active

                    if (groupToShow.tabs.length) {
                        // set active group tab
                        await Tabs.setActive(undefined, groupToShow.tabs);

                        // if has one empty tab - remove it
                        if (tabs.length === 1 && utils.isUrlEmpty(tabs[0].url)) {
                            Tabs.remove(tabs[0].id);
                        } else {
                            hideUnSyncTabs = true;
                        }
                    } else {
                        if (tabs.length === 1 && utils.isUrlEmpty(tabs[0].url)) {
                            await cache.setTabGroup(tabs[0].id, groupToShow.id);
                        } else {
                            await Tabs.create({
                                active: true,
                                windowId,
                                ...Groups.getNewTabParams(groupToShow),
                            });

                            hideUnSyncTabs = true;
                        }
                    }
                }

                if (hideUnSyncTabs && tabs.length) {
                    await browser.tabs.hide(tabs.map(utils.keyId));
                    utils.notify(browser.i18n.getMessage('tabsInThisWindowWereHidden'), undefined, 'tabsInThisWindowWereHidden');
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

                    addExcludeTabIds(tabIds);

                    await browser.tabs.hide(tabIds);

                    removeExcludeTabIds(tabIds);

                    if (options.discardTabsAfterHide && !groupToHide.dontDiscardTabsAfterHideThisGroup) {
                        Tabs.discard(tabIds);
                    }
                }

                if (tabsIdsToRemove.length) {
                    Tabs.remove(tabsIdsToRemove);
                }
            }

            updateMoveTabMenus();

            updateBrowserActionData(groupToShow.id);

            if (!applyFromHistory) {
                groupsHistory.add(groupId);
            }
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
            errorEventHandler(e);

            updateBrowserActionData(null, windowId);

            if (!groupWindowId) {
                excludeTabsIds.clear();
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

async function onCreatedTab(tab) {
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
}

function addExcludeTabIds(tabIds) {
    tabIds.forEach(excludeTabsIds.add, excludeTabsIds);
}

function removeExcludeTabIds(tabIds) {
    tabIds.forEach(excludeTabsIds.delete, excludeTabsIds);
}

async function onUpdatedTab(tabId, changeInfo, tab) {
    let excludeTab = excludeTabsIds.has(tab.id);

    console.log('onUpdatedTab %s tabId: %s, changeInfo:', (excludeTab ? '🛑' : ''), tab.id, changeInfo);

    if (excludeTab) {
        return;
    }

    if (changeInfo.hasOwnProperty('title') || changeInfo.hasOwnProperty('url')) {
        cache.setTab(tab);
    }

    if (utils.isTabPinned(tab) && !changeInfo.hasOwnProperty('pinned')) {
        console.log('onUpdatedTab 🛑 tab is pinned tabId: %s:', tab.id);
        return;
    }

    if (!cache.hasTab(tab.id)) {
        console.log('onUpdatedTab 🛑 tab not yet created tabId:', tab.id);
        return;
    }

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
                        let [winGroup] = await Groups.load(winGroupId, true);

                        if (winGroup.tabs.length) {
                            applyGroup(tab.windowId, tabGroupId, tab.id);
                            return;
                        }
                    }

                    let tabs = await Tabs.get(tab.windowId, null);

                    tabs = tabs.filter(tab => !tab.groupId);

                    let activePinnedTab = await Tabs.setActive(undefined, tabs.filter(tab => tab.pinned));

                    if (!activePinnedTab) {
                        let unSyncTabs = tabs.filter(tab => !tab.pinned);

                        if (unSyncTabs.length) {
                            await Tabs.setActive(undefined, unSyncTabs);
                        } else {
                            await Tabs.createTempActiveTab(tab.windowId, false);
                        }
                    }

                    excludeTabsIds.add(tab.id);
                    await browser.tabs.hide(tab.id);
                    excludeTabsIds.delete(tab.id);
                } else {
                    cache.setTabGroup(tab.id, winGroupId);
                }
            }
        }

        return;
    }

    if (options.showTabsWithThumbnailsInManageGroups && utils.isTabLoaded(changeInfo) && (tabGroupId || winGroupId)) {
        Tabs.updateThumbnail(tab.id);
    }
}

function onRemovedTab(tabId, {isWindowClosing, windowId}) {
    console.log('onRemovedTab', {tabId, isWindowClosing, windowId});

    if (isWindowClosing) {
        reCreateTabsOnRemoveWindow.push(tabId);
    } else {
        cache.removeTab(tabId);
    }
}

function onAttachedTab(tabId, {newWindowId}) {
    let excludeTab = excludeTabsIds.has(tabId);

    console.log('onAttachedTab', (excludeTab && '🛑'), {tabId, newWindowId});

    if (excludeTab) {
        return;
    }

    let groupId = cache.getWindowGroup(newWindowId);

    cache.setTabGroup(tabId, groupId);
}

async function onCreatedWindow(win) {
    console.log('onCreatedWindow', win);

    if (BG.skipAddGroupToNextNewWindow) {
        BG.skipAddGroupToNextNewWindow = false;
        return;
    }

    if (utils.isWindowAllow(win)) {
        win = await cache.loadWindowSession(win);

        if (win.groupId) {
            await cache.removeWindowSession(win.id);

            updateBrowserActionData(null, win.id);

            let winTabs = await Tabs.get(win.id, null, null);
            winTabs.forEach(tab => cache.removeTabGroup(tab.id));
        } else if (options.createNewGroupWhenOpenNewWindow) {
            await Groups.add(win.id);
        }

        tryRestoreMissedTabs();
    } else {
        let winTabs = await Tabs.get(win.id, null, null, {
            windowType: null,
        });

        addExcludeTabIds(winTabs.map(utils.keyId));
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
                    await tryRestoreMissedTabs();

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
        browser.menus.remove(CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP + group.id);
        browser.notifications.clear(CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP + group.id);

        let groups = await Groups.load();

        groups.push(group);

        groups = await normalizeContainersInGroups(groups);

        await Groups.save(groups);

        updateMoveTabMenus();

        if (group.tabs.length && !group.isArchive) {
            await loadingBrowserAction();

            group.tabs = await createTabsSafe(Groups.setNewTabsParams(group.tabs, group));

            await loadingBrowserAction(false);
        }

        sendMessage({
            action: 'group-added',
            group,
        });

    }.bind(null, utils.clone(groupToRemove));

    browser.menus.create({
        id: CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP + groupToRemove.id,
        title: browser.i18n.getMessage('undoRemoveGroupItemTitle', groupToRemove.title),
        contexts: [browser.menus.ContextType.BROWSER_ACTION],
        icons: utils.getGroupIconUrl(groupToRemove, 16),
        onclick: restoreGroup,
    });

    if (options.showNotificationAfterGroupDelete) {
        utils.notify(
                browser.i18n.getMessage('undoRemoveGroupNotification', groupToRemove.title),
                7000,
                CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP + groupToRemove.id,
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
    let hasBookmarksPermission = await browser.permissions.contains(PERMISSIONS.BOOKMARKS);

    if (!options.showContextMenuOnTabs && !options.showContextMenuOnLinks && !hasBookmarksPermission) {
        return;
    }

    let windowId = await Windows.getLastFocusedNormalWindow();

    let groupId = cache.getWindowGroup(windowId),
        [currentGroup, groups] = await Groups.load(groupId || -1);

    await removeMoveTabMenus();

    const temporaryContainer = containers.get(TEMPORARY_CONTAINER);

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
        onclick: function(info, tab) {
            if (!utils.isUrlAllowToCreate(tab.url)) {
                utils.notify(browser.i18n.getMessage('thisUrlsAreNotSupported', tab.url), 7000, 'thisUrlsAreNotSupported');
                return;
            }

            let setActive = 2 === info.button;

            Tabs.createNative({
                ...tab,
                active: setActive,
                cookieStoreId: TEMPORARY_CONTAINER,
            });
        }
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

            cache.applyTabSession(tab);

            tab = utils.normalizeTabFavIcon(tab);

            Groups.update(groupId, {
                iconUrl: tab.favIconUrl,
            });
        }
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
        onclick: async function(info) {
            if (!utils.isUrlAllowToCreate(info.linkUrl)) {
                return;
            }

            if (!utils.isUrlAllowToCreate(info.linkUrl)) {
                utils.notify(browser.i18n.getMessage('thisUrlsAreNotSupported', info.linkUrl), 7000, 'thisUrlsAreNotSupported');
                return;
            }

            let setActive = 2 === info.button;

            Tabs.createNative({
                url: info.linkUrl,
                title: info.linkText,
                active: setActive,
                cookieStoreId: TEMPORARY_CONTAINER,
            });
        },
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
        onclick: async function(info) {
            if (!info.bookmarkId) {
                utils.notify(browser.i18n.getMessage('bookmarkNotAllowed'), 7000, 'bookmarkNotAllowed');
                return;
            }

            let [bookmark] = await browser.bookmarks.get(info.bookmarkId);

            if (bookmark.type !== browser.bookmarks.BookmarkTreeNodeType.BOOKMARK) {
                utils.notify(browser.i18n.getMessage('bookmarkNotAllowed'), 7000, 'bookmarkNotAllowed');
                return;
            }

            if (!utils.isUrlAllowToCreate(bookmark.url)) {
                utils.notify(browser.i18n.getMessage('thisUrlsAreNotSupported', bookmark.url), 7000, 'thisUrlsAreNotSupported');
                return;
            }

            let setActive = 2 === info.button;

            Tabs.createNative({
                url: bookmark.url,
                title: bookmark.title,
                active: setActive,
                cookieStoreId: TEMPORARY_CONTAINER,
            });

        },
    }));

    hasBookmarksPermission && groups.length && menuIds.push(browser.menus.create({
        type: browser.menus.ItemType.SEPARATOR,
        parentId: 'stg-open-bookmark-parent',
        contexts: [browser.menus.ContextType.BOOKMARK],
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
                    utils.notify(browser.i18n.getMessage('thisUrlsAreNotSupported', info.linkUrl), 7000, 'thisUrlsAreNotSupported');
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
            parentId: 'stg-open-bookmark-parent',
            contexts: [browser.menus.ContextType.BOOKMARK],
            onclick: async function(info) {
                if (!info.bookmarkId) {
                    utils.notify(browser.i18n.getMessage('bookmarkNotAllowed'), 7000, 'bookmarkNotAllowed');
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

            runAction({
                action: 'add-new-group',
                proposalTitle: tab.title,
                tabIds: tabIds,
                showTabsAfterMoving: setActive,
            });
        },
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
                utils.notify(browser.i18n.getMessage('thisUrlsAreNotSupported', info.linkUrl), 7000, 'thisUrlsAreNotSupported');
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
        },
    }));

    hasBookmarksPermission && menuIds.push(browser.menus.create({
        title: browser.i18n.getMessage('createNewGroup'),
        icons: {
            16: '/icons/group-new.svg',
        },
        parentId: 'stg-open-bookmark-parent',
        contexts: [browser.menus.ContextType.BOOKMARK],
        onclick: async function(info) {
            if (!info.bookmarkId) {
                utils.notify(browser.i18n.getMessage('bookmarkNotAllowed'), 7000, 'bookmarkNotAllowed');
                return;
            }

            let [bookmark] = await browser.bookmarks.get(info.bookmarkId);

            if (bookmark.type === browser.bookmarks.BookmarkTreeNodeType.BOOKMARK) {
                if (!utils.isUrlAllowToCreate(bookmark.url)) {
                    utils.notify(browser.i18n.getMessage('bookmarkNotAllowed'), 7000, 'bookmarkNotAllowed');
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
                    utils.notify(browser.i18n.getMessage('groupsCreatedCount', groupsCreatedCount), 7000);
                } else {
                    utils.notify(browser.i18n.getMessage('noGroupsCreated'), 7000);
                }
            } else {
                utils.notify(browser.i18n.getMessage('bookmarkNotAllowed'), 7000, 'bookmarkNotAllowed');
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

    menuIds.push(browser.menus.create({
        title: browser.i18n.getMessage('reopenTabsWithTemporaryContainersInNew'),
        icons: {
            16: 'resource://usercontext-content/chill.svg',
        },
        contexts: [browser.menus.ContextType.BROWSER_ACTION],
        onclick: async function() {
            let windows = await Windows.load(true, true, true),
                allTabs = windows.reduce((acc, win) => (acc.push(...win.tabs), acc), []),
                cookieStoreIdsToRemove = new Set,
                tabsToCreate = [];

            let tabsIdsToRemove = allTabs
                .filter(tab => containers.isTemporary(tab.cookieStoreId))
                .reverse()
                .map(function(tab) {
                    cookieStoreIdsToRemove.add(tab.cookieStoreId);

                    tabsToCreate.push({
                        ...tab,
                        cookieStoreId: TEMPORARY_CONTAINER,
                    });

                    return tab.id;
                });

            if (tabsToCreate.length) {
                // create tabs
                BG.skipCreateTab = true;

                let newTabs = await Promise.all(tabsToCreate.map(Tabs.createNative));

                BG.skipCreateTab = false;

                newTabs = await Promise.all(newTabs.map(cache.setTabSession));

                let tabsToHide = newTabs.filter(tab => tab.groupId && !cache.getWindowId(tab.groupId)),
                    tabsToHideIds = tabsToHide.map(utils.keyId);

                if (tabsToHideIds.length) {
                    addExcludeTabIds(tabsToHideIds);
                    await browser.tabs.hide(tabsToHideIds);
                    removeExcludeTabIds(tabsToHideIds);
                }

                // remove old tabs
                await Tabs.remove(tabsIdsToRemove);

                // remove temporary containers
                cookieStoreIdsToRemove.forEach(containers.remove);
            }
        },
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
    let hasBookmarksPermission = await browser.permissions.contains(PERMISSIONS.BOOKMARKS);

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

    const {BOOKMARK, FOLDER, SEPARATOR} = browser.bookmarks.BookmarkTreeNodeType;

    let rootFolder = {
        id: options.defaultBookmarksParent,
    };

    if (options.exportGroupToMainBookmarkFolder) {
        rootFolder = await _getBookmarkFolderFromTitle(options.autoBackupBookmarksFolderName, options.defaultBookmarksParent);
    }

    groupIndex = options.exportGroupToMainBookmarkFolder ? groupIndex : undefined;

    let groupBookmarkFolder = await _getBookmarkFolderFromTitle(group.title, rootFolder.id, groupIndex);

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
            tabIds: new Set,
            showTabAfterMovingItIntoThisGroup,
        };
    }

    _tabsLazyMoving[groupId].tabIds.add(tabId);

    _tabsLazyMovingTimer = window.setTimeout(async function() {
        let groups = Object.values(_tabsLazyMoving);

        _tabsLazyMoving = {};

        for (let group of groups) {
            await Tabs.move(Array.from(group.tabIds), group.id, undefined, undefined, group.showTabAfterMovingItIntoThisGroup);
        }
    }, 100);
}

let canceledRequests = new Set;
async function onBeforeTabRequest({tabId, url, originUrl, requestId, frameId}) {
    if (frameId !== 0 || tabId === -1) {
        return {};
    }

    if (canceledRequests.has(requestId)) {
        return {
            cancel: true,
        };
    }

    let excludeTab = excludeTabsIds.has(tabId);

    console.log('onBeforeTabRequest %s tabId: %s, url: %s, originUrl is STG: %s', (excludeTab ? '🛑' : ''), tabId, url, originUrl && originUrl.startsWith(addonUrlPrefix));

    if (excludeTab) {
        return {};
    }

    let tab = await browser.tabs.get(tabId);

    if (utils.isTabPinned(tab)) {
        console.log('onBeforeTabRequest 🛑 cancel, tab is pinned');
        return {};
    }

    if (containers.isTemporary(tab.cookieStoreId)) {
        console.log('onBeforeTabRequest 🛑 cancel, container is temporary', tab.cookieStoreId);
        return {};
    }

    if (utils.isUrlEmpty(tab.url)) {
        delete tab.title;
    }

    cache.applyTabSession(tab);

    if (!tab.groupId) {
        return {};
    }

    console.log('onBeforeRequest tab', tab);

    tab.url = url;

    let [tabGroup, groups] = await Groups.load(tab.groupId);

    if (!tabGroup.isSticky) {
        let destGroup = Groups.getCatchedForTab(groups, tabGroup, tab);

        if (destGroup) {
            cache.backupTabForMove(tab);
            console.log('onBeforeTabRequest move tab from groupId %d -> %d', tabGroup.id, destGroup.id);
            addTabToLazyMove(tab.id, destGroup.id, destGroup.showTabAfterMovingItIntoThisGroup);
            return {};
        }
    }

    if (!tabGroup.newTabContainer || tabGroup.newTabContainer === tab.cookieStoreId) {
        return {};
    }

    let newTabParams = {
        url: tab.url,
        title: tab.title,
        index: tab.index,
        active: tab.active,
        windowId: tab.windowId,
        openerTabId: tab.openerTabId,
        favIconUrl: tab.favIconUrl,
        thumbnail: tab.thumbnail,
        ...Groups.getNewTabParams(tabGroup),
    };

    if (tabGroup.ifDifferentContainerReOpen) {
        if (originUrl && originUrl.startsWith(addonUrlPrefix)) {
            originUrl = null;
        }

        if (originUrl && originUrl.startsWith('moz-extension')) {
            if (tab.hidden) {
                //
            } else {
                newTabParams.url = utils.setUrlSearchParams(browser.extension.getURL('/help/open-in-container.html'), {
                    url: tab.url,
                    currentCookieStoreId: tabGroup.newTabContainer,
                    anotherCookieStoreId: tab.cookieStoreId,
                    uuid: utils.getUUIDFromUrl(originUrl),
                    groupId: tabGroup.id,
                });

                newTabParams.active = true;
            }
        }
    } else {
        if (!containers.isDefault(tab.cookieStoreId)) {
            return {};
        }
    }

    canceledRequests.add(requestId);
    setTimeout(() => canceledRequests.delete(requestId), 2000);

    let newTabPromise = Tabs.create(newTabParams);

    if (tab.hidden) {
        newTabPromise.then(async function({id}) {
            excludeTabsIds.add(id);
            await browser.tabs.hide(id);
            excludeTabsIds.delete(id);
        });
    }

    Tabs.remove(tab.id);

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
    browser.tabs.onCreated.addListener(onCreatedTab);
    browser.tabs.onUpdated.addListener(onUpdatedTab, {
        properties: [
            browser.tabs.UpdatePropertyName.TITLE, // for cache
            browser.tabs.UpdatePropertyName.STATUS, // for check update url and thumbnail
            browser.tabs.UpdatePropertyName.FAVICONURL, // for session
            browser.tabs.UpdatePropertyName.HIDDEN,
            browser.tabs.UpdatePropertyName.PINNED,
        ],
    });
    browser.tabs.onRemoved.addListener(onRemovedTab);

    browser.tabs.onAttached.addListener(onAttachedTab);

    browser.windows.onCreated.addListener(onCreatedWindow);
    browser.windows.onFocusChanged.addListener(onFocusChangedWindow);
    browser.windows.onRemoved.addListener(onRemovedWindow);
}

function removeEvents() {
    browser.tabs.onCreated.removeListener(onCreatedTab);
    browser.tabs.onUpdated.removeListener(onUpdatedTab);
    browser.tabs.onRemoved.removeListener(onRemovedTab);

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

browser.commands.onCommand.addListener(command => runAction(command));

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

async function runAction(data, externalExtId) {
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

    console.info('runAction', {data, externalExtId});

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
                            utils.notify(result.error, 7000, 'groupIsArchived');
                        } else {
                            result.ok = await applyGroup(currentWindow.id, data.groupId);
                        }
                    } else {
                        delete data.groupId;
                        result = await runAction(data, externalExtId);
                    }
                } else if ('new' === data.groupId) {
                    let {ok, group} = await runAction({
                        action: 'add-new-group',
                        proposalTitle: data.title,
                    }, externalExtId);

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
                            groups: groups.map(Groups.mapForExternalExtension),
                            disableGroupIds: [currentGroup.id, ...groups.filter(group => group.isArchive).map(utils.keyId)],
                        });

                        result.ok = true;
                    } else {
                        result.error = browser.i18n.getMessage('impossibleToAskUserAboutAction', [activeTab.title, browser.i18n.getMessage('hotkeyActionTitleLoadCustomGroup')]);
                        utils.notify(result.error, 15000, 'impossibleToAskUserAboutAction', undefined, openNotSupportedUrlHelper);
                    }
                }
                break;
            case 'unload-group':
                result.ok = await Groups.unload(currentGroup.id);
                break;
            case 'add-new-group':
                if (!options.alwaysAskNewGroupName || data.title) {
                    // only this addon can move tabs to new group
                    let newGroup = await Groups.add(undefined, (!externalExtId && data.tabIds), data.title, data.showTabsAfterMoving);

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
                            }, externalExtId);
                        } else {
                            result.error = 'title in empty - skip create group';
                        }
                    } else {
                        result = await runAction({
                            action: 'add-new-group',
                            title: data.proposalTitle || browser.i18n.getMessage('newGroupTitle', lastCreatedGroupPosition + 1),
                            tabIds: data.tabIds,
                            showTabsAfterMoving: data.showTabsAfterMoving,
                        }, externalExtId);

                        if (options.alwaysAskNewGroupName) {
                            result.error = browser.i18n.getMessage('impossibleToAskUserAboutAction', [activeTab.title, browser.i18n.getMessage('createNewGroup')]);
                            utils.notify(result.error, 15000, 'impossibleToAskUserAboutAction', undefined, openNotSupportedUrlHelper);
                        }
                    }
                }
                break;
            case 'rename-group':
                if (!groups.length) {
                    result.error = browser.i18n.getMessage('noGroupsAvailable');
                    utils.notify(result.error, 7000, 'noGroupsAvailable');
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
                        utils.notify(result.error, 15000, 'impossibleToAskUserAboutAction', undefined, openNotSupportedUrlHelper);
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
                                result = await runAction(data, externalExtId);
                            } else {
                                result.error = 'title in empty - skip rename group';
                            }
                        } else {
                            result.error = browser.i18n.getMessage('impossibleToAskUserAboutAction', [activeTab.title, browser.i18n.getMessage('hotkeyActionTitleRenameGroup')]);
                            utils.notify(result.error, 15000, 'impossibleToAskUserAboutAction', undefined, openNotSupportedUrlHelper);
                        }
                    } else {
                        result = await runAction('rename-group', externalExtId);
                    }
                } else if (data.groupId && data.title && typeof data.title === 'string') {
                    let groupToRename = groups.find(group => group.id === data.groupId);

                    if (groupToRename) {
                        Groups.update(groupToRename.id, {
                            title: data.title,
                        });
                        result.ok = true;
                    } else {
                        result = await runAction('rename-group', externalExtId);
                    }
                } else {
                    result = await runAction('rename-group', externalExtId);
                }
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
                    utils.notify(result.error, 7000, 'pinnedTabsAreNotSupported');
                } else if (utils.isTabCanNotBeHidden(activeTab)) {
                    result.error = browser.i18n.getMessage('thisTabsCanNotBeHidden', utils.getTabTitle(activeTab, false, 25));
                    utils.notify(result.error, 7000, 'thisTabsCanNotBeHidden');
                } else {
                    if (Number.isFinite(data.groupId) && 0 < data.groupId) {
                        if (groups.some(group => group.id === data.groupId)) {
                            let groupMoveTo = groups.find(group => group.id === data.groupId);

                            if (groupMoveTo.isArchive) {
                                result.error = browser.i18n.getMessage('groupIsArchived', groupMoveTo.title);
                                utils.notify(result.error, 7000, 'groupIsArchived');
                            } else {
                                await Tabs.move([activeTab.id], data.groupId);
                                result.ok = true;
                            }
                        } else {
                            delete data.groupId;
                            result = await runAction(data, externalExtId);
                        }
                    } else if ('new' === data.groupId) {
                        let {ok} = await runAction({
                            action: 'add-new-group',
                            title: data.title,
                            proposalTitle: activeTab.title,
                            tabIds: [activeTab.id],
                        }, externalExtId);

                        result.ok = ok;
                    } else {
                        if (Tabs.isCanSendMessage(activeTab)) {
                            Tabs.sendMessage(activeTab.id, {
                                action: 'show-groups-popup',
                                popupAction: 'move-active-tab-to-custom-group',
                                popupTitle: browser.i18n.getMessage('moveTabToGroupDisabledTitle'),
                                groups: groups.map(Groups.mapForExternalExtension),
                                disableGroupIds: groups.filter(group => group.isArchive).map(utils.keyId),
                                focusedGroupId: activeTab.groupId,
                            });

                            result.ok = true;
                        } else {
                            result.error = browser.i18n.getMessage('impossibleToAskUserAboutAction', [activeTab.title, browser.i18n.getMessage('moveTabToGroupDisabledTitle')]);
                            utils.notify(result.error, 15000, 'impossibleToAskUserAboutAction', undefined, openNotSupportedUrlHelper);
                        }
                    }
                }
                break;
            case 'discard-group':
                let groupToDiscard = groups.find(group => group.id === data.groupId);

                if (groupToDiscard) {
                    if (groupToDiscard.isArchive) {
                        result.error = browser.i18n.getMessage('groupIsArchived', groupToDiscard.title);
                        utils.notify(result.error, 7000, 'groupIsArchived');
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
                            popupTitle: browser.i18n.getMessage('hotkeyActionTitleDiscardGroup'),
                            groups: groups.map(Groups.mapForExternalExtension),
                            focusedGroupId: currentGroup.id,
                            disableGroupIds: groups.filter(group => group.isArchive).map(utils.keyId),
                            disableNewGroupItem: true,
                        });

                        result.ok = true;
                    } else {
                        result.error = browser.i18n.getMessage('impossibleToAskUserAboutAction', [activeTab.title, browser.i18n.getMessage('hotkeyActionTitleDiscardGroup')]);
                        utils.notify(result.error, 15000, 'impossibleToAskUserAboutAction', undefined, openNotSupportedUrlHelper);
                    }
                }
                break;
            case 'discard-other-groups':
                let tabIds = notArchivedGroups.reduce(function(acc, gr) {
                    if (gr.id !== currentGroup.id && !cache.getWindowId(gr.id)) {
                        acc.push(...gr.tabs.map(utils.keyId));
                    }
                    return acc;
                }, []);

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
                    cookieStoreId: TEMPORARY_CONTAINER,
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
        throw Error(errorEventMessage('invalid autoBackupIntervalValue', options));
    }

    let intervalSec = null,
        overwrite = false;

    if ('hours' === options.autoBackupIntervalKey) {
        intervalSec = HOUR_SEC;
    } else if ('days' === options.autoBackupIntervalKey) {
        if (1 === value) {
            // if backup will create every day - overwrite backups every 2 hours in order to keep as recent changes as possible
            overwrite = true;
            intervalSec = HOUR_SEC * 2;
        } else {
            intervalSec = DAY_SEC;
        }
    } else {
        throw Error(errorEventMessage('invalid autoBackupIntervalKey', options));
    }

    let timeToBackup = value * intervalSec + options.autoBackupLastBackupTimeStamp;

    if (now > timeToBackup) {
        createBackup(options.autoBackupIncludeTabFavIcons, options.autoBackupIncludeTabThumbnails, true, overwrite);
        timer = value * intervalSec;
    } else {
        timer = timeToBackup - now;
    }

    _autoBackupTimer = setTimeout(resetAutoBackup, (timer + 10) * 1000);
}

async function createBackup(includeTabFavIcons, includeTabThumbnails, isAutoBackup = false, overwrite = false) {
    let [data, groups] = await Promise.all([storage.get(null), Groups.load(null, true, includeTabFavIcons, includeTabThumbnails)]);

    if (isAutoBackup && (!groups.length || groups.every(gr => !gr.tabs.length))) {
        console.warn('skip create auto backup, groups are empty');
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
        if (cookieStoreId !== TEMPORARY_CONTAINER && !data.containers[cookieStoreId]) {
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

    sendMessage({
        action: 'lock-addon',
    });

    await loadingBrowserAction();

    let {os} = await browser.runtime.getPlatformInfo(),
        isMac = os === browser.runtime.PlatformOs.MAC;

    if (true === clearAddonDataBeforeRestore) {
        await clearAddon(false);

        await utils.wait(1000);

        await containers.init();
    } else {
        data.groups.forEach(group => group.isMain = false);
    }

    if (data.hasOwnProperty('showTabsWithThumbnailsInManageGroups')) {
        options.showTabsWithThumbnailsInManageGroups = data.showTabsWithThumbnailsInManageGroups;
    }

    let currentData = await storage.get(null),
        lastCreatedGroupPosition = Math.max(currentData.lastCreatedGroupPosition, data.lastCreatedGroupPosition || 0);

    currentData.groups = await Groups.load(null, true, true, true);

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

    let windows = await Windows.load(true, true, true);

    await syncTabs(data.groups, windows);

    if (Array.isArray(data.pinnedTabs)) {
        let currentPinnedTabs = await Tabs.get(null, true, null);

        data.pinnedTabs = data.pinnedTabs.filter(function(tab) {
            delete tab.groupId;
            tab.pinned = true;
            return !currentPinnedTabs.some(t => t.url === tab.url);
        });

        if (data.pinnedTabs.length) {
            await createTabsSafe(data.pinnedTabs);
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

    if (tabs.length) {
        await browser.tabs.show(tabs.map(utils.keyId));
    }

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

    options,
    saveOptions,

    containers,
    normalizeContainersInGroups,

    Tabs,
    Groups,
    Windows,

    createTabsSafe,

    addUndoRemoveGroupItem,

    excludeTabsIds,
    addExcludeTabIds,
    removeExcludeTabIds,

    sendMessage,
    sendExternalMessage,

    setBrowserAction,
    updateBrowserActionData,
    updateMoveTabMenus,

    loadingBrowserAction,

    exportGroupToBookmarks,
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
    async saveConsoleLogs() {
        let urls = {},
            index = 1;

        let logs = console.getLogs();

        function normalize(obj) {
            if (Array.isArray(obj)) {
                return obj.map(normalize);
            } else if ('object' === utils.type(obj)) {
                for (let key in obj) {
                    if (['title', 'icon', 'icons', 'iconUrl', 'favIconUrl', 'thumbnail', 'filename'].includes(key)) {
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
            } else if (String(obj).startsWith('file:')) {
                return urls[obj] || (urls[obj] = 'FILE_' + index++);
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

    if (data.version === DEFAULT_OPTIONS.version) {
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
                    tabs.reverse();

                    await Promise.all(tabs.map(tab => Tabs.createNative(utils.normalizeTabUrl(tab))));

                    await utils.wait(100);

                    await Tabs.remove(tabs.map(tab => tab.id));

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

                let notifId = await utils.notify(browser.i18n.getMessage('loading'));

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

                data.groups = await syncTabs(data.groups, windows, true);

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
    let allTabs = windows.reduce((acc, win) => (acc.push(...win.tabs), acc), []);

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

async function tryRestoreMissedTabs() {
    // try to restore missed tabs
    let {tabsToRestore} = await storage.get('tabsToRestore');

    if (!tabsToRestore) {
        return;
    }

    if (tabsToRestore.length) {
        let groups = await Groups.load(null, true),
            groupsObj = {},
            foundTabIds = new Set;

        console.log('tryRestoreMissedTabs tabsToRestore', tabsToRestore);

        groups.forEach(function(group) {
            if (group.isArchive) {
                return;
            }

            groupsObj[group.id] = {
                tabs: group.tabs,
                newTabParams: Groups.getNewTabParams(group),
            };
        });

        tabsToRestore = tabsToRestore
            .map(utils.normalizeTabUrl)
            .map(function(tab) {
                if (groupsObj[tab.groupId]) {
                    let winTab = groupsObj[tab.groupId].tabs.find(function(t) {
                        if (utils.isTabLoading(t) && utils.isUrlEmpty(t.url)) {
                            return true;
                        }

                        return !foundTabIds.has(t.id) && t.url === tab.url && t.cookieStoreId === tab.cookieStoreId;
                    });

                    if (winTab) {
                        foundTabIds.add(winTab.id);
                    } else {
                        return Object.assign(tab, groupsObj[tab.groupId].newTabParams);
                    }
                }
            })
            .filter(Boolean);

        if (tabsToRestore.length) {
            await createTabsSafe(tabsToRestore);
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

        if (group.newTabContainer && group.newTabContainer !== TEMPORARY_CONTAINER) {
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

async function restoreOldExtensionUrls() {
    let tabs = await browser.tabs.query({
            url: 'moz-extension://*/help/open-in-container.html*',
        }),
        currentUUID = utils.getUUIDFromUrl(addonUrlPrefix);

    tabs.forEach(function({id, url}) {
        let uuid = utils.getUUIDFromUrl(url);

        if (uuid !== currentUUID) {
            browser.tabs.update(id, {
                url: url.replace(uuid, currentUUID),
                loadReplace: true,
            });
        }
    });
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
        openHelp('welcome-v4');
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
                    tabsToHide.push(tab);
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

        moveTabsToWin[windowId].forEach(tab => tab.windowId = windowId);

        console.log('[initializeGroupWindows] moveTabsToWin length', moveTabsToWin[windowId].length);
    }

    if (tabsToShow.length) {
        await browser.tabs.show(tabsToShow.map(utils.keyId));

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
                await Tabs.setActive(undefined, visibleTabs);
            } else {
                await Tabs.createTempActiveTab(tabToHide.windowId, false);
            }
        }

        await browser.tabs.hide(tabsToHide.map(utils.keyId));

        console.log('[initializeGroupWindows] tabsToHide length', tabsToHide.length);
    }
}

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

    utils.assignKeys(options, data, ALL_OPTIONS_KEYS);

    data.groups = await normalizeContainersInGroups(data.groups);

    await storage.set(data);

    let windows = await Windows.load(true);

    if (!windows.length) {
        utils.notify(browser.i18n.getMessage('notFoundWindowsAddonStoppedWorking'));
        throw '';
    }

    await initializeGroupWindows(windows, data.groups.map(utils.keyId));

    if (window.localStorage.isBackupRestoring) {
        delete window.localStorage.isBackupRestoring;
        utils.notify(browser.i18n.getMessage('backupSuccessfullyRestored'));
    }

    windows.forEach(function(win) {
        updateBrowserActionData(null, win.id);

        if (win.groupId) {
            groupsHistory.add(win.groupId);
        }
    });

    await tryRestoreMissedTabs();

    containers.removeUnusedTemporaryContainers(windows);

    restoreOldExtensionUrls();

    resetAutoBackup();

    createMoveTabMenus();

    addEvents();

    if (Groups.needToAddBlockBeforeRequest(data.groups)) {
        addListenerOnBeforeRequest();
    }

    Groups.load(null, true, true); // load favIconUrls, speed up first run popup

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

        delete window.localStorage.lastReloadFromError;
    })
    .catch(function(e) {
        setBrowserAction(undefined, 'lang:clickHereToReloadAddon', '/icons/exclamation-triangle-yellow.svg', true);

        browser.browserAction.setPopup({
            popup: '',
        });

        browser.browserAction.onClicked.addListener(() => browser.runtime.reload());

        if (e) {
            errorEventHandler(e);
        }
    });
