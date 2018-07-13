(async function() {
    'use strict';

    const STG_ID = 'simple-tab-groups@drive4ik',
        STG_HOME_PAGE = 'https://addons.mozilla.org/firefox/addon/simple-tab-groups/';

    function sendExternalMessage(data) {
        return new Promise(function(resolve, reject) {
            browser.runtime.sendMessage(STG_ID, data, function(responce) {
                if (responce && responce.ok) {
                    resolve(responce);
                } else {
                    reject(responce);
                }
            });
        });
    }

    function notify(message, timer = 20000) {
        let id = String(Date.now());

        // https://developer.mozilla.org/en-US/Add-ons/WebExtensions/API/notifications/NotificationOptions
        // Only 'type', 'iconUrl', 'title', and 'message' are supported.
        browser.notifications.create(id, {
            type: 'basic',
            iconUrl: '/icons/icon.svg',
            title: browser.i18n.getMessage('extensionName'),
            message: String(message),
        });

        setTimeout(browser.notifications.clear, timer, id);

        return new Promise(function(resolve, reject) {
            let called = false,
                listener = function(id, notificationId) {
                    if (id === notificationId) {
                        browser.notifications.onClicked.removeListener(listener);
                        called = true;
                        resolve(id);
                    }
                }.bind(null, id);

            setTimeout(() => !called && reject(), timer);

            browser.notifications.onClicked.addListener(listener);
        });
    }

    async function showInstallSTGNotification() {
        await notify(browser.i18n.getMessage('needInstallSTGExtension'));
        browser.tabs.create({
            url: STG_HOME_PAGE,
        });
    }

    browser.browserAction.onClicked.addListener(function() {
        sendExternalMessage({
                openManageGroups: true,
            })
            .catch(showInstallSTGNotification);
    });

})()
