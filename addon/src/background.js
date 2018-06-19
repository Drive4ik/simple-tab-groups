'use strict';

import * as constants from './js/constants';
import * as utils from './js/utils';
import storage from './js/storage';

let errorLogs = [],
    options = {},
    _groups = [],
    allThumbnails = {};

let log = function(message = 'log', data = null, showNotification = true) {
    try {
        throw Error(message);
    } catch (e) {
        let prefix = browser.extension.getURL('');

        errorLogs.push({
            message: message,
            data: data,
            fromLine: e.stack.split('@').map(l => l.split(prefix).join('')),
        });

        if (showNotification) {
            utils.notify(browser.i18n.getMessage('whatsWrongMessage'))
                .then(() => browser.runtime.openOptionsPage());
        }
    }
};

let saveGroupsToStorageTimer = null;

async function saveGroupsToStorage(sendMessageToAll = false) {
    if (sendMessageToAll) {
        sendMessageGroupsUpdated();
    }

    if (saveGroupsToStorageTimer) {
        clearTimeout(saveGroupsToStorageTimer);
    }

    saveGroupsToStorageTimer = setTimeout(function() {
        if (!options.createThumbnailsForTabs) {
            _groups.forEach(function(group) {
                group.tabs.forEach(function(tab) {
                    if (tab.thumbnail) {
                        delete tab.thumbnail;
                    }
                });
            });
        }

        storage.set({
            groups: _groups,
        });
    }, 500);
}

async function getWindow(windowId = browser.windows.WINDOW_ID_CURRENT) {
    return await browser.windows.get(windowId).catch(function() {});
}

async function createWindow(createData = {}) {
    let win = await browser.windows.create(createData);

    if ('normal' === win.type) {
        lastFocusedNormalWindow = win;
    }

    lastFocusedWinId = win.id;

    return win;
}

function setFocusOnWindow(windowId) {
    return browser.windows.update(windowId, {
        focused: true,
    });
}

async function getTabs(windowId = browser.windows.WINDOW_ID_CURRENT, status = 'v') { // v: visible, h: hidden, null: all
    let tabs = await browser.tabs.query({
        windowId: windowId,
        pinned: false,
    });

    if ('v' === status) {
        return tabs.filter(utils.isTabVisible);
    } else if ('h' === status) {
        return tabs.filter(utils.isTabHidden);
    } else if (!status) {
        return tabs;
    }
}

function getPinnedTabs(windowId = browser.windows.WINDOW_ID_CURRENT) {
    return browser.tabs.query({
        windowId: windowId,
        pinned: true,
    });
}

function mapTab(tab) {
    if (!tab.url || 'about:newtab' === tab.url || 'about:blank' === tab.url) {
        tab.url = 'about:blank';
    }

    return {
        id: tab.id || null,
        title: tab.title || tab.url,
        url: tab.url,
        active: Boolean(tab.active),
        favIconUrl: tab.favIconUrl || '',
        cookieStoreId: tab.cookieStoreId || constants.DEFAULT_COOKIE_STORE_ID,
        thumbnail: options.createThumbnailsForTabs ? (tab.thumbnail || allThumbnails[tab.url] || null) : null,
    };
}

function getTabFavIconUrl(tab, useTabsFavIconsFromGoogleS2Converter) {
    let safedFavIconUrl = '',
        localUrls = ['moz-extension', 'about', 'data', 'view-source', 'javascript', 'chrome', 'file'];

    if (localUrls.some(url => tab.url.startsWith(url))) {
        safedFavIconUrl = tab.favIconUrl;
    } else {
        safedFavIconUrl = useTabsFavIconsFromGoogleS2Converter ? ('https://www.google.com/s2/favicons?domain_url=' + encodeURIComponent(tab.url)) : tab.favIconUrl;
    }

    if (!safedFavIconUrl) {
        safedFavIconUrl = '/icons/tab.svg';
    }

    return safedFavIconUrl;
}

function createGroup(id, windowId = null) {
    return {
        id: id,
        title: browser.i18n.getMessage('newGroupTitle', id),
        iconColor: utils.randomColor(),
        iconUrl: null,
        iconViewType: 'main-squares',
        tabs: [],
        catchTabRules: '',
        catchTabContainers: [],
        isSticky: false,
        windowId: windowId || null,
    };
}

async function addGroup(windowId, resetGroups = false, returnNewGroupIndex = true, withTabs = []) {
    let { lastCreatedGroupPosition } = await storage.get('lastCreatedGroupPosition');

    lastCreatedGroupPosition++;

    if (resetGroups) {
        _groups = [];
    }

    let newGroupIndex = _groups.length;

    _groups.push(createGroup(lastCreatedGroupPosition, windowId));

    if (0 === newGroupIndex) {
        let win = await getWindow(),
            tabs = await getTabs();

        windowId = win.id;

        _groups[0].windowId = windowId;
        _groups[0].tabs = tabs.map(mapTab);

        updateBrowserActionData(_groups[0].windowId);
    } else if (withTabs.length) {
        _groups[newGroupIndex].tabs = utils.clone(withTabs.map(mapTab)); // clone need for fix bug: dead object after close tab which create object
    }

    await storage.set({
        lastCreatedGroupPosition,
    });

    sendMessage({
        action: 'group-added',
        group: _groups[newGroupIndex],
    });

    sendExternalMessage({
        groupAdded: true,
        groupId: _groups[newGroupIndex].id,
    });

    updateMoveTabMenus(windowId);
    saveGroupsToStorage();

    return returnNewGroupIndex ? newGroupIndex : _groups[newGroupIndex];
}

async function updateGroup(groupId, updateData) {
    let groupIndex = _groups.findIndex(gr => gr.id === groupId);

    Object.assign(_groups[groupIndex], utils.clone(updateData)); // clone need for fix bug: dead object after close tab which create object

    sendMessage({
        action: 'group-updated',
        group: Object.assign(updateData, {
            id: groupId,
        }),
    });

    sendExternalMessage({
        groupUpdated: true,
        groupId: groupId,
    });

    saveGroupsToStorage();

    let win = await getWindow();

    if (['title', 'iconUrl', 'iconColor', 'iconViewType'].some(key => key in updateData)) {
        updateMoveTabMenus(win.id);
    }

    if (_groups[groupIndex].windowId && _groups[groupIndex].windowId === win.id) {
        updateBrowserActionData(win.id);
    }
}

function sendMessageGroupsUpdated() {
    sendMessage({
        action: 'groups-updated',
    });
}

function sendMessage(data) {
    browser.runtime.sendMessage(data);
}

function sendExternalMessage(data, allowedRequestKeys = ['getGroupsList']) {
    Object.keys(constants.EXTENSIONS_WHITE_LIST)
        .forEach(function(exId) {
            if (allowedRequestKeys.some(key => constants.EXTENSIONS_WHITE_LIST[exId].allowedRequests.includes(key))) {
                data.isExternalMessage = true;
                browser.runtime.sendMessage(exId, data);
            }
        });
}

async function addUndoRemoveGroupItem(group) {
    browser.menus.create({
        id: constants.CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP + group.id,
        title: browser.i18n.getMessage('undoRemoveGroupItemTitle', group.title),
        contexts: ['browser_action'],
        icons: {
            16: utils.getGroupIconUrl(group, options.browserActionIconColor),
        },
        onclick: function(info) {
            browser.menus.remove(info.menuItemId);

            group.windowId = null;
            group.tabs.forEach(tab => tab.id = null);

            _groups.push(group);

            updateMoveTabMenus();
            saveGroupsToStorage(true);
        },
    });
}

async function createTempActiveTab(windowId = browser.windows.WINDOW_ID_CURRENT, createPinnedTab = true) {
    let pinnedTabs = await getPinnedTabs(windowId);

    if (pinnedTabs.length) {
        if (!pinnedTabs.some(tab => tab.active)) {
            await browser.tabs.update(pinnedTabs[pinnedTabs.length - 1].id, {
                active: true,
            });
        }
    } else {
        return browser.tabs.create({
            url: 'about:blank',
            pinned: createPinnedTab,
            active: true,
            windowId: windowId,
        });
    }
}

async function removeGroup(groupId) {
    let groupIndex = _groups.findIndex(gr => gr.id === groupId),
        group = _groups[groupIndex];

    _groups.splice(groupIndex, 1);

    if (group.windowId) {
        setLoadingToBrowserAction();
        await setWindowValue(group.windowId, 'groupId', null);
    }

    addUndoRemoveGroupItem(group);

    if (_groups.length) { // dont close tabs if remove last group
        let tabsIdsToRemove = group.tabs.filter(utils.keyId).map(utils.keyId);

        if (tabsIdsToRemove.length) {
            let tempEmptyTab = null;

            if (group.windowId) {
                tempEmptyTab = await createTempActiveTab(group.windowId, false);
            }

            await browser.tabs.remove(tabsIdsToRemove);

            if (tempEmptyTab) {
                let windows = await browser.windows.getAll({}),
                    otherWindow = windows.find(win => utils.isWindowAllow(win) && win.id !== group.windowId);

                if (otherWindow) {
                    await browser.tabs.remove(tempEmptyTab.id);
                    await setFocusOnWindow(otherWindow.id);
                }
            }
        }
    }

    updateMoveTabMenus();

    if (group.windowId) {
        updateBrowserActionData();
    }

    sendMessage({
        action: 'group-removed',
        groupId: groupId,
    });

    sendExternalMessage({
        groupDeleted: true,
        groupId: groupId,
    });

    saveGroupsToStorage();
}

async function moveGroup(groupId, position = 'up') {
    let groupIndex = _groups.findIndex(group => group.id === groupId);

    if ('up' === position) {
        if (0 === groupIndex) {
            return;
        }

        _groups.splice(groupIndex - 1, 0, _groups.splice(groupIndex, 1)[0]);
    } else if ('down' === position) {
        if (groupIndex === _groups.length - 1) {
            return;
        }

        _groups.splice(groupIndex + 1, 0, _groups.splice(groupIndex, 1)[0]);
    } else if ('number' === utils.type(position)) {
        _groups.splice(position, 0, _groups.splice(groupIndex, 1)[0]);
    }

    updateMoveTabMenus();
    saveGroupsToStorage(true);
}

let savingTabsInWindow = {};

async function saveCurrentTabs(windowId, excludeTabId, calledFunc) {
    if (!windowId || savingTabsInWindow[windowId]) {
        return;
    }

    savingTabsInWindow[windowId] = true;

    let group = _groups.find(gr => gr.windowId === windowId);

    if (!group) {
        delete savingTabsInWindow[windowId];
        return;
    }

    if (calledFunc) {
        console.info('saveCurrentTabs called from', calledFunc);
    }

    let tabs = await getTabs(windowId);

    // console.info('saving tabs ', { windowId, excludeTabId, calledFunc }, JSON.parse(JSON.stringify(tabs)));

    // let syncTabIds = _groups
    //     .filter(gr => gr.id !== group.id)
    //     .reduce((acc, gr) => acc.concat(gr.tabs.filter(utils.keyId).map(utils.keyId)), []); // dont savetabs if its are already saved in other groups

    // if (excludeTabId) {
    //     syncTabIds.push(excludeTabId);
    // }

    group.tabs = tabs
        .filter(tab => excludeTabId ? excludeTabId !== tab.id : true)
        .map(mapTab);

    sendMessage({
        action: 'group-updated',
        group: {
            id: group.id,
            tabs: group.tabs,
        },
    });

    saveGroupsToStorage();

    delete savingTabsInWindow[windowId];
}

async function addTab(groupId, cookieStoreId) {
    let group = _groups.find(gr => gr.id === groupId);

    if (group.windowId) {
        await browser.tabs.create({
            active: false,
            cookieStoreId,
            windowId: group.windowId,
        });
    } else {
        group.tabs.push({
            active: false,
            url: 'about:blank',
            cookieStoreId,
        });
        saveGroupsToStorage();
    }

    sendMessage({
        action: 'group-updated',
        group: {
            id: group.id,
            tabs: group.tabs,
        },
    });
}

async function removeTab(groupId, tabIndex) {
    let group = _groups.find(gr => gr.id === groupId),
        tabId = group.tabs[tabIndex].id;

    if (tabId) {
        let tab = await browser.tabs.get(tabId);

        if (utils.isTabHidden(tab)) {
            group.tabs.splice(tabIndex, 1);
            saveGroupsToStorage();
        } else {
            let pinnedTabs = await getPinnedTabs(tab.windowId),
                tabs = await getTabs(tab.windowId);

            if (!pinnedTabs.length && 1 === tabs.length) {
                await browser.tabs.create({
                    active: true,
                    windowId: tab.windowId,
                });
            }
        }

        await browser.tabs.remove(tabId);
    } else {
        group.tabs.splice(tabIndex, 1);

        sendMessage({
            action: 'group-updated',
            group: {
                id: group.id,
                tabs: group.tabs,
            },
        });

        saveGroupsToStorage();
    }
}

function setLoadingToBrowserAction() {
    browser.browserAction.setIcon({
        path: '/icons/animate-spinner.svg',
    });
}

let loadingGroupInWindow = {}; // windowId: true;
async function loadGroup(windowId, groupIndex, activeTabIndex = -1) {
    if (!windowId) { // if click on notification after moving tab to window which is now closed :)
        throw Error('loadGroup: windowId not set');
    }

    let group = _groups[groupIndex];

    if (!group) {
        throw Error('group index not found ' + groupIndex);
    }

    if (loadingGroupInWindow[windowId]) {
        return;
    }

    // console.log('loadGroup', { groupId: group.id, windowId, activeTabIndex });

    try {
        if (group.windowId) {
            if (-1 !== activeTabIndex) {
                await browser.tabs.update(group.tabs[activeTabIndex].id, {
                    active: true,
                });
            }

            setFocusOnWindow(group.windowId);
        } else {
            // magic

            let tmpWin = await getWindow(windowId);
            if (tmpWin.incognito) {
                throw 'Error: Does\'nt support private windows';
            }

            let oldTabIds = [],
                oldGroup = _groups.find(gr => gr.windowId === windowId);

            if (oldGroup) {
                let tabs = await getTabs(windowId);

                if (tabs.some(utils.isTabCanNotBeHidden)) {
                    throw browser.i18n.getMessage('notPossibleSwitchGroupBecauseSomeTabShareMicrophoneOrCamera');
                }

                // oldGroup.windowId = null;
                oldTabIds = oldGroup.tabs.map(utils.keyId);
            }

            loadingGroupInWindow[windowId] = true;

            setLoadingToBrowserAction();

            removeEvents();

            let pinnedTabs = await getPinnedTabs(windowId),
                pinnedTabsLength = pinnedTabs.length;

            // group.windowId = windowId;
            group.tabs = group.tabs.filter(tab => tab.id || utils.isUrlAllowToCreate(tab.url)); // remove missed unsupported tabs

            if (!group.tabs.length && !pinnedTabsLength && oldGroup) {
                group.tabs.push({
                    url: 'about:blank',
                    active: true,
                    cookieStoreId: constants.DEFAULT_COOKIE_STORE_ID,
                });
            }

            let tempEmptyTab = null;

            if (oldGroup) {
                tempEmptyTab = await createTempActiveTab(windowId); // create empty tab (for quickly change group and not blinking)

                if (tempEmptyTab) {
                    pinnedTabsLength++;
                }

                if (oldTabIds.length) {
                    await browser.tabs.hide(oldTabIds);

                    if (options.discardTabsAfterHide) {
                        browser.tabs.discard(oldTabIds);
                    }
                }
            } else {
                let winTabs = await getTabs(windowId);

                if (winTabs.length && group.tabs.length) {
                    let syncedTabs = [];

                    group.tabs
                        .filter(tab => !tab.id)
                        .forEach(function(tab) {
                            let winTab = winTabs.find(function(t) {
                                if (!syncedTabs.includes(t.id)) {
                                    return t.url === tab.url;
                                }
                            });

                            if (winTab) {
                                tab.id = winTab.id;
                                syncedTabs.push(winTab.id);
                            }
                        });
                }
            }

            if (group.tabs.length) {
                let containers = await utils.loadContainers(),
                    hiddenTabsIds = group.tabs.filter(utils.keyId).map(utils.keyId);

                if (hiddenTabsIds.length) {
                    await browser.tabs.move(hiddenTabsIds, {
                        index: pinnedTabsLength,
                        windowId: windowId,
                    });
                    await browser.tabs.show(hiddenTabsIds);
                }

                await Promise.all(group.tabs.map(async function(tab, tabIndex) {
                    if (tab.id) {
                        return;
                    }

                    let isTabActive = -1 === activeTabIndex ? Boolean(tab.active) : tabIndex === activeTabIndex;

                    let newTab = await browser.tabs.create({
                        active: isTabActive,
                        index: pinnedTabsLength + tabIndex,
                        url: tab.url,
                        windowId: windowId,
                        cookieStoreId: utils.normalizeCookieStoreId(tab.cookieStoreId, containers),
                    });

                    tab.id = newTab.id;
                }));

                // set active tab
                group.tabs.some(function(tab, tabIndex) {
                    let isTabActive = -1 === activeTabIndex ? Boolean(tab.active) : tabIndex === activeTabIndex;

                    if (isTabActive) {
                        browser.tabs.update(tab.id, {
                            active: true,
                        });
                        return true;
                    }
                });
            }

            if (tempEmptyTab) {
                await browser.tabs.remove(tempEmptyTab.id);
            }

            if (oldGroup) {
                oldGroup.windowId = null;
            }

            group.windowId = windowId;
            await setWindowValue(windowId, 'groupId', group.id);

            await saveCurrentTabs(windowId, undefined, 'loadGroup');

            updateMoveTabMenus(windowId);

            updateBrowserActionData(windowId);

            addEvents();

            delete loadingGroupInWindow[windowId];
        }

        sendMessage({
            action: 'group-loaded',
            group: group,
        });

    } catch (e) {
        delete loadingGroupInWindow[windowId];
        utils.notify(e);
        throw String(e);
    }
}

function isCatchedUrl(url, group) {
    if (!group.catchTabRules) {
        return false;
    }

    return group.catchTabRules
        .split(/\s*\n\s*/)
        .filter(Boolean)
        .some(function(regExpStr) {
            try {
                return new RegExp(regExpStr).test(url);
            } catch (e) {};
        });
}

async function getTabThumbnail(tabId) {
    let tab = await browser.tabs.get(tabId);

    if (tab.discarded) {
        utils.notify(browser.i18n.getMessage('cantMakeThumbnailTabWasDiscarded'));
        return null;
    }

    let thumbnailBase64 = await browser.tabs.captureTab(tabId, {
        format: 'png',
    });

    return new Promise(function(resolve, reject) {
        let img = new Image();

        img.onload = function() {
            resolve(utils.resizeImage(img, 192, Math.floor(img.width * 192 / img.height), false));
        };

        img.onerror = reject;

        img.src = thumbnailBase64;
    });
}

async function updateTabThumbnail(tabId, force = false) {
    if (!options.createThumbnailsForTabs || !tabId) {
        return;
    }

    let groupId = null,
        tab = null,
        tabIndex = null;

    _groups.some(function(gr) {
        let found = gr.tabs.some(function(t, tIndex) {
            if (t.id === tabId) {
                tab = t;
                tabIndex = tIndex;
                return true;
            }
        });

        if (found) {
            groupId = gr.id;
        }

        return found;
    });

    if (!tab || (tab.thumbnail && !force)) {
        return;
    }

    try {
        tab.thumbnail = await getTabThumbnail(tabId);
    } catch (e) {
        console.warn(e);
        tab.thumbnail = null;
    }

    if (tab.thumbnail || force) {
        allThumbnails[tab.url] = tab.thumbnail;

        sendMessage({
            action: 'tab-thumbnail-updated',
            tabIndex,
            groupId,
            thumbnail: tab.thumbnail,
        });

        saveGroupsToStorage();
    }
}

async function onActivatedTab({ tabId, windowId }) {
    console.log('onActivatedTab', { tabId, windowId });

    let group = _groups.find(gr => gr.windowId === windowId);

    if (!group) {
        return;
    }

    group.tabs = group.tabs.map(function(tab, index) {
        tab.active = tab.id === tabId;

        if (!tab.thumbnail) { // TODO refacror: move update thumbnail to other place
            updateTabThumbnail(tabId);
        }

        return tab;
    });

    sendMessage({
        action: 'group-updated',
        group: {
            id: group.id,
            tabs: group.tabs,
        },
    });

    saveGroupsToStorage();
}

async function onCreatedTab(tab) {
    console.log('onCreatedTab', tab);

    saveCurrentTabs(tab.windowId, undefined, 'onCreatedTab');
}

let currentlyMovingTabs = []; // tabIds // expample: open tab from bookmark and move it to other group: many calls method onUpdatedTab

async function onUpdatedTab(tabId, changeInfo, tab) {
    let windowId = tab.windowId,
        group = _groups.find(gr => gr.windowId === windowId);

    if (!group ||
        utils.isTabIncognito(tab) ||
        currentlyMovingTabs.includes(tabId) || // reject processing tabs
        'isArticle' in changeInfo || // not supported reader mode now
        'discarded' in changeInfo || // not supported discard tabs now
        (utils.isTabPinned(tab) && undefined === changeInfo.pinned)) { // pinned tabs are not supported
        return;
    }

    console.log('onUpdatedTab\n tabId:', tabId, JSON.stringify(changeInfo) + '\n', JSON.stringify({
        status: tab.status,
        url: tab.url,
        title: tab.title,
    }));

    if ('hidden' in changeInfo) { // if other programm hide or show tabs
        if (changeInfo.hidden) {
            saveCurrentTabs(windowId, undefined, 'onUpdatedTab tab make hidden');
        } else {
            let descTabIndex = -1,
                descGroupIndex = _groups.findIndex(function(gr) {
                    descTabIndex = gr.tabs.findIndex(t => t.id === tabId);

                    if (-1 !== descTabIndex) {
                        return true;
                    }
                });

            if (-1 === descGroupIndex) {
                saveCurrentTabs(windowId, undefined, 'onUpdatedTab tab make visible');
            } else {
                loadGroup(windowId, descGroupIndex, descTabIndex);
            }
        }

        return;
    }

    if ('pinned' in changeInfo) {
        saveCurrentTabs(windowId, undefined, 'onUpdatedTab change pinned tab');

        return;
    }

    if (!group.tabs.some(t => t.id === tabId)) {
        console.warn('saving tab by update was canceled: tab not found in group');
        return;
    }

    let savedTabIndex = group.tabs.findIndex(t => t.id === tabId);

    if ('loading' === changeInfo.status && changeInfo.url) {
        if (!group.isSticky && utils.isUrlAllowToCreate(changeInfo.url) && !utils.isUrlEmpty(changeInfo.url)) {
            let destGroup = _groups.find(gr => gr.catchTabContainers.includes(tab.cookieStoreId)) || _groups.find(gr => isCatchedUrl(changeInfo.url, gr));

            if (destGroup && destGroup.id !== group.id) {
                currentlyMovingTabs.push(tabId);

                group.tabs[savedTabIndex] = mapTab(tab);

                await moveTabToGroup(savedTabIndex, undefined, group.id, destGroup.id);

                currentlyMovingTabs.splice(currentlyMovingTabs.indexOf(tabId), 1);
            }
        }
    } else if ('complete' === tab.status) {
        saveCurrentTabs(windowId, undefined, 'onUpdatedTab complete load tab');

        if (!group.tabs[savedTabIndex].thumbnail) { // TODO refactor this
            updateTabThumbnail(tabId);
        }
    }
}

async function onRemovedTab(tabId, { isWindowClosing, windowId }) {
    console.log('onRemovedTab', arguments);

    let findTab = _groups.some(function(group) {
        let tabIndex = group.tabs.findIndex(tab => tab.id === tabId);

        if (-1 !== tabIndex) {
            if (isWindowClosing) {
                group.tabs[tabIndex].id = null;
            } else {
                group.tabs.splice(tabIndex, 1);
            }

            return true;
        }
    });

    if (isWindowClosing) {
        return;
    }

    saveCurrentTabs(windowId, tabId, 'onRemovedTab');
}

async function onMovedTab(tabId, { windowId }) {
    console.log('onMovedTab', tabId, { windowId });

    saveCurrentTabs(windowId, undefined, 'onMovedTab');
}

async function onAttachedTab(tabId, { newWindowId }) {
    console.log('onAttachedTab', tabId, { newWindowId });

    saveCurrentTabs(newWindowId, undefined, 'onAttachedTab');
}

async function onDetachedTab(tabId, { oldWindowId }) { // notice: call before onAttached
    console.log('onDetachedTab', tabId, { oldWindowId });

    let group = _groups.find(gr => gr.windowId === oldWindowId);

    if (!group) {
        return;
    }

    let tabIndex = group.tabs.findIndex(tab => tab.id === tabId);

    if (-1 === tabIndex) { // if tab is not allowed
        return;
    }

    group.tabs.splice(tabIndex, 1);

    sendMessage({
        action: 'group-updated',
        group: {
            id: group.id,
            tabs: group.tabs,
        },
    });

    saveGroupsToStorage();
}

let lastFocusedWinId = null,
    lastFocusedNormalWindow = null; // fix bug with browser.windows.getLastFocused({windowTypes: ['normal']}), maybe find exists bug??

async function onFocusChangedWindow(windowId) {
    console.log('onFocusChangedWindow', windowId);

    if (browser.windows.WINDOW_ID_NONE === windowId) {
        return;
    }

    let win = await getWindow(windowId);

    if (win.incognito) {
        browser.browserAction.disable();
        resetBrowserActionData();
        removeMoveTabMenus();
    } else if (!lastFocusedWinId || lastFocusedWinId !== windowId) {
        browser.browserAction.enable();
        updateBrowserActionData(windowId);
        updateMoveTabMenus(windowId);
    }

    if (utils.isWindowAllow(win)) {
        lastFocusedNormalWindow = win;
    }

    lastFocusedWinId = windowId;
}

// if oldGroupId === null, move tab from current window without group
async function moveTabToGroup(oldTabIndex, newTabIndex = -1, oldGroupId = null, newGroupId, showNotificationAfterMoveTab = true, sendMessageAction = true) {
    console.warn('moveTabToGroup', [].join.call(arguments, ' '));

    let oldGroup = null,
        newGroup = _groups.find(gr => gr.id === newGroupId),
        tab = null,
        rawTab = null,
        pushToEnd = -1 === newTabIndex,
        newTabRealIndex = null;

    if (pushToEnd) {
        newTabIndex = newGroup.tabs.length;
    }

    if (newGroup.windowId) {
        let pinnedTabs = await getPinnedTabs(newGroup.windowId);
        newTabRealIndex = pushToEnd ? -1 : (pinnedTabs.length + newTabIndex);
    }

    if (oldGroupId) {
        oldGroup = _groups.find(gr => gr.id === oldGroupId);
        tab = oldGroup.tabs[oldTabIndex];
    } else {
        let tabId = oldTabIndex;
        rawTab = await browser.tabs.get(tabId);
        tab = mapTab(rawTab);
    }


    if (oldGroupId === newGroupId) { // if it's same group
        if (newGroup.windowId) {
            await browser.tabs.move(tab.id, {
                index: newTabRealIndex,
            });
        } else {
            if (newTabIndex !== oldTabIndex) {
                newGroup.tabs.splice(newTabIndex, 0, newGroup.tabs.splice(oldTabIndex, 1)[0]);
            }
        }
    } else { // if it's different group
        if (tab.id) {
            if (!rawTab) {
                rawTab = await browser.tabs.get(tab.id);
            }

            if (!newGroup.windowId && !utils.isTabCanBeHidden(rawTab)) {
                utils.notify(browser.i18n.getMessage('thisTabCanNotBeHidden'));
                return;
            }
        } else {
            if (!utils.isUrlAllowToCreate(tab.url)) {
                utils.notify(browser.i18n.getMessage('thisTabIsNotSupported'));
                return;
            }
        }

        if (oldGroup) {
            oldGroup.tabs.splice(oldTabIndex, 1);
        }

        if (tab.id) {
            newGroup.tabs.splice(newTabIndex, 0, tab);

            if (newGroup.windowId) {
                await browser.tabs.move(tab.id, {
                    index: newTabRealIndex,
                    windowId: newGroup.windowId,
                });
                await browser.tabs.show(tab.id);
            } else {
                let tabInGroup = newGroup.tabs.find(utils.keyId);

                if (tabInGroup) {
                    let rawTabInGroup = await browser.tabs.get(tabInGroup.id);

                    if (rawTabInGroup.windowId !== rawTab.windowId) {
                        await browser.tabs.move(tab.id, {
                            index: -1,
                            windowId: rawTabInGroup.windowId,
                        });
                        // await browser.tabs.show(tab.id);

                        rawTab = await browser.tabs.get(tab.id);
                    }
                }

                if (utils.isTabVisible(rawTab)) {
                    let tempEmptyTab = null;

                    if (rawTab.active) {
                        let tabs = await getTabs(rawTab.windowId),
                            activeIndex = tabs.findIndex(t => t.id === tab.id),
                            tabIdToMakeActive = null;

                        if (tabs[activeIndex + 1]) {
                            tabIdToMakeActive = tabs[activeIndex + 1].id;
                        } else if (activeIndex - 1 >= 0) {
                            tabIdToMakeActive = tabs[activeIndex - 1].id;
                        } else {
                            tempEmptyTab = await createTempActiveTab(rawTab.windowId);
                        }

                        if (tabIdToMakeActive) {
                            await browser.tabs.update(tabIdToMakeActive, {
                                active: true,
                            });
                        }
                    }

                    await browser.tabs.hide(tab.id);

                    if (tempEmptyTab) {
                        await browser.tabs.remove(tempEmptyTab.id);
                    }
                }
            }
        } else {
            // add tab
            if (newGroup.windowId) {
                let containers = await utils.loadContainers();

                await browser.tabs.create({
                    active: false,
                    url: tab.url,
                    index: newTabRealIndex,
                    windowId: newGroup.windowId,
                    cookieStoreId: utils.normalizeCookieStoreId(tab.cookieStoreId, containers),
                });
            } else {
                newGroup.tabs.splice(newTabIndex, 0, tab);
            }
        }
    }

    if (sendMessageAction) {
        if (oldGroup && oldGroup !== newGroup) {
            sendMessage({
                action: 'group-updated',
                group: {
                    id: oldGroup.id,
                    tabs: oldGroup.tabs,
                },
            });
        }

        sendMessage({
            action: 'group-updated',
            group: {
                id: newGroup.id,
                tabs: newGroup.tabs,
            },
        });
    }

    saveGroupsToStorage();

    if (!showNotificationAfterMoveTab || !options.showNotificationAfterMoveTab) {
        return;
    }

    let title = tab.title.length > 50 ? (tab.title.slice(0, 50) + '...') : tab.title,
        message = browser.i18n.getMessage('moveTabToGroupMessage', [newGroup.title, title]);

    utils.notify(message).then(async function(newGroupId, newTabIndex) {
        let groupIndex = _groups.findIndex(group => group.id === newGroupId);

        if (-1 !== groupIndex && _groups[groupIndex].tabs[newTabIndex]) {
            await setFocusOnWindow(lastFocusedNormalWindow.id);
            loadGroup(lastFocusedNormalWindow.id, groupIndex, newTabIndex);
        }
    }.bind(null, newGroup.id, newTabIndex));
}

let moveTabToGroupMenusIds = [];

async function updateMoveTabMenus(windowId) {
    await removeMoveTabMenus();
    await createMoveTabMenus(windowId);
}

async function removeMoveTabMenus() {
    if (!moveTabToGroupMenusIds.length) {
        return;
    }

    await Promise.all(moveTabToGroupMenusIds.map(id => browser.menus.remove(id)));

    moveTabToGroupMenusIds = [];
}

async function createMoveTabMenus(windowId) {
    if (!windowId) {
        let win = await getWindow();
        windowId = win.id;
    }

    let currentGroup = _groups.find(gr => gr.windowId === windowId);

    moveTabToGroupMenusIds.push(browser.menus.create({
        id: 'stg-set-tab-icon-as-group-icon',
        title: browser.i18n.getMessage('setTabIconAsGroupIcon'),
        enabled: Boolean(currentGroup),
        icons: {
            16: '/icons/image.svg',
        },
        contexts: ['tab'],
        onclick: function(info, tab) {
            if (utils.isTabIncognito(tab)) {
                utils.notify(browser.i18n.getMessage('privateAndPinnedTabsAreNotSupported'));
                return;
            }

            let group = _groups.find(gr => gr.windowId === tab.windowId);

            if (!group) {
                return;
            }

            group.iconUrl = getTabFavIconUrl(tab);

            updateBrowserActionData(group.windowId);
            updateMoveTabMenus(group.windowId);

            sendMessage({
                action: 'group-updated',
                group: {
                    id: group.id,
                    iconUrl: group.iconUrl,
                },
            });

            saveGroupsToStorage();
        }
    }));

    moveTabToGroupMenusIds.push(browser.menus.create({
        id: 'stg-move-tab-helper',
        title: browser.i18n.getMessage('moveTabToGroupDisabledTitle'),
        enabled: false,
        contexts: ['tab'],
    }));

    await Promise.all(_groups.map(function(group) {
        moveTabToGroupMenusIds.push(browser.menus.create({
            id: constants.CONTEXT_MENU_PREFIX_GROUP + group.id,
            title: group.title,
            enabled: currentGroup ? group.id !== currentGroup.id : true,
            icons: {
                16: utils.getGroupIconUrl(group, options.browserActionIconColor),
            },
            contexts: ['tab'],
            onclick: async function(destGroupId, info, tab) {
                if (utils.isTabIncognito(tab) || utils.isTabPinned(tab)) {
                    utils.notify(browser.i18n.getMessage('privateAndPinnedTabsAreNotSupported'));
                    return;
                }

                let oldTabIndex,
                    oldGroupId,
                    oldGroup = _groups.find(gr => gr.windowId === tab.windowId);

                if (oldGroup) {
                    oldTabIndex = oldGroup.tabs.findIndex(t => t.id === tab.id);
                    oldGroupId = oldGroup.id;
                } else {
                    oldTabIndex = tab.id;
                }

                moveTabToGroup(oldTabIndex, undefined, oldGroupId, destGroupId);
            }.bind(null, group.id),
        }));
    }));

    moveTabToGroupMenusIds.push(browser.menus.create({
        id: 'stg-move-tab-new-group',
        contexts: ['tab'],
        title: browser.i18n.getMessage('createNewGroup'),
        icons: {
            16: '/icons/group-new.svg',
        },
        onclick: async function(info, tab) {
            if (utils.isTabIncognito(tab) || utils.isTabPinned(tab)) {
                utils.notify(browser.i18n.getMessage('privateAndPinnedTabsAreNotSupported'));
                return;
            }

            let oldTabIndex,
                oldGroupId,
                newGroup = await addGroup(undefined, undefined, false),
                oldGroup = _groups.find(gr => gr.windowId === tab.windowId);

            if (oldGroup) {
                oldTabIndex = oldGroup.tabs.findIndex(t => t.id === tab.id);
                oldGroupId = oldGroup.id;
            } else {
                oldTabIndex = tab.id;
            }

            moveTabToGroup(oldTabIndex, undefined, oldGroupId, newGroup.id);
        },
    }));
}

function setBrowserActionData(currentGroup) {
    if (!currentGroup) {
        resetBrowserActionData();
        return;
    }

    browser.browserAction.setTitle({
        title: currentGroup.title + ' - ' + browser.i18n.getMessage('extensionName'),
    });

    browser.browserAction.setIcon({
        path: utils.getGroupIconUrl(currentGroup, options.browserActionIconColor),
    });
}

function resetBrowserActionData() {
    browser.browserAction.setTitle({
        title: browser.runtime.getManifest().browser_action.default_title,
    });

    browser.browserAction.setIcon({
        path: utils.getGroupIconUrl(undefined, options.browserActionIconColor),
    });
}

async function updateBrowserActionData(windowId) {
    if (!windowId) {
        let win = await getWindow();
        windowId = win.id;
    }

    setBrowserActionData(_groups.find(gr => gr.windowId === windowId));
}

async function onRemovedWindow(windowId) {
    let group = _groups.find(gr => gr.windowId === windowId);

    if (group) {
        group.windowId = null;
        group.tabs.forEach(tab => tab.id = null); // reset tab id in func onRemovedTab

        sendMessage({
            action: 'group-updated',
            group: {
                id: group.id,
                windowId: null,
                tabs: group.tabs,
            },
        });

        saveGroupsToStorage();
    }

    if (lastFocusedNormalWindow.id === windowId) {
        lastFocusedNormalWindow = await getWindow();
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

    browser.windows.onFocusChanged.removeListener(onFocusChangedWindow);
    browser.windows.onRemoved.removeListener(onRemovedWindow);
}

async function loadGroupPosition(textPosition) {
    if (1 === _groups.length) {
        return;
    }

    let win = await getWindow(),
        groupIndex = _groups.findIndex(group => group.windowId === win.id);

    if (-1 === groupIndex) {
        return;
    }

    let nextGroupIndex = utils.getNextIndex(groupIndex, _groups.length, textPosition);

    if (false === nextGroupIndex) {
        return;
    }

    await loadGroup(_groups[groupIndex].windowId, nextGroupIndex);
}

function sortGroups(vector = 'asc') {
    if (!['asc', 'desc'].includes(vector)) {
        return;
    }

    _groups = _groups.sort(function(a, b) {
        if ('asc' === vector) {
            return utils.compareStrings(a.title, b.title);
        } else if ('desc' === vector) {
            return utils.compareStrings(b.title, a.title);
        }
    });

    updateMoveTabMenus();
    saveGroupsToStorage(true);
}

async function openManageGroups(windowScreen) {
    let manageUrl = browser.extension.getURL(constants.MANAGE_TABS_URL);

    if (options.openManageGroupsInTab) {
        let tabs = await browser.tabs.query({
            windowId: browser.windows.WINDOW_ID_CURRENT,
            url: manageUrl,
            // pinned: false,
            // hidden: false,
        });

        if (tabs.length) { // if manage tab is found
            browser.tabs.update(tabs[0].id, {
                active: true,
            });
        } else {
            browser.tabs.create({
                active: true,
                url: manageUrl,
            });
        }
    } else {
        let allWindows = await browser.windows.getAll({
            populate: true,
            windowTypes: ['popup'],
        });

        let isFoundWindow = allWindows.some(function(win) {
            if ('popup' === win.type && 1 === win.tabs.length && manageUrl === win.tabs[0].url) { // if manage popup is now open
                BG.setFocusOnWindow(win.id);
                return true;
            }
        });

        if (isFoundWindow) {
            return;
        }

        let createData = {
            url: manageUrl,
            type: 'popup',
        };

        if (windowScreen) {
            createData.left = 0;
            createData.top = 0;
            createData.width = windowScreen.availWidth;
            createData.height = windowScreen.availHeight;
        }

        createWindow(createData);
    }
}

browser.menus.create({
    id: 'openSettings',
    title: browser.i18n.getMessage('openSettings'),
    onclick: () => browser.runtime.openOptionsPage(),
    contexts: ['browser_action'],
    icons: {
        16: '/icons/settings.svg',
    },
});

browser.runtime.onMessage.addListener(async function(request, sender) {
    if (!utils.isAllowSender(request, sender)) {
        return {
            unsubscribe: true,
        };
    }

    if (request.optionsUpdated) {
        options = await storage.get(constants.allOptionsKeys);

        if (request.optionsUpdated.includes('hotkeys')) {
            let tabs = await browser.tabs.query({
                discarded: false,
                pinned: false,
                windowType: 'normal',
            });

            tabs.forEach(function(tab) {
                if (utils.isTabNotIncognito(tab)) {
                    browser.tabs.sendMessage(tab.id, {
                        updateHotkeys: true,
                    });
                }
            });
        }
    }

    if (request.runAction) {
        runAction(request.runAction);
    }
});

browser.runtime.onMessageExternal.addListener(function(request, sender, sendResponse) {
    let extensionRules = {};

    if (!utils.isAllowExternalRequestAndSender(request, sender, extensionRules)) {
        sendResponse({
            ok: false,
            error: '[STG] Your extension/action does not in white list. If you want to add your extension/action to white list - please contact with me.',
            yourExtentionRules: extensionRules,
        });
        return;
    }

    if (request.areYouHere) {
        sendResponse({
            ok: true,
        });
    } else if (request.getGroupsList) {
        sendResponse({
            ok: true,
            groupsList: _groups.map(function(group) {
                return {
                    id: group.id,
                    title: group.title,
                    iconUrl: utils.getGroupIconUrl(group, options.browserActionIconColor),
                };
            }),
        });
    } else if (request.runAction) {
        sendResponse(runAction(request.runAction));
    }
});

async function runAction(action) {
    let result = {
        ok: false,
    };

    if (!action || !action.id) {
        result.error = '[STG] Action id is empty';
        return result;
    }

    let currentWindow = await getWindow(),
        currentGroup = _groups.find(gr => gr.windowId === currentWindow.id);

    if (!utils.isWindowAllow(currentWindow)) {
        result.error = '[STG] This window is not supported';
        return result;
    }

    try {
        if ('load-next-group' === action.id) {
            if (currentGroup) {
                await loadGroupPosition('next');
                result.ok = true;
            }
        } else if ('load-prev-group' === action.id) {
            if (currentGroup) {
                await loadGroupPosition('prev');
                result.ok = true;
            }
        } else if ('load-first-group' === action.id) {
            if (_groups[0]) {
                await loadGroup(currentWindow.id, 0);
                result.ok = true;
            }
        } else if ('load-last-group' === action.id) {
            if (_groups[_groups.length - 1]) {
                await loadGroup(currentWindow.id, _groups.length - 1);
                result.ok = true;
            }
        } else if ('load-custom-group' === action.id) {
            let groupIndex = _groups.findIndex(gr => gr.id === action.groupId);

            if (-1 === groupIndex) {
                throw Error('group id not found');
            } else {
                await loadGroup(currentWindow.id, groupIndex);
                result.ok = true;
            }
        } else if ('add-new-group' === action.id) {
            await addGroup();
            result.ok = true;
        } else if ('delete-current-group' === action.id) {
            if (currentGroup) {
                await removeGroup(currentGroup.id);
                result.ok = true;
            }
        } else if ('open-manage-groups' === action.id) {
            await openManageGroups();
            result.ok = true;
        }
    } catch (e) {
        result.error = '[STG] ' + String(e);
    }

    return result;
}

window.background = {
    inited: false,

    log,
    // getLogs: () => errorLogs,
    getLogs: function() {
        let logs = errorLogs;
        errorLogs = [];
        return logs;
    },

    openManageGroups,

    getGroups: () => _groups,

    createWindow,
    getWindow,

    getTabs,
    moveTabToGroup,

    updateMoveTabMenus,

    updateBrowserActionData,
    setFocusOnWindow,
    getLastFocusedNormalWindow: () => lastFocusedNormalWindow,

    sortGroups,
    loadGroup,

    sendMessageGroupsUpdated,

    mapTab,
    getTabFavIconUrl,
    updateTabThumbnail,
    getTabThumbnail,

    addTab,
    removeTab,

    createGroup,
    moveGroup,
    addGroup,
    updateGroup,
    removeGroup,

    runMigrateForData,
};

async function runMigrateForData(data) {
    if (!data || !Array.isArray(data.groups)) {
        throw TypeError('data type or groups type is wrong');
    }

    // reset tab ids
    data.groups.forEach(group => group.tabs.forEach(tab => tab.id = null));

    if (data.version === browser.runtime.getManifest().version) {
        return data;
    }

    if (1 === utils.compareStrings(data.version, browser.runtime.getManifest().version)) {
        throw 'Please, update addon to latest version';
    }

    // start migration
    let keysToRemoveFromStorage = [],
        removeKeys = function(...keys) {
            keys.forEach(function(key) {
                delete data[key];
                keysToRemoveFromStorage.push(key);
            });
        };

    if (-1 === utils.compareStrings(data.version, '1.8.1')) {
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
    }

    if (-1 === utils.compareStrings(data.version, '2.2')) {
        if ('showGroupCircleInSearchedTab' in data) {
            data.showGroupIconWhenSearchATab = data.showGroupCircleInSearchedTab;
            removeKeys('showGroupCircleInSearchedTab');
        }
    }

    if (-1 === utils.compareStrings(data.version, '2.3')) {
        data.groups = data.groups.map(function(group) {
            group.tabs = group.tabs.filter(Boolean);
            return group;
        });

        removeKeys('enableKeyboardShortcutLoadNextPrevGroup', 'enableKeyboardShortcutLoadByIndexGroup');
    }

    if (-1 === utils.compareStrings(data.version, '2.4')) {
        data.groups = data.groups.map(function(group) {
            if (!group.catchTabContainers) {
                group.catchTabContainers = [];
            }

            return group;
        });
    }

    if (-1 === utils.compareStrings(data.version, '2.4.5')) {
        data.groups = data.groups.map(function(group) {
            if (!group.iconColor.trim()) {
                group.iconColor = 'transparent';
            }

            group.iconViewType = 'main-squares';

            return group;
        });
    }

    if (-1 === utils.compareStrings(data.version, '3.0')) {
        data.doRemoveSTGNewTabUrls = true;
        removeKeys('enableFastGroupSwitching', 'enableFavIconsForNotLoadedTabs', 'createNewGroupAfterAttachTabToNewWindow');
        removeKeys('individualWindowForEachGroup', 'openNewWindowWhenCreateNewGroup', 'showNotificationIfGroupsNotSyncedAtStartup');
        removeKeys('showGroupIconWhenSearchATab', 'showUrlTooltipOnTabHover');

        data.groups = data.groups.map(function(group) {
            group.title = utils.unSafeHtml(group.title);
            return group;
        });
    }



    data.version = browser.runtime.getManifest().version;

    if (keysToRemoveFromStorage.length) {
        await storage.remove(keysToRemoveFromStorage);
    }
    // end migration

    return data;
}

const NEW_TAB_URL = '/stg-newtab/newtab.html';

async function removeSTGNewTabUrls(windows) {
    function isStgNewTabUrl(url) {
        return url.startsWith('moz-extension') && url.includes(NEW_TAB_URL);
    }

    function revokeStgNewTabUrl(url) {
        return new URL(url).searchParams.get('url');
    }

    return Promise.all(
        windows
            .map(async function(win) {
                await Promise.all(
                    win.tabs
                        .map(async function(tab) {
                            if (isStgNewTabUrl(tab.url)) {
                                tab.url = revokeStgNewTabUrl(tab.url);

                                await browser.tabs.update(tab.id, {
                                    url: tab.url,
                                    loadReplace: true,
                                });
                            }
                        })
                );

                return win;
            })
    );
}

// { reason: "update", previousVersion: "3.0.1", temporary: true }
// { reason: "install", temporary: true }
// browser.runtime.onInstalled.addListener(console.info.bind(null, 'onInstalled'));

// fix FF bug on browser.windows.getAll ... function not return all windows
async function getAllWindows() {
    let allTabs = await browser.tabs.query({
        pinned: false,
        windowType: 'normal',
    });

    return Promise.all(
        allTabs
            .reduce((acc, tab) => acc.includes(tab.windowId) ? acc : acc.concat([tab.windowId]), [])
            .map(async function(winId) {
                let win = await browser.windows.get(winId);

                if (!utils.isWindowAllow(win)) {
                    return false;
                }

                win.tabs = allTabs.filter(tab => tab.windowId === win.id);
                win.session = await getSessionDataFromWindow(win.id);

                return win;
            })
            .filter(Boolean)
    );
}

async function setWindowValue(windowId, key, value = null) {
    return browser.sessions.setWindowValue(windowId, key, value);
}

async function getWindowValue(windowId, key) {
    return await browser.sessions.getWindowValue(windowId, key).catch(utils.notify) || null;
}

async function getSessionDataFromWindow(windowId) {
    return {
        groupId: await getWindowValue(windowId, 'groupId'),
    };
}

async function init() {
    let data = await storage.get(null);

    data = await runMigrateForData(data); // run migration for data

    constants.allOptionsKeys.forEach(key => options[key] = key in data ? data[key] : utils.clone(constants.DEFAULT_OPTIONS[key])); // reload options

    let windows = await getAllWindows();

    if (!windows.length) {
        utils.notify(browser.i18n.getMessage('nowFoundWindowsAddonStoppedWorking'));
        return;
    }

    let isMigrateToV3 = !!data.doRemoveSTGNewTabUrls;

    if (!data.doRemoveSTGNewTabUrls) {
        data.doRemoveSTGNewTabUrls = windows.some(win => win.tabs.some(tab => tab.url.startsWith('moz-extension') && tab.url.includes(NEW_TAB_URL)));
    }

    if (data.doRemoveSTGNewTabUrls) {
        windows = await removeSTGNewTabUrls(windows);
    }

    delete data.doRemoveSTGNewTabUrls;

    lastFocusedNormalWindow = windows.find(win => win.focused) || windows[0];
    lastFocusedWinId = lastFocusedNormalWindow.id;

    if (options.createThumbnailsForTabs) {
        data.groups.forEach(function(group) {
            group.tabs.forEach(function(tab) {
                if (tab.thumbnail && !allThumbnails[tab.url]) { // save all tabs thumblails by url
                    allThumbnails[tab.url] = tab.thumbnail;
                }
            });
        });
    }

    let loadingRawTabs = {}; // window id : tabs that were in the loading state

    windows.forEach(function(win) {
        loadingRawTabs[win.id] = win.tabs.filter(winTab => utils.isTabVisible(winTab) && winTab.status === 'loading');
    });

    let tryCount = 0,
        tryTime = 250, // ms
        showNotificationMessageForLongTimeLoading = 90; // sec

    // waiting all tabs to load
    await new Promise(function(resolve) {
        async function checkTabs() {
            let loadingTabs = await browser.tabs.query({
                pinned: false,
                hidden: false,
                status: 'loading',
                windowType: 'normal',
            });

            if (loadingTabs.length) {
                tryCount++;

                if (Math.floor(tryCount % (1000 / tryTime * showNotificationMessageForLongTimeLoading)) === 0) {
                    utils.notify(browser.i18n.getMessage('waitingToLoadAllTabs'), undefined, 'loading-tab-message');
                }

                setTimeout(checkTabs, tryTime);
            } else {
                resolve();
            }
        }

        checkTabs();
    });

    browser.notifications.clear('loading-tab-message');

    windows = await getAllWindows();

    // update saved loading tabs
    windows.forEach(function(win) {
        if (loadingRawTabs[win.id]) {
            loadingRawTabs[win.id] = loadingRawTabs[win.id]
                .map(oldTab => win.tabs.find(t => t.id === oldTab.id))
                .filter(Boolean);
        } else {
            loadingRawTabs[win.id] = [];
        }
    });

    let containers = await utils.loadContainers(),
        syncedGroupsIds = [],
        syncedTabsIds = [];

    await Promise.all(windows.map(async function(win) {
        let group = null;

        // find group which was synced with window
        if (win.session.groupId) {
            group = data.groups.find(group => group.id === win.session.groupId);
        }

        if (!group) {
            win.session.groupId = null;
            await setWindowValue(win.id, 'groupId', null);
            return;
        }

        group.windowId = win.id;
        syncedGroupsIds.push(group.id);

        if (!group.tabs.length && !loadingRawTabs[win.id].length) {
            let tabsToHide = win.tabs.filter(utils.isTabVisible).map(utils.keyId);

            if (tabsToHide.length) {
                await createTempActiveTab(win.id, false);
                await browser.tabs.hide(tabsToHide);
            }
            return;
        }

        let tempSyncedTabIds = [];

        // синхронизируем вкладки, пытаемся найти вкладки что есть в группе чтоб не создавать заного
        group.tabs.forEach(function(groupTab) {
            win.tabs.some(function(winTab) {
                if (!tempSyncedTabIds.includes(winTab.id) && winTab.url === groupTab.url) {
                    tempSyncedTabIds.push(winTab.id);
                    groupTab.id = winTab.id;
                    return true;
                }
            });
        });

        group.tabs = group.tabs.filter(tab => tab.id || utils.isUrlAllowToCreate(tab.url)); // remove missed unsupported tabs

        await Promise.all(group.tabs.map(async function(tab, tabIndex) {
            if (tab.id) {
                let winTab = win.tabs.find(winT => winT.id === tab.id);

                if (utils.isTabHidden(winTab)) {
                    await browser.tabs.show(winTab.id);
                }

                return;
            }

            let newTab = await browser.tabs.create({
                active: Boolean(tab.active),
                url: tab.url,
                windowId: win.id,
                cookieStoreId: utils.normalizeCookieStoreId(tab.cookieStoreId, containers),
            });

            tab.id = newTab.id;
        }));

        // add loading tabs to current group
        if (loadingRawTabs[win.id].length) {
            let tabsToConcatWithGroupTabs = loadingRawTabs[win.id].filter(tab => !group.tabs.some(t => t.id === tab.id));

            if (tabsToConcatWithGroupTabs.length) {
                group.tabs = group.tabs.concat(tabsToConcatWithGroupTabs.map(mapTab));
            }

            let loadedActiveTab = tabsToConcatWithGroupTabs.find(tab => tab.active);

            if (loadedActiveTab) {
                group.tabs.forEach(tab => tab.active = tab.id === loadedActiveTab.id);
            }
        }

        let tabsIdsSortingInOrderInGroup = group.tabs.map(utils.keyId);

        syncedTabsIds = syncedTabsIds.concat(tabsIdsSortingInOrderInGroup);

        let pinnedTabs = await getPinnedTabs(win.id),
            pinnedTabsLength = pinnedTabs.length;

        await browser.tabs.move(tabsIdsSortingInOrderInGroup, {
            windowId: win.id,
            index: pinnedTabsLength,
        });

        let tabsIdsToHide = win.tabs
            .filter(winTab => utils.isTabVisible(winTab) && !tabsIdsSortingInOrderInGroup.includes(winTab.id))
            .map(utils.keyId);

        if (tabsIdsToHide.length) {
            let tmpTab = await createTempActiveTab(win.id, false);

            await browser.tabs.hide(tabsIdsToHide);

            if (tmpTab) {
                await browser.tabs.remove(tmpTab.id);
            }
        }
    }));

    // find all tabs in group and in window and sync this tabs
    data.groups
        .filter(group => !syncedGroupsIds.includes(group.id) && group.tabs.length)
        .forEach(function(group) {
            group.windowId = null;

            windows.some(function(win) {
                let tempSyncedTabIds = [];

                let isAllTabsFinded = group.tabs.every(function(groupTab) {
                    return win.tabs.some(function(winTab) {
                        if (!tempSyncedTabIds.includes(winTab.id) && !syncedTabsIds.includes(winTab.id) && winTab.url === groupTab.url) {
                            groupTab.id = winTab.id; // temporary set tab id
                            tempSyncedTabIds.push(winTab.id);
                            return true;
                        }
                    });
                });

                if (isAllTabsFinded) {
                    syncedGroupsIds.push(group.id);
                    syncedTabsIds = syncedTabsIds.concat(group.tabs.map(utils.keyId));

                    if (!win.session.groupId && isMigrateToV3) { // sync group with window if all tabs found but window was not synchronized
                        group.windowId = win.id;
                        win.session.groupId = group.id;
                        setWindowValue(win.id, 'groupId', group.id);
                    }

                    return true;
                }

                // if not found all tabs - clear tab ids
                group.tabs.forEach(tab => tab.id = null);
            });
        });

    // sync other tabs by max tab matches in window
    data.groups
        .filter(group => !syncedGroupsIds.includes(group.id) && group.tabs.length)
        .forEach(function(group) {
            group.windowId = null;

            let tabsMatches = {}, // matches: win tabs
                tempSyncedTabIds = [];

            windows.forEach(function(win) {
                let matches = group.tabs
                    .filter(function(groupTab) {
                        return win.tabs.some(function(winTab) {
                            if (!tempSyncedTabIds.includes(winTab.id) && !syncedTabsIds.includes(winTab.id) && winTab.url === groupTab.url) {
                                tempSyncedTabIds.push(winTab.id);
                                return true;
                            }
                        });
                    })
                    .length;

                if (!tabsMatches[matches]) {
                    tabsMatches[matches] = win.tabs;
                }
            });

            let maxMatches = Math.max.apply(Math, Object.keys(tabsMatches));

            if (maxMatches) {
                group.tabs.forEach(function(groupTab) {
                    let winTab = tabsMatches[maxMatches].find(winTab => !syncedTabsIds.includes(winTab.id) && winTab.url === groupTab.url);

                    if (winTab) {
                        groupTab.id = winTab.id;
                        syncedTabsIds.push(winTab.id);
                    }
                });
            }
        });

    _groups = data.groups;

    await storage.set(data);

    updateBrowserActionData();
    createMoveTabMenus();

    browser.browserAction.enable();

    addEvents();

    window.background.inited = true;
}

browser.browserAction.setTitle({
    title: browser.i18n.getMessage('waitingToLoadAllTabs'),
});
browser.browserAction.disable();

setLoadingToBrowserAction();

init()
    .then(function() {
        // send message for addon plugins
        Object.keys(constants.EXTENSIONS_WHITE_LIST)
            .forEach(function(exId) {
                browser.runtime.sendMessage(exId, {
                    IAmBack: true,
                });
            });
    })
    .catch(utils.notify);
