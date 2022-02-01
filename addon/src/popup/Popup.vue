<script>
    'use strict';

    import Vue from 'vue';
    import VueLazyload from 'vue-lazyload';

    import popup from '../js/popup.vue';
    import editGroupPopup from './edit-group-popup.vue';
    import editGroup from '../js/edit-group.vue';
    import contextMenu from '../components/context-menu.vue';
    import contextMenuTab from '../components/context-menu-tab.vue';
    import contextMenuTabNew from '../components/context-menu-tab-new.vue';
    import contextMenuGroup from '../components/context-menu-group.vue';

    Vue.config.errorHandler = errorEventHandler;

    Vue.use(VueLazyload);

    const loadingNode = document.getElementById('loading');

    function fullLoading(show) {
        if (show) {
            loadingNode.classList.remove('is-hidden');
        } else {
            loadingNode.classList.add('is-hidden');
        }
    }

    const SECTION_SEARCH = 'search',
        SECTION_GROUPS_LIST = 'groupsList',
        SECTION_GROUP_TABS = 'groupTabs',
        SECTION_DEFAULT = SECTION_GROUPS_LIST,
        availableTabKeys = new Set(['id', 'url', 'title', 'favIconUrl', 'status', 'index', 'discarded', 'active', 'cookieStoreId', 'lastAccessed', 'audible', 'mutedInfo', 'windowId']),
        isSidebar = '#sidebar' === window.location.hash;

    let loadPromise = null;

    export default {
        data() {
            return {
                isSidebar: isSidebar,

                SECTION_SEARCH,
                SECTION_GROUPS_LIST,
                SECTION_GROUP_TABS,

                DEFAULT_COOKIE_STORE_ID,
                TEMPORARY_CONTAINER,

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
                searchOnlyGroups: window.localStorage.searchOnlyGroupsInPopup == 1,
                extendedSearch: false,

                currentWindow: null,
                openedWindows: [],

                groupToShow: null,
                groupToEdit: null,

                containers: Containers.getAll(true),
                options: {},
                groups: [],

                allTabs: {},

                showUnSyncTabs: false,
                unSyncTabs: [],

                showArchivedGroupsInPopup: window.localStorage.hasOwnProperty('showArchivedGroupsInPopup') ? window.localStorage.showArchivedGroupsInPopup == 1 : true,

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
        created() {
            if (!isSidebar && BG.options.fullPopupWidth) {
                document.documentElement.classList.add('full-popup-width');
            }

            window.matchMedia('(prefers-color-scheme: dark)').addListener(({matches}) => this.updateTheme());

            this.loadOptions();

            loadPromise = Promise.all([this.loadWindows(), this.loadGroups(), this.loadUnsyncedTabs()]);
        },
        async mounted() {
            await loadPromise;

            this.$nextTick(function() {
                fullLoading(false);
                this.setFocusOnSearch();
                this.setupListeners();

                if (this.options.openGroupAfterChange && this.currentGroup) {
                    this.showSectionGroupTabs(this.currentGroup);
                }
            });
        },
        watch: {
            'options.theme': 'updateTheme',
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
                window.localStorage.searchOnlyGroupsInPopup = value ? 1 : 0;
            },
            groups(groups) {
                if (this.groupToShow) {
                    this.groupToShow = groups.find(gr => gr.id === this.groupToShow.id) || null;
                }
            },
            showArchivedGroupsInPopup(value) {
                window.localStorage.showArchivedGroupsInPopup = value ? 1 : 0;
            },
        },
        computed: {
            currentGroup() {
                return this.currentWindow && this.groups.find(group => group.id === this.currentWindow.groupId);
            },
            filteredGroups() {
                let searchStr = this.search.toLowerCase(),
                    groups = this.showArchivedGroupsInPopup ? this.groups : this.groups.filter(group => !group.isArchive),
                    filteredGroups = [];

                groups.forEach(group => {
                    if (this.searchOnlyGroups) {
                        group.filteredTabs = [];

                        if (utils.mySearchFunc(searchStr, group.title)) {
                            filteredGroups.push(group);
                        }
                    } else {
                        group.filteredTabs = group.tabs.filter(tab => utils.mySearchFunc(searchStr, utils.getTabTitle(tab, true), this.extendedSearch));

                        if (group.filteredTabs.length || utils.mySearchFunc(searchStr, group.title, this.extendedSearch)) {
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
                return this.unSyncTabs.map(tab => tab.windowId).filter(utils.onlyUniqueFilter);
            },
            allTabsCount() {
                return Object.keys(this.allTabs).length;
            },
        },
        methods: {
            lang: browser.i18n.getMessage,

            updateTheme() {
                document.documentElement.dataset.theme = utils.getThemeApply(this.options.theme);
            },

            async loadWindows() {
                this.currentWindow = await Windows.get();
                this.openedWindows = await Windows.load();
            },

            loadOptions() {
                this.options = utils.clone(BG.options);
            },

            setFocusOnSearch() {
                this.$nextTick(() => this.$refs.search.focus());
            },

            setFocusOnActive() {
                this.$nextTick(function() {
                    let activeItemNode = document.querySelector('.is-active-element');

                    if (!activeItemNode && this.groupToShow) {
                        let activeTab = utils.getLastActiveTab(this.groupToShow.tabs);

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
                        let tabIds = this.getTabIdsForMove(from.data.item.id);

                        BG.Tabs.move(tabIds, to.data.group.id, to.data.item.index, false);
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
                    tab = this.mapTab(cache.applyTabSession(tab));

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
                    if (utils.isTabPinned(tab)) {
                        return;
                    }

                    if (BG.groupIdForNextTab) {
                        lazyAddTab(tab, BG.groupIdForNextTab);
                        return;
                    }

                    lazyCreateTabs.push(tab);

                    clearTimeout(lazyCreateTabsTimer);
                    lazyCreateTabsTimer = setTimeout(function(tabs) {
                        lazyCreateTabs = [];

                        tabs.forEach(tab => lazyAddTab(tab, cache.getTabGroup(tab.id)));
                    }, 200, lazyCreateTabs);
                };

                const onUpdatedTab = (tabId, changeInfo, tab) => {
                    if (utils.isTabPinned(tab) && undefined === changeInfo.pinned) {
                        return;
                    }

                    if (!cache.hasTab(tab.id)) {
                        return;
                    }

                    if (this.allTabs[tab.id]) {
                        if (changeInfo.favIconUrl) {
                            utils.normalizeTabFavIcon(changeInfo);
                            this.allTabs[tab.id].favIconUrl = changeInfo.favIconUrl;
                        }

                        if (changeInfo.url) {
                            utils.normalizeTabUrl(changeInfo);
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

                    if (BG.excludeTabIds.has(tab.id)) {
                        return;
                    }

                    if (changeInfo.hasOwnProperty('pinned') || changeInfo.hasOwnProperty('hidden')) {
                        let tabGroupId = cache.getTabGroup(tab.id),
                            winGroupId = cache.getWindowGroup(tab.windowId);

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
                    let groupId = cache.getWindowGroup(windowId);

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
                    if (BG.excludeTabIds.has(tabId)) {
                        return;
                    }

                    let groupId = cache.getWindowGroup(oldWindowId);

                    if (groupId) {
                        clearTimeout(onDetachedTabTimer);
                        onDetachedTabTimer = setTimeout(groupId => this.loadGroupTabs(groupId), 100, groupId);
                    }
                };

                let onAttachedTabTimer = 0,
                    onAttachedUnsyncTabTimer = 0;
                const onAttachedTab = (tabId, {newWindowId}) => {
                    if (BG.excludeTabIds.has(tabId)) {
                        return;
                    }

                    let groupId = cache.getWindowGroup(newWindowId);

                    if (groupId) {
                        clearTimeout(onAttachedTabTimer);
                        onAttachedTabTimer = setTimeout(groupId => this.loadGroupTabs(groupId), 100, groupId);
                    } else {
                        clearTimeout(onAttachedUnsyncTabTimer);
                        onAttachedUnsyncTabTimer = setTimeout(() => this.loadUnsyncedTabs(), 100);
                    }
                };

                const onMessage = utils.catchFunc(async request => {
                    switch (request.action) {
                        case 'group-updated':
                            let group = this.groups.find(gr => gr.id === request.group.id);
                            Object.assign(group, request.group);
                            break;
                        case 'group-added':
                            if (!this.groups.some(gr => gr.id === request.group.id)) {
                                this.groups.push(this.mapGroup(request.group));
                            }
                            break;
                        case 'group-removed':
                            if (this.groupToShow && this.groupToShow.id === request.groupId) {
                                this.showSectionDefault();
                            }

                            let groupIndex = this.groups.findIndex(gr => gr.id === request.groupId);

                            if (-1 !== groupIndex) {
                                this.groups.splice(groupIndex, 1);
                            }

                            break;
                        case 'groups-updated':
                        case 'group-unloaded':
                            this.loadGroups();
                            this.loadUnsyncedTabs();
                            this.loadWindows();
                            break;
                        case 'group-loaded':
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
                            break;
                        case 'window-closed':
                            this.loadWindows();
                            break;
                        case 'options-updated':
                            this.loadOptions();
                            break;
                        case 'containers-updated':
                            this.containers = Containers.getAll(true);
                            Object.values(this.allTabs).forEach(this.mapTabContainer);
                            break;
                        case 'lock-addon':
                            fullLoading(true);
                            removeEvents();
                            break;
                    }
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
                browser.runtime.onMessage.addListener(onMessage);

                function removeEvents() {
                    browser.tabs.onCreated.removeListener(onCreatedTab);
                    browser.tabs.onUpdated.removeListener(onUpdatedTab);
                    browser.tabs.onRemoved.removeListener(onRemovedTab);
                    browser.tabs.onActivated.removeListener(onActivatedTab);
                    browser.tabs.onMoved.removeListener(onMovedTab);
                    browser.tabs.onDetached.removeListener(onDetachedTab);
                    browser.tabs.onAttached.removeListener(onAttachedTab);
                    browser.runtime.onMessage.removeListener(onMessage);
                }

                window.addEventListener('unload', removeEvents);
            },

            async loadGroupTabs(groupId) {
                let [{tabs}] = await Groups.load(groupId, true, true),
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
                let aIncludes = utils.getTabTitle(a, true).toLowerCase().includes(searchStr),
                    bIncludes = utils.getTabTitle(b, true).toLowerCase().includes(searchStr);

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
                    group.tabs = Object.freeze(group.tabs.map(utils.normalizeTabFavIcon).map(this.mapTabContainer));
                } else {
                    group.tabs = group.tabs.map(this.mapTab, this);
                }

                group.isMoving = false;
                group.isOver = false;

                return new Vue({
                    data: group,
                    computed: {
                        iconUrlToDisplay() {
                            return utils.getGroupIconUrl({
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

                tab = utils.normalizeTabFavIcon(tab);

                tab = this.mapTabContainer(tab);

                tab.isMoving = false;
                tab.isOver = false;

                return this.allTabs[tab.id] = new Vue({
                    data: tab,
                });
            },

            mapTabContainer(tab) {
                tab.container = Containers.get(tab.cookieStoreId);
                return tab;
            },

            isOpenedGroup({id}) {
                return this.openedWindows.some(win => win.groupId === id);
            },

            async loadGroups() {
                let groups = await Groups.load(null, true, true);

                this.groups = groups.map(this.mapGroup, this);

                this.multipleTabIds = [];
            },
            async loadUnsyncedTabs() {
                let windows = await Windows.load(true, true);

                this.unSyncTabs = windows
                    .reduce(function(acc, win) {
                        win.tabs.forEach(tab => !tab.groupId && acc.push(tab));
                        return acc;
                    }, [])
                    .map(this.mapTab, this);
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

            async createNewGroup(tabIds, showTabAfterMoving, proposalTitle, windowId) {
                let newGroupTitle = '';

                if (this.options.alwaysAskNewGroupName) {
                    newGroupTitle = await Groups.getNextTitle();

                    newGroupTitle = await this.showPrompt(this.lang('createNewGroup'), proposalTitle || newGroupTitle);

                    if (!newGroupTitle) {
                        return false;
                    }
                }

                Groups.add(windowId, tabIds, newGroupTitle, showTabAfterMoving);
            },

            async renameGroup({id, title}) {
                title = await this.showPrompt(this.lang('hotkeyActionTitleRenameGroup'), title);

                if (title) {
                    Groups.update(id, {title});
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
                Tabs.remove(this.getTabIdsForMove(tab.id));
            },

            discardTab(tab) {
                Tabs.discard(this.getTabIdsForMove(tab.id));
            },

            showMuteIconTab(tab) {
                return tab.audible || tab.mutedInfo.muted;
            },

            showMuteIconGroup(group) {
                return group.isArchive ? false : group.tabs.some(this.showMuteIconTab);
            },

            toggleMuteTab(tab) {
                Tabs.setMute([tab], tab.audible);
            },

            toggleMuteGroup(group) {
                Tabs.setMute(group.tabs, group.tabs.some(tab => tab.audible));
            },

            discardGroup({tabs}) {
                Tabs.discard(tabs);
            },

            discardOtherGroups(groupExclude) {
                let tabs = this.groups.reduce((acc, gr) => {
                    let groupTabs = (gr.id === groupExclude.id || gr.isArchive || this.isOpenedGroup(gr)) ? [] : gr.tabs;

                    acc.push(...groupTabs);

                    return acc;
                }, []);

                Tabs.discard(tabs);
            },

            async unloadGroup({id}) {
                fullLoading(true);
                await BG.Groups.unload(id);
                fullLoading(false);
            },

            async toggleArchiveGroup({id, title, isArchive}) {
                let ok = true;

                if (!isArchive && this.options.showConfirmDialogBeforeGroupArchiving) {
                    ok = await this.showConfirm(this.lang('archiveGroup'), this.lang('confirmArchiveGroup', utils.safeHtml(title)));
                }

                if (ok) {
                    fullLoading(true);
                    await BG.Groups.archiveToggle(id);
                    fullLoading(false);
                }
            },

            reloadTab(tab, bypassCache) {
                Tabs.reload(this.getTabIdsForMove(tab.id), bypassCache);
            },

            reloadAllTabsInGroup(group, bypassCache) {
                Tabs.reload(group.tabs, bypassCache);
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

                        let tabIds = tabs.map(utils.keyId),
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
                    this.applyGroup(group, tab);
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

                if (isCurrentGroup) {
                    if (!tab) { // open group
                        this.showSectionGroupTabs(group);
                        return;
                    }

                    if (tab.active) {
                        return;
                    }
                }

                let tabId = tab && tab.id;

                if (closePopup) {
                    BG.applyGroup(this.currentWindow.id, group.id, tabId);
                    this.closeWindow();
                } else {
                    this.someGroupAreLoading = true;

                    let loadGroupPromise = BG.applyGroup(this.currentWindow.id, group.id, tabId);

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
                let tabsIds = this.unSyncTabs.map(utils.keyId);

                if (this.currentGroup) {
                    this.unSyncTabs = [];

                    await BG.Tabs.move(tabsIds, this.currentGroup.id, undefined, false);
                } else {
                    await BG.Tabs.moveNative(this.unSyncTabs, {
                        windowId: this.currentWindow.id,
                        index: -1,
                    });

                    await BG.Tabs.show(tabsIds);
                }

                this.loadGroups();
            },
            async unsyncHiddenWindowTabsCreateNewGroup() {
                await this.createNewGroup(this.unSyncWindowTabs.map(utils.keyId), undefined, this.unSyncWindowTabs[0].title, this.currentWindow.id);

                this.loadUnsyncedTabs();
            },
            async unsyncHiddenTabsCreateNewGroupAll() {
                let groupCreated = await this.createNewGroup(this.unSyncTabs.map(utils.keyId), undefined, this.unSyncTabs[0].title);

                if (groupCreated !== false) {
                    this.unSyncTabs = [];
                }
            },
            unsyncHiddenTabsCloseAll() {
                BG.Tabs.remove(this.unSyncTabs.map(utils.keyId));

                this.unSyncTabs = [];
            },
            async unsyncHiddenTabsShowTabIntoCurrentWindow(tab) {
                await Tabs.moveNative([tab], {
                    windowId: this.currentWindow.id,
                    index: -1,
                });

                await Tabs.show(tab.id);

                if (this.currentGroup) {
                    this.unSyncTabs.splice(this.unSyncTabs.indexOf(tab), 1);
                } else {
                    this.loadUnsyncedTabs();
                }
            },

            openGroupInNewWindow(group, tab = {}) {
                BG.Windows.create(undefined, group.id, tab.id); // BG need because this popup will unload after win open and code not work
            },

            openGroupSettings(group) {
                this.groupToEdit = group;
            },
            async removeGroup(group) {
                if (this.options.showConfirmDialogBeforeGroupDelete) {
                    let ok = await this.showConfirm(this.lang('deleteGroup'), this.lang('confirmDeleteGroup', utils.safeHtml(group.title)), 'delete', 'is-danger');

                    if (!ok) {
                        return;
                    }
                }

                this.groups.splice(this.groups.indexOf(group), 1);

                if (this.groupToShow) {
                    this.showSectionDefault();
                }

                await BG.Groups.remove(group.id);

                if (!this.currentGroup) {
                    this.loadUnsyncedTabs();
                }
            },
            getTabIdsForMove(tabId) {
                if (tabId && !this.multipleTabIds.includes(tabId)) {
                    this.multipleTabIds.push(tabId);
                }

                let tabs = this.multipleTabIds;

                this.multipleTabIds = [];

                return tabs;
            },
            async moveTabs(tabId, groupId, loadUnsync = false, showTabAfterMoving, discardTabs) {
                let tabIds = this.getTabIdsForMove(tabId);

                await BG.Tabs.move(tabIds, groupId, undefined, false, showTabAfterMoving);

                if (discardTabs) {
                    Tabs.discard(tabIds);
                }

                if (loadUnsync) {
                    this.loadUnsyncedTabs();
                }
            },
            async moveTabToNewGroup(tabId, loadUnsync, showTabAfterMoving) {
                await this.createNewGroup(this.getTabIdsForMove(tabId), showTabAfterMoving);

                if (loadUnsync) {
                    this.loadUnsyncedTabs();
                }
            },
            setTabIconAsGroupIcon({favIconUrl}) {
                Groups.setIconUrl(this.groupToShow.id, favIconUrl);
            },

            getTabTitle: utils.getTabTitle,
            isTabLoading: utils.isTabLoading,
            getGroupTitle: utils.getGroupTitle,
            getLastActiveTabTitle: utils.getLastActiveTabTitle,
            getLastActiveTabContainer: utils.getLastActiveTabContainer,
            groupTabsCountMessage: utils.groupTabsCountMessage,

            openOptionsPage() {
                delete window.localStorage.optionsSection;
                browser.runtime.openOptionsPage().catch(e => console.error('cant open options page:', e));
                this.closeWindow();
            },
            openManageGroups() {
                BG.openManageGroups();
                this.closeWindow();
            },
            sortGroups(vector) {
                Groups.sort(vector);
            },
            exportGroupToBookmarks({id}) {
                BG.exportGroupToBookmarks(id);
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

            scrollToActiveElement(event) {
                if (-1 == event.target.tabIndex) {
                    return;
                }

                setTimeout(() => {
                    this.$nextTick(() => {
                        if (this.groupToEdit || this.dragData) {
                            return;
                        }

                        utils.scrollTo(document.activeElement);
                    });
                }, 150);
            },

            focusToNextElement(event) {
                event.preventDefault();

                let nodes = [...document.querySelectorAll('#result .group, #result .tab')],
                    focusedNodeIndex = nodes.findIndex(node => node === document.activeElement),
                    activeNodeIndex = nodes.findIndex(node => node.classList.contains('is-active-element')),
                    nextIndex = -1,
                    textPosition = null;

                if (KeyEvent.DOM_VK_UP === event.keyCode) {
                    textPosition = 'prev';
                } else if (KeyEvent.DOM_VK_DOWN === event.keyCode) {
                    textPosition = 'next';
                }

                if (!textPosition) {
                    throw Error('wrong key for this func');
                }

                if (-1 !== focusedNodeIndex) {
                    nextIndex = utils.getNextIndex(focusedNodeIndex, nodes.length, textPosition);
                } else if (-1 !== activeNodeIndex) {
                    nextIndex = utils.getNextIndex(activeNodeIndex, nodes.length, textPosition);
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
        },
    }
</script>

<template>
    <div
        id="stg-popup"
        :class="['no-outline', {'edit-group-popup': !!groupToEdit, 'is-sidebar': isSidebar}]"
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
        <header class="is-flex is-align-items-center">
            <div id="search-wrapper" class="is-full-width">
                <div :class="['field', {'has-addons': searchDelay.length}]">
                    <div :class="['control is-expanded', {'is-loading': searchDelayTimer}]">
                        <input
                            type="text"
                            class="input search-input"
                            ref="search"
                            v-model.trim="searchDelay"
                            autocomplete="off"
                            @keyup.enter="selectFirstItemOnSearch"
                            @keydown.down="focusToNextElement"
                            @keydown.up="focusToNextElement"
                            @input="searchDelay.length ? null : showSectionDefault()"
                            :placeholder="lang('searchOrGoToActive')" />
                    </div>
                    <template v-if="searchDelay.length">
                        <div v-show="!searchOnlyGroups" class="control">
                            <label class="button" :title="lang('extendedTabSearch')">
                                <input type="checkbox" v-model="extendedSearch" />
                            </label>
                        </div>
                        <div class="control">
                            <button :class="['button', {'is-active': searchOnlyGroups}]" @click="searchOnlyGroups = !searchOnlyGroups" v-text="lang('searchOnlyGroups')"></button>
                        </div>
                    </template>
                </div>
            </div>
            <div
                tabindex="0"
                @click="createNewGroup()"
                @keyup.enter="createNewGroup()"
                :title="lang('createNewGroup')"
            >
                <div class="item-icon">
                    <img class="size-16" src="/icons/group-new.svg" />
                </div>
            </div>
            <div
                class="h-margin-left-10"
                tabindex="0"
                @click="openManageGroups"
                @keyup.enter="openManageGroups"
                :title="lang('manageGroupsTitle')"
            >
                <img class="size-16" src="/icons/icon.svg" />
            </div>
            <div
                class="h-margin-left-10"
                tabindex="0"
                @click="openOptionsPage"
                @keyup.enter="openOptionsPage"
                :title="lang('openSettings')"
                @contextmenu="$refs.settingsContextMenu.open($event)"
            >
                <img class="size-16" src="/icons/settings.svg" />
            </div>
        </header>

        <main id="result" :class="['is-full-width', dragData ? 'drag-' + dragData.itemType : false]">
            <!-- SEARCH TABS -->
            <div v-if="section === SECTION_SEARCH">
                <div v-if="filteredGroups.length">
                    <div v-for="group in filteredGroups" :key="group.id">
                        <div
                            :class="['group item is-unselectable', {
                                'is-active-element': group === currentGroup,
                                'is-opened': isOpenedGroup(group),
                            }]"
                            @contextmenu="$refs.contextMenuGroup.open($event, {group})"

                            @click="!group.isArchive && applyGroup(group)"
                            @keyup.enter="!group.isArchive && applyGroup(group)"
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
                                <div class="item-title clip-text">
                                    <figure v-if="group.newTabContainer !== DEFAULT_COOKIE_STORE_ID" class="image is-16x16">
                                        <img
                                            :src="containers[group.newTabContainer].iconUrl"
                                            :style="{fill: containers[group.newTabContainer].colorCode}" />
                                    </figure>
                                    <figure v-if="group.isArchive" class="image is-16x16">
                                        <img src="/icons/archive.svg" />
                                    </figure>
                                    <figure
                                        v-if="showMuteIconGroup(group)"
                                        class="image is-16x16"
                                        @click.stop="toggleMuteGroup(group)"
                                        :title="group.tabs.some(tab => tab.audible) ? lang('muteGroup') : lang('unMuteGroup')"
                                        >
                                        <img
                                            :src="group.tabs.some(tab => tab.audible) ? '/icons/audio.svg' : '/icons/audio-mute.svg'"
                                            class="align-text-bottom" />
                                    </figure>
                                    <span v-text="getGroupTitle(group)"></span>
                                    <span
                                        v-if="options.showExtendGroupsPopupWithActiveTabs && !group.isArchive"
                                        :class="['tab-title', {bordered: getLastActiveTabContainer(group.tabs)}]"
                                        :style="{borderColor: getLastActiveTabContainer(group.tabs, 'colorCode')}"
                                        v-text="getLastActiveTabTitle(group.tabs)"></span>
                                </div>
                                <div class="item-action bold-hover is-unselectable" @click.stop="showSectionGroupTabs(group)">
                                    <img class="size-16 rotate-180" src="/icons/arrow-left.svg" />
                                    <span class="tabs-text" v-text="groupTabsCountMessage(group.tabs, group.isArchive, false)"></span>
                                </div>
                        </div>

                        <template v-if="group.isArchive">
                            <div v-for="(tab, index) in group.filteredTabs" :key="index"
                                class="tab item is-unselectable space-left"
                                :title="getTabTitle(tab, true)"
                                >
                                <div class="item-icon">
                                    <img v-if="tab.favIconUrl.startsWith('/')" :src="tab.favIconUrl" class="size-16" />
                                    <img v-else v-lazy="tab.favIconUrl" class="size-16" />
                                </div>
                                <div class="item-title clip-text">
                                    <span :class="{bordered: !!tab.container}" :style="tab.container ? {borderColor: tab.container.colorCode} : false">
                                        <template v-if="tab.container">
                                            <span :title="tab.container.name">
                                                <img :src="tab.container.iconUrl" class="size-16 align-text-bottom" :style="{fill: tab.container.colorCode}" />
                                            </span>
                                        </template>
                                        <span class="tab-discarded" v-text="getTabTitle(tab)"></span>
                                    </span>
                                </div>
                            </div>
                        </template>

                        <template v-else>
                            <div v-for="(tab, index) in group.filteredTabs" :key="index"
                                @contextmenu="$refs.contextMenuTab.open($event, {tab, group})"
                                @click.stop="clickOnTab($event, tab, group)"
                                @keyup.enter="clickOnTab($event, tab, group)"
                                @keyup.delete="removeTab(tab)"
                                @keydown.up="focusToNextElement"
                                @keydown.down="focusToNextElement"
                                tabindex="0"
                                @mousedown.middle.prevent
                                @mouseup.middle.prevent="removeTab(tab)"
                                :class="['tab item is-unselectable space-left', {
                                    'is-active-element': group === currentGroup && tab.active,
                                    'is-multiple-tab-to-move': multipleTabIds.includes(tab.id),
                                }]"
                                :title="getTabTitle(tab, true)"
                                >
                                <div class="item-icon">
                                    <img v-if="isTabLoading(tab)" src="/icons/refresh.svg" class="spin size-16 align-text-bottom" />
                                    <img v-else-if="tab.favIconUrl.startsWith('/')" :src="tab.favIconUrl" class="size-16" />
                                    <img v-else v-lazy="tab.favIconUrl" class="size-16" />
                                </div>
                                <div class="item-title clip-text">
                                    <span :class="{bordered: !!tab.container}" :style="tab.container ? {borderColor: tab.container.colorCode} : false">
                                        <span
                                            v-if="showMuteIconTab(tab)"
                                            @click.stop="toggleMuteTab(tab)"
                                            :title="tab.audible ? lang('muteTab') : lang('unMuteTab')"
                                            >
                                            <img :src="tab.audible ? '/icons/audio.svg' : '/icons/audio-mute.svg'" class="size-16 align-text-bottom" />
                                        </span>
                                        <template v-if="tab.container">
                                            <span :title="tab.container.name">
                                                <img :src="tab.container.iconUrl" class="size-16 align-text-bottom" :style="{fill: tab.container.colorCode}" />
                                            </span>
                                        </template>
                                        <span :class="{'tab-discarded': tab.discarded}" v-text="getTabTitle(tab)"></span>
                                    </span>
                                </div>
                                <div class="item-action flex-on-hover">
                                    <span class="size-16 cursor-pointer" @click.stop="removeTab(tab)" :title="lang('deleteTab')">
                                        <img src="/icons/close.svg" />
                                    </span>
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
                        @keyup.enter="!group.isArchive && applyGroup(group)"
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
                            <div class="item-title clip-text">
                                <figure class="image is-16x16" v-if="group.newTabContainer !== DEFAULT_COOKIE_STORE_ID">
                                    <img
                                        :src="containers[group.newTabContainer].iconUrl"
                                        :style="{fill: containers[group.newTabContainer].colorCode}" />
                                </figure>
                                <figure v-if="group.isArchive" class="image is-16x16">
                                    <img src="/icons/archive.svg" />
                                </figure>
                                <figure
                                    v-if="showMuteIconGroup(group)"
                                    class="image is-16x16"
                                    @click.stop="toggleMuteGroup(group)"
                                    :title="group.tabs.some(tab => tab.audible) ? lang('muteGroup') : lang('unMuteGroup')"
                                    >
                                    <img
                                        :src="group.tabs.some(tab => tab.audible) ? '/icons/audio.svg' : '/icons/audio-mute.svg'"
                                        class="align-text-bottom" />
                                </figure>
                                <span v-text="getGroupTitle(group)"></span>
                                <span
                                    v-if="options.showExtendGroupsPopupWithActiveTabs && !group.isArchive"
                                    :class="['tab-title', {bordered: getLastActiveTabContainer(group.tabs)}]"
                                    :style="{borderColor: getLastActiveTabContainer(group.tabs, 'colorCode')}"
                                    v-text="getLastActiveTabTitle(group.tabs)"></span>
                            </div>
                            <div class="item-action bold-hover is-unselectable" @click.stop="showSectionGroupTabs(group)">
                                <img class="size-16 rotate-180" src="/icons/arrow-left.svg" />
                                <span class="tabs-text" v-text="groupTabsCountMessage(group.tabs, group.isArchive, false)"></span>
                            </div>
                    </div>

                </div>

                <hr>

                <div v-if="unSyncTabs.length && !showUnSyncTabs">
                    <hr>
                    <div class="item" tabindex="0" @click="showUnSyncTabs = true" @keyup.enter="showUnSyncTabs = true">
                        <div class="item-icon">
                            <img class="size-16" src="/icons/arrow-down.svg" />
                        </div>
                        <div class="item-title" v-text="lang('showOtherTabs')"></div>
                    </div>
                </div>

                <div v-if="unSyncTabs.length && showUnSyncTabs" class="not-sync-tabs">
                    <hr>
                    <p class="h-margin-bottom-10">
                        <span v-text="lang('foundHiddenUnSyncTabsDescription')"></span>
                        <ul>
                            <li>
                                <a tabindex="0" @click="unsyncHiddenTabsMoveToCurrentGroup" @keyup.enter="unsyncHiddenTabsMoveToCurrentGroup" v-text="lang('actionHiddenUnSyncTabsMoveAllTabsToCurrentGroup')"></a>
                            </li>
                            <li v-if="unSyncWindowTabs.length && countWindowsUnSyncTabs.length > 1">
                                <a tabindex="0" @click="unsyncHiddenWindowTabsCreateNewGroup" @keyup.enter="unsyncHiddenWindowTabsCreateNewGroup" v-text="lang('actionHiddenUnSyncWindowTabsCreateGroup')"></a>
                            </li>
                            <li>
                                <a tabindex="0" @click="unsyncHiddenTabsCreateNewGroupAll" @keyup.enter="unsyncHiddenTabsCreateNewGroupAll" v-text="lang('actionHiddenUnSyncTabsCreateGroup')"></a>
                            </li>
                            <li>
                                <a tabindex="0" @click="unsyncHiddenTabsCloseAll" @keyup.enter="unsyncHiddenTabsCloseAll" v-text="lang('actionHiddenUnSyncTabsCloseAll')"></a>
                            </li>
                        </ul>
                    </p>
                    <div>
                        <div v-for="tab in unSyncTabs" :key="tab.id"
                            @contextmenu="$refs.contextMenuTab.open($event, {tab})"
                            @click.stop="($event.ctrlKey || $event.metaKey || $event.shiftKey) ? clickOnTab($event, tab) : unsyncHiddenTabsShowTabIntoCurrentWindow(tab)"
                            @keyup.enter="($event.ctrlKey || $event.metaKey || $event.shiftKey) ? clickOnTab($event, tab) : unsyncHiddenTabsShowTabIntoCurrentWindow(tab)"
                            @keydown.delete="removeTab(tab)"
                            @mousedown.middle.prevent
                            @mouseup.middle.prevent="removeTab(tab)"
                            :class="['tab item is-unselectable', {
                                'is-multiple-tab-to-move': multipleTabIds.includes(tab.id),
                            }]"
                            :title="getTabTitle(tab, true)"
                            tabindex="0"
                            >
                            <div class="item-icon">
                                <img v-if="isTabLoading(tab)" src="/icons/refresh.svg" class="spin size-16 align-text-bottom" />
                                <img v-else-if="tab.favIconUrl.startsWith('/')" :src="tab.favIconUrl" class="size-16" />
                                <img v-else v-lazy="tab.favIconUrl" class="size-16" />
                            </div>
                            <div class="item-title clip-text">
                                <span :class="{bordered: !!tab.container}" :style="tab.container ? {borderColor: tab.container.colorCode} : false">
                                    <span
                                        v-if="showMuteIconTab(tab)"
                                        @click.stop="toggleMuteTab(tab)"
                                        :title="tab.audible ? lang('muteTab') : lang('unMuteTab')"
                                        >
                                        <img :src="tab.audible ? '/icons/audio.svg' : '/icons/audio-mute.svg'" class="size-16 align-text-bottom" />
                                    </span>
                                    <template v-if="tab.container">
                                        <span :title="tab.container.name">
                                            <img :src="tab.container.iconUrl" class="size-16 align-text-bottom" :style="{fill: tab.container.colorCode}" />
                                        </span>
                                    </template>
                                    <span :class="{'tab-discarded': tab.discarded}" v-text="getTabTitle(tab)"></span>
                                </span>
                            </div>
                            <div class="item-action flex-on-hover">
                                <span class="size-16 cursor-pointer" @click.stop="removeTab(tab)" :title="lang('deleteTab')">
                                    <img src="/icons/close.svg" />
                                </span>
                            </div>
                        </div>

                    </div>
                </div>
            </div>

            <!-- GROUP -->
            <div v-if="section === SECTION_GROUP_TABS" class="tabs-list">
                <div class="item is-unselectable" tabindex="0" @click="showSectionDefault" @keyup.enter="showSectionDefault">
                    <span class="item-icon">
                        <img class="size-16" src="/icons/arrow-left.svg" />
                    </span>
                    <span class="item-title" v-text="lang('goBackToGroupsButtonTitle')"></span>
                </div>

                <hr>

                <div class="group-info item no-hover">
                    <div class="item-icon">
                        <img :src="groupToShow.iconUrlToDisplay" class="is-inline-block size-16" />
                    </div>
                    <div class="item-title clip-text">
                        <template v-if="groupToShow.newTabContainer !== DEFAULT_COOKIE_STORE_ID">
                            <img
                                :src="containers[groupToShow.newTabContainer].iconUrl"
                                :style="{fill: containers[groupToShow.newTabContainer].colorCode}"
                                :title="containers[groupToShow.newTabContainer].name"
                                class="size-16"
                                />
                        </template>
                        <img v-if="groupToShow.isArchive" src="/icons/archive.svg" class="size-16" />
                        <span class="group-title" v-text="getGroupTitle(groupToShow)"></span>
                    </div>
                    <div class="item-action is-unselectable">
                        <span tabindex="0" @click="openGroupSettings(groupToShow)" @keyup.enter="openGroupSettings(groupToShow)" class="size-16 cursor-pointer" :title="lang('groupSettings')">
                            <img src="/icons/settings.svg" />
                        </span>
                        <span tabindex="0" @click="removeGroup(groupToShow)" @keyup.enter="removeGroup(groupToShow)" class="size-16 cursor-pointer" :title="lang('deleteGroup')">
                            <img src="/icons/group-delete.svg" />
                        </span>
                    </div>
                </div>

                <template v-if="groupToShow.isArchive">
                    <div
                        v-for="(tab, tabIndex) in groupToShow.tabs"
                        :key="tabIndex"
                        class="tab item is-unselectable"
                        :title="getTabTitle(tab, true)"
                        @mousedown.middle.prevent
                        >
                        <div class="item-icon">
                            <img v-if="tab.favIconUrl.startsWith('/')" :src="tab.favIconUrl" class="size-16" />
                            <img v-else v-lazy="tab.favIconUrl" class="size-16" />
                        </div>
                        <div class="item-title clip-text">
                            <span :class="{bordered: !!tab.container}" :style="tab.container ? {borderColor: tab.container.colorCode} : false">
                                <template v-if="tab.container">
                                    <span :title="tab.container.name">
                                        <img :src="tab.container.iconUrl" class="size-16 align-text-bottom" :style="{fill: tab.container.colorCode}" />
                                    </span>
                                </template>
                                <span class="tab-discarded" v-text="getTabTitle(tab)"></span>
                            </span>
                        </div>
                    </div>
                </template>

                <template v-else>
                    <div
                        v-for="(tab, tabIndex) in groupToShow.tabs"
                        :key="tabIndex"
                        :data-tab-id="tab.id"
                        @contextmenu="$refs.contextMenuTab.open($event, {tab, group: groupToShow})"
                        @click.stop="clickOnTab($event, tab, groupToShow)"
                        @keyup.enter="clickOnTab($event, tab, groupToShow)"
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
                        }]"
                        :title="getTabTitle(tab, true)"

                        draggable="true"
                        @dragstart="dragHandle($event, 'tab', ['tab'], {item: tab, group: groupToShow})"
                        @dragenter="dragHandle($event, 'tab', ['tab'], {item: tab, group: groupToShow})"
                        @dragover="dragHandle($event, 'tab', ['tab'], {item: tab, group: groupToShow})"
                        @dragleave="dragHandle($event, 'tab', ['tab'], {item: tab, group: groupToShow})"
                        @drop="dragHandle($event, 'tab', ['tab'], {item: tab, group: groupToShow})"
                        @dragend="dragHandle($event, 'tab', ['tab'], {item: tab, group: groupToShow})"
                        >
                        <div class="item-icon">
                            <img v-if="isTabLoading(tab)" src="/icons/refresh.svg" class="spin size-16 align-text-bottom" />
                            <img v-else-if="tab.favIconUrl.startsWith('/')" :src="tab.favIconUrl" class="size-16" />
                            <img v-else v-lazy="tab.favIconUrl" class="size-16" />
                        </div>
                        <div class="item-title clip-text">
                            <span :class="{bordered: !!tab.container}" :style="tab.container ? {borderColor: tab.container.colorCode} : false">
                                <span
                                    v-if="showMuteIconTab(tab)"
                                    @click.stop="toggleMuteTab(tab)"
                                    :title="tab.audible ? lang('muteTab') : lang('unMuteTab')"
                                    >
                                    <img :src="tab.audible ? '/icons/audio.svg' : '/icons/audio-mute.svg'" class="size-16 align-text-bottom" />
                                </span>
                                <template v-if="tab.container">
                                    <span :title="tab.container.name">
                                        <img :src="tab.container.iconUrl" class="size-16 align-text-bottom" :style="{fill: tab.container.colorCode}" />
                                    </span>
                                </template>
                                <span :class="{'tab-discarded': tab.discarded}" v-text="getTabTitle(tab)"></span>
                            </span>
                        </div>
                        <div class="item-action flex-on-hover">
                            <span class="size-16 cursor-pointer" @click.stop="removeTab(tab)" :title="lang('deleteTab')">
                                <img src="/icons/close.svg" />
                            </span>
                        </div>
                    </div>

                    <hr>

                    <div class="create-new-tab">
                        <div class="item" tabindex="0" @contextmenu="$refs.contextMenuTabNew.open($event, {group: groupToShow})" @click="addTab(groupToShow)" @keyup.enter="addTab(groupToShow)">
                            <div class="item-icon">
                                <img class="size-16" src="/icons/tab-new.svg">
                            </div>
                            <div class="item-title" v-text="lang('createNewTab')"></div>
                        </div>
                    </div>
                </template>

            </div>
        </main>

        <context-menu ref="settingsContextMenu">
            <ul class="is-unselectable">
                <li @click="showArchivedGroupsInPopup = !showArchivedGroupsInPopup">
                    <img :src="showArchivedGroupsInPopup ? '/icons/check-square.svg' : '/icons/square.svg'" class="size-16" />
                    <span v-text="lang('showArchivedGroups')"></span>
                </li>
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
            @save-group="() => $refs.editGroup.saveGroup()"
            >
            <edit-group
                ref="editGroup"
                :groupId="groupToEdit.id"
                :can-load-file="isSidebar"
                @saved="groupToEdit = null"
                @open-manage-groups="openManageGroups"/>
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
                <input v-model.trim="promptValue" type="text" class="input" ref="promptInput" @keyup.enter.stop="promptResolveFunc(true)" />
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

    </div>
</template>

<style lang="scss">
    :root {
        --popup-width: 450px;
        --max-popup-width: 100%;

        --max-popup-height: 600px;
        --min-popup-height: 125px;

        --item-background-color-active: var(--color-light-gray);
        --item-background-color-hover: var(--color-gray);
        --item-background-color-active-hover: var(--color-dark-gray);

        --footer-background-color: var(--item-background-color-active);
        --footer-background-hover-color: var(--item-background-color-hover);
    }

    #loading {
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        left: 0;
        height: 100vh;
        width: 100vw;
        background-color: #ffffff;
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 1;
        opacity: .9;

        > img {
            width: 30px;
        }
    }

    html {
        width: var(--popup-width);
        min-height: var(--min-popup-height);
        max-width: var(--max-popup-width);
        min-width: 200px;
        // max-height: calc(var(--max-popup-height) - 10px);
        overflow-x: hidden;

        &.full-popup-width {
            --popup-width: 800px;

            .group.item .item-action {
                width: 100px;
                min-width: 100px;
            }
        }
    }

    html[data-theme="dark"] {
        --item-background-color-active: #686869;
        --item-background-color-hover: var(--input-background-color);
        --item-background-color-active-hover: #4b4b4b;

        --footer-background-color: var(--item-background-color-active-hover);
        --footer-background-hover-color: var(--item-background-color-hover);
    }

    #stg-popup {
        --footer-height: 45px;

        &.is-sidebar {
            --max-popup-height: 100vh;
            --min-popup-height: 100vh;
            display: flex;
            flex-direction: column;

            > main {
                flex-grow: 1;
                padding-bottom: calc(var(--footer-height) + 10px);
            }

            > footer > :not(.is-vertical-separator) {
                height: var(--footer-height);
            }
        }

        width: var(--popup-width);
        min-height: var(--min-popup-height);
        max-height: var(--max-popup-height);
        max-width: var(--max-popup-width);

        overflow-y: auto;
        // margin: 0 auto;

        scrollbar-width: thin;

        &.edit-group-popup {
            min-height: var(--max-popup-height);
        }

        > footer {
            position: sticky;
            bottom: 0;
            height: var(--footer-height);
            margin-top: var(--indent);
            align-items: center;
            background-color: var(--footer-background-color);

            > :hover {
                background-color: var(--footer-background-hover-color);
            }

            .manage-groups span {
                flex-grow: 1;
            }

            > *:not(.is-vertical-separator) {
                padding: 0 20px;
            }

            .is-vertical-separator {
                background-color: var(--color-hr);
                width: 1px;
                height: 75%;
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
    }

    /* END HELPERS */
    #search-wrapper {
        padding: var(--indent);
    }

    .item {
        display: flex;
        flex-direction: row;
        flex-wrap: nowrap;
        align-items: center;
        cursor: default;
        height: 28px;
        min-height: 28px;
        padding-left: var(--indent);

        &.space-left {
            padding-left: calc(var(--indent) * 2);
        }

        > :last-child {
            padding-right: var(--indent);
        }

        &.is-active-element:before,
        &.is-opened:before,
        &.is-multiple-tab-to-move:before {
            content: '';
            position: absolute;
            background-color: var(--in-content-border-focus);
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

        .item-icon {
            position: relative;
            width: 20px;
            max-width: 20px;
            min-width: 20px;
            text-align: center;
            line-height: 1;
        }

        .item-title {
            flex-grow: 1;
            white-space: nowrap;
            overflow: hidden;
            padding-left: 5px;
            padding-right: 5px;
            cursor: default;
            display: flex;
            align-items: center;

            > * + * {
                margin-left: 5px;
            }

            .tab-title {
                opacity: 0.4;
            }
        }

        .item-action {
            display: flex;
            align-items: center;
            align-self: stretch;
            padding-left: 5px;
            white-space: nowrap;
        }

        .item-action > :not(:first-child) {
            margin-left: 3px;
        }

        .flex-on-hover {
            display: none;
        }

        &:hover .flex-on-hover {
            display: flex;
        }
    }

    .tabs-list .group-info.item .item-title {
        justify-content: center;

        > img {
            pointer-events: auto;
        }
    }

    .group-title {
        max-width: 100%;
    }

    .group,
    .tab {
        position: relative;
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

    .bordered {
        border-bottom-right-radius: 5px;
        border-bottom-left-radius: 5px;
        border-bottom-width: 1px;
        border-bottom-style: solid;
        max-width: 100%;
        overflow: hidden;
        vertical-align: middle;
    }

    .not-sync-tabs > p {
        padding: 0 var(--indent);
    }


    /* media */
    /*
    @media screen and (min-height: 600px) {
        #stg-popup {
            padding-right: 17px;
        }
    }
     */


</style>
