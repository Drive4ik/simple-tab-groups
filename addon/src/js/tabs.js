'use strict';

import constants from './constants';
import storage from './storage';
import utils from './utils';
import Groups from './groups';
import Windows from './windows';

const newTabKeys = ['active', 'cookieStoreId', 'index', 'discarded', 'title', 'openInReaderMode', 'pinned', 'url', 'windowId'];

async function create(tab, hideTab = false) {
    const {BG} = browser.extension.getBackgroundPage();

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

    // if (!Number.isFinite(tab.index) || 0 > tab.index) { // index not need ?
        delete tab.index;
    // }

    if (!Number.isFinite(tab.windowId) || 1 > tab.windowId || !BG.cache.getWindow(tab.windowId)) {
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

    BG.cache.setTab(newTab);

    newTab = await BG.cache.loadTabSession(newTab);

    if (!newTab.pinned) {
        if (hideTab) {
            await browser.tabs.hide(newTab.id);
            newTab.hidden = true;
        }

        if (groupId && groupId !== newTab.session.groupId) {
            BG.cache.setTabGroup(newTab.id, groupId);
        }

        if (newTab.session.groupId) {
            BG.sendMessage({
                action: 'tab-added',
                tab: newTab,
            });
        }
    }

    return newTab;
}

async function setActive(tabId, tabs) {
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
    return tabs;
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

    return pinned ? tabs : Promise.all(tabs.map(BG.cache.loadTabSession));
}

function getFavIconUrl({url, favIconUrl}) {
    const {BG} = browser.extension.getBackgroundPage();

    let safedFavIconUrl = '';

    if (BG.getOptions().useTabsFavIconsFromGoogleS2Converter) {
        safedFavIconUrl = utils.getFavIconFromUrl(url);
    }

    return safedFavIconUrl || favIconUrl || '/icons/tab.svg';
}

async function setMute(tabs, muted) {
    return Promise.all(
        tabs
        .filter(tab => muted ? tab.audible : tab.mutedInfo.muted)
        .map(tab => browser.tabs.update(tab.id, {muted}))
    );
}

async function createTempActiveTab(windowId, createPinnedTab = true, canUseExistsEmptyTab) {
    const {BG} = browser.extension.getBackgroundPage();

    let pinnedTabs = BG.cache.getPinnedTabs(windowId);

    if (pinnedTabs.length) {
        if (!pinnedTabs.some(tab => tab.active)) {
            await setActive(pinnedTabs.sort(utils.sortBy('lastAccessed')).pop().id);
        }
    } else {
        if (canUseExistsEmptyTab) {
            let tabs = await get(windowId);

            if (1 === tabs.length && utils.isUrlEmpty(tabs[0].url)) {
                return tabs[0];
            }
        }

        return create({
            url: 'about:blank',
            pinned: createPinnedTab,
            active: true,
            windowId: windowId,
        });
    }
}

async function add(groupId, cookieStoreId, url, title, active = false) {
    const {BG} = browser.extension.getBackgroundPage();

    let windowId = BG.cache.getWindowId(groupId);

    return BG.createTabsSafe([{
        url,
        title,
        active,
        cookieStoreId,
        groupId,
        windowId,
    }], !windowId);
}

async function remove({id, hidden, session}) {
    const {BG} = browser.extension.getBackgroundPage();

    if (!hidden) {
        let groupWindowId = BG.cache.getWindowId(session.groupId);

        if (groupWindowId && 1 === BG.cache.getTabs(session.groupId).length) {
            // let pinnedTabs = await getTabs(groupWindowId, true);
            let pinnedTabs = BG.cache.getPinnedTabs(groupWindowId);

            if (!pinnedTabs.length) {
                await create({
                    active: true,
                    windowId: groupWindowId,
                });
            }
        }
    }

    await browser.tabs.remove(id);
}

async function clearThumbnails() { // TODO
    // await storage.set({
    //     thumbnails: {},
    // });

    // _thumbnails = {};

    // sendMessage({
    //     action: 'thumbnails-updated',
    // });
}

async function updateThumbnail(tab, force = false) { // TODO
    return;



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
        // browser.extension.extensionTypes.ImageFormat.JPEG
        // browser.extension.extensionTypes.ImageFormat.PNG
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

    BG.sendMessage({
        action: 'thumbnail-updated',
        url: tabUrl,
        thumbnail: thumbnail,
    });

    await storage.set({
        thumbnails: _thumbnails,
    });
}

async function move(tabs, groupId, newTabIndex = -1, showNotificationAfterMoveTab = true, showTabAfterMoving = false) {
    // tabs = utils.clone(tabs);
    const {BG} = browser.extension.getBackgroundPage();

    console.info('moveTabs', {groupId, newTabIndex, showNotificationAfterMoveTab, showTabAfterMoving});
    // console.info('moveTabs tabs 0', tabs[0]);

    let showPinnedMessage = false,
        tabsCantHide = [],
        groupWindowId = BG.cache.getWindowId(groupId),
        windowId = groupWindowId,
        [group, groups] = await Groups.load(groupId, true),
        // group = groups.find(gr => gr.id === groupId),
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
        let tabIds = tabs.map(utils.keyId);

        await Promise.all(tabIds.map(tabId => BG.cache.setTabGroup(tabId, groupId)));

        let tempTabs = await Promise.all(activeTabs.map(tab => createTempActiveTab(tab.windowId)));

        BG.excludeTabsIds.push(...tabIds);

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

        BG.excludeTabsIds = BG.excludeTabsIds.filter(tabId => !tabIds.includes(tabId));

        tempTabs = tempTabs.filter(Boolean).map(utils.keyId);

        if (tempTabs.length) {
            browser.tabs.remove(tempTabs);
        }

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
        return;
    }

    if (showTabAfterMoving) {
        await BG.applyGroup(windowId, groupId, tabs[0].id);

        // return;
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
            let [group] = await Groups.load(groupId),
                tab = await browser.tabs.get(tabId).catch(noop);

            if (group && tab) {
                let winId = BG.cache.getWindowId(groupId) || await Windows.getLastFocusedNormalWindow();

                BG.applyGroup(winId, groupId, tabId);
            }
        }.bind(null, groupId, tabs[0].id));
}

export default {
    create,
    setActive,
    getActive,
    getHighlighted,
    get,
    getFavIconUrl,
    setMute,
    createTempActiveTab,
    add,
    remove,
    clearThumbnails,
    updateThumbnail,
    move,
};
