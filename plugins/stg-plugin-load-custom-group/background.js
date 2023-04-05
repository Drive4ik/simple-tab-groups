import * as Constants from './constants.js';
import * as Utils from './utils.js';

const SUPPORTED_STG_ACTIONS = new Set(['i-am-back', 'group-added', 'group-updated', 'group-removed']);

browser.runtime.onMessageExternal.addListener(async (request, sender) => {
    if (sender.id !== Constants.STG_ID) {
        console.error(`Only STG support`);
        return;
    }

    const {groupId} = await browser.storage.local.get('groupId');

    switch (request.action) {
        case 'i-am-back':
            await updateBrowserAction();
            break;
        case 'group-updated':
            if (groupId === request.group.id) {
                await updateBrowserAction(request.group);
            }
            break;
        case 'group-removed':
            if (groupId === request.groupId) {
                await resetState();
            }
            break;
    }
});

browser.action.onClicked.addListener(async () => {
    try {
        const {groupId} = await browser.storage.local.get('groupId');

        if (groupId) {
            const responce = await Utils.sendExternalMessage('load-custom-group', {groupId});

            if (!responce.ok) {
                Utils.notify('error', responce.error);
            }
        } else {
            browser.runtime.openOptionsPage();
        }
    } catch (e) {
        setBrowserAction();
        Utils.notify('needInstallSTGExtension', browser.i18n.getMessage('needInstallSTGExtension'), {
            timerSec: 10,
            onClick: {
                action: 'open-tab',
                url: Constants.STG_HOME_PAGE,
            },
        });
    }
});

browser.menus.onClicked.addListener(info => {
    if (info.menuItemId === 'openSettings') {
        browser.runtime.openOptionsPage();
    }
});

async function updateBrowserAction(group = null) {
    try {
        if (!group) {
            const {groupId} = await browser.storage.local.get('groupId'),
                {groupsList} = await Utils.sendExternalMessage('get-groups-list');

            group = groupsList.find(gr => gr.id === groupId);
        }

        await setBrowserAction(group?.title, group?.iconUrl);
    } catch (e) {
        await setBrowserAction();
    }
}

async function setBrowserAction(title = null, iconUrl = null) {
    const [{shortcut}] = await browser.commands.getAll();

    title = title || browser.i18n.getMessage('defaultBrowserActionTitle');

    const titleParts = [title];

    if (shortcut) {
        titleParts.push(`(${shortcut})`);
    }

    await browser.action.setIcon({
        path: iconUrl || 'icons/icon.svg',
    });

    await browser.action.setTitle({
        title: titleParts.join(' '),
    });

    await browser.commands.update({
        name: '_execute_action',
        description: title,
    });
}

async function resetState() {
    await browser.storage.local.remove('groupId');

    await setBrowserAction();

    await Utils.notify('needSelectGroup', browser.i18n.getMessage('needSelectGroup'), {
        onClick: {
            action: 'open-options',
        },
    });
}

async function setup() {
    updateBrowserAction();

    await Utils.createMenu({
        id: 'openSettings',
        title: browser.i18n.getMessage('openSettings'),
        contexts: [browser.menus.ContextType.ACTION],
        icon: 'icons/settings.svg',
    });
}

browser.runtime.onStartup.addListener(setup);
browser.runtime.onInstalled.addListener(setup);

self.updateBrowserAction = updateBrowserAction;
self.SUPPORTED_STG_ACTIONS = SUPPORTED_STG_ACTIONS;
