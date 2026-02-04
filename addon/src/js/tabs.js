
import './prefixed-storage.js';
import Logger from './logger.js';
import backgroundSelf from './background.js';
import Notification from './notification.js';
import * as Constants from './constants.js';
import * as Utils from './utils.js';
import * as Cache from './cache.js';
import * as Containers from './containers.js';
import * as Management from './management.js';
import * as Groups from './groups.js';
import * as Windows from './windows.js';
// import * as Storage from './storage.js';

const logger = new Logger('Tabs');

const mainStorage = localStorage.create(Constants.MODULES.BACKGROUND);

export async function create({url, active, pinned, title, index, windowId, openerTabId, cookieStoreId, newTabContainer, ifDifferentContainerReOpen, excludeContainersForReOpen, groupId, favIconUrl, thumbnail}, skipTracking = false) {
    if (!Constants.IS_BACKGROUND_PAGE) {
        throw Error('is not background');
    }

    const tab = {};

    if (url) {
        if (Utils.isUrlAllowToCreate(url)) {
            if (url.startsWith('moz-extension')) {
                const uuid = Management.extractUUID(url);

                if (Utils.isUUID(uuid)) {
                    tab.url = url;
                } else {
                    tab.url = Constants.PAGES.HELP.UNSUPPORTED_URL + '#' + url;
                }
            } else {
                tab.url = url;
            }
        } else if (url !== 'about:newtab') {
            tab.url = Constants.PAGES.HELP.UNSUPPORTED_URL + '#' + url;
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
        tab.cookieStoreId = Containers.get(tab.cookieStoreId).cookieStoreId;
    }

    const newTab = await browser.tabs.create(tab);

    if (skipTracking === true) {
        self.skipTabs.created.add(newTab.id);
    }

    delete newTab.groupId; // TODO temp

    await Cache.setTabSession(newTab, {groupId, favIconUrl, thumbnail});

    logger.log('create', newTab);

    return newTab;
}

export async function createUrlOnce(url) {
    let [tab] = await browser.tabs.query({
        url: url.includes('#') ? url.slice(0, url.indexOf('#')) : url,
        hidden: false,
    });

    if (tab) {
        const updateProperties = {
            active: true,
        };

        if (tab.url !== url) {
            updateProperties.url = url;
        }

        [tab] = await tabsAction({action: 'update'}, tab, updateProperties);
    }

    tab ??= await browser.tabs.create({
        url,
        active: true,
    });

    return tab;
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

    log.stop();
    return tabToActive;
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

    tabs = tabs.filter(tab => !self.skipTabs.removed.has(tab.id)); // BUG https://bugzilla.mozilla.org/show_bug.cgi?id=1396758

    tabs.forEach(tab => delete tab.groupId); // TODO temp

    if (!query.pinned) {
        tabs = await Promise.all(
            tabs.map(tab => Cache.loadTabSession(Utils.normalizeTabUrl(tab), includeFavIconUrl, includeThumbnail))
        );
    }

    tabs = tabs.filter(Boolean);

    log.stop('found tabs count:', tabs.length);
    return tabs;
}

export async function getOne(tabId) {
    try {
        if (self.skipTabs.removed.has(tabId)) { // BUG https://bugzilla.mozilla.org/show_bug.cgi?id=1396758
            return null;
        }

        const tab = await browser.tabs.get(tabId);
        delete tab.groupId; // TODO temp
        return Utils.normalizeTabUrl(tab);
    } catch {
        return null;
    }
}

export async function getList(tabIds, includeFavIconUrl, includeThumbnail) {
    const tabs = await Promise.all(tabIds.map(tabId => {
        return getOne(tabId).then(tab => Cache.loadTabSession(tab, includeFavIconUrl, includeThumbnail));
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
        const tempTab = await create({
            url: createPinnedTab ? (newTabUrl || 'about:blank') : (newTabUrl || 'about:newtab'),
            pinned: createPinnedTab,
            active: true,
            windowId: windowId,
        }, true);
        log.stop('created temp tab', tempTab);
        return tempTab;
    }
}

export async function add(groupId, cookieStoreId, url, title) {
    const log = logger.start('add', {groupId, cookieStoreId, url, title});

    const {group} = await Groups.load(groupId);

    // TODO get rid of BG
    const [tab] = await backgroundSelf.createTabsSafe([{
        url,
        title,
        cookieStoreId,
        ...Groups.getNewTabParams(group),
    }]);

    log.stop(tab);
    return tab;
}

export async function updateThumbnail(tabId) {
    const log = logger.start('updateThumbnail', {tabId});

    const tab = await getOne(tabId);

    if (!tab) {
        log.stop('!tab');
        return;
    }

    if (!Utils.isTabLoaded(tab)) {
        log.stop('tab is loading');
        return;
    }

    if (tab.discarded) {
        reload(tab.id);
        log.stop('tab is discarded, reloading');
        return;
    }

    try {
        const thumbnailBase64 = await browser.tabs.captureTab(tab.id, {
            format: browser.extensionTypes.ImageFormat.JPEG,
            quality: 25,
        });

        const thumbnail = await new Promise((resolve, reject) => {
            const img = new Image();

            img.onload = () => {
                resolve(Utils.resizeImage(img, 192, Math.floor(img.width * 192 / img.height), false, 'image/jpeg', 0.7));
            };

            img.onerror = img.onabort = reject;

            img.src = thumbnailBase64;
        });

        await Cache.setTabThumbnail(tab.id, thumbnail);

        backgroundSelf.sendMessageFromBackground('tab-updated', {
            tabId: tab.id,
            changeInfo: {thumbnail},
        });

        log.stop('success');
    } catch (e) {
        log.logError('cant create thumbnail', e);
        log.stopError(String(e));
    }
}

export async function move(tabIds, groupId, params = {}) {
    const log = logger.start('move', {tabIds, groupId, params});

    let tabs = await getList(tabIds.slice());

    if (tabs.length) {
        tabIds = tabs.map(extractId);
    } else {
        log.stop('tabs are empty');
        return [];
    }

    const skippedTabs = self.skipTabsTracking(tabIds);

    const tabsCantHide = new Set;
    const groupWindowId = Cache.getWindowId(groupId);
    const {group} = await Groups.load(groupId, !groupWindowId);
    const windowId = groupWindowId || (group.tabs[0]?.windowId) || await Windows.getLastFocusedNormalWindow();
    const activeTabs = [];

    log.log('vars', {groupWindowId, windowId});
    log.log('filter active');

    params.showTabAfterMovingItIntoThisGroup ??= group.showTabAfterMovingItIntoThisGroup;
    params.showOnlyActiveTabAfterMovingItIntoThisGroup ??= group.showOnlyActiveTabAfterMovingItIntoThisGroup;
    params.showNotificationAfterMovingTabIntoThisGroup ??= group.showNotificationAfterMovingTabIntoThisGroup;

    let showPinnedMessage = false;

    tabs = tabs.filter(function(tab) {
        if (tab.pinned) {
            showPinnedMessage = true;
            self.continueTabsTracking([tab], skippedTabs);
            log.log('tab pinned', tab);
            return false;
        }

        if (Utils.isTabCanNotBeHidden(tab)) {
            tabsCantHide.add(getTitle(tab, false, 20));
            self.continueTabsTracking([tab], skippedTabs);
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
        activeTabs.length = 0; // reset active tabs

        let tabIdsToRemove = [],
            newTabParams = Groups.getNewTabParams(group);

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

            const newTab = await create({
                ...tab,
                ...Cache.getTabSession(tab.id), // apply session, because we can move tab from onBeforeTabRequest
                active: false,
                openerTabId: null,
                windowId,
                ...newTabParams,
            }, true);

            self.skipTabsTracking([newTab], skippedTabs);

            if (tab.active) {
                activeTabs.push({...newTab, active: true});
            }

            return newTab;
        }));

        await remove(tabIdsToRemove, true);

        tabs = await moveNative(tabs, {
            index: params.newTabIndex ?? -1,
            windowId,
        });

        if (groupWindowId) {
            await show(tabs.filter(tab => tab.hidden));
        } else {
            await hide(tabs.filter(tab => !tab.hidden));
        }

        await Promise.all(tabs.map(tab => Cache.setTabGroup(tab.id, groupId)));

        backgroundSelf.sendMessageFromBackground('groups-updated');

        log.log('end moving');
    }

    self.continueTabsTracking(skippedTabs);

    if (showPinnedMessage) {
        log.log('notify pinnedTabsAreNotSupported');
        Notification('pinnedTabsAreNotSupported');
    }

    if (tabsCantHide.size) {
        log.log('notify thisTabsCanNotBeHidden');
        Notification(['thisTabsCanNotBeHidden', Array.from(tabsCantHide).join(', ')]);
    }

    if (!tabs.length) {
        log.stop('empty tabs');
        return [];
    }

    let [firstTab] = activeTabs.length ? activeTabs : tabs;

    if (params.showTabAfterMovingItIntoThisGroup) {
        if (params.showOnlyActiveTabAfterMovingItIntoThisGroup) {
            if (activeTabs.length) {
                log.log('applyGroup', windowId, groupId, firstTab.id)
                await backgroundSelf.applyGroup(windowId, groupId, firstTab.id);
                params.showNotificationAfterMovingTabIntoThisGroup = false;
            }
        } else {
            log.log('applyGroup 2', windowId, groupId, firstTab.id)
            await backgroundSelf.applyGroup(windowId, groupId, firstTab.id);
            params.showNotificationAfterMovingTabIntoThisGroup = false;
        }
    }

    if (!params.showNotificationAfterMovingTabIntoThisGroup) {
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

    Notification(message, {
        iconUrl,
        module: ['background', 'applyGroup', null, groupId, firstTab.id],
    });

    log.stop(tabs, 'with notify');
    return tabs;
}

async function filterExist(tabs, returnTabIds = false) {
    const tabIds = tabs.map(extractId);
    const log = logger.start('filterExist', tabIds, {returnTabIds});

    const lengthBefore = tabIds.length;
    const returnFunc = returnTabIds ? t => t.id : t => t;

    tabs = await Promise.all(tabs.map(tab => {
        return browser.tabs.get(extractId(tab))
            .then(returnFunc, log.onCatch(['not found tab', tab], false));
    }));
    tabs = tabs.filter(Boolean).filter(tab => !self.skipTabs.removed.has(tab.id)); // BUG https://bugzilla.mozilla.org/show_bug.cgi?id=1396758
    tabs.forEach(tab => delete tab.groupId); // TODO temp

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

const tabsActionSchema = new Map([
    ['get', {sendOneByOne: true, processGroupId: true}], // TODO refactor to use it
    ['discard', {sendArray: true, sendOneByOne: true}],
    ['show', {sendArray: true, sendOneByOne: true}],
    ['hide', {sendArray: true, sendOneByOne: true}],
    ['remove', {sendArray: true, sendOneByOne: true}],
    ['update', {sendOneByOne: true, processGroupId: true}],
    ['reload', {sendOneByOne: true}],
    ['move', {sendArray: true, processGroupId: true}], // TODO refactor to use it
]);

async function tabsAction({action, skipTracking = false, silentRemove = false}, tabs, ...funcArgs) {
    const schema = tabsActionSchema.get(action);

    if (!schema) {
        throw Error(`invalid action: ${action}`);
    }

    if (!tabs) {
        throw Error(`invalid tabs`);
    }

    tabs = Array.isArray(tabs) ? tabs : [tabs];

    if (!tabs.length) {
        return;
    }

    const tabIds = tabs.map(extractId);
    const log = logger.start(`tabsAction`, {skipTracking, silentRemove}, `browser.tabs.${action}(`,tabIds,...funcArgs,')');

    if (action === 'remove') {
        skipTracking = true;

        if (silentRemove) {
            tabIds.forEach(tabId => self.skipTabs.removed.add(tabId));
        }
    }

    if (skipTracking) {
        self.skipTabsTracking(tabIds);
    }

    let result = [];

    async function sendOneByOne() {
        const settled = await Promise.allSettled(tabIds.map(tabId => {
            return browser.tabs[action](tabId, ...funcArgs);
        }));

        for (const [index, {status, value, reason}] of settled.entries()) {
            if (status === 'fulfilled') {
                result.push(value || tabIds[index]);
            } else {
                log.warn(action, 'was rejected for tab:', tabs[index], 'reason:', reason);
            }
        }
    }

    if (schema.sendArray) {
        try {
            result = await browser.tabs[action](tabIds, ...funcArgs);
            result ||= tabIds;
        } catch (e) {
            if (schema.sendOneByOne) {
                log.logError(`fail ${action} tabs as array of ids, doing it one by one`, e);
                await sendOneByOne();
            } else {
                log.throwError(`fail ${action} tabs`, e);
            }
        }
    } else if (schema.sendOneByOne) {
        await sendOneByOne();
    } else {
        log.throwError('invalid schema config');
    }

    if (skipTracking) {
        self.continueTabsTracking(tabIds);
    }

    if (schema.processGroupId) {
        result.forEach(tab => delete tab.groupId); // TODO tmp
    }

    log.stop(result.map(extractId), ')');

    return result;
}

export async function show(tabs, skipTracking = false) {
    return await tabsAction({action: 'show', skipTracking}, tabs);
}

export async function hide(tabs, skipTracking = false) {
    return await tabsAction({action: 'hide', skipTracking}, tabs);
}

export async function discard(tabs, skipTracking = false) {
    return await tabsAction({action: 'discard', skipTracking}, tabs);
}

export async function reload(tabs, bypassCache = false) {
    return await tabsAction({action: 'reload'}, tabs, {bypassCache});
}

export async function setMute(tabs, muted) {
    logger.log('setMute', {muted});

    tabs = await getList(tabs.map(extractId), false, false);
    muted = Boolean(muted);

    tabs = tabs.filter(tab => muted ? tab.audible : tab.mutedInfo.muted);

    return await tabsAction({action: 'update'}, tabs, {muted});
}

export async function remove(tabs, silentRemove = false) {
    return await tabsAction({action: 'remove', silentRemove}, tabs);
}

// const restrictedDomainsRegExp = /^https?:\/\/(.+\.)?(mozilla\.(net|org|com)|firefox\.com)\//;
const restrictedDomains = new Set('accounts-static.cdn.mozilla.net,accounts.firefox.com,addons.cdn.mozilla.net,addons.mozilla.org,api.accounts.firefox.com,content.cdn.mozilla.net,discovery.addons.mozilla.org,oauth.accounts.firefox.com,profile.accounts.firefox.com,support.mozilla.org,sync.services.mozilla.com'.split(','));

export function isCanSendMessage({url}) {
    if (url === 'about:blank') {
        return true;
    }

    if (url.startsWith('about:') || url.startsWith('moz-extension')) {
        return false;
    }

    try {
        return !restrictedDomains.has(new URL(url).hostname);
    } catch {
        return false;
    }
}

export function extractId(tab) {
    return tab.id || tab;
}

export function sendMessage(tabId, message) {
    message.colorScheme = backgroundSelf.options.colorScheme;

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

    if (mainStorage.enableDebug && id) {
        let lastDate = new Date(lastAccessed);

        if (lastDate.getTime()) {
            lastDate = `(${lastDate.getMinutes()}:${lastDate.getSeconds()}.${lastDate.getMilliseconds()})`;
        } else {
            lastDate = '';
        }

        title = `@${windowId}:#${id}:i${index} ${lastDate} ${title}`;
    }

    return sliceLength ? Utils.sliceText(title, sliceLength) : title;
}
