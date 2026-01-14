
export const STG_ID = 'simple-tab-groups@drive4ik';
export const STG_HOME_PAGE = 'https://addons.mozilla.org/firefox/addon/simple-tab-groups/'

export const HOST = Object.freeze({
    NAME: 'simple_tab_groups_host',
    DOWNLOAD_URL: 'https://github.com/Drive4ik/simple-tab-groups/releases',
});

export const MANIFEST = Object.freeze(browser.runtime.getManifest());
export const BROWSER = await browser.runtime.getBrowserInfo();
export const PLATFORM = await browser.runtime.getPlatformInfo();

export const IS_WINDOWS = PLATFORM.os === browser.runtime.PlatformOs.WIN;

export const INTERVAL_KEY = Object.freeze({
    minutes: 'minutes',
    hours: 'hours',
    days: 'days',
});
