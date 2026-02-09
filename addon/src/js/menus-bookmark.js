
import Listeners from '/js/listeners.js?storage.local.onChanged';
import * as Constants from '/js/constants.js';
import * as Menus from '/js/menus.js';
import * as Bookmarks from '/js/bookmarks.js';
import * as Containers from '/js/containers.js';
import * as Utils from '/js/utils.js';
import * as Tabs from '/js/tabs.js';
import * as Groups from '/js/groups.js';
import * as Storage from '/js/storage.js';
import {isChangedBooleanKey} from '/js/storage-utils.js';
import * as Browser from '/js/browser.js';
import * as Permissions from '/js/permissions.js';
import Notification from '/js/notification.js';
import Logger from '/js/logger.js';
import Lang from '/js/lang.js';

const CONTEXT = Menus.ContextType.BOOKMARK;
const PARENT_ID = CONTEXT;
const SETTING_KEYS = ['showArchivedGroups'];
const EXPORT_ALL_GROUPS_ID = 'exportAllGroups';

const MODULE_NAME = 'menus-bookmark';

const logger = new Logger(MODULE_NAME).disable();

export async function create(withExtra = true) {
    const log = logger.start(create, {withExtra});
    const hasPermission = await Bookmarks.hasPermission();

    if (hasPermission) {
        await createMenus();
    }

    if (withExtra) {
        await Menus.create({
            id: EXPORT_ALL_GROUPS_ID,
            title: Lang('exportAllGroupsToBookmarks'),
            icon: 'icons/bookmark.svg',
            enabled: hasPermission,
            context: Menus.ContextType.BROWSER_ACTION,
            module: [MODULE_NAME, 'exportAllGroups'],
        });
    }

    log.stop({hasPermission});
}

export async function remove(withExtra = true) {
    const log = logger.start(remove, {withExtra});
    const hasPermission = await Bookmarks.hasPermission();

    if (hasPermission) {
        const withReal = await Menus.has(PARENT_ID);
        await removeMenus(withReal);
    }

    if (withExtra) {
        if (await Menus.has(EXPORT_ALL_GROUPS_ID)) {
            await Menus.remove(EXPORT_ALL_GROUPS_ID);
        }
    }

    log.stop({hasPermission});
}

async function createMenus() {
    const settings = await loadSettings();
    const {groups} = await Groups.load();

    await Menus.create({
        id: PARENT_ID,
        title: Lang('openBookmarkInGroup'),
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

export async function updateGroup(group, settings = null, hasPermission = null) {
    hasPermission ??= await Bookmarks.hasPermission();

    if (!hasPermission) {
        return;
    }

    settings ??= await loadSettings();
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
    const hasPermission = await Bookmarks.hasPermission();

    if (!hasPermission) {
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
    Permissions.onAdded.add(onPermissionsChanged, {waitListener: false});
    Permissions.onRemoved.add(onPermissionsChanged, {waitListener: false});
    Listeners.storage.local.onChanged.add(onStorageChanged, {waitListener: false});
}

export function removeListeners() {
    Permissions.onAdded.remove(onPermissionsChanged);
    Permissions.onRemoved.remove(onPermissionsChanged);
    Listeners.storage.local.onChanged.remove(onStorageChanged);
}

async function onPermissionsChanged(permissions) {
    if (Permissions.hasAny(permissions, Permissions.BOOKMARKS)) {
        const hasPermission = await Bookmarks.hasPermission();

        if (hasPermission) {
            await createMenus();
        } else {
            await removeMenus(false);
        }

        await Menus.update(EXPORT_ALL_GROUPS_ID, {
            enabled: hasPermission,
        });
    }
}

async function onStorageChanged(changes) {
    if (isChangedBooleanKey('showArchivedGroups', changes)) {
        const hasPermission = await Bookmarks.hasPermission();

        if (!hasPermission) {
            return
        }

        logger.log('onStorageChanged showArchivedGroups, updating groups menus...');

        const settings = await loadSettings();
        const {groups} = await Groups.load();

        for (const group of groups) {
            await updateGroup(group, settings, true);
        }
    }
}

// actions
export async function openInTemporaryContainer(info) {
    const log = logger.start(openInTemporaryContainer, info);

    if (!info.bookmarkId) {
        Notification('bookmarkNotAllowed');
        log.stopWarn('bookmarkNotAllowed');
        return;
    }

    const [bookmark] = await Bookmarks.get(info.bookmarkId);

    if (bookmark.type !== Bookmarks.BOOKMARK) {
        Notification('bookmarkNotAllowed');
        log.stopWarn('bookmarkNotAllowed');
        return;
    }

    if (!Utils.isUrlAllowToCreate(bookmark.url)) {
        Notification(['thisUrlsAreNotSupported', bookmark.url]);
        log.stopWarn('thisUrlsAreNotSupported');
        return;
    }

    await Tabs.create({
        url: bookmark.url,
        title: bookmark.title,
        active: info.button.RIGHT,
        cookieStoreId: Constants.TEMPORARY_CONTAINER,
    });

    log.stop();
}

export async function openInGroup(groupId, info) {
    const log = logger.start(openInGroup, groupId, info);

    if (!info.bookmarkId) {
        Notification('bookmarkNotAllowed');
        log.stopWarn('bookmarkNotAllowed');
        return;
    }

    await Browser.actionLoading();

    const tabsToCreate = [];

    const [bookmark] = await Bookmarks.getSubTree(info.bookmarkId);

    if (bookmark.type === Bookmarks.BOOKMARK) {
        bookmark.children = [bookmark];
    }

    await findBookmarks(bookmark);

    async function findBookmarks(folder) {
        for (const bookm of folder.children) {
            if (bookm.type === Bookmarks.FOLDER) {
                await findBookmarks(bookm);
            } else if (bookm.type === Bookmarks.BOOKMARK) {
                tabsToCreate.push({
                    title: bookm.title,
                    url: bookm.url,
                });
            }
        }
    }

    if (tabsToCreate.length) {
        const {group} = await Groups.load(groupId);
        const [firstTab] = await self.createTabsSafe(Groups.setNewTabsParams(tabsToCreate, group));

        await Browser.actionLoading(false);

        if (info.button.RIGHT) {
            await self.applyGroup(undefined, groupId, firstTab.id);
        } else {
            // Notification(['tabsCreatedCount', tabsToCreate.length]);
        }
    } else {
        await Browser.actionLoading(false);
        // Notification('tabsNotCreated');
    }

    log.stop('created tabs count:', tabsToCreate.length);
}

export async function createNewGroup(info) {
    const log = logger.start(createNewGroup, info);

    if (!info.bookmarkId) {
        Notification('bookmarkNotAllowed');
        log.stop('bookmarkNotAllowed');
        return;
    }

    const [bookmark] = await Bookmarks.get(info.bookmarkId);

    log.log('bookmark is', bookmark.type);

    if (bookmark.type === Bookmarks.BOOKMARK) {
        if (!Utils.isUrlAllowToCreate(bookmark.url)) {
            Notification('bookmarkNotAllowed');
            log.stop('bookmarkNotAllowed');
            return;
        }

        let {ok, group, error} = await self.onBackgroundMessage({
            action: 'add-new-group',
            proposalTitle: bookmark.title,
        }, self);

        if (!ok) {
            log.warn('group not created:', error);
            group = await Groups.add(undefined, undefined, bookmark.title);
            ok = true;
        }

        if (ok && group) {
            const newTab = await Tabs.add(group.id, undefined, bookmark.url, bookmark.title);

            if (info.button.RIGHT) {
                await self.applyGroup(undefined, group.id, newTab.id);
            }
        }
    } else if (bookmark.type === Bookmarks.FOLDER) {
        const [folder] = await Bookmarks.getSubTree(info.bookmarkId);

        await Browser.actionLoading();

        let groupsCreatedCount = 0;
        async function addBookmarkFolderAsGroup(folder) {
            const tabsToCreate = [];

            for (const bookm of folder.children) {
                if (bookm.type === Bookmarks.FOLDER) {
                    await addBookmarkFolderAsGroup(bookmark);
                } else if (bookm.type === Bookmarks.BOOKMARK) {
                    tabsToCreate.push({
                        title: bookm.title,
                        url: bookm.url,
                    });
                }
            }

            if (tabsToCreate.length) {
                const newGroup = await Groups.add(undefined, undefined, folder.title);
                await self.createTabsSafe(Groups.setNewTabsParams(tabsToCreate, newGroup));
                groupsCreatedCount++;
            }
        }

        await addBookmarkFolderAsGroup(folder);

        await Browser.actionLoading(false);

        if (groupsCreatedCount) {
            Notification(['groupsCreatedCount', groupsCreatedCount]);
        } else {
            Notification('noGroupsCreated');
        }

        log.log('created groups count: ', groupsCreatedCount);
    } else {
        Notification('bookmarkNotAllowed');
    }

    log.stop();
}

export async function exportAllGroups() {
    const log = logger.start(exportAllGroups);
    await Browser.actionLoading();
    const {groups} = await Groups.load(null, true);
    await Bookmarks.exportGroups(groups);
    await Browser.actionLoading(false);
    // Notification('allGroupsExported'); // ? maybe not needed anymore
    log.stop();
}

// helpers
async function loadSettings() {
    return Storage.get(SETTING_KEYS);
}
