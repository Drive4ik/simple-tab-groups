'use strict';

import storage from './storage';
import utils from './utils';
import Tabs from './tabs';
import Windows from './windows';

const CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP = 'stg-undo-remove-group-id-';

// if set groupId => return [group, groups, groupIndex]
async function load(groupId = null, withTabs = false) {
    const {BG} = browser.extension.getBackgroundPage();

    let [allTabs, {groups}] = await Promise.all([
            withTabs ? Tabs.get(null, false, null) : false,
            storage.get('groups')
        ]);

    if (withTabs) {
        let groupTabs = {};

        groups.forEach(group => groupTabs[group.id] = []);

        await Promise.all(allTabs.map(async function(tab) {
            if (tab.groupId) {
                if (groupTabs[tab.groupId]) {
                    groupTabs[tab.groupId].push(tab);
                } else {
                    delete tab.groupId;
                    await BG.cache.removeTabGroup(tab.id);
                }
            }
        }));

        groups = groups.map(function(group) {
            if (!group.isArchive) {
                group.tabs = groupTabs[group.id].sort(utils.sortBy('index'));
            }

            return group;
        });
    }

    if (groupId) {
        return [groups.find(group => group.id === groupId), groups, groups.findIndex(group => group.id === groupId)];
    }

    return groups;
}

async function save(groups, withMessage = false) {
    const {BG} = browser.extension.getBackgroundPage();

    if (!Array.isArray(groups)) {
        throw Error('groups has invalid type');
    }

    await storage.set({
        groups,
    });

    if (withMessage) {
        BG.sendMessage({
            action: 'groups-updated',
        });
    }

    return groups;
}

function create(id, title) {
    const {BG} = browser.extension.getBackgroundPage();

    let {defaultGroupIconColor, defaultGroupIconViewType} = BG.getOptions();

    return {
        id: id,
        title: utils.createGroupTitle(title, id),
        iconColor: defaultGroupIconColor || utils.randomColor(),
        iconUrl: null,
        iconViewType: defaultGroupIconViewType,
        tabs: [],
        isArchive: false,
        catchTabRules: '',
        catchTabContainers: [],
        newTabContainer: null,
        ifNotDefaultContainerReOpenInNew: true,
        isSticky: false,
        muteTabsWhenGroupCloseAndRestoreWhenOpen: false,
        showTabAfterMovingItIntoThisGroup: false,
        dontDiscardTabsAfterHideThisGroup: false,
    };
}

async function add(windowId, tabIds = [], title, showTabsAfterMoving) {
    const {BG} = browser.extension.getBackgroundPage();

    tabIds = tabIds.slice();

    let {lastCreatedGroupPosition} = await storage.get('lastCreatedGroupPosition');

    lastCreatedGroupPosition++;

    let newGroup = create(lastCreatedGroupPosition, title);

    let groups = await load();

    groups.push(newGroup);

    await save(groups);

    await storage.set({
        lastCreatedGroupPosition,
    });

    if (windowId) {
        await BG.cache.setWindowGroup(windowId, newGroup.id);
        BG.updateBrowserActionData(newGroup.id);
    }

    BG.updateMoveTabMenus();

    if (windowId && !tabIds.length) {
        let tabs = await Tabs.get(windowId);
        tabIds = tabs.map(utils.keyId);
    }

    if (tabIds.length) {
        newGroup.tabs = await Tabs.move(tabIds, newGroup.id, undefined, false, showTabsAfterMoving);
    }

    if (!showTabsAfterMoving) {
        BG.sendMessage({
            action: 'group-added',
            group: newGroup,
        });
    }

    BG.sendExternalMessage({
        action: 'group-added',
        group: mapForExternalExtension(newGroup),
    });

    return newGroup;
}

async function remove(groupId) {
    const {BG} = browser.extension.getBackgroundPage();

    let [group, groups, index] = await load(groupId, true);

    BG.addUndoRemoveGroupItem(group);

    groups.splice(index, 1);

    await save(groups);

    if (!group.isArchive) {
        let groupWindowId = BG.cache.getWindowId(groupId);

        if (groupWindowId) {
            BG.setBrowserAction(groupWindowId, 'loading');
            await BG.cache.removeWindowSession(groupWindowId);
        }

        if (group.tabs.length) {
            if (groupWindowId) {
                await Tabs.createTempActiveTab(groupWindowId, false);
            }

            await Tabs.remove(group.tabs.map(utils.keyId));
        }

        BG.updateMoveTabMenus();

        if (groupWindowId) {
            BG.updateBrowserActionData(null, groupWindowId);
        }
    }

    BG.sendMessage({
        action: 'group-removed',
        groupId: groupId,
    });

    BG.sendExternalMessage({
        action: 'group-removed',
        groupId: groupId,
    });
}

async function update(groupId, updateData) {
    const {BG} = browser.extension.getBackgroundPage();

    let [group, groups] = await load(groupId);

    if (!group) {
        throw Error(`group ${groupId} not found for update it`);
    }

    updateData = utils.clone(updateData); // clone need for fix bug: dead object after close tab which create object

    if (updateData.iconUrl && updateData.iconUrl.startsWith('chrome:')) {
        utils.notify('Icon not supported');
        delete updateData.iconUrl;
    }

    if (updateData.title) {
        updateData.title = updateData.title.slice(0, 256);
    }

    Object.assign(group, updateData);

    await save(groups);

    BG.sendMessage({
        action: 'group-updated',
        group: {
            id: groupId,
            ...updateData,
        },
    });

    if (['title', 'iconUrl', 'iconColor', 'iconViewType', 'newTabContainer'].some(key => key in updateData)) {
        BG.sendExternalMessage({
            action: 'group-updated',
            group: mapForExternalExtension(group),
            windowId: BG.cache.getWindowId(groupId),
        });

        BG.updateMoveTabMenus();

        BG.updateBrowserActionData(groupId);
    }
}

async function move(groupId, newGroupIndex) {
    const {BG} = browser.extension.getBackgroundPage();

    let [group, groups, groupIndex] = await load(groupId);

    groups.splice(newGroupIndex, 0, groups.splice(groupIndex, 1)[0]);

    await save(groups, true);

    BG.updateMoveTabMenus();
}

async function sort(vector = 'asc') {
    if (!['asc', 'desc'].includes(vector)) {
        throw Error(utils.errorEventMessage('invalid sort vector', vector));
    }

    const {BG} = browser.extension.getBackgroundPage();

    let groups = await load();

    if ('asc' === vector) {
        groups.sort(utils.sortBy('title'));
    } else {
        groups.sort(utils.sortBy('title', undefined, true));
    }

    await save(groups, true);

    BG.updateMoveTabMenus();
}

async function archiveToggle(groupId) {
    const {BG} = browser.extension.getBackgroundPage();

    await BG.loadingBrowserAction();

    let [group, groups] = await load(groupId, true);

    if (group.isArchive) {
        group.isArchive = false;

        await BG.createTabsSafe(setNewTabsParams(group.tabs, group), {
            sendMessageEachTab: false,
        });
    } else {
        group.isArchive = true;

        let tabIds = group.tabs.map(utils.keyId);

        group.tabs = Tabs.prepareForSave(group.tabs, false, true, true);

        let groupWindowId = BG.cache.getWindowId(group.id);

        if (groupWindowId) {
            await BG.cache.removeWindowSession(groupWindowId);
            await Tabs.createTempActiveTab(groupWindowId, false);
        }

        if (tabIds.length) {
            BG.addExcludeTabsIds(tabIds);
            await Tabs.remove(tabIds);
            BG.removeExcludeTabsIds(tabIds);
        }
    }

    await save(groups, true);

    BG.loadingBrowserAction(false);

    BG.updateMoveTabMenus();
}

function mapForExternalExtension(group) {
    const {BG} = browser.extension.getBackgroundPage();

    return {
        id: group.id,
        title: utils.getGroupTitle(group, group.isArchive ? '' : 'withActiveGroup'),
        isArchive: group.isArchive,
        iconUrl: utils.getGroupIconUrl(group),
        contextualIdentity: group.newTabContainer ? BG.containers.get(group.newTabContainer) : null,
    };
}

function getNewTabParams({id, newTabContainer, ifNotDefaultContainerReOpenInNew}) {
    return {groupId: id, newTabContainer, ifNotDefaultContainerReOpenInNew};
}

function setNewTabsParams(tabs, group) {
    let newTabParams = getNewTabParams(group);

    return tabs.map(tab => Object.assign(tab, newTabParams));
}

async function getNextTitle() {
    let {lastCreatedGroupPosition} = await storage.get('lastCreatedGroupPosition');
    return utils.createGroupTitle(null, lastCreatedGroupPosition + 1);
}

export default {
    CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP,

    load,
    save,
    create,
    add,
    remove,
    update,
    move,
    sort,
    archiveToggle,
    mapForExternalExtension,
    getNewTabParams,
    setNewTabsParams,
    getNextTitle,
};
