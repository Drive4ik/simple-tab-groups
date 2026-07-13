<script>

import popup from '../components/popup.vue';
import GithubGistFields from './github-gist-fields.vue';

import '/js/prefixed-storage.js';
import * as Constants from '/js/constants.js';
import Lang from '/js/lang.js';
import * as Storage from '/js/storage.js';
import * as Cloud from '/js/sync/cloud/cloud.js';
import GithubGist from '/js/sync/cloud/githubgist.js';

import syncAreaMixin from '/js/mixins/sync-area.mixin.js';

export default {
    name: 'github-gist-access',
    mixins: [syncAreaMixin],
    data() {
        this.browserName = `${Constants.BROWSER_FULL_NAME} v${Constants.BROWSER.version}`;
        this.helpLink = Constants.PAGES.HELP.HOWTO_GITHUB_GIST;

        return {
            errorMessage: '',
            confirmForgetGistArea: null,
        };
    },
    components: {
        popup,
        GithubGistFields,
    },
    computed: {
        icon() {
            return this.area === this.sync
                ? {save: '/icons/cloud-arrow-up-solid.svg'}
                : {save: '/icons/floppy-disk-solid.svg'};
        },
    },
    created() {
        this.sync.load();

        this.local.load().then(() => {
            this.$watch('local.options.syncOptionsLocation', syncOptionsLocation => {
                Storage.set({syncOptionsLocation});
            });
        });
    },
    methods: {
        lang: Lang,
        submit(area) {
            const savedGistName = area.optionsBackup.githubGistName;

            if (savedGistName && area.options.githubGistName !== savedGistName) {
                this.confirmForgetGistArea = area;
                return;
            }

            this.save(area);
        },
        async save(area) {
            this.confirmForgetGistArea = null;

            try {
                area.loadingOptions = true;

                if (area.options.githubGistToken) {
                    await new GithubGist(area.options.githubGistToken, area.options.githubGistName).checkToken();
                }

                await area.save();
                await area.load();
            } catch ({message}) {
                this.errorMessage = String(new Cloud.CloudError(message));
            } finally {
                area.loadingOptions = false;
            }
        },
    },
};

</script>

<template>
<div class="box">
    <div class="columns is-mobile is-vcentered">
        <div class="column">
            <span class="is-size-5" v-text="lang('githubGistAccessTitle')"></span>
            <span class="tag is-info ml-2">BETA</span>
        </div>
        <div class="column is-narrow has-text-right">
            <a class="button is-link" :href="helpLink" target="_blank">
                <span class="icon">
                    <figure class="image is-16x16">
                        <img src="/icons/help.svg" />
                    </figure>
                </span>
                <span v-text="lang('helpTitle')"></span>
            </a>
        </div>
    </div>

    <div class="field is-horizontal">
        <div class="field-label is-normal">
            <label class="label colon" v-text="lang('githubGistAccessLocation')"></label>
        </div>
        <div class="field-body">
            <div class="field">
                <div class="field">
                    <div class="control has-icons-left">
                        <div class="select">
                            <select v-model="local.options.syncOptionsLocation">
                                <option v-for="area in areas" :key="area.value" :value="area.value" v-text="lang(area.title)"></option>
                            </select>
                        </div>
                        <span class="icon is-left">
                            <figure class="image is-16x16">
                                <img :src="icon.save">
                            </figure>
                        </span>
                    </div>
                </div>

                <template v-if="area.disabled">
                    <div class="mt-3 mb-3" v-html="lang(['browserIsNotFirefox', browserName], {
                        a: {
                            'sync-url': {
                                href: 'https://www.mozilla.org/firefox/sync/',
                                target: '_blank',
                            },
                        },
                    })"></div>
                    <div>
                        <a class="button is-link" href="https://www.mozilla.org/firefox/new/" target="_blank">
                            <span class="icon">
                                <figure class="image is-16x16">
                                    <img src="/icons/logo-firefox.svg">
                                </figure>
                            </span>
                            <span v-text="lang('downloadFirefox')"></span>
                        </a>
                    </div>
                </template>
            </div>
        </div>
    </div>

    <form class="field" @submit.prevent="submit(area)">
        <fieldset :disabled="area.disabled || area.loadingOptions">
            <github-gist-fields
                class="field"
                :token.sync="area.options.githubGistToken"
                :gist-name.sync="area.options.githubGistName"
                :error-message.sync="errorMessage"
            ></github-gist-fields>

            <div class="is-flex is-align-items-center">
                <div v-if="!area.disabled" class="hidden-empty">
                    <div v-if="area.gist" class="is-flex is-align-items-center gap-indent">
                        <div class="breadcrumb mb-0">
                            <ul class="is-align-items-center">
                                <li v-for="(breadcrumb, i) in area.gist.breadcrumb" :key="i">
                                    <a :href="breadcrumb.url" :class="{'has-text-weight-semibold': breadcrumb.isBold}" target="_blank" rel="noreferrer noopener">
                                        <figure v-show="breadcrumb.imageLoaded" class="image is-24x24 mr-2">
                                            <img :src="breadcrumb.image" @load="breadcrumb.imageLoaded = true" decoding="async" />
                                        </figure>

                                        <span v-if="breadcrumb.text" v-text="breadcrumb.text"></span>
                                    </a>
                                </li>
                            </ul>
                        </div>
                        <span class="tag is-rounded" v-text="lang('githubSecretTitle')"></span>
                        <span>
                            <span class="colon" v-text="lang('lastUpdate')"></span>
                            <time class="is-underline-dotted" :title="area.gist.lastUpdateFull" :datetime="area.gist.lastUpdateISO" v-text="area.gist.lastUpdateAgo"></time>
                        </span>
                    </div>
                    <figure v-else-if="area.loadingGist" class="image is-16x16">
                        <img src="/icons/animate-spinner.svg">
                    </figure>
                </div>
                <div class="field is-grouped is-grouped-right is-flex-grow-1">
                    <div class="control">
                        <button type="submit" class="button is-success is-soft" :class="{'is-loading': area.loadingOptions}">
                            <span class="icon">
                                <figure class="image is-16x16">
                                    <img :src="icon.save">
                                </figure>
                            </span>
                            <span v-text="lang('saveSettings')"></span>
                        </button>
                    </div>
                </div>
            </div>
        </fieldset>
    </form>

    <popup
        v-if="confirmForgetGistArea"
        :title="lang('githubGistNameTitle')"
        @save="save(confirmForgetGistArea)"
        @close-popup="confirmForgetGistArea = null"
        :buttons="
            [{
                event: 'save',
                classList: 'is-success is-soft',
                lang: 'saveSettings',
                focused: true,
            }, {
                event: 'close-popup',
                lang: 'cancel',
            }]
        ">
        <span v-text="lang('githubGistNameChangeWarning')"></span>
    </popup>
</div>
</template>
