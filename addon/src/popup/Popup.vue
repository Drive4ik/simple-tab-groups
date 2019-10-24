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

    const SECTION_SEARCH = 'search',
        SECTION_GROUPS_LIST = 'groupsList',
        SECTION_GROUP_TABS = 'groupTabs',
        SECTION_DEFAULT = SECTION_GROUPS_LIST,
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

                dragData: null,
                someGroupAreLoading: false,

                nextGroupTitle: '',
                isShowingCreateGroupPopup: false,

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

                multipleTabs: [],

                enableDebug: !!window.localStorage.enableDebug,
                enableLogging: !!window.localStorage.enableLogging,
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
                document.getElementById('loading').remove();
                this.setFocusOnSearch();
                this.setupListeners();
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
                this.multipleTabs = [];
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
                return this.currentWindow && this.groups.find(group => group.id === this.currentWindow.session.groupId);
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
                this.currentWindow = await Windows.get();
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
                        let activeTab = utils.getGroupLastActiveTab(this.groupToShow);

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
                        let tabs = this.getTabsForMove(from.data.item);

                        Tabs.move(tabs, to.data.group.id, to.data.item.index, false);
                    })
                    .$on('drag-moving', (item, isMoving) => item.isMoving = isMoving)
                    .$on('drag-over', (item, isOver) => item.isOver = isOver);

                browser.runtime.onMessage.addListener(async function(request, sender) {
                    if (!utils.isAllowSender(request, sender)) {
                        return;
                    }

                    switch (request.action) {
                        case 'tab-added':
                            {
                                let group = this.groups.find(gr => gr.id === request.tab.session.groupId);

                                if (group) {
                                    group.tabs.push(this.mapTab(request.tab));
                                    group.tabs.sort(utils.sortBy('index'));
                                } else {
                                    throw Error(utils.errorEventMessage('group for new tab not found', request));
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
                        case 'tab-removed':
                            {
                                let tabIndex = -1,
                                    group = this.groups.find(gr => -1 !== (tabIndex = gr.tabs.findIndex(t => t.id === request.tabId)));

                                if (group) {
                                    group.tabs.splice(tabIndex, 1);
                                } else {
                                    tabIndex = this.unSyncTabs.findIndex(tab => tab.id === request.tabId);

                                    if (-1 !== tabIndex) {
                                        this.unSyncTabs.splice(tabIndex, 1);
                                    }
                                }
                            }

                            break;
                        case 'group-updated':
                            let group = this.groups.find(gr => gr.id === request.group.id);

                            if (request.group.tabs) {
                                request.group.tabs = request.group.tabs.map(this.mapTab, this);

                                if (this.multipleTabs.length) {
                                    // ищем новые замапеные вкладки и добавляем их в мультиселект
                                    group.tabs.forEach(function(tab) {
                                        let multipleTabIndex = this.multipleTabs.indexOf(tab);

                                        if (-1 !== multipleTabIndex) {
                                            let mappedTab = request.group.tabs.find(t => t.id === tab.id);

                                            if (mappedTab) {
                                                this.multipleTabs.splice(multipleTabIndex, 1, mappedTab);
                                            } else {
                                                this.multipleTabs.splice(multipleTabIndex, 1);
                                            }
                                        }
                                    }, this);
                                }
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
                            if (isSidebar) {
                                this.loadOptions();
                            }
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
                let vm = this;

                group.tabs = group.tabs.map(this.mapTab, this);
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

                this.multipleTabs = [];
            },
            async loadUnsyncedTabs() {
                let windows = await Windows.load(true);

                this.unSyncTabs = windows
                    .reduce(function(acc, win) {
                        win.tabs.forEach(tab => !tab.session.groupId && acc.push(tab));
                        return acc;
                    }, [])
                    .map(this.mapTab, this);
            },

            async showCreateGroupPopup() {
                this.nextGroupTitle = await Groups.getNextTitle();
                this.isShowingCreateGroupPopup = true;
            },

            async createNewGroup() {
                await Groups.add(undefined, undefined, this.nextGroupTitle);
            },

            addTab(cookieStoreId) {
                Tabs.add(this.groupToShow.id, cookieStoreId);
            },
            removeTab(tab) {
                let tabIds = this.getTabsForMove(tab, utils.keyId);

                Tabs.remove(tabIds);
            },

            discardTab(tab) {
                let tabIds = this.getTabsForMove(tab, utils.keyId);

                Tabs.discard(tabIds);
            },

            discardGroup({tabs}) {
                Tabs.discard(tabs.map(utils.keyId));
            },

            discardOtherGroups(groupExclude) {
                let tabIds = this.groups.reduce((acc, gr) => [...acc, ...(gr.id === groupExclude.id ? [] : gr.tabs.map(utils.keyId))], []);

                Tabs.discard(tabIds);
            },

            reloadTab(tab, bypassCache) {
                let tabIds = this.getTabsForMove(tab, utils.keyId);

                Tabs.reload(tabIds, bypassCache);
            },

            reloadAllTabsInGroup(group, bypassCache) {
                if (group.tabs.length) {
                    Tabs.reload(group.tabs.map(utils.keyId), bypassCache);
                }
            },

            clickOnTab(event, tab, group) {
                if (event.ctrlKey || event.metaKey) {
                    if (this.multipleTabs.includes(tab)) {
                        this.multipleTabs.splice(this.multipleTabs.indexOf(tab), 1);
                    } else {
                        this.multipleTabs.push(tab);
                    }
                } else if (event.shiftKey) {
                    if (this.multipleTabs.length) {
                        let tabs = [];

                        if (SECTION_SEARCH === this.section) {
                            tabs = this.filteredGroupsBySearch.reduce((acc, group) => [...acc, ...group.filteredTabsBySearch], []);
                        } else {
                            tabs = group ? group.tabs : this.unSyncTabs;
                        }

                        let tabIndex = tabs.indexOf(tab),
                            lastTabIndex = -1;

                        this.multipleTabs.slice().reverse().some(function(t) {
                            return -1 !== (lastTabIndex = tabs.indexOf(t));
                        });

                        if (-1 === lastTabIndex) {
                            this.multipleTabs.push(tab);
                        } else if (tabIndex !== lastTabIndex) {
                            let multipleTabIndex = this.multipleTabs.indexOf(tabs[lastTabIndex]);

                            for (let i = Math.min(tabIndex, lastTabIndex), maxIndex = Math.max(tabIndex, lastTabIndex); i <= maxIndex; i++) {
                                if (!this.multipleTabs.includes(tabs[i])) {
                                    if (tabIndex > lastTabIndex) {
                                        this.multipleTabs.push(tabs[i]);
                                    } else {
                                        this.multipleTabs.splice(multipleTabIndex, 0, tabs[i]);
                                    }
                                }
                            }
                        }
                    } else {
                        this.multipleTabs.push(tab);
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

                this.multipleTabs = [];

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
                await Groups.add(undefined, this.unSyncTabs.map(utils.cloneTab));

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

                if (tab.hidden) {
                    BG.browser.tabs.show(tab.id);
                }

                if (this.currentGroup) {
                    this.unSyncTabs.splice(this.unSyncTabs.indexOf(tab), 1);
                } else {
                    this.loadUnsyncedTabs();
                }
            },

            async openGroupInNewWindow(groupId) {
                let windowId = this.getWindowId(groupId);

                if (windowId) {
                    Windows.setFocus(windowId);
                } else {
                    BG.Windows.create(undefined, groupId); // BG need because this popup will unload after win open and code not work
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
            async onSubmitRemoveGroup(group) {
                this.groups.splice(this.groups.indexOf(group), 1);

                this.groupToRemove = null;

                this.showSectionDefault();

                await Groups.remove(group.id);

                if (!this.currentGroup) {
                    this.loadUnsyncedTabs();
                }
            },
            getTabsForMove(withTab, mapFunc = utils.cloneTab) {
                if (withTab && !this.multipleTabs.includes(withTab)) {
                    this.multipleTabs.push(withTab);
                }

                let tabs = this.multipleTabs.map(mapFunc);

                this.multipleTabs = [];

                return tabs;
            },
            async moveTabs(tab, group, loadUnsync = false, showTabAfterMoving, discardTabs) {
                let tabs = this.getTabsForMove(tab);

                await Tabs.move(tabs, group.id, undefined, false, showTabAfterMoving);

                if (discardTabs) {
                    Tabs.discard(tabs.map(utils.keyId));
                }

                if (loadUnsync) {
                    this.loadUnsyncedTabs();
                }
            },
            async moveTabToNewGroup(tab, loadUnsync, showTabAfterMoving) {
                await Groups.add(undefined, this.getTabsForMove(tab), undefined, showTabAfterMoving);

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
            exportGroupToBookmarks(groupId) {
                BG.exportGroupToBookmarks(groupId);
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

            scrollToActiveElement() {
                this.$nextTick(function() {
                    if (this.groupToEdit) {
                        return;
                    }

                    if (!document.activeElement || '-1' === document.activeElement.tabIndex) {
                        return;
                    }

                    utils.scrollTo(document.activeElement);
                });
            },

            goToElementSibling(event) {
                let element = null;

                if (KeyEvent.DOM_VK_UP === event.keyCode) {
                    element = event.target.previousElementSibling || (event.target.parentNode.previousElementSibling && event.target.parentNode.previousElementSibling.lastElementChild);
                } else if (KeyEvent.DOM_VK_DOWN === event.keyCode) {
                    element = event.target.nextElementSibling || (event.target.parentNode.nextElementSibling && event.target.parentNode.nextElementSibling.firstElementChild);
                }

                if (element) {
                    event.preventDefault();
                    element.focus();
                }
            },

            goToFirstMainElement(event) {
                let element = null;

                if (KeyEvent.DOM_VK_DOWN === event.keyCode) {
                    element = document.querySelector('#result .group, #result .tab');
                }

                if (element) {
                    event.preventDefault();
                    element.focus();
                }
            },

            toggleLogging() {
                this.enableLogging = !this.enableLogging;

                if (this.enableLogging) {
                    window.localStorage.enableLogging = 1;
                } else {
                    delete window.localStorage.enableLogging;
                }

                BG.console.restart();

                if (!window.localStorage.enableLogging) {
                    BG.saveConsoleLogs();
                }
            },
        },
    }
</script>

<template>
    <div
        id="stg-popup"
        :class="['no-outline', {'edit-group-popup': !!groupToEdit, 'is-sidebar': isSidebar}]"
        @contextmenu="['INPUT', 'TEXTAREA'].includes($event.target.nodeName) ? null : $event.preventDefault()"
        @click="multipleTabs = []"
        @wheel.ctrl.prevent

        tabindex="-1"
        @focus.capture="scrollToActiveElement"
        @keydown.f3.stop.prevent="setFocusOnSearch"

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
                        @keydown.arrow-down="goToFirstMainElement"
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
                            :class="['group item', {
                                'is-active': group === currentGroup,
                                'is-opened': getWindowId(group.id),
                            }]"
                            @contextmenu="$refs.groupContextMenu.open($event, {group})"

                            @click="applyGroup(group)"
                            @keyup.enter="applyGroup(group)"
                            @keydown.arrow-right="showSectionGroupTabs(group)"
                            @keydown.arrow-up="goToElementSibling"
                            @keydown.arrow-down="goToElementSibling"
                            tabindex="0"
                            :title="getGroupTitle(group, 'withTabsCount withTabs')"
                            >
                                <div class="item-icon">
                                    <img :src="group.iconUrlToDisplay" class="is-inline-block size-16" />
                                </div>
                                <div class="item-title" v-text="getGroupTitle(group, options.showExtendGroupsPopupWithActiveTabs ? 'withActiveTab' : '')"></div>
                                <div class="item-action bold-hover is-unselectable" @click.stop="showSectionGroupTabs(group)">
                                    <img class="size-16 rotate-180" src="/icons/arrow-left.svg" />
                                    <span class="tabs-text" v-text="groupTabsCountMessage(group.tabs)"></span>
                                </div>
                        </div>

                        <div v-for="(tab, index) in group.filteredTabsBySearch" :key="index"
                            @contextmenu="$refs.tabsContextMenu.open($event, {tab, group})"
                            @click.stop="clickOnTab($event, tab, group)"
                            @keyup.enter="clickOnTab($event, tab, group)"
                            @keyup.delete="removeTab(tab)"
                            @keydown.arrow-up="goToElementSibling"
                            @keydown.arrow-down="goToElementSibling"
                            tabindex="0"
                            @mousedown.middle.prevent
                            @mouseup.middle.prevent="removeTab(tab)"
                            :class="['tab item is-unselectable space-left', {
                                'is-active': group === currentGroup && tab.active,
                                'is-multiple-tab-to-move': multipleTabs.includes(tab),
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
                                    <span v-if="tab.container" :title="tab.container.name">
                                        <img :src="tab.container.iconUrl" class="size-16 align-text-bottom" :style="{fill: tab.container.colorCode}" />
                                    </span>
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
                        :class="['group item', {
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
                        @click="applyGroup(group)"
                        @keyup.enter="applyGroup(group)"
                        @keydown.arrow-right="showSectionGroupTabs(group)"
                        @keydown.arrow-up="goToElementSibling"
                        @keydown.arrow-down="goToElementSibling"
                        tabindex="0"
                        :title="getGroupTitle(group, 'withTabsCount withTabs')"
                        >
                            <div class="item-icon">
                                <img :src="group.iconUrlToDisplay" class="is-inline-block size-16" />
                            </div>
                            <div class="item-title" v-text="getGroupTitle(group, options.showExtendGroupsPopupWithActiveTabs ? 'withActiveTab' : '')"></div>
                            <div class="item-action bold-hover is-unselectable" @click.stop="showSectionGroupTabs(group)">
                                <img class="size-16 rotate-180" src="/icons/arrow-left.svg" />
                                <span class="tabs-text" v-text="groupTabsCountMessage(group.tabs)"></span>
                            </div>
                    </div>

                </div>

                <hr>

                <div class="create-new-group">
                    <div class="item" tabindex="0" @click="showCreateGroupPopup" @keyup.enter="showCreateGroupPopup">
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
                                'is-multiple-tab-to-move': multipleTabs.includes(tab),
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
                                    <span v-if="tab.container" :title="tab.container.name">
                                        <img :src="tab.container.iconUrl" class="size-16 align-text-bottom" :style="{fill: tab.container.colorCode}" />
                                    </span>
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
                    <div class="item-title" v-text="getGroupTitle(groupToShow)"></div>
                    <div class="item-action is-unselectable">
                        <span tabindex="0" @click="openGroupSettings(groupToShow)" @keyup.enter="openGroupSettings(groupToShow)" class="size-16 cursor-pointer" :title="lang('groupSettings')">
                            <img src="/icons/settings.svg" />
                        </span>
                        <span tabindex="0" @click="removeGroup(groupToShow)" @keyup.enter="removeGroup(groupToShow)" class="size-16 cursor-pointer" :title="lang('deleteGroup')">
                            <img src="/icons/group-delete.svg" />
                        </span>
                    </div>
                </div>

                <div
                    v-for="(tab, tabIndex) in groupToShow.tabs"
                    :key="tabIndex"
                    :data-tab-id="tab.id"
                    @contextmenu="$refs.tabsContextMenu.open($event, {tab, group: groupToShow})"
                    @click.stop="clickOnTab($event, tab, groupToShow)"
                    @keyup.enter="clickOnTab($event, tab, groupToShow)"
                    @keydown.arrow-left="showSectionDefault"
                    @keydown.arrow-up="goToElementSibling"
                    @keydown.arrow-down="goToElementSibling"
                    @keydown.delete="removeTab(tab)"
                    tabindex="0"
                    @mousedown.middle.prevent
                    @mouseup.middle.prevent="removeTab(tab)"
                    :class="['tab item is-unselectable', {
                        'is-active': groupToShow === currentGroup && tab.active,
                        'drag-moving': tab.isMoving,
                        'drag-over': tab.isOver,
                        'is-multiple-tab-to-move': multipleTabs.includes(tab),
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
                            <span v-if="tab.container" :title="tab.container.name">
                                <img :src="tab.container.iconUrl" class="size-16 align-text-bottom" :style="{fill: tab.container.colorCode}" />
                            </span>
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
            </div>
        </main>

        <footer v-if="!isSidebar" class="is-flex is-unselectable">
            <div tabindex="0" class="is-flex is-align-items-center manage-groups is-full-height is-full-width" @click="openManageGroups" @keyup.enter="openManageGroups" :title="lang('manageGroupsTitle')">
                <img class="size-16" src="/icons/icon.svg" />
                <span class="h-margin-left-10" v-text="lang('manageGroupsTitle')"></span>
            </div>
            <div v-if="enableDebug" class="is-flex is-align-items-center is-vertical-separator"></div>
            <div tabindex="0" v-if="enableDebug" class="is-flex is-align-items-center is-full-height" @click="toggleLogging" @keyup.enter="toggleLogging" :title="enableLogging ? 'Stop logging' : 'Start logging'">
                <img v-if="enableLogging" class="size-16" src="/icons/stop-circle.svg" style="fill: red; margin-right: 5px;" />
                <img class="size-16" src="/icons/bug.svg" />
            </div>
            <div class="is-flex is-align-items-center is-vertical-separator"></div>
            <div tabindex="0" class="is-flex is-align-items-center is-full-height" @click="openOptionsPage" @keyup.enter="openOptionsPage" :title="lang('openSettings')">
                <img class="size-16" src="/icons/settings.svg" />
            </div>
        </footer>

        <context-menu ref="createNewTabContextMenu">
            <ul class="is-unselectable">
                <li v-for="container in containers" :key="container.cookieStoreId" @click="addTab(container.cookieStoreId)">
                    <img :src="container.iconUrl" class="is-inline-block size-16 fill-context" :style="{fill: container.colorCode}" />
                    <span v-text="container.name"></span>
                </li>
                <li @click="addTab(TEMPORARY_CONTAINER)">
                    <img src="resource://usercontext-content/chill.svg" class="is-inline-block size-16 fill-context" />
                    <span v-text="lang('temporaryContainerTitle')"></span>
                </li>
            </ul>
        </context-menu>

        <context-menu ref="groupContextMenu">
            <template v-slot="menu">
                <ul v-if="menu.data" class="is-unselectable">
                    <li @click="openGroupInNewWindow(menu.data.group.id)">
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
                    <li @click="exportGroupToBookmarks(menu.data.group.id)">
                        <img src="/icons/bookmark.svg" class="size-16" />
                        <span v-text="lang('exportGroupToBookmarks')"></span>
                    </li>
                    <li @click="reloadAllTabsInGroup(menu.data.group, $event.ctrlKey || $event.metaKey)">
                        <img src="/icons/refresh.svg" class="size-16" />
                        <span v-text="lang('reloadAllTabsInGroup')"></span>
                    </li>
                    <li @click="discardGroup(menu.data.group)">
                        <img src="/icons/snowflake.svg" class="size-16" />
                        <span v-text="lang('discardGroupTitle')"></span>
                    </li>
                    <li v-if="groups.length > 1" @click="discardOtherGroups(menu.data.group)">
                        <img src="/icons/snowflake.svg" class="size-16" />
                        <span v-text="lang('discardOtherGroups')"></span>
                    </li>

                    <hr>

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
                    <li v-if="multipleTabs.length" @click="removeTab(menu.data.tab)">
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
                        @click="moveTabs(menu.data.tab, group, !menu.data.group, undefined, $event.ctrlKey || $event.metaKey)"
                        @contextmenu="moveTabs(menu.data.tab, group, !menu.data.group, true)"
                        >
                        <img :src="group.iconUrlToDisplay" class="is-inline-block size-16" />
                        <span v-text="getGroupTitle(group, 'withActiveGroup')"></span>
                    </li>

                    <li
                        @click="moveTabToNewGroup(menu.data.tab, !menu.data.group)"
                        @contextmenu="moveTabToNewGroup(menu.data.tab, !menu.data.group, true)">
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
                }]
            ">
            <span v-html="lang('deleteGroupBody', safeHtml(groupToRemove.title))"></span>
        </popup>

        <popup
            v-if="isShowingCreateGroupPopup"
            :title="lang('createNewGroup')"
            @create-group="createNewGroup(); isShowingCreateGroupPopup = false"
            @close-popup="isShowingCreateGroupPopup = false"
            @show-popup="$refs.nextGroupTitle.focus(); $refs.nextGroupTitle.select()"
            :autofocus-on-button="false"
            :buttons="
                [{
                    event: 'create-group',
                    classList: 'is-success',
                    lang: 'ok',
                }, {
                    event: 'close-popup',
                    lang: 'cancel',
                }]
            ">
            <div class="control is-expanded">
                <input
                    ref="nextGroupTitle"
                    @keyup.enter.stop="createNewGroup(); isShowingCreateGroupPopup = false"
                    v-model.trim="nextGroupTitle"
                    type="text"
                    class="input" />
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
        &:focus {
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
        border-bottom-width: 2px;
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
