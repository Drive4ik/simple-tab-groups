<script>
    'use strict';

    import * as utils from '../js/utils';
    import Vue from 'vue';

    import swatches from 'vue-swatches'
    import "vue-swatches/dist/vue-swatches.min.css"

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
        'isSticky',
        'windowId'
    ];

    const iconTypes = [
        'main-squares',
        'circle',
        'squares',
        'old-tab-groups'
    ];

    export default {
        name: 'edit-group',
        props: {
            group: {
                required: true,
                type: Object,
            },
            browserActionIconColor: {
                required: true,
                type: String,
            },
            containers: {
                required: true,
                type: Array,
            },
        },
        components: {
            swatches: swatches,
        },
        data() {
            let vm = this;

            return {
                iconTypes: iconTypes,
                groupClone: new Vue({
                    data: utils.extractKeys(this.group, fieldsToEdit),
                    computed: {
                        iconUrlToDisplay() {
                            // watch variables
                            this.iconUrl;
                            this.iconColor;
                            this.iconViewType;

                            return utils.getGroupIconUrl(this, vm.browserActionIconColor);
                        },
                    },
                }),
            };
        },
        mounted() {
            this.$refs.groupTitle.focus();
        },
        methods: {
            lang: browser.i18n.getMessage,

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
                    this.groupClone.iconViewType = this.iconTypes[0];
                }
            },

            getIconTypeUrl(iconType) {
                return utils.getGroupIconUrl({
                    iconViewType: iconType,
                    iconColor: this.groupClone.iconColor || 'rgb(66, 134, 244)',
                }, this.browserActionIconColor);
            },

            async selectUserGroupIcon() {
                // if (1 === lastOptions.popupDesign) { // maybe temporary solution
                //     if (window.confirm(browser.i18n.getMessage('selectUserGroupIconWarnText'))) {
                //         dispatchEvent('click', '[data-action="open-manage-page"]');
                //     }

                //     return;
                // }

                let vm = this;

                let iconUrl = await new Promise(function(resolve) {
                    let fileInput = document.createElement('input');

                    fileInput.type = 'file';
                    fileInput.accept = '.ico,.png,.jpg,.svg';
                    fileInput.initialValue = fileInput.value;
                    fileInput.onchange = function() {
                        if (fileInput.value !== fileInput.initialValue) {
                            let file = fileInput.files[0];
                            if (file.size > 100e6) {
                                reject();
                                return;
                            }

                            let reader = new FileReader();
                            reader.addEventListener('loadend', function() {
                                fileInput.remove();
                                resolve(reader.result);
                            });
                            reader.readAsDataURL(file);
                        } else {
                            reject();
                        }
                    };
                    fileInput.click();
                });

                let img = new Image();
                img.addEventListener('load', function() {
                    let resizedIconUrl = iconUrl;

                    if (img.height > 16 || img.width > 16) {
                        resizedIconUrl = utils.resizeImage(img, 16, 16);
                    }

                    vm.setIconUrl(resizedIconUrl);
                });
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
                            notify(browser.i18n.getMessage('invalidRegExpRuleTitle', regExpStr));
                        }
                    });

                BG.updateGroup(group.id, group);

                this.$emit('saved');
            },
        }
    }
</script>

<template>
    <div>
        <div class="field">
            <label class="label" v-text="lang('title')"></label>
            <div class="control has-icons-left">
                <input ref="groupTitle" v-model.trim="groupClone.title" data-auto-focus type="text" class="input" maxlength="120" :placeholder="lang('title')" />
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
                <div v-for="iconType in iconTypes" class="control">
                    <button @click="setIconView(iconType)" :class="['button', {'is-focused': !groupClone.iconUrl && iconType === groupClone.iconViewType}]">
                        <figure class="image is-16x16 is-inline-block">
                            <img :src="getIconTypeUrl(iconType)" />
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

        <hr>

        <div class="field">
            <div class="control">
                <label class="checkbox">
                    <input id="isStickyGroup" type="checkbox" v-model="groupClone.isSticky" />
                    <span v-text="lang('isStickyGroupTitle')"></span>
                </label>
                <span class="cursor-help" :title="lang('isStickyGroupHelp')">
                    <img class="size-18 align-bottom" src="/icons/help.svg" />
                </span>
            </div>
        </div>

        <div v-if="containers.length" class="field containers-wrapper">
            <label class="label">
                <span v-text="lang('catchTabContainers')"></span>
            </label>
            <div class="control">
                <div v-for="container in containers" class="field">
                    <div class="control">
                        <label class="checkbox">
                            <input type="checkbox" :value="container.cookieStoreId" v-model="groupClone.catchTabContainers" />
                            <img :src="container.iconUrl" class="size-16 align-bottom container-icon" :style="{fill: container.colorCode}" />
                            <span v-text="container.name"></span>
                        </label>
                    </div>
                </div>
            </div>
        </div>

        <div class="field">
            <label class="label">
                <span v-text="lang('regexpForTabsTitle')"></span>
                <span class="cursor-help" :title="lang('regexpForTabsHelp')">
                    <img class="size-18" src="/icons/help.svg" />
                </span>
            </label>
            <div class="control">
                <textarea class="textarea" v-model="groupClone.catchTabRules" :placeholder="lang('regexpForTabsPlaceholder')"></textarea>
            </div>
        </div>

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
