'use strict';

import constants from './constants';
import storage from './storage';
import utils from './utils';
import Groups from './groups';
import Windows from './windows';

const newTabKeys = ['active', 'cookieStoreId', /*'index', */'discarded', 'title', 'openInReaderMode', 'pinned', 'url', 'windowId'];

async function create(tab) {
    const {BG} = browser.extension.getBackgroundPage();

    console.log('create tab', utils.clone(tab));

    let {groupId, thumbnail, favIconUrl} = tab;

    if (!tab.url || !utils.isUrlAllowToCreate(tab.url)) {
        delete tab.url;
    }

    if (!tab.active) {
        tab.active = false;
    }

    if (!tab.active && tab.url && !utils.isUrlEmpty(tab.url)) {
        tab.discarded = true;
    }

    if (tab.active || !tab.discarded) {
        delete tab.title;
    }

    // if (!Number.isFinite(tab.index) || 0 > tab.index) { // index not need ?
    //     delete tab.index;
    // }

    if (!Number.isFinite(tab.windowId) || 1 > tab.windowId || !BG.cache.hasWindow(tab.windowId)) {
        delete tab.windowId;
    }

    if ('cookieStoreId' in tab) {
        tab.cookieStoreId = BG.containers.get(tab.cookieStoreId, 'cookieStoreId');
    }

    if (tab.isInReaderMode) {
        tab.openInReaderMode = true;
    }

    Object.keys(tab).forEach(key => !newTabKeys.includes(key) && (delete tab[key]));

    let newTab = await browser.tabs.create(tab);

    if (groupId) {
        BG.cache.setTabGroup(newTab.id, groupId);
    }

    if (thumbnail) {
        BG.cache.setTabThumbnail(newTab.id, thumbnail);
    }

    if (favIconUrl) {
        BG.cache.setTabFavIcon(newTab.id, favIconUrl);
    }

    newTab.session = BG.cache.getTabSession(newTab.id);

    if (newTab.session.groupId) {
        BG.sendMessage({
            action: 'tab-added',
            tab: newTab,
        });
    }

    return newTab;
}

async function setActive(tabId, tabs) {
    let tabToActive = null;

    if (tabId) {
        tabToActive = Array.isArray(tabs) ? tabs.find(tab => tab.id === tabId) : {
            id: tabId,
        };
    } else if (Array.isArray(tabs) && tabs.length) { // find lastAccessed tab
        let lastAccessedTimes = tabs.map(tab => tab.lastAccessed),
            maxLastAccessed = Math.max(...lastAccessedTimes);

        tabToActive = tabs.find(tab => tab.lastAccessed === maxLastAccessed);
    }

    if (tabToActive) {
        Array.isArray(tabs) && tabs.forEach(tab => tab.active = tab.id === tabToActive.id);

        await browser.tabs.update(tabToActive.id, {
            active: true,
        });
    }

    return tabToActive;
}

async function getActive(windowId = browser.windows.WINDOW_ID_CURRENT) {
    const {BG} = browser.extension.getBackgroundPage();

    let [activeTab] = await browser.tabs.query({
        active: true,
        windowId: windowId,
    });

    return activeTab ? BG.cache.loadTabSession(activeTab) : null;
}

async function getHighlighted(windowId = browser.windows.WINDOW_ID_CURRENT, clickedTab = null) {
    const {BG} = browser.extension.getBackgroundPage();

    let tabs = await browser.tabs.query({
        pinned: false,
        hidden: false,
        highlighted: true,
        windowId: windowId,
    });

    if (clickedTab && !tabs.some(tab => tab.id === clickedTab.id)) { // if clicked tab not in selected tabs - add it
        tabs.push(clickedTab);

        if (2 === tabs.length) {
            tabs = tabs.filter(tab => tab.active ? (tab.id === clickedTab.id) : true); // exclude active tab if need to move another tab
        }
    }

    // return Promise.all(tabs.map(BG.cache.loadTabSession));
    return tabs.filter(BG.cache.filterRemovedTab);
}

async function get(windowId = browser.windows.WINDOW_ID_CURRENT, pinned = false, hidden = false) {
    const {BG} = browser.extension.getBackgroundPage();

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

    tabs = tabs.filter(BG.cache.filterRemovedTab);

    return pinned ? tabs : Promise.all(tabs.map(BG.cache.loadTabSession));
}

async function setMute(tabs, muted) {
    return Promise.all(
        tabs
        .filter(tab => muted ? tab.audible : tab.mutedInfo.muted)
        .map(tab => browser.tabs.update(tab.id, {muted}))
    );
}

async function createTempActiveTab(windowId, createPinnedTab = true, newTabUrl) {
    const {BG} = browser.extension.getBackgroundPage();

    let pinnedTabs = await get(windowId, true, null);

    if (pinnedTabs.length) {
        if (!pinnedTabs.some(tab => tab.active)) {
            await setActive(pinnedTabs.sort(utils.sortBy('lastAccessed')).pop().id);
        }
    } else {
        newTabUrl = createPinnedTab ? (newTabUrl || 'about:blank') : (newTabUrl || 'about:newtab');

        return create({
            url: newTabUrl,
            pinned: createPinnedTab,
            active: true,
            windowId: windowId,
        });
    }
}

async function add(groupId, cookieStoreId, url, title, active = false) {
    const {BG} = browser.extension.getBackgroundPage();

    let windowId = BG.cache.getWindowId(groupId),
        [tab] = await BG.createTabsSafe([{
            url,
            title,
            active,
            cookieStoreId,
            groupId,
            windowId,
        }], !windowId);

    return tab;
}

async function remove({id, hidden, session}) {
    const {BG} = browser.extension.getBackgroundPage();

    // if (!hidden) { // TODO что делать?
    //     let groupWindowId = BG.cache.getWindowId(session.groupId);

    //     if (groupWindowId) {
    //         let [group] = await Groups.load(session.groupId, true);

    //         if (1 === group.tabs.length) {
    //             let pinnedTabs = await get(groupWindowId, true, null);

    //             if (!pinnedTabs.length) {
    //                 await create({
    //                     active: true,
    //                     windowId: groupWindowId,
    //                 });
    //             }
    //         }
    //     }
    // }

    await browser.tabs.remove(id);
}

async function updateThumbnail(tabId, force) {
    const {BG} = browser.extension.getBackgroundPage();

    let hasThumbnailsPermission = await browser.permissions.contains(constants.PERMISSIONS.ALL_URLS);

    if (!hasThumbnailsPermission) {
        return;
    }

    let tab = await browser.tabs.get(tabId);

    if (!utils.isTabLoaded(tab)) {
        return;
    }

    tab = await BG.cache.loadTabSession(tab);

    if (!force && tab.session.thumbnail) {
        return;
    }

    if (tab.discarded) {
        browser.tabs.reload(tab.id);
        return;
    }

    let thumbnail = null;

    try {
        let thumbnailBase64 = await browser.tabs.captureTab(tab.id, {
            format: browser.extensionTypes.ImageFormat.JPEG,
            quality: 25,
        });

        thumbnail = await new Promise(function(resolve, reject) {
            let img = new Image();

            img.onload = function() {
                resolve(utils.resizeImage(img, 192, Math.floor(img.width * 192 / img.height), false, 'image/jpeg', 0.7));
            };

            img.onerror = img.onabort = reject;

            img.src = thumbnailBase64;
        });
    } catch (e) {}

    BG.cache.setTabThumbnail(tab.id, thumbnail);

    BG.sendMessage({
        action: 'thumbnail-updated',
        tabId: tab.id,
        thumbnail: thumbnail,
    });
}

async function move(tabs, groupId, newTabIndex = -1, showNotificationAfterMoveTab = true, showTabAfterMoving = false) {
    // tabs = utils.clone(tabs);
    const {BG} = browser.extension.getBackgroundPage();

    console.info('moveTabs', {groupId, newTabIndex, showNotificationAfterMoveTab, showTabAfterMoving, tabs});
    // console.info('moveTabs tabs 0', tabs[0]);

    let showPinnedMessage = false,
        tabsCantHide = [],
        groupWindowId = BG.cache.getWindowId(groupId),
        windowId = groupWindowId,
        [group, groups] = await Groups.load(groupId, true),
        activeTabs = [];

    if (!windowId) {
        windowId = group.tabs.length ? group.tabs[0].windowId : await Windows.getLastFocusedNormalWindow();
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

        if (tab.active) {
            activeTabs.push(tab);
        }

        return true;
    });

    if (tabs.length) {
        let windows = activeTabs.length ? await Windows.load(true) : [];

        await Promise.all(activeTabs.map(function(tab) {
            let winGroupId = BG.cache.getWindowGroup(tab.windowId);

            if (winGroupId) {
                let groupTabs = groups.find(gr => gr.id === winGroupId).tabs.filter(t => t.id !== tab.id);

                if (groupTabs.length) {
                    return setActive(undefined, groupTabs);
                }
            } else {
                let win = windows.find(win => win.id === tab.windowId),
                    winTabs = win.tabs.filter(t => !t.hidden && t.id !== tab.id);

                if (winTabs.length) {
                    return setActive(undefined, winTabs);
                }
            }

            return createTempActiveTab(tab.windowId, false);
        }));

        let tabIds = tabs.map(utils.keyId);

        BG.addExcludeTabsIds(tabIds);

        tabs = await browser.tabs.move(tabIds, {
            index: newTabIndex,
            windowId,
        });

        if (groupWindowId) {
            let tabsToShow = tabs.filter(tab => tab.hidden);

            if (tabsToShow.length) {
                await browser.tabs.show(tabsToShow.map(utils.keyId));
            }
        } else {
            let tabsToHide = tabs.filter(tab => !tab.hidden);

            if (tabsToHide.length) {
                await browser.tabs.hide(tabsToHide.map(utils.keyId));
            }
        }

        BG.removeExcludeTabsIds(tabIds);

        await Promise.all(tabIds.map(tabId => BG.cache.setTabGroup(tabId, groupId)));

        BG.sendMessage({
            action: 'groups-updated',
        });
    }

    if (showPinnedMessage) {
        utils.notify(browser.i18n.getMessage('pinnedTabsAreNotSupported'));
    }

    if (tabsCantHide.length) {
        utils.notify(browser.i18n.getMessage('thisTabsCanNotBeHidden', tabsCantHide.join(', ')));
    }

    if (!tabs.length) {
        return [];
    }

    if (showTabAfterMoving) {
        await BG.applyGroup(windowId, groupId, tabs[0].id);
        // return;
    }

    if (!showNotificationAfterMoveTab || !BG.getOptions().showNotificationAfterMoveTab) {
        return tabs;
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
            let [group] = await Groups.load(groupId),
                tab = await browser.tabs.get(tabId).catch(function() {});

            if (group && tab) {
                let winId = BG.cache.getWindowId(groupId) || await Windows.getLastFocusedNormalWindow();

                BG.applyGroup(winId, groupId, tabId);
            }
        }.bind(null, groupId, tabs[0].id));

    return tabs;
}

async function sendMessage(tabId, message) {
    return browser.tabs.sendMessage(tabId, message).catch(function() {});
}

export default {
    create,
    setActive,
    getActive,
    getHighlighted,
    get,
    setMute,
    createTempActiveTab,
    add,
    remove,
    updateThumbnail,
    move,
    sendMessage,
};
