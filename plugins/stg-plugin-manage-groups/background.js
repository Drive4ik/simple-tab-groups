import Listeners from './listeners.js\
?extension.onStart\
&action.onClicked\
&commands.onChanged\
';
import * as Constants from './constants.js';
import * as Utils from './utils.js';
import Notification from './notification.js?add-listeners';
import Lang from './lang.js';

Listeners.action.onClicked.add(async () => {
    try {
        const responce = await Utils.sendExternalMessage('open-manage-groups');

        if (!responce.ok) {
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

    const titleParts = [Lang('defaultBrowserActionTitle')];

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

Listeners.commands.onChanged.add(updateActionTitle);

Listeners.extension.onStart.add(setup);
