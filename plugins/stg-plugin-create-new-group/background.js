import Listeners from './listeners.js\
?onExtensionStart\
&action.onClicked\
&commands.onChanged\
';
import * as Constants from './constants.js';
import * as Utils from './utils.js';
import Notification from './notification.js';

Listeners.action.onClicked(async () => {
    try {
        const responce = await Utils.sendExternalMessage('add-new-group');

        if (responce.ok) {
            Utils.sendExternalMessage('load-last-group');
        } else {
            Notification(responce.error);
        }
    } catch {
        Notification('needInstallSTGExtension', {
            tab: {
                url: Constants.STG_HOME_PAGE,
            },
        });
    }
});

async function updateActionTitle() {
    const [{shortcut}] = await browser.commands.getAll();

    const titleParts = [browser.i18n.getMessage('createNewGroupTitle')];

    if (shortcut) {
        titleParts.push(`(${shortcut})`);
    }

    await browser.action.setTitle({
        title: titleParts.join(' '),
    });
}

async function setup() {
    updateActionTitle();
}

Listeners.commands.onChanged(updateActionTitle);

Listeners.onExtensionStart(setup);
