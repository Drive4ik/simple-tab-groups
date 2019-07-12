'use strict';

import constants from './js/constants';
import containers from './js/containers';
import utils from './js/utils';
import storage from './js/storage';
import file from './js/file';
import cache from './js/cache';

let options = {},
    _groups = [],
    _thumbnails = {},
    reCreateTabsOnRemoveWindow = [],
    menuIds = [],

    manifest = browser.runtime.getManifest(),
    manageTabsPageUrl = browser.extension.getURL(constants.MANAGE_TABS_URL),
    noop = function() {};

window.addEventListener('error', utils.errorEventHandler);
// throw Error(utils.errorEventMessage('some data message'));

let _saveGroupsToStorageTimer = 0;
async function saveGroupsToStorage(withMessage = false) {
    if (withMessage) {
        sendMessage({
            action: 'groups-updated',
        });
    }

    if (_saveGroupsToStorageTimer) {
        clearTimeout(_saveGroupsToStorageTimer);
    }

    _saveGroupsToStorageTimer = setTimeout(function() {
        storage.set({
            groups: _groups,
        });
    }, 500);
}

async function getWindow(windowId = browser.windows.WINDOW_ID_CURRENT) {
    let win = await browser.windows.get(windowId);
    return cache.loadWindowSession(win);
}

async function createWindow(createData = {}, groupId, activeTabId) {
    if (groupId) {
        browser.windows.onCreated.removeListener(onCreatedWindow);
    }

    let win = await browser.windows.create(createData);

    if (groupId) {
        browser.windows.onCreated.addListener(onCreatedWindow);
    }

    if (utils.isWindowAllow(win)) {
        win = await cache.loadWindowSession(win);
    }

    if (groupId) {
        await loadGroup(win.id, groupId, activeTabId);
    }

    return win;
}

function setFocusOnWindow(windowId) {
    return browser.windows.update(windowId, {
        focused: true,
    });
}

async function setTabActive(tabId, tabs) {
    let tabToActive = null;

    if (tabId) {
        tabToActive = Array.isArray(tabs) ? tabs.find(tab => tab.id === tabId) : {
            id: tabId,
        };
    } else if (Array.isArray(tabs)) { // find lastAccessed tab
        let lastAccessedTimes = tabs.map(tab => tab.lastAccessed),
            maxLastAccessed = lastAccessedTimes.length ? Math.max(...lastAccessedTimes) : null;

        tabToActive = maxLastAccessed ? tabs.find(tab => tab.lastAccessed === maxLastAccessed) : null;
    }

    if (tabToActive) {
        Array.isArray(tabs) && tabs.forEach(tab => tab.active = tab.id === tabToActive.id);

        await browser.tabs.update(tabToActive.id, {
            active: true,
        });
    }

    return tabToActive;
}

// function _fixTabUrl(tab) {
//     if (!tab.url || utils.isUrlEmpty(tab.url)) {
//         tab.url = 'about:blank';
//     }

//     return tab;
// }

async function createTabsSafe(tabs, hideTab, groupId, withRemoveEvents = true) {
    if (withRemoveEvents) {
        removeEvents();
    }

    let result = await Promise.all(tabs.map(function(tab) {
        if (groupId) {
            tab.groupId = groupId;
        }

        return createTab(tab, hideTab);
    }));

    if (withRemoveEvents) {
        addEvents();
    }

    return result;
}

const newTabKeys = ['active', 'cookieStoreId', 'index', 'discarded', 'title', 'openInReaderMode', 'pinned', 'url', 'windowId'];

async function createTab(tab, hideTab = false) {
    console.log('create' + (hideTab ? ' hidden ' : ' ') + 'tab', utils.clone(tab));

    let groupId = tab.groupId;

    if (!tab.url || !utils.isUrlAllowToCreate(tab.url)) {
        delete tab.url;
    }

    if (!tab.active || hideTab) {
        tab.active = false;
    }

    if (!tab.active && tab.url && !utils.isUrlEmpty(tab.url)) {
        tab.discarded = true;
    }

    if (tab.active || !tab.discarded) {
        delete tab.title;
    }

    if (!Number.isFinite(tab.index) || 0 > tab.index) {
        delete tab.index;
    }

    if (!Number.isFinite(tab.windowId) || 1 > tab.windowId || !cache.getWindow(tab.windowId)) {
        delete tab.windowId;
    }

    if ('cookieStoreId' in tab) {
        tab.cookieStoreId = containers.get(tab.cookieStoreId, 'cookieStoreId');
    }

    if (tab.isInReaderMode) {
        tab.openInReaderMode = true;
    }

    Object.keys(tab).forEach(key => !newTabKeys.includes(key) && (delete tab[key]));

    let newTab = await browser.tabs.create(tab);

    cache.setTab(newTab);

    newTab = await cache.loadTabSession(newTab);

    if (!newTab.pinned) {
        if (hideTab) {
            await browser.tabs.hide(newTab.id);
            newTab.hidden = true;
        }

        if (groupId && groupId !== newTab.session.groupId) {
            cache.setTabGroup(newTab.id, groupId);
        }

        if (newTab.session.groupId) {
            sendMessage({
                action: 'tab-added',
                tab: newTab,
            });
        }
    }

    return newTab;
}

async function getActiveTab(windowId = browser.windows.WINDOW_ID_CURRENT) {
    let [activeTab] = await browser.tabs.query({
        active: true,
        windowId: windowId,
    });

    return activeTab;
}

async function getHighlightedTabs(windowId = browser.windows.WINDOW_ID_CURRENT, clickedTab = null) {
    if (clickedTab && utils.isTabPinned(clickedTab)) {
        return [];
    }

    let tabs = await browser.tabs.query({
        pinned: false,
        hidden: false,
        highlighted: true,
        windowId: windowId,
    });

    if (clickedTab) {
        if (!tabs.some(tab => tab.id === clickedTab.id)) { // if clicked tab not in selected tabs - add it
            tabs.push(clickedTab);

            if (2 === tabs.length) {
                tabs = tabs.filter(tab => tab.active ? (tab.id === clickedTab.id) : true); // exclude active tab if need to move another tab
            }
        }
    }

    return tabs.map(function(tab) {
        return {
            tabId: tab.id,
        };
    });
}

async function getTabs(windowId = browser.windows.WINDOW_ID_CURRENT, pinned = false, hidden = false) {
    let query = {
        windowId,
        pinned,
        hidden,
    };

    if (null === pinned) {
        delete query.pinned;
    }

    if (null === hidden) {
        delete query.hidden;
    }

    let tabs = await browser.tabs.query(query);

    return pinned ? tabs : Promise.all(tabs.map(cache.loadTabSession));
}

function mapTab(tab) {
    // tab = _fixTabUrl(tab);

    return {
        id: tab.id || null,
        title: tab.title || tab.url,
        url: tab.url,
        active: Boolean(tab.active),
        favIconUrl: tab.favIconUrl || '',
        cookieStoreId: tab.cookieStoreId || constants.DEFAULT_COOKIE_STORE_ID,
    };
}

function getTabFavIconUrl(tab) {
    let safedFavIconUrl = '';

    if (options.useTabsFavIconsFromGoogleS2Converter) {
        safedFavIconUrl = utils.getFavIconFromUrl(tab.url);
    }

    return safedFavIconUrl || tab.favIconUrl || '/icons/tab.svg';
}

function createGroup(id, title) {
    return {
        id: id,
        title: utils.createGroupTitle(title, id),
        iconColor: options.defaultGroupIconColor || utils.randomColor(),
        iconUrl: null,
        iconViewType: options.defaultGroupIconViewType,
        tabs: [],
        catchTabRules: '',
        catchTabContainers: [],
        isSticky: false,
        muteTabsWhenGroupCloseAndRestoreWhenOpen: false,
        showTabAfterMovingItIntoThisGroup: false,
        // windowId: windowId || null,
    };
}

async function addGroup(windowId, withTabs = [], title) {
    let { lastCreatedGroupPosition } = await storage.get('lastCreatedGroupPosition');

    withTabs = utils.clone(withTabs); // clone need for fix bug: dead object after close tab which create object

    lastCreatedGroupPosition++;

    let newGroup = createGroup(lastCreatedGroupPosition, title);

    _groups.push(newGroup);

    if (!withTabs.length && (1 === _groups.length || windowId)) {
        if (!windowId) {
            let win = await getWindow();
            windowId = win.id;
        }

        withTabs = await getTabs(windowId);
    }

    if (withTabs.length) {
        await createTabsSafe(withTabs, !windowId, newGroup.id);
    }

    if (windowId) {
        await cache.setWindowGroup(windowId, newGroup.id);
        updateBrowserActionData(newGroup.id);
    }

    await storage.set({
        lastCreatedGroupPosition,
    });

    sendMessage({
        action: 'group-added',
        group: newGroup,
    });

    sendExternalMessage({
        action: 'group-added',
        group: mapGroupForExternalExtension(newGroup),
    });

    updateMoveTabMenus(windowId);

    saveGroupsToStorage();

    return newGroup;
}

async function updateGroup(groupId, updateData) {
    let group = _groups.find(gr => gr.id === groupId);

    updateData = utils.clone(updateData); // clone need for fix bug: dead object after close tab which create object

    Object.assign(group, updateData);

    sendMessage({
        action: 'group-updated',
        group: {
            id: groupId,
            ...updateData,
        },
    });

    sendExternalMessage({
        action: 'group-updated',
        group: mapGroupForExternalExtension(group),
    });

    saveGroupsToStorage();

    if (['title', 'iconUrl', 'iconColor', 'iconViewType'].some(key => key in updateData)) {
        updateMoveTabMenus();
    }

    updateBrowserActionData(groupId);
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

const CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP = 'stg-undo-remove-group-id-';

async function addUndoRemoveGroupItem(group) {
    let restoreGroup = function(group) {
        browser.menus.remove(CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP + group.id);

        // group.windowId = null;
        group.tabs.forEach(tab => delete tab.id);

        _groups.push(group); // TODO

        updateMoveTabMenus();

        saveGroupsToStorage(true);
    }.bind(null, group);

    browser.menus.create({
        id: CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP + group.id,
        title: browser.i18n.getMessage('undoRemoveGroupItemTitle', group.title),
        contexts: ['browser_action'],
        icons: {
            16: utils.getGroupIconUrl(group),
        },
        onclick: restoreGroup,
    });

    utils.notify(browser.i18n.getMessage('undoRemoveGroupNotification', group.title)).then(restoreGroup);
}

async function createTempActiveTab(windowId, createPinnedTab = true, canUseExistsEmptyTab) {
    let pinnedTabs = cache.getPinnedTabs(windowId);

    if (pinnedTabs.length) {
        if (!pinnedTabs.some(tab => tab.active)) {
            await setTabActive(pinnedTabs.sort(utils.sortBy('lastAccessed')).pop().id);
        }
    } else {
        if (canUseExistsEmptyTab) {
            let tabs = await getTabs(windowId);

            if (1 === tabs.length && utils.isUrlEmpty(tabs[0].url)) {
                return tabs[0];
            }
        }

        return createTab({
            url: 'about:blank',
            pinned: createPinnedTab,
            active: true,
            windowId: windowId,
        });
    }
}

async function removeGroup(groupId) {
    let groupIndex = _groups.findIndex(gr => gr.id === groupId),
        // group = _groups[groupIndex],
        groupWindowId = cache.getWindowId(groupId);

    let groups = await loadAllGroups(),
        group = groups.find(gr => gr.id === groupId);

    _groups.splice(groupIndex, 1);

    addUndoRemoveGroupItem(group);

    saveGroupsToStorage();

    if (groupWindowId) {
        setBrowserAction(groupWindowId, 'loading');
        await cache.removeWindowGroup(groupWindowId);
    }

    let tabsIdsToRemove = group.tabs.filter(utils.keyId).map(utils.keyId);

    if (tabsIdsToRemove.length) {
        if (groupWindowId && cache.getWindowsCount() === 1) {
            await createTempActiveTab(groupWindowId, false);
        }

        await browser.tabs.remove(tabsIdsToRemove);
    }

    updateMoveTabMenus();

    updateBrowserActionData(groupId);

    sendMessage({
        action: 'group-removed',
        groupId: groupId,
    });

    sendExternalMessage({
        action: 'group-removed',
        groupId: groupId,
    });
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

let _savingTabsInWindow = {};
async function saveCurrentTabs(windowId) {
    if (!windowId || _savingTabsInWindow[windowId]) {
        return;
    }

    let group = _groups.find(gr => gr.windowId === windowId);

    if (!group) {
        return;
    }

    _savingTabsInWindow[windowId] = true;

    if (arguments[1]) {
        console.info('saveCurrentTabs called from', arguments[1]);
    }

    let winTabs = await getTabs(windowId);

    console.info('saving tabs ', { windowId, calledFuncStringName: arguments[1] }, utils.clone(winTabs));

    let tabIdsInOtherGroups = _groups
        .filter(gr => gr.id !== group.id)
        .reduce((ids, gr) => ids.concat(gr.tabs.filter(utils.keyId).map(utils.keyId)), []);

    group.tabs = winTabs
        .filter(winTab => !tabIdsInOtherGroups.includes(winTab.id))
        .map(function(winTab) {
            if (browser.tabs.TabStatus.LOADING === winTab.status && utils.isUrlEmpty(winTab.url)) {
                let tab = group.tabs.find(t => t.id === winTab.id);

                if (tab) {
                    tab.active = winTab.active;
                    return tab;
                }
            }

            if (!winTab.favIconUrl) {
                let tab = group.tabs.find(tab => winTab.url === tab.url && tab.favIconUrl);

                if (tab) {
                    winTab.favIconUrl = tab.favIconUrl;
                }
            }

            // return mapTab(winTab);
            return winTab;
        });

    sendMessage({
        action: 'group-updated',
        group: {
            id: group.id,
            tabs: group.tabs,
        },
    });

    saveGroupsToStorage();

    delete _savingTabsInWindow[windowId];
}

async function addTab(groupId, cookieStoreId, url, title, active = false) {
    let windowId = cache.getWindowId(groupId);

    return createTabsSafe([{
        url,
        title,
        active,
        cookieStoreId,
        groupId,
        windowId,
    }], !windowId);
}

async function removeTab(tab) {
    if (!tab.hidden) {
        let windowId = cache.getWindowId(tab.session.groupId);

        if (windowId && 1 === cache.getTabs(tab.session.groupId).length) {
            // let pinnedTabs = await getTabs(groupWindowId, true);
            let pinnedTabs = cache.getPinnedTabs(windowId);

            if (!pinnedTabs.length) {
                await createTab({
                    active: true,
                    windowId: windowId,
                });
            }
        }
    }

    await browser.tabs.remove(tab.id);
}

function setMuteTabs(tabs, muted) {
    tabs
        .filter(tab => muted ? tab.audible : tab.mutedInfo.muted)
        .forEach(tab => browser.tabs.update(tab.id, {muted}));
}

let _loadingGroupInWindow = {}; // windowId: true;
async function loadGroup(windowId, groupId, activeTabId) {
    if (!windowId) { // load group into last focused window
        windowId = await getLastFocusedNormalWindowId();

        if (!windowId) {
            throw Error('loadGroup: not found normal window');
        }
    }

    if (_loadingGroupInWindow[windowId]) {
        return false;
    }

    console.log('loadGroup args groupId: %s, windowId: %s, activeTab: %s', groupId, windowId, activeTabId);

    let groupToShow = _groups.find(gr => gr.id === groupId);

    if (!groupToShow) {
        throw Error(utils.errorEventMessage('loadGroup: groupToShow not found', {groupId, activeTabId}));
    }

    _loadingGroupInWindow[windowId] = true;

    let groupWindowId = cache.getWindowId(groupId);

    console.time('load-group-' + groupId);

    try {
        if (groupWindowId) {
            if (activeTabId) {
                setTabActive(activeTabId);
            }

            setFocusOnWindow(groupWindowId);
        } else {
            // magic

            let groups = await loadAllGroups(),
                {groupId: oldGroupId} = cache.getWindowSession(windowId),
                groupToHide = groups.find(gr => gr.id === oldGroupId);

            groupToShow = groups.find(gr => gr.id === groupId);

            if (groupToHide && groupToHide.tabs.some(utils.isTabCanNotBeHidden)) {
                throw browser.i18n.getMessage('notPossibleSwitchGroupBecauseSomeTabShareMicrophoneOrCamera');
            }

            setBrowserAction(windowId, 'loading');

            removeEvents();

            // let tempEmptyTab = await createTempActiveTab(windowId); // create empty tab (for quickly change group and not blinking)

            // show tabs
            if (groupToShow.tabs.length) {
                // groupToShow.tabs = groupToShow.tabs.filter(tab => tab.id || utils.isUrlAllowToCreate(tab.url)); // remove unsupported tabs

                let showTabIds = groupToShow.tabs.map(utils.keyId);

                if (groupToShow.tabs[0].windowId !== windowId) {
                    await browser.tabs.move(showTabIds, {
                        index: -1,
                        windowId: windowId,
                    });
                }

                await browser.tabs.show(showTabIds);

                if (groupToShow.muteTabsWhenGroupCloseAndRestoreWhenOpen) {
                    setMuteTabs(groupToShow.tabs, false);
                }

                // set active tab
                await setTabActive(activeTabId, groupToShow.tabs);
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

                if (groupToHide.muteTabsWhenGroupCloseAndRestoreWhenOpen) {
                    setMuteTabs(groupToHide.tabs, true);
                }

                if (!groupToShow.tabs.length) {
                    let tempEmptyTab = await createTempActiveTab(windowId);
                    if (tempEmptyTab) {
                        tabsIdsToRemove.push(tempEmptyTab.id);
                    }
                }

                let tabIdsToHide = groupToHide.tabs.map(utils.keyId);

                await browser.tabs.hide(tabIdsToHide);

                if (tabsIdsToRemove.length) {
                    browser.tabs.remove(tabsIdsToRemove);
                }

                if (options.discardTabsAfterHide) {
                    browser.tabs.discard(tabIdsToHide);
                }
            }

            cache.setWindowGroup(windowId, groupToShow.id);

            // set group id for tabs which may has opened without groupId (new window without group)
            getTabs(windowId)
                .then(function(tabs) {
                    let hasNewTabs = false;

                    tabs.forEach(function(tab) {
                        if (tab.session.groupId !== groupToShow.id) {
                            hasNewTabs = true;
                            cache.setTabGroup(tab.id, groupToShow.id);
                        }
                    })

                    return [hasNewTabs, tabs];
                })
                .then(function([hasNewTabs, tabs]) {
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

            sendMessage({
                action: 'group-updated',
                group: groupToShow,
            });

            // await saveCurrentTabs(windowId, 'loadGroup');

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

async function updateTabThumbnail(tab, force = false) {
    if (!utils.isTabLoaded(tab)) {
        return;
    }

    let hasThumbnailsPermission = await browser.permissions.contains(constants.PERMISSIONS.ALL_URLS);

    if (!hasThumbnailsPermission) {
        return;
    }

    let tabUrl = utils.makeSafeUrlForThumbnail(tab.url);

    if (!force && _thumbnails[tabUrl]) {
        return;
    }

    // let rawTab = await browser.tabs.get(tab.id);

    if (tab.discarded) {
        browser.tabs.reload(tab.id);
        return;
    }

    let thumbnail = null;

    try {
        let thumbnailBase64 = await browser.tabs.captureTab(tab.id);

        thumbnail = await new Promise(function(resolve, reject) {
            let img = new Image();

            img.onload = function() {
                resolve(utils.resizeImage(img, 192, Math.floor(img.width * 192 / img.height), false));
            };

            img.onerror = reject;

            img.src = thumbnailBase64;
        });
    } catch (e) {

    }

    if (thumbnail) {
        _thumbnails[tabUrl] = thumbnail;
    } else {
        delete _thumbnails[tabUrl];
    }

    sendMessage({
        action: 'thumbnail-updated',
        url: tabUrl,
        thumbnail: thumbnail,
    });

    await storage.set({
        thumbnails: _thumbnails,
    });
}

async function onActivatedTab({ previousTabId, tabId, windowId }) {
    console.log('onActivatedTab', { previousTabId, tabId, windowId });

    // if (isMovingTabs) {
    //     return;
    // }

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

    updateTabThumbnail(activeTab);
}

function _isCatchedUrl(url, group) {
    if (!group.catchTabRules) {
        return false;
    }

    return group.catchTabRules
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

function _getCatchedGroupForTab(tab, checkTabAsNew = false) {
    return _groups.find(function(group) {
        if (group.catchTabContainers.includes(tab.cookieStoreId)) {
            return true;
        }

        if (_isCatchedUrl(tab.url, group)) {
            return true;
        }

        if (checkTabAsNew && 'about:blank' === tab.url && utils.isTabLoaded(tab) && _isCatchedUrl(tab.title, group)) {
            return true;
        }
    });
}

async function onCreatedTab(tab) {
    console.log('onCreatedTab', tab);

    // if (isMovingTabs) {
    //     return;
    // }

    cache.setTab(tab, true);

    if (utils.isTabPinned(tab)) {
        return;
    }

    // tab = await cache.loadTabSession(tab);

    let {groupId} = cache.getWindowSession(tab.windowId),
        group = _groups.find(gr => gr.id === groupId);

    if (!group) {
        console.warn('tab created without group');
        return;
    }

    console.debug('created tab group id', group.id);

    if (!group.isSticky) {
        let destGroup = _getCatchedGroupForTab(tab, true);

        if (destGroup && destGroup.id !== group.id) {
            // group.tabs.push(mapTab(tab));
            group.tabs.push(tab);

            moveTabs([{
                    tabId: tab.id,
                }], {
                    groupId: destGroup.id,
                },
                undefined,
                destGroup.showTabAfterMovingItIntoThisGroup
            )
            .catch(utils.notify);
            return;
        }
    }

    // if (isMovingTabs) {
    //     return;
    // }

    // group.tabs.push(mapTab(tab));

    cache.setTabGroup(tab.id, group.id);

    sendMessage({
        action: 'tab-added',
        tab: tab,
    });

    // saveCurrentTabs(group.windowId, 'onCreatedTab');
}

async function onUpdatedTab(tabId, changeInfo, tab) {
    console.log('onUpdatedTab', {isMovingTabs, isTabIncognito: utils.isTabIncognito(tab), changeInfo, tab})

    if (isMovingTabs || utils.isTabIncognito(tab) || 'isArticle' in changeInfo || 'attention' in changeInfo) {
        return;
    }

    tab = cache.updateTab(tabId, changeInfo);

    if (utils.isTabPinned(tab) && undefined === changeInfo.pinned) {
        return;
    }

    let {groupId} = cache.getWindowSession(tab.windowId),
        group = groupId ? _groups.find(gr => gr.id === groupId) : null;

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
                    loadGroup(tab.windowId, tab.session.groupId, tabId);
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

    if (!group.isSticky) {
        let destGroup = _getCatchedGroupForTab(tab);

        if (destGroup && destGroup.id !== group.id) {
            // Object.assign(tab, mapTab(tab));

            moveTabs([{
                    tabId: tab.id,
                }], {
                    groupId: destGroup.id,
                },
                undefined,
                destGroup.showTabAfterMovingItIntoThisGroup
            )
            .catch(utils.notify);
            return;
        }
    }

    // if (utils.isTabLoaded(tab)) {
        // Object.assign(tab, mapTab(rawTab));

        // sendMessage({
        //     action: 'group-updated',
        //     group: {
        //         id: group.id,
        //         tabs: group.tabs,
        //     },
        // });

        // saveGroupsToStorage();

        updateTabThumbnail(tab);
    // }
}

function onRemovedTab(tabId, { isWindowClosing, windowId }) {
    console.log('onRemovedTab', {tabId, isWindowClosing, windowId});

    let tab = cache.getTab(tabId);

    if (!tab) {
        return;
    }

    cache.removeTab(tabId);

    if (isWindowClosing && !utils.isUrlEmpty(tab.url) && tab.session.groupId) {
        let group = _groups.find(gr => gr.id === tab.session.groupId);

        if (group) {
            delete tab.index;

            tab.groupId = group.id;

            if (!reCreateTabsOnRemoveWindow.length) {
                cache.getWindows().forEach(win => win.id === windowId ? null : setBrowserAction(win.id, 'loading', undefined, false));
            }

            reCreateTabsOnRemoveWindow.push(tab);
        }
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

    // if (isMovingTabs) {
    //     return;
    // }

    // saveCurrentTabs(windowId, 'onMovedTab');
}

function onAttachedTab(tabId, { newWindowId, newPosition }) {
    console.log('onAttachedTab', { tabId, newWindowId, newPosition });

    cache.updateTab(tabId, {
        index: newPosition,
        windowId: newWindowId,
    });

    let {groupId} = cache.getWindowSession(newWindowId);

    cache.setTabGroup(tabId, groupId);

    // if (isMovingTabs) {
    //     return;
    // }

    // saveCurrentTabs(newWindowId, 'onAttachedTab');
}

function onDetachedTab(tabId, { oldWindowId }) { // notice: call before onAttached
    console.log('onDetachedTab', { tabId, oldWindowId });

    /*if (isMovingTabs) {
        return;
    }

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

    saveGroupsToStorage();*/
}

async function onCreatedWindow(win) {
    console.log('onCreatedWindow', win);

    if (utils.isWindowAllow(win)) {
        await cache.loadWindowSession(win);
        getTabs(win.id, null, null);

        if (!win.session.groupId && options.createNewGroupWhenOpenNewWindow) {
            addGroup(win.id);
        }
    }
}

let _lastFocusedWinId = null;

async function onFocusChangedWindow(windowId) {
    console.log('onFocusChangedWindow', windowId);

    if (browser.windows.WINDOW_ID_NONE === windowId) {
        return;
    }

    let win = await getWindow(windowId);

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
        cache.getWindows().forEach(win => updateBrowserActionData(null, win.id));
        reCreateTabsOnRemoveWindow = [];
    }
}

// async function onSessionChanged() {
//     console.debug('onSessionChanged');

//     let windows = await browser.windows.getAll({
//             windowTypes: [browser.windows.WindowType.NORMAL],
//         }),
//         cachedWindows = cache.getWindows();

//     windows = windows.filter(utils.isWindowAllow);

//     if (windows.length > cachedWindows.length) {
//         let newWin = windows.find(win => !cachedWindows.some(w => w.id === win.id));

//         await onCreatedWindow(newWin);

//         updateBrowserActionData(undefined, newWin.id);
//     }
// }

async function getLastFocusedNormalWindowId() {
    let lastFocusedWindow = await browser.windows.getLastFocused();

    if (utils.isWindowAllow(lastFocusedWindow)) {
        return lastFocusedWindow.id;
    }

    // hard way (((
    let windows = await browser.windows.getAll({
            windowTypes: [browser.windows.WindowType.NORMAL],
        }),
        filteredWindows = windows.filter(utils.isWindowAllow).sort(utils.sortBy('id')),
        win = filteredWindows.find(win => win.focused) || filteredWindows.pop();

    return win ? win.id : null;
}

let isMovingTabs = false;

async function moveTabs(tabs, groupId, newTabIndex = -1, showNotificationAfterMoveTab = true, showTabAfterMoving = false) {
    // tabs = utils.clone(tabs);

    console.info('moveTabs', {groupId, newTabIndex, showNotificationAfterMoveTab, showTabAfterMoving});
    console.info('moveTabs tabs 0', tabs[0]);

    if (!tabs.length) {
        throw TypeError('moveTabs type error: tabs is');
    }

    let showPinnedMessage = false,
        tabsCantHide = [],
        groupWindowId = cache.getWindowId(groupId),
        windowId = groupWindowId,
        group = _groups.find(gr => gr.id === groupId);

    if (!windowId) {
        let groupTabs = cache.getTabs(groupId);

        windowId = (groupTabs[0] && groupTabs[0].windowId) || await getLastFocusedNormalWindowId();
    }

    tabs = tabs.filter(function(tab) {
        if (tab.pinned) {
            showPinnedMessage = true;
            return false;
        }

        if (utils.isTabCanNotBeHidden(tab)) {
            let tabTitle = utils.sliceText(utils.getTabTitle(tab), 20);

            if (!tabsCantHide.includes(tabTitle)) {
                tabsCantHide.push(tabTitle);
            }

            return false;
        }

        return true;
    });

    if (tabs.length) {
        let tabIds = tabs.map(utils.keyId);

        await Promise.all(tabIds.map(tabId => cache.setTabGroup(tabId, groupId)));

        await browser.tabs.move(tabIds, {
            index: newTabIndex,
            windowId,
        });

        await browser.tabs.show(tabIds);
    }

    // sendMessage({
    //     action: 'groups-updated',
    // });

    if (showPinnedMessage) {
        utils.notify(browser.i18n.getMessage('pinnedTabsAreNotSupported'));
    }

    if (tabsCantHide.length) {
        utils.notify(browser.i18n.getMessage('thisTabsCanNotBeHidden', tabsCantHide.join(', ')));
    }

    if (showTabAfterMoving) {
        await loadGroup(windowId, groupId, tabs[0].id);

        return;
    }

    if (!showNotificationAfterMoveTab || !options.showNotificationAfterMoveTab) {
        return;
    }

    let message = '';

    if (tabs.length > 1) {
        message = browser.i18n.getMessage('moveMultipleTabsToGroupMessage', tabs.length);
    } else {
        let tabTitle = utils.sliceText(utils.getTabTitle(tabs[0]), 50);
        message = browser.i18n.getMessage('moveTabToGroupMessage', [group.title, tabTitle]);
    }

    utils.notify(message)
        .then(async function(groupId, tabId) {
            let group = _groups.find(gr => gr.id === groupId),
                tab = await browser.tabs.get(tabId).catch(noop);

            if (group && tab) {
                let winId = cache.getWindowId(groupId) || await getLastFocusedNormalWindowId();

                loadGroup(winId, groupId, tabId);
            }
        }.bind(null, groupId, tabs[0].id));
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
    if (!windowId) {
        windowId = await getLastFocusedNormalWindowId();

        if (!windowId) {
            removeMoveTabMenus();
            return;
        }
    }

    let hasBookmarksPermission = await browser.permissions.contains(constants.PERMISSIONS.BOOKMARKS);

    if (!options.showContextMenuOnTabs && !options.showContextMenuOnLinks && !hasBookmarksPermission) {
        return;
    }

    let {groupId} = cache.getWindowSession(windowId),
        currentGroup = _groups.find(gr => gr.id === groupId);

    hasBookmarksPermission && menuIds.push(browser.menus.create({
        id: 'stg-open-bookmark-in-group-parent',
        title: browser.i18n.getMessage('openBookmarkInGroup'),
        contexts: ['bookmark'],
    }));

    options.showContextMenuOnTabs && menuIds.push(browser.menus.create({
        id: 'stg-move-tab-parent',
        title: browser.i18n.getMessage('moveTabToGroupDisabledTitle'),
        contexts: ['tab'],
    }));

    options.showContextMenuOnLinks && menuIds.push(browser.menus.create({
        id: 'stg-open-link-parent',
        title: browser.i18n.getMessage('openLinkInGroupDisabledTitle'),
        contexts: ['link'],
    }));

    _groups.forEach(function(group) {
        let groupIconUrl = utils.getGroupIconUrl(group),
            groupTitle = (cache.getWindowId(group.id) ? '• ' : '') + group.title;

        options.showContextMenuOnTabs && menuIds.push(browser.menus.create({
            title: groupTitle,
            enabled: currentGroup ? group.id !== currentGroup.id : true,
            icons: {
                16: groupIconUrl,
            },
            parentId: 'stg-move-tab-parent',
            contexts: ['tab'],
            onclick: async function(info, tab) {
                let setActive = 2 === info.button,
                    tabsToMove = await getHighlightedTabs(tab.windowId, tab);

                if (!tabsToMove.length) {
                    utils.notify(browser.i18n.getMessage('pinnedTabsAreNotSupported'));
                    return;
                }

                moveTabs(tabsToMove, {
                        groupId: group.id,
                    }, !setActive, setActive)
                    .catch(utils.notify);
            },
        }));

        options.showContextMenuOnLinks && menuIds.push(browser.menus.create({
            title: groupTitle,
            icons: {
                16: groupIconUrl,
            },
            parentId: 'stg-open-link-parent',
            contexts: ['link'],
            onclick: async function(info) {
                if (!utils.isUrlAllowToCreate(info.linkUrl)) {
                    return;
                }

                let setActive = 2 === info.button;

                await addTab(group.id, undefined, info.linkUrl, info.linkText, setActive);

                if (setActive) {
                    let groupWindowId = cache.getWindowId(group.id);

                    if (groupWindowId) {
                        setFocusOnWindow(groupWindowId);
                    } else {
                        loadGroup(null, group.id);
                    }
                }
            },
        }));

        hasBookmarksPermission && menuIds.push(browser.menus.create({
            title: groupTitle,
            icons: {
                16: groupIconUrl,
            },
            parentId: 'stg-open-bookmark-in-group-parent',
            contexts: ['bookmark'],
            onclick: async function(info) {
                if (!info.bookmarkId) {
                    utils.notify(browser.i18n.getMessage('bookmarkNotAllowed'));
                    return;
                }

                let [bookmark] = await browser.bookmarks.get(info.bookmarkId);

                if (bookmark.type !== 'bookmark' || !bookmark.url || !utils.isUrlAllowToCreate(bookmark.url)) {
                    utils.notify(browser.i18n.getMessage('bookmarkNotAllowed'));
                    return;
                }

                let setActive = 2 === info.button;

                await addTab(group.id, undefined, bookmark.url, bookmark.title, setActive);

                if (setActive) {
                    let groupWindowId = cache.getWindowId(group.id);

                    if (groupWindowId) {
                        setFocusOnWindow(groupWindowId);
                    } else {
                        loadGroup(null, group.id);
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
        contexts: ['tab'],
        onclick: async function(info, tab) {
            let tabsToMove = await getHighlightedTabs(tab.windowId, tab);

            if (!tabsToMove.length) {
                utils.notify(browser.i18n.getMessage('pinnedTabsAreNotSupported'));
                return;
            }

            let newGroup = await addGroup();

            if (1 === _groups.length) { // new group already contains this tab
                return;
            }

            moveTabs(tabsToMove, {
                    groupId: newGroup.id,
                })
                .catch(utils.notify);
        },
    }));

    options.showContextMenuOnTabs && menuIds.push(browser.menus.create({
        type: 'separator',
        parentId: 'stg-move-tab-parent',
        contexts: ['tab'],
    }));

    options.showContextMenuOnTabs && menuIds.push(browser.menus.create({
        title: browser.i18n.getMessage('setTabIconAsGroupIcon'),
        enabled: Boolean(currentGroup),
        icons: {
            16: '/icons/image.svg',
        },
        parentId: 'stg-move-tab-parent',
        contexts: ['tab'],
        onclick: function(info, tab) {
            let {groupId} = cache.getWindowSession(tab.windowId),
                group = _groups.find(gr => gr.id === groupId);

            if (!group) {
                return;
            }

            group.iconUrl = getTabFavIconUrl(tab);

            updateMoveTabMenus(tab.windowId);
            updateBrowserActionData(group.id);

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

    options.showContextMenuOnLinks && menuIds.push(browser.menus.create({
        title: browser.i18n.getMessage('createNewGroup'),
        icons: {
            16: '/icons/group-new.svg',
        },
        parentId: 'stg-open-link-parent',
        contexts: ['link'],
        onclick: async function(info) {
            if (!utils.isUrlAllowToCreate(info.linkUrl)) {
                return;
            }

            let setActive = 2 === info.button,
                newGroup = await addGroup();

            await addTab(newGroup.id, undefined, info.linkUrl, info.linkText, setActive);

            if (setActive && !newGroup.windowId) { // TODO
                loadGroup(null, newGroup.id);
            }
        },
    }));

    hasBookmarksPermission && menuIds.push(browser.menus.create({
        title: browser.i18n.getMessage('createNewGroup'),
        icons: {
            16: '/icons/group-new.svg',
        },
        parentId: 'stg-open-bookmark-in-group-parent',
        contexts: ['bookmark'],
        onclick: async function(info) {
            if (!info.bookmarkId) {
                utils.notify(browser.i18n.getMessage('bookmarkNotAllowed'));
                return;
            }

            let [bookmark] = await browser.bookmarks.get(info.bookmarkId);

            if (bookmark.type !== 'bookmark' || !bookmark.url || !utils.isUrlAllowToCreate(bookmark.url)) {
                utils.notify(browser.i18n.getMessage('bookmarkNotAllowed'));
                return;
            }

            let setActive = 2 === info.button,
                newGroup = await addGroup();

            await addTab(newGroup.id, undefined, bookmark.url, bookmark.title, setActive);

            if (setActive && !newGroup.windowId) { // TODO
                loadGroup(null, newGroup.id);
            }
        },
    }));

    hasBookmarksPermission && menuIds.push(browser.menus.create({
        type: 'separator',
        parentId: 'stg-open-bookmark-in-group-parent',
        contexts: ['bookmark'],
    }));

    hasBookmarksPermission && menuIds.push(browser.menus.create({
        title: browser.i18n.getMessage('importBookmarkFolderAsNewGroup'),
        icons: {
            16: '/icons/bookmark-o.svg',
        },
        parentId: 'stg-open-bookmark-in-group-parent',
        contexts: ['bookmark'],
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
                let bookmarksToAdd = [];

                for (let bookmark of folder.children) {
                    if (bookmark.type === 'folder') {
                        await addBookmarkFolderAsGroup(bookmark);
                    } else if (bookmark.type === 'bookmark' && bookmark.url && utils.isUrlAllowToCreate(bookmark.url) && !utils.isUrlEmpty(bookmark.url)) {
                        bookmarksToAdd.push({
                            title: bookmark.title,
                            url: bookmark.url,
                            favIconUrl: utils.getFavIconFromUrl(bookmark.url) || '/icons/tab.svg',
                        });
                    }
                }

                if (bookmarksToAdd.length) {
                    await addGroup(undefined, bookmarksToAdd, folder.title);
                    groupsCreatedCount++;
                }
            }

            let currentWindowId = await getLastFocusedNormalWindowId();

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
        contexts: ['browser_action'],
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

async function exportGroupToBookmarks(groupId, showMessages = true) {
    let hasBookmarksPermission = await browser.permissions.contains(constants.PERMISSIONS.BOOKMARKS);

    if (!hasBookmarksPermission) {
        showMessages && utils.notify(browser.i18n.getMessage('noAccessToBookmarks'))
            .then(() => browser.runtime.openOptionsPage());
        return;
    }

    let groups = await loadAllGroups();

    let group = groups.find(gr => gr.id === groupId);

    if (!group) {
        throw Error(utils.errorEventMessage('group not found in exportGroupToBookmarks', groupId));
    }

    if (!group.tabs.length) {
        showMessages && utils.notify(browser.i18n.getMessage('groupWithoutTabs'));
        return;
    }

    let win = null;

    if (showMessages) {
        win = await getWindow();
        setBrowserAction(win.id, 'loading');
    }

    let rootFolder = {
        id: options.defaultBookmarksParent,
    };

    if (options.exportGroupToMainBookmarkFolder) {
        rootFolder = await _getBookmarkFolderFromTitle(options.autoBackupBookmarksFolderName, options.defaultBookmarksParent);
    }

    let groupIndex = options.exportGroupToMainBookmarkFolder ? groups.indexOf(group) : undefined,
        groupBookmarkFolder = await _getBookmarkFolderFromTitle(group.title, rootFolder.id, groupIndex);

    if (groupBookmarkFolder.children.length) {
        let bookmarksToRemove = [];

        group.tabs.forEach(function(tab) {
            groupBookmarkFolder.children = groupBookmarkFolder.children.filter(function(b) {
                if (b.type === 'bookmark' && b.url === tab.url) {
                    bookmarksToRemove.push(b);
                    return false;
                }

                return b.type === 'bookmark';
            });
        });

        await Promise.all(bookmarksToRemove.map(b => browser.bookmarks.remove(b.id).catch(noop)));

        let children = await browser.bookmarks.getChildren(groupBookmarkFolder.id);

        if (children.length) {
            if (children[0].type !== 'separator') {
                await browser.bookmarks.create({
                    type: 'separator',
                    index: 0,
                    parentId: groupBookmarkFolder.id,
                });
            }

            // found and remove duplicated separators
            let duplicatedSeparators = children.filter(function(separator, index) {
                return separator.type === 'separator' && children[index - 1] && children[index - 1].type === 'separator';
            });

            if (children[children.length - 1].type === 'separator' && !duplicatedSeparators.includes(children[children.length - 1])) {
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
            type: 'bookmark',
            index: Number(index),
            parentId: groupBookmarkFolder.id,
        });
    }

    if (showMessages) {
        updateBrowserActionData(group.id);
        utils.notify(browser.i18n.getMessage('groupExportedToBookmarks', group.title));
    }
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

function updateBrowserActionData(groupId, windowId) {
    console.log('updateBrowserActionData', {groupId, windowId});

    if (groupId) {
        windowId = cache.getWindowId(groupId);
    } else if (windowId) {
        groupId = cache.getWindowSession(windowId).groupId;
    }

    if (!windowId) {
        return;
    }

    let group = _groups.find(gr => gr.id === groupId);

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

    // browser.sessions.onChanged.addListener(onSessionChanged);
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

    // browser.sessions.onChanged.removeListener(onSessionChanged);
}

async function loadGroupPosition(textPosition) {
    if (1 >= _groups.length) {
        return false;
    }

    let win = await getWindow(),
        groupIndex = _groups.findIndex(group => group.windowId === win.id);

    if (-1 === groupIndex) {
        return false;
    }

    let nextGroupIndex = utils.getNextIndex(groupIndex, _groups.length, textPosition);

    if (false === nextGroupIndex) {
        return false;
    }

    return loadGroup(win.id, _groups[nextGroupIndex].id);
}

function sortGroups(vector = 'asc') {
    if (!['asc', 'desc'].includes(vector)) {
        throw Error(utils.errorEventMessage('invalid sort vector', vector));
    }

    if ('asc' === vector) {
        _groups.sort(utils.sortBy('title'));
    } else {
        _groups.sort(utils.sortBy('title', undefined, true));
    }

    updateMoveTabMenus();
    saveGroupsToStorage(true);
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
            await setTabActive(tabs[0].id);
        } else {
            await createTab({
                active: true,
                url: manageTabsPageUrl,
            });
        }
    } else {
        let allWindows = await browser.windows.getAll({
            populate: true,
            windowTypes: ['popup'],
        });

        let isFoundWindow = allWindows.some(function(win) {
            if ('popup' === win.type && 1 === win.tabs.length && manageTabsPageUrl === win.tabs[0].url) { // if manage popup is now open
                setFocusOnWindow(win.id);
                return true;
            }
        });

        if (isFoundWindow) {
            return;
        }

        await createWindow({
            url: manageTabsPageUrl,
            type: 'popup',
            width: Number(window.localStorage.manageGroupsWindowWidth) || 1000,
            height: Number(window.localStorage.manageGroupsWindowHeight) || 700,
        });
    }
}

async function clearTabsThumbnails() {
    await storage.set({
        thumbnails: {},
    });

    _thumbnails = {};

    sendMessage({
        action: 'thumbnails-updated',
    });
}

browser.runtime.onMessage.addListener(async function(request, sender) {
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

    if (!window.background.inited) {
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

function mapGroupForExternalExtension(group) {
    return {
        id: group.id,
        title: group.title,
        iconUrl: utils.getGroupIconUrl(group),
    };
}

async function getNextGroupTitle() {
    let { lastCreatedGroupPosition } = await storage.get('lastCreatedGroupPosition');
    return utils.createGroupTitle(null, lastCreatedGroupPosition + 1);
}

async function runAction(data, externalExtId) {
    let result = {
        ok: false,
    };

    if (!data.action) {
        result.error = '[STG] Action or it\'s id is empty';
        return result;
    }

    async function getCurrentWindow() {
        let currentWindow = await getWindow();

        if (!utils.isWindowAllow(currentWindow)) {
            throw Error('This window is not supported');
        }

        return currentWindow;
    }

    try {
        let currentWindow = await getCurrentWindow(),
            currentGroup = _groups.find(gr => gr.windowId === currentWindow.id);

        switch (data.action) {
            case 'are-you-here':
                result.ok = true;
                break;
            case 'get-groups-list':
                result.groupsList = _groups.map(mapGroupForExternalExtension);
                result.ok = true;
                break;
            case 'load-next-group':
                result.ok = await loadGroupPosition('next');
                break;
            case 'load-prev-group':
                result.ok = await loadGroupPosition('prev');
                break;
            case 'load-first-group':
                if (_groups[0]) {
                    result.ok = await loadGroup(currentWindow.id, _groups[0].id);
                }
                break;
            case 'load-last-group':
                if (_groups.length > 0) {
                    result.ok = await loadGroup(currentWindow.id, _groups[_groups.length - 1].id);
                }
                break;
            case 'load-custom-group':
                let group = _groups.find(gr => gr.id === data.groupId);

                if (group) {
                    result.ok = await loadGroup(currentWindow.id, group.id);
                } else {
                    throw Error(`Group id '${data.groupId}' type: '${typeof data.groupId}' not found. Need exists int group id.`);
                }
                break;
            case 'add-new-group':
                let newGroup = await addGroup();
                result.ok = true;
                result.group = mapGroupForExternalExtension(newGroup);
                break;
            case 'delete-current-group':
                if (currentGroup) {
                    await removeGroup(currentGroup.id);

                    if (externalExtId) {
                        utils.notify(browser.i18n.getMessage('groupRemovedByExtension', [currentGroup.title, utils.getSupportedExternalExtensionName(externalExtId)]));
                    }

                    result.ok = true;
                } else {
                    throw Error('There is no group in the current window');
                }

                break;
            case 'open-manage-groups':
                await openManageGroups();
                result.ok = true;
                break;
            case 'move-active-tab-to-custom-group':
                let activeTab = await getActiveTab();

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
                    await moveTabs([{
                        tabId: activeTab.id,
                    }], {
                        groupId: data.groupId,
                    });
                } else {
                    let activeGroup = _groups.find(group => group.windowId === activeTab.windowId);

                    await browser.tabs.sendMessage(activeTab.id, {
                        action: 'move-tab-to-custom-group',
                        groups: _groups.map(mapGroupForExternalExtension),
                        activeGroupId: activeGroup ? activeGroup.id : null,
                    }).catch(noop);
                }

                result.ok = true;
                break;
            case 'move-active-tab-to-group':
                let activeTabForMove = await getActiveTab();

                if ('new' === data.groupId) {
                    let newGroup = await addGroup();
                    data.groupId = newGroup.id;
                } else if (!_groups.some(group => group.id === data.groupId)) {
                    throw Error('Group not found');
                }

                await moveTabs([{
                    tabId: activeTabForMove.id,
                }], {
                    groupId: data.groupId,
                });

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
            };

        tabs
            .filter(utils.isTabNotIncognito)
            .forEach(tab => browser.tabs.sendMessage(tab.id, actionData).catch(noop));
    }

    if (optionsKeys.some(key => key === 'autoBackupEnable' || key === 'autoBackupIntervalKey' || key === 'autoBackupIntervalValue')) {
        resetAutoBackup();
    }

    if (optionsKeys.includes('prependGroupTitleToWindowTitle')) {
        _groups.forEach(group => updateBrowserActionData(group.id));
    }

    if (optionsKeys.some(key => key === 'showContextMenuOnTabs' || key === 'showContextMenuOnLinks')) {
        updateMoveTabMenus();
    }

    await browser.runtime.sendMessage({
        action: 'options-updated',
    }).catch(noop);
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
    for (let group of _groups) {
        await exportGroupToBookmarks(group.id, false);
    }

    if (showFinishMessage) {
        utils.notify(browser.i18n.getMessage('allGroupsExportedToBookmarks'));
    }
}

window.background = {
    inited: false,

    waitRestoreSession: false,

    openManageGroups,

    getGroups: () => utils.clone(_groups),
    loadAllGroups,
    loadAllWindows,

    getOptions: () => utils.clone(options),
    saveOptions,

    containers,

    createWindow,
    getWindow,

    getTabs,
    moveTabs,

    updateMoveTabMenus,
    clearTabsThumbnails,

    setFocusOnWindow,

    sortGroups,
    exportGroupToBookmarks,
    loadGroup,
    getNextGroupTitle,

    // mapTab,
    getTabFavIconUrl,
    updateTabThumbnail,

    getThumbnails: () => utils.clone(_thumbnails),

    addTab,
    removeTab,

    createGroup,
    moveGroup,
    addGroup,
    updateGroup,
    removeGroup,

    runMigrateForData,

    createBackup,
};

function _resetGroupsIdsAndTabsIds(groups) {
    return groups.map(function(group) {
        group.windowId = null;
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

async function loadAllGroups() {
    let [allTabs, {groups}] = await Promise.all([
            browser.tabs.query({
                windowType: browser.windows.WindowType.NORMAL,
                pinned: false,
            }),
            storage.get('groups')
        ]);

    let groupTabs = {};

    groups.forEach(group => groupTabs[group.id] = []);

    await Promise.all(allTabs.map(async function(tab) {
        tab = await cache.loadTabSession(tab);

        if (tab.session.groupId) {
            if (groupTabs[tab.session.groupId]) {
                groupTabs[tab.session.groupId].push(tab);
            } else {
                cache.removeTabGroup(tab.id);
            }
        }
    }));

    // for (var groupId in groupTabs) {
    //     groupTabs[groupId].sort((tabA, tabB) => utils.compareStrings(tabA.index, tabB.index));
    // }

    // allTabs.forEach(function(tab) {
    //     if (tab.session.groupId) {
    //         if (groupTabs[tab.session.groupId]) {
    //             groupTabs[tab.session.groupId].push(tab);
    //         } else {
    //             removeTabValue(tab.id, 'groupId');
    //         }
    //     }
    // });

    return groups.map(function(group) {
        // if (groupTabs[group.id].length) {
        //     group.tabs = groupTabs[group.id]
        //         .sort((tabA, tabB) => utils.compareStrings(tabA.index, tabB.index));
        // }


        group.tabs = groupTabs[group.id];

        // group.tabs.sort(utils.sortBy('index'));

        return group;
    });

    // groups = await Promise.all(groups.map(function(group) {
    //     if (groupTabs[group.id].length) {
    //         group.tabs = groupTabs[group.id];
    //     }
    // }));
}

// { reason: "update", previousVersion: "3.0.1", temporary: true }
// { reason: "install", temporary: true }
// browser.runtime.onInstalled.addListener(console.info.bind(null, 'onInstalled'));

// fix FF bug on browser.windows.getAll ... it's not return all windows
// without pinned: false because need all windows, without normal tabs but with pinned tabs
async function loadAllWindows(withTabs) {
    let [allTabs, allWindows] = await Promise.all([
            withTabs ? browser.tabs.query({
                windowType: browser.windows.WindowType.NORMAL,
            }) : false,
            browser.windows.getAll({
                windowTypes: [browser.windows.WindowType.NORMAL],
            })
        ]);

    let windows = await Promise.all(allWindows.map(async function(win) {
        if (!utils.isWindowAllow(win)) {
            return false;
        }

        win = await cache.loadWindowSession(win);

        if (withTabs) {
            win.tabs = await Promise.all(
                allTabs
                    .filter(function(tab) {
                        if (utils.isTabPinned(tab)) {
                            cache.setTab(tab);
                            return false;
                        }

                        return tab.windowId === win.id;
                    })
                    .map(cache.loadTabSession)
            );
        }

        return win;
    }));

    return windows.filter(Boolean).sort(utils.sortBy('id'));
}

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

    let windows = await loadAllWindows(true);

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

        window.background.waitRestoreSession = true;

        await new Promise(function(resolve) {
            let tryCount = 0;

            async function checkRestoreSession() {
                let wins = await loadAllWindows(true);

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

    window.background.waitRestoreSession = false;

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

        let tempTabs = await Promise.all(windows.map(win => createTempActiveTab(win.id)));

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

                return createTab({
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

        windows = await loadAllWindows(true);
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
                        await setTabActive(undefined, showedTabs);
                    } else {
                        tempTab = await createTempActiveTab(win.id);
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
                        await setTabActive(null, visibleTabs);
                    } else {
                        await createTempActiveTab(win.id, false);
                    }
                }

                await browser.tabs.hide(tabsToHide.map(utils.keyId));
            }
        }
    }));


    // data.groups.forEach(group => group.tabs = []); // TMP for developing



    // OLD code ============================

    _groups = data.groups;

    _thumbnails = data.thumbnails;

    await storage.remove(['doRemoveSTGNewTabUrls', 'withoutSession']);
    // await storage.clear(); TODO
    await storage.set(data);

    resetAutoBackup();

    windows.forEach(win => updateBrowserActionData(null, win.id));

    createMoveTabMenus();

    addEvents();

    window.background.inited = true;
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
