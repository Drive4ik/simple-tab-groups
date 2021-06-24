(function() {
    'use strict';

    const isBackgroundPage = window.location.pathname.includes('background');

    if (!isBackgroundPage) {
        if (browser.extension.inIncognitoContext) { // will never be on background, I believe...
            window.location.replace('/help/incognito.html');
            return;
        }

        const background = browser.extension.getBackgroundPage();

        if (background === null) {
            // current tab was opened not in default cookie container, reopen this tab
            browser.tabs.getCurrent()
                .then(async function(currentTab) {
                    if (DEFAULT_COOKIE_STORE_ID === currentTab.cookieStoreId) {
                        browser.runtime.onMessage.addListener(({action}) => 'i-am-back' === action && window.location.reload());
                    } else {
                        await browser.tabs.create({
                            url:  currentTab.url,
                            active: currentTab.active,
                            index: currentTab.index,
                            windowId: currentTab.windowId,
                        });

                        browser.tabs.remove(currentTab.id);
                    }
                });

            return;
        }

        window.BG = background.BG;

        window.console = background.console;
        window.cache = background.cache;
        window.containers = background.containers;
    }

    window.addonUrlPrefix = browser.runtime.getURL('');
    window.manifest = browser.runtime.getManifest();
    window.noop = function() {};

})();
