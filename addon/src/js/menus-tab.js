
import Listeners from '/js/listeners.js\
?storage.local.onChanged\
&windows.onFocusChanged';
import * as Constants from '/js/constants.js';
import * as Menus from '/js/menus.js';
import * as Containers from '/js/containers.js';
import * as Utils from '/js/utils.js';
import * as Tabs from '/js/tabs.js';
import * as Groups from '/js/groups.js';
import * as Windows from '/js/windows.js';
import * as Storage from '/js/storage.js';
import {isChangedBooleanKey} from '/js/storage-utils.js';
import Notification from '/js/notification.js';
import Logger from '/js/logger.js';
import Lang from '/js/lang.js';

const CONTEXT = Menus.ContextType.TAB;
const PARENT_ID = CONTEXT;
const SETTING_KEYS = ['showContextMenuOnTabs', 'showArchivedGroups'];
const SET_ICON_TO_GROUP_ID = 'set-tab-icon-as-group-icon';

const MODULE_NAME = 'menus-tab';

const logger = new Logger(MODULE_NAME).disable();

export async function create(withExtra = true) {
    const log = logger.start(create, {withExtra});
    const settings = await loadSettings();

    if (settings.showContextMenuOnTabs) {
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

    if (settings.showContextMenuOnTabs) {
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
        title: Lang('moveTabToGroupTitle'),
        context: CONTEXT,
    });

    for (const group of groups) {
        const groupProperties = await Groups.getMenuProperties(group, CONTEXT, settings);

        await Menus.create({
            ...groupProperties,
            parentId: PARENT_ID,
            module: [MODULE_NAME, 'moveToGroup', group.id],
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

    await Menus.create({
        id: SET_ICON_TO_GROUP_ID,
        parentId: PARENT_ID,
        title: Lang('setTabIconAsGroupIcon'),
        icon: 'icons/image.svg',
        module: [MODULE_NAME, 'setIconAsGroupIcon'],
    });

}

async function removeMenus(withReal) {
    await Menus.remove(PARENT_ID, withReal);
}

export async function updateGroup(group, settings = null) {
    settings ??= await loadSettings();

    if (!settings.showContextMenuOnTabs) {
        return;
    }

    const groupProperties = await Groups.getMenuProperties(group, CONTEXT, settings);
    await Menus.update(groupProperties.id, groupProperties);
}

export async function groupLoaded(group, windowId) {
    const settings = await loadSettings();
    await updateGroup(group, settings);
    await updateIconToGroup(windowId, settings, true);
}

export async function groupUnloaded(group, windowId) {
    const settings = await loadSettings();
    await updateGroup(group, settings);
    await updateIconToGroup(windowId, settings, false);
}

async function updateIconToGroup(windowId, settings, enabled) {
    if (!settings.showContextMenuOnTabs) {
        return;
    }

    const currentWindow = await Windows.get();

    if (currentWindow.id === windowId) {
        await Menus.update(SET_ICON_TO_GROUP_ID, {
            enabled,
        });
    }
}

export async function groupAdded(group, windowId = null) {
    await remove(false);
    await create(false);
}

export async function groupRemoved(group) {
    const settings = await loadSettings();

    if (!settings.showContextMenuOnTabs) {
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
    Listeners.windows.onFocusChanged.add(onWindowFocusChanged, {waitListener: false});
}

export function removeListeners() {
    Listeners.storage.local.onChanged.remove(onStorageChanged);
    Listeners.windows.onFocusChanged.remove(onWindowFocusChanged);
}

async function onStorageChanged(changes) {
    if (isChangedBooleanKey('showContextMenuOnTabs', changes)) {
        logger.log('onStorageChanged', {showContextMenuOnTabs: changes.showContextMenuOnTabs});

        if (changes.showContextMenuOnTabs.newValue) {
            await createMenus();
        } else {
            await removeMenus();
            return;
        }
    }

    if (isChangedBooleanKey('showArchivedGroups', changes)) {
        const settings = await loadSettings();

        if (!settings.showContextMenuOnTabs) {
            return
        }

        logger.log('onStorageChanged', {showArchivedGroups: changes.showArchivedGroups});

        const {groups} = await Groups.load();

        for (const group of groups) {
            await updateGroup(group, settings);
        }
    }
}

async function onWindowFocusChanged(windowId) {
    if (windowId === browser.windows.WINDOW_ID_NONE) {
        return;
    }

    const isNormalWindow = await Windows.isNormal(windowId);

    if (!isNormalWindow) {
        return;
    }

    const settings = await loadSettings();

    if (!settings.showContextMenuOnTabs) {
        return;
    }

    const groupId = await browser.sessions.getWindowValue(windowId, 'groupId');

    await Menus.update(SET_ICON_TO_GROUP_ID, {
        enabled: Boolean(groupId),
    });
}

// actions
export async function openInTemporaryContainer(info, tab) {
    const log = logger.start(openInTemporaryContainer, info, tab);

    if (!Utils.isUrlAllowToCreate(tab.url)) {
        Notification(['thisUrlsAreNotSupported', tab.url]);
        log.stopWarn('thisUrlsAreNotSupported', tab.url);
        return;
    }

    await Tabs.create({
        ...tab,
        index: null,
        active: info.button.RIGHT,
        cookieStoreId: Constants.TEMPORARY_CONTAINER,
    });

    log.stop();
}

export async function setIconAsGroupIcon(info, tab) {
    const log = logger.start(setIconAsGroupIcon, info, tab);

    const groupId = await browser.sessions.getWindowValue(tab.windowId, 'groupId');

    if (!groupId) {
        await Menus.update(info.menuItemId, {enabled: false});
        log.stopWarn('no group found');
        return;
    }

    tab = Utils.normalizeTabFavIcon(tab);
    await Groups.setIconUrl(groupId, tab.favIconUrl);

    log.stop();
}

export async function moveToGroup(groupId, info, tab) {
    const log = logger.start(moveToGroup, info, tab);

    const tabIds = await Tabs.getHighlightedIds(tab.windowId, tab);

    await Tabs.move(tabIds, groupId, {
        showTabAfterMovingItIntoThisGroup: info.button.RIGHT,
    });

    if (!info.button.RIGHT && Menus.isControlPressed(info)) {
        await Tabs.discard(tabIds);
    }

    log.stop();
}

export async function createNewGroup(info, tab) {
    const log = logger.start(createNewGroup, info, tab);

    const tabIds = await Tabs.getHighlightedIds(tab.windowId, tab);

    await self.onBackgroundMessage({
        action: 'add-new-group',
        proposalTitle: tab.title,
        tabIds: tabIds,
        windowId: info.button.RIGHT ? tab.windowId : undefined,
    }, self);

    log.stop();
}

// helpers
async function loadSettings() {
    return Storage.get(SETTING_KEYS);
}
