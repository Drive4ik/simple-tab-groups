<script>
    'use strict';

    import Vue from 'vue';
    import VueLazyload from 'vue-lazyload';

    import utils from '../js/utils';
    import Groups from '../js/groups';
    import Tabs from '../js/tabs';
    import Windows from '../js/windows';
    import popup from '../js/popup.vue';
    import editGroupPopup from './edit-group-popup.vue';
    import editGroup from '../js/edit-group.vue';
    import contextMenu from '../js/context-menu-component.vue';

    const {BG} = browser.extension.getBackgroundPage();

    if (!BG.inited) {
        browser.runtime.onMessage.addListener(({action}) => 'i-am-back' === action && window.location.reload());
        throw 'Background not inited, waiting...';
    }

    window.addEventListener('error', utils.errorEventHandler);
    Vue.config.errorHandler = utils.errorEventHandler;

    Vue.use(VueLazyload);

    Vue.config.keyCodes = {
        'arrow-left': KeyEvent.DOM_VK_LEFT,
        'arrow-up': KeyEvent.DOM_VK_UP,
        'arrow-right': KeyEvent.DOM_VK_RIGHT,
        'arrow-down': KeyEvent.DOM_VK_DOWN,
        'enter': KeyEvent.DOM_VK_RETURN,
        'tab': KeyEvent.DOM_VK_TAB,
        'delete': KeyEvent.DOM_VK_DELETE,
        'f3': KeyEvent.DOM_VK_F3,
    };

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
        availableTabKeys = ['id', 'url', 'title', 'favIconUrl', 'status', 'index', 'discarded', 'active', 'cookieStoreId', 'lastAccessed'],
        isSidebar = '#sidebar' === window.location.hash;

    let loadPromise = null;

    export default {
        data() {
            return {
                isSidebar: isSidebar,

                TEMPORARY_CONTAINER: BG.containers.TEMPORARY_CONTAINER,

                SECTION_SEARCH,
                SECTION_GROUPS_LIST,
                SECTION_GROUP_TABS,

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

                groupToShow: null,
                groupToEdit: null,
                groupToRemove: null,

                containers: BG.containers.getAll(),
                options: {},
                groups: [],

                showUnSyncTabs: false,
                unSyncTabs: [],

                multipleTabIds: [],
            };
        },
        components: {
            popup: popup,
            'edit-group-popup': editGroupPopup,
            'edit-group': editGroup,
            'context-menu': contextMenu,
        },
        created() {
            this.loadOptions();

            loadPromise = Promise.all([this.loadCurrentWindow(), this.loadGroups(), this.loadUnsyncedTabs()]);
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
        },
        computed: {
            currentGroup() {
                return this.currentWindow && this.groups.find(group => group.id === this.currentWindow.groupId);
            },
            filteredGroupsBySearch() {
                if (!this.search) {
                    return [];
                }

                let searchStr = this.search.toLowerCase(),
                    groups = [];

                this.groups.forEach(function(group) {
                    group.filteredTabsBySearch = group.tabs.filter(tab => utils.mySearchFunc(searchStr, utils.getTabTitle(tab, true), this.extendedSearch));

                    if (group.filteredTabsBySearch.length || utils.mySearchFunc(searchStr, group.title, this.extendedSearch)) {
                        group.filteredTabsBySearch.sort(this.$_simpleSortTabs.bind(null, searchStr));
                        groups.push(group);
                    }
                }, this);

                return groups;
            },
        },
        methods: {
            lang: browser.i18n.getMessage,
            safeHtml: utils.safeHtml,

            async loadCurrentWindow() {
                this.currentWindow = await Windows.get(undefined, false);
            },

            loadOptions() {
                this.options = BG.getOptions();
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

                        Tabs.move(tabIds, to.data.group.id, to.data.item.index, false);
                    })
                    .$on('drag-moving', (item, isMoving) => item.isMoving = isMoving)
                    .$on('drag-over', (item, isOver) => item.isOver = isOver);

                browser.runtime.onMessage.addListener(async function(request) {

                    switch (request.action) {
                        case 'tabs-added':
                            {
                                let group = this.groups.find(gr => gr.id === request.groupId);

                                if (group) {
                                    group.tabs.push(...request.tabs.map(this.mapTab));
                                    group.tabs.sort(utils.sortBy('index'));
                                } else {
                                    throw Error(utils.errorEventMessage('group for new tabs not found', request));
                                }
                            }

                            break;
                        case 'tab-updated':
                            {
                                let tab = null;

                                this.groups.some(gr => tab = gr.tabs.find(t => t.id === request.tab.id));

                                if (!tab) {
                                    tab = this.unSyncTabs.find(t => t.id === request.tab.id);
                                }

                                if (tab) {
                                    Object.assign(tab, request.tab);
                                }
                            }

                            break;
                        case 'tabs-removed':
                            {
                                this.groups
                                    .filter(group => !group.isArchive)
                                    .forEach(group => group.tabs = group.tabs.filter(tab => !request.tabIds.includes(tab.id)));

                                this.unSyncTabs = this.unSyncTabs.filter(tab => !request.tabIds.includes(tab.id));

                                this.multipleTabIds = this.multipleTabIds.filter(tabId => !request.tabIds.includes(tabId));
                            }

                            break;
                        case 'group-updated':
                            let group = this.groups.find(gr => gr.id === request.group.id);

                            if (request.group.tabs) {
                                request.group.tabs = request.group.tabs.map(this.mapTab, this);
                            }

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
                            this.loadGroups();
                            this.loadUnsyncedTabs();
                            this.loadCurrentWindow();
                            break;
                        case 'group-loaded':
                            await this.loadCurrentWindow();

                            if (this.options.openGroupAfterChange) {
                                if (this.currentGroup && this.currentGroup.id === request.groupId && this.groupToShow !== this.currentGroup) {
                                    this.showSectionGroupTabs(this.currentGroup);
                                }
                            }
                            break;
                        case 'options-updated':
                            this.loadOptions();
                            break;
                        case 'containers-updated':
                            this.containers = BG.containers.getAll();
                            break;
                    }
                }.bind(this));
            },

            showSectionGroupTabs(group) {
                this.groupToShow = group;
                this.search = '';
                this.section = SECTION_GROUP_TABS;
                this.setFocusOnActive();
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
                    group.tabs = Object.freeze(group.tabs.map(BG.utils.normalizeTabFavIcon));
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
                                iconUrl: this.iconUrl,
                                iconColor: this.iconColor,
                                iconViewType: this.iconViewType,
                            });
                        },
                    },
                });
            },

            mapTab(tab) {
                Object.keys(tab).forEach(key => !availableTabKeys.includes(key) && delete tab[key]);

                tab = BG.utils.normalizeTabFavIcon(tab);

                tab.container = BG.containers.isDefault(tab.cookieStoreId) ? false : BG.containers.get(tab.cookieStoreId);

                tab.isMoving = false;
                tab.isOver = false;

                return new Vue({
                    data: tab,
                });
            },

            getWindowId: BG.cache.getWindowId,

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

            discardGroup({tabs}) {
                Tabs.discard(tabs.map(utils.keyId));
            },

            discardOtherGroups(groupExclude) {
                let tabIds = this.groups.reduce(function(acc, gr) {
                    let groupTabIds = (gr.id === groupExclude.id || gr.isArchive || BG.cache.getWindowId(gr.id)) ? [] : gr.tabs.map(utils.keyId);

                    return [...acc, ...groupTabIds];
                }, []);

                Tabs.discard(tabIds);
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
                if (group.tabs.length) {
                    Tabs.reload(group.tabs.map(utils.keyId), bypassCache);
                }
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
                            tabs = this.filteredGroupsBySearch.reduce((acc, group) => [...acc, ...group.filteredTabsBySearch], []);
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
                let hiddenTabsIds = this.unSyncTabs.map(utils.keyId);

                await Tabs.moveNative(this.unSyncTabs, {
                    windowId: this.currentWindow.id,
                    index: -1,
                });

                await BG.browser.tabs.show(hiddenTabsIds);

                if (this.currentGroup) {
                    this.unSyncTabs = [];
                }

                this.loadGroups();
            },
            async unsyncHiddenTabsCreateNewGroup() {
                await this.createNewGroup(this.unSyncTabs.map(utils.keyId), undefined, this.unSyncTabs[0].title);

                this.unSyncTabs = [];
            },
            unsyncHiddenTabsCloseAll() {
                Tabs.remove(this.unSyncTabs.map(utils.keyId));

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

                await Tabs.move(tabIds, groupId, undefined, false, showTabAfterMoving);

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
                let groups = this.filteredGroupsBySearch.filter(group => !group.isArchive);

                if (!groups.length) {
                    return;
                }

                let [group] = groups,
                    [tab] = group.filteredTabsBySearch;

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
                        @keydown.arrow-down="focusToNextElement"
                        @keydown.arrow-up="focusToNextElement"
                        :placeholder="lang('searchPlaceholder')" />
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
                <div v-if="filteredGroupsBySearch.length">
                    <div v-for="group in filteredGroupsBySearch" :key="group.id">
                        <div
                            :class="['group item is-unselectable', {
                                'is-active': group === currentGroup,
                                'is-opened': getWindowId(group.id),
                            }]"
                            @contextmenu="$refs.groupContextMenu.open($event, {group})"

                            @click="!group.isArchive && applyGroup(group)"
                            @keyup.enter="!group.isArchive && applyGroup(group)"
                            @keydown.arrow-right="showSectionGroupTabs(group)"
                            @keydown.arrow-up="focusToNextElement"
                            @keydown.arrow-down="focusToNextElement"
                            @keydown.f2.stop="renameGroup(group)"
                            tabindex="0"
                            :title="getGroupTitle(group, 'withCountTabs withTabs withContainer')"
                            >
                                <div class="item-icon">
                                    <img :src="group.iconUrlToDisplay" class="is-inline-block size-16" />
                                </div>
                                <div class="item-title">
                                    <template v-if="group.newTabContainer">
                                        <img
                                            :src="containers[group.newTabContainer].iconUrl"
                                            :style="{fill: containers[group.newTabContainer].colorCode}"
                                            class="size-16"
                                            />
                                    </template>
                                    <template v-if="group.isArchive">
                                        <img src="/icons/archive.svg" class="size-16" />
                                    </template>
                                    <span v-text="getGroupTitle(group, options.showExtendGroupsPopupWithActiveTabs ? 'withActiveTab' : '')"></span>
                                </div>
                                <div class="item-action bold-hover is-unselectable" @click.stop="showSectionGroupTabs(group)">
                                    <img class="size-16 rotate-180" src="/icons/arrow-left.svg" />
                                    <span class="tabs-text" v-text="groupTabsCountMessage(group.tabs, group.isArchive)"></span>
                                </div>
                        </div>

                        <template v-if="group.isArchive">
                            <div v-for="(tab, index) in group.filteredTabsBySearch" :key="index"
                                class="tab item is-unselectable space-left"
                                :title="getTabTitle(tab, true)"
                                >
                                <div class="item-icon">
                                    <img v-lazy="tab.favIconUrl" class="size-16" />
                                </div>
                                <div class="item-title">
                                    <span :class="{bordered: !!tab.container}" :style="tab.container ? {borderColor: tab.container.colorCode} : false">
                                        <span v-if="isTabLoading(tab)">
                                            <img src="/icons/refresh.svg" class="spin size-16 align-text-bottom" />
                                        </span>
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
                            <div v-for="(tab, index) in group.filteredTabsBySearch" :key="index"
                                @contextmenu="$refs.tabsContextMenu.open($event, {tab, group})"
                                @click.stop="clickOnTab($event, tab, group)"
                                @keyup.enter="clickOnTab($event, tab, group)"
                                @keyup.delete="removeTab(tab)"
                                @keydown.arrow-up="focusToNextElement"
                                @keydown.arrow-down="focusToNextElement"
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
                                    <img v-lazy="tab.favIconUrl" class="size-16" />
                                </div>
                                <div class="item-title">
                                    <span :class="{bordered: !!tab.container}" :style="tab.container ? {borderColor: tab.container.colorCode} : false">
                                        <span v-if="isTabLoading(tab)">
                                            <img src="/icons/refresh.svg" class="spin size-16 align-text-bottom" />
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
                <div class="groups">
                    <div
                        v-for="group in groups"
                        :key="group.id"
                        :class="['group item is-unselectable', {
                            'drag-moving': group.isMoving,
                            'drag-over': group.isOver,
                            'is-active': group === currentGroup,
                            'is-opened': getWindowId(group.id),
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
                        @keydown.arrow-right="showSectionGroupTabs(group)"
                        @keydown.arrow-up="focusToNextElement"
                        @keydown.arrow-down="focusToNextElement"
                        @keydown.f2.stop="renameGroup(group)"
                        tabindex="0"
                        :title="getGroupTitle(group, 'withCountTabs withTabs withContainer')"
                        >
                            <div class="item-icon">
                                <img :src="group.iconUrlToDisplay" class="is-inline-block size-16" />
                            </div>
                            <div class="item-title">
                                <template v-if="group.newTabContainer">
                                    <img
                                        :src="containers[group.newTabContainer].iconUrl"
                                        :style="{fill: containers[group.newTabContainer].colorCode}"
                                        class="size-16"
                                        />
                                </template>
                                <template v-if="group.isArchive">
                                    <img src="/icons/archive.svg" class="size-16" />
                                </template>
                                <span v-text="getGroupTitle(group, options.showExtendGroupsPopupWithActiveTabs ? 'withActiveTab' : '')"></span>
                            </div>
                            <div class="item-action bold-hover is-unselectable" @click.stop="showSectionGroupTabs(group)">
                                <img class="size-16 rotate-180" src="/icons/arrow-left.svg" />
                                <span class="tabs-text" v-text="groupTabsCountMessage(group.tabs, group.isArchive)"></span>
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
                        <span v-text="lang('foundHiddenUnSyncTabsDescription')"></span><br>
                        <a tabindex="0" @click="unsyncHiddenTabsMoveToCurrentGroup" @keyup.enter="unsyncHiddenTabsMoveToCurrentGroup" v-text="lang('actionHiddenUnSyncTabsMoveAllTabsToCurrentGroup')"></a><br>
                        <a tabindex="0" @click="unsyncHiddenTabsCreateNewGroup" @keyup.enter="unsyncHiddenTabsCreateNewGroup" v-text="lang('actionHiddenUnSyncTabsCreateGroup')"></a><br>
                        <a tabindex="0" @click="unsyncHiddenTabsCloseAll" @keyup.enter="unsyncHiddenTabsCloseAll" v-text="lang('actionHiddenUnSyncTabsCloseAll')"></a>
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
                                <img v-lazy="tab.favIconUrl" class="size-16" />
                            </div>
                            <div class="item-title">
                                <span :class="{bordered: !!tab.container}" :style="tab.container ? {borderColor: tab.container.colorCode} : false">
                                    <span v-if="isTabLoading(tab)">
                                        <img src="/icons/refresh.svg" class="spin size-16 align-text-bottom" />
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
                    <div class="item-title">
                        <template v-if="groupToShow.newTabContainer">
                            <img
                                :src="containers[groupToShow.newTabContainer].iconUrl"
                                :style="{fill: containers[groupToShow.newTabContainer].colorCode}"
                                :title="containers[groupToShow.newTabContainer].name"
                                class="size-16"
                                />
                        </template>
                        <template v-if="groupToShow.isArchive">
                            <img src="/icons/archive.svg" class="size-16" />
                        </template>
                        <span v-text="getGroupTitle(groupToShow)"></span>
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
                            <img v-lazy="tab.favIconUrl" class="size-16" />
                        </div>
                        <div class="item-title">
                            <span :class="{bordered: !!tab.container}" :style="tab.container ? {borderColor: tab.container.colorCode} : false">
                                <span v-if="isTabLoading(tab)">
                                    <img src="/icons/refresh.svg" class="spin size-16 align-text-bottom" />
                                </span>
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
                        @keydown.arrow-left="showSectionDefault"
                        @keydown.arrow-up="focusToNextElement"
                        @keydown.arrow-down="focusToNextElement"
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
                            <img v-lazy="tab.favIconUrl" class="size-16" />
                        </div>
                        <div class="item-title">
                            <span :class="{bordered: !!tab.container}" :style="tab.container ? {borderColor: tab.container.colorCode} : false">
                                <span v-if="isTabLoading(tab)">
                                    <img src="/icons/refresh.svg" class="spin size-16 align-text-bottom" />
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

        <footer v-if="!isSidebar" class="is-flex is-unselectable">
            <div tabindex="0" class="is-flex is-align-items-center manage-groups is-full-height is-full-width" @click="openManageGroups" @keyup.enter="openManageGroups" :title="lang('manageGroupsTitle')">
                <img class="size-16" src="/icons/icon.svg" />
                <span class="h-margin-left-10" v-text="lang('manageGroupsTitle')"></span>
            </div>
            <div class="is-flex is-align-items-center is-vertical-separator"></div>
            <div tabindex="0" class="is-flex is-align-items-center is-full-height" @click="openOptionsPage" @keyup.enter="openOptionsPage" :title="lang('openSettings')">
                <img class="size-16" src="/icons/settings.svg" />
            </div>
        </footer>

        <context-menu ref="createNewTabContextMenu">
            <ul class="is-unselectable">
                <li v-for="container in containers" :key="container.cookieStoreId" @click="addTab(container.cookieStoreId)">
                    <img :src="container.iconUrl" class="is-inline-block size-16" :style="{fill: container.colorCode}" />
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
                    <li :class="{'is-disabled': menu.data.group.isArchive}" @click="!menu.data.group.isArchive && reloadAllTabsInGroup(menu.data.group, $event.ctrlKey || $event.metaKey)">
                        <img src="/icons/refresh.svg" class="size-16" />
                        <span v-text="lang('reloadAllTabsInGroup')"></span>
                    </li>
                    <li :class="{'is-disabled': menu.data.group.isArchive}" @click="!menu.data.group.isArchive && discardGroup(menu.data.group)">
                        <img src="/icons/snowflake.svg" class="size-16" />
                        <span v-text="lang('discardGroupTitle')"></span>
                    </li>
                    <li v-if="groups.length > 1" @click="discardOtherGroups(menu.data.group)">
                        <img src="/icons/snowflake.svg" class="size-16" />
                        <span v-text="lang('discardOtherGroups')"></span>
                    </li>
                    <li @click="renameGroup(menu.data.group)">
                        <img src="/icons/edit.svg" class="size-16" />
                        <span v-text="lang('hotkeyActionTitleRenameGroup') + ' (F2)'"></span>
                    </li>

                    <hr>

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
        --popup-width: 432px;
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
        font-size: 13px;
        width: var(--popup-width);
        min-height: var(--min-popup-height);
        max-width: var(--max-popup-width);
        min-width: 200px;
        // max-height: calc(var(--max-popup-height) - 10px);
        overflow-x: hidden;
    }

    html.dark-theme {
        --item-background-color-active: #686869;
        --item-background-color-hover: var(--input-background-color);
        --item-background-color-active-hover: #4b4b4b;

        --footer-background-color: var(--item-background-color-active-hover);
        --footer-background-hover-color: var(--item-background-color-hover);
    }

    #stg-popup {
        &.is-sidebar {
            --max-popup-height: 100vh;
            --min-popup-height: 100vh;

            #result > * {
                padding-bottom: var(--indent);
            }
        }

        width: var(--popup-width);
        min-height: var(--min-popup-height);
        max-height: var(--max-popup-height);
        max-width: var(--max-popup-width);

        overflow-y: auto;
        // margin: 0 auto;

        &.edit-group-popup {
            min-height: var(--max-popup-height);
        }

        > footer {
            position: sticky;
            bottom: 0;
            height: 45px;
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
            text-overflow: ellipsis;
            padding-left: 5px;
            padding-right: 5px;
            cursor: default;

            img {
                vertical-align: text-bottom;
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
            margin-left: 5px;
        }

        .flex-on-hover {
            display: none;
        }

        &:hover .flex-on-hover {
            display: flex;
        }
    }

    .tabs-list .group-info.item .item-title {
        text-align: center;
    }

    .group,
    .tab {
        position: relative;
    }

    .group .tabs-text {
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .groups .item .item-action {
        width: 100px;
        min-width: 100px;
    }

    .bordered {
        display: inline-block;
        border-bottom-right-radius: 5px;
        border-bottom-left-radius: 5px;
        border-bottom-width: 1px;
        border-bottom-style: solid;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
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
