
import Listeners from '/js/listeners.js\
?tabs.onActivated\
&tabs.onCreated\
&tabs.onUpdated=[{"properties":["title","status","favIconUrl","hidden","pinned","discarded","audible"]}]\
&tabs.onRemoved\
&tabs.onMoved\
&tabs.onDetached\
&tabs.onAttached\
&storage.local.onChanged\
';
import './prefixed-storage.js';
import Logger from './logger.js';
import Notification from './notification.js';
import BatchProcessor from './batch-processor.js';
import * as Broadcast from './broadcast.js';
import * as TabsBroadcast from './broadcast.js?channel=tabs';
import * as Constants from './constants.js';
import * as Utils from './utils.js';
import * as Cache from './cache.js';
import * as Containers from './containers.js';
import * as Extensions from './extensions.js';
import * as Groups from './groups.js';
import * as Windows from './windows.js';
import * as ConstantsBrowser from './constants-browser.js';
import * as Storage from './storage.js';
import * as BrowserSettings from './browser-settings.js';
import * as DeltaCapture from './sync/delta/delta-capture.js';
import {closedTabCapturePlan} from './sync/delta/close-capture.js';

export {on, off} from './broadcast.js?channel=tabs';

const logger = new Logger('Tabs');
const mainStorage = localStorage.create(Constants.MODULES.BACKGROUND);
const settings = await Storage.get(['showTabsWithThumbnailsInManageGroups', 'colorScheme']);
const skipTrackingWindows = new Set();
const skip = {
    created: new Set(),
    tracking: new Set(),
    removed: new Set(),
};
const longUrls = {}; // tabId: url

Listeners.storage.local.onChanged.add(onStorageChanged, {waitListener: false});

export function addListeners(options) {
    Listeners.tabs.onActivated.add(onActivated, options);
    Listeners.tabs.onCreated.add(onCreated, options);
    Listeners.tabs.onUpdated.add(onUpdated, options);
    Listeners.tabs.onRemoved.add(onRemoved, options);
    Listeners.tabs.onMoved.add(onMoved, options);
    Listeners.tabs.onDetached.add(onDetached, options);
    Listeners.tabs.onAttached.add(onAttached, options);
}

export function removeListeners() {
    Listeners.tabs.onActivated.remove(onActivated);
    Listeners.tabs.onCreated.remove(onCreated);
    Listeners.tabs.onUpdated.remove(onUpdated);
    Listeners.tabs.onRemoved.remove(onRemoved);
    Listeners.tabs.onMoved.remove(onMoved);
    Listeners.tabs.onDetached.remove(onDetached);
    Listeners.tabs.onAttached.remove(onAttached);
}

function send(action, data) {
    TabsBroadcast.send({action, ...data}, {
        includeSelf: false,
    });
}

export function sendUpdatedGroup(groupId) {
    send('updated.group', {
        groupId,
    });
}

function captureSnapshot(tabId) {
    return {
        groupId: Cache.getTabGroup(tabId),
        uid: Cache.getTabUid(tabId),
        lastModified: Cache.getTabLastModified(tabId),
        groupPinned: Cache.getTabGroupPinned(tabId),
        favIconUrl: Cache.getTabFavIcon(tabId),
    };
}

// listeners
const updatedBatch = new BatchProcessor(async (tabIds, groupKey) => {
    logger.log('updatedBatch', groupKey);

    // 'unsync:<windowId>'
    if (groupKey.startsWith('unsync:')) {
        const windowId = Number(groupKey.split(':', 2)[1]);
        send('updated.unsync', {windowId});
        return;
    }

    if (groupKey === 'unsync') {
        // fallback: broadcast per-window unsync for all windows
        const windows = await Windows.load(false);
        for (const win of windows) {
            send('updated.unsync', {windowId: win.id});
        }
        return;
    }

    sendUpdatedGroup(groupKey);
});

export function skipTrackingWindow(windowId) {
    skipTrackingWindows.add(windowId);
}

export function continueTrackingWindow(windowId) {
    skipTrackingWindows.delete(windowId);
}

export function skipTracking(tabs, accum = new Set) {
    for (const tab of tabs) {
        const id = extractId(tab);
        skip.tracking.add(id);
        accum.add(id);
    }

    return accum;
}

export function continueTracking(tabs, accum = null) {
    for (const tab of tabs) {
        const id = extractId(tab);
        skip.tracking.delete(id);
        accum?.delete(id);
    }
}

export function isSkippedTracking(tab) {
    return skip.tracking.has(extractId(tab));
}

export function clearSkipTracking() { // TODO remove/refactor
    return skip.tracking.clear();
}

async function onCreated(tab) {
    await Utils.wait(50);

    if (skip.removed.has(tab.id)) {
        logger.log(onCreated, '🛑 skip removed tab:', tab.id);
        return;
    }

    if (skip.created.has(tab.id)) {
        logger.log(onCreated, '🛑 skip created tab:', tab.id);
        return;
    }

    if (skipTrackingWindows.has(tab.windowId)) {
        logger.log(onCreated, '🛑 skip tracking tab:', tab.id, 'for window:', tab.windowId);
        return;
    }

    delete tab.groupId; // TODO tmp

    logger.log(onCreated, tab);

    Cache.setTab(tab);

    if (isPinned(tab)) {
        await Cache.setTabGroup(tab.id, Groups.PINNED_GROUP_ID, tab.windowId)
            .catch(logger.onCatch("onCreated can't set pinned group", false));
        await Cache.setTabGroupPinned(tab.id, true)
            .catch(logger.onCatch("onCreated can't set groupPinned", false));

        Cache.applyTabSession(tab);

        if (!Cache.getTabUid(tab.id)) {
            await Cache.setTabUid(tab.id)
                .catch(logger.onCatch("onCreated can't mint uid (pinned)", false));
        }

        DeltaCapture.tabAdded(tab);
        return;
    }

    await Cache.setTabGroup(tab.id, null, tab.windowId)
        .catch(logger.onCatch("onCreated can't set group", false));

    Cache.applyTabSession(tab);

    if (Cache.getTabGroup(tab.id) && !Cache.getTabUid(tab.id)) {
        await Cache.setTabUid(tab.id)
            .catch(logger.onCatch("onCreated can't mint uid", false));
    }

    updatedBatch.add(tab.id, tab.groupId || `unsync:${tab.windowId}`);

    DeltaCapture.tabAdded(tab);
}

async function onActivated({tabId, windowId, previousTabId = null}) {
    await Utils.wait(50 + 20); // needs to wait skipTrackingWindows list

    if (skip.tracking.has(tabId) || skip.tracking.has(previousTabId)) {
        logger.log(onActivated, '🛑 skip tracking one/all of tabs:', {tabId, previousTabId});
        return;
    }

    if (skipTrackingWindows.has(windowId)) {
        logger.log(onActivated, '🛑 skip tracking tab for window:', windowId, {tabId, previousTabId});
        return;
    }

    logger.log('onActivated', {tabId, windowId, previousTabId})

    if (!skip.removed.has(tabId)) {
        send('updated', {
            tabId: tabId,
            changeInfo: {active: true},
        });
    }

    if (previousTabId && !skip.removed.has(previousTabId)) {
        send('updated', {
            tabId: previousTabId,
            changeInfo: {active: false},
        });
    }
}

async function processLongUrls(tabId, changeInfo) {
    if (longUrls[tabId] && isLoaded(changeInfo)) {
        sendMessage(tabId, {
            action: 'long-url',
            url: longUrls[tabId],
        }).finally(() => delete longUrls[tabId]);
    }
}

async function onUpdated(tabId, changeInfo, tab) {
    if (skip.removed.has(tab.id)) {
        logger.log(onUpdated, '🛑 skip removed tab:', tab.id);
        return;
    }

    processLongUrls(tabId, changeInfo);

    if (skip.tracking.has(tab.id)) {
        Cache.setTab(tab);
        logger.log(onUpdated, '🛑 skip tracking tab:', tab.id);
        return;
    }

    if (skipTrackingWindows.has(tab.windowId)) {
        logger.log(onUpdated, '🛑 skip tracking tab:', tab.id, 'for window:', tab.windowId);
        return;
    }

    // if tab was restored along with window, it needs to wait when GrantRestore will add the window to the skipTrackingWindows
    await Utils.wait(50 + 20); // 50ms for tab onCreated + 20ms as a margin

    if (skip.tracking.has(tab.id) || skipTrackingWindows.has(tab.windowId)) {
        Cache.setTab(tab);
        logger.log(onUpdated, '🛑 skip tracking tab (after wait):', tab.id);
        return;
    }

    delete tab.groupId; // TODO tmp

    const log = logger.start(onUpdated, tabId, changeInfo);

    changeInfo = Cache.getRealTabStateChanged(tab);

    Cache.setTab(tab);

    if (!changeInfo) {
        log.stop('🛑 changeInfo keys was not changed');
        return;
    }

    if ((Object.hasOwn(changeInfo, 'title') || Object.hasOwn(changeInfo, 'url'))
        && DeltaCapture.shouldArmAppliedNavigation()) {
        DeltaCapture.markAppliedNavigation(tab.id, tab.url);
    }

    if (isPinned(tab) && !Object.hasOwn(changeInfo, 'pinned')) {
        if (Object.hasOwn(changeInfo, 'favIconUrl')) {
            await Cache.setTabFavIcon(tab.id, changeInfo.favIconUrl)
                .catch(log.onCatch(['cant set favIcon (pinned)', tab, changeInfo], false));
        }

        if (Object.hasOwn(changeInfo, 'title') || Object.hasOwn(changeInfo, 'url')) {
            await Cache.setTabLastModified(tab.id, Cache.getTabLastModified(tab.id))
                .catch(log.onCatch(['cant set lastModified (pinned)', tab, changeInfo], false));

            if (Cache.getTabGroupPinned(tab.id) && Cache.getTabGroup(tab.id)) {
                DeltaCapture.tabModified(tab, captureSnapshot(tab.id));
            } else {
                DeltaCapture.pinnedModified(tab, captureSnapshot(tab.id));
            }
        }

        log.stop('🛑 tab is pinned');
        return;
    }

    if (changeInfo.favIconUrl) {
        await Cache.setTabFavIcon(tab.id, changeInfo.favIconUrl)
            .catch(log.onCatch(['cant set favIcon', tab, changeInfo], false));
    }

    if (Object.hasOwn(changeInfo, 'title') || Object.hasOwn(changeInfo, 'url')) {
        await Cache.setTabLastModified(tab.id, Cache.getTabLastModified(tab.id))
            .catch(log.onCatch(['cant set lastModified', tab, changeInfo], false));

        DeltaCapture.tabModified(tab, captureSnapshot(tab.id));
    }

    if (Object.hasOwn(changeInfo, 'pinned') || Object.hasOwn(changeInfo, 'hidden')) {
        const currentGroupId = Cache.getTabGroup(tab.id);
        const inPinnedGroup = Groups.isPinnedGroupId(currentGroupId);

        if (Object.hasOwn(changeInfo, 'pinned') && Cache.getTabGroupPinned(tab.id) && currentGroupId && !inPinnedGroup) {
            log.stop('🛑 group-pinned tab pin transition, keeping group', tab.id);
            return;
        }

        let tabGroupId;

        if (changeInfo.pinned) {
            log.log('absorb pinned tab into pinned group', tab.id);

            if (!inPinnedGroup) {
                const uid = Cache.getTabUid(tab.id);
                if (uid && currentGroupId) {
                    DeltaCapture.tabRemoved(uid, currentGroupId);
                }

                await Cache.setTabGroup(tab.id, Groups.PINNED_GROUP_ID, tab.windowId)
                    .catch(log.onCatch(["can't set pinned group", tab.id], false));
                await Cache.setTabGroupPinned(tab.id, true)
                    .catch(log.onCatch(["can't set groupPinned", tab.id], false));

                if (!Cache.getTabUid(tab.id)) {
                    await Cache.setTabUid(tab.id).catch(() => {});
                }

                DeltaCapture.tabAdded(tab);
            }

            tabGroupId = Groups.PINNED_GROUP_ID;
        } else if (changeInfo.hidden) {
            log.log('remove group for hidden tab', tab.id);
            tabGroupId = currentGroupId;
            await Cache.removeTabGroup(tab.id).catch(() => {});
        } else if (changeInfo.pinned === false) {
            log.log('tab is unpinned', tab.id);

            const uid = Cache.getTabUid(tab.id);
            if (inPinnedGroup) {
                if (uid) {
                    DeltaCapture.tabRemoved(uid, Groups.PINNED_GROUP_ID);
                    DeltaCapture.pinnedRemoved(uid);
                }
                await Cache.setTabGroupPinned(tab.id, false)
                    .catch(log.onCatch(["can't clear groupPinned", tab.id], false));
            } else if (uid) {
                DeltaCapture.pinnedRemoved(uid);
            }

            await Cache.setTabGroup(tab.id, null, tab.windowId)
                .catch(log.onCatch(["can't set group to tab, !pinned", tab.id], false));

            DeltaCapture.tabAdded(tab);

            tabGroupId = Cache.getTabGroup(tab.id);
        } else if (changeInfo.hidden === false) {
            log.log('tab is showing', tab.id);

            Cache.applyTabSession(tab);

            if (tab.groupId) {
                log.log('call apply group for tab', tab.id, 'groupId', tab.groupId);
                await Groups.apply(tab.windowId, tab.groupId, tab.id)
                    .catch(log.onCatch(["can't apply group", tab.groupId], false));
            } else {
                log.log('call setTabGroup for tab', tab.id);
                await Cache.setTabGroup(tab.id, null, tab.windowId)
                    .catch(log.onCatch(["can't set group to tab, !hidden", tab.id], false));

                tabGroupId = Cache.getTabGroup(tab.id);
            }
        }

        tabGroupId && updatedBatch.add(tab.id, tabGroupId);
        currentGroupId && currentGroupId !== tabGroupId && updatedBatch.add(tab.id, currentGroupId);
        updatedBatch.add(tab.id, `unsync:${tab.windowId}`);

        log.stop();
        return;
    }

    send('updated', {
        tabId: tab.id,
        changeInfo,
    });

    if (settings.showTabsWithThumbnailsInManageGroups && isLoaded(changeInfo)) {
        await updateThumbnail(tab.id);
    }

    log.stop();
}

function onRemoved(tabId, {isWindowClosing, windowId}) {
    const silent = skip.removed.has(tabId);

    skip.removed.add(tabId); // BUG https://bugzilla.mozilla.org/show_bug.cgi?id=1396758

    DeltaCapture.clearAppliedNavigation(tabId);

    const groupId = Cache.getTabGroup(tabId);
    const uid = Cache.getTabUid(tabId);
    const wasPinned = Cache.lastTabsState[tabId]?.pinned === true;

    updatedBatch.delete(tabId, groupId || `unsync:${windowId}`);

    if (silent) {
        Cache.removeTab(tabId);
        logger.log(onRemoved, '🛑 silent removed tab:', tabId);
        return;
    }

    if (skipTrackingWindows.has(windowId)) {
        logger.log(onRemoved, '🛑 skip tracking tab:', tabId, 'for window:', windowId);
        return;
    }

    logger.log(onRemoved, tabId, {isWindowClosing, windowId, groupId});

    if (isWindowClosing) {
        Broadcast.send({
            action: 'add-restore-tab-on-removed-window',
            tabId,
        });
    } else {
        Cache.removeTab(tabId);

        const capture = closedTabCapturePlan({uid, groupId, wasPinned}, Groups.isPinnedGroupId);

        if (capture.removeFromGroupId) {
            DeltaCapture.tabRemoved(uid, capture.removeFromGroupId);
        }
        if (capture.retirePinnedUid) {
            DeltaCapture.pinnedRemoved(capture.retirePinnedUid);
        }

        if (groupId) {
            send('removed', {
                tabId,
                groupId,
            });
        } else {
            send('removed.unsync', {
                tabId,
            });
        }
    }
}

async function onMoved(tabId, {windowId, /* fromIndex, */ toIndex}) {
    if (skip.removed.has(tabId)) {
        logger.log(onMoved, '🛑 skip removed tab:', tabId);
        return;
    }

    if (skip.tracking.has(tabId)) {
        logger.log(onMoved, '🛑 skip tracking tab:', tabId);
        return;
    }

    if (skipTrackingWindows.has(windowId)) {
        logger.log(onMoved, '🛑 skip tracking tab:', tabId, 'for window:', windowId);
        return;
    }

    await Utils.wait(50 + 20);

    if (skip.tracking.has(tabId) || skipTrackingWindows.has(windowId)) {
        logger.log(onMoved, '🛑 skip tracking tab (after wait):', tabId);
        return;
    }

    const groupId = Cache.getTabGroup(tabId);

    logger.log(onMoved, {tabId, groupId});

    updatedBatch.add(tabId, groupId || `unsync:${windowId}`);

    if (groupId) {
        DeltaCapture.tabMoved(tabId);
    } else if (Cache.lastTabsState[tabId]?.pinned) {
        DeltaCapture.pinnedMoved(tabId, toIndex);
    }

    /*
    if (Cache.getTabGroup(tabId)) {
        clearTimeout(openerTabTimer);
        openerTabTimer = setTimeout(() => Tabs.get().catch(() => {}), 500); // load visible tabs of current window for set openerTabId
    } */
}

async function onDetached(tabId, {oldWindowId}) { // notice: called before onAttached
    if (skip.removed.has(tabId)) {
        logger.log(onDetached, '🛑 skip removed tab:', tabId);
        return;
    }

    if (skip.tracking.has(tabId)) {
        logger.log(onDetached, '🛑 skip tracking tab:', tabId);
        return;
    }

    if (skipTrackingWindows.has(oldWindowId)) {
        logger.log(onDetached, '🛑 skip tracking tab:', tabId, 'for window:', oldWindowId);
        return;
    }

    await Utils.wait(50 + 20);

    const groupId = Cache.getWindowGroup(oldWindowId);

    logger.log(onDetached, {tabId, oldWindowId, groupId});

    updatedBatch.add(tabId, groupId || `unsync:${oldWindowId}`);
}

async function onAttached(tabId, {newWindowId}) { // called when tabs.move()
    if (skip.removed.has(tabId)) {
        logger.log(onAttached, '🛑 skip removed tab:', tabId);
        return;
    }

    if (skip.tracking.has(tabId)) {
        logger.log(onAttached, '🛑 skip tracking tab:', tabId);
        return;
    }

    if (skipTrackingWindows.has(newWindowId)) {
        logger.log(onAttached, '🛑 skip tracking tab:', tabId, 'for window:', newWindowId);
        return;
    }

    await Utils.wait(50 + 20);

    const log = logger.start(onAttached, {tabId, newWindowId});

    await Cache.setTabGroup(tabId, null, newWindowId)
        .catch(log.onCatch("can't set group"));

    const groupId = Cache.getTabGroup(tabId);

    log.log('groupId', groupId);

    if (groupId && !Cache.getTabUid(tabId)) {
        await Cache.setTabUid(tabId)
            .catch(log.onCatch("can't mint uid", false));
    }

    updatedBatch.add(tabId, groupId || `unsync:${newWindowId}`);

    log.stop();
}

function onStorageChanged(changes) {
    if (Storage.isChangedBooleanKey('showTabsWithThumbnailsInManageGroups', changes)) {
        settings.showTabsWithThumbnailsInManageGroups = changes.showTabsWithThumbnailsInManageGroups.newValue;
    }
    if (Storage.isChangedStringKey('colorScheme', changes)) {
        settings.colorScheme = changes.colorScheme.newValue;
    }
}

// methods
export async function create({url, active, pinned, discarded, title, index, windowId, openerTabId, cookieStoreId, newTabContainer, ifDifferentContainerReOpen, excludeContainersForReOpen, groupId, favIconUrl, thumbnail, groupPinned}, skipListener = false) {
    if (!Constants.IS_BACKGROUND_PAGE) {
        throw new Error('is not background');
    }

    skipListener = skipListener === true;

    const tab = {};

    let longUrl;

    if (url) {
        if (url.length > 100_000) {
            if (!Utils.isUrlLengthValid(url)) {
                longUrl = url;
                url = Constants.PAGES.HELP.DUMMY;
            }
        }

        if (Utils.isUrlAllowToCreate(url)) {
            if (url.startsWith('moz-extension')) {
                const uuid = Extensions.extractUUID(url);

                if (Utils.isUUID(uuid)) {
                    tab.url = url;
                } else {
                    tab.url = createUnsupportedUrlPage(url);
                }
            } else {
                tab.url = url;
            }
        } else if (url !== 'about:newtab') {
            tab.url = createUnsupportedUrlPage(url);
        }
    }

    tab.active = !!active;

    if (Groups.isPinnedGroupId(groupId)) {
        pinned = true;
        groupPinned = true;
    }

    if (pinned) {
        tab.pinned = true;
    }

    const defaultDiscarded = !tab.pinned;
    const wantDiscarded = (typeof discarded === 'boolean' ? discarded : defaultDiscarded) && !tab.active
        && !!tab.url && !tab.url.startsWith('about:') && !longUrl;

    const discardPinnedAfterCreate = wantDiscarded && tab.pinned;

    if (wantDiscarded && !tab.pinned) {
        tab.discarded = true;
    }

    if (tab.discarded && title) {
        tab.title = title.slice(0, 1000);
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
        tab.cookieStoreId = (await Containers.createTemporary()).cookieStoreId;
    } else {
        tab.cookieStoreId = Containers.get(tab.cookieStoreId).cookieStoreId;
    }

    const newTab = await browser.tabs.create(tab);

    if (skipListener) {
        skip.created.add(newTab.id);
    }

    if (discardPinnedAfterCreate) {
        await browser.tabs.discard(newTab.id)
            .then(() => { newTab.discarded = true; })
            .catch(error => logger.logError(['cant discard pinned tab after create', newTab.id], error));
    }

    delete newTab.groupId; // TODO temp

    if (longUrl) {
        longUrls[newTab.id] = longUrl;
        self.setTimeout(() => delete longUrls[newTab.id], 30_000);
    }

    await Cache.setTabSession(newTab, {groupId, favIconUrl, thumbnail, groupPinned});

    if (skipListener) {
        logger.log('created', newTab.id);
    } else {
        logger.log('created', newTab);
    }

    return newTab;
}

function createUnsupportedUrlPage(url) {
    const urlObj = createUnsupportedUrlPage.urlObj ??= new URL(Constants.PAGES.HELP.UNSUPPORTED_URL);
    urlObj.searchParams.set('url', url);
    return urlObj.href;
}

function isStrictlyAscendingBy(arr, key) {
    return arr.every((item, i) => i === 0 || item[key] > arr[i - 1][key]);
}

export async function createMultiple(tabsToCreate, skipCreateListenerAndTracking = false) {
    if (!Array.isArray(tabsToCreate)) {
        throw new Error('tabs must be an array');
    }

    const log = logger.start(createMultiple, 'count:', tabsToCreate.length, {skipCreateListenerAndTracking});

    if (!tabsToCreate.length) {
        log.stop('no tabs');
        return [];
    }

    const tabsToCreateBackup = tabsToCreate.map(tab => ({...tab}));

    for (const tab of tabsToCreate) {
        delete tab.openerTabId;
    }

    const hasTreeTabs = Extensions.hasTreeTabs();
    const createdTabsByWindow = new Map();

    const settled = await Promise.allSettled(tabsToCreate.map(tab => create(tab, skipCreateListenerAndTracking)));

    for (const [index, {status, value: createdTab, reason}] of settled.entries()) {
        if (status === 'fulfilled') {
            createdTabsByWindow.getOrInsert(createdTab.windowId, []).push(createdTab);

            if (!createdTab.pinned) {
                tabsToCreateBackup[index].newId = createdTab.id; // map id for restore openerTabId
            }
        } else {
            log.logError(['failed to create tab:', tabsToCreateBackup[index], 'reason:'], reason);
        }
    }

    // update openerTabIds for newly created tab ids
    for (const tabToCreate of tabsToCreateBackup) {
        if (tabToCreate.openerTabId > 0) {
            const openerTab = tabsToCreateBackup.find(t => t.id === tabToCreate.openerTabId);

            if (tabToCreate !== openerTab && openerTab?.newId) {
                tabToCreate.newOpenerTabId = openerTab.newId;
            }
        }
    }

    // sort tabs by previous order in each window and restore openerTabId for newly created tabs
    for (let [windowId, createdTabs] of createdTabsByWindow) {
        const needSorting = createdTabs.length > 1 && !isStrictlyAscendingBy(createdTabs, 'index');

        // because of "New tab position" setting,
        // tabs can be created in wrong order, so we need to re-sort them by previous index
        if (needSorting) {
            const minIndex = Math.min(...createdTabs.map(tab => tab.index));
            createdTabs = await moveNative(createdTabs, {index: minIndex}, skipCreateListenerAndTracking);
        }

        if (hasTreeTabs) {
            log.log('start restoring openerTabIds for tabs (count):', createdTabs.length);
            // restore openerTabId only if opener tab in the same window
            const createdTabIds = new Set(createdTabs.map(extractId));

            for (const [index, tab] of createdTabs.entries()) {
                if (tab.pinned) {
                    log.log('skip pinned tab', tab.id);
                    continue;
                }

                const {newOpenerTabId} = tabsToCreateBackup.find(t => t.newId === tab.id);

                if (createdTabIds.has(newOpenerTabId)) {
                    try {
                        [createdTabs[index]] = await tabsAction({action: 'update'}, tab, {
                            openerTabId: newOpenerTabId,
                        }); // no need skipListener, addon don't track openerTabId changes
                    } catch (e) {
                        log.logError(['failed to restore openerTabId for tab:', tab.id, 'newOpenerTabId:', newOpenerTabId], e);

                        const invalidTabId = /\d+/.exec(e.message)?.[0];

                        if (invalidTabId == tab.id) { // "Invalid tab ID: 123"
                            createdTabs[index] = null;
                        } else if (invalidTabId == newOpenerTabId) {
                            // do nothing
                        }
                    }
                }
            }

            createdTabs = createdTabs.filter(Boolean);
        }

        createdTabsByWindow.set(windowId, createdTabs);
    }

    log.stop();

    return [...createdTabsByWindow.values()].flat();
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
    const log = logger.start(setActive, tabId, 'from tabs:', tabs.map(extractId));

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

export async function getNewTabIndex(tabs) {
    if (!tabs.length) {
        return null;
    }

    const hasBrowserSettingsPermission = await BrowserSettings.hasPermission();

    if (hasBrowserSettingsPermission) {
        const {newTabPosition: {value: newTabPosition}} = await BrowserSettings.get();

        if (newTabPosition === 'afterCurrent') {
            return tabs.toSorted(Utils.sortBy('lastAccessed')).pop()?.index + 1 || null;
        }
    }

    return tabs.slice().pop()?.index + 1 || null;
}

export async function getHighlightedIds(windowId = browser.windows.WINDOW_ID_CURRENT, clickedTab = null, pinned = null) {
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

    const log = logger.start(get, query);

    let tabs = await browser.tabs.query(query);

    tabs = tabs.filter(tab => !skip.removed.has(tab.id)); // BUG https://bugzilla.mozilla.org/show_bug.cgi?id=1396758

    tabs.forEach(tab => delete tab.groupId); // TODO temp

    if (!query.pinned) {
        tabs = await Promise.all(
            tabs.map(tab => Cache.loadTabSession(normalizeUrl(tab), includeFavIconUrl, includeThumbnail))
        );
    }

    tabs = tabs.filter(Boolean);

    log.stop('found tabs count:', tabs.length);
    return tabs;
}

export async function getOne(tabId) {
    try {
        if (skip.removed.has(tabId)) { // BUG https://bugzilla.mozilla.org/show_bug.cgi?id=1396758
            return null;
        }

        const tab = await browser.tabs.get(tabId);
        delete tab.groupId; // TODO temp
        return normalizeUrl(tab);
    } catch {
        return null;
    }
}

async function getList(tabIds) {
    return Promise.all(tabIds.map(getOne)).then(tabs => tabs.filter(Boolean));
}

export async function createTempActiveTab(windowId, createPinnedTab = true, newTabUrl) {
    const log = logger.start(createTempActiveTab, {windowId, createPinnedTab, newTabUrl});

    const pinnedTabs = await get(windowId, true, null);

    if (pinnedTabs.length) {
        if (!pinnedTabs.some(tab => tab.active)) {
            await setActive(Utils.getLastActiveTab(pinnedTabs).id);
            log.stop('setActive pinned');
        } else {
            log.stop('pinned is active');
        }
        // no not return USER pinned tab, because it shouldn't be removed as a temp tab
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
    const log = logger.start(add, {groupId, cookieStoreId, url, title});

    const windowId = Cache.getWindowId(groupId);

    let {group} = await Groups.load(groupId, !windowId);

    const tab = await create({
        url,
        title,
        cookieStoreId,
        index: windowId ? null : group.tabs.pop()?.index + 1,
        // windowId, // windowId will get from Cache.getWindowId into create function
        ...Groups.getNewTabParams(group),
    }, true);

    if (!windowId) {
        await hide(tab, true);
    }

    sendUpdatedGroup(groupId);

    log.stop(tab);
    return tab;
}

export async function updateThumbnail(tabId) {
    const log = logger.start(updateThumbnail, {tabId});

    const tab = await getOne(tabId);

    if (!tab) {
        log.stop('!tab');
        return;
    }

    if (!isLoaded(tab)) {
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

        send('updated', {
            tabId: tab.id,
            changeInfo: {thumbnail},
        });

        log.stop('success');
    } catch (e) {
        log.stopWarn('cant create thumbnail', e);
    }
}

export async function move(tabIds, groupId, params = {}) {
    const log = logger.start(move, {tabIds, groupId, params});

    let tabs = await getList(tabIds);
    tabs = await Promise.all(tabs.map(tab => Cache.loadTabSession(tab, true, settings.showTabsWithThumbnailsInManageGroups)));

    if (tabs.length) {
        tabIds = tabs.map(extractId);
    } else {
        log.stop('tabs are empty');
        return [];
    }

    const skippedTabs = skipTracking(tabIds);

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
    const pinnedToGroupPin = [];

    tabs = tabs.filter(function(tab) {
        const fromPinnedGroup = !params._pinnedAlreadyHandled &&
            Groups.isPinnedGroupId(tab.groupId ?? Cache.getTabGroup(tab.id));

        if (tab.pinned || fromPinnedGroup) {
            if (!params._pinnedAlreadyHandled) {
                pinnedToGroupPin.push(tab);
                continueTracking([tab], skippedTabs);
                log.log('route pinned tab into group as group-pinned', tab.id);
                return false;
            }

            showPinnedMessage = true;
            continueTracking([tab], skippedTabs);
            log.log('tab pinned', tab);
            return false;
        }

        if (isCanNotBeHidden(tab)) {
            tabsCantHide.add(getTitle(tab, false, 20));
            continueTracking([tab], skippedTabs);
            log.log('cant move tab', tab);
            return false;
        }

        if (tab.active && tab.groupId !== groupId) {
            activeTabs.push(tab);
        }

        return true;
    });

    const groupPinnedResultTabs = [];
    for (const tab of pinnedToGroupPin) {
        const ok = await Groups.setTabGroupPinned(tab.id, true, groupId, params.newTabIndex)
            .catch(log.onCatch(['cant group-pin tab into group', tab.id, groupId], false));

        if (ok) {
            groupPinnedResultTabs.push(tab);
        }
    }

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

            skipTracking([newTab], skippedTabs);

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

        if (Groups.isPinnedGroupId(groupId)) {
            await Promise.all(tabs.map(tab => Cache.setTabGroupPinned(tab.id, true)));
            tabs.forEach(tab => tab.groupPinned = true);
        }

        await DeltaCapture.tabsAdded(tabs);

        Groups.sendUpdatedAll();

        log.log('end moving');
    }

    continueTracking(skippedTabs);

    if (showPinnedMessage) {
        log.log('notify pinnedTabsAreNotSupported');
        Notification('pinnedTabsAreNotSupported');
    }

    if (tabsCantHide.size) {
        log.log('notify thisTabsCanNotBeHidden');
        Notification(['thisTabsCanNotBeHidden', Array.from(tabsCantHide).join(', ')]);
    }

    if (Groups.isPinnedGroupId(groupId)) {
        await Groups.refreshPinnedGroupIfShown();
    }

    if (!tabs.length) {
        log.stop('empty tabs');
        return groupPinnedResultTabs;
    }

    let [firstTab] = activeTabs.length ? activeTabs : tabs;

    if (params.showTabAfterMovingItIntoThisGroup) {
        if (params.showOnlyActiveTabAfterMovingItIntoThisGroup) {
            if (activeTabs.length) {
                log.log('apply group [1]', windowId, groupId, firstTab.id)
                await Groups.apply(windowId, groupId, firstTab.id);
                params.showNotificationAfterMovingTabIntoThisGroup = false;
            }
        } else {
            log.log('apply group [2]', windowId, groupId, firstTab.id)
            await Groups.apply(windowId, groupId, firstTab.id);
            params.showNotificationAfterMovingTabIntoThisGroup = false;
        }
    }

    if (!params.showNotificationAfterMovingTabIntoThisGroup) {
        log.stop('no notify, count:', tabs.length);
        return [...tabs, ...groupPinnedResultTabs];
    }

    let message = [],
        iconUrl = null;

    if (tabs.length > 1) {
        message = ['moveMultipleTabsToGroupMessage', tabs.length];
        iconUrl = Groups.getIconUrl(group);
    } else {
        let tabTitle = getTitle(firstTab, false, 50);
        message = ['moveTabToGroupMessage', [group.title, tabTitle]];
        firstTab = normalizeFavIcon(firstTab);
        iconUrl = firstTab.favIconUrl;
    }

    Notification(message, {
        iconUrl,
        module: ['groups', 'apply', null, groupId, firstTab.id],
    });

    log.stop('with notify, count:', tabs.length);
    return [...tabs, ...groupPinnedResultTabs];
}

export async function moveNative(tabs, moveProperties = {}, skipTrackingFlag = false, fixSessionAfterMove = true) {
    tabs = Array.isArray(tabs) ? tabs : [tabs];

    const tabsLengthBefore = tabs.length;
    const log = logger.start(moveNative, 'tabs:', tabs.map(extractId), {moveProperties, skipTrackingFlag, fixSessionAfterMove});

    tabs = await getList(tabs.map(extractId));
    tabs = await Promise.all(tabs.map(tab => Cache.loadTabSession(tab, true, true)));
    const tabsBeforeMoveMap = new Map(tabs.map(tab => [tab.id, tab]));

    let updateOpenerTabIds = moveProperties.windowId && Extensions.hasTreeTabs();
    const openerTabIds = {};

    if (updateOpenerTabIds) {
        tabs.forEach(tab => openerTabIds[tab.id] = tab.openerTabId);
        updateOpenerTabIds = tabs.some(tab => tab.windowId !== moveProperties.windowId);
    }

    tabs = await tabsAction({action: 'move', skipTrackingFlag}, tabs, moveProperties);

    if (updateOpenerTabIds) {
        log.log('updating openerTabIds...');

        const tabIds = tabs.map(extractId);

        tabs = await Promise.all(tabs.map(async tab => {
            if (openerTabIds[tab.id] > 0 && tabIds.includes(openerTabIds[tab.id])) {
                /* Tabs moved across windows always lose their openerTabId even
                if it is also moved to the same window together, thus we need
                to restore it manually.
                https://github.com/piroor/treestyletab/issues/2546#issuecomment-733488187 */
                try {
                    [tab] = await tabsAction({action: 'update'}, tab, {
                        openerTabId: openerTabIds[tab.id],
                    });
                } catch {
                    //
                }
            }

            return tab;
        }));
    }

    // BUG brorser.session values are lost after moving DISCARDED tabs to ANOTHER window
    const tabAfterMoveNeedFixing = tabAfterMove => {
        const tabBeforeMove = tabsBeforeMoveMap.get(tabAfterMove.id);
        return tabBeforeMove.discarded && tabBeforeMove.windowId !== tabAfterMove.windowId;
    };

    if (fixSessionAfterMove && tabs.some(tabAfterMoveNeedFixing)) {
        log.log('fixing session after move...');

        // allSettled is just in case
        tabs = await Promise.allSettled(tabs.map(async tabAfterMove => {
            if (!tabAfterMoveNeedFixing(tabAfterMove)) {
                return tabAfterMove;
            }

            Cache.clearTabSessionCache(tabAfterMove.id);
            tabAfterMove = await Cache.loadTabSession(tabAfterMove, true, true);

            const tabBeforeMove = tabsBeforeMoveMap.get(tabAfterMove.id);

            if (isSame(tabAfterMove, tabBeforeMove, Cache.KEYS)) {
                return tabAfterMove;
            }

            tabAfterMove = await Cache.setTabSession(tabAfterMove, tabBeforeMove);

            log.log('session was fixed for discarded tab', tabAfterMove.id);

            return tabAfterMove;
        }));
        tabs = tabs.map(({value}) => value).filter(Boolean);
    }

    // clean session data from tab object to avoid confusion, return only clean data from browser.tabs.move()
    tabs.forEach(tab => Cache.KEYS.forEach(key => delete tab[key]));

    if (tabs.length !== tabsLengthBefore) {
        log.stopWarn('some tabs were not moved, before:', tabsLengthBefore, 'after:', tabs.length);
    } else {
        log.stop('tabs count:', tabs.length);
    }

    return tabs;
}

const tabsActionSchema = new Map([
    ['get', {sendOneByOne: true, processGroupId: true}], // TODO refactor to use it
    ['discard', {sendArray: true, sendOneByOne: true}],
    ['show', {sendArray: true, sendOneByOne: true}],
    ['hide', {sendArray: true, sendOneByOne: true}],
    ['remove', {sendArray: true, sendOneByOne: true}],
    ['update', {sendOneByOne: true, processGroupId: true}],
    ['reload', {sendOneByOne: true}],
    ['move', {sendArray: true, processGroupId: true}],
]);

async function tabsAction({action, skipTrackingFlag = false, silentRemove = false}, tabs, ...funcArgs) {
    const schema = tabsActionSchema.get(action);

    if (!schema) {
        throw new Error(`invalid action: ${action}`);
    }

    if (!tabs) {
        throw new Error(`invalid tabs`);
    }

    tabs = Array.isArray(tabs) ? tabs : [tabs];

    let result = [];

    const tabIds = tabs.map(extractId);
    const log = logger.start(tabsAction, `browser.tabs.${action}(`,tabIds,...funcArgs,')', {skipTrackingFlag, silentRemove});

    if (!tabs.length) {
        log.stop('tabs are empty');
        return result;
    }

    if (action === 'remove') {
        skipTrackingFlag = true;

        if (silentRemove) {
            tabIds.forEach(tabId => skip.removed.add(tabId));
        }
    }

    if (skipTrackingFlag) {
        skipTracking(tabIds); // TODO
    }

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

    if (skipTrackingFlag) {
        continueTracking(tabIds);
    }

    if (schema.processGroupId) {
        result.forEach(tab => delete tab.groupId); // TODO tmp
    }

    log.stop(result.map(extractId), ')');

    return result;
}

export async function show(tabs, skipTrackingFlag = false) {
    return await tabsAction({action: 'show', skipTrackingFlag}, tabs);
}

export async function hide(tabs, skipTrackingFlag = false) {
    return await tabsAction({action: 'hide', skipTrackingFlag}, tabs);
}

export async function discard(tabs, skipTrackingFlag = false) {
    return await tabsAction({action: 'discard', skipTrackingFlag}, tabs);
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

export async function sendMessage(tabId, message = {}) {
    message.colorScheme = settings.colorScheme;
    return browser.tabs.sendMessage(tabId, message).catch(() => {});
}

export function prepareForSave(tabs, ...prepareArgs) {
    return tabs.map(tab => prepareForSaveTab(tab, ...prepareArgs));
}

export function prepareForSaveTab(
        {id, url, title, cookieStoreId, favIconUrl, openerTabId, groupId, thumbnail, lastAccessed, uid, lastModified, groupPinned},
        includeGroupId = false,
        includeFavIconUrl = false,
        includeThumbnail = false,
        includeId = true,
        includeLastAccessed = true,
        includeUid = true,
        includeLastModified = true
    ) {
    const tab = {url};

    if (includeId && id) {
        tab.id = id;

        if (openerTabId > 0) {
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

    if (includeUid && uid) {
        tab.uid = uid;
    }

    if (includeLastModified && lastModified) {
        tab.lastModified = lastModified;
    }

    if (groupPinned) {
        tab.groupPinned = true;
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

// const restrictedDomainsRegExp = /^https?:\/\/(.+\.)?(mozilla\.(net|org|com)|firefox\.com)\//;
const restrictedDomains = new Set('accounts-static.cdn.mozilla.net,accounts.firefox.com,addons.cdn.mozilla.net,addons.mozilla.org,api.accounts.firefox.com,content.cdn.mozilla.net,discovery.addons.mozilla.org,oauth.accounts.firefox.com,profile.accounts.firefox.com,support.mozilla.org,sync.services.mozilla.com'.split(','));

export function isCanSendMessage({url}) {
    if (url === 'about:blank') {
        return true;
    }

    if (url.startsWith('about:')) {
        return false;
    }

    if (url.startsWith('moz-extension') && !url.startsWith(Constants.STG_BASE_URL)) {
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

export function isPinned(tab) {
    return tab.pinned === true;
}

function isCanBeHidden(tab) {
    return !isPinned(tab) && !tab.sharingState?.screen && !tab.sharingState?.camera && !tab.sharingState?.microphone;
}

export function isCanNotBeHidden(tab) {
    return !isCanBeHidden(tab);
}

export function isLoaded(tab) {
    return tab.status === browser.tabs.TabStatus.COMPLETE;
}

export function isLoading(tab) {
    return tab.status === browser.tabs.TabStatus.LOADING;
}

export function normalizeUrl(tab) {
    tab.url = Utils.normalizeUrl(tab.url);
    return tab;
}

export function normalizeFavIcon(tab) {
    if (!Utils.isAvailableFavIconUrl(tab.favIconUrl)) {
        tab.favIconUrl = ConstantsBrowser.DEFAULT_FAVICON;
    }

    return tab;
}

export function isSame(tab1, tab2, keys = ['url', 'cookieStoreId', 'groupId']) {
    return Utils.isEqualByKeys(tab1, tab2, keys);
}

export async function restoreOldExtensionUrls(parseUrlFunc = null) {
    const tabs = await browser.tabs.query({
        url: Constants.STG_HELP_PAGES.map(page => `moz-extension://*/help/${page}.html*`),
    });

    await Promise.allSettled(tabs.map(async tab => {
        const oldUrl = tab.url;

        if (parseUrlFunc) {
            tab.url = await parseUrlFunc(tab);
        }

        if (!tab.url.startsWith(Constants.STG_BASE_URL) || oldUrl !== tab.url) {
            await browser.tabs.update(tab.id, {
                url: Constants.STG_BASE_URL + tab.url.slice(Constants.STG_BASE_URL.length),
                loadReplace: true,
            });
        }
    }));
}

export async function reconcile(groups, allTabs) {
    const log = logger.start(['info', reconcile], 'groups count:', groups.length, 'allTabs count:', allTabs.length);

    allTabs = allTabs.slice(); // to prevent bugs...

    const containersStorageMap = new Map;
    const sameTabKeys = ['url', 'cookieStoreId'];

    for (const group of groups) {
        if (group.isArchive) {
            continue;
        }

        log.log('reconcile group', group.id, 'tabs count:', group.tabs.length);

        const newTabParams = Groups.getNewTabParams(group);
        const groupWindowId = Cache.getWindowId(group.id) || group.tabs[0]?.windowId;

        let tabs = [];
        let newTabs = [];

        for (const tab of group.tabs) {
            tab.groupId = group.id;
            tab.cookieStoreId = await Containers.findExistOrCreateSimilar(tab.cookieStoreId, null, containersStorageMap);

            const winTabIndex = allTabs.findIndex(winTab => isSame(winTab, tab, sameTabKeys));

            if (winTabIndex !== -1) {
                const [winTab] = allTabs.splice(winTabIndex, 1);

                tabs.push(Cache.setTabSession(winTab, tab));
            } else {
                tabs.push(null);

                newTabs.push({
                    ...tab,
                    windowId: groupWindowId,
                    active: null,
                    index: null,
                    ...Cache.applySession({}, tab),
                    ...newTabParams,
                });
            }
        }

        if (newTabs.length) {
            log.log('new tabs count:', newTabs.length);
            newTabs = await createMultiple(newTabs, true);
            tabs = tabs.map(tab => tab ?? newTabs.shift()).filter(Boolean);
        }

        group.tabs = tabs;

        const firstTabIndex = group.tabs[0]?.index;
        if (Number.isFinite(firstTabIndex)) {
            log.log('sorting tabs');
            group.tabs = await moveNative(group.tabs, {index: firstTabIndex}, true);
        }
    }

    log.stop();

    return groups;
}
