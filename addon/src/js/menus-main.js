
import * as Constants from '/js/constants.js';
import * as Menus from './menus.js';
import * as MenusBookmark from './menus-bookmark.js';
import * as MenusTab from './menus-tab.js';
import * as MenusLink from './menus-link.js';
import * as Containers from '/js/containers.js';
import * as Tabs from '/js/tabs.js';
import * as Operations from '/js/operations.js';
import * as Browser from '/js/browser.js';
// import * as Cache from '/js/cache.js';
import Logger from '/js/logger.js';
import Lang from '/js/lang.js';

const MODULE_NAME = 'menus-main';

const REOPEN_TEMP_TABS_ID = 'reopenTabsWithTemporaryContainers';

const logger = new Logger(MODULE_NAME);

export function create(withExtra = true) {
    return Menus.transaction('create', async () => {
        const log = logger.start(create, {withExtra});

        await Menus.removeAll();

        await MenusBookmark.create(withExtra);
        await MenusTab.create(withExtra);
        await MenusLink.create(withExtra);

        if (withExtra) {
            await Menus.create({
                id: REOPEN_TEMP_TABS_ID,
                title: Lang('reopenTabsWithTemporaryContainers'),
                icon: Containers.TEMPORARY.iconUrl,
                context: Menus.ContextType.BROWSER_ACTION,
                module: [MODULE_NAME, 'reopenTabsWithTemporaryContainers'],
            });
        }

        log.stop();
    });
}

export function remove(withExtra = true) {
    return Menus.transaction('remove', async () => {
        const log = logger.start(remove, {withExtra});

        await MenusBookmark.remove(withExtra);
        await MenusTab.remove(withExtra);
        await MenusLink.remove(withExtra);

        if (withExtra) {
            if (await Menus.has(REOPEN_TEMP_TABS_ID)) {
                await Menus.remove(REOPEN_TEMP_TABS_ID);
            }
        }

        log.stop();
    });
}

export function addListeners() {
    MenusBookmark.addListeners();
    MenusTab.addListeners();
    MenusLink.addListeners();
}

export function removeListeners() {
    MenusBookmark.removeListeners();
    MenusTab.removeListeners();
    MenusLink.removeListeners();
}

export function updateGroup(group) {
    return Menus.transaction('update-group', async () => {
        await MenusBookmark.updateGroup(group);
        await MenusTab.updateGroup(group);
        await MenusLink.updateGroup(group);
    });
}

export function groupLoaded(group, windowId) {
    return Menus.transaction('group-loaded', async () => {
        await MenusBookmark.groupLoaded(group, windowId);
        await MenusTab.groupLoaded(group, windowId);
        await MenusLink.groupLoaded(group, windowId);
    });
}

export function groupUnloaded(group, windowId) {
    return Menus.transaction('group-unloaded', async () => {
        await MenusBookmark.groupUnloaded(group, windowId);
        await MenusTab.groupUnloaded(group, windowId);
        await MenusLink.groupUnloaded(group, windowId);
    });
}

export function groupAdded(group, windowId = null) {
    return Menus.transaction('group-added', async () => {
        await MenusBookmark.groupAdded(group, windowId);
        await MenusTab.groupAdded(group, windowId);
        await MenusLink.groupAdded(group, windowId);
    });
}

export function groupRemoved(group) {
    return Menus.transaction('group-removed', async () => {
        await MenusBookmark.groupRemoved(group);
        await MenusTab.groupRemoved(group);
        await MenusLink.groupRemoved(group);
    });
}

export function groupsUpdated(groups) {
    return Menus.transaction('groups-updated', async () => {
        await MenusBookmark.groupsUpdated(groups);
        await MenusTab.groupsUpdated(groups);
        await MenusLink.groupsUpdated(groups);
    });
}

// actions
export function reopenTabsWithTemporaryContainers(...args) {
    return Operations.run('reopen-temp-containers', () => reopenTabsWithTemporaryContainersNow(...args));
}

async function reopenTabsWithTemporaryContainersNow(info) {
    const log = logger.start(reopenTabsWithTemporaryContainers, info);

    const allTabs = await Tabs.query({}, {
        includeFavIconUrl: true,
        includeThumbnail: true,
    });
    const tabsToReopen = allTabs.filter(tab => Containers.isTemporary(tab.cookieStoreId));

    if (tabsToReopen.length) {
        await Browser.actionLoading();

        await Tabs.recreate(tabsToReopen, tab => ({
            ...tab,
            cookieStoreId: Constants.TEMPORARY_CONTAINER,
        }));

        if (info.button.RIGHT) {
            await Tabs.removeUnusedTemporaryContainers();
        }

        await Browser.actionLoading(false);
    }

    log.stop('reopened tabs count:', tabsToReopen.length);
}
