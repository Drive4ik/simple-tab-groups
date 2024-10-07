<script>
    'use strict';

    import Vue from 'vue';

    import popup from '../components/popup.vue';
    import editGroup from '../components/edit-group.vue';
    import manageAddonBackup from './manage-addon-backup';

    import * as Constants from '/js/constants.js';
    import Messages from '/js/messages.js';
    import Logger from '/js/logger.js';
    import * as Utils from '/js/utils.js';
    import * as Storage from '/js/storage.js';
    import * as File from '/js/file.js';
    import * as Urls from '/js/urls.js';
    import * as Groups from '/js/groups.js';
    import {isValidHotkeyEvent, isValidHotkeyValue, eventToHotkeyValue} from '/js/hotkeys.js';
    import JSON from '/js/json.js';

    import defaultGroupMixin from '/js/mixins/default-group.mixin.js';

    window.logger = new Logger('Options');

    Vue.config.errorHandler = errorEventHandler.bind(window.logger);

    const SECTION_GENERAL = 'general',
        SECTION_HOTKEYS = 'hotkeys',
        SECTION_BACKUP = 'backup',
        folderNameRegExp = /[\<\>\:\"\/\\\|\?\*\x00-\x1F]|^(?:aux|con|nul|prn|com\d|lpt\d)$|^\.+|\.+$/gi;

    document.title = browser.i18n.getMessage('openSettings');

    export default {
        name: 'options-page',
        mixins: [defaultGroupMixin],
        data() {
            this.HOTKEY_ACTIONS = Constants.HOTKEY_ACTIONS;
            this.HOTKEY_ACTIONS_WITH_CUSTOM_GROUP = Constants.HOTKEY_ACTIONS_WITH_CUSTOM_GROUP;
            this.GROUP_ICON_VIEW_TYPES = Constants.GROUP_ICON_VIEW_TYPES;
            this.AUTO_BACKUP_INTERVAL_KEY = Constants.AUTO_BACKUP_INTERVAL_KEY;

            this.SECTION_GENERAL = SECTION_GENERAL;
            this.SECTION_HOTKEYS = SECTION_HOTKEYS;
            this.SECTION_BACKUP = SECTION_BACKUP;

            return {
                section: window.localStorage.optionsSection || SECTION_GENERAL,

                contextMenuTabTitles: {
                    'open-in-new-window': {
                        title: 'openGroupInNewWindow',
                        icon: 'window-new',
                    },
                    'reload': {
                        title: 'reloadTab',
                        icon: 'refresh',
                    },
                    'discard': {
                        title: 'discardTabTitle',
                        icon: 'snowflake',
                    },
                    'remove': {
                        title: 'deleteTab',
                        icon: 'close',
                    },
                    'update-thumbnail': {
                        title: 'updateTabThumbnail',
                        icon: 'image',
                    },
                    'set-group-icon': {
                        title: 'setTabIconAsGroupIcon',
                        icon: 'image',
                    },
                    'hr': null,
                    'move-tab-to-group': {
                        title: 'moveTabToGroupDisabledTitle',
                        icon: '',
                    },
                },

                contextMenuGroupTitles: {
                    'open-in-new-window': {
                        title: 'openGroupInNewWindow',
                        icon: 'window-new',
                    },
                    'sort-asc': {
                        title: 'sortGroupsAZ',
                        icon: 'sort-alpha-asc',
                    },
                    'sort-desc': {
                        title: 'sortGroupsZA',
                        icon: 'sort-alpha-desc',
                    },
                    'discard': {
                        title: 'hotkeyActionTitleDiscardGroup',
                        icon: 'snowflake',
                    },
                    'discard-other': {
                        title: 'hotkeyActionTitleDiscardOtherGroups',
                        icon: 'snowflake',
                    },
                    'export-to-bookmarks': {
                        title: 'exportGroupToBookmarks',
                        icon: 'bookmark',
                    },
                    'unload': {
                        title: 'unloadGroup',
                        icon: 'upload',
                    },
                    'archive': {
                        title: 'archiveGroup',
                        icon: 'archive',
                    },
                    'rename': {
                        title: 'hotkeyActionTitleRenameGroup',
                        icon: 'edit',
                    },
                    'hr': null,
                    'reload-all-tabs': {
                        title: 'reloadAllTabsInGroup',
                        icon: 'refresh',
                    },
                },

                includeTabThumbnailsIntoBackup: false,
                includeTabFavIconsIntoBackup: true,

                options: {},
                groups: [],

                manageAddonSettings: null,
                manageAddonSettingsTitle: '',
                manageAddonSettingsDisableEmptyGroups: false,
                manageAddonSettingsAllowClearAddonDataBeforeRestore: false,

                permissions: {
                    bookmarks: false,
                },

                defaultBookmarksParents: [],

                showLoadingMessage: false,

                showClearAddonConfirmPopup: false,
            };
        },
        components: {
            popup: popup,
            'edit-group': editGroup,
            'manage-addon-backup': manageAddonBackup,
        },
        async created() {
            const data = await Storage.get();

            const options = Utils.assignKeys({}, data, Constants.ALL_OPTIONS_KEYS);

            options.autoBackupFolderName = await File.getAutoBackupFolderName();

            this.permissions.bookmarks = await browser.permissions.contains(Constants.PERMISSIONS.BOOKMARKS);

            this.groups = data.groups; // set before for watch hotkeys
            this.options = options;

            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.updateTheme());

            this.loadBookmarksParents();

            [
                ...Constants.ONLY_BOOL_OPTION_KEYS,
                'defaultBookmarksParent',
                'autoBackupIntervalKey',
                'theme',
                'contextMenuTab',
                'contextMenuGroup',
                ]
                .forEach(option => {
                    this.$watch(`options.${option}`, function(value, oldValue) {
                        if (null == oldValue) {
                            return;
                        }

                        Messages.sendMessageModule('BG.saveOptions', {
                            [option]: value,
                        });
                    });
                });
        },
        watch: {
            section(section) {
                window.localStorage.optionsSection = section;
            },
            'options.autoBackupFolderName': function(value, oldValue) {
                if (null == oldValue) {
                    return;
                }

                while (folderNameRegExp.exec(value)) {
                    value = value.replace(folderNameRegExp, '').trim();
                }

                if (value.length > 200) {
                    value = '';
                }

                Messages.sendMessageModule('BG.saveOptions', {
                    autoBackupFolderName: value,
                });
            },
            'options.autoBackupIntervalValue': function(value, oldValue) {
                if (!value || null == oldValue) {
                    return;
                }

                if (
                    value < 1 ||
                    (Constants.AUTO_BACKUP_INTERVAL_KEY.minutes === this.options.autoBackupIntervalKey && value > 59) ||
                    (Constants.AUTO_BACKUP_INTERVAL_KEY.hours === this.options.autoBackupIntervalKey && value > 24) ||
                    (Constants.AUTO_BACKUP_INTERVAL_KEY.days === this.options.autoBackupIntervalKey && value > 30)
                    ) {
                    value = 1;
                }

                Messages.sendMessageModule('BG.saveOptions', {
                    autoBackupIntervalValue: value,
                });
            },
            'options.theme': 'updateTheme',
            'options.temporaryContainerTitle': function(temporaryContainerTitle, oldValue) {
                if (!temporaryContainerTitle || null == oldValue) {
                    return;
                }

                Messages.sendMessageModule('BG.saveOptions', {
                    temporaryContainerTitle,
                });
            },
            'options.hotkeys': {
                handler(hotkeys, oldValue) {
                    hotkeys = hotkeys.filter((hotkey, index, self) => {
                        return self.findIndex(h => h.value === hotkey.value) === index;
                    });

                    const hotheysIsValid = hotkeys.every(hotkey => hotkey.action && isValidHotkeyValue(hotkey.value));

                    if (hotheysIsValid && oldValue) {
                        Messages.sendMessageModule('BG.saveOptions', {hotkeys});
                    }
                },
                deep: true,
            },
            'options.showTabsWithThumbnailsInManageGroups': function(value, oldValue) {
                if (null == oldValue) {
                    return;
                }

                if (!value) {
                    this.includeTabThumbnailsIntoBackup = this.options.autoBackupIncludeTabThumbnails = false;
                }
            },
        },
        computed: {
            showEnableDarkThemeNotification() {
                return Utils.getThemeApply(this.options.theme) === 'dark';
            },
            groupIds() {
                return this.groups.map(group => group.id);
            },
        },
        methods: {
            lang: browser.i18n.getMessage,
            getHotkeyActionTitle: action => browser.i18n.getMessage('hotkeyActionTitle' + Utils.capitalize(Utils.toCamelCase(action))),

            updateTheme() {
                document.documentElement.dataset.theme = Utils.getThemeApply(this.options.theme);
            },

            openBackupFolder: File.openBackupFolder,
            getGroupTitle: Groups.getTitle,

            hasEqualHotkeys(hotkey) {
                return this.options.hotkeys.filter(h => h.value && h.value === hotkey.value).length > 1;
            },

            getHotkeyParentNode(event) {
                return event.target.closest('.control');
            },

            onBlurHotkey(event) {
                const inputParent = this.getHotkeyParentNode(event);

                inputParent.classList.remove('key-success');
            },

            saveHotkeyKeyCodeAndStopEvent(hotkey, event, withKeyCode) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();

                const inputParent = this.getHotkeyParentNode(event);

                if (isValidHotkeyEvent(event)) {
                    inputParent.classList.add('key-success');
                    inputParent.classList.remove('key-error');
                } else {
                    inputParent.classList.add('key-error');
                    inputParent.classList.remove('key-success');
                }

                hotkey.value = eventToHotkeyValue(event);
            },

            setManageAddonSettings(data, popupTitle, disableEmptyGroups = false, allowClearAddonDataBeforeRestore = false) {
                this.manageAddonSettingsTitle = popupTitle;
                this.manageAddonSettingsDisableEmptyGroups = disableEmptyGroups;
                this.manageAddonSettingsAllowClearAddonDataBeforeRestore = allowClearAddonDataBeforeRestore;
                this.manageAddonSettings = data;
            },

            saveManagedAddonSettings(data, clearAddonDataBeforeRestore) {
                let clearAddonData = false;

                if (this.manageAddonSettingsAllowClearAddonDataBeforeRestore && clearAddonDataBeforeRestore) {
                    clearAddonData = true;
                }

                this.manageAddonSettings = null;

                this.showLoadingMessage = true;

                Messages.sendMessageModule('BG.restoreBackup', data, clearAddonData);
            },

            exportAddonSettings() {
                Messages.sendMessage('create-backup', {
                    includeTabFavIcons: this.includeTabFavIconsIntoBackup,
                    includeTabThumbnails: this.includeTabThumbnailsIntoBackup,
                });
            },

            async importAddonSettings() {
                let data = null;

                try {
                    data = await File.load();
                } catch (e) {
                    Utils.notify(e);
                    return;
                }

                if ('object' !== Utils.type(data) || !Array.isArray(data.groups) || !Number.isSafeInteger(data.lastCreatedGroupPosition)) {
                    Utils.notify('This is wrong backup!');
                    return;
                }

                const resultMigrate = await Messages.sendMessageModule('BG.runMigrateForData', data);

                if (resultMigrate.migrated) {
                    data = resultMigrate.data;
                } else if (resultMigrate.error) {
                    Utils.notify(resultMigrate.error);
                    return;
                }

                this.setManageAddonSettings(data, 'importAddonSettingsTitle', false, true);
            },

            async importSettingsOldTabGroupsAddonButton() {
                let oldOptions = null;

                try {
                    oldOptions = await File.load();
                } catch (e) {
                    Utils.notify(e);
                    return;
                }

                if (!oldOptions || !Array.isArray(oldOptions.windows) || !oldOptions.session) {
                    Utils.notify('This is not "Tab Groups" backup!');
                    return;
                }

                let data = {
                    groups: [],
                    pinnedTabs: [],
                };

                oldOptions.windows.forEach(function(win) {
                    let oldGroups = {},
                        groups = {};

                    try {
                        oldGroups = JSON.parse(win.extData['tabview-group']);
                    } catch (e) {
                        Utils.notify('Error: cannot parse backup file - ' + e);
                        return;
                    }

                    Object.values(oldGroups).forEach(function({id, title, catchRules}) {
                        groups[id] = {
                            title: Groups.createTitle(title, id),
                            tabs: [],
                            catchTabRules: catchRules || '',
                        };
                    });

                    win.tabs.forEach(function(oldTab) {
                        let tabData = {},
                            tab = oldTab.entries.pop();

                        tab = Utils.normalizeTabUrl(tab);

                        if (!Utils.isUrlAllowToCreate(tab.url)) {
                            return;
                        }

                        if (oldTab.pinned) {
                            data.pinnedTabs.push({
                                title: tab.title,
                                url: tab.url,
                                pinned: true,
                            });
                            return;
                        }

                        try {
                            tabData = JSON.parse(oldTab.extData['tabview-tab']);
                            if (!tabData || !tabData.groupID) {
                                return;
                            }
                        } catch (e) {
                            return Utils.notify('Cannot parse groups: ' + e);
                        }

                        if (groups[tabData.groupID]) {
                            groups[tabData.groupID].tabs.push({
                                title: tab.title,
                                url: tab.url,
                                groupId: groups[tabData.groupID].id,
                            });
                        }
                    });

                    data.groups.push(...Object.values(groups));
                });

                this.setManageAddonSettings(data, 'importSettingsOldTabGroupsAddonTitle');
            },

            async importSettingsPanoramaViewAddonButton() {
                let panoramaOptions = null;

                try {
                    panoramaOptions = await File.load();
                } catch (e) {
                    Utils.notify(e);
                    return;
                }

                if (!panoramaOptions || !panoramaOptions.file || 'panoramaView' !== panoramaOptions.file.type || !Array.isArray(panoramaOptions.windows)) {
                    Utils.notify('This is not "Panorama View" backup!');
                    return;
                }

                let data = {
                    groups: [],
                    pinnedTabs: [],
                };

                if (panoramaOptions.file.version === 1) {
                    panoramaOptions.windows.forEach(function(win) {
                        let groups = {};

                        win.groups.forEach(function({id, name}) {
                            groups[id] = {
                                title: Groups.createTitle(name, id),
                                tabs: [],
                            };
                        });

                        win.tabs.forEach(function({url, title, pinned, groupId}) {
                            url = Utils.normalizeUrl(url);

                            if (Utils.isUrlAllowToCreate(url)) {
                                if (pinned) {
                                    data.pinnedTabs.push({url, title, pinned});
                                } else if (groups[groupId]) {
                                    groups[groupId].tabs.push({url, title});
                                }
                            }
                        });

                        data.groups.push(...Object.values(groups));
                    });
                } else if (panoramaOptions.file.version === 2) {
                    panoramaOptions.windows.forEach(function(win) {
                        win.tabGroups?.forEach(function({title, tabs}) {
                            let groupTabs = [];

                            tabs.forEach(function({url, title}) {
                                url = Utils.normalizeUrl(url);

                                if (Utils.isUrlAllowToCreate(url)) {
                                    groupTabs.push({url, title});
                                }
                            });

                            if (groupTabs.length) {
                                data.groups.push({
                                    title: Groups.createTitle(title, groupTabs.length),
                                    tabs: groupTabs,
                                });
                            }
                        });

                        win.pinnedTabs?.forEach(function({url, title}) {
                            url = Utils.normalizeUrl(url);

                            if (Utils.isUrlAllowToCreate(url)) {
                                data.pinnedTabs.push({url, title});
                            }
                        });
                    });
                } else {
                    Utils.notify('"Panorama View" backup has unsupported version');
                    return;
                }

                this.setManageAddonSettings(data, 'importSettingsPanoramaViewAddonTitle', true);
            },

            async importSettingsSyncTabGroupsAddonButton() {
                let syncTabOptions = null;

                try {
                    syncTabOptions = await File.load();
                } catch (e) {
                    Utils.notify(e);
                    return;
                }

                if (!syncTabOptions || !syncTabOptions.version || 'syncTabGroups' !== syncTabOptions.version[0] || !Array.isArray(syncTabOptions.groups)) {
                    Utils.notify('This is not "Sync Tab Groups" backup!');
                    return;
                }

                if (1 !== syncTabOptions.version[1]) {
                    Utils.notify('"Sync Tab Groups" backup has unsupported version');
                    return;
                }

                let data = {
                    groups: [],
                    pinnedTabs: [],
                };

                syncTabOptions.groups.forEach(function({id, title, tabs}) {
                    tabs = tabs
                        .map(function({url, title, favIconUrl, pinned}) {
                            url = Utils.normalizeUrl(url);

                            if (Utils.isUrlAllowToCreate(url)) {
                                return {url, title, favIconUrl, pinned};
                            }
                        })
                        .filter(Boolean);

                    data.groups.push({
                        title: Groups.createTitle(title, id),
                        tabs: tabs.filter(tab => !tab.pinned),
                    });

                    data.pinnedTabs.push(...tabs.filter(tab => tab.pinned));
                });

                this.setManageAddonSettings(data, 'importSettingsSyncTabGroupsAddonTitle', true);
            },

            runClearAddonConfirm() {
                this.showClearAddonConfirmPopup = false;
                this.showLoadingMessage = true;
                Messages.sendMessageModule('BG.clearAddon');
            },

            createHotkey() {
                return {
                    value: '',
                    action: '',
                    groupId: 0,
                };
            },

            async setPermissionsBookmarks(event) {
                if (event.target.checked) {
                    this.permissions.bookmarks = await browser.permissions.request(Constants.PERMISSIONS.BOOKMARKS);
                } else {
                    await browser.permissions.remove(Constants.PERMISSIONS.BOOKMARKS);
                }

                this.loadBookmarksParents();
            },

            async loadBookmarksParents() {
                if (this.defaultBookmarksParents.length) {
                    return;
                }

                this.permissions.bookmarks = await browser.permissions.contains(Constants.PERMISSIONS.BOOKMARKS);

                if (this.permissions.bookmarks) {
                    this.defaultBookmarksParents = await browser.bookmarks.get(Constants.DEFAULT_BOOKMARKS_PARENTS);
                }
            },

            getGroupIconUrl(groupId) {
                const group = this.groups.find(gr => gr.id === groupId);
                return Groups.getIconUrl(group);
            },

            openDebugPage() {
                Urls.openDebugPage();
            },
        },
    }
</script>

<template>
    <div id="stg-options">
        <div class="tabs is-boxed is-fullwidth">
            <ul>
                <li :class="{'is-active': section === SECTION_GENERAL}">
                    <a @click="section = SECTION_GENERAL" @keydown.enter="section = SECTION_GENERAL" tabindex="0">
                        <span class="icon">
                            <img class="size-16" src="/icons/cog.svg">
                        </span>
                        <span v-text="lang('generalTitle')"></span>
                    </a>
                </li>
                <li :class="{'is-active': section === SECTION_HOTKEYS}">
                    <a @click="section = SECTION_HOTKEYS" @keydown.enter="section = SECTION_HOTKEYS" tabindex="0">
                        <span class="icon">
                            <img class="size-16" src="/icons/keyboard-o.svg">
                        </span>
                        <span v-text="lang('hotkeysTitle')"></span>
                    </a>
                </li>
                <li :class="{'is-active': section === SECTION_BACKUP}">
                    <a @click="section = SECTION_BACKUP" @keydown.enter="section = SECTION_BACKUP" tabindex="0">
                        <span class="icon">
                            <img class="size-16" src="/icons/cloud-upload.svg">
                        </span>
                        <span v-text="lang('exportAddonSettingsTitle')"></span>
                    </a>
                </li>
            </ul>
        </div>

        <div v-show="section === SECTION_GENERAL">
            <div class="field">
                <label class="checkbox">
                    <input v-model="permissions.bookmarks" @click="setPermissionsBookmarks" type="checkbox" />
                    <span v-text="lang('allowAccessToBookmarks')"></span>
                </label>
            </div>
            <div class="field h-margin-left-10">
                <label class="label" v-text="lang('defaultBookmarkFolderLocation')"></label>
                <div class="control has-icons-left">
                    <div class="select">
                        <select v-model="options.defaultBookmarksParent" :disabled="!permissions.bookmarks">
                            <option v-for="bookmark in defaultBookmarksParents" :key="bookmark.id" :value="bookmark.id" v-text="bookmark.title"></option>
                        </select>
                    </div>
                    <div class="icon is-left">
                        <img class="size-16" src="/icons/bookmark.svg" />
                    </div>
                </div>
            </div>
            <div class="field">
                <label class="checkbox">
                    <input v-model="options.showContextMenuOnTabs" type="checkbox" />
                    <span v-text="lang('showContextMenuOnTabs')"></span>
                </label>
            </div>
            <div class="field">
                <label class="checkbox">
                    <input v-model="options.showContextMenuOnLinks" type="checkbox" />
                    <span v-text="lang('showContextMenuOnLinks')"></span>
                </label>
            </div>
            <div class="field">
                <label class="checkbox">
                    <input v-model="options.closePopupAfterChangeGroup" type="checkbox" />
                    <span v-text="lang('closePopupAfterChangeGroup')"></span>
                </label>
            </div>
            <div class="field">
                <label class="checkbox">
                    <input v-model="options.closePopupAfterSelectTab" type="checkbox" />
                    <span v-text="lang('closePopupAfterSelectTab')"></span>
                </label>
            </div>
            <div class="field">
                <label class="checkbox">
                    <input v-model="options.fullPopupWidth" type="checkbox" />
                    <span v-text="lang('fullPopupWidth')"></span>
                </label>
            </div>
            <div class="field">
                <label class="checkbox">
                    <input v-model="options.openGroupAfterChange" type="checkbox" />
                    <span v-text="lang('openGroupAfterChange')"></span>
                </label>
            </div>
            <div class="field">
                <label class="checkbox">
                    <input v-model="options.createNewGroupWhenOpenNewWindow" type="checkbox" />
                    <span v-text="lang('createNewGroupWhenOpenNewWindow')"></span>
                </label>
            </div>
            <div class="field">
                <label class="checkbox">
                    <input v-model="options.showExtendGroupsPopupWithActiveTabs" type="checkbox" />
                    <span v-text="lang('showExtendGroupsPopupWithActiveTabs')"></span>
                </label>
            </div>
            <div class="field">
                <label class="checkbox">
                    <input v-model="options.alwaysAskNewGroupName" type="checkbox" />
                    <span v-text="lang('alwaysAskNewGroupName')"></span>
                </label>
            </div>
            <div class="field">
                <label class="checkbox">
                    <input v-model="options.openManageGroupsInTab" type="checkbox" />
                    <span v-text="lang('openManageGroupsInTab')"></span>
                </label>
            </div>
            <div class="field">
                <label class="checkbox">
                    <input v-model="options.showConfirmDialogBeforeGroupDelete" type="checkbox" />
                    <span v-text="lang('showConfirmDialogBeforeGroupDelete')"></span>
                </label>
            </div>
            <div class="field">
                <label class="checkbox">
                    <input v-model="options.showConfirmDialogBeforeGroupArchiving" type="checkbox" />
                    <span v-text="lang('showConfirmDialogBeforeGroupArchiving')"></span>
                </label>
            </div>
            <div class="field">
                <label class="checkbox">
                    <input v-model="options.showNotificationAfterGroupDelete" type="checkbox" />
                    <span v-text="lang('showNotificationAfterGroupDelete')"></span>
                </label>
            </div>
            <div class="field">
                <label class="checkbox">
                    <input v-model="options.disableAllNotifications" type="checkbox" />
                    <span v-text="lang('disableAllNotifications')"></span>
                </label>
            </div>
            <div class="field">
                <label class="checkbox">
                    <input v-model="options.showTabsWithThumbnailsInManageGroups" type="checkbox" />
                    <span v-text="lang('showTabsWithThumbnailsInManageGroups')"></span>
                </label>
            </div>
            <div class="field">
                <button class="button is-success" @click="openDefaultGroup">
                    <span class="icon">
                        <img class="size-16" src="/icons/icon.svg" />
                    </span>
                    <span class="h-margin-left-5" v-text="lang('defaultGroup')"></span>
                </button>
            </div>
            <div class="field">
                <label class="label" v-text="lang('temporaryContainerTitleDescription')"></label>
                <div class="control">
                    <input v-model.lazy.trim="options.temporaryContainerTitle" class="input tmp-container-input" type="text" :placeholder="lang('temporaryContainerTitle')">
                </div>
            </div>

            <div class="field">
                <label class="label" v-text="lang('theme')"></label>
                <div class="control">
                    <div class="select">
                        <select v-model="options.theme">
                            <option value="auto" v-text="lang('themeAuto')"></option>
                            <option value="light" v-text="lang('themeLight')"></option>
                            <option value="dark" v-text="lang('themeDark')"></option>
                        </select>
                    </div>
                </div>
            </div>

            <div v-if="showEnableDarkThemeNotification" class="field mb-6" v-html="lang('enableDarkThemeNotification')"></div>

            <hr/>

            <div class="field">
                <label class="label" v-text="lang('contextMenuEditor')"></label>

                <div class="columns">
                    <div class="column">
                        <label class="label" v-text="lang('tab') + ':'"></label>
                        <template v-for="(item, id) in contextMenuTabTitles">
                            <hr v-if="id === 'hr'" :key="id">
                            <div v-else class="field" :key="id">
                                <label class="checkbox">
                                    <input v-model="options.contextMenuTab" :value="id" type="checkbox" />
                                    <img v-if="item.icon" class="size-16 mr-3" :src="`/icons/${item.icon}.svg`" />
                                    <span v-text="lang(item.title)"></span>
                                </label>
                            </div>
                        </template>
                    </div>
                    <div class="column">
                        <label class="label" v-text="lang('group') + ':'"></label>
                        <template v-for="(item, id) in contextMenuGroupTitles">
                            <hr v-if="id === 'hr'" :key="id">
                            <div v-else class="field" :key="id">
                                <label class="checkbox">
                                    <input v-model="options.contextMenuGroup" :value="id" type="checkbox" />
                                    <img v-if="item.icon" class="size-16 mr-3" :src="`/icons/${item.icon}.svg`" />
                                    <span v-text="lang(item.title)"></span>
                                </label>
                            </div>
                        </template>
                    </div>
                </div>

            </div>

            <hr/>

            <div class="mt-5">
                <button class="button is-warning" @click="openDebugPage" v-text="lang('helpPageStgDebugTitle')"></button>
            </div>
        </div>

        <div v-show="section === SECTION_HOTKEYS">
            <label class="has-text-weight-bold" v-text="lang('hotkeysTitle')"></label>
            <div class="h-margin-bottom-10" v-html="lang('hotkeysDescription')"></div>
            <div class="hotkeys">
                <div v-for="(hotkey, hotkeyIndex) in options.hotkeys" :key="hotkeyIndex" class="field">
                    <div class="is-flex is-align-items-center" :class="hasEqualHotkeys(hotkey) && 'key-error'">
                        <div class="control input-command">
                            <input type="text" @keydown="saveHotkeyKeyCodeAndStopEvent(hotkey, $event)" @blur="onBlurHotkey" :value="hotkey.value" autocomplete="off" class="input" :placeholder="lang('hotkeyPlaceholder')" tabindex="-1" />
                        </div>
                        <div class="select">
                            <select v-model="hotkey.action">
                                <option v-if="!hotkey.action" disabled value="" v-text="lang('selectAction')"></option>
                                <option v-for="action in HOTKEY_ACTIONS" :key="action" :value="action" v-text="getHotkeyActionTitle(action)"></option>
                            </select>
                        </div>
                        <div class="delete-button">
                            <span @click="options.hotkeys.splice(hotkeyIndex, 1)" class="cursor-pointer" :title="lang('deleteHotKeyButton')">
                                <img class="size-16" src="/icons/delete.svg" />
                            </span>
                        </div>
                    </div>

                    <div v-if="HOTKEY_ACTIONS_WITH_CUSTOM_GROUP.includes(hotkey.action)" class="is-flex is-align-items-center custom-group">
                        <div :class="['control', {'has-icons-left': hotkey.groupId}]">
                            <div class="select">
                                <select v-model.number="hotkey.groupId">
                                    <option :value="0" v-text="lang('selectGroup')"></option>
                                    <option v-if="hotkey.groupId && !groupIds.includes(hotkey.groupId)" disabled :value="hotkey.groupId" v-text="lang('unknownGroup')"></option>
                                    <option v-for="group in groups" :key="group.id" :value="group.id" v-text="getGroupTitle(group)"></option>
                                </select>
                            </div>
                            <span class="icon is-left" v-if="hotkey.groupId">
                                <img class="size-16" :src="getGroupIconUrl(hotkey.groupId)">
                            </span>
                        </div>
                    </div>
                </div>
            </div>
            <div class="control h-margin-top-10">
                <button @click="options.hotkeys.push(createHotkey())" class="button">
                    <span class="icon">
                        <img class="size-16" src="/icons/new.svg" />
                    </span>
                    <span v-text="lang('addHotKeyButton')"></span>
                </button>
            </div>
        </div>

        <div v-show="section === SECTION_BACKUP">
            <div class="field">
                <div class="has-text-weight-bold h-margin-bottom-5" v-text="lang('exportAddonSettingsTitle')"></div>
                <div class="h-margin-bottom-5" v-html="lang('exportAddonSettingsDescription')"></div>
                <div class="field">
                    <label class="checkbox" :disabled="!options.showTabsWithThumbnailsInManageGroups">
                        <input v-if="options.showTabsWithThumbnailsInManageGroups" v-model="includeTabThumbnailsIntoBackup" type="checkbox" />
                        <input v-else disabled="" type="checkbox" />
                        <span v-text="lang('includeTabThumbnailsIntoBackup')"></span>
                    </label>
                </div>
                <div class="field">
                    <label class="checkbox">
                        <input v-model="includeTabFavIconsIntoBackup" type="checkbox" />
                        <span v-text="lang('includeTabFavIconsIntoBackup')"></span>
                    </label>
                </div>
                <div class="field">
                    <div class="control">
                        <button @click="exportAddonSettings" class="button is-info">
                            <span class="icon">
                                <img class="size-16" src="/icons/download.svg" />
                            </span>
                            <span class="h-margin-left-5" v-text="lang('exportAddonSettingsButton')"></span>
                        </button>
                    </div>
                </div>
            </div>

            <hr>

            <div class="field">
                <div class="field">
                    <label class="checkbox">
                        <input v-model="options.autoBackupEnable" type="checkbox" />
                        <span v-text="lang('autoBackupEnableTitle')"></span>
                    </label>
                </div>
                <div v-if="options.autoBackupEnable" class="field">
                    <div class="field">
                        <label class="checkbox" :disabled="!options.showTabsWithThumbnailsInManageGroups">
                            <input v-if="options.showTabsWithThumbnailsInManageGroups" v-model="options.autoBackupIncludeTabThumbnails" type="checkbox" />
                            <input v-else disabled="" type="checkbox" />
                            <span v-text="lang('includeTabThumbnailsIntoBackup')"></span>
                        </label>
                    </div>
                    <div class="field">
                        <label class="checkbox">
                            <input v-model="options.autoBackupIncludeTabFavIcons" type="checkbox" />
                            <span v-text="lang('includeTabFavIconsIntoBackup')"></span>
                        </label>
                    </div>
                    <div class="field">
                        <label class="checkbox">
                            <input v-model="options.autoBackupByDayIndex" type="checkbox" />
                            <span v-text="lang('autoBackupByDayIndexTitle')"></span>
                        </label>
                        <p class="help is-medium" v-text="lang('autoBackupByDayIndexDescription')"></p>
                    </div>

                    <div class="field is-flex is-align-items-center indent-children">
                        <div class="h-margin-right-5" v-html="lang('autoBackupCreateEveryTitle')"></div>
                        <div class="field has-addons">
                            <div class="control">
                                <input type="number" class="input backup-time-input" v-model.number="options.autoBackupIntervalValue" min="1" max="20" />
                            </div>
                            <div class="control">
                                <div class="select">
                                    <select v-model="options.autoBackupIntervalKey">
                                        <option :value="AUTO_BACKUP_INTERVAL_KEY.minutes" v-text="lang('autoBackupIntervalKeyMinutes')"></option>
                                        <option :value="AUTO_BACKUP_INTERVAL_KEY.hours" v-text="lang('autoBackupIntervalKeyHours')"></option>
                                        <option :value="AUTO_BACKUP_INTERVAL_KEY.days" v-text="lang('autoBackupIntervalKeyDays')"></option>
                                    </select>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="field">
                        <span v-text="lang('autoBackupLastBackupTitle')"></span>
                        <span v-if="options.autoBackupLastBackupTimeStamp > 1" v-text="new Date(options.autoBackupLastBackupTimeStamp * 1000).toLocaleString()"></span>
                        <span v-else>&mdash;</span>
                    </div>

                    <!-- files -->
                    <div class="field">
                        <div class="field is-grouped is-align-items-center">
                            <div class="control">
                                <label class="field" v-text="lang('folderNameTitle') + ':'"></label>
                            </div>
                            <div class="control">
                                <input type="text" v-model.trim="options.autoBackupFolderName" maxlength="200" class="input" />
                            </div>
                            <div class="control">
                                <button class="button" @click="openBackupFolder" v-text="lang('openBackupFolder')"></button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <hr>

            <div class="field">
                <div class="has-text-weight-bold h-margin-bottom-5" v-text="lang('importAddonSettingsTitle')"></div>
                <div class="h-margin-bottom-5" v-html="lang('importAddonSettingsDescription')"></div>
                <div class="field is-grouped is-align-items-center">
                    <div class="control">
                        <button @click="importAddonSettings" class="button is-info">
                            <span class="icon">
                                <img class="size-16" src="/icons/icon.svg" />
                            </span>
                            <span class="h-margin-left-5" v-text="lang('importAddonSettingsButton')"></span>
                        </button>
                    </div>
                </div>
            </div>

            <hr>

            <div class="has-text-weight-bold h-margin-bottom-5" v-text="lang('importSettingsOldTabGroupsAddonTitle')"></div>
            <div class="h-margin-bottom-5" v-html="lang('importSettingsOldTabGroupsAddonDescription')"></div>
            <div class="field">
                <div class="control">
                    <button @click="importSettingsOldTabGroupsAddonButton" class="button">
                        <span class="icon">
                            <img class="size-16" src="/icons/old-tab-groups.svg" />
                        </span>
                        <span class="h-margin-left-5" v-text="lang('browseFileTitle')"></span>
                    </button>
                </div>
            </div>

            <hr>

            <div class="has-text-weight-bold h-margin-bottom-5" v-text="lang('importSettingsPanoramaViewAddonTitle')"></div>
            <div class="h-margin-bottom-5" v-html="lang('importSettingsPanoramaViewAddonDescription')"></div>
            <div class="field">
                <div class="control">
                    <button @click="importSettingsPanoramaViewAddonButton" class="button">
                        <span class="icon">
                            <img class="size-16" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAADsOAAA7DgHMtqGDAAACL0lEQVR42m2Ty05UYRCEv+rzz03GQZORnTExuPMdeAv2JibudYO6x507fQjfgkdwYaJi8BajzAzCYQ6eOZf/bxcDgmJtuyuV6qoO6fn9R8AW+JhLEIhdYAMDEjtU8Q6zEr4Vs2JaPwvAFv4/MiAH1MMU2D+BoumxX8JxRXHk49ncH4c/yn4uCkACqhaKxmki7P6EJKdOFD8S02+JctQdB3TGcGgdyhbyCg4WcFxDTCBHJtyhmDqTt5HYEYejAYHjGubNkpTXUDRQR3CHTNA1yKBNMJ86Pz9GYg1NN+OQAYHXE1gkaNK5BRNIYIBhysSXTy3pBPMgNIR5v88idAgkdgn0MPNLRzQMsz1MVYuwvu/pmkjRUp6tiL5VgUwbSIG/+QYgkxNUPn31dfpgdUS9fmVT8h5J1NbBOrTh79iEMqsmbw4naw+v8+5Fc0OxGdy7u3arFlClVBN4yxotGYYTSL5D9B4Jx7CY0t7q+rXN9y8bsuivWOi2t57OavGLQIvw4PIBVSCmOzQOCcqTRH4CC/eeJYeS2577TcqlvYiYcoUWoYGDRJBDu3Dyz5H8yIkjSxou4/DWE6XjhSMgp88RffysdUMIx4dO/iFS/kgw1GkRdSmQBmOfERGdTx3C5HskFX76Nxcm/+CAFeb0ljs66wsEOprpqsYY0BMKaBkiKCAfwIIuU66eCxjYCqjLLNDVtlbtiQ98rEzQp6KjFoCBVyhjNhzR0CG7+OVdZuqy/RuUhxWxRglzCQAAAABJRU5ErkJggg==" />
                        </span>
                        <span class="h-margin-left-5" v-text="lang('browseFileTitle')"></span>
                    </button>
                </div>
            </div>

            <hr>

            <div class="has-text-weight-bold h-margin-bottom-5" v-text="lang('importSettingsSyncTabGroupsAddonTitle')"></div>
            <div class="h-margin-bottom-5" v-html="lang('importSettingsSyncTabGroupsAddonDescription')"></div>
            <div class="field">
                <div class="control">
                    <button @click="importSettingsSyncTabGroupsAddonButton" class="button">
                        <span class="icon">
                            <img class="size-16" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAC4ElEQVR42m1Tu09TcRQ+bVx0dyFYZGiqCelQaAwNVtMApe/29t375LYNCqSFxISBRBdD1MV/wsHBaDQScTYmYkV0MDGBQRExGAddhF65v+M55eXgTb6c331833deFxJ3zlxLP4YfuWeA0iIIjkfnp2CnlwCLd8/fBLrSUvJ2sVgUhD1Jkn7mcrkIMFl/A2gQOnHl+Ky9Btt878D4A+eaVI32qBVt26yOo6Zptq7rGI1GP0Nu6YC0ckw+jFoLRHXViYlF2EpMXvLrcvWPMa6joiiCRDCZTCJwqv/NoNURsM1VB6aewKY0ddGnlo1dTVdRlmWbRDAej9uQpTrZST9w1I/JQl0mgRYJPGKBkE8uaTuqpmC5XLYJIhaL7UH+uYMJlvpqHxpjeT8qL6BtvnRayYdcQsCvFg2rLJetQqHQLpVKFgkgRO7DhrIKOLHmwNpHQPMDYJVgvqP4lkAZxe7Bujld6spm8tuKqnATMZvN4vDwcAsat1RX8vq5+lkJZjwlaPjqp+a9+omFAYp9irM52DjdlG9c6OYxqqra6/f7m263u0ljvDo7O3sS5hpzrmxcrrtdfU2/d6ip5mu9/LEsyd3BwXCzz9PfHBq4PN/v718IBALzXq+34fF4Zo4E0pnURrU+jtONKbwyOYHlSmHbNM2uVCaxbpg66oaGFaVMna8gLRA3sINUKoWhUKgFPI5arWYZhtEmWFSfRep+mvEWpWwRqU1Ns/L5vEWbx++sdDrdieFwGIFHQo6CyDaBZ7xDJF8ikdhkcTrbRBaETuMymYwg9w6oiXtA4xAkgLSaNne3UqnssgAtySadkYj2IZlckdx5AwVvIQnYwHURUfB6krsgUqcEmvFXrpWIgu4FOR+RKTveQjEyMkKrLEm/+ccgAZtqRqrzFz3riUQiXyg7FrDZ+R8BJAGbRYLB4HfgX5LcPrHy2NgY1zbRGaMs65Qi8rPR0VEGMjhtgiDyNzJ0/QXvYtJ0HU94ewAAAABJRU5ErkJggg==" />
                        </span>
                        <span class="h-margin-left-5" v-text="lang('browseFileTitle')"></span>
                    </button>
                </div>
            </div>

            <hr>

            <div class="field">
                <div class="has-text-weight-bold h-margin-bottom-5" v-text="lang('deleteAllAddonDataAndSettings')"></div>
                <div class="has-text-danger has-text-weight-bold h-margin-bottom-5">
                    <span v-text="lang('warning')"></span>
                    <span v-html="lang('eraseAddonSettingsWarningTitle')"></span>
                </div>
                <div class="field is-grouped is-align-items-center">
                    <div class="control">
                        <button @click="showClearAddonConfirmPopup = true" class="button is-danger">
                            <span class="icon">
                                <img class="size-16" src="/icons/close.svg" />
                            </span>
                            <span class="h-margin-left-5" v-text="lang('clear')"></span>
                        </button>
                    </div>
                </div>
            </div>

        </div>

        <popup
            v-if="openEditDefaultGroup"
            :title="lang('defaultGroup')"
            :buttons="
                [{
                    event: 'save-group',
                    classList: 'is-success',
                    lang: 'save',
                }, {
                    event: 'close-popup',
                    lang: 'cancel',
                }]
            "
            @save-group="() => $refs.editDefaultGroup.triggerChanges()"
            @close-popup="openEditDefaultGroup = false"
            >
            <edit-group
                ref="editDefaultGroup"
                :group-to-edit="defaultGroup"
                :is-default-group="true"
                :group-to-compare="defaultCleanGroup"
                @changes="saveDefaultGroup"></edit-group>
        </popup>

        <popup v-if="showLoadingMessage" :buttons="
                [{
                    event: 'null',
                    lang: 'ok',
                    classList: 'is-success',
                }]
            ">
            <span v-text="lang('loading')"></span>
        </popup>

        <popup v-if="showClearAddonConfirmPopup"
            :title="lang('deleteAllAddonDataAndSettings')"
            @clear="runClearAddonConfirm"
            @close-popup="showClearAddonConfirmPopup = false"
            :buttons="
                [{
                    event: 'clear',
                    lang: 'ok',
                    classList: 'is-danger',
                }, {
                    event: 'close-popup',
                    lang: 'cancel',
                    focused: true,
                }]
            ">
            <span v-text="lang('warningAllDataWillRemove')"></span>
        </popup>

        <popup
            v-if="manageAddonSettings"
            ref="mng"
            :title="lang(manageAddonSettingsTitle)"
            @close-popup="manageAddonSettings = null"
            @save="() => {
                $refs.mng.buttonsClone = [{lang: 'ok'}];
                saveManagedAddonSettings($refs.manageAddonBackup.getData(), $refs.manageAddonBackup.clearAddonData);
            }"
            :buttons="
                [{
                    event: 'save',
                    lang: 'eraseAndImportAddonBackupButton',
                    classList: 'is-danger',
                    disabled: false,
                }, {
                    event: 'close-popup',
                    lang: 'cancel',
                }]
            ">
            <manage-addon-backup
                :data="manageAddonSettings"
                :disable-empty-groups="manageAddonSettingsDisableEmptyGroups"
                :allow-clear-addon-data="manageAddonSettingsAllowClearAddonDataBeforeRestore"
                ref="manageAddonBackup"
                @enable-get-data="value => $refs.mng.buttonsClone[0].disabled = !value"
                @clear-addon-data-update="value =>
                    Object.assign($refs.mng.buttonsClone[0], value ?
                        {lang: 'eraseAndImportAddonBackupButton', classList: 'is-danger'} :
                        {lang: 'importAddonSettingsButton', classList: 'is-primary'})
                "
                ></manage-addon-backup>
        </popup>

    </div>
</template>

<style lang="scss">
    body {
        // background-color: #f9f9fa;
        transition: background-color ease .2s;
    }

    .button.is-info,
    .button.is-danger,
    .button.is-success {
        --fill-color: #fff;
    }

    #stg-options {
        overflow-x: auto;
        max-width: 1024px;
        margin: 0 auto;
        padding: 10px 20px 50px;

        .backup-time-input {
            width: 100px;
        }

        .tmp-container-input {
            width: 300px;
        }

        .hotkeys {
            .control .input {
                width: 15em;
                ime-mode: disabled;
            }
            .control:not(.key-success):not(.key-error) .input:focus {
                --in-content-border-focus: transparent;
                outline: 2px solid dodgerblue;
            }
            :not(.key-error) > .control.key-success .input:focus {
                --in-content-border-focus: transparent;
                outline: 2px solid limegreen;
            }
            .key-error .input {
                --in-content-border-focus: transparent;
                outline: 2px solid orangered;
            }
        }

        .hotkeys > .field {
            &:not(:last-child) {
                border-bottom: 1px solid var(--color-hr);
                padding-bottom: .75rem;
            }

            > * > :not(:last-child) {
                margin-right: var(--indent);
            }

            > :not(.custom-group) .select {
                flex-grow: 1;

                select {
                    width: 100%;
                }
            }

            .custom-group {
                justify-content: end;
                margin-right: calc(16px + var(--indent));
                margin-top: .75rem;

                > .control {
                    max-width: 100%;
                }
            }

            .delete-button {
                line-height: 1;
            }
        }
    }

    .debug-record {
        fill: red;
        animation: blink 1s ease-out infinite;
    }

    @keyframes blink {
        0% {
            opacity: 1;
        }
        50% {
            opacity: 0;
        }
        100% {
            opacity: 1;
        }
    }

    .tabs {
        ul {
            border-bottom-color: var(--color-hr);
        }
    }

    html[data-theme="dark"] {
        --background-color: #202023;

        .tabs {
            a {
                color: #a6a5a5;
            }

            &.is-boxed {
                li.is-active a {
                    border-color: var(--color-hr);
                }

                li.is-active a,
                a:hover {
                    background-color: var(--background-color);
                }
            }
        }

        .delete-button:hover img {
            fill: #0078d7;
        }
    }

    .help.is-medium {
        font-size: 1rem;
    }

</style>
