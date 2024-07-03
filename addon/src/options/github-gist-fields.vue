<script>

import * as Constants from '/js/constants.js';
import {CloudError} from '/js/sync/cloud/cloud.js';
import GithubGist from '/js/sync/cloud/githubgist.js';

export default {
    props: {
        token: {
            type: String,
            required: true,
        },
        fileName: {
            type: String,
            required: true,
        },
        gistId: {
            type: String,
            required: true,
        },
        error: {
            type: String,
            default: '',
        },
    },
    data() {
        this.FILE_NAME_PARTS = Constants.GIT_GIST_FILE_NAME_PARTS;

        return {
            tokenLoading: false,
            tokenCheched: null,
        };
    },
    watch: {
        internalToken() {
            this.tokenCheched = null;
        },
    },
    computed: {
        internalToken: {
            get() {
                return this.token;
            },
            set(value) {
                this.$emit('update:token', value);
            },
        },
        internalFileName: {
            get() {
                return this.fileName.slice(this.FILE_NAME_PARTS.start.length, - this.FILE_NAME_PARTS.end.length);
            },
            set(value) {
                this.$emit('update:fileName', this.FILE_NAME_PARTS.start + value + this.FILE_NAME_PARTS.end);
                this.internalGistId = '';
            },
        },
        internalGistId: {
            get() {
                return this.gistId;
            },
            set(value) {
                this.$emit('update:gistId', value);
            },
        },
        isValidFileName() {
            return this.internalFileName.length > 0 && !this.fileName.includes('/');
        },
    },
    methods: {
        lang: browser.i18n.getMessage,

        async checkToken() {
            try {
                this.tokenLoading = true;
                this.tokenCheched = null;

                const GithubGistCloud = new GithubGist(this.token);

                await GithubGistCloud.checkToken();

                this.tokenCheched = true;
                this.$emit('update:error', '');
            } catch ({message}) {
                this.$emit('update:error', new CloudError(message).toString());
                this.tokenCheched = false;
            } finally {
                this.tokenLoading = false;
            }
        },
    },
}

</script>

<template>
<div>
    <div class="field is-horizontal">
        <div class="field-label is-normal">
            <label class="label" v-text="lang('githubGistTokenTitle') + ':'"></label>
        </div>
        <div class="field-body">
            <div class="field has-addons">
                <div :class="['control is-expanded has-icons-left', {
                    'is-loading': tokenLoading,
                    'has-icons-right': tokenCheched !== null,
                    }]">
                    <input type="text" v-model.trim="internalToken" maxlength="40" class="input" />

                    <span class="icon is-left">
                        <img class="size-16" src="/icons/key-solid.svg">
                    </span>
                    <span v-if="tokenCheched !== null" class="icon is-right">
                        <img v-if="tokenCheched" class="size-16" src="/icons/check.svg">
                        <img v-else class="size-16" src="/icons/close.svg">
                    </span>
                </div>
                <div class="control">
                    <button class="button" @click="checkToken" :disabled="tokenLoading" v-text="lang('githubGistCheckToken')"></button>
                </div>
            </div>
        </div>
    </div>
    <div class="field is-horizontal">
        <div class="field-label is-normal">
            <label class="label" v-text="lang('fileNameTitle') + ':'"></label>
        </div>
        <div class="field-body">
            <div class="field has-addons">
                <div class="control">
                    <a class="button is-static" v-text="FILE_NAME_PARTS.start"></a>
                </div>
                <div class="control is-expanded" :class="{'has-icons-right': !isValidFileName}">
                    <input type="text" v-model.trim="internalFileName" maxlength="100" class="input" />
                    <span v-if="!isValidFileName" class="icon is-right">
                        <img class="size-16" src="/icons/close.svg">
                    </span>
                </div>
                <div class="control">
                    <a class="button is-static" v-text="FILE_NAME_PARTS.end"></a>
                </div>
            </div>
        </div>
    </div>
    <div class="field error-field">
        <p class="has-text-danger has-text-right" v-text="error"></p>
    </div>
</div>
</template>

<style scoped>
.error-field {
    min-height: 1.5em;
}
</style>
