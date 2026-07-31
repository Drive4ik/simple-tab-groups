<script>
import Vue from 'vue';

import '/js/prefixed-storage.js';
import * as Constants from '/js/constants.js';
import Logger, {errorEventHandler} from '/js/logger.js';
import Lang from '/js/lang.js?translate-page';

import globalMixin from '/js/mixins/global.mixin.js';

window.logger = new Logger(Constants.MODULES.OFFLINE_REMOVE);
Vue.config.errorHandler = errorEventHandler.bind(window.logger);
Vue.mixin(globalMixin);

export default {
    name: Constants.MODULES.OFFLINE_REMOVE,
    data() {
        return {
            loaded: false,
            busy: false,
            count: 0,
            outcome: null,
        };
    },
    async created() {
        const params = new URLSearchParams(window.location.search);
        this.count = Math.max(0, parseInt(params.get('count'), 10) || 0);

        const pending = await this.sendMessageModule('OfflineRemove.pendingOfflineRemoveCount')
            .catch(() => null);

        if (typeof pending === 'number') {
            this.count = pending;
        }

        this.loaded = true;
    },
    methods: {
        lang: Lang,

        async decide(action) {
            if (this.busy) {
                return;
            }
            this.busy = true;

            const method = action === 'confirm'
                ? 'OfflineRemove.confirmOfflineRemovals'
                : 'OfflineRemove.discardOfflineRemovals';

            try {
                await this.sendMessageModule(method);
                this.outcome = action;
            } finally {
                this.busy = false;
            }

            await this.closeSelf();
        },
        async closeSelf() {
            try {
                const tab = await browser.tabs.getCurrent();
                if (tab) {
                    await browser.tabs.remove(tab.id);
                }
            } catch {
                // keep the outcome panel as a fallback when the tab cannot self-close
            }
        },
    },
};
</script>

<template>
    <div class="offline-remove-page">
        <div class="offline-remove-card">
            <img class="offline-remove-icon" src="/icons/exclamation-triangle-yellow.svg" alt="" />

            <template v-if="!loaded">
                <p v-text="lang('loading')"></p>
            </template>

            <template v-else-if="outcome === 'confirm'">
                <h1 class="title is-5" v-text="lang('offlineRemoveConfirmApplied')"></h1>
            </template>

            <template v-else-if="outcome === 'discard'">
                <h1 class="title is-5" v-text="lang('offlineRemoveConfirmKept')"></h1>
            </template>

            <template v-else-if="count > 0">
                <h1 class="title is-5" v-text="lang('offlineRemoveConfirmHeading')"></h1>
                <p class="offline-remove-body" v-text="lang('offlineRemoveConfirmBody', String(count))"></p>
                <div class="offline-remove-actions">
                    <button
                        type="button"
                        class="button is-danger"
                        :class="{'is-loading': busy}"
                        :disabled="busy"
                        @click="decide('confirm')"
                        v-text="lang('offlineRemoveConfirmApply', String(count))"
                        ></button>
                    <button
                        type="button"
                        class="button"
                        :disabled="busy"
                        @click="decide('discard')"
                        v-text="lang('offlineRemoveConfirmKeep')"
                        ></button>
                </div>
            </template>

            <template v-else>
                <h1 class="title is-5" v-text="lang('offlineRemoveConfirmNothingPending')"></h1>
            </template>
        </div>
    </div>
</template>

<style>
.offline-remove-page {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 2rem;
}

.offline-remove-card {
    max-width: 34rem;
    width: 100%;
    text-align: center;
    padding: 2rem;
    border: 1px solid var(--bulma-border);
    border-radius: var(--bulma-radius-large);
    background-color: var(--bulma-scheme-main-bis);
}

.offline-remove-icon {
    width: 3rem;
    height: 3rem;
    margin-bottom: 1rem;
}

.offline-remove-body {
    margin-bottom: 1.5rem;
    white-space: pre-line;
}

.offline-remove-actions {
    display: flex;
    gap: 0.75rem;
    justify-content: center;
    flex-wrap: wrap;
}
</style>
