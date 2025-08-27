<script>
    'use strict';

    // import Vue from 'vue';

    import popup from './popup.vue';
    import swatches from 'vue-swatches';
    import contextMenu from '../components/context-menu.vue';
    import 'vue-swatches/dist/vue-swatches.css';

    import backgroundSelf from '/js/background.js';
    import * as Constants from '/js/constants.js';
    import * as Containers from '/js/containers.js';
    import * as Storage from '/js/storage.js';
    import * as Messages from '/js/messages.js';
    import Notification from '/js/notification.js';
    import * as File from '/js/file.js';
    import * as Tabs from '/js/tabs.js';
    import * as Groups from '/js/groups.js';
    import * as Utils from '/js/utils.js';
    import JSON from '/js/json.js';

    export default {
        name: 'edit-group',
        props: {
            groupToEdit: {
                type: Object,
                required: true,
            },
            groupToCompare: {
                type: Object,
                required: true,
            },
            isDefaultGroup: {
                type: Boolean,
                default: false,
            },
            canLoadFile: {
                type: Boolean,
                default: true,
            },
        },
        components: {
            popup: popup,
            swatches: swatches,
            'context-menu': contextMenu,
        },
        data() {
            this.DEFAULT_CONTAINER = Containers.DEFAULT;
            this.TEMPORARY_CONTAINER = Containers.TEMPORARY;
            this.GROUP_ICON_VIEW_TYPES = Constants.GROUP_ICON_VIEW_TYPES;
            this.TITLE_VARIABLES = {
                uid: '{uid}',
                ...Utils.DATE_LOCALE_VARIABLES,
            };

            return {
                show: false,

                containers: Containers.query({}),

                disabledContainers: {},

                showMessageCantLoadFile: false,

                group: null,

                groupsMoveToIfNoneCatchTabRules: [],

                currentTabUrl: null,

                permissions: {
                    bookmarks: false,
                },
            };
        },
        watch: {
            'group.newTabContainer'(newTabContainer) {
                this.group.excludeContainersForReOpen = this.group.excludeContainersForReOpen.filter(cookieStoreId => cookieStoreId !== newTabContainer);
            },
        },
        computed: {
            iconUrlToDisplay() {
                return Groups.getIconUrl({
                    title: this.group.title,
                    iconUrl: this.group.iconUrl,
                    iconColor: this.group.iconColor,
                    iconViewType: this.group.iconViewType,
                });
            },
            currentDomainRegexp() {
                if (this.currentTabUrl) {
                    let currentDomainRegexp = this.currentTabUrl.hostname.replace(/\./g, '\\.');

                    if (!this.group.catchTabRules.includes(currentDomainRegexp)) {
                        return currentDomainRegexp;
                    }
                }

                return null;
            },
            currentDomainWithSubdomainsRegexp() {
                if (this.currentTabUrl) {
                    let parts = this.currentTabUrl.hostname.split('.');

                    if (parts.length > 2) {
                        if (parts.length === 3 && parts[0] === 'www') {
                            return;
                        }

                        let currentDomainWithSubdomainsRegexp = ['.*', ...parts.slice(-2)].join('\\.');

                        if (!this.group.catchTabRules.includes(currentDomainWithSubdomainsRegexp)) {
                            return currentDomainWithSubdomainsRegexp;
                        }
                    }
                }

                return null;
            },
            selectedMoveGroupToImage() {
                const group = this.groupsMoveToIfNoneCatchTabRules.find(group => group.id === this.group.moveToGroupIfNoneCatchTabRules);

                return group ? Groups.getIconUrl(group) : null;
            },
        },
        async created() {
            const [
                {groups},
                bookmarksPermission,
            ] = await Promise.all([
                Storage.get('groups'),
                browser.permissions.contains(Constants.PERMISSIONS.BOOKMARKS),
            ]);

            this.permissions.bookmarks = bookmarksPermission;

            const newGroup = {...this.groupToEdit};

            delete newGroup.tabs;
            delete newGroup.filteredTabs;

            if (newGroup.exportToBookmarks) {
                newGroup.exportToBookmarks = this.permissions.bookmarks;
            }

            this.$set(this, 'group', JSON.clone(newGroup));

            this.groupsMoveToIfNoneCatchTabRules = groups.filter(group => {
                group.titleToView = Groups.getTitle(group);

                if (this.group.moveToGroupIfNoneCatchTabRules === group.id) {
                    return true;
                }

                return !group.isArchive;
            });

            if (!this.isDefaultGroup) {
                for (const cookieStoreId of [Constants.DEFAULT_COOKIE_STORE_ID, ...Object.keys(this.containers)]) {
                    for (const group of groups) {
                        if (group.id === this.group.id) {
                            continue;
                        }

                        if (group.catchTabContainers.includes(cookieStoreId)) {
                            this.$set(this.disabledContainers, cookieStoreId, group.title);
                        }
                    }
                }

                Messages.sendMessageModule('Tabs.getActive')
                    .then(currentTab => {
                        if (currentTab?.url.startsWith('http')) {
                            this.currentTabUrl = new URL(currentTab.url);
                        }
                    });
            }

            this.show = true;

            this.setFocus();
        },
        methods: {
            lang: browser.i18n.getMessage,

            addCurrentDomain(domainRegexpStr) {
                this.group.catchTabRules += (this.group.catchTabRules.length ? '\n' : '') + domainRegexpStr;
            },

            setFocus() {
                this.$nextTick(() => this.$refs.groupTitle.focus());
            },

            setIconView(groupIcon) {
                this.group.iconViewType = groupIcon;
                this.group.iconUrl = null;
            },

            setIconUrl(iconUrl) {
                this.group.iconViewType = null;
                this.group.iconUrl = iconUrl;
            },

            setRandomColor() {
                this.group.iconUrl = null;
                this.group.iconColor = Utils.randomColor();

                if (!this.group.iconViewType) {
                    this.group.iconViewType = Constants.DEFAULT_GROUP_ICON_VIEW_TYPE;
                }
            },

            getIconTypeUrl(iconType) {
                return Groups.getIconUrl({
                    title: this.group.title,
                    iconViewType: iconType,
                    iconColor: this.group.iconColor,
                });
            },

            isDisabledContainer(cookieStoreId) {
                return this.isDefaultGroup ||
                    (
                        !this.group.catchTabContainers.includes(cookieStoreId) &&
                        this.disabledContainers.hasOwnProperty(cookieStoreId)
                    );
            },

            async selectUserGroupIcon() {
                if (!this.canLoadFile) { // maybe temporary solution
                    this.showMessageCantLoadFile = true;
                    return;
                }

                let iconUrl = await File.load('.ico,.png,.jpg,.svg', 'url');

                try {
                    iconUrl = await Utils.normalizeGroupIcon(iconUrl);
                    this.setIconUrl(iconUrl);
                } catch (e) {
                    Notification(e);
                }
            },

            async setPermissionsBookmarks(event, groupOptionKey) {
                if (!this.permissions.bookmarks && event.target.checked) {
                    this.permissions.bookmarks = await browser.permissions.request(Constants.PERMISSIONS.BOOKMARKS);
                    this[groupOptionKey] = this.permissions.bookmarks;
                }
            },

            insertValueToGroupTitle(value) {
                const {selectionStart, selectionEnd} = this.$refs.groupTitle,
                    title = this.group.title;

                this.group.title = title.slice(0, selectionStart) + value + title.slice(selectionEnd, title.length);
            },

            async triggerChanges() {
                const changes = {};

                for (const [key, value] of Object.entries(this.group)) {
                    const defaultValue = this.groupToCompare[key];

                    if (Utils.isPrimitive(value)) {
                        if (value !== defaultValue) {
                            changes[key] = value;
                        }
                    } else if (Array.isArray(value)) {
                        if (!Utils.isEqualPrimitiveArrays(value, defaultValue)) {
                            changes[key] = value.slice();
                        }
                    }
                }

                if (changes.hasOwnProperty('title')) {
                    const groupId = this.isDefaultGroup ? null : this.group.id;
                    const {defaultGroupProps} = await Groups.getDefaults();
                    changes.title = Groups.createTitle(changes.title, groupId, defaultGroupProps, !this.isDefaultGroup);
                }

                changes.catchTabRules
                    ?.split(/\s*\n\s*/)
                    .filter(Boolean)
                    .forEach(regExpStr => {
                        try {
                            new RegExp(regExpStr);
                        } catch (e) {
                            Notification(['invalidRegExpRuleTitle', regExpStr]);
                        }
                    });

                this.$emit('changes', changes);
            },
        }
    }
</script>

<template>
    <div v-if="show" @keydown.stop.enter="triggerChanges" @keyup.stop tabindex="-1" class="no-outline edit-group">
        <label class="label" v-text="lang('title')"></label>
        <div :class="['field', isDefaultGroup && 'has-addons']">
            <div class="control is-expanded has-icons-left">
                <input ref="groupTitle" v-model.trim="group.title" type="text" maxlength="256" class="input" :placeholder="lang('title')" @keydown.stop @keyup.stop />
                <span class="icon is-left">
                    <figure class="image is-16x16 is-inline-block">
                        <img :src="iconUrlToDisplay" />
                    </figure>
                </span>
            </div>
            <div v-if="isDefaultGroup" class="control">
                <button class="button"
                    @click="$refs.groupNameVariables.open($event)"
                    @contextmenu.prevent="$refs.groupNameVariables.open($event)">
                    <span class="icon">
                        <img src="/icons/info.svg" class="size-16" />
                    </span>
                </button>
            </div>
        </div>

        <context-menu ref="groupNameVariables">
            <ul class="is-unselectable">
                <li v-for="(value, key) in TITLE_VARIABLES" :key="key" @click="insertValueToGroupTitle(`{${key}}`)">
                    <span v-text="`{${key}} - ` + value"></span>
                </li>
            </ul>
        </context-menu>

        <div class="field">
            <label class="label" v-text="lang('iconStyle')"></label>
            <div class="field is-grouped icon-buttons">
                <div class="control">
                    <swatches
                        v-model.trim="group.iconColor"
                        :title="lang('iconColor')"
                        swatches="text-advanced"
                        popover-x="right"
                        show-fallback
                        :trigger-style="{
                            width: '41px',
                            height: '30px',
                            borderRadius: '4px',
                            borderWidth: '1px',
                            borderColor: '#dbdbdb',
                        }"
                        @keydown.native.enter.stop
                        @keypress.native.enter.stop
                        @keyup.native.enter.stop></swatches>
                </div>
                <div v-for="(data, iconViewType) in GROUP_ICON_VIEW_TYPES" :key="iconViewType" class="control">
                    <button @click="setIconView(iconViewType)" :class="['button', {'is-focused': !group.iconUrl && iconViewType === group.iconViewType}]">
                        <figure class="image is-16x16 is-inline-block">
                            <img :src="getIconTypeUrl(iconViewType)" />
                        </figure>
                    </button>
                </div>
                <div class="control">
                    <button @click="setRandomColor" class="button" :title="lang('setRandomColor')">
                        <img src="/icons/refresh.svg" class="size-16" />
                    </button>
                </div>
                <div class="control">
                    <button @click="selectUserGroupIcon" class="button" :title="lang('selectUserGroupIcon')">
                        <img src="/icons/image.svg" class="size-16" />
                    </button>
                </div>
            </div>
        </div>

        <div class="field">
            <div class="control">
                <label class="checkbox">
                    <input type="checkbox" v-model="group.discardTabsAfterHide" />
                    <span v-text="lang('discardTabsAfterHide')"></span>
                </label>
            </div>
        </div>
        <div class="field ml-3">
            <div class="control">
                <label class="checkbox" :disabled="!group.discardTabsAfterHide">
                    <input v-model="group.discardExcludeAudioTabs" :disabled="!group.discardTabsAfterHide" type="checkbox" />
                    <span v-text="lang('discardExcludeAudioTabs')"></span>
                </label>
            </div>
        </div>
        <div class="field">
            <div class="control">
                <label class="checkbox">
                    <input type="checkbox" v-model="group.muteTabsWhenGroupCloseAndRestoreWhenOpen" />
                    <span v-text="lang('muteTabsWhenGroupCloseAndRestoreWhenOpen')"></span>
                </label>
            </div>
        </div>

        <div class="field">
            <div class="control">
                <label class="checkbox">
                    <input type="checkbox" v-model="group.prependTitleToWindow" />
                    <span v-text="lang('prependTitleToWindow')"></span>
                </label>
            </div>
        </div>

        <div class="field">
            <div class="control">
                <label class="checkbox">
                    <input type="checkbox" v-model="group.dontUploadToCloud" />
                    <span v-text="lang('dontUploadToCloud')"></span>
                </label>
            </div>
        </div>

        <div class="field">
            <div class="control">
                <label class="checkbox">
                    <input
                        v-model="group.exportToBookmarks"
                        @click="$event => setPermissionsBookmarks($event, 'exportToBookmarks')"
                        type="checkbox" />
                    <span v-text="lang('exportGroupToBookmarks')"></span>
                </label>
            </div>
        </div>

        <div class="field">
            <label class="label" v-text="lang('alwaysOpenTabsInContainer')"></label>
            <div class="containers-wrapper">
                <div class="control">
                    <label class="radio indent-children">
                        <input type="radio" :value="DEFAULT_CONTAINER.cookieStoreId" v-model="group.newTabContainer" />
                        <span class="word-break-all" v-text="DEFAULT_CONTAINER.name"></span>
                    </label>
                </div>
                <div v-for="container in containers" :key="container.cookieStoreId + 'open'" class="control">
                    <label class="radio indent-children">
                        <input type="radio" :value="container.cookieStoreId" v-model="group.newTabContainer" />
                        <span :class="`size-16 userContext-icon identity-icon-${container.icon} identity-color-${container.color}`"></span>
                        <span class="word-break-all" v-text="container.name"></span>
                    </label>
                </div>
                <div class="control">
                    <label class="radio indent-children">
                        <input type="radio" :value="TEMPORARY_CONTAINER.cookieStoreId" v-model="group.newTabContainer" />
                        <span :class="`size-16 userContext-icon identity-icon-${TEMPORARY_CONTAINER.icon} identity-color-${TEMPORARY_CONTAINER.color}`"></span>
                        <span class="word-break-all" v-text="TEMPORARY_CONTAINER.name"></span>
                    </label>
                </div>
            </div>
            <div class="control h-margin-top-10">
                <label class="checkbox">
                    <input type="checkbox" v-model="group.ifDifferentContainerReOpen" />
                    <span v-text="lang('ifDifferentContainerReOpen')"></span>
                </label>
            </div>
            <div v-if="group.ifDifferentContainerReOpen" class="field h-margin-top-10">
                <label class="label" v-text="lang('excludeContainersForReOpen')"></label>
                <div class="containers-wrapper">
                    <div class="control">
                        <label class="checkbox indent-children" :disabled="group.newTabContainer === DEFAULT_CONTAINER.cookieStoreId">
                            <input type="checkbox" :disabled="group.newTabContainer === DEFAULT_CONTAINER.cookieStoreId" :value="DEFAULT_CONTAINER.cookieStoreId" v-model="group.excludeContainersForReOpen" />
                            <span class="word-break-all" v-text="DEFAULT_CONTAINER.name"></span>
                        </label>
                    </div>
                    <div v-for="container in containers" :key="container.cookieStoreId + 'reopen'" class="control">
                        <label
                            class="checkbox indent-children"
                            :disabled="container.cookieStoreId === group.newTabContainer">
                            <input
                                type="checkbox"
                                :disabled="container.cookieStoreId === group.newTabContainer"
                                :value="container.cookieStoreId"
                                v-model="group.excludeContainersForReOpen" />
                            <span :class="`size-16 userContext-icon identity-icon-${container.icon} identity-color-${container.color}`"></span>
                            <span class="word-break-all" v-text="container.name"></span>
                        </label>
                    </div>
                </div>
            </div>
        </div>

        <hr>

        <div class="field">
            <label class="label" v-text="lang('tabMoving')"></label>
            <div class="control is-inline-flex indent-children">
                <label class="checkbox">
                    <input type="checkbox" v-model="group.isSticky" />
                    <span v-text="lang('isStickyGroupTitle')"></span>
                </label>
                <span class="cursor-help" :title="lang('isStickyGroupHelp')">
                    <img class="size-18" src="/icons/help.svg" />
                </span>
            </div>
        </div>
        <div class="field">
            <div class="control">
                <label class="checkbox">
                    <input type="checkbox" v-model="group.showTabAfterMovingItIntoThisGroup" />
                    <span v-text="lang('showTabAfterMovingItIntoThisGroup')"></span>
                </label>
            </div>
        </div>
        <div class="field ml-3">
            <div class="control">
                <label class="checkbox" :disabled="!group.showTabAfterMovingItIntoThisGroup">
                    <input type="checkbox" :disabled="!group.showTabAfterMovingItIntoThisGroup" v-model="group.showOnlyActiveTabAfterMovingItIntoThisGroup" />
                    <span v-text="lang('showOnlyActiveTabAfterMovingItIntoThisGroup')"></span>
                </label>
            </div>
        </div>
        <div class="field">
            <div class="control">
                <label class="checkbox">
                    <input type="checkbox" v-model="group.showNotificationAfterMovingTabIntoThisGroup" />
                    <span v-text="lang('showNotificationAfterMovingTabIntoThisGroup')"></span>
                </label>
            </div>
        </div>

        <div class="field">
            <label class="label" v-text="lang('catchTabContainers')"></label>
            <div :class="['containers-wrapper', isDefaultGroup && 'no-y-scroll']">
                <div v-for="container in {DEFAULT_CONTAINER, ...containers}" :key="container.cookieStoreId + 'catch'" class="control">
                    <label class="checkbox indent-children" :disabled="isDisabledContainer(container.cookieStoreId)">
                        <input type="checkbox" :disabled="isDisabledContainer(container.cookieStoreId)" :value="container.cookieStoreId" v-model="group.catchTabContainers" />
                        <span v-if="container.iconUrl" :class="`size-16 userContext-icon identity-icon-${container.icon} identity-color-${container.color}`"></span>
                        <span class="word-break-all" v-text="container.name"></span>
                        <i v-if="disabledContainers.hasOwnProperty(container.cookieStoreId)" class="word-break-all">({{disabledContainers[container.cookieStoreId]}})</i>
                    </label>
                </div>
            </div>
        </div>

        <div class="field">
            <label class="label is-inline-flex indent-children">
                <span v-text="lang('regexpForTabsTitle')"></span>
                <span class="cursor-help" :title="lang('regexpForTabsHelp')">
                    <img class="size-18" src="/icons/help.svg" />
                </span>
            </label>
        </div>

        <div v-if="currentDomainRegexp || currentDomainWithSubdomainsRegexp" class="field is-grouped">
            <div v-if="currentDomainRegexp" class="control">
                <button class="button is-link is-small" @click="addCurrentDomain(currentDomainRegexp)">
                    <span v-text="currentDomainRegexp"></span>
                </button>
            </div>
            <div v-if="currentDomainWithSubdomainsRegexp" class="control">
                <button class="button is-link is-small" @click="addCurrentDomain(currentDomainWithSubdomainsRegexp)">
                    <span v-text="currentDomainWithSubdomainsRegexp"></span>
                </button>
            </div>
        </div>

        <div class="field h-margin-bottom-10">
            <div class="control">
                <textarea class="textarea reg-exp"
                    :rows="canLoadFile ? false : 2"
                    @keydown.stop
                    @keyup.stop
                    v-model.trim="group.catchTabRules"
                    :disabled="isDefaultGroup"
                    :placeholder="lang('regexpForTabsPlaceholder')"></textarea>
            </div>
        </div>

        <div class="field">
            <label class="label" v-text="lang('moveToGroupIfNoneCatchTabRules')"></label>
            <div :class="['control', group.moveToGroupIfNoneCatchTabRules && 'has-icons-left']">
                <div class="select is-fullwidth">
                    <select v-model="group.moveToGroupIfNoneCatchTabRules">
                        <option :value="null" v-text="lang('dontMove')"></option>
                        <option
                            v-for="group in groupsMoveToIfNoneCatchTabRules"
                            :key="group.id + 'catch'"
                            :value="group.id"
                            v-text="group.isArchive ? lang('groupArchivedTitle', group.titleToView) : group.titleToView"></option>
                    </select>
                </div>
                <span v-if="group.moveToGroupIfNoneCatchTabRules" class="icon is-left">
                    <img :src="selectedMoveGroupToImage" alt="" class="size-16" />
                </span>
            </div>
        </div>

        <popup
            v-if="showMessageCantLoadFile"
            :title="lang('warning')"
            @open-manage-groups="$emit('open-manage-groups')"
            @close-popup="showMessageCantLoadFile = false"
            :buttons="
                [{
                    event: 'open-manage-groups',
                    lang: 'ok',
                }, {
                    event: 'close-popup',
                    lang: 'cancel',
                }]
            ">
            <span v-text="lang('selectUserGroupIconWarnText')"></span>
        </popup>
    </div>
</template>

<style>
    .edit-group {
        .word-break-all {
            word-break: break-word;
        }

        .icon-buttons {
            flex-wrap: wrap;
        }

        .field.is-grouped > .control:not(:last-child) {
            margin-right: .68rem;
        }

        .field .control {
            cursor: default;
        }

        .containers-wrapper {
            max-height: 155px;
            overflow-y: auto;
            scrollbar-width: thin;
        }

        .checkbox,
        .radio {
            display: flex;
            align-items: center;
        }

        .reg-exp {
            font-family: Monaco, Consolas, Andale Mono, Lucida Console;
        }

        .no-y-scroll {
            overflow-y: hidden;
        }
    }

</style>
