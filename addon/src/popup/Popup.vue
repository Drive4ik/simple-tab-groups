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

                search: '',

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
                    BG.moveGroup(from.data.item.id, to.data.itemIndex);
                })
                .$on('drag-move-tab', function(from, to) {
                    let newTabIndex = undefined,
                        groupTo = null;

                    if (to.data.isGroup) {
                        groupTo = to.data.item;
                    } else {
                        groupTo = to.data.group;
                        newTabIndex = to.data.itemIndex;
                    }

                    BG.moveTabToGroup(from.data.itemIndex, newTabIndex, from.data.group.id, groupTo.id, false);
                })
                .$on('drag-moving', (item, isMoving) => item.isMoving = isMoving)
                .$on('drag-over', (item, isOver) => item.isOver = isOver);
        },
        async mounted() {
            let currentWindow = await BG.getWindow();
            this.currentWindowId = currentWindow.id;

            this.containers = await utils.loadContainers();

            this.options = await storage.get(constants.allOptionsKeys);

            this.loadGroups();

            await this.loadUnsyncedTabs();

            this.setupListeners();

            this.$refs.search.focus();
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
                    group.filteredTabsBySearch = group.tabs.filter(function(tab, tabIndex) {
                        tab.index = tabIndex;
                        return this.$_mySearchFunc(searchStr, (tab.title || '').toLowerCase()) || this.$_mySearchFunc(searchStr, tab.url.toLowerCase());
                    }, this);

                    if (group.filteredTabsBySearch.length || this.$_mySearchFunc(searchStr, group.title.toLowerCase())) {
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

                    console.info('BG event:', request.action, utils.clone(request));

                    switch (request.action) {
                        case 'tab-thumbnail-updated':
                            let group = this.groups.find(group => group.id === request.groupId);
                            group.tabs.some(function(tab, tabIndex) {
                                if (tabIndex === request.tabIndex) {
                                    tab.thumbnail = request.thumbnail;
                                    return true;
                                }
                            });
                            break;
                        case 'group-updated':
                            let groupIndex = this.groups.findIndex(group => group.id === request.group.id);

                            if (request.group.tabs) {
                                request.group.tabs = request.group.tabs.map(this.$_tabMap, this);
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

            $_mySearchFunc(searchStr, inStr) {
                let lastFindIndex = -1;

                return searchStr
                    .split('')
                    .every(function(char) {
                        if (' ' === char) {
                            return true;
                        }

                        lastFindIndex = inStr.indexOf(char, lastFindIndex + 1);
                        return -1 !== lastFindIndex;
                    });
            },

            $_simpleSortTabs(searchStr, a, b) {
                let aIncludes = (a.title || '').toLowerCase().includes(searchStr) || a.url.includes(searchStr),
                    bIncludes = (b.title || '').toLowerCase().includes(searchStr) || b.url.includes(searchStr);

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

                            return utils.getGroupIconUrl(this, vm.options.browserActionIconColor);
                        },
                    },
                });
            },

            $_tabMap(tab) {
                let vm = this;

                tab.favIconUrlToDisplay = BG.getTabFavIconUrl(tab, this.options.useTabsFavIconsFromGoogleS2Converter);
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
                this.groups = utils.clone(BG.getGroups()).map(this.$_groupMap, this);
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

            addGroup() {
                BG.addGroup();
            },
            addTab(cookieStoreId) {
                BG.addTab(this.groupToShow.id, cookieStoreId || constants.DEFAULT_COOKIE_STORE_ID);
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
            async loadGroup(group, tabIndex) {
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
                this.loadGroups();
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
            async moveTabToGroup(oldTabIndex, oldGroupId, newGroupId, callLoadUnsyncedTabs) {
                await BG.moveTabToGroup(oldTabIndex, undefined, oldGroupId, newGroupId);

                if (callLoadUnsyncedTabs) {
                    this.loadUnsyncedTabs();
                }
            },
            async moveTabToNewGroup(oldTabIndex, oldGroupId, callLoadUnsyncedTabs) {
                let newGroup = await BG.addGroup(undefined, undefined, false);

                await BG.moveTabToGroup(oldTabIndex, undefined, oldGroupId, newGroup.id);

                if (callLoadUnsyncedTabs) {
                    this.loadUnsyncedTabs();
                }
            },
            setTabIconAsGroupIcon(tab) {
                BG.updateGroup(this.groupToShow.id, {
                    iconViewType: null,
                    iconUrl: BG.getTabFavIconUrl(tab, this.options.useTabsFavIconsFromGoogleS2Converter),
                });
            },

            getTabTitle(tab) {
                return [tab.title, tab.url].filter(Boolean).join('\n');
            },

            openOptionsPage() {
                browser.runtime.openOptionsPage();
                window.close();
            },
            openManageGroups() {
                BG.openManageGroups(window.screen);
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

        },
    }
</script>

<template>
    <div
        id="stg-popup"
        :class="['is-flex is-column', {'edit-group-popup': !!groupToEdit}]"
        @contextmenu="['INPUT', 'TEXTAREA'].includes($event.target.nodeName) ? null : $event.preventDefault()"
        @wheel.ctrl.prevent
        >
        <header id="searchWrapper">
            <div :class="['field', {'has-addons': search}]">
                <div class="control is-expanded">
                    <input id="search" v-model.trim="search" @input="$refs.search.value === '' ? showSectionDefault() : null" ref="search" type="text" class="input is-small no-shadow" autocomplete="off" :placeholder="lang('searchPlaceholder')" />
                </div>
                <div v-show="search" class="control">
                    <label class="button is-small" @click="showSectionDefault(); $refs.search.focus();">
                        <img class="size-12" src="/icons/close.svg" />
                    </label>
                </div>
            </div>
        </header>

        <main id="result"
            :class="['is-full-width', dragData ? 'drag-' + dragData.itemType : false]">
            <!-- SEARCH TABS -->
            <div v-show="section === SECTION_SEARCH">
                <div v-if="filteredGroupsBySearch.length">
                    <div v-for="group in filteredGroupsBySearch" :key="group.id">
                        <div class="group" @contextmenu="$refs.groupContextMenu.open($event, {group})">
                            <div :class="['item', {'is-active': group === currentGroup}]" @click="loadGroup(group, -1)">
                                <div class="item-icon" :title="group.title">
                                    <img :src="group.iconUrlToDisplay" class="is-inline-block size-16" />
                                </div>
                                <div class="item-title" :title="group.title" v-text="group.title"></div>
                                <div class="item-action hover is-unselectable" @click.stop="showSectionGroupTabs(group)">
                                    <img class="size-16 rotate-180" src="/icons/arrow-left.svg" />
                                    <span class="tabs-text" v-text="lang('groupTabsCount', group.tabs.length)"></span>
                                </div>
                            </div>
                        </div>

                        <div v-for="tab in group.filteredTabsBySearch"
                            @contextmenu="$refs.tabsContextMenu.open($event, {tab, group, tabIndex: tab.index})"
                            @click="loadGroup(group, tab.index)"
                            @mousedown.middle.prevent
                            @mouseup.middle.prevent="removeTab(group.id, tab.index)"
                            :class="['item is-unselectable space-left', {'is-active': group === currentGroup && tab.active}]"
                            :title="getTabTitle(tab)"
                            >
                            <div class="item-icon">
                                <img :src="tab.favIconUrlToDisplay" class="size-16" />
                            </div>
                            <div class="item-title">
                                <span :class="{bordered: !!tab.borderedStyle}" :style="tab.borderedStyle">
                                    <span v-if="!tab.id" :title="lang('thisTabWillCreateAsNew')">
                                        <img src="/icons/refresh.svg" class="size-16 align-text-bottom" />
                                    </span>
                                    <span v-text="tab.title || tab.url"></span>
                                </span>
                            </div>
                            <div class="item-action flex-on-hover">
                                <span class="icon cursor-pointer" @click.stop="removeTab(group.id, tab.index)" :title="lang('deleteTab')">
                                    <img class="size-16" src="/icons/close.svg" />
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
                        v-for="(group, groupIndex) in groups"
                        :key="group.id"
                        :class="['group', {
                            'drag-moving': group.isMoving,
                            'drag-over': group.isOver,
                        }]"
                        @contextmenu="$refs.groupContextMenu.open($event, {group})"

                        draggable="true"
                        @dragstart="dragHandle($event, 'group', ['group'], {itemIndex: groupIndex, item: group, isGroup: true})"
                        @dragenter="dragHandle($event, 'group', ['group'], {itemIndex: groupIndex, item: group, isGroup: true})"
                        @dragover="dragHandle($event, 'group', ['group'], {itemIndex: groupIndex, item: group, isGroup: true})"
                        @dragleave="dragHandle($event, 'group', ['group'], {itemIndex: groupIndex, item: group, isGroup: true})"
                        @drop="dragHandle($event, 'group', ['group'], {itemIndex: groupIndex, item: group, isGroup: true})"
                        @dragend="dragHandle($event, 'group', ['group'], {itemIndex: groupIndex, item: group, isGroup: true})"
                        >
                        <div :class="['item', {'is-active': group === currentGroup}]" @click="loadGroup(group, -1)">
                            <div class="item-icon" :title="group.title">
                                <img :src="group.iconUrlToDisplay" class="is-inline-block size-16" />
                            </div>
                            <div class="item-title" :title="group.title" v-text="group.title"></div>
                            <div class="item-action hover is-unselectable" @click.stop="showSectionGroupTabs(group)">
                                <img class="size-16 rotate-180" src="/icons/arrow-left.svg" />
                                <span class="tabs-text" v-text="lang('groupTabsCount', group.tabs.length)"></span>
                            </div>
                        </div>
                    </div>

                </div>
                <div class="hr"></div>
                <div class="create-new-group">
                    <div class="item" @click="addGroup">
                        <div class="item-icon">
                            <img class="size-16 icon" src="/icons/group-new.svg" />
                        </div>
                        <div class="item-title" v-text="lang('createNewGroup')"></div>
                    </div>
                </div>

                <div v-show="unSyncTabs.length" class="not-sync-tabs">
                    <div class="hr"></div>
                    <p class="h-margin-bottom-10">
                        <span v-text="lang('foundHiddenUnSyncTabsDescription')"></span><br>
                        <a @click="unsyncHiddenTabsMoveToCurrentGroup" v-text="lang('actionHiddenUnSyncTabsMoveAllTabsToCurrentGroup')"></a><br>
                        <a @click="unsyncHiddenTabsCreateNewGroup" v-text="lang('actionHiddenUnSyncTabsCreateGroup')"></a><br>
                        <a @click="unsyncHiddenTabsCloseAll" v-text="lang('actionHiddenUnSyncTabsCloseAll')"></a>
                    </p>
                    <div>
                        <div v-for="tab in unSyncTabs"
                            @contextmenu="$refs.tabsContextMenu.open($event, {tab})"
                            @click="unsyncHiddenTabsShowTabIntoCurrentWindow(tab)"
                            @mousedown.middle.prevent
                            @mouseup.middle.prevent="removeUnSyncTab(tab)"
                            class="item is-unselectable"
                            :title="getTabTitle(tab)"
                            >
                            <div class="item-icon">
                                <img :src="tab.favIconUrlToDisplay" class="size-16" />
                            </div>
                            <div class="item-title">
                                <span :class="{bordered: !!tab.borderedStyle}" :style="tab.borderedStyle" v-text="tab.title || tab.url"></span>
                            </div>
                            <div class="item-action flex-on-hover">
                                <span class="icon cursor-pointer" @click.stop="removeUnSyncTab(tab)" :title="lang('deleteTab')">
                                    <img class="size-16" src="/icons/close.svg" />
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

                    <div class="hr"></div>

                    <div class="group-info item no-hover">
                        <div class="item-icon">
                            <img :src="groupToShow.iconUrlToDisplay" class="is-inline-block size-16" />
                        </div>
                        <div class="item-title" v-text="groupToShow.title"></div>
                        <div class="item-action is-unselectable">
                            <span @click="openGroupSettings(groupToShow)" class="cursor-pointer" :title="lang('groupSettings')">
                                <img src="/icons/settings.svg" class="size-16 icon" />
                            </span>
                            <span @click="removeGroup(groupToShow)" class="cursor-pointer" :title="lang('deleteGroup')">
                                <img src="/icons/group-delete.svg" class="size-16 icon" />
                            </span>
                        </div>
                    </div>

                    <div
                        v-for="(tab, tabIndex) in groupToShow.tabs"
                        :key="tabIndex"
                        @contextmenu="$refs.tabsContextMenu.open($event, {tab, tabIndex, group: groupToShow})"
                        @click="loadGroup(groupToShow, tabIndex)"
                        @mousedown.middle.prevent
                        @mouseup.middle.prevent="removeTab(groupToShow.id, tabIndex)"
                        :class="['item is-unselectable', {
                            'is-active': groupToShow === currentGroup && tab.active,
                            'drag-moving': tab.isMoving,
                            'drag-over': tab.isOver,
                        }]"
                        :title="getTabTitle(tab)"

                        draggable="true"
                        @dragstart="dragHandle($event, 'tab', ['tab'], {itemIndex: tabIndex, item: tab, group: groupToShow})"
                        @dragenter="dragHandle($event, 'tab', ['tab'], {itemIndex: tabIndex, item: tab, group: groupToShow})"
                        @dragover="dragHandle($event, 'tab', ['tab'], {itemIndex: tabIndex, item: tab, group: groupToShow})"
                        @dragleave="dragHandle($event, 'tab', ['tab'], {itemIndex: tabIndex, item: tab, group: groupToShow})"
                        @drop="dragHandle($event, 'tab', ['tab'], {itemIndex: tabIndex, item: tab, group: groupToShow})"
                        @dragend="dragHandle($event, 'tab', ['tab'], {itemIndex: tabIndex, item: tab, group: groupToShow})"
                        >
                        <div class="item-icon">
                            <img :src="tab.favIconUrlToDisplay" class="size-16" />
                        </div>
                        <div class="item-title">
                            <span :class="{bordered: !!tab.borderedStyle}" :style="tab.borderedStyle">
                                <span v-if="!tab.id" :title="lang('thisTabWillCreateAsNew')">
                                    <img src="/icons/refresh.svg" class="size-16 align-text-bottom" />
                                </span>
                                <span v-text="tab.title || tab.url"></span>
                            </span>
                        </div>
                        <div class="item-action flex-on-hover">
                            <span class="icon cursor-pointer" @click.stop="removeTab(groupToShow.id, tabIndex)" :title="lang('deleteTab')">
                                <img class="size-16" src="/icons/close.svg" />
                            </span>
                        </div>
                    </div>

                    <div class="hr"></div>

                    <div class="create-new-tab">
                        <div class="item" @contextmenu="containers.length && $refs.createNewTabContextMenu.open($event)" @click="addTab(null)">
                            <div class="item-icon">
                                <img class="size-16" src="/icons/tab-new.svg">
                            </div>
                            <div class="item-title" v-text="lang('createNewTab')"></div>
                        </div>

                        <context-menu v-if="containers.length" ref="createNewTabContextMenu">
                            <ul class="is-unselectable">
                                <li v-for="container in containers" @click="addTab(container.cookieStoreId)">
                                    <img :src="container.iconUrl" class="is-inline-block size-16 container-icon" :style="{fill: container.colorCode}" />
                                    <span v-text="container.name"></span>
                                </li>
                            </ul>
                        </context-menu>

                    </div>
                </div>
            </div>
        </main>

        <context-menu ref="groupContextMenu">
            <ul slot-scope="menu" class="is-unselectable">
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

                <li class="is-disabled" v-text="lang('moveTabToGroupDisabledTitle')"></li>

                <li
                    v-for="group in groups"
                    :class="{'is-disabled': menu.data.group ? menu.data.group.id === group.id : false}"
                    @click="menu.data.group
                        ? (menu.data.group.id !== group.id && moveTabToGroup(menu.data.tabIndex, menu.data.group.id, group.id))
                        : moveTabToGroup(menu.data.tab.id, undefined, group.id, true)
                        "
                    >
                    <img :src="group.iconUrlToDisplay" class="is-inline-block size-16" />
                    <span v-text="group.title"></span>
                </li>

                <li @click="menu.data.group ? moveTabToNewGroup(menu.data.tabIndex, menu.data.group.id) : moveTabToNewGroup(menu.data.tab.id, undefined, true)">
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
                :browser-action-icon-color="options.browserActionIconColor"
                @saved="groupToEdit = null" />
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

        <div class="spacer"></div>

        <footer class="is-flex is-unselectable">
            <div class="is-flex is-aligin-items-center manage-groups is-full-height is-full-width" @click="openManageGroups" :title="lang('manageGroupsTitle')">
                <img class="icon size-16" src="/icons/icon.svg" />
                <span class="h-margin-left-10" v-text="lang('manageGroupsTitle')"></span>
            </div>
            <div class="is-flex is-aligin-items-center is-vertical-separator"></div>
            <div class="is-flex is-aligin-items-center settings is-full-height" @click="openOptionsPage" :title="lang('settingsTitle')">
                <img class="icon size-16" src="/icons/settings.svg" />
            </div>
        </footer>
    </div>
</template>

<style lang="scss">
    :root {
        --popup-width: 348px;
        --max-popup-width: 800px;

        --max-popup-height: 600px;
        --min-popup-height: 200px;

        --color-light-gray: #eceded;
        --color-gray: #e3e3e3;
        --color-dark-gray: #d4d4d4;
        --color-dark-dark-gray: #bababa;
    }

    html {
        font-size: 13px;
        width: var(--popup-width);
        min-height: var(--min-popup-height);
        max-height: var(--max-popup-height);
        overflow-x: hidden;
    }

    .hr { /* fix FF UI bugs on margin when scrolling */
        height: calc((var(--indent) * 2) + 1px);
        position: relative;

        &::after {
            content: "";
            position: absolute;
            height: 1px;
            left: 0;
            top: 50%;
            width: 100%;
            background-color: var(--color-gray);
        }
    }

    .hr,
    .spacer,
    #stg-popup,
    #searchWrapper,
    #result {
        background-color: #ffffff;
    }

    #stg-popup {
        width: var(--popup-width);
        min-height: var(--min-popup-height);
        max-height: var(--max-popup-height);

        overflow-y: auto;
        // margin: 0 auto;

        &.edit-group-popup {
            min-height: var(--max-popup-height);
        }

        > footer {
            height: 45px;
            min-height: 45px;
            align-items: center;
            justify-content: space-between;
            background-color: var(--color-light-gray);
            cursor: default;

            > :hover {
                background-color: var(--color-gray); /* dark-dark */
            }

            > .manage-groups,
            > .settings {
                padding: 0 20px;
            }
        }

        /* Drag & Drop Styles */
        .drag-group .item > *,
        .drag-tab .item > * {
            pointer-events: none;
        }

        .drag-over {
            outline: 2px dashed rgba(0, 0, 0, 0.5) !important;
            outline-offset: -3px;
        }

        .drag-moving {
            opacity: 0.4;
        }
    }

    .group-circle {
        width: 14px;
        height: 14px;
        margin: 0 auto;
        border-radius: 50%;
        display: inline-block;
        vertical-align: -3px;
    }

    .spacer { /* fix FF UI bugs on margin then scrolling */
        min-height: var(--indent);
    }

    /* END HELPERS */
    #searchWrapper {
        padding: var(--indent);
    }

    #search {
        background: url('/icons/search.svg') no-repeat 4px center;
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
        // border-top: 1px solid transparent;
        // border-bottom: 1px solid transparent;

        &.space-left {
            padding-left: calc(var(--indent) * 2);
        }

        > :last-child {
            padding-right: var(--indent);
        }

        &.is-active,
        // &.is-hover,
        &:not(.no-hover):hover {
            // border-top-color: var(--color-dark-dark-gray);
            // border-bottom-color: var(--color-dark-dark-gray);
        }

        // &.is-hover,
        &:not(.no-hover):not(.is-active):hover {
            background-color: var(--color-light-gray);
        }

        &.is-active {
            background-color: var(--color-gray);
        }

        .hover:hover {
            background-color: var(--color-dark-gray);
        }

        &:not(.no-hover):active,
        .hover:active {
            background-color: var(--color-dark-gray) !important;
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

    .group .tabs-text {
        white-space: nowrap;
        overflow: hidden;
        display: inline-block;
        text-overflow: ellipsis;
    }

    .groups .item .item-action {
        width: 100px;
        min-width: 100px;
        line-height: 1;
    }

    /* .group-icon,
    .tab-icon { */
    // .icon { // TODO refactor this
    //     display: inline-block;
    //     text-align: center;
    //     width: 16px;
    //     height: 16px;
    //     line-height: 0;
    // }

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

    .is-vertical-separator {
        background-color: var(--color-dark-gray);
        width: 1px;
        height: 75%;
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
