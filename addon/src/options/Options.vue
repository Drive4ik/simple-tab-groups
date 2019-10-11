<script>
    'use strict';

    import Vue from 'vue';

    import utils from '../js/utils';
    import storage from '../js/storage';
    import constants from '../js/constants';
    import file from '../js/file';
    import Groups from '../js/groups';
    import Tabs from '../js/tabs';
    import Windows from '../js/windows';

    import popup from '../js/popup.vue';
    import swatches from 'vue-swatches';
    import 'vue-swatches/dist/vue-swatches.min.css';

    const {BG} = browser.extension.getBackgroundPage();

    window.addEventListener('error', utils.errorEventHandler);
    Vue.config.errorHandler = utils.errorEventHandler;

    const SECTION_GENERAL = 'general',
        SECTION_HOTKEYS = 'hotkeys',
        SECTION_BACKUP = 'backup',
        SECTION_DEFAULT = SECTION_GENERAL,
        _funcKeys = [...Array(12).keys()].map(n => n + 1),
        isFunctionKey = keyCode => _funcKeys.some(n => keyCode === KeyEvent[`DOM_VK_F${n}`]),
        folderNameRegExp = /[\.\<\>\:\"\/\\\|\?\*\x00-\x1F]|^(?:aux|con|nul|prn|com\d|lpt\d)$/gi;

    export default {
        data() {
            return {
                SECTION_GENERAL,
                SECTION_HOTKEYS,
                SECTION_BACKUP,

                section: SECTION_DEFAULT,

                hotkeyActions: [
                    'load-next-group',
                    'load-prev-group',
                    'load-history-next-group',
                    'load-history-prev-group',
                    'load-first-group',
                    'load-last-group',
                    'load-custom-group',
                    'add-new-group',
                    'delete-current-group',
                    'open-manage-groups',
                    'move-active-tab-to-custom-group',
                    'discard-group',
                    'discard-other-groups',
                ],

                actionsWithCustomGroup: [
                    'load-custom-group',
                    'move-active-tab-to-custom-group',
                    'discard-group',
                ],

                groupIconViewTypes: constants.groupIconViewTypes,

                includeTabThumbnailsIntoBackup: false,
                includeTabFavIconsIntoBackup: true,

                options: {},
                groups: [],
                isMac: false,

                permissions: {
                    bookmarks: false,
                },

                defaultBookmarksParents: [],

                showLoadingMessage: false,

                showEnableDarkThemeNotification: false,

                enableDebug: !!window.localStorage.enableDebug,
                errorLogs: utils.getErrorLogs(),
            };
        },
        components: {
            popup: popup,
            swatches: swatches,
        },
        async created() {
            let {os} = await browser.runtime.getPlatformInfo();
            this.isMac = os === browser.runtime.PlatformOs.MAC;

            let data = await storage.get(null);

            this.options = utils.extractKeys(data, constants.allOptionsKeys);
            this.groups = data.groups;

            this.options.hotkeys.forEach(function(hotkey) {
                if (this.actionsWithCustomGroup.includes(hotkey.action) && hotkey.groupId && !this.groups.some(gr => gr.id === hotkey.groupId)) {
                    hotkey.groupId = 0;
                }
            }, this);

            this.permissions.bookmarks = await browser.permissions.contains(constants.PERMISSIONS.BOOKMARKS);

            this.loadBookmarksParents();

            [
                ...constants.onlyBoolOptionsKeys,
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
        watch: {
            'options.autoBackupFolderName': function(value, oldValue) {
                if (!value || null == oldValue) {
                    return;
                }

                value = value.replace(folderNameRegExp, '');

                if (!value.length || value.length > 200) {
                    value = constants.DEFAULT_OPTIONS.autoBackupFolderName;
                }

                BG.saveOptions({
                    autoBackupFolderName: value,
                });
            },
            'options.autoBackupBookmarksFolderName': function(value, oldValue) {
                if (!value || null == oldValue) {
                    return;
                }

                value = value.replace(folderNameRegExp, '');

                if (!value.length || value.length > 200) {
                    value = constants.DEFAULT_OPTIONS.autoBackupBookmarksFolderName;
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

                        if (!(hotkey.ctrlKey || hotkey.shiftKey || hotkey.altKey || hotkey.metaKey || isFunctionKey(hotkey.keyCode))) {
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
            enableDebug(enableDebug) {
                if (enableDebug) {
                    window.localStorage.enableDebug = 1;
                } else {
                    delete window.localStorage.enableDebug;
                }

                BG.console.restart();
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

            async importAddonSettings() {
                let data = null;

                try {
                    data = await file.load();
                } catch (e) {
                    utils.notify(String(e));
                    return;
                }

                if ('object' !== utils.type(data) || !Array.isArray(data.groups) || !Number.isFinite(data.lastCreatedGroupPosition)) {
                    utils.notify('this is wrong backup!');
                    return;
                }

                this.showLoadingMessage = true;

                BG.events.removeEvents();

                await BG.loadingBrowserAction();

                try {
                    data = await BG.runMigrateForData(data); // run migration for data
                    delete data.withoutSession;
                } catch (e) {
                    utils.notify(String(e));
                    return;
                }

                if (data.pinnedTabs) {
                    let currentPinnedTabs = await Tabs.get(null, true, null);

                    data.pinnedTabs = data.pinnedTabs.filter(function(tab) {
                        tab.pinned = true;
                        return tab.url && !currentPinnedTabs.some(t => t.url === tab.url) && utils.isUrlAllowToCreate(tab.url);
                    });

                    if (data.pinnedTabs) {
                        await BG.createTabsSafe(data.pinnedTabs, false, false, false);
                    }

                    delete data.pinnedTabs;
                }

                let windows = await Windows.load(true);

                await BG.syncTabs(data.groups, windows);

                if (!this.isMac) {
                    data.hotkeys.forEach(hotkey => hotkey.metaKey = false);
                }

                data.isBackupRestoring = true;

                await storage.set(data);

                browser.runtime.reload(); // reload addon
            },

            exportAddonSettings() {
                BG.createBackup(this.includeTabThumbnailsIntoBackup, this.includeTabFavIconsIntoBackup);
            },

            async importSettingsOldTabGroupsAddonButton() {
                let oldOptions = null;

                try {
                    oldOptions = await file.load();
                } catch (e) {
                    utils.notify(String(e));
                    return;
                }

                if (!oldOptions || !Array.isArray(oldOptions.windows) || !oldOptions.session) {
                    utils.notify('This is not "Tab Groups" backup!');
                    return;
                }

                this.showLoadingMessage = true;

                let {lastCreatedGroupPosition} = await storage.get('lastCreatedGroupPosition'),
                    newGroups = [],
                    tabsToCreate = [];

                oldOptions.windows.forEach(function(win) {
                    let oldGroups = {},
                        groups = {};

                    try {
                        oldGroups = JSON.parse(win.extData['tabview-group']);
                    } catch (e) {
                        utils.notify('Error: cannot parse backup file - ' + e);
                        return;
                    }

                    Object.values(oldGroups).forEach(function(oldGroup) {
                        lastCreatedGroupPosition++;

                        groups[oldGroup.id] = Groups.create(lastCreatedGroupPosition, utils.createGroupTitle(oldGroup.title, oldGroup.id));
                        groups[oldGroup.id].catchTabRules = oldGroup.catchRules || '';
                    });

                    win.tabs.forEach(function(oldTab) {
                        let tabData = {},
                            tab = oldTab.entries.pop();

                        if (tab.url.startsWith('about:reader')) {
                            tab.url = decodeURIComponent(tab.url.slice(17));
                            tab.openInReaderMode = true;
                        } else {
                            tab.openInReaderMode = false;
                        }

                        if (oldTab.pinned) {
                            tabsToCreate.push({
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
                            tabsToCreate.push({
                                title: tab.title,
                                url: tab.url,
                                groupId: groups[tabData.groupID].id,
                                openInReaderMode: tab.openInReaderMode,
                            });
                        }
                    });

                    newGroups.push(...Object.values(groups));
                });

                await this._saveImportedGroups(newGroups, tabsToCreate, lastCreatedGroupPosition);

                this.showLoadingMessage = false;
            },

            async importSettingsPanoramaViewAddonButton() {
                let panoramaOptions = null;

                try {
                    panoramaOptions = await file.load();
                } catch (e) {
                    utils.notify(String(e));
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

                this.showLoadingMessage = true;

                let {lastCreatedGroupPosition} = await storage.get('lastCreatedGroupPosition'),
                    newGroups = [],
                    tabsToCreate = [];

                panoramaOptions.windows.forEach(function(win) {
                    let groups = {};

                    win.groups.forEach(function(group) {
                        lastCreatedGroupPosition++;

                        groups[group.id] = Groups.create(lastCreatedGroupPosition, group.name);
                    });

                    win.tabs.forEach(function(tab) {
                        if (!groups[tab.groupId]) {
                            return;
                        }

                        tab.groupId = groups[tab.groupId].id;

                        tabsToCreate.push(tab);
                    });

                    newGroups.push(...Object.values(groups));
                });

                await this._saveImportedGroups(newGroups, tabsToCreate, lastCreatedGroupPosition);

                this.showLoadingMessage = false;
            },

            async importSettingsSyncTabGroupsAddonButton() {
                let syncTabOptions = null;

                try {
                    syncTabOptions = await file.load();
                } catch (e) {
                    utils.notify(String(e));
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

                this.showLoadingMessage = true;

                let {lastCreatedGroupPosition} = await storage.get('lastCreatedGroupPosition'),
                    newGroups = [],
                    tabsToCreate = [],
                    groups = {};

                syncTabOptions.groups.forEach(function(group) {
                    lastCreatedGroupPosition++;

                    groups[group.id] = Groups.create(lastCreatedGroupPosition, group.title);

                    group.tabs.forEach(function(tab) {
                        tab.groupId = groups[group.id].id;
                        tabsToCreate.push(tab);
                    });
                });

                await this._saveImportedGroups(Object.values(groups), tabsToCreate, lastCreatedGroupPosition);

                this.showLoadingMessage = false;
            },

            async _saveImportedGroups(newGroups, tabsToCreate, lastCreatedGroupPosition) {
                let groups = await Groups.load();
                groups.push(...newGroups);
                await Groups.save(groups);

                await storage.set({lastCreatedGroupPosition});

                let tabs = tabsToCreate
                    .map(function(tab) {
                        tab.url = utils.normalizeUrl(tab.url);
                        return tab;
                    })
                    .filter(tab => tab.url && utils.isUrlAllowToCreate(tab.url))
                    .map(function(tab) {
                        delete tab.active;
                        delete tab.windowId;

                        return tab;
                    });

                await BG.createTabsSafe(tabs, true);

                utils.notify(browser.i18n.getMessage('backupSuccessfullyRestored'));
            },

            async saveErrorLogsIntoFile() {
                file.save({
                    info: await utils.getInfo(),
                    logs: utils.getErrorLogs(),
                }, 'STG-error-logs.json');
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
                    this.permissions.bookmarks = await browser.permissions.request(constants.PERMISSIONS.BOOKMARKS);
                } else {
                    await browser.permissions.remove(constants.PERMISSIONS.BOOKMARKS);
                }

                this.loadBookmarksParents();

                BG.updateMoveTabMenus();
            },

            async loadBookmarksParents() {
                if (this.defaultBookmarksParents.length) {
                    return;
                }

                this.permissions.bookmarks = await browser.permissions.contains(constants.PERMISSIONS.BOOKMARKS);

                if (this.permissions.bookmarks) {
                    this.defaultBookmarksParents = await BG.browser.bookmarks.get(constants.defaultBookmarksParents);
                }
            },
        },
    }
</script>

<template>
    <div id="stg-options">
        <div class="tabs is-fullwidth">
            <ul>
                <li :class="{'is-active': section === SECTION_GENERAL}" @click="section = SECTION_GENERAL">
                    <a>
                        <span class="icon">
                            <img class="size-16" src="/icons/cog.svg">
                        </span>
                        <span v-text="lang('generalTitle')"></span>
                    </a>
                </li>
                <li :class="{'is-active': section === SECTION_HOTKEYS}" @click="section = SECTION_HOTKEYS">
                    <a>
                        <span class="icon">
                            <img class="size-16" src="/icons/keyboard-o.svg">
                        </span>
                        <span v-text="lang('hotkeysTitle')"></span>
                    </a>
                </li>
                <li :class="{'is-active': section === SECTION_BACKUP}" @click="section = SECTION_BACKUP">
                    <a>
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
                    <div class="icon is-small is-left">
                        <img class="size-16" src="/icons/bookmark.svg" />
                    </div>
                </div>
            </div>
            <div class="field h-margin-left-10">
                <label class="checkbox" :disabled="!permissions.bookmarks">
                    <input v-model="options.exportGroupToMainBookmarkFolder" type="checkbox" :disabled="!permissions.bookmarks"/>
                    <span v-text="lang('exportGroupToMainBookmarkFolder', options.autoBackupBookmarksFolderName)"></span>
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
                    <input v-model="options.closePopupAfterChangeGroup" type="checkbox" />
                    <span v-text="lang('closePopupAfterChangeGroup')"></span>
                </label>
            </div>
            <div class="field h-margin-left-10">
                <label class="checkbox" :disabled="options.closePopupAfterChangeGroup">
                    <input v-model="options.openGroupAfterChange" type="checkbox" :disabled="options.closePopupAfterChangeGroup"/>
                    <span v-text="lang('openGroupAfterChange')"></span>
                </label>
            </div>
            <div class="field">
                <label class="checkbox">
                    <input v-model="options.followToLoadedGroupInSideBar" type="checkbox" />
                    <span v-text="lang('followToLoadedGroupInSideBar')"></span>
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
                        <swatches v-model.trim="options.defaultGroupIconColor" :title="lang('iconColor')" colors="text-advanced" popover-to="right" show-fallback :trigger-style="{
                            width: '40px',
                            height: '33px',
                            borderRadius: '4px',
                        }" />
                    </div>
                    <div v-for="iconViewType in groupIconViewTypes" :key="iconViewType" class="control">
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

            <div class="field">
                <label class="checkbox">
                    <input type="checkbox" v-model="enableDebug" />
                    <span>Enable DEBUG</span>
                </label>
                <br>
                <span>Please enable this checkbox only if you need to record bug and send logs to me, &lt;<a href="mailto:drive4ik@gmail.com">drive4ik@gmail.com</a>&gt;</span>
            </div>

            <div v-if="errorLogs.length" class="field">
                <div class="control">
                    <button @click="saveErrorLogsIntoFile" class="button is-warning" v-text="lang('saveErrorLogsIntoFile')"></button>
                </div>
            </div>
        </div>

        <div v-show="section === SECTION_HOTKEYS">
            <label class="has-text-weight-bold" v-text="lang('hotkeysTitle')"></label>
            <div class="h-margin-bottom-10" v-html="lang('hotkeysDescription')"></div>
            <div class="hotkeys">
                <div v-for="(hotkey, hotkeyIndex) in options.hotkeys" :key="hotkeyIndex" class="hotkey is-flex is-align-items-center">
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
                        <input type="text" @keydown="saveHotkeyKeyCodeAndStopEvent(hotkey, $event, true)" :value="hotkey.key" autocomplete="off" class="input" :placeholder="lang('hotkeyPlaceholder')" />
                    </div>
                    <div class="select">
                        <select v-model="hotkey.action">
                            <option v-if="!hotkey.action" selected disabled value="" v-text="lang('selectAction')"></option>
                            <option v-for="action in hotkeyActions" :key="action" :value="action" v-text="getHotkeyActionTitle(action)"></option>
                        </select>
                    </div>
                    <div v-if="actionsWithCustomGroup.includes(hotkey.action)" class="select custom-group">
                        <select v-model.number="hotkey.groupId">
                            <option value="0" v-text="lang('selectGroup')"></option>
                            <option v-for="group in groups" :key="group.id" :value="group.id" v-text="group.title"></option>
                        </select>
                    </div>
                    <div class="delete-button">
                        <span @click="options.hotkeys.splice(hotkeyIndex, 1)" class="cursor-pointer" :title="lang('deleteHotKeyButton')">
                            <img class="size-16" src="/icons/delete.svg" />
                        </span>
                    </div>
                </div>
            </div>
            <div>
                <div class="control">
                    <button @click="options.hotkeys.push(createHotkey())" class="button">
                        <span class="icon">
                            <img class="size-16" src="/icons/new.svg" />
                        </span>
                        <span v-text="lang('addHotKeyButton')"></span>
                    </button>
                </div>
            </div>
        </div>

        <div v-show="section === SECTION_BACKUP">
            <div class="field">
                <div class="has-text-weight-bold h-margin-bottom-5" v-text="lang('exportAddonSettingsTitle')"></div>
                <div class="h-margin-bottom-5" v-html="lang('exportAddonSettingsDescription')"></div>
                <div class="field">
                    <label class="checkbox" :disabled="!permissions.allUrls">
                        <input v-model="includeTabThumbnailsIntoBackup" :disabled="!permissions.allUrls" type="checkbox" />
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
                            <img class="size-16" src="/icons/download.svg" />
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
                        <label class="checkbox" :disabled="!permissions.allUrls">
                            <input v-model="options.autoBackupIncludeTabThumbnails" :disabled="!permissions.allUrls" type="checkbox" />
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
                <div class="has-text-danger has-text-weight-bold h-margin-bottom-5">
                    <span v-text="lang('warning')"></span>
                    <span v-text="lang('importAddonSettingsWarning')"></span>
                </div>
                <div class="field is-grouped is-align-items-center">
                    <div class="control">
                        <button @click="importAddonSettings" class="button is-primary">
                            <img class="size-16" src="/icons/upload.svg" />
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
                        <img class="size-16" src="/icons/old-tab-groups.svg" />
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
                        <img class="size-16" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAiklEQVR42mP4KO/o/UXJ/slXRfv/2PBnBfs3DFDgExj61i8o7D8I+waGPvb0DfFk+Kxo9xiXZhiGGQDTDMM+gSGPGAhpxmcACA8HA0ChjE8zciwAQ/4NsmYQn2HgAXLiQHcWuhw6BqvFGjB4Ag1D7TAwAJSryDUAnJlAWRLZEORYQE846Jq9/AI9AD3nkgARmnBEAAAAAElFTkSuQmCC" />
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
                        <img class="size-16" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAC4ElEQVR42m1Tu09TcRQ+bVx0dyFYZGiqCelQaAwNVtMApe/29t375LYNCqSFxISBRBdD1MV/wsHBaDQScTYmYkV0MDGBQRExGAddhF65v+M55eXgTb6c331833deFxJ3zlxLP4YfuWeA0iIIjkfnp2CnlwCLd8/fBLrSUvJ2sVgUhD1Jkn7mcrkIMFl/A2gQOnHl+Ky9Btt878D4A+eaVI32qBVt26yOo6Zptq7rGI1GP0Nu6YC0ckw+jFoLRHXViYlF2EpMXvLrcvWPMa6joiiCRDCZTCJwqv/NoNURsM1VB6aewKY0ddGnlo1dTVdRlmWbRDAej9uQpTrZST9w1I/JQl0mgRYJPGKBkE8uaTuqpmC5XLYJIhaL7UH+uYMJlvpqHxpjeT8qL6BtvnRayYdcQsCvFg2rLJetQqHQLpVKFgkgRO7DhrIKOLHmwNpHQPMDYJVgvqP4lkAZxe7Bujld6spm8tuKqnATMZvN4vDwcAsat1RX8vq5+lkJZjwlaPjqp+a9+omFAYp9irM52DjdlG9c6OYxqqra6/f7m263u0ljvDo7O3sS5hpzrmxcrrtdfU2/d6ip5mu9/LEsyd3BwXCzz9PfHBq4PN/v718IBALzXq+34fF4Zo4E0pnURrU+jtONKbwyOYHlSmHbNM2uVCaxbpg66oaGFaVMna8gLRA3sINUKoWhUKgFPI5arWYZhtEmWFSfRep+mvEWpWwRqU1Ns/L5vEWbx++sdDrdieFwGIFHQo6CyDaBZ7xDJF8ikdhkcTrbRBaETuMymYwg9w6oiXtA4xAkgLSaNne3UqnssgAtySadkYj2IZlckdx5AwVvIQnYwHURUfB6krsgUqcEmvFXrpWIgu4FOR+RKTveQjEyMkKrLEm/+ccgAZtqRqrzFz3riUQiXyg7FrDZ+R8BJAGbRYLB4HfgX5LcPrHy2NgY1zbRGaMs65Qi8rPR0VEGMjhtgiDyNzJ0/QXvYtJ0HU94ewAAAABJRU5ErkJggg==" />
                        <span class="h-margin-left-5" v-text="lang('browseFileTitle')"></span>
                    </button>
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

    </div>
</template>

<style lang="scss">
    body {
        // background-color: #f9f9fa;
    }

    .vue-swatches__container {
        transform: translate(2px, calc(-100% - 44px));
    }

    #stg-options {
        overflow-x: auto;

        .backup-time-input {
            width: 100px;
        }

        .hotkey {
            margin-bottom: var(--indent);

            > :not(:last-child) {
                margin-right: var(--indent);
            }

            > .input-command {
                width: 110px;
                min-width: 110px;
            }

            > .delete-button {
                line-height: 1;
            }

            > .notify-message {
                margin: 0;
            }
        }
    }

    // bulma
    .tabs a {
        border-top-color: transparent;
        border-top-style: solid;
        border-top-width: 3px;
        cursor: default;
    }

    .tabs ul,
    .tabs li a {
        border-bottom: none;
    }

    .tabs li.is-active a {
        border-top-color: #0a84ff;
        color: #0a84ff;
    }

    .tabs a:hover {
        border-top-color: #a9a9ac;
        background-color: #ededf0;
    }

    html.dark-theme {
        --background-color: #202023;

        .tabs a {
            color: #a6a5a5;

            &:hover {
                background-color: #2c2c2f;
            }
        }

        .vue-swatches__trigger.vue-swatches--is-empty {
            background-color: transparent !important;
            border-color: var(--color-hr);
        }

        .delete-button:hover img {
            fill: #0078d7;
        }
    }

</style>
