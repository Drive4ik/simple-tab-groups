<script>
import Vue from 'vue';

import '/js/prefixed-storage.js';
import * as Constants from '/js/constants.js';
import Logger, {errorEventHandler} from '/js/logger.js';
import Lang from '/js/lang.js?translate-page';
import {tabsCountMessage} from '/js/groups-helpers.js';
import {channel} from '/js/broadcast.js';
import {getSyncDiffHistory, clearSyncDiffHistory} from '/js/sync/delta/sync-diff-store.js';

import globalMixin from '/js/mixins/global.mixin.js';

window.logger = new Logger(Constants.MODULES.SYNC_DIFF);
Vue.config.errorHandler = errorEventHandler.bind(window.logger);
Vue.mixin(globalMixin);

const CloudBroadcast = channel('cloud');

const KIND_SYMBOL = {
    added: '+',
    removed: '−',
    changed: '~',
    moved: '↔',
};

const PINNED_GROUP_REF = 'pinned';

export default {
    name: Constants.MODULES.SYNC_DIFF,
    data() {
        return {
            history: [],
            selectedId: null,
            counts: null,
            groupByGroups: false,
        };
    },
    computed: {
        selectedEntry() {
            return this.history.find(entry => entry.id === this.selectedId) || this.history[0] || null;
        },
        tabSections() {
            const tabs = this.selectedEntry?.tabs || [];

            if (!this.groupByGroups) {
                return tabs.length ? [{key: 'all', label: null, tabs}] : [];
            }

            const byGroup = new Map();
            for (const tab of tabs) {
                const key = tab.group == null ? PINNED_GROUP_REF : String(tab.group);
                if (!byGroup.has(key)) {
                    byGroup.set(key, {key, label: this.groupLabel(tab), tabs: []});
                }
                byGroup.get(key).tabs.push(tab);
            }

            return [...byGroup.values()];
        },
    },
    async created() {
        const params = new URLSearchParams(window.location.search);
        this.selectedId = params.get('entry');

        await Promise.all([this.reload(), this.loadCounts()]);

        this.offBroadcast = CloudBroadcast.on(['sync-diff', 'sync-end'], () => {
            this.reload();
            this.loadCounts();
        });
    },
    beforeDestroy() {
        this.offBroadcast?.();
    },
    methods: {
        lang: Lang,
        tabsCountMessage,

        async reload() {
            this.history = await getSyncDiffHistory();
        },
        async loadCounts() {
            const {groups} = await this.sendMessageModule('Groups.loadWithArchivedTabs', null, true);
            const archived = [];
            const notArchived = [];

            for (const group of groups || []) {
                const tabs = Array.isArray(group.tabs) ? group.tabs : [];
                (group.isArchive ? archived : notArchived).push(...tabs);
            }

            this.counts = {archived, notArchived, all: archived.length + notArchived.length};
        },
        select(id) {
            this.selectedId = id;
        },
        async clearHistory() {
            await clearSyncDiffHistory();
            await this.reload();
        },
        kindSymbol(kind) {
            return KIND_SYMBOL[kind] || '';
        },
        groupLabel(tab) {
            if (tab.group == null || tab.group === PINNED_GROUP_REF) {
                return this.lang('syncDiffPinnedGroup');
            }
            return tab.groupTitle || String(tab.group);
        },
        movedFromLabel(tab) {
            if (tab.kind !== 'moved' || tab.fromGroup == null || tab.fromGroup === tab.group) {
                return '';
            }
            const from = tab.fromGroup === PINNED_GROUP_REF
                ? this.lang('syncDiffPinnedGroup')
                : (tab.fromGroupTitle || String(tab.fromGroup));
            return this.lang('syncDiffMovedFrom', from);
        },
        formatTs(ts) {
            return new Date(ts).toLocaleString();
        },
        formatValue(value) {
            if (value === undefined) {
                return '∅';
            }
            if (value === null || typeof value === 'object') {
                return JSON.stringify(value);
            }
            return String(value);
        },
    },
};
</script>

<template>
    <div class="sync-diff-page">
        <header class="sync-diff-header">
            <h1 class="title is-5" v-text="lang('syncDiffPageTitle')"></h1>
            <label class="checkbox sync-diff-groupby">
                <input v-model="groupByGroups" type="checkbox" />
                <span v-text="lang('syncDiffGroupByGroups')"></span>
            </label>
            <div v-if="counts" class="sync-diff-counts">
                <span class="tag is-info is-light">
                    <span v-text="lang('syncDiffOpenTabs')"></span>&nbsp;<b v-text="tabsCountMessage(counts.notArchived, false, false)"></b>
                </span>
                <span class="tag is-warning is-light">
                    <span v-text="lang('syncDiffArchivedTabs')"></span>&nbsp;<b v-text="tabsCountMessage(counts.archived, true, false)"></b>
                </span>
                <span class="tag is-dark">
                    <span v-text="lang('syncDiffAllTabs')"></span>&nbsp;<b v-text="counts.all"></b>
                </span>
            </div>
        </header>

        <div class="sync-diff-body">
            <aside class="sync-diff-list">
                <div class="sync-diff-list-head">
                    <span v-text="lang('syncDiffHistoryTitle')"></span>
                    <button v-if="history.length" class="button is-small is-danger is-light" @click="clearHistory" v-text="lang('syncDiffClear')"></button>
                </div>
                <div v-if="!history.length" class="sync-diff-empty" v-text="lang('syncDiffEmpty')"></div>
                <ul v-else>
                    <li
                        v-for="entry in history"
                        :key="entry.id"
                        :class="{active: selectedEntry && entry.id === selectedEntry.id}"
                        @click="select(entry.id)"
                        >
                        <div class="summary" v-text="entry.summary"></div>
                        <div class="ts" v-text="formatTs(entry.ts)"></div>
                    </li>
                </ul>
            </aside>

            <section v-if="selectedEntry" class="sync-diff-detail">
                <div v-if="selectedEntry.tabs.length" class="diff-section">
                    <h2 class="title is-6" v-text="lang('syncDiffTabs')"></h2>
                    <div v-for="section in tabSections" :key="'ts' + section.key" class="diff-group-section">
                        <h3 v-if="section.label" class="diff-group-heading" v-text="section.label"></h3>
                        <div v-for="(item, i) in section.tabs" :key="'t' + i" class="diff-row" :class="'diff-' + item.kind">
                            <span class="diff-kind" v-text="kindSymbol(item.kind)"></span>
                            <div class="diff-main">
                                <div class="diff-line" v-text="item.title || item.url"></div>
                                <div class="diff-sub" v-text="item.url"></div>
                                <div v-if="movedFromLabel(item)" class="diff-moved-from" v-text="movedFromLabel(item)"></div>
                                <ul v-if="item.changes" class="diff-changes">
                                    <li v-for="(change, ci) in item.changes" :key="ci">
                                        <b v-text="change.field"></b>:
                                        <span class="diff-from" v-text="formatValue(change.from)"></span>
                                        →
                                        <span class="diff-to" v-text="formatValue(change.to)"></span>
                                    </li>
                                </ul>
                            </div>
                        </div>
                    </div>
                </div>

                <div v-if="selectedEntry.groups.length" class="diff-section">
                    <h2 class="title is-6" v-text="lang('syncDiffGroups')"></h2>
                    <div v-for="(item, i) in selectedEntry.groups" :key="'g' + i" class="diff-row" :class="'diff-' + item.kind">
                        <span class="diff-kind" v-text="kindSymbol(item.kind)"></span>
                        <div class="diff-main">
                            <div class="diff-line" v-text="item.title"></div>
                            <ul v-if="item.changes" class="diff-changes">
                                <li v-for="(change, ci) in item.changes" :key="ci">
                                    <b v-text="change.field"></b>:
                                    <span class="diff-from" v-text="formatValue(change.from)"></span>
                                    →
                                    <span class="diff-to" v-text="formatValue(change.to)"></span>
                                </li>
                            </ul>
                        </div>
                    </div>
                </div>

                <div v-if="selectedEntry.options.length" class="diff-section">
                    <h2 class="title is-6" v-text="lang('syncDiffOptions')"></h2>
                    <div v-for="(item, i) in selectedEntry.options" :key="'o' + i" class="diff-row" :class="'diff-' + item.kind">
                        <span class="diff-kind" v-text="kindSymbol(item.kind)"></span>
                        <div class="diff-main">
                            <div class="diff-line"><b v-text="item.key"></b></div>
                            <div class="diff-changes">
                                <span class="diff-from" v-text="formatValue(item.from)"></span>
                                →
                                <span class="diff-to" v-text="formatValue(item.to)"></span>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            <section v-else class="sync-diff-detail sync-diff-empty" v-text="lang('syncDiffSelectEntry')"></section>
        </div>
    </div>
</template>

<style>
.sync-diff-page {
    display: flex;
    flex-direction: column;
    height: 100vh;
    padding: 1rem;
    gap: 1rem;
}

.sync-diff-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
}

.sync-diff-header .title {
    margin-bottom: 0;
}

.sync-diff-counts {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
}

.sync-diff-body {
    display: flex;
    gap: 1rem;
    flex: 1;
    min-height: 0;
}

.sync-diff-list {
    width: 20rem;
    flex-shrink: 0;
    overflow-y: auto;
    border-right: 1px solid var(--bulma-border);
    padding-right: 0.5rem;
}

.sync-diff-list-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
    font-weight: bold;
}

.sync-diff-list ul {
    list-style: none;
    margin: 0;
    padding: 0;
}

.sync-diff-list li {
    padding: 0.5rem;
    border-radius: var(--bulma-radius);
    cursor: pointer;
}

.sync-diff-list li:hover {
    background-color: var(--bulma-scheme-main-bis);
}

.sync-diff-list li.active {
    background-color: var(--bulma-scheme-main-ter);
}

.sync-diff-list li .summary {
    font-weight: bold;
}

.sync-diff-list li .ts {
    font-size: 0.8em;
    opacity: 0.7;
}

.sync-diff-detail {
    flex: 1;
    overflow-y: auto;
    min-width: 0;
}

.sync-diff-empty {
    opacity: 0.6;
    padding: 1rem;
}

.diff-section {
    margin-bottom: 1.5rem;
}

.diff-row {
    display: flex;
    gap: 0.5rem;
    padding: 0.35rem 0.5rem;
    border-left: 3px solid transparent;
    align-items: flex-start;
}

.diff-row.diff-added {
    border-left-color: var(--bulma-success);
}

.diff-row.diff-removed {
    border-left-color: var(--bulma-danger);
}

.diff-row.diff-changed {
    border-left-color: var(--bulma-warning);
}

.diff-row.diff-moved {
    border-left-color: var(--bulma-info);
}

.diff-group-section {
    margin-bottom: 0.75rem;
}

.diff-group-heading {
    font-weight: bold;
    font-size: 0.95em;
    margin: 0.5rem 0 0.25rem;
    opacity: 0.85;
}

.diff-moved-from {
    font-size: 0.8em;
    color: var(--bulma-info);
}

.diff-kind {
    font-weight: bold;
    width: 1rem;
    flex-shrink: 0;
    text-align: center;
}

.diff-row.diff-added .diff-kind {
    color: var(--bulma-success);
}

.diff-row.diff-removed .diff-kind {
    color: var(--bulma-danger);
}

.diff-row.diff-changed .diff-kind {
    color: var(--bulma-warning);
}

.diff-row.diff-moved .diff-kind {
    color: var(--bulma-info);
}

.diff-main {
    min-width: 0;
    word-break: break-word;
}

.diff-sub {
    font-size: 0.8em;
    opacity: 0.7;
}

.diff-changes {
    font-size: 0.85em;
    margin: 0.25rem 0 0;
    padding: 0;
    list-style: none;
}

.diff-from {
    color: var(--bulma-danger);
}

.diff-to {
    color: var(--bulma-success);
}
</style>
