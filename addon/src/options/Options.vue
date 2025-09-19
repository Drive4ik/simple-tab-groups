<script>
    import Vue from 'vue';

    import popup from '../components/popup.vue';
    import editGroup from '../components/edit-group.vue';
    import manageAddonBackup from './manage-addon-backup.vue';
    import githubGist from './github-gist.vue';

    import '/js/prefixed-storage.js';
    import * as Constants from '/js/constants.js';
    import * as Messages from '/js/messages.js';
    import Logger, {errorEventHandler} from '/js/logger.js';
    import Notification from '/js/notification.js';
    import * as Utils from '/js/utils.js';
    import * as Management from '/js/management.js';
    import * as Containers from '/js/containers.js';
    import * as Bookmarks from '/js/bookmarks.js';
    import * as Storage from '/js/storage.js';
    import * as File from '/js/file.js';
    import * as Urls from '/js/urls.js';
    import * as Groups from '/js/groups.js';
    import {isValidHotkeyValue, eventToHotkeyValue} from '/js/hotkeys.js';
    import JSON from '/js/json.js';

    import defaultGroupMixin from '/js/mixins/default-group.mixin.js';
    import optionsMixin from '/js/mixins/options.mixin.js';

    window.logger = new Logger(Constants.MODULES.OPTIONS);

    const storage = localStorage.create(Constants.MODULES.OPTIONS);

    Vue.config.errorHandler = errorEventHandler.bind(window.logger);

    const SECTION_GENERAL = 'general',
        SECTION_HOTKEYS = 'hotkeys',
        SECTION_BACKUP = 'backup',
        SECTION_ABOUT = 'about',
        folderNameRegExp = /[\<\>\:\"\/\\\|\?\*\x00-\x1F]|^(?:aux|con|nul|prn|com\d|lpt\d)$|^\.+|\.+$/gi;

    document.title = browser.i18n.getMessage('openSettings');

    const [section, element = null] = (storage.section || SECTION_GENERAL).split(' ');
    storage.section = section;

    let instance;

    const {
        sendMessage,
        sendMessageModule,
    } = Messages.connectToBackground(Constants.MODULES.OPTIONS, [
        'group-added',
        'group-removed',
        'group-updated',
        'groups-updated',
        'sync-end',
    ], ({action, changes}) => {
        if (action.startsWith('group')) {
            instance?.loadGroups();
        } else if (action === 'sync-end') {
            if (changes.local) {
                instance?.optionsReload();
                instance?.loadGroups();
            }
        }
    });

    await Containers.init();
    await Management.init();

    export default {
        name: Constants.MODULES.OPTIONS,
        mixins: [defaultGroupMixin, optionsMixin],
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

            const mainStorage = localStorage.create(Constants.MODULES.BACKGROUND);

            if (mainStorage.autoBackupLastTimeStamp) {
                const lastBackupDate = new Date(mainStorage.autoBackupLastTimeStamp * 1000);
                this.lastAutoBackup = {
                    ago: Utils.relativeTime(lastBackupDate),
                    full: lastBackupDate.toLocaleString(Utils.UI_LANG, {dateStyle: 'full', timeStyle: 'short'}),
                    ISO: lastBackupDate.toISOString(),
                };
            }

            return {
                section,
                element,

                optionsWatchKeys: [
                    ...Constants.ONLY_BOOL_OPTION_KEYS,
                    'defaultBookmarksParent',
                    'autoBackupIntervalKey',
                    'syncIntervalKey',
                    'colorScheme',
                    'contextMenuTab',
                    'contextMenuGroup',
                ],

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
            'github-gist': githubGist,
        },
        async created() {
            instance = this;

            this.$on('options-reloaded', () => this.addCustomWatchers());

            this.loadBookmarksParents();

            this.loadGroups();
        },
        mounted() {
            const scrollNodeSelector = {
                sync: '#sync-block',
                debug: '#debug-block',
            }[this.element];

            if (scrollNodeSelector) {
                Utils.wait(1000).then(() => Utils.scrollTo(scrollNodeSelector));
            }
        },
        watch: {
            section(section) {
                storage.section = section;
            },
        },
        computed: {
            groupIds() {
                return this.groups.map(group => group.id);
            },
        },
        methods: {
            addCustomWatchers() {
                this.optionsWatch('autoBackupFolderName', async value => {
                    while (folderNameRegExp.exec(value)) {
                        value = value.replace(folderNameRegExp, '').trim();
                    }

                    if (value.length > 200) {
                        value = '';
                    }

                    return value;
                });

                this.optionsWatch('autoBackupIntervalValue', value => Utils.clamp(value, 1, 50));

                this.optionsWatch('syncIntervalValue', value => Utils.clamp(value, 1, 50));

                this.optionsWatch('temporaryContainerTitle', value => value || undefined);

                this.optionsWatch('hotkeys', hotkeys => {
                    const isValid = hotkeys.every(hotkey => hotkey.action && isValidHotkeyValue(hotkey.value));

                    if (!isValid) {
                        return;
                    }

                    return hotkeys.filter((hotkey, index, self) => {
                        return self.findIndex(h => h.value === hotkey.value) === index;
                    });
                }, {deep: true});

                this.optionsWatch('showTabsWithThumbnailsInManageGroups', value => {
                    if (!value) {
                        this.options.autoBackupIncludeTabThumbnails = this.includeTabThumbnailsIntoBackup = false;
                    }
                });
            },

            async loadGroups() {
                const {groups} = await Storage.get('groups');
                this.groups = groups;
            },

            lang: browser.i18n.getMessage,
            getHotkeyActionTitle: action => browser.i18n.getMessage('hotkeyActionTitle' + Utils.capitalize(Utils.toCamelCase(action))),
            getDonateItemHelp: item => browser.i18n.getMessage('donateItemHelp' + Utils.capitalize(Utils.toCamelCase(item))),

            openBackupFolder: File.openBackupFolder,
            getGroupTitle: Groups.getTitle,

            drawDangerHotkey(hotkey) {
                if (!hotkey.value) {
                    return false;
                }

                if (!isValidHotkeyValue(hotkey.value)) {
                    return true;
                }

                // hasEqualHotkeys
                return this.options.hotkeys.filter(h => h.value && h.value === hotkey.value).length > 1;
            },

            saveHotkeyKeyCodeAndStopEvent(hotkey, event) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();

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

                sendMessageModule('BG.restoreBackup', data, clearAddonData);
            },

            exportAddonSettings() {
                sendMessage('create-backup', {
                    includeTabFavIcons: this.includeTabFavIconsIntoBackup,
                    includeTabThumbnails: this.includeTabThumbnailsIntoBackup,
                });
            },

            async importAddonSettings() {
                let data = null;

                try {
                    data = await File.load();
                } catch (e) {
                    Notification(e);
                    return;
                }

                if (
                    'object' !== Utils.type(data) ||
                    'object' !== Utils.type(data.defaultGroupProps) ||
                    !Array.isArray(data.groups) ||
                    !data.version
                ) {
                    Notification('This is wrong backup!');
                    return;
                }

                const resultMigrate = await sendMessageModule('BG.runMigrateForData', data, false);

                if (resultMigrate.migrated) {
                    data = resultMigrate.data;
                } else if (resultMigrate.error) {
                    Notification(resultMigrate.error);
                    return;
                }

                this.setManageAddonSettings(data, 'importAddonSettingsTitle', false, true);
            },

            async importSettingsOldTabGroupsAddonButton() {
                let oldOptions = null;

                try {
                    oldOptions = await File.load();
                } catch (e) {
                    Notification(e);
                    return;
                }

                if (!oldOptions || !Array.isArray(oldOptions.windows) || !oldOptions.session) {
                    Notification('This is not "Tab Groups" backup!');
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
                        Notification(`Error: cannot parse backup file - ${e}`);
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
                            return Notification(`Cannot parse groups: ${e}`);
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
                    Notification(e);
                    return;
                }

                if (!panoramaOptions || !panoramaOptions.file || 'panoramaView' !== panoramaOptions.file.type || !Array.isArray(panoramaOptions.windows)) {
                    Notification('This is not "Panorama View" backup!');
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
                    Notification('"Panorama View" backup has unsupported version');
                    return;
                }

                this.setManageAddonSettings(data, 'importSettingsPanoramaViewAddonTitle', true);
            },

            async importSettingsSyncTabGroupsAddonButton() {
                let syncTabOptions = null;

                try {
                    syncTabOptions = await File.load();
                } catch (e) {
                    Notification(e);
                    return;
                }

                if (!syncTabOptions || !syncTabOptions.version || 'syncTabGroups' !== syncTabOptions.version[0] || !Array.isArray(syncTabOptions.groups)) {
                    Notification('This is not "Sync Tab Groups" backup!');
                    return;
                }

                if (1 !== syncTabOptions.version[1]) {
                    Notification('"Sync Tab Groups" backup has unsupported version');
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
                sendMessageModule('BG.clearAddon');
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
                    this.permissions.bookmarks = await Bookmarks.requestPermission();
                } else {
                    await browser.permissions.remove(Constants.PERMISSIONS.BOOKMARKS);
                }

                this.loadBookmarksParents();
            },

            async loadBookmarksParents() {
                if (this.defaultBookmarksParents.length) {
                    return;
                }

                this.permissions.bookmarks = await Bookmarks.hasPermission();

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
    <div id="stg-options" class="container is-max-desktop mt-3 mb-6">
        <div class="tabs is-boxed is-fullwidth">
            <ul>
                <li :class="{'is-active': section === SECTION_GENERAL}">
                    <a @click="section = SECTION_GENERAL" @keydown.enter="section = SECTION_GENERAL" tabindex="0">
                        <span class="icon">
                            <figure class="image is-16x16">
                                <img src="/icons/cog.svg" />
                            </figure>
                        </span>
                        <span v-text="lang('generalTitle')"></span>
                    </a>
                </li>
                <li :class="{'is-active': section === SECTION_HOTKEYS}">
                    <a @click="section = SECTION_HOTKEYS" @keydown.enter="section = SECTION_HOTKEYS" tabindex="0">
                        <span class="icon">
                            <figure class="image is-16x16">
                                <img src="/icons/keyboard-o.svg" />
                            </figure>
                        </span>
                        <span v-text="lang('hotkeysTitle')"></span>
                    </a>
                </li>
                <li :class="{'is-active': section === SECTION_BACKUP}">
                    <a @click="section = SECTION_BACKUP" @keydown.enter="section = SECTION_BACKUP" tabindex="0">
                        <span class="icon">
                            <figure class="image is-16x16">
                                <img src="/icons/cloud-arrow-up-solid.svg" />
                            </figure>
                        </span>
                        <span v-text="lang('exportAddonSettingsTitle')"></span>
                    </a>
                </li>
                <li :class="{'is-active': section === SECTION_ABOUT}">
                    <a @click="section = SECTION_ABOUT" @keydown.enter="section = SECTION_ABOUT" tabindex="0">
                        <span class="icon">
                            <figure class="image is-16x16">
                                <img src="/icons/info.svg" />
                            </figure>
                        </span>
                        <span v-text="lang('aboutExtension')"></span>
                    </a>
                </li>
            </ul>
        </div>

        <div v-show="section === SECTION_GENERAL">
            <div class="field">
                <label class="label colon" v-text="lang('colorScheme')"></label>
                <div class="control">
                    <div class="select">
                        <select v-model="options.colorScheme">
                            <option value="auto">💻 <span v-text="lang('colorSchemeAuto')"></span></option>
                            <option value="light">🔆 <span v-text="lang('colorSchemeLight')"></span></option>
                            <option value="dark">🌒 <span v-text="lang('colorSchemeDark')"></span></option>
                        </select>
                    </div>
                </div>
                <div class="has-text-warning show-on-dark-scheme" v-html="lang('darkColorSchemeNotification')"></div>
            </div>

            <div class="field">
                <button class="button is-primary is-soft" @click="openDefaultGroup">
                    <span class="icon">
                        <figure class="image is-16x16">
                            <img src="/icons/wrench.svg" />
                        </figure>
                    </span>
                    <span v-text="lang('defaultGroup')"></span>
                </button>
            </div>

            <hr/>

            <div class="block checkboxes as-column">
                <label class="checkbox">
                    <input v-model="permissions.bookmarks" @click="setPermissionsBookmarks" type="checkbox" />
                    <span v-text="lang('allowAccessToBookmarks')"></span>
                </label>
                <div class="ml-5">
                    <label class="label colon" v-text="lang('defaultBookmarkFolderLocation')"></label>
                    <div class="control has-icons-left">
                        <div class="select">
                            <select v-model="options.defaultBookmarksParent" :disabled="!permissions.bookmarks">
                                <option v-for="bookmark in defaultBookmarksParents" :key="bookmark.id" :value="bookmark.id" v-text="bookmark.title"></option>
                            </select>
                        </div>
                        <div class="icon is-left">
                            <figure class="image is-16x16">
                                <img src="/icons/bookmark.svg" />
                            </figure>
                        </div>
                    </div>
                </div>
                <label class="checkbox">
                    <input v-model="options.showArchivedGroups" type="checkbox" />
                    <span v-text="lang('showArchivedGroups')"></span>
                </label>
                <label class="checkbox">
                    <input v-model="options.closePopupAfterChangeGroup" type="checkbox" />
                    <span v-text="lang('closePopupAfterChangeGroup')"></span>
                </label>
                <label class="checkbox">
                    <input v-model="options.closePopupAfterSelectTab" type="checkbox" />
                    <span v-text="lang('closePopupAfterSelectTab')"></span>
                </label>
                <label class="checkbox">
                    <input v-model="options.openGroupAfterChange" type="checkbox" />
                    <span v-text="lang('openGroupAfterChange')"></span>
                </label>
                <label class="checkbox">
                    <input v-model="options.showExtendGroupsPopupWithActiveTabs" type="checkbox" />
                    <span v-text="lang('showExtendGroupsPopupWithActiveTabs')"></span>
                </label>
                <label class="checkbox">
                    <input v-model="options.fullPopupWidth" type="checkbox" />
                    <span v-text="lang('fullPopupWidth')"></span>
                </label>
                <label class="checkbox">
                    <input v-model="options.createNewGroupWhenOpenNewWindow" type="checkbox" />
                    <span v-text="lang('createNewGroupWhenOpenNewWindow')"></span>
                </label>
                <label class="checkbox">
                    <input v-model="options.alwaysAskNewGroupName" type="checkbox" />
                    <span v-text="lang('alwaysAskNewGroupName')"></span>
                </label>
                <label class="checkbox">
                    <input v-model="options.openManageGroupsInTab" type="checkbox" />
                    <span v-text="lang('openManageGroupsInTab')"></span>
                </label>
                <label class="checkbox">
                    <input v-model="options.showConfirmDialogBeforeGroupDelete" type="checkbox" />
                    <span v-text="lang('showConfirmDialogBeforeGroupDelete')"></span>
                </label>
                <label class="checkbox">
                    <input v-model="options.showNotificationAfterGroupDelete" type="checkbox" />
                    <span v-text="lang('showNotificationAfterGroupDelete')"></span>
                </label>
                <label class="checkbox">
                    <input v-model="options.showConfirmDialogBeforeGroupArchiving" type="checkbox" />
                    <span v-text="lang('showConfirmDialogBeforeGroupArchiving')"></span>
                </label>
                <label class="checkbox">
                    <input v-model="options.showTabsWithThumbnailsInManageGroups" type="checkbox" />
                    <span v-text="lang('showTabsWithThumbnailsInManageGroups')"></span>
                </label>
            </div>

            <div class="field is-horizontal">
                <div class="field-label">
                    <label class="label colon" v-text="lang('temporaryContainerTitleDescription')"></label>
                </div>
                <div class="field-body">
                    <div class="field">
                        <div class="control">
                            <input v-model.lazy.trim="options.temporaryContainerTitle" class="input tmp-container-input" type="text" :placeholder="lang('temporaryContainerTitle')">
                        </div>
                    </div>
                </div>
            </div>

            <div class="box">
                <label class="label is-medium" v-text="lang('contextMenuEditor')"></label>

                <div class="block checkboxes as-column">
                    <label class="checkbox">
                        <input v-model="options.showContextMenuOnTabs" type="checkbox" />
                        <span v-text="lang('showContextMenuOnTabs')"></span>
                    </label>
                    <label class="checkbox">
                        <input v-model="options.showContextMenuOnLinks" type="checkbox" />
                        <span v-text="lang('showContextMenuOnLinks')"></span>
                    </label>
                </div>

                <hr/>

                <div class="columns">
                    <div class="column">
                        <label class="label colon" v-text="lang('tab')"></label>
                        <div class="checkboxes as-column">
                            <template v-for="(item, id) in contextMenuTabTitles">
                                <hr v-if="id === 'hr'" :key="id">
                                <label v-else :key="item.title" class="checkbox">
                                    <input v-model="options.contextMenuTab" :value="id" type="checkbox" />
                                    <span class="icon-text">
                                        <figure v-if="item.icon" class="icon image is-16x16">
                                            <img :src="`/icons/${item.icon}.svg`" />
                                        </figure>
                                        <span v-text="lang(item.title)"></span>
                                    </span>
                                </label>
                            </template>
                        </div>
                    </div>
                    <div class="column">
                        <label class="label colon" v-text="lang('group')"></label>
                        <div class="checkboxes as-column">
                            <template v-for="(item, id) in contextMenuGroupTitles">
                                <hr v-if="id === 'hr'" :key="id">
                                <label v-else :key="item.title" class="checkbox">
                                    <input v-model="options.contextMenuGroup" :value="id" type="checkbox" />
                                    <span class="icon-text">
                                        <figure v-if="item.icon" class="icon image is-16x16">
                                            <img :src="`/icons/${item.icon}.svg`" />
                                        </figure>
                                        <span v-text="lang(item.title)"></span>
                                    </span>
                                </label>
                            </template>
                        </div>
                    </div>
                </div>
            </div>

            <hr/>

            <div id="debug-block">
                <button class="button is-warning is-soft" @click="openDebugPage" v-text="lang('helpPageStgDebugTitle')"></button>
            </div>
        </div>

        <div v-show="section === SECTION_HOTKEYS">
            <label class="label" v-text="lang('hotkeysTitle')"></label>
            <div class="block" v-html="lang('hotkeysDescription')"></div>
            <div class="block hotkeys">
                <div class="field is-grouped" v-for="(hotkey, hotkeyIndex) in options.hotkeys" :key="hotkeyIndex">
                    <div class="control">
                        <input
                            type="text"
                            class="input is-shadowless is-palette-info"
                            :class="{'is-palette-danger': drawDangerHotkey(hotkey)}"
                            @keydown="saveHotkeyKeyCodeAndStopEvent(hotkey, $event)"
                            :value="hotkey.value"
                            autocomplete="off"
                            :placeholder="lang('hotkeyPlaceholder')"
                            tabindex="-1" />
                    </div>
                    <div class="control is-expanded">
                        <div class="select is-fullwidth">
                            <select v-model="hotkey.action">
                                <option v-if="!hotkey.action" disabled value="" v-text="lang('selectAction')"></option>
                                <option v-for="action in HOTKEY_ACTIONS" :key="action" :value="action" v-text="getHotkeyActionTitle(action)"></option>
                            </select>
                        </div>
                    </div>
                    <div
                        v-if="HOTKEY_ACTIONS_WITH_CUSTOM_GROUP.includes(hotkey.action)"
                        class="control is-expanded"
                        :class="{'has-icons-left': hotkey.groupId}"
                        >
                        <div class="select is-fullwidth">
                            <select v-model="hotkey.groupId">
                                <option :value="null" v-text="lang('selectGroup')"></option>
                                <option v-if="hotkey.groupId && !groupIds.includes(hotkey.groupId)" disabled hidden :value="hotkey.groupId" v-text="lang('unknownGroup')"></option>
                                <option v-for="group in groups" :key="group.id" :value="group.id" v-text="getGroupTitle(group)"></option>
                            </select>
                        </div>
                        <span class="icon is-left" v-if="hotkey.groupId">
                            <figure class="image is-16x16">
                                <img class="no-fill" :src="getGroupIconUrl(hotkey.groupId)" />
                            </figure>
                        </span>
                    </div>
                    <div class="control">
                        <button class="button" @click="options.hotkeys.splice(hotkeyIndex, 1)" :title="lang('deleteHotKeyButton')">
                            <span class="icon">
                                <figure class="image is-16x16">
                                    <img src="/icons/delete.svg" />
                                </figure>
                            </span>
                        </button>
                    </div>
                </div>
            </div>
            <div class="block">
                <div class="control">
                    <button @click="options.hotkeys.push(createHotkey())" class="button">
                        <span class="icon">
                            <figure class="image is-16x16">
                                <img src="/icons/new.svg" />
                            </figure>
                        </span>
                        <span v-text="lang('addHotKeyButton')"></span>
                    </button>
                </div>
            </div>
        </div>

        <div v-show="section === SECTION_BACKUP">
            <div class="field">
                <label class="label" v-text="lang('exportAddonSettingsTitle')"></label>
                <div class="field" v-html="lang('exportAddonSettingsDescription')"></div>

                <div class="block checkboxes as-column">
                    <label class="checkbox" :disabled="!options.showTabsWithThumbnailsInManageGroups">
                        <input type="checkbox" v-model="includeTabThumbnailsIntoBackup" :disabled="!options.showTabsWithThumbnailsInManageGroups" />
                        <span v-text="lang('includeTabThumbnailsIntoBackup')"></span>
                    </label>
                    <label class="checkbox">
                        <input v-model="includeTabFavIconsIntoBackup" type="checkbox" />
                        <span v-text="lang('includeTabFavIconsIntoBackup')"></span>
                    </label>
                </div>

                <div class="field">
                    <div class="control">
                        <button @click="exportAddonSettings" class="button is-info is-soft">
                            <span class="icon">
                                <figure class="image is-16x16">
                                    <img src="/icons/download.svg" />
                                </figure>
                            </span>
                            <span v-text="lang('exportAddonSettingsButton')"></span>
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

                <template v-if="options.autoBackupEnable">
                    <div class="block checkboxes as-column">
                        <label class="checkbox" :disabled="!options.showTabsWithThumbnailsInManageGroups">
                            <input v-if="options.showTabsWithThumbnailsInManageGroups" v-model="options.autoBackupIncludeTabThumbnails" type="checkbox" />
                            <input v-else disabled="" type="checkbox" />
                            <span v-text="lang('includeTabThumbnailsIntoBackup')"></span>
                        </label>
                        <label class="checkbox">
                            <input v-model="options.autoBackupIncludeTabFavIcons" type="checkbox" />
                            <span v-text="lang('includeTabFavIconsIntoBackup')"></span>
                        </label>
                        <label class="checkbox">
                            <input v-model="options.autoBackupByDayIndex" type="checkbox" />
                            <span class="icon-text">
                                <span v-text="lang('autoBackupByDayIndexTitle')"></span>
                                <figure class="icon image is-16x16" :title="lang('autoBackupByDayIndexDescription')">
                                    <img src="/icons/info.svg" />
                                </figure>
                            </span>
                        </label>
                    </div>

                    <div class="field is-horizontal">
                        <div class="field-label is-normal">
                            <label class="label colon" v-text="lang('autoBackupCreateEveryTitle')"></label>
                        </div>
                        <div class="field-body">
                            <div class="field has-addons">
                                <div class="control is-expanded">
                                    <input type="number" class="input" v-model.lazy.number="options.autoBackupIntervalValue" min="1" max="50" />
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
                    </div>

                    <div class="field is-horizontal">
                        <div class="field-label">
                            <label class="label colon" v-text="lang('lastUpdate')"></label>
                        </div>
                        <div class="field-body">
                            <time
                                v-if="lastAutoBackup"
                                class="is-underline-dotted"
                                :title="lastAutoBackup.full"
                                :datetime="lastAutoBackup.ISO"
                                v-text="lastAutoBackup.ago"></time>
                            <span v-else>&mdash;</span>
                        </div>
                    </div>

                    <div class="field is-horizontal">
                        <div class="field-label is-normal">
                            <label class="label colon" v-text="lang('folderNameTitle')"></label>
                        </div>
                        <div class="field-body">
                            <div class="field has-addons">
                                <div class="control is-expanded">
                                    <input type="text" v-model.lazy.trim="options.autoBackupFolderName" maxlength="200" class="input" />
                                </div>
                                <div class="control">
                                    <button class="button" @click="openBackupFolder" v-text="lang('openBackupFolder')"></button>
                                </div>
                            </div>
                        </div>
                    </div>
                </template>
            </div>

            <hr>

            <div id="sync-block" class="field">
                <div class="field">
                    <label class="checkbox">
                        <input v-model="options.syncEnable" type="checkbox" />
                        <span v-text="lang('syncEnableTitle')"></span>
                    </label>
                </div>

                <template v-if="options.syncEnable">
                    <div class="field">
                        <label class="checkbox">
                            <input v-model="options.syncTabFavIcons" type="checkbox" />
                            <span v-text="lang('includeTabFavIconsIntoBackup')"></span>
                        </label>
                    </div>

                    <div class="field is-horizontal">
                        <div class="field-label is-normal">
                            <label class="label colon" v-text="lang('autoBackupCreateEveryTitle')"></label>
                        </div>
                        <div class="field-body">
                            <div class="field has-addons">
                                <div class="control is-expanded">
                                    <input type="number" class="input" v-model.lazy.number="options.syncIntervalValue" min="1" max="50" />
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
                    </div>

                    <github-gist></github-gist>
                </template>
            </div>

            <hr>

            <div class="columns is-multiline">
                <div class="column is-full">
                    <label class="label" v-text="lang('importAddonSettingsTitle')"></label>
                    <div class="field" v-html="lang('importAddonSettingsDescription')"></div>
                    <div class="field is-grouped is-align-items-center">
                        <div class="control">
                            <button @click="importAddonSettings" class="button is-info is-soft">
                                <span class="icon">
                                    <figure class="image is-16x16">
                                        <img src="/icons/icon.svg" />
                                    </figure>
                                </span>
                                <span v-text="lang('restoreBackup')"></span>
                            </button>
                        </div>
                    </div>
                </div>
                <div class="column">
                    <label class="label" v-text="lang('importSettingsOldTabGroupsAddonTitle')"></label>
                    <div class="field" v-html="lang('importSettingsOldTabGroupsAddonDescription')"></div>
                    <div class="field">
                        <div class="control">
                            <button @click="importSettingsOldTabGroupsAddonButton" class="button">
                                <span class="icon">
                                    <figure class="image is-16x16">
                                        <img src="/icons/old-tab-groups.svg" />
                                    </figure>
                                </span>
                                <span v-text="lang('browseFileTitle')"></span>
                            </button>
                        </div>
                    </div>
                </div>
                <div class="column">
                    <label class="label" v-text="lang('importSettingsPanoramaViewAddonTitle')"></label>
                    <div class="field" v-html="lang('importSettingsPanoramaViewAddonDescription')"></div>
                    <div class="field">
                        <div class="control">
                            <button @click="importSettingsPanoramaViewAddonButton" class="button">
                                <span class="icon">
                                    <figure class="image is-16x16">
                                        <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAADsOAAA7DgHMtqGDAAACL0lEQVR42m2Ty05UYRCEv+rzz03GQZORnTExuPMdeAv2JibudYO6x507fQjfgkdwYaJi8BajzAzCYQ6eOZf/bxcDgmJtuyuV6qoO6fn9R8AW+JhLEIhdYAMDEjtU8Q6zEr4Vs2JaPwvAFv4/MiAH1MMU2D+BoumxX8JxRXHk49ncH4c/yn4uCkACqhaKxmki7P6EJKdOFD8S02+JctQdB3TGcGgdyhbyCg4WcFxDTCBHJtyhmDqTt5HYEYejAYHjGubNkpTXUDRQR3CHTNA1yKBNMJ86Pz9GYg1NN+OQAYHXE1gkaNK5BRNIYIBhysSXTy3pBPMgNIR5v88idAgkdgn0MPNLRzQMsz1MVYuwvu/pmkjRUp6tiL5VgUwbSIG/+QYgkxNUPn31dfpgdUS9fmVT8h5J1NbBOrTh79iEMqsmbw4naw+v8+5Fc0OxGdy7u3arFlClVBN4yxotGYYTSL5D9B4Jx7CY0t7q+rXN9y8bsuivWOi2t57OavGLQIvw4PIBVSCmOzQOCcqTRH4CC/eeJYeS2577TcqlvYiYcoUWoYGDRJBDu3Dyz5H8yIkjSxou4/DWE6XjhSMgp88RffysdUMIx4dO/iFS/kgw1GkRdSmQBmOfERGdTx3C5HskFX76Nxcm/+CAFeb0ljs66wsEOprpqsYY0BMKaBkiKCAfwIIuU66eCxjYCqjLLNDVtlbtiQ98rEzQp6KjFoCBVyhjNhzR0CG7+OVdZuqy/RuUhxWxRglzCQAAAABJRU5ErkJggg==" />
                                    </figure>
                                </span>
                                <span v-text="lang('browseFileTitle')"></span>
                            </button>
                        </div>
                    </div>
                </div>
                <div class="column">
                    <label class="label" v-text="lang('importSettingsSyncTabGroupsAddonTitle')"></label>
                    <div class="field" v-html="lang('importSettingsSyncTabGroupsAddonDescription')"></div>
                    <div class="field">
                        <div class="control">
                            <button @click="importSettingsSyncTabGroupsAddonButton" class="button">
                                <span class="icon">
                                    <figure class="image is-16x16">
                                        <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAC4ElEQVR42m1Tu09TcRQ+bVx0dyFYZGiqCelQaAwNVtMApe/29t375LYNCqSFxISBRBdD1MV/wsHBaDQScTYmYkV0MDGBQRExGAddhF65v+M55eXgTb6c331833deFxJ3zlxLP4YfuWeA0iIIjkfnp2CnlwCLd8/fBLrSUvJ2sVgUhD1Jkn7mcrkIMFl/A2gQOnHl+Ky9Btt878D4A+eaVI32qBVt26yOo6Zptq7rGI1GP0Nu6YC0ckw+jFoLRHXViYlF2EpMXvLrcvWPMa6joiiCRDCZTCJwqv/NoNURsM1VB6aewKY0ddGnlo1dTVdRlmWbRDAej9uQpTrZST9w1I/JQl0mgRYJPGKBkE8uaTuqpmC5XLYJIhaL7UH+uYMJlvpqHxpjeT8qL6BtvnRayYdcQsCvFg2rLJetQqHQLpVKFgkgRO7DhrIKOLHmwNpHQPMDYJVgvqP4lkAZxe7Bujld6spm8tuKqnATMZvN4vDwcAsat1RX8vq5+lkJZjwlaPjqp+a9+omFAYp9irM52DjdlG9c6OYxqqra6/f7m263u0ljvDo7O3sS5hpzrmxcrrtdfU2/d6ip5mu9/LEsyd3BwXCzz9PfHBq4PN/v718IBALzXq+34fF4Zo4E0pnURrU+jtONKbwyOYHlSmHbNM2uVCaxbpg66oaGFaVMna8gLRA3sINUKoWhUKgFPI5arWYZhtEmWFSfRep+mvEWpWwRqU1Ns/L5vEWbx++sdDrdieFwGIFHQo6CyDaBZ7xDJF8ikdhkcTrbRBaETuMymYwg9w6oiXtA4xAkgLSaNne3UqnssgAtySadkYj2IZlckdx5AwVvIQnYwHURUfB6krsgUqcEmvFXrpWIgu4FOR+RKTveQjEyMkKrLEm/+ccgAZtqRqrzFz3riUQiXyg7FrDZ+R8BJAGbRYLB4HfgX5LcPrHy2NgY1zbRGaMs65Qi8rPR0VEGMjhtgiDyNzJ0/QXvYtJ0HU94ewAAAABJRU5ErkJggg==" />
                                    </figure>
                                </span>
                                <span v-text="lang('browseFileTitle')"></span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <hr>

            <label class="label" v-text="lang('deleteAllAddonDataAndSettings')"></label>
            <div class="field has-text-weight-bold has-text-danger">
                <span v-text="lang('warning')"></span>
                <span v-html="lang('eraseAddonSettingsWarningTitle')"></span>
            </div>
            <div class="field is-grouped is-align-items-center">
                <div class="control">
                    <button @click="showClearAddonConfirmPopup = true" class="button is-danger">
                        <span class="icon">
                            <figure class="image is-16x16">
                                <img src="/icons/close.svg" data-theme="light" />
                            </figure>
                        </span>
                        <span v-text="lang('clear')"></span>
                    </button>
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
                <div class="columns is-mobile is-multiline">
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
                    <div class="column is-four-fifths">
                        <span>Vitalii Bavykin</span>
                        <span>(Drive4ik)</span>
                        <br>
                        <span v-text="lang('email')"></span>:
                        <a href="mailto:drive4ik+stg@protonmail.com" target="_blank">drive4ik+stg@protonmail.com</a>
                    </div>

                    <div class="column is-one-fifth">
                        <span class="icon-text is-flex-wrap-nowrap">
                            <span class="icon">
                                <figure class="image is-16x16">
                                    <img src="/icons/house.svg" />
                                </figure>
                            </span>
                            <span v-text="lang('homepage')"></span>
                        </span>
                    </div>
                    <div class="column is-four-fifths">
                        <a :href="MANIFEST.homepage_url" target="_blank">
                            <span class="icon-text">
                                <span class="icon">
                                    <figure class="image is-16x16">
                                        <img class="no-fill" src="/icons/github.svg" />
                                    </figure>
                                </span>
                                <span>GitHub</span>
                            </span>
                        </a>
                        <br>
                        <a href="https://addons.mozilla.org/firefox/addon/simple-tab-groups/" target="_blank">
                            <span class="icon-text">
                                <span class="icon">
                                    <figure class="image is-16x16">
                                        <img class="no-fill" src="/icons/extension-generic.svg" />
                                    </figure>
                                </span>
                                <span v-text="lang('aboutExtensionPage')"></span>
                            </span>
                        </a>
                    </div>

                    <div class="column is-one-fifth">
                        <span class="icon-text is-flex-wrap-nowrap">
                            <span class="icon">
                                <figure class="image is-16x16">
                                    <img src="/icons/cubes.svg" />
                                </figure>
                            </span>
                            <span v-text="lang('aboutLibraries')"></span>
                        </span>
                    </div>
                    <div class="column is-four-fifths">
                        <a href="https://v2.vuejs.org/" target="_blank">Vue 2</a><br>
                        <a href="https://saintplay.github.io/vue-swatches/" target="_blank">vue-swatches</a><br>
                        <a href="https://bulma.io/" target="_blank">Bulma</a><br>
                    </div>
                </div>

                <div class="thanks-wrapper mt-6 pb-6">
                    <span class="icon-text">
                        <span class="icon">
                            <figure class="image is-16x16">
                                <img class="heart" src="/icons/heart.svg" />
                            </figure>
                        </span>
                        <span v-text="lang('aboutThanksText')"></span>
                    </span>
                </div>

                <div class="donate-section mb-6">
                    <div class="columns is-mobile is-multiline is-2">
                        <template v-for="(item, name) in DONATE_ITEMS">
                            <div class="column is-one-fifth is-align-content-center">
                                <span class="icon-text">
                                    <span class="icon">
                                        <figure class="image is-16x16">
                                            <img :src="`/icons/logo-${name}.svg`" />
                                        </figure>
                                    </span>
                                    <span v-text="item.title"></span>
                                    <span v-if="item.hasHelp" class="icon" :title="getDonateItemHelp(name)">
                                        <figure class="image is-16x16">
                                            <img src="/icons/info.svg" />
                                        </figure>
                                    </span>
                                </span>
                            </div>
                            <div class="column is-four-fifths">
                                <div class="is-flex is-align-items-center gap-indent">
                                    <a v-if="item.link" data-copy-target :href="item.link" target="_blank" v-text="item.linkText"></a>
                                    <!-- eslint-disable-next-line vue/no-v-text-v-html-on-component -->
                                    <wallet v-else-if="item.wallet" data-copy-target class="is-family-monospace" v-text="item.wallet"></wallet>

                                    <button class="button" @click="copyTextSelector(`.${name} [data-copy-target]`)">
                                        <span class="icon">
                                            <figure class="image is-16x16">
                                                <img src="/icons/copy.svg" />
                                            </figure>
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
                                            <figure class="image is-16x16">
                                                <img src="/icons/qrcode.svg" />
                                            </figure>
                                        </span>
                                    </button>
                                </div>
                            </div>
                        </template>
                    </div>
                </div>

                <div class="block">
                    <div class="has-text-weight-bold mb-5">
                        <a href="https://addons.mozilla.org/firefox/user/1017663/" target="_blank" class="colon" v-text="lang('plugins')"></a>
                    </div>

                    <div v-for="(plugin, uuid) in PLUGINS" :key="uuid" class="field">
                        <span class="icon-text">
                            <figure class="icon image is-16x16">
                                <img :src="getPluginIcon(plugin.id)" alt="plugin icon">
                            </figure>

                            <a :href="plugin.url" target="_blank" v-text="plugin.title"></a>

                            <figure v-if="isInstalledExtension(uuid)" class="icon image is-16x16">
                                <img v-if="isEnabledExtension(uuid)" class="has-text-success" src="/icons/check-square.svg" />
                                <img v-else src="/icons/square-xmark.svg" />
                            </figure>
                        </span>
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
                        {lang: 'restoreBackup', classList: 'is-primary'})
                "
                ></manage-addon-backup>
        </popup>

    </div>
</template>

<style>
    @property --icon-light {
        syntax: "<percentage>";
        inherits: false;
        initial-value: 76%;
    }

    .thanks-wrapper {
        .heart {
            image-rendering: high-quality;
            animation: heartbeat 2.5s ease;
            fill: hsl(0, 100%, var(--icon-light));
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

        .button:has([src*="qrcode"]) {
            &::after {
                --size: 200px;
                width: var(--size);
                height: var(--size);
                border-radius: 5px;
                position: absolute;
                left: calc(100% + var(--gap-indent));
                background-color: var(--bulma-white);
                background-image: var(--image-url);
                background-repeat: round;
                z-index: 1;
            }

            &:focus::after {
                content: '';
            }
        }
    }


    #stg-options {
        .hotkeys {
            --width-normal: 15rem;

            .control:has(.select) {
                min-width: var(--width-normal);
            }

            .input {
                width: var(--width-normal);

                &:focus,
                &.is-palette-danger {
                    outline: 2px solid var(--color);
                    border-color: transparent;
                }
            }
        }
    }

</style>
