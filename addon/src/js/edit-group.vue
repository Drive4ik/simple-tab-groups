<script>
    'use strict';

    // import Vue from 'vue';

    import popup from './popup.vue';
    import swatches from 'vue-swatches';
    import 'vue-swatches/dist/vue-swatches.css';

    import backgroundSelf from 'background';
    import * as Constants from 'constants';
    import * as Containers from 'containers';
    import * as Storage from 'storage';
    import Messages from 'messages';
    import * as File from 'file';
    import * as Tabs from 'tabs';
    import * as Groups from 'groups';
    import * as Utils from 'utils';
    import JSON from 'json';

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
        },
        data() {
            return {
                show: false,

                containersWithDefault: {},
                containersExcludeTemp: {},

                TEMPORARY_CONTAINER: Constants.TEMPORARY_CONTAINER,
                DEFAULT_COOKIE_STORE_ID: Constants.DEFAULT_COOKIE_STORE_ID,
                disabledContainers: {},

                showMessageCantLoadFile: false,

                GROUP_ICON_VIEW_TYPES: Constants.GROUP_ICON_VIEW_TYPES,

                group: null,

                mainGroup: null,

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
            },
        },
        async created() {
            const [
                {groups},
                bookmarksPermission,
            ] = await Promise.all([
                Storage.get('groups'),
                browser.permissions.contains(Constants.PERMISSIONS.BOOKMARKS),
                this.loadContainers(),
            ]);

            this.permissions.bookmarks = bookmarksPermission;

            const newGroup = {...this.groupToEdit};

            delete newGroup.tabs;
            delete newGroup.filteredTabs;

            if (newGroup.exportToBookmarksWhenAutoBackup) {
                newGroup.exportToBookmarksWhenAutoBackup = this.permissions.bookmarks;
            }

            this.$set(this, 'group', JSON.clone(newGroup));

            this.mainGroup = groups.find(gr => gr.isMain);

            if (!this.isDefaultGroup) {
                for (const cookieStoreId in this.containersWithDefault) {
                    groups.forEach(gr => {
                        if (gr.id === this.group.id) {
                            return;
                        }

                        if (gr.catchTabContainers.includes(cookieStoreId)) {
                            this.disabledContainers[cookieStoreId] = gr.title;
                        }
                    });
                }

                const currentTab = await Messages.sendMessageModule('Tabs.getActive');

                if (currentTab?.url.startsWith('http')) {
                    this.currentTabUrl = new URL(currentTab.url);
                }
            }

            this.show = true;

            this.setFocus();
        },
        methods: {
            lang: browser.i18n.getMessage,

            async loadContainers() {
                Containers.setTemporaryContainerTitle(backgroundSelf.options.temporaryContainerTitle)
                const containersStorage = await Containers.load({});
                const containersWithDefault = Containers.getAll(true, containersStorage);
                const containersExcludeTemp = {...containersWithDefault};
                delete containersExcludeTemp[Constants.TEMPORARY_CONTAINER];

                this.containersWithDefault = containersWithDefault;
                this.containersExcludeTemp = containersExcludeTemp;
            },

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
                    iconColor: this.group.iconColor || 'rgb(66, 134, 244)',
                });
            },

            isDisabledContainer({cookieStoreId}) {
                return this.isDefaultGroup || !this.group.catchTabContainers.includes(cookieStoreId) && this.disabledContainers.hasOwnProperty(cookieStoreId);
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
                    Utils.notify(e);
                }
            },

            async setPermissionsBookmarks(event, groupOptionKey) {
                if (!this.permissions.bookmarks && event.target.checked) {
                    this.permissions.bookmarks = await browser.permissions.request(Constants.PERMISSIONS.BOOKMARKS);
                    this[groupOptionKey] = this.permissions.bookmarks;
                }
            },

            triggerChanges() {
                const changes = {};

                for(const [key, value] of Object.entries(this.group)) {
                    const defaultValue = this.groupToCompare[key];

                    if (value !== Object(value)) { // is primitive
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
                    changes.title = Groups.createTitle(changes.title, groupId);
                }

                changes.catchTabRules
                    ?.split(/\s*\n\s*/)
                    .filter(Boolean)
                    .forEach(regExpStr => {
                        try {
                            new RegExp(regExpStr);
                        } catch (e) {
                            Utils.notify(['invalidRegExpRuleTitle', regExpStr]);
                        }
                    });

                this.$emit('changes', changes);
            },
        }
    }
</script>

<template>
    <div v-if="show" @keydown.stop.enter="triggerChanges" @keyup.stop tabindex="-1" class="no-outline edit-group">
        <div class="field">
            <label class="label" v-text="lang('title')"></label>
            <div class="control has-icons-left">
                <input ref="groupTitle" v-model.trim="group.title" type="text" maxlength="256" class="input" :placeholder="lang('title')" />
                <span class="icon is-small is-left">
                    <figure class="image is-16x16 is-inline-block">
                        <img :src="iconUrlToDisplay" />
                    </figure>
                </span>
            </div>
        </div>

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
                <div v-for="iconViewType in GROUP_ICON_VIEW_TYPES" :key="iconViewType" class="control">
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

        <div class="small-field">
            <div class="control">
                <label class="checkbox">
                    <input type="checkbox" v-model="group.discardTabsAfterHide" />
                    <span v-text="lang('discardTabsAfterHide')"></span>
                </label>
            </div>
        </div>
        <div class="small-field ml-3">
            <div class="control">
                <label class="checkbox" :disabled="!group.discardTabsAfterHide">
                    <input v-model="group.discardExcludeAudioTabs" :disabled="!group.discardTabsAfterHide" type="checkbox" />
                    <span v-text="lang('discardExcludeAudioTabs')"></span>
                </label>
            </div>
        </div>
        <div class="small-field">
            <div class="control">
                <label class="checkbox">
                    <input type="checkbox" v-model="group.muteTabsWhenGroupCloseAndRestoreWhenOpen" />
                    <span v-text="lang('muteTabsWhenGroupCloseAndRestoreWhenOpen')"></span>
                </label>
            </div>
        </div>

        <div class="small-field">
            <div class="control">
                <label class="checkbox">
                    <input type="checkbox" v-model="group.prependTitleToWindow" />
                    <span v-text="lang('prependTitleToWindow')"></span>
                </label>
            </div>
        </div>

        <div class="small-field">
            <div class="control">
                <label class="checkbox">
                    <input
                        v-model="group.exportToBookmarksWhenAutoBackup"
                        @click="$event => setPermissionsBookmarks($event, 'exportToBookmarksWhenAutoBackup')"
                        type="checkbox" />
                    <span v-text="lang('exportToBookmarksWhenAutoBackup')"></span>
                </label>
            </div>
        </div>
        <div class="small-field ml-3">
            <div class="control">
                <label class="checkbox" :disabled="!group.exportToBookmarksWhenAutoBackup">
                    <input v-model="group.leaveBookmarksOfClosedTabs" :disabled="!group.exportToBookmarksWhenAutoBackup" type="checkbox" />
                    <span v-text="lang('leaveBookmarksOfClosedTabs')"></span>
                </label>
            </div>
        </div>

        <div class="field">
            <label class="label" v-text="lang('alwaysOpenTabsInContainer')"></label>
            <div class="containers-wrapper">
                <div v-for="container in containersWithDefault" :key="container.cookieStoreId + 'open'" class="control">
                    <label class="radio indent-children">
                        <input type="radio" :value="container.cookieStoreId" v-model="group.newTabContainer" />
                        <span v-if="container.iconUrl" :class="`size-16 userContext-icon identity-icon-${container.icon} identity-color-${container.color}`"></span>
                        <span class="word-break-all" v-text="container.name"></span>
                    </label>
                </div>
            </div>
            <div class="control h-margin-top-10">
                <label class="checkbox indent-children">
                    <input type="checkbox" v-model="group.ifDifferentContainerReOpen" />
                    <span v-text="lang('ifDifferentContainerReOpen')"></span>
                </label>
            </div>
            <div v-if="group.ifDifferentContainerReOpen" class="field h-margin-top-10">
                <label class="label" v-text="lang('excludeContainersForReOpen')"></label>
                <div class="containers-wrapper">
                    <div v-for="container in containersExcludeTemp" :key="container.cookieStoreId + 'reopen'" class="control">
                        <label
                            class="checkbox indent-children"
                            :disabled="container.cookieStoreId === group.newTabContainer">
                            <input
                                type="checkbox"
                                :disabled="container.cookieStoreId === group.newTabContainer"
                                :value="container.cookieStoreId"
                                v-model="group.excludeContainersForReOpen" />
                            <span v-if="container.iconUrl" :class="`size-16 userContext-icon identity-icon-${container.icon} identity-color-${container.color}`"></span>
                            <span class="word-break-all" v-text="container.name"></span>
                        </label>
                    </div>
                </div>
            </div>
        </div>

        <hr>

        <div class="small-field">
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
        <div class="small-field">
            <div class="control">
                <label class="checkbox">
                    <input type="checkbox" v-model="group.showTabAfterMovingItIntoThisGroup" />
                    <span v-text="lang('showTabAfterMovingItIntoThisGroup')"></span>
                </label>
            </div>
        </div>
        <div class="small-field ml-3">
            <div class="control">
                <label class="checkbox" :disabled="!group.showTabAfterMovingItIntoThisGroup">
                    <input type="checkbox" :disabled="!group.showTabAfterMovingItIntoThisGroup" v-model="group.showOnlyActiveTabAfterMovingItIntoThisGroup" />
                    <span v-text="lang('showOnlyActiveTabAfterMovingItIntoThisGroup')"></span>
                </label>
            </div>
        </div>
        <div class="small-field">
            <div class="control">
                <label class="checkbox">
                    <input type="checkbox" v-model="group.showNotificationAfterMovingTabIntoThisGroup" />
                    <span v-text="lang('showNotificationAfterMovingTabIntoThisGroup')"></span>
                </label>
            </div>
        </div>

        <div class="field">
            <label class="label" v-text="lang('catchTabContainers')"></label>
            <div class="containers-wrapper">
                <div v-for="container in containersExcludeTemp" :key="container.cookieStoreId + 'catch'" class="control">
                    <label class="checkbox indent-children" :disabled="isDisabledContainer(container)">
                        <input type="checkbox" :disabled="isDisabledContainer(container)" :value="container.cookieStoreId" v-model="group.catchTabContainers" />
                        <span v-if="container.iconUrl" :class="`size-16 userContext-icon identity-icon-${container.icon} identity-color-${container.color}`"></span>
                        <span class="word-break-all" v-text="container.name"></span>
                        <i class="word-break-all" v-if="disabledContainers.hasOwnProperty(container.cookieStoreId)">({{ disabledContainers[container.cookieStoreId] }})</i>
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
                    @keydown.enter.stop
                    @keypress.enter.stop
                    @keyup.enter.stop
                    v-model.trim="group.catchTabRules"
                    :disabled="isDefaultGroup"
                    :placeholder="lang('regexpForTabsPlaceholder')"></textarea>
            </div>
        </div>

        <template v-if="!group.isArchive">
            <div class="field">
                <div class="control">
                    <button
                        :disabled="group.isMain"
                        :class="['button', {'is-info': !group.isMain}]"
                        @click="group.isMain = true"
                        v-text="group.isMain ? lang('thisGroupIsMain') : lang('setGroupAsMain')"
                        >
                    </button>
                </div>
            </div>

            <div class="field" v-if="!group.isMain && mainGroup">
                <label class="checkbox" :disabled="!group.catchTabRules || group.isSticky">
                    <input type="checkbox" :disabled="!group.catchTabRules || group.isSticky" v-model="group.moveToMainIfNotInCatchTabRules" />
                    <span v-text="lang('moveToMainIfNotInCatchTabRules', mainGroup.title)"></span>
                </label>
            </div>
        </template>

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

<style lang="scss">
    .edit-group {
        .small-field:not(:last-child) {
            margin-bottom: .25rem;
        }

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
            line-height: 1.4;
        }

        .reg-exp {
            font-family: Monaco, Consolas, Andale Mono, Lucida Console;
        }
    }

</style>
