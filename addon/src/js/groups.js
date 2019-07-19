'use strict';

import storage from './storage';
import utils from './utils';
import Tabs from './tabs';
import Windows from './windows';

// if set groupId => return [group, groups]
async function load(groupId = null, withTabs = false) {
    const {BG} = browser.extension.getBackgroundPage();

    let [allTabs, {groups}] = await Promise.all([
            withTabs ? browser.tabs.query({
                windowType: browser.windows.WindowType.NORMAL,
                pinned: false,
            }) : true,
            storage.get('groups')
        ]);

    if (withTabs) {
        let groupTabs = {};

        groups.forEach(group => groupTabs[group.id] = []);

        await Promise.all(allTabs.map(async function(tab) {
            tab = await BG.cache.loadTabSession(tab);

            if (tab.session.groupId) {
                if (groupTabs[tab.session.groupId]) {
                    groupTabs[tab.session.groupId].push(tab);
                } else {
                    BG.cache.removeTabGroup(tab.id);
                }
            }
        }));

        groups = groups.map(function(group) {
            group.tabs = groupTabs[group.id].sort(utils.sortBy('index')); // TODO check perfomance with sort
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

    groups.forEach(group => group.tabs = []);

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

    return {
        id: id,
        title: utils.createGroupTitle(title, id),
        iconColor: BG.getOptions().defaultGroupIconColor || utils.randomColor(),
        iconUrl: null,
        iconViewType: BG.getOptions().defaultGroupIconViewType,
        tabs: [],
        catchTabRules: '',
        catchTabContainers: [],
        isSticky: false,
        muteTabsWhenGroupCloseAndRestoreWhenOpen: false,
        showTabAfterMovingItIntoThisGroup: false,
        // windowId: windowId || null,
    };
}

async function add(windowId, withTabs = [], title) {
    const {BG} = browser.extension.getBackgroundPage();

    let { lastCreatedGroupPosition } = await storage.get('lastCreatedGroupPosition');

    withTabs = utils.clone(withTabs); // clone need for fix bug: dead object after close tab which create object

    lastCreatedGroupPosition++;

    let newGroup = create(lastCreatedGroupPosition, title);

    let groups = await load();

    groups.push(newGroup);

    await save(groups);

    await storage.set({
        lastCreatedGroupPosition,
    });

    if (!withTabs.length && (1 === groups.length || windowId)) {
        if (!windowId) {
            windowId = await Windows.getLastFocusedNormalWindow();
        }

        withTabs = await Tabs.get(windowId);
    }

    if (windowId) {
        await BG.cache.setWindowGroup(windowId, newGroup.id);
        BG.updateBrowserActionData(newGroup.id);
    }

    if (withTabs.length) {
        await Tabs.move(withTabs, newGroup.id, undefined, false);
        // await Promise.all(withTabs.map(tab => cache.setTabGroup(tab.id, newGroup.id)));
        // await createTabsSafe(withTabs, !windowId, newGroup.id);
    }

    BG.sendMessage({
        action: 'group-added',
        group: newGroup,
    });

    BG.sendExternalMessage({
        action: 'group-added',
        group: mapGroupForExternalExtension(newGroup),
    });

    BG.updateMoveTabMenus(windowId);

    return newGroup;
}

async function remove(groupId) {
    const {BG} = browser.extension.getBackgroundPage();

    let [group, groups, index] = await load(groupId, true),
        groupWindowId = BG.cache.getWindowId(groupId);

    addUndoRemoveGroupItem(group);

    groups.splice(index, 1);

    await save(groups);

    if (groupWindowId) {
        BG.setBrowserAction(groupWindowId, 'loading');
        await BG.cache.removeWindowGroup(groupWindowId);
    }

    if (group.tabs.length) {
        if (groupWindowId && BG.cache.getWindowsCount() === 1) {
            await Tabs.createTempActiveTab(groupWindowId, false);
        }

        await browser.tabs.remove(group.tabs.map(utils.keyId));
    }

    BG.updateMoveTabMenus();

    BG.updateBrowserActionData(groupId);

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
    }

    BG.updateBrowserActionData(groupId);
}

async function move(groupId, position) {
    const {BG} = browser.extension.getBackgroundPage();

    let [group, groups, groupIndex] = await load(groupId);

    groups.splice(position, 0, groups.splice(groupIndex, 1)[0]);

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

const CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP = 'stg-undo-remove-group-id-';

async function addUndoRemoveGroupItem(groupToRemove) {
    const {BG} = browser.extension.getBackgroundPage();

    let restoreGroup = async function(group) {
        browser.menus.remove(CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP + group.id);

        let tabs = group.tabs,
            groups = await load();

        groups.push(group);

        await save(groups, true);

        if (tabs.length) {
            await BG.createTabsSafe(tabs, true, group.id);
        }

        BG.updateMoveTabMenus();
    }.bind(null, utils.clone(groupToRemove));

    browser.menus.create({
        id: CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP + groupToRemove.id,
        title: browser.i18n.getMessage('undoRemoveGroupItemTitle', groupToRemove.title),
        contexts: [browser.menus.ContextType.BROWSER_ACTION],
        icons: utils.getGroupIconUrl(groupToRemove, 16),
        onclick: restoreGroup,
    });

    utils.notify(browser.i18n.getMessage('undoRemoveGroupNotification', groupToRemove.title)).then(restoreGroup);
}

export default {
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
    addUndoRemoveGroupItem,
};
