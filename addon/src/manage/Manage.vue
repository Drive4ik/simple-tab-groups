<script>
import Vue from 'vue';

import popup from '../components/popup.vue';
import popupHelpers from '../components/popup-helpers.vue';
import editGroup from '../components/edit-group.vue';
import contextMenu from '../components/context-menu.vue';
import contextMenuTab from '../components/context-menu-tab.vue';
import contextMenuTabNew from '../components/context-menu-tab-new.vue';
import contextMenuGroup from '../components/context-menu-group.vue';

import '/js/prefixed-storage.js';
import * as Constants from '/js/constants.js';
import Logger, {errorEventHandler} from '/js/logger.js';
import * as Groups from '/js/groups.js';
import * as Tabs from '/js/tabs.js';
import * as Utils from '/js/utils.js';

import defaultGroupMixin from '/js/mixins/default-group.mixin.js';
import optionsMixin from '/js/mixins/options.mixin.js';
import popupHelpersMixin from '/js/mixins/popup-helpers.mixin.js';
import tabGroupsMixin from '/js/mixins/tab-groups.mixin.js';

window.logger = new Logger(Constants.MODULES.MANAGE);
Vue.config.errorHandler = errorEventHandler.bind(window.logger);

const storage = localStorage.create(Constants.MODULES.MANAGE);

// import dnd from '../js/dnd';
// import { Drag, Drop } from 'vue-drag-drop';
// import draggable from 'vuedraggable';

document.title = browser.i18n.getMessage('manageGroupsTitle');

const VIEW_GRID = 'grid';
const VIEW_DEFAULT = VIEW_GRID;

export default {
    name: Constants.MODULES.MANAGE,
    mixins: [
        defaultGroupMixin,
        optionsMixin,
        popupHelpersMixin,
        tabGroupsMixin,
    ],
    data() {
        return {
            extraAvailableTabKeys: ['thumbnail'],
            optionsWatchKeys: ['showTabsWithThumbnailsInManageGroups', 'showArchivedGroups'],

            VIEW_GRID,

            view: VIEW_DEFAULT,
        };
    },
    components: {
        popup: popup,
        'popup-helpers': popupHelpers,
        'edit-group': editGroup,
        'context-menu': contextMenu,
        'context-menu-tab': contextMenuTab,
        'context-menu-tab-new': contextMenuTabNew,
        'context-menu-group': contextMenuGroup,
    },
    async mounted() {
        const log = logger.start('mounted');

        await Promise.all([
            this.optionsLoadPromise,
            this.tabGroupsPromise,
        ]);

        log.log('options and tab groups loaded');

        await this.$nextTick();

        this.isLoading = false;
        this.setFocusOnSearch();
        this.setupListeners();

        log.stop();
    },
    watch: {
        'options.showTabsWithThumbnailsInManageGroups'(value) {
            value && this.loadAvailableTabThumbnails();
        },
    },
    computed: {
        filteredGroups() {
            let searchStr = this.search.toLowerCase(),
                groups = this.options.showArchivedGroups ? this.groups : this.groups.filter(group => !group.isArchive);

            return groups.map(group => {
                group.filteredTabs = group.tabs.filter(tab => Utils.mySearchFunc(searchStr, Tabs.getTitle(tab, true), this.extendedSearch));
                return group;
            });
        },
        filteredUnSyncTabs() {
            let searchStr = this.search.toLowerCase();

            return this.unSyncTabs.filter(tab => Utils.mySearchFunc(searchStr, Tabs.getTitle(tab, true), this.extendedSearch));
        },
        isCurrentWindowIsAllow() {
            return Utils.isWindowAllow(this.currentWindow);
        },
    },
    methods: {
        lang: browser.i18n.getMessage,

        setupListeners() {
            this.tabGroupsSetupListeners();

            this
                .$on('drag-move-group', (from, to) => {
                    this.sendMessageModule('Groups.move', from.data.item.id, this.groups.indexOf(to.data.item));
                })
                .$on('drag-move-tab', (from, to) => {
                    if ('new-group' === to.data.item.id) {
                        this.moveTabToNewGroup(null, true);
                    } else {
                        const tabIds = this.getTabIdsForMove(),
                            groupId = this.isGroup(to.data.item) ? to.data.item.id : to.data.group.id,
                            newTabIndex = this.isGroup(to.data.item) ? undefined : to.data.item.index;

                        this.sendMessageModule('Tabs.move', tabIds, groupId, {
                            newTabIndex,
                            showTabAfterMovingItIntoThisGroup: false,
                            showOnlyActiveTabAfterMovingItIntoThisGroup: false,
                            showNotificationAfterMovingTabIntoThisGroup: false,
                        });
                    }
                })
                .$on('drag-moving', (item, isMoving) => item.isMoving = isMoving)
                .$on('drag-over', (item, isOver) => item.isOver = isOver);

            if (!this.isCurrentWindowIsAllow) {
                window.addEventListener('resize', () => {
                    storage.windowWidth = window.innerWidth;
                    storage.windowHeight = window.innerHeight;
                });
            }
        },

        loadAvailableTabThumbnails() {
            for (const group of this.groups) {
                if (group.isArchive) {
                    continue;
                }

                for (const tab of group.tabs) {
                    if (!tab.thumbnail && !tab.discarded && Utils.isTabLoaded(tab)) {
                        this.updateTabThumbnail(tab);
                    }
                }
            }
        },

        async moveTabToNewGroup(tabId, loadUnsync, showTabAfterMovingItIntoThisGroup) {
            const tabIds = this.getTabIdsForMove(tabId);

            let newGroupTitle = '';

            if (this.options.alwaysAskNewGroupName) {
                const {defaultGroupProps} = await Groups.getDefaults();
                newGroupTitle = Groups.createTitle(null, null, defaultGroupProps);
                newGroupTitle = await this.prompt(this.lang('createNewGroup'), newGroupTitle);

                if (!newGroupTitle) {
                    return;
                }
            }

            const newGroupWindowId = showTabAfterMovingItIntoThisGroup ? this.currentWindow.id : undefined;
            const newGroup = await this.sendMessageModule('Groups.add', newGroupWindowId, tabIds, newGroupTitle);

            if (showTabAfterMovingItIntoThisGroup) {
                this.applyGroup(newGroup, {id: tabId});
            }

            if (loadUnsync) {
                this.loadUnsyncedTabs();
            }
        },

        addGroup() {
            this.$once('group-added', () => {
                this.$nextTick(() => [...document.querySelectorAll('input[type="text"]')].pop().select());
            });

            this.sendMessageModule('Groups.add');
        },

        updateTabThumbnail({id}) {
            this.sendMessageModule('Tabs.updateThumbnail', id);
        },

        async applyGroup({id: groupId}, {id: tabId} = {}, openInNewWindow = false) {
            if (!this.isCurrentWindowIsAllow) {
                await browser.windows.update(this.currentWindow.id, {
                    state: browser.windows.WindowState.MINIMIZED,
                });
            }

            await this.sendMessage('load-custom-group', {
                groupId,
                tabId,
                windowId: openInNewWindow ? 'new' : null,
            });

            if (!this.isCurrentWindowIsAllow) {
                this.closeThisWindow();
            }
        },

        async clickOnTab(event, tab, group) {
            if (event.ctrlKey || event.metaKey) {
                if (this.multipleTabIds.includes(tab.id)) {
                    this.multipleTabIds.splice(this.multipleTabIds.indexOf(tab.id), 1);
                } else {
                    this.multipleTabIds.push(tab.id);
                }
            } else if (event.shiftKey) {
                if (this.multipleTabIds.length) {
                    let tabIds = group ? group.filteredTabs.map(Tabs.extractId) : this.filteredUnSyncTabs.map(Tabs.extractId),
                        tabIndex = tabIds.indexOf(tab.id),
                        lastTabIndex = -1;

                    this.multipleTabIds.slice().reverse().some(function(tabId) {
                        return -1 !== (lastTabIndex = tabIds.indexOf(tabId));
                    });

                    if (-1 === lastTabIndex) {
                        this.multipleTabIds.push(tab.id);
                    } else if (tabIndex !== lastTabIndex) {
                        let multipleTabIndex = this.multipleTabIds.indexOf(tabIds[lastTabIndex]);

                        for (let i = Math.min(tabIndex, lastTabIndex), maxIndex = Math.max(tabIndex, lastTabIndex); i <= maxIndex; i++) {
                            if (!this.multipleTabIds.includes(tabIds[i])) {
                                if (tabIndex > lastTabIndex) {
                                    this.multipleTabIds.push(tabIds[i]);
                                } else {
                                    this.multipleTabIds.splice(multipleTabIndex, 0, tabIds[i]);
                                }
                            }
                        }
                    }
                } else {
                    this.multipleTabIds.push(tab.id);
                }
            } else if (group) {
                this.applyGroup(group, tab);
            } else if (this.isCurrentWindowIsAllow) {
                await this.sendMessageModule('Tabs.moveNative', [tab.id], {
                    windowId: this.currentWindow.id,
                    index: -1,
                });

                await this.sendMessageModule('Tabs.show', tab.id);

                this.loadUnsyncedTabs();
            }
        },

        async removeGroup(group) {
            if (this.options.showConfirmDialogBeforeGroupDelete) {
                const ok = await this.confirm(this.lang('deleteGroup'), this.lang('confirmDeleteGroup', group.title), 'delete', 'is-danger');

                if (!ok) {
                    return;
                }
            }

            this.groups.splice(this.groups.indexOf(group), 1);

            this.sendMessageModule('Groups.remove', group.id);
        },
        setTabIconAsGroupIcon({favIconUrl}, group) {
            this.sendMessageModule('Groups.setIconUrl', group.id, favIconUrl);
        },

        isGroup(obj) {
            return obj.hasOwnProperty('tabs');
        },

        // allowTypes: Array ['groups', 'tabs']
        dragHandle(event, itemType, allowTypes, data) {
            if (event.type !== 'dragstart' && (!this.dragData || !this.dragData.allowTypes.includes(itemType))) {
                return;
            }

            switch (event.type) {
                case 'dragstart':
                    event.stopPropagation();
                    this.$emit('drag-moving', data.item, true);

                    this.dragData = {itemType, allowTypes, data};

                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/html', '');

                    if ('tab' === itemType) {
                        if (!this.multipleTabIds.includes(data.item.id)) {
                            this.multipleTabIds.push(data.item.id);
                        }

                        if (1 < this.multipleTabIds.length) {
                            let multiTabsNode = document.getElementById('multipleTabsText');
                            multiTabsNode.innerText = browser.i18n.getMessage('movingMultipleTabsText', this.multipleTabIds.length);

                            event.dataTransfer.setDragImage(multiTabsNode, 20, multiTabsNode.offsetHeight - 80);
                        }
                    }
                    break;
                case 'dragenter':
                    event.preventDefault();
                    event.stopPropagation();
                    this.$emit('drag-over', data.item, true);
                    break;
                case 'dragover':
                    event.preventDefault();
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = 'move';
                    return false;
                    break;
                case 'dragleave':
                    event.stopPropagation();
                    this.$emit('drag-over', data.item, false);
                    break;
                case 'drop':
                    event.preventDefault();
                    event.stopPropagation();
                    this.$emit('drag-over', data.item, false);

                    if (data.item !== this.dragData.data.item) {
                        this.$emit('drag-move-' + this.dragData.itemType, this.dragData, {itemType, allowTypes, data});
                    }

                    return false;
                    break;
                case 'dragend':
                    event.stopPropagation();
                    this.$emit('drag-moving', this.dragData.data.item, false);

                    if (1 === this.multipleTabIds.length) {
                        this.multipleTabIds = [];
                    }

                    this.dragData = null;
                    break;
            }
        },

        async closeThisWindow() {
            window.close();
        },

        openOptionsPage(section = 'general') {
            this.sendMessage('open-options-page', {section});
        },
    },
}
</script>

<template>
<!-- single view -->
<!-- grid display -->
<!-- free arrange -->

<div id="stg-manage" class="is-flex is-flex-direction-column" tabindex="-1"
    @contextmenu="['INPUT', 'TEXTAREA'].includes($event.target.nodeName) ? null : $event.preventDefault()"
    @click="multipleTabIds = []"
    @keydown.esc="closeThisWindow"
    @keydown.f3.stop.prevent="setFocusOnSearch"
    >
    <header class="field is-flex is-align-items-center gap-indent">
        <span class="is-size-4">
            <span v-text="lang('extensionName')"></span> - <span v-text="lang('manageGroupsTitle')"></span>
        </span>
        <div class="checkboxes as-column">
            <label class="checkbox" :disabled="isLoading">
                <input v-model="options.showTabsWithThumbnailsInManageGroups" :disabled="isLoading" type="checkbox" />
                <span v-text="lang('showTabsWithThumbnailsInManageGroups')"></span>
            </label>
            <label class="checkbox" :disabled="isLoading">
                <input v-model="options.showArchivedGroups" :disabled="isLoading" type="checkbox" />
                <span v-text="lang('showArchivedGroups')"></span>
            </label>
        </div>
        <div class="buttons has-addons is-hidden">
            <span class="button is-small is-primary" v-text="lang('manageGroupViewGrid')"></span>
            <span class="button is-small" disabled v-text="lang('manageGroupViewFreeArrange')"></span>
        </div>
        <div class="is-flex-grow-1 is-flex is-flex-wrap-wrap is-justify-content-end gap-indent">
            <div>
                <div class="field has-addons">
                    <p class="control">
                        <button class="button" @click="addGroup" :disabled="isLoading">
                            <span class="icon">
                                <figure class="image is-16x16">
                                    <img src="/icons/group-new.svg" />
                                </figure>
                            </span>
                            <span v-text="lang('createNewGroup')"></span>
                        </button>
                    </p>
                    <p class="control">
                        <button class="button" @click="openDefaultGroup" :title="lang('defaultGroup')" :disabled="isLoading">
                            <span class="icon">
                                <figure class="image is-16x16">
                                    <img src="/icons/wrench.svg"/>
                                </figure>
                            </span>
                        </button>
                    </p>
                </div>
            </div>
            <div>
                <div id="search-wrapper" class="field" :class="{'has-addons': searchDelay.length}">
                    <div class="control has-icons-left is-expanded" :class="{'is-loading': searchDelayTimer}">
                        <input
                            type="text"
                            class="input"
                            ref="search"
                            v-model.trim="searchDelay"
                            autocomplete="off"
                            @click.stop
                            :placeholder="lang('searchPlaceholder')"
                            :readonly="isLoading" />
                        <span class="icon is-small is-left">
                            <figure class="image is-16x16">
                                <img class="no-fill" src="/icons/search.svg"></img>
                            </figure>
                        </span>
                    </div>
                    <div v-show="searchDelay.length" class="control">
                        <button class="button" @click="extendedSearch = !extendedSearch" :title="lang('extendedTabSearch')">
                            <span class="icon">
                                <figure class="image is-16x16">
                                    <img v-if="extendedSearch" src="/icons/check-square.svg" />
                                    <img v-else src="/icons/square.svg" />
                                </figure>
                            </span>
                        </button>
                    </div>
                </div>
            </div>
            <div>
                <button class="button" @click="openOptionsPage()" :disabled="isLoading">
                    <span class="icon">
                        <figure class="image is-16x16">
                            <img src="/icons/settings.svg" />
                        </figure>
                    </span>
                    <span v-text="lang('openSettings')"></span>
                </button>
            </div>
        </div>
    </header>

    <main id="result" v-show="!isLoading">
        <!-- GRID -->
        <div v-if="view === VIEW_GRID" :class="['grid',
            dragData ? 'drag-' + dragData.itemType : false,
        ]">
            <div
                v-for="group in filteredGroups"
                :key="group.id"
                :class="['group', {
                    'is-archive': group.isArchive,
                    'drag-moving': group.isMoving,
                    'drag-over': group.isOver,
                    'is-opened': isOpenedGroup(group),
                }]"
                @contextmenu="'INPUT' !== $event.target.nodeName && $refs.contextMenuGroup.open($event, {group})"

                :draggable="String(group.draggable)"
                @dragstart="dragHandle($event, 'group', ['group'], {item: group})"
                @dragenter="dragHandle($event, 'group', ['group'], {item: group})"
                @dragover="dragHandle($event, 'group', ['group'], {item: group})"
                @dragleave="dragHandle($event, 'group', ['group'], {item: group})"
                @drop="dragHandle($event, 'group', ['group'], {item: group})"
                @dragend="dragHandle($event, 'group', ['group'], {item: group})"

                >
                <div class="header">
                    <div class="group-icon">
                        <figure :class="['image is-16x16', {'is-sticky': group.isSticky}]">
                            <img :src="group.iconUrlToDisplay" />
                        </figure>
                    </div>
                    <div class="other-icon" v-if="group.newTabContainer !== DEFAULT_COOKIE_STORE_ID">
                        <figure :class="`image is-16x16 userContext-icon identity-icon-${containers[group.newTabContainer]?.icon} identity-color-${containers[group.newTabContainer]?.color}`"></figure>
                    </div>
                    <div class="other-icon" v-if="group.isArchive">
                        <figure class="image is-16x16">
                            <img src="/icons/archive.svg" />
                        </figure>
                    </div>
                    <div class="group-title">
                        <input
                            type="text"
                            class="input"
                            @focus="group.draggable = false"
                            @blur="group.draggable = true"
                            v-model.lazy.trim="group.title"
                            :placeholder="lang('title')"
                            maxlength="256"
                            />
                    </div>
                    <div class="tabs-count" v-text="groupTabsCountMessage(group.filteredTabs, group.isArchive)"></div>
                    <div class="other-icon is-clickable is-unselectable" @click="openGroupSettings(group)" @keydown.enter.stop.prevent="openGroupSettings(group)" tabindex="0" :title="lang('groupSettings')">
                        <figure class="image is-16x16">
                            <img src="/icons/settings.svg" />
                        </figure>
                    </div>
                    <div class="other-icon is-clickable is-unselectable" @click="removeGroup(group)" @keydown.enter.stop.prevent="removeGroup(group)" tabindex="0" :title="lang('deleteGroup')">
                        <figure class="image is-16x16">
                            <img src="/icons/group-delete.svg" />
                        </figure>
                    </div>
                </div>
                <div :class="['body', {
                    'in-list-view': !options.showTabsWithThumbnailsInManageGroups,
                }]">
                    <div
                        v-for="(tab, index) in group.filteredTabs"
                        :key="index"
                        :class="['tab', {
                            'is-active-element': tab.active,
                            'is-in-multiple-drop': multipleTabIds.includes(tab.id),
                            'has-thumbnail': options.showTabsWithThumbnailsInManageGroups && tab.thumbnail,
                            'drag-moving': tab.isMoving,
                            'drag-over': tab.isOver,
                        },
                            tab.container && `identity-color-${tab.container?.color}`
                        ]"
                        :title="getTabTitle(tab, true)"
                        @contextmenu.stop.prevent="!group.isArchive && $refs.contextMenuTab.open($event, {tab, group})"

                        @click.stop="!group.isArchive && clickOnTab($event, tab, group)"

                        :draggable="String(!group.isArchive)"
                        @dragstart="dragHandle($event, 'tab', ['tab', 'group'], {item: tab, group})"
                        @dragenter="dragHandle($event, 'tab', ['tab', 'group'], {item: tab, group})"
                        @dragover="dragHandle($event, 'tab', ['tab', 'group'], {item: tab, group})"
                        @dragleave="dragHandle($event, 'tab', ['tab', 'group'], {item: tab, group})"
                        @drop="dragHandle($event, 'tab', ['tab', 'group'], {item: tab, group})"
                        @dragend="dragHandle($event, 'tab', ['tab', 'group'], {item: tab, group})"
                        >
                        <template v-if="options.showTabsWithThumbnailsInManageGroups">
                            <div class="tab-icon">
                                <figure class="image is-16x16">
                                    <img :src="tab.favIconUrl" loading="lazy" decoding="async" />
                                </figure>
                            </div>
                            <div v-if="isTabLoading(tab)" class="refresh-icon">
                                <figure class="image is-16x16">
                                    <img src="/icons/tab-loading.svg" />
                                </figure>
                            </div>
                        </template>
                        <template v-else>
                            <div class="tab-icon">
                                <figure class="image is-16x16">
                                    <img v-if="isTabLoading(tab)" src="/icons/tab-loading.svg"/>
                                    <img v-else :src="tab.favIconUrl" loading="lazy" decoding="async" />
                                </figure>
                            </div>
                        </template>
                        <div v-if="tab.cookieStoreId && tab.cookieStoreId !== DEFAULT_COOKIE_STORE_ID" class="cookie-container">
                            <figure :title="tab.container?.name" :class="`image is-16x16 userContext-icon identity-icon-${tab.container?.icon} identity-color-${tab.container?.color}`"></figure>
                        </div>
                        <div v-if="options.showTabsWithThumbnailsInManageGroups" class="screenshot">
                            <img v-if="tab.thumbnail" :src="tab.thumbnail" loading="lazy" decoding="async">
                        </div>

                        <div
                            @mousedown.middle.prevent
                            @mouseup.middle.prevent="!group.isArchive && removeTab(tab)"
                            class="tab-title clip-text"
                            :class="{'discarded-color': group.isArchive || tab.discarded}"
                            v-text="getTabTitle(tab)"></div>

                        <div v-if="!group.isArchive" class="delete-tab-button" @click.stop="removeTab(tab)" :title="lang('deleteTab')">
                            <figure class="image is-16x16">
                                <img src="/icons/close.svg" />
                            </figure>
                        </div>
                    </div>

                    <div
                        v-if="!group.isArchive"
                        class="tab new"
                        tabindex="0"
                        :title="lang('createNewTab')"
                        @click="addTab(group)"
                        @keydown.enter.stop.prevent="addTab(group)"
                        @contextmenu.stop.prevent="$refs.contextMenuTabNew.open($event, {group})"
                        >
                        <div :class="options.showTabsWithThumbnailsInManageGroups ? 'screenshot' : 'tab-icon'">
                            <figure class="image is-16x16">
                                <img src="/icons/tab-new.svg" />
                            </figure>
                        </div>
                        <span class="tab-title icon-text">
                            <span class="is-flex-grow-1" v-text="lang('createNewTab')"></span>
                            <figure class="icon image is-16x16" @click.stop="$refs.contextMenuTabNew.open($event, {group})">
                                <img src="/icons/wrench.svg" />
                            </figure>
                        </span>
                    </div>
                </div>
            </div>

            <div v-if="unSyncTabs.length" class="group">
                <div class="header">
                    <div class="group-icon"></div>
                    <div class="group-title">
                        <span v-text="lang('showOtherTabs')"></span>
                    </div>
                    <div class="tabs-count" v-text="groupTabsCountMessage(unSyncTabs)"></div>
                </div>
                <div :class="['body', {
                        'in-list-view': !options.showTabsWithThumbnailsInManageGroups,
                    }]">
                    <div
                        v-for="tab in filteredUnSyncTabs"
                        :key="tab.id"
                        :class="['tab', {
                            'is-in-multiple-drop': multipleTabIds.includes(tab.id),
                            'has-thumbnail': options.showTabsWithThumbnailsInManageGroups && tab.thumbnail,
                            'drag-moving': tab.isMoving,
                        },
                            tab.container && `identity-color-${tab.container?.color}`
                        ]"
                        :title="getTabTitle(tab, true)"
                        @contextmenu.stop.prevent="$refs.contextMenuTab.open($event, {tab})"

                        @click.stop="clickOnTab($event, tab)"

                        draggable="true"
                        @dragstart="dragHandle($event, 'tab', ['tab', 'group'], {item: tab})"
                        @dragend="dragHandle($event, 'tab', ['tab', 'group'], {item: tab})"
                        >
                        <template v-if="options.showTabsWithThumbnailsInManageGroups">
                            <div class="tab-icon">
                                <figure class="image is-16x16">
                                    <img :src="tab.favIconUrl" loading="lazy" decoding="async" />
                                </figure>
                            </div>
                            <div v-if="isTabLoading(tab)" class="refresh-icon">
                                <figure class="image is-16x16">
                                    <img src="/icons/tab-loading.svg"/>
                                </figure>
                            </div>
                        </template>
                        <template v-else>
                            <div class="tab-icon">
                                <figure class="image is-16x16">
                                    <img v-if="isTabLoading(tab)" src="/icons/tab-loading.svg"/>
                                    <img v-else :src="tab.favIconUrl" loading="lazy" decoding="async" />
                                </figure>
                            </div>
                        </template>
                        <div v-if="tab.cookieStoreId && tab.cookieStoreId !== DEFAULT_COOKIE_STORE_ID" class="cookie-container">
                            <figure :title="tab.container?.name" :class="`image is-16x16 userContext-icon identity-icon-${tab.container?.icon} identity-color-${tab.container?.color}`"></figure>
                        </div>
                        <div v-if="options.showTabsWithThumbnailsInManageGroups" class="screenshot">
                            <img v-if="tab.thumbnail" :src="tab.thumbnail" loading="lazy" decoding="async">
                        </div>
                        <div
                            @mousedown.middle.prevent
                            @mouseup.middle.prevent="removeTab(tab)"
                            class="tab-title clip-text"
                            :class="{'discarded-color': tab.discarded}"
                            v-text="getTabTitle(tab)"></div>

                        <div class="delete-tab-button" @click.stop="removeTab(tab)" :title="lang('deleteTab')">
                            <figure class="image is-16x16">
                                <img src="/icons/close.svg"/>
                            </figure>
                        </div>
                    </div>
                </div>
            </div>

            <div class="group new is-clickable"
                @click="addGroup"
                draggable="true"
                @dragover="dragHandle($event, 'tab', ['tab'])"
                @drop="dragHandle($event, 'tab', ['tab'], {item: {id: 'new-group'}})"

                >
                <figure class="image is-96x96">
                    <img src="/icons/group-new.svg" />
                </figure>
                <div v-text="lang('createNewGroup')"></div>
            </div>
        </div>
    </main>

    <transition name="fade">
        <div class="loading" v-show="isLoading">
            <figure class="image">
                <img src="/icons/icon-animate.svg" />
            </figure>
        </div>
    </transition>

    <div id="multipleTabsText" class="notification is-success"></div>

    <context-menu-tab-new ref="contextMenuTabNew" @add="addTab"></context-menu-tab-new>

    <context-menu-group ref="contextMenuGroup"
        :menu="options.contextMenuGroup"
        :groups="groups"
        :opened-windows="openedWindows"
        :show-rename="false"
        :show-settings="false"
        :show-remove="false"
        @open-in-new-window="(group, tab) => applyGroup(group, tab, true)"
        @sort="sortGroups"
        @discard="discardGroup"
        @discard-other="discardOtherGroups"
        @export-to-bookmarks="exportGroupToBookmarks"
        @unload="unloadGroup"
        @archive="toggleArchiveGroup"
        @unarchive="toggleArchiveGroup"
        @reload-all-tabs="reloadAllTabsInGroup"
        ></context-menu-group>

    <context-menu-tab ref="contextMenuTab"
        :menu="options.contextMenuTab"
        :groups="groups"
        :multiple-tab-ids="multipleTabIds"
        :show-update-thumbnail="options.showTabsWithThumbnailsInManageGroups"
        @open-in-new-window="(group, tab) => applyGroup(group, tab, true)"
        @reload="reloadTab"
        @discard="discardTab"
        @remove="removeTab"
        @update-thumbnail="updateTabThumbnail"
        @set-group-icon="setTabIconAsGroupIcon"
        @move-tab="moveTabs"
        @move-tab-new-group="moveTabToNewGroup"
        ></context-menu-tab>

    <popup
        v-if="openEditDefaultGroup"
        :title="lang('defaultGroup')"
        :buttons="
            [{
                event: 'save-group',
                classList: 'is-success',
                lang: 'save',
            }, {
                event: 'close-popup',
                lang: 'cancel',
            }]
        "
        @save-group="() => $refs.editDefaultGroup.triggerChanges()"
        @close-popup="openEditDefaultGroup = false"
        >
        <edit-group
            ref="editDefaultGroup"
            :group-to-edit="defaultGroup"
            :is-default-group="true"
            :group-to-compare="defaultCleanGroup"
            @changes="saveDefaultGroup"></edit-group>
    </popup>

    <popup
        v-if="groupToEdit"
        :title="lang('groupSettings')"
        :buttons="
            [{
                event: 'save-group',
                classList: 'is-success',
                lang: 'save',
            }, {
                event: 'close-popup',
                lang: 'cancel',
            }]
        "
        @close-popup="groupToEdit = null"
        @save-group="() => $refs.editGroup.triggerChanges()"
        >
        <edit-group
            ref="editGroup"
            :group-to-edit="groupToEdit.$data"
            :group-to-compare="groupToEdit.$data"
            @changes="changes => saveEditedGroup(groupToEdit.id, changes)"></edit-group>
    </popup>

    <popup-helpers
        v-if="promptOptions || confirmOptions"
        :prompt="promptOptions"
        :confirm="confirmOptions"
        ></popup-helpers>


    <!-- <footer class="is-flex is-unselectable">
        footer
    </footer> -->

    <div
        v-if="enableDebug"
        id="debug-message"
        class="tag is-warning is-medium is-clickable"
        @click="openOptionsPage('general debug')"
        v-text="lang('loggingIsEnabledTitle')"
        ></div>
</div>

</template>

<style>
:root {
    --group-active-shadow: 0 0 0 3.5px hsla(from var(--bulma-info-50) h s l / .4);
    --group-active-border-color: var(--bulma-info-50);
    --group-active-border: var(--border-width) solid var(--group-active-border-color);

    --tab-active-shadow: var(--group-active-shadow);
    --tab-active-border: var(--group-active-border);
    --tab-inner-border-color: var(--bulma-scheme-main-quater);
    --tab-icons-radius: 75%;
    --tab-icons-size: 20px;

    --multiple-tab-text-color: var(--bulma-white);
    --multiple-tab-bg-color: light-dark(var(--bulma-info-55), var(--bulma-info-30));

    --border-width: 1px;
    --border-radius: 0.375rem;
}

.fade-enter-active, .fade-leave-active {
    transition: opacity .5s;
}
.fade-enter, .fade-leave-to /* .fade-leave-active до версии 2.1.8 */ {
    opacity: 0;
}

#stg-manage {
    padding: var(--bulma-block-spacing) var(--bulma-block-spacing) calc(var(--bulma-block-spacing) * 10);
}

#search-wrapper {
    width: 20em;
}

.loading {
    --image-size: 48px;

    position: absolute;
    top: calc(50vh - var(--image-size) / 2);
    left: calc(50vw - var(--image-size) / 2);

    figure {
        width: var(--image-size);
        height: var(--image-size);
    }
}

#multipleTabsText {
    position: fixed;
    text-align: center;
    left: -1000%;
    max-width: 20em;
    pointer-events: none;
}

#result {
    /* GRID VIEW */
    .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
        /* grid-template-rows: minmax(auto, 600px) minmax(auto, 600px); */
        grid-gap: var(--gap-indent);
    }

    .group {
        display: flex;
        flex-direction: column;
        border: var(--border-width) solid var(--bulma-border);
        max-height: 600px;
        background-color: var(--bulma-scheme-main-bis);
        border-radius: var(--border-radius);
        user-select: none;

        &.drag-over {
            outline-offset: 0.3rem;
        }

        > .header {
            display: flex;
            align-items: center;
            gap: var(--gap-indent);
            padding: var(--gap-indent-mini) var(--gap-indent);

            > .group-title {
                flex-grow: 1;
            }

            figure {
                pointer-events: none;
            }
        }

        > .body {
            overflow-y: auto;
            padding: var(--gap-indent-mini);
            scrollbar-width: thin;
            min-height: 10em;

            &:not(.in-list-view) {
                display: grid;
                grid-gap: var(--gap-indent-mini);
                grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
                grid-auto-rows: 10em;
            }

            &.in-list-view {
                display: flex;
                flex-direction: column;
            }
        }

        .tab {
            position: relative;
        }

        &:not(.is-archive) .tab {
            cursor: pointer;
        }

        > .body:not(.in-list-view) > .tab {
            --inner-indent: var(--gap-indent-mini);
            --half-inner-indent: calc(var(--inner-indent) / 2);
            --text-height: 1.3em;
            --icon-size: 16px;
            --half-icon-size: calc(var(--icon-size) / 2);

            padding: var(--inner-indent);
            border-radius: var(--border-radius);

            > * {
                border: 0 solid var(--identity-tab-color, var(--tab-inner-border-color));
                background-color: var(--bulma-scheme-main-bis);
            }

            > .tab-icon,
            > .delete-tab-button,
            > .cookie-container,
            > .refresh-icon,
            > .tab-title {
                position: absolute;
                display: flex;
            }

            &:not(.has-thumbnail) > .tab-icon {
                align-items: start;
                justify-content: start;
                width: var(--icon-size);
                height: var(--icon-size);
                top: calc(50% - var(--half-icon-size) + var(--inner-indent) + var(--border-width) - var(--text-height));
                left: calc(50% - var(--half-icon-size));
            }

            &.has-thumbnail > .tab-icon {
                align-items: start;
                justify-content: start;
                top: var(--inner-indent);
                left: var(--inner-indent);
                width: var(--tab-icons-size);
                height: var(--tab-icons-size);
                border-bottom-width: var(--border-width);
                border-right-width: var(--border-width);
                border-bottom-right-radius: var(--tab-icons-radius);
            }

            > .delete-tab-button {
                visibility: hidden;
                align-items: start;
                justify-content: end;
                top: var(--inner-indent);
                right: var(--inner-indent);
                height: var(--tab-icons-size);
                width: var(--tab-icons-size);
                line-height: 0;
                border-bottom-width: var(--border-width);
                border-left-width: var(--border-width);
                border-bottom-left-radius: var(--tab-icons-radius);
            }

            &:hover > .delete-tab-button {
                visibility: visible;
            }

            > .cookie-container {
                display: flex;
                align-items: end;
                justify-content: start;
                left: var(--inner-indent);
                bottom: calc(var(--inner-indent) + var(--text-height) + var(--border-width));
                width: var(--tab-icons-size);
                height: var(--tab-icons-size);
                border-right-width: var(--border-width);
                border-top-width: var(--border-width);
                border-top-right-radius: var(--tab-icons-radius);
            }

            > .refresh-icon {
                display: flex;
                align-items: end;
                justify-content: end;
                bottom: calc(var(--inner-indent) + var(--text-height) + var(--border-width));
                right: var(--inner-indent);
                width: var(--tab-icons-size);
                height: var(--tab-icons-size);
                border-left-width: var(--border-width);
                border-top-width: var(--border-width);
                border-top-left-radius: var(--tab-icons-radius);
            }

            > .tab-title {
                line-height: var(--text-height);
                left: var(--inner-indent);
                right: var(--inner-indent);
                bottom: var(--inner-indent);
                white-space: nowrap;
            }

            > .screenshot {
                height: calc(100% - var(--text-height) - var(--border-width));
                overflow: hidden;
                border-width: var(--border-width);
                border-radius: var(--border-radius);

                > img {
                    width: 100%;
                    height: 100%;

                    &[src=""] {
                        display: none;
                    }
                }
            }

            &.new > .screenshot {
                display: flex;
                justify-content: center;
                align-items: center;
                border-style: dashed;
            }

            &.is-active-element {
                box-shadow: var(--tab-active-shadow);
                outline: var(--tab-active-border);
                outline-offset: -1px;
            }

            &.is-in-multiple-drop,
            &.is-in-multiple-drop > * {
                color: var(--multiple-tab-text-color);
                background-color: var(--multiple-tab-bg-color);

                img {
                    color-scheme: dark;
                }
            }

            &.drag-over {
                &.drag-moving,
                &.is-in-multiple-drop {
                    outline-offset: 0.3rem;
                }
            }
        }

        > .body.in-list-view > .tab {
            display: flex;
            align-items: center;
            justify-content: left;
            gap: var(--gap-indent);
            height: 27px;
            padding: var(--gap-indent-mini);

            &.new {
                border: var(--border-width) dashed var(--tab-inner-border-color);
            }

            &:hover {
                background-color: var(--bulma-scheme-main-ter);
            }

            > .delete-tab-button {
                display: flex;
                visibility: hidden;
            }

            &:hover > .delete-tab-button {
                visibility: visible;
            }

            > .tab-title {
                flex-grow: 1;
                white-space: nowrap;
            }

            &.is-active-element {
                outline: var(--border-width) solid var(--identity-tab-color, var(--group-active-border-color));
                outline-offset: -1px;
            }

            &.is-in-multiple-drop,
            &.is-in-multiple-drop > * {
                color: var(--multiple-tab-text-color);
                background-color: var(--multiple-tab-bg-color);

                img {
                    color-scheme: dark;
                }
            }
        }

        &.is-opened {
            box-shadow: var(--group-active-shadow);
            border: var(--group-active-border);
        }

        &.new {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: var(--gap-indent);
            min-height: 20em;
            border: 2px dashed var(--tab-inner-border-color);
            background-color: transparent;
        }
    }

    .group,
    .group .tab {
        transition: opacity 0.3s;
    }

    .drag-tab .tab > *,
    .drag-tab .group > *,
    .drag-group .group > * {
        pointer-events: none;
    }

    .drag-tab .group > .body > *:not(.new) {
        pointer-events: all;
    }

    /* Drag & Drop Styles */

    .drag-moving,
    .drag-tab .tab.is-in-multiple-drop {
        opacity: 0.4;
    }
}

#debug-message {
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
}

</style>
