import Logger from './logger.js';
import backgroundSelf from './background.js';
import * as Constants from './constants.js';
import * as Urls from './urls.js';
import * as Utils from './utils.js';
import * as Cache from './cache.js';
import * as Containers from './containers.js';
import * as Management from './management.js';
import * as Groups from './groups.js';
import * as Windows from './windows.js';

const logger = new Logger('Tabs');

export async function createNative({url, active, pinned, title, index, windowId, openerTabId, cookieStoreId, newTabContainer, ifDifferentContainerReOpen, excludeContainersForReOpen, groupId, favIconUrl, thumbnail}) {
    const tab = {};

    if (url) {
        if (Utils.isUrlAllowToCreate(url)) {
            if (url.startsWith('moz-extension')) {
                const uuid = Management.extractUUID(url);

                if (Management.isUUID(uuid)) {
                    tab.url = url;
                } else {
                    tab.url = Urls.HELP_PAGE_UNSUPPORTED_URL + '#' + url;
                }
            } else {
                tab.url = url;
            }
        } else if (url !== 'about:newtab') {
            tab.url = Urls.HELP_PAGE_UNSUPPORTED_URL + '#' + url;
        }
    }

    tab.active = !!active;

    if (pinned) {
        tab.pinned = true;
    }

    if (!tab.active && !tab.pinned && tab.url && !tab.url.startsWith('about:')) {
        tab.discarded = true;
    }

    if (tab.discarded && title) {
        tab.title = title;
    }

    if (Number.isSafeInteger(index) && index >= 0) {
        tab.index = index;
    }

    windowId = Cache.getWindowId(groupId) || windowId;

    if (Number.isSafeInteger(windowId) && windowId >= 1) {
        tab.windowId = windowId;
    }

    if (Number.isSafeInteger(openerTabId) && openerTabId >= 1) {
        tab.openerTabId = openerTabId;
    }

    tab.cookieStoreId = cookieStoreId || Constants.DEFAULT_COOKIE_STORE_ID;

    tab.cookieStoreId = getNewTabContainer(tab, {newTabContainer, ifDifferentContainerReOpen, excludeContainersForReOpen});

    if (tab.cookieStoreId === Constants.TEMPORARY_CONTAINER) {
        tab.cookieStoreId = await Containers.createTemporaryContainer();
    } else {
        tab.cookieStoreId = Containers.get(tab.cookieStoreId, 'cookieStoreId', true);
    }

    const newTab = await browser.tabs.create(tab);

    Cache.setTab(newTab);

    Cache.applySession(newTab, {groupId, favIconUrl, thumbnail});

    logger.log('createNative', newTab);

    return newTab;
}

export async function create(tab) {
    backgroundSelf.groupIdForNextTab = tab.groupId;

    backgroundSelf.skipCreateTab = true;

    const newTab = await createNative(tab);

    backgroundSelf.skipCreateTab = false;

    backgroundSelf.groupIdForNextTab = null;

    return Cache.setTabSession(newTab);
}

export async function createUrlOnce(url, windowId) {
    const [tab] = await get(windowId, null, null, {url});

    if (tab) {
        return setActive(tab.id);
    } else {
        return createNative({
            active: true,
            url,
            windowId,
        });
    }
}

export async function setActive(tabId = null, tabs = []) {
    const log = logger.start('setActive', tabId, 'from tabs:', tabs.map(extractId));

    let tabToActive = null;

    if (tabId) {
        tabToActive = tabs.find(tab => tab.id === tabId) || {
            id: tabId,
        };
    } else if (tabs.length) { // find lastAccessed tab
        let maxLastAccessed = Math.max(...tabs.map(tab => tab.lastAccessed));

        tabToActive = tabs.find(tab => tab.lastAccessed === maxLastAccessed);
    }

    if (tabToActive) {
        tabs.forEach(tab => tab.active = tab.id === tabToActive.id);

        await browser.tabs.update(tabToActive.id, {
            active: true,
        }).catch(log.onCatch(tabToActive.id));
    }

    return log.stop(tabToActive);
}

export async function getActive(windowId = browser.windows.WINDOW_ID_CURRENT) {
    const [activeTab] = await get(windowId, null, null, {
        active: true,
    });

    return activeTab;
}

export async function getHighlightedIds(windowId = browser.windows.WINDOW_ID_CURRENT, clickedTab = null, pinned = false) {
    let tabs = await get(windowId, pinned, false, {
        highlighted: true,
    });

    if (clickedTab && !tabs.some(tab => tab.id === clickedTab.id)) { // if clicked tab not in selected tabs - add it
        tabs.push(clickedTab);

        if (2 === tabs.length) {
            tabs = tabs.filter(tab => tab.active ? (tab.id === clickedTab.id) : true); // exclude active tab if need to move another tab
        }
    }

    return tabs.map(extractId);
}

export async function get(
        windowId = browser.windows.WINDOW_ID_CURRENT,
        pinned = false,
        hidden = false,
        otherProps = {},
        includeFavIconUrl = false,
        includeThumbnail = false
    ) {
    const query = {
        windowId,
        pinned,
        hidden,
        windowType: browser.windows.WindowType.NORMAL,
        ...otherProps,
    };

    for (const key in query) {
        if (query[key] == null) {
            delete query[key];
        }
    }

    const log = logger.start('get', query);

    let tabs = await browser.tabs.query(query);

    if (!query.pinned) {
        tabs = await Promise.all(
            tabs.map(tab => Cache.loadTabSession(Utils.normalizeTabUrl(tab), includeFavIconUrl, includeThumbnail))
        );
    }

    tabs = tabs.filter(Boolean);

    log.stop('found tabs count:', tabs.length);
    return tabs;
}

export async function getOne(id) {
    try {
        let tab = await browser.tabs.get(id);
        return Utils.normalizeTabUrl(tab);
    } catch (e) {
        return null;
    }
}

export async function getList(tabIds, includeFavIconUrl, includeThumbnail) {
    let tabs = await Promise.all(tabIds.map(id => {
        return browser.tabs.get(id)
            .then(tab => Cache.loadTabSession(Utils.normalizeTabUrl(tab), includeFavIconUrl, includeThumbnail))
            .catch(() => {});
    }));

    return tabs.filter(Boolean);
}

export async function createTempActiveTab(windowId, createPinnedTab = true, newTabUrl) {
    const log = logger.start('createTempActiveTab', {windowId, createPinnedTab, newTabUrl});

    let pinnedTabs = await get(windowId, true, null);

    if (pinnedTabs.length) {
        if (!pinnedTabs.some(tab => tab.active)) {
            await setActive(Utils.getLastActiveTab(pinnedTabs).id);
            log.stop('setActive pinned');
        } else log.stop('pinned is active');
    } else {
        const tempTab = await createNative({
            url: createPinnedTab ? (newTabUrl || 'about:blank') : (newTabUrl || 'about:newtab'),
            pinned: createPinnedTab,
            active: true,
            windowId: windowId,
        });
        log.stop('created temp tab', tempTab);
        return tempTab;
    }
}

export async function add(groupId, cookieStoreId, url, title) {
    const log = logger.start('add', {groupId, cookieStoreId, url, title});
    let {group} = await Groups.load(groupId),
        [tab] = await backgroundSelf.createTabsSafe([{
            url,
            title,
            cookieStoreId,
            ...Groups.getNewTabParams(group),
        }]);

    return log.stop(), tab;
}

export async function updateThumbnail(tabId) {
    if (!backgroundSelf.options.showTabsWithThumbnailsInManageGroups) {
        return;
    }

    let tab = await getOne(tabId);

    if (!tab) {
        return;
    }

    if (!Utils.isTabLoaded(tab)) {
        return;
    }

    if (tab.discarded) {
        reload(tab.id);
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
                resolve(Utils.resizeImage(img, 192, Math.floor(img.width * 192 / img.height), false, 'image/jpeg', 0.7));
            };

            img.onerror = img.onabort = reject;

            img.src = thumbnailBase64;
        });

        await Cache.setTabThumbnail(tab.id, thumbnail);

        backgroundSelf.sendMessage('thumbnail-updated', {
            tabId: tab.id,
            thumbnail: thumbnail,
        });
    } catch (e) {}
}

export async function move(tabIds, groupId, {
        newTabIndex: newTabIndex = -1,
        showTabAfterMovingItIntoThisGroup: showTabAfterMovingItIntoThisGroup = false,
        showOnlyActiveTabAfterMovingItIntoThisGroup: showOnlyActiveTabAfterMovingItIntoThisGroup = false,
        showNotificationAfterMovingTabIntoThisGroup: showNotificationAfterMovingTabIntoThisGroup = false,
    } = {}) {
    const log = logger.start('move', {groupId}, {
        newTabIndex,
        showTabAfterMovingItIntoThisGroup,
        showOnlyActiveTabAfterMovingItIntoThisGroup,
        showNotificationAfterMovingTabIntoThisGroup,
    }, tabIds);

    let tabs = await getList(tabIds.slice());

    if (tabs.length) {
        tabIds = tabs.map(extractId);
    } else {
        log.stop('tabs are empty');
        return [];
    }

    backgroundSelf.addExcludeTabIds(tabIds);

    let showPinnedMessage = false,
        tabsCantHide = new Set,
        groupWindowId = Cache.getWindowId(groupId),
        {group} = await Groups.load(groupId, !groupWindowId),
        windowId = groupWindowId || (group.tabs[0]?.windowId) || await Windows.getLastFocusedNormalWindow(),
        activeTabs = [];

    log.log('vars', {groupWindowId, windowId});
    log.log('filter active');

    tabs = tabs.filter(function(tab) {
        if (tab.pinned) {
            showPinnedMessage = true;
            backgroundSelf.excludeTabIds.delete(tab.id);
            log.log('tab pinned', tab);
            return false;
        }

        if (Utils.isTabCanNotBeHidden(tab)) {
            tabsCantHide.add(getTitle(tab, false, 20));
            backgroundSelf.excludeTabIds.delete(tab.id);
            log.log('cant move tab', tab);
            return false;
        }

        if (tab.active && tab.groupId !== groupId) {
            activeTabs.push(tab);
        }

        return true;
    });

    log.log('active tabs', activeTabs, 'tabs to move COUNT:', tabs.length);

    if (tabs.length) {
        const excludeMovingTabs = tab => !tabs.some(t => t.id === tab.id);

        await Promise.all(activeTabs.map(async function(activeTab) {
            let allTabsInActiveTabWindow = await get(activeTab.windowId, null, null),
                tabsToActive = allTabsInActiveTabWindow.filter(tab => !tab.hidden && excludeMovingTabs(tab));

            if (tabsToActive.length) {
                log.log('set active some other');
                await setActive(undefined, tabsToActive);
            } else { // if not found other visible (include pinned) tabs in window
                let differentWindows = activeTab.windowId !== windowId,
                    otherHiddenAndVisibleTabsInActiveTabWindow = allTabsInActiveTabWindow.filter(excludeMovingTabs),
                    activeTabIsLastInSrcGroup = false,
                    activeTabIsInLoadedGroup = false,
                    activeTabNotInGroup = false;

                if (activeTab.groupId) {
                    activeTabIsLastInSrcGroup = !otherHiddenAndVisibleTabsInActiveTabWindow
                        .some(tab => tab.groupId === activeTab.groupId);

                    activeTabIsInLoadedGroup = activeTab.groupId === Cache.getWindowGroup(activeTab.windowId);
                } else {
                    activeTabNotInGroup = !Cache.getWindowGroup(activeTab.windowId);
                }

                log.log('create condition', {
                    differentWindows,
                    otherHiddenAndVisibleTabsInActiveTabWindow,
                    activeTabIsLastInSrcGroup,
                    activeTabIsInLoadedGroup,
                    activeTabNotInGroup,
                });

                if (
                    (differentWindows && !otherHiddenAndVisibleTabsInActiveTabWindow.length) ||
                    (activeTabIsLastInSrcGroup && activeTabIsInLoadedGroup) ||
                    (activeTabNotInGroup)
                ) {
                    log.log('create temp')
                    await createTempActiveTab(activeTab.windowId, false);
                }
            }
        }));
        activeTabs = [];

        let tabIdsToRemove = [],
            newTabParams = Groups.getNewTabParams(group);

        backgroundSelf.groupIdForNextTab = group.id;

        backgroundSelf.skipCreateTab = true;

        tabs = await Promise.all(tabs.map(async function(tab) {
            let newTabContainer = getNewTabContainer(tab, group);

            if (tab.cookieStoreId === newTabContainer) {
                if (tab.active) {
                    activeTabs.push(tab);
                }
                return tab;
            } else {
                tab.cookieStoreId = newTabContainer;
            }

            log.log('create new tab with newTabContainer', newTabContainer);

            tabIdsToRemove.push(tab.id);

            let newTab = await createNative({
                ...tab,
                ...Cache.getTabSession(tab.id), // apply session, because we can move tab from onBeforeTabRequest
                active: false,
                openerTabId: null,
                windowId,
                ...newTabParams,
            });

            if (tab.active) {
                activeTabs.push({...newTab, active: true});
            }

            tabIds.push(newTab.id);
            backgroundSelf.excludeTabIds.add(newTab.id);

            return Cache.setTabSession(newTab);
        }));

        backgroundSelf.skipCreateTab = false;

        backgroundSelf.groupIdForNextTab = null;

        await remove(tabIdsToRemove);

        tabs = await moveNative(tabs, {
            index: newTabIndex,
            windowId,
        });

        if (groupWindowId) {
            await show(tabs.filter(tab => tab.hidden));
        } else {
            await hide(tabs.filter(tab => !tab.hidden));
        }

        await Promise.all(tabs.map(tab => Cache.setTabGroup(tab.id, groupId)));

        backgroundSelf.removeExcludeTabIds(tabIds);

        backgroundSelf.sendMessage('groups-updated');

        log.log('end moving');
    }

    if (showPinnedMessage) {
        log.log('notify pinnedTabsAreNotSupported')
        Utils.notify(['pinnedTabsAreNotSupported']);
    }

    if (tabsCantHide.size) {
        log.log('notify thisTabsCanNotBeHidden')
        Utils.notify(['thisTabsCanNotBeHidden', Array.from(tabsCantHide).join(', ')]);
    }

    if (!tabs.length) {
        log.stop('empty tabs');
        return [];
    }

    let [firstTab] = activeTabs.length ? activeTabs : tabs;

    if (showTabAfterMovingItIntoThisGroup) {
        if (showOnlyActiveTabAfterMovingItIntoThisGroup) {
            if (activeTabs.length) {
                log.log('applyGroup', windowId, groupId, firstTab.id)
                await backgroundSelf.applyGroup(windowId, groupId, firstTab.id);
                showNotificationAfterMovingTabIntoThisGroup = false;
            }
        } else {
            log.log('applyGroup 2', windowId, groupId, firstTab.id)
            await backgroundSelf.applyGroup(windowId, groupId, firstTab.id);
            showNotificationAfterMovingTabIntoThisGroup = false;
        }
    }

    if (!showNotificationAfterMovingTabIntoThisGroup) {
        log.stop(tabs, 'no notify');
        return tabs;
    }

    let message = [],
        iconUrl = null;

    if (tabs.length > 1) {
        message = ['moveMultipleTabsToGroupMessage', tabs.length];
        iconUrl = Groups.getIconUrl(group);
    } else {
        let tabTitle = getTitle(firstTab, false, 50);
        message = ['moveTabToGroupMessage', [group.title, tabTitle]];
        firstTab = Utils.normalizeTabFavIcon(firstTab);
        iconUrl = firstTab.favIconUrl;
    }

    Utils.notify(message, undefined, undefined, iconUrl, async function(groupId, tabId) {
        let {group} = await Groups.load(groupId),
            tab = await getOne(tabId);

        if (group && tab) {
            let winId = Cache.getWindowId(groupId) || await Windows.getLastFocusedNormalWindow();

            winId && backgroundSelf.applyGroup(winId, groupId, tabId).catch(log.onCatch(['applyGroup from notif', winId, groupId, tabId]));
        }
    }.bind(null, groupId, firstTab.id));

    log.stop(tabs, 'with notify');
    return tabs;
}

async function filterExist(tabs, returnTabIds = false) {
    const tabIds = tabs.map(extractId);
    const log = logger.start('filterExist', tabIds, {returnTabIds});

    let lengthBefore = tabIds.length,
        returnFunc = returnTabIds ? t => t.id : t => t;

    tabs = await Promise.all(tabs.map(tab => {
        return browser.tabs.get(extractId(tab))
            .then(returnFunc, log.onCatch(['not found tab', tab], false));
    }));
    tabs = tabs.filter(Boolean);

    log.assert(lengthBefore === tabs.length, 'tabs length after filter are not equal. not found tabs:',
        tabIds.filter(tabId => !tabs.some(tab => tab.id === tabId)));

    log.stop();
    return tabs;
}

export async function moveNative(tabs, moveProperties = {}) {
    let tabIds = tabs.map(extractId),
        openerTabIds = [];

    const log = logger.start('moveNative', {moveProperties}, tabIds);

    if (moveProperties.windowId) { // try fix bug when tab lose it's openerTabId after moving between windows
        tabs = await filterExist(tabIds);
        openerTabIds = tabs.map(tab => tab.openerTabId);
        tabIds = tabs.map(extractId);
    } else {
        tabIds = await filterExist(tabIds, true);
    }

    if (!tabIds.length) {
        log.stop('tabs are empty');
        return [];
    }

    let movedTabs = await browser.tabs.move(tabIds, moveProperties).catch(log.onCatch(['move', tabIds])),
        movedTabsObj = Utils.arrayToObj(movedTabs, 'id'),
        movedTabIdsSet = new Set(tabIds);

    log.stop(tabIds);
    return tabs
        .map(function(tab, index) {
            if (!movedTabIdsSet.has(tab.id)) {
                return;
            }

            if (moveProperties.windowId) {
                tab.windowId = moveProperties.windowId;
                // Tabs moved across windows always lose their openerTabId even
                // if it is also moved to the same window together, thus we need
                // to restore it manually.
                // https://github.com/piroor/treestyletab/issues/2546#issuecomment-733488187
                if (openerTabIds[index] > 0) {
                    tab.openerTabId = openerTabIds[index];
                    browser.tabs.update(tab.id, {
                        openerTabId: tab.openerTabId,
                    }).catch(() => {});
                }
            }

            if (movedTabsObj[tab.id]) {
                tab.index = movedTabsObj[tab.id].index;
            }

            return tab;
        })
        .filter(Boolean);
}

export async function setMute(tabs, muted) {
    const tabIds = tabs.map(extractId);
    muted = !!muted;
    const log = logger.start('setMute', tabIds, 'muted:', muted);

    tabs = await getList(tabIds);

    await Promise.all(
        tabs
        .filter(tab => muted ? tab.audible : tab.mutedInfo.muted)
        .map(tab =>
            browser.tabs.update(tab.id, {muted})
                .catch(log.onCatch(['mute tab', tab], false))
        )
    );

    log.stop();
}

export async function remove(...tabs) { // id or ids or tabs
    tabs = tabs.flat();

    if (tabs.length) {
        const log = logger.start('remove', tabs.map(extractId));

        await Promise.all(tabs.map(tab =>
            browser.tabs.remove(extractId(tab))
                .catch(log.onCatch(['remove tab', tab], false))
        ));

        log.stop();
    }
}

async function browserTabs(funcName, tabs, log) {
    const tabIds = tabs.map(extractId);

    try {
        await browser.tabs[funcName](tabIds);
    } catch (e) {
        log.logError(e.message, e);

        log.warn(funcName, 'tabs one by one', tabIds);

        await Promise.all(tabs.map(tab =>
            browser.tabs[funcName](extractId(tab))
                .catch(log.onCatch([funcName, 'tab', tab], false))
        ));
    }
}

export async function show(...tabs) {
    tabs = tabs.flat();

    if (tabs.length) {
        const log = logger.start('show', tabs.map(extractId));

        await browserTabs('show', tabs, log);

        log.stop();
    }
}

export async function hide(...tabs) {
    tabs = tabs.flat();

    if (tabs.length) {
        const log = logger.start('hide', tabs.map(extractId));

        await browserTabs('hide', tabs, log);

        log.stop();
    }
}

export async function safeHide(...tabs) { // ids or tabs
    tabs = tabs.flat();

    if (tabs.length) {
        let tabIds = tabs.map(extractId);

        const log = logger.start('safeHide', tabIds);

        backgroundSelf.addExcludeTabIds(tabIds);
        await hide(tabIds);
        backgroundSelf.removeExcludeTabIds(tabIds);

        log.stop();
    }
}

export async function discard(...tabs) { // ids or tabs
    tabs = tabs.flat();

    if (tabs.length) {
        const log = logger.start('discard', tabs.map(extractId));

        await Promise.all(tabs.map(tab =>
            browser.tabs.discard(extractId(tab))
                .catch(log.onCatch(['discard tab', tab], false))
        ));

        log.stop();
    }
}

export async function reload(tabs, bypassCache = false) { // ids or tabs
    tabs = [tabs].flat();

    if (tabs.length) {
        const log = logger.start('reload', tabs.map(extractId));

        await Promise.all(tabs.map(tab =>
            browser.tabs.reload(extractId(tab), {bypassCache})
                .catch(log.onCatch(['reload tab', tab], false))
        ));

        log.stop();
    }
}

const extensionsWebextensionsRestrictedDomains = ['accounts-static.cdn.mozilla.net', 'accounts.firefox.com', 'addons.cdn.mozilla.net', 'addons.mozilla.org', 'api.accounts.firefox.com', 'content.cdn.mozilla.net', 'discovery.addons.mozilla.org', 'install.mozilla.org', 'oauth.accounts.firefox.com', 'profile.accounts.firefox.com', 'support.mozilla.org', 'sync.services.mozilla.com'];

export function isCanSendMessage({url}) {
    if (url === 'about:blank') {
        return true;
    }

    if (url.startsWith('moz-extension') || url.startsWith('about:')) {
        return false;
    }

    return !extensionsWebextensionsRestrictedDomains.some(host => (new RegExp('^https?://' + host).test(url)));
}

export function extractId(tab) {
    return tab.id || tab;
}

export function sendMessage(tabId, message) {
    message.theme = backgroundSelf.options.theme;

    return browser.tabs.sendMessage(tabId, message).catch(() => {});
}

export function prepareForSave(tabs, ...prepareArgs) {
    return tabs.map(tab => prepareForSaveTab(tab, ...prepareArgs));
}

export function prepareForSaveTab(
        {id, url, title, cookieStoreId, favIconUrl, openerTabId, groupId, thumbnail, lastAccessed},
        includeGroupId = false,
        includeFavIconUrl = false,
        includeThumbnail = false,
        includeId = true,
        includeLastAccessed = true
    ) {
    const tab = {url};

    if (includeId && id) {
        tab.id = id;

        if (openerTabId) {
            tab.openerTabId = openerTabId;
        }
    }

    if (title) {
        tab.title = title;
    }

    if (!Containers.isDefault(cookieStoreId)) {
        tab.cookieStoreId = Containers.isTemporary(cookieStoreId) ? Constants.TEMPORARY_CONTAINER : cookieStoreId;
    }

    if (includeGroupId && groupId) {
        tab.groupId = groupId;
    }

    if (includeFavIconUrl && favIconUrl?.startsWith('data:')) {
        tab.favIconUrl = favIconUrl;
    }

    if (includeThumbnail && thumbnail) {
        tab.thumbnail = thumbnail;
    }

    if (includeLastAccessed && lastAccessed) {
        tab.lastAccessed = lastAccessed;
    }

    return tab;
}

export function getNewTabContainer(
        {url, cookieStoreId, status},
        {newTabContainer = Constants.DEFAULT_COOKIE_STORE_ID, ifDifferentContainerReOpen, excludeContainersForReOpen = []}
    ) {

    if (cookieStoreId === newTabContainer || Containers.isTemporary(cookieStoreId)) {
        return cookieStoreId;
    }

    if (url && !url.startsWith('http') && !url.startsWith('ftp') && status !== browser.tabs.TabStatus.LOADING) {
        return Constants.DEFAULT_COOKIE_STORE_ID;
    }

    if (ifDifferentContainerReOpen) {
        return excludeContainersForReOpen.includes(cookieStoreId) ? cookieStoreId : newTabContainer;
    }

    return Containers.isDefault(cookieStoreId) ? newTabContainer : cookieStoreId;
}

export function getTitle({id, index, title, url, discarded, windowId, lastAccessed}, withUrl = false, sliceLength = 0, withActiveTab = false) {
    title = title || url || 'about:blank';

    if (withUrl && url && title !== url) {
        title += '\n' + url;
    }

    if (withActiveTab && id) {
        title = (discarded ? Constants.DISCARDED_SYMBOL : Constants.ACTIVE_SYMBOL) + ' ' + title;
    }

    if (backgroundSelf.storage.enableDebug && id) {
        let lastDate = new Date(lastAccessed);

        if (lastDate.getTime()) {
            lastDate = `(${lastDate.getMinutes()}:${lastDate.getSeconds()}.${lastDate.getMilliseconds()})${title}`;
        } else {
            lastDate = '';
        }

        title = `@${windowId}:#${id}:i${index} ${lastDate} ${title}`;
    }

    return sliceLength ? Utils.sliceText(title, sliceLength) : title;
}
