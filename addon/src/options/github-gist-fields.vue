<script>

import Lang from '/js/lang.js';
import {CloudError} from '/js/sync/cloud/cloud.js';
import GithubGist from '/js/sync/cloud/githubgist.js';

export default {
    props: {
        token: {
            type: String,
            required: true,
        },
        gistName: {
            type: String,
            required: true,
        },
        errorMessage: {
            type: String,
            default: '',
        },
    },
    data() {
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
        internalGistName: {
            get() {
                return this.gistName || '';
            },
            set(value) {
                this.$emit('update:gistName', value);
            },
        },
        isValidGistName() {
            return this.internalGistName.length > 0;
        },
    },
    methods: {
        lang: Lang,

        async checkToken() {
            try {
                this.tokenLoading = true;
                this.tokenCheched = null;

                await new GithubGist(this.token, 'check-token').checkToken();

                this.tokenCheched = true;
            } catch ({message}) {
                this.tokenCheched = false;
                this.$emit('update:errorMessage', String(new CloudError(message)));
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
            <label class="label colon" v-text="lang('githubGistNameTitle')"></label>
        </div>
        <div class="field-body">
            <div class="field">
                <div class="control" :class="{'has-icons-right': !isValidGistName}">
                    <input required type="text" v-model.trim="internalGistName" maxlength="100" class="input" />
                    <span v-if="!isValidGistName" class="icon is-right">
                        <figure class="image is-16x16">
                            <img src="/icons/close.svg" />
                        </figure>
                    </span>
                </div>
                <p class="help" v-text="lang('githubGistNameHelp')"></p>
            </div>
        </div>
    </div>
    <div v-if="errorMessage" class="field error-message">
        <p class="has-text-danger has-text-right white-space-pre-line" v-text="errorMessage"></p>
    </div>
</div>
</template>
