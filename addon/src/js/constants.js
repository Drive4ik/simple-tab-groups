'use strict';

const DEFAULT_COOKIE_STORE_ID = 'firefox-default';
const PRIVATE_COOKIE_STORE_ID = 'firefox-private';
const CONTEXT_MENU_PREFIX_GROUP = 'stg-move-group-id-';
const CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP = 'stg-undo-remove-group-id-';
const MANAGE_TABS_URL = '/manage/manage.html';

const groupIconViewTypes = [
    'main-squares',
    'circle',
    'squares',
    'old-tab-groups'
];

const EXTENSIONS_WHITE_LIST = {
    'stg-plugin-create-new-group@drive4ik': {
        allowedRequests: [
            'runAction',
        ],
        allowedActionIds: [
            'add-new-group',
            'load-last-group',
        ],
    },
    'stg-plugin-load-custom-group@drive4ik': {
        allowedRequests: [
            'runAction',
            'getGroupsList',
        ],
        allowedActionIds: [
            'load-custom-group',
        ],
    },
};

const DEFAULT_OPTIONS = {
    groups: [],
    lastCreatedGroupPosition: 0,
    browserActionIconColor: '#606060',
    defaultGroupIconViewType: groupIconViewTypes[0],
    version: '1.0',

    // options
    discardTabsAfterHide: false,
    closePopupAfterChangeGroup: true,
    openGroupAfterChange: true,
    showNotificationAfterMoveTab: true,
    openManageGroupsInTab: true,
    showConfirmDialogBeforeGroupDelete: true,
    useTabsFavIconsFromGoogleS2Converter: false,
    createThumbnailsForTabs: true,

    hotkeys: [
        {
            ctrlKey: true,
            shiftKey: false,
            altKey: false,
            metaKey: false,
            key: '`',
            keyCode: 192,
            action: {
                id: 'load-next-group',
            },
        },
        {
            ctrlKey: true,
            shiftKey: true,
            altKey: false,
            metaKey: false,
            key: '`',
            keyCode: 192,
            action: {
                id: 'load-prev-group',
            },
        },
    ],
};

const onlyBoolOptionsKeys = (function() {
    return Object.keys(DEFAULT_OPTIONS).filter(key => 'boolean' === typeof DEFAULT_OPTIONS[key]);
})();

const allOptionsKeys = onlyBoolOptionsKeys.concat(['hotkeys', 'browserActionIconColor', 'defaultGroupIconViewType']);

export {
    DEFAULT_COOKIE_STORE_ID,
    PRIVATE_COOKIE_STORE_ID,
    CONTEXT_MENU_PREFIX_GROUP,
    CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP,
    MANAGE_TABS_URL,
    EXTENSIONS_WHITE_LIST,
    DEFAULT_OPTIONS,
    onlyBoolOptionsKeys,
    allOptionsKeys,
    groupIconViewTypes,
};
