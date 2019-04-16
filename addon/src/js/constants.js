'use strict';

const DEFAULT_COOKIE_STORE_ID = 'firefox-default';
const PRIVATE_COOKIE_STORE_ID = 'firefox-private';
const MANAGE_TABS_URL = '/manage/manage.html';

const PERMISSIONS = {
    BOOKMARKS: {
        permissions: ['bookmarks'],
    },
    ALL_URLS: {
        origins: ['<all_urls>'],
    },
};

const groupIconViewTypes = [
    'main-squares',
    'circle',
    'squares',
    'old-tab-groups'
];

const defaultBookmarksParents = [
    'toolbar_____',
    'menu________',
    'unfiled_____',
];

const EXTENSIONS_WHITE_LIST = {
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
    '{506e023c-7f2b-40a3-8066-bc5deb40aebe}': {
        title: 'Gesturefy',
        url: 'https://addons.mozilla.org/firefox/addon/gesturefy/',
        postActions: [],
        getActions: [
            'add-new-group',
            'load-first-group',
            'load-last-group',
            'load-next-group',
            'load-prev-group',
            'load-custom-group',
            'delete-current-group',
            'open-manage-groups',
            'move-active-tab-to-custom-group',
        ],
    },
};

const DEFAULT_OPTIONS = {
    version: '1.0',
    groups: [],
    lastCreatedGroupPosition: 0,
    thumbnails: {},

    // options
    discardTabsAfterHide: false,
    closePopupAfterChangeGroup: true,
    openGroupAfterChange: true,
    prependGroupTitleToWindowTitle: false,
    createNewGroupWhenOpenNewWindow: false,
    showNotificationAfterMoveTab: true,
    openManageGroupsInTab: true,
    showConfirmDialogBeforeGroupDelete: true,
    useTabsFavIconsFromGoogleS2Converter: false,
    showContextMenuOnTabs: true,
    showContextMenuOnLinks: true,
    exportGroupToMainBookmarkFolder: true,
    defaultBookmarksParent: defaultBookmarksParents[0],

    defaultGroupIconViewType: groupIconViewTypes[0],
    defaultGroupIconColor: '',

    autoBackupEnable: true,
    autoBackupLastBackupTimeStamp: 1,
    autoBackupIntervalKey: 'days', // days, hours
    autoBackupIntervalValue: 1,
    autoBackupIncludeTabThumbnails: true,
    autoBackupIncludeTabFavIcons: true,
    autoBackupGroupsToBookmarks: true,
    autoBackupFolderName: 'STG-backups',

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
};

const onlyBoolOptionsKeys = Object.keys(DEFAULT_OPTIONS).filter(key => 'boolean' === typeof DEFAULT_OPTIONS[key]);

const allOptionsKeys = onlyBoolOptionsKeys
    .concat([
        'hotkeys',
        'defaultBookmarksParent',
        'defaultGroupIconViewType',
        'defaultGroupIconColor',
        'autoBackupLastBackupTimeStamp',
        'autoBackupIntervalKey',
        'autoBackupIntervalValue',
        'autoBackupFolderName',
    ]);

const HOUR_SEC = 60 * 60;
const DAY_SEC = 24 * HOUR_SEC;

export {
    DEFAULT_COOKIE_STORE_ID,
    PRIVATE_COOKIE_STORE_ID,
    MANAGE_TABS_URL,
    EXTENSIONS_WHITE_LIST,
    DEFAULT_OPTIONS,
    onlyBoolOptionsKeys,
    allOptionsKeys,
    groupIconViewTypes,
    defaultBookmarksParents,
    HOUR_SEC,
    DAY_SEC,
    PERMISSIONS,
};
