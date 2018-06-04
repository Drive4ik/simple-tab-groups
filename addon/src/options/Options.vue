<script>
    'use strict';

    import * as utils from '../js/utils';
    import storage from '../js/storage';
    import {onlyBoolOptionsKeys, allOptionsKeys} from '../js/constants';
    import {importFromFile, exportToFile} from '../js/fileImportExport';

    const BG = (function(bgWin) {
        return bgWin && bgWin.background && bgWin.background.inited ? bgWin.background : false;
    })(browser.extension.getBackgroundPage());

    if (!BG) {
        throw Error('Please, update addon to latest version');
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

                includeTabThumbnailsIntoBackup: false,

                options: {
                    empty: true,
                },
                groups: [],
            };
        },
        async mounted() {
            let data = await storage.get(null);

            this.options = utils.extractKeys(data, allOptionsKeys);
            this.groups = Array.isArray(data.groups) ? data.groups : [];

            onlyBoolOptionsKeys.forEach(function(option) {
                this.$watch(`options.${option}`, function(newValue) {
                    this.saveOptions({
                        [option]: newValue,
                    });
                });
            }, this);
        },
        watch: {
            'options.browserActionIconColor': async function(newValue, oldValue) {
                if (!oldValue) {
                    return;
                }

                await this.saveOptions({
                    browserActionIconColor: newValue,
                });

                BG.updateBrowserActionData();
            },
            'options.hotkeys': {
                handler(hotkeys, oldValue) {
                    if (!oldValue) {
                        return;
                    }

                    let filteredHotkeys = hotkeys.filter(function(hotkey) {
                        let ok = (hotkey.keyCode || hotkey.key) && hotkey.action.id && (hotkey.ctrlKey || hotkey.shiftKey || hotkey.altKey);

                        if (ok && 'load-custom-group' === hotkey.action.id && !this.groups.some(gr => gr.id === hotkey.action.groupId)) {
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
        computed: {},
        methods: {
            lang: browser.i18n.getMessage,
            getHotkeyActionTitle: action => browser.i18n.getMessage('hotkeyActionTitle' + utils.capitalize(utils.toCamelCase(action))),

            async saveOptions(options) {
                await storage.set(options, true);
                BG.reloadOptions();
                // this.$emit('options-updated');
            },

            saveHotkeyKeyCode(hotkey, event) {
                if (!event.ctrlKey && !event.shiftKey && !event.altKey) {
                    hotkey.key = event.key;
                    hotkey.keyCode = event.keyCode;
                }
            },

            async importAddonSettings() {
                try {
                    let data = await importFromFile();

                    if ('object' !== utils.type(data) || !Array.isArray(data.groups)) {
                        throw 'Error: this is wrong backup!';
                    }

                    data = await BG.runMigrateForData(data);

                    let syncedWindowIds = BG.getGroups().filter(group => group.windowId).map(group => group.windowId),
                        windows = await browser.windows.getAll({
                            windowTypes: ['normal'],
                        });

                    windows = windows // find allowed windows
                        .filter(function(win) {
                            if (!utils.isWindowAllow(win) || !syncedWindowIds.includes(win.id)) {
                                return false;
                            }

                            return true;
                        });

                    windows = await Promise.all(windows.map(async function(win) { // find all allowed tabs in allowed windows
                        win.tabs = await browser.tabs.query({
                            pinned: false,
                            hidden: false,
                            windowId: win.id,
                        });

                        return win;
                    }));

                    await Promise.all(windows.map(async function(win) { // hide all tabs in allowed windows
                        if (win.tabs.length) {
                            await browser.tabs.create({
                                active: true,
                                windowId: win.id,
                            });
                            await browser.tabs.hide(win.tabs.map(utils.keyId));
                        }
                    }));

                    data.groups.forEach(gr => gr.windowId = null); // reset window ids

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
                    data.groups = data.groups.map(function(group) {
                        group.tabs = group.tabs.map(function(tab) {
                            delete tab.thumbnail;
                            return tab;
                        });

                        return group;
                    });
                }

                exportToFile(data);
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
                                title: (tabEntry.title || tabEntry.url),
                                url: tabEntry.url,
                                favIconUrl: oldTab.image || '',
                                active: Boolean(extData.active),
                            }));
                        }
                    });
                });

                let groups = Object.values(newGroups)
                    .sort((a, b) => String(a.slot).localeCompare(String(b.slot), [], { numeric: true }))
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

            saveErrorLogsIntoFile() {
                let logs = BG.getLogs(),
                    logsStr = null;

                if (logs.length) {
                    exportToFile(logs, 'STG-error-logs.json');
                } else {
                    utils.notify('No logs found');
                }
            },

            createHotkey() {
                return {
                    ctrlKey: false,
                    shiftKey: false,
                    altKey: false,
                    key: '',
                    keyCode: 0,
                    action: {
                        id: '',
                        groupId: 0,
                    },
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
                    <input v-model="options.createThumbnailsForTabs" @change="!options.createThumbnailsForTabs && (includeTabThumbnailsIntoBackup = false) " type="checkbox" />
                    <span v-text="lang('createThumbnailsForTabs')"></span>
                </label>
            </div>

            <hr>

            <div class="field browser-action-color-wrapper">
                <label class="label" v-text="lang('enterBrowserActionIconColor')"></label>
                <div class="control is-inline-block">
                    <input v-model.lazy="options.browserActionIconColor" class="input" type="color" />
                </div>
            </div>

            <hr>

            <div class="field is-hidden_">
                <div class="control">
                    <button @click="saveErrorLogsIntoFile" class="button is-warning is-small" v-text="lang('saveErrorLogsIntoFile')"></button>
                </div>
            </div>
        </div>

        <div v-show="section === SECTION_HOTKEYS">
            <label class="has-text-weight-bold" v-text="lang('hotkeysTitle')"></label>
            <div class="h-margin-bottom-10" v-html="lang('hotkeysDescription')"></div>
            <div class="hotkeys">
                <div v-for="(hotkey, hotkeyIndex) in options.hotkeys" :key="hotkeyIndex" class="hotkey is-flex is-aligin-items-center">
                    <label class="checkbox">
                        <input v-model="hotkey.ctrlKey" type="checkbox" />
                        <span>Ctrl</span>
                    </label>
                    <label class="checkbox">
                        <input v-model="hotkey.shiftKey" type="checkbox" />
                        <span>Shift</span>
                    </label>
                    <label class="checkbox">
                        <input v-model="hotkey.altKey" type="checkbox" />
                        <span>Alt</span>
                    </label>
                    <div class="control">
                        <input type="text" @keydown.stop="saveHotkeyKeyCode(hotkey, $event)" v-model="hotkey.key" autocomplete="off" maxlength="1" class="input is-small" :placeholder="lang('hotkeyPlaceholder')" />
                    </div>
                    <div class="select is-small">
                        <select v-model="hotkey.action.id">
                            <option v-if="!hotkey.action.id" selected disabled value="" v-text="lang('selectAction')"></option>
                            <option v-for="action in hotkeyActions" :key="action" :value="action" v-text="getHotkeyActionTitle(action)"></option>
                        </select>
                    </div>
                    <div v-show="'load-custom-group' === hotkey.action.id" class="select is-small custom-group">
                        <select v-model="hotkey.action.groupId">
                            <option selected disabled value="" v-text="lang('selectGroup')"></option>
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
        min-height: 500px;

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

        & > .control {
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
