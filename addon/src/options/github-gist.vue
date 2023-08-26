<script>

import GithubGistFields from './github-gist-fields.vue';

import * as Constants from '/js/constants.js';
import Logger from '/js/logger.js';
import * as Storage from '/js/storage.js';
import * as SyncStorage from '/js/sync/sync-storage.js';
import GithubGist from '/js/sync/cloud/githubgist.js';
// import GithubGist from './githubgist.js';

export default {
    data() {
        this.SYNC_STORAGE_FSYNC = Constants.SYNC_STORAGE_FSYNC;
        this.SYNC_STORAGE_LOCAL = Constants.SYNC_STORAGE_LOCAL;
        // this.SYNC_STORAGE_IS_AVAILABLE = false;
        this.SYNC_STORAGE_IS_AVAILABLE = SyncStorage.IS_AVAILABLE;

        return {
            isActiveHelp: false,

            browserInfo: {
                name: null,
                version: null,
            },

            sync: {
                loading: false,
                options: {...Constants.DEFAULT_SYNC_OPTIONS},
                load: this.loadSyncOptions.bind(this),
                save: this.saveSyncOptions.bind(this),
                error: '',
            },
            local: {
                loading: false,
                options: {...Constants.DEFAULT_SYNC_OPTIONS, syncOptionsLocation: Constants.DEFAULT_OPTIONS.syncOptionsLocation},
                load: this.loadLocalOptions.bind(this),
                save: this.saveLocalOptions.bind(this),
                error: '',
            },
        };
    },
    components: {
        GithubGistFields,
    },
    watch: {
        'local.options.syncOptionsLocation'(syncOptionsLocation) {
            Storage.set({syncOptionsLocation});
        },
    },
    computed: {
        browserName() {
            return `${this.browserInfo.name} v${this.browserInfo.version}`;
        },
    },
    created() {
        this.sync.load();
        this.local.load();
        this.loadBrowserInfo();
    },
    methods: {
        lang: browser.i18n.getMessage,

        async loadBrowserInfo() {
            Object.assign(this.browserInfo, await browser.runtime.getBrowserInfo());
        },

        // SYNC
        async loadSyncOptions() {
            if (this.SYNC_STORAGE_IS_AVAILABLE) {
                Object.assign(this.sync.options, await SyncStorage.get());
            }
        },

        async saveSyncOptions() {
            await SyncStorage.set({...this.sync.options});
        },

        // LOCAL
        async loadLocalOptions() {
            Object.assign(this.local.options, await Storage.get(this.local.options));
        },

        async saveLocalOptions() {
            await Storage.set({...this.local.options});
        },

        // MAIN
        async save(area) {
            area.error = '';
            area.loading = true;

            await area.save();

            try {
                const result = await this.createBackup(area.options);

                console.debug('result', result)

                if (result.newGistId) {
                    area.options.githubGistId = result.newGistId;

                    await area.save();
                }
            } catch (e) {
                area.error = e.message;
            } finally {
                area.loading = false;
            }
        },

        async createBackup({githubGistToken, githubGistFileName, githubGistId}) {
            const GithubGistCloud = new GithubGist(githubGistToken, githubGistFileName, githubGistId);

            const result = {};

            await GithubGistCloud.checkToken();

            if (GithubGistCloud.gistId) {
                const gist = await GithubGistCloud.getGist().catch(() => {});

                if (!gist) {
                    result.newGistId = await GithubGistCloud.findGistId().catch(() => {});
                }
            } else {
                result.newGistId = await GithubGistCloud.findGistId().catch(() => {});
            }


            function getBackupForCloud() {
                return {"version": "44"}
            }

            const content = await getBackupForCloud();

            if (GithubGistCloud.gistId) { // update backup
                await GithubGistCloud.updateGist(content);
            } else {
                const gist = await GithubGistCloud.createGist(content, browser.i18n.getMessage('githubGistBackupDescription'));

                result.newGistId = gist.id;
            }

            return result;
        },

    },
};

</script>

<template>
    <div class="box">
        <div class="field level">
            <div class="level-left">
                <div class="level-item">
                    <div class="subtitle">GitHub Gist cloud settings</div>
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

        <div v-if="!SYNC_STORAGE_IS_AVAILABLE" class="field">
            <p class="field">Your browser is: {{browserName}}, it doesn't support <a href="https://www.mozilla.org/firefox/sync/" target="_blank" class="is-underlined">Firefox Sync</a></p>
            <p class="field">
                <a class="button is-link" href="https://www.mozilla.org/firefox/new/" target="_blank">
                    <span class="icon">
                        <img class="size-16" src="/icons/firefox-logo.svg">
                    </span>
                    <span>Download Firefox</span>
                </a>
            </p>
        </div>

        <fieldset class="field" :disabled="!SYNC_STORAGE_IS_AVAILABLE || sync.loading">
            <legend>
                <label class="label">
                    <input type="radio" v-model="local.options.syncOptionsLocation" :value="SYNC_STORAGE_FSYNC" :disabled="!SYNC_STORAGE_IS_AVAILABLE">
                    Use settings that are in Firefox Sync
                </label>
            </legend>

            <github-gist-fields
                class="field"
                :token.sync="sync.options.githubGistToken"
                :file-name.sync="sync.options.githubGistFileName"
                :gistId.sync="sync.options.githubGistId"
                :error="sync.error"
            ></github-gist-fields>

            <div class="field is-grouped is-grouped-right">
                <div class="control">
                    <button class="button is-info" @click="sync.load">
                        <span class="icon">
                            <img class="size-16" src="/icons/cloud-arrow-down-solid.svg">
                        </span>
                        <span>Load</span>
                    </button>
                </div>
                <div class="control">
                    <button :class="['button is-success', {'is-loading': sync.loading}]" @click="save(sync)">
                        <span class="icon">
                            <img class="size-16" src="/icons/cloud-arrow-up-solid.svg">
                        </span>
                        <span v-if="sync.options.githubGistId">Save settings</span>
                        <span v-else>Save settings and create/update backup</span>
                    </button>
                </div>
            </div>
        </fieldset>

        <fieldset class="field" :disabled="local.loading">
            <legend>
                <label class="label">
                    <input type="radio" v-model="local.options.syncOptionsLocation" :value="SYNC_STORAGE_LOCAL">
                    Use settings that are on the local computer (this $browserName$ profile)
                </label>
            </legend>

            <github-gist-fields
                class="field"
                :token.sync="local.options.githubGistToken"
                :file-name.sync="local.options.githubGistFileName"
                :gistId.sync="local.options.githubGistId"
                :error="local.error"
            ></github-gist-fields>

            <div class="field is-grouped is-grouped-right">
                <div class="control">
                    <button class="button is-info" @click="local.load">
                        <span class="icon">
                            <img class="size-16" src="/icons/arrow-down.svg">
                        </span>
                        <span>Load</span>
                    </button>
                </div>
                <div class="control">
                    <button :class="['button is-success', {'is-loading': local.loading}]" @click="save(local)">
                        <span class="icon">
                            <img class="size-16" src="/icons/floppy-disk-solid.svg">
                        </span>
                        <span v-if="local.options.githubGistId">Save settings</span>
                        <span v-else>Save settings and create/update backup</span>
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

fieldset {
    padding: .75rem;
    border: 1px solid;
}

legend {
    padding: 0 calc(.75rem / 2);
    margin: 0 .75rem;
}

</style>
