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

    // cache = {
    //     tabs: {},
    //     windowIdGroupId: {},
    //     tabIdGroupId: {},
    // },

    manifest = browser.runtime.getManifest(),
    manageTabsPageUrl = browser.extension.getURL(constants.MANAGE_TABS_URL),
    noop = function() {};

window.addEventListener('error', utils.errorEventHandler);
// throw Error(utils.errorEventMessage('invalid', data));

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

async function createWindow(createData = {}, groupId, activeTabId, activeTabIndex) {
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
        await loadGroup(win.id, groupId, activeTabId, activeTabIndex);
    }

    return win;
}

function setFocusOnWindow(windowId) {
    return browser.windows.update(windowId, {
        focused: true,
    });
}

async function setTabActive(tabId, tabs, tabIndex) {
    let tabToActive = null;

    if (tabId) {
        tabToActive = Array.isArray(tabs) ? tabs.find(tab => tab.id === tabId) : {
            id: tabId,
        };
    } else if (Number.isFinite(tabIndex) && -1 < tabIndex) {
        tabToActive = Array.isArray(tabs) ? tabs[tabIndex] : {
            id: tabId,
        };
    } else if (Array.isArray(tabs)) { // find lastAccessed tab
        let lastAccessedTimes = tabs.map(tab => tab.lastAccessed).filter(Boolean),
            maxLastAccessed = lastAccessedTimes.length ? Math.max.apply(Math, lastAccessedTimes) : null;

        tabToActive = maxLastAccessed ? tabs.find(tab => tab.lastAccessed === maxLastAccessed) : null;
    }

    if (tabToActive) {
        tabs && tabs.forEach(tab => tab.active = tab.id === tabToActive.id);

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

const newTabKeys = ['active', 'cookieStoreId', 'index', 'discarded', 'title', 'openerTabId', 'openInReaderMode', 'pinned', 'url', 'windowId'];

// function clearTabForCreate(tab, excludeIdKey) {
//     Object.keys(tab).forEach(function(key) {
//         if (excludeIdKey && 'id' === key) {
//             return;
//         }

//         if (!newTabKeys.includes(key)) {
//             delete tab[key];
//         }
//     });

//     return tab;
// }

async function createTab(tab, hideTab = false) {
    console.log('createTab hideTab', tab, hideTab);

    let newTab = null,
        groupId = tab.groupId,
        tabIsNew = false;

    if (tab.id) {
        newTab = tab;
        delete tab.groupId;
    } else {
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

        if (!Number.isFinite(tab.windowId) || 0 >= tab.windowId) {
            delete tab.windowId;
        }

        if ('cookieStoreId' in tab) {
            tab.cookieStoreId = containers.get(tab.cookieStoreId, 'cookieStoreId');
        }

        if (tab.isInReaderMode) {
            tab.openInReaderMode = true;
        }

        Object.keys(tab).forEach(key => !newTabKeys.includes(key) && (delete tab[key]));

        newTab = await browser.tabs.create(tab);

        cache.setTab(newTab);

        tabIsNew = true;
    }

    newTab = await cache.loadTabSession(newTab);

    if (utils.isTabNotPinned(newTab)) {
        if (hideTab) {
            await browser.tabs.hide(newTab.id);
            newTab.hidden = true;
        }

        if (groupId && groupId !== newTab.session.groupId) {
            cache.setTabGroup(newTab.id, groupId);
        }

        if (newTab.session.groupId && tabIsNew) {
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
    let tabs = await browser.tabs.query({
        windowId,
        pinned,
        hidden,
    });

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

async function createTempActiveTab(windowId, createPinnedTab = true) {
    let pinnedTabs = cache.getPinnedTabs(windowId);

    if (pinnedTabs.length) {
        if (!pinnedTabs.some(tab => tab.active)) {
            await setTabActive(pinnedTabs[pinnedTabs.length - 1].id);
        }
    } else {
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
            if ('loading' === winTab.status && utils.isUrlEmpty(winTab.url)) {
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
    // let {groups} = await storage.get('groups'),

    // let group = groups.find(gr => gr.id === groupId),
    let windowId = cache.getWindowId(groupId);

    return createTabsSafe([{
        url,
        title,
        active,
        cookieStoreId,
        groupId,
        windowId,
    }], !windowId);



    // return createTab({
    //     url,
    //     title,
    //     active,
    //     cookieStoreId,
    //     groupId,
    //     windowId,
    // }, !windowId);


    // if (group.windowId) {
    //     tab.windowId = group.windowId;

    //     return createTab(tab);
    // } else {
    //     if (tab.active) {
    //         group.tabs.forEach(t => t.active = false);
    //     }

    //     group.tabs.push(tab);

    //     sendMessage({
    //         action: 'group-updated',
    //         group: {
    //             id: group.id,
    //             tabs: group.tabs,
    //         },
    //     });

    //     saveGroupsToStorage();

    //     return tab;
    // }
}

async function removeTab(tab, tabIndex) {
    if (tab.id) {
        if (utils.isTabVisible(tab)) {
            let groupWindowId = cache.getWindowId(tab.session.groupId),
                isLastTabInGroup = 1 === cache.getTabs(tab.session.groupId).length;

            if (groupWindowId && isLastTabInGroup) {
                // let pinnedTabs = await getTabs(groupWindowId, true);
                let pinnedTabs = cache.getPinnedTabs(groupWindowId);

                if (!pinnedTabs.length) {
                    await createTab({
                        active: true,
                        windowId: groupWindowId,
                    });
                }
            }
        }

        await browser.tabs.remove(tab.id);
    } else {
        let group = _groups.find(gr => gr.id === tab.session.groupId);

        group.tabs.splice(tabIndex, 1);

        // group.tabs.splice(tabIndex, 1);

        sendMessage({
            action: 'group-updated',
            group: {
                id: group.id,
                tabs: group.tabs,
            },
        });

        saveGroupsToStorage();
    }



/*
    let group = _groups.find(gr => gr.id === groupId);
        tabId = group.tabs[tabIndex].id;

    if (tabId) {
        let tab = await browser.tabs.get(tabId);

        if (utils.isTabVisible(tab)) {
            let pinnedTabs = await getPinnedTabs(group.windowId);

            if (!pinnedTabs.length && 1 === group.tabs.length) {
                await createTab({
                    active: true,
                    windowId: group.windowId,
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
    }*/
}

function setMuteTabs(tabs, muted) {
    tabs
        .filter(tab => muted ? tab.audible : tab.mutedInfo.muted)
        .forEach(tab => browser.tabs.update(tab.id, {muted}));
}

let _loadingGroupInWindow = {}; // windowId: true;
async function loadGroup(windowId, groupId, activeTabId, activeTabIndex) {
    if (!windowId) { // load group into last focused window
        windowId = await getLastFocusedNormalWindowId();

        if (!windowId) {
            throw Error('loadGroup: not found normal window');
        }
    }

    if (_loadingGroupInWindow[windowId]) {
        return false;
    }

    console.log('loadGroup args groupId: %s, windowId: %s, activeTab: %s, activeTabIndex: %s', groupId, windowId, activeTabId, activeTabIndex);

    // let groups = await loadAllGroups(),
    //     {groupId: oldGroupId} = cache.getWindowSession(windowId),
    //     groupToShow = groups.find(gr => gr.id === groupId),
    //     groupToHide = groups.find(gr => gr.id === oldGroupId),
    //     groupWindowId = cache.getWindowId(groupId);


    let groupToShow = _groups.find(gr => gr.id === groupId);

    if (!groupToShow) {
        throw Error(utils.errorEventMessage('loadGroup: groupToShow not found', {groupId, activeTabId, activeTabIndex}));
    }

    _loadingGroupInWindow[windowId] = true;

    let groupWindowId = cache.getWindowId(groupId);

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

            let tempEmptyTab = await createTempActiveTab(windowId); // create empty tab (for quickly change group and not blinking)

            // hide tabs
            if (groupToHide && groupToHide.tabs.length) {
                let tabIdsToHide = groupToHide.tabs.map(utils.keyId);

                if (groupToHide.muteTabsWhenGroupCloseAndRestoreWhenOpen) {
                    setMuteTabs(groupToHide.tabs, true);
                }

                await browser.tabs.hide(tabIdsToHide);

                if (options.discardTabsAfterHide) {
                    browser.tabs.discard(tabIdsToHide);
                }
            }

            // show tabs
            if (groupToShow.tabs.length) {
                groupToShow.tabs = groupToShow.tabs.filter(tab => tab.id || utils.isUrlAllowToCreate(tab.url)); // remove unsupported tabs

                let needResortTabs = false;

                if (groupToShow.tabs.some(tab => !tab.id)) {
                    needResortTabs = true;

                    groupToShow.tabs = await createTabsSafe(groupToShow.tabs.map(function(tab) {
                        if (!tab.id) {
                            tab.windowId = windowId;
                            delete tab.index;
                        }

                        return tab;
                    }), false, groupToShow.id, false);
                }

                if (!needResortTabs && groupToShow.tabs.some(tab => tab.windowId !== windowId)) {
                    needResortTabs = true;
                }

                if (needResortTabs) {
                    await browser.tabs.move(groupToShow.tabs.map(utils.keyId), {
                        index: -1,
                        windowId: windowId,
                    });

                    let _groupToShow = _groups.find(gr => gr.id === groupId);

                    _groupToShow.tabs = [];
                    saveGroupsToStorage();
                }

                await browser.tabs.show(groupToShow.tabs.map(utils.keyId));

                if (groupToShow.muteTabsWhenGroupCloseAndRestoreWhenOpen) {
                    setMuteTabs(groupToShow.tabs, false);
                }

                console.debug('groupToShow.tabs', groupToShow.tabs);

                // set active tab
                await setTabActive(activeTabId, groupToShow.tabs, activeTabIndex);
            }

            if (tempEmptyTab) {
                await browser.tabs.remove(tempEmptyTab.id);
            }

            if (groupToHide) {
                groupToHide.tabs.some(function(tab) {
                    if (tab.url === manageTabsPageUrl) {
                        browser.tabs.remove(tab.id);
                        return true;
                    }
                });
            }

            // set group id for tabs which may has opened without groupId (new window without group)
            getTabs(windowId).then(tabs => tabs.forEach(function(tab) {
                if (tab.session.groupId !== groupToShow.id) {
                    cache.setTabGroup(tab.id, groupToShow.id);
                }
            }));

            cache.setWindowGroup(windowId, groupToShow.id);

            sendMessage({
                action: 'group-updated',
                group: groupToShow,
            });

            // await saveCurrentTabs(windowId, 'loadGroup');

            updateMoveTabMenus(windowId);

            updateBrowserActionData(groupToShow.id);

            addEvents();
        }

        // sendMessage({
        //     action: 'group-loaded',
        //     group: groupToShow,
        // });

        return true;
    } catch (e) {
        if (groupToShow) {
            updateBrowserActionData(groupToShow.id);
        }

        console.error(e);

        throw e;
    } finally {
        delete _loadingGroupInWindow[windowId];
    }
}

async function _fixLastActiveTab(group, setPosition = 'last-active', breakIfHasActive = false) {
    let tabIds = group.tabs.filter(utils.keyId).map(utils.keyId);

    if (!tabIds.length || (breakIfHasActive && group.tabs.some(tab => tab.active))) {
        return;
    }

    let winTabs = await Promise.all(tabIds.map(tabId => browser.tabs.get(tabId))),
        tabsTime = winTabs.map(tab => tab.lastAccessed),
        lastAccessedTime = Math.max.apply(Math, tabsTime),
        lastAccessedRawTab = null;

    if ('prev-active' === setPosition) {
        tabsTime = tabsTime.filter(time => time !== lastAccessedTime);

        if (!tabsTime.length) {
            return;
        }

        lastAccessedTime = Math.max.apply(Math, tabsTime);
    }

    lastAccessedRawTab = winTabs.find(tab => tab.lastAccessed === lastAccessedTime);

    if (group.windowId) {
        await setTabActive(lastAccessedRawTab.id);
    } else {
        group.tabs.forEach(tab => tab.active = tab.id === lastAccessedRawTab.id);
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
            .then(function() {
                if (tab.active) {
                    _fixLastActiveTab(group, 'prev-active');
                }
            })
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
    // let tab = null,
        // group = null;

    if (isMovingTabs || utils.isTabIncognito(tab) || 'isArticle' in changeInfo) {
        return;
    }

    cache.updateTab(tabId, changeInfo);

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
            .then(function() {
                if (tab.active) {
                    _fixLastActiveTab(group, 'prev-active');
                }
            })
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

// let reCreateTabGroups = [];

function onRemovedTab(tabId, { isWindowClosing, windowId }) {
    console.log('onRemovedTab', {tabId, isWindowClosing, windowId});

    let tab = cache.getTab(tabId);

    if (!tab) {
        return;
    }

    if (isWindowClosing) {
        let group = _groups.find(gr => gr.id === tab.session.groupId);

        if (group) {
            delete tab.id;
            delete tab.windowId;
            delete tab.index;

            group.tabs.push(tab);

            callSaveGroupsOnWindowClosed = true;
        }
    }

    cache.removeTab(tabId);

    if (utils.isTabNotPinned(tab)) {
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
        cache.setWindow(win, true);

        if (options.createNewGroupWhenOpenNewWindow) {
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

let callSaveGroupsOnWindowClosed = false;
async function onRemovedWindow(windowId) {
    console.log('onRemovedWindow windowId:', windowId);

    let {groupId} = cache.getWindowSession(windowId);

    if (groupId && callSaveGroupsOnWindowClosed) {
        callSaveGroupsOnWindowClosed = false;
        saveGroupsToStorage();
    }

    cache.removeWindow(windowId);

    // reCreateTabGroups.forEach(function(groupId) {
    //     let group = _groups.find(gr => gr.id === groupId);

    //     createTabsSafe(group.tabs.reverse(), true, groupId);

    //     group.tabs = [];
    // });

    // let {groupId} = cache.getWindowSession(windowId),
    //     group = _groups.find(gr => gr.id === groupId);

    // // let group = _groups.find(gr => gr.windowId === windowId);

    // if (group) {
    //     // group.windowId = null;
    //     // group.tabs.forEach(tab => tab.id = null); // reset tab id in func onRemovedTab // TODO

    //     sendMessage({
    //         action: 'group-updated',
    //         group: {
    //             id: group.id,
    //             // windowId: null,
    //             tabs: group.tabs,
    //         },
    //     });

    //     // saveGroupsToStorage();
    // }
}

async function getLastFocusedNormalWindowId() {
    let lastFocusedWindow = await browser.windows.getLastFocused();

    if (utils.isWindowAllow(lastFocusedWindow)) {
        return lastFocusedWindow.id;
    }

    // hard way (((
    let windows = await browser.windows.getAll({
            windowTypes: ['normal'],
        }),
        filteredWindows = windows.filter(utils.isWindowAllow).sort(utils.sortBy('id')),
        win = filteredWindows.find(win => win.focused) || filteredWindows.pop();

    console.log('getLastFocusedNormalWindowId', win, filteredWindows);

    return win ? win.id : null;
}

let isMovingTabs = false;

async function moveTabs(fromData, toData, showNotificationAfterMoveTab = true, showTabAfterMoving = false) {
    /*
    fromData = [ Array of object tab identifiers
        if tabId && (groupId || tabIndex) -> error
        if !tabId && (!groupId || !tabIndex) -> error

        need only tabId or (groupId && tabIndex) else -> error

        {
            tabId: int || null
            or
            tabIndex: int || null
            groupId: int || null
        }
    ]

    toData = {
        newTabIndex: int || -1
        groupId: int, required
    }
    /**/

    fromData = utils.clone(fromData);
    toData = utils.clone(toData);

    console.info('moveTabs', {fromData, toData, showNotificationAfterMoveTab, showTabAfterMoving});

    let newGroup = _groups.find(gr => gr.id === toData.groupId);

    if (!newGroup) {
        throw Error('moveTabs error: new group id not found');
    }

    if (!Array.isArray(fromData)) {
        throw TypeError('moveTabs type error: fromData must be an array');
    }

    if (!fromData.length) {
        throw TypeError('moveTabs type error: fromData can not be empty');
    }

    for (let tabData of fromData) {
        if ('object' !== utils.type(tabData)) {
            throw TypeError('moveTabs type error: tab data must be an object');
        }

        if (tabData.tabId && (tabData.groupId || null != tabData.tabIndex)) {
            throw Error('moveTabs type error: tab data must contains only tab id');
        }

        if (!tabData.tabId && (!tabData.groupId || null == tabData.tabIndex || 0 > tabData.tabIndex)) {
            throw Error('moveTabs type error: tab data must contains valid group id and tab index');
        }
    }

    let pushToEnd = (-1 === toData.newTabIndex || null == toData.newTabIndex);

    if (pushToEnd) {
        toData.newTabIndex = newGroup.tabs.length;
    }

    toData.newRealTabIndex = -1;

    let pinnedTabs = [];

    if (newGroup.windowId) {
        pinnedTabs = cache.getPinnedTabs(newGroup.windowId);

        if (!pushToEnd) {
            toData.newRealTabIndex = pinnedTabs.length + toData.newTabIndex;
        }
    }

    let countMovedTabs = 0,
        workedGroups = [];

    function setGroupAsWorked(group) {
        if (!workedGroups.includes(group)) {
            workedGroups.push(group);
        }
    }

    function moveTabLocal(tabData, newTab) {
        countMovedTabs++;

        if (tabData.tabId) {
            let foundTab = _groups.some(function(group) {
                return group.tabs.some(function(tab, tabIndex) {
                    if (tab && tab.id === tabData.tabId) {
                        if (group.id === newGroup.id) {
                            newGroup.tabs.splice(tabIndex, 1);
                            newGroup.tabs.splice(toData.newTabIndex, 0, (newTab || tab));
                        } else {
                            group.tabs[tabIndex] = null;
                            newGroup.tabs.splice(toData.newTabIndex, 0, (newTab || tab));
                            setGroupAsWorked(group);
                        }

                        setGroupAsWorked(newGroup);

                        return true;
                    }
                });
            });

            if (!foundTab && newTab) { // if move unsync tab
                newGroup.tabs.splice(toData.newTabIndex, 0, newTab);
                setGroupAsWorked(newGroup);
            }
        } else {
            if (tabData.groupId === newGroup.id) {
                let [tab] = newGroup.tabs.splice(tabData.tabIndex, 1);
                newGroup.tabs.splice(toData.newTabIndex, 0, (newTab || tab));
            } else {
                let group = _groups.find(gr => gr.id === tabData.groupId);
                newGroup.tabs.splice(toData.newTabIndex, 0, (newTab || group.tabs[tabData.tabIndex]));
                group.tabs[tabData.tabIndex] = null;
                setGroupAsWorked(group);
            }

            setGroupAsWorked(newGroup);
        }

    }

    let tabsWhichCantMove = {
        showPinnedMessage: false,
        urlNotAllow: [],
        cantHide: [],
    };

    isMovingTabs = true;

    if (newGroup.windowId) {
        if (newGroup.tabs.length) { // update/fix real tab indexes
            let tabs = await getTabs(newGroup.windowId);

            await browser.tabs.move(newGroup.tabs.map(utils.keyId), {
                index: pinnedTabs.length,
                windowId: newGroup.windowId,
            });
        }

        for (let tabData of fromData) {
            if (tabData.tabId) {
                let tab = await browser.tabs.get(tabData.tabId);

                if (utils.isTabPinned(tab)) {
                    tabsWhichCantMove.showPinnedMessage = true;
                    continue;
                }

                // moveTabLocal(tabData, mapTab(tab));
                moveTabLocal(tabData, tab);

                await browser.tabs.move(tab.id, {
                    index: toData.newRealTabIndex,
                    windowId: newGroup.windowId,
                });

                tab = await browser.tabs.get(tab.id);

                if (utils.isTabHidden(tab)) {
                    await browser.tabs.show(tab.id);
                }
            } else {
                let group = _groups.find(gr => gr.id === tabData.groupId),
                    tab = group.tabs[tabData.tabIndex];

                if (tab) {
                    if (!utils.isUrlAllowToCreate(tab.url)) {
                        tabsWhichCantMove.urlNotAllow.push(tab.url);
                        continue;
                    }

                    let newTab = await createTab({
                        index: toData.newRealTabIndex,
                        url: tab.url,
                        title: tab.title,
                        windowId: newGroup.windowId,
                        cookieStoreId: tab.cookieStoreId,
                    });

                    // moveTabLocal(tabData, mapTab(newTab));
                    moveTabLocal(tabData, newTab);
                } else {
                    throw Error(utils.errorEventMessage('moveTabs error: tab not found', tabData));
                }
            }

            toData.newTabIndex++;

            if (!pushToEnd) {
                toData.newRealTabIndex++;
            }
        }
    } else {
        let tabInGroup = newGroup.tabs.find(utils.keyId),
            newGroupWindowId = null;

        if (tabInGroup) {
            let rawTabInGroup = await browser.tabs.get(tabInGroup.id);
            newGroupWindowId = rawTabInGroup.windowId;
        }

        for (let tabData of fromData) {
            if (tabData.tabId) {
                let tab = await browser.tabs.get(tabData.tabId);

                if (utils.isTabPinned(tab)) {
                    tabsWhichCantMove.showPinnedMessage = true;
                    continue;
                }

                if (utils.isTabCanNotBeHidden(tab)) {
                    tabsWhichCantMove.cantHide.push(utils.getTabTitle(tab));
                    continue;
                }

                if (newGroupWindowId && newGroupWindowId !== tab.windowId) {
                    await browser.tabs.move(tab.id, {
                        index: -1,
                        windowId: newGroupWindowId,
                    });
                    tab = await browser.tabs.get(tab.id);
                }

                // moveTabLocal(tabData, mapTab(tab));
                moveTabLocal(tabData, tab);

                if (utils.isTabVisible(tab)) {
                    let tempEmptyTab = null;

                    if (tab.active) {
                        let winTabs = await getTabs(tab.windowId),
                            activeIndex = winTabs.findIndex(t => t.id === tab.id);

                        if (-1 !== activeIndex && activeIndex - 1 >= 0) {
                            await setTabActive(winTabs[activeIndex - 1].id);
                        } else if (-1 !== activeIndex && winTabs[activeIndex + 1]) {
                            await setTabActive(winTabs[activeIndex + 1].id);
                        } else {
                            tempEmptyTab = await createTempActiveTab(tab.windowId);
                        }
                    }

                    await browser.tabs.hide(tab.id);

                    if (tempEmptyTab) {
                        await browser.tabs.remove(tempEmptyTab.id);
                    }
                }

            } else {
                moveTabLocal(tabData);
            }

            toData.newTabIndex++;
        }
    }

    await Promise.all(workedGroups.map(async function(group) {
        group.tabs = group.tabs.filter(Boolean);

        if (group.windowId) {
            await saveCurrentTabs(group.windowId, 'moveTabs');
        } else {
            sendMessage({
                action: 'group-updated',
                group: {
                    id: group.id,
                    tabs: group.tabs,
                },
            });
        }
    }));

    isMovingTabs = false;

    function join(strArray) {
        return strArray.filter(utils.onlyUniqueFilter).map(str => utils.sliceText(str, 25)).join(', ');
    }

    if (tabsWhichCantMove.showPinnedMessage) {
        utils.notify(browser.i18n.getMessage('pinnedTabsAreNotSupported'));
    }

    if (tabsWhichCantMove.urlNotAllow.length) {
        utils.notify(browser.i18n.getMessage('thisUrlsAreNotSupported', join(tabsWhichCantMove.urlNotAllow)));
    }

    if (tabsWhichCantMove.cantHide.length) {
        utils.notify(browser.i18n.getMessage('thisTabsCanNotBeHidden', join(tabsWhichCantMove.cantHide)));
    }

    if (!workedGroups.length) {
        return;
    }

    saveGroupsToStorage();

    let lastTabIndex = newGroup.tabs[toData.newTabIndex] ? toData.newTabIndex : toData.newTabIndex - 1;

    if (showTabAfterMoving) {
        await loadGroup(newGroup.windowId, newGroup.id, lastTabIndex);

        return;
    }

    if (!showNotificationAfterMoveTab || !options.showNotificationAfterMoveTab) {
        return;
    }

    let message = '';

    if (countMovedTabs > 1) {
        message = browser.i18n.getMessage('moveMultipleTabsToGroupMessage', countMovedTabs);
    } else {
        let tabTitle = utils.sliceText(utils.getTabTitle(newGroup.tabs[lastTabIndex]), 50);
        message = browser.i18n.getMessage('moveTabToGroupMessage', [newGroup.title, tabTitle]);
    }

    utils.notify(message)
        .then(async function(newGroupId, lastTabIndex) {
            let group = _groups.find(gr => gr.id === newGroupId);

            if (group && group.tabs[lastTabIndex]) {
                let winId = await getLastFocusedNormalWindowId();
                if (winId) {
                    await setFocusOnWindow(winId);
                    loadGroup(winId, group.id, lastTabIndex);
                }
            }
        }.bind(null, newGroup.id, lastTabIndex));
}

async function updateMoveTabMenus(windowId) {
    await removeMoveTabMenus();
    await createMoveTabMenus(windowId);
}

let moveTabToGroupMenusIds = [];

async function removeMoveTabMenus() {
    if (moveTabToGroupMenusIds.length) {
        await Promise.all(moveTabToGroupMenusIds.map(id => browser.menus.remove(id).catch(noop)));
        moveTabToGroupMenusIds = [];
    }
}

async function createMoveTabMenus(windowId) {
    if (!windowId) {
        let win = await getWindow();

        if (!utils.isWindowAllow(win)) {
            removeMoveTabMenus();
            return;
        }

        windowId = win.id;
    }

    let {groupId} = cache.getWindowSession(windowId),
        currentGroup = _groups.find(gr => gr.id === groupId),
        hasBookmarksPermission = await browser.permissions.contains(constants.PERMISSIONS.BOOKMARKS);

    if (!options.showContextMenuOnTabs && !options.showContextMenuOnLinks && !hasBookmarksPermission) {
        return;
    }

    hasBookmarksPermission && moveTabToGroupMenusIds.push(browser.menus.create({
        id: 'stg-open-bookmark-in-group-parent',
        title: browser.i18n.getMessage('openBookmarkInGroup'),
        contexts: ['bookmark'],
    }));

    options.showContextMenuOnTabs && moveTabToGroupMenusIds.push(browser.menus.create({
        id: 'stg-move-tab-parent',
        title: browser.i18n.getMessage('moveTabToGroupDisabledTitle'),
        contexts: ['tab'],
    }));

    options.showContextMenuOnLinks && moveTabToGroupMenusIds.push(browser.menus.create({
        id: 'stg-open-link-parent',
        title: browser.i18n.getMessage('openLinkInGroupDisabledTitle'),
        contexts: ['link'],
    }));

    _groups.forEach(function(group) {
        let groupIconUrl = utils.getGroupIconUrl(group),
            groupTitle = (cache.getWindowId(group.id) ? '• ' : '') + group.title;

        options.showContextMenuOnTabs && moveTabToGroupMenusIds.push(browser.menus.create({
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

        options.showContextMenuOnLinks && moveTabToGroupMenusIds.push(browser.menus.create({
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

        hasBookmarksPermission && moveTabToGroupMenusIds.push(browser.menus.create({
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

    options.showContextMenuOnTabs && moveTabToGroupMenusIds.push(browser.menus.create({
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

    options.showContextMenuOnTabs && moveTabToGroupMenusIds.push(browser.menus.create({
        type: 'separator',
        parentId: 'stg-move-tab-parent',
        contexts: ['tab'],
    }));

    options.showContextMenuOnTabs && moveTabToGroupMenusIds.push(browser.menus.create({
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

    options.showContextMenuOnLinks && moveTabToGroupMenusIds.push(browser.menus.create({
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

    hasBookmarksPermission && moveTabToGroupMenusIds.push(browser.menus.create({
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

    hasBookmarksPermission && moveTabToGroupMenusIds.push(browser.menus.create({
        type: 'separator',
        parentId: 'stg-open-bookmark-in-group-parent',
        contexts: ['bookmark'],
    }));

    hasBookmarksPermission && moveTabToGroupMenusIds.push(browser.menus.create({
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

            await addBookmarkFolderAsGroup(folder);

            if (groupsCreatedCount) {
                utils.notify(browser.i18n.getMessage('groupsCreatedCount', groupsCreatedCount));
            } else {
                utils.notify(browser.i18n.getMessage('noGroupsCreated'));
            }
        },
    }));

    hasBookmarksPermission && moveTabToGroupMenusIds.push(browser.menus.create({
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

    let group = _groups.find(gr => gr.id === groupId);

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

    let groupIndex = options.exportGroupToMainBookmarkFolder ? _groups.indexOf(group) : undefined,
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

function updateBrowserActionData(groupId) {
    let windowId = cache.getWindowId(groupId);

    if (!windowId) {
        return;
    }

    let group = _groups.find(gr => gr.id === groupId);

    if (group) {
        setBrowserAction(windowId, utils.sliceText(group.title, 28) + ' - STG', utils.getGroupIconUrl(group));
        prependWindowTitle(windowId, group.title);
    } else {
        setBrowserAction(windowId);
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
                windowType: 'normal',
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
                windowType: 'normal',
                pinned: false,
            }),
            storage.get('groups')
        ]);

    let groupTabs = {};

    groups.forEach(group => groupTabs[group.id] = []);

    await Promise.all(allTabs.map(async function(tab) {
        await cache.loadTabSession(tab);

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


        group.tabs.push.apply(group.tabs, groupTabs[group.id]);

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
                windowType: 'normal',
            }) : false,
            browser.windows.getAll({
                windowTypes: ['normal'],
            })
        ]);

    let windows = await Promise.all(allWindows.map(async function(win) {
        if (!utils.isWindowAllow(win)) {
            return false;
        }

        await cache.loadWindowSession(win);

        if (withTabs) {
            win.tabs = await Promise.all(allTabs
                .filter(function(tab) {
                    if (utils.isTabPinned(tab)) {
                        cache.setTab(tab);
                        return false;
                    }

                    return tab.windowId === win.id;

                    // tab => tab.windowId === win.id && utils.isTabNotPinned(tab)
                })
                .map(function(tab) {
                    if (utils.isUrlEmpty(tab.url)) { // TODO remove this ?
                        tab.url = 'about:blank';
                    }

                    return cache.loadTabSession(tab);
                }));
        }

        return win;
    }));

    return windows.filter(Boolean);
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

    // console.debug('browser.extension.isAllowedFileSchemeAccess()', await browser.extension.isAllowedFileSchemeAccess());

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

        // windows = await loadAllWindows(true);

        setBrowserAction(undefined, 'loading');

        browser.notifications.clear('wait-session-restore-message');
    }

    window.background.waitRestoreSession = false;

    if (windows.some(win => win.tabs.some(tab => isStgNewTabUrl(tab.url)))) {
        windows = await removeSTGNewTabUrls(windows);
    }


    // data.withoutSession = true;

    if (data.withoutSession) { // if version < 4

        // try simple sync groups and tabs
        let needFullSync = ! windows.every(function(win) {
            if (!win.session.groupId) {
                return false;
            }

            // find group which was synced with window
            let group = data.groups.find(gr => gr.id === win.session.groupId);

            if (!group) {
                return false;
            }

            let visibleTabs = win.tabs.filter(utils.isTabVisible);

            if (visibleTabs.length !== group.tabs.length) {
                return false;
            }

            group.windowId = win.id;

            return visibleTabs.every(function(rawTab, tabIndex) {
                if (rawTab.status === 'loading' && rawTab.active === group.tabs[tabIndex].active) {
                    group.tabs[tabIndex].id = rawTab.id;
                    return true;
                }

                if (rawTab.url === group.tabs[tabIndex].url) {
                    group.tabs[tabIndex].id = rawTab.id;
                    return true;
                }
            });
        });

        if (needFullSync) {
            data.groups = _resetGroupsIdsAndTabsIds(data.groups);

            let loadingRawTabs = {}; // window id : tabs that were in the loading state

            windows.forEach(function(win) {
                loadingRawTabs[win.id] = win.tabs.filter(rawTab => utils.isTabVisible(rawTab) && rawTab.status === 'loading');
            });

            // waiting all tabs to load
            await new Promise(function(resolve) {
                if (!data.groups.length) { // if no groups - not need to wait load tabs
                    resolve();
                    return;
                }

                let tryCount = 0,
                    tryTime = 250, // ms
                    showNotificationMessageForLongTimeLoading = 61, // sec
                    fullStopAddonAfterLoadingWaitFor = 3, // min
                    startLoadingTabsTime = Date.now();

                async function checkTabs() {
                    let loadingTabs = await browser.tabs.query({
                        pinned: false,
                        hidden: false,
                        status: 'loading',
                        windowType: 'normal',
                    });

                    loadingTabs = loadingTabs.filter(utils.isTabNotIncognito);

                    if (loadingTabs.length) {
                        if ((Date.now() - startLoadingTabsTime) > (fullStopAddonAfterLoadingWaitFor * 60 * 1000)) { // after 10 min loading - stop loading
                            resolve(); // stop wait tab loading
                            return;
                        }

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

            windows = await loadAllWindows(true);

            if (!windows.length) {
                throw browser.i18n.getMessage('nowFoundWindowsAddonStoppedWorking');
            }

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

            await Promise.all(windows.map(async function(win) {
                let group = null;

                // find group which was synced with window
                if (win.session.groupId) {
                    group = data.groups.find(group => group.id === win.session.groupId);
                }

                if (!group) {
                    win.session.groupId = null;
                    await cache.removeWindowGroup(win.id);
                    return;
                }

                group.windowId = win.id;

                if (!group.tabs.length && !loadingRawTabs[win.id].length) {
                    let tabsToHide = win.tabs.filter(utils.isTabVisible).map(utils.keyId);

                    if (tabsToHide.length) {
                        await createTempActiveTab(win.id, false);
                        await browser.tabs.hide(tabsToHide);
                    }

                    return;
                }

                let tempSyncedTabIds = [];

                // синхронизируем вкладки, пытаемся найти вкладки что есть в группе чтоб не создавать заново
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

                await Promise.all(group.tabs.filter(tab => !tab.id).map(async function(tab) {
                    let newTab = await createTab({
                        active: Boolean(tab.active),
                        url: tab.url,
                        title: tab.title,
                        windowId: win.id,
                        cookieStoreId: tab.cookieStoreId,
                    });

                    win.tabs.push(newTab);

                    tab.id = newTab.id;
                }));

                // add loading tabs to current group
                if (loadingRawTabs[win.id].length) {
                    let tabsToConcatWithGroupTabs = loadingRawTabs[win.id].filter(tab => !group.tabs.some(t => t.id === tab.id));

                    if (tabsToConcatWithGroupTabs.length) {
                        // group.tabs = group.tabs.concat(tabsToConcatWithGroupTabs.map(mapTab));
                        group.tabs.push.apply(group.tabs, tabsToConcatWithGroupTabs);

                        let loadedActiveTab = tabsToConcatWithGroupTabs.find(tab => tab.active);

                        if (loadedActiveTab) {
                            group.tabs.forEach(tab => tab.active = tab.id === loadedActiveTab.id);
                        }
                    }
                }

                await showHideAndSortTabsInWindow(win, group.tabs);
            }));
        }

        async function showHideAndSortTabsInWindow(win, groupTabs) {
            let tabsToShow = [],
                tabsToHide = [],
                groupTabsIds = groupTabs.map(utils.keyId);

            win.tabs.forEach(function(winTab) {
                if (groupTabsIds.includes(winTab.id)) {
                    if (utils.isTabHidden(winTab)) {
                        tabsToShow.push(winTab);
                    } else {
                        // do nothing: tab found and it's visible
                    }
                } else {
                    if (utils.isTabVisible(winTab)) {
                        tabsToHide.push(winTab);
                    } else {
                        // do nothing: tab not found in group and it's hidden
                    }
                }
            });

            if (tabsToShow.length) {
                await browser.tabs.show(tabsToShow.map(utils.keyId));
            }

            let pinnedTabs = cache.getPinnedTabs(win.id);

            await browser.tabs.move(groupTabsIds, {
                windowId: win.id,
                index: pinnedTabs.length,
            });

            if (tabsToHide.length) {
                let tmpTab = null,
                    activeTab = groupTabs.find(tab => tab.active);

                if (activeTab) {
                    if (win.tabs.some(winTab => winTab.id === activeTab.id && !winTab.active)) {
                        await setTabActive(activeTab.id);
                    }
                } else if (tabsToHide.some(tab => tab.active)) {
                    tmpTab = await createTempActiveTab(win.id, false);
                }

                await browser.tabs.hide(tabsToHide.map(utils.keyId));

                if (tmpTab) {
                    await browser.tabs.remove(tmpTab.id);
                }
            }
        }

        // find all tabs in group and in window and sync this tabs
        let missedGroupsForSync = data.groups.filter(gr => !gr.windowId && gr.tabs.length),
            syncedTabsIds = data.groups.reduce((acc, gr) => acc.concat(gr.tabs.map(utils.keyId)), []).filter(Boolean);

        for (let group of missedGroupsForSync) {
            for (let win of windows) {
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
                    syncedTabsIds.push.apply(syncedTabsIds, tempSyncedTabIds);

                    if (!win.session.groupId) { // sync group with window if all tabs found but window was not synchronized
                        group.windowId = win.id;
                        win.session.groupId = group.id;

                        cache.setWindowGroup(win.id, group.id);

                        await showHideAndSortTabsInWindow(win, group.tabs);
                    }

                    break;
                } else {
                    // if not found all tabs - clear tab ids
                    group.tabs.forEach(tab => tab.id = null);
                }
            }
        }

        // sync other tabs by max tab matches in window
        data.groups
                .filter(gr => !gr.windowId && gr.tabs.length)
                .forEach(function(group) {
                    let tabsMatches = {}; // matches: win tabs

                    windows.forEach(function(win) {
                        let tempSyncedTabIds = [];

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



        // NEW ============================================================================================
        // complete migration for version below 4
        windows.sort(utils.sortBy('id'));

        // let mainWindow = windows[0],
        //     tempTabs = {}; // windowId: tab   if tab null => no create another tab

        data.groups = await Promise.all(data.groups.map(async function(group) {
            let win = windows.find(w => w.session.groupId === group.id),
                windowId = (win && win.id) || windows[0].id;
                // windowId = groupWindowId || mainWindow.id;

            // create temp tabs
            // if (!tempTabs[windowId] && null !== tempTabs[windowId]) {
            //     let tempTab = await createTempActiveTab(windowId);
            //     tempTabs[windowId] = tempTab || null;
            // }

            await Promise.all(group.tabs.map(async function(tab) {
                if (tab.id) {
                    // tab = await browser.tabs.get(tab.id);
                    cache.setTabGroup(tab.id, group.id);
                    // tab = addTabSessio(tab);
                } else {
                    await createTab({
                        title: tab.title,
                        url: tab.url,
                        cookieStoreId: tab.cookieStoreId,
                        windowId: windowId,
                        groupId: group.id,
                    });
                }

                // if (utils.isTabVisible(tab)) {
                //     await browser.tabs.hide(tab.id);
                // }

                // return tab;
            }));

            // group.tabs = []; // TODO ?

            return group;
        }));

        // need set active tab
        // await Promise.all(windows.map(function(win) {
        //     let group = data.groups.find(gr => gr.id === win.session.groupId);

        //     if (group) {
        //         return setLastActiveTab(group.tabs);
        //     }
        // }));

        // need remove tempTabs
        // for (let tab of tempTabs) {
        //     tab && browser.tabs.remove(tab.id);
        // }

        // await browser.tabs.remove(
        //     Object
        //         .values(tempTabs)
        //         .filter(Boolean)
        //         .map(tab => tab.id)
        //     ).catch(noop);

        // TODO need delete group.windowId

        delete data.withoutSession;

        windows = await loadAllWindows(true);
    }

    await Promise.all(windows.map(async function(win) {
        if (win.session.groupId) {
            let tabIdsToHide = win.tabs.filter(tab => tab.session.groupId !== win.session.groupId).map(utils.keyId),
                tabsToShow = win.tabs.filter(tab => tab.session.groupId === win.session.groupId),
                activeTab = null;

            if (tabsToShow.length) {
                await browser.tabs.show(tabsToShow.map(utils.keyId));
                activeTab = await setTabActive(null, tabsToShow);
            }

            if (tabIdsToHide.length) {
                let tempTab = null;

                if (!activeTab) {
                    tempTab = await createTempActiveTab(win.id);
                }

                await browser.tabs.hide(tabIdsToHide);

                if (tempTab) {
                    browser.tabs.remove(tempTab.id);
                }
            }
        }
    }));




    // OLD code ============================

    _groups = data.groups;

    _thumbnails = data.thumbnails;

    await storage.remove(['doRemoveSTGNewTabUrls', 'withoutSession']);
    // await storage.clear(); TODO
    await storage.set(data);

    resetAutoBackup();

    windows.forEach(win => updateBrowserActionData(cache.getWindowSession(win.id).groupId));

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
