import './prefixed-storage.js';

import Logger, {errorEventHandler} from './logger.js';
import backgroundSelf from './background.js';
import * as GroupsBroadcast from './broadcast.js?channel=groups';
import * as Constants from './constants.js';
import * as Storage from './storage.js';
import * as Cache from './cache.js';
import Notification from './notification.js';
import Lang from '/js/lang.js';
import * as Containers from './containers.js';
import * as Browser from './browser.js';
import * as Bookmarks from './bookmarks.js';
import * as Extensions from './extensions.js';
import * as Menus from './menus.js';
import * as MenusMain from './menus-main.js';
// import * as Messages from './messages.js';
// import JSON from './json.js';
import * as Tabs from './tabs.js';
import * as Windows from './windows.js';
import * as Utils from './utils.js';
import GroupsHistory from './groups-history.js';
import * as DeltaCapture from './sync/delta/delta-capture.js';
import {runUserMutation} from './sync/delta/user-priority-lock.js';

export {on, off} from './broadcast.js?channel=groups';

const logger = new Logger(Constants.MODULES.GROUPS);
const mainStorage = localStorage.create(Constants.MODULES.BACKGROUND);
const windowsWithLoadingGroups = new Set();
const groupsHistory = new GroupsHistory();

export function fillHistory(windows) {
    return groupsHistory.fill(windows);
}

export async function applyByPosition(direction, windowId, groups, currentGroupId) {
    groups = groups.filter(group => !isPinnedGroup(group));

    if (!groups.length) {
        return false;
    }

    const currentGroupIndex = groups.findIndex(group => group.id === currentGroupId);
    const nextGroupIndex = Utils.getNextIndex(currentGroupIndex, groups.length, direction, true);

    return apply(windowId, groups[nextGroupIndex].id);
}

export async function applyByHistory(direction, windowId, groups) {
    const nextGroupId = await groupsHistory.move(windowId, groups, direction);

    if (!nextGroupId) {
        return false;
    }

    return apply(windowId, nextGroupId, undefined, true);
}

export async function apply(windowId, groupId, activeTabId, applyFromHistory = false, ignoreSharing = false) {
    const log = logger.start(apply, 'groupId:', groupId, 'windowId:', windowId, 'activeTabId:', activeTabId);

    windowId ||= await Windows.getLastFocusedNormalWindow();

    if (!windowId) {
        log.stopError('no window was found for apply');
        return false;
    } else if (windowsWithLoadingGroups.has(windowId)) {
        log.stopWarn('window in loading state now', windowId);
        return false;
    }

    if (isPinnedGroupId(groupId)) {
        log.stop('pinned group toggle');
        return togglePinnedGroupInWindow(windowId);
    }

    windowsWithLoadingGroups.add(windowId);

    const groupWindowId = Cache.getWindowId(groupId);

    let result = null;

    const skippedTrackingTabIds = new Set();

    try {
        const addTabs = [];

        if (groupWindowId) {
            if (activeTabId) {
                Tabs.setActive(activeTabId);
            }

            Windows.setFocus(groupWindowId);
        } else {
            // magic

            const {group: groupToShow, groups} = await load(groupId, true),
                oldGroupId = Cache.getWindowGroup(windowId),
                groupToHide = groups.find(gr => gr.id === oldGroupId),
                tabsIdsToRemove = new Set;

            for (const tab of groupToShow?.tabs || []) {
                const id = Tabs.extractId(tab);
                id != null && skippedTrackingTabIds.add(id);
            }
            for (const tab of groupToHide?.tabs || []) {
                const id = Tabs.extractId(tab);
                id != null && skippedTrackingTabIds.add(id);
            }

            if (!groupToShow) {
                log.throwError('groupToShow not found');
            }

            if (groupToShow.isArchive) {
                Notification(['groupIsArchived', groupToShow.title]);
                throw '';
            }

            const sharingTabs = groupToHide?.tabs.filter(tab => !isGroupPinned(tab) && Tabs.isCanNotBeHidden(tab)) || [];

            if (sharingTabs.length && !ignoreSharing) {
                const titles = sharingTabs.map(tab => Tabs.getTitle(tab, false, 20)).join(', ');
                Notification(['notPossibleSwitchGroupBecauseSomeTabShareMicrophoneOrCamera', titles], {
                    module: ['groups', 'apply', windowId, groupId, activeTabId, applyFromHistory, true],
                    expires: Notification.MAX_EXPIRES,
                });
                throw '';
            }

            await Browser.actionLoading();

            // show tabs
            if (groupToShow.tabs.length) {
                if (groupToShow.tabs.some(tab => tab.windowId !== windowId)) {
                    groupToShow.tabs = await Tabs.moveNative(groupToShow.tabs, {
                        index: -1,
                        windowId: windowId,
                    }, true);
                }

                await Tabs.show(groupToShow.tabs, true);

                if (groupToShow.muteTabsWhenGroupCloseAndRestoreWhenOpen) {
                    await Tabs.setMute(groupToShow.tabs, false);
                }

                await pinGroupTabs(groupToShow.tabs, windowId);
            }

            // link group with window
            await Cache.setWindowGroup(windowId, groupToShow.id);

            await unpinGroupTabs(groupToHide?.tabs);

            // hide tabs
            await hideTabs(groupToHide?.tabs);

            const activeTabGroupToHide = groupToHide?.tabs.find(tab => tab.active);

            async function hideTabs(tabs = []) {
                await Tabs.hide(tabs, true);

                if (groupToHide) {
                    if (groupToHide.muteTabsWhenGroupCloseAndRestoreWhenOpen) {
                        await Tabs.setMute(tabs, true);
                    }

                    if (groupToHide.discardTabsAfterHide) {
                        if (groupToHide.discardExcludeAudioTabs) {
                            tabs = tabs.filter(tab => !tab.audible);
                        }

                        await Tabs.discard(tabs);
                    }
                }
            }

            async function hideUnSyncTabs(tabs) {
                if (!tabs.length) {
                    return;
                }

                await Tabs.hide(tabs, true);

                let showNotif = mainStorage.showTabsInThisWindowWereHidden ?? 0;
                if (showNotif < 5) {
                    mainStorage.showTabsInThisWindowWereHidden = ++showNotif;
                    Notification('tabsInThisWindowWereHidden');
                }
            }

            // set active tab
            if (activeTabId) {
                await Tabs.setActive(activeTabId);

                if (!groupToHide) {
                    let tabs = await Tabs.get(windowId);

                    tabs = tabs.filter(tab => !tab.groupId);

                    if (tabs.length === 1 && Utils.isUrlEmpty(tabs[0].url)) {
                        tabsIdsToRemove.add(tabs[0].id);
                    } else {
                        await hideUnSyncTabs(tabs);
                    }
                }
            } else if (groupToHide) {
                if (activeTabGroupToHide) {
                    let tabToActive = await Tabs.setActive(null, groupToShow.tabs);

                    if (!tabToActive) {
                        // group to show has no any tabs, try select pinned tab or create new one
                        let pinnedTabs = await Tabs.get(windowId, true),
                            activePinnedTab = await Tabs.setActive(null, pinnedTabs);

                        if (!activePinnedTab) {
                            await Tabs.create({
                                active: true,
                                windowId,
                                ...getNewTabParams(groupToShow),
                            }, true);
                        }
                    }
                } else {
                    // some pinned tab active, do nothing
                }
            } else {
                let tabs = await Tabs.get(windowId, null); // get tabs with pinned

                // remove tabs without group
                tabs = tabs.filter(tab => !tab.groupId);

                let activePinnedTab = await Tabs.setActive(null, tabs.filter(tab => tab.pinned));

                // find other not pinned tabs
                tabs = tabs.filter(tab => !tab.pinned);

                if (activePinnedTab) {
                    await hideUnSyncTabs(tabs);
                } else {
                    // no pinned tabs found, some tab without group is active

                    if (groupToShow.tabs.length) {
                        // set active group tab
                        await Tabs.setActive(null, groupToShow.tabs);

                        // if has one empty tab - remove it
                        if (tabs.length === 1 && Utils.isUrlEmpty(tabs[0].url)) {
                            tabsIdsToRemove.add(tabs[0].id);
                        } else {
                            await hideUnSyncTabs(tabs);
                        }
                    } else {
                        if (tabs.length === 1 && Utils.isUrlEmpty(tabs[0].url)) {
                            await Cache.setTabGroup(tabs[0].id, groupToShow.id)
                                .catch(log.onCatch(["can't set group", groupToShow.id, tabs[0]], false));
                            addTabs.push(Cache.applyTabSession(tabs[0]));
                        } else {
                            await Tabs.create({
                                active: true,
                                windowId,
                                ...getNewTabParams(groupToShow),
                            }, true);

                            await hideUnSyncTabs(tabs);
                        }
                    }
                }
            }

            if (groupToHide) {
                if (activeTabGroupToHide) {
                    await hideTabs([activeTabGroupToHide]);
                }

                groupToHide.tabs.forEach(tab => tab.url.startsWith(Constants.PAGES.MANAGE) && tabsIdsToRemove.add(tab.id));
            }

            await Tabs.remove(Array.from(tabsIdsToRemove));

            await MenusMain.groupLoaded(groupToShow, windowId);

            if (groupToHide) {
                await MenusMain.updateGroup(groupToHide);
            }

            await Browser.actionLoading(false);

            if (!applyFromHistory) {
                await groupsHistory.add(windowId, groupId);
            }
        }

        sendLoaded(groupId, windowId, addTabs);

        result = true;
    } catch (e) {
        result = false;

        if (e) {
            errorEventHandler.call(log, e);

            await Browser.actionGroup(null, windowId);

            if (!groupWindowId) {
                Tabs.continueTracking(skippedTrackingTabIds);
            }
        }
    } finally {
        windowsWithLoadingGroups.delete(windowId);
    }

    result ? log.stop() : log.stopError();

    return result;
}

function isGroupPinned(tab) {
    if (!tab) {
        return false;
    }
    if (tab.groupPinned === true) {
        return true;
    }
    const id = Tabs.extractId(tab);
    if ((tab.groupId ?? Cache.getTabGroup(id)) === PINNED_GROUP_ID) {
        return true;
    }
    return Cache.getTabGroupPinned(id);
}

async function pinGroupTabs(tabs = [], windowId) {
    const pinnedGroupTabs = tabs.filter(isGroupPinned);

    if (!pinnedGroupTabs.length) {
        return;
    }

    const log = logger.start('pinGroupTabs', 'count:', pinnedGroupTabs.length, 'windowId:', windowId);

    const ids = pinnedGroupTabs.map(Tabs.extractId);
    const skipped = Tabs.skipTracking(ids);

    try {
        await Promise.allSettled(pinnedGroupTabs.map(tab =>
            browser.tabs.update(tab.id, {pinned: true})
                .catch(log.onCatch(['cant pin group tab', tab.id], false))
        ));

        const globalPinned = await Tabs.get(windowId, true, null).catch(() => []);
        const globalPinnedCount = globalPinned.filter(tab => !Cache.getTabGroup(tab.id)).length;

        await Tabs.moveNative(pinnedGroupTabs, {
            index: globalPinnedCount,
            windowId,
        }, true);
    } catch (e) {
        log.logError('cant order group-pinned tabs', e);
    } finally {
        Tabs.continueTracking(skipped);
    }

    log.stop();
}

async function unpinGroupTabs(tabs = [], shouldUnpin = isGroupPinned) {
    const pinnedGroupTabs = tabs.filter(shouldUnpin);

    if (!pinnedGroupTabs.length) {
        return;
    }

    const log = logger.start('unpinGroupTabs', 'count:', pinnedGroupTabs.length);

    const ids = pinnedGroupTabs.map(Tabs.extractId);
    const skipped = Tabs.skipTracking(ids);

    try {
        await Promise.allSettled(pinnedGroupTabs.map(tab =>
            browser.tabs.update(tab.id, {pinned: false})
                .catch(log.onCatch(['cant unpin group tab', tab.id], false))
        ));

        pinnedGroupTabs.forEach(tab => tab.pinned = false);
    } catch (e) {
        log.logError('cant unpin group tabs', e);
    } finally {
        Tabs.continueTracking(skipped);
    }

    log.stop();
}

export async function setTabGroupPinned(tabId, groupPinned, targetGroupId, newTabIndex) {
    const log = logger.start('setTabGroupPinned', {tabId, groupPinned, targetGroupId, newTabIndex});

    let groupId = Cache.getTabGroup(tabId);

    if (isPinnedGroupId(groupId) && !targetGroupId) {
        log.stopWarn('cannot unpin inside the pinned group, drag it into a group instead', tabId);
        return false;
    }

    let newlyEnteredGroup = false;

    if (targetGroupId && groupId !== targetGroupId) {
        await browser.tabs.update(tabId, {pinned: false}).catch(log.onCatch(['cant unpin for move', tabId], false));
        await Tabs.move([tabId], targetGroupId, {showNotificationAfterMovingTabIntoThisGroup: false, _pinnedAlreadyHandled: true, newTabIndex})
            .catch(log.onCatch(['cant move tab into group', tabId, targetGroupId], false));
        groupId = Cache.getTabGroup(tabId);
        groupPinned ??= true;
        newlyEnteredGroup = true;
    }

    if (!groupId) {
        log.stopWarn('tab has no group, ignoring group-pin toggle', tabId);
        return false;
    }

    groupPinned ??= !Cache.getTabGroupPinned(tabId);

    await Cache.setTabGroupPinned(tabId, groupPinned)
        .catch(log.onCatch(['cant set groupPinned', tabId], false));

    const windowId = Cache.getWindowId(groupId);
    const {group} = await load(groupId, true);
    const tab = group?.tabs.find(t => t.id === tabId);

    if (tab) {
        tab.groupPinned = groupPinned;

        const destinationGroupIsShownInTabWindow = windowId && Cache.getWindowGroup(tab.windowId) === groupId;

        if (!destinationGroupIsShownInTabWindow) {
            await unpinGroupTabs([tab], t => t.pinned);
            await Tabs.hide([tab], true);

            if (groupPinned && newlyEnteredGroup && newTabIndex == null) {
                await placeTabAfterGroupPins(group, tab);
            }
        } else if (groupPinned) {
            await pinGroupTabs(group.tabs.filter(isGroupPinned), windowId);
        } else {
            await unpinGroupTabs([tab], t => t.pinned);
            await pinGroupTabs(group.tabs.filter(isGroupPinned), windowId);
        }
    }

    await Cache.setTabLastModified(tabId).catch(log.onCatch(['cant bump lastModified (group-pin)', tabId], false));
    const liveTab = await Tabs.getOne(tabId);
    if (liveTab) {
        if (newlyEnteredGroup) {
            await DeltaCapture.tabAdded(liveTab);
        } else {
            await DeltaCapture.tabModified(liveTab);
        }
    }

    sendUpdatedAll();
    Tabs.sendUpdatedGroup(groupId);

    log.stop();
    return true;
}

async function placeTabAfterGroupPins(group, tab) {
    const others = group.tabs
        .filter(t => t.id !== tab.id)
        .sort(Utils.sortBy('index'));

    const pins = others.filter(isGroupPinned);
    const anchor = pins.length ? pins[pins.length - 1].index + 1 : others[0]?.index;

    if (anchor != null && tab.index !== anchor) {
        await Tabs.moveNative([tab], {
            index: anchor,
            windowId: others[0]?.windowId ?? tab.windowId,
        }, true);
    }
}

export async function applyGroupPinnedOrder(groupId) {
    const windowId = Cache.getWindowId(groupId);

    if (!windowId) {
        return;
    }

    const {group} = await load(groupId, true);

    if (group?.tabs.some(isGroupPinned)) {
        await pinGroupTabs(group.tabs, windowId);
    }
}

const KEYS_RESPONSIBLE_VIEW = new Set([
    'title',
    'iconUrl',
    'iconColor',
    'iconViewType',
    'isArchive',
    'isSticky',
    'newTabContainer',
    'prependTitleToWindow',
]);

function send(action, data = {}) {
    GroupsBroadcast.send({action, ...data});
}

export function sendAdded(group, windowId) {
    send('added', {group, windowId});
    DeltaCapture.groupAdded(group);
}

export function sendUpdated(group, fullGroup) {
    send('updated', {group, fullGroup});
    DeltaCapture.groupModified(fullGroup);
}

export function sendRemoved(groupId, windowId) {
    send('removed', {groupId, windowId});
    DeltaCapture.groupRemoved(groupId);
}

export function sendLoaded(groupId, windowId, addTabs = []) {
    send('loaded', {groupId, windowId, addTabs});
}

export function sendUnloaded(groupId, windowId) {
    send('unloaded', {groupId, windowId});
}

export function sendUpdatedAll() {
    send('updated.all');
}

Containers.onChanged(async () => {
    if (!mainStorage.inited) {
        return;
    }

    const log = logger.start('Containers.onChanged listener');
    const {groups} = await load();

    if (normalizeContainersInGroups(groups)) {
        await save(groups);
    }
    log.stop();
});

// if set return {group, groups, groupIndex}
export async function load(groupId = null, withTabs = false, includeFavIconUrl, includeThumbnail) {
    const log = logger.start('load', groupId, {withTabs, includeFavIconUrl, includeThumbnail});

    let [allTabs, {groups}] = await Promise.all([
        withTabs ? Tabs.get(null, null, null, undefined, includeFavIconUrl, includeThumbnail) : false,
        Storage.get('groups')
    ]);

    if (withTabs) {
        let groupTabs = groups.reduce((acc, group) => (acc[group.id] = [], acc), {});

        await Promise.all(allTabs.map(async function(tab) {
            if (tab.groupId) {
                if (groupTabs[tab.groupId]) {
                    groupTabs[tab.groupId].push(tab);
                } else {
                    delete tab.groupId;
                    await Cache.removeTabGroup(tab.id).catch(() => {});
                }
            }
        }));

        groups = groups.map(function(group) {
            if (!group.isArchive) {
                group.tabs = groupTabs[group.id].sort(Utils.sortBy('index'));
            }

            return group;
        });
    }

    log.stop();

    const groupIndex = groups.findIndex(group => group.id === groupId);

    return {
        group: groups[groupIndex],
        groups,
        groupIndex,
        archivedGroups: groups.filter(group => group.isArchive),
        notArchivedGroups: groups.filter(group => !group.isArchive),
    };
}

export async function save(groups, withMessage = false) {
    const log = logger.start('save', {withMessage});

    if (!Array.isArray(groups)) {
        log.throwError('groups has invalid type');
    }

    await Storage.set({groups});

    if (isNeedBlockBeforeRequest(groups)) {
        backgroundSelf.addListenerOnBeforeRequest();
    } else {
        backgroundSelf.removeListenerOnBeforeRequest();
    }

    if (withMessage) {
        sendUpdatedAll();
    }

    log.stop();

    return groups;
}

export function createId() {
    return self.crypto.randomUUID();
}

export const PINNED_GROUP_ID = '70696e6e-6564-4000-8000-000000000001';

export function isPinnedGroup(group) {
    return group?.isPinnedGroup === true;
}

export function isPinnedGroupId(groupId) {
    return groupId === PINNED_GROUP_ID;
}

export function getPinnedGroup(groups) {
    return groups.find(isPinnedGroup);
}

function getPinnedGroupShownWindowId(group) {
    const shownTab = group?.tabs?.find(tab => !tab.hidden);
    return shownTab ? shownTab.windowId : null;
}

async function showPinnedGroupInWindow(group, windowId) {
    const log = logger.start('showPinnedGroupInWindow', {windowId, count: group.tabs.length});

    if (group.tabs.length) {
        if (group.tabs.some(tab => tab.windowId !== windowId)) {
            group.tabs = await Tabs.moveNative(group.tabs, {
                index: -1,
                windowId,
            }, true);
        }

        await Tabs.show(group.tabs, true);
        await pinGroupTabs(group.tabs, windowId);
    }

    sendUpdatedAll();
    Tabs.sendUpdatedGroup(group.id);

    log.stop();
    return true;
}

async function hidePinnedGroup(group) {
    const log = logger.start('hidePinnedGroup', {count: group.tabs.length});

    await unpinGroupTabs(group.tabs);
    await Tabs.hide(group.tabs, true);

    sendUpdatedAll();
    Tabs.sendUpdatedGroup(group.id);

    log.stop();
    return true;
}

export async function absorbNativePinnedTabs() {
    const log = logger.start('absorbNativePinnedTabs');

    const pinnedTabs = await Tabs.get(null, true, null).catch(() => []);

    let absorbed = 0;

    for (const tab of pinnedTabs) {
        await Cache.loadTabSession(tab, false, false).catch(() => {});

        if (Cache.getTabGroup(tab.id)) {
            continue;
        }

        await Cache.setTabGroup(tab.id, PINNED_GROUP_ID, tab.windowId)
            .catch(log.onCatch(['cant absorb pinned tab', tab.id], false));
        await Cache.setTabGroupPinned(tab.id, true)
            .catch(log.onCatch(['cant set groupPinned', tab.id], false));

        if (!Cache.getTabUid(tab.id)) {
            await Cache.setTabUid(tab.id).catch(() => {});
        }

        absorbed++;
    }

    if (absorbed) {
        sendUpdatedAll();
    }

    log.stop('absorbed:', absorbed);
}

export async function refreshPinnedGroupIfShown() {
    const {group} = await load(PINNED_GROUP_ID, true);
    const windowId = getPinnedGroupShownWindowId(group);

    if (windowId && group.tabs.length) {
        await Tabs.show(group.tabs, true);
        await pinGroupTabs(group.tabs, windowId);
    }
}

export async function togglePinnedGroupInWindow(windowId) {
    const {group} = await load(PINNED_GROUP_ID, true);

    if (!group) {
        return false;
    }

    if (getPinnedGroupShownWindowId(group) === windowId) {
        return hidePinnedGroup(group);
    }

    return showPinnedGroupInWindow(group, windowId);
}

export function ensurePinnedGroup(groups) {
    if (groups.some(isPinnedGroup)) {
        return false;
    }

    const group = create(PINNED_GROUP_ID, 'Pinned', {isPinnedGroup: true});
    group.isPinnedGroup = true;
    group.title = 'Pinned';
    groups.unshift(group);

    return true;
}

// extract "uid" from "group.id" that matches UUID
export function extractUId(groupId) {
    return groupId?.slice(-4);
}

export function create(id, title, defaultGroupProps = {}) {
    const group = {
        id,
        title: null,
        iconColor: null,
        iconUrl: null,
        iconViewType: Constants.DEFAULT_GROUP_ICON_VIEW_TYPE,
        tabs: [],
        isArchive: false,
        isPinnedGroup: false,
        discardTabsAfterHide: false,
        discardExcludeAudioTabs: false,
        prependTitleToWindow: false,
        dontUploadToCloud: false,
        exportToBookmarks: true,
        newTabContainer: Constants.DEFAULT_COOKIE_STORE_ID,
        ifDifferentContainerReOpen: false,
        excludeContainersForReOpen: [],
        isSticky: false,
        catchTabContainers: [],
        catchTabRules: '',
        moveToGroupIfNoneCatchTabRules: null,
        muteTabsWhenGroupCloseAndRestoreWhenOpen: false,
        showTabAfterMovingItIntoThisGroup: false,
        showOnlyActiveTabAfterMovingItIntoThisGroup: false,
        showNotificationAfterMovingTabIntoThisGroup: true,

        ...defaultGroupProps,
    };

    if (id) { // create title for group
        group.title = createTitle(title, id, defaultGroupProps);
    } else { // create title for default group, if needed
        group.title ??= createTitle(title, null, defaultGroupProps);
    }

    group.iconColor ??= Utils.randomColor();

    return group;
}

export async function getDefaults() {
    const {defaultGroupProps} = await Storage.get('defaultGroupProps');

    const defaultGroup = create(undefined, undefined, defaultGroupProps);
    const defaultCleanGroup = create(undefined, undefined, {});

    delete defaultGroup.id;
    delete defaultGroup.tabs;

    delete defaultCleanGroup.id;
    delete defaultCleanGroup.tabs;

    defaultGroup.iconColor = defaultGroupProps.iconColor || '';
    defaultCleanGroup.iconColor = '';

    return {
        defaultGroup,
        defaultCleanGroup,
        defaultGroupProps,
    };
}

async function saveDefaultCore(defaultGroupProps) {
    const log = logger.start('saveDefault', defaultGroupProps);

    await Storage.set({defaultGroupProps});

    log.stop();
}

export async function saveDefault(defaultGroupProps) {
    return runUserMutation(() => saveDefaultCore(defaultGroupProps));
}

export async function add(...args) {
    return runUserMutation(() => addCore(...args));
}

async function addCore(windowId, tabIds = [], title = null) {
    tabIds = tabIds?.slice?.() || [];
    title = title?.slice(0, 256);

    const log = logger.start('add', {windowId, tabIds, title});

    const windowGroupId = Cache.getWindowGroup(windowId);

    if (windowGroupId) {
        const result = await unload(windowGroupId);

        if (!result) {
            log.stopError('cant unload');
            return;
        }
    }

    const {groups} = await load();
    const {defaultGroupProps} = await getDefaults();

    const newGroup = create(createId(), title, defaultGroupProps);

    groups.push(newGroup);

    newGroup.title = Utils.format(newGroup.title, {index: groups.length});

    await save(groups);

    if (windowId) {
        await Cache.setWindowGroup(windowId, newGroup.id);
        await Browser.actionGroup(newGroup, windowId);
    }

    if (windowId && !tabIds.length) {
        tabIds = await Tabs.get(windowId).then(tabs => tabs.map(Tabs.extractId));
    }

    if (tabIds.length) {
        newGroup.tabs = await Tabs.move(tabIds, newGroup.id, {
            showNotificationAfterMovingTabIntoThisGroup: false,
        });
    }

    sendAdded(newGroup, windowId);

    await MenusMain.groupAdded(newGroup, windowId);

    log.stop(newGroup.id);
    return newGroup;
}

export async function remove(...args) {
    return runUserMutation(() => removeCore(...args));
}

async function removeCore(groupId) {
    const log = logger.start('remove', groupId);

    const groupWindowId = Cache.getWindowId(groupId);

    log.log('groupWindowId', groupWindowId);

    if (groupWindowId) {
        const result = await unload(groupId);

        if (!result) {
            log.stopError('cant unload');
            return;
        }
    }

    const {group, groups, groupIndex} = await load(groupId, true);
    const {defaultGroupProps} = await getDefaults();

    if (!group) {
        log.stopError('groupId', groupId, 'not found');
        return;
    }

    if (group.isPinnedGroup) {
        log.stopError('cannot remove the pinned group', groupId);
        return;
    }

    groups.splice(groupIndex, 1);

    groups.forEach(gr => {
        if (gr.moveToGroupIfNoneCatchTabRules === group.id) {
            gr.moveToGroupIfNoneCatchTabRules = null;
            log.log('remove moveToGroupIfNoneCatchTabRules from group', gr.id);
        }
    });

    await save(groups);

    if (defaultGroupProps.moveToGroupIfNoneCatchTabRules === group.id) {
        log.log('remove moveToGroupIfNoneCatchTabRules from default group props');
        delete defaultGroupProps.moveToGroupIfNoneCatchTabRules;
        await saveDefaultCore(defaultGroupProps);
    }

    if (!group.isArchive) {
        log.log('removing group tabs...');
        await Tabs.remove(group.tabs, true);
    }

    await MenusMain.groupRemoved(group).catch(log.onCatch('cant remove menus', false));

    await addUndoRemove(group);

    await Bookmarks.removeGroup(group).catch(log.onCatch('cant remove bookmark', false));

    sendRemoved(groupId, groupWindowId);

    log.stop();
}

const RESTORE_GROUP_PREFIX = 'restore-group-';

async function addUndoRemove(groupToRemove) {
    const restoreId = RESTORE_GROUP_PREFIX + groupToRemove.id;

    if (await Menus.has(restoreId)) {
        await Menus.remove(restoreId);
    }
    await Notification.clear(restoreId);

    groupToRemove.tabs = Tabs.prepareForSave(groupToRemove.tabs, false, true, true);

    await browser.storage.session.set({
        [restoreId]: groupToRemove,
    });

    await Menus.create({
        id: restoreId,
        title: Lang('undoRemoveGroupItemTitle', groupToRemove.title),
        contexts: [Menus.ContextType.BROWSER_ACTION],
        icons: getIconUrl(groupToRemove, 16),
        module: ['groups', 'restore', groupToRemove.id],
    });

    const {showNotificationAfterGroupDelete} = await Storage.get('showNotificationAfterGroupDelete');

    if (showNotificationAfterGroupDelete) {
        await Notification(['undoRemoveGroupNotification', groupToRemove.title], {
            id: restoreId,
            module: ['groups', 'restore', groupToRemove.id],
            expires: Notification.MAX_EXPIRES,
        });
    }
}

export async function restore(...args) {
    return runUserMutation(() => restoreCore(...args));
}

async function restoreCore(groupId) {
    const log = logger.start('restore', groupId);

    const restoreId = RESTORE_GROUP_PREFIX + groupId;

    if (await Menus.has(restoreId)) {
        await Menus.remove(restoreId);
    }
    await Notification.clear(restoreId);

    const {[restoreId]: group} = await browser.storage.session.get(restoreId);

    if (!group) {
        log.stopError('group not found');
        return;
    }

    await browser.storage.session.remove(restoreId);

    const {groups} = await load();

    groups.push(group);

    normalizeContainersInGroups(groups);

    const tabs = group.tabs;

    await save(groups);

    if (tabs.length && !group.isArchive) {
        await Browser.actionLoading();
        group.tabs = await Tabs.createMultiple(setNewTabsParams(tabs, group), true);
        await Tabs.hide(group.tabs, true);
        await Browser.actionLoading(false);
    }

    await MenusMain.groupAdded(group);

    sendAdded(group);

    log.stop('success restored', group.id);
}

export async function update(...args) {
    return runUserMutation(() => updateCore(...args));
}

async function updateCore(groupId, updateData) {
    const log = logger.start('update', {groupId, updateData});

    if (updateData.iconUrl?.startsWith('chrome:')) {
        // Notification('Icon not supported');
        delete updateData.iconUrl;
    }

    const updateDataKeys = new Set(Object.keys(updateData));

    if (!updateDataKeys.size) {
        log.stop('no updateData keys to update');
        return;
    }

    const {group, groupIndex, groups} = await load(groupId);

    if (!group) {
        log.throwError(['group', groupId, 'not found for update it']);
    }

    // updateData = JSON.clone(updateData); // clone need for fix bug: dead object after close tab which create object

    if (updateDataKeys.has('title')) {
        const {defaultGroupProps} = await getDefaults();
        updateData.title = createTitle(updateData.title, groupId, defaultGroupProps).slice(0, 256);
        updateData.title = Utils.format(updateData.title, {index: groupIndex + 1});
    }

    Object.assign(group, updateData);

    await save(groups);

    sendUpdated({
        id: groupId,
        ...updateData,
    }, group);

    if (updateDataKeys.intersection(KEYS_RESPONSIBLE_VIEW).size) {
        await Browser.actionGroup(group);
        await MenusMain.updateGroup(group).catch(log.onCatch('cant update menus', false));
    }

    if (updateDataKeys.has('title')) {
        await Bookmarks.updateGroupTitle(group).catch(log.onCatch('cant update title', false));
    }

    if (updateDataKeys.has('exportToBookmarks')) {
        if (updateData.exportToBookmarks) {
            const {group: groupToExport, groupIndex} = await load(group.id, true);
            await Bookmarks.exportGroup(groupToExport, groupIndex).catch(log.onCatch('cant update bookmark', false));
        } else {
            await Bookmarks.removeGroup(group).catch(log.onCatch('cant remove bookmark', false));
        }
    }

    log.stop();
}

export async function move(...args) {
    return runUserMutation(() => moveCore(...args));
}

async function moveCore(groupId, newGroupIndex) {
    const log = logger.start('move', {groupId, newGroupIndex});

    const {groups, groupIndex} = await load(groupId);

    groups.splice(newGroupIndex, 0, groups.splice(groupIndex, 1)[0]);

    await save(groups, true);

    DeltaCapture.groupMoved(groupId, groups.findIndex(gr => gr.id === groupId));

    await MenusMain.groupsUpdated(groups);

    log.stop();
}

export async function sort(...args) {
    return runUserMutation(() => sortCore(...args));
}

async function sortCore(vector = 'asc') {
    const log = logger.start('sort', vector);

    if (!['asc', 'desc'].includes(vector)) {
        log.throwError(`invalid sort vector: ${vector}`);
    }

    const {groups} = await load();

    if ('asc' === vector) {
        groups.sort(Utils.sortBy('title'));
    } else {
        groups.sort(Utils.sortBy('title', undefined, true));
    }

    await save(groups, true);

    groups.forEach((gr, index) => DeltaCapture.groupMoved(gr.id, index));

    await MenusMain.groupsUpdated(groups);

    log.stop();
}

export function isLoaded(groupId) {
    const log = logger.start('isLoaded', groupId);

    if (!groupId) {
        log.stopWarn('groupId is not defined');
        return false;
    }

    const windowId = Cache.getWindowId(groupId);

    if (!windowId) {
        log.stop('group is not loaded');
        return false;
    }

    log.stop('group is loaded', windowId);
    return true;
}

export async function unload(groupId, ignoreSharing = false) {
    const log = logger.start('unload', groupId);

    if (!groupId) {
        Notification('groupNotFound');
        log.stopError('groupNotFound');
        return false;
    }

    const windowId = Cache.getWindowId(groupId);

    if (!windowId) {
        Notification('groupNotLoaded');
        log.stopError('groupNotLoaded');
        return false;
    }

    const {group} = await load(groupId, true);

    if (!group) {
        Notification('groupNotFound');
        log.stopError('groupNotFound (2)');
        return false;
    }

    if (group.isArchive) {
        Notification(['groupIsArchived', group.title]);
        log.stopError('groupIsArchived');
        return false;
    }

    const sharingTabs = group.tabs.filter(tab => !isGroupPinned(tab) && Tabs.isCanNotBeHidden(tab));

    if (sharingTabs.length && !ignoreSharing) {
        const titles = sharingTabs.map(tab => Tabs.getTitle(tab, false, 20)).join(', ');
        Notification(['notPossibleSwitchGroupBecauseSomeTabShareMicrophoneOrCamera', titles], {
            module: ['groups', 'unload', groupId, true],
            expires: Notification.MAX_EXPIRES,
        });
        log.stopError('some Tab Can Not Be Hidden');
        return false;
    }

    log.log('windowId', windowId);

    await Browser.actionLoading();

    await Cache.removeWindowSession(windowId);

    let tabs = await Tabs.get(windowId, false, true);
    // remove tabs without group
    tabs = tabs.filter(tab => !tab.groupId);

    if (tabs.length) {
        await Tabs.show(tabs, true);
        await Tabs.setActive(null, tabs);
    } else {
        await Tabs.createTempActiveTab(windowId, false);
    }

    await unpinGroupTabs(group.tabs);

    await Tabs.hide(group.tabs, true);

    if (group.discardTabsAfterHide) {
        log.log('run discard tabs');

        let tabs = group.tabs;

        if (group.discardExcludeAudioTabs) {
            tabs = group.tabs.filter(tab => !tab.audible);
        }

        await Tabs.discard(tabs);
    }

    await Browser.actionLoading(false);

    await MenusMain.groupUnloaded(group, windowId);

    sendUnloaded(groupId, windowId);

    log.stop();
    return true;
}

export async function archiveToggle(...args) {
    return runUserMutation(() => archiveToggleCore(...args));
}

export async function setArchiveStateWhileHoldingLock(groupId, isArchive) {
    const {group} = await load(groupId);

    if (!group || Boolean(group.isArchive) === Boolean(isArchive)) {
        return null;
    }

    return archiveToggleCore(groupId);
}

async function archiveToggleCore(groupId) {
    const log = logger.start('archiveToggle', groupId);

    await Browser.actionLoading();

    let {group, groups} = await load(groupId, true),
        tabsToRemove = [],
        needUpdateTabs = false;

    if (group.isPinnedGroup) {
        await Browser.actionLoading(false);
        log.stopError('cannot archive the pinned group', groupId);
        return;
    }

    log.log('group.isArchive', group.isArchive, '=>', !group.isArchive);

    if (group.isArchive) {
        group.isArchive = false;

        Extensions.tabsToUUID(group.tabs);

        const createdTabs = await Tabs.createMultiple(setNewTabsParams(group.tabs, group), true);
        await Tabs.hide(createdTabs, true);

        group.tabs = [];
        needUpdateTabs = true;
    } else {
        if (Cache.getWindowId(groupId)) {
            const result = await unload(groupId);

            if (!result) {
                log.stopError('cant unload group');
                return null;
            }

            ({group, groups} = await load(groupId, true));
        }

        Extensions.tabsToId(group.tabs);

        tabsToRemove = group.tabs;

        group.isArchive = true;
        group.tabs = Tabs.prepareForSave(group.tabs, false, true, true);
    }

    await save(groups);

    await Tabs.remove(tabsToRemove, true);

    sendUpdated(group, group);

    if (needUpdateTabs) {
        Tabs.sendUpdatedGroup(groupId);
    }

    await Browser.actionLoading(false);

    await MenusMain.updateGroup(group);

    log.stop();
}

export function mapForExternalExtension(group) {
    return {
        id: group.id,
        title: getTitle(group),
        isArchive: group.isArchive,
        isSticky: group.isSticky,
        iconUrl: getIconUrl(group),
        contextualIdentity: Containers.get(group.newTabContainer),
        windowId: Cache.getWindowId(group.id) || null,
    };
}

export function getNewTabParams({id, newTabContainer, ifDifferentContainerReOpen, excludeContainersForReOpen}) {
    return {groupId: id, newTabContainer, ifDifferentContainerReOpen, excludeContainersForReOpen};
}

export function setNewTabsParams(tabs, group) {
    let newTabParams = getNewTabParams(group);

    return tabs.map(tab => Object.assign(tab, newTabParams));
}

function isCatchedUrl(url, catchTabRules) {
    return catchTabRules
        .split(/\s*\n\s*/)
        .map(regExpStr => regExpStr.trim())
        .filter(Boolean)
        .some(regExpStr => {
            try {
                return new RegExp(regExpStr).test(url);
            } catch {}
        });
}

export function normalizeContainersInGroups(groups) {
    const allContainers = Containers.query({defaultContainer: true, temporaryContainer: true});

    let hasChanges = false;

    for (const group of groups) {
        const oldNewTabContainer = group.newTabContainer,
            oldCatchTabContainersLength = group.catchTabContainers.length,
            oldExcludeContainersForReOpenLength = group.excludeContainersForReOpen.length;

        group.newTabContainer = Containers.get(group.newTabContainer).cookieStoreId;
        group.catchTabContainers = group.catchTabContainers.filter(cookieStoreId => allContainers[cookieStoreId]);
        group.excludeContainersForReOpen = group.excludeContainersForReOpen.filter(cookieStoreId => allContainers[cookieStoreId]);

        if (
            oldNewTabContainer !== group.newTabContainer ||
            oldCatchTabContainersLength !== group.catchTabContainers.length ||
            oldExcludeContainersForReOpenLength !== group.excludeContainersForReOpen.length
        ) {
            hasChanges = true;

            if (mainStorage.inited) {
                sendUpdated({
                    id: group.id,
                    newTabContainer: group.newTabContainer,
                    catchTabContainers: group.catchTabContainers,
                    excludeContainersForReOpen: group.excludeContainersForReOpen,
                }, group);
            }
        }
    };

    return hasChanges;
}

export function getCatchedForTab(notArchivedGroups, currentGroup, {cookieStoreId, url}) {
    if (currentGroup.isSticky) {
        return;
    }

    const destGroup = notArchivedGroups.find(({catchTabContainers, catchTabRules}) => {
        if (catchTabContainers.includes(cookieStoreId)) {
            return true;
        }

        if (isCatchedUrl(url, catchTabRules)) {
            return true;
        }
    });

    if (destGroup) {
        if (destGroup.id === currentGroup.id) {
            return;
        }

        return destGroup;
    }

    if (currentGroup.catchTabRules && currentGroup.moveToGroupIfNoneCatchTabRules) {
        return notArchivedGroups.find(group => group.id === currentGroup.moveToGroupIfNoneCatchTabRules);
    }
}

export function isNeedBlockBeforeRequest(groups) {
    return groups.some(function({isArchive, catchTabContainers, catchTabRules, ifDifferentContainerReOpen, newTabContainer}) {
        if (isArchive) {
            return false;
        }

        if (catchTabContainers.length || catchTabRules) {
            return true;
        }

        if (ifDifferentContainerReOpen) {
            return true;
        }

        return newTabContainer !== Constants.DEFAULT_COOKIE_STORE_ID;
    });
}

export async function setIconUrl(groupId, iconUrl) {
    try {
        await update(groupId, {
            iconViewType: null,
            iconUrl: await Utils.normalizeGroupIcon(iconUrl),
        });
    } catch (e) {
        Notification(e);
    }
}

const emojiRegExp = /\p{RI}\p{RI}|\p{Emoji}(\p{EMod}+|\u{FE0F}\u{20E3}?|[\u{E0020}-\u{E007E}]+\u{E007F})?(\u{200D}\p{Emoji}(\p{EMod}+|\u{FE0F}\u{20E3}?|[\u{E0020}-\u{E007E}]+\u{E007F})?)+|\p{EPres}(\p{EMod}+|\u{FE0F}\u{20E3}?|[\u{E0020}-\u{E007E}]+\u{E007F})?|\p{Emoji}(\p{EMod}+|\u{FE0F}\u{20E3}?|[\u{E0020}-\u{E007E}]+\u{E007F})/u;
const firstCharEmojiRegExp = new RegExp(`^(${emojiRegExp.source})`, emojiRegExp.flags);

export function getEmojiIcon(group) {
    if (group.iconViewType === 'title') {
        const [emoji] = firstCharEmojiRegExp.exec(group.title) || [];
        return emoji;
    }
}

const UNKNOWN_GROUP_ICON_PROPS = {
    title: '❓',
    iconViewType: 'title',
    iconColor: 'gray',
};

export function getIconUrl(group, keyInObj = null) {
    group ??= UNKNOWN_GROUP_ICON_PROPS;

    let result = null;

    if (group.iconUrl) {
        result = group.iconUrl;
    } else {
        const iconColor = group.iconColor || 'transparent';

        let svg = Constants.GROUP_ICON_VIEW_TYPES[group.iconViewType];

        switch (group.iconViewType) {
            case 'main-squares':
                if (iconColor !== 'transparent') {
                    svg = svg.replace('transparent', iconColor);
                }
                break;
            case 'circle':
                svg = svg.replace('fill=""', `fill="${iconColor}"`);

                if (iconColor === 'transparent') {
                    svg = svg.replace('stroke-width="0"', 'stroke-width="1"');
                }
                break;
            case 'squares':
                if (iconColor !== 'transparent') {
                    svg = svg.replace('fill=""', `fill="${iconColor}"`);
                }
                break;
            case 'old-tab-groups':
                if (iconColor !== 'transparent') {
                    svg = svg.replace('fill=""', `fill="${iconColor}"`);
                }
                break;
            case 'title':
                const emoji = getEmojiIcon(group);

                svg = svg
                    .replace('position=""', emoji ? 'text-anchor="middle" x="50%"' : 'x="0"')
                    .replace('text-content', emoji || group.title);

                if (iconColor !== 'transparent') {
                    svg = svg.replace('fill=""', `fill="${iconColor}"`);
                }
                break;
        }

        try {
            result = Utils.convertSvgToUrl(svg.trim());
        } catch {
            result = getIconUrl(UNKNOWN_GROUP_ICON_PROPS);
        }
    }

    return keyInObj ? {[keyInObj]: result} : result;
}

export function createTitle(title = null, groupId = null, defaultGroupProps = {}, format = true) {
    const uid = extractUId(groupId) || '{uid}';

    if (title) {
        title = String(title);
    } else if (defaultGroupProps.title) {
        title = defaultGroupProps.title;
    } else {
        title = Lang('newGroupTitle', uid);
    }

    if (format) {
        return Utils.format(title, {uid}, Utils.DATE_LOCALE_VARIABLES);
    }

    return title;
}

export function getTitle({id, title, isArchive, isSticky, tabs, iconViewType, newTabContainer}, args = '') {
    const withActiveGroup = args.includes('withActiveGroup');
    const withCountTabs = args.includes('withCountTabs');
    const withContainer = args.includes('withContainer');
    const withSticky = args.includes('withSticky');
    const withTabs = args.includes('withTabs');
    const beforeTitle = [];

    if (withSticky && isSticky) {
        beforeTitle.push(Constants.STICKY_SYMBOL);
    }

    if (withContainer && newTabContainer !== Constants.DEFAULT_COOKIE_STORE_ID) {
        beforeTitle.push('[' + Containers.get(newTabContainer).name + ']');
    }

    if (withActiveGroup) {
        if (Cache.getWindowId(id)) {
            beforeTitle.push(Constants.ACTIVE_SYMBOL);
        } else if (isArchive) {
            beforeTitle.push(Constants.DISCARDED_SYMBOL);
        }
    }

    // replace first emoji to empty string
    if (iconViewType === 'title') {
        title = title.replace(firstCharEmojiRegExp, '');
    }

    if (beforeTitle.length) {
        title = beforeTitle.join(' ') + ' ' + title;
    }

    if (withCountTabs) {
        title += ' (' + tabsCountMessage(tabs.slice(), isArchive) + ')';
    }

    if (withTabs) {
        if (tabs.length) {
            title += ':\n' + tabs
                .slice(0, 30)
                .map(tab => Tabs.getTitle(tab, false, 70, !isArchive))
                .join('\n');

            if (tabs.length > 30) {
                title += '\n...';
            }
        }
    }

    if (mainStorage.enableDebug) {
        const windowId = Cache.getWindowId(id) || tabs?.[0]?.windowId || 'no window';
        title = `@${windowId}:#${id.slice(-4)} ${title}`;
    }

    return title;
}

export function tabsCountMessage(tabs, groupIsArchived, lang = true) {
    if (groupIsArchived) {
        return lang ? Lang('groupTabsCount', tabs.length) : tabs.length;
    }

    let activeTabsCount = tabs.filter(tab => !tab.discarded).length;

    if (lang) {
        return Lang('groupTabsCountActive', [activeTabsCount, tabs.length]);
    }

    return activeTabsCount ? (activeTabsCount + '/' + tabs.length) : tabs.length;
}

export function getMenuId(groupId, context) {
    return `${context}-${groupId}`;
}

export async function getMenuProperties(group, context, {showArchivedGroups}) {
    return {
        id: getMenuId(group.id, context),
        title: getTitle(group, 'withSticky withActiveGroup withContainer'),
        icon: getIconUrl(group),
        enabled: !group.isArchive,
        visible: !group.isArchive ? true : showArchivedGroups,
    };
}
