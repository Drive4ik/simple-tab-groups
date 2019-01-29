<script>
    'use strict';

    import * as utils from '../js/utils';
    import storage from '../js/storage';
    import * as constants from '../js/constants';
    import * as file from '../js/file';

    import popup from '../js/popup.vue';

    const BG = (function(bgWin) {
        return bgWin && bgWin.background && bgWin.background.inited ? bgWin.background : false;
    })(browser.extension.getBackgroundPage());

    if (!BG) {
        setTimeout(() => window.location.reload(), 3000);
        document.getElementById('stg-options').innerText = browser.i18n.getMessage('waitingToLoadAllTabs');
        throw Error('wait loading addon');
    }

    const SECTION_GENERAL = 'general',
        SECTION_HOTKEYS = 'hotkeys',
        SECTION_BACKUP = 'backup',
        SECTION_DEFAULT = SECTION_GENERAL,
        _funcKeys = [...Array(12).keys()].map(n => n + 1),
        isFunctionKey = keyCode => _funcKeys.some(n => keyCode === KeyEvent[`DOM_VK_F${n}`]);

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
                    'load-first-group',
                    'load-last-group',
                    'load-custom-group',
                    'add-new-group',
                    'delete-current-group',
                    'open-manage-groups',
                    'move-active-tab-to-custom-group',
                ],

                openPopupCommand: {
                    ctrlKey: false,
                    shiftKey: false,
                    altKey: false,
                    metaKey: false,
                    key: '',
                },

                groupIconViewTypes: constants.groupIconViewTypes,

                includeTabThumbnailsIntoBackup: false,
                includeTabFavIconsIntoBackup: true,

                thumbnailsSize: '',

                options: {
                    empty: true,
                },
                groups: [],
                isMac: false,

                permissions: {
                    bookmarks: false,
                },

                showEnableDarkThemeNotification: false,

                errorLogs: BG.getLogs(),
            };
        },
        components: {
            popup: popup,
        },
        async mounted() {
            let platformInfo = await browser.runtime.getPlatformInfo();
            this.isMac = platformInfo.os === 'mac';

            let data = await storage.get(null);

            this.calculateThumbnailsSize(data.thumbnails);

            this.options = utils.extractKeys(data, constants.allOptionsKeys);
            this.groups = Array.isArray(data.groups) ? data.groups : [];

            this.permissions.bookmarks = await browser.permissions.contains(constants.PERMISSIONS.BOOKMARKS);

            constants.onlyBoolOptionsKeys
                .concat(['defaultGroupIconViewType', 'autoBackupIntervalKey'])
                .forEach(function(option) {
                    this.$watch(`options.${option}`, function(newValue) {
                        BG.saveOptions({
                            [option]: newValue,
                        });
                    });
                }, this);

            this.initPopupHotkey();
        },
        watch: {
            'options.autoBackupFolderName': function(value, oldValue) {
                if (!value || null == oldValue) {
                    return;
                }

                value = value.replace(/[\<\>\:\"\/\\\|\?\*\x00-\x1F]|\.{2,}|^(?:aux|con|nul|prn|com\d|lpt\d)$/gi, '');

                if (!value.length || value.length > 200) {
                    value = constants.DEFAULT_OPTIONS.autoBackupFolderName;
                }

                BG.saveOptions({
                    autoBackupFolderName: value,
                });
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
                        let ok = (hotkey.keyCode || hotkey.key) && hotkey.action && (hotkey.ctrlKey || hotkey.shiftKey || hotkey.altKey || isFunctionKey(hotkey.keyCode));

                        if (ok && 'load-custom-group' === hotkey.action && !this.groups.some(gr => gr.id === hotkey.groupId)) {
                            ok = false;
                        }

                        return ok;
                    }, this);

                    BG.saveOptions({
                        hotkeys: filteredHotkeys,
                    });
                },
                deep: true,
            },
        },
        computed: {
            ctrlCommandKey() {
                return this.isMac ? 'MacCtrl' : 'Ctrl';
            },
        },
        methods: {
            lang: browser.i18n.getMessage,
            getHotkeyActionTitle: action => browser.i18n.getMessage('hotkeyActionTitle' + utils.capitalize(utils.toCamelCase(action))),

            openBackupFolder: file.openBackupFolder,

            calculateThumbnailsSize(thumbnails = {}) {
                this.thumbnailsSize = utils.formatBytes(Object.keys(thumbnails).length ? JSON.stringify(thumbnails).length : 0);
            },

            async clearTabsThumbnails() {
                await BG.clearTabsThumbnails();
                this.calculateThumbnailsSize();
            },

            resetPopupCommand() {
                this.openPopupCommand.ctrlKey = false;
                this.openPopupCommand.shiftKey = false;
                this.openPopupCommand.altKey = false;
                this.openPopupCommand.metaKey = false;
                this.openPopupCommand.key = browser.runtime.getManifest().commands._execute_browser_action.suggested_key.default;

                // browser.commands.reset('_execute_browser_action');
            },

            async initPopupHotkey() {
                let commands = await browser.commands.getAll(),
                    popupCommand = commands.find(command => command.name === '_execute_browser_action');

                this.openPopupCommand.ctrlKey = popupCommand.shortcut.includes(this.ctrlCommandKey);
                this.openPopupCommand.shiftKey = popupCommand.shortcut.includes('Shift');
                this.openPopupCommand.altKey = popupCommand.shortcut.includes('Alt');
                this.openPopupCommand.metaKey = this.isMac ? popupCommand.shortcut.includes('Command') : false;
                this.openPopupCommand.key = popupCommand.shortcut.split('+').pop();

                this.$watch('openPopupCommand', {
                    async handler(openPopupCommand) {
                        let shortcut = [];

                        if (openPopupCommand.ctrlKey) {
                            shortcut.push(this.ctrlCommandKey);
                        }

                        if (this.isMac && openPopupCommand.metaKey) {
                            shortcut.push('Command');
                        }

                        if (openPopupCommand.shiftKey) {
                            shortcut.push('Shift');
                        }

                        if (openPopupCommand.altKey) {
                            shortcut.push('Alt');
                        }

                        let key = openPopupCommand.key.replace('Arrow', '');

                        shortcut.push(key.length === 1 ? key.toUpperCase() : key);

                        try {
                            await browser.commands.update({
                                name: '_execute_browser_action',
                                shortcut: shortcut.join('+'),
                            });
                        } catch (e) {
                            this.resetPopupCommand();
                        }
                    },
                    deep: true,
                });
            },

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
                try {
                    let data = await file.load();

                    if ('object' !== utils.type(data) || !Array.isArray(data.groups)) {
                        throw 'Error: this is wrong backup!';
                    }

                    data = await BG.runMigrateForData(data);

                    await storage.set(data);

                    browser.runtime.reload(); // reload addon
                } catch (e) {
                    if (e) {
                        utils.notify(e);
                    }
                }
            },

            exportAddonSettings() {
                BG.createBackup(this.includeTabThumbnailsIntoBackup, this.includeTabFavIconsIntoBackup);
            },

            async importSettingsOldTabGroupsAddonButton() {
                let oldOptions = null;

                try {
                    oldOptions = await file.load();
                } catch (e) {
                    utils.notify(e);
                    return;
                }

                let data = await storage.get(['groups', 'lastCreatedGroupPosition']),
                    newGroups = {};

                oldOptions.windows.forEach(function(win) {
                    let oldGroups = {};

                    try {
                        oldGroups = JSON.parse(win.extData['tabview-group']);
                    } catch (e) {
                        utils.notify('Error: cannot parse backup file - ' + e);
                        return;
                    }

                    Object.keys(oldGroups).forEach(function(key) {
                        let oldGroup = oldGroups[key];

                        if (!newGroups[oldGroup.id]) {
                            data.lastCreatedGroupPosition++;

                            newGroups[oldGroup.id] = BG.createGroup(data.lastCreatedGroupPosition);
                            newGroups[oldGroup.id].title = utils.createGroupTitle(oldGroup.title, oldGroup.id);
                            newGroups[oldGroup.id].catchTabRules = (oldGroup.catchRules || '');
                            newGroups[oldGroup.id].slot = oldGroup.slot;
                        }
                    });

                    win.tabs.forEach(function(oldTab) {
                        let extData = {},
                            tabEntry = oldTab.entries.pop();

                        if (!tabEntry.url || !utils.isUrlAllowToCreate(tabEntry.url)) {
                            return;
                        }

                        if (oldTab.pinned) {
                            return browser.tabs.create({
                                url: tabEntry.url,
                                pinned: true,
                            });
                        }

                        try {
                            extData = JSON.parse(oldTab.extData['tabview-tab'] || '{}');
                            if (!extData || !extData.groupID) {
                                return;
                            }
                        } catch (e) {
                            return utils.notify('Cannot parse groups: ' + e);
                        }

                        if (newGroups[extData.groupID]) {
                            newGroups[extData.groupID].tabs.push(BG.mapTab({
                                title: tabEntry.title,
                                url: tabEntry.url,
                                favIconUrl: oldTab.image || '',
                                active: Boolean(extData.active),
                            }));
                        }
                    });
                });

                let groups = Object.values(newGroups)
                    .sort((a, b) => utils.compareStrings(a.slot, b.slot))
                    .map(function(group) {
                        delete group.slot;
                        return group;
                    });

                if (groups.length) {
                    data.groups = data.groups.concat(groups);

                    await storage.set(data);

                    browser.runtime.reload(); // reload addon
                } else {
                    utils.notify('Nothing imported');
                }
            },

            async importSettingsPanoramaViewAddonButton() {
                let panoramaOptions = null;

                try {
                    panoramaOptions = await file.load();

                    if (!panoramaOptions || !panoramaOptions.file || 'panoramaView' !== panoramaOptions.file.type || !Array.isArray(panoramaOptions.windows)) {
                        throw 'Error: this is wrong backup!';
                    }

                    if (1 !== panoramaOptions.file.version) {
                        throw 'Error: Panorama View backup has unsupported version';
                    }
                } catch (e) {
                    utils.notify(e);
                    return;
                }

                let data = await storage.get(['groups', 'lastCreatedGroupPosition']),
                    newGroups = {};

                panoramaOptions.windows.forEach(function(win) {
                    win.groups.forEach(function(group) {
                        if (!newGroups[group.id]) {
                            data.lastCreatedGroupPosition++;

                            newGroups[group.id] = BG.createGroup(data.lastCreatedGroupPosition, undefined, group.name);
                        }
                    });

                    win.tabs.forEach(function(tab) {
                        if (!newGroups[tab.groupId]) {
                            return;
                        }

                        if (!utils.isUrlAllowToCreate(tab.url)) {
                            return;
                        }

                        let newTab = BG.mapTab(tab);

                        if (tab.pinned) {
                            if (!utils.isUrlEmpty(newTab.url)) {
                                browser.tabs.create({
                                    url: newTab.url,
                                    pinned: true,
                                });
                            }
                        } else {
                            newGroups[tab.groupId].tabs.push(newTab);
                        }
                    });

                });

                let groups = Object.values(newGroups);

                if (groups.length) {
                    data.groups = data.groups.concat(groups);

                    await storage.set(data);

                    browser.runtime.reload(); // reload addon
                } else {
                    utils.notify('Nothing imported');
                }
            },

            async importSettingsSyncTabGroupsAddonButton() {
                let syncTabOptions = null;

                try {
                    syncTabOptions = await file.load();

                    if (!syncTabOptions || !syncTabOptions.version || 'syncTabGroups' !== syncTabOptions.version[0] || !Array.isArray(syncTabOptions.groups)) {
                        throw 'Error: this is wrong backup!';
                    }

                    if (1 !== syncTabOptions.version[1]) {
                        throw 'Error: Sync Tab Groups backup has unsupported version';
                    }
                } catch (e) {
                    utils.notify(e);
                    return;
                }

                let data = await storage.get(['groups', 'lastCreatedGroupPosition']),
                    newGroups = {};

                syncTabOptions.groups.forEach(function(group) {
                    if (group.incognito) {
                        return;
                    }

                    if (!newGroups[group.id]) {
                        data.lastCreatedGroupPosition++;

                        newGroups[group.id] = BG.createGroup(data.lastCreatedGroupPosition, undefined, group.title);
                        newGroups[group.id].position = group.position;
                    }

                    group.tabs.forEach(function(tab) {
                        if (!utils.isUrlAllowToCreate(tab.url)) {
                            return;
                        }

                        delete tab.id;

                        let newTab = BG.mapTab(tab);

                        if (tab.pinned) {
                            if (!utils.isUrlEmpty(newTab.url)) {
                                browser.tabs.create({
                                    url: newTab.url,
                                    pinned: true,
                                });
                            }
                        } else {
                            newGroups[group.id].tabs.push(newTab);
                        }
                    });
                });

                let groups = Object.values(newGroups)
                    .sort((a, b) => utils.compareStrings(a.position, b.position))
                    .map(function(group) {
                        delete group.position;
                        return group;
                    });

                if (groups.length) {
                    data.groups = data.groups.concat(groups);

                    await storage.set(data);

                    browser.runtime.reload(); // reload addon
                } else {
                    utils.notify('Nothing imported');
                }
            },

            async saveErrorLogsIntoFile() {
                let options = await storage.get('version'),
                    data = {
                        version: options.version,
                        logs: BG.getLogs(),
                    };

                if (data.logs.length) {
                    file.save(data, 'STG-error-logs.json');
                } else {
                    utils.notify('No logs found');
                }
            },

            getIconTypeUrl(iconType) {
                return utils.getGroupIconUrl({
                    iconViewType: iconType,
                    iconColor: 'hsl(200, 100%, 50%)',
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

                BG.updateMoveTabMenus();
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
                    <input v-model="options.useTabsFavIconsFromGoogleS2Converter" type="checkbox" />
                    <span v-text="lang('useTabsFavIconsFromGoogleS2Converter')"></span>
                </label>
            </div>
            <div class="field">
                <label class="checkbox">
                    <input type="checkbox" v-model="options.createThumbnailsForTabs" @change="!options.createThumbnailsForTabs && (includeTabThumbnailsIntoBackup = false) " />
                    <span v-text="lang('createThumbnailsForTabs')"></span>
                </label>

                <div class="control h-margin-top-10 is-flex is-align-items-center">
                    <span v-text="lang('tabsThumbnailsSize', thumbnailsSize)"></span>
                    <button class="button is-warning h-margin-left-10" @click="clearTabsThumbnails" v-text="lang('clearTabsThumbnails')"></button>
                </div>
            </div>

            <hr>

            <div class="field">
                <label class="label" v-text="lang('enterDefaultGroupIconViewTypeTitle')"></label>
                <div class="field is-grouped">
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

            <hr>

            <div class="field">
                <label class="checkbox">
                    <input v-model="options.enableDarkTheme" type="checkbox" />
                    <span v-text="lang('enableDarkTheme')"></span>
                </label>
            </div>

            <hr v-if="errorLogs.length">

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
                <div class="hotkey is-flex is-align-items-center">
                    <label class="checkbox">
                        <input v-model="openPopupCommand.ctrlKey" type="checkbox" />
                        <span v-if="isMac">Control</span>
                        <span v-else>Ctrl</span>
                    </label>
                    <label class="checkbox">
                        <input v-model="openPopupCommand.shiftKey" type="checkbox" />
                        <span>Shift</span>
                    </label>
                    <label class="checkbox">
                        <input v-model="openPopupCommand.altKey" type="checkbox" />
                        <span v-if="isMac">Option</span>
                        <span v-else>Alt</span>
                    </label>
                    <label v-if="isMac" class="checkbox">
                        <input v-model="openPopupCommand.metaKey" type="checkbox" />
                        <span>Command</span>
                    </label>
                    <div class="control input-command">
                        <input type="text" @keydown="saveHotkeyKeyCodeAndStopEvent(openPopupCommand, $event, false)" :value="openPopupCommand.key" autocomplete="off" class="input" />
                    </div>
                    <div class="is-flex">
                        <span v-text="lang('openPopupHotkeyTitle')"></span>
                    </div>
                    <div class="delete-button">
                        <button class="button is-danger is-outlined" @click="resetPopupCommand">Reset</button>
                    </div>
                </div>

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
                    <div v-if="'load-custom-group' === hotkey.action || 'move-active-tab-to-custom-group' === hotkey.action" class="select custom-group">
                        <select v-model.number="hotkey.groupId">
                            <option :disabled="'load-custom-group' === hotkey.action" value="0" v-text="lang('selectGroup')"></option>
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
                    <label class="checkbox">
                        <input v-model="includeTabThumbnailsIntoBackup" :disabled="!options.createThumbnailsForTabs" type="checkbox" />
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
                        <label class="checkbox">
                            <input v-model="options.autoBackupIncludeTabThumbnails" type="checkbox" />
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

                    <div>
                        <span v-text="lang('autoBackupLastBackupTitle')"></span>
                        <span v-if="options.autoBackupLastBackupTimeStamp > 1" v-text="new Date(options.autoBackupLastBackupTimeStamp * 1000).toLocaleString()"></span>
                        <span v-else>&mdash;</span>
                    </div>
                </div>
                <div class="field is-grouped">
                    <div class="control">
                        <input type="text" v-model.trim="options.autoBackupFolderName" maxlength="200" class="input" />
                    </div>
                    <div class="control">
                        <button class="button" @click="openBackupFolder" v-text="lang('openBackupFolder')"></button>
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
                <div class="control">
                    <button @click="importAddonSettings" class="button is-primary">
                        <img class="size-16" src="/icons/upload.svg" />
                        <span class="h-margin-left-5" v-text="lang('importAddonSettingsButton')"></span>
                    </button>
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

    </div>
</template>

<style lang="scss">
    body {
        // background-color: #f9f9fa;
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

</style>
