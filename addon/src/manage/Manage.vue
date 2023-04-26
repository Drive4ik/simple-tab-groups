<script>
    'use strict';

    import Vue from 'vue';

    import popup from '../components/popup.vue';
    import editGroup from '../components/edit-group.vue';
    import contextMenu from '../components/context-menu.vue';
    import contextMenuTab from '../components/context-menu-tab.vue';
    import contextMenuTabNew from '../components/context-menu-tab-new.vue';
    import contextMenuGroup from '../components/context-menu-group.vue';

    import backgroundSelf from '/js/background.js';
    import * as Constants from '/js/constants.js';
    import Messages from '/js/messages.js';
    import Logger, {catchFunc} from '/js/logger.js';
    import * as Containers from '/js/containers.js';
    import * as Urls from '/js/urls.js';
    import * as Cache from '/js/cache.js';
    import * as Groups from '/js/groups.js';
    import * as Windows from '/js/windows.js';
    import * as Tabs from '/js/tabs.js';
    import * as Utils from '/js/utils.js';
    import JSON from '/js/json.js';

    import defaultGroupMixin from '/js/mixins/default-group.mixin.js';
    import startUpData from '/js/mixins/start-up-data.mixin.js';

    window.logger = new Logger('Manage');

    // import dnd from '../js/dnd';
    // import { Drag, Drop } from 'vue-drag-drop';
    // import draggable from 'vuedraggable';

    document.title = browser.i18n.getMessage('manageGroupsTitle');

    Vue.config.errorHandler = errorEventHandler.bind(window.logger);

    const VIEW_GRID = 'grid',
        VIEW_DEFAULT = VIEW_GRID,
        availableTabKeys = new Set(['id', 'url', 'title', 'favIconUrl', 'status', 'index', 'discarded', 'active', 'cookieStoreId', 'thumbnail', 'windowId']);

    export default {
        name: 'manage-page',
        mixins: [defaultGroupMixin, startUpData],
        data() {
            return {
                DEFAULT_COOKIE_STORE_ID: Constants.DEFAULT_COOKIE_STORE_ID,
                TEMPORARY_CONTAINER: Constants.TEMPORARY_CONTAINER,

                VIEW_GRID,

                view: VIEW_DEFAULT,

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

                isLoading: true,

                search: '',
                searchDelay: '',
                searchDelayTimer: 0,
                extendedSearch: false,

                currentWindow: null,
                openedWindows: [],

                groupToEdit: null,

                containers: Containers.getAll(true),
                options: {},
                showArchivedGroupsInManageGroups: !!window.localStorage.showArchivedGroupsInManageGroups,

                groups: [],

                allTabs: {},

                unSyncTabs: [],

                dragData: null,
                multipleTabIds: [],
            };
        },
        components: {
            popup: popup,
            'edit-group': editGroup,
            'context-menu': contextMenu,
            'context-menu-tab': contextMenuTab,
            'context-menu-tab-new': contextMenuTabNew,
            'context-menu-group': contextMenuGroup,
        },
        created() {
            this.loadOptions();

            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.updateTheme());
        },
        async mounted() {
            const log = logger.start('mounted');
            const startUpData = await this.startUpData(this.options.showTabsWithThumbnailsInManageGroups);

            this.loadWindows(startUpData);
            this.loadGroups(startUpData);
            this.loadUnsyncedTabs(startUpData);

            log.log('loaded');

            this.$nextTick(function() {
                this.isLoading = false;
                this.setFocusOnSearch();
                this.setupListeners();

                if (this.options.showTabsWithThumbnailsInManageGroups) {
                    this.loadAvailableTabThumbnails();
                }

                log.stop();
            });
        },
        watch: {
            'options.theme': 'updateTheme',
            'options.showTabsWithThumbnailsInManageGroups': function(value, oldValue) {
                if (null != oldValue) {
                    Messages.sendMessageModule('BG.saveOptions', {
                            showTabsWithThumbnailsInManageGroups: value,
                        })
                        .then(() => value && this.loadAvailableTabThumbnails());
                }
            },
            showArchivedGroupsInManageGroups(value) {
                if (value) {
                    window.localStorage.showArchivedGroupsInManageGroups = 1;
                } else {
                    delete window.localStorage.showArchivedGroupsInManageGroups;
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
        },
        computed: {
            filteredGroups() {
                let searchStr = this.search.toLowerCase(),
                    groups = this.showArchivedGroupsInManageGroups ? this.groups : this.groups.filter(group => !group.isArchive);

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
                return this.currentWindow && Utils.isWindowAllow(this.currentWindow);
            },
            allTabsCount() {
                return Object.keys(this.allTabs).length;
            },
        },
        methods: {
            lang: browser.i18n.getMessage,

            updateTheme() {
                document.documentElement.dataset.theme = Utils.getThemeApply(this.options.theme);
            },

            setFocusOnSearch() {
                this.$nextTick(() => this.$refs.search.focus());
            },

            loadOptions() {
                this.options = JSON.clone(backgroundSelf.options);
            },

            async loadWindows({currendWindow, windows} = {}) {
                this.currentWindow = currendWindow || await Windows.get();
                this.openedWindows = windows || await Windows.load();
            },

            setupListeners() {
                this
                    .$on('drag-move-group', function(from, to) {
                        Groups.move(from.data.item.id, this.groups.indexOf(to.data.item));
                    })
                    .$on('drag-move-tab', function(from, to) {
                        if ('new-group' === to.data.item.id) {
                            this.moveTabToNewGroup(null, true);
                        } else {
                            const tabIds = this.getTabIdsForMove(),
                                groupId = this.isGroup(to.data.item) ? to.data.item.id : to.data.group.id,
                                newTabIndex = this.isGroup(to.data.item) ? undefined : to.data.item.index;

                            Messages.sendMessageModule('Tabs.move', tabIds, groupId, {newTabIndex});
                        }
                    })
                    .$on('drag-moving', (item, isMoving) => item.isMoving = isMoving)
                    .$on('drag-over', (item, isOver) => item.isOver = isOver);

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
                    onAttachedUnsyncTabTimer = 0,
                    onAttachedTabWinTimer = 0;
                const onAttachedTab = (tabId, {newWindowId}) => {
                    if (backgroundSelf.excludeTabIds.has(tabId)) {
                        return;
                    }

                    clearTimeout(onAttachedTabWinTimer);
                    onAttachedTabWinTimer = setTimeout(() => this.loadWindows());

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
                            this.$emit('group-added');
                        }
                    },
                    'group-removed': (request) => {
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
                    'group-loaded': () => listeners['window-closed'](),
                    'window-closed': () => {
                        this.loadWindows();
                    },
                    'options-updated': () => {
                        this.loadOptions();
                    },
                    'containers-updated': () => {
                        this.containers = Containers.getAll(true);
                        Object.values(this.allTabs).forEach(this.mapTabContainer);
                    },
                    'lock-addon': () => {
                        this.isLoading = true;
                        removeEvents();
                    },
                    'thumbnail-updated': (request) => {
                        let foundTab = this.groups.some(group => {
                            if (group.isArchive) {
                                return;
                            }

                            let tab = group.tabs.find(tab => tab.id === request.tabId);

                            if (tab) {
                                tab.thumbnail = request.thumbnail;
                                return true;
                            }
                        });

                        if (!foundTab) {
                            this.loadUnsyncedTabs();
                        }
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
                    ],
                });
                browser.tabs.onRemoved.addListener(onRemovedTab);
                browser.tabs.onActivated.addListener(onActivatedTab);
                browser.tabs.onMoved.addListener(onMovedTab);
                browser.tabs.onDetached.addListener(onDetachedTab);
                browser.tabs.onAttached.addListener(onAttachedTab);

                const {disconnect} = Messages.connectToBackground(logger.prefixes.join('.'), Object.keys(listeners), onMessage);

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

                if (!this.isCurrentWindowIsAllow) {
                    window.addEventListener('resize', function() {
                        if (window.localStorage.manageGroupsWindowWidth != window.innerWidth) {
                            window.localStorage.manageGroupsWindowWidth = window.innerWidth;
                        }

                        if (window.localStorage.manageGroupsWindowHeight != window.innerHeight) {
                            window.localStorage.manageGroupsWindowHeight = window.innerHeight;
                        }
                    });
                }
            },

            loadAvailableTabThumbnails() {
                this.groups.forEach(function(group) {
                    if (!group.isArchive) {
                        group.tabs.forEach(function(tab) {
                            if (!tab.thumbnail && !tab.discarded && Utils.isTabLoaded(tab)) {
                                Messages.sendMessageModule('Tabs.updateThumbnail', tab.id);
                            }
                        });
                    }
                });
            },

            async loadGroupTabs(groupId) {
                let {group: {tabs}} = await Groups.load(groupId, true, true, true),
                    group = this.groups.find(gr => gr.id === groupId);

                group.tabs = tabs.map(this.mapTab, this);
            },

            getTabIdsForMove(tabId) {
                if (tabId && !this.multipleTabIds.includes(tabId)) {
                    this.multipleTabIds.push(tabId);
                }

                let tabs = this.multipleTabIds;

                this.multipleTabIds = [];

                return [...tabs];
            },
            async moveTabs(tabId, groupId, loadUnsync = false, showTabAfterMovingItIntoThisGroup, discardTabs) {
                let tabIds = this.getTabIdsForMove(tabId);

                await Messages.sendMessageModule('Tabs.move', tabIds, groupId, {showTabAfterMovingItIntoThisGroup});

                if (discardTabs) {
                    Messages.sendMessageModule('Tabs.discard', tabIds);
                }

                if (loadUnsync) {
                    this.loadUnsyncedTabs();
                }
            },
            async moveTabToNewGroup(tabId, loadUnsync, showTabAfterMovingItIntoThisGroup) {
                let newGroupTitle = '',
                    tabIds = this.getTabIdsForMove(tabId);

                if (this.options.alwaysAskNewGroupName) {
                    newGroupTitle = await Groups.getNextTitle();

                    newGroupTitle = await this.showPrompt(this.lang('createNewGroup'), newGroupTitle);

                    if (!newGroupTitle) {
                        return;
                    }
                }

                let newGroupWindowId = showTabAfterMovingItIntoThisGroup ? this.currentWindow.id : undefined,
                    newGroup = await Groups.add(newGroupWindowId, tabIds, newGroupTitle);

                if (showTabAfterMovingItIntoThisGroup) {
                    this.applyGroup(newGroup, {id: tabId});
                }

                if (loadUnsync) {
                    this.loadUnsyncedTabs();
                }
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

            mapGroup(group) {
                if (group.isArchive) {
                    group.tabs = Object.freeze(group.tabs.map(Utils.normalizeTabFavIcon).map(this.mapTabContainer));
                } else {
                    group.tabs = group.tabs.map(this.mapTab, this);
                }

                group.draggable = true;
                group.isMoving = false;
                group.isOver = false;

                return new Vue({
                    data: group,
                    watch: {
                        title: function(title) {
                            Messages.sendMessageModule('Groups.update', this.id, {
                                title: Groups.createTitle(title, this.id),
                            });
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

            mapTab(tab) {
                Object.keys(tab).forEach(key => !availableTabKeys.has(key) && delete tab[key]);

                tab = Utils.normalizeTabFavIcon(tab);

                if (!tab.thumbnail) {
                    tab.thumbnail = null;
                }

                if (tab.url === window.location.href) {
                    tab.status = browser.tabs.TabStatus.COMPLETE;
                }

                tab = this.mapTabContainer(tab);

                tab.isMoving = false;
                tab.isOver = false;

                return this.allTabs[tab.id] = Vue.observable(tab);
            },

            mapTabContainer(tab) {
                tab.container = Containers.get(tab.cookieStoreId);
                return tab;
            },

            async loadGroups({groups} = {}) {
                ({groups} = groups ? {groups} : await Groups.load(null, true, true, this.options.showTabsWithThumbnailsInManageGroups));

                this.groups = groups.map(this.mapGroup, this);

                this.multipleTabIds = [];
            },
            async loadUnsyncedTabs({unSyncTabs} = {}) {
                if (unSyncTabs) {
                    return this.unSyncTabs = unSyncTabs.map(this.mapTab, this);
                }

                let windows = await Windows.load(true, true, true);

                this.unSyncTabs = windows
                    .reduce(function(acc, win) {
                        win.tabs.forEach(tab => !tab.groupId && acc.push(tab));
                        return acc;
                    }, [])
                    .map(this.mapTab, this);
            },
            addGroup() {
                this.$once('group-added', () => {
                    this.$nextTick(() => [...document.querySelectorAll('input[type="text"]')].pop().select());
                });

                Groups.add();
            },

            addTab(group, cookieStoreId) {
                Messages.sendMessageModule('Tabs.add', group.id, cookieStoreId);
            },
            removeTab(tab) {
                Messages.sendMessageModule('Tabs.remove', this.getTabIdsForMove(tab.id));
            },
            updateTabThumbnail({id}) {
                Messages.sendMessageModule('Tabs.updateThumbnail', id);
            },
            discardTab(tab) {
                Messages.sendMessageModule('Tabs.discard', this.getTabIdsForMove(tab.id));
            },
            discardGroup({tabs}) {
                Messages.sendMessageModule('Tabs.discard', tabs);
            },
            discardOtherGroups(groupExclude) {
                let tabs = this.groups.reduce((acc, gr) => {
                    let groupTabs = (gr.id === groupExclude.id || gr.isArchive || this.isOpenedGroup(gr)) ? [] : gr.tabs;

                    acc.push(...groupTabs);

                    return acc;
                }, []);

                Messages.sendMessageModule('Tabs.discard', tabs);
            },
            reloadTab(tab, bypassCache) {
                Messages.sendMessageModule('Tabs.reload', this.getTabIdsForMove(tab.id), bypassCache);
            },
            reloadAllTabsInGroup(group, bypassCache) {
                Messages.sendMessageModule('Tabs.reload', group.tabs.map(Tabs.extractId), bypassCache);
            },

            async applyGroup({id: groupId}, {id: tabId} = {}, openInNewWindow = false) {
                if (!this.isCurrentWindowIsAllow) {
                    await browser.windows.update(this.currentWindow.id, {
                        state: browser.windows.WindowState.MINIMIZED,
                    });
                }

                await Messages.sendMessage('load-custom-group', {
                    groupId,
                    tabId,
                    windowId: openInNewWindow ? 'new' : null,
                });

                if (!this.isCurrentWindowIsAllow) {
                    this.closeThisWindow();
                }
            },

            isOpenedGroup({id}) {
                return this.openedWindows.some(win => win.groupId === id);
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
                    await Messages.sendMessageModule('Tabs.moveNative', [tab.id], {
                        windowId: this.currentWindow.id,
                        index: -1,
                    });

                    await Messages.sendMessageModule('Tabs.show', tab.id);

                    this.loadUnsyncedTabs();
                }
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

                Messages.sendMessageModule('Groups.remove', group.id);
            },
            setTabIconAsGroupIcon({favIconUrl}, group) {
                Groups.setIconUrl(group.id, favIconUrl);
            },

            getTabTitle: Tabs.getTitle,
            // getGroupTitle: Groups.getTitle,
            isTabLoading: Utils.isTabLoading,
            groupTabsCountMessage: Groups.tabsCountMessage,

            isGroup(obj) {
                return obj.hasOwnProperty('tabs');
            },

            sortGroups(vector) {
                Groups.sort(vector);
            },
            exportGroupToBookmarks(group) {
                Messages.sendMessage('export-group-to-bookmarks', {
                    groupId: group.id,
                });
            },
            unloadGroup({id}) {
                Messages.sendMessageModule('Groups.unload', id);
            },

            saveEditedGroup(groupId, changes) {
                this.groupToEdit = null;

                if (Object.keys(changes).length) {
                    Messages.sendMessageModule('Groups.update', groupId, changes);
                }
            },

            async toggleArchiveGroup({id, title, isArchive}) {
                let ok = true;

                if (!isArchive && this.options.showConfirmDialogBeforeGroupArchiving) {
                    ok = await this.showConfirm(this.lang('archiveGroup'), this.lang('confirmArchiveGroup', Utils.safeHtml(title)));
                }

                if (ok) {
                    this.isLoading = true;
                    await Messages.sendMessageModule('Groups.archiveToggle', id);
                    this.isLoading = false;
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
                if (this.isCurrentWindowIsAllow) {
                    let tab = await Tabs.getActive();
                    Tabs.remove(tab.id);
                } else {
                    browser.windows.remove(this.currentWindow.id); // close manage groups POPUP window
                }
            },

            openOptionsPage() {
                delete window.localStorage.optionsSection;
                Urls.openOptionsPage();
            },
        },
    }
</script>

<template>
    <!-- single view -->
    <!-- grid display -->
    <!-- free arrange -->

    <div id="stg-manage" class="is-flex is-column" tabindex="-1"
        @contextmenu="['INPUT', 'TEXTAREA'].includes($event.target.nodeName) ? null : $event.preventDefault()"
        @click="multipleTabIds = []"
        @keydown.esc="closeThisWindow"
        @keydown.f3.stop.prevent="setFocusOnSearch"
        >
        <header class="is-flex is-align-items-center">
            <span class="page-title">
                <span v-text="lang('extensionName')"></span> - <span v-text="lang('manageGroupsTitle')"></span>
            </span>
            <span>
                <div>
                    <label class="checkbox">
                        <input v-model="options.showTabsWithThumbnailsInManageGroups" type="checkbox" />
                        <span v-text="lang('showTabsWithThumbnailsInManageGroups')"></span>
                    </label>
                    <br>
                    <label class="checkbox">
                        <input v-model="showArchivedGroupsInManageGroups" type="checkbox" />
                        <span v-text="lang('showArchivedGroups')"></span>
                    </label>
                </div>
                <div class="buttons has-addons" style="display: none;">
                    <span class="button is-small is-primary" v-text="lang('manageGroupViewGrid')"></span>
                    <span class="button is-small" disabled v-text="lang('manageGroupViewFreeArrange')"></span>
                </div>
            </span>
            <div class="is-full-width has-text-right">
                <button class="button" @click="addGroup" @contextmenu="$refs.newGroupContextMenu.open($event)">
                    <span class="icon">
                        <img class="size-16" src="/icons/group-new.svg">
                    </span>
                    <span v-text="lang('createNewGroup')"></span>
                </button>
            </div>
            <span>
                <div id="search-wrapper" :class="['field', {'has-addons': searchDelay.length}]">
                    <div :class="['control is-expanded', {'is-loading': searchDelayTimer}]">
                        <input
                            type="text"
                            class="input search-input fill-context"
                            ref="search"
                            v-model.trim="searchDelay"
                            autocomplete="off"
                            @click.stop
                            :placeholder="lang('searchPlaceholder')"
                            :readonly="isLoading" />
                    </div>
                    <div v-show="searchDelay.length" class="control">
                        <label class="button" :title="lang('extendedTabSearch')">
                            <input type="checkbox" v-model="extendedSearch" />
                        </label>
                    </div>
                </div>
            </span>
            <div :title="lang('openSettings')" @click="openOptionsPage" class="cursor-pointer">
                <img class="size-20" src="/icons/settings.svg" />
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
                            <span :class="`size-16 userContext-icon identity-icon-${containers[group.newTabContainer]?.icon} identity-color-${containers[group.newTabContainer]?.color}`"></span>
                        </div>
                        <div class="other-icon" v-if="group.isArchive">
                            <figure class="image is-16x16">
                                <img src="/icons/archive.svg" class="size-16"/>
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
                        <div class="other-icon cursor-pointer is-unselectable" @click="openGroupSettings(group)" :title="lang('groupSettings')">
                            <figure class="image is-16x16">
                                <img src="/icons/settings.svg" />
                            </figure>
                        </div>
                        <div class="other-icon cursor-pointer is-unselectable" @click="removeGroup(group)" :title="lang('deleteGroup')">
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
                                    <img class="size-16" :src="tab.favIconUrl" loading="lazy" decoding="async" />
                                </div>
                                <div v-if="isTabLoading(tab)" class="refresh-icon">
                                    <img class="spin size-16" src="/icons/refresh.svg"/>
                                </div>
                            </template>
                            <template v-else>
                                <div class="tab-icon">
                                    <img v-if="isTabLoading(tab)" class="spin size-16" src="/icons/refresh.svg"/>
                                    <img v-else class="size-16" :src="tab.favIconUrl" loading="lazy" decoding="async" />
                                </div>
                            </template>
                            <div v-if="tab.cookieStoreId && tab.cookieStoreId !== DEFAULT_COOKIE_STORE_ID" class="cookie-container">
                                <span :title="tab.container?.name" :class="`is-inline-block size-16 userContext-icon identity-icon-${tab.container?.icon} identity-color-${tab.container?.color}`"></span>
                            </div>
                            <div v-if="options.showTabsWithThumbnailsInManageGroups" class="screenshot">
                                <img v-if="tab.thumbnail" :src="tab.thumbnail" loading="lazy" decoding="async">
                            </div>
                            <div
                                @mousedown.middle.prevent
                                @mouseup.middle.prevent="!group.isArchive && removeTab(tab)"
                                class="tab-title clip-text"
                                v-text="getTabTitle(tab, false, 0, !group.isArchive && !tab.discarded)"></div>

                            <div v-if="!group.isArchive" class="delete-tab-button" @click.stop="removeTab(tab)" :title="lang('deleteTab')">
                                <img class="size-16" src="/icons/close.svg" />
                            </div>
                        </div>

                        <div
                            v-if="!group.isArchive"
                            class="tab new"
                            tabindex="0"
                            :title="lang('createNewTab')"
                            @click="addTab(group)"
                            @contextmenu.stop.prevent="$refs.contextMenuTabNew.open($event, {group})"
                            >
                            <div :class="options.showTabsWithThumbnailsInManageGroups ? 'screenshot' : 'tab-icon'">
                                <img src="/icons/tab-new.svg">
                            </div>
                            <div :class="['tab-title', {'clip-text': options.showTabsWithThumbnailsInManageGroups}]" v-text="lang('createNewTab')"></div>
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
                                    <img class="size-16" :src="tab.favIconUrl" loading="lazy" decoding="async" />
                                </div>
                                <div v-if="isTabLoading(tab)" class="refresh-icon">
                                    <img class="spin size-16" src="/icons/refresh.svg"/>
                                </div>
                            </template>
                            <template v-else>
                                <div class="tab-icon">
                                    <img v-if="isTabLoading(tab)" class="spin size-16" src="/icons/refresh.svg"/>
                                    <img v-else class="size-16" :src="tab.favIconUrl" loading="lazy" decoding="async" />
                                </div>
                            </template>
                            <div v-if="tab.cookieStoreId && tab.cookieStoreId !== DEFAULT_COOKIE_STORE_ID" class="cookie-container">
                                <span :title="tab.container?.name" :class="`is-inline-block size-16 userContext-icon identity-icon-${tab.container?.icon} identity-color-${tab.container?.color}`"></span>
                            </div>
                            <div v-if="options.showTabsWithThumbnailsInManageGroups" class="screenshot">
                                <img v-if="tab.thumbnail" :src="tab.thumbnail" loading="lazy" decoding="async">
                            </div>
                            <div
                                @mousedown.middle.prevent
                                @mouseup.middle.prevent="removeTab(tab)"
                                class="tab-title clip-text"
                                v-text="getTabTitle(tab, false, 0, !tab.discarded)"></div>

                            <div class="delete-tab-button" @click.stop="removeTab(tab)" :title="lang('deleteTab')">
                                <img class="size-16" src="/icons/close.svg" />
                            </div>
                        </div>
                    </div>
                </div>

                <div class="group new cursor-pointer"
                    @click="addGroup"

                    draggable="true"
                    @dragover="dragHandle($event, 'tab', ['tab'])"
                    @drop="dragHandle($event, 'tab', ['tab'], {item: {id: 'new-group'}})"

                    >
                    <div class="body">
                        <img src="/icons/group-new.svg">
                        <div class="h-margin-top-10" v-text="lang('createNewGroup')"></div>
                    </div>
                </div>
            </div>
        </main>

        <transition name="fade">
            <div class="loading spin" v-show="isLoading">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
                    <path d="M288 39.056v16.659c0 10.804 7.281 20.159 17.686 23.066C383.204 100.434 440 171.518 440 256c0 101.689-82.295 184-184 184-101.689 0-184-82.295-184-184 0-84.47 56.786-155.564 134.312-177.219C216.719 75.874 224 66.517 224 55.712V39.064c0-15.709-14.834-27.153-30.046-23.234C86.603 43.482 7.394 141.206 8.003 257.332c.72 137.052 111.477 246.956 248.531 246.667C393.255 503.711 504 392.788 504 256c0-115.633-79.14-212.779-186.211-240.236C302.678 11.889 288 23.456 288 39.056z"></path>
                </svg>
            </div>
        </transition>

        <div id="multipleTabsText"></div>

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

        <context-menu ref="newGroupContextMenu">
            <ul class="is-unselectable">
                <li @click="openDefaultGroup">
                    <img src="/icons/icon.svg" class="size-16" />
                    <span v-text="lang('defaultGroup')"></span>
                </li>
            </ul>
        </context-menu>

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
                <input v-model.trim="promptValue" type="text" class="input" ref="promptInput" @keydown.enter.stop="promptResolveFunc(true)" />
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


        <!-- <footer class="is-flex is-unselectable">
            footer
        </footer> -->
    </div>

</template>

<style lang="scss">
    :root {
        --margin: 5px;
        --is-in-multiple-drop-text-color: #ffffff;
        --border-radius: 3px;

        --group-bg-color: #f5f5f5;
        --group-active-shadow-color: rgba(3, 102, 214, 0.3);
        --group-active-shadow: 0 0 0 3.5px var(--group-active-shadow-color);
        --group-active-border-color: #2188ff;
        --group-active-border: 1px solid var(--group-active-border-color);

        --tab-active-shadow: var(--group-active-shadow);
        --tab-active-border: var(--group-active-border);
        // --tab-hover-outline-color: #cfcfcf;

        --tab-inner-padding: 3px;
        --tab-inner-border-color: #c6ced4;
        --tab-border-width: 1px;
        --tab-buttons-radius: 75%;
        --tab-buttons-size: 25px;
        --active-tab-bg-color: #e4e4e4;
        --multiple-drag-tab-bg-color: #1e88e5;
    }

    html[data-theme="dark"] {
        --text-color: #e0e0e0;

        --group-bg-color: #444444;
        --group-active-shadow-color: rgba(255, 255, 255, 0.3);
        --group-active-border-color: #e0e0e0;

        --discarded-text-color: #979797;
    }

    .fade-enter-active, .fade-leave-active {
        transition: opacity .5s;
    }
    .fade-enter, .fade-leave-to /* .fade-leave-active до версии 2.1.8 */ {
        opacity: 0;
    }

    #stg-manage {
        padding: var(--indent) var(--indent) calc(var(--indent) * 10);

        > header {
            > :not(:first-child) {
                margin-left: 20px;
            }

            .page-title {
                font-size: 18px;
            }
        }

        > main {
            margin-top: var(--indent);
        }
    }

    #search-wrapper {
        width: 300px;
    }

    .loading {
        height: 50px;
        width: 50px;
        position: absolute;
        top: calc(100vh / 2 - 25px);
        left: calc(100vw / 2 - 25px);
        fill: #6e6e6e;
    }

    #multipleTabsText {
        position: fixed;
        text-align: center;
        color: #000;
        background-color: #fff;
        border-radius: 10px;
        left: -1000%;
        max-width: 450px;
        padding: 15px;
        pointer-events: none;
        box-shadow: 10px 5px rgba(0, 0, 0, 0.6);
    }

    #result {
        // GRID VIEW
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
            /* grid-template-rows: minmax(auto, 600px) minmax(auto, 600px); */
            grid-gap: 10px;
        }

        .group {
            display: flex;
            flex-direction: column;
            border: 1px solid rgba(0, 0, 0, 0.15);
            max-height: 600px;
            background-color: var(--group-bg-color);
            border-radius: var(--border-radius);

            &.drag-over {
                outline-offset: 3px;
            }

            > .header {
                display: flex;
                align-items: center;
                padding: var(--margin);

                > * {
                    display: flex;
                }

                > .group-title {
                    flex-grow: 1;
                }

                > .delete-group-button {
                    line-height: 0;
                }

                > :not(:first-child) {
                    padding-left: var(--margin);
                }

                > .group-icon {
                    position: relative;
                }

                > .group-icon > *,
                > .other-icon > * {
                    pointer-events: none;
                }
            }

            > .body {
                user-select: none;

                overflow-y: auto;
                padding: var(--margin);
                min-height: 110px;
                /* flex-grow: 1; */

                scrollbar-width: thin;

                &:not(.in-list-view) {
                    display: grid;
                    grid-gap: var(--margin);
                    /* grid-gap: 10px; */
                    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
                    grid-auto-rows: 100px;
                }

                &.in-list-view {
                    display: flex;
                    flex-direction: column;
                    margin-bottom: 30px;
                }
            }

            .tab {
                position: relative;
            }

            &:not(.is-archive) .tab {
                cursor: pointer;
            }

            > .body:not(.in-list-view) > .tab {
                padding: var(--tab-inner-padding);
                border-radius: var(--border-radius);

                > * {
                    border: 0 solid var(--identity-tab-color, var(--tab-inner-border-color));
                    background-color: var(--group-bg-color);
                }

                > .tab-icon,
                > .delete-tab-button,
                > .cookie-container,
                > .refresh-icon,
                > .tab-title {
                    position: absolute;
                }

                &:not(.has-thumbnail) > .tab-icon {
                    display: flex;
                    width: 16px;
                    height: 16px;
                    top: calc((calc(100% - 1em - var(--tab-inner-padding)) / 2) - 8px);
                    left: calc((100% / 2) - 8px);
                }

                &.has-thumbnail > .tab-icon {
                    display: flex;
                    align-items: start;
                    justify-content: left;
                    top: var(--tab-inner-padding);
                    left: var(--tab-inner-padding);
                    width: var(--tab-buttons-size);
                    height: var(--tab-buttons-size);
                    border-bottom-width: var(--tab-border-width);
                    border-right-width: var(--tab-border-width);
                    border-bottom-right-radius: var(--tab-buttons-radius);
                }

                > .delete-tab-button {
                    display: flex;
                    visibility: hidden;
                    align-items: start;
                    justify-content: right;
                    top: var(--tab-inner-padding);
                    right: var(--tab-inner-padding);
                    height: var(--tab-buttons-size);
                    width: var(--tab-buttons-size);
                    line-height: 0;
                    border-bottom-width: var(--tab-border-width);
                    border-left-width: var(--tab-border-width);
                    border-bottom-left-radius: var(--tab-buttons-radius);
                }

                &:hover > .delete-tab-button {
                    visibility: visible;
                }

                > .cookie-container {
                    display: flex;
                    align-items: end;
                    justify-content: left;
                    left: var(--tab-inner-padding);
                    bottom: calc(1em + var(--tab-inner-padding) * 2);
                    width: var(--tab-buttons-size);
                    height: var(--tab-buttons-size);
                    border-right-width: var(--tab-border-width);
                    border-top-width: var(--tab-border-width);
                    border-top-right-radius: var(--tab-buttons-radius);
                    padding-bottom: 1px;
                }

                > .refresh-icon {
                    display: flex;
                    align-items: end;
                    justify-content: right;
                    bottom: calc(1em + var(--tab-inner-padding) * 2);
                    right: var(--tab-inner-padding);
                    width: var(--tab-buttons-size);
                    height: var(--tab-buttons-size);
                    border-left-width: var(--tab-border-width);
                    border-top-width: var(--tab-border-width);
                    border-top-left-radius: var(--tab-buttons-radius);
                }

                > .tab-title {
                    line-height: 1.3em;
                    position: absolute;
                    text-align: center;
                    left: var(--tab-inner-padding);
                    right: var(--tab-inner-padding);
                    bottom: var(--tab-inner-padding);
                    white-space: nowrap;
                }

                > .screenshot {
                    height: calc(100% - 1em - var(--tab-inner-padding) - 1px);
                    overflow: hidden;
                    border-width: var(--tab-border-width);
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
                    border-width: var(--tab-border-width);

                    > img {
                        width: 16px;
                        opacity: 0.7;
                    }
                }

                // &:hover,
                // &:hover > * {
                //     background-color: var(--active-tab-bg-color);
                // }

                &.is-active-element {
                    box-shadow: var(--tab-active-shadow);
                    outline: var(--tab-active-border);
                    outline-offset: -1px;
                    -moz-outline-radius: var(--border-radius);
                }

                // &:not(.is-active-element):not(.drag-moving):hover {
                //     outline: 1px solid var(--tab-hover-outline-color);
                //     outline-offset: 1px;
                // }

                &.is-in-multiple-drop,
                &.is-in-multiple-drop > * {
                    --fill-color: var(--is-in-multiple-drop-text-color);
                    background-color: var(--multiple-drag-tab-bg-color);
                }

                &.drag-over {
                    &.drag-moving,
                    &.is-in-multiple-drop {
                        outline-offset: 4px;
                    }
                }

                &.is-in-multiple-drop > .tab-title {
                    color: var(--is-in-multiple-drop-text-color);
                }
            }

            > .body.in-list-view > .tab {
                display: flex;
                align-items: center;
                justify-content: left;
                height: 27px;
                padding: var(--tab-inner-padding);

                &.new {
                    justify-content: center;
                    border: var(--tab-border-width) dashed var(--tab-inner-border-color);

                    > .tab-title {
                        flex-grow: 0;
                    }
                }

                &:hover {
                    background-color: rgba(126, 126, 126, 0.3);
                }

                > .tab-icon {
                    display: flex;
                }

                > .delete-tab-button {
                    display: none;
                    justify-content: right;
                }

                &:hover > .delete-tab-button {
                    display: flex;
                }

                > .cookie-container {
                    padding-left: var(--margin);
                    display: flex;
                    align-items: center;
                }

                > .refresh-icon {
                    display: flex;
                    padding-left: var(--margin);
                }

                > .tab-title {
                    flex-grow: 1;
                    padding: 0 var(--margin);
                    white-space: nowrap;
                }

                &.is-active-element {
                    outline: 1px solid var(--identity-tab-color, var(--group-active-border-color));
                    outline-offset: -1px;
                    -moz-outline-radius: var(--border-radius);
                }

                &.is-in-multiple-drop,
                &.is-in-multiple-drop > * {
                    --fill-color: var(--is-in-multiple-drop-text-color);
                    background-color: var(--multiple-drag-tab-bg-color);
                }

                &.is-in-multiple-drop > .tab-title {
                    color: var(--is-in-multiple-drop-text-color);
                }
            }

            &.is-opened {
                box-shadow: var(--group-active-shadow);
                border: var(--group-active-border);
            }

            &.new {
                display: flex;
                align-content: center;
                justify-content: center;
                min-height: 250px;
                border: 2px dashed var(--tab-inner-border-color);
                background-color: transparent;

                > .body {
                    display: block;
                    text-align: center;

                    > img {
                        width: 100px;
                        opacity: 0.7;
                    }
                }
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

</style>
