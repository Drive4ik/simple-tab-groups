(async function() {
    'use strict';

    const STG_ID = 'simple-tab-groups@drive4ik',
        STG_HOME_PAGE = 'https://addons.mozilla.org/firefox/addon/simple-tab-groups/',
        DEFAULT_ICON_COLOR = '#a8a8a8';

    let options = await loadOptions();

    function loadOptions() {
        return browser.storage.local.get({
            loadLastGroup: false,
            browserActionIconColor: DEFAULT_ICON_COLOR,
        });
    }

    async function updateBrowserIcon(browserActionIconColor) {
        if (browserActionIconColor !== DEFAULT_ICON_COLOR) {
            let iconBlob = await fetch(browser.runtime.getManifest().browser_action.default_icon),
                iconSvg = await iconBlob.text();

            browser.browserAction.setIcon({
                path: convertSvgToUrl(iconSvg.replace(DEFAULT_ICON_COLOR, browserActionIconColor)),
            });
        }
    }

    updateBrowserIcon(options.browserActionIconColor);

    window.DEFAULT_ICON_COLOR = DEFAULT_ICON_COLOR;
    window.updateBrowserIcon = updateBrowserIcon;

    function convertSvgToUrl(svg) {
        return 'data:image/svg+xml;base64,' + b64EncodeUnicode(svg);
    }

    function b64EncodeUnicode(str) {
        return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g,
            function toSolidBytes(match, p1) {
                return String.fromCharCode('0x' + p1);
            }));
    }

    browser.notifications.onClicked.addListener(function() {
        browser.tabs.create({
            url: STG_HOME_PAGE,
        });
    });

    browser.browserAction.onClicked.addListener(async function() {
        browser.runtime.sendMessage(STG_ID, {
            runAction: {
                id: 'add-new-group',
            },
        }, function(responce) {
            if (responce && responce.ok) {
                if (options.loadLastGroup) {
                    browser.runtime.sendMessage(STG_ID, {
                        runAction: {
                            id: 'load-last-group',
                        },
                    });
                }
            } else {
                browser.notifications.create({
                    type: 'basic',
                    iconUrl: '/icons/icon.svg',
                    title: browser.i18n.getMessage('extensionName'),
                    message: browser.i18n.getMessage('needInstallSTGExtension'),
                });
            }
        });
    });

    browser.menus.create({
        id: 'create-new-group-and-load-it',
        title: browser.i18n.getMessage('createNewGroupAndLoadItTitle'),
        type: 'checkbox',
        contexts: ['browser_action'],
        checked: options.loadLastGroup,
        onclick: function(info) {
            browser.storage.local.set({
                loadLastGroup: options.loadLastGroup = info.checked,
            });
        },
    });

})()
