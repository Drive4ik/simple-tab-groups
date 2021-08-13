'use strict';

const MANAGE_TABS_URL = '/manage/manage.html';
const ACTIVE_SYMBOL = '〇';
const DISCARDED_SYMBOL = '✱';
const STICKY_SYMBOL = '📌';

const TEMPORARY_CONTAINER = 'temporary-container';
const DEFAULT_COOKIE_STORE_ID = 'firefox-default';

const CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP = 'stg-undo-remove-group-id-';

const AUTO_BACKUP_INTERVAL_KEY = Object.freeze({
    minutes: 'minutes',
    hours: 'hours',
    days: 'days',
});

// permission "<all_urls>" need for tab thumbnails and webRequestBlocking
const PERMISSIONS = Object.freeze({
    BOOKMARKS: {
        permissions: ['bookmarks'],
    },
});

const GROUP_ICON_VIEW_TYPES = Object.freeze([
    'main-squares',
    'circle',
    'squares',
    'old-tab-groups',
    'title',
]);

const DEFAULT_BOOKMARKS_PARENTS = Object.freeze([
    'toolbar_____',
    'menu________',
    'unfiled_____',
]);

const TREE_TABS_EXTENSIONS = Object.freeze([
    'treestyletab@piro.sakura.ne.jp',
    '{8d808887-ed13-4931-9f5a-4c0bff979a5a}',
]);

const EXTENSIONS_WHITE_LIST = Object.freeze({
    'stg-plugin-create-new-group@drive4ik': {
        title: '[STG plugin] Create new group',
        url: 'https://addons.mozilla.org/firefox/addon/stg-plugin-create-new-group/',
        postActions: [],
        getActions: [
            'add-new-group',
            'load-last-group',
        ],
    },
    'stg-plugin-load-custom-group@drive4ik': {
        title: '[STG plugin] Load custom group',
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
        title: '[STG plugin] Open Manage groups',
        url: 'https://addons.mozilla.org/firefox/addon/stg-plugin-open-manage-groups/',
        postActions: [],
        getActions: [
            'open-manage-groups',
        ],
    },
    'stg-plugin-del-current-group@drive4ik': {
        title: '[STG plugin] Delete current group',
        url: 'https://addons.mozilla.org/firefox/addon/stg-plugin-del-current-group/',
        postActions: [],
        getActions: [
            'delete-current-group',
        ],
    },
    'stg-plugin-group-notes@drive4ik': {
        title: '[STG plugin] Group notes',
        url: 'https://addons.mozilla.org/firefox/addon/stg-plugin-group-notes/',
        postActions: [
            'i-am-back',
            'group-loaded',
            'group-unloaded',
            'group-updated',
            'group-removed',
        ],
        getActions: [
            'get-groups-list',
        ],
    },
    'stg-plugin-create-new-tab@drive4ik': {
        title: '[STG plugin] Create new tab',
        url: 'https://addons.mozilla.org/firefox/addon/stg-plugin-create-new-tab/',
        postActions: [
            'i-am-back',
            'group-loaded',
            'group-updated',
            'group-removed',
        ],
        getActions: [
            'create-temp-tab',
            'get-current-group',
        ],
    },
    'stg-plugin-create-temp-tab@drive4ik': {
        title: '[STG plugin] Create new tab in temporary container',
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
            'add-new-group',
            'rename-group',
            'load-next-group',
            'load-prev-group',
            'load-next-unloaded-group',
            'load-prev-unloaded-group',
            'load-history-next-group',
            'load-history-prev-group',
            'load-first-group',
            'load-last-group',
            'load-custom-group',
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

const DEFAULT_OPTIONS = Object.freeze({
    version: '1.0',
    groups: [],
    lastCreatedGroupPosition: 0,

    // options
    discardTabsAfterHide: false,
    closePopupAfterChangeGroup: true,
    openGroupAfterChange: false,
    alwaysAskNewGroupName: true,
    prependGroupTitleToWindowTitle: false,
    createNewGroupWhenOpenNewWindow: false,
    showNotificationAfterMoveTab: true,
    openManageGroupsInTab: true,
    showConfirmDialogBeforeGroupArchiving: true,
    showConfirmDialogBeforeGroupDelete: true,
    showNotificationAfterGroupDelete: true,
    showContextMenuOnTabs: true,
    showContextMenuOnLinks: true,
    exportGroupToMainBookmarkFolder: true,
    defaultBookmarksParent: DEFAULT_BOOKMARKS_PARENTS[0],
    leaveBookmarksOfClosedTabs: false,
    showExtendGroupsPopupWithActiveTabs: false,
    showTabsWithThumbnailsInManageGroups: false,
    fullPopupWidth: false,
    temporaryContainerTitle: browser.i18n.getMessage('temporaryContainerTitle'),

    defaultGroupIconViewType: GROUP_ICON_VIEW_TYPES[0],
    defaultGroupIconColor: '',

    autoBackupEnable: true,
    autoBackupLastBackupTimeStamp: 1,
    autoBackupIntervalKey: AUTO_BACKUP_INTERVAL_KEY.days, // minutes, hours, days
    autoBackupIntervalValue: 1,
    autoBackupIncludeTabThumbnails: true,
    autoBackupIncludeTabFavIcons: true,
    autoBackupGroupsToBookmarks: true,
    autoBackupGroupsToFile: true,
    autoBackupFolderName: '',
    autoBackupBookmarksFolderName: 'STG bookmarks',
    autoBackupByDayIndex: false,

    enableDarkTheme: false,

    hotkeys: [
        {
            ctrlKey: true,
            shiftKey: false,
            altKey: false,
            metaKey: false,
            key: '`',
            keyCode: 192,
            action: 'load-next-group',
            groupId: 0,
        },
        {
            ctrlKey: true,
            shiftKey: true,
            altKey: false,
            metaKey: false,
            key: '`',
            keyCode: 192,
            action: 'load-prev-group',
            groupId: 0,
        },
    ],
});

const ONLY_BOOL_OPTION_KEYS = Object.freeze(Object.keys(DEFAULT_OPTIONS).filter(key => 'boolean' === typeof DEFAULT_OPTIONS[key]));

const ALL_OPTIONS_KEYS = Object.freeze([
    ...ONLY_BOOL_OPTION_KEYS,
    'temporaryContainerTitle',
    'hotkeys',
    'defaultBookmarksParent',
    'defaultGroupIconViewType',
    'defaultGroupIconColor',
    'autoBackupLastBackupTimeStamp',
    'autoBackupIntervalKey',
    'autoBackupIntervalValue',
    'autoBackupFolderName',
    'autoBackupBookmarksFolderName',
]);

const MINUTE_SEC = 60;
const HOUR_SEC = 60 * MINUTE_SEC;
const DAY_SEC = 24 * HOUR_SEC;
