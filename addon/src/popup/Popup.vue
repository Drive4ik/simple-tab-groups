<script>
    import Vue from 'vue';

    import popup from '../components/popup.vue';
    import editGroupPopup from './edit-group-popup.vue';
    import editGroup from '../components/edit-group.vue';
    import contextMenu from '../components/context-menu.vue';
    import contextMenuTab from '../components/context-menu-tab.vue';
    import contextMenuTabNew from '../components/context-menu-tab-new.vue';
    import contextMenuGroup from '../components/context-menu-group.vue';

    import '/js/prefixed-storage.js';
    import backgroundSelf from '/js/background.js';
    import * as Constants from '/js/constants.js';
    import * as Messages from '/js/messages.js';
    import Logger, {catchFunc, errorEventHandler} from '/js/logger.js';
    import * as Containers from '/js/containers.js';
    import * as Urls from '/js/urls.js';
    import * as Cache from '/js/cache.js';
    import * as Groups from '/js/groups.js';
    import * as Windows from '/js/windows.js';
    import * as Tabs from '/js/tabs.js';
    import * as Utils from '/js/utils.js';
    import JSON from '/js/json.js';

    import defaultGroupMixin from '/js/mixins/default-group.mixin.js';
    import optionsMixin from '/js/mixins/options.mixin.js';
    import syncCloudMixin from '/js/mixins/sync-cloud.mixin.js';

    const isSidebar = '#sidebar' === window.location.hash;
    const MODULE_NAME = isSidebar ? Constants.MODULES.SIDEBAR : Constants.MODULES.POPUP;

    window.logger = new Logger(MODULE_NAME);

    const storage = localStorage.create(Constants.MODULES.POPUP);
    const mainStorage = localStorage.create(Constants.MODULES.BACKGROUND);

    Vue.config.errorHandler = errorEventHandler.bind(window.logger);

    function fullLoading(show) {
        document.getElementById('loading').classList.toggle('is-hidden', !show);
    }

    const {sendMessage} = Messages.connectToBackground(MODULE_NAME + '-temp');

    const startUpDataPromise = sendMessage('get-startup-data');
    await Containers.init();

    const SECTION_SEARCH = 'search',
        SECTION_GROUPS_LIST = 'groupsList',
        SECTION_GROUP_TABS = 'groupTabs',
        SECTION_DEFAULT = SECTION_GROUPS_LIST,
        availableTabKeys = new Set(['id', 'url', 'title', 'favIconUrl', 'status', 'index', 'discarded', 'active', 'cookieStoreId', 'lastAccessed', 'audible', 'mutedInfo', 'windowId']);

    export default {
        name: Constants.MODULES.POPUP,
        mixins: [defaultGroupMixin, optionsMixin, syncCloudMixin],
        data() {
            return {
                enableDebug: mainStorage.enableDebug,

                isSidebar: isSidebar,

                optionsWatchKeys: Constants.POPUP_SETTINGS_MENU_ITEMS
                    .map(item => item.optionsCheckbox && item.key)
                    .filter(Boolean),

                SECTION_SEARCH,
                SECTION_GROUPS_LIST,
                SECTION_GROUP_TABS,

                POPUP_SETTINGS_MENU_ITEMS: Constants.POPUP_SETTINGS_MENU_ITEMS,
                DEFAULT_COOKIE_STORE_ID: Constants.DEFAULT_COOKIE_STORE_ID,
                section: SECTION_DEFAULT,

                showPromptPopup: false,
                promptTitle: null,
                promptValue: '',
                promptResolveFunc: null,

                showConfirmPopup: false,
                confirmTitle: '',
                confirmText: '',
                confirmLang: '',
                confirmClass: '',
                confirmResolveFunc: null,

                dragData: null,
                someGroupAreLoading: false,

                search: '',
                searchDelay: '',
                searchDelayTimer: 0,
                searchOnlyGroups: storage.searchOnlyGroupsInPopup ?? false,
                extendedSearch: false,

                currentWindow: null,
                openedWindows: [],

                groupToShow: null,
                groupToEdit: null,

                containers: Containers.query({defaultContainer: true, temporaryContainer: true}),
                groups: [],

                allTabs: {},

                showUnSyncTabs: false,
                unSyncTabs: [],

                multipleTabIds: [], // TODO try use Set Object
            };
        },
        components: {
            popup: popup,
            'edit-group-popup': editGroupPopup,
            'edit-group': editGroup,
            'context-menu': contextMenu,
            'context-menu-tab': contextMenuTab,
            'context-menu-tab-new': contextMenuTabNew,
            'context-menu-group': contextMenuGroup,
        },
        async mounted() {
            const log = logger.start('mounted');

            await this.optionsLoadPromise;

            const startUpData = await startUpDataPromise;

            await this.loadWindows(startUpData);
            this.loadGroups(startUpData);
            this.loadUnsyncedTabs(startUpData);

            log.log('loaded');

            await this.$nextTick();

            fullLoading(false);
            this.setFocusOnSearch();
            this.setupListeners();

            if (this.options.openGroupAfterChange && this.currentGroup) {
                this.showSectionGroupTabs(this.currentGroup);
            }

            log.stop();
        },
        watch: {
            'options.fullPopupWidth'(fullPopupWidth) {
                if (!isSidebar) {
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
            searchDelay(search) {
                if (search.length && this.allTabsCount > 200) {
                    window.clearTimeout(this.searchDelayTimer);
                    this.searchDelayTimer = window.setTimeout(() => {
                        this.search = search;
                        this.searchDelayTimer = 0;
                    }, 500);
                } else {
                    this.search = search;
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
            currentGroup() {
                return this.currentWindow && this.groups.find(group => group.id === this.currentWindow.groupId);
            },
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
            allTabsCount() {
                return Object.keys(this.allTabs).length;
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
            lang: browser.i18n.getMessage,

            async loadWindows({windows} = {}) {
                this.currentWindow = await Windows.get();
                this.openedWindows = windows || await Windows.load();
            },

            setFocusOnSearch() {
                this.$nextTick(() => this.$refs.search.focus());
            },

            setFocusOnActive() {
                this.$nextTick(function() {
                    let activeItemNode = document.querySelector('.is-active-element');

                    if (!activeItemNode && this.groupToShow) {
                        let activeTab = Utils.getLastActiveTab(this.groupToShow.tabs);

                        if (activeTab) {
                            activeItemNode = document.querySelector(`[data-tab-id="${activeTab.id}"]`);
                        }
                    }

                    if (activeItemNode) {
                        activeItemNode.focus();
                    } else {
                        this.setFocusOnSearch();
                    }
                });
            },

            setupListeners() {
                this
                    .$on('drag-move-group', function(from, to) {
                        Groups.move(from.data.item.id, this.groups.indexOf(to.data.item));
                    })
                    .$on('drag-move-tab', function(from, to) {
                        const tabIds = this.getTabIdsForMove(from.data.item.id),
                            newTabIndex = to.data.item.index;

                        Messages.sendMessageModule('Tabs.move', tabIds, to.data.group.id, {newTabIndex});
                    })
                    .$on('drag-moving', (item, isMoving) => item.isMoving = isMoving)
                    .$on('drag-over', (item, isOver) => item.isOver = isOver);

                this
                    .$on('sync-error', async ({name, message}) => {
                        if (this.syncCloudProgress < 5) {
                            this.syncCloudProgress = 15;
                        }

                        if (this.syncCloudTriggeredByPopup) {
                            const ok = await this.showConfirm(name, message, 'openSettings', 'is-info');
                            ok && this.openOptionsPage('backup sync');
                        }
                    })
                    .$on('sync-finish', () => {
                        this.syncCloudTriggeredByPopup = false;
                    });

                let lazyRemoveTabTimer = 0,
                    lazyRemoveTabIds = [];
                const removeTab = (tabId, withAllTabs = false) => {
                    lazyRemoveTabIds.push(tabId);

                    if (withAllTabs) {
                        delete this.allTabs[tabId];
                    }

                    clearTimeout(lazyRemoveTabTimer);
                    lazyRemoveTabTimer = setTimeout(tabIds => {
                        lazyRemoveTabIds = [];

                        this.multipleTabIds = this.multipleTabIds.filter(tabId => !tabIds.includes(tabId));
                        this.loadUnsyncedTabs();

                        tabIds.forEach(tabId => {
                            let tabIndex = -1,
                                group = this.groups.find(gr => !gr.isArchive && -1 !== (tabIndex = gr.tabs.findIndex(tab => tab.id === tabId)));

                            if (group) {
                                group.tabs.splice(tabIndex, 1);
                                group.tabs.slice(tabIndex).forEach(t => t.index--);
                            }
                        });
                    }, 150, lazyRemoveTabIds);
                };

                let lazyAddUnsyncTabTimer = 0;
                const lazyAddTab = (tab, groupId) => {
                    tab = this.mapTab(Cache.applyTabSession(tab));

                    let group = groupId ? this.groups.find(gr => gr.id === groupId) : null;

                    if (group) {
                        if (!Object.isFrozen(group.tabs)) {
                            if (group.tabs.some(t => t.id === tab.id)) {
                                return;
                            }

                            let index = group.tabs.findIndex(t => t.index >= tab.index);

                            if (index === -1) {
                                index = group.tabs.length;
                            }

                            group.tabs.splice(index, 0, tab);
                            group.tabs.slice(index + 1).forEach(t => t.index++);
                        }
                    } else {
                        clearTimeout(lazyAddUnsyncTabTimer);
                        lazyAddUnsyncTabTimer = setTimeout(() => this.loadUnsyncedTabs(), 150);
                    }
                };

                let lazyCreateTabsTimer = 0,
                    lazyCreateTabs = [];
                const onCreatedTab = tab => {
                    if (Utils.isTabPinned(tab)) {
                        return;
                    }

                    if (backgroundSelf.groupIdForNextTab) {
                        lazyAddTab(tab, backgroundSelf.groupIdForNextTab);
                        return;
                    }

                    lazyCreateTabs.push(tab);

                    clearTimeout(lazyCreateTabsTimer);
                    lazyCreateTabsTimer = setTimeout(function(tabs) {
                        lazyCreateTabs = [];

                        tabs.forEach(tab => lazyAddTab(tab, Cache.getTabGroup(tab.id)));
                    }, 200, lazyCreateTabs);
                };

                const onUpdatedTab = (tabId, changeInfo, tab) => {
                    if (Utils.isTabPinned(tab) && undefined === changeInfo.pinned) {
                        return;
                    }

                    if (!Cache.hasTab(tab.id)) {
                        return;
                    }

                    if (this.allTabs[tab.id]) {
                        if (changeInfo.favIconUrl) {
                            Utils.normalizeTabFavIcon(changeInfo);
                            this.allTabs[tab.id].favIconUrl = changeInfo.favIconUrl;
                        }

                        if (changeInfo.url) {
                            Utils.normalizeTabUrl(changeInfo);
                            this.allTabs[tab.id].url = changeInfo.url;
                        }

                        if (changeInfo.hasOwnProperty('audible')) {
                            Tabs.getOne(tab.id).then(tab => {
                                if (tab) {
                                    this.allTabs[tab.id].audible = tab.audible;
                                    this.allTabs[tab.id].mutedInfo = tab.mutedInfo;
                                }
                            });
                        }

                        if (changeInfo.title) {
                            this.allTabs[tab.id].title = changeInfo.title;
                        }

                        if (changeInfo.status) {
                            this.allTabs[tab.id].status = changeInfo.status;
                        }

                        if (changeInfo.hasOwnProperty('discarded')) {
                            this.allTabs[tab.id].discarded = changeInfo.discarded;
                        } else if (changeInfo.status) {
                            this.allTabs[tab.id].discarded = false;
                        }

                        this.allTabs[tab.id].lastAccessed = tab.lastAccessed;
                    }

                    if (backgroundSelf.excludeTabIds.has(tab.id)) {
                        return;
                    }

                    if (changeInfo.hasOwnProperty('pinned') || changeInfo.hasOwnProperty('hidden')) {
                        let tabGroupId = Cache.getTabGroup(tab.id),
                            winGroupId = Cache.getWindowGroup(tab.windowId);

                        if (changeInfo.pinned || changeInfo.hidden) {
                            removeTab(tab.id);
                        } else {

                            if (false === changeInfo.hidden) {
                                if (tabGroupId) {
                                    return;
                                }
                            }

                            if (winGroupId) {
                                lazyAddTab(tab, winGroupId);
                            }
                        }
                    }
                };

                const onRemovedTab = tabId => removeTab(tabId, true);

                const onActivatedTab = ({tabId, previousTabId}) => {
                    if (this.allTabs[tabId]) {
                        this.allTabs[tabId].active = true;
                    }
                    if (this.allTabs[previousTabId]) {
                        this.allTabs[previousTabId].active = false;
                    }
                };

                let onMovedTabTimer = 0,
                    onMovedUnsyncTabTimer = 0;
                const onMovedTab = (tabId, {windowId}) => {
                    let groupId = Cache.getWindowGroup(windowId);

                    if (groupId) {
                        clearTimeout(onMovedTabTimer);
                        onMovedTabTimer = setTimeout(groupId => this.loadGroupTabs(groupId), 100, groupId);
                    } else {
                        clearTimeout(onMovedUnsyncTabTimer);
                        onMovedUnsyncTabTimer = setTimeout(() => this.loadUnsyncedTabs(), 100);
                    }
                };

                let onDetachedTabTimer = 0;
                const onDetachedTab = (tabId, {oldWindowId}) => { // notice: call before onAttached
                    if (backgroundSelf.excludeTabIds.has(tabId)) {
                        return;
                    }

                    let groupId = Cache.getWindowGroup(oldWindowId);

                    if (groupId) {
                        clearTimeout(onDetachedTabTimer);
                        onDetachedTabTimer = setTimeout(groupId => this.loadGroupTabs(groupId), 100, groupId);
                    }
                };

                let onAttachedTabTimer = 0,
                    onAttachedUnsyncTabTimer = 0;
                const onAttachedTab = (tabId, {newWindowId}) => {
                    if (backgroundSelf.excludeTabIds.has(tabId)) {
                        return;
                    }

                    let groupId = Cache.getWindowGroup(newWindowId);

                    if (groupId) {
                        clearTimeout(onAttachedTabTimer);
                        onAttachedTabTimer = setTimeout(groupId => this.loadGroupTabs(groupId), 100, groupId);
                    } else {
                        clearTimeout(onAttachedUnsyncTabTimer);
                        onAttachedUnsyncTabTimer = setTimeout(() => this.loadUnsyncedTabs(), 100);
                    }
                };

                const listeners = {
                    'group-updated': (request) => {
                        let group = this.groups.find(gr => gr.id === request.group.id);
                        Object.assign(group, request.group);
                    },
                    'group-added': (request) => {
                        if (!this.groups.some(gr => gr.id === request.group.id)) {
                            this.groups.push(this.mapGroup(request.group));
                        }
                    },
                    'group-removed': (request) => {
                        if (this.groupToShow && this.groupToShow.id === request.groupId) {
                            this.showSectionDefault();
                        }

                        let groupIndex = this.groups.findIndex(gr => gr.id === request.groupId);

                        if (-1 !== groupIndex) {
                            this.groups.splice(groupIndex, 1);
                        }
                    },
                    'groups-updated': () => listeners['group-unloaded'](),
                    'group-unloaded': () => {
                        this.loadGroups();
                        this.loadUnsyncedTabs();
                        this.loadWindows();
                    },
                    'group-loaded': async (request) => {
                        await this.loadWindows();

                        if (this.options.openGroupAfterChange) {
                            if (this.currentGroup && this.currentGroup.id === request.groupId && this.groupToShow !== this.currentGroup) {
                                this.showSectionGroupTabs(this.currentGroup);
                            }
                        }

                        if (request.addTabs.length) {
                            let group = this.groups.find(gr => gr.id === request.groupId);
                            group.tabs.push(...request.addTabs.map(this.mapTab, this));
                        }
                    },
                    'window-closed': () => {
                        this.loadWindows();
                    },
                    'containers-updated': () => {
                        this.containers = Containers.query({defaultContainer: true, temporaryContainer: true});
                        Object.values(this.allTabs).forEach(this.mapTabContainer);
                    },
                    'sync-end': ({changes}) => changes.local && listeners['groups-updated'](),
                    'lock-addon': () => {
                        fullLoading(true);
                        removeEvents();
                    },
                };

                const onMessage = catchFunc(async request => {
                    logger.info('take message', request.action);
                    await listeners[request.action](request);
                });

                browser.tabs.onCreated.addListener(onCreatedTab);
                browser.tabs.onUpdated.addListener(onUpdatedTab, {
                    properties: [
                        browser.tabs.UpdatePropertyName.DISCARDED,
                        browser.tabs.UpdatePropertyName.FAVICONURL,
                        browser.tabs.UpdatePropertyName.HIDDEN,
                        browser.tabs.UpdatePropertyName.PINNED,
                        browser.tabs.UpdatePropertyName.TITLE,
                        browser.tabs.UpdatePropertyName.STATUS,
                        browser.tabs.UpdatePropertyName.AUDIBLE,
                    ],
                });
                browser.tabs.onRemoved.addListener(onRemovedTab);
                browser.tabs.onActivated.addListener(onActivatedTab);
                browser.tabs.onMoved.addListener(onMovedTab);
                browser.tabs.onDetached.addListener(onDetachedTab);
                browser.tabs.onAttached.addListener(onAttachedTab);

                const {disconnect} = Messages.connectToBackground(MODULE_NAME, Object.keys(listeners), onMessage, false);

                function removeEvents() {
                    browser.tabs.onCreated.removeListener(onCreatedTab);
                    browser.tabs.onUpdated.removeListener(onUpdatedTab);
                    browser.tabs.onRemoved.removeListener(onRemovedTab);
                    browser.tabs.onActivated.removeListener(onActivatedTab);
                    browser.tabs.onMoved.removeListener(onMovedTab);
                    browser.tabs.onDetached.removeListener(onDetachedTab);
                    browser.tabs.onAttached.removeListener(onAttachedTab);
                    disconnect();
                }

                window.addEventListener('unload', removeEvents);
            },

            async loadGroupTabs(groupId) {
                let {group: {tabs}} = await Groups.load(groupId, true, true),
                    group = this.groups.find(gr => gr.id === groupId);

                group.tabs = tabs.map(this.mapTab, this);
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

            mapGroup(group) {
                if (group.isArchive) {
                    group.tabs = Object.freeze(group.tabs.map(Utils.normalizeTabFavIcon).map(this.mapTabContainer));
                } else {
                    group.tabs = group.tabs.map(this.mapTab, this);
                }

                group.isMoving = false;
                group.isOver = false;

                return new Vue({
                    data: group,
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

            mapTab(tab) {
                Object.keys(tab).forEach(key => !availableTabKeys.has(key) && delete tab[key]);

                tab = Utils.normalizeTabFavIcon(tab);

                tab = this.mapTabContainer(tab);

                if (tab.url === window.location.href) {
                    tab.status = browser.tabs.TabStatus.COMPLETE;
                }

                tab.isMoving = false;
                tab.isOver = false;

                return this.allTabs[tab.id] = new Vue({
                    data: tab,
                });
            },

            mapTabContainer(tab) {
                tab.container = Containers.isDefault(tab.cookieStoreId) ? null : Containers.get(tab.cookieStoreId);
                return tab;
            },

            isOpenedGroup({id}) {
                return this.openedWindows.some(win => win.groupId === id);
            },

            async loadGroups({groups} = {}) {
                ({groups} = groups ? {groups} : await Groups.load(null, true, true));

                this.groups = groups.map(this.mapGroup, this);

                this.multipleTabIds = [];
            },
            async loadUnsyncedTabs({windows} = {}) {
                windows ??= await Windows.load(true, true);

                const tabs = [];

                for (const win of windows) {
                    if (win.id === this.currentWindow.id) {
                        for (const tab of win.tabs) {
                            if (!tab.groupId) {
                                tabs.push(tab);
                            }
                        }
                    }
                }

                this.unSyncTabs = tabs.map(this.mapTab, this);
            },

            showPrompt(title, value) {
                if (this.showPromptPopup) {
                    return Promise.resolve(false);
                }

                return new Promise(resolve => {
                    this.promptTitle = title;
                    this.promptValue = value;

                    this.promptResolveFunc = ok => {
                        this.showPromptPopup = false;

                        if (ok && this.promptValue.length) {
                            resolve(this.promptValue);
                        } else {
                            resolve(false);
                        }
                    };

                    this.showPromptPopup = true;
                });
            },

            showConfirm(title, text, confirmLang = 'ok', confirmClass = 'is-success') {
                if (this.showConfirmPopup) {
                    return Promise.resolve(false);
                }

                return new Promise(resolve => {
                    this.confirmTitle = title;
                    this.confirmText = text;
                    this.confirmLang = confirmLang;
                    this.confirmClass = confirmClass;

                    this.confirmResolveFunc = ok => {
                        this.showConfirmPopup = false;
                        resolve(ok);
                    };

                    this.showConfirmPopup = true;
                });
            },

            async createNewGroup(tabIds, proposalTitle, applyGroupWithTabId) {
                if (this.options.alwaysAskNewGroupName) {
                    const {defaultGroupProps} = await Groups.getDefaults();
                    proposalTitle = await this.showPrompt(this.lang('createNewGroup'), Groups.createTitle(proposalTitle, null, defaultGroupProps));

                    if (!proposalTitle) {
                        return false;
                    }
                }

                const newGroupWindowId = Cache.getWindowGroup(this.currentWindow.id) ? undefined : this.currentWindow.id;
                const newGroup = Messages.sendMessageModule('Groups.add', newGroupWindowId, tabIds, proposalTitle);

                if (applyGroupWithTabId) {
                    this.applyGroup(newGroup, {id: applyGroupWithTabId});
                }
            },

            async renameGroup({id, title}) {
                title = await this.showPrompt(this.lang('hotkeyActionTitleRenameGroup'), title);

                if (title) {
                    Messages.sendMessageModule('Groups.update', id, {title});
                }
            },

            tryRenameGroup() {
                if (this.groupToShow) {
                    this.renameGroup(this.groupToShow);
                } else if (this.currentGroup) {
                    this.renameGroup(this.currentGroup);
                }
            },

            addTab(group, cookieStoreId) {
                Tabs.add(group.id, cookieStoreId);
            },
            removeTab(tab) {
                Messages.sendMessageModule('Tabs.remove', this.getTabIdsForMove(tab.id));
            },

            discardTab(tab) {
                Messages.sendMessageModule('Tabs.discard', this.getTabIdsForMove(tab.id));
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
                Messages.sendMessageModule('Tabs.setMute', group.tabs.map(Tabs.extractId), group.tabs.some(tab => tab.audible));
            },

            discardGroup({tabs}) {
                Messages.sendMessageModule('Tabs.discard', tabs.map(Tabs.extractId));
            },

            discardOtherGroups(groupExclude) {
                let tabs = this.groups.reduce((acc, gr) => {
                    let groupTabs = (gr.id === groupExclude.id || gr.isArchive || this.isOpenedGroup(gr)) ? [] : gr.tabs;

                    acc.push(...groupTabs);

                    return acc;
                }, []);

                Messages.sendMessageModule('Tabs.discard', tabs.map(Tabs.extractId));
            },

            async unloadGroup({id}) {
                fullLoading(true);
                await Messages.sendMessageModule('Groups.unload', id);
                fullLoading(false);
            },

            async toggleArchiveGroup({id, title, isArchive}) {
                let ok = true;

                if (!isArchive && this.options.showConfirmDialogBeforeGroupArchiving) {
                    ok = await this.showConfirm(this.lang('archiveGroup'), this.lang('confirmArchiveGroup', Utils.safeHtml(title)));
                }

                if (ok) {
                    fullLoading(true);
                    await Messages.sendMessageModule('Groups.archiveToggle', id);
                    fullLoading(false);
                }
            },

            reloadTab(tab, bypassCache) {
                Messages.sendMessageModule('Tabs.reload', this.getTabIdsForMove(tab.id), bypassCache);
            },

            reloadAllTabsInGroup(group, bypassCache) {
                Messages.sendMessageModule('Tabs.reload', group.tabs.map(Tabs.extractId), bypassCache);
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
                if (!isSidebar) {
                    window.close();
                }
            },

            async applyGroup(group, tab, closePopup = false) {
                if (this.someGroupAreLoading) {
                    return;
                }

                this.multipleTabIds = [];

                let isCurrentGroup = group === this.currentGroup;

                if (isSidebar && closePopup) {
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
                    Messages.sendMessage('load-custom-group', {
                        groupId: group.id,
                        tabId: tab?.id,
                    });
                    this.closeWindow();
                } else {
                    this.someGroupAreLoading = true;

                    let loadGroupPromise = Messages.sendMessage('load-custom-group', {
                        groupId: group.id,
                        tabId: tab?.id,
                    });

                    if (!isSidebar && this.options.closePopupAfterSelectTab && tab) {
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

                    await Messages.sendMessageModule('Tabs.move', tabsIds, this.currentGroup.id, {
                        showTabAfterMovingItIntoThisGroup: this.currentGroup.showTabAfterMovingItIntoThisGroup,
                        showOnlyActiveTabAfterMovingItIntoThisGroup: this.currentGroup.showOnlyActiveTabAfterMovingItIntoThisGroup,
                        showNotificationAfterMovingTabIntoThisGroup: this.currentGroup.showNotificationAfterMovingTabIntoThisGroup,
                    });
                } else {
                    await Messages.sendMessageModule('Tabs.moveNative', tabsIds, {
                        windowId: this.currentWindow.id,
                        index: -1,
                    });

                    await Messages.sendMessageModule('Tabs.show', tabsIds);
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
                Messages.sendMessageModule('Tabs.remove', this.unSyncTabs.map(Tabs.extractId));

                this.unSyncTabs = [];
            },
            async unsyncHiddenTabsShowTabIntoCurrentWindow(tab) {
                await Messages.sendMessageModule('Tabs.moveNative', [tab.id], {
                    windowId: this.currentWindow.id,
                    index: -1,
                });

                await Messages.sendMessageModule('Tabs.show', tab.id);

                if (this.currentGroup) {
                    this.unSyncTabs.splice(this.unSyncTabs.indexOf(tab), 1);
                } else {
                    this.loadUnsyncedTabs();
                }
            },

            openGroupInNewWindow(group, tab) {
                Messages.sendMessage('load-custom-group', {
                    groupId: group.id,
                    tabId: tab?.id,
                    windowId: 'new',
                });
            },

            openGroupSettings(group) {
                this.groupToEdit = group;
            },
            async removeGroup(group) {
                if (this.options.showConfirmDialogBeforeGroupDelete) {
                    let ok = await this.showConfirm(this.lang('deleteGroup'), this.lang('confirmDeleteGroup', Utils.safeHtml(group.title)), 'delete', 'is-danger');

                    if (!ok) {
                        return;
                    }
                }

                this.groups.splice(this.groups.indexOf(group), 1);

                if (this.groupToShow) {
                    this.showSectionDefault();
                }

                await Messages.sendMessageModule('Groups.remove', group.id);

                if (!this.currentGroup) {
                    this.loadUnsyncedTabs();
                }
            },
            getTabIdsForMove(tabId) {
                if (tabId && !this.multipleTabIds.includes(tabId)) {
                    this.multipleTabIds.push(tabId);
                }

                const tabs = this.multipleTabIds;

                this.multipleTabIds = [];

                return [...tabs];
            },
            async moveTabs(tabId, groupId, loadUnsync = false, showTabAfterMovingItIntoThisGroup, discardTabs) {
                const tabIds = this.getTabIdsForMove(tabId),
                    group = this.groups.find(gr => gr.id === groupId);

                await Messages.sendMessageModule('Tabs.move', tabIds, groupId, {
                    showTabAfterMovingItIntoThisGroup,
                    showOnlyActiveTabAfterMovingItIntoThisGroup: group.showOnlyActiveTabAfterMovingItIntoThisGroup,
                    showNotificationAfterMovingTabIntoThisGroup: group.showNotificationAfterMovingTabIntoThisGroup,
                });

                if (discardTabs) {
                    Messages.sendMessageModule('Tabs.discard', tabIds);
                }

                if (loadUnsync) {
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
                Groups.setIconUrl(this.groupToShow.id, favIconUrl);
            },
            getLastActiveTabTitle(tabs) {
                let tab = Utils.getLastActiveTab(tabs);

                return tab ? Tabs.getTitle(tab, undefined, undefined, true) : '';
            },

            getTabTitle: Tabs.getTitle,
            isTabLoading: Utils.isTabLoading,
            getGroupTitle: Groups.getTitle,
            groupTabsCountMessage: Groups.tabsCountMessage,
            getLastActiveTabContainer({tabs, newTabContainer}, key) {
                const tab = Utils.getLastActiveTab(tabs);
                const container = (tab && tab.cookieStoreId !== newTabContainer)
                    ? Containers.get(tab.cookieStoreId)
                    : null;

                return container?.[key];
            },

            openOptionsPage(section = 'general') {
                Messages.sendMessage('open-options-page', {section});
                this.closeWindow();
            },
            openManageGroups() {
                Messages.sendMessage('open-manage-groups');
                this.closeWindow();
            },
            sortGroups(vector) {
                Groups.sort(vector);
            },
            exportGroupToBookmarks(group) {
                Messages.sendMessage('export-group-to-bookmarks', {
                    groupId: group.id,
                });
            },

            saveEditedGroup(groupId, changes) {
                this.groupToEdit = null;

                if (Object.keys(changes).length) {
                    Messages.sendMessageModule('Groups.update', groupId, changes);
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
                    Messages.sendMessage(...sendMessage);
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
                            <img class="no-fill" src="/icons/search.svg"></img>
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
                <div
                    class="circle-progress"
                    :class="{
                        'in-progress': syncCloudInProgress,
                        'is-success': !syncCloudErrorMessage && syncCloudProgress === 100,
                        'is-danger': !!syncCloudErrorMessage,
                    }"
                    :style="{
                        '--sync-progress-percent': `${syncCloudProgress}%`,
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

        <popup
            v-if="showPromptPopup"
            :title="promptTitle"
            @resolve="promptResolveFunc(true)"
            @close-popup="promptResolveFunc(false)"
            @show-popup="$refs.promptInput.focus(); $refs.promptInput.select()"
            :buttons="
                [{
                    event: 'resolve',
                    classList: 'is-success',
                    lang: 'ok',
                    focused: false,
                }, {
                    event: 'close-popup',
                    lang: 'cancel',
                }]
            ">
            <div class="control is-expanded">
                <input v-model.trim="promptValue" type="text" class="input" ref="promptInput" @keydown.stop @keyup.stop @keydown.enter="promptResolveFunc(true)" maxlength="256" />
            </div>
        </popup>

        <popup
            v-if="showConfirmPopup"
            :title="confirmTitle"
            @resolve="confirmResolveFunc(true)"
            @close-popup="confirmResolveFunc(false)"
            :buttons="
                [{
                    event: 'resolve',
                    classList: confirmClass,
                    lang: confirmLang,
                    focused: true,
                }, {
                    event: 'close-popup',
                    lang: 'cancel',
                }]
            ">
            <span v-html="confirmText"></span>
        </popup>

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
    @property --sync-progress-percent {
        syntax: '<percentage>';
        initial-value: 0%;
        inherits: false;
    }

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
                --progress-color: hsl(from currentColor h s calc(l + 70));
                --progress-background: var(--current-background-color);

                display: flex;
                align-items: center;
                justify-content: center;
                position: relative;
                height: 100%;
                width: 100%;
                border-radius: 50%;
                background:
                    radial-gradient(
                        closest-side,
                        var(--progress-background) 85%, transparent 80% 100%
                    ),
                    conic-gradient(
                        var(--progress-color) var(--sync-progress-percent),
                        transparent 0
                    );

                &.in-progress {
                    transition: --sync-progress-percent linear .3s;
                }
                &.is-success {
                    --progress-color: hsl(153, 53%, 53%);
                }
                &.is-danger {
                    --progress-color: red;
                }

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
