(async function() {
    'use strict';

    const STG_ID = 'simple-tab-groups@drive4ik',
        STG_HOME_PAGE = 'https://addons.mozilla.org/firefox/addon/simple-tab-groups/',
        TEMPORARY_CONTAINER = 'temporary-container';

    let windowContextualIdentity = {},
        icons = {};

    browser.runtime.onMessageExternal.addListener(function(request, sender, sendResponse) {
        if (sender.id !== STG_ID) {
            console.error(`Only STG support`);
            return;
        }

        if (['i-am-back', 'group-loaded', 'group-updated', 'group-removed'].includes(request.action)) {
            loadContextualIdentityGroupsAndUpdateBrowserAction();
        } else {
            throw Error(`unknown action: ${request.action}`);
        }
    });

    async function loadContextualIdentityGroupsAndUpdateBrowserAction() {
        let windows = await browser.windows.getAll({
                windowTypes: [browser.windows.WindowType.NORMAL],
            }),
            [{shortcut}] = await browser.commands.getAll();

        await Promise.all(windows.map(async function(win) {
            let {group} = await sendExternalMessage({
                action: 'get-current-group',
                windowId: win.id,
            });

            windowContextualIdentity[win.id] = group ? group.contextualIdentity : null;

            // update browser action
            let title = browser.i18n.getMessage('newTabTitle');

            if (windowContextualIdentity[win.id]) {
                title += ` [${windowContextualIdentity[win.id].name}]`;
            }

            if (shortcut) {
                title += ` (${shortcut})`;
            }

            browser.browserAction.setTitle({
                title: title,
                windowId: win.id,
            });

            browser.browserAction.setIcon({
                path: await getIcon(windowContextualIdentity[win.id]),
                windowId: win.id,
            });
        }));
    }

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
        let win = await browser.windows.getCurrent();

        if (windowContextualIdentity[win.id]) {
            if (TEMPORARY_CONTAINER === windowContextualIdentity[win.id].cookieStoreId) {
                try {
                    await sendExternalMessage({
                        action: 'create-temp-tab',
                    });
                } catch (e) {
                    notify(browser.i18n.getMessage('needInstallSTGExtension'), undefined, 'needInstallSTGExtension', function() {
                        browser.tabs.create({
                            url: STG_HOME_PAGE,
                        });
                    });
                }
            } else {
                browser.tabs.create({
                    active: true,
                    cookieStoreId: windowContextualIdentity[win.id].cookieStoreId,
                });
            }
        } else {
            browser.tabs.create({
                active: true,
            });
        }
    });

    // https://dxr.mozilla.org/mozilla-central/source/browser/components/contextualidentity/content
    async function getIcon(container) {
        if (!container) {
            return browser.extension.getURL('/icons/icon.svg');
        }

        let {icon, colorCode, cookieStoreId} = container,
            svg = icons[icon];

        if (!svg) {
            let request = await fetch(`/icons/${icon}.svg`);
            svg = icons[icon] = await request.text();
        }

        if (cookieStoreId !== TEMPORARY_CONTAINER) {
            svg = svg.replace('context-fill', colorCode);
        }

        return convertSvgToUrl(svg);
    }

    function convertSvgToUrl(svg) {
        return 'data:image/svg+xml;base64,' + b64EncodeUnicode(svg);
    }

    function b64EncodeUnicode(str) {
        // first we use encodeURIComponent to get percent-encoded UTF-8,
        // then we convert the percent encodings into raw bytes which
        // can be fed into btoa.
        return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g,
            function toSolidBytes(match, p1) {
                return String.fromCharCode('0x' + p1);
            }));
    }

    loadContextualIdentityGroupsAndUpdateBrowserAction();

})();
