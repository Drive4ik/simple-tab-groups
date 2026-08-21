import './prefixed-storage.js';

import Logger, {errorEventHandler} from './logger.js';
import backgroundSelf from './background.js'; // TODO refactor to use Broadcast
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
import * as GroupsNative from './groups-native.js';
import * as Operations from './operations.js';
import * as Windows from './windows.js';
import * as Utils from './utils.js';
import * as NewCloudGroups from './sync/new-cloud-groups.js';
import GroupsHistory from './groups-history.js';

export {on, off} from './broadcast.js?channel=groups';

const logger = new Logger(Constants.MODULES.GROUPS);
const mainStorage = localStorage.create(Constants.MODULES.BACKGROUND);
const windowsWithLoadingGroups = new Set();
const groupsHistory = new GroupsHistory();

export function fillHistory(windows) {
    return groupsHistory.fill(windows);
}

export async function applyByPosition(direction, windowId, groups, currentGroupId) {
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

export function apply(...args) {
    return Operations.run('apply-group', () => applyNow(...args));
}

async function applyNow(windowId, groupId, activeTabId, applyFromHistory = false) {
    const log = logger.start(apply, 'groupId:', groupId, 'windowId:', windowId, 'activeTabId:', activeTabId);

    windowId ||= await Windows.getLastFocusedNormalWindow();

    if (!windowId) {
        log.stopError('no window was found for apply');
        return false;
    } else if (windowsWithLoadingGroups.has(windowId)) {
        log.stopWarn('window in loading state now', windowId);
        return false;
    }

    windowsWithLoadingGroups.add(windowId);

    const groupWindowId = Cache.getWindowId(groupId);

    let result = null;

    try {
        const addTabs = [];

        if (groupWindowId) {
            if (activeTabId) {
                Tabs.setActive(activeTabId);
            }

            Windows.setFocus(groupWindowId);
        } else {
            // magic

            const {group: groupToShow, groups} = await load(groupId, true);
            const oldGroupId = Cache.getWindowGroup(windowId);
            const groupToHide = groups.find(gr => gr.id === oldGroupId);
            const tabsIdsToRemove = new Set;

            if (!groupToShow) {
                log.throwError('groupToShow not found');
            }

            if (groupToShow.isArchive) {
                Notification(['groupIsArchived', groupToShow.title]);
                throw '';
            }

            if (groupToHide) {
                await beforeUnload(groupToHide);
            }

            await Browser.actionLoading();

            // show tabs
            if (groupToShow.tabs.length) {
                if (groupToShow.tabs.some(tab => tab.windowId !== windowId)) {
                    // the whole group gathers as one block at its own first tab in this window:
                    // strays arrive without joining anyone, the in-window part can be swallowed
                    // by a live span (docs/TABGROUPS-BEHAVIOR.md §20, §21) - GroupsNative.apply
                    // below rebuilds the sub-groups either way
                    const anchorTab = groupToShow.tabs.find(tab => tab.windowId === windowId);

                    groupToShow.tabs = await Tabs.moveNative(groupToShow.tabs, {
                        index: anchorTab?.index ?? await Tabs.resolveMoveIndex(groupToShow.id, windowId, groupToShow.tabs),
                        windowId: windowId,
                    }, true);
                }

                await Tabs.show(groupToShow.tabs, true);
                groupToShow.tabs.forEach(tab => tab.hidden = false); // the tab objects were loaded before show

                if (groupToShow.muteTabsWhenGroupCloseAndRestoreWhenOpen) {
                    await Tabs.setMute(groupToShow.tabs, false);
                }

                await GroupsNative.apply(windowId, groupToShow);
            }

            // link group with window
            await Cache.setWindowGroup(windowId, groupToShow.id);

            // hide tabs
            await hideTabs(groupToHide?.tabs);

            const activeTabGroupToHide = groupToHide?.tabs.find(tab => tab.active);

            async function hideTabs(tabs = []) {
                await GroupsNative.ungroup(tabs);
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

                // unsync tabs are managed by the addon: their native groups are consciously destroyed
                await GroupsNative.ungroup(tabs);
                await Tabs.hide(tabs, true);
                await GroupsNative.clearMembership(tabs);

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
        }
    } finally {
        windowsWithLoadingGroups.delete(windowId);
    }

    result ? log.stop() : log.stopError();

    return result;
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
}

export function sendUpdated(group, fullGroup) {
    send('updated', {group, fullGroup});
}

export function sendRemoved(groupId, windowId) {
    send('removed', {groupId, windowId});
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

    await enqueue(async () => {
        const {groups} = await load();

        if (normalizeContainersInGroups(groups)) {
            await saveNow(groups);
        }
    });

    log.stop();
});

export async function load(groupId = null, withTabs = false, includeFavIconUrl, includeThumbnail) {
    const log = logger.start('load', groupId, {withTabs, includeFavIconUrl, includeThumbnail});

    const [
        allTabs,
        {groups},
    ] = await Promise.all([
        withTabs ? Tabs.get(null, false, null, undefined, includeFavIconUrl, includeThumbnail) : false,
        Storage.get('groups')
    ]);

    if (withTabs) {
        const groupTabs = new Map(groups.map(group => [group.id, []]));

        await Promise.all(allTabs.map(async tab => {
            if (tab.groupId) {
                if (groupTabs.has(tab.groupId)) {
                    groupTabs.get(tab.groupId).push(tab);
                } else {
                    delete tab.groupId;
                    await Cache.removeTabGroup(tab.id).catch(() => {});
                }
            }
        }));

        for (const group of groups) {
            if (!group.isArchive) {
                group.tabs = groupTabs.get(group.id).toSorted(Utils.sortBy('index'));
            }
        }
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

// every load-modify-save of the groups array funnels here - the mirrors of different windows,
// composite operations, sync and UI edits must not interleave (lost update)
let writeQueue = Promise.resolve();

function enqueue(fn) {
    const turn = writeQueue.then(fn);
    writeQueue = turn.catch(() => {});
    return turn;
}

export function save(groups, withMessage = false) {
    return enqueue(async () => {
        if (typeof groups === 'function') {
            groups = await groups();

            if (!groups) {
                return groups;
            }
        }

        return saveNow(groups, withMessage);
    });
}

async function saveNow(groups, withMessage = false) {
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
        afterAutoMoveShowTab: false,
        afterAutoMoveShowOnlyActiveTab: false,
        afterAutoMoveShowNotification: true,
        groupsNative: [],

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

export async function saveDefault(defaultGroupProps) {
    const log = logger.start('saveDefault', defaultGroupProps);

    await Storage.set({defaultGroupProps});

    log.stop();
}

export function add(...args) {
    return Operations.run('add-group', () => addNow(...args));
}

async function addNow(windowId, tabIds = [], title = null) {
    tabIds = tabIds?.slice?.() || [];
    title = title?.slice(0, 256);

    const log = logger.start(addNow, {windowId, tabIds, title});

    const windowGroupId = Cache.getWindowGroup(windowId);

    if (windowGroupId) {
        const result = await unload(windowGroupId);

        if (!result) {
            log.stopError('cant unload');
            return;
        }
    }

    const newGroup = await enqueue(async () => {
        const {groups} = await load();
        const {defaultGroupProps} = await getDefaults();

        const newGroup = create(createId(), title, defaultGroupProps);

        groups.push(newGroup);

        newGroup.title = Utils.format(newGroup.title, {index: groups.length});

        NewCloudGroups.add(newGroup.id);

        await saveNow(groups);

        return newGroup;
    });

    if (windowId) {
        await Cache.setWindowGroup(windowId, newGroup.id);
        await Browser.actionGroup(newGroup, windowId);
    }

    if (windowId && !tabIds.length) {
        tabIds = await Tabs.get(windowId).then(tabs => tabs.map(Tabs.extractId));
    }

    if (tabIds.length) {
        newGroup.tabs = await Tabs.move(tabIds, newGroup.id);
    }

    sendAdded(newGroup, windowId);

    await MenusMain.groupAdded(newGroup, windowId);

    log.stop(newGroup.id);
    return newGroup;
}

export function remove(...args) {
    return Operations.run('remove-group', () => removeNow(...args));
}

async function removeNow(groupIds) {
    const log = logger.start(removeNow, groupIds);

    const idsToRemove = Utils.toSet(groupIds);
    const windowIdByGroupId = new Map;

    for (const groupId of idsToRemove) {
        const windowId = Cache.getWindowId(groupId);

        if (!windowId) {
            continue;
        }

        if (await unload(groupId)) {
            windowIdByGroupId.set(groupId, windowId);
        } else {
            log.warn('cant unload, skip removing group', groupId);
            idsToRemove.delete(groupId);
        }
    }

    const removedGroups = await enqueue(async () => {
        const {groups} = await load(null, true);
        const {defaultGroupProps} = await getDefaults();

        const groupsToRemove = groups.filter(group => idsToRemove.has(group.id));

        if (!groupsToRemove.length) {
            return groupsToRemove;
        }

        const restGroups = groups.filter(group => !idsToRemove.has(group.id));

        // the tabs close before the storage cut: an abort in between leaves an empty group,
        // never hidden orphan tabs whose group is already gone
        await Tabs.remove(groupsToRemove.flatMap(group => group.isArchive ? [] : group.tabs), true);

        let defaultGroupPropsChanged = false;

        for (const group of groupsToRemove) {
            if (removeRefs(group, restGroups, defaultGroupProps)) {
                defaultGroupPropsChanged = true;
            }
        }

        await saveNow(restGroups);

        if (defaultGroupPropsChanged) {
            await saveDefault(defaultGroupProps);
        }

        return groupsToRemove;
    });

    if (!removedGroups.length) {
        log.stopError('groups', groupIds, 'not found');
        return;
    }

    for (const group of removedGroups) {
        await removeFinish(group);

        sendRemoved(group.id, windowIdByGroupId.get(group.id));
    }

    log.stop();
}

function removeRefs(group, groups, defaultGroupProps) {
    const log = logger.start(removeRefs, group.id);

    for (const gr of groups) {
        if (gr.moveToGroupIfNoneCatchTabRules === group.id) {
            gr.moveToGroupIfNoneCatchTabRules = null;
            log.log('remove moveToGroupIfNoneCatchTabRules from group', gr.id);
        }
    }

    let defaultGroupPropsChanged = false;

    if (defaultGroupProps.moveToGroupIfNoneCatchTabRules === group.id) {
        log.log('remove moveToGroupIfNoneCatchTabRules from default group props');
        delete defaultGroupProps.moveToGroupIfNoneCatchTabRules;
        defaultGroupPropsChanged = true;
    }

    log.stop();

    return defaultGroupPropsChanged;
}

async function removeFinish(group) {
    const log = logger.start(removeFinish, group.id);

    NewCloudGroups.remove(group.id);

    await MenusMain.groupRemoved(group).catch(log.onCatch('cant remove menus', false));

    await addUndoRemove(group);

    await Bookmarks.removeGroup(group).catch(log.onCatch('cant remove bookmark', false));

    log.stop();
}

const RESTORE_GROUP_PREFIX = 'restore-group-';

async function addUndoRemove(groupToRemove) {
    const restoreId = RESTORE_GROUP_PREFIX + groupToRemove.id;

    // the saved tabs carry their groupNativeId - on restore Tabs.create writes it back into sessions
    groupToRemove.groupsNative = GroupsNative.referencedGroupsNative(groupToRemove);

    groupToRemove.tabs = Tabs.prepareForSave(groupToRemove.tabs, {
        includeGroupNativeId: true,
        includeFavIconUrl: true,
        includeThumbnail: true,
    });

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

export function restore(...args) {
    return Operations.run('restore-group', () => restoreNow(...args));
}

async function restoreNow(groupId) {
    const log = logger.start('restore', groupId);

    const restoreId = RESTORE_GROUP_PREFIX + groupId;

    await Menus.remove(restoreId);
    await Notification.clear(restoreId);

    const {[restoreId]: group} = await browser.storage.session.get(restoreId);

    if (!group) {
        log.stopError('group not found');
        return;
    }

    await browser.storage.session.remove(restoreId);

    await enqueue(async () => {
        const {groups} = await load();

        groups.push(group);

        normalizeContainersInGroups(groups);

        NewCloudGroups.add(group.id);

        await saveNow(groups);
    });

    const tabs = group.tabs;

    if (tabs.length && !group.isArchive) {
        await Browser.actionLoading();
        group.tabs = await Tabs.createMultiple(setNewTabsParams(tabs, group), true);
        // appended at the end of the strip - they can't be in a live group (docs/TABGROUPS-BEHAVIOR.md §10)
        await Tabs.hide(group.tabs, true);
        await Browser.actionLoading(false);
    }

    await MenusMain.groupAdded(group);

    sendAdded(group);

    log.stop('success restored', group.id);
}

export function update(groupId, updateData) {
    return enqueue(() => updateNow(groupId, updateData));
}

async function updateNow(groupId, updateData) {
    const log = logger.start('update', {groupId, updateData});

    const {group, groupIndex, groups} = await load(groupId);

    if (!group) {
        log.throwError(['group', groupId, 'not found for update it']);
    }

    if (typeof updateData === 'function') {
        updateData = updateData(group);
    }

    if (updateData.iconUrl?.startsWith('chrome:')) {
        // Notification('Icon not supported');
        delete updateData.iconUrl;
    }

    const updateDataKeys = new Set(Object.keys(updateData));

    if (!updateDataKeys.size) {
        log.stop('no keys to update');
        return;
    }

    log.log('update keys:', [...updateDataKeys]);

    // updateData = JSON.clone(updateData); // clone need for fix bug: dead object after close tab which create object

    if (updateDataKeys.has('title')) {
        const {defaultGroupProps} = await getDefaults();
        updateData.title = createTitle(updateData.title, groupId, defaultGroupProps).slice(0, 256);
        updateData.title = Utils.format(updateData.title, {index: groupIndex + 1});
    }

    if (group.dontUploadToCloud && updateData.dontUploadToCloud === false) {
        NewCloudGroups.add(group.id);
    }

    Object.assign(group, updateData);

    await saveNow(groups);

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

export async function move(groupId, newGroupIndex) {
    const log = logger.start('move', {groupId, newGroupIndex});

    const groups = await enqueue(async () => {
        const {groups, groupIndex} = await load(groupId);

        groups.splice(newGroupIndex, 0, groups.splice(groupIndex, 1)[0]);

        await saveNow(groups, true);

        return groups;
    });

    await MenusMain.groupsUpdated(groups);

    log.stop();
}

export async function sort(vector = 'asc') {
    const log = logger.start('sort', vector);

    if (!['asc', 'desc'].includes(vector)) {
        log.throwError(`invalid sort vector: ${vector}`);
    }

    const groups = await enqueue(async () => {
        const {groups} = await load();

        if ('asc' === vector) {
            groups.sort(Utils.sortBy('title'));
        } else {
            groups.sort(Utils.sortBy('title', undefined, true));
        }

        await saveNow(groups, true);

        return groups;
    });

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

async function beforeUnload(group) {
    const tabsToPin = group.tabs.filter(Tabs.isCanNotBeHidden);

    if (!tabsToPin.length) {
        return;
    }

    const log = logger.start(beforeUnload, group.id, tabsToPin.map(Tabs.extractId));

    // pinning strips the native membership itself (docs/TABGROUPS-BEHAVIOR.md §19)
    await Tabs.pin(tabsToPin, true);

    await Promise.allSettled(tabsToPin.flatMap(tab => [
        Cache.removeTabGroup(tab.id),
        Cache.removeTabNativeGroupId(tab.id),
    ]));

    group.tabs = group.tabs.filter(tab => !tabsToPin.includes(tab));

    let showNotif = mainStorage.thisTabsWerePinned ?? 0;

    if (showNotif < 3) {
        mainStorage.thisTabsWerePinned = ++showNotif;
        Notification(['thisTabsWerePinned', tabsToPin.map(tab => Tabs.getTitle(tab, false, 20)).join(', ')]);
    }

    log.stop();
}

export function unload(...args) {
    return Operations.run('unload-group', () => unloadNow(...args));
}

async function unloadNow(groupId) {
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

    await beforeUnload(group);

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

    // sessions keep the membership of hidden tabs - nothing to save here
    await GroupsNative.ungroup(group.tabs);
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

export function archiveToggle(...args) {
    return Operations.run('archive-toggle', () => archiveToggleNow(...args));
}

async function archiveToggleNow(groupId) {
    const log = logger.start('archiveToggle', groupId);

    await Browser.actionLoading();

    if (Cache.getWindowId(groupId)) {
        const result = await unload(groupId);

        if (!result) {
            await Browser.actionLoading(false);
            log.stopError('cant unload group');
            return null;
        }
    }

    const {group, tabsToRemove, needUpdateTabs} = await enqueue(async () => {
        const {group, groups} = await load(groupId, true);

        let tabsToRemove = [],
            needUpdateTabs = false;

        log.log('group.isArchive', group.isArchive, '=>', !group.isArchive);

        if (group.isArchive) {
            group.isArchive = false;

            Extensions.tabsToUUID(group.tabs);

            // the archived tabs carry their groupNativeId - Tabs.create writes it back into sessions
            const createdTabs = await Tabs.createMultiple(setNewTabsParams(group.tabs, group), true);

            // appended at the end of the strip - they can't be in a live group (docs/TABGROUPS-BEHAVIOR.md §10)
            await Tabs.hide(createdTabs, true);

            group.tabs = [];
            needUpdateTabs = true;
        } else {
            Extensions.tabsToId(group.tabs);

            tabsToRemove = group.tabs;

            group.isArchive = true;
            group.groupsNative = GroupsNative.referencedGroupsNative(group);
            group.tabs = Tabs.prepareForSave(group.tabs, {
                includeGroupNativeId: true,
                includeFavIconUrl: true,
                includeThumbnail: true,
            });
        }

        await saveNow(groups);

        return {group, tabsToRemove, needUpdateTabs};
    });

    await Tabs.remove(tabsToRemove, true);

    sendUpdated(group, group);

    if (needUpdateTabs) {
        Tabs.sendUpdatedGroup(groupId);
    }

    await Browser.actionLoading(false);

    await MenusMain.updateGroup(group);

    log.stop();
}

// a live tab whose session points to an archived group is a leftover of an archiving
// interrupted between the storage commit and the tab removal - its copy already lives
// in the archive, close it
export async function removeArchivedGroupsTabs(groups) {
    const archivedGroupIds = new Set(groups.filter(group => group.isArchive).map(group => group.id));

    if (!archivedGroupIds.size) {
        return;
    }

    const tabsToRemove = await Tabs.get(null, false, null)
        .then(tabs => tabs.filter(tab => archivedGroupIds.has(tab.groupId)));

    if (!tabsToRemove.length) {
        return;
    }

    const log = logger.start('removeArchivedGroupsTabs', tabsToRemove.map(tab => tab.id));

    await Tabs.keepWindowsAlive(tabsToRemove);
    // a whole live span closed in one call would be saved by the browser into its saved groups
    await GroupsNative.ungroup(tabsToRemove);
    await Tabs.remove(tabsToRemove, true);

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
