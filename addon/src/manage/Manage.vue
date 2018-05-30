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
        notify('background not inited');
        throw Error('background not inited');
    }

    const VIEW_GRID = 'grid',
        VIEW_DEFAULT = VIEW_GRID;

    export default {
        data() {
            return {
                VIEW_GRID,

                view: VIEW_DEFAULT,

                isLoaded: false,

                search: '',

                currentWindowId: null,

                groupToEdit: null,
                groupToRemove: null,

                containers: [],
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
        created() {
            document.title = this.lang('manageGroupsTitle');

            this
                .$on('drag-move-group', function(from, to) {
                    BG.moveGroup(from.data.item.id, to.data.itemIndex);
                })
                .$on('drag-move-tab', function(from, to) {
                    if (!this.multipleDropTabs.includes(from.data.item)) {
                        this.multipleDropTabs.push(from.data.item);
                    }

                    let newTabIndex = undefined,
                        groupTo = null;

                    if (to.data.isGroup) {
                        groupTo = to.data.item;
                    } else {
                        groupTo = to.data.group;
                        newTabIndex = to.data.itemIndex;
                    }

                    let promise = Promise.resolve(),
                        data = this.getDataForMultipleMove();

                    data.forEach(function(dataItem) {
                        promise = promise.then(() => BG.moveTabToGroup(dataItem.tabIndex, newTabIndex, dataItem.groupId, groupTo.id, false, false));
                    });

                    promise.then(BG.sendMessageGroupsUpdated);
                    // BG.moveTabToGroup(from.data.itemIndex, newTabIndex, from.data.group.id, groupTo.id, false);
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

            this.setupListeners();

            this.isLoaded = true;

            this.$nextTick(function() {
                this.$refs.search.focus();
            });
        },
        watch: {
            // search(search) {
            //     if (search) {
            //         this.showSectionSearch();
            //     }
            // },
            // currentGroup(group) {
            //     if (group && this.groupToShow && group.id === this.groupToShow.id && group._uid !== this.groupToShow._uid) {
            //         this.groupToShow = group;
            //     }
            // },
        },
        computed: {
            currentGroup() {
                return this.groups.find(group => group.windowId === this.currentWindowId); // TODO: if attach/detach tab to other window - need update window id
            },
            filteredGroups() {
                let searchStr = this.search.toLowerCase();

                return this.groups.map(function(group) {
                    group.filteredTabs = group.tabs
                        .filter(function(tab, tabIndex) {
                            tab.index = tabIndex;
                            return this.$_mySearchFunc(searchStr, (tab.title || '').toLowerCase()) || this.$_mySearchFunc(searchStr, tab.url.toLowerCase());
                        }, this);

                    return group;
                }, this);
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

            getDataForMultipleMove() {
                let data = [];

                this.multipleDropTabs.forEach(function(tab) {
                    let groupId = null,
                        tabIndex = null;

                    this.groups.some(function(gr) {
                        let index = gr.tabs.indexOf(tab);

                        if (-1 !== index) {
                            groupId = gr.id;
                            tabIndex = index;
                            return true;
                        }
                    });

                    if (groupId) {
                        data.push({
                            groupId,
                            tabIndex,
                        });
                    }
                }, this);

                return data.reverse();
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

                            return utils.getGroupIconUrl(this, vm.options.browserActionIconColor);
                        },
                    },
                });
            },

            $_tabMap(tab) {
                let vm = this;

                tab.favIconUrlToDisplay = BG.getTabFavIconUrl(tab, this.options.useTabsFavIconsFromGoogleS2Converter);
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
                this.groups = utils.clone(BG.getGroups()).map(this.$_groupMap, this);
            },
            addGroup() {
                BG.addGroup();
            },
            addTab(group, cookieStoreId = constants.DEFAULT_COOKIE_STORE_ID) {
                BG.addTab(group.id, cookieStoreId);
            },
            removeTab(group, tabIndex) {
                this.groups.some(function(gr) {
                    if (gr.id === group.id) {
                        gr.tabs.splice(tabIndex, 1);
                        return true;
                    }
                });

                BG.removeTab(group.id, tabIndex);
            },
            updateTabThumbnail(tabId) {
                BG.updateTabThumbnail(tabId, true);
            },
            loadGroup(group, tabIndex) {
                let groupIndex = this.groups.findIndex(gr => gr.id === group.id);
                BG.loadGroup(this.currentWindowId, groupIndex, tabIndex);
            },

            clickOnTab(event, tabIndex, tab, group) {
                if (event.ctrlKey) {
                    if (this.multipleDropTabs.includes(tab)) {
                        this.multipleDropTabs.splice(this.multipleDropTabs.indexOf(tab), 1);
                    } else {
                        this.multipleDropTabs.push(tab);
                    }
                } else {
                    this.loadGroup(group, tabIndex);
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
            moveTabToGroup(oldTabIndex, oldGroupId, newGroupId) {
                BG.moveTabToGroup(oldTabIndex, undefined, oldGroupId, newGroupId);
            },
            async moveTabToNewGroup(oldTabIndex, oldGroupId) {
                let newGroup = await BG.addGroup(undefined, undefined, false);

                BG.moveTabToGroup(oldTabIndex, undefined, oldGroupId, newGroup.id);
            },
            setTabIconAsGroupIcon(tab, group) {
                BG.updateGroup(group.id, {
                    iconViewType: null,
                    iconUrl: BG.getTabFavIconUrl(tab, this.options.useTabsFavIconsFromGoogleS2Converter),
                });
            },

            getTabTitle(tab) {
                return [tab.title, tab.url].filter(Boolean).join('\n');
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
    <!-- single view -->
    <!-- grid display -->
    <!-- free arrange -->

    <div id="stg-manage" class="is-flex is-column" @contextmenu="['INPUT', 'TEXTAREA'].includes($event.target.nodeName) ? null : $event.preventDefault()">
        <header class="is-flex is-aligin-items-center">
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
                <div id="searchWrapper" :class="['field', {'has-addons': search}]">
                    <div class="control is-expanded">
                        <input :readonly="!isLoaded" ref="search" v-model.trim="search" type="text" class="input is-small" :placeholder="lang('filterTabsPlaceholder')" autocomplete="on" />
                    </div>
                    <div v-show="search" class="control" @click="search = ''">
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

                        v-dnd:group.group="{itemIndex: groupIndex, item: group}"

                        TODO move to dnd.js

                    -->


                     <div
                        v-for="(group, groupIndex) in filteredGroups"
                        :key="group.id"
                        :class="['group', {
                            'drag-moving': group.isMoving,
                            'drag-over': group.isOver,
                        }]"
                        @contextmenu="'INPUT' !== $event.target.nodeName && $refs.groupContextMenu.open($event, {group})"

                        :draggable="String(group.draggable)"
                        @dragstart="dragHandle($event, 'group', ['group'], {itemIndex: groupIndex, item: group, isGroup: true})"
                        @dragenter="dragHandle($event, 'group', ['group'], {itemIndex: groupIndex, item: group, isGroup: true})"
                        @dragover="dragHandle($event, 'group', ['group'], {itemIndex: groupIndex, item: group, isGroup: true})"
                        @dragleave="dragHandle($event, 'group', ['group'], {itemIndex: groupIndex, item: group, isGroup: true})"
                        @drop="dragHandle($event, 'group', ['group'], {itemIndex: groupIndex, item: group, isGroup: true})"
                        @dragend="dragHandle($event, 'group', ['group'], {itemIndex: groupIndex, item: group, isGroup: true})"

                        >
                        <div class="header">
                            <div class="group-title">
                                <input
                                    type="text"
                                    @focus="group.draggable = false"
                                    @blur="group.draggable = true"
                                    v-model.lazy.trim="group.title"
                                    :placeholder="lang('title')"
                                    maxlength="120"
                                    />
                            </div>
                            <div class="group-icon">
                                <figure class="image is-16x16">
                                    <img :src="group.iconUrlToDisplay" class="is-inline-block size-16" />
                                </figure>
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
                                :key="tab.index"
                                :class="['tab', {
                                    'is-active': tab.active,
                                    'is-current': tab.active && group.windowId,
                                    'is-in-multiple-drop': multipleDropTabs.includes(tab),
                                    'has-thumbnail': tab.thumbnail,
                                    'drag-moving': tab.isMoving,
                                    'drag-over': tab.isOver,
                                }]"
                                :title="getTabTitle(tab)"
                                @contextmenu.stop.prevent="$refs.tabsContextMenu.open($event, {tab, group, tabIndex: tab.index})"

                                @click.stop="clickOnTab($event, tab.index, tab, group)"

                                draggable="true"
                                @dragstart="dragHandle($event, 'tab', ['tab', 'group'], {itemIndex: tab.index, item: tab, group})"
                                @dragenter="dragHandle($event, 'tab', ['tab', 'group'], {itemIndex: tab.index, item: tab, group})"
                                @dragover="dragHandle($event, 'tab', ['tab', 'group'], {itemIndex: tab.index, item: tab, group})"
                                @dragleave="dragHandle($event, 'tab', ['tab', 'group'], {itemIndex: tab.index, item: tab, group})"
                                @drop="dragHandle($event, 'tab', ['tab', 'group'], {itemIndex: tab.index, item: tab, group})"
                                @dragend="dragHandle($event, 'tab', ['tab', 'group'], {itemIndex: tab.index, item: tab, group})"
                                >
                                <div v-if="tab.favIconUrlToDisplay" class="tab-icon" :style="tab.container && {borderColor: tab.container.colorCode}">
                                    <img class="size-16" :src="tab.favIconUrlToDisplay" />
                                </div>
                                <div class="delete-tab-button" @click.stop="removeTab(group, tab.index)" :title="lang('deleteTab')" :style="tab.container && {borderColor: tab.container.colorCode}">
                                    <img class="size-14" src="/icons/close.svg" />
                                </div>
                                <div v-if="tab.container" class="container" :title="tab.container.name" :style="{borderColor: tab.container.colorCode}">
                                    <img class="size-16" :src="tab.container.iconUrl" :style="{fill: tab.container.colorCode}">
                                </div>
                                <div v-if="!tab.id" class="refresh-icon" :title="lang('thisTabWillCreateAsNew')" :style="{borderColor: tab.container.colorCode}">
                                    <img class="size-16" src="/icons/refresh.svg"/>
                                </div>
                                <div class="screenshot" :style="tab.container && {borderColor: tab.container.colorCode}">
                                    <img :src="tab.thumbnail">
                                </div>
                                <div class="tab-title text-ellipsis" v-text="tab.title || tab.url"></div>
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

        <context-menu ref="groupContextMenu">
            <ul slot-scope="menu" class="is-unselectable">
                <li @click="addTab(menu.data.group)">
                    <img src="/icons/tab-new.svg" class="size-16" />
                    <span v-text="lang('createNewTab')"></span>
                </li>
                <li v-for="container in containers" :key="container.cookieStoreId" @click="addTab(menu.data.group, container.cookieStoreId)">
                    <img :src="container.iconUrl" class="is-inline-block size-16 container-icon" :style="{fill: container.colorCode}" />
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
                <li v-if="menu.data.tab.id" @click="updateTabThumbnail(menu.data.tab.id)">
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
                :browser-action-icon-color="options.browserActionIconColor"
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
        --fill-color: #5d5d5d;

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

    #searchWrapper {
        width: 300px;
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

                transition: transform 0.3s;

                > .header {
                    display: flex;
                    align-items: center;
                    padding: var(--margin);

                    > * {
                        display: flex;
                    }

                    > .group-title {
                        flex-grow: 1;

                        > input {
                            width: 100%;
                            font-size: 12px;
                            background-color: transparent;
                            border: 1px solid #e4e4e4;
                            padding: 1px 3px;
                        }

                        > input:focus {
                            border: 1px solid #d5d5d5;
                            background-color: #ffffff;
                        }
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

                    > * > * {
                        pointer-events: none;
                    }

                    > * {
                        border: 0 solid var(--tab-inner-border-color);
                        background-color: var(--tab-bg-color);
                    }

                    img {
                        -moz-context-properties: fill;
                        fill: var(--fill-color);
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

                    &:hover,
                    &:hover > * {
                        background-color: var(--active-tab-bg-color);
                    }

                    &.is-active {
                        outline: 1px solid #0093e0;
                    }

                    &:not(.is-active):hover {
                        outline: 1px solid #cfcfcf;
                    }

                    &.is-in-multiple-drop,
                    &.is-in-multiple-drop > * {
                        --fill-color: #ffffff;
                        background-color: var(--multiple-drag-tab-bg-color);
                    }

                    &.is-in-multiple-drop > .tab-title {
                        color: #ffffff;
                    }

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
                            -moz-context-properties: fill;
                            fill: var(--fill-color);
                        }
                    }
                }
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

        .drag-over {
            outline: 2px dashed rgba(0, 0, 0, 0.5) !important;
        }

        .group.drag-over {
            outline-offset: 3px;
        }

        .drag-moving,
        .drag-tab .tab.is-in-multiple-drop {
            opacity: 0.4;
            animation-name: in-out;
            animation-duration: 0.5s;
            animation-iteration-count: infinite;
            animation-direction: alternate;
        }
    }

    @keyframes in-out {
        from {
            transform: scale(0.95);
        }
        to {
            transform: scale(0.8);
        }
    }

</style>
