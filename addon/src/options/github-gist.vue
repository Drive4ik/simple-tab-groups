<script>

import * as Constants from '/js/constants.js';
import Logger from '/js/logger.js';
import * as Storage from '/js/storage.js';
import * as SyncStorage from '/js/sync/sync-storage.js';
import {GithubGist} from '/js/sync/cloud/cloud.js';

const GithubGistCloud = new GithubGist();

const FILE_NAME_PARTS = Object.freeze({
    start: 'STG-',
    end: '.json',
});

export default {
    data() {
        // this.SYNC_STORAGE_IS_AVAILABLE = false;
        this.SYNC_STORAGE_IS_AVAILABLE = SyncStorage.IS_AVAILABLE;
        this.FILE_NAME_PARTS = FILE_NAME_PARTS;

        return {
            isActiveHelp: false,

            isCheckingToken: false,
            tokenIsValid: null,

            isSearchingId: false,
            searchOrCreateSuccess: null,

            browserInfo: null,

            options: {},
        };
    },
    watch: {
        options: {
            handler({githubGistToken, githubGistFileName, githubGistId}) {
                GithubGistCloud.token = githubGistToken;
                GithubGistCloud.fileName = githubGistFileName;
                GithubGistCloud.gistId = githubGistId;
            },
            deep: true,
        },
    },
    computed: {
        fileName: {
            get() {
                return this.options.githubGistFileName?.slice(FILE_NAME_PARTS.start.length, - FILE_NAME_PARTS.end.length);
            },
            set(value) {
                this.options.githubGistFileName = FILE_NAME_PARTS.start + value + FILE_NAME_PARTS.end;
            },
        },
        browserName() {
            return `${this.browserInfo?.name} v${this.browserInfo?.version}`;
        },
    },
    async created() {
        if (this.SYNC_STORAGE_IS_AVAILABLE) {
            await this.loadSyncOptions();
        } else {
            await this.loadOptions();
            this.browserInfo = await browser.runtime.getBrowserInfo();
        }
    },
    methods: {
        lang: browser.i18n.getMessage,

        async loadSyncOptions() {
            this.options = await SyncStorage.get();
        },

        async saveSyncOptions() {
            const syncOptions = {...this.options};
            await SyncStorage.set(syncOptions);
        },

        async loadOptions() {
            this.options = await Storage.get(Constants.DEFAULT_SYNC_OPTIONS);
        },

        async saveOptions() {
            const options = {...this.options};
            delete options.version;
            await Storage.set(options);
        },

        async checkToken() {
            this.isCheckingToken = true;

            try {
                await GithubGistCloud.checkToken();
                this.tokenIsValid = true;
            } catch (e) {
                this.tokenIsValid = false;
            }

            this.isCheckingToken = false;
        },
        async searchOrCreateId() {
            this.isSearchingId = true;

            function getBackupForCloud() {}

            try {
                const gistId = await GithubGistCloud.findGistId();

                if (gistId) {
                    this.options.githubGistId = gistId;
                    this.searchOrCreateSuccess = true;
                } else {
                    const content = await getBackupForCloud();
                    const description = browser.i18n.getMessage('githubGistBackupDescription');
                    // await GithubGistCloud.createGist(description, content);
                    this.searchOrCreateSuccess = false;
                }

            } catch (e) {
                this.searchOrCreateSuccess = false;
            }

            this.isSearchingId = false;
        },
    },
};

</script>

<template>
    <div class="box">
        <div class="level">
            <div class="level-left">
                <div class="level-item">
                    <div class="subtitle mb-0">GitHub gist</div>
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
                <label class="label" v-text="lang('githubGistTokenTitle') + ':'"></label>
            </div>
            <div class="field-body">
                <div class="field has-addons">
                    <div :class="['control is-expanded has-icons-left', {
                        'is-loading': isCheckingToken,
                        'has-icons-right': !isCheckingToken && tokenIsValid !== null,
                        }]">
                        <input type="text" v-model.trim="options.githubGistToken" maxlength="40" class="input" />

                        <span class="icon is-left">
                            <img class="size-16" src="/icons/key-solid.svg">
                        </span>
                        <span v-if="!isCheckingToken && tokenIsValid !== null" class="icon is-right">
                            <img v-if="tokenIsValid" class="size-16" src="/icons/check.svg">
                            <img v-else class="size-16" src="/icons/close.svg">
                        </span>
                    </div>
                    <div class="control">
                        <button class="button" @click="checkToken" :disabled="isCheckingToken" v-text="lang('checkGithubGistToken')"></button>
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
                    <div class="control is-expanded">
                        <input type="text" v-model.trim="fileName" maxlength="100" class="input" />
                    </div>
                    <div class="control">
                        <a class="button is-static" v-text="FILE_NAME_PARTS.end"></a>
                    </div>
                </div>
            </div>
        </div>
        <div class="field is-horizontal">
            <div class="field-label is-normal">
                <label class="label" v-text="lang('githubGistIdTitle') + ':'"></label>
            </div>
            <div class="field-body">
                <div class="field has-addons">
                    <div :class="['control is-expanded', {
                        'is-loading': isSearchingId,
                        'has-icons-right': !isSearchingId && searchOrCreateSuccess !== null,
                        }]">
                        <input type="text" v-model.trim="options.githubGistId" maxlength="32" class="input" />

                        <span v-if="!isSearchingId && searchOrCreateSuccess !== null" class="icon is-right">
                            <img v-if="searchOrCreateSuccess" class="size-16" src="/icons/check.svg">
                            <img v-else class="size-16" src="/icons/close.svg">
                        </span>
                    </div>
                    <div class="control">
                        <button class="button" @click="searchOrCreateId" :disabled="isSearchingId" v-text="lang('findOrCreateGithubGistId')"></button>
                    </div>
                </div>
            </div>
        </div>

        <hr>

        <div class="subtitle">Firefox Sync</div>
        <div class="columns">
            <div class="column">
                <div class="field">
                    <button class="button is-info" :disabled="!SYNC_STORAGE_IS_AVAILABLE" @click="loadSyncOptions">
                        <span class="icon">
                            <img class="size-16" src="/icons/cloud-arrow-down-solid.svg">
                        </span>
                        <span>Download GitHub gist settings from Firefox Sync Cloud</span>
                    </button>
                </div>
                <div v-if="!SYNC_STORAGE_IS_AVAILABLE" class="field">
                    <p>Your browser is: {{browserName}}, it doesn't support <a href="https://www.mozilla.org/firefox/sync/" target="_blank" class="is-underlined">Firefox Sync</a></p>
                    <p>
                        <a class="button is-link mt-3" href="https://www.mozilla.org/firefox/new/" target="_blank">
                            <span class="icon">
                                <img class="size-16" src="/icons/firefox-logo.svg">
                            </span>
                            <span>Download Firefox</span>
                        </a>
                    </p>
                </div>
            </div>
            <div class="column has-text-right">
                <button v-if="SYNC_STORAGE_IS_AVAILABLE" class="button is-success" @click="saveSyncOptions">
                    <span class="icon">
                        <img class="size-16" src="/icons/cloud-arrow-up-solid.svg">
                    </span>
                    <span>Upload GitHub gist settings to Firefox Sync Cloud</span>
                </button>
                <button v-else class="button is-success" @click="saveOptions">
                    <span class="icon">
                        <img class="size-16" src="/icons/floppy-disk-solid.svg">
                    </span>
                    <span>Save GitHub gist settings to local storage</span>
                </button>
            </div>
        </div>
    </div>
</template>
