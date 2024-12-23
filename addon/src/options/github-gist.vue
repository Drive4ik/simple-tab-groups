<script>

import GithubGistFields from './github-gist-fields.vue';

import * as Constants from '/js/constants.js';
import Logger from '/js/logger.js';
import * as Storage from '/js/storage.js';
import * as Utils from '/js/utils.js';
import * as Urls from '/js/urls.js';
import * as SyncStorage from '/js/sync/sync-storage.js';
import GithubGist from '/js/sync/cloud/githubgist.js';
import {CloudError} from '/js/sync/cloud/cloud.js';

import syncCloudMixin from '/js/mixins/sync-cloud.mixin.js';

export default {
    name: 'github-gist',
    mixins: [syncCloudMixin],
    data() {
        this.browserName = `${Constants.BROWSER.name} ${Constants.BROWSER.vendor} v${Constants.BROWSER.version}`;
        this.helpLink = Urls.getURL('how-to-github-gist');

        return {
            sync: {
                title: 'syncOptionLocatedFFSync',
                disabled: !SyncStorage.IS_AVAILABLE,
                loading: false,
                value: Constants.SYNC_STORAGE_FSYNC,
                options: {...Constants.DEFAULT_SYNC_OPTIONS},
                load: this.loadSyncOptions.bind(this),
                save: this.saveSyncOptions.bind(this),
                gist: null,
                error: '',
                icon: {
                    load: '/icons/cloud-arrow-down-solid.svg',
                    save: '/icons/cloud-arrow-up-solid.svg',
                },
            },
            local: {
                title: 'syncOptionLocatedLocally',
                disabled: false,
                loading: false,
                value: Constants.SYNC_STORAGE_LOCAL,
                options: {...Constants.DEFAULT_SYNC_OPTIONS, syncOptionsLocation: Constants.DEFAULT_OPTIONS.syncOptionsLocation},
                load: this.loadLocalOptions.bind(this),
                save: this.saveLocalOptions.bind(this),
                gist: null,
                error: '',
                icon: {
                    load: '/icons/arrow-down.svg',
                    save: '/icons/floppy-disk-solid.svg',
                },
            },
        };
    },
    components: {
        GithubGistFields,
    },
    watch: {
        synchronisationError() {
            this.area.error = this.synchronisationError;
        },
    },
    computed: {
        areas() {
            return [this.sync, this.local];
        },
        area() {
            return this.areas.find(area => area.value === this.local.options.syncOptionsLocation);
        },
    },
    created() {
        this.sync.load();

        this.local.load().then(() => {
            this.$watch('local.options.syncOptionsLocation', syncOptionsLocation => {
                Storage.set({syncOptionsLocation});
                this.area.error = '';
                this.synchronisationProgress = 0;
            });
        });

        this.$on('sync-finish', () => this.area.load(false));
    },
    methods: {
        lang: browser.i18n.getMessage,

        createCloud({githubGistToken, githubGistFileName}) {
            return new GithubGist(githubGistToken, githubGistFileName);
        },

        // SYNC
        async loadSyncOptions(resetState) {
            if (!this.sync.disabled) {
                Object.assign(this.sync.options, await SyncStorage.get());
                await this.loadGistInfo(this.sync, resetState);
            }
        },

        async saveSyncOptions() {
            await SyncStorage.set({...this.sync.options});
        },

        // LOCAL
        async loadLocalOptions(resetState) {
            Object.assign(this.local.options, await Storage.get(this.local.options));
            await this.loadGistInfo(this.local, resetState);
        },

        async saveLocalOptions() {
            await Storage.set({...this.local.options});
        },

        async loadGistInfo(area, resetState = true) {
            if (resetState) {
                area.error = '';
                this.synchronisationProgress = 0;
            }

            if (!area.options.githubGistToken) {
                area.gist = false;
                return;
            }

            area.gist = null;

            const GithubGistCloud = this.createCloud(area.options);

            const gist = await GithubGistCloud.getInfo().catch(e => false);

            if (gist) {
                area.gist = {
                    breadcrumb: [
                        {
                            url: gist.html_url.slice(0, gist.html_url.indexOf(gist.owner.login) + gist.owner.login.length),
                            image: gist.owner.avatar_url,
                            imageLoaded: false,
                            text: gist.owner.login,
                        }, {
                            url: gist.html_url,
                            text: area.options.githubGistFileName,
                            isBold: true,
                        },
                    ],
                    lastUpdateAgo: Utils.timeAgo(gist.updated_at),
                    lastUpdateFull: new Date(gist.updated_at).toLocaleString(Utils.UI_LANG, {timeZoneName: 'longOffset'}),
                };
            } else {
                area.gist = false;
            }
        },

        // MAIN
        async save(area) {
            try {
                area.error = '';
                area.loading = true;

                if (area.options.githubGistToken) {
                    const GithubGistCloud = this.createCloud(area.options);

                    await GithubGistCloud.checkToken();
                }

                await area.save();
                await area.load();
            } catch ({message}) {
                area.error = new CloudError(message).toString();
            } finally {
                area.loading = false;
            }
        },

        async startCloudSync() {
            this.area.error = '';

            await this.syncCloud();
        },
    },
};

</script>

<template>
    <div class="box">
        <div class="columns is-mobile is-vcentered">
            <div class="column">
                <span class="is-size-5" v-text="lang('githubGistCloudSettingsTitle')"></span>
                <span class="tag is-info ml-2">BETA</span>
            </div>
            <div class="column is-narrow has-text-right">
                <a class="button is-link" :href="helpLink" target="_blank">
                    <span v-text="lang('helpTitle')"></span>
                </a>
            </div>
        </div>

        <div class="field is-horizontal">
            <div class="field-label is-normal">
                <label class="label" v-text="lang('syncSettingsLocation') + ':'"></label>
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
                                <img class="size-16" :src="area.icon.save">
                            </span>
                        </div>
                    </div>

                    <template v-if="area.disabled">
                        <div class="mt-3 mb-3" v-html="lang('browserIsNotFirefox', [browserName])"></div>
                        <div>
                            <a class="button is-link" href="https://www.mozilla.org/firefox/new/" target="_blank">
                                <span class="icon">
                                    <img class="size-16" src="/icons/logo-firefox.svg">
                                </span>
                                <span v-text="lang('downloadFirefox')"></span>
                            </a>
                        </div>
                    </template>
                </div>
            </div>
        </div>

        <form class="field" @submit.prevent="save(area)" @reset.prevent="area.load">
            <fieldset :disabled="area.disabled || area.loading">
                <github-gist-fields
                    class="field"
                    :token.sync="area.options.githubGistToken"
                    :file-name.sync="area.options.githubGistFileName"
                    :error.sync="area.error"
                ></github-gist-fields>

                <div class="is-flex is-align-items-center">
                    <div v-if="!area.disabled" class="hidden-empty">
                        <div v-if="area.gist" class="is-flex is-align-items-center indent-gap">
                            <div class="breadcrumb mb-0">
                                <ul class="is-align-items-center">
                                    <li
                                        v-for="(breadcrumb, i) in area.gist.breadcrumb"
                                        :key="i"
                                        >
                                        <a :href="breadcrumb.url" :class="{'has-text-weight-semibold': breadcrumb.isBold}" target="_blank" rel="noreferrer noopener">
                                            <figure v-show="breadcrumb.imageLoaded" class="image is-24x24 mr-2">
                                                <img :src="breadcrumb.image" @load="breadcrumb.imageLoaded = true" decoding="async" />
                                            </figure>

                                            <span v-if="breadcrumb.text" v-text="breadcrumb.text"></span>
                                        </a>
                                    </li>
                                </ul>
                            </div>
                            <span class="tag is-dark is-rounded" v-text="lang('githubSecretTitle')"></span>
                            <span :title="area.gist.lastUpdateFull" v-text="lang('lastUpdateAgo', area.gist.lastUpdateAgo)"></span>
                        </div>
                        <div v-else-if="area.gist === null">
                            <img class="size-16" src="/icons/animate-spinner.svg">
                        </div>
                    </div>
                    <div class="field is-grouped is-grouped-right is-flex-grow-1">
                        <div class="control">
                            <button type="reset" class="button is-info">
                                <span class="icon">
                                    <img class="size-16" :src="area.icon.load">
                                </span>
                                <span v-text="lang('load')"></span>
                            </button>
                        </div>
                        <div class="control">
                            <button type="submit" class="button is-success" :class="{'is-loading': area.loading}">
                                <span class="icon">
                                    <img class="size-16" :src="area.icon.save">
                                </span>
                                <span v-text="lang('saveSettings')"></span>
                            </button>
                        </div>
                    </div>
                </div>

                <hr>

                <div class="columns is-vcentered">
                    <div class="column">
                        <div class="simple-progress">
                            <div class="position" :class="{
                                'in-progress': synchronisationInProgress,
                                'has-background-success': !area.error && synchronisationProgress === 100,
                                'has-background-danger': !!area.error,
                            }"
                            :style="{
                                '--progress-value': `${synchronisationProgress}%`,
                            }"
                            ></div>
                        </div>
                    </div>
                    <div class="column is-narrow has-text-right">
                        <button
                            class="button is-primary"
                            :class="{
                                'is-loading': synchronisationInProgress || area.loading,
                            }"
                            :disabled="synchronisationInProgress || area.loading"
                            @click.prevent="startCloudSync"
                            >
                            <span class="icon">
                                <img class="size-16" src="/icons/cloud-arrow-up-solid.svg">
                            </span>
                            <span v-text="lang('syncStart')"></span>
                        </button>
                    </div>
                </div>
            </fieldset>
        </form>
    </div>
</template>


<style scoped>
html[data-theme="dark"] .box {
    color: unset;
    background-color: #313131;

    .subtitle {
        color: #cecece;
    }
}


.simple-progress {
    display: flex;
    width: 100%;
    height: 1em;

    > .position {
        --transition-time: 0ms;
        transition: width var(--transition-time), background-color var(--transition-time);

        width: var(--progress-value, 0px);
        background-color: hsla(0, 0%, 50%, .5);
        border-radius: 999px;

        &.in-progress {
            --transition-time: .2s;
        }
    }
}

</style>
