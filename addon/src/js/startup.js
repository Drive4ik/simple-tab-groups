(function() {
    'use strict';

    const isBackgroundPage = window.location.pathname.includes('background');

    if (!isBackgroundPage) {
        const background = browser.extension.getBackgroundPage();

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
