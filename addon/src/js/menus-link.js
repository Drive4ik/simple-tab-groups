
import Listeners from '/js/listeners.js?storage.local.onChanged';
import * as Constants from '/js/constants.js';
import * as Menus from '/js/menus.js';
import * as Containers from '/js/containers.js';
import * as Utils from '/js/utils.js';
import * as Tabs from '/js/tabs.js';
import * as Groups from '/js/groups.js';
import * as Storage from '/js/storage.js';
import {isChangedBooleanKey} from '/js/storage-utils.js';
import Notification from '/js/notification.js';
import Logger from '/js/logger.js';
import Lang from '/js/lang.js';

const CONTEXT = Menus.ContextType.LINK;
const PARENT_ID = CONTEXT;
const SETTING_KEYS = ['showContextMenuOnLinks', 'showArchivedGroups'];

const MODULE_NAME = 'menus-link';

const logger = new Logger(MODULE_NAME).disable();

export async function create(withExtra = true) {
    const log = logger.start(create, {withExtra});
    const settings = await loadSettings();

    if (settings.showContextMenuOnLinks) {
        await createMenus(settings);
    }

    if (withExtra) {
        // there are no extra menus
    }

    log.stop(settings);
}

export async function remove(withExtra = true) {
    const log = logger.start(remove, {withExtra});
    const settings = await loadSettings();

    if (settings.showContextMenuOnLinks) {
        const withReal = await Menus.has(PARENT_ID);
        await removeMenus(withReal);
    }

    if (withExtra) {
        // there are no extra menus
    }

    log.stop(settings);
}

async function createMenus(settings = null) {
    settings ??= await loadSettings();
    const {groups} = await Groups.load();

    await Menus.create({
        id: PARENT_ID,
        title: Lang('openLinkInGroupTitle'),
        context: CONTEXT,
    });

    for (const group of groups) {
        const groupProperties = await Groups.getMenuProperties(group, CONTEXT, settings);

        await Menus.create({
            ...groupProperties,
            parentId: PARENT_ID,
            module: [MODULE_NAME, 'openInGroup', group.id],
        });
    }

    await Menus.create({
        parentId: PARENT_ID,
        title: Lang('createNewGroup'),
        icon: 'icons/group-new.svg',
        module: [MODULE_NAME, 'createNewGroup'],
    });

    await Menus.createSeparator(PARENT_ID);

    await Menus.create({
        parentId: PARENT_ID,
        title: Containers.TEMPORARY.name,
        icon: Containers.TEMPORARY.iconUrl,
        module: [MODULE_NAME, 'openInTemporaryContainer'],
    });
}

async function removeMenus(withReal) {
    await Menus.remove(PARENT_ID, withReal);
}

export async function updateGroup(group, settings = null) {
    settings ??= await loadSettings();

    if (!settings.showContextMenuOnLinks) {
        return;
    }

    const groupProperties = await Groups.getMenuProperties(group, CONTEXT, settings);
    await Menus.update(groupProperties.id, groupProperties);
}

export async function groupLoaded(group, windowId) {
    await updateGroup(group);
}

export async function groupUnloaded(group, windowId) {
    await updateGroup(group);
}

export async function groupAdded(group, windowId = null) {
    await remove(false);
    await create(false);
}

export async function groupRemoved(group) {
    const settings = await loadSettings();

    if (!settings.showContextMenuOnLinks) {
        return;
    }

    const groupMenuId = await Groups.getMenuId(group.id, CONTEXT);
    await Menus.remove(groupMenuId);
}

export async function groupsUpdated(groups) {
    await remove(false);
    await create(false);
}

// listeners
export function addListeners() {
    Listeners.storage.local.onChanged.add(onStorageChanged, {waitListener: false});
}

export function removeListeners() {
    Listeners.storage.local.onChanged.remove(onStorageChanged);
}

async function onStorageChanged(changes) {
    if (isChangedBooleanKey('showContextMenuOnLinks', changes)) {
        logger.log('onStorageChanged', {showContextMenuOnLinks: changes.showContextMenuOnLinks.newValue});

        if (changes.showContextMenuOnLinks.newValue) {
            await createMenus();
        } else {
            await removeMenus();
            return;
        }
    }

    if (isChangedBooleanKey('showArchivedGroups', changes)) {
        const settings = await loadSettings();

        if (!settings.showContextMenuOnLinks) {
            return
        }

        logger.log('onStorageChanged', {showArchivedGroups: changes.showArchivedGroups.newValue});

        const {groups} = await Groups.load();

        for (const group of groups) {
            await updateGroup(group, settings);
        }
    }
}

// actions
export async function openInTemporaryContainer(info) {
    const log = logger.start(openInTemporaryContainer, info);

    if (!Utils.isUrlAllowToCreate(info.linkUrl)) {
        Notification(['thisUrlsAreNotSupported', info.linkUrl]);
        log.stopWarn('thisUrlsAreNotSupported');
        return;
    }

    await Tabs.create({
        url: info.linkUrl,
        title: info.linkText,
        active: info.button.RIGHT,
        cookieStoreId: Constants.TEMPORARY_CONTAINER,
    });

    log.stop();
}

export async function openInGroup(groupId, info) {
    const log = logger.start(openInGroup, groupId, info);

    if (!Utils.isUrlAllowToCreate(info.linkUrl)) {
        Notification(['thisUrlsAreNotSupported', info.linkUrl]);
        log.stopWarn('thisUrlsAreNotSupported');
        return;
    }

    const newTab = await Tabs.add(groupId, undefined, info.linkUrl, info.linkText);

    if (info.button.RIGHT) {
        await self.applyGroup(newTab.windowId, groupId, newTab.id);
    }

    log.stop();
}

export async function createNewGroup(info) {
    const log = logger.start(createNewGroup, info);

    if (!Utils.isUrlAllowToCreate(info.linkUrl)) {
        Notification(['thisUrlsAreNotSupported', info.linkUrl]);
        log.stopWarn('thisUrlsAreNotSupported');
        return;
    }

    let {ok, group, error} = await self.onBackgroundMessage({
        action: 'add-new-group',
        proposalTitle: info.linkText,
    }, self);

    if (!ok) {
        log.warn('group not created:', error);
        group = await Groups.add(undefined, undefined, info.linkText);
        ok = true;
    }

    if (ok && group) {
        const newTab = await Tabs.add(group.id, undefined, info.linkUrl, info.linkText);

        if (info.button.RIGHT) {
            await self.applyGroup(undefined, group.id, newTab.id);
        }
    }

    log.stop(ok);
}

// helpers
async function loadSettings() {
    return Storage.get(SETTING_KEYS);
}
