<script>
    'use strict';

    import * as utils from '../js/utils';
    import storage from '../js/storage';
    import * as constants from '../js/constants';

    import Vue from 'vue';

    import popup from '../js/popup.vue';
    import editGroupPopup from './edit-group-popup.vue';
    import editGroup from '../js/edit-group.vue';
    import contextMenu from '../js/context-menu-component.vue';

    const BG = (function(bgWin) {
        return bgWin && bgWin.background && bgWin.background.inited ? bgWin.background : false;
    })(browser.extension.getBackgroundPage());

    if (!BG) {
        window.close();
        throw Error('background not inited');
    }

    Vue.config.keyCodes = {
        'arrow-left': KeyEvent.DOM_VK_LEFT,
        'arrow-up': KeyEvent.DOM_VK_UP,
        'arrow-right': KeyEvent.DOM_VK_RIGHT,
        'arrow-down': KeyEvent.DOM_VK_DOWN,
        'enter': KeyEvent.DOM_VK_RETURN,
        'tab': KeyEvent.DOM_VK_TAB,
        'delete': KeyEvent.DOM_VK_DELETE,
    }

    const SECTION_SEARCH = 'search',
        SECTION_GROUPS_LIST = 'groupsList',
        SECTION_GROUP_TABS = 'groupTabs',
        SECTION_DEFAULT = SECTION_GROUPS_LIST;

    export default {
        data() {
            return {
                SECTION_SEARCH,
                SECTION_GROUPS_LIST,
                SECTION_GROUP_TABS,

                section: SECTION_DEFAULT,

                dragData: null,
                someGroupAreLoading: false,

                hoverItem: null,

                nextGroupTitle: '',
                isShowingCreateGroupPopup: false,

                search: '',
                extendedSearch: false,

                currentWindowId: null,

                groupToShow: null,
                groupToEdit: null,
                groupToRemove: null,

                containers: [],
                options: {},
                groups: [],

                unSyncTabs: [],
            };
        },
        components: {
            popup: popup,
            'edit-group-popup': editGroupPopup,
            'edit-group': editGroup,
            'context-menu': contextMenu,
        },
        created() {
            this
                .$on('drag-move-group', function(from, to) {
                    BG.moveGroup(from.data.item.id, this.groups.indexOf(to.data.item));
                })
                .$on('drag-move-tab', function(from, to) {
                    let tabData = {};

                    if (from.data.item.id) {
                        tabData.tabId = from.data.item.id;
                    } else {
                        tabData.groupId = from.data.group.id;
                        tabData.tabIndex = from.data.group.tabs.indexOf(from.data.item);
                    }

                    BG.moveTabs([tabData], {
                            newTabIndex: to.data.group.tabs.indexOf(to.data.item),
                            groupId: to.data.group.id,
                        }, false)
                        .catch(utils.notify);
                })
                .$on('drag-moving', (item, isMoving) => item.isMoving = isMoving)
                .$on('drag-over', (item, isOver) => item.isOver = isOver);
        },
        async mounted() {
            this.options = await storage.get(constants.allOptionsKeys);

            if (this.options.enableDarkTheme) {
                document.documentElement.classList.add('dark-theme');
            }

            let currentWindow = await BG.getWindow();
            this.currentWindowId = currentWindow.id;

            this.containers = await utils.loadContainers();

            this.loadGroups();

            await this.loadUnsyncedTabs();

            this.setupListeners();

            this.$refs.search.focus();

            this.$nextTick(function() {
                let activeItemNode = document.querySelector('.is-active');

                if (activeItemNode && !utils.isElementVisible(activeItemNode)) {
                    activeItemNode.scrollIntoView(false);
                }
            });
        },
        watch: {
            search(search) {
                if (search) {
                    this.showSectionSearch();
                }
            },
            currentGroup(group) {
                if (group && this.groupToShow && group.id === this.groupToShow.id && group._uid !== this.groupToShow._uid) {
                    this.groupToShow = group;
                }
            },
        },
        computed: {
            currentGroup() {
                return this.groups.find(group => group.windowId === this.currentWindowId);
            },
            filteredGroupsBySearch() {
                if (!this.search) {
                    return [];
                }

                let searchStr = this.search.toLowerCase(),
                    groups = [];

                this.groups.forEach(function(group) {
                    group.filteredTabsBySearch = group.tabs
                        .filter(function(tab) {
                            return utils.mySearchFunc(searchStr, tab.title, this.extendedSearch)
                                || utils.mySearchFunc(searchStr, tab.url, this.extendedSearch);
                        }, this);

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

            setupListeners() {
                let listener = function(request, sender) {
                    if (!utils.isAllowSender(request, sender)) {
                        return;
                    }

                    switch (request.action) {
                        case 'group-updated':
                            let groupIndex = this.groups.findIndex(group => group.id === request.group.id);

                            if (request.group.tabs) {
                                request.group.tabs = request.group.tabs.map(this.$_tabMap, this);

                                if (this.hoverItem && !this.isGroup(this.hoverItem) && this.hoverItem.id) {
                                    this.hoverItem = request.group.tabs.find(tab => tab.id === this.hoverItem.id) || null;
                                }
                            }

                            Object.assign(this.groups[groupIndex], request.group);
                            break;
                        case 'group-added':
                            this.groups.push(this.$_groupMap(request.group));
                            break;
                        case 'group-removed':
                            this.groups.splice(this.groups.findIndex(gr => gr.id === request.groupId), 1);
                            break;
                        case 'group-loaded':
                        case 'groups-updated':
                            this.loadGroups();
                            break;
                    }

                }.bind(this);

                browser.runtime.onMessage.addListener(listener);
                window.addEventListener('unload', () => browser.runtime.onMessage.removeListener(listener));
            },

            showSectionGroupTabs(group) {
                this.groupToShow = group;
                this.search = '';
                this.section = SECTION_GROUP_TABS;
            },

            showSectionSearch() {
                this.groupToShow = null;
                this.section = SECTION_SEARCH;
            },

            showSectionDefault() {
                this.section = SECTION_DEFAULT;
                this.groupToShow = null;
                this.search = '';
            },

            $_simpleSortTabs(searchStr, a, b) {
                let aIncludes = (a.title || '').toLowerCase().includes(searchStr) || (a.url || '').toLowerCase().includes(searchStr),
                    bIncludes = (b.title || '').toLowerCase().includes(searchStr) || (b.url || '').toLowerCase().includes(searchStr);

                if (aIncludes && !bIncludes) { // move up
                    return -1;
                }

                if (!aIncludes && bIncludes) { // move down
                    return 1;
                }

                return 0; // stay
            },

            $_groupMap(group) {
                let vm = this;

                group.tabs = group.tabs.map(this.$_tabMap, this);
                group.isMoving = false;
                group.isOver = false;

                return new Vue({
                    data: group,
                    computed: {
                        iconUrlToDisplay() {
                            // watch variables
                            this.iconUrl;
                            this.iconColor;
                            this.iconViewType;

                            return utils.getGroupIconUrl(this);
                        },
                    },
                });
            },

            $_tabMap(tab) {
                let vm = this;

                tab.favIconUrlToDisplay = BG.getTabFavIconUrl(tab);
                tab.borderedStyle = (function() {
                    if (utils.isDefaultCookieStoreId(tab.cookieStoreId)) {
                        return false;
                    }

                    let container = vm.containers.find(container => container.cookieStoreId === tab.cookieStoreId);

                    if (!container) {
                        return false;
                    }

                    return {
                        borderColor: container.colorCode,
                    };
                })();

                tab.isMoving = false;
                tab.isOver = false;

                return new Vue({
                    data: tab,
                });
            },

            loadGroups() {
                this.groups = BG.getGroups().map(this.$_groupMap, this);

                if (this.hoverItem && this.isGroup(this.hoverItem)) {
                    this.hoverItem = this.groups.find(group => group.id === this.hoverItem.id) || null;
                }
            },
            async loadUnsyncedTabs() {
                let unSyncTabs = await browser.tabs.query({
                    pinned: false,
                    hidden: true,
                });

                this.unSyncTabs = unSyncTabs
                    .filter(utils.isTabNotIncognito)
                    .filter(unSyncTab => !this.groups.some(group => group.tabs.some(tab => tab.id === unSyncTab.id)))
                    .map(this.$_tabMap, this);
            },

            async showCreateGroupPopup() {
                let { lastCreatedGroupPosition } = await storage.get('lastCreatedGroupPosition');
                this.nextGroupTitle = browser.i18n.getMessage('newGroupTitle', lastCreatedGroupPosition + 1);
                this.isShowingCreateGroupPopup = true;
            },

            createNewGroup() {
                BG.addGroup(undefined, undefined, undefined, undefined, this.nextGroupTitle);
            },

            addTab(cookieStoreId) {
                BG.addTab(this.groupToShow.id, cookieStoreId);
            },
            removeTab(groupId, tabIndex) {
                this.groups.some(function(group) {
                    if (group.id === groupId) {
                        group.tabs.splice(tabIndex, 1);
                        return true;
                    }
                });

                BG.removeTab(groupId, tabIndex);
            },
            removeUnSyncTab(tab) {
                browser.tabs.remove(tab.id);
                this.unSyncTabs.splice(this.unSyncTabs.indexOf(tab), 1);
            },
            async loadGroup(group, tabIndex = -1, closePopup = false) {
                if (this.someGroupAreLoading) {
                    return;
                }

                let isCurrentGroup = group === this.currentGroup;

                if (isCurrentGroup) {
                    if (-1 === tabIndex) { // open group
                        this.showSectionGroupTabs(group);
                        return;
                    }

                    if (group.tabs[tabIndex].active) {
                        return;
                    }

                    group.tabs.forEach((tab, index) => tab.active = index === tabIndex);
                }

                let groupIndex = this.groups.findIndex(gr => gr.id === group.id);

                if (closePopup) {
                    BG.loadGroup(this.currentWindowId, groupIndex, tabIndex);
                    window.close();
                } else {
                    this.someGroupAreLoading = true;

                    await BG.loadGroup(this.currentWindowId, groupIndex, tabIndex);

                    this.someGroupAreLoading = false;

                    if (this.options.closePopupAfterChangeGroup) {
                        if (!isCurrentGroup) {
                            window.close();
                        }
                    } else {
                        if (this.options.openGroupAfterChange) {
                            this.showSectionGroupTabs(group);
                        } else {
                            this.loadUnsyncedTabs();
                        }
                    }
                }
            },
            async unsyncHiddenTabsMoveToCurrentGroup() {
                let hiddenTabsIds = this.unSyncTabs.map(utils.keyId);

                await browser.tabs.move(hiddenTabsIds, {
                    windowId: this.currentWindowId,
                    index: -1,
                });

                await browser.tabs.show(hiddenTabsIds);

                this.unSyncTabs = [];
                this.loadGroups();
            },
            async unsyncHiddenTabsCreateNewGroup() {
                await BG.addGroup(undefined, undefined, undefined, this.unSyncTabs);

                this.unSyncTabs = [];
            },
            unsyncHiddenTabsCloseAll() {
                browser.tabs.remove(this.unSyncTabs.map(utils.keyId));

                this.unSyncTabs = [];
            },
            async unsyncHiddenTabsShowTabIntoCurrentWindow(tab) {
                await browser.tabs.move(tab.id, {
                    windowId: this.currentWindowId,
                    index: -1,
                });

                await browser.tabs.show(tab.id);

                this.unSyncTabs.splice(this.unSyncTabs.indexOf(tab), 1);
            },

            async openGroupInNewWindow(group) {
                if (group.windowId) {
                    BG.setFocusOnWindow(group.windowId);
                } else {
                    let win = await BG.createWindow(),
                        groupIndex = this.groups.findIndex(gr => gr.id === group.id);

                    BG.loadGroup(win.id, groupIndex);
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
                await BG.removeGroup(group.id);
                this.groupToRemove = null;

                // this.groups.splice(this.groups.indexOf(group), 1);

                this.showSectionDefault();
            },
            async moveTab(tab, oldGroup, newGroup) {
                let tabData = {};

                if (tab.id) {
                    tabData.tabId = tab.id;
                } else {
                    tabData.tabIndex = oldGroup.tabs.indexOf(tab);
                    tabData.groupId = oldGroup.id;
                }

                try {
                    await BG.moveTabs([tabData], {
                        groupId: newGroup.id,
                    }, false);
                } catch (e) {
                    utils.notify(e);
                }

                if (!oldGroup) {
                    this.loadUnsyncedTabs();
                }
            },
            async moveTabToNewGroup(tab, oldGroup) {
                let newGroup = await BG.addGroup(undefined, undefined, false);

                await this.moveTab(tab, oldGroup, newGroup);
            },
            setTabIconAsGroupIcon(tab) {
                BG.updateGroup(this.groupToShow.id, {
                    iconViewType: null,
                    iconUrl: BG.getTabFavIconUrl(tab),
                });
            },

            getTabTitle: utils.getTabTitle,

            getFullGroupTitleWithTabs(group) {
                let title = group.title + ' (' + this.lang('groupTabsCount', group.tabs.length) + ')';

                if (group.tabs.length) {
                    title += ':\n' + group.tabs
                        .slice(0, 30)
                        .map(tab => utils.sliceText(tab.title, 70))
                        .join('\n');

                    if (group.tabs.length > 30) {
                        title += '\n...';
                    }
                }

                return title;
            },

            openOptionsPage() {
                browser.runtime.openOptionsPage();
                window.close();
            },
            reloadAddon() {
                browser.runtime.reload();
            },
            openManageGroups() {
                BG.openManageGroups();
                window.close();
            },
            sortGroups(vector) {
                BG.sortGroups(vector);
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

            isGroup(obj) {
                return 'tabs' in obj;
            },

            async setHoverItemByKey(arrow, event) {
                if (this.groupToEdit || this.groupToRemove) {
                    return;
                }

                let index = null;

                this.$el.focus();

                if ('up' === arrow || 'down' === arrow) {
                    event.preventDefault();
                }

                switch (this.section) {
                    case SECTION_SEARCH:
                        if (!this.filteredGroupsBySearch.length) {
                            return;
                        }

                        let allItems = this.filteredGroupsBySearch.reduce((accum, group) => accum.concat([group]).concat(group.filteredTabsBySearch), []);

                        index = this.hoverItem ? allItems.indexOf(this.hoverItem) : -1;

                        if ('up' === arrow) {
                            index = utils.getNextIndex(index, allItems.length, 'prev');
                            this.hoverItem = allItems[index] || null;
                        } else if ('down' === arrow) {
                            index = utils.getNextIndex(index, allItems.length, 'next');
                            this.hoverItem = allItems[index] || null;
                        } else if ('right' === arrow) {
                            if (this.hoverItem && this.isGroup(this.hoverItem)) { // open group
                                this.showSectionGroupTabs(this.hoverItem);
                            }
                        } else if ('enter' === arrow) {
                            if (!this.hoverItem && allItems.length) {
                                this.hoverItem = allItems[0];
                            }

                            if (this.hoverItem) {
                                if (this.isGroup(this.hoverItem)) { // is group
                                    this.loadGroup(this.hoverItem, undefined, true);
                                } else { // is tab
                                    // find group
                                    let group = this.groups.find(gr => gr.tabs.includes(this.hoverItem));
                                    this.loadGroup(group, group.tabs.indexOf(this.hoverItem), true);
                                }
                            }
                        }

                        break;
                    case SECTION_GROUPS_LIST:
                        index = this.hoverItem ? this.groups.indexOf(this.hoverItem) : -1;

                        if (-1 === index) {
                            index = this.groups.indexOf(this.currentGroup);
                        }

                        if ('up' === arrow) {
                            index = utils.getNextIndex(index, this.groups.length, 'prev');
                            this.hoverItem = this.groups[index] || null;
                        } else if ('down' === arrow) {
                            index = utils.getNextIndex(index, this.groups.length, 'next');
                            this.hoverItem = this.groups[index] || null;
                        } else if ('right' === arrow) {
                            if (this.hoverItem && this.isGroup(this.hoverItem)) {
                                this.showSectionGroupTabs(this.hoverItem);
                            }
                        } else if ('enter' === arrow) {
                            if (this.hoverItem) {
                                if (this.isGroup(this.hoverItem)) {
                                    this.loadGroup(this.hoverItem, undefined, true);
                                }
                            } else {
                                this.$refs.search.focus();
                            }
                        }

                        break;
                    case SECTION_GROUP_TABS:
                        index = this.hoverItem ? this.groupToShow.tabs.indexOf(this.hoverItem) : -1;

                        if (-1 === index && this.groupToShow.windowId) {
                            index = this.groupToShow.tabs.findIndex(tab => tab.active);
                        }

                        if ('up' === arrow) {
                            index = utils.getNextIndex(index, this.groupToShow.tabs.length, 'prev');
                            this.hoverItem = this.groupToShow.tabs[index] || null;
                        } else if ('down' === arrow) {
                            index = utils.getNextIndex(index, this.groupToShow.tabs.length, 'next');
                            this.hoverItem = this.groupToShow.tabs[index] || null;
                        } else if ('left' === arrow) {
                            this.showSectionDefault();
                        } else if ('enter' === arrow) {
                            if (this.hoverItem && -1 !== index) {
                                this.loadGroup(this.groupToShow, index, true);
                            }
                        } else if ('delete' === arrow) {
                            if (this.hoverItem && !this.isGroup(this.hoverItem)) {
                                let tabIndex = this.groupToShow.tabs.indexOf(this.hoverItem);
                                await this.setHoverItemByKey('down', event);
                                this.removeTab(this.groupToShow.id, tabIndex);
                            }
                        }

                        break;
                }

                this.$nextTick(function() {
                    let hoverItemNode = document.querySelector('.is-hovered-item');

                    if (hoverItemNode && !utils.isElementVisible(hoverItemNode)) {
                        let alignTo;

                        if ('up' === arrow) {
                            alignTo = false;
                        }

                        hoverItemNode.scrollIntoView(alignTo);
                    }
                });
            },

        },
    }
</script>

<template>
    <div
        id="stg-popup"
        :class="['is-flex is-column', {'edit-group-popup': !!groupToEdit}]"
        @contextmenu="['INPUT', 'TEXTAREA'].includes($event.target.nodeName) ? null : $event.preventDefault()"
        @wheel.ctrl.prevent

        tabindex="-1"
        @mousemove="hoverItem = null"
        @keyup.arrow-left="setHoverItemByKey('left', $event)"
        @keydown.arrow-up="setHoverItemByKey('up', $event)"
        @keyup.arrow-right="setHoverItemByKey('right', $event)"
        @keydown.arrow-down="setHoverItemByKey('down', $event)"
        @keydown.tab="setHoverItemByKey('down', $event)"
        @keyup.enter="setHoverItemByKey('enter', $event)"
        @keyup.delete="setHoverItemByKey('delete', $event)"

        >
        <header id="search-wrapper">
            <div :class="['field', {'has-addons': search}]">
                <div class="control is-expanded"
                    @keydown.arrow-right.stop @keyup.arrow-right.stop
                    @keydown.arrow-left.stop @keyup.arrow-left.stop
                    >
                    <input id="search" v-model.trim="search" @input="$refs.search.value === '' ? showSectionDefault() : null" ref="search" type="text" class="input is-small fill-context" autocomplete="off" :placeholder="lang('searchPlaceholder')" />
                </div>
                <div v-show="search" class="control">
                    <label class="button is-small" :title="lang('extendedTabSearch')">
                        <input type="checkbox" v-model="extendedSearch" />
                    </label>
                </div>
                <div v-show="search" class="control">
                    <label class="button is-small" @click="showSectionDefault(); $refs.search.focus();">
                        <img class="size-12" src="/icons/close.svg" />
                    </label>
                </div>
            </div>
        </header>

        <main id="result" :class="['is-full-width', dragData ? 'drag-' + dragData.itemType : false]">
            <!-- SEARCH TABS -->
            <div v-show="section === SECTION_SEARCH">
                <div v-if="filteredGroupsBySearch.length">
                    <div v-for="group in filteredGroupsBySearch" :key="group.id">
                        <div class="group" @contextmenu="$refs.groupContextMenu.open($event, {group})">
                            <div
                                :class="['item', {
                                    'is-active': group === currentGroup,
                                    'is-hovered-item': group === hoverItem,
                                }]"
                                @click="loadGroup(group)"
                                >
                                <div class="item-icon" :title="group.title">
                                    <img :src="group.iconUrlToDisplay" class="is-inline-block size-16" />
                                </div>
                                <div class="item-title" :title="group.title" v-text="group.title"></div>
                                <div class="item-action bold-hover is-unselectable" @click.stop="showSectionGroupTabs(group)">
                                    <img class="size-16 rotate-180" src="/icons/arrow-left.svg" />
                                    <span class="tabs-text" v-text="lang('groupTabsCount', group.tabs.length)"></span>
                                </div>
                            </div>
                        </div>

                        <div v-for="(tab, index) in group.filteredTabsBySearch" :key="index"
                            @contextmenu="$refs.tabsContextMenu.open($event, {tab, group})"
                            @click="loadGroup(group, group.tabs.indexOf(tab))"
                            @mousedown.middle.prevent
                            @mouseup.middle.prevent="removeTab(group.id, group.tabs.indexOf(tab))"
                            :class="['item is-unselectable space-left', {
                                'is-active': group === currentGroup && tab.active,
                                'is-hovered-item': tab === hoverItem,
                            }]"
                            :title="getTabTitle(tab, true)"
                            >
                            <div class="item-icon">
                                <img :src="tab.favIconUrlToDisplay" class="size-16" />
                            </div>
                            <div class="item-title">
                                <span :class="{bordered: !!tab.borderedStyle}" :style="tab.borderedStyle">
                                    <span v-if="!tab.id" :title="lang('thisTabWillCreateAsNew')">
                                        <img src="/icons/refresh.svg" class="size-16 align-text-bottom" />
                                    </span>
                                    <span v-text="getTabTitle(tab)"></span>
                                </span>
                            </div>
                            <div class="item-action flex-on-hover">
                                <span class="size-16 cursor-pointer" @click.stop="removeTab(group.id, group.tabs.indexOf(tab))" :title="lang('deleteTab')">
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
            <div v-show="section === SECTION_GROUPS_LIST">
                <div class="groups">
                    <div
                        v-for="group in groups"
                        :key="group.id"
                        :class="['group', {
                            'drag-moving': group.isMoving,
                            'drag-over': group.isOver,
                        }]"
                        @contextmenu="$refs.groupContextMenu.open($event, {group})"

                        draggable="true"
                        @dragstart="dragHandle($event, 'group', ['group'], {item: group})"
                        @dragenter="dragHandle($event, 'group', ['group'], {item: group})"
                        @dragover="dragHandle($event, 'group', ['group'], {item: group})"
                        @dragleave="dragHandle($event, 'group', ['group'], {item: group})"
                        @drop="dragHandle($event, 'group', ['group'], {item: group})"
                        @dragend="dragHandle($event, 'group', ['group'], {item: group})"
                        >
                        <div
                            :class="['item', {
                                'is-active': group === currentGroup,
                                'is-hovered-item': group === hoverItem,
                            }]"
                            @click="loadGroup(group)"
                            :title="group.title"
                            >
                            <div class="item-icon">
                                <img :src="group.iconUrlToDisplay" class="is-inline-block size-16" />
                            </div>
                            <div class="item-title" v-text="group.title"></div>
                            <div class="item-action bold-hover is-unselectable" :title="getFullGroupTitleWithTabs(group)" @click.stop="showSectionGroupTabs(group)">
                                <img class="size-16 rotate-180" src="/icons/arrow-left.svg" />
                                <span class="tabs-text" v-text="lang('groupTabsCount', group.tabs.length)"></span>
                            </div>
                        </div>
                    </div>

                </div>

                <hr>

                <div class="create-new-group">
                    <div class="item" @click="showCreateGroupPopup">
                        <div class="item-icon">
                            <img class="size-16" src="/icons/group-new.svg" />
                        </div>
                        <div class="item-title" v-text="lang('createNewGroup')"></div>
                    </div>
                </div>

                <div v-show="unSyncTabs.length" class="not-sync-tabs">
                    <hr>
                    <p class="h-margin-bottom-10">
                        <span v-text="lang('foundHiddenUnSyncTabsDescription')"></span><br>
                        <a @click="unsyncHiddenTabsMoveToCurrentGroup" v-text="lang('actionHiddenUnSyncTabsMoveAllTabsToCurrentGroup')"></a><br>
                        <a @click="unsyncHiddenTabsCreateNewGroup" v-text="lang('actionHiddenUnSyncTabsCreateGroup')"></a><br>
                        <a @click="unsyncHiddenTabsCloseAll" v-text="lang('actionHiddenUnSyncTabsCloseAll')"></a>
                    </p>
                    <div>
                        <div v-for="tab in unSyncTabs" :key="tab.id"
                            @contextmenu="$refs.tabsContextMenu.open($event, {tab})"
                            @click="unsyncHiddenTabsShowTabIntoCurrentWindow(tab)"
                            @mousedown.middle.prevent
                            @mouseup.middle.prevent="removeUnSyncTab(tab)"
                            class="item is-unselectable"
                            :title="getTabTitle(tab, true)"
                            >
                            <div class="item-icon">
                                <img :src="tab.favIconUrlToDisplay" class="size-16" />
                            </div>
                            <div class="item-title">
                                <span :class="{bordered: !!tab.borderedStyle}" :style="tab.borderedStyle" v-text="getTabTitle(tab)"></span>
                            </div>
                            <div class="item-action flex-on-hover">
                                <span class="size-16 cursor-pointer" @click.stop="removeUnSyncTab(tab)" :title="lang('deleteTab')">
                                    <img src="/icons/close.svg" />
                                </span>
                            </div>
                        </div>

                    </div>
                </div>
            </div>

            <!-- GROUP -->
            <div v-if="section === SECTION_GROUP_TABS">
                <div class="tabs-list">
                    <div class="item is-unselectable" @click="showSectionDefault">
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
                        <div class="item-title" v-text="groupToShow.title"></div>
                        <div class="item-action is-unselectable">
                            <span @click="openGroupSettings(groupToShow)" class="size-16 cursor-pointer" :title="lang('groupSettings')">
                                <img src="/icons/settings.svg" />
                            </span>
                            <span @click="removeGroup(groupToShow)" class="size-16 cursor-pointer" :title="lang('deleteGroup')">
                                <img src="/icons/group-delete.svg" />
                            </span>
                        </div>
                    </div>

                    <div
                        v-for="(tab, tabIndex) in groupToShow.tabs"
                        :key="tabIndex"
                        @contextmenu="$refs.tabsContextMenu.open($event, {tab, group: groupToShow})"
                        @click="loadGroup(groupToShow, tabIndex)"
                        @mousedown.middle.prevent
                        @mouseup.middle.prevent="removeTab(groupToShow.id, tabIndex)"
                        :class="['item is-unselectable', {
                            'is-active': groupToShow === currentGroup && tab.active,
                            'drag-moving': tab.isMoving,
                            'drag-over': tab.isOver,
                            'is-hovered-item': tab === hoverItem,
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
                            <img :src="tab.favIconUrlToDisplay" class="size-16" />
                        </div>
                        <div class="item-title">
                            <span :class="{bordered: !!tab.borderedStyle}" :style="tab.borderedStyle">
                                <span v-if="!tab.id" :title="lang('thisTabWillCreateAsNew')">
                                    <img src="/icons/refresh.svg" class="size-16 align-text-bottom" />
                                </span>
                                <span v-text="getTabTitle(tab)"></span>
                            </span>
                        </div>
                        <div class="item-action flex-on-hover">
                            <span class="size-16 cursor-pointer" @click.stop="removeTab(groupToShow.id, tabIndex)" :title="lang('deleteTab')">
                                <img src="/icons/close.svg" />
                            </span>
                        </div>
                    </div>

                    <hr>

                    <div class="create-new-tab">
                        <div class="item" @contextmenu="containers.length && $refs.createNewTabContextMenu.open($event)" @click="addTab()">
                            <div class="item-icon">
                                <img class="size-16" src="/icons/tab-new.svg">
                            </div>
                            <div class="item-title" v-text="lang('createNewTab')"></div>
                        </div>

                        <context-menu v-if="containers.length" ref="createNewTabContextMenu">
                            <ul class="is-unselectable">
                                <li v-for="container in containers" :key="container.cookieStoreId" @click="addTab(container.cookieStoreId)">
                                    <img :src="container.iconUrl" class="is-inline-block size-16 fill-context" :style="{fill: container.colorCode}" />
                                    <span v-text="container.name"></span>
                                </li>
                            </ul>
                        </context-menu>

                    </div>
                </div>
            </div>
        </main>

        <footer class="is-flex is-unselectable">
            <div class="is-flex is-align-items-center manage-groups is-full-height is-full-width" @click="openManageGroups" :title="lang('manageGroupsTitle')">
                <img class="size-16" src="/icons/icon.svg" />
                <span class="h-margin-left-10" v-text="lang('manageGroupsTitle')"></span>
            </div>
            <div class="is-flex is-align-items-center is-vertical-separator"></div>
            <div class="is-flex is-align-items-center is-full-height" @click="reloadAddon" :title="lang('reloadAddon')">
                <img class="size-16" src="/icons/refresh.svg" />
            </div>
            <div class="is-flex is-align-items-center is-vertical-separator"></div>
            <div class="is-flex is-align-items-center is-full-height" @click="openOptionsPage" :title="lang('openSettings')">
                <img class="size-16" src="/icons/settings.svg" />
            </div>
        </footer>

        <context-menu ref="groupContextMenu">
            <ul slot-scope="menu" class="is-unselectable">
                <li @click="openGroupInNewWindow(menu.data.group)">
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
        </context-menu>

        <context-menu ref="tabsContextMenu">
            <ul slot-scope="menu" v-if="menu.data" class="is-unselectable">
                <li v-if="menu.data.group" @click="setTabIconAsGroupIcon(menu.data.tab)">
                    <img src="/icons/image.svg" class="size-16" />
                    <span v-text="lang('setTabIconAsGroupIcon')"></span>
                </li>

                <hr v-if="menu.data.group">

                <li class="is-disabled">
                    <img class="size-16" />
                    <span v-text="lang('moveTabToGroupDisabledTitle') + ':'"></span>
                </li>

                <li
                    v-for="group in groups"
                    :key="group.id"
                    :class="{'is-disabled': menu.data.group ? menu.data.group.id === group.id : false}"
                    @click="menu.data.group
                        ? (menu.data.group.id === group.id ? null : moveTab(menu.data.tab, menu.data.group, group))
                        : moveTab(menu.data.tab, undefined, group)
                        "
                    >
                    <img :src="group.iconUrlToDisplay" class="is-inline-block size-16" />
                    <span v-text="group.title"></span>
                </li>

                <li @click="moveTabToNewGroup(menu.data.tab, menu.data.group)">
                    <img src="/icons/group-new.svg" class="size-16" />
                    <span v-text="lang('createNewGroup')"></span>
                </li>
            </ul>
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
                :group="groupToEdit"
                :containers="containers"
                :can-load-file="false"
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
                    @keydown.enter.stop="createNewGroup(); isShowingCreateGroupPopup = false"
                    v-model.trim="nextGroupTitle"
                    type="text"
                    class="input" />
            </div>
        </popup>
    </div>
</template>

<style lang="scss">
    :root {
        --popup-width: 348px;
        --max-popup-width: 100%;

        --max-popup-height: 600px;
        --min-popup-height: 200px;

        --item-background-color-active: var(--color-light-gray);
        --item-background-color-hover: var(--color-gray);
        --item-background-color-active-hover: var(--color-dark-gray);

        --footer-background-color: var(--item-background-color-active);
        --footer-background-hover-color: var(--item-background-color-hover);

    }

    html {
        font-size: 13px;
        width: var(--popup-width);
        min-height: var(--min-popup-height);
        max-width: var(--max-popup-width);
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
            height: 45px;
            min-height: 45px;
            margin-top: var(--indent);
            align-items: center;
            justify-content: space-between;
            cursor: default;
            background-color: var(--footer-background-color);

            > :hover {
                background-color: var(--footer-background-hover-color);
            }

            .manage-groups span {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                max-width: 165px;
            }

            & > *:not(.is-vertical-separator) {
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

        .drag-moving {
            opacity: 0.4;
        }
    }

    /* END HELPERS */
    #search-wrapper {
        padding: var(--indent);
    }

    #search {
        background-position-x: 4px;
        background-position-y: center;
        background-repeat: no-repeat;
        background-image: url('/icons/search.svg');
        padding-left: calc(16px + (2 * 4px));
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
        position: relative;

        &.space-left {
            padding-left: calc(var(--indent) * 2);
        }

        > :last-child {
            padding-right: var(--indent);
        }

        // &.is-hover,
        &:not(.no-hover):hover,
        &.is-active,
        &.is-hovered-item {
            background-color: var(--item-background-color-hover);
        }

        &.is-active:before {
            content: '';
            position: absolute;
            background-color: #0a84ff;
            left: 0;
            top: 0;
            bottom: 0;
            width: 4px;
        }

        .item-action.bold-hover:hover {
            background-color: var(--item-background-color-active-hover);
        }

        &:not(.no-hover):active {
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
            line-height: 1;
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

    .group .tabs-text {
        white-space: nowrap;
        overflow: hidden;
        display: inline-block;
        text-overflow: ellipsis;
        height: 16px;
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
