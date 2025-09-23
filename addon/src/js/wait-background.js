
import './prefixed-storage.js';
import * as Constants from './constants.js';
import * as Messages from './messages.js';
import backgroundSelf from './background.js';

const mainStorage = localStorage.create(Constants.MODULES.BACKGROUND);

let continueLoad;
const waitBackgroundPromise = new Promise(resolve => continueLoad = resolve);

function reloadPageOnAddonReady() {
    if (mainStorage.inited) {
        continueLoad();
    } else {
        Messages.connectToBackground(`[${location.pathname} wait connecting]`, 'i-am-back', continueLoad);
    }
}

if (backgroundSelf) {
    reloadPageOnAddonReady();
} else {
    // current tab was opened not in default cookie container, reopen this tab
    browser.tabs.getCurrent()
        .then(async currentTab => {
            if (currentTab.cookieStoreId === Constants.DEFAULT_COOKIE_STORE_ID) {
                reloadPageOnAddonReady();
            } else {
                await browser.tabs.create({
                    url: currentTab.url,
                    active: currentTab.active,
                    index: currentTab.index,
                    windowId: currentTab.windowId,
                    cookieStoreId: Constants.DEFAULT_COOKIE_STORE_ID,
                });

                return browser.tabs.remove(currentTab.id);
            }
        })
        // .catch(() => browser.tabs.create({url: self.location.href}))
        .catch(e => console.error('no STG background page, cant reopen current', e));
}

await waitBackgroundPromise;
