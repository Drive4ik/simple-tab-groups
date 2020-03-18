<script>
    'use strict';

    import Vue from 'vue';
    import VueLazyload from 'vue-lazyload';

    import popup from '../js/popup.vue';
    import editGroup from '../js/edit-group.vue';
    import contextMenu from '../js/context-menu-component.vue';

    // import dnd from '../js/dnd';
    // import { Drag, Drop } from 'vue-drag-drop';
    // import draggable from 'vuedraggable';

    document.title = browser.i18n.getMessage('manageGroupsTitle');

    if (!BG.inited) {
        browser.runtime.onMessage.addListener(({action}) => 'i-am-back' === action && window.location.reload());
        throw 'waiting background initialization...';
    }

    Vue.config.errorHandler = errorEventHandler;

    Vue.use(VueLazyload);

    const VIEW_GRID = 'grid',
        VIEW_DEFAULT = VIEW_GRID,
        availableTabKeys = new Set(['id', 'url', 'title', 'favIconUrl', 'status', 'index', 'discarded', 'active', 'cookieStoreId', 'thumbnail']);

    export default {
        data() {
            return {
                VIEW_GRID,

                view: VIEW_DEFAULT,

                showPromptPopup: false,
                promptTitle: null,
                promptValue: '',
                promptResolveFunc: null,

                isLoaded: false,

                search: '',
                extendedSearch: false,

                currentWindow: null,

                groupToEdit: null,
                groupToRemove: null,

                containers: containers.getAll(),
                options: {},

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

            // Drag: Drag,
            // Drop: Drop,
            // draggable: draggable,
            // dnd: dnd,
        },
        // directives: {
        //     dnd: dnd,
        // },
        // async created() {
        //     this.loadOptions();
        // },
        async mounted() {
            await this.loadCurrentWindow();

            this.loadOptions();

            await this.loadGroups();

            await this.loadUnsyncedTabs();

            this.setupListeners();

            this.isLoaded = true;

            this.$nextTick(function() {
                this.setFocusOnSearch();

                if (this.options.showTabsWithThumbnailsInManageGroups) {
                    this.groups.forEach(function(group) {
                        if (!group.isArchive) {
                            group.tabs.forEach(function(tab) {
                                if (!tab.thumbnail && !tab.discarded && utils.isTabLoaded(tab)) {
                                    Tabs.updateThumbnail(tab.id);
                                }
                            });
                        }
                    });
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
            'options.showTabsWithThumbnailsInManageGroups': function(value, oldValue) {
                if (undefined !== oldValue) {
                    BG.saveOptions({
                        showTabsWithThumbnailsInManageGroups: value,
                    });
                }
            },
        },
        computed: {
            filteredGroups() {
                let searchStr = this.search.toLowerCase();

                if (!searchStr) {
                    return this.groups.map(group => (group.filteredTabs = group.tabs, group));
                }

                return this.groups.map(group => {
                    group.filteredTabs = group.tabs.filter(tab => utils.mySearchFunc(searchStr, utils.getTabTitle(tab, true), this.extendedSearch));
                    return group;
                });
            },
            filteredUnSyncTabs() {
                let searchStr = this.search.toLowerCase();

                return this.unSyncTabs.filter(tab => utils.mySearchFunc(searchStr, utils.getTabTitle(tab, true), this.extendedSearch));
            },
            isCurrentWindowIsAllow() {
                return this.currentWindow && utils.isWindowAllow(this.currentWindow);
            },
            currentGroup() {
                if (!this.isCurrentWindowIsAllow) {
                    return null;
                }

                return this.groups.find(group => group.id === this.currentWindow.groupId);
            },
        },
        methods: {
            lang: browser.i18n.getMessage,
            safeHtml: utils.safeHtml,

            setFocusOnSearch() {
                this.$nextTick(() => this.$refs.search.focus());
            },

            loadOptions() {
                this.options = BG.getOptions();
            },

            async loadCurrentWindow() {
                this.currentWindow = await Windows.get(undefined, false);
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
                            let tabIds = this.getTabIdsForMove(),
                                groupId = this.isGroup(to.data.item) ? to.data.item.id : to.data.group.id,
                                index = this.isGroup(to.data.item) ? undefined : to.data.item.index;

                            Tabs.move(tabIds, groupId, index, false);
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
                        this.unSyncTabs = this.unSyncTabs.filter(tab => !tabIds.includes(tab.id));

                        tabIds.forEach(tabId => {
                            let tabIndex = -1,
                                group = this.groups.find(gr => !gr.isArchive && -1 !== (tabIndex = gr.tabs.findIndex(tab => tab.id === tabId)));

                            if (group) {
                                group.tabs.splice(tabIndex, 1);
                            }
                        });
                    }, 150, lazyRemoveTabIds);
                };

                let lazyAddGroupTabTimer = {},
                    lazyAddUnsyncTabTimer = 0;
                const lazyAddTab = (tab, groupId) => {
                    tab = this.mapTab(cache.applyTabSession(tab));

                    let group = groupId ? this.groups.find(gr => gr.id === groupId) : null;

                    if (group) {
                        group.tabs.push(tab);

                        clearTimeout(lazyAddGroupTabTimer[groupId]);
                        lazyAddGroupTabTimer[groupId] = setTimeout(group => group.tabs.sort(utils.sortBy('index')), 100, group);
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

                        tabs.forEach(tab => lazyAddTab(tab, cache.getTabSession(tab.id, 'groupId')));
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

                        if (changeInfo.title) {
                            this.allTabs[tab.id].title = changeInfo.title;
                        }

                        if (changeInfo.status) {
                            this.allTabs[tab.id].status = changeInfo.status;
                        }

                        if ('discarded' in changeInfo) {
                            this.allTabs[tab.id].discarded = changeInfo.discarded;
                        } else if (changeInfo.status) {
                            this.allTabs[tab.id].discarded = false;
                        }

                        this.allTabs[tab.id].lastAccessed = tab.lastAccessed;
                    }

                    if (BG.excludeTabsIds.has(tab.id)) {
                        return;
                    }

                    if ('pinned' in changeInfo || 'hidden' in changeInfo) {
                        let tabGroupId = cache.getTabSession(tab.id, 'groupId'),
                            winGroupId = cache.getWindowGroup(tab.windowId);

                        if (changeInfo.pinned || changeInfo.hidden) {
                            if (tabGroupId) {
                                removeTab(tab.id);
                            }
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
                    if (BG.excludeTabsIds.has(tabId)) {
                        return;
                    }

                    let groupId = cache.getWindowGroup(oldWindowId);

                    if (groupId) {
                        clearTimeout(onDetachedTabTimer);
                        onDetachedTabTimer = setTimeout(groupId => this.loadGroupTabs(groupId), 100, groupId);
                    }
                };

                let onAttachedTabTimer = 0,
                    onAttachedUnsyncTabTimer = 0,
                    onAttachedTabWinTimer = 0;
                const onAttachedTab = (tabId, {newWindowId}) => {
                    if (BG.excludeTabsIds.has(tabId)) {
                        return;
                    }

                    clearTimeout(onAttachedTabWinTimer);
                    onAttachedTabWinTimer = setTimeout(() => this.loadCurrentWindow());

                    let groupId = cache.getWindowGroup(newWindowId);

                    if (groupId) {
                        clearTimeout(onAttachedTabTimer);
                        onAttachedTabTimer = setTimeout(groupId => this.loadGroupTabs(groupId), 100, groupId);
                    } else {
                        clearTimeout(onAttachedUnsyncTabTimer);
                        onAttachedUnsyncTabTimer = setTimeout(() => this.loadUnsyncedTabs(), 100);
                    }
                };

                const onMessage = async request => {
                    switch (request.action) {
                        case 'group-updated':
                            let group = this.groups.find(gr => gr.id === request.group.id);
                            Object.assign(group, request.group);
                            break;
                        case 'group-added':
                            this.groups.push(this.mapGroup(request.group));
                            break;
                        case 'group-removed':
                            let groupIndex = this.groups.findIndex(gr => gr.id === request.groupId);

                            if (-1 !== groupIndex) {
                                this.groups.splice(groupIndex, 1);
                            }

                            break;
                        case 'groups-updated':
                        case 'group-unloaded':
                            this.loadGroups();
                            this.loadUnsyncedTabs();
                            this.loadCurrentWindow();
                            break;
                        case 'group-loaded':
                            this.loadCurrentWindow();
                            break;
                        case 'options-updated':
                            this.loadOptions();
                            break;
                        case 'containers-updated':
                            this.containers = containers.getAll();
                            break;
                        case 'thumbnail-updated':
                            let foundTab = this.groups.some(group => {
                                let tab = group.tabs.find(tab => tab.id === request.tabId);

                                if (tab) {
                                    this.$set(tab, 'thumbnail', request.thumbnail);
                                    return true;
                                }
                            });

                            if (!foundTab) {
                                this.loadUnsyncedTabs();
                            }

                            break;
                    }
                };

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
                browser.runtime.onMessage.addListener(onMessage);

                window.addEventListener('unload', function() {
                    browser.tabs.onCreated.removeListener(onCreatedTab);
                    browser.tabs.onUpdated.removeListener(onUpdatedTab);
                    browser.tabs.onRemoved.removeListener(onRemovedTab);
                    browser.tabs.onActivated.removeListener(onActivatedTab);
                    browser.tabs.onMoved.removeListener(onMovedTab);
                    browser.tabs.onDetached.removeListener(onDetachedTab);
                    browser.tabs.onAttached.removeListener(onAttachedTab);
                    browser.runtime.onMessage.removeListener(onMessage);
                });

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

            async loadGroupTabs(groupId) {
                let [{tabs}] = await Groups.load(groupId, true),
                    group = this.groups.find(gr => gr.id === groupId);

                group.tabs = tabs.map(this.mapTab, this);
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

                await Tabs.move(tabIds, groupId, undefined, false, showTabAfterMoving);

                if (discardTabs) {
                    Tabs.discard(tabIds);
                }

                if (loadUnsync) {
                    this.loadUnsyncedTabs();
                }
            },
            async moveTabToNewGroup(tabId, loadUnsync, showTabAfterMoving) {
                let newGroupTitle = '',
                    tabIds = this.getTabIdsForMove(tabId);

                if (this.options.alwaysAskNewGroupName) {
                    newGroupTitle = await Groups.getNextTitle();

                    newGroupTitle = await this.showPrompt(this.lang('createNewGroup'), newGroupTitle);

                    if (!newGroupTitle) {
                        return;
                    }
                }

                await Groups.add(undefined, tabIds, newGroupTitle, showTabAfterMoving);

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

            mapGroup(group) {
                if (group.isArchive) {
                    group.tabs = Object.freeze(group.tabs.map(utils.normalizeTabFavIcon));
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
                            Groups.update(this.id, {
                                title: utils.createGroupTitle(title, this.id),
                            });
                        },
                    },
                    computed: {
                        iconUrlToDisplay() {
                            return utils.getGroupIconUrl({
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

                if (tab.url === window.location.href) {
                    tab.status = browser.tabs.TabStatus.COMPLETE;
                }

                tab.container = containers.isDefault(tab.cookieStoreId) ? false : containers.get(tab.cookieStoreId);

                tab.isMoving = false;
                tab.isOver = false;

                return this.allTabs[tab.id] = new Vue({
                    data: tab,
                });
            },

            async loadGroups() {
                let groups = await Groups.load(null, true);

                this.groups = groups.map(this.mapGroup, this);

                this.multipleTabIds = [];
            },
            async loadUnsyncedTabs() {
                let windows = await Windows.load(true);

                this.unSyncTabs = windows
                    .reduce(function(acc, win) {
                        win.tabs.forEach(tab => !tab.groupId && acc.push(tab));
                        return acc;
                    }, [])
                    .map(this.mapTab, this);
            },
            addGroup() {
                Groups.add();
            },

            addTab(group, cookieStoreId) {
                Tabs.add(group.id, cookieStoreId);
            },
            removeTab(tab) {
                Tabs.remove(this.getTabIdsForMove(tab.id));
            },
            updateTabThumbnail({id}) {
                Tabs.updateThumbnail(id, true);
            },
            discardTab(tab) {
                Tabs.discard(this.getTabIdsForMove(tab.id));
            },
            discardGroup({tabs}) {
                Tabs.discard(tabs.map(utils.keyId));
            },
            discardOtherGroups(groupExclude) {
                let tabIds = this.groups.reduce(function(acc, gr) {
                    let groupTabIds = (gr.id === groupExclude.id || gr.isArchive || cache.getWindowId(gr.id)) ? [] : gr.tabs.map(utils.keyId);

                    acc.push(...groupTabIds);

                    return acc;
                }, []);

                Tabs.discard(tabIds);
            },
            reloadTab(tab, bypassCache) {
                Tabs.reload(this.getTabIdsForMove(tab.id), bypassCache);
            },
            async applyGroup(groupId, tabId, openInNewWindow = false) {
                if (!this.isCurrentWindowIsAllow) {
                    await browser.windows.update(this.currentWindow.id, {
                        state: browser.windows.WindowState.MINIMIZED,
                    });
                }

                if (openInNewWindow) {
                    await BG.Windows.create(undefined, groupId, tabId);
                } else {
                    await BG.applyGroup(null, groupId, tabId);
                }

                if (!this.isCurrentWindowIsAllow) {
                    this.closeThisWindow();
                }
            },

            getWindowId: cache.getWindowId,

            async clickOnTab(event, tab, group) {
                if (event.ctrlKey || event.metaKey) {
                    if (this.multipleTabIds.includes(tab.id)) {
                        this.multipleTabIds.splice(this.multipleTabIds.indexOf(tab.id), 1);
                    } else {
                        this.multipleTabIds.push(tab.id);
                    }
                } else if (event.shiftKey) {
                    if (this.multipleTabIds.length) {
                        let tabIds = group ? group.filteredTabs.map(utils.keyId) : this.filteredUnSyncTabs.map(utils.keyId),
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
                    this.applyGroup(group.id, tab.id);
                } else if (this.isCurrentWindowIsAllow) {
                    await Tabs.moveNative([tab], {
                        windowId: this.currentWindow.id,
                        index: -1,
                    });

                    await browser.tabs.show(tab.id);

                    this.loadUnsyncedTabs();
                }
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
            onSubmitRemoveGroup(group) {
                this.groups.splice(this.groups.indexOf(group), 1);

                this.groupToRemove = null;

                BG.Groups.remove(group.id);
            },
            setTabIconAsGroupIcon({favIconUrl}, group) {
                Groups.update(group.id, {
                    iconViewType: null,
                    iconUrl: favIconUrl,
                });
            },

            getTabTitle: utils.getTabTitle,
            getGroupTitle: utils.getGroupTitle,
            isTabLoading: utils.isTabLoading,

            isGroup(obj) {
                return 'tabs' in obj;
            },

            sortGroups(vector) {
                Groups.sort(vector);
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

            groupTabsCountMessage(tabs, groupIsArchived) {
                return utils.groupTabsCountMessage(tabs, groupIsArchived, true);
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
            <span class="is-full-width">
                <div>
                    <label class="checkbox">
                        <input v-model="options.showTabsWithThumbnailsInManageGroups" type="checkbox" />
                        <span v-text="lang('showTabsWithThumbnailsInManageGroups')"></span>
                    </label>
                </div>
                <div class="buttons has-addons" style="display: none;">
                    <span class="button is-small is-primary" v-text="lang('manageGroupViewGrid')"></span>
                    <span class="button is-small" disabled v-text="lang('manageGroupViewFreeArrange')"></span>
                </div>
            </span>
            <span>
                <div id="search-wrapper" :class="['field', {'has-addons': search}]">
                    <div class="control is-expanded">
                        <input
                            type="text"
                            class="input is-small search-input"
                            ref="search"
                            @click.stop
                            :placeholder="lang('searchPlaceholder')"
                            :readonly="!isLoaded"
                            v-model.trim="search" />
                    </div>
                    <div v-show="search" class="control">
                        <label class="button is-small" :title="lang('extendedTabSearch')">
                            <input type="checkbox" v-model="extendedSearch" />
                        </label>
                    </div>
                </div>
            </span>
        </header>

        <transition name="fade">
            <main id="result" v-show="isLoaded">
                <!-- GRID -->
                <div v-if="view === VIEW_GRID" :class="['grid',
                        dragData ? 'drag-' + dragData.itemType : false,
                    ]">


                    <!--

                        v-dnd:group.group="{item: group}"

                        TODO move to dnd.js

                    -->


                    <div
                        v-for="group in filteredGroups"
                        :key="group.id"
                        :class="['group', {
                            'is-archive': group.isArchive,
                            'drag-moving': group.isMoving,
                            'drag-over': group.isOver,
                            'loaded': getWindowId(group.id),
                        }]"
                        @contextmenu="'INPUT' !== $event.target.nodeName && !group.isArchive && $refs.groupContextMenu.open($event, {group})"

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
                                <figure class="image is-16x16">
                                    <img :src="group.iconUrlToDisplay" />
                                </figure>
                            </div>
                            <div class="group-icon" v-if="group.newTabContainer">
                                <figure class="image is-16x16">
                                    <img
                                        :src="containers[group.newTabContainer].iconUrl"
                                        :style="{fill: containers[group.newTabContainer].colorCode}"
                                        class="size-16"
                                        />
                                </figure>
                            </div>
                            <div class="group-icon" v-if="group.isArchive">
                                <figure class="image is-16x16">
                                    <img src="/icons/archive.svg" class="size-16"/>
                                </figure>
                            </div>
                            <div class="group-title">
                                <input
                                    type="text"
                                    class="input is-small"
                                    @focus="group.draggable = false"
                                    @blur="group.draggable = true"
                                    v-model.lazy.trim="group.title"
                                    :placeholder="lang('title')"
                                    />
                            </div>
                            <div class="tabs-count" v-text="groupTabsCountMessage(group.filteredTabs, group.isArchive)"></div>
                            <div class="group-icon cursor-pointer is-unselectable" @click="openGroupSettings(group)" :title="lang('groupSettings')">
                                <img class="size-16" src="/icons/settings.svg" />
                            </div>
                            <div class="group-icon cursor-pointer is-unselectable" @click="removeGroup(group)" :title="lang('deleteGroup')">
                                <img class="size-16" src="/icons/group-delete.svg" />
                            </div>
                        </div>
                        <div :class="['body', {
                                'in-list-view': !options.showTabsWithThumbnailsInManageGroups,
                            }]">
                            <div
                                v-for="(tab, index) in group.filteredTabs"
                                :key="index"
                                :class="['tab', {
                                    'is-active': tab.active,
                                    'is-in-multiple-drop': multipleTabIds.includes(tab.id),
                                    'has-thumbnail': options.showTabsWithThumbnailsInManageGroups && tab.thumbnail,
                                    'drag-moving': tab.isMoving,
                                    'drag-over': tab.isOver,
                                }]"
                                :title="getTabTitle(tab, true)"
                                @contextmenu.stop.prevent="!group.isArchive && $refs.tabsContextMenu.open($event, {tab, group})"

                                @click.stop="!group.isArchive && clickOnTab($event, tab, group)"

                                :draggable="String(!group.isArchive)"
                                @dragstart="dragHandle($event, 'tab', ['tab', 'group'], {item: tab, group})"
                                @dragenter="dragHandle($event, 'tab', ['tab', 'group'], {item: tab, group})"
                                @dragover="dragHandle($event, 'tab', ['tab', 'group'], {item: tab, group})"
                                @dragleave="dragHandle($event, 'tab', ['tab', 'group'], {item: tab, group})"
                                @drop="dragHandle($event, 'tab', ['tab', 'group'], {item: tab, group})"
                                @dragend="dragHandle($event, 'tab', ['tab', 'group'], {item: tab, group})"
                                >
                                <div class="tab-icon" :style="tab.container ? {borderColor: tab.container.colorCode} : false">
                                    <img v-if="tab.favIconUrl.startsWith('/')" :src="tab.favIconUrl" class="size-16" />
                                    <img v-else class="size-16" v-lazy="tab.favIconUrl" />
                                </div>
                                <div v-if="isTabLoading(tab)" class="refresh-icon" :style="tab.container ? {borderColor: tab.container.colorCode} : false">
                                    <img class="spin size-16" src="/icons/refresh.svg"/>
                                </div>
                                <template v-if="tab.container">
                                    <div class="cookie-container" :title="tab.container.name" :style="{borderColor: tab.container.colorCode}">
                                        <img class="size-16" :src="tab.container.iconUrl" :style="{fill: tab.container.colorCode}">
                                    </div>
                                </template>
                                <div v-if="options.showTabsWithThumbnailsInManageGroups" class="screenshot" :style="tab.container ? {borderColor: tab.container.colorCode} : false">
                                    <img v-if="tab.thumbnail" v-lazy="tab.thumbnail">
                                </div>
                                <div
                                    @mousedown.middle.prevent
                                    @mouseup.middle.prevent="!group.isArchive && removeTab(tab)"
                                    class="tab-title text-ellipsis"
                                    :style="tab.container ? {borderColor: tab.container.colorCode} : false"
                                    v-text="getTabTitle(tab, false, 0, true)"></div>

                                <div v-if="!group.isArchive" class="delete-tab-button" @click.stop="removeTab(tab)" :title="lang('deleteTab')" :style="tab.container ? {borderColor: tab.container.colorCode} : false">
                                    <img class="size-14" src="/icons/close.svg" />
                                </div>
                            </div>

                            <div
                                v-if="!group.isArchive"
                                class="tab new"
                                :title="lang('createNewTab')"
                                @click="addTab(group)"
                                >
                                <div :class="options.showTabsWithThumbnailsInManageGroups ? 'screenshot' : 'tab-icon'">
                                    <img src="/icons/tab-new.svg">
                                </div>
                                <div class="tab-title text-ellipsis" v-text="lang('createNewTab')"></div>
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
                                }]"
                                :title="getTabTitle(tab, true)"
                                @contextmenu.stop.prevent="$refs.tabsContextMenu.open($event, {tab})"

                                @click.stop="clickOnTab($event, tab)"

                                draggable="true"
                                @dragstart="dragHandle($event, 'tab', ['tab', 'group'], {item: tab})"
                                @dragend="dragHandle($event, 'tab', ['tab', 'group'], {item: tab})"
                                >
                                <div class="tab-icon" :style="tab.container ? {borderColor: tab.container.colorCode} : false">
                                    <img v-if="tab.favIconUrl.startsWith('/')" :src="tab.favIconUrl" class="size-16" />
                                    <img v-else class="size-16" v-lazy="tab.favIconUrl" />
                                </div>
                                <div v-if="isTabLoading(tab)" class="refresh-icon" :style="tab.container ? {borderColor: tab.container.colorCode} : false">
                                    <img class="spin size-16" src="/icons/refresh.svg"/>
                                </div>
                                <template v-if="tab.container">
                                    <div class="cookie-container" :title="tab.container.name" :style="{borderColor: tab.container.colorCode}">
                                        <img class="size-16" :src="tab.container.iconUrl" :style="{fill: tab.container.colorCode}">
                                    </div>
                                </template>
                                <div v-if="options.showTabsWithThumbnailsInManageGroups" class="screenshot" :style="tab.container ? {borderColor: tab.container.colorCode} : false">
                                    <img v-if="tab.thumbnail" v-lazy="tab.thumbnail">
                                </div>
                                <div
                                    @mousedown.middle.prevent
                                    @mouseup.middle.prevent="removeTab(tab)"
                                    class="tab-title text-ellipsis"
                                    :style="tab.container ? {borderColor: tab.container.colorCode} : false"
                                    v-text="getTabTitle(tab, false, 0, true)"></div>

                                <div class="delete-tab-button" @click.stop="removeTab(tab)" :title="lang('deleteTab')" :style="tab.container ? {borderColor: tab.container.colorCode} : false">
                                    <img class="size-14" src="/icons/close.svg" />
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
        </transition>

        <transition name="fade">
            <div class="loading spin" v-show="!isLoaded">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
                    <path d="M288 39.056v16.659c0 10.804 7.281 20.159 17.686 23.066C383.204 100.434 440 171.518 440 256c0 101.689-82.295 184-184 184-101.689 0-184-82.295-184-184 0-84.47 56.786-155.564 134.312-177.219C216.719 75.874 224 66.517 224 55.712V39.064c0-15.709-14.834-27.153-30.046-23.234C86.603 43.482 7.394 141.206 8.003 257.332c.72 137.052 111.477 246.956 248.531 246.667C393.255 503.711 504 392.788 504 256c0-115.633-79.14-212.779-186.211-240.236C302.678 11.889 288 23.456 288 39.056z"></path>
                </svg>
            </div>
        </transition>

        <div id="multipleTabsText"></div>

        <context-menu ref="groupContextMenu">
            <template v-slot="menu">
                <ul v-if="menu.data" class="is-unselectable">
                    <li @click="addTab(menu.data.group)">
                        <img src="/icons/tab-new.svg" class="size-16" />
                        <span v-text="lang('createNewTab')"></span>
                    </li>
                    <li v-if="menu.data.group !== currentGroup" @click="discardGroup(menu.data.group)">
                        <img src="/icons/snowflake.svg" class="size-16" />
                        <span v-text="lang('hotkeyActionTitleDiscardGroup')"></span>
                    </li>
                    <li v-if="groups.length > 1" @click="discardOtherGroups(menu.data.group)">
                        <img src="/icons/snowflake.svg" class="size-16" />
                        <span v-text="lang('hotkeyActionTitleDiscardOtherGroups')"></span>
                    </li>

                    <hr>

                    <li v-for="container in containers" :key="container.cookieStoreId" @click="addTab(menu.data.group, container.cookieStoreId)">
                        <img :src="container.iconUrl" class="is-inline-block size-16" :style="{fill: container.colorCode}" />
                        <span v-text="container.name"></span>
                    </li>
                </ul>
            </template>
        </context-menu>

        <context-menu ref="tabsContextMenu">
            <template v-slot="menu">
                <ul v-if="menu.data" class="is-unselectable">
                    <li v-if="menu.data.group" @click="applyGroup(menu.data.group.id, menu.data.tab.id, true)">
                        <img src="/icons/window-new.svg" class="size-16" />
                        <span v-text="lang('openGroupInNewWindow')"></span>
                    </li>
                    <li @click="reloadTab(menu.data.tab, $event.ctrlKey || $event.metaKey)">
                        <img src="/icons/refresh.svg" class="size-16" />
                        <span v-text="lang('reloadTab')"></span>
                    </li>
                    <li v-if="multipleTabIds.length" @click="removeTab(menu.data.tab)">
                        <img src="/icons/close.svg" class="size-16" />
                        <span v-text="lang('deleteTab')"></span>
                    </li>
                    <li v-if="!menu.data.tab.discarded" @click="discardTab(menu.data.tab)">
                        <img src="/icons/snowflake.svg" class="size-16" />
                        <span v-text="lang('discardTabTitle')"></span>
                    </li>
                    <li v-if="menu.data.group && menu.data.group !== currentGroup" @click="discardGroup(menu.data.group)">
                        <img src="/icons/snowflake.svg" class="size-16" />
                        <span v-text="lang('hotkeyActionTitleDiscardGroup')"></span>
                    </li>
                    <li v-if="menu.data.group && groups.length > 1" @click="discardOtherGroups(menu.data.group)">
                        <img src="/icons/snowflake.svg" class="size-16" />
                        <span v-text="lang('hotkeyActionTitleDiscardOtherGroups')"></span>
                    </li>
                    <li v-if="options.showTabsWithThumbnailsInManageGroups" @click="updateTabThumbnail(menu.data.tab)">
                        <img src="/icons/image.svg" class="size-16" />
                        <span v-text="lang('updateTabThumbnail')"></span>
                    </li>
                    <li v-if="menu.data.group" @click="setTabIconAsGroupIcon(menu.data.tab, menu.data.group)">
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
                        :class="{'is-disabled': group.isArchive}"
                        @click="!group.isArchive && moveTabs(menu.data.tab.id, group.id, !menu.data.group, undefined, $event.ctrlKey || $event.metaKey)"
                        @contextmenu="!group.isArchive && moveTabs(menu.data.tab.id, group.id, !menu.data.group, true)"
                        >
                        <img :src="group.iconUrlToDisplay" class="is-inline-block size-16" />
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
            @save-group="() => $refs.editGroup.saveGroup()"
            >
            <edit-group
                ref="editGroup"
                :groupId="groupToEdit.id"
                @saved="groupToEdit = null" />
        </popup>

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

        --group-active-shadow: 0 0 0 3.5px rgba(3, 102, 214, 0.3);
        --group-active-border: 1px solid #2188ff;
        --group-bg-color: #f5f5f5;

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

    html.dark-theme {
        --text-color: #e0e0e0;

        --group-bg-color: #444444;
        --group-active-shadow: 0 0 0 3.5px rgba(255, 255, 255, 0.3);
        --group-active-border: 1px solid #e0e0e0;

        --tab-active-shadow: var(--group-active-shadow);
        --tab-active-border: var(--group-active-border);

        --discarded-text-color: #979797;
    }

    .fade-enter-active, .fade-leave-active {
        transition: opacity .5s;
    }
    .fade-enter, .fade-leave-to /* .fade-leave-active до версии 2.1.8 */ {
        opacity: 0;
    }

    html {
        font-size: 14px;
    }

    #stg-manage {
        padding: var(--indent) var(--indent) calc(var(--indent) * 10);

        > header {
            > :not(:first-child) {
                margin-left: 20px;
            }

            .page-title {
                font-size: 20px;
                line-height: 1;
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
        font-size: 15px;
        font-weight: bold;
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

                > .group-icon > * {
                    pointer-events: none;
                }
            }

            > .body {
                -moz-user-select: none;
                user-select: none;

                overflow-y: auto;
                padding: var(--margin);
                min-height: 110px;
                /* flex-grow: 1; */

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
                font-size: 12px;
            }

            &:not(.is-archive) .tab {
                cursor: pointer;
            }

            > .body:not(.in-list-view) > .tab {
                padding: var(--tab-inner-padding);
                border-radius: var(--border-radius);

                > * {
                    border: 0 solid var(--tab-inner-border-color);
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
                    display: none;
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
                    display: flex;
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

                &.is-active {
                    box-shadow: var(--tab-active-shadow);
                    outline: var(--tab-active-border);
                    outline-offset: -1px;
                    -moz-outline-radius: var(--border-radius);
                }

                // &:not(.is-active):not(.drag-moving):hover {
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
                }

                > .refresh-icon {
                    display: flex;
                    padding-left: var(--margin);
                }

                > .tab-title {
                    flex-grow: 1;
                    padding: 0 var(--margin);
                    border-radius: var(--border-radius);
                    border-bottom: 1px solid transparent;
                }

                &.is-active {
                    outline: var(--tab-active-border);
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

            &.loaded {
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
