<script>
    'use strict';

    import Vue from 'vue';

    import popup from '../components/popup.vue';
    import editGroup from '../components/edit-group.vue';
    import manageAddonBackup from './manage-addon-backup.vue';
    import githubGist from './github-gist.vue';

    import * as Constants from '/js/constants.js';
    import Messages from '/js/messages.js';
    import Logger from '/js/logger.js';
    import * as Utils from '/js/utils.js';
    import * as Management from '/js/management.js';
    import * as Storage from '/js/storage.js';
    import * as File from '/js/file.js';
    import * as Urls from '/js/urls.js';
    import * as Groups from '/js/groups.js';
    import {isValidHotkeyEvent, isValidHotkeyValue, eventToHotkeyValue} from '/js/hotkeys.js';
    import JSON from '/js/json.js';

    import defaultGroupMixin from '/js/mixins/default-group.mixin.js';
    import syncCloudMixin from '/js/mixins/sync-cloud.mixin.js';

    window.logger = new Logger('Options');

    const storage = localStorage.create('options');

    Vue.mixin(defaultGroupMixin);
    Vue.mixin(syncCloudMixin);
    Vue.config.errorHandler = errorEventHandler.bind(window.logger);

    const SECTION_GENERAL = 'general',
        SECTION_HOTKEYS = 'hotkeys',
        SECTION_BACKUP = 'backup',
        SECTION_ABOUT = 'about',
        folderNameRegExp = /[\<\>\:\"\/\\\|\?\*\x00-\x1F]|^(?:aux|con|nul|prn|com\d|lpt\d)$|^\.+|\.+$/gi;

    document.title = browser.i18n.getMessage('openSettings');

    const [section, element = null] = (storage.section || SECTION_GENERAL).split(' ');

    export default {
        name: 'options-page',
        // mixins: [defaultGroupMixin, syncCloudMixin],
        data() {
            this.MANIFEST = Constants.MANIFEST;

            this.HOTKEY_ACTIONS = Constants.HOTKEY_ACTIONS;
            this.HOTKEY_ACTIONS_WITH_CUSTOM_GROUP = Constants.HOTKEY_ACTIONS_WITH_CUSTOM_GROUP;
            this.INTERVAL_KEY = Constants.INTERVAL_KEY;

            this.PLUGINS = Object.fromEntries(
                Object.entries(Constants.EXTENSIONS_WHITE_LIST).filter(([id]) => id.startsWith('stg'))
            );

            this.DONATE_ITEMS = Constants.DONATE_ITEMS;

            this.SECTION_GENERAL = SECTION_GENERAL;
            this.SECTION_HOTKEYS = SECTION_HOTKEYS;
            this.SECTION_BACKUP = SECTION_BACKUP;
            this.SECTION_ABOUT = SECTION_ABOUT;

            return {
                section,
                element,

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

                autoBackupLastTimeStamp: storage.autoBackupLastTimeStamp,

                showLoadingMessage: false,

                showClearAddonConfirmPopup: false,
            };
        },
        components: {
            popup: popup,
            'edit-group': editGroup,
            'manage-addon-backup': manageAddonBackup,
            'github-gist': githubGist,
        },
        async created() {
            this.loadBookmarksParents();
            this.permissions.bookmarks = await browser.permissions.contains(Constants.PERMISSIONS.BOOKMARKS);

            this.updateThemeBinded = this.updateTheme.bind(this);
            this.themeMatcher = window.matchMedia('(prefers-color-scheme: dark)');

            const {disconnect} = Messages.connectToBackground(
                logger.prefixes.join('.'),
                'sync-end',
                ({changes}) => changes.local && this.reload()
            );
            window.addEventListener('unload', disconnect);

            await this.reload();
        },
        mounted() {
            if (this.element === 'sync') {
                setTimeout(() => {
                    Utils.scrollTo('#sync-block');
                }, 1000);
            }
        },
        watch: {
            section(section) {
                storage.section = section;
            },
        },
        computed: {
            showDarkThemeNotification() {
                return Utils.getThemeApply(this.options.theme) === 'dark';
            },
            groupIds() {
                return this.groups.map(group => group.id);
            },
        },
        methods: {
            async reload() {
                this.unwatchers ??= new Set;
                this.unwatchers.forEach(unwatch => unwatch());
                this.unwatchers.clear();
                this.themeMatcher.removeEventListener('change', this.updateThemeBinded);

                // load
                const data = await Storage.get();
                const options = Utils.extractKeys(data, Constants.ALL_OPTION_KEYS);

                options.autoBackupFolderName = await File.getAutoBackupFolderName();

                this.groups = data.groups;
                this.options = options;

                this.themeMatcher.addEventListener('change', this.updateThemeBinded);
                this.updateTheme();

                [
                    ...Constants.ONLY_BOOL_OPTION_KEYS,
                    'defaultBookmarksParent',
                    'autoBackupIntervalKey',
                    'syncIntervalKey',
                    'theme',
                    'contextMenuTab',
                    'contextMenuGroup',
                    ]
                    .forEach(option => {
                        this.unwatchers.add(this.$watch(`options.${option}`, value => {
                            Messages.sendMessageModule('BG.saveOptions', {
                                [option]: value,
                            });
                        }));
                    });

                this.unwatchers.add(this.$watch('options.autoBackupFolderName', value => {
                    while (folderNameRegExp.exec(value)) {
                        value = value.replace(folderNameRegExp, '').trim();
                    }

                    if (value.length > 200) {
                        value = '';
                    }

                    Messages.sendMessageModule('BG.saveOptions', {
                        autoBackupFolderName: value,
                    });
                }));
                this.unwatchers.add(this.$watch('options.autoBackupIntervalValue', value => {
                    value && Messages.sendMessageModule('BG.saveOptions', {
                        autoBackupIntervalValue: Utils.minMaxRange(value, 1, 50),
                    });
                }));
                this.unwatchers.add(this.$watch('options.syncIntervalValue', value => {
                    value && Messages.sendMessageModule('BG.saveOptions', {
                        syncIntervalValue: Utils.minMaxRange(value, 1, 50),
                    });
                }));
                this.unwatchers.add(this.$watch('options.theme', this.updateTheme));
                this.unwatchers.add(this.$watch('options.temporaryContainerTitle', value => {
                    value && Messages.sendMessageModule('BG.saveOptions', {
                        temporaryContainerTitle: value,
                    });
                }));
                this.unwatchers.add(this.$watch('options.hotkeys', hotkeys => {
                    hotkeys = hotkeys.filter((hotkey, index, self) => {
                        return self.findIndex(h => h.value === hotkey.value) === index;
                    });

                    const hotheysIsValid = hotkeys.every(hotkey => hotkey.action && isValidHotkeyValue(hotkey.value));

                    if (hotheysIsValid) {
                        Messages.sendMessageModule('BG.saveOptions', {hotkeys});
                    }
                }, {deep: true}));
                this.unwatchers.add(this.$watch('options.showTabsWithThumbnailsInManageGroups', value => {
                    if (!value) {
                        this.includeTabThumbnailsIntoBackup = this.options.autoBackupIncludeTabThumbnails = false;
                    }
                }));
            },

            lang: browser.i18n.getMessage,
            getHotkeyActionTitle: action => browser.i18n.getMessage('hotkeyActionTitle' + Utils.capitalize(Utils.toCamelCase(action))),
            getDonateItemHelp: item => browser.i18n.getMessage('donateItemHelp' + Utils.capitalize(Utils.toCamelCase(item))),

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

                if ('object' !== Utils.type(data) || 'object' !== Utils.type(data.defaultGroupProps) || !Array.isArray(data.groups) || !data.version) {
                    Utils.notify('This is wrong backup!');
                    return;
                }

                const resultMigrate = await Messages.sendMessageModule('BG.runMigrateForData', data, false);

                if (resultMigrate.migrated) {
                    data = resultMigrate.data;
                } else if (resultMigrate.error) {
                    Utils.notify(browser.i18n.getMessage(resultMigrate.error));
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
                            title,
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

                        win.groups.forEach(function({id, name: title}) {
                            groups[id] = {
                                title,
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
                                    title,
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
                        title,
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
                    groupId: null,
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

            copyTextSelector(selector) {
                const content = document.querySelector(selector).textContent.trim();
                navigator.clipboard.writeText(content);
            },

            isInstalledExtension(id) {
                return Management.isInstalled(id);
            },
            isEnabledExtension(id) {
                return Management.isEnabled(id);
            },
            getPluginIcon(id) {
                const firstPart = String(id).slice(0, -3);
                return `https://addons.mozilla.org/user-media/addon_icons/${firstPart}/${id}-64.png`;
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
                            <img class="size-16" src="/icons/cloud-arrow-up-solid.svg">
                        </span>
                        <span v-text="lang('exportAddonSettingsTitle')"></span>
                    </a>
                </li>
                <li :class="{'is-active': section === SECTION_ABOUT}">
                    <a @click="section = SECTION_ABOUT" @keydown.enter="section = SECTION_ABOUT" tabindex="0">
                        <span class="icon">
                            <img class="size-16" src="/icons/info.svg">
                        </span>
                        <span v-text="lang('aboutExtension')"></span>
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
                            <option value="auto">💻 <span v-text="lang('themeAuto')"></span></option>
                            <option value="light">🔆 <span v-text="lang('themeLight')"></span></option>
                            <option value="dark">🌒 <span v-text="lang('themeDark')"></span></option>
                        </select>
                    </div>
                </div>
            </div>

            <div v-if="showDarkThemeNotification" class="field mb-6" v-html="lang('darkThemeNotification')"></div>

            <hr/>

            <div class="field">
                <label class="label" v-text="lang('contextMenuEditor')"></label>

                <div class="columns">
                    <div class="column">
                        <label class="label" v-text="lang('tab') + ':'"></label>
                        <template v-for="(item, id) in contextMenuTabTitles">
                            <hr v-if="id === 'hr'" :key="id">
                            <div v-else class="field" :key="item.title">
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
                            <div v-else class="field" :key="item.title">
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
                                <select v-model="hotkey.groupId">
                                    <option :value="null" v-text="lang('selectGroup')"></option>
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
                        <div v-html="lang('autoBackupCreateEveryTitle')"></div>
                        <div class="field has-addons">
                            <div class="control">
                                <input type="number" class="input backup-time-input" v-model.lazy.number="options.autoBackupIntervalValue" min="1" max="50" />
                            </div>
                            <div class="control">
                                <div class="select">
                                    <select v-model="options.autoBackupIntervalKey">
                                        <option :value="INTERVAL_KEY.minutes" v-text="lang('intervalKeyMinutes')"></option>
                                        <option :value="INTERVAL_KEY.hours" v-text="lang('intervalKeyHours')"></option>
                                        <option :value="INTERVAL_KEY.days" v-text="lang('intervalKeyDays')"></option>
                                    </select>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="field">
                        <span v-text="lang('autoBackupLastBackupTitle')"></span>
                        <span v-if="autoBackupLastTimeStamp > 1" v-text="new Date(autoBackupLastTimeStamp * 1000).toLocaleString()"></span>
                        <span v-else>&mdash;</span>
                    </div>

                    <!-- files -->
                    <div class="field">
                        <div class="field is-grouped is-align-items-center">
                            <div class="control">
                                <label class="field" v-text="lang('folderNameTitle') + ':'"></label>
                            </div>
                            <div class="control">
                                <input type="text" v-model.lazy.trim="options.autoBackupFolderName" maxlength="200" class="input" />
                            </div>
                            <div class="control">
                                <button class="button" @click="openBackupFolder" v-text="lang('openBackupFolder')"></button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <hr>

            <div id="sync-block" class="field">
                <div class="field">
                    <label class="checkbox">
                        <input v-model="options.syncEnable" type="checkbox" />
                        <span v-text="lang('syncEnableTitle')"></span>
                    </label>
                </div>
                <div v-if="options.syncEnable" class="field">
                    <div class="field">
                        <label class="checkbox">
                            <input v-model="options.syncTabFavIcons" type="checkbox" />
                            <span v-text="lang('includeTabFavIconsIntoBackup')"></span>
                        </label>
                    </div>

                    <div class="field is-flex is-align-items-center indent-children">
                        <div v-html="lang('autoBackupCreateEveryTitle')"></div>
                        <div class="field has-addons">
                            <div class="control">
                                <input type="number" class="input backup-time-input" v-model.lazy.number="options.syncIntervalValue" min="1" max="50" />
                            </div>
                            <div class="control">
                                <div class="select">
                                    <select v-model="options.syncIntervalKey">
                                        <option :value="INTERVAL_KEY.hours" v-text="lang('intervalKeyHours')"></option>
                                        <option :value="INTERVAL_KEY.days" v-text="lang('intervalKeyDays')"></option>
                                    </select>
                                </div>
                            </div>
                        </div>
                    </div>

                    <github-gist></github-gist>
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

        <div v-show="section === SECTION_ABOUT">
            <div class="columns is-mobile">
                <div class="column is-narrow">
                    <figure class="image is-96x96">
                        <img :src="MANIFEST.icons[128]" />
                    </figure>
                </div>
                <div class="column is-flex is-flex-direction-column is-justify-content-space-between">
                    <div>
                        <div class="title">
                            <span v-text="MANIFEST.name"></span> v<span v-text="MANIFEST.version"></span>
                        </div>
                        <div class="subtitle">
                            <span v-text="MANIFEST.description"></span>
                        </div>
                    </div>
                    <div class="is-size-5" v-text="lang('aboutMadeIn')"></div>
                </div>
            </div>

            <div class="is-size-5 mt-6">
                <div class="columns is-mobile">
                    <div class="column is-one-fifth">
                        <span class="icon-text is-flex-wrap-nowrap">
                            <span class="icon">
                                <figure class="image is-16x16">
                                    <img src="/icons/user.svg" />
                                </figure>
                            </span>
                            <span v-text="lang('author')"></span>
                        </span>
                    </div>
                    <div class="column">
                        <span>Vitalii Bavykin</span>
                        <span>(Drive4ik)</span>
                        <br>
                        <span v-text="lang('email')"></span>:
                        <a href="mailto:drive4ik+stg@protonmail.com" target="_blank">drive4ik+stg@protonmail.com</a>
                    </div>
                </div>

                <div class="columns is-mobile">
                    <div class="column is-one-fifth">
                        <span class="icon-text is-flex-wrap-nowrap">
                            <span class="icon">
                                <img src="/icons/house.svg" />
                            </span>
                            <span v-text="lang('homepage')"></span>
                        </span>
                    </div>
                    <div class="column">
                        <a :href="MANIFEST.homepage_url" target="_blank">
                            <span class="icon-text">
                                <span class="icon">
                                    <img src="/icons/github.svg" />
                                </span>
                                <span>GitHub</span>
                            </span>
                        </a>
                        <br>
                        <a href="https://addons.mozilla.org/firefox/addon/simple-tab-groups/" target="_blank">
                            <span class="icon-text">
                                <span class="icon">
                                    <img src="/icons/extension-generic.svg" />
                                </span>
                                <span v-text="lang('aboutExtensionPage')"></span>
                            </span>
                        </a>
                    </div>
                </div>

                <div class="columns is-mobile">
                    <div class="column is-one-fifth">
                        <span class="icon-text is-flex-wrap-nowrap">
                            <span class="icon">
                                <img src="/icons/cubes.svg" />
                            </span>
                            <span v-text="lang('aboutLibraries')"></span>
                        </span>
                    </div>
                    <div class="column">
                        <a href="https://v2.vuejs.org/" target="_blank">Vue 2</a><br>
                        <a href="https://saintplay.github.io/vue-swatches/" target="_blank">vue-swatches</a><br>
                        <a href="https://bulma.io/" target="_blank">Bulma</a><br>
                    </div>
                </div>

                <div class="thanks-wrapper mt-6 pb-6">
                    <span class="icon-text">
                        <span class="icon">
                            <img class="heart" src="/icons/heart.svg" />
                        </span>
                        <span v-text="lang('aboutThanksText')"></span>
                    </span>
                </div>

                <div class="donate-section mb-6">
                    <div v-for="(item, name) in DONATE_ITEMS" :key="name" :class="name" class="columns is-mobile">
                        <div class="column is-one-fifth is-align-content-center">
                            <span class="icon-text">
                                <span class="icon">
                                    <img :src="`/icons/logo-${name}.svg`" />
                                </span>
                                <span v-text="item.title"></span>
                                <span v-if="item.hasHelp" class="icon" :title="getDonateItemHelp(name)">
                                    <img src="/icons/info.svg" />
                                </span>
                            </span>
                        </div>
                        <div class="column">
                            <div class="is-flex is-align-items-center indent-gap">
                                <a v-if="item.link" data-copy-target :href="item.link" target="_blank" v-text="item.linkText"></a>
                                <!-- eslint-disable-next-line vue/no-v-text-v-html-on-component -->
                                <wallet v-else-if="item.wallet" data-copy-target class="is-family-monospace" v-text="item.wallet"></wallet>

                                <button class="button" @click="copyTextSelector(`.${name} [data-copy-target]`)">
                                    <span class="icon">
                                        <img src="/icons/copy.svg" />
                                    </span>
                                </button>

                                <!--
                                    https://qrcodemate.com/
                                    https://qrgenerator.org/
                                    https://ezgif.com/svg-to-png
                                -->
                                <button v-if="item.hasQr" class="button" :style="{
                                        '--image-url': `url(/icons/qrcode-${name}.png)`,
                                    }">
                                    <span class="icon">
                                        <img src="/icons/qrcode.svg" />
                                    </span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="block">
                    <div class="has-text-weight-bold mb-5">
                        <a href="https://addons.mozilla.org/firefox/user/1017663/" target="_blank">STG plugins:</a>
                    </div>

                    <div class="columns is-mobile is-variable is-2 initial-line-height" v-for="(plugin, uuid) in PLUGINS" :key="plugin.url">
                        <div class="column is-narrow">
                            <span class="icon">
                                <img :src="getPluginIcon(plugin.id)" alt="icon">
                            </span>
                        </div>
                        <div class="column is-narrow">
                            <a :href="plugin.url" target="_blank" v-text="plugin.title"></a>
                        </div>
                        <div v-if="isInstalledExtension(uuid)" class="column">
                            <span class="icon">
                                <img v-if="isEnabledExtension(uuid)" class="has-text-success" src="/icons/check-square.svg" />
                                <img v-else src="/icons/square-xmark.svg" />
                            </span>
                        </div>
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

<style>
    body {
        /* background-color: #f9f9fa; */
        transition: background-color ease .2s;
    }

    .title,
    .subtitle {
        color: var(--text-color);
    }

    .button.is-info,
    .button.is-danger,
    .button.is-success,
    .button.is-primary {
        --fill-color: #fff;
    }

    .initial-line-height {
        line-height: 1.5rem;
    }

    @property --icon-light {
        syntax: "<percentage>";
        inherits: false;
        initial-value: 76%;
    }

    .thanks-wrapper {
        .heart {
            image-rendering: high-quality;
            animation: heartbeat 2.5s ease;
            --fill-color: hsl(0, 100%, var(--icon-light));
        }

        &:hover,
        &:has(~ .donate-section:hover) {
            .heart {
                animation-iteration-count: infinite;
            }
        }
    }

    @keyframes heartbeat {
        0% { transform: scale(1); --icon-light: 76%; }
        10% { transform: scale(1.25); --icon-light: 66%; }
        20% { transform: scale(1.1); --icon-light: 76%; }
        30% { transform: scale(1.3); --icon-light: 50%; }
        50% { transform: scale(1); --icon-light: 76%; }
        100% { transform: scale(1); }
    }

    .donate-section {
        .icon:has([src*="info"]) {
            cursor: help;
        }

        .button:has([src*="copy"]):active {
            --fill-color: hsl(from var(--input-text-color) h s calc(l + 30));
        }
    }

    .button:has([src*="qrcode"]) {
        &::after {
            --size: 200px;
            width: var(--size);
            height: var(--size);
            border-radius: 5px;
            position: absolute;
            left: calc(100% + var(--indent));
            background-color: #fff;
            background-repeat: round;
            background-image: var(--image-url);
            z-index: 1;
        }

        &:focus::after {
            content: '';
        }
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
            &:not(.key-error) > .control.key-success .input:focus {
                --in-content-border-focus: transparent;
                outline: 2px solid limegreen;
            }
            .key-error .input {
                --in-content-border-focus: transparent;
                outline: 2px solid orangered;
            }

            > .field {
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
    }

    .tabs {
        ul {
            border-bottom-color: var(--color-hr);
        }
    }

    html[data-theme="dark"] {
        --background-color: #202023;

        a[href] {
            color: #7585ff;
        }

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
