<script>
    'use strict';

    import * as utils from '../js/utils';
    import storage from '../js/storage';
    import * as constants from '../js/constants';

    import Vue from 'vue';

    import popup from '../js/popup.vue';
    import editGroup from '../js/edit-group.vue';
    import contextMenu from '../js/context-menu-component.vue';
    // import dnd from '../js/dnd';
    // import { Drag, Drop } from 'vue-drag-drop';
    // import draggable from 'vuedraggable';

    const BG = (function(bgWin) {
        return bgWin && bgWin.background && bgWin.background.inited ? bgWin.background : false;
    })(browser.extension.getBackgroundPage());

    if (!BG) {
        setTimeout(() => window.location.reload(), 3000);
        document.getElementById('stg-manage').innerText = browser.i18n.getMessage('waitingToLoadAllTabs');
        throw Error('wait loading addon');
    }

    const VIEW_GRID = 'grid',
        VIEW_DEFAULT = VIEW_GRID;

    let currentWindow = null;

    function setSaveWindowPositionTimer() {
        setTimeout(async function() {
            currentWindow = await BG.getWindow();

            if (window.localStorage.manageGroupsWindowLeft != currentWindow.left) {
                window.localStorage.manageGroupsWindowLeft = currentWindow.left;
            }

            if (window.localStorage.manageGroupsWindowTop != currentWindow.top) {
                window.localStorage.manageGroupsWindowTop = currentWindow.top;
            }

            if (window.localStorage.manageGroupsWindowWidth != currentWindow.width) {
                window.localStorage.manageGroupsWindowWidth = currentWindow.width;
            }

            if (window.localStorage.manageGroupsWindowHeight != currentWindow.height) {
                window.localStorage.manageGroupsWindowHeight = currentWindow.height;
            }

            setSaveWindowPositionTimer();
        }, 5000);
    }

    export default {
        data() {
            return {
                VIEW_GRID,

                view: VIEW_DEFAULT,

                isLoaded: false,

                search: '',
                extendedSearch: false,

                currentWindowId: null,

                groupToEdit: null,
                groupToRemove: null,

                containers: [],
                options: {},
                thumbnails: BG.getThumbnails(),

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
        created() {
            document.title = this.lang('manageGroupsTitle');

            this
                .$on('drag-move-group', function(from, to) {
                    BG.moveGroup(from.data.item.id, this.groups.indexOf(to.data.item));
                })
                .$on('drag-move-tab', async function(from, to) {
                    let tabsToMove = this.getDataForMultipleMove(),
                        toData = {};

                    if (this.isGroup(to.data.item)) {
                        toData.groupId = to.data.item.id;
                    } else {
                        toData.groupId = to.data.group.id;
                        toData.newTabIndex = to.data.group.tabs.indexOf(to.data.item);
                    }

                    BG.moveTabs(tabsToMove, toData, false).catch(utils.notify);
                })
                .$on('drag-moving', (item, isMoving) => item.isMoving = isMoving)
                .$on('drag-over', (item, isOver) => item.isOver = isOver);
        },
        async mounted() {
            await this.loadOptions();

            currentWindow = await BG.getWindow();

            this.currentWindowId = currentWindow.id;

            this.containers = await utils.loadContainers();

            this.loadGroups();

            this.setupListeners();

            this.isLoaded = true;

            this.$nextTick(function() {
                this.$refs.search.focus();
            });

            if ('popup' === currentWindow.type) {
                setSaveWindowPositionTimer();
            }
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
            currentGroup() {
                // TODO: if attach/detach manage group tab to other window - need update window id
                return this.groups.find(group => group.windowId === this.currentWindowId);
            },
            filteredGroups() {
                let searchStr = this.search.toLowerCase();

                return this.groups.map(function(group) {
                    group.filteredTabs = group.tabs
                        .filter(function(tab) {
                            return utils.mySearchFunc(searchStr, tab.title, this.extendedSearch)
                                || utils.mySearchFunc(searchStr, tab.url, this.extendedSearch);
                        }, this);

                    return group;
                }, this);
            },
        },
        methods: {
            lang: browser.i18n.getMessage,
            safeHtml: utils.safeHtml,

            async loadOptions() {
                this.options = await storage.get(constants.allOptionsKeys);
            },

            setupListeners() {
                let listener = function(request, sender) {
                    if (!utils.isAllowSender(request, sender)) {
                        return;
                    }

                    switch (request.action) {
                        case 'thumbnail-updated':
                            this.$set(this.thumbnails, request.url, request.thumbnail);
                            break;
                        case 'thumbnails-updated':
                            this.thumbnails = BG.getThumbnails();
                            break;
                        case 'group-updated':
                            let groupIndex = this.groups.findIndex(group => group.id === request.group.id);

                            if (request.group.tabs) {
                                this.groups[groupIndex].tabs.forEach(function(tab) {
                                    let multipleTabIndex = this.multipleDropTabs.indexOf(tab);

                                    if (-1 !== multipleTabIndex) {
                                        this.multipleDropTabs.splice(multipleTabIndex, 1);
                                    }
                                }, this);

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
                        case 'options-updated':
                            this.loadOptions();
                            break;
                    }

                }.bind(this);

                browser.runtime.onMessage.addListener(listener);
                window.addEventListener('unload', () => browser.runtime.onMessage.removeListener(listener));
            },

            getDataForMultipleMove() {
                let tabsToMove = [];

                this.multipleDropTabs.forEach(function(tab) {
                    if (tab.id) {
                        tabsToMove.push({
                            tabId: tab.id,
                        });
                    } else {
                        this.groups.some(function(group) {
                            let tabIndex = group.tabs.indexOf(tab);

                            if (-1 !== tabIndex) {
                                tabsToMove.push({
                                    tabIndex: tabIndex,
                                    groupId: group.id,
                                });
                                return true;
                            }
                        });
                    }
                }, this);

                this.multipleDropTabs = [];

                return tabsToMove.reverse();
            },

            $_groupMap(group) {
                let vm = this;

                group.tabs = group.tabs.map(this.$_tabMap, this);
                group.draggable = true;
                group.isMoving = false;
                group.isOver = false;

                return new Vue({
                    data: group,
                    watch: {
                        title: function(title) {
                            BG.updateGroup(this.id, {
                                title: utils.createGroupTitle(title, this.id),
                            });
                        },
                    },
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
                tab.container = (function() {
                    if (utils.isDefaultCookieStoreId(tab.cookieStoreId)) {
                        return false;
                    }

                    return vm.containers.find(container => container.cookieStoreId === tab.cookieStoreId);
                })();
                tab.isMoving = false;
                tab.isOver = false;

                return new Vue({
                    data: tab,
                });
            },

            loadGroups() {
                this.groups = BG.getGroups().map(this.$_groupMap, this);
                this.multipleDropTabs = [];
            },
            addGroup() {
                BG.addGroup();
            },
            addTab(group, cookieStoreId) {
                BG.addTab(group.id, cookieStoreId);
            },
            removeTab(group, tab) {
                let tabIndex = group.tabs.indexOf(tab);

                group.tabs.splice(tabIndex, 1);

                BG.removeTab(group.id, tabIndex);
            },
            updateTabThumbnail(tab) {
                BG.updateTabThumbnail(tab, true);
            },
            loadGroup(group, tabIndex) {
                // fix bug with browser.windows.getLastFocused({windowTypes: ['normal']}), maybe find exists bug??
                let lastFocusedNormalWindow = BG.getLastFocusedNormalWindow();

                let groupIndex = this.groups.findIndex(gr => gr.id === group.id);

                BG.loadGroup(lastFocusedNormalWindow.id, groupIndex, tabIndex);

                if ('popup' === currentWindow.type) {
                    browser.windows.remove(currentWindow.id); // close manage groups popop window
                }
            },

            clickOnTab(event, tab, group) {
                if (event.ctrlKey) {
                    if (this.multipleDropTabs.includes(tab)) {
                        this.multipleDropTabs.splice(this.multipleDropTabs.indexOf(tab), 1);
                    } else {
                        this.multipleDropTabs.push(tab);
                    }
                } else {
                    this.loadGroup(group, group.tabs.indexOf(tab));
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
            },
            setTabIconAsGroupIcon(tab, group) {
                BG.updateGroup(group.id, {
                    iconViewType: null,
                    iconUrl: BG.getTabFavIconUrl(tab),
                });
            },

            getTabTitle: utils.getTabTitle,

            makeSafeUrlForThumbnail: utils.makeSafeUrlForThumbnail,

            isGroup(obj) {
                return 'tabs' in obj;
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

                        if ('tab' === itemType) {
                            if (!this.multipleDropTabs.includes(data.item)) {
                                this.multipleDropTabs.push(data.item);
                            }

                            if (1 < this.multipleDropTabs.length) {
                                let multiTabsNode = document.getElementById('multipleTabsText');
                                multiTabsNode.innerText = browser.i18n.getMessage('movingMultipleTabsText', this.multipleDropTabs.length);

                                event.dataTransfer.setDragImage(multiTabsNode, multiTabsNode.clientWidth / 2, multiTabsNode.offsetHeight - 100);
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

        },
    }
</script>

<template>
    <!-- single view -->
    <!-- grid display -->
    <!-- free arrange -->

    <div id="stg-manage" class="is-flex is-column" @contextmenu="['INPUT', 'TEXTAREA'].includes($event.target.nodeName) ? null : $event.preventDefault()">
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
                        <input :readonly="!isLoaded" ref="search" v-model.trim="search" type="text" class="input is-small" :placeholder="lang('filterTabsPlaceholder')" autocomplete="on" />
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
                            'loaded': group.windowId,
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
                                    <img :src="group.iconUrlToDisplay" />
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
                                :key="group.tabs.indexOf(tab)"
                                :class="['tab', {
                                    'is-active': tab.active,
                                    'is-current': tab.active && group.windowId,
                                    'is-in-multiple-drop': multipleDropTabs.includes(tab),
                                    'has-thumbnail': thumbnails[makeSafeUrlForThumbnail(tab.url)],
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
                                <div v-if="tab.favIconUrlToDisplay" class="tab-icon" :style="tab.container ? {borderColor: tab.container.colorCode} : false">
                                    <img class="size-16" :src="tab.favIconUrlToDisplay" />
                                </div>
                                <div class="delete-tab-button" @click.stop="removeTab(group, tab)" :title="lang('deleteTab')" :style="tab.container ? {borderColor: tab.container.colorCode} : false">
                                    <img class="size-14" src="/icons/close.svg" />
                                </div>
                                <div v-if="tab.container" class="container" :title="tab.container.name" :style="{borderColor: tab.container.colorCode}">
                                    <img class="size-16" :src="tab.container.iconUrl" :style="{fill: tab.container.colorCode}">
                                </div>
                                <div v-if="!tab.id" class="refresh-icon" :title="lang('thisTabWillCreateAsNew')" :style="tab.container ? {borderColor: tab.container.colorCode} : false">
                                    <img class="size-16" src="/icons/refresh.svg"/>
                                </div>
                                <div class="screenshot" :style="tab.container ? {borderColor: tab.container.colorCode} : false">
                                    <img v-if="thumbnails[makeSafeUrlForThumbnail(tab.url)]" :src="thumbnails[makeSafeUrlForThumbnail(tab.url)]">
                                </div>
                                <div
                                    @mousedown.middle.prevent
                                    @mouseup.middle.prevent="removeTab(group, tab)"
                                    class="tab-title text-ellipsis"
                                    v-text="getTabTitle(tab)"></div>
                            </div>

                            <div class="tab new" :title="lang('createNewTab')" @click="addTab(group)">
                                <div class="screenshot">
                                    <img src="/icons/tab-new.svg" class="size-16">
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
            <div class="loading" v-show="!isLoaded">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
                    <path d="M288 39.056v16.659c0 10.804 7.281 20.159 17.686 23.066C383.204 100.434 440 171.518 440 256c0 101.689-82.295 184-184 184-101.689 0-184-82.295-184-184 0-84.47 56.786-155.564 134.312-177.219C216.719 75.874 224 66.517 224 55.712V39.064c0-15.709-14.834-27.153-30.046-23.234C86.603 43.482 7.394 141.206 8.003 257.332c.72 137.052 111.477 246.956 248.531 246.667C393.255 503.711 504 392.788 504 256c0-115.633-79.14-212.779-186.211-240.236C302.678 11.889 288 23.456 288 39.056z"></path>
                </svg>
            </div>
        </transition>

        <div id="multipleTabsText"></div>

        <context-menu ref="groupContextMenu">
            <ul slot-scope="menu" class="is-unselectable">
                <li @click="addTab(menu.data.group)">
                    <img src="/icons/tab-new.svg" class="size-16" />
                    <span v-text="lang('createNewTab')"></span>
                </li>
                <li v-for="container in containers" :key="container.cookieStoreId" @click="addTab(menu.data.group, container.cookieStoreId)">
                    <img :src="container.iconUrl" class="is-inline-block size-16 fill-context" :style="{fill: container.colorCode}" />
                    <span v-text="container.name"></span>
                </li>
            </ul>
        </context-menu>

        <context-menu ref="tabsContextMenu">
            <ul slot-scope="menu" v-if="menu.data" class="is-unselectable">
                <li @click="setTabIconAsGroupIcon(menu.data.tab, menu.data.group)">
                    <img src="/icons/image.svg" class="size-16" />
                    <span v-text="lang('setTabIconAsGroupIcon')"></span>
                </li>
                <li v-if="options.createThumbnailsForTabs" @click="updateTabThumbnail(menu.data.tab)">
                    <img src="/icons/image.svg" class="size-16" />
                    <span v-text="lang('updateTabThumbnail')"></span>
                </li>
            </ul>
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
                :group="groupToEdit"
                :containers="containers"
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
        --tab-hover-outline-color: #cfcfcf;
        --is-in-multiple-drop-text-color: #ffffff;
        --border-radius: 3px;
        --group-shadow: 0 0 0 0.2em rgba(3, 102, 214, 0.3);
        --tab-shadow: 0 0 2px 3px rgba(3, 102, 214, 0.5);

        --group-bg-color: #fcfcfc;

        --tab-inner-padding: 3px;
        --tab-inner-border-color: #c6ced4;
        --tab-bg-color: var(--group-bg-color);
        --tab-border-width: 1px;
        --tab-buttons-radius: 75%;
        --tab-buttons-size: 25px;
        --active-tab-bg-color: #e4e4e4;
        --multiple-drag-tab-bg-color: #1e88e5;
    }

    html.dark-theme {
        --text-color: #e0e0e0;
        --group-bg-color: #444444;
        --tab-bg-color: var(--group-bg-color);
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
        animation: spin 2s linear infinite;
    }

    #multipleTabsText {
        position: fixed;
        text-align: center;
        color: #000;
        font-size: 15px;
        font-weight: bold;
        background-color: #fff;
        border-radius: 50%;
        left: -1000%;
        max-width: 450px;
        padding: 100px;
        pointer-events: none;
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

                    > :not(.delete-tab-button):not(.tab-title) {
                        pointer-events: none;
                    }

                    > * {
                        border: 0 solid var(--tab-inner-border-color);
                        background-color: var(--tab-bg-color);
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
                        display: flex;
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

                        > img {
                            width: 4em;
                            height: auto;
                        }
                    }

                    // &:hover,
                    // &:hover > * {
                    //     background-color: var(--active-tab-bg-color);
                    // }

                    &.is-active {
                        outline: 1px solid var(--outline-color);
                        box-shadow: var(--tab-shadow);
                    }

                    &:not(.is-active):not(.drag-moving):hover {
                        outline: 1px solid var(--tab-hover-outline-color);
                        outline-offset: 1px;
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
                    border-color: var(--outline-color);
                    box-shadow: var(--group-shadow);
                }

                &.new {
                    display: flex;
                    align-content: center;
                    justify-content: center;
                    min-height: 250px;

                    > .body {
                        display: block;
                        text-align: center;

                        > img {
                            width: 100px;
                        }
                    }
                }
            }

            .group,
            .group .tab {
                will-change: transition;
                transition-property: transform;
                transition: transform 0.3s;
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

        .group.drag-over {
            outline-offset: 3px;
        }

        .drag-moving,
        .drag-tab .tab.is-in-multiple-drop {
            opacity: 0.4;
            transform: scale(0.8);
        }
    }

    @keyframes spin {
        100% {
            transform: rotate(360deg);
        }
    }

</style>
