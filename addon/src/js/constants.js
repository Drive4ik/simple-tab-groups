'use strict';

const DEFAULT_COOKIE_STORE_ID = 'firefox-default';
const PRIVATE_COOKIE_STORE_ID = 'firefox-private';
const CONTEXT_MENU_PREFIX_GROUP = 'stg-move-group-id-';
const CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP = 'stg-undo-remove-group-id-';
const MANAGE_TABS_URL = '/manage/manage.html';
const BACKUP_FOLDER = 'STG-backups/';

const groupIconViewTypes = [
    'main-squares',
    'circle',
    'squares',
    'old-tab-groups'
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
    createNewGroupWhenOpenNewWindow: false,
    showNotificationAfterMoveTab: true,
    openManageGroupsInTab: true,
    showConfirmDialogBeforeGroupDelete: true,
    useTabsFavIconsFromGoogleS2Converter: false,
    createThumbnailsForTabs: true,

    defaultGroupIconViewType: groupIconViewTypes[0],

    autoBackupEnable: true,
    autoBackupLastBackupTimeStamp: 1,
    autoBackupIntervalKey: 'days', // days, hours
    autoBackupIntervalValue: 1,
    autoBackupIncludeTabThumbnails: true,
    autoBackupIncludeTabFavIcons: true,

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
        },
        {
            ctrlKey: true,
            shiftKey: true,
            altKey: false,
            metaKey: false,
            key: '`',
            keyCode: 192,
            action: 'load-prev-group',
        },
    ],
};

const onlyBoolOptionsKeys = Object.keys(DEFAULT_OPTIONS).filter(key => 'boolean' === typeof DEFAULT_OPTIONS[key]);

const allOptionsKeys = onlyBoolOptionsKeys
    .concat([
        'hotkeys',
        'defaultGroupIconViewType',
        'autoBackupLastBackupTimeStamp',
        'autoBackupIntervalKey',
        'autoBackupIntervalValue'
    ]);

const HOUR_SEC = 60 * 60;
const DAY_SEC = 24 * HOUR_SEC;

export {
    DEFAULT_COOKIE_STORE_ID,
    PRIVATE_COOKIE_STORE_ID,
    CONTEXT_MENU_PREFIX_GROUP,
    CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP,
    MANAGE_TABS_URL,
    BACKUP_FOLDER,
    EXTENSIONS_WHITE_LIST,
    DEFAULT_OPTIONS,
    onlyBoolOptionsKeys,
    allOptionsKeys,
    groupIconViewTypes,
    HOUR_SEC,
    DAY_SEC,
};
