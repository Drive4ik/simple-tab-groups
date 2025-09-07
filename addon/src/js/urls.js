
import './prefixed-storage.js';
import * as Constants from './constants.js';
import * as Tabs from './tabs.js';
import * as Windows from './windows.js';
import * as Storage from './storage.js';

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
}

export function openOptionsPage(section = 'general') {
    localStorage.create(Constants.MODULES.OPTIONS).section = section;

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
    const {openManageGroupsInTab} = await Storage.get('openManageGroupsInTab');

    if (openManageGroupsInTab) {
        await Tabs.createUrlOnce(MANAGE_TABS_URL);
    } else {
        const allPopupWindows = await loadPopupWindows(),
            win = allPopupWindows.find(win => win.tabs[0].url.startsWith(MANAGE_TABS_URL));

        if (win) {
            await Windows.setFocus(win.id);
        } else {
            const manageStorage = localStorage.create(Constants.MODULES.MANAGE);

            await Windows.createPopup(MANAGE_TABS_URL, {
                width: manageStorage.windowWidth ?? 1000,
                height: manageStorage.windowHeight ?? 700,
            });
        }
    }
}

export async function openDebugPage() {
    const allPopupWindows = await loadPopupWindows(),
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

export function setUrlSearchParams(url, params = {}, baseUrl = Constants.STG_BASE_URL) {
    const formatedUrl = formatUrl(...[url].flat());
    const urlObj = new URL(formatedUrl, baseUrl);

    for (const [key, value] of Object.entries(params)) {
        urlObj.searchParams.set(key, value);
    }

    return urlObj.href;
}

export function formatUrl(url, data = {}) {
    return url.replace(/\{(.+?)\}/g, (match, key) => {
        if (key.startsWith('/')) {
            const keyClear = key.slice(1);

            if ([null, '', undefined].includes(data[keyClear])) {
                return '';
            } else {
                return '/' + window.encodeURIComponent(data[keyClear]);
            }
        }

        return window.encodeURIComponent(data[key]);
    });
}
