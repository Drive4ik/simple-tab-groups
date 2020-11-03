<script>
    'use strict';

    import Vue from 'vue';
    import VueLazyload from 'vue-lazyload';

    import popup from '../js/popup.vue';
    import editGroupPopup from './edit-group-popup.vue';
    import editGroup from '../js/edit-group.vue';
    import contextMenu from '../js/context-menu-component.vue';

    if (!BG.inited) {
        browser.runtime.onMessage.addListener(({action}) => 'i-am-back' === action && window.location.reload());
        throw 'waiting background initialization...';
    }

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

                dragData: null,
                someGroupAreLoading: false,

                search: '',
                extendedSearch: false,

                currentWindow: null,
                openedWindows: [],

                groupToShow: null,
                groupToEdit: null,
                groupToRemove: null,

                containers: containers.getAll(true),
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
        },
        created() {
            if (!isSidebar && BG.options.fullPopupWidth) {
                document.documentElement.classList.add('full-popup-width');
            }

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
            'options.enableDarkTheme': function(enableDarkTheme) {
                if (enableDarkTheme) {
                    document.documentElement.classList.add('dark-theme');
                } else {
                    document.documentElement.classList.remove('dark-theme');
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

                if (!searchStr) {
                    return groups;
                }

                groups.forEach(group => {
                    group.filteredTabs = group.tabs.filter(tab => utils.mySearchFunc(searchStr, utils.getTabTitle(tab, true), this.extendedSearch));

                    if (group.filteredTabs.length || utils.mySearchFunc(searchStr, group.title, this.extendedSearch)) {
                        group.filteredTabs.sort(this.$_simpleSortTabs.bind(null, searchStr));
                        filteredGroups.push(group);
                    }
                });

                return filteredGroups;
            },
            unSyncWindowTabs() {
                return this.currentWindow ? this.unSyncTabs.filter(tab => tab.windowId === this.currentWindow.id) : [];
            },
        },
        methods: {
            lang: browser.i18n.getMessage,
            safeHtml: utils.safeHtml,

            async loadWindows() {
                this.currentWindow = await Windows.get(undefined, false);
                this.openedWindows = await Windows.load();
            },

            loadOptions() {
                this.options = utils.clone(BG.options);
            },

            setFocusOnSearch() {
                this.$refs.search.focus();
            },

            setFocusOnActive() {
                this.$nextTick(function() {
                    let activeItemNode = document.querySelector('.is-active');

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
                    tab = this.mapTab(tab);

                    let group = groupId ? this.groups.find(gr => gr.id === groupId) : null;

                    if (group) {
                        if (!Object.isFrozen(group.tabs)) {
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
                            Tabs.getOne(tab.id, true).then(({id, audible, mutedInfo}) => {
                                this.allTabs[id].audible = audible;
                                this.allTabs[id].mutedInfo = mutedInfo;
                            }).catch(console.error);
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
                            this.groups.push(this.mapGroup(request.group));
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
                            break;
                        case 'window-closed':
                            this.loadWindows();
                            break;
                        case 'options-updated':
                            this.loadOptions();
                            break;
                        case 'containers-updated':
                            this.containers = containers.getAll(true);
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
                this.search = '';
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
                this.search = '';
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
                tab.container = containers.get(tab.cookieStoreId);
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
                    let prevFocusedElement = document.activeElement;

                    this.promptTitle = title;
                    this.promptValue = value;

                    this.promptResolveFunc = ok => {
                        this.showPromptPopup = false;

                        if (ok && this.promptValue.length) {
                            resolve(this.promptValue);
                        } else {
                            resolve(false);
                        }

                        prevFocusedElement.focus();
                    };

                    this.showPromptPopup = true;
                });
            },

            async createNewGroup(tabIds, showTabAfterMoving, proposalTitle) {
                let newGroupTitle = '';

                if (this.options.alwaysAskNewGroupName) {
                    newGroupTitle = await Groups.getNextTitle();

                    newGroupTitle = await this.showPrompt(this.lang('createNewGroup'), proposalTitle || newGroupTitle);

                    if (!newGroupTitle) {
                        return;
                    }
                }

                Groups.add(undefined, tabIds, newGroupTitle, showTabAfterMoving);
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

            addTab(cookieStoreId) {
                Tabs.add(this.groupToShow.id, cookieStoreId);
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

            async toggleArchiveGroup({id}) {
                fullLoading(true);
                await BG.Groups.archiveToggle(id);
                fullLoading(false);
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

                    await browser.tabs.show(tabsIds);
                }

                this.loadGroups();
            },
            async unsyncHiddenWindowTabsCreateNewGroup() {
                await this.createNewGroup(this.unSyncWindowTabs.map(utils.keyId), undefined, this.unSyncWindowTabs[0].title);

                this.loadUnsyncedTabs();
            },
            async unsyncHiddenTabsCreateNewGroupAll() {
                await this.createNewGroup(this.unSyncTabs.map(utils.keyId), undefined, this.unSyncTabs[0].title);

                this.unSyncTabs = [];
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

                browser.tabs.show(tab.id);

                if (this.currentGroup) {
                    this.unSyncTabs.splice(this.unSyncTabs.indexOf(tab), 1);
                } else {
                    this.loadUnsyncedTabs();
                }
            },

            openGroupInNewWindow({id}) {
                BG.Windows.create(undefined, id); // BG need because this popup will unload after win open and code not work
            },

            openGroupSettings(group) {
                this.groupToEdit = group;
            },
            removeGroup(group) {
                if (this.options.showConfirmDialogBeforeGroupDelete) {
                    this.groupToRemove = group;
                } else {
                    this.onSubmitRemoveGroup(group);
                }
            },
            async onSubmitRemoveGroup(group) {
                this.groups.splice(this.groups.indexOf(group), 1);

                this.groupToRemove = null;

                if (this.groupToShow) {
                    this.showSectionDefault();
                }

                await Groups.remove(group.id);

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
                Groups.update(this.groupToShow.id, {
                    iconViewType: null,
                    iconUrl: favIconUrl,
                });
            },

            getTabTitle: utils.getTabTitle,
            isTabLoading: utils.isTabLoading,
            getGroupTitle: utils.getGroupTitle,
            getLastActiveTabTitle: utils.getLastActiveTabTitle,
            getLastActiveTabContainer: utils.getLastActiveTabContainer,
            groupTabsCountMessage: utils.groupTabsCountMessage,

            openOptionsPage() {
                delete window.localStorage.optionsSection;
                browser.runtime.openOptionsPage();
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
                    activeNodeIndex = nodes.findIndex(node => node.classList.contains('is-active')),
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

        >
        <header id="search-wrapper">
            <div :class="['field', {'has-addons': search}]">
                <div class="control is-expanded">
                    <input
                        type="text"
                        class="input is-small search-input"
                        ref="search"
                        v-model.trim="search"
                        @input="$refs.search.value === '' ? showSectionDefault() : null"
                        autocomplete="off"
                        @keyup.enter="selectFirstItemOnSearch"
                        @keydown.down="focusToNextElement"
                        @keydown.up="focusToNextElement"
                        :placeholder="lang('searchOrGoToActive')" />
                </div>
                <div v-show="search" class="control">
                    <label class="button is-small" :title="lang('extendedTabSearch')">
                        <input type="checkbox" v-model="extendedSearch" />
                    </label>
                </div>
            </div>
        </header>

        <main id="result" :class="['is-full-width', dragData ? 'drag-' + dragData.itemType : false]">
            <!-- SEARCH TABS -->
            <div v-if="section === SECTION_SEARCH">
                <div v-if="filteredGroups.length">
                    <div v-for="group in filteredGroups" :key="group.id">
                        <div
                            :class="['group item is-unselectable', {
                                'is-active': group === currentGroup,
                                'is-opened': isOpenedGroup(group),
                            }]"
                            @contextmenu="$refs.groupContextMenu.open($event, {group})"

                            @click="!group.isArchive && applyGroup(group)"
                            @keyup.enter="!group.isArchive && applyGroup(group)"
                            @keydown.right="showSectionGroupTabs(group)"
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
                                @contextmenu="$refs.tabsContextMenu.open($event, {tab, group})"
                                @click.stop="clickOnTab($event, tab, group)"
                                @keyup.enter="clickOnTab($event, tab, group)"
                                @keyup.delete="removeTab(tab)"
                                @keydown.up="focusToNextElement"
                                @keydown.down="focusToNextElement"
                                tabindex="0"
                                @mousedown.middle.prevent
                                @mouseup.middle.prevent="removeTab(tab)"
                                :class="['tab item is-unselectable space-left', {
                                    'is-active': group === currentGroup && tab.active,
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
                            'is-active': group === currentGroup,
                            'is-opened': isOpenedGroup(group),
                        }]"

                        draggable="true"
                        @dragstart="dragHandle($event, 'group', ['group'], {item: group})"
                        @dragenter="dragHandle($event, 'group', ['group'], {item: group})"
                        @dragover="dragHandle($event, 'group', ['group'], {item: group})"
                        @dragleave="dragHandle($event, 'group', ['group'], {item: group})"
                        @drop="dragHandle($event, 'group', ['group'], {item: group})"
                        @dragend="dragHandle($event, 'group', ['group'], {item: group})"

                        @contextmenu="$refs.groupContextMenu.open($event, {group})"
                        @click="!group.isArchive && applyGroup(group)"
                        @keyup.enter="!group.isArchive && applyGroup(group)"
                        @keydown.right.stop="showSectionGroupTabs(group); setFocusOnSearch();"
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

                <div class="create-new-group">
                    <div class="item" tabindex="0" @click="createNewGroup()" @keyup.enter="createNewGroup()">
                        <div class="item-icon">
                            <img class="size-16" src="/icons/group-new.svg" />
                        </div>
                        <div class="item-title" v-text="lang('createNewGroup')"></div>
                    </div>
                </div>

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
                            <li v-if="unSyncWindowTabs.length">
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
                            @contextmenu="$refs.tabsContextMenu.open($event, {tab})"
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
                        @contextmenu="$refs.tabsContextMenu.open($event, {tab, group: groupToShow})"
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
                            'is-active': groupToShow === currentGroup && tab.active,
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
                        <div class="item" tabindex="0" @contextmenu="$refs.createNewTabContextMenu.open($event)" @click="addTab()" @keyup.enter="addTab()">
                            <div class="item-icon">
                                <img class="size-16" src="/icons/tab-new.svg">
                            </div>
                            <div class="item-title" v-text="lang('createNewTab')"></div>
                        </div>
                    </div>
                </template>

            </div>
        </main>

        <footer class="is-flex is-unselectable">
            <div tabindex="0" class="is-flex is-align-items-center manage-groups is-full-height is-full-width" @click="openManageGroups" @keyup.enter="openManageGroups" :title="lang('manageGroupsTitle')">
                <img class="size-16" src="/icons/icon.svg" />
                <span class="h-margin-left-10" v-text="lang('manageGroupsTitle')"></span>
            </div>
            <div class="is-flex is-align-items-center is-vertical-separator"></div>
            <div
                tabindex="0"
                class="is-flex is-align-items-center is-full-height"
                @click="openOptionsPage"
                @keyup.enter="openOptionsPage"
                :title="lang('openSettings')"
                @contextmenu="$refs.settingsContextMenu.open($event)"
                >
                <img class="size-16" src="/icons/settings.svg" />
            </div>
        </footer>

        <context-menu ref="settingsContextMenu">
            <ul class="is-unselectable">
                <li @click="showArchivedGroupsInPopup = !showArchivedGroupsInPopup">
                    <img :src="showArchivedGroupsInPopup ? '/icons/check-square.svg' : '/icons/square.svg'" class="size-16" />
                    <span v-text="lang('showArchivedGroups')"></span>
                </li>
            </ul>
        </context-menu>

        <context-menu ref="createNewTabContextMenu">
            <ul class="is-unselectable" v-if="groupToShow">
                <li
                    v-for="container in containers"
                    v-if="
                        container.cookieStoreId !== DEFAULT_COOKIE_STORE_ID &&
                        (
                            groupToShow.ifDifferentContainerReOpen
                            ? (
                                groupToShow.excludeContainersForReOpen.includes(container.cookieStoreId) ||
                                groupToShow.newTabContainer === container.cookieStoreId ||
                                container.cookieStoreId === TEMPORARY_CONTAINER
                            )
                            : true
                        )
                    "
                    :key="container.cookieStoreId"
                    @click="addTab(container.cookieStoreId)"
                    >
                    <img v-if="container.iconUrl" :src="container.iconUrl" class="is-inline-block size-16" :style="{fill: container.colorCode}" />
                    <span v-text="container.name"></span>
                </li>
            </ul>
        </context-menu>

        <context-menu ref="groupContextMenu">
            <template v-slot="menu">
                <ul v-if="menu.data" class="is-unselectable">
                    <li :class="{'is-disabled': menu.data.group.isArchive}" @click="!menu.data.group.isArchive && openGroupInNewWindow(menu.data.group)">
                        <img src="/icons/window-new.svg" class="size-16" />
                        <span v-text="lang('openGroupInNewWindow')"></span>
                    </li>
                    <li :class="{'is-disabled': menu.data.group.isArchive}" @click="!menu.data.group.isArchive && reloadAllTabsInGroup(menu.data.group, $event.ctrlKey || $event.metaKey)">
                        <img src="/icons/refresh.svg" class="size-16" />
                        <span v-text="lang('reloadAllTabsInGroup')"></span>
                    </li>
                    <li @click="sortGroups('asc')">
                        <img src="/icons/sort-alpha-asc.svg" class="size-16" />
                        <span v-text="lang('sortGroupsAZ')"></span>
                    </li>
                    <li @click="sortGroups('desc')">
                        <img src="/icons/sort-alpha-desc.svg" class="size-16" />
                        <span v-text="lang('sortGroupsZA')"></span>
                    </li>
                    <li @click="exportGroupToBookmarks(menu.data.group)">
                        <img src="/icons/bookmark.svg" class="size-16" />
                        <span v-text="lang('exportGroupToBookmarks')"></span>
                    </li>
                    <li :class="{'is-disabled': menu.data.group.isArchive}" @click="!menu.data.group.isArchive && discardGroup(menu.data.group)">
                        <img src="/icons/snowflake.svg" class="size-16" />
                        <span v-text="lang('hotkeyActionTitleDiscardGroup')"></span>
                    </li>
                    <li v-if="groups.length > 1" @click="discardOtherGroups(menu.data.group)">
                        <img src="/icons/snowflake.svg" class="size-16" />
                        <span v-text="lang('hotkeyActionTitleDiscardOtherGroups')"></span>
                    </li>
                    <li @click="renameGroup(menu.data.group)">
                        <img src="/icons/edit.svg" class="size-16" />
                        <span v-text="lang('hotkeyActionTitleRenameGroup') + ' (F2)'"></span>
                    </li>

                    <hr>

                    <li :class="{'is-disabled': !isOpenedGroup(menu.data.group)}" @click="isOpenedGroup(menu.data.group) && unloadGroup(menu.data.group)">
                        <img src="/icons/upload.svg" class="size-16" />
                        <span v-text="lang('unloadGroup')"></span>
                    </li>
                    <li @click="toggleArchiveGroup(menu.data.group)">
                        <img :src="'/icons/' + (menu.data.group.isArchive ? 'unarchive' : 'archive') + '.svg'" class="size-16" />
                        <span v-text="lang(menu.data.group.isArchive ? 'unArchiveGroup' : 'archiveGroup')"></span>
                    </li>
                    <li @click="openGroupSettings(menu.data.group)">
                        <img src="/icons/settings.svg" class="size-16" />
                        <span v-text="lang('groupSettings')"></span>
                    </li>
                    <li @click="removeGroup(menu.data.group)">
                        <img src="/icons/group-delete.svg" class="size-16" />
                        <span v-text="lang('deleteGroup')"></span>
                    </li>
                </ul>
            </template>
        </context-menu>

        <context-menu ref="tabsContextMenu">
            <template v-slot="menu">
                <ul v-if="menu.data" class="is-unselectable">
                    <li @click="reloadTab(menu.data.tab, $event.ctrlKey || $event.metaKey)">
                        <img src="/icons/refresh.svg" class="size-16" />
                        <span v-text="lang('reloadTab')"></span>
                    </li>
                    <li v-if="!menu.data.tab.discarded" @click="discardTab(menu.data.tab)">
                        <img src="/icons/snowflake.svg" class="size-16" />
                        <span v-text="lang('discardTabTitle')"></span>
                    </li>
                    <li v-if="multipleTabIds.length" @click="removeTab(menu.data.tab)">
                        <img src="/icons/close.svg" class="size-16" />
                        <span v-text="lang('deleteTab')"></span>
                    </li>
                    <li v-if="menu.data.group" @click="setTabIconAsGroupIcon(menu.data.tab)">
                        <img src="/icons/image.svg" class="size-16" />
                        <span v-text="lang('setTabIconAsGroupIcon')"></span>
                    </li>

                    <hr>

                    <li class="is-disabled">
                        <img class="size-16" />
                        <span v-text="lang('moveTabToGroupDisabledTitle') + ':'"></span>
                    </li>

                    <li
                        v-for="group in groups"
                        :key="group.id"
                        v-if="!group.isArchive"
                        @click="moveTabs(menu.data.tab.id, group.id, !menu.data.group, undefined, $event.ctrlKey || $event.metaKey)"
                        @contextmenu="moveTabs(menu.data.tab.id, group.id, !menu.data.group, true)"
                        >
                        <figure :class="['image is-16x16', {'is-sticky': group.isSticky}]">
                            <img :src="group.iconUrlToDisplay" />
                        </figure>
                        <span v-text="getGroupTitle(group, 'withActiveGroup withContainer')"></span>
                    </li>

                    <li
                        @click="moveTabToNewGroup(menu.data.tab.id, !menu.data.group)"
                        @contextmenu="moveTabToNewGroup(menu.data.tab.id, !menu.data.group, true)">
                        <img src="/icons/group-new.svg" class="size-16" />
                        <span v-text="lang('createNewGroup')"></span>
                    </li>
                </ul>
            </template>
        </context-menu>

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
            v-if="groupToRemove"
            :title="lang('deleteGroupTitle')"
            @remove-group="onSubmitRemoveGroup(groupToRemove)"
            @close-popup="groupToRemove = null"
            :buttons="
                [{
                    event: 'remove-group',
                    classList: 'is-danger',
                    lang: 'delete',
                }, {
                    event: 'close-popup',
                    lang: 'cancel',
                    focused: true,
                }]
            ">
            <span v-html="lang('deleteGroupBody', safeHtml(groupToRemove.title))"></span>
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
                <input v-model.trim="promptValue" type="text" class="input" ref="promptInput" @keyup.enter.stop="promptResolveFunc(true)" />
            </div>
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

    html.dark-theme {
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

        &.is-active:before,
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

        &.is-active.is-multiple-tab-to-move:before {
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
        &.is-active {
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
