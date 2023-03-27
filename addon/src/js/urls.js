
import * as Constants from './constants.js';

// export {STG_BASE_URL, MANAGE_TABS_URL, STG_HELP_PAGES, IS_BACKGROUND_PAGE} from './constants.js';

export function getURL(url) {
    return browser.runtime.getURL(Constants.STG_HELP_PAGES.includes(url) ? `/help/${url}.html` : url);
}

export async function openUrl(url, asWindow = true) {
    if (asWindow) {
        return browser.windows.create({
            focused: true,
            type: browser.windows.CreateType.POPUP,
            state:  browser.windows.WindowState.MAXIMIZED,
            url,
        }).catch(() => {});
    }

    return browser.tabs.create({
        url,
        active: true,
    }).catch(() => {});
};

export function openHelp(page, asWindow) {
    return openUrl(getURL(page), asWindow);
}
