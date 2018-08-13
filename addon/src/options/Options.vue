<script>
    'use strict';

    import * as utils from '../js/utils';
    import storage from '../js/storage';
    import {onlyBoolOptionsKeys, allOptionsKeys, groupIconViewTypes, DEFAULT_COOKIE_STORE_ID} from '../js/constants';
    import {importFromFile, exportToFile, generateBackupFileName} from '../js/fileImportExport';

    const BG = (function(bgWin) {
        return bgWin && bgWin.background && bgWin.background.inited ? bgWin.background : false;
    })(browser.extension.getBackgroundPage());

    if (!BG) {
        setTimeout(() => window.location.reload(), 3000);
        throw Error('wait loading addon');
    }

    const SECTION_GENERAL = 'general',
        SECTION_HOTKEYS = 'hotkeys',
        SECTION_BACKUP = 'backup',
        SECTION_DEFAULT = SECTION_GENERAL;

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
                ],

                openPopupCommand: {
                    ctrlKey: false,
                    shiftKey: false,
                    altKey: false,
                    metaKey: false,
                    key: '',
                },

                groupIconViewTypes: groupIconViewTypes,

                includeTabThumbnailsIntoBackup: false,
                includeTabFavIconsIntoBackup: true,

                thumbnailsSize: '',

                options: {
                    empty: true,
                },
                groups: [],
                isMac: false,

                errorLogs: BG.getLogs(),
            };
        },
        async mounted() {
            let { os } = await browser.runtime.getPlatformInfo();
            this.isMac = os === 'mac';

            let data = await storage.get(null);

            this.calculateThumbnailsSize(data.thumbnails);

            this.options = utils.extractKeys(data, allOptionsKeys);
            this.groups = Array.isArray(data.groups) ? data.groups : [];

            onlyBoolOptionsKeys
                .concat(['defaultGroupIconViewType'])
                .forEach(function(option) {
                    this.$watch(`options.${option}`, function(newValue) {
                        this.saveOptions({
                            [option]: newValue,
                        });
                    });
                }, this);

            this.initPopupHotkey();
        },
        watch: {
            'options.hotkeys': {
                handler(hotkeys, oldValue) {
                    if (!oldValue) {
                        return;
                    }

                    let filteredHotkeys = hotkeys.filter(function(hotkey) {
                        let ok = (hotkey.keyCode || hotkey.key) && hotkey.action/* && (hotkey.ctrlKey || hotkey.shiftKey || hotkey.altKey)*/;

                        if (ok && 'load-custom-group' === hotkey.action && !this.groups.some(gr => gr.id === hotkey.groupId)) {
                            ok = false;
                        }

                        return ok;
                    }, this);

                    this.saveOptions({
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

            async saveOptions(options) {
                await storage.set(options, true);
                await browser.runtime.sendMessage({
                    action: 'options-updated',
                    optionsUpdated: Object.keys(options),
                });
            },

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
                    let data = await importFromFile();

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

            async exportAddonSettings() {
                let data = await storage.get(null);

                if (!this.includeTabThumbnailsIntoBackup) {
                    delete data.thumbnails;
                }

                data.groups.forEach(function(group) {
                    delete group.windowId;

                    group.tabs.forEach(function(tab) {
                        delete tab.id;

                        if (tab.cookieStoreId === DEFAULT_COOKIE_STORE_ID) {
                            delete tab.cookieStoreId;
                        }

                        if (!this.includeTabFavIconsIntoBackup) {
                            delete tab.favIconUrl;
                        }
                    }, this);
                }, this);

                exportToFile(data, generateBackupFileName());
            },

            async importSettingsOldTabGroupsAddonButton() {
                let oldOptions = null;

                try {
                    oldOptions = await importFromFile();
                } catch (e) {
                    return utils.notify(e);
                }

                let data = await storage.get(['groups', 'lastCreatedGroupPosition']),
                    newGroups = {};

                oldOptions.windows.forEach(function(win) {
                    let oldGroups = {};

                    try {
                        oldGroups = JSON.parse(win.extData['tabview-group']);
                    } catch (e) {
                        return utils.notify('Error: cannot parse backup file - ' + e);
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

                        if (!utils.isUrlAllowToCreate(tabEntry.url)) {
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

            async saveErrorLogsIntoFile() {
                let options = await storage.get('version'),
                    data = {
                        version: options.version,
                        logs: BG.getLogs(),
                    };

                if (data.logs.length) {
                    exportToFile(data, 'STG-error-logs.json');
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
                };
            },

        },
    }
</script>

<template>
    <div id="stg-options">
        <div class="tabs is-boxed">
            <ul>
                <li :class="{'is-active': section === SECTION_GENERAL}" @click="section = SECTION_GENERAL">
                    <a>
                        <span class="icon is-small">
                            <img :src="'/icons/cog.svg'">
                        </span>
                        <span v-text="lang('generalTitle')"></span>
                    </a>
                </li>
                <li :class="{'is-active': section === SECTION_HOTKEYS}" @click="section = SECTION_HOTKEYS">
                    <a>
                        <span class="icon is-small">
                            <img :src="'/icons/keyboard-o.svg'">
                        </span>
                        <span v-text="lang('hotkeysTitle')"></span>
                    </a>
                </li>
                <li :class="{'is-active': section === SECTION_BACKUP}" @click="section = SECTION_BACKUP">
                    <a>
                        <span class="icon is-small">
                            <img :src="'/icons/cloud-upload.svg'">
                        </span>
                        <span v-text="lang('exportAddonSettingsTitle')"></span>
                    </a>
                </li>
            </ul>
        </div>

        <div v-show="section === SECTION_GENERAL">
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

                <div class="control h-margin-top-10">
                    <span v-text="lang('tabsThumbnailsSize', thumbnailsSize)"></span>
                    <button class="button is-warning is-small" @click="clearTabsThumbnails" v-text="lang('clearTabsThumbnails')"></button>
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

            <hr v-if="errorLogs.length">

            <div v-if="errorLogs.length" class="field">
                <div class="control">
                    <button @click="saveErrorLogsIntoFile" class="button is-warning is-small" v-text="lang('saveErrorLogsIntoFile')"></button>
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
                    <div class="control">
                        <input type="text" @keydown="saveHotkeyKeyCodeAndStopEvent(openPopupCommand, $event, false)" :value="openPopupCommand.key" autocomplete="off" class="input is-small" />
                    </div>
                    <div class="is-flex">
                        <span class="is-size-7" v-text="lang('openPopupHotkeyTitle')"></span>
                    </div>
                    <div class="delete-button">
                        <button class="button is-danger is-outlined is-small" @click="resetPopupCommand">Reset</button>
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
                    <div class="control">
                        <input type="text" @keydown="saveHotkeyKeyCodeAndStopEvent(hotkey, $event, true)" :value="hotkey.key" autocomplete="off" class="input is-small" :placeholder="lang('hotkeyPlaceholder')" />
                    </div>
                    <div class="select is-small">
                        <select v-model="hotkey.action">
                            <option v-if="!hotkey.action" selected disabled value="" v-text="lang('selectAction')"></option>
                            <option v-for="action in hotkeyActions" :key="action" :value="action" v-text="getHotkeyActionTitle(action)"></option>
                        </select>
                    </div>
                    <div v-if="'load-custom-group' === hotkey.action" class="select is-small custom-group">
                        <select v-model="hotkey.groupId">
                            <option v-if="!hotkey.groupId" selected disabled value="undefined" v-text="lang('selectGroup')"></option>
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
                            <img class="size-14" src="/icons/new.svg" />
                        </span>
                        <span v-text="lang('addHotKeyButton')"></span>
                    </button>
                </div>
            </div>
        </div>

        <div v-show="section === SECTION_BACKUP">
            <div class="h-margin-bottom-20">
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
                <div class="control">
                    <button @click="exportAddonSettings" class="button">
                        <img class="size-14" src="/icons/download.svg" />
                        <span class="h-margin-left-5" v-text="lang('exportAddonSettingsButton')"></span>
                    </button>
                </div>
            </div>
            <div>
                <div class="has-text-weight-bold h-margin-bottom-5" v-text="lang('importAddonSettingsTitle')"></div>
                <div class="h-margin-bottom-5" v-html="lang('importAddonSettingsDescription')"></div>
                <div class="has-text-danger has-text-weight-bold h-margin-bottom-5">
                    <span v-text="lang('warning')"></span>
                    <span v-text="lang('importAddonSettingsWarning')"></span>
                </div>
                <div class="control">
                    <button @click="importAddonSettings" class="button">
                        <img class="size-14" src="/icons/upload.svg" />
                        <span class="h-margin-left-5" v-text="lang('importAddonSettingsButton')"></span>
                    </button>
                </div>
            </div>

            <hr>

            <div class="has-text-weight-bold h-margin-bottom-5" v-text="lang('importSettingsOldTabGroupsAddonTitle')"></div>
            <div class="h-margin-bottom-5" v-html="lang('importSettingsOldTabGroupsAddonDescription')"></div>
            <div class="control">
                <button @click="importSettingsOldTabGroupsAddonButton" class="button" v-text="lang('importSettingsOldTabGroupsAddonButton')"></button>
            </div>
        </div>

    </div>

</template>

<style lang="scss">
    * {
        font-size: 15px;
    }

    body {
        background-color: #f9f9fa;
        padding: 0 6px;
    }

    .tabs.is-boxed li.is-active a {
        background-color: #f9f9fa;
    }

    #stg-options {
        min-height: 600px;

        & > div {
            max-width: 99%;
        }
    }

    hr {
        margin: 10px -4px;
        color: transparent;
        border-top: 1px solid #e3e3e3;
    }

    .hotkey {
        margin-bottom: 10px;

        & > :not(:last-child) {
            margin-right: 10px;
        }

        & > :nth-child(4) {
            width: 100px;
        }

        & > .delete-button {
            line-height: 0;
        }

        & > .notify-message {
            margin: 0;
        }
    }

    .browser-action-color-wrapper > .control:last-child {
        min-width: 44px;
    }
</style>
