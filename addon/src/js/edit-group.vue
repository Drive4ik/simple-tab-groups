<script>
    'use strict';

    import Vue from 'vue';

    import popup from './popup.vue';
    import swatches from 'vue-swatches';
    import 'vue-swatches/dist/vue-swatches.css';

    export default {
        name: 'edit-group',
        props: {
            groupId: {
                required: true,
                type: Number,
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
                containers: containers.getAll(true),
                TEMPORARY_CONTAINER,
                DEFAULT_COOKIE_STORE_ID,
                disabledContainers: {},

                showMessageCantLoadFile: false,

                GROUP_ICON_VIEW_TYPES,

                group: null,

                mainGroup: null,

                changedKeys: [],

                currentTabUrl: null,

                options: {
                    discardTabsAfterHide: BG.options.discardTabsAfterHide,
                },
            };
        },
        watch: {
            'group.newTabContainer': function(newTabContainer) {
                this.group.excludeContainersForReOpen = this.group.excludeContainersForReOpen.filter(cookieStoreId => cookieStoreId !== newTabContainer);
            },
        },
        computed: {
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
            let [group, groups] = await Groups.load(this.groupId);

            this.group = new Vue({
                data: group,
                computed: {
                    iconUrlToDisplay() {
                        return utils.getGroupIconUrl({
                            title: this.title,
                            iconUrl: this.iconUrl,
                            iconColor: this.iconColor,
                            iconViewType: this.iconViewType,
                        });
                    },
                },
            });

            this.mainGroup = groups.find(gr => gr.isMain);

            for (let key in group) {
                let unwatch = this.$watch(`group.${key}`, function() {
                    this.changedKeys.push(key);
                    unwatch();
                }, {
                    deep: true,
                });
            };

            for (let cookieStoreId in this.containers) {
                groups.forEach(gr => {
                    if (gr.id === this.groupId) {
                        return;
                    }

                    if (gr.catchTabContainers.includes(cookieStoreId)) {
                        this.$set(this.disabledContainers, cookieStoreId, gr.title);
                    }
                });
            }

            let currentTab = await Tabs.getActive();

            if (currentTab && currentTab.url.startsWith('http')) {
                this.currentTabUrl = new URL(currentTab.url);
            }
        },
        mounted() {
            if (this.group) {
                this.setFocus();
            } else {
                let unwatch = this.$watch('group', function() {
                    this.setFocus();
                    unwatch();
                });
            }
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
                this.group.iconColor = utils.randomColor();

                if (!this.group.iconViewType) {
                    this.group.iconViewType = BG.options.defaultGroupIconViewType;
                }
            },

            getIconTypeUrl(iconType) {
                return utils.getGroupIconUrl({
                    iconViewType: iconType,
                    iconColor: this.group.iconColor || 'rgb(66, 134, 244)',
                });
            },

            isDisabledContainer({cookieStoreId}) {
                return !this.group.catchTabContainers.includes(cookieStoreId) && this.disabledContainers.hasOwnProperty(cookieStoreId);
            },

            async selectUserGroupIcon() {
                if (!this.canLoadFile) { // maybe temporary solution
                    this.showMessageCantLoadFile = true;
                    return;
                }

                let iconUrl = await file.load('.ico,.png,.jpg,.svg', 'url'),
                    img = new Image();

                img.addEventListener('load', () => {
                    let resizedIconUrl = iconUrl;

                    if (img.height > 64 || img.width > 64) {
                        resizedIconUrl = utils.resizeImage(img, 64, 64);
                    }

                    this.setIconUrl(resizedIconUrl);
                });

                img.src = iconUrl;
            },

            async saveGroup() {
                if (this.changedKeys.length) {
                    let group = {};

                    this.changedKeys.forEach(key => group[key] = this.group[key]);

                    if (this.changedKeys.includes('title')) {
                        group.title = utils.createGroupTitle(group.title, this.groupId);
                    }

                    if (this.changedKeys.includes('catchTabRules')) {
                        group.catchTabRules
                            .split(/\s*\n\s*/)
                            .filter(Boolean)
                            .forEach(function(regExpStr) {
                                try {
                                    new RegExp(regExpStr);
                                } catch (e) {
                                    utils.notify(['invalidRegExpRuleTitle', regExpStr]);
                                }
                            });
                    }

                    await Groups.update(this.groupId, group);
                }

                this.$emit('saved');
            },
        }
    }
</script>

<template>
    <div v-if="group" @keyup.stop @keydown.stop @keydown.enter="saveGroup" tabindex="-1" class="no-outline edit-group">
        <div class="field">
            <label class="label" v-text="lang('title')"></label>
            <div class="control has-icons-left">
                <input ref="groupTitle" v-model.trim="group.title" type="text" class="input" :placeholder="lang('title')" />
                <span class="icon is-small is-left">
                    <figure class="image is-16x16 is-inline-block">
                        <img :src="group.iconUrlToDisplay" />
                    </figure>
                </span>
            </div>
        </div>

        <div class="field">
            <label class="label" v-text="lang('iconStyle')"></label>
            <div class="field is-grouped icon-buttons">
                <div class="control">
                    <swatches v-model.trim="group.iconColor" :title="lang('iconColor')" swatches="text-advanced" popover-x="right" show-fallback :trigger-style="{
                        width: '36px',
                        height: '27px',
                        borderRadius: '4px',
                    }" />
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

        <div class="field">
            <div class="control">
                <label class="checkbox">
                    <input type="checkbox" v-model="group.muteTabsWhenGroupCloseAndRestoreWhenOpen" />
                    <span v-text="lang('muteTabsWhenGroupCloseAndRestoreWhenOpen')"></span>
                </label>
            </div>
            <div v-if="options.discardTabsAfterHide" class="control">
                <label class="checkbox">
                    <input type="checkbox" v-model="group.dontDiscardTabsAfterHideThisGroup" />
                    <span v-text="lang('dontDiscardTabsAfterHideThisGroup')"></span>
                </label>
            </div>
        </div>

        <div class="field">
            <label class="label" v-text="lang('alwaysOpenTabsInContainer')"></label>
            <div class="containers-wrapper">
                <div v-for="container in containers" :key="container.cookieStoreId" class="control">
                    <label class="radio indent-children">
                        <input type="radio" :value="container.cookieStoreId" v-model="group.newTabContainer" />
                        <img v-if="container.iconUrl" :src="container.iconUrl" class="size-16 fill-context" :style="{fill: container.colorCode}" />
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
                    <div v-for="container in containers" v-if="container.cookieStoreId !== TEMPORARY_CONTAINER" :key="container.cookieStoreId" class="control">
                        <label
                            class="checkbox indent-children"
                            :disabled="container.cookieStoreId === group.newTabContainer">
                            <input
                                type="checkbox"
                                :disabled="container.cookieStoreId === group.newTabContainer"
                                :value="container.cookieStoreId"
                                v-model="group.excludeContainersForReOpen" />
                            <img v-if="container.iconUrl" :src="container.iconUrl" class="size-16 fill-context" :style="{fill: container.colorCode}" />
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
            <div class="control">
                <label class="checkbox">
                    <input type="checkbox" v-model="group.showTabAfterMovingItIntoThisGroup" />
                    <span v-text="lang('showTabAfterMovingItIntoThisGroup')"></span>
                </label>
            </div>
        </div>

        <div class="field">
            <label class="label" v-text="lang('catchTabContainers')"></label>
            <div class="containers-wrapper">
                <div v-for="container in containers" v-if="container.cookieStoreId !== TEMPORARY_CONTAINER" :key="container.cookieStoreId" class="control">
                    <label class="checkbox indent-children" :disabled="isDisabledContainer(container)">
                        <input type="checkbox" :disabled="isDisabledContainer(container)" :value="container.cookieStoreId" v-model="group.catchTabContainers" />
                        <img v-if="container.iconUrl" :src="container.iconUrl" class="size-16 fill-context" :style="{fill: container.colorCode}" />
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
                <textarea class="textarea reg-exp" :rows="canLoadFile ? false : 2" @keydown.enter.stop v-model.trim="group.catchTabRules" :placeholder="lang('regexpForTabsPlaceholder')"></textarea>
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
