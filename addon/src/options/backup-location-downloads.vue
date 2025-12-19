<script>

import contextMenu from '../components/context-menu.vue';

import '/js/prefixed-storage.js';
import * as Constants from '/js/constants.js';
import Notification from '/js/notification.js';
import * as Utils from '/js/utils.js';
import * as File from '/js/file.js';

import optionsMixin from '/js/mixins/options.mixin.js';

export default {
    mixins: [optionsMixin],
    data() {
        this.FILE_PATH_VARIABLES = Utils.getFilePathVariables();

        return {};
    },
    components: {
        'context-menu': contextMenu,
    },
    created() {
        this.$on('options-reloaded', () => this.addCustomWatchers());
    },
    methods: {
        lang: browser.i18n.getMessage,
        addCustomWatchers() {
            this.optionsWatch('autoBackupFilePathFile', async (value, oldValue) => {
                try {
                    await File.testFilePath(value);
                    return value;
                } catch (e) {
                    Notification(e);
                    return oldValue;
                }
            });
        },
        insertVariableToFilePath(variable) {
            const {selectionStart, selectionEnd} = this.$refs.autoBackupFilePathFile;
            let filePath = this.options.autoBackupFilePathFile;

            filePath = filePath.slice(0, selectionStart) +
                `{${variable}}` +
                filePath.slice(selectionEnd, filePath.length);

            this.options.autoBackupFilePathFile = filePath;
        },
        openBackupFolder() {
            File.openBackupFolder();
        },
    },
}

</script>

<template>
    <div class="field">
        <div class="field is-horizontal">
            <div class="field-label is-normal">
                <label class="label colon" v-text="lang('filePathTitle')"></label>
            </div>
            <div class="field-body">
                <div class="field">
                    <div class="field has-addons">
                        <div class="control">
                            <a class="button is-static" v-text="lang('downloadsFolder') + '/'"></a>
                        </div>
                        <div class="control is-expanded">
                            <input type="text"
                                v-model.lazy.trim="options.autoBackupFilePathFile"
                                ref="autoBackupFilePathFile"
                                maxlength="200"
                                :title="lang('filePathTitle')"
                                class="input"
                                />
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
    </div>
</template>
