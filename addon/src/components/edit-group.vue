<script>
// import Vue from 'vue';

import popup from './popup.vue';
import swatches from 'vue-swatches';
import contextMenu from '../components/context-menu.vue';
import 'vue-swatches/dist/vue-swatches.css';

// import backgroundSelf from '/js/background.js';
import * as Constants from '/js/constants.js';
import * as Containers from '/js/containers.js';
import * as Storage from '/js/storage.js';
import * as Messages from '/js/messages.js';
import Notification from '/js/notification.js';
import Lang from '/js/lang.js';
import * as File from '/js/file.js';
import * as Bookmarks from '/js/bookmarks.js';
// import * as Tabs from '/js/tabs.js';
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
        this.permissions.bookmarks = await Bookmarks.hasPermission();

        const {groups} = await Storage.get('groups');

        const newGroup = {...this.groupToEdit};

        delete newGroup.tabs;
        delete newGroup.filteredTabs;

        if (newGroup.exportToBookmarks) {
            newGroup.exportToBookmarks = this.permissions.bookmarks;
        }

        this.$set(this, 'group', JSON.clone(newGroup));

        // TODO исключить перемещение в текущую группу
        // и обязательно сделать перемещение независимо от липкости группы
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
        lang: Lang,

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

            await File.load('image/x-icon, image/png, image/jpeg, image/svg+xml', 'url')
                .then(file => Utils.normalizeGroupIcon(file.data))
                .then(iconUrl => this.setIconUrl(iconUrl))
                .catch(Notification);
        },

        async setPermissionsBookmarks(event, groupOptionKey) {
            if (!this.permissions.bookmarks && event.target.checked) {
                this.permissions.bookmarks = await Bookmarks.requestPermission();
                this[groupOptionKey] = this.permissions.bookmarks;
            }
        },

        insertVariableToGroupTitle(variable) {
            this.group.title = Utils.insertVariable(
                this.$refs.groupTitle,
                this.group.title,
                variable
            );
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
                    } catch {
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
    <label class="label colon" v-text="lang('title')"></label>
    <div :class="['field', isDefaultGroup && 'has-addons']">
        <div class="control is-expanded has-icons-left">
            <input ref="groupTitle" v-model.trim="group.title" type="text" maxlength="256" class="input" :placeholder="lang('title')" @keydown.stop @keyup.stop />
            <span class="icon is-left">
                <figure class="image is-16x16">
                    <img class="no-fill" :src="iconUrlToDisplay" />
                </figure>
            </span>
        </div>
        <div v-if="isDefaultGroup" class="control">
            <button class="button"
                @click="$refs.groupNameVariables.open($event)"
                @contextmenu.prevent="$refs.groupNameVariables.open($event)">
                <span class="icon">
                    <figure class="image is-16x16">
                        <img src="/icons/brackets-curly.svg" />
                    </figure>
                </span>
            </button>
        </div>
    </div>

    <context-menu ref="groupNameVariables">
        <ul class="is-unselectable">
            <li v-for="(value, variable) in TITLE_VARIABLES" :key="variable" @click="insertVariableToGroupTitle(variable)">
                <span v-text="`{${variable}} - ` + value"></span>
            </li>
        </ul>
    </context-menu>

    <div class="field">
        <label class="label colon" v-text="lang('iconStyle')"></label>
        <div class="buttons">
            <swatches
                v-model.trim="group.iconColor"
                :title="lang('iconColor')"
                swatches="text-advanced"
                popover-x="right"
                show-fallback
                background-color="var(--bulma-background)"
                fallback-input-class="input"
                :trigger-style="{
                    width: 'var(--trigger-size)',
                    height: 'var(--trigger-size)',
                    borderRadius: 'var(--bulma-control-radius)',
                }"
                @keydown.native.enter.stop
                @keypress.native.enter.stop
                @keyup.native.enter.stop></swatches>
            <button
                v-for="(data, iconViewType) in GROUP_ICON_VIEW_TYPES"
                :key="iconViewType"
                @click="setIconView(iconViewType)"
                :class="['button', {'is-focused': !group.iconUrl && iconViewType === group.iconViewType}]">
                <span class="icon">
                    <figure class="image is-16x16">
                        <img :src="getIconTypeUrl(iconViewType)" />
                    </figure>
                </span>
            </button>
            <button @click="setRandomColor" class="button" :title="lang('setRandomColor')">
                <span class="icon">
                    <figure class="image is-16x16">
                        <img src="/icons/refresh.svg" />
                    </figure>
                </span>
            </button>
            <button @click="selectUserGroupIcon" class="button" :title="lang('selectUserGroupIcon')">
                <span class="icon">
                    <figure class="image is-16x16">
                        <img src="/icons/image.svg" />
                    </figure>
                </span>
            </button>
        </div>
    </div>

    <div class="block checkboxes as-column">
        <label class="checkbox">
            <input type="checkbox" v-model="group.discardTabsAfterHide" />
            <span v-text="lang('discardTabsAfterHide')"></span>
        </label>
        <label class="checkbox ml-3" :disabled="!group.discardTabsAfterHide">
            <input type="checkbox" v-model="group.discardExcludeAudioTabs" :disabled="!group.discardTabsAfterHide" />
            <span v-text="lang('discardExcludeAudioTabs')"></span>
        </label>
        <label class="checkbox">
            <input type="checkbox" v-model="group.muteTabsWhenGroupCloseAndRestoreWhenOpen" />
            <span v-text="lang('muteTabsWhenGroupCloseAndRestoreWhenOpen')"></span>
        </label>
        <label class="checkbox">
            <input type="checkbox" v-model="group.prependTitleToWindow" />
            <span v-text="lang('prependTitleToWindow')"></span>
        </label>
        <label class="checkbox">
            <input type="checkbox" v-model="group.dontUploadToCloud" />
            <span v-text="lang('dontUploadToCloud')"></span>
        </label>
        <label class="checkbox">
            <input type="checkbox" v-model="group.exportToBookmarks" @click="$event => setPermissionsBookmarks($event, 'exportToBookmarks')" />
            <span v-text="lang('exportGroupToBookmarks')"></span>
        </label>
    </div>

    <div class="field">
        <label class="label colon" v-text="lang('alwaysOpenTabsInContainer')"></label>
        <div class="field">
            <div class="control" :class="{'has-icons-left': group.newTabContainer !== DEFAULT_CONTAINER.cookieStoreId}">
                <div class="select is-fullwidth">
                    <select v-model="group.newTabContainer">
                        <option
                            v-for="container in {DEFAULT_CONTAINER, ...containers, TEMPORARY_CONTAINER}"
                            :key="container.cookieStoreId"
                            :value="container.cookieStoreId"
                            v-text="container.name"></option>
                    </select>
                </div>
                <span v-if="group.newTabContainer !== DEFAULT_CONTAINER.cookieStoreId" class="icon is-left">
                    <figure :class="`image is-16x16 userContext-icon identity-icon-${(containers[group.newTabContainer] ?? TEMPORARY_CONTAINER).icon} identity-color-${(containers[group.newTabContainer] ?? TEMPORARY_CONTAINER).color}`"></figure>
                </span>
            </div>
        </div>
        <div class="field">
            <div class="control">
                <label class="checkbox">
                    <input type="checkbox" v-model="group.ifDifferentContainerReOpen" />
                    <span v-text="lang('ifDifferentContainerReOpen')"></span>
                </label>
            </div>
        </div>
        <div v-if="group.ifDifferentContainerReOpen" class="field">
            <label class="label colon" v-text="lang('excludeContainersForReOpen')"></label>
            <div class="checkboxes as-column containers">
                <label class="checkbox" :disabled="group.newTabContainer === DEFAULT_CONTAINER.cookieStoreId">
                    <input type="checkbox" v-model="group.excludeContainersForReOpen" :value="DEFAULT_CONTAINER.cookieStoreId" :disabled="group.newTabContainer === DEFAULT_CONTAINER.cookieStoreId" />
                    <span class="word-break-word" v-text="DEFAULT_CONTAINER.name"></span>
                </label>
                <label v-for="container in containers" :key="container.cookieStoreId" class="checkbox" :disabled="container.cookieStoreId === group.newTabContainer">
                    <input type="checkbox" v-model="group.excludeContainersForReOpen" :value="container.cookieStoreId" :disabled="container.cookieStoreId === group.newTabContainer" />
                    <span class="icon-text">
                        <figure :class="`icon image is-16x16 userContext-icon identity-icon-${container.icon} identity-color-${container.color}`"></figure>
                        <span class="word-break-word" v-text="container.name"></span>
                    </span>
                </label>
            </div>
        </div>
    </div>

    <hr>

    <div class="block checkboxes as-column">
        <label class="checkbox">
            <input type="checkbox" v-model="group.isSticky" />
            <span class="icon-text">
                <span v-text="lang('isStickyGroupTitle')"></span>
                <figure class="icon image is-16x16 cursor-help" :title="lang('isStickyGroupHelp')">
                    <img src="/icons/help.svg" />
                </figure>
            </span>
        </label>
        <label class="checkbox">
            <input type="checkbox" v-model="group.showTabAfterMovingItIntoThisGroup" />
            <span v-text="lang('showTabAfterMovingItIntoThisGroup')"></span>
        </label>
        <label class="checkbox ml-3" :disabled="!group.showTabAfterMovingItIntoThisGroup">
            <input type="checkbox" :disabled="!group.showTabAfterMovingItIntoThisGroup" v-model="group.showOnlyActiveTabAfterMovingItIntoThisGroup" />
            <span v-text="lang('showOnlyActiveTabAfterMovingItIntoThisGroup')"></span>
        </label>
        <label class="checkbox">
            <input type="checkbox" v-model="group.showNotificationAfterMovingTabIntoThisGroup" />
            <span v-text="lang('showNotificationAfterMovingTabIntoThisGroup')"></span>
        </label>
    </div>

    <div class="field">
        <label class="label colon" v-text="lang('catchTabContainers')"></label>
        <div class="checkboxes as-column containers">
            <label v-for="container in {DEFAULT_CONTAINER, ...containers}" :key="container.cookieStoreId" class="checkbox" :disabled="isDisabledContainer(container.cookieStoreId)">
                <input type="checkbox" v-model="group.catchTabContainers" :value="container.cookieStoreId" :disabled="isDisabledContainer(container.cookieStoreId)" />
                <span class="icon-text">
                    <figure v-if="container.iconUrl" :class="`icon image is-16x16 userContext-icon identity-icon-${container.icon} identity-color-${container.color}`"></figure>
                    <span class="word-break-word" v-text="container.name"></span>
                </span>
                <em class="brackets-round word-break-word hidden-empty" v-text="disabledContainers[container.cookieStoreId] ?? ''"></em>
            </label>
        </div>
    </div>

    <div class="field">
        <label class="label">
            <span class="icon-text">
                <span v-text="lang('regexpForTabsTitle')"></span>
                <figure class="icon image is-16x16 cursor-help" :title="lang('regexpForTabsHelp')">
                    <img src="/icons/help.svg" />
                </figure>
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

    <div class="field">
        <div class="control">
            <textarea class="textarea is-family-monospace"
                :rows="canLoadFile ? false : 2"
                @keydown.stop
                @keyup.stop
                v-model.trim="group.catchTabRules"
                :disabled="isDefaultGroup"
                :placeholder="lang('regexpForTabsPlaceholder')"></textarea>
        </div>
    </div>

    <div class="field">
        <label class="label colon" v-text="lang('moveToGroupIfNoneCatchTabRules')"></label>
        <div class="control" :class="{'has-icons-left': group.moveToGroupIfNoneCatchTabRules}">
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
                <figure class="image is-16x16">
                    <img class="no-fill" :src="selectedMoveGroupToImage" />
                </figure>
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
    .checkboxes.containers {
        max-height: calc((var(--bulma-body-font-size) + 1em) * 6 + .5em);
        overflow-x: auto;
        scrollbar-width: thin;
        padding-block-end: var(--bulma-block-spacing);

        .field > & {
            margin-block-end: calc(var(--bulma-block-spacing) * -1);
        }
    }

    .vue-swatches {
        --trigger-size: 2.4em;
        display: flex;

        .vue-swatches__fallback__wrapper {
            display: flex;
            gap: 1em;
            padding-block-start: 5px;

            .vue-swatches__fallback__input--wrapper {
                flex-grow: 1;

                .vue-swatches__fallback__input {
                    background-color: hsl(var(--bulma-input-h),var(--bulma-input-s),calc(var(--bulma-input-background-l) + var(--bulma-input-background-l-delta)));
                    border-color: var(--bulma-input-border-color);
                    border-radius: var(--bulma-input-radius);
                    color: hsl(var(--bulma-input-h),var(--bulma-input-s),var(--bulma-input-color-l));
                    padding-block: 0;
                }
            }
        }
    }
}

</style>
