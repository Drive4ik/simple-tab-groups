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

    async function notify(message, timer = 20000, id = null, iconUrl = null, onClick = null, onClose = null) {
        if (id) {
            await browser.notifications.clear(id);
        } else {
            id = String(Date.now());
        }

        // https://developer.mozilla.org/en-US/Add-ons/WebExtensions/API/notifications/NotificationOptions
        // Only 'type', 'iconUrl', 'title', and 'message' are supported.
        await browser.notifications.create(id, {
            type: 'basic',
            iconUrl: iconUrl || '/icons/icon.svg',
            title: browser.i18n.getMessage('extensionName'),
            message: String(message),
        });

        let rejectTimer = null,
            listener = function(id, calledId) {
                if (id !== calledId) {
                    return;
                }

                browser.notifications.onClicked.removeListener(listener);
                browser.notifications.onClosed.removeListener(onClosedListener);

                clearTimeout(rejectTimer);
                onClick && onClick(id);
            }.bind(null, id),
            onClosedListener = function(id, calledId, calledBy) {
                if (id !== calledId) {
                    return;
                }

                browser.notifications.onClicked.removeListener(listener);
                browser.notifications.onClosed.removeListener(onClosedListener);
                browser.notifications.clear(id);

                if (calledBy !== 'timeout') {
                    clearTimeout(rejectTimer);
                    onClose && onClose(id);
                }
            }.bind(null, id);

        rejectTimer = setTimeout(onClosedListener, timer, id, 'timeout');

        browser.notifications.onClicked.addListener(listener);
        browser.notifications.onClosed.addListener(onClosedListener);

        return id;
    }

    browser.browserAction.onClicked.addListener(async function() {
        try {
            await sendExternalMessage({
                active: true,
                action: 'create-temp-tab',
            });
        } catch (e) {
            notify(browser.i18n.getMessage('needInstallSTGExtension'), undefined, 'needInstallSTGExtension', function() {
                browser.tabs.create({
                    url: STG_HOME_PAGE,
                });
            });
        }
    });

})();
