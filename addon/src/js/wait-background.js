
import './prefixed-storage.js';
import * as Constants from './constants.js';
import * as Messages from './messages.js';

const mainStorage = localStorage.create(Constants.MODULES.BACKGROUND);

const {promise: waitBackgroundPromise, resolve: continueLoad} = Promise.withResolvers();

function reloadPageOnAddonReady() {
    if (mainStorage.inited) {
        continueLoad();
    } else {
        Messages.connectToBackground(`[${location.pathname} wait connecting]`, 'i-am-back', continueLoad);
    }
}

// a page in another container is reopened in the default one: there it has a localStorage and a BroadcastChannel of its own, not the add-on's (docs/BEHAVIOR-CREATE-TABS.md §19)
if (Constants.PAGES.isPopup || Constants.PAGES.isSidebar) {
    reloadPageOnAddonReady();
} else {
    const currentTab = await browser.tabs.getCurrent();

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

        await browser.tabs.remove(currentTab.id);
    }
}

await waitBackgroundPromise;
