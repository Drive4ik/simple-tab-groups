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

let options = {},
    // _groups = [],
    _thumbnails = {},
    reCreateTabsOnRemoveWindow = [],
    menuIds = [],

    excludeTabsIds = [],

    manifest = browser.runtime.getManifest(),
    manageTabsPageUrl = browser.extension.getURL(constants.MANAGE_TABS_URL),
    noop = function() {};

window.addEventListener('error', utils.errorEventHandler);
// throw Error(utils.errorEventMessage('some data message'));

async function createTabsSafe(tabs, hideTab, groupId, withRemoveEvents = true) {
    if (withRemoveEvents) {
        removeEvents();
    }

    let result = await Promise.all(tabs.map(function(tab) {
        if (groupId) {
            tab.groupId = groupId;
        }

        return Tabs.create(tab, hideTab);
    }));

    if (withRemoveEvents) {
        addEvents();
    }

    return result;
}

function sendMessage(data) {
    console.info('BG event:', data.action, utils.clone(data));

    browser.runtime.sendMessage(data).catch(noop);
}

function sendExternalMessage(data) {
    console.info('BG event external:', data.action, utils.clone(data));

    Object.keys(constants.EXTENSIONS_WHITE_LIST)
        .forEach(function(exId) {
            if (constants.EXTENSIONS_WHITE_LIST[exId].postActions.includes(data.action)) {
                data.isExternalMessage = true;
                browser.runtime.sendMessage(exId, data).catch(noop);
            }
        });
}

async function applyGroupByPosition(textPosition, groups) {
    if (1 >= groups.length) {
        return false;
    }

    let winId = await Windows.getLastFocusedNormalWindow(),
        {groupId} = cache.getWindowSession(winId),
        groupIndex = groupId ? groups.findIndex(group => group.id === groupId) : -1;

    if (-1 === groupIndex) {
        return false;
    }

    let nextGroupIndex = utils.getNextIndex(groupIndex, groups.length, textPosition);

    return applyGroup(winId, groups[nextGroupIndex].id);
}

let _loadingGroupInWindow = {}; // windowId: true;
async function applyGroup(windowId, groupId, activeTabId) {
    windowId = windowId || await Windows.getLastFocusedNormalWindow();

    if (_loadingGroupInWindow[windowId]) {
        return false;
    }

    console.log('applyGroup args groupId: %s, windowId: %s, activeTab: %s', groupId, windowId, activeTabId);

    // let groupToShow = _groups.find(gr => gr.id === groupId);

    // if (!groupToShow) {
    //     throw Error(utils.errorEventMessage('applyGroup: groupToShow not found', {groupId, activeTabId}));
    // }

    _loadingGroupInWindow[windowId] = true;

    let groupWindowId = cache.getWindowId(groupId);

    console.time('load-group-' + groupId);

    try {
        if (groupWindowId) {
            if (activeTabId) {
                Tabs.setActive(activeTabId);
            }

            Windows.setFocus(groupWindowId);
        } else {
            // magic

            let [groupToShow, groups] = await Groups.load(groupId, true),
                {groupId: oldGroupId} = cache.getWindowSession(windowId),
                groupToHide = groups.find(gr => gr.id === oldGroupId);

            if (groupToHide && groupToHide.tabs.some(utils.isTabCanNotBeHidden)) {
                throw browser.i18n.getMessage('notPossibleSwitchGroupBecauseSomeTabShareMicrophoneOrCamera');
            }

            setBrowserAction(windowId, 'loading');

            removeEvents();

            // let tempEmptyTab = await Tabs.createTempActiveTab(windowId); // create empty tab (for quickly change group and not blinking)

            // show tabs
            if (groupToShow.tabs.length) {
                // groupToShow.tabs = groupToShow.tabs.filter(tab => tab.id || utils.isUrlAllowToCreate(tab.url)); // remove unsupported tabs

                let tabIds = groupToShow.tabs.map(utils.keyId);

                if (groupToShow.tabs[0].windowId !== windowId) {
                    groupToShow.tabs = await browser.tabs.move(tabIds, {
                        index: -1,
                        windowId: windowId,
                    });
                }

                await browser.tabs.show(tabIds);

                if (groupToShow.muteTabsWhenGroupCloseAndRestoreWhenOpen) {
                    Tabs.setMute(groupToShow.tabs, false);
                }

                // set active tab
                await Tabs.setActive(activeTabId, groupToShow.tabs);
            }

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

                    if (!groupToShow.tabs.length) {
                        let tempEmptyTab = await Tabs.createTempActiveTab(windowId);
                        if (tempEmptyTab) {
                            tabsIdsToRemove.push(tempEmptyTab.id);
                        }
                    }

                    let tabIds = groupToHide.tabs.map(utils.keyId);

                    await browser.tabs.hide(tabIds);

                    if (options.discardTabsAfterHide) {
                        browser.tabs.discard(tabIds);
                    }
                }

                if (tabsIdsToRemove.length) {
                    browser.tabs.remove(tabsIdsToRemove);
                }
            }

            await cache.setWindowGroup(windowId, groupToShow.id);

            // set group id for tabs which may has opened without groupId (new window without group)
            Tabs.get(windowId)
                .then(function(tabs) {
                    let hasNewTabs = false;

                    tabs.forEach(function(tab) {
                        if (tab.session.groupId !== groupToShow.id) {
                            hasNewTabs = true;
                            cache.setTabGroup(tab.id, groupToShow.id);
                        }
                    })

                    if (hasNewTabs) {
                        sendMessage({
                            action: 'group-updated',
                            group: {
                                id: groupToShow.id,
                                tabs,
                            },
                        });
                    }
                });

            // sendMessage({ // TODO need this event ??
            //     action: 'group-updated',
            //     group: groupToShow,
            // });

            updateMoveTabMenus(windowId);

            updateBrowserActionData(groupToShow.id);

            addEvents();
        }
    } catch (e) {
        updateBrowserActionData(null, windowId);

        if (!groupWindowId) {
            removeEvents();
            addEvents();
        }

        throw e;
    } finally {
        delete _loadingGroupInWindow[windowId];

        console.timeEnd('load-group-' + groupId);
    }
}

async function onActivatedTab({ previousTabId, tabId, windowId }) {
    console.log('onActivatedTab', { previousTabId, tabId, windowId });

    let activeTab = cache.updateTab(tabId, {
        active: true,
    });

    if (previousTabId) {
        cache.updateTab(previousTabId, {
            active: false,
        });
    }

    let {groupId} = cache.getWindowSession(windowId);

    if (!groupId) {
        return;
    }

    sendMessage({
        action: 'tab-updated',
        tab: {
            id: tabId,
            active: true,
        },
    });

    if (previousTabId) {
        sendMessage({
            action: 'tab-updated',
            tab: {
                id: previousTabId,
                active: false,
            },
        });
    }

    Tabs.updateThumbnail(activeTab);
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

    tab = cache.setTab(tab, true);

    if (utils.isTabPinned(tab)) {
        return;
    }

    // tab = await cache.loadTabSession(tab);

    let {groupId} = cache.getWindowSession(tab.windowId),
        [group, groups] = await Groups.load(groupId || -1);

    if (!group) {
        console.log('tab created without group');
        return;
    }

    console.debug('created tab group id', group.id);

    if (!group.isSticky) {
        let destGroup = _getCatchedGroupForTab(groups, tab, true);

        if (destGroup && destGroup.id !== group.id) {
            Tabs.move([tab], destGroup.id, undefined, undefined, destGroup.showTabAfterMovingItIntoThisGroup);
            return;
        }
    }

    cache.setTabGroup(tab.id, group.id);

    sendMessage({
        action: 'tab-added',
        tab: tab,
    });

    // saveCurrentTabs(group.windowId, 'onCreatedTab');
}

async function onUpdatedTab(tabId, changeInfo, tab) {
    console.log('onUpdatedTab', {changeInfo, tab})

    if (excludeTabsIds.includes(tabId) || utils.isTabIncognito(tab) || 'isArticle' in changeInfo || 'attention' in changeInfo) {
        return;
    }

    tab = cache.updateTab(tabId, changeInfo);

    if (utils.isTabPinned(tab) && undefined === changeInfo.pinned) {
        return;
    }

    let {groupId} = cache.getWindowSession(tab.windowId),
        [group, groups] = await Groups.load(groupId || -1);

    if ('pinned' in changeInfo || 'hidden' in changeInfo) {
        if (changeInfo.pinned || changeInfo.hidden) {
            await cache.removeTabGroup(tabId);

            if (group) {
                sendMessage({
                    action: 'tab-removed',
                    tabId: tabId,
                });
            }
        } else {

            if (false === changeInfo.pinned) {
                await cache.setTabGroup(tabId, groupId);
            } else if (false === changeInfo.hidden) {
                if (tab.session.groupId) {
                    applyGroup(tab.windowId, tab.session.groupId, tabId);
                    return;
                } else {
                    await cache.setTabGroup(tabId, groupId);
                }
            }

            if (group) {
                sendMessage({
                    action: 'tab-added',
                    tab: tab,
                });
            }
        }

        return;
    }

    if (!group) {
        console.warn('no group found on onUpdatedTab');
        return;
    }


    console.log('onUpdatedTab\n tabId:', tabId, JSON.stringify(changeInfo) + '\n', JSON.stringify({
        status: tab.status,
        url: tab.url,
        title: tab.title,
    }));

    sendMessage({
        action: 'tab-updated',
        tab: {
            id: tabId,
            ...changeInfo,
        },
    });

    // group = _groups.find(gr => (tab = gr.tabs.find(t => t.id === tabId)));

    // if ('hidden' in changeInfo) { // if other programm hide or show tabs
    //     if (changeInfo.hidden) {
    //         cache.removeTabGroup(tabId);
    //     } else { // show tab
    //         // loadGroup(tab.windowId, group.id, group.tabs.indexOf(tab), true); // TODO
    //         cache.setTabGroup(tabId, groupId);
    //     }

    //     return;
    // }

    // if ('pinned' in changeInfo) {
    //     if (utils.isTabPinned(tab)) {
    //         cache.removeTabGroup(tabId);
    //     } else {
    //         cache.setTabGroup(tabId, groupId);
    //     }

    //     // saveCurrentTabs(rawTab.windowId, 'onUpdatedTab change pinned tab');

    //     return;
    // }

    Tabs.updateThumbnail(tab);

    if (!group.isSticky) {
        let destGroup = _getCatchedGroupForTab(groups, tab);

        if (destGroup && destGroup.id !== group.id) {
            Tabs.move([tab], destGroup.id, undefined, undefined, destGroup.showTabAfterMovingItIntoThisGroup);
            return;
        }
    }
}

async function onRemovedTab(tabId, { isWindowClosing, windowId }) {
    console.log('onRemovedTab', {tabId, isWindowClosing, windowId});

    let tab = cache.getTab(tabId);

    if (!tab) {
        return;
    }

    cache.removeTab(tabId);

    if (isWindowClosing && !utils.isUrlEmpty(tab.url) && tab.session.groupId) {
        // let [group] = await Groups.load(tab.session.groupId);

        // if (group) {
            // delete tab.index;

            tab.groupId = tab.session.groupId;

            if (!reCreateTabsOnRemoveWindow.length) {
                cache.getWindows().forEach(win => win.id !== windowId && setBrowserAction(win.id, 'loading', undefined, false));
            }

            reCreateTabsOnRemoveWindow.push(tab);
        // }
    } else if (utils.isTabNotPinned(tab)) {
        sendMessage({
            action: 'tab-removed',
            tabId: tabId,
        });
    }
}

function onMovedTab(tabId, { windowId, fromIndex, toIndex }) {
    console.log('onMovedTab', {tabId, windowId, fromIndex, toIndex });

    cache.updateTab(tabId, {
        index: toIndex,
    });
}

function onAttachedTab(tabId, { newWindowId, newPosition }) {
    console.log('onAttachedTab', { tabId, newWindowId, newPosition });

    cache.updateTab(tabId, {
        index: newPosition,
        windowId: newWindowId,
    });

    if (excludeTabsIds.includes(tabId)) {
        return;
    }

    let {groupId} = cache.getWindowSession(newWindowId);

    cache.setTabGroup(tabId, groupId);
}

function onDetachedTab(tabId, { oldWindowId }) { // notice: call before onAttached
    console.log('onDetachedTab', { tabId, oldWindowId });
}

async function onCreatedWindow(win) {
    console.log('onCreatedWindow', win);

    if (utils.isWindowAllow(win)) {
        await cache.loadWindowSession(win);
        await Tabs.get(win.id, null, null);

        if (options.createNewGroupWhenOpenNewWindow && !win.session.groupId) {
            Groups.add(win.id);
        }
    }
}

let _lastFocusedWinId = null;

async function onFocusChangedWindow(windowId) {
    console.log('onFocusChangedWindow', windowId);

    if (browser.windows.WINDOW_ID_NONE === windowId) {
        return;
    }

    let win = await Windows.get(windowId);

    if (!utils.isWindowAllow(win)) {
        browser.browserAction.disable();
        removeMoveTabMenus();
    } else if (_lastFocusedWinId !== windowId) {
        browser.browserAction.enable();
        updateMoveTabMenus(windowId);
    }

    _lastFocusedWinId = windowId;
}

async function onRemovedWindow(windowId) {
    console.log('onRemovedWindow windowId:', windowId);

    cache.removeWindow(windowId);

    if (reCreateTabsOnRemoveWindow.length) {
        createTabsSafe(reCreateTabsOnRemoveWindow, true);
        reCreateTabsOnRemoveWindow = [];
        cache.getWindows().forEach(win => updateBrowserActionData(null, win.id));
    }
}

async function updateMoveTabMenus(windowId) {
    await removeMoveTabMenus();
    await createMoveTabMenus(windowId);
}

async function removeMoveTabMenus() {
    if (menuIds.length) {
        await Promise.all(menuIds.map(id => browser.menus.remove(id).catch(noop)));
        menuIds = [];
    }
}

async function createMoveTabMenus(windowId) {
    let hasBookmarksPermission = await browser.permissions.contains(constants.PERMISSIONS.BOOKMARKS);

    if (!options.showContextMenuOnTabs && !options.showContextMenuOnLinks && !hasBookmarksPermission) {
        return;
    }

    windowId = windowId || await Windows.getLastFocusedNormalWindow();

    let {groupId} = cache.getWindowSession(windowId),
        [currentGroup, groups] = await Groups.load(groupId || -1);

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
        let groupIcons = utils.getGroupIconUrl(group, 16),
            groupTitle = (cache.getWindowId(group.id) ? '• ' : '') + group.title;

        options.showContextMenuOnTabs && menuIds.push(browser.menus.create({
            title: groupTitle,
            enabled: currentGroup ? group.id !== currentGroup.id : true,
            icons: groupIcons,
            parentId: 'stg-move-tab-parent',
            contexts: [browser.menus.ContextType.TAB],
            onclick: async function(info, tab) {
                let setActive = 2 === info.button,
                    tabsToMove = await Tabs.getHighlighted(tab.windowId, tab);

                Tabs.move(tabsToMove, group.id, undefined, !setActive, setActive);
            },
        }));

        options.showContextMenuOnLinks && menuIds.push(browser.menus.create({
            title: groupTitle,
            icons: groupIcons,
            parentId: 'stg-open-link-parent',
            contexts: [browser.menus.ContextType.LINK],
            onclick: async function(info) {
                if (!utils.isUrlAllowToCreate(info.linkUrl)) {
                    return;
                }

                let setActive = 2 === info.button;

                await Tabs.add(group.id, undefined, info.linkUrl, info.linkText, setActive);

                if (setActive) {
                    let groupWindowId = cache.getWindowId(group.id);

                    if (groupWindowId) {
                        Windows.setFocus(groupWindowId);
                    } else {
                        applyGroup(null, group.id);
                    }
                }
            },
        }));

        hasBookmarksPermission && menuIds.push(browser.menus.create({
            title: groupTitle,
            icons: groupIcons,
            parentId: 'stg-open-bookmark-in-group-parent',
            contexts: [browser.menus.ContextType.BOOKMARK],
            onclick: async function(info) {
                if (!info.bookmarkId) {
                    utils.notify(browser.i18n.getMessage('bookmarkNotAllowed'));
                    return;
                }

                let [bookmark] = await browser.bookmarks.get(info.bookmarkId);

                if (bookmark.type !== browser.menus.ContextType.BOOKMARK || !bookmark.url || !utils.isUrlAllowToCreate(bookmark.url)) {
                    utils.notify(browser.i18n.getMessage('bookmarkNotAllowed'));
                    return;
                }

                let setActive = 2 === info.button;

                await Tabs.add(group.id, undefined, bookmark.url, bookmark.title, setActive);

                if (setActive) {
                    let groupWindowId = cache.getWindowId(group.id);

                    if (groupWindowId) {
                        Windows.setFocus(groupWindowId);
                    } else {
                        applyGroup(null, group.id);
                    }
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
            let tabsToMove = await Tabs.getHighlighted(tab.windowId, tab);

            // if (tabsToMove.some(t => t.pinned)) {
            //     utils.notify(browser.i18n.getMessage('pinnedTabsAreNotSupported'));
            //     return;
            // }

            Groups.add(null, tabsToMove);

            // let newGroup = await Groups.add(null, tabsToMove);

            // if (1 === _groups.length) { // new group already contains this tab
            //     return;
            // }

            // Tabs.move(tabsToMove, newGroup.id);
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
            let {groupId} = cache.getWindowSession(tab.windowId);

            if (!groupId) {
                return;
            }

            Groups.update(groupId, {
                iconUrl: Tabs.getFavIconUrl(tab),
            });
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
                groupWindowId = cache.getWindowId(newGroup.id);

            await Tabs.add(newGroup.id, undefined, info.linkUrl, info.linkText, setActive);

            if (setActive && !groupWindowId) {
                applyGroup(null, newGroup.id);
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

            if (bookmark.type !== browser.menus.ContextType.BOOKMARK || !bookmark.url || !utils.isUrlAllowToCreate(bookmark.url)) {
                utils.notify(browser.i18n.getMessage('bookmarkNotAllowed'));
                return;
            }

            let setActive = 2 === info.button,
                newGroup = await Groups.add(),
                groupWindowId = cache.getWindowId(newGroup.id);

            await Tabs.add(newGroup.id, undefined, bookmark.url, bookmark.title, setActive);

            if (setActive && !groupWindowId) {
                applyGroup(null, newGroup.id);
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

            if (folder.type !== 'folder') {
                utils.notify(browser.i18n.getMessage('bookmarkNotAllowed'));
                return;
            }

            async function addBookmarkFolderAsGroup(folder) {
                let tabsToCreate = [];

                for (let bookmark of folder.children) {
                    if (bookmark.type === 'folder') {
                        await addBookmarkFolderAsGroup(bookmark);
                    } else if (bookmark.type === browser.menus.ContextType.BOOKMARK && bookmark.url && utils.isUrlAllowToCreate(bookmark.url) && !utils.isUrlEmpty(bookmark.url)) {
                        tabsToCreate.push({
                            title: bookmark.title,
                            url: bookmark.url,
                            favIconUrl: utils.getFavIconFromUrl(bookmark.url) || '/icons/tab.svg',
                        });
                    }
                }

                if (tabsToCreate.length) {
                    let tabs = await createTabsSafe(tabsToCreate, true);
                    await Groups.add(undefined, tabs, folder.title);
                    groupsCreatedCount++;
                }
            }

            let currentWindowId = await Windows.getLastFocusedNormalWindow();

            setBrowserAction(currentWindowId, 'loading', undefined, false);

            await addBookmarkFolderAsGroup(folder);

            updateBrowserActionData(null, currentWindowId);

            if (groupsCreatedCount) {
                utils.notify(browser.i18n.getMessage('groupsCreatedCount', groupsCreatedCount));
            } else {
                utils.notify(browser.i18n.getMessage('noGroupsCreated'));
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
        bookmark = bookmarks.find(b => b.type === 'folder' && b.parentId === parentId);

    if (!bookmark) {
        let bookmarkData = {
            title,
            parentId,
            type: 'folder',
        };

        if (index !== undefined) {
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
        showMessages && utils.notify(browser.i18n.getMessage('noAccessToBookmarks'))
            .then(() => browser.runtime.openOptionsPage());
        return;
    }

    if (!group) {
        throw Error('group has invalid type in exportGroupToBookmarks');
    }

    if (!group.tabs.length) {
        showMessages && utils.notify(browser.i18n.getMessage('groupWithoutTabs'));
        return;
    }

    let win = null;

    if (showMessages) {
        win = await Windows.get();
        setBrowserAction(win.id, 'loading');
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

        group.tabs.forEach(function(tab) {
            groupBookmarkFolder.children = groupBookmarkFolder.children.filter(function(b) {
                if (b.type === browser.menus.ContextType.BOOKMARK && b.url === tab.url) {
                    bookmarksToRemove.push(b);
                    return false;
                }

                return b.type === browser.menus.ContextType.BOOKMARK;
            });
        });

        await Promise.all(bookmarksToRemove.map(b => browser.bookmarks.remove(b.id).catch(noop)));

        let children = await browser.bookmarks.getChildren(groupBookmarkFolder.id);

        if (children.length) {
            if (children[0].type !== browser.menus.ItemType.SEPARATOR) {
                await browser.bookmarks.create({
                    type: browser.menus.ItemType.SEPARATOR,
                    index: 0,
                    parentId: groupBookmarkFolder.id,
                });
            }

            // found and remove duplicated separators
            let duplicatedSeparators = children.filter(function(separator, index) {
                return separator.type === browser.menus.ItemType.SEPARATOR &&
                    children[index - 1] &&
                    children[index - 1].type === browser.menus.ItemType.SEPARATOR;
            });

            if (children[children.length - 1].type === browser.menus.ItemType.SEPARATOR && !duplicatedSeparators.includes(children[children.length - 1])) {
                duplicatedSeparators.push(children[children.length - 1]);
            }

            if (duplicatedSeparators.length) {
                await Promise.all(duplicatedSeparators.map(sep => browser.bookmarks.remove(sep.id).catch(noop)));
            }
        }
    }

    for (let index in group.tabs) {
        await browser.bookmarks.create({
            title: group.tabs[index].title,
            url: group.tabs[index].url,
            type: browser.menus.ContextType.BOOKMARK,
            index: Number(index),
            parentId: groupBookmarkFolder.id,
        });
    }

    if (showMessages) {
        updateBrowserActionData(group.id);
        utils.notify(browser.i18n.getMessage('groupExportedToBookmarks', group.title));
    }

    return true;
}

function setBrowserAction(windowId, title, icon, enable) {
    console.info('setBrowserAction', {windowId, title, icon, enable});

    let winObj = windowId ? {windowId} : {};

    if ('loading' === title) {
        title = 'lang:waitingToLoadAllTabs';
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
        groupId = cache.getWindowSession(windowId).groupId;
    }

    if (!windowId) {
        return;
    }

    let [group] = await Groups.load(groupId || -1);

    if (group) {
        setBrowserAction(windowId, utils.sliceText(group.title, 28) + ' - STG', utils.getGroupIconUrl(group), true);
        prependWindowTitle(windowId, group.title);
    } else {
        setBrowserAction(windowId, undefined, undefined, true);
        prependWindowTitle(windowId);
    }
}

function prependWindowTitle(windowId, title) {
    if (windowId) {
        browser.windows.update(windowId, {
            titlePreface: options.prependGroupTitleToWindowTitle && title ? ('[' + utils.sliceText(title, 35) + '] ') : '',
        });
    }
}

function addEvents() {
    browser.tabs.onCreated.addListener(onCreatedTab);
    browser.tabs.onActivated.addListener(onActivatedTab);
    browser.tabs.onMoved.addListener(onMovedTab);
    browser.tabs.onUpdated.addListener(onUpdatedTab);
    browser.tabs.onRemoved.addListener(onRemovedTab);

    browser.tabs.onAttached.addListener(onAttachedTab);
    browser.tabs.onDetached.addListener(onDetachedTab);

    browser.windows.onCreated.addListener(onCreatedWindow);
    browser.windows.onFocusChanged.addListener(onFocusChangedWindow);
    browser.windows.onRemoved.addListener(onRemovedWindow);
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
}

async function openManageGroups() {
    if (options.openManageGroupsInTab) {
        let tabs = await browser.tabs.query({
            windowId: browser.windows.WINDOW_ID_CURRENT,
            url: manageTabsPageUrl,
            // pinned: false,
            // hidden: false,
        });

        if (tabs.length) { // if manage tab is found
            await Tabs.setActive(tabs[0].id);
        } else {
            await Tabs.create({
                active: true,
                url: manageTabsPageUrl,
            });
        }
    } else {
        let allWindows = await browser.windows.getAll({
            populate: true,
            windowTypes: [browser.windows.WindowType.POPUP],
        });

        let isFoundWindow = allWindows.some(function(win) {
            if (browser.windows.WindowType.POPUP === win.type && 1 === win.tabs.length && manageTabsPageUrl === win.tabs[0].url) { // if manage popup is now open
                Windows.setFocus(win.id);
                return true;
            }
        });

        if (isFoundWindow) {
            return;
        }

        await Windows.create({
            url: manageTabsPageUrl,
            type: browser.windows.CreateType.POPUP,
            width: Number(window.localStorage.manageGroupsWindowWidth) || 1000,
            height: Number(window.localStorage.manageGroupsWindowHeight) || 700,
        });
    }
}

browser.runtime.onMessage.addListener(function(request, sender) {
    if (!utils.isAllowSender(request, sender)) {
        return {
            unsubscribe: true,
        };
    }

    if (request.action) {
        return runAction(request);
    }
});

browser.runtime.onMessageExternal.addListener(function(request, sender, sendResponse) {
    let extensionRules = {};

    if (!window.BG.inited) {
        sendResponse({
            ok: false,
            error: '[STG] I am not yet loaded',
        });
        return;
    }

    if (!utils.isAllowExternalRequestAndSender(request, sender, extensionRules)) {
        sendResponse({
            ok: false,
            error: '[STG] Your extension/action does not in white list. If you want to add your extension/action to white list - please contact with me.',
            yourExtentionRules: extensionRules,
        });
        return;
    }

    if (request.action) {
        sendResponse(runAction(request, sender.id));
    } else {
        sendResponse({
            ok: false,
            error: 'unknown action',
        });
    }
});

async function runAction(data, externalExtId) {
    let result = {
        ok: false,
    };

    if (!data.action) {
        result.error = '[STG] Action or it\'s id is empty';
        return result;
    }

    try {
        console.debug('runAction data.action', data.action);

        let currentWindow = await Windows.getLastFocusedNormalWindow(false),
            [currentGroup, groups] = await Groups.load(currentWindow.session.groupId || -1);
// console.debug('runAction aaaaa', data.action);
        switch (data.action) {
            case 'are-you-here':
                result.ok = true;
                break;
            case 'get-groups-list':
                result.groupsList = groups.map(Groups.mapGroupForExternalExtension);
                result.ok = true;
                break;
            case 'load-next-group':
                result.ok = await applyGroupByPosition('next', groups);
                break;
            case 'load-prev-group':
                result.ok = await applyGroupByPosition('prev', groups);
                break;
            case 'load-first-group':
                if (groups[0]) {
                    await applyGroup(currentWindow.id, groups[0].id);
                    result.ok = true;
                }
                break;
            case 'load-last-group':
                if (groups.length > 0) {
                    if (!currentGroup || currentGroup.id !== groups[groups.length - 1].id) {
                        await applyGroup(currentWindow.id, groups[groups.length - 1].id);
                        result.ok = true;
                    }
                }
                break;
            case 'load-custom-group':
                if (groups.some(group => group.id === data.groupId)) {
                    await applyGroup(currentWindow.id, data.groupId);
                    result.ok = true;
                } else {
                    throw Error(`Group id '${data.groupId}' type: '${typeof data.groupId}' not found. Need exists int group id.`);
                }
                break;
            case 'add-new-group':
                let newGroup = await Groups.add();
                result.ok = true;
                result.group = Groups.mapGroupForExternalExtension(newGroup);
                break;
            case 'delete-current-group':
                if (currentGroup) {
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
                    utils.notify(browser.i18n.getMessage('pinnedTabsAreNotSupported'));
                    break;
                } else if (utils.isTabIncognito(activeTab)) {
                    utils.notify(browser.i18n.getMessage('privateTabsAreNotSupported'));
                    break;
                } else if (utils.isTabCanNotBeHidden(activeTab)) {
                    utils.notify(browser.i18n.getMessage('thisTabsCanNotBeHidden', utils.sliceText(utils.getTabTitle(activeTab), 25)));
                    break;
                }

                if (data.groupId) {
                    if (groups.some(group => group.id === data.groupId)) {
                        await Tabs.move([activeTab], data.groupId);
                    } else {
                        throw Error(`Group id '${data.groupId}' type: '${typeof data.groupId}' not found. Need exists int group id.`);
                    }
                } else {
                    browser.tabs.sendMessage(activeTab.id, {
                        action: 'move-tab-to-custom-group',
                        groups: groups.map(Groups.mapGroupForExternalExtension),
                        tabGroupId: activeTab.session.groupId || null,
                    }).catch(noop);
                }

                result.ok = true;
                break;
            case 'move-active-tab-to-group':
                let activeTabForMove = await Tabs.getActive();

                if ('new' === data.groupId) {
                    let newGroup = await Groups.add();
                    data.groupId = newGroup.id;
                } else if (!groups.some(group => group.id === data.groupId)) {
                    throw Error('Group not found');
                }

                await Tabs.move([activeTabForMove], data.groupId);

                result.ok = true;
                break;
            case 'get-hotkeys':
                result.ok = true;
                result.hotkeys = options.hotkeys;
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
    _options = utils.clone(_options);

    let optionsKeys = Object.keys(_options);

    if (!optionsKeys.every(key => constants.allOptionsKeys.includes(key))) {
        throw Error('some key in save options are not supported: ' + optionsKeys.join(', '));
    }

    Object.assign(options, _options);

    await storage.set(_options);

    if (optionsKeys.includes('hotkeys')) {
        let tabs = await browser.tabs.query({
                discarded: false,
                windowType: browser.windows.WindowType.NORMAL,
            }),
            actionData = {
                action: 'update-hotkeys',
                hotkeys: options.hotkeys,
            };

        tabs
            .filter(utils.isTabNotIncognito)
            .forEach(tab => browser.tabs.sendMessage(tab.id, actionData).catch(noop));
    }

    if (optionsKeys.some(key => key === 'autoBackupEnable' || key === 'autoBackupIntervalKey' || key === 'autoBackupIntervalValue')) {
        resetAutoBackup();
    }

    if (optionsKeys.includes('prependGroupTitleToWindowTitle')) {
        Groups.load().then(groups => groups.forEach(group => updateBrowserActionData(group.id)));
    }

    if (optionsKeys.some(key => key === 'showContextMenuOnTabs' || key === 'showContextMenuOnLinks')) {
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
    let data = await storage.get(null);

    if (isAutoBackup && !data.groups.length) {
        return;
    }

    if (!includeTabThumbnails) {
        delete data.thumbnails;
    }

    data.groups.forEach(function(group) {
        delete group.windowId;

        group.tabs.forEach(function(tab) {
            delete tab.id;

            if (containers.isDefault(tab.cookieStoreId)) {
                delete tab.cookieStoreId;
            }

            if (!includeTabFavIcons) {
                delete tab.favIconUrl;
            }
        });
    });

    if (isAutoBackup) {
        data.autoBackupLastBackupTimeStamp = utils.unixNow();

        if (options.autoBackupGroupsToFile) {
            await file.backup(data, true, overwrite);
        }

        if (options.autoBackupGroupsToBookmarks) {
            await exportAllGroupsToBookmarks();
        }

        await storage.set({
            autoBackupLastBackupTimeStamp: data.autoBackupLastBackupTimeStamp,
        });

        options.autoBackupLastBackupTimeStamp = data.autoBackupLastBackupTimeStamp;
    } else {
        await file.backup(data, false, overwrite);
    }
}

async function exportAllGroupsToBookmarks(showFinishMessage) {
    let hasBookmarksPermission = await browser.permissions.contains(constants.PERMISSIONS.BOOKMARKS);

    if (!hasBookmarksPermission) {
        return;
    }

    let groups = await Groups.load(null, true);

    for (let groupIndex in groups) {
        await exportGroupToBookmarks(groups[groupIndex], groupIndex, false);
    }

    if (showFinishMessage) {
        utils.notify(browser.i18n.getMessage('allGroupsExportedToBookmarks'));
    }
}

window.BG = {
    inited: false,

    waitRestoreSession: false,

    cache,
    openManageGroups,

    // getGroups: () => utils.clone(_groups),
    // Windows.load,

    getOptions: () => utils.clone(options),
    saveOptions,

    containers,

    excludeTabsIds,

    events: {
        onCreatedWindow,
    },

    // createWindow,
    // getWindow,

    createTabsSafe,

    // getTabs,
    // moveTabs,

    sendMessage,
    sendExternalMessage,

    setBrowserAction,
    updateBrowserActionData,
    updateMoveTabMenus,
    // clearTabsThumbnails,

    // setFocusOnWindow,

    // sortGroups,
    exportGroupToBookmarks,
    applyGroup,
    // getNextGroupTitle,

    // getTabFavIconUrl,
    // updateTabThumbnail,

    // getThumbnails: () => utils.clone(_thumbnails),

    // addTab,
    // removeTab,

    // createGroup,
    // moveGroup,
    // addGroup,
    // updateGroup,
    // removeGroup,

    runMigrateForData,

    createBackup,
};

function _resetGroupsIdsAndTabsIds(groups) {
    return groups.map(function(group) {
        delete group.windowId;
        group.tabs = group.tabs.filter(Boolean).map(function(tab) {
            tab.id = null;
            return tab;
        });

        return group;
    });
}

async function runMigrateForData(data) {
    // reset tab ids
    data.groups = _resetGroupsIdsAndTabsIds(data.groups);

    let currentVersion = manifest.version;

    if (data.version === currentVersion) {
        return data;
    }

    if (data.version === constants.DEFAULT_OPTIONS.version) {
        data.version = currentVersion;
        return data;
    }

    // start migration
    let keysToRemoveFromStorage = [];

    function removeKeys(...keys) {
        keys.forEach(function(key) {
            delete data[key];
            keysToRemoveFromStorage.push(key);
        });
    }

    let migrations = [
        {
            version: '1.8.1',
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

                removeKeys('windowsGroup');
            },
        },
        {
            version: '2.2',
            migration() {
                if ('showGroupCircleInSearchedTab' in data) {
                    data.showGroupIconWhenSearchATab = data.showGroupCircleInSearchedTab;
                    removeKeys('showGroupCircleInSearchedTab');
                }
            },
        },
        {
            version: '2.3',
            migration() {
                data.groups = data.groups.map(function(group) {
                    group.tabs = group.tabs.filter(Boolean);
                    return group;
                });

                removeKeys('enableKeyboardShortcutLoadNextPrevGroup', 'enableKeyboardShortcutLoadByIndexGroup');
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
            migration() {
                // doRemoveSTGNewTabUrls = true

                removeKeys('enableFastGroupSwitching', 'enableFavIconsForNotLoadedTabs', 'createNewGroupAfterAttachTabToNewWindow');
                removeKeys('individualWindowForEachGroup', 'openNewWindowWhenCreateNewGroup', 'showNotificationIfGroupsNotSyncedAtStartup');
                removeKeys('showGroupIconWhenSearchATab', 'showUrlTooltipOnTabHover');

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
            migration() {
                data.hotkeys.forEach(function(hotkey) {
                    if (hotkey.action.groupId) {
                        hotkey.groupId = hotkey.action.groupId;
                    }

                    hotkey.action = hotkey.action.id;
                });

                removeKeys('browserActionIconColor');
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
            migration() {
                removeKeys('createThumbnailsForTabs');
            },
        },
        {
            version: '4.0',
            migration() {
                data.withoutSession = true;
                data.groups.forEach(group => delete group.windowId);
            },
        },
    ];

    // if data version < required latest migrate version then need migration
    if (-1 === utils.compareVersions(data.version, migrations[migrations.length - 1].version)) {

        for (let i = 0; i < migrations.length; i++) {
            if (-1 === utils.compareVersions(data.version, migrations[i].version)) {
                await migrations[i].migration();
            }
        }

    } else if (1 === utils.compareVersions(data.version, currentVersion)) {
        throw 'Please, update addon to latest version';
    }

    data.version = currentVersion;

    if (keysToRemoveFromStorage.length) {
        await storage.remove(keysToRemoveFromStorage);
    }
    // end migration

    return data;
}

function isStgNewTabUrl(url) {
    return url.startsWith('moz-extension') && url.includes('/stg-newtab/newtab.html');
}

async function removeSTGNewTabUrls(windows) {
    return Promise.all(windows.map(async function(win) {
        await Promise.all(win.tabs.map(async function(winTab) {
            if (isStgNewTabUrl(winTab.url)) {
                winTab.url = new URL(winTab.url).searchParams.get('url');

                await browser.tabs.update(winTab.id, {
                    url: winTab.url,
                    loadReplace: true,
                });
            }
        }));

        return win;
    }));
}

// setInterval(async function() {
//     console.time('loadAllGroups()');
//     let groups = await loadAllGroups();
//     console.timeEnd('loadAllGroups()');

//     console.debug(groups);
// }, 5000);

// { reason: "update", previousVersion: "3.0.1", temporary: true }
// { reason: "install", temporary: true }
// browser.runtime.onInstalled.addListener(console.info.bind(null, 'onInstalled'));

function isRestoreSessionNow(windows) {
    return 1 === windows.length && 1 === windows[0].tabs.length && 'about:sessionrestore' === windows[0].tabs[0].url;
}

async function init() {
    let isAllowedIncognitoAccess = await browser.extension.isAllowedIncognitoAccess();

    if (isAllowedIncognitoAccess) {
        throw 'no support incognito mode, please disable addon in incognito mode';
    }

    let data = await storage.get(null);

    if (!Array.isArray(data.groups)) {
        utils.notify(browser.i18n.getMessage('ffFailedAndLostDataMessage'));

        data.groups = [];
    }

    data = await runMigrateForData(data); // run migration for data

    constants.allOptionsKeys.forEach(key => options[key] = key in data ? data[key] : utils.clone(constants.DEFAULT_OPTIONS[key])); // reload options

    let windows = await Windows.load(true);

    if (!windows.length) {
        throw browser.i18n.getMessage('nowFoundWindowsAddonStoppedWorking');
    }

    await containers.init();

    // clear unused thumbnails TODO
/*    let allSafedTabUrls = data.groups.reduce((acc, group) => acc.concat(group.tabs.map(tab => utils.makeSafeUrlForThumbnail(tab.url))), []);
    Object
        .keys(data.thumbnails)
        .forEach(url => !allSafedTabUrls.includes(url) ? delete data.thumbnails[url] : null);*/

    if (isRestoreSessionNow(windows)) {
        // waiting for session restore

        window.BG.waitRestoreSession = true;

        await new Promise(function(resolve) {
            let tryCount = 0;

            async function checkRestoreSession() {
                let wins = await Windows.load(true);

                if (isRestoreSessionNow(wins)) {
                    tryCount++;

                    if (3 === tryCount) {
                        setBrowserAction(undefined, 'lang:waitingForSessionRestoreNotification', 'loading');

                        utils.notify(browser.i18n.getMessage('waitingForSessionRestoreNotification'), undefined, 'wait-session-restore-message');
                    }

                    setTimeout(checkRestoreSession, 1000);
                } else {
                    windows = wins;
                    resolve();
                }
            }

            checkRestoreSession();
        });

        setBrowserAction(undefined, 'loading');

        browser.notifications.clear('wait-session-restore-message');
    }

    window.BG.waitRestoreSession = false;

    if (windows.some(win => win.tabs.some(tab => isStgNewTabUrl(tab.url)))) {
        windows = await removeSTGNewTabUrls(windows);
    }

    if (data.withoutSession) { // if version < 4
        let allTabs = windows.reduce(function(acc, win) {
            if (win.tabs.length) {
                acc.push(...win.tabs);
            }

            return acc;
        }, []);

        let tempTabs = await Promise.all(windows.map(win => Tabs.createTempActiveTab(win.id)));

        if (allTabs.length) {
            await browser.tabs.hide(allTabs.map(utils.keyId));
        }

        let syncedTabs = [],
            needResortGroups = [];

        data.groups = await Promise.all(data.groups.map(async function(group) {
            group.tabs = await Promise.all(group.tabs.map(async function(groupTab) {
                for (let index in allTabs) {
                    let winTab = allTabs[index];

                    if (winTab.url === groupTab.url && !syncedTabs.includes(winTab) && winTab.cookieStoreId === containers.get(groupTab.cookieStoreId, 'cookieStoreId'))
                    {
                        syncedTabs.push(winTab);
                        await cache.setTabGroup(winTab.id, group.id);

                        return winTab;
                    }
                }

                if (!needResortGroups.includes(group)) {
                    needResortGroups.push(group);
                }

                return Tabs.create({
                    title: groupTab.title,
                    url: groupTab.url,
                    cookieStoreId: groupTab.cookieStoreId,
                    // windowId: windowId,
                    groupId: group.id,
                }, true);
            }));

            return group;
        }));

        if (needResortGroups.length) {
            for (let i in needResortGroups) {
                let group = needResortGroups[i],
                    windowId = cache.getWindowId(group.id);

                await browser.tabs.move(group.tabs.map(utils.keyId), {
                    index: -1,
                    windowId: windowId || group.tabs[0].windowId,
                });
            }
        }

        if (tempTabs.filter(Boolean).length) {
            await browser.tabs.remove(tempTabs.filter(Boolean).map(utils.keyId));
        }

        data.groups.forEach(group => group.tabs = []);

        delete data.withoutSession;

        windows = await Windows.load(true);
    }

    await Promise.all(windows.map(async function(win) {
        if (win.session.groupId) {
            let showedTabs = [],
                tabIdsToShow = [],
                tabIdsToHide = [],
                tabToHideIsActive = false;

            win.tabs.forEach(function(tab) {
                if (tab.session.groupId === win.session.groupId) {
                    if (tab.hidden) {
                        tabIdsToShow.push(tab.id);
                    }

                    showedTabs.push(tab);
                } else if (!tab.hidden) {
                    if (tab.active) {
                        tabToHideIsActive = true;
                    }

                    tabIdsToHide.push(tab.id);
                }
            });

            if (tabIdsToShow.length) {
                await browser.tabs.show(tabIdsToShow);
            }

            if (tabIdsToHide.length) {
                let tempTab = null;

                if (tabToHideIsActive) {
                    if (showedTabs.length) {
                        await Tabs.setActive(undefined, showedTabs);
                    } else {
                        tempTab = await Tabs.createTempActiveTab(win.id);
                    }
                }

                await browser.tabs.hide(tabIdsToHide);

                if (tempTab) {
                    await browser.tabs.remove(tempTab.id);
                }
            }
        } else {
            let tabsToHide = [];

            win.tabs.forEach(function(tab) {
                if (tab.session.groupId) {
                    if (data.groups.some(group => tab.session.groupId === group.id)) {
                        tabsToHide.push(tab);
                    } else {
                        cache.removeTabGroup(tab.id);
                    }
                }
            });

            if (tabsToHide.length) {
                if (tabsToHide.some(tab => tab.active)) {
                    let visibleTabs = win.tabs.filter(tab => !tab.hidden && !tab.session.groupId);

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


    // data.groups.forEach(group => group.tabs = []); // TMP for developing



    // OLD code ============================

    // _groups = data.groups;

    _thumbnails = data.thumbnails;

    await storage.remove(['doRemoveSTGNewTabUrls', 'withoutSession']);
    // await storage.clear(); TODO
    await storage.set(data);

    resetAutoBackup();

    windows.forEach(win => updateBrowserActionData(null, win.id));

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

        setBrowserAction(undefined, undefined, undefined, true);
    })
    .catch(function(e) {
        // utils.notify(e);

        setBrowserAction(undefined, 'lang:clickHereToReloadAddon', '/icons/exclamation-triangle-yellow.svg', true);

        browser.browserAction.setPopup({
            popup: '',
        });

        browser.browserAction.onClicked.addListener(() => browser.runtime.reload());

        throw e;
    });
