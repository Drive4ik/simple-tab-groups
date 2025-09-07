
export let ON_INSTALLED_DETAILS = {};
browser.runtime.onInstalled.addListener(details => ON_INSTALLED_DETAILS = details); // need to be before any await

export const MANIFEST = Object.freeze(browser.runtime.getManifest());
export const STG_BASE_URL = browser.runtime.getURL('');
export const BROWSER = await browser.runtime.getBrowserInfo();

export const BROWSER_FULL_NAME = `${BROWSER?.name} ${BROWSER?.vendor}`;

export const IS_BACKGROUND_PAGE = self.location.pathname.includes('background');

export const IS_MAC = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase().includes('mac');

export const DEBUG = Object.freeze({
    MANUAL: 'manual',
    AUTO: 'auto',
});

export const ACTIVE_SYMBOL = '〇';
export const DISCARDED_SYMBOL = '✱';
export const STICKY_SYMBOL = '📌';

export const DEFAULT_COOKIE_STORE_ID_FIREFOX = 'firefox-default';
export const DEFAULT_COOKIE_STORE_ID = {
    'IceCat GNU': 'icecat-default',
}[BROWSER_FULL_NAME] ?? DEFAULT_COOKIE_STORE_ID_FIREFOX;

export const TEMPORARY_CONTAINER = 'temporary-container';
export const TEMPORARY_CONTAINER_ICON = 'chill';

export const CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP = 'stg-undo-remove-group-id-';

export const INTERVAL_KEY = Object.freeze({
    minutes: 'minutes',
    hours: 'hours',
    days: 'days',
});

export const STG_HELP_PAGES = Object.freeze([
    'welcome',
    'extensions-that-conflict-with-stg',
    'open-in-container',
    'how-to-github-gist',
    'stg-unsupported-url',
    'stg-debug',
    'db-error-reinstall',
]);

// permission "<all_urls>" need for tab thumbnails and webRequestBlocking
export const PERMISSIONS = Object.freeze({
    BOOKMARKS: {
        permissions: ['bookmarks'],
    },
});

const GROUP_ICON_VIEW_TYPES = {
    'main-squares': 'icon',
    'circle': 'circle',
    'squares': 'squares',
    'old-tab-groups': 'old-tab-groups',
    'title': 'text',
};
await Promise.all(Object.entries(GROUP_ICON_VIEW_TYPES).map(async ([key, icon]) => {
    GROUP_ICON_VIEW_TYPES[key] = await fetch(`/icons/${icon}.svg`).then(response => response.text());
}))
Object.freeze(GROUP_ICON_VIEW_TYPES);
export { GROUP_ICON_VIEW_TYPES };

export const DEFAULT_GROUP_ICON_VIEW_TYPE = Object.keys(GROUP_ICON_VIEW_TYPES)[0];

export const DEFAULT_BOOKMARKS_PARENTS = Object.freeze([
    'toolbar_____',
    'menu________',
    'unfiled_____',
]);

export const HOTKEY_ACTIONS = Object.freeze([
    'load-next-group',
    'load-prev-group',
    'load-next-unloaded-group',
    'load-prev-unloaded-group',
    'load-next-non-empty-group',
    'load-prev-non-empty-group',
    'load-history-next-group',
    'load-history-prev-group',
    'load-first-group',
    'load-last-group',
    'load-custom-group',
    'add-new-group',
    'rename-group',
    'delete-current-group',
    'open-manage-groups',
    'move-selected-tabs-to-custom-group',
    'discard-group',
    'discard-other-groups',
    'reload-all-tabs-in-current-group',
]);

export const HOTKEY_ACTIONS_WITH_CUSTOM_GROUP = Object.freeze([
    'load-custom-group',
    'move-selected-tabs-to-custom-group',
    'discard-group',
    'rename-group',
]);

export const POPUP_SETTINGS_MENU_ITEMS = Object.freeze([
    {
        key: 'showArchivedGroups',
        optionsCheckbox: true,
    }, {
        key: 'closePopupAfterChangeGroup',
        optionsCheckbox: true,
    }, {
        key: 'closePopupAfterSelectTab',
        optionsCheckbox: true,
    }, {
        key: 'openGroupAfterChange',
        optionsCheckbox: true,
    }, {
        key: 'showExtendGroupsPopupWithActiveTabs',
        optionsCheckbox: true,
    }, {
        key: 'fullPopupWidth',
        optionsCheckbox: true,
    }, {
        key: 'alwaysAskNewGroupName',
        optionsCheckbox: true,
    }, {
        key: 'hr',
    }, {
        key: 'syncCloudOptions',
        sendMessage: ['open-options-page', {
            section: 'backup sync',
        }],
        title: 'githubGistCloudSettingsTitle',
        icon: 'settings',
        closePopup: true,
    }, {
        key: 'hr',
    }, {
        key: 'aboutAddon',
        sendMessage: ['open-options-page', {
            section: 'about',
        }],
        title: 'aboutExtension',
        icon: 'info',
        closePopup: true,
    },
]);

export const TREE_TABS_EXTENSIONS = Object.freeze([
    'treestyletab@piro.sakura.ne.jp',
    '{8d808887-ed13-4931-9f5a-4c0bff979a5a}',
]);

export const CONFLICTED_EXTENSIONS_FOR_REOPEN_TAB_IN_CONTAINER = Object.freeze([
    '@testpilot-containers', // https://addons.mozilla.org/firefox/addon/multi-account-containers/
    '@contain-google', // https://addons.mozilla.org/firefox/addon/google-container/
    '@contain-facebook', // https://addons.mozilla.org/firefox/addon/facebook-container/
    '@contain-amzn', // https://addons.mozilla.org/firefox/addon/contain-amazon/
    '@contain-twitter', // https://addons.mozilla.org/firefox/addon/twitter-container/
    '@contain-youtube', // https://addons.mozilla.org/firefox/addon/youtube-container/
    '@containing-reddit', // https://addons.mozilla.org/firefox/addon/contain-reddit/
    'containerise@kinte.sh', // https://addons.mozilla.org/firefox/addon/containerise/
]);

export const CONFLICTED_EXTENSIONS = Object.freeze([
    'tab_open_close_control@felix-kolbe.de', // https://addons.mozilla.org/firefox/addon/tab-open-close-control/
    'extension@one-tab.com', // https://addons.mozilla.org/firefox/addon/onetab/
    '{dcdaadfa-21f1-4853-9b34-aad681fff6f3}', // https://addons.mozilla.org/firefox/addon/tiled-tab-groups/
    'panorama-tab-groups@example.com', // https://addons.mozilla.org/firefox/addon/panorama-tab-groups/
    '{60e27487-c779-464c-8698-ad481b718d5f}', // https://addons.mozilla.org/firefox/addon/panorama-view/
    'panorama@nyordanov.com', // https://addons.mozilla.org/firefox/addon/basic-panorama/
    'firefox-addon@workona.com', // https://addons.mozilla.org/firefox/addon/workona/
    'tab-stash@condordes.net', // https://addons.mozilla.org/firefox/addon/tab-stash/
    'tab-array@menhera.org', // https://addons.mozilla.org/firefox/addon/container-tab-groups/
    '{3c078156-979c-498b-8990-85f7987dd929}', // https://addons.mozilla.org/firefox/addon/sidebery/
    'tab_group_window@crossblade.her.jp', // https://addons.mozilla.org/firefox/addon/tab-group-window/
    'power-tabs@rapptz-addons.com', // https://addons.mozilla.org/firefox/addon/power-tabs/
    '{644e8eb0-c710-47e9-b81c-5dd69bfcf86b}', // https://addons.mozilla.org/firefox/addon/tabs-aside/
    'sync-tab-groups@eric.masseran', // Sync Tab Groups
    'Tab-Session-Manager@sienori', // https://addons.mozilla.org/firefox/addon/tab-session-manager/
]);

export const EXTENSIONS_WHITE_LIST = Object.freeze({
    'stg-plugin-create-new-group@drive4ik': {
        id: 932675,
        title: 'Create new group',
        url: 'https://addons.mozilla.org/firefox/addon/stg-plugin-create-new-group/',
        postActions: [],
        getActions: [
            'add-new-group',
            'load-last-group',
        ],
    },
    'stg-plugin-load-custom-group@drive4ik': {
        id: 932681,
        title: 'Load custom group',
        url: 'https://addons.mozilla.org/firefox/addon/stg-plugin-load-custom-group/',
        postActions: [
            'i-am-back',
            'group-added',
            'group-updated',
            'group-removed',
        ],
        getActions: [
            'are-you-here',
            'get-groups-list',
            'load-custom-group',
        ],
    },
    'stg-plugin-manage-groups@drive4ik': {
        id: 986719,
        title: 'Open Manage groups',
        url: 'https://addons.mozilla.org/firefox/addon/stg-plugin-manage-groups/',
        postActions: [],
        getActions: [
            'open-manage-groups',
        ],
    },
    'stg-plugin-del-current-group@drive4ik': {
        id: 1459086,
        title: 'Delete current group',
        url: 'https://addons.mozilla.org/firefox/addon/stg-plugin-del-current-group/',
        postActions: [],
        getActions: [
            'delete-current-group',
        ],
    },
    'stg-plugin-group-notes@drive4ik': {
        id: 2670858,
        title: 'Group notes',
        url: 'https://addons.mozilla.org/firefox/addon/stg-plugin-group-notes/',
        postActions: [
            'i-am-back',
            'group-loaded',
            'group-unloaded',
            'group-updated',
            'group-removed',
            'get-backup',
            'set-backup',
        ],
        getActions: [
            'get-groups-list',
        ],
    },
    'stg-plugin-create-new-tab@drive4ik': {
        id: 2609558,
        title: 'Create new tab',
        url: 'https://addons.mozilla.org/firefox/addon/stg-plugin-create-new-tab/',
        postActions: [
            'i-am-back',
            'group-loaded',
            'group-unloaded',
            'group-updated',
            'group-removed',
        ],
        getActions: [
            'create-temp-tab',
            'get-current-group',
        ],
    },
    'stg-plugin-create-temp-tab@drive4ik': {
        id: 2667177,
        title: 'Create new tab in temporary container',
        url: 'https://addons.mozilla.org/firefox/addon/stg-plugin-create-temp-tab/',
        postActions: [],
        getActions: [
            'create-temp-tab',
        ],
    },
    '{506e023c-7f2b-40a3-8066-bc5deb40aebe}': {
        title: 'Gesturefy',
        url: 'https://addons.mozilla.org/firefox/addon/gesturefy/',
        postActions: [],
        getActions: [
            'load-next-group',
            'load-prev-group',
            'load-next-unloaded-group',
            'load-prev-unloaded-group',
            'load-next-non-empty-group',
            'load-prev-non-empty-group',
            'load-history-next-group',
            'load-history-prev-group',
            'load-first-group',
            'load-last-group',
            'load-custom-group',
            'add-new-group',
            'rename-group',
            'delete-current-group',
            'open-manage-groups',
            'move-selected-tabs-to-custom-group',
            'discard-group',
            'discard-other-groups',
            'reload-all-tabs-in-current-group',
            'create-temp-tab',
            'create-backup',
        ],
    },
    'tridactyl.vim@cmcaine.co.uk': {
        title: 'Tridactyl',
        url: 'https://addons.mozilla.org/firefox/addon/tridactyl-vim/',
        postActions: [
            'i-am-back',
            'group-added',
            'group-updated',
            'group-removed',
        ],
        getActions: [
            'are-you-here',
            'get-current-group',
            'add-new-group',
            'rename-group',
            'load-next-group',
            'load-prev-group',
            'load-next-unloaded-group',
            'load-prev-unloaded-group',
            'load-next-non-empty-group',
            'load-prev-non-empty-group',
            'load-history-next-group',
            'load-history-prev-group',
            'load-first-group',
            'load-last-group',
            'load-custom-group',
            'get-groups-list',
            'delete-current-group',
            'open-manage-groups',
            'move-selected-tabs-to-custom-group',
            'discard-group',
            'discard-other-groups',
            'reload-all-tabs-in-current-group',
            'create-temp-tab',
            'create-backup',
        ],
    },
});

export const SAFE_EXTENSIONS_FOR_REOPEN_TAB_IN_CONTAINER = Object.freeze([
    ...Object.keys(EXTENSIONS_WHITE_LIST).filter(extId => extId.endsWith('@drive4ik')),

    'newtaboverride@agenedia.com', // https://addons.mozilla.org/firefox/addon/new-tab-override/
    'extension@tabliss.io', // https://addons.mozilla.org/firefox/addon/tabliss/
    'newtabtools@darktrojan.net', // https://addons.mozilla.org/firefox/addon/new-tab-tools/
    '{66E978CD-981F-47DF-AC42-E3CF417C1467}', // https://addons.mozilla.org/firefox/addon/new-tab-homepage/
    '{166411f2-402a-4bca-a3da-38b795ec8007}', // https://addons.mozilla.org/firefox/addon/renewed-tab/
]);

export const DONATE_ITEMS = Object.freeze({
    'paypal': {
        title: 'PayPal',
        link: 'https://www.paypal.com/donate/?hosted_button_id=E428H4972XMEW',
        linkText: 'drive4ik@protonmail.com',
        hasQr: true,
    },
    'bitcoin': {
        title: 'Bitcoin',
        wallet: 'bc1qkmpzhl96jegd60t5ym2s9wvsl5yqy3m6pu3kn5',
        hasQr: true,
    },
    'ethereum': {
        title: 'Ethereum',
        wallet: '0x90C056f99992484cDBb367f40315f63BC4D2092E',
        hasQr: true,
        hasHelp: true,
    },
    'bnb-smartchain': {
        title: 'BNB (Smart Chain)',
        wallet: '0x90C056f99992484cDBb367f40315f63BC4D2092E',
        hasQr: true,
        hasHelp: true,
    },
    'tron-usdt': {
        title: 'Tron USDT',
        wallet: 'TU84P6EUT94JWhQkjNwMvfSSiik1w9gnyr',
        hasQr: true,
        hasHelp: true,
    },
});

export const GIT_GIST_FILE_NAME_PARTS = Object.freeze({
    start: 'STG-',
    end: '.json',
});

export const DEFAULT_SYNC_OPTIONS = Object.freeze({
    version: MANIFEST.version,
    githubGistToken: '',
    githubGistFileName: GIT_GIST_FILE_NAME_PARTS.start + 'backup' + GIT_GIST_FILE_NAME_PARTS.end,
});

const BROWSER_HAS_FSYNC = [
    'Firefox Mozilla',
    'Zen Mozilla',
    'Floorp Mozilla',
    'Waterfox WaterfoxLimited',
    'r3dfox ESR Eclipse Community',
].includes(BROWSER_FULL_NAME);

export const IS_AVAILABLE_SYNC_STORAGE = browser.storage.sync instanceof Object && BROWSER_HAS_FSYNC;
export const SYNC_STORAGE_FSYNC = 'ff-sync';
export const SYNC_STORAGE_LOCAL = 'local';

export const DEFAULT_OPTIONS = Object.freeze({
    version: MANIFEST.version,
    groups: [],

    // options

    /* changed group keys with the exception: id, tabs */
    defaultGroupProps: {},

    closePopupAfterChangeGroup: true,
    closePopupAfterSelectTab: false,
    openGroupAfterChange: false,
    showArchivedGroups: true,
    alwaysAskNewGroupName: true,
    createNewGroupWhenOpenNewWindow: false,
    openManageGroupsInTab: true,
    showConfirmDialogBeforeGroupArchiving: true,
    showConfirmDialogBeforeGroupDelete: true,
    showNotificationAfterGroupDelete: true,
    showContextMenuOnTabs: true,
    showContextMenuOnLinks: true,
    defaultBookmarksParent: DEFAULT_BOOKMARKS_PARENTS[0],
    showExtendGroupsPopupWithActiveTabs: false,
    showTabsWithThumbnailsInManageGroups: false,
    fullPopupWidth: false,
    temporaryContainerTitle: browser.i18n.getMessage('temporaryContainerTitle'),

    contextMenuTab: [
        'open-in-new-window',
        'reload',
        'discard',
        'remove',
        'update-thumbnail',
        'set-group-icon',
        'move-tab-to-group',
    ],
    contextMenuGroup: [
        'open-in-new-window',
        'sort-asc',
        'sort-desc',
        'discard',
        'discard-other',
        'export-to-bookmarks',
        'unload',
        'archive',
        'rename',
        'reload-all-tabs',
    ],

    autoBackupEnable: true,
    autoBackupIntervalKey: INTERVAL_KEY.days, // minutes, hours, days
    autoBackupIntervalValue: 1,
    autoBackupIncludeTabThumbnails: true,
    autoBackupIncludeTabFavIcons: true,
    autoBackupFolderName: '',
    autoBackupByDayIndex: true,

    syncEnable: true,
    syncOptionsLocation: IS_AVAILABLE_SYNC_STORAGE ? SYNC_STORAGE_FSYNC : SYNC_STORAGE_LOCAL,
    syncLastUpdate: "1970-01-01T00:00:00Z",
    syncIntervalKey: INTERVAL_KEY.days, // hours, days
    syncIntervalValue: 1,
    syncTabFavIcons: false,

    theme: 'auto', // auto, light, dark

    hotkeys: [
        {
            value: `${IS_MAC ? 'Mac' : ''}Ctrl+Backquote`,
            action: 'load-next-group',
            groupId: null,
        }, {
            value: `${IS_MAC ? 'Mac' : ''}Ctrl+Shift+Backquote`,
            action: 'load-prev-group',
            groupId: null,
        },
    ],
});

const DEFAULT_OPTION_KEYS = Object.keys(DEFAULT_OPTIONS);

export const ONLY_BOOL_OPTION_KEYS = Object.freeze(DEFAULT_OPTION_KEYS.filter(key => 'boolean' === typeof DEFAULT_OPTIONS[key]));

export const NON_OPTION_KEYS = Object.freeze(['version', 'groups']);

export const ALL_OPTION_KEYS = Object.freeze(DEFAULT_OPTION_KEYS.filter(key => !NON_OPTION_KEYS.includes(key)));

export const ON_UPDATED_TAB_PROPERTIES = Object.freeze([ // browser.tabs not defined into web page scripts
    browser.tabs?.UpdatePropertyName.TITLE, // for cache
    browser.tabs?.UpdatePropertyName.STATUS, // for check update url and thumbnail
    // browser.tabs?.UpdatePropertyName.URL, // for check update url and thumbnail
    browser.tabs?.UpdatePropertyName.FAVICONURL, // for session
    browser.tabs?.UpdatePropertyName.HIDDEN,
    browser.tabs?.UpdatePropertyName.PINNED,
]);

export const MODULES = Object.freeze({
    BACKGROUND: 'Background',
    MANAGE: 'Manage',
    POPUP: 'Popup',
    SIDEBAR: 'Sidebar',
    OPTIONS: 'Options',
    GROUPS: 'Groups',
    BOOKMARKS: 'Bookmarks',
    MANAGEMENT: 'Management',
    CLOUD: 'Cloud',
    LOGGER: 'Logger',
});
