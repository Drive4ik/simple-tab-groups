'use strict';

const DEFAULT_COOKIE_STORE_ID = 'firefox-default',
    PRIVATE_COOKIE_STORE_ID = 'firefox-private',
    CONTEXT_MENU_PREFIX_GROUP = 'stg-move-group-id-',
    CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP = 'stg-undo-remove-group-id-',
    MANAGE_TABS_URL = '/manage/manage.html',
    EXTENSIONS_WHITE_LIST = {
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
    },
    DEFAULT_OPTIONS = {
        groups: [],
        lastCreatedGroupPosition: 0,
        browserActionIconColor: '#606060',
        version: '1.0',

        // options
        discardTabsAfterHide: false,
        closePopupAfterChangeGroup: true,
        openGroupAfterChange: true,
        showUrlTooltipOnTabHover: true,
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
                key: '~',
                keyCode: 192,
                action: {
                    id: 'load-prev-group',
                },
            },
        ],
    },
    onlyBoolOptionsKeys = (function() {
        return Object.keys(DEFAULT_OPTIONS).filter(key => 'boolean' === typeof DEFAULT_OPTIONS[key]);
    })(),
    allOptionsKeys = onlyBoolOptionsKeys.concat(['hotkeys', 'browserActionIconColor']);

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
};
