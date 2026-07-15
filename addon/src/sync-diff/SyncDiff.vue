<script>
import Vue from 'vue';

import '/js/prefixed-storage.js';
import * as Constants from '/js/constants.js';
import Logger, {errorEventHandler} from '/js/logger.js';
import Lang from '/js/lang.js?translate-page';
import {tabsCountMessage} from '/js/groups-helpers.js';
import {channel} from '/js/broadcast.js';
import {
    getSyncDiffHistory,
    clearSyncDiffHistory,
    getSyncDiffViewSettings,
    setSyncDiffViewSettings,
    DEFAULT_SYNC_DIFF_VIEW_SETTINGS,
} from '/js/sync/delta/sync-diff-store.js';

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
            view: {...DEFAULT_SYNC_DIFF_VIEW_SETTINGS},
            viewLoaded: false,
        };
    },
    computed: {
        selectedEntry() {
            return this.history.find(entry => entry.id === this.selectedId) || this.history[0] || null;
        },
        visibleTabs() {
            return (this.selectedEntry?.tabs || []).filter(item => this.isVisible(item));
        },
        visibleGroups() {
            return (this.selectedEntry?.groups || []).filter(item => this.isVisible(item));
        },
        visibleOptions() {
            return (this.selectedEntry?.options || []).filter(item => this.isVisible(item));
        },
        filterChips() {
            const c = {added: 0, removed: 0, changed: 0, moved: 0};
            for (const item of this.selectedEntry?.tabs || []) {
                c[this.viewKind(item)] += 1;
            }
            return [
                {key: 'added', symbol: KIND_SYMBOL.added, count: c.added, active: this.view.showAdded},
                {key: 'removed', symbol: KIND_SYMBOL.removed, count: c.removed, active: this.view.showRemoved},
                {key: 'changed', symbol: KIND_SYMBOL.changed, count: c.changed, active: this.view.showChanged},
                {key: 'moved', symbol: KIND_SYMBOL.moved, count: c.moved, active: !this.view.hideMoves},
            ];
        },
        tabSections() {
            const tabs = this.visibleTabs;

            const decorate = section => ({
                ...section,
                summary: this.sectionSummary(section.tabs),
                collapsed: this.isCollapsed(section.key),
            });

            if (!this.view.groupByGroups) {
                return tabs.length ? [decorate({key: 'all', label: null, tabs})] : [];
            }

            const byGroup = new Map();
            for (const tab of tabs) {
                const key = tab.group == null ? PINNED_GROUP_REF : String(tab.group);
                if (!byGroup.has(key)) {
                    byGroup.set(key, {key, label: this.groupLabel(tab), tabs: []});
                }
                byGroup.get(key).tabs.push(tab);
            }

            return [...byGroup.values()].map(decorate);
        },
    },
    watch: {
        view: {
            deep: true,
            handler(value) {
                if (this.viewLoaded) {
                    setSyncDiffViewSettings(value);
                }
            },
        },
    },
    async created() {
        const params = new URLSearchParams(window.location.search);
        this.selectedId = params.get('entry');

        this.view = await getSyncDiffViewSettings();
        this.viewLoaded = true;

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
        isMove(item) {
            return item.kind === 'changed' && item.moveOnly === true;
        },
        viewKind(item) {
            return this.isMove(item) ? 'moved' : item.kind;
        },
        kindSymbol(item) {
            return KIND_SYMBOL[this.viewKind(item)] || '';
        },
        isVisible(item) {
            if (this.isMove(item)) {
                return !this.view.hideMoves;
            }
            if (item.kind === 'added') {
                return this.view.showAdded;
            }
            if (item.kind === 'removed') {
                return this.view.showRemoved;
            }
            if (item.kind === 'changed') {
                return this.view.showChanged;
            }
            return true;
        },
        toggleChip(key) {
            if (key === 'added') {
                this.view.showAdded = !this.view.showAdded;
            } else if (key === 'removed') {
                this.view.showRemoved = !this.view.showRemoved;
            } else if (key === 'changed') {
                this.view.showChanged = !this.view.showChanged;
            } else if (key === 'moved') {
                this.view.hideMoves = !this.view.hideMoves;
            }
        },
        sectionSummary(tabs) {
            const c = {added: 0, removed: 0, changed: 0, moved: 0};
            for (const tab of tabs) {
                c[this.viewKind(tab)] += 1;
            }
            return [
                c.added && KIND_SYMBOL.added + c.added,
                c.removed && KIND_SYMBOL.removed + c.removed,
                c.changed && KIND_SYMBOL.changed + c.changed,
                c.moved && KIND_SYMBOL.moved + c.moved,
            ].filter(Boolean).join(' ');
        },
        isCollapsed(key) {
            return this.view.collapsedGroups.includes(key);
        },
        toggleCollapse(key) {
            const collapsed = new Set(this.view.collapsedGroups);
            if (collapsed.has(key)) {
                collapsed.delete(key);
            } else {
                collapsed.add(key);
            }
            this.view.collapsedGroups = [...collapsed];
        },
        collapseAll() {
            this.view.collapsedGroups = this.tabSections.map(section => section.key);
        },
        expandAll() {
            this.view.collapsedGroups = [];
        },
        groupLabel(tab) {
            if (tab.group == null || tab.group === PINNED_GROUP_REF) {
                return this.lang('syncDiffPinnedGroup');
            }
            return tab.groupTitle;
        },
        movedFromLabel(tab) {
            if (!this.isMove(tab) || tab.fromGroup == null || tab.fromGroup === tab.group) {
                return '';
            }
            const from = tab.fromGroup === PINNED_GROUP_REF
                ? this.lang('syncDiffPinnedGroup')
                : tab.fromGroupTitle;
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
                <div class="diff-toolbar">
                    <div class="diff-chips">
                        <button
                            v-for="chip in filterChips"
                            :key="chip.key"
                            type="button"
                            class="diff-chip"
                            :class="['diff-chip-' + chip.key, {'is-off': !chip.active}]"
                            @click="toggleChip(chip.key)"
                            >
                            <span class="diff-chip-symbol" v-text="chip.symbol"></span>
                            <span class="diff-chip-count" v-text="chip.count"></span>
                        </button>
                    </div>
                    <div class="diff-tools">
                        <label class="checkbox">
                            <input v-model="view.groupByGroups" type="checkbox" />
                            <span v-text="lang('syncDiffGroupByGroups')"></span>
                        </label>
                        <template v-if="view.groupByGroups">
                            <button type="button" class="button is-small" @click="expandAll" v-text="lang('syncDiffExpandAll')"></button>
                            <button type="button" class="button is-small" @click="collapseAll" v-text="lang('syncDiffCollapseAll')"></button>
                        </template>
                    </div>
                </div>

                <div v-if="tabSections.length" class="diff-section">
                    <h2 class="title is-6" v-text="lang('syncDiffTabs')"></h2>
                    <div
                        v-for="section in tabSections"
                        :key="'ts' + section.key"
                        class="diff-tree-group"
                        :class="{'is-flat': !section.label}"
                        >
                        <div
                            v-if="section.label"
                            tabindex="0"
                            class="diff-tree-head"
                            @click="toggleCollapse(section.key)"
                            @keydown.enter="toggleCollapse(section.key)"
                            >
                            <span class="diff-chevron" v-text="section.collapsed ? '▸' : '▾'"></span>
                            <span class="diff-tree-title" v-text="section.label"></span>
                            <span class="diff-tree-summary" v-text="section.summary"></span>
                            <span class="diff-tree-badge" v-text="section.tabs.length"></span>
                        </div>
                        <div v-show="!section.label || !section.collapsed" class="diff-tree-body">
                            <div v-for="(item, i) in section.tabs" :key="'t' + i" class="diff-row" :class="'diff-' + viewKind(item)">
                                <span class="diff-kind" v-text="kindSymbol(item)"></span>
                                <div class="diff-main">
                                    <div class="diff-line" v-text="item.title || item.url"></div>
                                    <div class="diff-sub mono" v-text="item.url"></div>
                                    <div v-if="movedFromLabel(item)" class="diff-moved-from" v-text="movedFromLabel(item)"></div>
                                    <ul v-if="item.changes" class="diff-changes">
                                        <li v-for="(change, ci) in item.changes" :key="ci">
                                            <b v-text="change.field"></b>:
                                            <span class="diff-from mono" v-text="formatValue(change.from)"></span>
                                            →
                                            <span class="diff-to mono" v-text="formatValue(change.to)"></span>
                                        </li>
                                    </ul>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div v-if="visibleGroups.length" class="diff-section">
                    <h2 class="title is-6" v-text="lang('syncDiffGroups')"></h2>
                    <div v-for="(item, i) in visibleGroups" :key="'g' + i" class="diff-row" :class="'diff-' + viewKind(item)">
                        <span class="diff-kind" v-text="kindSymbol(item)"></span>
                        <div class="diff-main">
                            <div class="diff-line" v-text="item.title"></div>
                            <ul v-if="item.changes" class="diff-changes">
                                <li v-for="(change, ci) in item.changes" :key="ci">
                                    <b v-text="change.field"></b>:
                                    <span class="diff-from mono" v-text="formatValue(change.from)"></span>
                                    →
                                    <span class="diff-to mono" v-text="formatValue(change.to)"></span>
                                </li>
                            </ul>
                        </div>
                    </div>
                </div>

                <div v-if="visibleOptions.length" class="diff-section">
                    <h2 class="title is-6" v-text="lang('syncDiffOptions')"></h2>
                    <div v-for="(item, i) in visibleOptions" :key="'o' + i" class="diff-row" :class="'diff-' + viewKind(item)">
                        <span class="diff-kind" v-text="kindSymbol(item)"></span>
                        <div class="diff-main">
                            <div class="diff-line"><b v-text="item.key"></b></div>
                            <div class="diff-changes">
                                <span class="diff-from mono" v-text="formatValue(item.from)"></span>
                                →
                                <span class="diff-to mono" v-text="formatValue(item.to)"></span>
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

.mono {
    font-family: var(--bulma-family-monospace, monospace);
}

.diff-toolbar {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    padding: 0.35rem 0;
    margin-bottom: 0.75rem;
    background-color: var(--bulma-scheme-main);
    border-bottom: 1px solid var(--bulma-border);
}

.diff-chips {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
}

.diff-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.15rem 0.6rem;
    border: 1px solid currentColor;
    border-radius: 999px;
    background: transparent;
    font-size: 0.85em;
    font-weight: bold;
    cursor: pointer;
    line-height: 1.6;
}

.diff-chip .diff-chip-count {
    font-variant-numeric: tabular-nums;
}

.diff-chip.diff-chip-added {
    color: var(--bulma-success);
}

.diff-chip.diff-chip-removed {
    color: var(--bulma-danger);
}

.diff-chip.diff-chip-changed {
    color: var(--bulma-warning);
}

.diff-chip.diff-chip-moved {
    color: var(--bulma-info);
}

.diff-chip:not(.is-off) {
    background-color: color-mix(in srgb, currentColor 15%, transparent);
}

.diff-chip.is-off {
    opacity: 0.5;
    filter: grayscale(0.7);
    text-decoration: line-through;
}

.diff-tools {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
}

.diff-section {
    margin-bottom: 1.5rem;
}

.diff-tree-group {
    margin-bottom: 0.25rem;
}

.diff-tree-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.4rem;
    border-radius: var(--bulma-radius);
    cursor: pointer;
    user-select: none;
}

.diff-tree-head:hover {
    background-color: var(--bulma-scheme-main-bis);
}

.diff-chevron {
    width: 1rem;
    flex-shrink: 0;
    text-align: center;
    opacity: 0.7;
}

.diff-tree-title {
    font-weight: bold;
}

.diff-tree-summary {
    font-size: 0.8em;
    opacity: 0.7;
    font-variant-numeric: tabular-nums;
}

.diff-tree-badge {
    margin-left: auto;
    font-size: 0.75em;
    opacity: 0.6;
    font-variant-numeric: tabular-nums;
}

.diff-tree-body {
    padding-left: 1rem;
}

.diff-tree-group.is-flat .diff-tree-body {
    padding-left: 0;
}

.diff-row {
    display: flex;
    gap: 0.5rem;
    padding: 0.35rem 0.5rem;
    border-left: 3px solid transparent;
    border-radius: 0 var(--bulma-radius) var(--bulma-radius) 0;
    align-items: flex-start;
}

.diff-row:hover {
    background-color: var(--bulma-scheme-main-bis);
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
