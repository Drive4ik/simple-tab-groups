
import Listeners from '/js/listeners.js\
?tabs.onActivated\
&tabs.onCreated\
&tabs.onUpdated\
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
import * as GroupsNative from './groups-native.js';
import * as Operations from './operations.js';
import * as Windows from './windows.js';
import * as ConstantsBrowser from './constants-browser.js';
import * as Storage from './storage.js';
import * as BrowserSettings from './browser-settings.js';

export {on, off} from './broadcast.js?channel=tabs';

const logger = new Logger('Tabs');
const mainStorage = localStorage.create(Constants.MODULES.BACKGROUND);
const settings = await Storage.get(['showTabsWithThumbnailsInManageGroups', 'colorScheme']);
Cache.setUseThumbnails(settings.showTabsWithThumbnailsInManageGroups);
const skipTrackingWindows = new Set();
const skip = {
    created: new Set(),
    tracking: new Set(),
    removed: new Set(),
};
const pendingRealUrls = new Map(); // tabId -> url

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

// listeners
const deferredUpdatedKeys = new Set;

function unsyncKey(windowId) {
    return `unsync:${windowId}`;
}

function updatedKey(groupId, windowId) {
    return groupId || unsyncKey(windowId);
}

const updatedBatch = new BatchProcessor(async (tabIds, groupKey) => {
    if (Operations.isBusy()) {
        deferredUpdatedKeys.add(groupKey);
        return;
    }

    logger.log('updatedBatch', groupKey);

    if (groupKey.startsWith('unsync:')) {
        const windowId = Number(groupKey.split(':', 2)[1]);
        send('updated.unsync', {windowId});
        return;
    }

    const {group} = await Groups.load(groupKey);

    if (group) {
        sendUpdatedGroup(groupKey);
    }
});

Operations.onIdle(function sendDeferredUpdated() {
    for (const groupKey of deferredUpdatedKeys) {
        updatedBatch.add(groupKey, groupKey);
    }

    deferredUpdatedKeys.clear();
});

export function skipTrackingWindow(windowId) {
    skipTrackingWindows.add(windowId);
}

export function continueTrackingWindow(windowId) {
    skipTrackingWindows.delete(windowId);
}

export function skipTrackingTabs(tabs, accum = new Set) {
    for (const tab of tabs) {
        const id = extractId(tab);
        skip.tracking.add(id);
        accum.add(id);
    }

    return accum;
}

export function continueTrackingTabs(tabs, accum = null) {
    for (const tab of tabs) {
        const id = extractId(tab);
        skip.tracking.delete(id);
        accum?.delete(id);
    }
}

export function isSkippedTracking(tab) {
    return skip.tracking.has(extractId(tab));
}

// the first load of a new tab reaches onBeforeTabRequest a few ms after this event
// (docs/BEHAVIOR-CREATE-TABS.md §23): the request handler waits for the group decision here
const pendingOnCreatedById = new Map();

async function onCreated(tab) {
    const tabId = tab.id;
    const {promise, resolve} = Promise.withResolvers();

    pendingOnCreatedById.set(tabId, promise);

    try {
        await processCreated(tab);
    } catch (error) {
        logger.logError(['onCreated failed for tab:', tabId], error);
    } finally {
        pendingOnCreatedById.delete(tabId);
        resolve();
    }
}

export function waitOnCreated(tabId) {
    return pendingOnCreatedById.get(tabId) ?? Promise.resolve();
}

async function processCreated(tab) {
    await Utils.wait(50);

    const skipCreated = skip.created.delete(tab.id);

    if (skip.removed.has(tab.id)) {
        logger.log(onCreated, '🛑 skip removed tab:', tab.id);
        return;
    }

    if (skipTrackingWindows.has(tab.windowId)) {
        logger.log(onCreated, '🛑 skip tracking tab:', tab.id, 'for window:', tab.windowId);
        return;
    }

    // the mirror reacts to every appeared tab, including the addon's own (skip.created):
    // newTabPosition=afterCurrent can drop the new tab inside a native group span and the
    // browser joins it to the group. The skip flags only suppress STG's own bookkeeping.
    if (!isPinned(tab)) {
        GroupsNative.scheduleMirrorWindow(tab.windowId);
    }

    if (skipCreated) {
        logger.log(onCreated, '🛑 skip created tab:', tab.id);
        return;
    }

    browserTabToAddon(tab);

    logger.log(onCreated, tab);

    Cache.setTab(tab);

    if (isPinned(tab)) {
        return;
    }

    await Cache.setTabGroup(tab.id, null, tab.windowId)
        .catch(logger.onCatch("onCreated can't set group", false));

    Cache.applyTabSession(tab);

    updatedBatch.add(tab.id, updatedKey(tab.groupId, tab.windowId));
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

async function processPendingRealUrls(tabId, changeInfo) {
    if (pendingRealUrls.has(tabId) && isLoaded(changeInfo)) {
        sendMessage(tabId, {
            action: 'real-url',
            url: pendingRealUrls.get(tabId),
        }).finally(() => pendingRealUrls.delete(tabId));
    }
}

async function onUpdated(tabId, changeInfo, tab) {
    if (skip.removed.has(tab.id)) {
        logger.log(onUpdated, '🛑 skip removed tab:', tab.id);
        return;
    }

    processPendingRealUrls(tabId, changeInfo);
    browserTabToAddon(tab);

    if (skip.tracking.has(tab.id) || skipTrackingWindows.has(tab.windowId)) {
        Cache.setTab(tab, changeInfo);

        if (Object.hasOwn(changeInfo, 'pinned') || Object.hasOwn(changeInfo, 'hidden')) {
            updatedBatch.add(tab.id, updatedKey(Cache.getTabGroup(tab.id), tab.windowId));
        }

        logger.log(onUpdated, '🛑 skip tracking tab:', tab.id, 'window:', tab.windowId);
        return;
    }

    // the subscription is unfiltered (docs/BEHAVIOR-OPENER.md Implications 9), so the event fires
    // on every tab property; no tracked key changed - drop it before the wait and the extra
    // tabs.get. The tab argument already carries the new values, openerTabId included
    // (docs/BEHAVIOR-OPENER.md §10), and it feeds the mirror, not the diff base: the snapshot may
    // hold tracked keys of an event that is still waiting to be processed
    if (!Object.hasOwn(changeInfo, 'groupId') && !Constants.ON_UPDATED_TAB_PROPERTIES.some(key => Object.hasOwn(changeInfo, key))) {
        Cache.mirrorTab(tab);
        logger.log(onUpdated, '🛑 skip event without tracked keys:', tab.id, Object.keys(changeInfo));
        return;
    }

    // if tab was restored along with window, it needs to wait when GrantRestore will add the window to the skipTrackingWindows
    await Utils.wait(50 + 20); // 50ms for tab onCreated + 20ms as a margin

    if (Object.hasOwn(changeInfo, 'groupId')) {
        GroupsNative.scheduleMirrorWindow(tab.windowId);
    }

    // an addon operation could start while we were waiting, and the event snapshot is stale by
    // now anyway - diffing it against lastTabsState would fabricate transitions that never
    // happened, and writing it anywhere would roll back what the muted events of that operation
    // have already recorded. The event is only a signal, the state comes fresh from the browser
    if (skip.tracking.has(tab.id)) {
        logger.log(onUpdated, '🛑 skip tracking tab:', tab.id);
        return;
    }

    // past the cache: this handler is what moves the cache, and a read with the session would
    // hand it the cache's own url for a blank tab (fillEmptyUrl)
    tab = await get(tabId, {withSession: false});

    if (!tab) {
        logger.log(onUpdated, '🛑 tab not found:', tabId);
        return;
    }

    const log = logger.start(onUpdated, tabId, changeInfo);

    // the cache takes what the event announced, not the difference
    const announced = changeInfo;

    changeInfo = Cache.getRealTabStateChanged(tab);

    Cache.setTab(tab, announced);

    if (!changeInfo) {
        log.stop('🛑 changeInfo keys have not changed');
        return;
    }

    if (isPinned(tab) && !Object.hasOwn(changeInfo, 'pinned')) {
        log.stop('🛑 tab is pinned');
        return;
    }

    if (Utils.isAvailableFavIconUrl(tab.favIconUrl)) {
        if (changeInfo.favIconUrl) {
            await Cache.setTabFavIcon(tab.id, changeInfo.favIconUrl)
                .catch(log.onCatch(['cant set favIcon', tab, changeInfo], false));
        }
    } else if (isLoaded(tab) && !tab.discarded) {
        await Cache.removeTabFavIcon(tab.id);
        changeInfo.favIconUrl = null;
    }

    if (Object.hasOwn(changeInfo, 'pinned') || Object.hasOwn(changeInfo, 'hidden')) {
        let tabGroupId;

        if (changeInfo.pinned || changeInfo.hidden) {
            changeInfo.pinned && log.log('remove group for pinned tab', tab.id);
            changeInfo.hidden && log.log('remove group for hidden tab', tab.id);

            tabGroupId = Cache.getTabGroup(tab.id);
            await Cache.removeTabGroup(tab.id);

            if (changeInfo.pinned) {
                // pinned tabs can't be in a native group, and the mirror doesn't see pinned tabs - clean up here
                await Cache.removeTabNativeGroupId(tab.id);
            }
        } else if (changeInfo.pinned === false) {
            log.log('tab is unpinned', tab.id);

            await Cache.setTabGroup(tab.id, null, tab.windowId)
                .catch(log.onCatch(["can't set group to tab, !pinned", tab.id], false));

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
        updatedBatch.add(tab.id, unsyncKey(tab.windowId));

        log.stop();
        return;
    }

    send('updated', {
        tabId: tab.id,
        changeInfo,
    });

    if (isLoaded(changeInfo)) {
        await updateThumbnail(tab.id);
    }

    log.stop();
}

function onRemoved(tabId, {isWindowClosing, windowId}) {
    const silent = skip.removed.has(tabId);

    skip.removed.add(tabId); // BUG https://bugzilla.mozilla.org/show_bug.cgi?id=1396758
    skip.created.delete(tabId);

    const groupId = Cache.getTabGroup(tabId);
    const groupKey = updatedKey(groupId, windowId);

    if (silent) {
        Cache.removeTab(tabId);
        updatedBatch.add(tabId, groupKey);
        logger.log(onRemoved, '🛑 silent removed tab:', tabId);
        return;
    }

    updatedBatch.delete(tabId, groupKey);

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

        // membership dies with the tab; if it was the last member of a native group,
        // tabGroups.onRemoved fires and schedules the mirror itself
    }
}

async function onMoved(tabId, {windowId, fromIndex, toIndex}) {
    // await Utils.wait(); // ? no needs for wait skipTrackingWindows list

    if (skip.removed.has(tabId)) {
        logger.log(onMoved, '🛑 skip removed tab:', tabId);
        return;
    }

    if (skip.tracking.has(tabId)) {
        updatedBatch.add(tabId, updatedKey(Cache.getTabGroup(tabId), windowId));
        logger.log(onMoved, '🛑 skip tracking tab:', tabId);
        return;
    }

    if (skipTrackingWindows.has(windowId)) {
        logger.log(onMoved, '🛑 skip tracking tab:', tabId, 'for window:', windowId);
        return;
    }

    const groupId = Cache.getTabGroup(tabId);

    logger.log(onMoved, {tabId, windowId, groupId, fromIndex, toIndex});

    updatedBatch.add(tabId, updatedKey(groupId, windowId));

    // a move can change native membership (join/leave a span) - let the mirror resync the window
    GroupsNative.scheduleMirrorWindow(windowId);
}

// onDetached/onAttached are never muted per-window: the addon's own moves are muted per-tab, a
// restored window never emits attaches (docs/BEHAVIOR-TABGROUPS.md §18), and a moved tab's attach
// can be delivered BEFORE windows.onCreated (§17) - a window-level flag set there is always too
// late. An unmuted attach is a user move and must be mirrored immediately: GrandRestore reads the
// window a second later and relies on the arrived tabs being already unbound from their groups
async function onDetached(tabId, {oldWindowId}) { // notice: called before onAttached
    // ahead of the mutes: the addon's own moves erase the links just the same (docs/BEHAVIOR-OPENER.md §7, §9)
    Cache.clearTabOpeners(tabId);

    if (skip.removed.has(tabId)) {
        logger.log(onDetached, '🛑 skip removed tab:', tabId);
        return;
    }

    if (skip.tracking.has(tabId)) {
        updatedBatch.add(tabId, updatedKey(Cache.getTabGroup(tabId), oldWindowId));
        logger.log(onDetached, '🛑 skip tracking tab:', tabId);
        return;
    }

    const groupId = Cache.getWindowGroup(oldWindowId);

    logger.log(onDetached, {tabId, oldWindowId, groupId});

    updatedBatch.add(tabId, updatedKey(groupId, oldWindowId));

    GroupsNative.scheduleMirrorWindow(oldWindowId);
}

async function onAttached(tabId, {newWindowId}) { // called when tabs.move()
    if (skip.removed.has(tabId)) {
        logger.log(onAttached, '🛑 skip removed tab:', tabId);
        return;
    }

    if (skip.tracking.has(tabId)) {
        updatedBatch.add(tabId, updatedKey(Cache.getTabGroup(tabId), newWindowId));
        logger.log(onAttached, '🛑 skip tracking tab:', tabId);
        return;
    }

    const log = logger.start(onAttached, {tabId, newWindowId});

    await Cache.setTabGroup(tabId, null, newWindowId)
        .catch(log.onCatch("can't set group"));

    // a single moved tab arrives ungrouped, a group moved whole arrives with its membership and
    // the same live id, both without any groupId event (docs/BEHAVIOR-TABGROUPS.md §16, §17) -
    // the arrived tab's own groupId is the only signal
    const attachedTab = await get(tabId, {raw: true});

    if (attachedTab?.groupId === GroupsNative.TAB_GROUP_ID_NONE) {
        await Cache.removeTabNativeGroupId(tabId);
    }

    const groupId = Cache.getTabGroup(tabId);

    log.log('groupId', groupId);

    updatedBatch.add(tabId, updatedKey(groupId, newWindowId));

    GroupsNative.scheduleMirrorWindow(newWindowId);

    if (groupId && attachedTab?.mutedInfo.muted && !attachedTab.hidden) {
        const {group} = await Groups.load(groupId);
        await Groups.showTabs(group, [attachedTab]);
    }

    log.stop();
}

function onStorageChanged(changes) {
    if (Storage.isChangedKey('showTabsWithThumbnailsInManageGroups', changes, Boolean)) {
        settings.showTabsWithThumbnailsInManageGroups = changes.showTabsWithThumbnailsInManageGroups.newValue;
        Cache.setUseThumbnails(settings.showTabsWithThumbnailsInManageGroups);
    }
    if (Storage.isChangedKey('colorScheme', changes, String)) {
        settings.colorScheme = changes.colorScheme.newValue;
    }
}

// methods
export async function create({url, active, pinned, title, index, windowId, openerTabId, cookieStoreId, newTabContainer, ifDifferentContainerReOpen, excludeContainersForReOpen, groupId, groupNativeId, favIconUrl, thumbnail}, params = {}) {
    const schema = tabsActionSchema.get('create');
    const skipTrackingCreated = params.skipTrackingCreated ?? schema.skipTrackingCreated ?? false;
    const allowDiscarded = params.allowDiscarded ?? true;

    if (!Constants.IS_BACKGROUND_PAGE) {
        throw new Error('is not background');
    }

    const tab = {};
    const {url: createUrl, realUrl, openInReaderMode} = prepareUrlForCreate(url);

    if (createUrl) {
        tab.url = createUrl;
    }

    tab.active = !!active;

    if (pinned) {
        tab.pinned = true;
    }

    if (openInReaderMode) {
        tab.openInReaderMode = true;
    }

    // a tab in reader mode cannot be born discarded (docs/BEHAVIOR-CREATE-TABS.md §30)
    if (allowDiscarded && !tab.active && !tab.pinned && tab.url && !tab.url.startsWith('about:') && !realUrl && !openInReaderMode) {
        tab.discarded = true;
    }

    if (tab.discarded && title) {
        tab.title = title.slice(0, 1000);
    }

    if (Number.isSafeInteger(index) && index >= 0) {
        tab.index = index;
    }

    windowId = Cache.getWindowId(groupId) || windowId;

    if (Number.isSafeInteger(windowId) && windowId > 0) {
        tab.windowId = windowId;
    }

    if (Number.isSafeInteger(openerTabId) && openerTabId > 0) {
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

    if (skipTrackingCreated) {
        skip.created.add(newTab.id);
    }

    browserTabToAddon(newTab);

    if (realUrl) {
        pendingRealUrls.set(newTab.id, realUrl);
        self.setTimeout(() => pendingRealUrls.delete(newTab.id), 30_000);
    }

    // the tab is born on about:blank (docs/BEHAVIOR-CREATE-TABS.md §12)
    if (createUrl) {
        Cache.setTabRequestedUrl(newTab.id, urlToAddon(url));
    }

    fillEmptyUrl(newTab);

    await Cache.setTabSession(newTab, {groupId, groupNativeId, favIconUrl, thumbnail});

    if (skipTrackingCreated) {
        updatedBatch.add(newTab.id, updatedKey(groupId, newTab.windowId));
        logger.log('created', newTab.id);
    } else {
        logger.log('created', newTab);
    }

    return newTab;
}

// built as a string: searchParams.set drops the key of an address over the limit (docs/BEHAVIOR-CREATE-TABS.md §54)
export function wrapUnsupportedUrl(url) {
    return `${Constants.PAGES.HELP.UNSUPPORTED_URL}?${new URLSearchParams({url})}`;
}

function unwrapUrl(url) {
    return Extensions.isWrapperUrl(url)
        ? Utils.getNestedUrl(url) ?? url
        : url;
}

// what browser.tabs.create gets for a url (docs/BEHAVIOR-CREATE-TABS.md §16, §18, §20, §22, §30, §34, §37)
function prepareUrlForCreate(url) {
    const readerPageUrl = getPageUrl(url);
    const openInReaderMode = readerPageUrl !== url && readerPageUrl.startsWith('http');
    const pageUrl = openInReaderMode ? readerPageUrl : url;

    if (!pageUrl || pageUrl === 'about:newtab' || pageUrl === 'about:home') { // both refused by tabs.create, a call without url opens the New Tab page (§16)
        return {};
    }

    const result = {};
    let createUrl;

    if (Utils.isDataUrlAllowToNavigate(pageUrl)) {
        result.realUrl = pageUrl;
        createUrl = Constants.PAGES.HELP.DUMMY;
    } else {
        createUrl = Extensions.urlToBrowserOrNull(pageUrl) ?? wrapUnsupportedUrl(pageUrl);
    }

    if (!Utils.isUrlLengthValid(createUrl)) {
        result.realUrl = pageUrl;
        createUrl = Constants.PAGES.HELP.UNSUPPORTED_URL;
    }

    result.url = createUrl;

    if (openInReaderMode && createUrl.startsWith('http')) {
        result.openInReaderMode = true;
    }

    return result;
}

/*
tabsToCreate - the tabs to create; with createMissing - a mixed list, where only the tabs marked "new: true" are created, the rest are alive already and are kept as they are, an empty slot stays empty
startIndex - the index of the first created tab in its window, the rest follow it; without it the tabs are appended at the end of the window
createMissing - see tabsToCreate
hideUnloaded - true: the created tabs of an unloaded group are hidden plain, past the group's options. false: the caller hides them itself, after its own sort (Groups.settleTabs)
the tabs come out in the list order - explicit ascending indexes per window, created inactive and activated afterwards, the order enforced
the created tabs are muted for the addon's own create listener: the caller settles them itself
returns {created, live, aligned}: created - the tabs this call created. live - every tab of the list alive after the call, the created and the kept ones. aligned - live laid over tabsToCreate, undefined where a creation failed
*/
export async function createMultiple(tabsToCreate, params = {}) {
    const startIndex = params.startIndex ?? null;
    const createMissing = params.createMissing ?? false;
    const hideUnloaded = params.hideUnloaded ?? true;

    if (!Array.isArray(tabsToCreate)) {
        throw new Error('tabs must be an array');
    }

    const newTabs = createMissing ? tabsToCreate.filter(tab => tab?.new) : tabsToCreate;

    const log = logger.start(createMultiple, 'count:', newTabs.length, {
        startIndex,
        createMissing,
        hideUnloaded,
    });

    if (!newTabs.length) {
        log.stop('no tabs to create');

        const aligned = tabsToCreate.map(tab => tab?.new ? undefined : tab);

        return {created: [], live: aligned.filter(Boolean), aligned};
    }

    // explicit ascending indexes per window: a no-index batch comes out reversed (docs/BEHAVIOR-CREATE-TABS.md §4-5)
    const placements = [];

    {
        const nextIndexByWindow = new Map();
        let fallbackWindowId = null;

        for (const [index, tab] of newTabs.entries()) {
            // the window is resolved first and for EVERY tab - a pinned one skips only the index arithmetic
            const windowId = Cache.getWindowId(tab.groupId) || tab.windowId
                || (fallbackWindowId ??= await Windows.getFirstNormalWindowId());

            if (tab.pinned) {
                placements[index] = {windowId};
                continue;
            }

            // BUG https://bugzilla.mozilla.org/show_bug.cgi?id=1396758
            // the browser's own count, closing tabs included: a tab the user has just closed holds its slot
            // for ~110 ms after onRemoved, and query() would leave it out (docs/BEHAVIOR-REMOVE-TABS.md §4)
            const tabIndex = nextIndexByWindow.get(windowId)
                ?? startIndex
                ?? (await browser.tabs.query({windowId})).length;

            nextIndexByWindow.set(windowId, tabIndex + 1);

            placements[index] = {windowId, index: tabIndex, active: false};
        }

        if (startIndex !== null && nextIndexByWindow.size > 1) {
            throw new Error('startIndex is a placement in one window, the tabs are in several');
        }
    }

    // the openers are applied afterwards by applyOpeners (docs/BEHAVIOR-OPENER.md §3): a saved opener may not exist yet
    let created = await Promise.all(newTabs.map(async (tab, index) => {
        try {
            return await create({
                ...tab,
                ...placements[index],
                openerTabId: undefined,
            });
        } catch (error) {
            log.logError(['failed to create tab:', tab, 'reason:'], error);
            return undefined;
        }
    }));

    // ensureOrder
    {
        const createdTabsByWindow = Map.groupBy(created.filter(Boolean), tab => tab.windowId);

        // safety net: explicit indexes must keep the order (docs/BEHAVIOR-CREATE-TABS.md §2)
        for (const windowTabs of createdTabsByWindow.values()) {
            const sorted = await ensureSorted(windowTabs, {...params, byMinIndex: true});
            const sortedById = new Map(sorted.map(tab => [tab.id, tab]));
            created = created.map(tab => sortedById.has(tab?.id) ? Cache.applyTabSession(sortedById.get(tab.id)) : tab);
        }
    }

    for (const [index, tab] of created.entries()) {
        if (newTabs[index].active === true && tab && !tab.active) {
            await setActive(tab.id);
        }
    }

    if (hideUnloaded) {
        // appended past the end of the strip the tabs join nothing (docs/BEHAVIOR-TABGROUPS.md §10), an anchor inside the group can land in a span (§7)
        await hide(created.filter(tab => tab?.groupId && !Cache.getWindowId(tab.groupId)), {ungroupNative: startIndex !== null});
    }

    let next = 0;

    const aligned = createMissing
        ? tabsToCreate.map(tab => tab?.new ? created[next++] : tab)
        : created;

    log.stop();

    return {
        created: created.filter(Boolean),
        live: aligned.filter(Boolean),
        aligned: aligned,
    };
}

// the offsets are read from "fromTabs", the links are given to "toTabs" - the same tabs at the same indexes
export function getOpenersByOffset(fromTabs, toTabs = fromTabs) {
    if (fromTabs.length !== toTabs.length) {
        throw new Error('fromTabs and toTabs must have the same length');
    }

    const openers = new Map;

    // dont't do fromTabs.filter(Boolean) because the indexes must match toTabs
    for (const [index, tab] of fromTabs.entries()) {
        if (tab?.openerOffset && toTabs[index]) {
            openers.set(toTabs[index], toTabs[index + tab.openerOffset]);
        }
    }

    return openers;
}

export function getOpenersById(tabs) {
    const openers = new Map;
    const byId = new Map(tabs.map(tab => [tab?.id, tab]));

    for (const tab of tabs) {
        if (tab?.openerTabId > 0) {
            openers.set(tab, byId.get(tab.openerTabId));
        }
    }

    return openers;
}

export function getOpeners(tabs) {
    return new Map([...getOpenersById(tabs), ...getOpenersByOffset(tabs)]);
}

// "openerOffset" is always the last key of a saved tab (see prepareForSaveTab) - delete + add keeps it there
export function withOffsets(tabs, openers = getOpeners(tabs), {removeIds = false} = {}) {
    return tabs.map((tab, index) => {
        const openerIndex = tabs.indexOf(openers.get(tab));

        tab = {...tab};

        delete tab.openerOffset;

        if (removeIds) {
            delete tab.id;
            delete tab.openerTabId;
        }

        if (openerIndex >= 0 && openerIndex !== index) {
            tab.openerOffset = openerIndex - index;
        }

        return tab;
    });
}

// the single writer of the links; the browser is the judge - a refused link costs nothing,
// the tab stays (docs/BEHAVIOR-OPENER.md §3, §7, Implications 10). Every accepted write feeds
// the mirror right here: Cache.getTabChildren and the tabsToRestore of a closing window read
// the links from it
async function setOpeners(links) {
    const updated = new Map;

    if (links.length) {
        logger.log(setOpeners, links);

        await Promise.all(links.map(async ([tabId, openerTabId]) => {
            try {
                const tab = browserTabToAddon(await browser.tabs.update(tabId, {openerTabId}));
                Cache.mirrorTab(tab);
                updated.set(tabId, tab);
            } catch (e) {
                logger.warn('cant set opener', openerTabId, 'for tab', tabId, e);
            }
        }));
    }

    return updated;
}

/*
savedTabs - the tabs as they were saved, with "openerOffset" relative to this very list
aligned - the "aligned" list createMultiple returned for savedTabs: the browser tabs at the same indexes
every live tab gets its saved opener, without comparing with the current one: the tab objects may be stale by now,
and re-applying the link a tab already has is a no-op for a tree extension (docs/BEHAVIOR-OPENER.md T5); a link is never removed
*/
export async function applyOpeners(savedTabs, aligned) {
    const links = [];

    for (const [tab, opener] of getOpenersByOffset(savedTabs, aligned)) {
        if (opener && opener.id !== tab.id && opener.windowId === tab.windowId) {
            links.push([tab.id, opener.id]);
        }
    }

    await setOpeners(links);
}

async function queryLiveMembers(windowIds) {
    const members = [];

    for (const windowId of windowIds) {
        const tabs = await query({windowId, pinned: false, hidden: false}, {raw: true});
        members.push(...tabs.filter(tab => tab.groupId !== GroupsNative.TAB_GROUP_ID_NONE));
    }

    return members;
}

// docs/BEHAVIOR-OPENER.md "How STG carries the link" - A transfer (§3, §6, §7, Implications 10)
// a copy that could not be created is an empty slot in the result: its original stays where it is, with its links
export async function recreate(tabs, buildTabFunc) {
    const log = logger.start(recreate, 'tabs:', tabs.map(extractId));

    const originals = await list(tabs, {sortByIndex: true});
    const windowIds = new Set(originals.map(tab => tab.windowId));

    // the copy takes the original's slot and its live sub-group by the occupant rule; the first
    // member's slot is the boundary of the span (docs/BEHAVIOR-TABGROUPS.md §7) - its copy goes
    // one slot further, a span of one member is a boundary too (§25); the copies the rule still
    // leaves out stand right next to the span and join in place below (§23)
    const membersBefore = await queryLiveMembers(windowIds);
    const liveIdByOldId = new Map(membersBefore.map(tab => [tab.id, tab.groupId]));
    const firstMemberIds = new Set(
        [...Map.groupBy(membersBefore, tab => tab.groupId).values()]
            .filter(members => members.length > 1)
            .map(members => members.toSorted(Utils.sortBy('index'))[0].id)
    );

    const copyByOldId = new Map;
    const insertedByWindow = new Map;

    for (const tab of originals) {
        const inserted = insertedByWindow.get(tab.windowId) ?? 0;
        const index = tab.index + inserted + (firstMemberIds.has(tab.id) ? 1 : 0);

        try {
            const copy = await create({
                ...buildTabFunc(tab),
                index,
                windowId: tab.windowId,
                openerTabId: undefined,
            }, {allowDiscarded: !isSharing(tab)});

            copyByOldId.set(tab.id, copy);
            insertedByWindow.set(tab.windowId, inserted + 1);
        } catch (error) {
            log.logError(['failed to create tab:', tab, 'reason:'], error);
        }
    }

    const liveIdByCopyId = new Map((await queryLiveMembers(windowIds)).map(tab => [tab.id, tab.groupId]));
    const copiesByLiveId = new Map;

    for (const [oldId, copy] of copyByOldId) {
        const liveId = liveIdByOldId.get(oldId);

        if (liveId && liveIdByCopyId.get(copy.id) !== liveId) {
            copiesByLiveId.getOrInsert(liveId, []).push(copy);
        }
    }

    for (const [liveId, copies] of copiesByLiveId) {
        await group(copies, copies[0].windowId, {joinLiveGroupId: liveId});
    }

    const links = [];

    for (const tab of originals) {
        if (copyByOldId.has(tab.id) && tab.openerTabId > 0 && tab.openerTabId !== tab.id) {
            links.push([copyByOldId.get(tab.id).id, copyByOldId.get(tab.openerTabId)?.id ?? tab.openerTabId]);
        }
    }

    for (const child of Cache.getTabChildren(copyByOldId.keys())) {
        if (!copyByOldId.has(child.id)) {
            links.push([child.id, copyByOldId.get(child.openerTabId).id]);
        }
    }

    await setOpeners(links);

    const copiesToHide = originals
        .filter(tab => copyByOldId.has(tab.id) && (tab.hidden || (tab.groupId && !Cache.getWindowId(tab.groupId))))
        .map(tab => copyByOldId.get(tab.id));

    await hide(copiesToHide);
    await remove([...copyByOldId.keys()]);

    const newTabs = tabs.map(tab => copyByOldId.get(extractId(tab)));

    log.stop('new tabs:', newTabs.map(tab => tab?.id ?? null));

    return newTabs;
}

export async function createUrlOnce(url) {
    // a page in a window of any type
    let [tab] = await query({
        url: url.includes('#') ? url.slice(0, url.indexOf('#')) : url,
        hidden: false,
        windowType: null,
    }, {withSession: false});

    if (tab) {
        const updateProperties = {
            active: true,
        };

        if (tab.browserUrl !== url) {
            updateProperties.url = url;
        }

        [tab] = await tabsAction({action: 'update'}, tab, updateProperties);
    }

    tab ??= browserTabToAddon(await browser.tabs.create({
        url,
        active: true,
    }));

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

export async function getActive(windowId) {
    const [activeTab] = await query({windowId, active: true});

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
            return tabs.toSorted(Utils.sortBy('lastAccessed')).at(-1).index + 1;
        }
    }

    return tabs.at(-1).index + 1;
}

export async function getHighlightedIds(windowId, clickedTab = null, pinned = false) {
    let tabs = await query({windowId, pinned, hidden: false, highlighted: true});

    if (clickedTab && !tabs.some(tab => tab.id === clickedTab.id)) { // if clicked tab not in selected tabs - add it
        tabs.push(clickedTab);

        if (2 === tabs.length) {
            tabs = tabs.filter(tab => tab.active ? (tab.id === clickedTab.id) : true); // exclude active tab if need to move another tab
        }
    }

    return tabs.map(extractId);
}

export async function query(queryInfo = {}, params) {
    const queryParams = {
        windowType: browser.windows.WindowType.NORMAL,
        ...queryInfo,
    };

    for (const key in queryParams) {
        if (queryParams[key] == null) {
            delete queryParams[key];
        }
    }

    const log = logger.start(query, queryParams);

    const tabs = await prepare(await browser.tabs.query(queryParams), params);

    log.stop('count:', tabs.length);

    return tabs;
}

async function prepare(tabs, params = {}) {
    const raw = params.raw ?? false;
    const withSession = params.withSession ?? true;

    // BUG https://bugzilla.mozilla.org/show_bug.cgi?id=1396758
    // a tab the user closes lingers in tabs.query after onRemoved (docs/BEHAVIOR-REMOVE-TABS.md §4)
    tabs = tabs.filter(tab => !skip.removed.has(tab.id));

    if (raw) {
        return tabs;
    }

    tabs.forEach(browserTabToAddon);

    if (!withSession) {
        return tabs;
    }

    tabs = await Promise.all(tabs.map(tab => Cache.loadTabSession(tab, params)));
    tabs = tabs.filter(Boolean);
    tabs.forEach(fillEmptyUrl);

    return tabs;
}

export async function get(tab, params) {
    const [found] = await list([tab], params);
    return found;
}

export async function list(tabs, params = {}) {
    const sortByIndex = params.sortByIndex ?? false;

    const found = await Promise.all(tabs.map(tab => browser.tabs.get(extractId(tab)).catch(() => null)));

    tabs = await prepare(found.filter(Boolean), params);

    if (sortByIndex) {
        tabs = [...Map.groupBy(tabs, tab => tab.windowId).values()]
            .flatMap(windowTabs => windowTabs.toSorted(Utils.sortBy('index')));
    }

    return tabs;
}

export async function createTempActiveTab(windowId, createPinnedTab = true, newTabUrl) {
    const log = logger.start(createTempActiveTab, {windowId, createPinnedTab, newTabUrl});

    const pinnedTabs = await query({windowId, pinned: true}, {withSession: false});

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
            index: 0, // never joins a span there (docs/BEHAVIOR-TABGROUPS.md §7, R7.12/R7.13)
            windowId: windowId,
            groupId: createPinnedTab ? undefined : Cache.getWindowGroup(windowId),
        });

        log.stop('created temp tab', tempTab);
        return tempTab;
    }
}

export function add(...args) {
    return Operations.run('add-tab', () => addNow(...args));
}

async function addNow(groupId, cookieStoreId, url, title) {
    const log = logger.start(addNow, {groupId, cookieStoreId, url, title});

    const windowId = Cache.getWindowId(groupId);

    let {group} = await Groups.load(groupId, !windowId);

    const tab = await create({
        url,
        title,
        cookieStoreId,
        index: windowId ? null : await getNewTabIndex(group.tabs),
        windowId: windowId || group.tabs[0]?.windowId,
        ...Groups.getNewTabParams(group),
    });

    if (!windowId) {
        await Groups.hideTabs(group, [tab]);
    }

    log.stop(tab);
    return tab;
}

export async function updateThumbnail(tabId) {
    if (!settings.showTabsWithThumbnailsInManageGroups) {
        return;
    }

    const log = logger.start(updateThumbnail, {tabId});

    const tab = await get(tabId, {withSession: false});

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

export function move(...args) {
    return Operations.run('move-tabs', () => moveNow(...args));
}

async function moveNow(tabIds, groupId, params = {}) {
    const auto = params.auto ?? false;
    const newTabIndex = params.newTabIndex ?? null;

    const log = logger.start(moveNow, {tabIds, groupId, params});

    const groupWindowId = Cache.getWindowId(groupId);
    const {group, groups} = await Groups.load(groupId, !groupWindowId);

    if (!group) {
        log.stopError('group not found', groupId);
        return [];
    }

    const showTab = params.showTab ?? (auto && group.afterAutoMoveShowTab);
    const showOnlyActiveTab = params.showOnlyActiveTab ?? (auto && group.afterAutoMoveShowOnlyActiveTab);
    const showNotification = params.showNotification ?? (auto && group.afterAutoMoveShowNotification);

    const listParams = {
        sortByIndex: true,
        includeFavIconUrl: true,
        includeThumbnail: true,
    };

    let tabs = await list(tabIds, listParams);

    if (tabs.length) {
        tabIds = tabs.map(extractId);
    } else {
        log.stop('tabs are empty');
        return [];
    }

    const skippedTabs = skipTrackingTabs(tabIds);

    const windowId = groupWindowId || group.tabs[0]?.windowId || tabs[0].windowId;

    log.log('vars', {groupWindowId, windowId});

    let showPinnedMessage = false;

    tabs = tabs.filter(function(tab) {
        if (tab.pinned) {
            showPinnedMessage = true;
            continueTrackingTabs([tab], skippedTabs);
            log.log('tab pinned', tab);
            return false;
        }

        return true;
    });

    log.log('tabs to move COUNT:', tabs.length);

    tabs.forEach(tab => updatedBatch.add(tab.id, updatedKey(tab.groupId, tab.windowId)));

    const activeTabs = [];
    let tempTabs = [];
    let destGroupNativeId = null;
    let membershipSnapshot = null;

    try {
        if (!groupWindowId) {
            const tabsToHide = await Groups.pinSharingTabs(tabs);

            if (tabsToHide.length < tabs.length) {
                continueTrackingTabs(tabs.filter(tab => !tabsToHide.includes(tab)), skippedTabs);
                tabs = await list(tabsToHide, listParams);
            }
        }

        if (tabs.length) {
            destGroupNativeId = resolveDestSubGroupId(group, groupWindowId, tabs, newTabIndex);

            tempTabs = await activateOutside(tabs.filter(tab => tab.windowId !== groupWindowId));

            // the movers' sub-group fate is decided on the ORIGINAL tabs (a drop onto a sub-group
            // tab is dictated by destGroupNativeId instead): the container recreation below swaps
            // tab ids and maps the snapshot onto the copies
            membershipSnapshot = destGroupNativeId
                ? null
                : await GroupsNative.snapshotMembership(tabs, groups, groupId);

            tabs = await recreateTabsForContainer(tabs, group, activeTabs, membershipSnapshot, skippedTabs, log);
        }

        if (tabs.length) {
            tabs = await moveNative(tabs, {
                index: newTabIndex ?? await resolveMoveIndex(groupId, windowId, tabs),
                windowId,
            });

            if (groupWindowId) {
                await Groups.showTabs(group, tabs);
            } else {
                // the anchor can drop any mover, hidden ones included, onto a live-member slot
                // (docs/BEHAVIOR-TABGROUPS.md §1, §4 R2.14, §11, §20) - the whole set goes through hide
                await Groups.hideTabs(group, tabs);
            }

            await Promise.all(tabs.map(tab => Cache.setTabGroup(tab.id, groupId)));
            tabs.forEach(tab => updatedBatch.add(tab.id, groupId));

            if (destGroupNativeId) {
                // dropped onto a tab of an unloaded group's sub-group - it wins over the carried membership
                await Promise.allSettled(tabs.map(tab => {
                    tab.groupNativeId = destGroupNativeId;
                    return Cache.setTabNativeGroupId(tab.id, destGroupNativeId);
                }));
            } else {
                await GroupsNative.restoreMembership(group, tabs, membershipSnapshot);
            }

            log.log('end moving');
        }
    } finally {
        continueTrackingTabs(skippedTabs);
    }

    if (showPinnedMessage) {
        log.log('notify pinnedTabsAreNotSupported');
        Notification('pinnedTabsAreNotSupported');
    }

    if (!tabs.length) {
        log.stop('empty tabs');
        return [];
    }

    return applyGroupAndNotify(group, groupId, windowId, tabs, activeTabs, tempTabs, {showTab, showOnlyActiveTab, showNotification}, log);
}

// the group's tabs gather as one block in the window at their own first tab there, or at the
// group's anchor: strays arrive without joining anyone, the in-window part can be swallowed by
// a live span (docs/BEHAVIOR-TABGROUPS.md §20, §21) - the caller rebuilds the sub-groups after
export async function moveToWindow(tabs, groupId, windowId) {
    const anchorTab = tabs.find(tab => tab.windowId === windowId);

    return moveNative(tabs, {
        index: anchorTab?.index ?? await resolveMoveIndex(groupId, windowId, tabs),
        windowId,
    });
}

// no explicit index - the movers line up at the group's tail (or after its last-accessed tab,
// per newTabPosition), keeping the group's tabs contiguous. Membership follows the occupant
// rule: cross-window arrivals at the tail join nothing, same-window movers can be swallowed
// by a live span - a loaded group keeps the browser's placement, an unloaded one strips the
// movers before hiding (docs/BEHAVIOR-TABGROUPS.md §1, §11, §20). An empty group: arrivals
// from other windows append at the end of the strip; movers already in the window gather at
// the first mover's own slot, their live membership stripped first - a member as the first
// mover swallows the whole block (§21), and the snapshot taken before carries the sub-groups
async function resolveMoveIndex(groupId, windowId, movingTabs) {
    const movingIds = new Set(movingTabs.map(extractId));
    const groupTabs = (await query({windowId, pinned: false})).filter(tab => !movingIds.has(tab.id) && tab.groupId === groupId);
    const anchor = await getNewTabIndex(groupTabs);

    if (anchor != null) {
        return anchor;
    }

    if (movingTabs.every(tab => tab.windowId === windowId)) {
        // live groups, not sessions: the mirror is deferred while an operation runs, so a span
        // the user has just made may not be in the sessions yet
        if (!await GroupsNative.hasLiveGroups(windowId)) {
            return movingTabs[0].index;
        }

        await ungroup(movingTabs);
        return (await get(movingTabs[0], {withSession: false}))?.index ?? movingTabs[0].index;
    }

    // BUG https://bugzilla.mozilla.org/show_bug.cgi?id=1396758
    // the browser's own count, closing tabs included: a tab the user has just closed holds its slot
    // for ~110 ms after onRemoved, and query() would leave it out (docs/BEHAVIOR-REMOVE-TABS.md §4)
    return (await browser.tabs.query({windowId})).length;
}

// dropping onto a tab of an UNLOADED group: the moved tabs inherit its native sub-group
function resolveDestSubGroupId(group, groupWindowId, tabs, newTabIndex) {
    if (groupWindowId || newTabIndex == null) {
        return;
    }

    const movingTabIds = new Set(tabs.map(extractId));
    const targetTab = group.tabs.find(tab => !movingTabIds.has(tab.id) && tab.index === newTabIndex);

    if (group.groupsNative.some(entry => entry.id === targetTab?.groupNativeId)) {
        return targetTab.groupNativeId;
    }
}

async function recreateTabsForContainer(tabs, group, activeTabs, membershipSnapshot, skippedTabs, log) {
    const containerParams = Groups.getContainerParams(group);
    const containerOf = new Map(tabs.map(tab => [tab.id, getNewTabContainer(tab, containerParams)]));
    const tabsToRecreate = tabs.filter(tab => tab.cookieStoreId !== containerOf.get(tab.id));

    if (!tabsToRecreate.length) {
        activeTabs.push(...tabs.filter(tab => tab.active));
        return tabs;
    }

    log.log('recreating tabs for new containers, count:', tabsToRecreate.length);

    const newTabs = await recreate(tabsToRecreate, tab => ({
        ...tab,
        cookieStoreId: containerOf.get(tab.id),
        groupId: undefined,
        groupNativeId: undefined,
        active: false,
    }));

    skipTrackingTabs(newTabs.filter(Boolean), skippedTabs);

    const newTabByOldId = new Map(tabsToRecreate.map((tab, index) => [tab.id, newTabs[index]]));

    return tabs.flatMap(tab => {
        if (!newTabByOldId.has(tab.id)) {
            if (tab.active) {
                activeTabs.push(tab);
            }

            return [tab];
        }

        const newTab = newTabByOldId.get(tab.id);

        if (!newTab) {
            continueTrackingTabs([tab], skippedTabs);
            log.log('cant move tab, the copy was not created', tab.id);
            return [];
        }

        if (membershipSnapshot?.has(tab.id)) {
            membershipSnapshot.set(newTab.id, membershipSnapshot.get(tab.id));
            membershipSnapshot.delete(tab.id);
        }

        if (tab.active) {
            activeTabs.push({...newTab, active: true});
        }

        return [newTab];
    });
}

async function applyGroupAndNotify(group, groupId, windowId, tabs, activeTabs, tempTabs, {showTab, showOnlyActiveTab, showNotification}, log) {
    let [firstTab] = activeTabs.length ? activeTabs : tabs;

    const applyGroup = showTab && (!showOnlyActiveTab || activeTabs.length > 0);

    if (applyGroup) {
        log.log('apply group', windowId, groupId, firstTab.id);

        if (await Groups.apply(windowId, groupId, firstTab.id)) {
            await remove(tempTabs.filter(tab => tab.windowId === windowId), {ungroupNative: false, keepWindowsAlive: false});
        }
    }

    if (applyGroup || !showNotification) {
        log.stop('no notify, count:', tabs.length);
        return tabs;
    }

    let message = [];
    let iconUrl = null;

    if (tabs.length > 1) {
        message = ['moveMultipleTabsToGroupMessage', tabs.length];
        iconUrl = Groups.getIconUrl(group);
    } else {
        const tabTitle = getTitle(firstTab, false, 50);
        message = ['moveTabToGroupMessage', group.title, tabTitle];
        firstTab = normalizeFavIcon(firstTab);
        iconUrl = firstTab.favIconUrl;
    }

    Notification(message, {
        iconUrl,
        module: ['groups', 'apply', null, groupId, firstTab.id],
    });

    log.stop('with notify, count:', tabs.length);
    return tabs;
}

export async function moveNative(tabs, moveProperties = {}, params = {}) {
    tabs = Array.isArray(tabs) ? tabs : [tabs];

    const tabsLengthBefore = tabs.length;
    const log = logger.start(moveNative, 'tabs:', tabs.map(extractId), {moveProperties, params});

    tabs = await list(tabs, {includeFavIconUrl: true, includeThumbnail: true});
    const tabsBeforeMoveMap = new Map(tabs.map(tab => [tab.id, tab]));

    tabs = await tabsAction({action: 'move', ...params}, tabs, moveProperties);

    /* a cross-window move erases the opener even when it moved along - restore it manually;
    the browser is the judge: an opener that is in the tab's new window is accepted, one
    left in another window is refused (docs/BEHAVIOR-OPENER.md §7, §9) */
    const links = [];

    for (const tab of tabs) {
        const beforeMove = tabsBeforeMoveMap.get(tab.id);

        if (beforeMove?.windowId !== tab.windowId && beforeMove?.openerTabId > 0 && beforeMove.openerTabId !== tab.id) {
            links.push([tab.id, beforeMove.openerTabId]);
        }
    }

    const updated = await setOpeners(links);

    tabs = tabs.map(tab => updated.get(tab.id) ?? tab);

    // BUG brorser.session values are lost after moving DISCARDED tabs to ANOTHER window
    const tabAfterMoveNeedFixing = tabAfterMove => {
        const tabBeforeMove = tabsBeforeMoveMap.get(tabAfterMove.id);
        return tabBeforeMove.discarded && tabBeforeMove.windowId !== tabAfterMove.windowId;
    };

    if (tabs.some(tabAfterMoveNeedFixing)) {
        log.log('fixing session after move...');

        // allSettled is just in case
        tabs = await Promise.allSettled(tabs.map(async tabAfterMove => {
            if (!tabAfterMoveNeedFixing(tabAfterMove)) {
                return tabAfterMove;
            }

            Cache.forgetTab(tabAfterMove.id);
            tabAfterMove = await Cache.loadTabSession(tabAfterMove, {includeFavIconUrl: true, includeThumbnail: true});

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

    // our moves are event-suppressed - let the mirror resync native membership of the touched windows
    const mirrorWindowIds = new Set();
    for (const tab of tabsBeforeMoveMap.values()) {
        mirrorWindowIds.add(tab.windowId);
    }
    for (const tab of tabs) {
        mirrorWindowIds.add(tab.windowId);
    }
    mirrorWindowIds.forEach(id => GroupsNative.scheduleMirrorWindow(id));

    if (tabs.length !== tabsLengthBefore) {
        log.stopWarn('some tabs were not moved, before:', tabsLengthBefore, 'after:', tabs.length);
    } else {
        log.stop('tabs count:', tabs.length);
    }

    return tabs;
}

const tabsActionSchema = new Map([
    ['create', {skipTrackingCreated: true}],
    ['get', {sendOneByOne: true, returnsTabs: true}], // TODO refactor to use it
    ['discard', {sendArray: true, sendOneByOne: true}],
    ['show', {sendArray: true, sendOneByOne: true, skipTracking: true}],
    ['hide', {sendArray: true, sendOneByOne: true, skipTracking: true}],
    ['remove', {sendArray: true, sendOneByOne: true, skipTracking: true}],
    ['update', {sendOneByOne: true, returnsTabs: true}],
    ['reload', {sendOneByOne: true}],
    ['move', {sendArray: true, returnsTabs: true, skipTracking: true}],
    ['group', {sendAsIs: true, skipTracking: true, defaultValue: browser.tabGroups.TAB_GROUP_ID_NONE}], // the browser's own argument object → native groupId; defaultValue on fail
    ['ungroup', {sendArray: true, sendOneByOne: true, skipTracking: true}],
]);

async function tabsAction({action, ...params}, tabs, ...funcArgs) {
    const schema = tabsActionSchema.get(action);

    if (!schema) {
        throw new Error(`invalid action: ${action}`);
    }

    if (action === 'create') {
        throw new Error('create is not sent by tabsAction');
    }

    const skipTracking = params.skipTracking ?? schema.skipTracking ?? false;

    if (!tabs) {
        throw new Error(`invalid tabs`);
    }

    tabs = Array.isArray(tabs) ? tabs : [tabs];

    let result = schema.defaultValue ?? [];

    const tabIds = tabs.map(extractId);
    const log = logger.start(tabsAction, `browser.tabs.${action}(`,tabIds,...funcArgs,')', {skipTracking});

    if (!tabs.length) {
        log.stop('tabs are empty');
        return result;
    }

    if (action === 'remove' && skipTracking) {
        tabIds.forEach(tabId => skip.removed.add(tabId));
    }

    const skipped = skipTracking
        ? new Set(tabIds).difference(skip.tracking)
        : new Set;

    skipTrackingTabs(skipped);

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

    try {
        if (schema.sendAsIs) {
            // the caller passes prebuilt args as-is; result isn't a tabs array → skip the array post-processing below
            try {
                result = await browser.tabs[action](...funcArgs);
            } catch (e) {
                log.logError(`fail ${action} tabs`, e);
            }

            log.stop(result, ')');

            return result;
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
    } finally {
        continueTrackingTabs(skipped);
    }

    if (schema.returnsTabs) {
        result.forEach(browserTabToAddon);
    }

    log.stop(result.map(extractId), ')');

    return result;
}

export async function show(tabs, params = {}) {
    return await tabsAction({action: 'show', ...params}, tabs);
}

async function activateOutside(tabs) {
    const ids = new Set(tabs.map(extractId));
    const tempTabs = [];

    if (!ids.size) {
        return tempTabs;
    }

    const activeTabs = await query({active: true}, {withSession: false});

    for (const activeTab of activeTabs.filter(tab => ids.has(tab.id))) {
        const visibleTabs = await query({windowId: activeTab.windowId, hidden: false}, {withSession: false});
        const otherTabs = visibleTabs.filter(tab => !ids.has(tab.id));

        if (otherTabs.length) {
            await setActive(null, otherTabs);
        } else {
            tempTabs.push(await createTempActiveTab(activeTab.windowId, false));
        }
    }

    return tempTabs.filter(Boolean);
}

// the tabs leave their live native groups first (ungroupNative): the header of a group whose tabs
// are all hidden stays in the tab bar (docs/BEHAVIOR-TABGROUPS.md §4). tabs.hide skips the window's
// active tab (§9) - activateOther hands the activity to another visible tab before
export async function hide(tabs, params = {}) {
    const activateOther = params.activateOther ?? false;
    const ungroupNative = params.ungroupNative ?? true;

    tabs = Array.isArray(tabs) ? tabs : [tabs];

    if (!tabs.length) {
        return [];
    }

    if (activateOther) {
        await activateOutside(tabs);
    }

    if (ungroupNative) {
        await ungroup(tabs);
    }

    return await tabsAction({action: 'hide', ...params}, tabs);
}

export async function discard(tabs, params = {}) {
    // an empty tab holds nothing worth freeing, and a reader tab discarded on about:blank reports about:blank until it is activated (docs/BEHAVIOR-CREATE-TABS.md §35); the skipped tab stays loaded until the next unload of its group
    tabs = [tabs].flat().filter(tabOrId => !Utils.isUrlEmpty(tabOrId.browserUrl));

    return await tabsAction({action: 'discard', ...params}, tabs);
}

export async function pin(tabs) {
    return await tabsAction({action: 'update', skipTracking: true}, tabs, {pinned: true});
}

export async function group(tabs, windowId, params = {}) {
    const joinLiveGroupId = params.joinLiveGroupId ?? null;

    const tabIds = tabs.map(extractId);
    const groupProperties = joinLiveGroupId
        ? {tabIds, groupId: joinLiveGroupId}
        : {tabIds, createProperties: {windowId}};
    return await tabsAction({action: 'group', ...params}, tabs, groupProperties);
}

export async function ungroup(tabs, params = {}) {
    return await tabsAction({action: 'ungroup', ...params}, tabs);
}

export async function reload(tabs, bypassCache = false) {
    return await tabsAction({action: 'reload'}, tabs, {bypassCache});
}

export async function setMute(tabs, muted, params = {}) {
    const onlyMutedBySelf = params.onlyMutedBySelf ?? false;

    muted = Boolean(muted);

    if (onlyMutedBySelf) {
        tabs = tabs.filter(tab => !tab.mutedInfo || isMutedBySelf(tab));
    }

    const ids = new Set(tabs.map(extractId));

    if (!ids.size) {
        return [];
    }

    logger.log('setMute', {muted, onlyMutedBySelf});

    const found = await query(muted ? {audible: true} : {muted: true}, {withSession: false});
    const tabsToUpdate = found.filter(tab => ids.has(tab.id) && (!onlyMutedBySelf || isMutedBySelf(tab)));

    return await tabsAction({action: 'update'}, tabsToUpdate, {muted});
}

// removing all visible tabs closes the window with its hidden tabs (BEHAVIOR-REMOVE-TABS.md §1) -
// give it a temp tab first; the state is read live, the caller's snapshot may be stale
async function ensureWindowsAlive(tabsToRemove) {
    const removedIds = new Set(tabsToRemove.map(extractId));
    const visibleTabs = await query({hidden: false}, {withSession: false});

    for (const [windowId, windowTabs] of Map.groupBy(visibleTabs, tab => tab.windowId)) {
        if (windowTabs.every(tab => removedIds.has(tab.id))) {
            await createTempActiveTab(windowId, false)
                .catch(logger.onCatch(['cant create temp tab in window', windowId], false));
        }
    }
}

// keepWindowsAlive - see ensureWindowsAlive.
// A caller that knows better passes false: hidden tabs that were stripped when hidden, a window
// that keeps a visible tab for sure
export async function remove(tabs, params = {}) {
    const ungroupNative = params.ungroupNative ?? true;
    const keepWindowsAlive = params.keepWindowsAlive ?? true;

    tabs = Array.isArray(tabs) ? tabs : [tabs];

    if (!tabs.length) {
        return [];
    }

    // closing a whole live native group in one call leaves a SAVED group in the browser that no API
    // can remove (docs/BEHAVIOR-TABGROUPS.md §26) - the tabs leave their groups first
    if (ungroupNative) {
        await ungroup(tabs);
    }

    if (keepWindowsAlive) {
        await ensureWindowsAlive(tabs);
    }

    return await tabsAction({action: 'remove', ...params}, tabs);
}

export async function sendMessage(tabId, message = {}) {
    message.colorScheme = settings.colorScheme;
    return browser.tabs.sendMessage(tabId, message).catch(() => {});
}

export function prepareForSave(tabs, params = {}) {
    if (params.includeOpener !== false) {
        tabs = withOffsets(tabs);
    }

    return tabs.map(tab => prepareForSaveTab(tab, params));
}

export function prepareForSaveTab(
        sourceTab,
        {
            includeGroupId = false,
            includeGroupNativeId = true,
            includeFavIconUrl = false,
            includeThumbnail = false,
            includeOpener = true,
            includeLastAccessed = true,
        } = {}
    ) {
    const {url, title, cookieStoreId, favIconUrl, openerOffset, groupId, groupNativeId, thumbnail, lastAccessed} = sourceTab;

    const tab = {url};

    if (title) {
        tab.title = title;
    }

    if (!Containers.isDefault(cookieStoreId)) {
        tab.cookieStoreId = Containers.isTemporary(cookieStoreId) ? Constants.TEMPORARY_CONTAINER : cookieStoreId;
    }

    if (includeGroupId && groupId) {
        tab.groupId = groupId;
    }

    if (includeGroupNativeId && groupNativeId) {
        tab.groupNativeId = groupNativeId;
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

    // last on purpose: withOffsets rewrites this key on an already saved tab (delete + add puts it last),
    // and the cloud compares saved tabs as JSON strings - both writers must produce the same key order
    if (includeOpener && openerOffset) {
        tab.openerOffset = openerOffset;
    }

    return tab;
}

export function getNewTabContainer(
        {cookieStoreId},
        {newTabContainer = Constants.DEFAULT_COOKIE_STORE_ID, ifDifferentContainerReOpen, excludeContainersForReOpen = []}
    ) {

    if (cookieStoreId === newTabContainer || Containers.isTemporary(cookieStoreId)) {
        return cookieStoreId;
    }

    if (ifDifferentContainerReOpen) {
        return excludeContainersForReOpen.includes(cookieStoreId) ? cookieStoreId : newTabContainer;
    }

    return Containers.isDefault(cookieStoreId) ? newTabContainer : cookieStoreId;
}

// the page a tab shows: for a tab in reader mode, the page it reads (docs/BEHAVIOR-CREATE-TABS.md §30)
export function getPageUrl(url) {
    return url?.startsWith(Constants.READER_MODE_PAGE)
        ? Utils.getNestedUrl(url) ?? url
        : url;
}

// the url as the addon keeps it (extensions.js)
export function urlToAddon(url) {
    return Extensions.urlToId(unwrapUrl(url));
}

export function tabUrlToAddon(tab) {
    tab.url = urlToAddon(tab.url);
    return tab;
}

// a tab of the browser as the addon keeps it
function browserTabToAddon(tab) {
    GroupsNative.detachTabGroupId(tab); // native groupId conflicts with STG groupId key
    Object.defineProperty(tab, 'browserUrl', {value: tab.url, writable: true, configurable: true}); // not enumerable: stays out of messages and saved data
    tabUrlToAddon(tab);
    return tab;
}

export function getTitle({id, index, title, url, discarded, windowId, lastAccessed}, withUrl = false, sliceLength = 0, withActiveTab = false) {
    url = Utils.sliceText(getPageUrl(url), 2048);
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

export function isCanSendMessage({browserUrl: url}) {
    if (url === 'about:blank') {
        return true;
    }

    if (url.startsWith('about:')) {
        return false;
    }

    if (Extensions.isExtensionUrl(url) && !Extensions.isOwnUrl(url)) {
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

export function isSharing(tab) {
    return Boolean(tab.sharingState?.screen || tab.sharingState?.camera || tab.sharingState?.microphone);
}

function isMutedBySelf(tab) {
    return Boolean(tab.mutedInfo?.muted) && tab.mutedInfo.extensionId === browser.runtime.id;
}

export function isLoaded(tab) {
    return tab.status === browser.tabs.TabStatus.COMPLETE;
}

export function isLoading(tab) {
    return tab.status === browser.tabs.TabStatus.LOADING;
}

// an empty url in a snapshot gets what the cache knows (docs/BEHAVIOR-CREATE-TABS.md §12, §26)
export function fillEmptyUrl(tab) {
    if (Utils.isUrlEmpty(tab.url)) {
        tab.url = Cache.getTabUrl(tab.id) ?? tab.url;
    }

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
    // the addon's own pages in a window of any type
    let tabs = await query({
        url: Constants.PAGES.HELP_PATHS.map(path => `moz-extension://*/${path}*`),
        windowType: null,
    }, {withSession: false});

    // under another uuid it is a page of an old install of the addon, unless the uuid is of a known extension
    tabs = tabs.filter(tab => Extensions.isOwnUrl(tab.browserUrl) || !Extensions.getByUrl(tab.browserUrl));

    await Promise.allSettled(tabs.map(async tab => {
        const url = parseUrlFunc ? await parseUrlFunc(tab) : tab.browserUrl;

        if (!url.startsWith(Constants.STG_BASE_URL) || url !== tab.browserUrl) {
            await browser.tabs.update(tab.id, {
                url: Constants.STG_BASE_URL + url.slice(Constants.STG_BASE_URL.length),
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
        const sessionPromises = [];
        const savedTabs = group.tabs;
        const tabs = [];

        for (const tab of savedTabs) {
            tab.groupId = group.id;
            tab.cookieStoreId = await Containers.findExistOrCreateSimilar(tab.cookieStoreId, null, containersStorageMap);

            const winTabIndex = allTabs.findIndex(winTab => isSame(winTab, tab, sameTabKeys));

            if (winTabIndex !== -1) {
                const [winTab] = allTabs.splice(winTabIndex, 1);

                // the adopted tab takes the source's native membership - its own belongs to the old group
                delete winTab.groupNativeId;
                sessionPromises.push(Cache.setTabSession(winTab, tab));
                tabs.push(winTab);
            } else {
                tabs.push({
                    ...tab,
                    new: true,
                    windowId: groupWindowId,
                    active: null,
                    index: null,
                    ...newTabParams,
                });
            }
        }

        await Promise.allSettled(sessionPromises);

        const {live, aligned} = await createMultiple(tabs, {createMissing: true, hideUnloaded: false});

        group.tabs = await ensureSorted(live);

        await applyOpeners(savedTabs, aligned);
    }

    log.stop();

    return groups;
}

export async function ensureSorted(tabs, params = {}) {
    const byMinIndex = params.byMinIndex ?? false;

    let liveTabs = await list(tabs, {withSession: false});

    const isBlock = liveTabs.every((tab, i) => {
        if (i === 0) {
            return true;
        }

        const prevTab = liveTabs[i - 1];

        if (tab.windowId !== prevTab.windowId) {
            return false;
        }

        return tab.index === prevTab.index + 1;
    });

    const startIndex = byMinIndex
        ? Math.min(...liveTabs.map(tab => tab.index))
        : liveTabs[0]?.index;

    const log = logger.start(ensureSorted, 'tabs:', liveTabs.map(extractId), {isBlock, startIndex: String(startIndex)});

    // the array lands as one block in list order around its first tab (docs/BEHAVIOR-MOVE-TABS.md §5)
    if (!isBlock && Number.isInteger(startIndex)) {
        liveTabs = await moveNative(liveTabs, {index: startIndex}, params);
    }

    log.stop();

    return liveTabs;
}
