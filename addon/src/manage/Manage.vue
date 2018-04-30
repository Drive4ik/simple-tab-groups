<script>
    'use strict';

    import * as utils from '../js/utils';
    import storage from '../js/storage';
    import * as constants from '../js/constants';

    import Vue from 'vue';

    import popup from '../js/popup.vue';
    import editGroup from '../js/edit-group.vue';
    import contextMenu from '../js/context-menu-component.vue';
    import draggable from 'vuedraggable';

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

                search: '',

                currentWindowId: null,

                groupToEdit: null,
                groupToRemove: null,

                containers: [],
                options: {},

                groups: [],
            };
        },
        components: {
            popup: popup,
            'edit-group': editGroup,
            'context-menu': contextMenu,

            draggable: draggable,
        },
        created() {
            document.title = this.lang('manageGroupsTitle');
        },
        async mounted() {
            let currentWindow = await BG.getWindow();
            this.currentWindowId = currentWindow.id;

            this.containers = await utils.loadContainers();

            this.options = await storage.get(constants.allOptionsKeys);

            this.loadGroups();

            this.setupListeners();

            this.$refs.search.focus();
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
                            return this.$_mySearchFunc(searchStr, tab.title.toLowerCase()) || this.$_mySearchFunc(searchStr, tab.url.toLowerCase());
                        }, this);

                    return group;
                }, this);
            },
            groupToRemovePopupData() {
                if (!this.groupToRemove) {
                    return null;
                }

                if (this.groupToRemove.windowId === this.currentWindowId && 1 === this.groups.length && this.groupToRemove.tabs.length) {
                    return {
                        title: this.lang('warning'),
                        body: this.lang('confirmDeleteLastGroupAndCloseTabs'),
                    };
                }

                return {
                    title: this.lang('deleteGroupTitle'),
                    body: this.lang('deleteGroupBody', utils.safeHtml(this.groupToRemove.title)),
                };
            },
        },
        methods: {
            lang: browser.i18n.getMessage,

            setupListeners() {
                let listener = function(request, sender) {
                    if (!utils.isAllowSender(request, sender)) {
                        return;
                    }

                    console.info('BG event:', request.action, utils.clone(request));

                    if ('group-updated' === request.action) { // group
                        let groupIndex = this.groups.findIndex(group => group.id === request.group.id);

                        if (request.group.tabs) {
                            request.group.tabs = request.group.tabs.map(this.$_tabMap, this);
                        }

                        Object.assign(this.groups[groupIndex], request.group);
                    } else if (['group-loaded', 'groups-updated'].includes(request.action)) {
                        this.loadGroups();
                    }

                }.bind(this);

                browser.runtime.onMessage.addListener(listener);
                window.addEventListener('unload', () => browser.runtime.onMessage.removeListener(listener));
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

                Object.assign(group, {
                    tabs: group.tabs.map(vm.$_tabMap, vm),
                });

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

                Object.assign(tab, {
                    favIconUrlToDisplay: BG.getTabFavIconUrl(tab, this.options.useTabsFavIconsFromGoogleS2Converter),
                    container: (function() {
                        if (utils.isDefaultCookieStoreId(tab.cookieStoreId)) {
                            return false;
                        }

                        return vm.containers.find(container => container.cookieStoreId === tab.cookieStoreId);
                    })(),
                });

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
            async loadGroup(group, tabIndex) {
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

                await BG.loadGroup(this.currentWindowId, groupIndex, tabIndex);

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

                this.groups.splice(this.groups.indexOf(group), 1);

                this.showSectionDefault();
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

                if (group.windowId === this.currentWindowId) {
                    BG.updateBrowserActionData(this.currentWindowId);
                    BG.updateMoveTabMenus(this.currentWindowId);
                }
            },

            sortGroups(vector) {
                BG.sortGroups(vector);
            },

            handleDrop(...args) {
                console.log('handleDrop', args);
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
                        <input ref="search" v-model.trim="search" type="text" class="input is-small" :placeholder="lang('filterTabsPlaceholder')" autocomplete="on" />
                    </div>
                    <div v-show="search" class="control" @click="search = ''">
                        <label class="button is-small">
                            <img class="size-12" src="/icons/close.svg" alt="" />
                        </label>
                    </div>
                </div>
            </span>
        </header>

        <main id="result">
            <!-- GRID -->
            <div v-if="view === VIEW_GRID">
                <draggable class="grid" :list="filteredGroups" :options="{group: 'group'}">
                    <div
                        class="group"
                        v-for="group in filteredGroups"
                        :key="group.id"
                        @contextmenu="'INPUT' !== $event.target.nodeName && $refs.groupContextMenu.open($event, {group})"
                        >
                        <div class="header">
                            <div class="group-title">
                                <input type="text" v-model.lazy.trim="group.title" data-group-id="" maxlength="120" placeholder="Please enter group name" />
                            </div>
                            <div class="group-icon">
                                <figure class="image is-16x16">
                                    <img :src="group.iconUrlToDisplay" class="is-inline-block size-16" alt="" />
                                </figure>
                            </div>
                            <div class="tabs-count" v-text="lang('groupTabsCount', group.filteredTabs.length)"></div>
                            <div class="group-icon cursor-pointer is-unselectable" @click="openGroupSettings(group)" :title="lang('groupSettings')">
                                <img class="size-16" src="/icons/settings.svg" alt="" />
                            </div>
                            <div class="group-icon cursor-pointer is-unselectable" @click="removeGroup(group)" data-action="show-delete-group-popup" data-group-id="" :title="lang('deleteGroup')">
                                <img class="size-16" src="/icons/group-delete.svg" alt="" />
                            </div>
                        </div>
                        <div class="body">
                            <div
                                v-for="tab in group.filteredTabs"
                                @contextmenu.stop.prevent="$refs.tabsContextMenu.open($event, {tab, group, tabIndex: tab.index})"
                                :class="['tab cursor-pointer', {
                                    'is-active': tab.active,
                                    'is-current': tab.active && group.windowId,
                                    'has-thumbnail': tab.thumbnail,

                                }]"
                                :title="options.showUrlTooltipOnTabHover && (tab.title + '\n' + tab.url)"
                                data-is-tab="true" data-action="load-group" data-group-id="" data-tab-index="" data-draggable-group="tabs"
                                >
                                <div v-if="tab.favIconUrlToDisplay" class="tab-icon" :style="tab.container && {borderColor: tab.container.colorCode}">
                                    <img class="size-16" :src="tab.favIconUrlToDisplay" alt="" />
                                </div>
                                <div class="delete-tab-button" @click="removeTab(group, tab.index)" data-action="remove-tab" data-group-id="" data-tab-index="" :title="lang('deleteTab')" :style="tab.container && {borderColor: tab.container.colorCode}">
                                    <img class="size-14" src="/icons/close.svg" alt="" />
                                </div>
                                <div v-if="tab.container" class="container" :style="{borderColor: tab.container.colorCode}">
                                    <img class="size-16" :src="tab.container.iconUrl" :style="{fill: tab.container.colorCode}" alt="">
                                </div>
                                <div class="screenshot" :style="tab.container && {borderColor: tab.container.colorCode}">
                                    <img :src="tab.thumbnail" alt="">
                                </div>
                                <div class="tab-title has-text-centered text-ellipsis" v-text="tab.title"></div>
                            </div>

                            <div class="tab new cursor-pointer" :title="lang('createNewTab')" @click="addTab(group)">
                                <div class="screenshot">
                                    <img src="/icons/tab-new.svg" alt="">
                                </div>
                                <div class="tab-title has-text-centered text-ellipsis" v-text="lang('createNewTab')"></div>
                            </div>
                        </div>
                    </div>
                </draggable>

                <div class="group new cursor-pointer" data-action="add-group">
                    <div class="body">
                        <img src="/icons/group-new.svg" alt="">
                        <div class="h-margin-top-10" v-text="lang('createNewGroup')"></div>
                    </div>
                </div>
            </div>
        </main>

        <context-menu v-if="containers.length" ref="groupContextMenu">
            <ul slot-scope="menu" class="is-unselectable">
                <li v-for="container in containers" @click="addTab(menu.data.group, container.cookieStoreId)">
                    <img :src="container.iconUrl" class="is-inline-block size-16 container-icon" :style="{fill: container.colorCode}" alt="" />
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
            </ul>
        </context-menu>

        <popup
            v-if="groupToEdit"
            title="groupSettings"
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


        <!-- <footer class="is-flex is-unselectable">
            footer
        </footer> -->
    </div>

</template>

<style lang="scss">
    :root {
        --margin: 5px;
        --tab-inner-padding: 3px;
        --fill-color: #818181;
        --active-tab-bg-color: #e4e4e4;
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

        // GRID VIEW
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
            /* grid-template-rows: minmax(auto, 600px) minmax(auto, 600px); */
            grid-gap: 10px;
            padding: 10px;

            .group {
                display: flex;
                flex-direction: column;
                border: 1px solid rgba(0, 0, 0, 0.15);
                max-height: 600px;
                background-color: #fcfcfc;

                transition: transform 0.3s;
            }

            .group > .header {
                display: flex;
                align-items: center;
                padding: var(--margin);
            }

            .group > .header > * {
                display: flex;
            }

            .group > .header > .group-title {
                flex-grow: 1;
            }

            .group > .header > .group-title > input {
                width: 100%;
                font-size: 12px;
                background-color: transparent;
                border: 1px solid #e4e4e4;
                padding: 1px 3px;
            }

            .group > .header > .group-title > input:focus {
                border: 1px solid #d5d5d5;
                background-color: #ffffff;
            }

            .group > .header > .delete-group-button {
                line-height: 0;
            }

            .group > .header > :not(:first-child) {
                padding-left: var(--margin);
            }

            .group > .header > .group-icon > * {
                pointer-events: none;
            }

            .group > .body {
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

            .group .tab {
                position: relative;
                font-size: 12px;
                padding: var(--tab-inner-padding);
            }

            .group .tab.has-thumbnail:hover > .tab-icon,
            .group .tab:hover > .delete-tab-button,
            .group .tab:hover > .container,
            .group .tab.is-current,
            .group .tab:not(.is-current):hover,
            .group .tab.is-current.has-thumbnail > .tab-icon,
            .group .tab.is-current > .delete-tab-button,
            .group .tab.is-current > .container {
                background-color: var(--active-tab-bg-color);
            }

            .group .tab.is-active {
                outline: 1px solid #0093e0;
            }

            .group .tab:not(.is-active):hover {
                outline: 1px solid #cfcfcf;
            }

            .group .tab:not(.has-thumbnail) > .tab-icon {
                position: absolute;
                width: 16px;
                height: 16px;
                top: calc((calc(100% - 1em - var(--tab-inner-padding)) / 2) - 8px);
                left: calc((100% / 2) - 8px);
                pointer-events: none;
            }

            .group .tab.has-thumbnail > .tab-icon {
                position: absolute;
                top: var(--tab-inner-padding);
                left: var(--tab-inner-padding);
                border-bottom-right-radius: 75%;
                width: 25px;
                height: 25px;
                display: flex;
                align-items: start;
                justify-content: left;
                background-color: #fcfcfc;
                border-bottom: 1px solid #c6ced4;
                border-right: 1px solid #c6ced4;
                pointer-events: none;
            }

            .tab-icon > img {
                line-height: 0;
            }

            .group .tab > .delete-tab-button {
                display: flex;
                align-items: start;
                justify-content: right;
                position: absolute;
                top: var(--tab-inner-padding);
                right: var(--tab-inner-padding);
                height: 25px;
                width: 25px;
                border-bottom-left-radius: 75%;
                border-bottom: 1px solid #C6CED4;
                border-left: 1px solid #C6CED4;
                background-color: #fcfcfc;
                line-height: 0;
            }

            .group .tab > .container {
                position: absolute;
                bottom: calc(1em + var(--tab-inner-padding) * 2);
                left: var(--tab-inner-padding);
                border-right-style: solid;
                border-right-width: 1px;
                border-top-style: solid;
                border-top-width: 1px;
                display: flex;
                align-items: end;
                justify-content: left;
                width: 25px;
                height: 25px;
                background-color: #FCFCFC;
                border-top-right-radius: 75%;
            }

            .group .tab > .container > img {
                -moz-context-properties: fill;
            }

            .group .tab > .tab-title {
                line-height: 1.3em;
                position: absolute;
                left: var(--tab-inner-padding);
                right: var(--tab-inner-padding);
                bottom: var(--tab-inner-padding);
            }

            .group .tab > .screenshot {
                height: calc(100% - 1em - var(--tab-inner-padding));
                /* flex-grow: 1; */
                overflow: hidden;
                border: 1px solid #C6CED4;
            }

            > .group .tab > .screenshot > img {
                width: 100%;
                height: 100%;
            }

            .group .tab > .screenshot > img[src=""] {
                display: none;
            }


            .group .tab > .tab-icon > *,
            .group .tab > .screenshot > *,
            .group .tab > .delete-tab-button > * {
                pointer-events: none;
            }

            .group .tab.new > .screenshot {
                display: flex;
                justify-content: center;
                align-items: center;
            }

            .group .tab.new > .screenshot > img {
                width: 4em;
                height: auto;
                -moz-context-properties: fill;
                fill: var(--fill-color);
            }

            .group.new {
                display: flex;
                align-content: center;
                justify-content: center;
                min-height: 250px;
            }

            .group.new > .body {
                display: block;
                text-align: center;
            }

            .group.new > .body > img {
                width: 100px;
                -moz-context-properties: fill;
                fill: var(--fill-color);
            }
        }
    }


    /* Drag & Drop Styles */
    #result .drag-over {
        outline: 2px dashed rgba(0, 0, 0, 0.5) !important;
    }

    #result .group.drag-over {
        outline-offset: 3px;
    }

    #result .drag-moving {
        opacity: 0.4;
        animation-name: in-out;
        animation-duration: 0.5s;
        animation-iteration-count: infinite;
        animation-direction: alternate;
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
