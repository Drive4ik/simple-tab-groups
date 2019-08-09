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
            if (tab.session.groupId) {
                if (groupTabs[tab.session.groupId]) {
                    groupTabs[tab.session.groupId].push(tab);
                } else {
                    delete tab.session.groupId;
                    BG.cache.removeTabGroup(tab.id);
                }
            }
        }));

        groups = groups.map(function(group) {
            group.tabs = groupTabs[group.id].sort(utils.sortBy('index'));
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
        catchTabRules: '',
        catchTabContainers: [],
        isSticky: false,
        muteTabsWhenGroupCloseAndRestoreWhenOpen: false,
        showTabAfterMovingItIntoThisGroup: false,
        dontDiscardTabsAfterHideThisGroup: false,
    };
}

async function add(windowId, tabs = [], title, showTabsAfterMoving) {
    const {BG} = browser.extension.getBackgroundPage();

    let { lastCreatedGroupPosition } = await storage.get('lastCreatedGroupPosition');

    tabs = utils.clone(tabs); // clone need for fix bug: dead object after close tab which create object

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

    BG.updateMoveTabMenus(windowId);

    if (windowId && !tabs.length) {
        tabs = await Tabs.get(windowId);
    }

    if (tabs.length) {
        newGroup.tabs = await Tabs.move(tabs, newGroup.id, undefined, false, showTabsAfterMoving);
    }

    if (!showTabsAfterMoving) {
        BG.sendMessage({
            action: 'group-added',
            group: newGroup,
        });
    }

    BG.sendExternalMessage({
        action: 'group-added',
        group: mapGroupForExternalExtension(newGroup),
    });

    return newGroup;
}

async function remove(groupId) {
    const {BG} = browser.extension.getBackgroundPage();

    let [group, groups, index] = await load(groupId, true),
        groupWindowId = BG.cache.getWindowId(groupId);

    BG.addUndoRemoveGroupItem(group);

    groups.splice(index, 1);

    await save(groups);

    if (groupWindowId) {
        BG.setBrowserAction(groupWindowId, 'loading');
        await BG.cache.removeWindowGroup(groupWindowId);
    }

    if (group.tabs.length) {
        if (groupWindowId) {
            await Tabs.createTempActiveTab(groupWindowId, false);
        }

        await browser.tabs.remove(group.tabs.map(utils.keyId));
    }

    BG.updateMoveTabMenus();

    if (groupWindowId) {
        BG.updateBrowserActionData(null, groupWindowId);
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

    if (updateData.iconUrl && updateData.iconUrl.startsWith('chrome')) {
        utils.notify('Icon not supported');
        delete updateData.iconUrl;
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

    if (['title', 'iconUrl', 'iconColor', 'iconViewType'].some(key => key in updateData)) {
        BG.sendExternalMessage({
            action: 'group-updated',
            group: mapGroupForExternalExtension(group),
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

function mapGroupForExternalExtension(group) {
    return {
        id: group.id,
        title: group.title,
        iconUrl: utils.getGroupIconUrl(group),
    };
}

async function getNextTitle() {
    let { lastCreatedGroupPosition } = await storage.get('lastCreatedGroupPosition');
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
    mapGroupForExternalExtension,
    getNextTitle,
};
