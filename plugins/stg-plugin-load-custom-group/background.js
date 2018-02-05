(async function() {
    'use strict';

    const STG_ID = 'simple-tab-groups@drive4ik',
        STG_HOME_PAGE = 'https://addons.mozilla.org/firefox/addon/simple-tab-groups/',
        MANIFEST = browser.runtime.getManifest();

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

            setTimeout(() => !called && reject(), timer, id);

            browser.notifications.onClicked.addListener(listener);
        });
    }

    async function showInstallSTGNotification() {
        await notify(browser.i18n.getMessage('needInstallSTGExtension'));
        browser.tabs.create({
            url: STG_HOME_PAGE,
        });
    }

    async function showSelectGroupNotification() {
        await notify(browser.i18n.getMessage('needSelectGroup'));
        browser.runtime.openOptionsPage();
    }

    browser.runtime.onMessageExternal.addListener(async function(request, sender, sendResponse) {
        if (sender.id !== STG_ID) {
            return;
        }

        let { groupId } = await browser.storage.local.get('groupId');

        if (request.groupUpdated) {
            if (groupId && request.groupId === groupId) {
                updateBrowserAction(groupId);
            }
        } else if (request.IAmBack) {
            updateBrowserAction(groupId);
        }
    });

    async function updateBrowserAction(groupId) {
        try {
            if (groupId) {
                let responce = await sendExternalMessage({
                    getGroupExpandedData: {
                        groupId: groupId,
                    },
                });

                setBrowserAction(responce.group.title, responce.group.iconUrl);
                browser.storage.local.set({
                    groupId: groupId,
                });
            } else {
                throw new Error('No group id');
            }
        } catch (e) {
            setBrowserAction();
            browser.storage.local.remove('groupId');
            showSelectGroupNotification();
            throw e;
        }
    }

    function setBrowserAction(title, iconUrl) {
        if (!title && !iconUrl) {
            title = MANIFEST.browser_action.default_title;
            iconUrl = MANIFEST.browser_action.default_icon;
        }

        browser.browserAction.setTitle({
            title: title,
        });

        browser.browserAction.setIcon({
            path: iconUrl,
        });
    }

    browser.browserAction.onClicked.addListener(async function() {
        let { groupId } = await browser.storage.local.get('groupId');

        try {
            await sendExternalMessage({
                areYouHere: true,
            });

            if (!groupId) {
                return browser.runtime.openOptionsPage();
            }

            try {
                await sendExternalMessage({
                    runAction: {
                        id: 'load-custom-group',
                        groupId: groupId,
                    },
                });
            } catch (e) {
                browser.runtime.openOptionsPage();
            }
        } catch (e) {
            showInstallSTGNotification();
        }
    });

    sendExternalMessage({
            areYouHere: true,
        })
        .then(async function() {
            let { groupId } = await browser.storage.local.get('groupId');
            await updateBrowserAction(groupId);
        }, showInstallSTGNotification);

    window.sendExternalMessage = sendExternalMessage;
    window.updateBrowserAction = updateBrowserAction;

})()
