<script>
    'use strict';

    import * as utils from '../js/utils';
    import storage from '../js/storage';
    import {onlyBoolOptionsKeys} from '../js/constants';
    import {importFromFile, exportToFile} from '../js/fileImportExport';

    import groupComponent from './group-component.vue';
    import tabComponent from './tab-component.vue';
    import groupImg from '../js/group-img.vue';
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
                sections: [SECTION_SEARCH, SECTION_GROUPS_LIST, SECTION_GROUP_TABS],

                search: '',

                currentWindowId: null,

                groupToShow: null,

                containers: [],
                options: {},
                groups: [],

                unSyncTabs: [],
            };
        },
        components: {
            group: groupComponent,
            tab: tabComponent,
            'group-img': groupImg,
            'context-menu': contextMenu,
        },
        async mounted() {
            let currentWindow = await BG.getWindow();
            this.currentWindowId = currentWindow.id;

            this.containers = await utils.loadContainers();

            this.options = await storage.get(onlyBoolOptionsKeys);

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
        },
        computed: {
            filteredGroupsBySearch() {
                if (!this.search) {
                    return [];
                }

                let searchStr = this.search.toLowerCase(),
                    groups = [];

                this.groups.forEach(function(group) {
                    group.filteredTabsBySearch = group.tabs.filter(function(tab, tabIndex) {
                        tab.index = tabIndex;
                        return this.$_mySearchFunc(searchStr, tab.title.toLowerCase()) || this.$_mySearchFunc(searchStr, tab.url.toLowerCase());
                    }, this);

                    if (group.filteredTabsBySearch.length || this.$_mySearchFunc(searchStr, group.title.toLowerCase())) {
                        groups.push(group);
                    }
                }, this);

                return groups;
            },
        },
        methods: {
            lang: browser.i18n.getMessage,

            setupListeners() {
                let listener = function(request, sender) {
                    if (!utils.isAllowSender(request, sender)) {
                        return;
                    }

                    if ('group-updated' === request.action) { // group
                        let groupIndex = this.groups.findIndex(group => group.id === request.group.id);

                        Object.assign(this.groups[groupIndex], request.group);
                    } else if ('groups-updated' === request.action) {
                        this.loadGroups();
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
                this.groupToShow = null;
                this.search = '';
                this.section = SECTION_DEFAULT;
            },

            $_mySearchFunc(searchStr, str) {
                let lastFindIndex = -1;

                return searchStr
                    .split('')
                    .every(function(char) {
                        if (' ' === char) {
                            return true;
                        }

                        lastFindIndex = str.indexOf(char, lastFindIndex + 1);
                        return -1 !== lastFindIndex;
                    });
            },

            loadGroups() {
                this.groups = utils.clone(BG.getGroups());
            },
            async loadUnsyncedTabs() {
                let unSyncTabs = await browser.tabs.query({
                    pinned: false,
                    hidden: true,
                });

                this.unSyncTabs = unSyncTabs
                    .filter(utils.isTabNotIncognito)
                    .filter(unSyncTab => !this.groups.some(group => group.tabs.some(tab => tab.id === unSyncTab.id)));
            },

            getCurrentGroup() {
                return this.groups.find(group => group.windowId === this.currentWindowId);
            },

            addGroup() {
                BG.addGroup();
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
            async loadGroup(group, tabIndex) {
                if (group === this.getCurrentGroup() && -1 === tabIndex) { // open group
                    this.showSectionGroupTabs(group);
                    return;
                }

                if (group === this.getCurrentGroup()) {
                    group.tabs.forEach((tab, index) => tab.active = index === tabIndex);
                }

                let groupIndex = this.groups.findIndex(gr => gr.id === group.id);

                await BG.loadGroup(this.currentWindowId, groupIndex, tabIndex);

                if (this.options.closePopupAfterChangeGroup) {
                    if (group !== this.getCurrentGroup()) {
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
            },
            unsyncHiddenTabsCreateNewGroup() {
                BG.addGroup(undefined, undefined, undefined, utils.clone(this.unSyncTabs));
            },
            unsyncHiddenTabsCloseAll() {
                browser.tabs.remove(this.unSyncTabs.map(utils.keyId));
            },
            async unsyncHiddenTabsShowIntoCurrentWindow(tab) {
                await browser.tabs.move(tab.id, {
                    windowId: this.currentWindowId,
                    index: -1,
                });

                await browser.tabs.show(tab.id);
            },

            openGroupSettings(group) {
                //
            },
            deleteGroup(group) {
                let _removeGroup = () => BG.removeGroup(group.id).then(() => this.section === SECTION_DEFAULT);

                if (this.options.showConfirmDialogBeforeGroupDelete) {
                    if (group.windowId === this.currentWindowId && 1 === this.groups.length && group.tabs.length) {
                        // Popups.confirm(browser.i18n.getMessage('confirmDeleteLastGroupAndCloseTabs'), browser.i18n.getMessage('warning'))
                            // .then(_removeGroup);
                    } else {
                        // Popups.confirm(
                        //         browser.i18n.getMessage('deleteGroupBody', group.title),
                        //         browser.i18n.getMessage('deleteGroupTitle'),
                        //         'delete',
                        //         'is-danger'
                        //     )
                        //     .then(_removeGroup);
                    }
                } else {
                    // _removeGroup();
                }

                // add popups, dialogs etc...
                _removeGroup();
            },
            moveTabToGroup(oldTabIndex, oldGroupId, newGroupId) {
                BG.moveTabToGroup(oldTabIndex, undefined, oldGroupId, newGroupId);
            },
            async moveTabToNewGroup(oldTabIndex, oldGroupId) {
                let newGroup = await BG.addGroup(undefined, undefined, false);

                BG.moveTabToGroup(oldTabIndex, undefined, oldGroupId, newGroup.id);
            },
            setTabIconAsGroupIcon(tab) {
                BG.updateGroup(this.groupToShow.id, {
                    iconViewType: null,
                    iconUrl: BG.getTabFavIconUrl(tab, this.options.useTabsFavIconsFromGoogleS2Converter),
                });

                if (this.groupToShow.windowId === this.currentWindowId) {
                    BG.updateBrowserActionData(this.currentWindowId);
                    BG.updateMoveTabMenus(this.currentWindowId);
                }
            },



            openOptionsPage() {
                browser.runtime.openOptionsPage();
            },
            openManageGroups() {
                BG.openManageGroups(window.screen);
            },
            sortGroups(vector) {
                BG.sortGroups(vector);
            },
        },
    }
</script>

<template>
    <div id="stg" class="is-flex is-column" @contextmenu="$event.target.nodeName === 'INPUT' ? null : $event.preventDefault()">
        <header id="searchWrapper">
            <div :class="['field', {'has-addons': search}]">
                <div class="control is-expanded">
                    <input id="search" v-model.trim="search" @input="$refs.search.value === '' && showSectionDefault()" ref="search" type="text" class="input is-small no-shadow" autocomplete="off" :placeholder="lang('searchPlaceholder')" />
                </div>
                <div v-show="search" class="control">
                    <label class="button is-small" @click="showSectionDefault">
                        <img class="size-12" src="/icons/close.svg" alt="" />
                    </label>
                </div>
            </div>
        </header>

        <main id="result" class="is-full-width">
            <!-- SEARCH TABS -->
            <div v-if="section === SECTION_SEARCH">
                <div v-if="filteredGroupsBySearch.length">
                    <group
                        v-for="group in filteredGroupsBySearch"
                        :key="group.id"
                        :group="group"
                        :is-active="group === getCurrentGroup()"
                        @load-group="loadGroup(group, -1)"
                        @show-group="showSectionGroupTabs(group)"
                        >
                            <div slot="tabs">
                                <tab
                                    v-for="tab in group.filteredTabsBySearch"
                                    class="space-left"
                                    :key="tab.url + tab.id + tab.index"
                                    :tab="tab"
                                    :show-active="group === getCurrentGroup()"
                                    :containers="containers"
                                    :show-url-tooltip-on-tab-hover="options.showUrlTooltipOnTabHover"
                                    :use-fav-icons-from-google-converter="options.useTabsFavIconsFromGoogleS2Converter"
                                    @click="loadGroup(group, tab.index)"
                                    @remove-tab="removeTab(group.id, tab.index)"
                                    @contextmenu="$refs.tabsContextMenu.open($event, {tab, tabIndex: tab.index})"
                                    ></tab>
                            </div>
                        </group>
                </div>
                <div v-else>
                    <i class="item no-hover">
                        <span class="item-title" v-text="lang('searchTabNotFoundTitle', search)"></span>
                    </i>
                </div>

            </div>

            <!-- GROUPS LIST -->
            <div v-show="section === SECTION_GROUPS_LIST">
                <div class="groups">
                    <group
                        v-for="group in groups"
                        :key="group.id"
                        :group="group"
                        :is-active="group === getCurrentGroup()"
                        @load-group="loadGroup(group, -1)"
                        @show-group="showSectionGroupTabs(group)"
                        ></group>
                </div>
                <div class="hr"></div>
                <div class="create-new-group">
                    <div class="item" @click="addGroup">
                        <div class="item-icon">
                            <img class="size-16 icon" src="/icons/group-new.svg" alt="" />
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
                        <tab
                            v-for="tab in unSyncTabs"
                            :key="tab.id"
                            :tab="tab"
                            :containers="containers"
                            :show-url-tooltip-on-tab-hover="options.showUrlTooltipOnTabHover"
                            :use-fav-icons-from-google-converter="options.useTabsFavIconsFromGoogleS2Converter"
                            @click="unsyncHiddenTabsShowIntoCurrentWindow(tab)"
                            @remove-tab="removeUnSyncTab(tab)"
                            ></tab>
                    </div>
                </div>
            </div>

            <!-- GROUP -->
            <div v-if="section === SECTION_GROUP_TABS">
                <div class="tabs-list">
                    <div class="item" @click="showSectionDefault">
                        <span class="item-icon">
                            <img class="size-16" src="/icons/arrow-left.svg" alt="" />
                        </span>
                        <span class="item-title" v-text="lang('goBackToGroupsButtonTitle')"></span>
                    </div>

                    <div class="hr"></div>

                    <div class="group-info item no-hover">
                        <div class="item-icon">
                            <group-img :group="groupToShow"></group-img>
                        </div>
                        <div class="item-title" v-text="groupToShow.title"></div>
                        <div class="item-action">
                            <img @click="openGroupSettings(groupToShow)" src="/icons/settings.svg" class="size-16 cursor-pointer icon" :title="lang('groupSettings')" />
                            <img @click="deleteGroup(groupToShow)" src="/icons/group-delete.svg" class="size-16 cursor-pointer icon" :title="lang('deleteGroup')" />
                        </div>
                    </div>

                    <tab
                        v-for="(tab, tabIndex) in groupToShow.tabs"
                        :key="tab.url + tab.id + tabIndex"
                        :tab="tab"
                        :show-active="groupToShow === getCurrentGroup()"
                        :containers="containers"
                        :show-url-tooltip-on-tab-hover="options.showUrlTooltipOnTabHover"
                        :use-fav-icons-from-google-converter="options.useTabsFavIconsFromGoogleS2Converter"
                        @click="loadGroup(groupToShow, tabIndex)"
                        @remove-tab="removeTab(groupToShow.id, tabIndex)"
                        @contextmenu="$refs.tabsContextMenu.open($event, {tab, tabIndex})"
                        ></tab>

                    <context-menu ref="tabsContextMenu">
                        <ul slot-scope="menu" class="is-unselectable">
                            <li @click="setTabIconAsGroupIcon(menu.data.tab)">
                                <img src="/icons/image.svg" class="size-16" />
                                <span v-text="lang('setTabIconAsGroupIcon')"></span>
                            </li>

                            <li v-text="lang('moveTabToGroupDisabledTitle')"></li>

                            <li
                                v-for="group in groups"
                                :class="{'is-disabled': groupToShow.id === group.id}"
                                @click="groupToShow.id === group.id ? null : moveTabToGroup(menu.data.tabIndex, groupToShow.id, group.id)"
                                >
                                <group-img :group="group"></group-img>
                                <span v-text="group.title"></span>
                            </li>

                            <li @click="moveTabToNewGroup(menu.data.tabIndex, groupToShow.id)">
                                <img src="/icons/group-new.svg" class="size-16" />
                                <span v-text="lang('createNewGroup')"></span>
                            </li>
                        </ul>
                    </context-menu>

                    <div class="hr"></div>

                    <div class="create-new-tab">
                        <div class="item" @click="addTab('TODO NEED cookieStoreId')">
                            <div class="item-icon">
                                <img class="size-16" src="/icons/tab-new.svg" alt="">
                            </div>
                            <div class="item-title" v-text="lang('createNewTab')"></div>
                        </div>
                    </div>
                </div>
            </div>
        </main>

        <div class="spacer"></div>

        <footer class="is-flex is-unselectable">
            <div class="is-flex is-aligin-items-center manage-groups is-full-height is-full-width" data-action="open-manage-page" :title="lang('manageGroupsTitle')">
                <img class="icon" src="/icons/icon.svg" alt="" />
                <span class="h-margin-left-10" v-text="lang('manageGroupsTitle')"></span>
            </div>
            <div class="is-flex is-aligin-items-center is-vertical-separator"></div>
            <div class="is-flex is-aligin-items-center settings is-full-height" @click="openOptionsPage" :title="lang('settingsTitle')">
                <img class="icon" src="/icons/settings.svg" alt="" />
            </div>
        </footer>
    </div>

</template>

<style lang="scss">
    :root {
        --indent: 10px;
        --color-light-gray: #eceded;
        --color-gray: #e3e3e3;
        --color-dark-gray: #d4d4d4;
        --color-dark-dark-gray: #bababa;
    }

    html {
        overflow-x: hidden;
        font-size: 13px;
        width: 348px;
        // min-width: 348px;
        // max-width: 425px;
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
    #stg,
    #searchWrapper,
    #result {
        background-color: #ffffff;
    }

    #stg {
        width: 348px;
        // min-width: 348px;
        // max-width: 425px;
        min-height: 400px;
        max-height: 600px;
        overflow-y: auto;
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
        border-top: 1px solid transparent;
        border-bottom: 1px solid transparent;

        > :last-child {
            padding-right: var(--indent);
        }

        &.space-left {
            padding-left: calc(var(--indent) * 2);
        }

        &.is-active,
        &.is-hover,
        &:not(.no-hover):hover {
            border-top-color: var(--color-dark-dark-gray);
            border-bottom-color: var(--color-dark-dark-gray);
        }

        &.is-hover,
        &:not(.no-hover):not(.is-active):hover {
            background-color: var(--color-light-gray);
        }

        &.is-active {
            background-color: var(--color-gray);
        }

        .hover:hover {
            background-color: var(--color-dark-gray);
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

    .groups .item .item-action {
        width: 100px;
        min-width: 100px;
        line-height: 1;
    }

    /* .group-icon,
    .tab-icon { */
    .icon {
        display: inline-block;
        text-align: center;
        width: 16px;
        height: 16px;
        line-height: 0;
    }

    .not-sync-tabs > p {
        padding: 0 var(--indent);
    }

    .is-vertical-separator {
        background-color: var(--color-dark-gray);
        width: 1px;
        height: 75%;
    }

    #stg footer {
        height: 45px;
        min-height: 45px;
        align-items: center;
        justify-content: space-between;
        background-color: var(--color-light-gray);
        cursor: default;

        & > :hover {
            background-color: var(--color-gray); /* dark-dark */
        }

        & > .manage-groups,
        & > .settings {
            padding: 0 20px;
        }
    }


    /* Drag & Drop Styles */
    #stg .drag-over {
        outline: 2px dashed rgba(0, 0, 0, 0.5) !important;
        outline-offset: -3px;
    }

    #stg .drag-moving {
        opacity: 0.4;
    }


    /* media */
    /*
    @media screen and (min-height: 600px) {
        #stg {
            padding-right: 17px;
        }
    }
     */


</style>
