
import Vue from '/js/vue.runtime.esm.js';

import '/js/prefixed-storage.js';
import * as Constants from '/js/constants.js';
import * as Containers from '/js/containers.js';
import * as Tabs from '/js/tabs.js';
import * as Groups from '/js/groups.js';
import * as Utils from '/js/utils.js';
import * as Windows from '/js/windows.js';
import * as Cloud from '/js/sync/cloud/cloud.js';

const mainStorage = localStorage.create(Constants.MODULES.BACKGROUND);

export default {
    data() {
        this.PAGES = Constants.PAGES;

        return {
            enableDebug: mainStorage.enableDebug,
            isLoading: true,

            DEFAULT_COOKIE_STORE_ID: Constants.DEFAULT_COOKIE_STORE_ID,

            defaultAvailableTabKeys: ['id', 'url', 'title', 'favIconUrl', 'status', 'index', 'discarded', 'active', 'cookieStoreId', 'windowId', 'groupNativeId'],

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
            return this.PAGES.isManage && this.options.showTabsWithThumbnailsInManageGroups;
        },
        availableTabKeys() {
            return [...this.defaultAvailableTabKeys, ...this.extraAvailableTabKeys ?? []];
        },
        currentGroup() {
            return this.groups.find(group => group.id === this.currentWindow?.groupId);
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

            list.add(Windows.on(['opened', 'closed'], () => this.loadWindows()));

            list.add(Tabs.on('updated', ({tabId, changeInfo}) => {
                const tab = this.allTabs[tabId] ?? this.unSyncTabs.find(tab => tab.id === tabId);
                tab && Object.assign(tab, changeInfo);
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
            this.currentWindow = await Windows.get();
            this.openedWindows = windows ?? await this.sendMessageModule('Windows.load');
        },
        async loadGroups({groups} = {}) {
            groups ??= await this.sendMessageModule('Groups.load', null, true, true, this.includeTabThumbnails)
                .then(({groups}) => groups);

            this.groups = groups.map(this.mapGroup, this);

            this.multipleTabIds = [];
        },
        async loadUnsyncedTabs({windows = null, windowId = null} = {}) {
            if (!windowId || this.currentWindow?.id === windowId) {
                windows ??= await this.sendMessageModule('Windows.load', true, true, this.includeTabThumbnails);

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
                    groupNativeByTab() {
                        const map = new Map;
                        const groupsNative = this.groupsNative ?? [];
                        const groupNativeById = new Map(groupsNative.map(groupNative => [groupNative.id, groupNative]));

                        for (const tab of this.tabs) {
                            const groupNative = groupNativeById.get(tab.groupNativeId);
                            groupNative && map.set(tab, groupNative);
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

            if (!isArchive && tab.url === window.location.href) {
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

        // set --group-native-color only when the tab belongs to a native group;
        // when absent, `border: … var(--group-native-color)` collapses (invalid var, no fallback) instead of drawing a transparent line
        nativeColorStyle(tab, group) {
            const groupNative = group.groupNativeByTab.get(tab);

            if (!groupNative) {
                return null;
            }

            const [lightL, darkL] = groupNative.collapsed
                ? [0.97, 0.48]
                : [0.48, 0.83];

            return {
                '--group-native-color': `light-dark(oklch(from ${groupNative.color} ${lightL} c h), oklch(from ${groupNative.color} ${darkL} c h))`,
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

            const tabsToDiscard = Utils.flatTabs(groupsToDiscard);

            this.sendMessageModule('Tabs.discard', tabsToDiscard.map(Tabs.extractId));
        },
        async moveTabs(tabId, groupId, loadUnsync = false, showTabAfterMovingItIntoThisGroup, discardTabs) {
            const tabIds = this.getTabIdsForMove(tabId);

            await this.sendMessageModule('Tabs.move', tabIds, groupId, {showTabAfterMovingItIntoThisGroup});

            if (discardTabs) {
                this.sendMessageModule('Tabs.discard', tabIds);
            }

            if (loadUnsync) {
                this.loadUnsyncedTabs();
            }
        },

        async loadGroupTabs(groupId) {
            const {group: {tabs}} = await this.sendMessageModule('Groups.load', groupId, true, true, this.includeTabThumbnails);
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
            return this.openedWindows.some(win => win.groupId === group.id);
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
