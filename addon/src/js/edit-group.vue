<script>
    'use strict';

    import file from './file';
    import utils from './utils';
    import constants from './constants';

    import Vue from 'vue';

    import popup from './popup.vue';
    import swatches from 'vue-swatches';
    import Groups from '../js/groups';
    import Tabs from '../js/tabs';
    import 'vue-swatches/dist/vue-swatches.min.css';

    const {BG} = browser.extension.getBackgroundPage();

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
                containers: BG.containers.getAll(),
                disabledContainers: {},
                disabledContainerGroupTabs: {},

                showMessageCantLoadFile: false,

                groupIconViewTypes: constants.groupIconViewTypes,

                group: null,

                changedKeys: [],

                currentTabUrl: null,
            };
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
            hasContainers() {
                return Object.keys(this.containers).length > 0;
            },
        },
        async created() {
            let [group, groups] = await Groups.load(this.groupId);

            this.group = new Vue({
                data: group,
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

            for (let key in group) {
                let unwatch = this.$watch(`group.${key}`, function() {
                    this.changedKeys.push(key);
                    unwatch();
                }, {
                    deep: true,
                });
            });

            for (let cookieStoreId in this.containers) {
                groups.forEach(function(gr) {
                    if (gr.id === this.groupId) {
                        return;
                    }

                    if (gr.catchTabContainers.includes(cookieStoreId)) {
                        this.$set(this.disabledContainers, cookieStoreId, gr.title);
                    }

                    if (gr.newTabContainer === cookieStoreId) {
                        this.$set(this.disabledContainerGroupTabs, cookieStoreId, gr.title);
                    }
                }, this);
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
                    this.group.iconViewType = BG.getOptions().defaultGroupIconViewType;
                }
            },

            getIconTypeUrl(iconType) {
                return utils.getGroupIconUrl({
                    iconViewType: iconType,
                    iconColor: this.group.iconColor || 'rgb(66, 134, 244)',
                });
            },

            isDisabledContainer({cookieStoreId}) {
                return !this.group.catchTabContainers.includes(cookieStoreId) && cookieStoreId in this.disabledContainers;
            },

            isDisabledNewTabContainer({cookieStoreId}) {
                return this.group.newTabContainer !== cookieStoreId && cookieStoreId in this.disabledContainerGroupTabs;
            },

            checkNewTabContainer(cookieStoreId, isChecked) {
                if (isChecked) {
                    if (!this.isDisabledNewTabContainer({cookieStoreId}) && !this.group.newTabContainer) {
                        this.group.newTabContainer = cookieStoreId;
                    }
                } else if (this.group.newTabContainer === cookieStoreId) {
                    this.group.newTabContainer = null;
                }
            },

            async selectUserGroupIcon() {
                if (!this.canLoadFile) { // maybe temporary solution
                    this.showMessageCantLoadFile = true;
                    return;
                }

                let iconUrl = await file.load('.ico,.png,.jpg,.svg', 'url'),
                    img = new Image();

                img.addEventListener('load', function() {
                    let resizedIconUrl = iconUrl;

                    if (img.height > 16 || img.width > 16) {
                        resizedIconUrl = utils.resizeImage(img, 16, 16);
                    }

                    this.setIconUrl(resizedIconUrl);
                }.bind(this));

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
                                    utils.notify(browser.i18n.getMessage('invalidRegExpRuleTitle', regExpStr));
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
    <div v-if="group" @keydown.enter.stop="saveGroup" tabindex="-1" class="no-outline edit-group">
        <div class="field">
            <label class="label" v-text="lang('title')"></label>
            <div class="control has-icons-left">
                <input ref="groupTitle" v-model.trim="group.title" type="text" class="input" maxlength="120" :placeholder="lang('title')" />
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
                    <swatches v-model.trim="group.iconColor" :title="lang('iconColor')" colors="text-advanced" popover-to="right" show-fallback :trigger-style="{
                        width: '35px',
                        height: '30px',
                        borderRadius: '4px',
                    }" />
                </div>
                <div v-for="iconViewType in groupIconViewTypes" :key="iconViewType" class="control">
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
            <div class="control">
                <label class="checkbox">
                    <input type="checkbox" v-model="group.dontDiscardTabsAfterHideThisGroup" />
                    <span v-text="lang('dontDiscardTabsAfterHideThisGroup')"></span>
                </label>
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

        <div v-if="hasContainers" class="field containers-wrapper">
            <label class="label">
                <span v-text="lang('catchTabContainers')"></span>
            </label>
            <div class="control">
                <div v-for="container in containers" :key="container.cookieStoreId" class="field">
                    <div class="control">
                        <label class="checkbox indent-children" :disabled="isDisabledContainer(container)">
                            <input type="checkbox"
                                :disabled="isDisabledContainer(container)"
                                :value="container.cookieStoreId"
                                @change="checkNewTabContainer(container.cookieStoreId, $event.target.checked)"
                                v-model="group.catchTabContainers"
                                />
                            <img :src="container.iconUrl" class="size-16 fill-context" :style="{fill: container.colorCode}" />
                            <span class="word-break-all" v-text="container.name"></span>
                            <i class="word-break-all" v-if="container.cookieStoreId in disabledContainers">({{ disabledContainers[container.cookieStoreId] }})</i>
                        </label>
                    </div>
                </div>
            </div>
        </div>

        <div v-if="hasContainers" class="field containers-wrapper">
            <label class="label">
                <span v-text="lang('alwaysOpenTabsInContainer')"></span>
            </label>
            <div class="control">
                <div class="field">
                    <div class="control">
                        <label class="radio indent-children">
                            <input type="radio" :value="null" v-model="group.newTabContainer" />
                            <span class="word-break-all" v-text="'Default'"></span>
                        </label>
                    </div>
                </div>
                <div v-for="container in containers" :key="container.cookieStoreId" class="field">
                    <div class="control">
                        <label class="radio indent-children" :disabled="isDisabledNewTabContainer(container)">
                            <input type="radio"
                                :disabled="isDisabledNewTabContainer(container)"
                                :value="container.cookieStoreId"
                                v-model="group.newTabContainer"
                                />
                            <img :src="container.iconUrl" class="size-16 fill-context" :style="{fill: container.colorCode}" />
                            <span class="word-break-all" v-text="container.name"></span>
                            <i class="word-break-all" v-if="container.cookieStoreId in disabledContainerGroupTabs">({{ disabledContainerGroupTabs[container.cookieStoreId] }})</i>
                        </label>
                    </div>
                </div>
            </div>
        </div>

        <div class="field h-margin-bottom-10">
            <label class="label is-inline-flex indent-children">
                <span v-text="lang('regexpForTabsTitle')"></span>
                <span class="cursor-help" :title="lang('regexpForTabsHelp')">
                    <img class="size-18" src="/icons/help.svg" />
                </span>
            </label>
            <div class="control">
                <textarea class="textarea reg-exp" :rows="canLoadFile ? false : 2" @keydown.enter.stop v-model.trim="group.catchTabRules" :placeholder="lang('regexpForTabsPlaceholder')"></textarea>
            </div>
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
    .vue-swatches__fallback__wrapper {
        margin-top: 5px;
    }

    .edit-group {
        .icon-buttons {
            flex-wrap: wrap;
        }

        .field.is-grouped > .control:not(:last-child) {
            margin-right: .68rem;
        }

        .containers-wrapper .field {
            margin: 0;
        }

        .field > .control {
            cursor: default;
        }

        .checkbox,
        .radio {
            display: flex;
        }

        .reg-exp {
            font-family: Monaco, Consolas, Andale Mono, Lucida Console;
        }
    }

</style>
