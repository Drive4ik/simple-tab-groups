
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
// (docs/CREATE-TABS-BEHAVIOR.md §23): the request handler waits for the group decision here
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

    if (skip.created.has(tab.id)) {
        logger.log(onCreated, '🛑 skip created tab:', tab.id);
        return;
    }

    GroupsNative.detachTabGroupId(tab); // native groupId conflicts with STG groupId key

    logger.log(onCreated, tab);

    Cache.setTab(tab);

    if (isPinned(tab)) {
        return;
    }

    await Cache.setTabGroup(tab.id, null, tab.windowId)
        .catch(logger.onCatch("onCreated can't set group", false));

    Cache.applyTabSession(tab);

    updatedBatch.add(tab.id, tab.groupId || `unsync:${tab.windowId}`);
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

    if (skip.tracking.has(tab.id)) {
        Cache.setTab(tab);
        logger.log(onUpdated, '🛑 skip tracking tab:', tab.id);
        return;
    }

    if (skipTrackingWindows.has(tab.windowId)) {
        Cache.setTab(tab);
        logger.log(onUpdated, '🛑 skip tracking tab:', tab.id, 'for window:', tab.windowId);
        return;
    }

    // the subscription is unfiltered (docs/OPENER-BEHAVIOR.md Implications 9), so the event fires
    // on every tab property; no tracked key changed - drop it before the wait and the extra
    // tabs.get. The tab argument already carries the new values, openerTabId included
    // (docs/OPENER-BEHAVIOR.md §10), and it feeds the mirror, not the diff base: the snapshot may
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

    changeInfo = Cache.getRealTabStateChanged(tab);

    Cache.setTab(tab);

    if (!changeInfo) {
        log.stop('🛑 changeInfo keys have not changed');
        return;
    }

    if (isPinned(tab) && !Object.hasOwn(changeInfo, 'pinned')) {
        log.stop('🛑 tab is pinned');
        return;
    }

    if (changeInfo.favIconUrl) {
        await Cache.setTabFavIcon(tab.id, changeInfo.favIconUrl)
            .catch(log.onCatch(['cant set favIcon', tab, changeInfo], false));
    }

    if (Object.hasOwn(changeInfo, 'pinned') || Object.hasOwn(changeInfo, 'hidden')) {
        let tabGroupId;

        if (changeInfo.pinned || changeInfo.hidden) {
            changeInfo.pinned && log.log('remove group for pinned tab', tab.id);
            changeInfo.hidden && log.log('remove group for hidden tab', tab.id);

            tabGroupId = Cache.getTabGroup(tab.id);
            await Cache.removeTabGroup(tab.id).catch(() => {});

            if (changeInfo.pinned) {
                // pinned tabs can't be in a native group, and the mirror doesn't see pinned tabs - clean up here
                await Cache.removeTabNativeGroupId(tab.id).catch(() => {});
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

    const groupId = Cache.getTabGroup(tabId);

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
        logger.log(onMoved, '🛑 skip tracking tab:', tabId);
        return;
    }

    if (skipTrackingWindows.has(windowId)) {
        logger.log(onMoved, '🛑 skip tracking tab:', tabId, 'for window:', windowId);
        return;
    }

    const groupId = Cache.getTabGroup(tabId);

    logger.log(onMoved, {tabId, windowId, groupId, fromIndex, toIndex});

    updatedBatch.add(tabId, groupId || `unsync:${windowId}`);

    // a move can change native membership (join/leave a span) - let the mirror resync the window
    GroupsNative.scheduleMirrorWindow(windowId);
}

// onDetached/onAttached are never muted per-window: the addon's own moves are muted per-tab, a
// restored window never emits attaches (docs/TABGROUPS-BEHAVIOR.md §18), and a moved tab's attach
// can be delivered BEFORE windows.onCreated (§17) - a window-level flag set there is always too
// late. An unmuted attach is a user move and must be mirrored immediately: GrandRestore reads the
// window a second later and relies on the arrived tabs being already unbound from their groups
async function onDetached(tabId, {oldWindowId}) { // notice: called before onAttached
    // ahead of the mutes: the addon's own moves erase the links just the same (docs/OPENER-BEHAVIOR.md §7, §9)
    Cache.clearTabOpeners(tabId);

    if (skip.removed.has(tabId)) {
        logger.log(onDetached, '🛑 skip removed tab:', tabId);
        return;
    }

    if (skip.tracking.has(tabId)) {
        logger.log(onDetached, '🛑 skip tracking tab:', tabId);
        return;
    }

    const groupId = Cache.getWindowGroup(oldWindowId);

    logger.log(onDetached, {tabId, oldWindowId, groupId});

    updatedBatch.add(tabId, groupId || `unsync:${oldWindowId}`);

    GroupsNative.scheduleMirrorWindow(oldWindowId);
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

    const log = logger.start(onAttached, {tabId, newWindowId});

    await Cache.setTabGroup(tabId, null, newWindowId)
        .catch(log.onCatch("can't set group"));

    // a single moved tab arrives ungrouped, a group moved whole arrives with its membership and
    // the same live id, both without any groupId event (docs/TABGROUPS-BEHAVIOR.md §16, §17) -
    // the arrived tab's own groupId is the only signal
    const attachedTab = await get(tabId, {raw: true});

    if (attachedTab?.groupId === GroupsNative.TAB_GROUP_ID_NONE) {
        await Cache.removeTabNativeGroupId(tabId).catch(() => {});
    }

    const groupId = Cache.getTabGroup(tabId);

    log.log('groupId', groupId);

    updatedBatch.add(tabId, groupId || `unsync:${newWindowId}`);

    GroupsNative.scheduleMirrorWindow(newWindowId);

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
export async function create({url, active, pinned, title, index, windowId, openerTabId, cookieStoreId, newTabContainer, ifDifferentContainerReOpen, excludeContainersForReOpen, groupId, groupNativeId, favIconUrl, thumbnail}, params = {}) {
    const schema = tabsActionSchema.get('create');
    const skipTrackingCreated = params.skipTrackingCreated ?? schema.skipTrackingCreated ?? false;

    if (!Constants.IS_BACKGROUND_PAGE) {
        throw new Error('is not background');
    }

    const tab = {};

    let realUrl;

    if (url) {
        if (Utils.isDataUrlAllowToNavigate(url)) {
            realUrl = url;
            url = Constants.PAGES.HELP.DUMMY;
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

        if (tab.url && !Utils.isUrlLengthValid(tab.url)) {
            realUrl = url;
            tab.url = Constants.PAGES.HELP.UNSUPPORTED_URL;
        }
    }

    tab.active = !!active;

    if (pinned) {
        tab.pinned = true;
    }

    if (!tab.active && !tab.pinned && tab.url && !tab.url.startsWith('about:') && !realUrl) {
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

    if (schema.processGroupId) {
        GroupsNative.detachTabGroupId(newTab);
    }

    if (realUrl) {
        pendingRealUrls.set(newTab.id, realUrl);
        self.setTimeout(() => pendingRealUrls.delete(newTab.id), 30_000);
    }

    await Cache.setTabSession(newTab, {groupId, groupNativeId, favIconUrl, thumbnail});

    if (skipTrackingCreated) {
        logger.log('created', newTab.id);
    } else {
        logger.log('created', newTab);
    }

    return newTab;
}

function createUnsupportedUrlPage(url) {
    const unsupportedUrlObj = new URL(Constants.PAGES.HELP.UNSUPPORTED_URL);
    unsupportedUrlObj.searchParams.set('url', url);
    return unsupportedUrlObj.href;
}

/*
tabsToCreate - the tabs to create; with createMissing - a mixed list, where only the tabs marked "new: true" are created, the rest are alive already and are kept as they are, an empty slot stays empty
startIndex - the index of the first created tab in its window, the rest follow it
createMissing - see tabsToCreate
ensureOrder - true: the tabs come out in the list order - explicit ascending indexes per window, from startIndex or the end of the window, created inactive and activated afterwards, the order enforced. false: every tab lands where its own index says, active as asked, startIndex is refused
the created tabs are muted for the addon's own create listener: the caller settles them itself
returns {created, live, aligned}: created - the tabs this call created. live - every tab of the list alive after the call, the created and the kept ones. aligned - live laid over tabsToCreate, undefined where a creation failed
*/
export async function createMultiple(tabsToCreate, params = {}) {
    const startIndex = params.startIndex ?? null;
    const createMissing = params.createMissing ?? false;
    const ensureOrder = params.ensureOrder ?? true;

    if (!Array.isArray(tabsToCreate)) {
        throw new Error('tabs must be an array');
    }

    if (!ensureOrder && startIndex !== null) {
        throw new Error('startIndex is a placement, it contradicts ensureOrder: false');
    }

    const newTabs = createMissing ? tabsToCreate.filter(tab => tab?.new) : tabsToCreate;

    const log = logger.start(createMultiple, 'count:', newTabs.length, {
        startIndex,
        createMissing,
        ensureOrder,
    });

    if (!newTabs.length) {
        log.stop('no tabs to create');

        const aligned = tabsToCreate.map(tab => tab?.new ? undefined : tab);

        return {created: [], live: aligned.filter(Boolean), aligned};
    }

    // explicit ascending indexes per window: a no-index batch comes out reversed (docs/CREATE-TABS-BEHAVIOR.md §4-5)
    const placements = [];

    {
        const nextIndexByWindow = new Map();
        let fallbackWindowId = null;

        for (const [index, tab] of newTabs.entries()) {
            // the window is resolved first and for EVERY tab - a pinned one skips only the index arithmetic
            const windowId = Cache.getWindowId(tab.groupId) || tab.windowId
                || (fallbackWindowId ??= await Windows.getLastFocusedNormalWindow());

            if (tab.pinned || !ensureOrder) {
                placements[index] = {windowId};
                continue;
            }

            // BUG https://bugzilla.mozilla.org/show_bug.cgi?id=1396758
            // the browser's own count, closing tabs included: a tab the user has just closed holds its slot
            // for ~110 ms after onRemoved, and query() would leave it out (docs/REMOVE-TABS-BEHAVIOR.md §4)
            const tabIndex = nextIndexByWindow.get(windowId)
                ?? startIndex
                ?? (await browser.tabs.query({windowId})).length;

            nextIndexByWindow.set(windowId, tabIndex + 1);

            placements[index] = {windowId, index: tabIndex, active: false};
        }
    }

    // the openers are applied afterwards by applyOpeners (docs/OPENER-BEHAVIOR.md §3): a saved opener may not exist yet
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

    if (ensureOrder) {
        const createdTabsByWindow = Map.groupBy(created.filter(Boolean), tab => tab.windowId);

        // safety net: explicit indexes must keep the order (docs/CREATE-TABS-BEHAVIOR.md §2)
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
// the tab stays (docs/OPENER-BEHAVIOR.md §3, §7, Implications 10). Every accepted write feeds
// the mirror right here: Cache.getTabChildren and the tabsToRestore of a closing window read
// the links from it
async function setOpeners(links) {
    const updated = new Map;

    if (links.length) {
        logger.log(setOpeners, links);

        await Promise.all(links.map(async ([tabId, openerTabId]) => {
            try {
                const tab = await browser.tabs.update(tabId, {openerTabId});
                GroupsNative.detachTabGroupId(tab);
                Cache.mirrorTab(tab, true);
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
and re-applying the link a tab already has is a no-op for a tree extension (docs/OPENER-BEHAVIOR.md T5); a link is never removed
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

// the tail of a restore, after createMultiple: the group's live tabs are sorted into the saved
// order, then the native groups - a loaded group gets GroupsNative.apply over its WHOLE live list,
// an unloaded one is stripped (the sort can drop hidden tabs onto live-member slots,
// docs/TABGROUPS-BEHAVIOR.md §11, §12) and hidden - and the links go last: sort first, link last
// (docs/OPENER-BEHAVIOR.md Implications 8)
export async function settleGroupTabs(groupId, savedTabs, {live, aligned}) {
    const tabs = await ensureSorted(live);

    if (Groups.isLoaded(groupId)) {
        const {group} = await Groups.load(groupId, true);

        await GroupsNative.apply(Cache.getWindowId(groupId), group)
            .catch(logger.onCatch(['cant apply native groups', groupId], false));
    } else {
        await GroupsNative.ungroup(tabs);
        await hide(tabs);
    }

    await applyOpeners(savedTabs, aligned);

    return tabs.map(Cache.applyTabSession);
}

// docs/OPENER-BEHAVIOR.md "How STG carries the link" - A transfer (§3, §6, §7, Implications 10)
// a copy that could not be created is an empty slot in the result: its original stays where it is, with its links
export async function recreate(tabs, buildTabFunc, params = {}) {
    const log = logger.start(recreate, 'tabs:', tabs.map(extractId), {params});

    const {aligned: newTabs} = await createMultiple(tabs.map(buildTabFunc), {...params, ensureOrder: false});

    const newIdByOldId = new Map;

    for (const [index, tab] of tabs.entries()) {
        if (newTabs[index]) {
            newIdByOldId.set(tab.id, newTabs[index].id);
        }
    }

    const links = [];

    for (const tab of tabs) {
        if (newIdByOldId.has(tab.id) && tab.openerTabId > 0 && tab.openerTabId !== tab.id) {
            links.push([newIdByOldId.get(tab.id), newIdByOldId.get(tab.openerTabId) ?? tab.openerTabId]);
        }
    }

    for (const child of Cache.getTabChildren(newIdByOldId.keys())) {
        if (!newIdByOldId.has(child.id)) {
            links.push([child.id, newIdByOldId.get(child.openerTabId)]);
        }
    }

    await setOpeners(links);

    await remove(Array.from(newIdByOldId.keys()), params);

    log.stop('new tabs:', newTabs.map(tab => tab?.id ?? null));

    return newTabs;
}

export async function createUrlOnce(url) {
    // the addon's own page: in a window of any type, with its url as the browser holds it
    let [tab] = await query({
        url: url.includes('#') ? url.slice(0, url.indexOf('#')) : url,
        hidden: false,
        windowType: null,
    }, {raw: true});

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

export async function getHighlightedIds(windowId = browser.windows.WINDOW_ID_CURRENT, clickedTab = null, pinned = false) {
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
    // a tab the user closes lingers in tabs.query after onRemoved (docs/REMOVE-TABS-BEHAVIOR.md §4)
    tabs = tabs.filter(tab => !skip.removed.has(tab.id));

    if (raw) {
        return tabs;
    }

    tabs.forEach(GroupsNative.detachTabGroupId);
    tabs.forEach(normalizeUrl);

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
            index: 0, // never joins a span there (docs/TABGROUPS-BEHAVIOR.md §7, R7.12/R7.13)
            windowId: windowId,
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
        // the anchor index can land inside a live span and the tab joins it from birth
        // (docs/TABGROUPS-BEHAVIOR.md §7, §10)
        await GroupsNative.ungroup(tab);
        await hide(tab);
    }

    sendUpdatedGroup(groupId);

    log.stop(tab);
    return tab;
}

export async function updateThumbnail(tabId) {
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

    let tabs = await list(tabIds, {
        sortByIndex: true,
        includeFavIconUrl: true,
        includeThumbnail: settings.showTabsWithThumbnailsInManageGroups,
    });

    if (tabs.length) {
        tabIds = tabs.map(extractId);
    } else {
        log.stop('tabs are empty');
        return [];
    }

    const skippedTabs = skipTrackingTabs(tabIds);

    const tabsCantHide = new Set;
    const windowId = groupWindowId || (group.tabs[0]?.windowId) || await Windows.getLastFocusedNormalWindow();
    const activeTabs = [];

    log.log('vars', {groupWindowId, windowId});
    log.log('filter active');

    let showPinnedMessage = false;

    tabs = tabs.filter(function(tab) {
        if (tab.pinned) {
            showPinnedMessage = true;
            continueTrackingTabs([tab], skippedTabs);
            log.log('tab pinned', tab);
            return false;
        }

        if (isCanNotBeHidden(tab)) {
            tabsCantHide.add(getTitle(tab, false, 20));
            continueTrackingTabs([tab], skippedTabs);
            log.log('cant move tab', tab);
            return false;
        }

        if (tab.active && tab.groupId !== groupId) {
            activeTabs.push(tab);
        }

        return true;
    });

    log.log('active tabs', activeTabs, 'tabs to move COUNT:', tabs.length);

    let destGroupNativeId = null;
    let membershipSnapshot = null;

    try {
        if (tabs.length) {
            destGroupNativeId = resolveDestSubGroupId(group, groupWindowId, tabs, newTabIndex);

            await activateOtherTabs(activeTabs, tabs, windowId, log);
            activeTabs.length = 0; // reset active tabs

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
                await show(tabs.filter(tab => tab.hidden));
            } else {
                // the anchor can drop any mover, hidden ones included, onto a live-member slot
                // (docs/TABGROUPS-BEHAVIOR.md §1, §4 R2.14, §11, §20) - strip the whole set
                await GroupsNative.ungroup(tabs);
                await hide(tabs.filter(tab => !tab.hidden));
            }

            await Promise.all(tabs.map(tab => Cache.setTabGroup(tab.id, groupId)));

            if (destGroupNativeId) {
                // dropped onto a tab of an unloaded group's sub-group - it wins over the carried membership
                await Promise.allSettled(tabs.map(tab => {
                    tab.groupNativeId = destGroupNativeId;
                    return Cache.setTabNativeGroupId(tab.id, destGroupNativeId);
                }));
            } else {
                await GroupsNative.restoreMembership(group, tabs, membershipSnapshot);
            }

            Groups.sendUpdatedAll();

            log.log('end moving');
        }
    } finally {
        continueTrackingTabs(skippedTabs);
    }

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

    return applyGroupAndNotify(group, groupId, windowId, tabs, activeTabs, {showTab, showOnlyActiveTab, showNotification}, log);
}

// no explicit index - the movers line up at the group's tail (or after its last-accessed tab,
// per newTabPosition), keeping the group's tabs contiguous. Membership follows the occupant
// rule: cross-window arrivals at the tail join nothing, same-window movers can be swallowed
// by a live span - a loaded group keeps the browser's placement, an unloaded one strips the
// movers before hiding (docs/TABGROUPS-BEHAVIOR.md §1, §11, §20). An empty group: arrivals
// from other windows append at the end of the strip; movers already in the window gather at
// the first mover's own slot, their live membership stripped first - a member as the first
// mover swallows the whole block (§21), and the snapshot taken before carries the sub-groups
export async function resolveMoveIndex(groupId, windowId, movingTabs) {
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

        await GroupsNative.ungroup(movingTabs);
        return (await get(movingTabs[0], {withSession: false}))?.index ?? movingTabs[0].index;
    }

    // BUG https://bugzilla.mozilla.org/show_bug.cgi?id=1396758
    // the browser's own count, closing tabs included: a tab the user has just closed holds its slot
    // for ~110 ms after onRemoved, and query() would leave it out (docs/REMOVE-TABS-BEHAVIOR.md §4)
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

async function activateOtherTabs(activeTabs, movingTabs, windowId, log) {
    const excludeMovingTabs = tab => !movingTabs.some(t => t.id === tab.id);

    await Promise.all(activeTabs.map(async activeTab => {
        const allTabsInActiveTabWindow = await query({windowId: activeTab.windowId});
        const tabsToActive = allTabsInActiveTabWindow.filter(tab => !tab.hidden && excludeMovingTabs(tab));

        if (tabsToActive.length) {
            log.log('set active some other');
            await setActive(undefined, tabsToActive);
        } else { // if not found other visible (include pinned) tabs in window
            const differentWindows = activeTab.windowId !== windowId;
            const otherHiddenAndVisibleTabsInActiveTabWindow = allTabsInActiveTabWindow.filter(excludeMovingTabs);
            let activeTabIsLastInSrcGroup = false;
            let activeTabIsInLoadedGroup = false;
            let activeTabNotInGroup = false;

            if (activeTab.groupId) {
                activeTabIsLastInSrcGroup = !otherHiddenAndVisibleTabsInActiveTabWindow
                    .some(tab => tab.groupId === activeTab.groupId);

                activeTabIsInLoadedGroup = activeTab.groupId === Cache.getWindowGroup(activeTab.windowId);
            } else {
                activeTabNotInGroup = !Cache.getWindowGroup(activeTab.windowId);
            }

            log.log('create temp tab condition:', {
                differentWindows,
                otherHiddenAndVisibleTabsInActiveTabWindowCount: otherHiddenAndVisibleTabsInActiveTabWindow.length,
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
}

async function recreateTabsForContainer(tabs, group, activeTabs, membershipSnapshot, skippedTabs, log) {
    const containerParams = Groups.getContainerParams(group);
    const containerOf = new Map(tabs.map(tab => [tab, getNewTabContainer(tab, containerParams)]));
    const tabsToRecreate = tabs.filter(tab => tab.cookieStoreId !== containerOf.get(tab));

    if (!tabsToRecreate.length) {
        activeTabs.push(...tabs.filter(tab => tab.active));
        return tabs;
    }

    log.log('recreating tabs for new containers, count:', tabsToRecreate.length);

    const newTabs = await recreate(tabsToRecreate, tab => ({
        ...tab,
        cookieStoreId: containerOf.get(tab),
        groupId: undefined,
        groupNativeId: undefined,
        active: false,
    }), {silentRemove: true});

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

async function applyGroupAndNotify(group, groupId, windowId, tabs, activeTabs, {showTab, showOnlyActiveTab, showNotification}, log) {
    let [firstTab] = activeTabs.length ? activeTabs : tabs;

    const applyGroup = showTab && (!showOnlyActiveTab || activeTabs.length > 0);

    if (applyGroup) {
        log.log('apply group', windowId, groupId, firstTab.id);
        await Groups.apply(windowId, groupId, firstTab.id);
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
    left in another window is refused (docs/OPENER-BEHAVIOR.md §7, §9) */
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

            Cache.clearTabSessionCache(tabAfterMove.id);
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
    ['create', {processGroupId: true, skipTrackingCreated: true}],
    ['get', {sendOneByOne: true, processGroupId: true}], // TODO refactor to use it
    ['discard', {sendArray: true, sendOneByOne: true}],
    ['show', {sendArray: true, sendOneByOne: true, skipTracking: true}],
    ['hide', {sendArray: true, sendOneByOne: true, skipTracking: true}],
    ['remove', {sendArray: true, sendOneByOne: true, skipTracking: true}],
    ['update', {sendOneByOne: true, processGroupId: true}],
    ['reload', {sendOneByOne: true}],
    ['move', {sendArray: true, processGroupId: true, skipTracking: true}],
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
    const silentRemove = params.silentRemove ?? false;

    if (!tabs) {
        throw new Error(`invalid tabs`);
    }

    tabs = Array.isArray(tabs) ? tabs : [tabs];

    let result = schema.defaultValue ?? [];

    const tabIds = tabs.map(extractId);
    const log = logger.start(tabsAction, `browser.tabs.${action}(`,tabIds,...funcArgs,')', {skipTracking, silentRemove});

    if (!tabs.length) {
        log.stop('tabs are empty');
        return result;
    }

    if (action === 'remove' && silentRemove) {
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

    if (schema.processGroupId) {
        result.forEach(GroupsNative.detachTabGroupId);
    }

    log.stop(result.map(extractId), ')');

    return result;
}

export async function show(tabs, params = {}) {
    return await tabsAction({action: 'show', ...params}, tabs);
}

// a tab that can sit in a live native group must be detached first - GroupsNative.ungroup
// before hide (docs/TABGROUPS-BEHAVIOR.md §4); freshly appended tabs don't need it (§10)
export async function hide(tabs, params = {}) {
    return await tabsAction({action: 'hide', ...params}, tabs);
}

export async function discard(tabs, params = {}) {
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

export async function setMute(tabs, muted) {
    logger.log('setMute', {muted});

    tabs = await list(tabs, {withSession: false});
    muted = Boolean(muted);

    tabs = tabs.filter(tab => muted ? tab.audible : tab.mutedInfo.muted);

    return await tabsAction({action: 'update'}, tabs, {muted});
}

// removing all visible tabs closes the window with its hidden tabs (REMOVE-TABS-BEHAVIOR.md §1) -
// give it a temp tab first; the state is read live, the caller's snapshot may be stale
export async function keepWindowsAlive(tabsToRemove) {
    const removedIds = new Set(Array.from(tabsToRemove, tab => tab.id));
    const visibleTabs = await query({hidden: false}, {withSession: false});

    for (const [windowId, windowTabs] of Map.groupBy(visibleTabs, tab => tab.windowId)) {
        if (windowTabs.every(tab => removedIds.has(tab.id))) {
            await createTempActiveTab(windowId, false)
                .catch(logger.onCatch(['cant create temp tab in window', windowId], false));
        }
    }
}

export async function remove(tabs, params = {}) {
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

// the active tab of a window that has just appeared shows an empty url with status complete for
// its first tens of ms, the load starts later (docs/CREATE-TABS-BEHAVIOR.md §26)
export function fillEmptyUrl(tab) {
    const knownUrl = Cache.getTabValue(tab.id, 'url');

    if (knownUrl && Utils.isUrlEmpty(tab.url) && (isLoading(tab) || tab.active)) {
        tab.url = Utils.normalizeUrl(knownUrl);
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
    // the addon's own pages: in a window of any type, with their urls as the browser holds them
    const tabs = await query({
        url: Constants.STG_HELP_PAGES.map(page => `moz-extension://*/help/${page}.html*`),
        windowType: null,
    }, {raw: true});

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

        const {live, aligned} = await createMultiple(tabs, {createMissing: true});

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

    // the array lands as one block in list order around its first tab (docs/MOVE-TABS-BEHAVIOR.md §5)
    if (!isBlock && Number.isInteger(startIndex)) {
        liveTabs = await moveNative(liveTabs, {index: startIndex}, params);
    }

    log.stop();

    return liveTabs;
}
