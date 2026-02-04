<script>
import Vue from 'vue';

// import popup from '../components/popup.vue';
import popupHelpers from '../components/popup-helpers.vue';
import editGroupPopup from './edit-group-popup.vue';
import editGroup from '../components/edit-group.vue';
import contextMenu from '../components/context-menu.vue';
import contextMenuTab from '../components/context-menu-tab.vue';
import contextMenuTabNew from '../components/context-menu-tab-new.vue';
import contextMenuGroup from '../components/context-menu-group.vue';

import '/js/prefixed-storage.js';
import * as Constants from '/js/constants.js';
import Logger, {errorEventHandler} from '/js/logger.js';
import Lang from '/js/lang.js';
import * as Containers from '/js/containers.js';
import * as Groups from '/js/groups.js';
import * as Tabs from '/js/tabs.js';
import * as Utils from '/js/utils.js';

import defaultGroupMixin from '/js/mixins/default-group.mixin.js';
import globalMixin from '/js/mixins/global.mixin.js';
import optionsMixin from '/js/mixins/options.mixin.js';
import popupHelpersMixin from '/js/mixins/popup-helpers.mixin.js';
import syncCloudMixin from '/js/mixins/sync-cloud.mixin.js';
import tabGroupsMixin from '/js/mixins/tab-groups.mixin.js';

const isSidebar = '#sidebar' === window.location.hash;
const MODULE_NAME = isSidebar ? Constants.MODULES.SIDEBAR : Constants.MODULES.POPUP;

window.logger = new Logger(MODULE_NAME);
Vue.config.errorHandler = errorEventHandler.bind(window.logger);

const storage = localStorage.create(Constants.MODULES.POPUP);

const SECTION_SEARCH = 'search';
const SECTION_GROUPS_LIST = 'groupsList';
const SECTION_GROUP_TABS = 'groupTabs';
const SECTION_DEFAULT = SECTION_GROUPS_LIST;

export default {
    name: Constants.MODULES.POPUP,
    mixins: [
        defaultGroupMixin,
        globalMixin,
        optionsMixin,
        popupHelpersMixin,
        syncCloudMixin,
        tabGroupsMixin,
    ],
    data() {
        return {
            isSidebar,

            extraAvailableTabKeys: ['lastAccessed', 'audible', 'mutedInfo'],
            optionsWatchKeys: Constants.POPUP_SETTINGS_MENU_ITEMS
                .map(item => item.optionsCheckbox && item.key)
                .filter(Boolean),

            SECTION_SEARCH,
            SECTION_GROUPS_LIST,
            SECTION_GROUP_TABS,

            POPUP_SETTINGS_MENU_ITEMS: Constants.POPUP_SETTINGS_MENU_ITEMS,
            section: SECTION_DEFAULT,

            someGroupAreLoading: false,

            searchOnlyGroups: storage.searchOnlyGroupsInPopup ?? false,

            groupToShow: null,

            showUnSyncTabs: false,
        };
    },
    components: {
        // popup: popup,
        'popup-helpers': popupHelpers,
        'edit-group-popup': editGroupPopup,
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

        if (this.options.openGroupAfterChange && this.currentGroup) {
            this.showSectionGroupTabs(this.currentGroup);
        }

        log.stop();
    },
    watch: {
        isLoading() {
            document.getElementById('loading').classList.toggle('is-hidden', !this.isLoading);
        },
        'options.fullPopupWidth'(fullPopupWidth) {
            if (!this.isSidebar) {
                document.documentElement.classList.toggle('full-popup-width', fullPopupWidth);
            }
        },
        section() {
            this.multipleTabIds = [];
        },
        groupToEdit(groupToEdit) {
            if (!groupToEdit) {
                this.setFocusOnSearch();
            }
        },
        search(search) {
            if (search.length) {
                this.showSectionSearch();
            }
        },
        searchOnlyGroups(value) {
            storage.searchOnlyGroupsInPopup = !!value;
        },
        groups(groups) {
            if (this.groupToShow) {
                this.groupToShow = groups.find(gr => gr.id === this.groupToShow.id) || null;
            }
        },
    },
    computed: {
        filteredGroups() {
            let searchStr = this.search.toLowerCase(),
                groups = this.options.showArchivedGroups ? this.groups : this.groups.filter(group => !group.isArchive),
                filteredGroups = [];

            groups.forEach(group => {
                if (this.searchOnlyGroups) {
                    group.filteredTabs = [];

                    if (Utils.mySearchFunc(searchStr, group.title)) {
                        filteredGroups.push(group);
                    }
                } else {
                    group.filteredTabs = group.tabs.filter(tab => Utils.mySearchFunc(searchStr, Tabs.getTitle(tab, true), this.extendedSearch));

                    if (group.filteredTabs.length || Utils.mySearchFunc(searchStr, group.title, this.extendedSearch)) {
                        group.filteredTabs.sort(this.$_simpleSortTabs.bind(null, searchStr));
                        filteredGroups.push(group);
                    }
                }
            });

            return filteredGroups;
        },
        unSyncWindowTabs() {
            return this.currentWindow ? this.unSyncTabs.filter(tab => tab.windowId === this.currentWindow.id) : [];
        },
        countWindowsUnSyncTabs() {
            return this.unSyncTabs.map(tab => tab.windowId).filter(Utils.onlyUniqueFilter).length;
        },
        syncTitle() {
            let result = this.lang('syncStart');

            if (this.syncCloudLastUpdateAgo) {
                result += ' (' + this.lang('lastUpdate') + `: ${this.syncCloudLastUpdateAgo})`;
            }

            return result;
        },
    },
    methods: {
        lang: Lang,

        async setFocusOnActive() {
            await this.$nextTick();

            let activeItemNode = document.querySelector('.is-active-element');

            if (!activeItemNode && this.groupToShow) {
                const activeTab = Utils.getLastActiveTab(this.groupToShow.tabs);

                if (activeTab) {
                    activeItemNode = document.querySelector(`[data-tab-id="${activeTab.id}"]`);
                }
            }

            if (activeItemNode) {
                activeItemNode.focus();
            } else {
                this.setFocusOnSearch();
            }
        },

        setupListeners() {
            this.tabGroupsSetupListeners();

            this
                .$on('drag-move-group', (from, to) => {
                    this.sendMessageModule('Groups.move', from.data.item.id, this.groups.indexOf(to.data.item));
                })
                .$on('drag-move-tab', (from, to) => {
                    const tabIds = this.getTabIdsForMove(from.data.item.id),
                        newTabIndex = to.data.item.index;

                    this.sendMessageModule('Tabs.move', tabIds, to.data.group.id, {
                        newTabIndex,
                        showTabAfterMovingItIntoThisGroup: false,
                        showOnlyActiveTabAfterMovingItIntoThisGroup: false,
                        showNotificationAfterMovingTabIntoThisGroup: false,
                    });
                })
                .$on('drag-moving', (item, isMoving) => item.isMoving = isMoving)
                .$on('drag-over', (item, isOver) => item.isOver = isOver);

            this
                .$on('sync-error', async ({name, message}) => {
                    if (this.syncCloudProgress < 5) {
                        this.syncCloudProgress = 15;
                    }

                    if (this.syncCloudTriggeredByPopup) {
                        const ok = await this.confirm(name, message, 'openSettings', 'is-info');
                        ok && this.openOptionsPage('backup/sync');
                    }
                })
                .$on('sync-finish', () => {
                    this.syncCloudTriggeredByPopup = false;
                });

            this.$on('group-removed', request => {
                if (this.groupToShow?.id === request.groupId) {
                    this.showSectionDefault();
                }
            });
            this.$on('group-loaded-ready', request => {
                if (this.options.openGroupAfterChange) {
                    if (this.currentGroup?.id === request.groupId && this.currentGroup !== this.groupToShow) {
                        this.showSectionGroupTabs(this.currentGroup);
                    }
                }

                if (request.addTabs.length) {
                    const group = this.groups.find(gr => gr.id === request.groupId);
                    group.tabs.push(...request.addTabs.map(this.mapTab, this));
                }
            });
        },

        showSectionGroupTabs(group) {
            this.groupToShow = group;
            this.search = this.searchDelay = '';
            this.section = SECTION_GROUP_TABS;
            this.setFocusOnSearch();
        },
        showSectionSearch() {
            this.groupToShow = null;
            this.section = SECTION_SEARCH;
        },
        showSectionDefault() {
            this.section = SECTION_DEFAULT;
            this.groupToShow = null;
            this.search = this.searchDelay = '';
            this.setFocusOnSearch();
        },

        $_simpleSortTabs(searchStr, a, b) {
            let aIncludes = Tabs.getTitle(a, true).toLowerCase().includes(searchStr),
                bIncludes = Tabs.getTitle(b, true).toLowerCase().includes(searchStr);

            if (aIncludes && !bIncludes) { // move up
                return -1;
            }

            if (!aIncludes && bIncludes) { // move down
                return 1;
            }

            return 0; // stay
        },

        async createNewGroup(tabIds, proposalTitle, applyGroupWithTabId) {
            if (this.options.alwaysAskNewGroupName) {
                const {defaultGroupProps} = await Groups.getDefaults();
                proposalTitle = Groups.createTitle(proposalTitle, null, defaultGroupProps);
                proposalTitle = await this.prompt(this.lang('createNewGroup'), proposalTitle);

                if (!proposalTitle) {
                    return false;
                }
            }

            const newGroupWindowId = this.currentWindow.groupId ? undefined : this.currentWindow.id;
            const newGroup = this.sendMessageModule('Groups.add', newGroupWindowId, tabIds, proposalTitle);

            if (applyGroupWithTabId) {
                this.applyGroup(newGroup, {id: applyGroupWithTabId});
            }
        },

        async renameGroup(group) {
            const title = await this.prompt(this.lang('hotkeyActionTitleRenameGroup'), group.title);

            if (title) {
                group.title = title;
            }
        },

        tryRenameGroup() {
            if (this.groupToShow) {
                this.renameGroup(this.groupToShow);
            } else if (this.currentGroup) {
                this.renameGroup(this.currentGroup);
            }
        },

        showMuteIconTab(tab) {
            return tab.audible || tab.mutedInfo.muted;
        },

        showMuteIconGroup(group) {
            return group.isArchive ? false : group.tabs.some(this.showMuteIconTab);
        },

        toggleMuteTab(tab) {
            Tabs.setMute([tab.id], tab.audible);
        },

        toggleMuteGroup(group) {
            this.sendMessageModule('Tabs.setMute', group.tabs.map(Tabs.extractId), group.tabs.some(tab => tab.audible));
        },

        clickOnTab(event, tab, group) {
            if (event.ctrlKey || event.metaKey) {
                if (this.multipleTabIds.includes(tab.id)) {
                    this.multipleTabIds.splice(this.multipleTabIds.indexOf(tab.id), 1);
                } else {
                    this.multipleTabIds.push(tab.id);
                }
            } else if (event.shiftKey) {
                if (this.multipleTabIds.length) {
                    let tabs = [];

                    if (SECTION_SEARCH === this.section) {
                        tabs = this.filteredGroups.reduce((acc, group) => (acc.push(...group.filteredTabs), acc), []);
                    } else {
                        tabs = group ? group.tabs : this.unSyncTabs;
                    }

                    let tabIds = tabs.map(Tabs.extractId),
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
            } else {
                this.applyGroup(group, tab, event.key === 'Enter');
            }
        },

        closeWindow() {
            if (!this.isSidebar) {
                window.close();
            }
        },

        async applyGroup(group, tab, closePopup = false) {
            if (this.someGroupAreLoading) {
                return;
            }

            this.multipleTabIds = [];

            let isCurrentGroup = group === this.currentGroup;

            if (this.isSidebar && closePopup) {
                this.showSectionGroupTabs(group);
            }

            if (isCurrentGroup) {
                if (!tab) { // open group
                    this.showSectionGroupTabs(group);
                    return;
                }

                if (tab.active) {
                    return;
                }
            }

            if (closePopup) {
                this.sendMessage('load-custom-group', {
                    groupId: group.id,
                    tabId: tab?.id,
                });
                this.closeWindow();
            } else {
                this.someGroupAreLoading = true;

                let loadGroupPromise = this.sendMessage('load-custom-group', {
                    groupId: group.id,
                    tabId: tab?.id,
                });

                if (!this.isSidebar && this.options.closePopupAfterSelectTab && tab) {
                    this.someGroupAreLoading = false;
                    this.closeWindow();
                    return;
                }

                if (this.options.closePopupAfterChangeGroup) {
                    if (!isCurrentGroup) {
                        this.closeWindow();
                    }

                    this.someGroupAreLoading = false;
                } else {
                    await loadGroupPromise;

                    this.someGroupAreLoading = false;

                    this.loadUnsyncedTabs();
                }
            }
        },
        async unsyncHiddenTabsMoveToCurrentGroup() {
            let tabsIds = this.unSyncTabs.map(Tabs.extractId);

            if (this.currentGroup) {
                this.unSyncTabs = [];

                await this.sendMessageModule('Tabs.move', tabsIds, this.currentGroup.id);
            } else {
                await this.sendMessageModule('Tabs.moveNative', tabsIds, {
                    windowId: this.currentWindow.id,
                    index: -1,
                });

                await this.sendMessageModule('Tabs.show', tabsIds);
            }

            this.loadGroups();
        },
        async unsyncHiddenWindowTabsCreateNewGroup() {
            await this.createNewGroup(this.unSyncWindowTabs.map(Tabs.extractId), Utils.getLastActiveTab(this.unSyncWindowTabs).title);

            this.loadUnsyncedTabs();
        },
        async unsyncHiddenTabsCreateNewGroupAll() {
            await this.createNewGroup(this.unSyncTabs.map(Tabs.extractId), Utils.getLastActiveTab(this.unSyncTabs).title);

            this.unSyncTabs = [];
        },
        unsyncHiddenTabsCloseAll() {
            this.sendMessageModule('Tabs.remove', this.unSyncTabs.map(Tabs.extractId));

            this.unSyncTabs = [];
        },
        async unsyncHiddenTabsShowTabIntoCurrentWindow(tab) {
            await this.sendMessageModule('Tabs.moveNative', [tab.id], {
                windowId: this.currentWindow.id,
                index: -1,
            });

            await this.sendMessageModule('Tabs.show', tab.id);

            if (this.currentGroup) {
                this.unSyncTabs.splice(this.unSyncTabs.indexOf(tab), 1);
            } else {
                this.loadUnsyncedTabs();
            }
        },

        openGroupInNewWindow(group, tab) {
            this.sendMessage('load-custom-group', {
                groupId: group.id,
                tabId: tab?.id,
                windowId: 'new',
            });
        },

        async removeGroup(group) {
            if (this.options.showConfirmDialogBeforeGroupDelete) {
                const ok = await this.confirm(this.lang('deleteGroup'), this.lang('confirmDeleteGroup', group.title), 'delete', 'is-danger');

                if (!ok) {
                    return;
                }
            }

            this.groups.splice(this.groups.indexOf(group), 1);

            if (this.groupToShow) {
                this.showSectionDefault();
            }

            await this.sendMessageModule('Groups.remove', group.id);

            if (!this.currentGroup) {
                this.loadUnsyncedTabs();
            }
        },
        async moveTabToNewGroup(tabId, loadUnsync, doApplyGroup) {
            await this.createNewGroup(this.getTabIdsForMove(tabId), undefined, doApplyGroup ? tabId : false);

            if (loadUnsync) {
                this.loadUnsyncedTabs();
            }
        },
        setTabIconAsGroupIcon({favIconUrl}) {
            this.sendMessageModule('Groups.setIconUrl', this.groupToShow.id, favIconUrl);
        },
        getLastActiveTabTitle(tabs) {
            const tab = Utils.getLastActiveTab(tabs);

            return tab ? Tabs.getTitle(tab, undefined, undefined, true) : '';
        },

        getLastActiveTabContainer({tabs, newTabContainer}, key) {
            const tab = Utils.getLastActiveTab(tabs);

            if (tab) {
                const tabContainer = Containers.get(tab.cookieStoreId);

                if (tabContainer.cookieStoreId !== newTabContainer) {
                    return tabContainer?.[key];
                }
            }
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

                    // if (itemType !== 'group') {
                    //     event.dataTransfer.setDragImage(event.target, event.target.clientWidth / 2, event.target.clientHeight / 2);
                    // }
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
                case 'dragend':
                    event.stopPropagation();
                    this.$emit('drag-moving', this.dragData.data.item, false);

                    this.dragData = null;
                    break;
            }
        },

        async scrollToActiveElement(event) {
            if (-1 == event.target.tabIndex || this.multipleTabIds.length) {
                return;
            }

            await Utils.wait(150);

            this.$nextTick(() => {
                if (this.groupToEdit || this.openEditDefaultGroup || this.dragData || this.multipleTabIds.length) {
                    return;
                }

                Utils.scrollTo(document.activeElement);
            });
        },

        focusToNextElement(event) {
            event.preventDefault();

            let nodes = [...document.querySelectorAll('#result .group, #result .tab')],
                focusedNodeIndex = nodes.findIndex(node => node === document.activeElement),
                activeNodeIndex = nodes.findIndex(node => node.classList.contains('is-active-element')),
                nextIndex = -1,
                textPosition = null;

            if (event.key === 'ArrowUp') {
                textPosition = 'prev';
            } else if (event.key === 'ArrowDown') {
                textPosition = 'next';
            }

            if (!textPosition) {
                throw Error('wrong key for this function');
            }

            if (-1 !== focusedNodeIndex) {
                nextIndex = Utils.getNextIndex(focusedNodeIndex, nodes.length, textPosition);
            } else if (-1 !== activeNodeIndex) {
                nextIndex = Utils.getNextIndex(activeNodeIndex, nodes.length, textPosition);
            }

            if (false === nextIndex || -1 === nextIndex) {
                nextIndex = 'next' === textPosition ? 0 : (nodes.length - 1);
            }

            if (nodes[nextIndex]) {
                nodes[nextIndex].focus();
            }
        },

        selectFirstItemOnSearch() {
            let groups = this.filteredGroups.filter(group => !group.isArchive);

            if (!groups.length) {
                return;
            }

            let [group] = groups,
                [tab] = group.filteredTabs;

            this.applyGroup(group, tab, true);
        },

        mainContextMenu(event) {
            if (['INPUT', 'TEXTAREA'].includes(event.target.nodeName)) {
                return;
            }

            event.preventDefault();

            if (event.target.tabIndex > -1) {
                event.target.classList.add('is-context-active');
            } else {
                let parent = event.target.closest('[tabindex="0"]');
                parent && parent.classList.add('is-context-active');
            }
        },

        async syncCloudClickInPopup() {
            if (this.syncCloudTriggeredByPopup) {
                return;
            }

            this.syncCloudTriggeredByPopup = true;

            const syncResult = await this.syncCloud();

            // disabled when event this.$on('sync-finish')
            if (!syncResult) {
                this.syncCloudTriggeredByPopup = false;
            }
        },
        settingsMenuAction({optionsCheckbox, sendMessage, key, closePopup}) {
            if (optionsCheckbox) {
                this.optionsSave(key, !this.options[key]);
            } else if (sendMessage) {
                this.sendMessage(...sendMessage);
            }

            if (closePopup) {
                this.closeWindow();
            }
        },
    },
}
</script>

<template>
<div
    id="stg-popup"
    :class="['no-outline', {'edit-group-popup': !!groupToEdit || openEditDefaultGroup, 'is-sidebar': isSidebar}]"
    @contextmenu="mainContextMenu"
    @click="multipleTabIds = []"
    @wheel.ctrl.prevent

    tabindex="-1"
    @focus.capture="scrollToActiveElement"
    @keydown.f3.stop.prevent="setFocusOnSearch"
    @keydown.f2.stop.prevent="tryRenameGroup"
    @keydown.right="setFocusOnActive"
    @keydown.left="searchDelay.length ? null : showSectionDefault()"

    >
    <header>
        <div :class="['field', {'has-addons': searchDelay.length}]">
            <div :class="['control has-icons-left is-expanded', {'is-loading': searchDelayTimer}]">
                <input
                    type="text"
                    class="input"
                    ref="search"
                    v-model.trim="searchDelay"
                    autocomplete="off"
                    @keydown.enter="selectFirstItemOnSearch"
                    @keydown.down="focusToNextElement"
                    @keydown.up="focusToNextElement"
                    @input="searchDelay.length ? null : showSectionDefault()"
                    :placeholder="lang('searchOrGoToActive')" />
                <span class="icon is-small is-left">
                    <figure class="image is-16x16">
                        <img class="no-fill" src="/icons/search.svg" />
                    </figure>
                </span>
            </div>
            <template v-if="searchDelay.length">
                <div v-show="!searchOnlyGroups" class="control">
                    <button class="button" @click="extendedSearch = !extendedSearch" :title="lang('extendedTabSearch')">
                        <span class="icon">
                            <figure class="image is-16x16">
                                <img v-if="extendedSearch" src="/icons/check-square.svg" />
                                <img v-else src="/icons/square.svg" />
                            </figure>
                        </span>
                    </button>
                </div>
                <div class="control">
                    <button :class="['button', {'is-active': searchOnlyGroups}]" @click="searchOnlyGroups = !searchOnlyGroups" v-text="lang('searchOnlyGroups')"></button>
                </div>
            </template>
        </div>
    </header>

    <main id="result" :class="['field is-flex-grow-1', dragData ? 'drag-' + dragData.itemType : false]">
        <!-- SEARCH TABS -->
        <div v-if="section === SECTION_SEARCH">
            <div v-if="filteredGroups.length" class="search-scrollable no-outline">
                <div v-for="group in filteredGroups" :key="group.id">
                    <div
                        :class="['group item is-unselectable', {
                            'is-active-element': group === currentGroup,
                            'is-opened': isOpenedGroup(group),
                        }]"
                        @contextmenu="$refs.contextMenuGroup.open($event, {group})"

                        @click="!group.isArchive && applyGroup(group)"
                        @keydown.enter="!group.isArchive && applyGroup(group, undefined, true)"
                        @keydown.right.stop="showSectionGroupTabs(group)"
                        @keydown.up="focusToNextElement"
                        @keydown.down="focusToNextElement"
                        @keydown.f2.stop="renameGroup(group)"
                        tabindex="0"
                        :title="getGroupTitle(group, 'withCountTabs withTabs withContainer')"
                        >
                            <div class="item-icon">
                                <figure :class="['image is-16x16', {'is-sticky': group.isSticky}]">
                                    <img :src="group.iconUrlToDisplay" />
                                </figure>
                            </div>
                            <div class="item-title clip-text icon-text">
                                <figure v-if="group.newTabContainer !== DEFAULT_COOKIE_STORE_ID" :class="`icon image is-16x16 userContext-icon identity-icon-${containers[group.newTabContainer]?.icon} identity-color-${containers[group.newTabContainer]?.color}`"></figure>
                                <figure v-if="group.isArchive" class="icon image is-16x16">
                                    <img src="/icons/archive.svg" />
                                </figure>
                                <figure
                                    v-if="showMuteIconGroup(group)"
                                    class="icon image is-16x16"
                                    @click.stop="toggleMuteGroup(group)"
                                    :title="group.tabs.some(tab => tab.audible) ? lang('muteGroup') : lang('unMuteGroup')"
                                    >
                                    <img :src="group.tabs.some(tab => tab.audible) ? '/icons/audio.svg' : '/icons/audio-mute.svg'" />
                                </figure>
                                <span v-text="getGroupTitle(group)"></span>
                                <span v-if="options.showExtendGroupsPopupWithActiveTabs && !group.isArchive" class="tab-title">
                                    <figure v-if="getLastActiveTabContainer(group, 'icon')" :title="getLastActiveTabContainer(group, 'name')" :class="`image is-16x16 userContext-icon identity-icon-${getLastActiveTabContainer(group, 'icon')} identity-color-${getLastActiveTabContainer(group, 'color')}`"></figure>
                                    <span v-text="getLastActiveTabTitle(group.tabs)"></span>
                                </span>
                            </div>
                            <div class="item-action bold-hover is-unselectable" @click.stop="showSectionGroupTabs(group)">
                                <figure class="image is-16x16">
                                    <img class="rotate-180" src="/icons/arrow-left.svg" />
                                </figure>
                                <span class="tabs-text" v-text="groupTabsCountMessage(group.tabs, group.isArchive, false)"></span>
                            </div>
                    </div>

                    <template v-if="group.isArchive">
                        <div v-for="(tab, index) in group.filteredTabs" :key="index"
                            class="tab item is-unselectable space-left"
                            :title="getTabTitle(tab, true)"
                            >
                            <div class="item-icon">
                                <figure class="image is-16x16">
                                    <img :src="tab.favIconUrl" loading="lazy" decoding="async" />
                                </figure>
                            </div>
                            <div class="item-title clip-text icon-text">
                                <figure v-if="tab.container" :title="tab.container?.name" :class="`icon image is-16x16 userContext-icon identity-icon-${tab.container?.icon} identity-color-${tab.container?.color}`"></figure>
                                <span class="discarded-color" v-text="getTabTitle(tab)"></span>
                            </div>
                        </div>
                    </template>

                    <template v-else>
                        <div v-for="(tab, index) in group.filteredTabs" :key="index"
                            @contextmenu="$refs.contextMenuTab.open($event, {tab, group})"
                            @click.stop="clickOnTab($event, tab, group)"
                            @keydown.enter="clickOnTab($event, tab, group)"
                            @keydown.delete="removeTab(tab)"
                            @keydown.up="focusToNextElement"
                            @keydown.down="focusToNextElement"
                            tabindex="0"
                            @mousedown.middle.prevent
                            @mouseup.middle.prevent="removeTab(tab)"
                            :class="['tab item is-unselectable space-left', {
                                'is-active-element': group === currentGroup && tab.active,
                                'is-multiple-tab-to-move': multipleTabIds.includes(tab.id),
                            }]"
                            :style="{
                                '--group-icon-color': group.iconColor,
                            }"
                            :title="getTabTitle(tab, true)"
                            >
                            <figure class="item-icon image is-16x16">
                                <img v-if="isTabLoading(tab)" src="/icons/tab-loading.svg" />
                                <img v-else :src="tab.favIconUrl" loading="lazy" decoding="async" />
                            </figure>
                            <div class="item-title clip-text icon-text">
                                <figure v-if="showMuteIconTab(tab)" class="icon image is-16x16" @click.stop="toggleMuteTab(tab)" :title="tab.audible ? lang('muteTab') : lang('unMuteTab')">
                                    <img :src="tab.audible ? '/icons/audio.svg' : '/icons/audio-mute.svg'" />
                                </figure>
                                <figure v-if="tab.container" :title="tab.container?.name" :class="`image is-16x16 userContext-icon identity-icon-${tab.container?.icon} identity-color-${tab.container?.color}`"></figure>
                                <span :class="{'discarded-color': tab.discarded}" v-text="getTabTitle(tab)"></span>
                            </div>
                            <div class="item-action flex-on-hover">
                                <figure class="image is-16x16 is-clickable" @click.stop="removeTab(tab)" :title="lang('deleteTab')">
                                    <img src="/icons/close.svg" />
                                </figure>
                            </div>
                        </div>
                    </template>

                </div>
            </div>
            <div v-else>
                <i class="item no-hover">
                    <span class="item-title" v-text="lang('searchNotFoundTitle', search)"></span>
                </i>
            </div>
        </div>

        <!-- GROUPS LIST -->
        <div v-if="section === SECTION_GROUPS_LIST">
            <div>
                <div
                    v-for="group in filteredGroups"
                    :key="group.id"
                    :class="['group item is-unselectable', {
                        'drag-moving': group.isMoving,
                        'drag-over': group.isOver,
                        'is-active-element': group === currentGroup,
                        'is-opened': isOpenedGroup(group),
                    }]"

                    draggable="true"
                    @dragstart="dragHandle($event, 'group', ['group'], {item: group})"
                    @dragenter="dragHandle($event, 'group', ['group'], {item: group})"
                    @dragover="dragHandle($event, 'group', ['group'], {item: group})"
                    @dragleave="dragHandle($event, 'group', ['group'], {item: group})"
                    @drop="dragHandle($event, 'group', ['group'], {item: group})"
                    @dragend="dragHandle($event, 'group', ['group'], {item: group})"

                    @contextmenu="$refs.contextMenuGroup.open($event, {group})"
                    @click="!group.isArchive && applyGroup(group)"
                    @keydown.enter="!group.isArchive && applyGroup(group, undefined, true)"
                    @keydown.right.stop="showSectionGroupTabs(group);"
                    @keydown.up="focusToNextElement"
                    @keydown.down="focusToNextElement"
                    @keydown.f2.stop="renameGroup(group)"
                    tabindex="0"
                    :title="getGroupTitle(group, 'withCountTabs withTabs withContainer')"
                    >
                        <div class="item-icon">
                            <figure :class="['image is-16x16', {'is-sticky': group.isSticky}]">
                                <img :src="group.iconUrlToDisplay" />
                            </figure>
                        </div>
                        <div class="item-title clip-text icon-text">
                            <figure v-if="group.newTabContainer !== DEFAULT_COOKIE_STORE_ID" :title="containers[group.newTabContainer]?.name" :class="`icon image is-16x16 userContext-icon identity-icon-${containers[group.newTabContainer]?.icon} identity-color-${containers[group.newTabContainer]?.color}`"></figure>
                            <figure v-if="group.isArchive" class="icon image is-16x16">
                                <img src="/icons/archive.svg" />
                            </figure>
                            <figure
                                v-if="showMuteIconGroup(group)"
                                class="icon image is-16x16"
                                @click.stop="toggleMuteGroup(group)"
                                :title="group.tabs.some(tab => tab.audible) ? lang('muteGroup') : lang('unMuteGroup')"
                                >
                                <img :src="group.tabs.some(tab => tab.audible) ? '/icons/audio.svg' : '/icons/audio-mute.svg'" />
                            </figure>
                            <span v-text="getGroupTitle(group)"></span>
                            <span v-if="options.showExtendGroupsPopupWithActiveTabs && !group.isArchive" class="tab-title">
                                <figure v-if="getLastActiveTabContainer(group, 'icon')" :title="getLastActiveTabContainer(group, 'name')" :class="`image is-16x16 userContext-icon identity-icon-${getLastActiveTabContainer(group, 'icon')} identity-color-${getLastActiveTabContainer(group, 'color')}`"></figure>
                                <span v-text="getLastActiveTabTitle(group.tabs)"></span>
                            </span>
                        </div>
                        <div class="item-action bold-hover is-unselectable" @click.stop="showSectionGroupTabs(group)">
                            <figure class="image is-16x16">
                                <img class="rotate-180" src="/icons/arrow-left.svg" />
                            </figure>
                            <span class="tabs-text" v-text="groupTabsCountMessage(group.tabs, group.isArchive, false)"></span>
                        </div>
                </div>

            </div>

            <hr>

            <div class="create-new-group">
                <div class="item" tabindex="0"
                    @click="createNewGroup()"
                    @keydown.enter="createNewGroup()">
                    <figure class="item-icon image is-16x16">
                        <img src="/icons/group-new.svg" />
                    </figure>
                    <div class="item-title" v-text="lang('createNewGroup')"></div>
                    <div class="item-action bold-hover" @click.stop="openDefaultGroup" :title="lang('defaultGroup')">
                        <figure class="image is-16x16">
                            <img src="/icons/wrench.svg" />
                        </figure>
                    </div>
                </div>
            </div>

            <div v-if="unSyncTabs.length && !showUnSyncTabs">
                <hr class="is-display-block" />
                <div class="item" tabindex="0" @click="showUnSyncTabs = true" @keydown.enter="showUnSyncTabs = true">
                    <figure class="item-icon image is-16x16">
                        <img src="/icons/arrow-down.svg" />
                    </figure>
                    <div class="item-title" v-text="lang('showOtherTabs')"></div>
                </div>
            </div>

            <div v-if="unSyncTabs.length && showUnSyncTabs" class="not-sync-tabs">
                <hr class="is-display-block" />
                <p class="mb-3">
                    <span v-text="lang('foundHiddenUnSyncTabsDescription')"></span>
                    <ul>
                        <li>
                            <a tabindex="0" @click="unsyncHiddenTabsMoveToCurrentGroup" @keydown.enter="unsyncHiddenTabsMoveToCurrentGroup" v-text="lang('actionHiddenUnSyncTabsMoveAllTabsToCurrentGroup')"></a>
                        </li>
                        <li v-if="unSyncWindowTabs.length && countWindowsUnSyncTabs > 1">
                            <a tabindex="0" @click="unsyncHiddenWindowTabsCreateNewGroup" @keydown.enter="unsyncHiddenWindowTabsCreateNewGroup" v-text="lang('actionHiddenUnSyncWindowTabsCreateGroup')"></a>
                        </li>
                        <li>
                            <a tabindex="0" @click="unsyncHiddenTabsCreateNewGroupAll" @keydown.enter="unsyncHiddenTabsCreateNewGroupAll" v-text="lang('actionHiddenUnSyncTabsCreateGroup')"></a>
                        </li>
                        <li>
                            <a tabindex="0" @click="unsyncHiddenTabsCloseAll" @keydown.enter="unsyncHiddenTabsCloseAll" v-text="lang('actionHiddenUnSyncTabsCloseAll')"></a>
                        </li>
                    </ul>
                </p>
                <div>
                    <div v-for="tab in unSyncTabs" :key="tab.id"
                        @contextmenu="$refs.contextMenuTab.open($event, {tab})"
                        @click.stop="($event.ctrlKey || $event.metaKey || $event.shiftKey) ? clickOnTab($event, tab) : unsyncHiddenTabsShowTabIntoCurrentWindow(tab)"
                        @keydown.enter="($event.ctrlKey || $event.metaKey || $event.shiftKey) ? clickOnTab($event, tab) : unsyncHiddenTabsShowTabIntoCurrentWindow(tab)"
                        @keydown.delete="removeTab(tab)"
                        @mousedown.middle.prevent
                        @mouseup.middle.prevent="removeTab(tab)"
                        :class="['tab item is-unselectable', {
                            'is-multiple-tab-to-move': multipleTabIds.includes(tab.id),
                        }]"
                        :title="getTabTitle(tab, true)"
                        tabindex="0"
                        >
                        <figure class="item-icon image is-16x16">
                            <img v-if="isTabLoading(tab)" src="/icons/tab-loading.svg" />
                            <img v-else :src="tab.favIconUrl" loading="lazy" decoding="async" />
                        </figure>
                        <div class="item-title clip-text icon-text">
                            <figure v-if="showMuteIconTab(tab)" class="icon image is-16x16" @click.stop="toggleMuteTab(tab)" :title="tab.audible ? lang('muteTab') : lang('unMuteTab')">
                                <img :src="tab.audible ? '/icons/audio.svg' : '/icons/audio-mute.svg'" />
                            </figure>
                            <figure v-if="tab.container" :title="tab.container?.name" :class="`icon image is-16x16 userContext-icon identity-icon-${tab.container?.icon} identity-color-${tab.container?.color}`"></figure>
                            <span :class="{'discarded-color': tab.discarded}" v-text="getTabTitle(tab)"></span>
                        </div>
                        <div class="item-action flex-on-hover">
                            <figure class="image is-16x16 is-clickable" @click.stop="removeTab(tab)" :title="lang('deleteTab')">
                                <img src="/icons/close.svg" />
                            </figure>
                        </div>
                    </div>

                </div>
            </div>
        </div>

        <!-- GROUP -->
        <div v-if="section === SECTION_GROUP_TABS" class="tabs-list"
            :style="{
                '--group-icon-color': groupToShow.iconColor,
            }"
            >
            <div class="item is-unselectable" tabindex="0" @click="showSectionDefault" @keydown.enter="showSectionDefault">
                <figure class="item-icon image is-16x16">
                    <img src="/icons/arrow-left.svg" />
                </figure>
                <span class="item-title" v-text="lang('goBackToGroupsButtonTitle')"></span>
            </div>

            <hr>

            <div class="group-info item no-hover field">
                <figure class="item-icon image is-16x16">
                    <img :src="groupToShow.iconUrlToDisplay" />
                </figure>
                <div class="item-title icon-text is-justify-content-center clip-text">
                    <figure v-if="groupToShow.newTabContainer !== DEFAULT_COOKIE_STORE_ID" :title="containers[groupToShow.newTabContainer]?.name" :class="`icon image is-16x16 userContext-icon identity-icon-${containers[groupToShow.newTabContainer]?.icon} identity-color-${containers[groupToShow.newTabContainer]?.color}`"></figure>
                    <figure v-if="groupToShow.isArchive" class="icon image is-16x16">
                        <img src="/icons/archive.svg" />
                    </figure>
                    <span class="group-title" v-text="getGroupTitle(groupToShow)"></span>
                </div>
                <div class="item-action is-unselectable">
                    <figure tabindex="0" @click="openGroupSettings(groupToShow)" @keydown.enter="openGroupSettings(groupToShow)" class="image is-16x16 is-clickable" :title="lang('groupSettings')">
                        <img src="/icons/settings.svg" />
                    </figure>
                    <figure tabindex="0" @click="removeGroup(groupToShow)" @keydown.enter="removeGroup(groupToShow)" class="image is-16x16 is-clickable" :title="lang('deleteGroup')">
                        <img src="/icons/group-delete.svg" />
                    </figure>
                </div>
            </div>

            <div v-if="groupToShow.isArchive" class="archive-tabs-scrollable no-outline">
                <div
                    v-for="(tab, tabIndex) in groupToShow.tabs"
                    :key="tabIndex"
                    class="tab item is-unselectable"
                    :title="getTabTitle(tab, true)"
                    @mousedown.middle.prevent
                    >
                    <figure class="item-icon image is-16x16">
                        <img :src="tab.favIconUrl" loading="lazy" decoding="async" />
                    </figure>
                    <div class="item-title clip-text icon-text">
                        <figure v-if="tab.container" :title="tab.container?.name" :class="`icon image is-16x16 userContext-icon identity-icon-${tab.container?.icon} identity-color-${tab.container?.color}`"></figure>
                        <span class="discarded-color" v-text="getTabTitle(tab)"></span>
                    </div>
                </div>
            </div>

            <template v-else>
                <div class="tabs-scrollable no-outline">
                    <div
                        v-for="(tab, tabIndex) in groupToShow.tabs"
                        :key="tabIndex"
                        :data-tab-id="tab.id"
                        @contextmenu="$refs.contextMenuTab.open($event, {tab, group: groupToShow})"
                        @click.stop="clickOnTab($event, tab, groupToShow)"
                        @keydown.enter="clickOnTab($event, tab, groupToShow)"
                        @keydown.left="showSectionDefault"
                        @keydown.up="focusToNextElement"
                        @keydown.down="focusToNextElement"
                        @keydown.delete="removeTab(tab)"
                        tabindex="0"
                        @mousedown.middle.prevent
                        @mouseup.middle.prevent="removeTab(tab)"
                        :class="['tab item is-unselectable', {
                            'is-active-element': groupToShow === currentGroup && tab.active,
                            'drag-moving': tab.isMoving,
                            'drag-over': tab.isOver,
                            'is-multiple-tab-to-move': multipleTabIds.includes(tab.id),
                        },
                            tab.container && `identity-color-${tab.container?.color}`,
                        ]"
                        :title="getTabTitle(tab, true)"

                        draggable="true"
                        @dragstart="dragHandle($event, 'tab', ['tab'], {item: tab, group: groupToShow})"
                        @dragenter="dragHandle($event, 'tab', ['tab'], {item: tab, group: groupToShow})"
                        @dragover="dragHandle($event, 'tab', ['tab'], {item: tab, group: groupToShow})"
                        @dragleave="dragHandle($event, 'tab', ['tab'], {item: tab, group: groupToShow})"
                        @drop="dragHandle($event, 'tab', ['tab'], {item: tab, group: groupToShow})"
                        @dragend="dragHandle($event, 'tab', ['tab'], {item: tab, group: groupToShow})"
                        >
                        <figure class="item-icon image is-16x16">
                            <img v-if="isTabLoading(tab)" src="/icons/tab-loading.svg" />
                            <img v-else :src="tab.favIconUrl" loading="lazy" decoding="async" />
                        </figure>
                        <div class="item-title clip-text icon-text">
                            <figure
                                v-if="showMuteIconTab(tab)"
                                @click.stop="toggleMuteTab(tab)"
                                :title="tab.audible ? lang('muteTab') : lang('unMuteTab')"
                                class="icon image is-16x16"
                                >
                                <img :src="tab.audible ? '/icons/audio.svg' : '/icons/audio-mute.svg'" />
                            </figure>
                            <figure v-if="tab.container" :title="tab.container?.name" :class="`icon image is-16x16 userContext-icon identity-icon-${tab.container?.icon} identity-color-${tab.container?.color}`"></figure>
                            <span :class="{'discarded-color': tab.discarded}" v-text="getTabTitle(tab)"></span>
                        </div>
                        <div class="item-action flex-on-hover">
                            <figure class="image is-16x16 is-clickable" @click.stop="removeTab(tab)" :title="lang('deleteTab')">
                                <img src="/icons/close.svg" />
                            </figure>
                        </div>
                    </div>
                </div>

                <hr>

                <div class="create-new-tab">
                    <div class="item" tabindex="0" @contextmenu="$refs.contextMenuTabNew.open($event, {group: groupToShow})" @click="addTab(groupToShow)" @keydown.enter="addTab(groupToShow)">
                        <figure class="item-icon image is-16x16">
                            <img src="/icons/tab-new.svg" />
                        </figure>
                        <div class="item-title">
                            <span class="icon-text">
                                <figure v-if="containers[groupToShow.newTabContainer]?.icon" :title="containers[groupToShow.newTabContainer].name" :class="`icon image is-16x16 userContext-icon identity-icon-${containers[groupToShow.newTabContainer].icon} identity-color-${containers[groupToShow.newTabContainer].color}`"></figure>
                                <span v-text="lang('createNewTab')"></span>
                            </span>
                        </div>
                        <div class="item-action bold-hover" @click.stop="$refs.contextMenuTabNew.open($event, {group: groupToShow})">
                            <figure class="image is-16x16">
                                <img src="/icons/ellipsis-v.svg" />
                            </figure>
                        </div>
                    </div>
                </div>
            </template>
        </div>
    </main>

    <footer class="is-unselectable">
        <div tabindex="0" class="is-flex-grow-1 manage-groups" @click="openManageGroups" @keydown.enter="openManageGroups" :title="lang('manageGroupsTitle')">
            <figure class="image is-16x16">
                <img src="/icons/icon.svg" />
            </figure>
            <span v-text="lang('manageGroupsTitle')"></span>
        </div>
        <div
            v-if="options.syncEnable"
            tabindex="0"
            class="sync"
            @click="syncCloudClickInPopup"
            @keydown.enter="syncCloudClickInPopup"
            :title="syncTitle"
            >
            <div class="circle-progress" :class="{
                    'is-success': !syncCloudErrorMessage && syncCloudProgress === 100,
                    'is-danger': !!syncCloudErrorMessage,
                }" :style="{
                    '--progress-percent': `${syncCloudProgress}%`,
                }"
                >
                <figure class="image is-16x16">
                    <img src="/icons/cloud-arrow-up-solid.svg" />
                    <img v-if="syncCloudHasError" id="sync-error-icon" src="/icons/exclamation-triangle-yellow.svg">
                </figure>
            </div>
        </div>
        <div
            tabindex="0"
            class="settings"
            @click="openOptionsPage()"
            @keydown.enter="openOptionsPage()"
            :title="lang('openSettings')"
            >
            <figure class="image is-16x16">
                <img src="/icons/settings.svg" />
            </figure>
        </div>
        <div
            class="settings-menu"
            @click="$refs.settingsMenu.open($event)"
            @contextmenu="$refs.settingsMenu.open($event)"
            :title="lang('settingsMenu')"
            >
            <figure class="image is-16x16">
                <img src="/icons/ellipsis-v.svg" />
            </figure>
        </div>
    </footer>

    <context-menu ref="settingsMenu">
        <ul class="is-unselectable">
            <template v-for="(item, i) in POPUP_SETTINGS_MENU_ITEMS">
                <hr v-if="item.key === 'hr'" :key="i" />
                <li v-else :key="item.key" @click="settingsMenuAction(item)">
                    <figure v-if="item.optionsCheckbox" class="image is-16x16">
                        <img v-if="options[item.key]" src="/icons/check-square.svg" />
                        <img v-else src="/icons/square.svg" />
                    </figure>
                    <figure v-else class="image is-16x16">
                        <img :src="`/icons/${item.icon}.svg`" />
                    </figure>
                    <span v-text="lang(item.title || item.key)"></span>
                </li>
            </template>
        </ul>
    </context-menu>

    <context-menu-tab-new ref="contextMenuTabNew" @add="addTab"></context-menu-tab-new>

    <context-menu-group ref="contextMenuGroup"
        :menu="options.contextMenuGroup"
        :groups="groups"
        :opened-windows="openedWindows"
        @open-in-new-window="openGroupInNewWindow"
        @sort="sortGroups"
        @discard="discardGroup"
        @discard-other="discardOtherGroups"
        @export-to-bookmarks="exportGroupToBookmarks"
        @unload="unloadGroup"
        @archive="toggleArchiveGroup"
        @unarchive="toggleArchiveGroup"
        @rename="renameGroup"
        @reload-all-tabs="reloadAllTabsInGroup"
        @settings="openGroupSettings"
        @remove="removeGroup"
        ></context-menu-group>

    <context-menu-tab ref="contextMenuTab"
        :menu="options.contextMenuTab"
        :groups="groups"
        :multiple-tab-ids="multipleTabIds"
        @open-in-new-window="openGroupInNewWindow"
        @reload="reloadTab"
        @discard="discardTab"
        @remove="removeTab"
        @set-group-icon="setTabIconAsGroupIcon"
        @move-tab="moveTabs"
        @move-tab-new-group="moveTabToNewGroup"
        ></context-menu-tab>

    <edit-group-popup
        v-if="groupToEdit"
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
            :can-load-file="isSidebar"
            @changes="changes => saveEditedGroup(groupToEdit.id, changes)"
            @open-manage-groups="openManageGroups"></edit-group>
    </edit-group-popup>

    <edit-group-popup
        v-if="openEditDefaultGroup"
        title="defaultGroup"
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
        @close-popup="openEditDefaultGroup = false"
        @save-group="() => $refs.editDefaultGroup.triggerChanges()"
        >
        <edit-group
            ref="editDefaultGroup"
            :group-to-edit="defaultGroup"
            :is-default-group="true"
            :group-to-compare="defaultCleanGroup"
            :can-load-file="isSidebar"
            @changes="saveDefaultGroup"
            @open-manage-groups="openManageGroups"></edit-group>
    </edit-group-popup>

    <popup-helpers
        v-if="promptOptions || confirmOptions"
        :prompt="promptOptions"
        :confirm="confirmOptions"
        ></popup-helpers>

    <div
        v-if="enableDebug"
        id="debug-message"
        class="tag is-warning is-medium is-clickable"
        @click="openDebugPage"
        v-text="lang('loggingIsEnabledTitle')"
        ></div>
</div>
</template>

<style>

:root {
    --popup-width: 450px;
    --max-popup-width: 100%;

    --max-popup-height: 600px;
    --min-popup-height: 125px;

    --item-background-color-active: var(--bulma-scheme-main-bis);
    --item-background-color-hover: var(--bulma-scheme-main-ter);
    --item-background-color-active-hover: var(--bulma-scheme-main-quater);

    --footer-background-color: var(--bulma-scheme-main-bis);
    --footer-background-hover-color: var(--bulma-scheme-main-ter);
}

#loading {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    height: 100vh;
    width: 100vw;
    background-color: hsla(var(--bulma-scheme-h), var(--bulma-scheme-s), var(--bulma-scheme-invert-l), 0.46);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1;

    > img {
        width: 3em;
    }
}

html {
    scrollbar-width: thin;
    width: var(--popup-width);
    min-height: var(--min-popup-height);
    max-width: var(--max-popup-width);
    min-width: 200px;
    overflow-x: hidden;

    &.full-popup-width {
        --popup-width: 800px;

        .group.item .item-action {
            width: 100px;
            min-width: 100px;
        }
    }
}

#stg-popup {
    --item-height: 2.3em;
    --footer-height: calc(var(--bulma-block-spacing) * 2 + var(--item-height));

    width: var(--popup-width);
    min-height: var(--min-popup-height);
    max-height: var(--max-popup-height);
    max-width: var(--max-popup-width);

    overflow-y: auto;
    scrollbar-width: thin;

    > header {
        padding: var(--bulma-block-spacing);
    }

    &.is-sidebar {
        --max-popup-height: 100vh;
        --min-popup-height: 100vh;
        display: flex;
        flex-direction: column;

        > main {
            flex-grow: 1;
        }

        > footer > * {
            height: var(--footer-height);
        }
    }

    &.edit-group-popup {
        min-height: var(--max-popup-height);
    }

    > footer {
        display: flex;
        align-items: stretch;
        position: sticky;
        bottom: 0;
        height: var(--footer-height);
        --current-background-color: var(--footer-background-color);
        background-color: var(--current-background-color);

        > * {
            display: flex;
            align-items: center;
            padding: var(--bulma-block-spacing);
            gap: var(--gap-indent);
            position: relative;

            &:not(.manage-groups) {
                width: var(--footer-height);
                justify-content: center;
            }

            &.settings-menu {
                width: auto;
            }

            &:not(:first-child)::before {
                content: "";
                background-color: var(--bulma-hr-background-color);
                width: var(--bulma-hr-height);
                height: calc(100% - var(--gap-indent) * 1.5);
                position: absolute;
                left: calc(var(--bulma-hr-height) / 2 * -1);
            }

            &:hover {
                --current-background-color: var(--footer-background-hover-color);
                background-color: var(--current-background-color);
            }
        }

        .circle-progress {
            #sync-error-icon {
                position: absolute;
                right: 0;
                bottom: 0;
                width: 10px;
                height: 10px;
            }
        }
    }

    /* Drag & Drop Styles */
    .drag-group .item > *,
    .drag-tab .item > * {
        pointer-events: none;
    }

    .drag-over {
        outline-offset: -3px;
    }

    .drag-moving,
    .drag-tab .is-multiple-tab-to-move {
        opacity: 0.4;
    }

    .item {
        display: flex;
        flex-direction: row;
        flex-wrap: nowrap;
        align-items: center;
        cursor: default;
        height: var(--item-height);
        min-height: var(--item-height);
        padding-inline-start: var(--bulma-block-spacing);
        gap: var(--gap-indent);

        &.space-left {
            padding-inline-start: calc(var(--bulma-block-spacing) * 2);
        }

        &.is-active-element:before,
        &.is-opened:before,
        &.is-multiple-tab-to-move:before {
            content: '';
            position: absolute;
            background-color: var(--group-icon-color, var(--bulma-info-50));
            left: 0;
            top: 0;
            bottom: 0;
            width: 4px;
        }

        &.is-active-element.is-multiple-tab-to-move:before {
            width: 6px;
        }

        &:not(.no-hover):hover,
        &:focus,
        &.is-context-active {
            background-color: var(--item-background-color-hover);
        }

        .item-action.bold-hover:hover {
            background-color: var(--item-background-color-active-hover);
        }

        &:not(.no-hover):active,
        &.is-active-element {
            background-color: var(--item-background-color-active-hover);
        }

        /* .item-icon {

        } */

        .item-title {
            flex-grow: 1;
            white-space: nowrap;
            overflow: hidden;
            cursor: default;
            display: flex;
            align-items: center;
            flex-wrap: nowrap;
            gap: var(--gap-indent);

            .tab-title {
                display: flex;
                align-items: center;
                color: var(--discarded-text-color);
                gap: var(--gap-indent);
            }
        }

        .item-action {
            display: flex;
            align-items: center;
            align-self: stretch;
            padding-inline: var(--bulma-block-spacing);
            white-space: nowrap;
            gap: var(--gap-indent);
        }

        .flex-on-hover {
            display: flex;
            visibility: hidden;
        }

        &:hover .flex-on-hover {
            visibility: visible;
        }
    }

    .search-scrollable,
    .archive-tabs-scrollable,
    .tabs-scrollable {
        max-height: calc(var(--max-popup-height) - var(--footer-height) - var(--minus-height-delta));
        scrollbar-width: thin;
        overflow-y: auto;
    }

    .search-scrollable {
        --minus-height-delta: 60px; /* minus search bar */
    }
    .archive-tabs-scrollable {
        --minus-height-delta: 150px; /* minus create new tab */
    }
    .tabs-scrollable {
        --minus-height-delta: 210px; /* minus all */
    }
}

/* END HELPERS */
.group-title {
    max-width: 100%;
}

.group,
.tab {
    position: relative;
}

.tab:not(.drag-over),
.group:not(.drag-over) {
    outline: none;
}

.group .tabs-text {
    flex-grow: 1;
}

.group.item .item-action {
    width: 75px;
    min-width: 75px;
    overflow: hidden;
    text-align: center;
}

.not-sync-tabs > p {
    padding: 0 var(--bulma-block-spacing);
}

#debug-message {
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
}

</style>
