
import Vue from '/js/vue.runtime.esm.js';

import '/js/prefixed-storage.js';
import * as Constants from '/js/constants.js';
import * as Containers from '/js/containers.js';
import * as Extensions from '/js/extensions.js';
import * as Tabs from '/js/tabs.js';
import * as Groups from '/js/groups.js';
import * as Windows from '/js/windows.js';
import * as Cloud from '/js/sync/cloud/cloud.js';
import {onDebugChanged} from '/js/logger.js';

const mainStorage = localStorage.create(Constants.MODULES.BACKGROUND);

export default {
    data() {
        this.PAGES = Constants.PAGES;

        return {
            enableDebug: mainStorage.enableDebug,
            isLoading: true,

            DEFAULT_COOKIE_STORE_ID: Constants.DEFAULT_COOKIE_STORE_ID,

            defaultAvailableTabKeys: ['id', 'url', 'title', 'favIconUrl', 'status', 'index', 'discarded', 'active', 'cookieStoreId', 'windowId', 'subGroupId'],

            currentWindow: null,
            openedWindows: [],

            containers: {},

            search: '',
            searchDelay: '',
            searchDelayTimer: 0,
            extendedSearch: false,

            groupToEdit: null,
            groups: [],

            multipleTabIds: [],
            unSyncTabs: [],

            dragData: null,
        };
    },
    watch: {
        searchDelay(search) {
            if (search.length && this.allTabsArray.length > 200) {
                window.clearTimeout(this.searchDelayTimer);
                this.searchDelayTimer = window.setTimeout(() => {
                    this.search = search;
                    this.searchDelayTimer = 0;
                }, 500);
            } else {
                this.search = search;
            }
        },
    },
    computed: {
        includeTabThumbnails() {
            return this.PAGES.isManage;
        },
        availableTabKeys() {
            return [...this.defaultAvailableTabKeys, ...this.extraAvailableTabKeys ?? []];
        },
        currentGroup() {
            return this.groups.find(group => group.id === this.currentWindow?.groupId);
        },
        // built whole and never changed in place: Vue 2 does not track a Map, a change is a new Map
        windowIdByGroupId() {
            return new Map(this.openedWindows.filter(win => win.groupId).map(win => [win.groupId, win.id]));
        },
        allTabs() {
            const allTabs = {};

            for (const group of this.groups) {
                if (!group.isArchive) {
                    for (const tab of group.tabs) {
                        allTabs[tab.id] = tab;
                    }
                }
            }

            return allTabs;
        },
        allTabsArray() {
            return Object.values(this.allTabs);
        },
        unSyncTabIds() {
            return this.unSyncTabs.map(Tabs.extractId);
        },
    },
    created() {
        this.startUpDataPromise = this.sendMessage('get-startup-data', {isManage: Constants.PAGES.isManage});
        this.containers = this.getContainers();

        this.$root.$on('lock-addon', () => {
            this.tabGroupsHandleLockAddon();
        });
    },
    beforeDestroy() {
        this.tabGroupsRemoveListeners();
    },
    mounted() { // called before mounted in .vue files
        this.tabGroupsPromise = this.tabGroupsLoad(this.startUpDataPromise);
    },
    methods: {
        async loadWindowsAndGroups(startUpData = {}) {
            await this.loadWindows(startUpData);
            await this.loadGroups(startUpData);
        },

        async tabGroupsLoad(startUpDataPromise = this.sendMessage('get-startup-data', {isManage: Constants.PAGES.isManage})) {
            const startUpData = await startUpDataPromise;

            await this.loadWindowsAndGroups(startUpData);
            await this.loadUnsyncedTabs(startUpData);
        },

        isTabLoading: Tabs.isLoading,
        getTabTitle: Tabs.getTitle,
        getGroupTitle: Groups.getTitle,
        groupTabsCountMessage: Groups.tabsCountMessage,

        tabGroupsSetupListeners() {
            const list = this.tabGroupsOffListeners = new Set();

            list.add(Containers.onChanged(() => this.onChangedContainers()));

            list.add(onDebugChanged(mode => this.enableDebug = mode));

            list.add(Windows.on(['opened', 'closed'], () => this.loadWindows()));

            list.add(Tabs.on('updated', ({tabId, changeInfo}) => {
                const tab = this.allTabs[tabId] ?? this.unSyncTabs.find(tab => tab.id === tabId);
                tab && Tabs.normalizeFavIcon(Object.assign(tab, changeInfo));
            }));
            list.add(Tabs.on('updated.group', ({groupId}) => {
                this.loadGroupTabs(groupId);
            }));
            list.add(Tabs.on('updated.unsync', ({windowId}) => {
                this.loadUnsyncedTabs({windowId});
            }));
            list.add(Tabs.on('removed', ({tabId, groupId}) => {
                const group = this.groups.find(group => group.id === groupId);
                const tabIndex = group.tabs.findIndex(tab => tab.id === tabId);

                if (tabIndex !== -1) {
                    group.tabs.splice(tabIndex, 1);
                }
            }));
            list.add(Tabs.on('removed.unsync', ({tabId}) => {
                const tabIndex = this.unSyncTabs.findIndex(tab => tab.id === tabId);

                if (tabIndex !== -1) {
                    this.unSyncTabs.splice(tabIndex, 1);
                }
            }));

            list.add(Groups.on('added', request => {
                if (!this.groups.some(group => group.id === request.group.id)) {
                    this.groups.push(this.mapGroup(request.group));
                }
                this.onGroupAdded?.(request);
            }));
            list.add(Groups.on('updated', request => {
                const group = this.groups.find(group => group.id === request.group.id);
                Object.assign(group, request.group);
                this.onGroupUpdated?.(request);
            }));
            list.add(Groups.on('removed', request => {
                this.groups = this.groups.filter(group => group.id !== request.groupId);
                this.onGroupRemoved?.(request);
            }));
            list.add(Groups.on('loaded', async request => {
                await this.loadWindowsAndGroups();
                await this.onGroupLoadedReady?.(request);
            }));
            list.add(Groups.on('unloaded', async request => {
                await this.tabGroupsLoad();
                this.onGroupUnloaded?.(request);
            }));
            list.add(Groups.on('updated.all', async request => {
                await this.tabGroupsLoad();
                this.onGroupsUpdatedAll?.(request);
            }));

            list.add(Cloud.on('sync-end', async request => {
                if (request.changes.local) {
                    await this.tabGroupsLoad();
                    this.onGroupsSyncEnd?.(request);
                }
            }));
        },

        tabGroupsRemoveListeners() {
            this.tabGroupsOffListeners.forEach(off => off());
            this.tabGroupsOffListeners.clear();
        },

        tabGroupsHandleLockAddon() {
            this.isLoading = true;
            this.tabGroupsRemoveListeners();
        },
        onChangedContainers() {
            this.containers = this.getContainers();
            this.allTabsArray.forEach(this.mapTabContainer, this);
        },
        getContainers() {
            return Containers.query({
                defaultContainer: true,
                temporaryContainer: true,
            });
        },

        async setFocusOnSearch() {
            await this.$nextTick();
            this.$refs.search.focus();
        },

        async loadWindows({windows} = {}) {
            const {id} = await browser.windows.getCurrent();

            this.currentWindow = await this.sendMessageModule('Windows.get', id);
            this.openedWindows = windows ?? await this.sendMessageModule('Windows.load');
        },
        async loadGroups({groups} = {}) {
            groups ??= await this.sendMessageModule('Groups.load', null, true, {includeFavIconUrl: true, includeThumbnail: this.includeTabThumbnails})
                .then(({groups}) => groups);

            this.groups = groups.map(this.mapGroup, this);

            this.multipleTabIds = [];
        },
        async loadUnsyncedTabs({windows = null, windowId = null} = {}) {
            if (!windowId || this.currentWindow?.id === windowId) {
                windows ??= await this.sendMessageModule('Windows.load', true, {includeFavIconUrl: true, includeThumbnail: this.includeTabThumbnails});

                const win = windows.find(w => windowId ? w.id === windowId : w.id === this.currentWindow.id);

                if (!win) {
                    return;
                }

                this.unSyncTabs = win.tabs
                    .filter(tab => !tab.groupId)
                    .map(tab => this.mapTab(tab));
            }
        },

        mapGroup(group) {
            group.tabs = group.tabs.map(tab => this.mapTab(tab, group.isArchive));

            group.draggable = true; // isManage
            group.isMoving = false;
            group.isOver = false;

            const vm = this;

            return new Vue({
                data: group,
                watch: {
                    title(title) {
                        vm.sendMessageModule('Groups.update', this.id, {title});
                    },
                },
                computed: {
                    iconUrlToDisplay() {
                        return Groups.getIconUrl({
                            title: this.title,
                            iconUrl: this.iconUrl,
                            iconColor: this.iconColor,
                            iconViewType: this.iconViewType,
                        });
                    },
                    subGroupByTab() {
                        const map = new Map;
                        const subGroupById = new Map(this.subGroups.map(subGroup => [subGroup.id, subGroup]));

                        for (const tab of this.tabs) {
                            const subGroup = subGroupById.get(tab.subGroupId);
                            subGroup && map.set(tab, subGroup);
                        }

                        return map;
                    },
                },
            });
        },
        mapTab(tab, isArchive = false) {
            isArchive = isArchive === true;

            for (const key in tab) {
                if (!this.availableTabKeys.includes(key)) {
                    delete tab[key];
                }
            }

            tab = Tabs.normalizeFavIcon(tab);

            tab = this.mapTabContainer(tab);

            if (this.PAGES.isManage) {
                tab.thumbnail ??= null;
            }

            if (!isArchive && tab.url === Extensions.urlToId(window.location.href)) {
                tab.status = browser.tabs.TabStatus.COMPLETE;
            }

            tab.isMoving = false;
            tab.isOver = false;

            if (isArchive) {
                return Object.freeze(tab);
            }

            return Vue.observable(tab);

            // return/*  this.allTabs[tab.id] = */ new Vue({
            //     data: tab,
            // });
        },
        mapTabContainer(tab) {
            if (Containers.isDefault(tab.cookieStoreId)) {
                tab.container = null;
            } else {
                tab.container = Containers.get(tab.cookieStoreId);
            }

            return tab;
        },

        // set --sub-group-color only when the tab belongs to a sub-group;
        // when absent, `border: … var(--sub-group-color)` collapses (invalid var, no fallback) instead of drawing a transparent line
        subGroupColorStyle(tab, group) {
            const subGroup = group.subGroupByTab.get(tab);

            if (!subGroup) {
                return null;
            }

            const [lightL, darkL] = subGroup.collapsed
                ? [0.97, 0.48]
                : [0.48, 0.83];

            return {
                '--sub-group-color': `light-dark(oklch(from ${subGroup.color} ${lightL} c h), oklch(from ${subGroup.color} ${darkL} c h))`,
            };
        },

        // tabs and groups actions
        getTabIdsForMove(tabId) {
            if (tabId && !this.multipleTabIds.includes(tabId)) {
                this.multipleTabIds.push(tabId);
            }

            const tabs = [...this.multipleTabIds];

            this.multipleTabIds = [];

            return tabs;
        },

        addTab(group, cookieStoreId) {
            this.sendMessageModule('Tabs.add', group.id, cookieStoreId);
        },
        removeTab(tab) {
            this.sendMessageModule('Tabs.remove', this.getTabIdsForMove(tab.id));
        },

        reloadTab(tab, bypassCache) {
            this.sendMessageModule('Tabs.reload', this.getTabIdsForMove(tab.id), bypassCache);
        },
        reloadAllTabsInGroup(group, bypassCache) {
            this.sendMessageModule('Tabs.reload', group.tabs.map(Tabs.extractId), bypassCache);
        },

        discardTab(tab) {
            this.sendMessageModule('Tabs.discard', this.getTabIdsForMove(tab.id));
        },
        discardGroup(group) {
            this.sendMessageModule('Tabs.discard', group.tabs.map(Tabs.extractId));
        },
        discardOtherGroups(groupExclude) {
            const groupsToDiscard = this.groups.filter(group => {
                if (groupExclude.id === group.id) {
                    return false;
                } else if (group.isArchive) {
                    return false;
                } else if (this.isOpenedGroup(group)) {
                    return false;
                }

                return true;
            });

            const tabsToDiscard = groupsToDiscard.flatMap(group => group.tabs);

            this.sendMessageModule('Tabs.discard', tabsToDiscard.map(Tabs.extractId));
        },
        async moveTabs(tabId, groupId, loadUnsync = false, showTab, discardTabs) {
            const tabIds = this.getTabIdsForMove(tabId);

            await this.sendMessageModule('Tabs.move', tabIds, groupId, {showTab});

            if (discardTabs) {
                this.sendMessageModule('Tabs.discard', tabIds);
            }

            if (loadUnsync) {
                this.loadUnsyncedTabs();
            }
        },

        async loadGroupTabs(groupId) {
            const {group: {tabs}} = await this.sendMessageModule('Groups.load', groupId, true, {includeFavIconUrl: true, includeThumbnail: this.includeTabThumbnails});
            const group = this.groups.find(gr => gr.id === groupId);

            group.tabs = tabs.map(tab => this.mapTab(tab, group.isArchive));
        },

        openGroupSettings(group) {
            this.groupToEdit = group;
        },
        saveEditedGroup(groupId, changes) {
            this.groupToEdit = null;

            if (Object.keys(changes).length) {
                this.sendMessageModule('Groups.update', groupId, changes);
            }
        },


        async unloadGroup(group) {
            this.isLoading = true;
            await this.sendMessageModule('Groups.unload', group.id);
            this.isLoading = false;
        },
        sortGroups(vector) {
            this.sendMessageModule('Groups.sort', vector);
        },
        isOpenedGroup(group) {
            return this.windowIdByGroupId.has(group.id);
        },
        async toggleArchiveGroup({id, title, isArchive}) {
            let ok = true;

            if (!isArchive && this.options.showConfirmDialogBeforeGroupArchiving) {
                ok = await this.confirm(this.lang('archiveGroup'), this.lang('confirmArchiveGroup', title));
            }

            if (ok) {
                this.isLoading = true;
                await this.sendMessageModule('Groups.archiveToggle', id);
                this.isLoading = false;
            }
        },

        exportGroupToBookmarks(group) {
            this.sendMessage('export-group-to-bookmarks', {
                groupId: group.id,
            });
        },
    },
}
