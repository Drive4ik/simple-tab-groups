import Logger from './logger.js';
import * as Constants from './constants.js';
import * as Storage from './storage.js';
import * as Cache from './cache.js';
import * as Containers from './containers.js';
import JSON from './json.js';
import * as Tabs from './tabs.js';
import * as Utils from './utils.js';

const logger = new Logger('Groups');

// if set return {group, groups, groupIndex}
export async function load(groupId = null, withTabs = false, includeFavIconUrl, includeThumbnail) {
    const log = logger.start('load', groupId, {withTabs, includeFavIconUrl, includeThumbnail});

    let [allTabs, {groups}] = await Promise.all([
        withTabs ? Tabs.get(null, false, null, undefined, includeFavIconUrl, includeThumbnail) : false,
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
                    await Cache.removeTabGroup(tab.id);
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

    let groupIndex = groups.findIndex(group => group.id === groupId);

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
        BG.addListenerOnBeforeRequest();
    } else {
        BG.removeListenerOnBeforeRequest();
    }

    if (withMessage) {
        sendMessage('groups-updated');
    }

    log.stop();

    return groups;
}

export function create(id, title) {
    return {
        id: id,
        title: Utils.createGroupTitle(title, id),
        iconColor: BG.options.defaultGroupIconColor || Utils.randomColor(),
        iconUrl: null,
        iconViewType: BG.options.defaultGroupIconViewType,
        tabs: [],
        isArchive: false,
        newTabContainer: Constants.DEFAULT_COOKIE_STORE_ID,
        ifDifferentContainerReOpen: false,
        excludeContainersForReOpen: [],
        isMain: false,
        isSticky: false,
        catchTabContainers: [],
        catchTabRules: '',
        moveToMainIfNotInCatchTabRules: false,
        muteTabsWhenGroupCloseAndRestoreWhenOpen: false,
        showTabAfterMovingItIntoThisGroup: false,
        showOnlyActiveTabAfterMovingItIntoThisGroup: false,
        showNotificationAfterMovingTabIntoThisGroup: true,
        dontDiscardTabsAfterHideThisGroup: false,
        bookmarkId: null,
    };
}

export async function add(windowId, tabIds = [], title = null) {
    tabIds = tabIds?.slice?.() || [];
    title = title?.slice(0, 256);

    const log = logger.start('add', {windowId, tabIds, title});

    let windowGroupId = Cache.getWindowGroup(windowId);

    if (windowGroupId) {
        let result = await unload(windowGroupId);

        if (!result) {
            log.stopError('cant unload');
            return;
        }
    }

    let {lastCreatedGroupPosition} = await Storage.get('lastCreatedGroupPosition');

    lastCreatedGroupPosition++;

    let {groups} = await load(),
        newGroup = create(lastCreatedGroupPosition, title);

    groups.push(newGroup);

    await save(groups);

    await Storage.set({lastCreatedGroupPosition});

    if (windowId) {
        await Cache.setWindowGroup(windowId, newGroup.id);
        await BG.updateBrowserActionData(newGroup.id).catch(log.onCatch(newGroup.id));
    }

    BG.updateMoveTabMenus();

    if (windowId && !tabIds.length) {
        tabIds = await Tabs.get(windowId).then(tabs => tabs.map(Tabs.extractId));
    }

    if (tabIds.length) {
        newGroup.tabs = await Tabs.move(tabIds, newGroup.id, {
            ...newGroup,
            showNotificationAfterMovingTabIntoThisGroup: false,
        });
    }

    sendMessage('group-added', {
        group: newGroup,
    });

    BG.sendExternalMessage({
        action: 'group-added',
        group: mapForExternalExtension(newGroup),
    });

    return log.stop(newGroup);
}

export async function remove(groupId) {
    const log = logger.start('remove', groupId);

    let groupWindowId = Cache.getWindowId(groupId);

    if (Cache.getWindowId(groupId)) {
        let result = await unload(groupId);

        if (!result) {
            log.stopError('cant unload');
            return;
        }
    }

    let {group, groups, groupIndex} = await load(groupId, true);

    BG.addUndoRemoveGroupItem(group);

    groups.splice(groupIndex, 1);

    await save(groups);

    if (!group.isArchive) {
        await Tabs.remove(group.tabs);

        BG.updateMoveTabMenus();

        if (group.isMain) {
            Utils.notify(['thisGroupWasMain'], 7);
        }
    }

    BG.removeGroupBookmark(group);

    sendMessage('group-removed', {
        groupId: groupId,
        windowId: groupWindowId,
    });

    BG.sendExternalMessage({
        action: 'group-removed',
        groupId: groupId,
        windowId: groupWindowId,
    });

    log.stop();
}

export async function update(groupId, updateData) {
    const log = logger.start('update', {groupId, updateData});

    let {group, groups} = await load(groupId);

    if (!group) {
        log.throwError(['group', groupId, 'not found for update it']);
    }

    updateData = JSON.clone(updateData); // clone need for fix bug: dead object after close tab which create object

    if (updateData.iconUrl && updateData.iconUrl.startsWith('chrome:')) {
        Utils.notify('Icon not supported');
        delete updateData.iconUrl;
    }

    if (updateData.title) {
        updateData.title = updateData.title.slice(0, 256);
    }

    if (!Object.keys(updateData).length) {
        return log.stop(null, 'no updateData keys to update');
    }

    if (updateData.isMain) {
        groups.forEach(gr => gr.isMain = gr.id === groupId);
    }

    Object.assign(group, updateData);

    await save(groups);

    sendMessage('group-updated', {
        group: {
            id: groupId,
            ...updateData,
        },
    });

    let externalGroup = mapForExternalExtension(group);

    if (Object.keys(externalGroup).some(key => updateData.hasOwnProperty(key))) {
        BG.sendExternalMessage({
            action: 'group-updated',
            group: externalGroup,
        });
    }

    if (['title', 'iconUrl', 'iconColor', 'iconViewType', 'isArchive', 'isSticky'].some(key => updateData.hasOwnProperty(key))) {
        BG.updateMoveTabMenus();

        await BG.updateBrowserActionData(groupId);
    }

    if (updateData.hasOwnProperty('title')) {
        BG.updateGroupBookmarkTitle(group);
    }

    log.stop();
}

export async function move(groupId, newGroupIndex) {
    const log = logger.start('move', {groupId, newGroupIndex});

    let {groups, groupIndex} = await load(groupId);

    groups.splice(newGroupIndex, 0, groups.splice(groupIndex, 1)[0]);

    await save(groups, true);

    BG.updateMoveTabMenus();

    log.stop();
}

export async function sort(vector = 'asc') {
    const log = logger.start('sort', vector);

    if (!['asc', 'desc'].includes(vector)) {
        log.throwError(`invalid sort vector: ${vector}`);
    }

    let {groups} = await load();

    if ('asc' === vector) {
        groups.sort(Utils.sortBy('title'));
    } else {
        groups.sort(Utils.sortBy('title', undefined, true));
    }

    await save(groups, true);

    BG.updateMoveTabMenus();

    log.stop();
}

export async function unload(groupId) {
    const log = logger.start('unload', groupId);

    if (!groupId) {
        Utils.notify(['groupNotFound'], 7, 'groupNotFound');
        return log.stopError(false, 'groupNotFound');
    }

    let windowId = Cache.getWindowId(groupId);

    if (!windowId) {
        Utils.notify(['groupNotLoaded'], 7, 'groupNotLoaded');
        return log.stopError(false, 'groupNotLoaded');
    }

    let {group} = await load(groupId, true);

    if (!group) {
        Utils.notify(['groupNotFound'], 7, 'groupNotFound');
        return log.stopError(false, 'groupNotFound');
    }

    if (group.isArchive) {
        Utils.notify(['groupIsArchived', group.title], 7, 'groupIsArchived');
        return log.stopError(false, 'groupIsArchived');
    }

    if (group.tabs.some(Utils.isTabCanNotBeHidden)) {
        Utils.notify(['notPossibleSwitchGroupBecauseSomeTabShareMicrophoneOrCamera']);
        return log.stopError(false, 'some Tab Can Not Be Hidden');
    }

    await BG.loadingBrowserAction(true, windowId);

    await Cache.removeWindowSession(windowId);

    let tabs = await Tabs.get(windowId, false, true);
    // remove tabs without group
    tabs = tabs.filter(tab => !tab.groupId);

    if (tabs.length) {
        await Tabs.show(tabs);
        await Tabs.setActive(null, tabs);
    } else {
        await Tabs.createTempActiveTab(windowId, false);
    }

    await Tabs.safeHide(group.tabs);

    if (BG.options.discardTabsAfterHide && !group.dontDiscardTabsAfterHideThisGroup) {
        log.log('run discard tabs');
        Tabs.discard(group.tabs).catch(log.onCatch(['Tabs.discard', group.tabs]));
    }

    await BG.updateBrowserActionData(null, windowId).catch(log.onCatch(['updateBrowserActionData', windowId]));

    BG.updateMoveTabMenus();

    sendMessage('group-unloaded', {
        groupId,
        windowId,
    });

    BG.sendExternalMessage({
        action: 'group-unloaded',
        groupId,
        windowId,
    });

    return log.stop(true);
}

export async function archiveToggle(groupId) {
    const log = logger.start('archiveToggle', groupId);

    await BG.loadingBrowserAction();

    let {group, groups} = await load(groupId, true),
        tabIdsToRemove = [];

    log.log('group.isArchive', group.isArchive);

    if (group.isArchive) {
        group.isArchive = false;

        await BG.createTabsSafe(setNewTabsParams(group.tabs, group), true);

        group.tabs = [];
    } else {
        if (Cache.getWindowId(groupId)) {
            let result = await unload(groupId);

            if (!result) {
                return log.stopError(null, 'cant unload group');
            }

            ({group, groups} = await load(groupId, true));
        }

        tabIdsToRemove = group.tabs.map(Tabs.extractId);

        group.isArchive = true;
        group.tabs = Tabs.prepareForSave(group.tabs, false, true, true);

        if (group.isMain) {
            group.isMain = false;
            Utils.notify(['thisGroupWasMain'], 7);
        }
    }

    await save(groups);

    if (tabIdsToRemove.length) {
        BG.addExcludeTabIds(tabIdsToRemove);
        await Tabs.remove(tabIdsToRemove);
        BG.removeExcludeTabIds(tabIdsToRemove);
    }

    sendMessage('groups-updated');

    BG.sendExternalMessage({
        action: 'group-updated',
        group: mapForExternalExtension(group),
    });

    BG.loadingBrowserAction(false).catch(log.onCatch('loadingBrowserAction'));

    BG.updateMoveTabMenus();

    log.stop();
}

export function mapForExternalExtension(group) {
    return {
        id: group.id,
        title: Utils.getGroupTitle(group),
        isArchive: group.isArchive,
        isSticky: group.isSticky,
        iconUrl: Utils.getGroupIconUrl(group),
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

export async function getNextTitle() {
    let {lastCreatedGroupPosition} = await Storage.get('lastCreatedGroupPosition');
    return Utils.createGroupTitle(null, lastCreatedGroupPosition + 1);
}

function isCatchedUrl(url, catchTabRules) {
    return catchTabRules
        .split(/\s*\n\s*/)
        .map(regExpStr => regExpStr.trim())
        .filter(Boolean)
        .some(function(regExpStr) {
            try {
                return new RegExp(regExpStr).test(url);
            } catch (e) {};
        });
}

export function normalizeContainersInGroups(groups) {
    let allContainers = Containers.getAll(true),
        hasChanges = false;

    groups.forEach(function(group) {
        let oldNewTabContainer = group.newTabContainer,
            oldCatchTabContainersLength = group.catchTabContainers.length,
            oldExcludeContainersForReOpenLength = group.excludeContainersForReOpen.length;

        group.newTabContainer = Containers.get(group.newTabContainer, 'cookieStoreId', true);
        group.catchTabContainers = group.catchTabContainers.filter(cookieStoreId => allContainers[cookieStoreId]);
        group.excludeContainersForReOpen = group.excludeContainersForReOpen.filter(cookieStoreId => allContainers[cookieStoreId]);

        if (
            oldNewTabContainer !== group.newTabContainer ||
            oldCatchTabContainersLength !== group.catchTabContainers.length ||
            oldExcludeContainersForReOpenLength !== group.excludeContainersForReOpen.length
        ) {
            hasChanges = true;

            sendMessage('group-updated', {
                group: {
                    id: group.id,
                    newTabContainer: group.newTabContainer,
                    catchTabContainers: group.catchTabContainers,
                    excludeContainersForReOpen: group.excludeContainersForReOpen,
                },
            });
        }
    });

    return hasChanges;
}

export function getCatchedForTab(groups, currentGroup, {cookieStoreId, url}) {
    groups = groups.filter(group => !group.isArchive);

    let destGroup = groups.find(function({catchTabContainers, catchTabRules}) {
        if (catchTabContainers.includes(cookieStoreId)) {
            return true;
        }

        if (catchTabRules && isCatchedUrl(url, catchTabRules)) {
            return true;
        }
    });

    if (destGroup) {
        if (destGroup.id === currentGroup.id) {
            return false;
        }

        return destGroup;
    }

    if (!currentGroup.moveToMainIfNotInCatchTabRules || !currentGroup.catchTabRules) {
        return false;
    }

    let mainGroup = groups.find(group => group.isMain);

    if (!mainGroup || mainGroup.id === currentGroup.id) {
        return false;
    }

    return mainGroup;
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
        Utils.notify(e);
    }
}
