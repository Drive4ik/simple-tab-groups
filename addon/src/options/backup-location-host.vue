<script>

import contextMenu from '../components/context-menu.vue';

import '/js/prefixed-storage.js';
import * as Constants from '/js/constants.js';
import Notification from '/js/notification.js';
import * as Utils from '/js/utils.js';
import * as Host from '/js/host.js';

import optionsMixin from '/js/mixins/options.mixin.js';

export default {
    mixins: [optionsMixin],
    data() {
        this.FILE_PATH_VARIABLES = Utils.getFilePathVariables();

        this.HOST = Constants.HOST;

        return {
            hasConnection: null,

            errorMessage: '',

            backupFolder: '',
            backupFolderErrorMessage: '',

            deleteBackupDays: null,
            keepBackupFiles: null,
        };
    },
    components: {
        'context-menu': contextMenu,
    },
    watch: {
        deleteBackupDays(value, oldValue) {
            if (oldValue === null) {
                return;
            }

            const newValue = Utils.clamp(value, 0, 1000);

            if (newValue !== value) {
                this.deleteBackupDays = newValue;
                return; // will trigger watcher again
            }

            this.setSettingsHost({
                deleteBackupDays: this.deleteBackupDays,
            });
        },
        keepBackupFiles(value, oldValue) {
            if (oldValue === null) {
                return;
            }

            const newValue = Utils.clamp(value, 1, 1000);

            if (newValue !== value) {
                this.keepBackupFiles = newValue;
                return; // will trigger watcher again
            }

            this.setSettingsHost({
                keepBackupFiles: this.keepBackupFiles,
            });
        },
    },
    created() {
        this.loadSettings();

        this.$on('options-reloaded', () => this.addCustomWatchers());
    },
    methods: {
        lang: browser.i18n.getMessage,
        addCustomWatchers() {
            this.optionsWatch('autoBackupFilePathHost', async (value, oldValue) => {
                try {
                    await Host.testFilePath(value);
                    return value;
                } catch (e) {
                    Notification(e);
                    return oldValue;
                }
            });
        },
        async loadSettings() {
            try {
                const settings = await Host.getSettings();
                this.hasConnection = true;

                this.backupFolder = settings.backupFolderResponse.data;

                if (settings.backupFolderResponse.ok) {
                    this.backupFolderErrorMessage = '';
                } else {
                    const error = new Host.HostError(settings.backupFolderResponse);
                    this.backupFolderErrorMessage = Host.getErrorMessage(error);
                }

                this.deleteBackupDays = settings.deleteBackupDays;
                this.keepBackupFiles = settings.keepBackupFiles;
            } catch (e) {
                this.hasConnection = false;

                this.backupFolder = '';
                this.backupFolderErrorMessage = '';
                this.deleteBackupDays = null;
                this.keepBackupFiles = null;

                if (e instanceof Host.HostError) {
                    this.errorMessage = e;
                }
            }
        },
        insertVariableToFilePath(variable) {
            this.options.autoBackupFilePathHost = Utils.insertVariable(
                this.$refs.autoBackupFilePathHost,
                this.options.autoBackupFilePathHost,
                variable
            );
        },

        async openBackupFolder() {
            try {
                await Host.openBackupFolder();
                this.backupFolderErrorMessage = '';
            } catch (e) {
                this.backupFolderErrorMessage = Host.getErrorMessage(e);
            }
        },

        async selectBackupFolderHost() {
            try {
                this.backupFolder = await Host.selectBackupFolder();
                this.backupFolderErrorMessage = '';
            } catch (e) {
                this.backupFolderErrorMessage = Host.getErrorMessage(e);
            }
        },

        async setSettingsHost(settings) {
            try {
                await Host.setSettings(settings);
                this.errorMessage = '';
            } catch (e) {
                this.errorMessage = e;
            }
        },
    },
}

</script>

<template>
    <div class="field">
        <div v-if="hasConnection === false" class="field is-horizontal">
            <div class="field-label is-normal">
                <label class="label colon" v-text="lang('requiredActions')"></label>
            </div>
            <div class="field-body">
                <div class="field mt-2">
                    <div class="block white-space-pre-line" v-html="lang('stgHostHowToUse', HOST.DOWNLOAD_URL)"></div>
                    <a class="button is-primary is-soft" role="button" @click="loadSettings" v-text="lang('check')"></a>
                </div>
            </div>
        </div>

        <fieldset :disabled="!hasConnection">
            <div class="field is-horizontal">
                <div class="field-label is-normal">
                    <label class="label colon" v-text="lang('filePathTitle')"></label>
                </div>
                <div class="field-body">
                    <div class="field">
                        <div class="field has-addons">
                            <div class="control">
                                <button class="button" @click="selectBackupFolderHost" :title="lang('selectBackupFolder')">
                                    <span class="icon">
                                        <figure class="image is-16x16">
                                            <img src="/icons/folder-open.svg" />
                                        </figure>
                                    </span>
                                </button>
                            </div>
                            <div class="control is-expanded">
                                <input type="text" @click="selectBackupFolderHost" :value="backupFolder" readonly class="input" :title="lang(backupFolder ? 'backupFolderTitle' : 'selectBackupFolder')" :class="{'is-clickable': hasConnection}" />
                            </div>
                            <div class="control auto-backup-filename">
                                <input type="text" v-model.lazy.trim="options.autoBackupFilePathHost" ref="autoBackupFilePathHost" maxlength="200" class="input" :title="lang('filePathTitle')" />
                            </div>
                            <div class="control">
                                <a class="button is-static">.json</a>
                            </div>
                            <div class="control">
                                <button class="button"
                                    @click="$refs.filePathVariables.open($event)"
                                    @contextmenu.prevent="$refs.filePathVariables.open($event)">
                                    <span class="icon">
                                        <figure class="image is-16x16">
                                            <img src="/icons/brackets-curly.svg" />
                                        </figure>
                                    </span>
                                </button>
                            </div>
                            <div class="control">
                                <button class="button" @click="openBackupFolder" v-text="lang('openBackupFolder')"></button>
                            </div>
                        </div>

                        <p class="help is-danger is-size-6 hidden-empty" v-text="errorMessage"></p>
                        <p class="help is-danger is-size-6 hidden-empty" v-text="backupFolderErrorMessage"></p>
                    </div>
                </div>
            </div>

            <context-menu ref="filePathVariables">
                <ul class="is-unselectable">
                    <li
                        v-for="(value, variable) in FILE_PATH_VARIABLES"
                        :key="variable"
                        @click="insertVariableToFilePath(variable)"
                        >
                        <span v-text="`{${variable}} - ` + value"></span>
                    </li>
                </ul>
            </context-menu>

            <div class="field is-horizontal">
                <div class="field-label is-normal">
                    <label class="label colon" v-text="lang('deleteFilesOlderThan')"></label>
                </div>
                <div class="field-body">
                    <div class="field has-addons">
                        <div class="control is-expanded">
                            <input type="number" class="input" v-model.lazy.number="deleteBackupDays" min="0" max="1000" step="1" />
                        </div>
                        <div class="control">
                            <a class="button is-static" v-text="lang('intervalKeyDays')"></a>
                        </div>
                    </div>
                </div>
            </div>
            <div class="field is-horizontal">
                <div class="field-label is-normal">
                    <label class="label colon" v-text="lang('keepLastBackupFiles')"></label>
                </div>
                <div class="field-body">
                    <div class="field has-addons">
                        <div class="control is-expanded">
                            <input type="number" :disabled="deleteBackupDays === 0" class="input" v-model.lazy.number="keepBackupFiles" min="1" max="1000" step="1" />
                        </div>
                        <div class="control">
                            <a class="button is-static" v-text="lang('filesCount')"></a>
                        </div>
                    </div>
                </div>
            </div>
        </fieldset>
    </div>
</template>
