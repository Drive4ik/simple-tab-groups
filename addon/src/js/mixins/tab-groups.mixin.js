
import Vue from '/js/vue.runtime.esm.js';

import '/js/prefixed-storage.js';
import Logger from '/js/logger.js';
import * as Constants from '/js/constants.js';
import * as Containers from '/js/containers.js';
import * as Tabs from '/js/tabs.js';
import * as Groups from '/js/groups.js';
import * as Utils from '/js/utils.js';
import * as Messages from '/js/messages.js';
import * as Windows from '/js/windows.js';

const MODULE_NAME = 'tab-groups.mixin';
const logger = new Logger(MODULE_NAME, [Utils.getNameFromPath(location.href)]);

const mainStorage = localStorage.create(Constants.MODULES.BACKGROUND);

const instances = new Set;

const {
    sendMessage,
    sendMessageModule,
    disconnect,
} = Messages.connectToBackground(MODULE_NAME, '*', (syncEvent) => {
    logger.info('got message', syncEvent.action, syncEvent);

    for (const instance of instances) {
        instance.$emit(syncEvent.action, syncEvent);
    }
});

const startUpDataPromise = sendMessage('get-startup-data');

await Containers.init();

const getContainers = () => Containers.query({defaultContainer: true, temporaryContainer: true});

export default {
    data() {
        this.sendMessage = sendMessage;
        this.sendMessageModule = sendMessageModule;

        return {
            enableDebug: mainStorage.enableDebug,
            isLoading: true,

            DEFAULT_COOKIE_STORE_ID: Constants.DEFAULT_COOKIE_STORE_ID,

            defaultAvailableTabKeys: ['id', 'url', 'title', 'favIconUrl', 'status', 'index', 'discarded', 'active', 'cookieStoreId', 'windowId'],

            currentWindow: null,
            openedWindows: [],

            containers: getContainers(),

            search: '',
            searchDelay: '',
            searchDelayTimer: 0,
            extendedSearch: false,

            groupToEdit: null,
            groups: [],

            multipleTabIds: [], // TODO try use Set Object
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
        isManage() {
            return this.$options.name === Constants.MODULES.MANAGE;
        },
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
        instances.add(this);
    },
    beforeDestroy() {
        instances.delete(this);
    },
    mounted() {
        this.tabGroupsPromise = this.tabGroupsLoad(startUpDataPromise);

        this.tabGroupsSetupLiteners();
    },
    methods: {
        async tabGroupsLoad(startUpDataPromise = sendMessage('get-startup-data')) {
            const startUpData = await startUpDataPromise;

            await this.loadWindows(startUpData);
            this.loadGroups(startUpData);
            this.loadUnsyncedTabs(startUpData);
        },

        isTabLoading: Utils.isTabLoading,
        getTabTitle: Tabs.getTitle,
        getGroupTitle: Groups.getTitle,
        groupTabsCountMessage: Groups.tabsCountMessage,

        tabGroupsSetupLiteners() {
            this.$on('containers-updated', () => {
                this.containers = getContainers();
                this.allTabsArray.forEach(this.mapTabContainer, this);
            });

            this.$on('window-closed', () => this.loadWindows());

            this.$on('group-added', request => {
                this.groups.push(this.mapGroup(request.group));
            });
            this.$on('group-updated', request => {
                const group = this.groups.find(group => group.id === request.group.id);
                Object.assign(group, request.group);
            });
            this.$on('group-removed', request => {
                this.groups = this.groups.filter(group => group.id !== request.groupId);
            });
            this.$on('group-loaded', async request => {
                await this.loadWindows();
                this.$emit('group-loaded-ready', request);
            });
            this.$on('group-unloaded', () => this.tabGroupsLoad());

            this.$on('groups-updated', () => this.tabGroupsLoad());

            this.$on('sync-end', ({changes}) => {
                if (changes.local) {
                    this.$emit('groups-updated');
                }
            });

            this.$on('lock-addon', () => {
                this.isLoading = true;
                disconnect();
            });
        },

        async setFocusOnSearch() {
            await this.$nextTick();
            this.$refs.search.focus();
        },

        async loadWindows({windows} = {}) {
            this.currentWindow = await Windows.get();
            this.openedWindows = windows ?? await sendMessageModule('Windows.load');
        },
        async loadGroups({groups} = {}) {
            ({groups} = groups ? {groups} : await sendMessageModule('Groups.load', null, true, true, this.includeTabThumbnails));

            this.groups = groups.map(this.mapGroup, this);

            this.multipleTabIds = [];
        },
        async loadUnsyncedTabs({windows} = {}) {
            const includeTabThumbnails =  this.isManage && this.options.showTabsWithThumbnailsInManageGroups;

            windows ??= await sendMessageModule('Windows.load', true, true, includeTabThumbnails);

            const tabs = [];

            function addTabs(win) {
                for (const tab of win.tabs) {
                    if (!tab.groupId) {
                        tabs.push(tab);
                    }
                }
            }

            for (const win of windows) {
                if (this.currentWindow.type === browser.windows.WindowType.NORMAL) {
                    if (win.id === this.currentWindow.id) {
                        addTabs(win);
                    }
                } else {
                    addTabs(win);
                }
            }

            this.unSyncTabs = tabs.map(this.mapTab, this);
        },

        mapGroup(group) {
            group.tabs = group.tabs.map(tab => this.mapTab(tab, group.isArchive));

            if (group.isArchive) {
                Object.freeze(group.tabs);
            }

            group.draggable = true; // isManage
            group.isMoving = false;
            group.isOver = false;

            return new Vue({
                data: group,
                watch: {
                    title(title) {
                        sendMessageModule('Groups.update', this.id, {title});
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

            tab = Utils.normalizeTabFavIcon(tab);

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
                return tab;
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
            sendMessageModule('Tabs.add', group.id, cookieStoreId);
        },
        removeTab(tab) {
            sendMessageModule('Tabs.remove', this.getTabIdsForMove(tab.id));
        },

        reloadTab(tab, bypassCache) {
            sendMessageModule('Tabs.reload', this.getTabIdsForMove(tab.id), bypassCache);
        },
        reloadAllTabsInGroup(group, bypassCache) {
            sendMessageModule('Tabs.reload', group.tabs.map(Tabs.extractId), bypassCache);
        },

        discardTab(tab) {
            sendMessageModule('Tabs.discard', this.getTabIdsForMove(tab.id));
        },
        discardGroup(group) {
            sendMessageModule('Tabs.discard', group.tabs.map(Tabs.extractId));
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

            const tabsToDiscard = Utils.concatTabs(groupsToDiscard);

            sendMessageModule('Tabs.discard', tabsToDiscard.map(Tabs.extractId));
        },
        async moveTabs(tabId, groupId, loadUnsync = false, showTabAfterMovingItIntoThisGroup, discardTabs) {
            const tabIds = this.getTabIdsForMove(tabId);

            await sendMessageModule('Tabs.move', tabIds, groupId, {showTabAfterMovingItIntoThisGroup});

            if (discardTabs) {
                sendMessageModule('Tabs.discard', tabIds);
            }

            if (loadUnsync) {
                this.loadUnsyncedTabs();
            }
        },

        async loadGroupTabs(groupId) {
            const {group: {tabs}} = await Groups.load(groupId, true, true, this.includeTabThumbnails);
            const group = this.groups.find(gr => gr.id === groupId);

            group.tabs = tabs.map(this.mapTab, this);
        },

        openGroupSettings(group) {
            this.groupToEdit = group;
        },
        saveEditedGroup(groupId, changes) {
            this.groupToEdit = null;

            if (Object.keys(changes).length) {
                sendMessageModule('Groups.update', groupId, changes);
            }
        },


        async unloadGroup(group) {
            this.isLoading = true;
            await sendMessageModule('Groups.unload', group.id);
            this.isLoading = false;
        },
        sortGroups(vector) {
            sendMessageModule('Groups.sort', vector);
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
                await sendMessageModule('Groups.archiveToggle', id);
                this.isLoading = false;
            }
        },

        exportGroupToBookmarks(group) {
            sendMessage('export-group-to-bookmarks', {
                groupId: group.id,
            });
        },
    },
}
