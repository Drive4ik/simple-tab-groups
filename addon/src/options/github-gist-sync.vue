<script>

import popup from '../components/popup.vue';

import '/js/prefixed-storage.js';
import * as Constants from '/js/constants.js';
import Lang from '/js/lang.js';
import * as Storage from '/js/storage.js';
import * as Cloud from '/js/sync/cloud/cloud.js';

import syncAreaMixin from '/js/mixins/sync-area.mixin.js';
import syncCloudMixin from '/js/mixins/sync-cloud.mixin.js';

export default {
    name: 'github-gist-sync',
    mixins: [syncAreaMixin, syncCloudMixin],
    data() {
        return {
            confirmResetSyncState: false,

            syncSleepNewTabs: Constants.DEFAULT_OPTIONS.syncSleepNewTabs,
            syncSleepPinnedTabs: Constants.DEFAULT_OPTIONS.syncSleepPinnedTabs,
            syncActivatePreviouslyActiveTabs: Constants.DEFAULT_OPTIONS.syncActivatePreviouslyActiveTabs,
        };
    },
    components: {
        popup,
    },
    computed: {
        isLoadingSyncButton() {
            return this.syncCloudInProgress;
        },
        isDisableSyncButton() {
            return this.isLoadingSyncButton || this.area.disabled || this.area.loadingGist;
        },
    },
    created() {
        this.sync.load();
        this.local.load();

        Storage.get(['syncSleepNewTabs', 'syncSleepPinnedTabs', 'syncActivatePreviouslyActiveTabs'])
            .then(values => {
                ['syncSleepNewTabs', 'syncSleepPinnedTabs', 'syncActivatePreviouslyActiveTabs'].forEach(key => {
                    this[key] = values[key];
                    this.$watch(key, value => {
                        Storage.set({[key]: value});
                    });
                });
            });

        this.syncCloudOffListeners.add(Cloud.on('sync-finish', () => this.area.load(false)));
    },
    methods: {
        lang: Lang,
        async resetSyncState() {
            await this.sendMessage('reset-cloud-sync-state');
            await this.area.load(false);
        },
    },
};

</script>

<template>
<div>
    <div class="field">
        <label class="checkbox">
            <input v-model="syncSleepNewTabs" type="checkbox" />
            <span v-text="lang('syncSleepNewTabs')"></span>
        </label>
    </div>

    <div class="field" style="margin-left: 1.5em;">
        <label class="checkbox" :class="{'has-text-grey-light': !syncSleepNewTabs}">
            <input v-model="syncActivatePreviouslyActiveTabs" type="checkbox" :disabled="!syncSleepNewTabs" />
            <span v-text="lang('syncActivatePreviouslyActiveTabs')"></span>
        </label>
    </div>

    <div class="field">
        <label class="checkbox">
            <input v-model="syncSleepPinnedTabs" type="checkbox" />
            <span v-text="lang('syncSleepPinnedTabs')"></span>
        </label>
    </div>

    <hr>

    <div class="columns is-vcentered">
        <div class="column">
            <div class="simple-progress">
                <div class="position" :class="{
                    'in-progress': syncCloudInProgress,
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
                class="button is-warning is-soft mr-2"
                :disabled="isLoadingSyncButton || area.disabled"
                @click="confirmResetSyncState = true"
                v-text="lang('resetSyncStateButton')"
                ></button>
        </div>
        <div class="column is-narrow">
            <button
                class="button is-primary is-soft"
                :class="{'is-loading': isLoadingSyncButton}"
                :disabled="isDisableSyncButton"
                @click="syncCloud()"
                >
                <span class="icon">
                    <figure class="image is-16x16">
                        <img src="/icons/cloud-arrow-up-solid.svg" />
                    </figure>
                </span>
                <span v-text="lang('syncStart')"></span>
            </button>
        </div>
    </div>

    <popup
        v-if="confirmResetSyncState"
        :title="lang('resetSyncStateButton')"
        @reset="resetSyncState(); confirmResetSyncState = false"
        @close-popup="confirmResetSyncState = false"
        :buttons="
            [{
                event: 'reset',
                classList: 'is-warning is-soft',
                lang: 'resetSyncStateButton',
                focused: true,
            }, {
                event: 'close-popup',
                lang: 'cancel',
            }]
        ">
        <div class="block" v-text="lang('resetSyncStateConfirm')"></div>
    </popup>

</div>
</template>


<style>

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
