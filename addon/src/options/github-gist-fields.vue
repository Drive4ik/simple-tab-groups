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
            tokenHidden: true,
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

                const GithubGistCloud = new GithubGist(this.token, 'check-token');

                await GithubGistCloud.checkToken();

                this.tokenCheched = true;
                this.$emit('update:error', '');
            } catch ({message}) {
                this.tokenCheched = false;
                this.$emit('update:error', new CloudError(message).toString());
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
            <label class="label colon" v-text="lang('githubGistTokenTitle')"></label>
        </div>
        <div class="field-body">
            <div class="field has-addons">
                <div class="control is-expanded has-icons-left has-icons-right">
                    <input :type="tokenHidden ? 'password' : 'text'" v-model.trim="internalToken" maxlength="100" class="input" />

                    <span class="icon is-left">
                        <figure class="image is-16x16">
                            <img class="no-fill" src="/icons/key-solid.svg" />
                        </figure>
                    </span>
                    <span v-if="tokenCheched !== null" class="icon is-right">
                        <figure class="image is-16x16">
                            <img v-if="tokenCheched" class="no-fill" src="/icons/check.svg" />
                            <img v-else class="no-fill" src="/icons/close.svg" />
                        </figure>
                    </span>
                </div>
                <div class="control">
                    <button type="button" class="button"
                        @mousedown.prevent="tokenHidden = false"
                        @keydown.prevent.space="tokenHidden = false"
                        @keyup.prevent.space="tokenHidden = true"
                        @blur.prevent="tokenHidden = true"
                        @mouseup.prevent="tokenHidden = true"
                        @mouseleave.prevent="tokenHidden = true"
                        >
                        <span class="icon">
                            <figure class="image is-16x16">
                                <img v-if="tokenHidden" src="/icons/eye.svg" />
                                <img v-else src="/icons/eye-slash.svg" />
                            </figure>
                        </span>
                    </button>
                </div>
                <div class="control">
                    <button type="button" class="button" :class="{'is-loading': tokenLoading}" @click.prevent="checkToken" v-text="lang('githubGistCheckToken')"></button>
                </div>
            </div>
        </div>
    </div>
    <div class="field is-horizontal">
        <div class="field-label is-normal">
            <label class="label colon" v-text="lang('fileNameTitle')"></label>
        </div>
        <div class="field-body">
            <div class="field has-addons">
                <div class="control">
                    <a class="button is-static" v-text="FILE_NAME_PARTS.start"></a>
                </div>
                <div class="control is-expanded" :class="{'has-icons-right': !isValidFileName}">
                    <input required type="text" v-model.trim="internalFileName" maxlength="100" class="input" />
                    <span v-if="!isValidFileName" class="icon is-right">
                        <figure class="image is-16x16">
                            <img src="/icons/close.svg" />
                        </figure>
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
