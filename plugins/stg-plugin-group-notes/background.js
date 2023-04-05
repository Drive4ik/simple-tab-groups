import * as Constants from './constants.js';
import * as Utils from './utils.js';
import * as MainUtils from './main-utils.js';

browser.runtime.onMessageExternal.addListener(async (request, sender) => {
    if (sender.id !== Constants.STG_ID) {
        console.error(`Only STG support`);
        return;
    }

    const requestGroupKey = MainUtils.getGroupKey(request.groupId);

    switch (request.action) {
        case 'i-am-back':
            Utils.sendExternalMessage('ignore-ext-for-reopen-container');
            init();
            break;
        case 'group-loaded':
            const {[requestGroupKey]: notes} = await browser.storage.local.get(requestGroupKey);
            MainUtils.setBadge(notes?.notes?.trim(), request.windowId);
            break;
        case 'group-unloaded':
            MainUtils.setBadge(false, request.windowId);
            break;
        case 'group-removed':
            MainUtils.setBadge(false, request.windowId);
            browser.storage.local.remove(requestGroupKey);
            break;
        case 'get-backup':
            return {
                backup: await browser.storage.local.get(),
            };
        case 'set-backup':
            await browser.storage.local.clear();
            await browser.storage.local.set(request.backup);
            browser.runtime.reload();
            break;
    }
});

browser.menus.onClicked.addListener(async info => {
    if (info.menuItemId === 'openInTab') {
        browser.tabs.create({
            active: true,
            pinned: true,
            url: browser.runtime.getURL('popup/popup.html#tab'),
        });
    } else if (info.menuItemId === 'openOptions') {
        browser.runtime.openOptionsPage();
    } else {
        throw Error(`unknown menu id: ${info.menuItemId}`);
    }
});

async function init() {
    const {groupsList} = await Utils.sendExternalMessage('get-groups-list'),
        notes = await browser.storage.local.get();

    groupsList.forEach(({id, windowId}) => MainUtils.setBadge(notes[MainUtils.getGroupKey(id)]?.notes.trim(), windowId));
}

async function setup() {
    await browser.action.setBadgeBackgroundColor({
        color: 'transparent',
    });

    init();

    await Utils.createMenu({
        id: 'openInTab',
        title: browser.i18n.getMessage('openInTab'),
        contexts: [browser.menus.ContextType.ACTION],
        icon: 'icons/icon.svg',
    });

    await Utils.createMenu({
        id: browser.menus.ItemType.SEPARATOR,
        type: browser.menus.ItemType.SEPARATOR,
        contexts: [browser.menus.ContextType.ACTION],
    });

    await Utils.createMenu({
        id: 'openOptions',
        title: browser.i18n.getMessage('openOptions'),
        contexts: [browser.menus.ContextType.ACTION],
        icon: 'icons/gear-solid.svg',
    });
}

browser.runtime.onStartup.addListener(setup);
browser.runtime.onInstalled.addListener(async ({reason, previousVersion}) => {
    if (reason === browser.runtime.OnInstalledReason.UPDATE) {
        const [major] = previousVersion.split('.');

        if (major == 1) {
            const oldStorage = await browser.storage.local.get();
            const newStorage = MainUtils.migrateStrorageToV2(oldStorage);

            await browser.storage.local.clear();
            await browser.storage.local.set(newStorage);
        }
    }

    try {
        await Utils.sendExternalMessage('ignore-ext-for-reopen-container');
    } catch (e) {
        Utils.notify('needInstallSTGExtension', browser.i18n.getMessage('needInstallSTGExtension'), {
            timerSec: 10,
            onClick: {
                action: 'open-tab',
                url: Constants.STG_HOME_PAGE,
            },
        });
    }

    setup();
});
