
import * as Constants from './constants.js';

const backgroundSelf = browser.extension.getBackgroundPage();

if (backgroundSelf) {
    self.BG = backgroundSelf.BG;
    self.cacheStorage = backgroundSelf.cacheStorage;
    self.sendMessage = backgroundSelf.sendMessage;
} else {
    // current tab was opened not in default cookie container, reopen this tab
    browser.tabs.getCurrent()
        .then(async currentTab => {
            if (Constants.DEFAULT_COOKIE_STORE_ID === currentTab.cookieStoreId) {
                // ! TODO RETEST IT
                browser.runtime.onMessage.addListener(({action}) => 'i-am-back' === action && window.location.reload());
            } else {
                await browser.tabs.create({
                    url: currentTab.url,
                    active: currentTab.active,
                    index: currentTab.index,
                    windowId: currentTab.windowId,
                });

                return browser.tabs.remove(currentTab.id);
            }
        })
        .catch(() => browser.tabs.create({url: self.location.href}))
        .catch(console.error.bind(console, 'no STG background page, cant reopen current'));
}
