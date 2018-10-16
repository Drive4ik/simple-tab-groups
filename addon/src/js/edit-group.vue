<script>
    'use strict';

    import * as utils from './utils';
    import * as file from './file';
    import { groupIconViewTypes } from './constants';
    import Vue from 'vue';

    import popup from './popup.vue';
    import swatches from 'vue-swatches';
    import "vue-swatches/dist/vue-swatches.min.css";

    const BG = (function(bgWin) {
        return bgWin && bgWin.background && bgWin.background.inited ? bgWin.background : false;
    })(browser.extension.getBackgroundPage());

    const fieldsToEdit = [
        'id',
        'title',
        'iconColor',
        'iconUrl',
        'iconViewType',
        'catchTabRules',
        'catchTabContainers',
        'muteTabsWhenGroupCloseAndRestoreWhenOpen',
        'isSticky',
        'showTabAfterMovingItIntoThisGroup',
        'windowId'
    ];

    export default {
        name: 'edit-group',
        props: {
            group: {
                required: true,
                type: Object,
            },
            containers: {
                required: true,
                type: Array,
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
            let vm = this,
                groups = BG.getGroups(),
                disabledContainers = {};

            this.containers.forEach(function(container) {
                let groupWhichHasContainer = groups.find(group => group.id !== this.group.id && group.catchTabContainers.includes(container.cookieStoreId));

                if (groupWhichHasContainer) {
                    disabledContainers[container.cookieStoreId] = groupWhichHasContainer.title;
                }
            }, this);

            return {
                disabledContainers: disabledContainers,

                showMessageCantLoadFile: false,

                groupIconViewTypes: groupIconViewTypes,
                groupClone: new Vue({
                    data: utils.extractKeys(this.group, fieldsToEdit),
                    computed: {
                        iconUrlToDisplay() {
                            // watch variables
                            this.iconUrl;
                            this.iconColor;
                            this.iconViewType;

                            return utils.getGroupIconUrl(this);
                        },
                    },
                }),
            };
        },
        mounted() {
            this.setFocus();
        },
        methods: {
            lang: browser.i18n.getMessage,

            setFocus() {
                this.$refs.groupTitle.focus();
            },

            setIconView(groupIcon) {
                this.groupClone.iconViewType = groupIcon;
                this.groupClone.iconUrl = null;
            },

            setIconUrl(iconUrl) {
                this.groupClone.iconViewType = null;
                this.groupClone.iconUrl = iconUrl;
            },

            setRandomColor() {
                this.groupClone.iconUrl = null;
                this.groupClone.iconColor = utils.randomColor();

                if (!this.groupClone.iconViewType) {
                    this.groupClone.iconViewType = this.groupIconViewTypes[0];
                }
            },

            getIconTypeUrl(iconType) {
                return utils.getGroupIconUrl({
                    iconViewType: iconType,
                    iconColor: this.groupClone.iconColor || 'rgb(66, 134, 244)',
                });
            },

            isDisabledContainer(container) {
                return !this.groupClone.catchTabContainers.includes(container.cookieStoreId) && container.cookieStoreId in this.disabledContainers;
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
                let group = utils.clone(this.groupClone.$data);

                delete group.windowId;

                group.title = utils.createGroupTitle(group.title, group.id);
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

                BG.updateGroup(group.id, group);

                this.$emit('saved');
            },
        }
    }
</script>

<template>
    <div @keydown.enter.stop="saveGroup" tabindex="-1" class="no-outline">
        <div class="field">
            <label class="label" v-text="lang('title')"></label>
            <div class="control has-icons-left">
                <input ref="groupTitle" v-model.trim="groupClone.title" type="text" class="input" maxlength="120" :placeholder="lang('title')" />
                <span class="icon is-small is-left">
                    <figure class="image is-16x16 is-inline-block">
                        <img :src="groupClone.iconUrlToDisplay" />
                    </figure>
                </span>
            </div>
        </div>

        <div class="field">
            <label class="label" v-text="lang('iconStyle')"></label>
            <div class="field is-grouped cut-bottom-margin">
                <div class="control">
                    <swatches v-model.trim="groupClone.iconColor" :title="lang('iconColor')" colors="text-advanced" popover-to="right" show-fallback :trigger-style="{
                        width: '35px',
                        height: '30px',
                        borderRadius: '4px',
                    }" />
                </div>
                <div v-for="iconViewType in groupIconViewTypes" :key="iconViewType" class="control">
                    <button @click="setIconView(iconViewType)" :class="['button', {'is-focused': !groupClone.iconUrl && iconViewType === groupClone.iconViewType}]">
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
                    <input type="checkbox" v-model="groupClone.muteTabsWhenGroupCloseAndRestoreWhenOpen" />
                    <span v-text="lang('muteTabsWhenGroupCloseAndRestoreWhenOpen')"></span>
                </label>
            </div>
        </div>

        <hr>

        <div class="field">
            <label class="label" v-text="lang('tabMoving')"></label>
            <div class="control is-inline-flex indent-children">
                <label class="checkbox">
                    <input type="checkbox" v-model="groupClone.isSticky" />
                    <span v-text="lang('isStickyGroupTitle')"></span>
                </label>
                <span class="cursor-help" :title="lang('isStickyGroupHelp')">
                    <img class="size-18" src="/icons/help.svg" />
                </span>
            </div>
            <div class="control">
                <label class="checkbox">
                    <input type="checkbox" v-model="groupClone.showTabAfterMovingItIntoThisGroup" />
                    <span v-text="lang('showTabAfterMovingItIntoThisGroup')"></span>
                </label>
            </div>
        </div>

        <div v-if="containers.length" class="field containers-wrapper">
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
                                v-model="groupClone.catchTabContainers"
                                />
                            <img :src="container.iconUrl" class="size-16 fill-context" :style="{fill: container.colorCode}" />
                            <span v-text="container.name"></span>
                            <i v-if="container.cookieStoreId in disabledContainers">({{ disabledContainers[container.cookieStoreId] }})</i>
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
                <textarea class="textarea" :rows="canLoadFile ? false : 1" @keydown.enter.stop v-model="groupClone.catchTabRules" :placeholder="lang('regexpForTabsPlaceholder')"></textarea>
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

    .field.cut-bottom-margin {
        margin-bottom: -.75em;
    }

    .field.is-grouped > .control:not(:last-child) {
        margin-right: .68rem;
    }

    .containers-wrapper .field {
        margin: 0;
    }
</style>
