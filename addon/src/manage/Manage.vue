<script>
    'use strict';

    import Vue from 'vue';
    import VueLazyload from 'vue-lazyload';

    import utils from '../js/utils';
    import Groups from '../js/groups';
    import Tabs from '../js/tabs';
    import Windows from '../js/windows';
    import storage from '../js/storage';
    import popup from '../js/popup.vue';
    import editGroup from '../js/edit-group.vue';
    import contextMenu from '../js/context-menu-component.vue';
    import constants from '../js/constants';
    // import dnd from '../js/dnd';
    // import { Drag, Drop } from 'vue-drag-drop';
    // import draggable from 'vuedraggable';

    const {BG} = browser.extension.getBackgroundPage();

    document.title = browser.i18n.getMessage('manageGroupsTitle');

    window.addEventListener('error', utils.errorEventHandler);
    Vue.config.errorHandler = utils.errorEventHandler;

    Vue.use(VueLazyload);

    const VIEW_GRID = 'grid',
        VIEW_DEFAULT = VIEW_GRID;

    let currentWindowPopupId = null;

    browser.windows.getCurrent().then(function(win) {
        if (browser.windows.WindowType.POPUP === win.type) {
            currentWindowPopupId = win.id;
            window.addEventListener('resize', function() {
                ['Width', 'Height'].forEach(function(option) {
                    if (window.localStorage['manageGroupsWindow' + option] != window['inner' + option]) {
                        window.localStorage['manageGroupsWindow' + option] = window['inner' + option];
                    }
                });
            });
        }
    });

    export default {
        data() {
            return {
                VIEW_GRID,

                view: VIEW_DEFAULT,

                isLoaded: false,

                hasThumbnailsPermission: false,

                search: '',
                extendedSearch: false,

                groupToEdit: null,
                groupToRemove: null,

                containers: BG.containers.getAll(),
                options: {},

                groups: [],

                dragData: null,
                multipleDropTabs: [],
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
        //     this.hasThumbnailsPermission = await browser.permissions.contains(constants.PERMISSIONS.ALL_URLS);

        //     this.loadOptions();
        // },
        async mounted() {
            this.hasThumbnailsPermission = await browser.permissions.contains(constants.PERMISSIONS.ALL_URLS);

            await this.loadOptions();

            await this.loadGroups();

            this.setupListeners();

            this.isLoaded = true;

            this.$nextTick(function() {
                this.$refs.search.focus();

                this.groups.forEach(group => group.tabs.forEach(tab => !tab.session.thumbnail && !tab.discarded && utils.isTabLoaded(tab) && Tabs.updateThumbnail(tab.id)));
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
        },
        computed: {
            filteredGroups() {
                let searchStr = this.search.toLowerCase();

                return this.groups.map(function(group) {
                    group.filteredTabs = group.tabs.filter(tab => utils.mySearchFunc(searchStr, utils.getTabTitle(tab, true), this.extendedSearch));
                    return group;
                }, this);
            },
        },
        methods: {
            lang: browser.i18n.getMessage,
            safeHtml: utils.safeHtml,

            async loadOptions() {
                let data = await storage.get(null);
                this.options = utils.extractKeys(data, constants.allOptionsKeys);
            },

            setupListeners() {
                this
                    .$on('drag-move-group', function(from, to) {
                        Groups.move(from.data.item.id, this.groups.indexOf(to.data.item));
                    })
                    .$on('drag-move-tab', function(from, to) {
                        let tabsToMove = this.getDataForMultipleMove(),
                            groupId = this.isGroup(to.data.item) ? to.data.item.id : to.data.group.id,
                            index = this.isGroup(to.data.item) ? -1 : to.data.item.index;

                        Tabs.move(tabsToMove, groupId, index, false);
                    })
                    .$on('drag-moving', (item, isMoving) => item.isMoving = isMoving)
                    .$on('drag-over', (item, isOver) => item.isOver = isOver);

                browser.runtime.onMessage.addListener(function(request, sender) {
                    if (!utils.isAllowSender(request, sender)) {
                        return;
                    }

                    switch (request.action) {
                        case 'tab-added':
                            {
                                let group = this.groups.find(gr => gr.id === request.tab.session.groupId);

                                if (group) {
                                    group.tabs.push(this.mapTab(request.tab));
                                } else {
                                    throw Error(utils.errorEventMessage('group for new tab not found', request));
                                }
                            }

                            break;
                        case 'tab-updated':
                            {
                                let tab = null;

                                this.groups.some(gr => tab = gr.tabs.find(t => t.id === request.tab.id));

                                Object.assign(tab, request.tab);
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
                        case 'thumbnail-updated':
                            this.groups.some(function(group) {
                                let tab = group.tabs.find(tab => tab.id === request.tabId);

                                if (tab) {
                                    this.$set(tab.session, 'thumbnail', request.thumbnail);
                                    return true;
                                }
                            }, this);

                            break;
                        case 'group-updated':
                            let group = this.groups.find(gr => gr.id === request.group.id);

                            if (request.group.tabs) {
                                request.group.tabs = request.group.tabs.map(this.mapTab, this);

                                if (this.multipleDropTabs.length) {
                                    // ищем новые замапеные вкладки и добавляем их в мультиселект
                                    group.tabs.forEach(function(tab) {
                                        let multipleTabIndex = this.multipleDropTabs.indexOf(tab);

                                        if (-1 !== multipleTabIndex) {
                                            let mappedTab = request.group.tabs.find(t => t.id === tab.id);

                                            if (mappedTab) {
                                                this.multipleDropTabs.splice(multipleTabIndex, 1, mappedTab);
                                            } else {
                                                this.multipleDropTabs.splice(multipleTabIndex, 1);
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
                            break;
                        case 'options-updated':
                            this.loadOptions();
                            break;
                    }

                }.bind(this));
            },

            getDataForMultipleMove() {
                let tabsToMove = this.multipleDropTabs
                    .map(function(tab) {
                        return {
                            id: tab.id,
                            title: tab.title,
                            url: tab.url,
                            hidden: tab.hidden,
                            sharingState: {...tab.sharingState},
                        };
                    });

                this.multipleDropTabs = [];

                return tabsToMove;
            },

            mapGroup(group) {
                group.tabs = group.tabs.map(this.mapTab, this);
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
                tab.container = BG.containers.isDefault(tab.cookieStoreId) ? false : BG.containers.get(tab.cookieStoreId);
                tab.isMoving = false;
                tab.isOver = false;

                if (!tab.session) {
                    tab.session = {};
                }

                return new Vue({
                    data: tab,
                });
            },

            async loadGroups() {
                let groups = await Groups.load(null, true);

                this.groups = groups.map(this.mapGroup, this);
                this.multipleDropTabs = [];
            },
            addGroup() {
                Groups.add();
            },
            addTab(group, cookieStoreId) {
                Tabs.add(group.id, cookieStoreId);
            },
            removeTab(tab) {
                Tabs.remove(tab);
            },
            updateTabThumbnail(tabId) {
                Tabs.updateThumbnail(tabId, true);
            },
            async applyGroup(groupId, tabId) {
                if (currentWindowPopupId) {
                    await browser.windows.update(currentWindowPopupId, {
                        state: browser.windows.WindowState.MINIMIZED,
                    });
                }

                await BG.applyGroup(null, groupId, tabId);

                if (currentWindowPopupId) {
                    browser.windows.remove(currentWindowPopupId); // close manage groups POPUP window
                }
            },

            getWindowId: BG.cache.getWindowId,

            openGroupInNewWindow(groupId, tabId) {
                let groupWindowId = this.getWindowId(groupId);

                if (groupWindowId) {
                    this.applyGroup(groupId, tabId);
                } else {
                    Windows.create(undefined, groupId, tabId);
                }
            },

            clickOnTab(event, tab, group) {
                if (event.ctrlKey || event.metaKey) {
                    if (this.multipleDropTabs.includes(tab)) {
                        this.multipleDropTabs.splice(this.multipleDropTabs.indexOf(tab), 1);
                    } else {
                        this.multipleDropTabs.push(tab);
                    }
                } else if (event.shiftKey) {
                    if (this.multipleDropTabs.length) {
                        let tabs = group.filteredTabs,
                            tabIndex = tabs.indexOf(tab),
                            lastTabIndex = -1;

                        this.multipleDropTabs.slice().reverse().some(function(t) {
                            return -1 !== (lastTabIndex = tabs.indexOf(t));
                        });

                        if (-1 === lastTabIndex) {
                            this.multipleDropTabs.push(tab);
                        } else if (tabIndex !== lastTabIndex) {
                            let multipleTabIndex = this.multipleDropTabs.indexOf(tabs[lastTabIndex]);

                            for (let i = Math.min(tabIndex, lastTabIndex), maxIndex = Math.max(tabIndex, lastTabIndex); i <= maxIndex; i++) {
                                if (!this.multipleDropTabs.includes(tabs[i])) {
                                    if (tabIndex > lastTabIndex) {
                                        this.multipleDropTabs.push(tabs[i]);
                                    } else {
                                        this.multipleDropTabs.splice(multipleTabIndex, 0, tabs[i]);
                                    }
                                }
                            }
                        }
                    } else {
                        this.multipleDropTabs.push(tab);
                    }
                } else {
                    this.applyGroup(group.id, tab.id);
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

                Groups.remove(group.id);
            },
            setTabIconAsGroupIcon({favIconUrl}, group) {
                Groups.update(group.id, {
                    iconViewType: null,
                    iconUrl: favIconUrl,
                });
            },
            discardTab(tabId) {
                Tabs.discard([tabId]);
            },

            getTabTitle: utils.getTabTitle,
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
                            if (!this.multipleDropTabs.includes(data.item)) {
                                this.multipleDropTabs.push(data.item);
                            }

                            if (1 < this.multipleDropTabs.length) {
                                let multiTabsNode = document.getElementById('multipleTabsText');
                                multiTabsNode.innerText = browser.i18n.getMessage('movingMultipleTabsText', this.multipleDropTabs.length);

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

                        if (1 === this.multipleDropTabs.length) {
                            this.multipleDropTabs = [];
                        }

                        this.dragData = null;
                        break;
                }
            },

            async closeThisWindow() {
                let tab = await browser.tabs.getCurrent();
                browser.tabs.remove(tab.id);
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
        @click="multipleDropTabs = []"
        @keydown.esc="closeThisWindow"
        >
        <header class="is-flex is-align-items-center">
            <span class="page-title">
                <span v-text="lang('extensionName')"></span> - <span v-text="lang('manageGroupsTitle')"></span>
            </span>
            <span class="is-full-width">
                <div class="buttons has-addons">
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
                            :placeholder="lang('searchPlaceholder')"
                            :readonly="!isLoaded"
                            v-model.trim="search" />
                    </div>
                    <div v-show="search" class="control">
                        <label class="button is-small" :title="lang('extendedTabSearch')">
                            <input type="checkbox" v-model="extendedSearch" />
                        </label>
                    </div>
                    <div v-show="search" class="control" @click="search = ''; $refs.search.focus();">
                        <label class="button is-small">
                            <img class="size-12" src="/icons/close.svg" />
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
                            'drag-moving': group.isMoving,
                            'drag-over': group.isOver,
                            'loaded': getWindowId(group.id),
                        }]"
                        @contextmenu="'INPUT' !== $event.target.nodeName && $refs.groupContextMenu.open($event, {group})"

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
                                    <img v-lazy="group.iconUrlToDisplay" />
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
                                    maxlength="120"
                                    />
                            </div>
                            <div class="tabs-count" v-text="lang('groupTabsCount', group.filteredTabs.length)"></div>
                            <div class="group-icon cursor-pointer is-unselectable" @click="openGroupSettings(group)" :title="lang('groupSettings')">
                                <img class="size-16" src="/icons/settings.svg" />
                            </div>
                            <div class="group-icon cursor-pointer is-unselectable" @click="removeGroup(group)" :title="lang('deleteGroup')">
                                <img class="size-16" src="/icons/group-delete.svg" />
                            </div>
                        </div>
                        <div class="body">
                            <div
                                v-for="tab in group.filteredTabs"
                                :key="tab.id"
                                :class="['tab', {
                                    'is-active': tab.active,
                                    'is-in-multiple-drop': multipleDropTabs.includes(tab),
                                    'has-thumbnail': tab.session.thumbnail,
                                    'drag-moving': tab.isMoving,
                                    'drag-over': tab.isOver,
                                }]"
                                :title="getTabTitle(tab, true)"
                                @contextmenu.stop.prevent="$refs.tabsContextMenu.open($event, {tab, group})"

                                @click.stop="clickOnTab($event, tab, group)"

                                draggable="true"
                                @dragstart="dragHandle($event, 'tab', ['tab', 'group'], {item: tab, group})"
                                @dragenter="dragHandle($event, 'tab', ['tab', 'group'], {item: tab, group})"
                                @dragover="dragHandle($event, 'tab', ['tab', 'group'], {item: tab, group})"
                                @dragleave="dragHandle($event, 'tab', ['tab', 'group'], {item: tab, group})"
                                @drop="dragHandle($event, 'tab', ['tab', 'group'], {item: tab, group})"
                                @dragend="dragHandle($event, 'tab', ['tab', 'group'], {item: tab, group})"
                                >
                                <div v-if="tab.favIconUrl" class="tab-icon" :style="tab.container ? {borderColor: tab.container.colorCode} : false">
                                    <img class="size-16" v-lazy="tab.favIconUrl" />
                                </div>
                                <div class="delete-tab-button" @click.stop="removeTab(tab)" :title="lang('deleteTab')" :style="tab.container ? {borderColor: tab.container.colorCode} : false">
                                    <img class="size-14" src="/icons/close.svg" />
                                </div>
                                <div v-if="tab.container" class="container" :title="tab.container.name" :style="{borderColor: tab.container.colorCode}">
                                    <img class="size-16" :src="tab.container.iconUrl" :style="{fill: tab.container.colorCode}">
                                </div>
                                <div v-if="isTabLoading(tab)" class="refresh-icon" :style="tab.container ? {borderColor: tab.container.colorCode} : false">
                                    <img class="spin size-16" src="/icons/refresh.svg"/>
                                </div>
                                <div class="screenshot" :style="tab.container ? {borderColor: tab.container.colorCode} : false">
                                    <img v-if="tab.session.thumbnail" v-lazy="tab.session.thumbnail">
                                </div>
                                <div
                                    @mousedown.middle.prevent
                                    @mouseup.middle.prevent="removeTab(tab)"
                                    :class="['tab-title text-ellipsis', {'tab-discarded': tab.discarded}]"
                                    v-text="getTabTitle(tab)"></div>
                            </div>

                            <div class="tab new" :title="lang('createNewTab')" @click="addTab(group)">
                                <div class="screenshot">
                                    <img src="/icons/tab-new.svg">
                                </div>
                                <div class="tab-title text-ellipsis" v-text="lang('createNewTab')"></div>
                            </div>
                        </div>
                    </div>

                    <div class="group new cursor-pointer" @click="addGroup">
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
                <ul class="is-unselectable">
                    <li @click="addTab(menu.data.group)">
                        <img src="/icons/tab-new.svg" class="size-16" />
                        <span v-text="lang('createNewTab')"></span>
                    </li>
                    <li v-for="container in containers" :key="container.cookieStoreId" @click="addTab(menu.data.group, container.cookieStoreId)">
                        <img :src="container.iconUrl" class="is-inline-block size-16 fill-context" :style="{fill: container.colorCode}" />
                        <span v-text="container.name"></span>
                    </li>
                </ul>
            </template>
        </context-menu>

        <context-menu ref="tabsContextMenu">
            <template v-slot="menu">
                <ul v-if="menu.data" class="is-unselectable">
                    <li @click="openGroupInNewWindow(menu.data.group.id, menu.data.tab.id)">
                        <img src="/icons/window-new.svg" class="size-16" />
                        <span v-text="lang('openGroupInNewWindow')"></span>
                    </li>
                    <li @click="discardTab(menu.data.tab.id)">
                        <img src="/icons/snowflake.svg" class="size-16" />
                        <span v-text="lang('discardTabTitle')"></span>
                    </li>
                    <li @click="setTabIconAsGroupIcon(menu.data.tab, menu.data.group)">
                        <img src="/icons/image.svg" class="size-16" />
                        <span v-text="lang('setTabIconAsGroupIcon')"></span>
                    </li>
                    <li v-if="hasThumbnailsPermission" @click="updateTabThumbnail(menu.data.tab.id)">
                        <img src="/icons/image.svg" class="size-16" />
                        <span v-text="lang('updateTabThumbnail')"></span>
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
                }]
            ">
            <span v-html="lang('deleteGroupBody', safeHtml(groupToRemove.title))"></span>
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
        height: 100vh;
        /* width: 100vw; */

        > header {
            padding: 10px 10px 0 10px;

            > :not(:first-child) {
                margin-left: 20px;
            }

            .page-title {
                font-size: 20px;
            }
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
        padding: 10px 10px 100px 10px;

        // GRID VIEW
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
            /* grid-template-rows: minmax(auto, 600px) minmax(auto, 600px); */
            grid-gap: 10px;

            .group {
                display: flex;
                flex-direction: column;
                border: 1px solid rgba(0, 0, 0, 0.15);
                max-height: 600px;
                background-color: var(--group-bg-color);
                border-radius: var(--border-radius);

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

                    display: grid;
                    grid-gap: var(--margin);
                    /* grid-gap: 10px; */
                    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
                    grid-auto-rows: 100px;

                    min-height: 110px;
                    /* flex-grow: 1; */
                }

                .tab {
                    position: relative;
                    font-size: 12px;
                    cursor: pointer;
                    padding: var(--tab-inner-padding);
                    border-radius: var(--border-radius);

                    > * {
                        border: 0 solid var(--tab-inner-border-color);
                        background-color: var(--group-bg-color);
                    }

                    > .tab-icon,
                    > .delete-tab-button,
                    > .container,
                    > .refresh-icon,
                    > .tab-title {
                        position: absolute;
                    }

                    &:not(.has-thumbnail) > .tab-icon {
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

                    > .container {
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
                        border-width: 2px;

                        > img {
                            width: 4em;
                            height: auto;
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

        .grid .group.drag-over {
            outline-offset: 3px;
        }

        .grid .group .tab.drag-moving.drag-over,
        .grid .group .tab.is-in-multiple-drop.drag-over {
            outline-offset: 4px;
        }

        .drag-moving,
        .drag-tab .tab.is-in-multiple-drop {
            opacity: 0.4;
        }
    }

</style>
