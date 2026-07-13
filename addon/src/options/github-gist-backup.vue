<script>

import popup from '../components/popup.vue';

import '/js/prefixed-storage.js';
import * as Constants from '/js/constants.js';
import Lang from '/js/lang.js';
import * as Storage from '/js/storage.js';
import * as Cloud from '/js/sync/cloud/cloud.js';
import {isReservedFileName} from '/js/sync/delta/layout.js';

import syncAreaMixin from '/js/mixins/sync-area.mixin.js';
import syncCloudMixin from '/js/mixins/sync-cloud.mixin.js';

export default {
    name: 'github-gist-backup',
    mixins: [syncAreaMixin, syncCloudMixin],
    data() {
        return {
            confirmRestoreBackupItem: null,
            confirmForgetBackupFileName: false,
            backupInProgress: false,

            syncTabFavIcons: Constants.DEFAULT_OPTIONS.syncTabFavIcons,
        };
    },
    components: {
        popup,
    },
    computed: {
        isBusy() {
            return this.syncCloudInProgress || this.backupInProgress;
        },
        canBackup() {
            return !this.isBusy && !this.area.disabled && !this.area.loadingGist && !!this.area.options.githubGistToken;
        },
        backupFileName() {
            return this.area.options.githubGistBackupFileName || '';
        },
        isValidBackupFileName() {
            return this.backupFileName.endsWith('.json')
                && this.backupFileName.length > '.json'.length
                && !isReservedFileName(this.backupFileName);
        },
    },
    created() {
        this.sync.load();
        this.local.load();

        Storage.get('syncTabFavIcons').then(({syncTabFavIcons}) => {
            this.syncTabFavIcons = syncTabFavIcons;
            this.$watch('syncTabFavIcons', value => Storage.set({syncTabFavIcons: value}));
        });

        this.syncCloudOffListeners.add(Cloud.on('sync-finish', () => this.area.load(false)));
    },
    methods: {
        lang: Lang,
        submitBackupFileName() {
            if (!this.isValidBackupFileName) {
                return;
            }

            const savedFileName = this.area.optionsBackup.githubGistBackupFileName;

            if (savedFileName && this.area.options.githubGistBackupFileName !== savedFileName) {
                this.confirmForgetBackupFileName = true;
                return;
            }

            this.saveBackupFileName();
        },
        async saveBackupFileName() {
            this.confirmForgetBackupFileName = false;

            try {
                this.backupInProgress = true;
                await this.area.save();
                await this.area.load(false);
            } finally {
                this.backupInProgress = false;
            }
        },
        async createBackup() {
            try {
                this.backupInProgress = true;
                await this.sendMessageModule('BG.cloudBackupPush');
                await this.area.load(false);
            } finally {
                this.backupInProgress = false;
            }
        },
        async restoreBackup({version}) {
            await this.sendMessageModule('BG.cloudBackupRestore', version);
        },
    },
};

</script>

<template>
<div class="box">
    <div class="columns is-mobile is-vcentered">
        <div class="column">
            <span class="is-size-5" v-text="lang('githubGistBackupTitle')"></span>
            <span class="tag is-info ml-2">BETA</span>
        </div>
    </div>

    <form class="field is-horizontal" @submit.prevent="submitBackupFileName">
        <div class="field-label is-normal">
            <label class="label colon" v-text="lang('githubGistBackupFileNameTitle')"></label>
        </div>
        <div class="field-body">
            <div class="field">
                <div class="field has-addons">
                    <div class="control is-expanded" :class="{'has-icons-right': !isValidBackupFileName}">
                        <input required type="text" v-model.trim="area.options.githubGistBackupFileName" maxlength="100" class="input" :disabled="area.disabled || isBusy" />
                        <span v-if="!isValidBackupFileName" class="icon is-right">
                            <figure class="image is-16x16">
                                <img src="/icons/close.svg" />
                            </figure>
                        </span>
                    </div>
                    <div class="control">
                        <button type="submit" class="button is-success is-soft" :class="{'is-loading': backupInProgress}" :disabled="area.disabled || isBusy || !isValidBackupFileName">
                            <span class="icon">
                                <figure class="image is-16x16">
                                    <img src="/icons/floppy-disk-solid.svg">
                                </figure>
                            </span>
                            <span v-text="lang('saveSettings')"></span>
                        </button>
                    </div>
                </div>
                <p v-if="!isValidBackupFileName" class="help has-text-danger" v-text="lang('githubGistBackupFileNameInvalid')"></p>
            </div>
        </div>
    </form>

    <div class="field">
        <label class="checkbox">
            <input v-model="syncTabFavIcons" type="checkbox" />
            <span v-text="lang('includeTabFavIconsIntoBackup')"></span>
        </label>
    </div>

    <div class="columns is-vcentered">
        <div class="column">
            <div class="simple-progress">
                <div class="position" :class="{
                    'in-progress': isBusy,
                    'has-background-success': !syncCloudErrorMessage && syncCloudProgress === 100,
                    'has-background-danger': !!syncCloudErrorMessage,
                }"
                :style="{
                    '--progress-value': `${syncCloudProgress}%`,
                }"
                ></div>
            </div>
            <p class="has-text-danger has-text-left white-space-pre-line hidden-empty" v-text="syncCloudErrorMessage"></p>
        </div>
        <div class="column is-narrow">
            <button
                type="button"
                class="button is-primary is-soft"
                :class="{'is-loading': backupInProgress}"
                :disabled="!canBackup"
                @click="createBackup"
                >
                <span class="icon">
                    <figure class="image is-16x16">
                        <img src="/icons/cloud-arrow-up-solid.svg" />
                    </figure>
                </span>
                <span v-text="lang('createBackupButton')"></span>
            </button>
        </div>
        <div class="column is-narrow">
            <div v-if="area.gist && area.gist.history.length" class="dropdown is-right focus-within">
                <div class="dropdown-trigger">
                    <button
                        type="button"
                        class="button is-info is-soft"
                        :class="{'is-loading': isBusy}"
                        :disabled="isBusy"
                        aria-haspopup="true"
                        aria-controls="restore-dropdown-menu"
                        >
                        <span class="icon">
                            <figure class="image is-16x16">
                                <img src="/icons/cloud-arrow-down-solid.svg" />
                            </figure>
                        </span>
                        <span v-text="lang('restoreBackup')"></span>
                        <span class="icon">
                            <figure class="image is-16x16">
                                <img src="/icons/arrow-down.svg" />
                            </figure>
                        </span>
                    </button>
                </div>
                <div class="dropdown-menu" id="restore-dropdown-menu" role="menu">
                    <div class="dropdown-content">
                        <a
                            v-for="item in area.gist.history"
                            :key="item.version"
                            class="dropdown-item"
                            :title="lang('restoreBackup') + `: &quot;${item.version_short}&quot; ${item.committed_at_full}`"
                            @click.prevent="confirmRestoreBackupItem = item"
                            tabindex="0"
                            >
                            <code>
                                <a
                                    :href="item.web_url"
                                    target="_blank"
                                    rel="noreferrer noopener"
                                    @click.stop
                                    :title="lang('viewBackup') + `: &quot;${item.version_short}&quot;`"
                                    v-text="item.version_short"
                                    ></a>
                            </code>
                            <span class="is-underline-dotted" v-text="item.committed_at_relative"></span>
                            <span v-text="item.committed_at_time_short"></span>
                            <small v-if="item.change_status?.total" class="brackets-round">
                                <span class="colon" v-text="lang('backupChangesLabel')"></span>
                                <span class="changes" v-text="item.change_status.total"></span>
                            </small>
                        </a>
                    </div>
                </div>
            </div>
            <figure v-else-if="area.loadingGist" class="image is-16x16">
                <img src="/icons/animate-spinner.svg">
            </figure>
        </div>
    </div>

    <popup
        v-if="confirmRestoreBackupItem"
        :title="lang('restoreBackup')"
        @restore="restoreBackup(confirmRestoreBackupItem); confirmRestoreBackupItem = null"
        @close-popup="confirmRestoreBackupItem = null"
        :buttons="
            [{
                event: 'restore',
                classList: 'is-primary is-soft',
                lang: 'restoreBackup',
                focused: true,
            }, {
                event: 'close-popup',
                lang: 'cancel',
            }]
        ">
        <div class="block">
            <span v-text="lang('areYouSureRestoreBackup')"></span>
            <a :href="confirmRestoreBackupItem.web_url" target="_blank" rel="noreferrer noopener" :title="lang('viewBackup')">
                <span class="tag is-medium" v-text="confirmRestoreBackupItem.version_short"></span>
                <span v-text="confirmRestoreBackupItem.committed_at_full"></span>
            </a>
        </div>
        <strong v-text="lang('overwriteCurrent')"></strong>
    </popup>

    <popup
        v-if="confirmForgetBackupFileName"
        :title="lang('githubGistBackupFileNameTitle')"
        @save="saveBackupFileName"
        @close-popup="confirmForgetBackupFileName = false"
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
        <span v-text="lang('githubGistBackupFileNameChangeWarning')"></span>
    </popup>

</div>
</template>


<style>

#restore-dropdown-menu {
    .dropdown-content {
        max-height: 30em;
        overflow: auto;
    }
}

.simple-progress {
    display: flex;
    width: 100%;
    --height: 1em;
    height: var(--height);

    > .position {
        --transition-time: 0ms;
        transition: width var(--transition-time), background-color var(--transition-time);

        width: var(--progress-value, 0px);
        background-color: var(--bulma-text-05-invert);
        border-radius: var(--height);

        &.in-progress {
            --transition-time: .2s;
        }
    }
}

</style>
