import * as Constants from './constants.js';
import * as Utils from './utils.js';

browser.action.onClicked.addListener(async () => {
    try {
        const responce = await Utils.sendExternalMessage('add-new-group');

        if (responce.ok) {
            Utils.sendExternalMessage('load-last-group');
        } else {
            Utils.notify('error', responce.error);
        }
    } catch (e) {
        Utils.notify('needInstallSTGExtension', browser.i18n.getMessage('needInstallSTGExtension'), {
            timerSec: 10,
            onClick: {
                action: 'open-tab',
                url: Constants.STG_HOME_PAGE,
            },
        });
    }
});
