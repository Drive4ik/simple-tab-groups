
import Vue from '/js/vue.runtime.esm.js';

import '/js/prefixed-storage.js';
import * as Constants from '/js/constants.js';
import * as Containers from '/js/containers.js';
import * as Tabs from '/js/tabs.js';
import * as Groups from '/js/groups.js';
import * as Utils from '/js/utils.js';
import * as Windows from '/js/windows.js';
import * as Cloud from '/js/sync/cloud/cloud.js';
import {isPinnedNeedingGroupPin} from '/js/tab-move-split.js';

const mainStorage = localStorage.create(Constants.MODULES.BACKGROUND);
const isManage = location.href.startsWith(Constants.PAGES.MANAGE);

export default {
    data() {
        this.isManage = isManage;

        return {
            enableDebug: mainStorage.enableDebug,
            isLoading: true,

            DEFAULT_COOKIE_STORE_ID: Constants.DEFAULT_COOKIE_STORE_ID,

            defaultAvailableTabKeys: ['id', 'url', 'title', 'favIconUrl', 'status', 'index', 'discarded', 'active', 'cookieStoreId', 'windowId', 'pinned', 'groupPinned'],

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
            return this.isManage && this.options.showTabsWithThumbnailsInManageGroups;
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
        this.startUpDataPromise = this.sendMessage('get-startup-data', {isManage});
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

        async tabGroupsLoad(startUpDataPromise = this.sendMessage('get-startup-data', {isManage})) {
            const startUpData = await startUpDataPromise;

            await this.loadWindowsAndGroups(startUpData);
            await this.loadUnsyncedTabs(startUpData);
        },

        isTabLoading: Tabs.isLoading,
        getTabTitle: Tabs.getTitle,
        getGroupTitle: Groups.getTitle,
        groupTabsCountMessage: Groups.tabsCountMessage,

        // Fault isolation for broadcast handlers: the dispatch loop (broadcast.js) wraps each
        // handler in a synchronous try/catch, so a sync throw is contained. But several handlers
        // below are async (or call an async method without awaiting), and their rejected promise
        // escapes that try/catch as an unhandled rejection. This helper runs the body
        // synchronously (broadcast ordering unchanged) and only catches the returned promise's
        // rejection, logging it locally via STG's logger instead of letting it escape.
        safeHandler(name, fn) {
            return (...args) => Promise.resolve(fn.apply(this, args)).catch(self.logger?.onCatch(name, false));
        },

        tabGroupsSetupListeners() {
            const list = this.tabGroupsOffListeners = new Set();

            list.add(Containers.onChanged(this.safeHandler('onChangedContainers', () => this.onChangedContainers())));

            list.add(Windows.on(['opened', 'closed'], this.safeHandler('loadWindows', () => this.loadWindows())));

            list.add(Tabs.on('updated', this.safeHandler('Tabs.updated', ({tabId, changeInfo}) => {
                const tab = this.allTabs[tabId] ?? this.unSyncTabs.find(tab => tab.id === tabId);
                tab && Object.assign(tab, changeInfo);
            })));
            list.add(Tabs.on('updated.group', this.safeHandler('Tabs.updated.group', ({groupId}) => {
                this.loadGroupTabs(groupId);
            })));
            list.add(Tabs.on('updated.unsync', this.safeHandler('Tabs.updated.unsync', ({windowId}) => {
                this.loadUnsyncedTabs({windowId});
            })));
            list.add(Tabs.on('removed', this.safeHandler('Tabs.removed', ({tabId, groupId}) => {
                const group = this.groups.find(group => group.id === groupId);

                // Same cross-channel race as loadGroupTabs: the Tabs `removed` broadcast can
                // reference a synced group the local `this.groups` array doesn't hold yet
                // (its Groups `added` broadcast is still pending). Nothing to splice — skip.
                if (!group) {
                    return;
                }

                const tabIndex = group.tabs.findIndex(tab => tab.id === tabId);

                if (tabIndex !== -1) {
                    group.tabs.splice(tabIndex, 1);
                }
            })));
            list.add(Tabs.on('removed.unsync', this.safeHandler('Tabs.removed.unsync', ({tabId}) => {
                const tabIndex = this.unSyncTabs.findIndex(tab => tab.id === tabId);

                if (tabIndex !== -1) {
                    this.unSyncTabs.splice(tabIndex, 1);
                }
            })));

            list.add(Groups.on('added', this.safeHandler('Groups.added', request => {
                this.groups.push(this.mapGroup(request.group));
                this.onGroupAdded?.(request);
            })));
            list.add(Groups.on('updated', this.safeHandler('Groups.updated', request => {
                const group = this.groups.find(group => group.id === request.group.id);
                Object.assign(group, request.group);
                this.onGroupUpdated?.(request);
            })));
            list.add(Groups.on('removed', this.safeHandler('Groups.removed', request => {
                this.groups = this.groups.filter(group => group.id !== request.groupId);
                this.onGroupRemoved?.(request);
            })));
            list.add(Groups.on('loaded', this.safeHandler('Groups.loaded', async request => {
                await this.loadWindowsAndGroups();
                await this.onGroupLoadedReady?.(request);
            })));
            list.add(Groups.on('unloaded', this.safeHandler('Groups.unloaded', async request => {
                await this.tabGroupsLoad();
                this.onGroupUnloaded?.(request);
            })));
            list.add(Groups.on('updated.all', this.safeHandler('Groups.updated.all', async request => {
                await this.tabGroupsLoad();
                this.onGroupsUpdatedAll?.(request);
            })));

            list.add(Cloud.on('sync-end', this.safeHandler('Cloud.sync-end', async request => {
                if (request.changes?.local) {
                    await this.tabGroupsLoad();
                    this.onGroupsSyncEnd?.(request);
                }
            })));
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

            if (this.isManage) {
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

        // tabs ang groups actions
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
        toggleTabGroupPinned(tab, groupPinned, targetGroupId) {
            // group-scoped pin: pinned only while the tab's group is active.
            this.sendMessageModule('Groups.setTabGroupPinned', tab.id, groupPinned, targetGroupId);
        },
        togglePinnedGroup() {
            this.sendMessageModule('Groups.togglePinnedGroupInWindow', this.currentWindow.id);
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

            // Single source of truth: Tabs.move now routes any browser-pinned tab into the
            // group as group-pinned (unpin → move → flag) instead of dropping it + showing
            // "pinnedTabsAreNotSupported". So just hand it everything.
            if (tabIds.length) {
                await this.sendMessageModule('Tabs.move', tabIds, groupId, {showTabAfterMovingItIntoThisGroup});
            }

            // Discard only the tabs that stayed normal — a tab that became (or stays)
            // group-pinned is pinned and visible, so discarding it would be wrong.
            if (discardTabs) {
                const findTab = id => this.allTabs[id] ?? this.unSyncTabs.find(tab => tab.id === id);
                const normalTabIds = tabIds.filter(id => !isPinnedNeedingGroupPin(findTab(id)));

                if (normalTabIds.length) {
                    this.sendMessageModule('Tabs.discard', normalTabIds);
                }
            }

            if (loadUnsync) {
                this.loadUnsyncedTabs();
            }
        },

        async loadGroupTabs(groupId) {
            const {group: {tabs}} = await this.sendMessageModule('Groups.load', groupId, true, true, this.includeTabThumbnails);
            const group = this.groups.find(gr => gr.id === groupId);

            // The Tabs `updated.group` broadcast (tabs channel) can arrive before the
            // Groups `added` broadcast (groups channel) for a freshly-synced group, so the
            // local `this.groups` array may not contain it yet. The view is just stale for
            // that group — bail out; the pending `added`/`sync-end` repaint will load it.
            if (!group) {
                return;
            }

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
