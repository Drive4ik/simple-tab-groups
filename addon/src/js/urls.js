
import * as Constants from './constants.js';
import * as Tabs from './tabs.js';
import * as Windows from './windows.js';

export const MANAGE_TABS_URL = getURL('/manage/manage.html');
export const HELP_PAGE_UNSUPPORTED_URL = getURL('stg-unsupported-url');

export function getURL(page) {
    return browser.runtime.getURL(Constants.STG_HELP_PAGES.includes(page) ? `/help/${page}.html` : page);
}

export async function openUrl(page, asWindow = false) {
    const url = getURL(page);

    if (asWindow) {
        return Windows.createPopup(url);
    }

    return browser.tabs.create({
        url,
        active: true,
        cookieStoreId: Constants.DEFAULT_COOKIE_STORE_ID,
    }).catch(() => {});
};

export function openOptionsPage() {
    return browser.runtime.openOptionsPage()
        .catch(self.logger?.onCatch('openOptionsPage', false))
        .catch(() => {});
}

function loadPopupWindows() {
    return browser.windows.getAll({
        windowTypes: [browser.windows.WindowType.POPUP],
        populate: true,
    });
}

export async function openManageGroups() {
    const {default: backgroundSelf} = await import('./background.js');

    if (backgroundSelf.options.openManageGroupsInTab) {
        await Tabs.createUrlOnce(MANAGE_TABS_URL);
    } else {
        let allPopupWindows = await loadPopupWindows(),
            win = allPopupWindows.find(win => win.tabs[0].url.startsWith(MANAGE_TABS_URL));

        if (win) {
            await Windows.setFocus(win.id);
        } else {
            await Windows.createPopup(MANAGE_TABS_URL, {
                width: Number(window.localStorage.manageGroupsWindowWidth) || 1000,
                height: Number(window.localStorage.manageGroupsWindowHeight) || 700,
            });
        }
    }
}

export async function openDebugPage() {
    let allPopupWindows = await loadPopupWindows(),
        debugPageUrl = getURL('stg-debug'),
        win = allPopupWindows.find(win => win.tabs[0].url.startsWith(debugPageUrl));

    if (win) {
        await Windows.setFocus(win.id);
    } else {
        await Windows.createPopup(debugPageUrl);
    }
}

export function openNotSupportedUrlHelper() {
    Tabs.createUrlOnce('https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/Content_scripts');
}
