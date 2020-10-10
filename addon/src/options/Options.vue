<script>
    'use strict';

    import Vue from 'vue';

    import popup from '../js/popup.vue';
    import swatches from 'vue-swatches';
    import manageAddonBackup from './manage-addon-backup';
    import 'vue-swatches/dist/vue-swatches.css';

    Vue.config.errorHandler = errorEventHandler;

    const SECTION_GENERAL = 'general',
        SECTION_HOTKEYS = 'hotkeys',
        SECTION_BACKUP = 'backup',
        funcKeys = [...Array(12).keys()].map(n => KeyEvent[`DOM_VK_F${n + 1}`]),
        folderNameRegExp = /[\<\>\:\"\/\\\|\?\*\x00-\x1F]|^(?:aux|con|nul|prn|com\d|lpt\d)$|^\.+|\.+$/gi;

    document.title = browser.i18n.getMessage('openSettings');

    export default {
        data() {
            return {
                SECTION_GENERAL,
                SECTION_HOTKEYS,
                SECTION_BACKUP,

                section: window.localStorage.optionsSection || SECTION_GENERAL,

                hotkeyActions: [
                    'load-next-group',
                    'load-prev-group',
                    'load-next-unloaded-group',
                    'load-prev-unloaded-group',
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
                ],

                actionsWithCustomGroup: [
                    'load-custom-group',
                    'move-selected-tabs-to-custom-group',
                    'discard-group',
                    'rename-group',
                ],

                GROUP_ICON_VIEW_TYPES: GROUP_ICON_VIEW_TYPES,

                includeTabThumbnailsIntoBackup: false,
                includeTabFavIconsIntoBackup: true,

                options: {},
                groups: [],
                isMac: false,

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

                showEnableDarkThemeNotification: false,

                enableDebug: window.localStorage.enableDebug || false,
            };
        },
        components: {
            popup: popup,
            swatches: swatches,
            'manage-addon-backup': manageAddonBackup,
        },
        async created() {
            let {os} = await browser.runtime.getPlatformInfo();
            this.isMac = os === browser.runtime.PlatformOs.MAC;

            let data = await storage.get(null);

            let options = utils.assignKeys({}, data, ALL_OPTIONS_KEYS);

            options.autoBackupFolderName = await file.getAutoBackupFolderName();

            this.permissions.bookmarks = await browser.permissions.contains(PERMISSIONS.BOOKMARKS);

            this.options = options;
            this.groups = data.groups;

            this.options.hotkeys.forEach(function(hotkey) {
                if (this.actionsWithCustomGroup.includes(hotkey.action) && hotkey.groupId && !this.groups.some(gr => gr.id === hotkey.groupId)) {
                    hotkey.groupId = 0;
                }
            }, this);

            this.loadBookmarksParents();

            [
                ...ONLY_BOOL_OPTION_KEYS,
                'defaultBookmarksParent',
                'defaultGroupIconViewType',
                'defaultGroupIconColor',
                'autoBackupIntervalKey'
                ]
                .forEach(function(option) {
                    this.$watch(`options.${option}`, function(newValue) {
                        BG.saveOptions({
                            [option]: newValue,
                        });
                    });
                }, this);

            browser.runtime.onMessage.addListener(({action}) => 'i-am-back' === action && window.location.reload());
        },
        mounted() {
            if (this.enableDebug === '2') {
                setTimeout(() => this.scrollToLoggingDesc(), 1000);
            }
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

                BG.saveOptions({
                    autoBackupFolderName: value,
                });
            },
            'options.autoBackupBookmarksFolderName': function(value, oldValue) {
                if (!value || null == oldValue) {
                    return;
                }

                while (folderNameRegExp.exec(value)) {
                    value = value.replace(folderNameRegExp, '').trim();
                }

                if (!value.length || value.length > 200) {
                    value = DEFAULT_OPTIONS.autoBackupBookmarksFolderName;
                }

                BG.saveOptions({
                    autoBackupBookmarksFolderName: value,
                });
            },
            'options.autoBackupGroupsToFile': function(value, oldValue) {
                if (null == oldValue) {
                    return;
                }

                if (!value && !this.options.autoBackupGroupsToBookmarks) {
                    this.options.autoBackupGroupsToBookmarks = true;
                }
            },
            'options.autoBackupGroupsToBookmarks': function(value, oldValue) {
                if (null == oldValue) {
                    return;
                }

                if (!value && !this.options.autoBackupGroupsToFile) {
                    this.options.autoBackupGroupsToFile = true;
                }
            },
            'options.autoBackupIntervalValue': function(value, oldValue) {
                if (!value || null == oldValue) {
                    return;
                }

                if (1 > value || 20 < value) {
                    value = 1;
                }

                BG.saveOptions({
                    autoBackupIntervalValue: value,
                });
            },
            'options.enableDarkTheme': function(enableDarkTheme, oldValue) {
                if (enableDarkTheme) {
                    document.documentElement.classList.add('dark-theme');
                } else {
                    document.documentElement.classList.remove('dark-theme');
                }

                if (null == oldValue) {
                    return;
                }

                if (enableDarkTheme) {
                    this.showEnableDarkThemeNotification = true;
                }
            },
            'options.temporaryContainerTitle': function(temporaryContainerTitle, oldValue) {
                if (!temporaryContainerTitle || null == oldValue) {
                    return;
                }

                BG.saveOptions({
                    temporaryContainerTitle,
                });
            },
            'options.hotkeys': {
                handler(hotkeys, oldValue) {
                    if (null == oldValue) {
                        return;
                    }

                    let filteredHotkeys = hotkeys.filter(function(hotkey) {
                        if (!hotkey.action) {
                            return false;
                        }

                        if (!hotkey.keyCode && !hotkey.key) {
                            return false;
                        }

                        if (!(hotkey.ctrlKey || hotkey.shiftKey || hotkey.altKey || hotkey.metaKey || funcKeys.includes(hotkey.keyCode))) {
                            return false;
                        }

                        return true;
                    }, this);

                    BG.saveOptions({
                        hotkeys: filteredHotkeys,
                    });
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
            async enableDebug(enableDebug) {
                let wasAutoDebug = null;

                if (enableDebug) {
                    window.localStorage.enableDebug = 1;
                } else {
                    wasAutoDebug = window.localStorage.enableDebug == 2;
                    delete window.localStorage.enableDebug;
                }

                console.restart();

                if (!window.localStorage.enableDebug) {
                    await this.saveConsoleLogs();

                    if (wasAutoDebug) {
                        utils.safeReloadAddon();
                    }
                }
            },
        },
        computed: {
            isDisabledAutoBackupGroupsToFile() {
                if (!this.permissions.bookmarks) {
                    this.options.autoBackupGroupsToFile = true;
                    return true;
                }

                return false;
            },
        },
        methods: {
            lang: browser.i18n.getMessage,
            getHotkeyActionTitle: action => browser.i18n.getMessage('hotkeyActionTitle' + utils.capitalize(utils.toCamelCase(action))),

            scrollToLoggingDesc() {
                this.section = SECTION_GENERAL;

                this.$nextTick(() => utils.scrollTo('#logging-description'));
            },

            openBackupFolder: file.openBackupFolder,

            saveHotkeyKeyCodeAndStopEvent(hotkey, event, withKeyCode) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();

                if (!event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
                    hotkey.key = event.key.length === 1 ? event.key.toUpperCase() : event.key;

                    if (withKeyCode) {
                        hotkey.keyCode = event.keyCode;
                    }
                }
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

                BG.restoreBackup(data, clearAddonData);
            },

            exportAddonSettings() {
                BG.createBackup(this.includeTabFavIconsIntoBackup, this.includeTabThumbnailsIntoBackup);
            },

            async importAddonSettings() {
                let data = null;

                try {
                    data = await file.load();
                } catch (e) {
                    utils.notify(e);
                    return;
                }

                if ('object' !== utils.type(data) || !Array.isArray(data.groups) || !Number.isFinite(data.lastCreatedGroupPosition)) {
                    utils.notify('This is wrong backup!');
                    return;
                }

                try {
                    await BG.runMigrateForData(data); // run migration for data
                } catch (e) {
                    utils.notify(e);
                    return;
                }

                this.setManageAddonSettings(data, 'importAddonSettingsTitle', false, true);
            },

            async importSettingsOldTabGroupsAddonButton() {
                let oldOptions = null;

                try {
                    oldOptions = await file.load();
                } catch (e) {
                    utils.notify(e);
                    return;
                }

                if (!oldOptions || !Array.isArray(oldOptions.windows) || !oldOptions.session) {
                    utils.notify('This is not "Tab Groups" backup!');
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
                        utils.notify('Error: cannot parse backup file - ' + e);
                        return;
                    }

                    Object.values(oldGroups).forEach(function({id, title, catchRules}) {
                        groups[id] = {
                            title: title || id,
                            tabs: [],
                            catchTabRules: catchRules || '',
                        };
                    });

                    win.tabs.forEach(function(oldTab) {
                        let tabData = {},
                            tab = oldTab.entries.pop();

                        tab = utils.normalizeTabUrl(tab);

                        if (!utils.isUrlAllowToCreate(tab.url)) {
                            return;
                        }

                        if (oldTab.pinned) {
                            data.pinnedTabs.push({
                                title: tab.title,
                                url: tab.url,
                                pinned: true,
                                openInReaderMode: tab.openInReaderMode,
                            });
                            return;
                        }

                        try {
                            tabData = JSON.parse(oldTab.extData['tabview-tab']);
                            if (!tabData || !tabData.groupID) {
                                return;
                            }
                        } catch (e) {
                            return utils.notify('Cannot parse groups: ' + e);
                        }

                        if (groups[tabData.groupID]) {
                            groups[tabData.groupID].tabs.push({
                                title: tab.title,
                                url: tab.url,
                                groupId: groups[tabData.groupID].id,
                                openInReaderMode: tab.openInReaderMode,
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
                    panoramaOptions = await file.load();
                } catch (e) {
                    utils.notify(e);
                    return;
                }

                if (!panoramaOptions || !panoramaOptions.file || 'panoramaView' !== panoramaOptions.file.type || !Array.isArray(panoramaOptions.windows)) {
                    utils.notify('This is not "Panorama View" backup!');
                    return;
                }

                if (1 !== panoramaOptions.file.version) {
                    utils.notify('"Panorama View" backup has unsupported version');
                    return;
                }

                let data = {
                    groups: [],
                    pinnedTabs: [],
                };

                panoramaOptions.windows.forEach(function(win) {
                    let groups = {};

                    win.groups.forEach(function({id, name}) {
                        groups[id] = {
                            title: name || id,
                            tabs: [],
                        };
                    });

                    win.tabs.forEach(function({url, title, pinned, groupId}) {
                        url = utils.normalizeUrl(url);

                        if (utils.isUrlAllowToCreate(url)) {
                            if (pinned) {
                                data.pinnedTabs.push({url, title, pinned});
                            } else if (groups[groupId]) {
                                groups[groupId].tabs.push({url, title});
                            }
                        }
                    });

                    data.groups.push(...Object.values(groups));
                });

                this.setManageAddonSettings(data, 'importSettingsPanoramaViewAddonTitle', true);
            },

            async importSettingsSyncTabGroupsAddonButton() {
                let syncTabOptions = null;

                try {
                    syncTabOptions = await file.load();
                } catch (e) {
                    utils.notify(e);
                    return;
                }

                if (!syncTabOptions || !syncTabOptions.version || 'syncTabGroups' !== syncTabOptions.version[0] || !Array.isArray(syncTabOptions.groups)) {
                    utils.notify('This is not "Sync Tab Groups" backup!');
                    return;
                }

                if (1 !== syncTabOptions.version[1]) {
                    utils.notify('"Sync Tab Groups" backup has unsupported version');
                    return;
                }

                let data = {
                    groups: [],
                    pinnedTabs: [],
                };

                syncTabOptions.groups.forEach(function({id, title, tabs}) {
                    tabs = tabs
                        .map(function({url, title, favIconUrl, pinned, isInReaderMode}) {
                            url = utils.normalizeUrl(url);

                            if (utils.isUrlAllowToCreate(url)) {
                                return {url, title, favIconUrl, pinned, isInReaderMode};
                            }
                        })
                        .filter(Boolean);

                    data.groups.push({
                        title: title || id,
                        tabs: tabs.filter(tab => !tab.pinned),
                    });

                    data.pinnedTabs.push(...tabs.filter(tab => tab.pinned));
                });

                this.setManageAddonSettings(data, 'importSettingsSyncTabGroupsAddonTitle', true);
            },

            runClearAddonConfirm() {
                this.showClearAddonConfirmPopup = false;
                this.showLoadingMessage = true;
                BG.clearAddon();
            },

            getIconTypeUrl(iconType) {
                return utils.getGroupIconUrl({
                    iconViewType: iconType,
                    iconColor: this.options.defaultGroupIconColor || 'rgb(66, 134, 244)',
                });
            },

            createHotkey() {
                return {
                    ctrlKey: false,
                    shiftKey: false,
                    altKey: false,
                    metaKey: false,
                    key: '',
                    keyCode: 0,
                    action: '',
                    groupId: 0,
                };
            },

            async setPermissionsBookmarks(event) {
                if (event.target.checked) {
                    this.permissions.bookmarks = await browser.permissions.request(PERMISSIONS.BOOKMARKS);
                } else {
                    await browser.permissions.remove(PERMISSIONS.BOOKMARKS);
                }

                this.loadBookmarksParents();

                BG.updateMoveTabMenus();
            },

            async loadBookmarksParents() {
                if (this.defaultBookmarksParents.length) {
                    return;
                }

                this.permissions.bookmarks = await browser.permissions.contains(PERMISSIONS.BOOKMARKS);

                if (this.permissions.bookmarks) {
                    this.defaultBookmarksParents = await browser.bookmarks.get(DEFAULT_BOOKMARKS_PARENTS);
                }
            },

            getGroupIconUrl(group) {
                return utils.getGroupIconUrl(group);
            },

            async saveConsoleLogs() {
                let urls = {},
                    index = 1;

                let logs = console.getLogs();

                function normalize(obj) {
                    if (Array.isArray(obj)) {
                        return obj.map(normalize);
                    } else if ('object' === utils.type(obj)) {
                        for (let key in obj) {
                            if (['title', 'icon', 'icons', 'iconUrl', 'favIconUrl', 'thumbnail', 'filename'].includes(key)) {
                                obj[key] = obj[key] ? ('some ' + key) : obj[key];
                            } else {
                                obj[key] = normalize(obj[key]);
                            }
                        }

                        return obj;
                    } else if (String(obj).startsWith('data:image')) {
                        return 'some data:image';
                    } else if (String(obj).startsWith('http')) {
                        return urls[obj] || (urls[obj] = 'URL_' + index++);
                    } else if (String(obj).startsWith('file:')) {
                        return urls[obj] || (urls[obj] = 'FILE_' + index++);
                    }

                    return obj;
                }

                logs = normalize(logs);

                await file.save({
                    info: await utils.getInfo(),
                    logs: logs,
                }, 'STG-debug-logs.json');
            },
        },
    }
</script>

<template>
    <div id="stg-options">
        <div id="logging-notification" @click="scrollToLoggingDesc" v-if="enableDebug === '2'">
            <span v-html="lang('loggingIsAutoEnabledTitle')"></span>
        </div>

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
            <div class="field h-margin-left-10">
                <label class="checkbox" :disabled="!permissions.bookmarks">
                    <input v-if="permissions.bookmarks" v-model="options.exportGroupToMainBookmarkFolder" type="checkbox" />
                    <input v-else disabled="" type="checkbox" />
                    <span v-text="lang('exportGroupToMainBookmarkFolder', options.autoBackupBookmarksFolderName)"></span>
                </label>
            </div>
            <div class="field h-margin-left-10">
                <label class="checkbox" :disabled="!permissions.bookmarks">
                    <input v-if="permissions.bookmarks" v-model="options.leaveBookmarksOfClosedTabs" type="checkbox" />
                    <input v-else disabled="" type="checkbox" />
                    <span v-text="lang('leaveBookmarksOfClosedTabs')"></span>
                </label>
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
                    <input v-model="options.discardTabsAfterHide" type="checkbox" />
                    <span v-text="lang('discardTabsAfterHide')"></span>
                </label>
            </div>
            <div class="field">
                <label class="checkbox">
                    <input v-model="options.reverseTabsOnCreate" type="checkbox" />
                    <span v-html="lang('reverseTabsOnCreate')"></span>
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
                    <input v-model="options.showExtendGroupsPopupWithActiveTabs" type="checkbox" />
                    <span v-text="lang('showExtendGroupsPopupWithActiveTabs')"></span>
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
                    <input v-model="options.alwaysAskNewGroupName" type="checkbox" />
                    <span v-text="lang('alwaysAskNewGroupName')"></span>
                </label>
            </div>
            <div class="field">
                <label class="checkbox">
                    <input v-model="options.prependGroupTitleToWindowTitle" type="checkbox" />
                    <span v-text="lang('prependGroupTitleToWindowTitle')"></span>
                </label>
            </div>
            <div class="field">
                <label class="checkbox">
                    <input v-model="options.showNotificationAfterMoveTab" type="checkbox" />
                    <span v-text="lang('showNotificationAfterMoveTab')"></span>
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
                <label class="label" v-text="lang('temporaryContainerTitleDescription')"></label>
                <div class="control">
                    <input v-model.lazy.trim="options.temporaryContainerTitle" class="input tmp-container-input" type="text" :placeholder="lang('temporaryContainerTitle')">
                </div>
            </div>

            <hr>

            <div class="field">
                <label class="checkbox">
                    <input v-model="options.enableDarkTheme" type="checkbox" />
                    <span v-text="lang('enableDarkTheme')"></span>
                </label>
            </div>

            <div class="field">
                <label class="label" v-text="lang('enterDefaultGroupIconViewTypeTitle')"></label>
                <div class="field is-grouped">
                    <div class="control">
                        <swatches v-model.trim="options.defaultGroupIconColor" :title="lang('iconColor')" swatches="text-advanced" popover-x="right" show-fallback :trigger-style="{
                            width: '40px',
                            height: '33px',
                            borderRadius: '4px',
                        }" />
                    </div>
                    <div v-for="iconViewType in GROUP_ICON_VIEW_TYPES" :key="iconViewType" class="control">
                        <button
                            @click="options.defaultGroupIconViewType = iconViewType"
                            :class="['button', {'is-focused': options.defaultGroupIconViewType === iconViewType}]"
                            >
                            <figure class="image is-16x16 is-inline-block">
                                <img :src="getIconTypeUrl(iconViewType)" />
                            </figure>
                        </button>
                    </div>
                </div>
            </div>

            <hr/>

            <div class="field is-grouped is-grouped-multiline">
                <div class="control">
                    <label class="checkbox">
                        <input type="checkbox" v-model="enableDebug" />
                        <span v-text="lang('enableDebugTitle')"></span>
                    </label>
                </div>
                <div v-if="enableDebug" class="control">
                    <img class="size-16 debug-record" src="resource://usercontext-content/circle.svg">
                    <span v-text="enableDebug === '2' ? lang('loggingIsAutoEnabledTitle') : lang('loggingIsEnabledTitle')"></span>
                </div>
            </div>

            <div id="logging-description" class="field" v-html="lang('loggingDescription')"></div>
        </div>

        <div v-show="section === SECTION_HOTKEYS">
            <label class="has-text-weight-bold" v-text="lang('hotkeysTitle')"></label>
            <div class="h-margin-bottom-10" v-html="lang('hotkeysDescription')"></div>
            <div class="h-margin-bottom-10" v-html="lang('hotkeysDescription2')"></div>
            <div class="hotkeys">
                <div v-for="(hotkey, hotkeyIndex) in options.hotkeys" :key="hotkeyIndex" class="field">
                    <div class="is-flex is-align-items-center">
                        <label class="checkbox">
                            <input v-model="hotkey.ctrlKey" type="checkbox" />
                            <span v-if="isMac">Control</span>
                            <span v-else>Ctrl</span>
                        </label>
                        <label class="checkbox">
                            <input v-model="hotkey.shiftKey" type="checkbox" />
                            <span>Shift</span>
                        </label>
                        <label class="checkbox">
                            <input v-model="hotkey.altKey" type="checkbox" />
                            <span v-if="isMac">Option</span>
                            <span v-else>Alt</span>
                        </label>
                        <label v-if="isMac" class="checkbox">
                            <input v-model="hotkey.metaKey" type="checkbox" />
                            <span>Command</span>
                        </label>
                        <div class="control input-command">
                            <input type="text" @keydown="saveHotkeyKeyCodeAndStopEvent(hotkey, $event, true)" :value="hotkey.key" autocomplete="off" class="input" :placeholder="lang('hotkeyPlaceholder')" tabindex="-1" />
                        </div>
                        <div class="select">
                            <select v-model="hotkey.action">
                                <option v-if="!hotkey.action" selected disabled value="" v-text="lang('selectAction')"></option>
                                <option v-for="action in hotkeyActions" :key="action" :value="action" v-text="getHotkeyActionTitle(action)"></option>
                            </select>
                        </div>
                        <div class="delete-button">
                            <span @click="options.hotkeys.splice(hotkeyIndex, 1)" class="cursor-pointer" :title="lang('deleteHotKeyButton')">
                                <img class="size-16" src="/icons/delete.svg" />
                            </span>
                        </div>
                    </div>

                    <div v-if="actionsWithCustomGroup.includes(hotkey.action)" class="is-flex is-align-items-center custom-group">
                        <div :class="['control', {'has-icons-left': groups.some(gr => gr.id === hotkey.groupId)}]">
                            <div class="select">
                                <select v-model.number="hotkey.groupId">
                                    <option :value="0" v-text="lang('selectGroup')"></option>
                                    <option v-for="group in groups" :key="group.id" :value="group.id" v-text="group.title"></option>
                                </select>
                            </div>
                            <span class="icon is-left" v-if="groups.some(gr => gr.id === hotkey.groupId)">
                                <img class="size-16" :src="getGroupIconUrl(groups.find(gr => gr.id === hotkey.groupId))">
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

                    <div class="field is-flex is-align-items-center indent-children">
                        <div class="h-margin-right-5" v-html="lang('autoBackupCreateEveryTitle')"></div>
                        <div class="field has-addons">
                            <div class="control">
                                <input type="number" class="input backup-time-input" v-model.number="options.autoBackupIntervalValue" min="1" max="20" />
                            </div>
                            <div class="control">
                                <div class="select">
                                    <select v-model="options.autoBackupIntervalKey">
                                        <option value="hours" v-text="lang('autoBackupIntervalKeyHours')"></option>
                                        <option value="days" v-text="lang('autoBackupIntervalKeyDays')"></option>
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
                        <label class="checkbox" :disabled="isDisabledAutoBackupGroupsToFile">
                            <input v-model="options.autoBackupGroupsToFile" :disabled="isDisabledAutoBackupGroupsToFile" type="checkbox" />
                            <span v-text="lang('autoBackupGroupsToFile')"></span>
                        </label>
                        <div class="field is-grouped is-align-items-center">
                            <div class="control">
                                <label class="field" v-text="lang('folderNameTitle') + ':'"></label>
                            </div>
                            <div class="control">
                                <input type="text" v-model.trim="options.autoBackupFolderName" :disabled="!options.autoBackupGroupsToFile" maxlength="200" class="input" />
                            </div>
                            <div class="control">
                                <button class="button" @click="openBackupFolder" v-text="lang('openBackupFolder')"></button>
                            </div>
                        </div>
                    </div>

                    <!-- bookmarks -->
                    <div class="field">
                        <label class="checkbox" :disabled="!permissions.bookmarks">
                            <input v-if="permissions.bookmarks" v-model="options.autoBackupGroupsToBookmarks" type="checkbox" />
                            <input v-else disabled="" type="checkbox" />
                            <span v-text="lang('autoBackupGroupsToBookmarks')"></span>
                        </label>
                        <div class="field is-grouped is-align-items-center">
                            <div class="control">
                                <label class="field" v-text="lang('folderNameTitle') + ':'"></label>
                            </div>
                            <div class="control">
                                <input type="text"
                                v-model.trim="options.autoBackupBookmarksFolderName"
                                :disabled="!options.autoBackupGroupsToBookmarks || !permissions.bookmarks"
                                maxlength="200" class="input" />
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
                        <button @click="importAddonSettings" class="button is-primary">
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
                    <button @click="importSettingsOldTabGroupsAddonButton" class="button is-primary">
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
                    <button @click="importSettingsPanoramaViewAddonButton" class="button is-primary">
                        <span class="icon">
                            <img class="size-16" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAiklEQVR42mP4KO/o/UXJ/slXRfv/2PBnBfs3DFDgExj61i8o7D8I+waGPvb0DfFk+Kxo9xiXZhiGGQDTDMM+gSGPGAhpxmcACA8HA0ChjE8zciwAQ/4NsmYQn2HgAXLiQHcWuhw6BqvFGjB4Ag1D7TAwAJSryDUAnJlAWRLZEORYQE846Jq9/AI9AD3nkgARmnBEAAAAAElFTkSuQmCC" />
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
                    <button @click="importSettingsSyncTabGroupsAddonButton" class="button is-primary">
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
                                <img class="size-16" src="/icons/close.svg" style="fill: #ffffff" />
                            </span>
                            <span class="h-margin-left-5" v-text="lang('clear')"></span>
                        </button>
                    </div>
                </div>
            </div>

        </div>

        <popup
            v-if="showEnableDarkThemeNotification"
            :title="lang('enableDarkTheme')"
            @close-popup="showEnableDarkThemeNotification = false"
            :buttons="
                [{
                    event: 'close-popup',
                    lang: 'ok',
                    classList: 'is-success',
                }]
            ">
            <span v-html="lang('enableDarkThemeNotification')"></span>
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
            :title="lang(manageAddonSettingsTitle)"
            @close-popup="manageAddonSettings = null"
            @save="() => saveManagedAddonSettings($refs.manageAddonBackup.getData(), $refs.manageAddonBackup.clearAddonData)"
            :buttons="
                [{
                    event: 'save',
                    lang: 'ok',
                    classList: 'is-primary',
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
                ></manage-addon-backup>
        </popup>

    </div>
</template>

<style lang="scss">
    body {
        // background-color: #f9f9fa;
        transition: background-color ease .2s;
    }

    #logging-notification {
        display: flex;
        height: 30px;
        background-color: rgba(255, 123, 123, 0.5);
        align-items: center;
        justify-content: center;
        cursor: pointer;
        margin-bottom: 10px;
        border-radius: 5px;
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

    html.dark-theme {
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

</style>
