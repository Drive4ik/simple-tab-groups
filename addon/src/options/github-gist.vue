<script>

import GithubGistFields from './github-gist-fields.vue';

import * as Constants from '/js/constants.js';
import Logger from '/js/logger.js';
import * as Storage from '/js/storage.js';
import * as Utils from '/js/utils.js';
import * as SyncStorage from '/js/sync/sync-storage.js';
import GithubGist from '/js/sync/cloud/githubgist.js';
import {CloudError} from '/js/sync/cloud/cloud.js';

export default {
    data() {
        this.SYNC_STORAGE_IS_AVAILABLE = SyncStorage.IS_AVAILABLE;
        // this.SYNC_STORAGE_IS_AVAILABLE = false;
        this.SYNC_STORAGE_FSYNC = Constants.SYNC_STORAGE_FSYNC;
        this.SYNC_STORAGE_LOCAL = Constants.SYNC_STORAGE_LOCAL;

        return {
            isActiveHelp: false,

            browserInfo: {
                name: null,
                version: null,
            },

            sync: {
                title: 'syncOptionLocatedFFSync',
                disabled: !this.SYNC_STORAGE_IS_AVAILABLE,
                loading: false,
                value: this.SYNC_STORAGE_FSYNC,
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
                value: this.SYNC_STORAGE_LOCAL,
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
        browserName() {
            return `${this.browserInfo.name} v${this.browserInfo.version}`;
        },
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
        })

        this.loadBrowserInfo();
    },
    methods: {
        lang: browser.i18n.getMessage,

        async loadBrowserInfo() {
            Object.assign(this.browserInfo, await browser.runtime.getBrowserInfo());
        },

        createCloud({githubGistToken, githubGistFileName, githubGistId}) {
            return new GithubGist(githubGistToken, githubGistFileName, githubGistId);
        },

        // SYNC
        async loadSyncOptions() {
            if (this.SYNC_STORAGE_IS_AVAILABLE) {
                Object.assign(this.sync.options, await SyncStorage.get());
                await this.loadGistInfo(this.sync);
            }
        },

        async saveSyncOptions() {
            await SyncStorage.set({...this.sync.options});
        },

        // LOCAL
        async loadLocalOptions() {
            Object.assign(this.local.options, await Storage.get(this.local.options));
            await this.loadGistInfo(this.local);
        },

        async saveLocalOptions() {
            await Storage.set({...this.local.options});
        },

        async loadGistInfo(area) {
            area.gist = null;

            if (!area.options.githubGistId) {
                area.gist = false;
                return;
            }

            const GithubGistCloud = this.createCloud(area.options);

            const gist = await GithubGistCloud.getGist(true).catch(e => false);

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
                            text: GithubGistCloud.fileName,
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
                this.synchronisationProgress = 0;

                area.error = '';
                area.loading = true;

                if (area.options.githubGistToken) {
                    const GithubGistCloud = this.createCloud(area.options);

                    await GithubGistCloud.checkToken();
                    await GithubGistCloud.findGistId();

                    area.options.githubGistId = GithubGistCloud.gistId;
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
            await this.area.load();
        },
    },
};

</script>

<template>
    <div class="box">
        <div class="field level">
            <div class="level-left">
                <div class="level-item">
                    <div class="subtitle" v-text="lang('githubGistCloudSettingsTitle')"></div>
                </div>
            </div>
            <div class="level-right">
                <div class="level-item">
                    <div :class="['dropdown is-right', isActiveHelp && 'is-active']">
                        <div class="dropdown-trigger">
                            <button class="button is-info" @click="isActiveHelp = !isActiveHelp">
                                <span v-text="lang('helpTitle')"></span>
                                <span class="icon">
                                    <img class="size-16" src="/icons/arrow-down.svg">
                                </span>
                            </button>
                        </div>
                        <div class="dropdown-menu">
                            <div class="dropdown-content">
                                <div class="dropdown-item content">
                                    <div>how create github account</div>
                                    <p class="is-size-5">Add the <code>is-right</code> modifier for a <strong>right-aligned</strong> dropdown.</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
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

                    <template v-if="area === sync && sync.disabled">
                        <div class="mt-3 mb-3" v-html="lang('browserIsNotFirefox', [browserName])"></div>
                        <div>
                            <a class="button is-link" href="https://www.mozilla.org/firefox/new/" target="_blank">
                                <span class="icon">
                                    <img class="size-16" src="/icons/firefox-logo.svg">
                                </span>
                                <span v-text="lang('downloadFirefox')"></span>
                            </a>
                        </div>
                    </template>
                </div>
            </div>
        </div>

        <fieldset class="field" :disabled="area.disabled || area.loading">
            <github-gist-fields
                class="field"
                :token.sync="area.options.githubGistToken"
                :file-name.sync="area.options.githubGistFileName"
                :gistId.sync="area.options.githubGistId"
                :error.sync="area.error"
            ></github-gist-fields>

            <div class="is-flex is-justify-content-space-between is-align-items-center">
                <div class="is-flex-grow-1">
                    <div v-if="area.gist" class="is-flex is-align-items-center indent-gap">
                        <div class="breadcrumb mb-0">
                            <ul class="is-align-items-center">
                                <li
                                    v-for="(breadcrumb, i) in area.gist.breadcrumb"
                                    :key="i"
                                    >
                                    <a :href="breadcrumb.url" :class="{'has-text-weight-semibold': breadcrumb.isBold}" target="_blank" rel="noreferrer noopener">
                                        <figure v-show="breadcrumb.imageLoaded" class="image is-24x24 mr-2">
                                            <img :src="breadcrumb.image" @load="breadcrumb.imageLoaded = true" loading="lazy" decoding="async" />
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
                <div>
                    <div class="field is-grouped">
                        <div class="control">
                            <button class="button is-info" @click="area.load">
                                <span class="icon">
                                    <img class="size-16" :src="area.icon.load">
                                </span>
                                <span v-text="lang('load')"></span>
                            </button>
                        </div>
                        <div class="control">
                            <button :class="['button is-success', {'is-loading': area.loading}]" @click="save(area)">
                                <span class="icon">
                                    <img class="size-16" :src="area.icon.save">
                                </span>
                                <span v-text="lang('saveSettings')"></span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>


            <hr>

            <div class="columns is-vcentered">
                <div class="column">
                    <div class="simple-progress">
                        <div :class="['position', {
                            'has-background-success': !area.error,
                            'has-background-danger': !!area.error,
                        }]"
                        :style="{
                            '--progress-value': `${synchronisationProgress}%`,
                        }"
                        ></div>
                    </div>
                </div>
                <div class="column is-narrow">
                    <button
                        :class="['button is-primary', {
                            'is-loading': synchronisationInProgress || area.loading,
                        }]"
                        :disabled="synchronisationInProgress || area.loading"
                        @click="startCloudSync"
                        >
                        <span class="icon">
                            <img class="size-16" src="/icons/cloud-arrow-up-solid.svg">
                        </span>
                        <span v-text="lang('syncStart')"></span>
                    </button>
                </div>
            </div>

        </fieldset>
    </div>
</template>


<style scoped>
html[data-theme="dark"] .box {
    color: unset;
    background-color: #313131;
}
html[data-theme="dark"] .box .subtitle {
    color: #cecece;
}

.simple-progress {
    display: flex;
    width: 100%;
    height: 1em;
}

.simple-progress > .position {
    --transition-time: .2s;

    transition: width var(--transition-time), background-color var(--transition-time);
    width: var(--progress-value, 0px);
    border-radius: 999px;
}

</style>
