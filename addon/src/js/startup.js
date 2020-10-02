(function() {
    'use strict';

    const isBackgroundPage = window.location.pathname.includes('background');

    if (!isBackgroundPage) {
        const background = browser.extension.getBackgroundPage();

        if (background === null) {
            // current tab was opened not in default cookie container, reopen this tab
            browser.tabs.getCurrent()
                .then(async function(currentTab) {
                    if (DEFAULT_COOKIE_STORE_ID === currentTab.cookieStoreId) {
                        if (currentTab.pinned) {
                            window.setTimeout(window.location.reload.bind(window.location), 500);
                        } else {
                            window.alert('Cannot open this page, please contact the add-on developer with a screenshot of this window');
                        }
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

        window.browser.tabs = background.browser.tabs;
        window.browser.windows = background.browser.windows;
        window.browser.storage = background.browser.storage;
        window.browser.downloads = background.browser.downloads;
        window.browser.notifications = background.browser.notifications;
    }

    window.addonUrlPrefix = browser.extension.getURL('');
    window.manifest = browser.runtime.getManifest();
    window.noop = function() {};

})();
