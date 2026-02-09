
import * as Constants from '/js/constants.js';
import * as Menus from './menus.js';
import * as MenusBookmark from './menus-bookmark.js';
import * as MenusTab from './menus-tab.js';
import * as MenusLink from './menus-link.js';
import * as Containers from '/js/containers.js';
import * as Tabs from '/js/tabs.js';
import * as Groups from '/js/groups.js';
import * as Browser from '/js/browser.js';
// import * as Cache from '/js/cache.js';
import Logger from '/js/logger.js';
import Lang from '/js/lang.js';

const MODULE_NAME = 'menus-main';

const REOPEN_TEMP_TABS_ID = 'reopenTabsWithTemporaryContainers';

const logger = new Logger(MODULE_NAME);

export async function create(withExtra = true) {
    const log = logger.start(create, {withExtra});

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
}

export async function remove(withExtra = true) {
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

export async function updateGroup(group) {
    await MenusBookmark.updateGroup(group);
    await MenusTab.updateGroup(group);
    await MenusLink.updateGroup(group);
}

export async function groupLoaded(group, windowId) {
    await MenusBookmark.groupLoaded(group, windowId);
    await MenusTab.groupLoaded(group, windowId);
    await MenusLink.groupLoaded(group, windowId);
}

export async function groupUnloaded(group, windowId) {
    await MenusBookmark.groupUnloaded(group, windowId);
    await MenusTab.groupUnloaded(group, windowId);
    await MenusLink.groupUnloaded(group, windowId);
}

export async function groupAdded(group, windowId = null) {
    await MenusBookmark.groupAdded(group, windowId);
    await MenusTab.groupAdded(group, windowId);
    await MenusLink.groupAdded(group, windowId);
}

export async function groupRemoved(group) {
    await MenusBookmark.groupRemoved(group);
    await MenusTab.groupRemoved(group);
    await MenusLink.groupRemoved(group);
}

export async function groupsUpdated(groups) {
    await MenusBookmark.groupsUpdated(groups);
    await MenusTab.groupsUpdated(groups);
    await MenusLink.groupsUpdated(groups);
}

// actions
export async function reopenTabsWithTemporaryContainers(info) {
    const log = logger.start(reopenTabsWithTemporaryContainers, info);

    const allTabs = await Tabs.get(null, null, null, undefined, true, true);
    const tabsToCreate = [];
    const tabsToRemove = [];

    for (const tab of allTabs) {
        if (Containers.isTemporary(tab.cookieStoreId)) {
            tabsToCreate.push({
                ...tab,
                cookieStoreId: Constants.TEMPORARY_CONTAINER,
            });

            tabsToRemove.push(tab);
        }
    }

    if (tabsToCreate.length) {
        await Browser.actionLoading();

        const newTabs = await Promise.all(tabsToCreate.map(Tabs.create));

        const tabsToHide = [];

        for (const tab of newTabs) {
            if (tab.groupId) {
                const groupIsLoaded = await Groups.isLoaded(tab.groupId);

                if (!groupIsLoaded) {
                    tabsToHide.push(tab);
                }
            }
        }

        await Tabs.hide(tabsToHide, true);

        await Tabs.remove(tabsToRemove);

        if (info.button.RIGHT) {
            await Containers.removeUnusedTemporaryContainers(newTabs);
        }

        await Browser.actionLoading(false);
    }

    log.stop('reopened tabs count:', tabsToCreate.length);
}
