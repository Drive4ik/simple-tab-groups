import Listeners from './listeners.js\
?onExtensionStart\
&action.onClicked\
&menus.onClicked\
&commands.onChanged\
&runtime.onMessage\
&runtime.onMessageExternal\
';
import * as Constants from './constants.js';
import * as Utils from './utils.js';

Listeners.runtime.onMessageExternal(async (request, sender) => {
    if (sender.id !== Constants.STG_ID) {
        return 'Only STG support';
    }

    const {groupId} = await browser.storage.local.get('groupId');

    switch (request.action) {
        case 'i-am-back':
            updateAction();
            break;
        case 'group-added':
            // used in options page
            break;
        case 'group-updated':
            if (groupId === request.group.id) {
                updateAction(request.group);
            }
            break;
        case 'group-removed':
            if (groupId === request.groupId) {
                await browser.storage.local.remove('groupId');
                setAction();
            }
            break;
    }
});

Listeners.runtime.onMessage((message, sender) => {
    if (sender.id !== browser.runtime.id) {
        return;
    }

    switch (message.action) {
        case 'group-selected':
            updateAction();
            break;
    }
});

Listeners.action.onClicked(async () => {
    try {
        const {groupId} = await browser.storage.local.get('groupId');
        const responce = await Utils.sendExternalMessage('load-custom-group', {groupId});

        if (!responce.ok) {
            Utils.notify('error', responce.error);
        }
    } catch {
        setAction();
        Utils.notify('needInstallSTGExtension', browser.i18n.getMessage('needInstallSTGExtension'), {
            timerSec: 10,
            onClick: {
                action: 'open-tab',
                url: Constants.STG_HOME_PAGE,
            },
        });
    }
});

Listeners.menus.onClicked(info => {
    if (info.menuItemId === 'openSettings') {
        browser.runtime.openOptionsPage();
    }
});

async function updateAction(group) {
    try {
        if (!group) {
            const {groupId} = await browser.storage.local.get('groupId');

            if (groupId) {
                const {groupsList} = await Utils.sendExternalMessage('get-groups-list');
                group = groupsList.find(gr => gr.id === groupId);
            }
        }

        await setAction(group);
    } catch {
        await setAction();
    }
}

async function setAction({id, title, iconUrl} = {}) {
    const [{shortcut}] = await browser.commands.getAll();

    const titleParts = [
        id ? title : browser.i18n.getMessage('defaultBrowserActionTitle'),
    ];

    if (shortcut) {
        titleParts.push(`(${shortcut})`);
    }

    await browser.action.setTitle({
        title: titleParts.join(' '),
    });

    await browser.action.setIcon({
        path: id ? iconUrl : 'icons/icon.svg',
    });

    await browser.action.setPopup({
        popup: id ? '' : Constants.MANIFEST.options_ui.page,
    });

    await browser.commands.update({
        name: '_execute_action',
        description: titleParts[0],
    });
}

async function setup() {
    updateAction();

    await Utils.createMenu({
        id: 'openSettings',
        title: browser.i18n.getMessage('openSettings'),
        contexts: [browser.menus.ContextType.ACTION],
        icon: 'icons/settings.svg',
    });
}

Listeners.commands.onChanged(() => updateAction());

Listeners.onExtensionStart(setup);
