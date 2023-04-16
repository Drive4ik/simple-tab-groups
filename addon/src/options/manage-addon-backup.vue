<script>
    'use strict';

    import * as Constants from 'constants';
    import * as Containers from 'containers';
    import * as Groups from 'groups';
    import JSON from 'json';

    export default {
        props: {
            data: {
                required: true,
                type: Object,
            },
            disableEmptyGroups: {
                required: true,
                type: Boolean,
            },
            allowClearAddonData: {
                required: true,
                type: Boolean,
            },
        },
        watch: {
            clearAddonData(value) {
                this.$emit('clear-addon-data-update', value);
            },
            groups({length}) {
                if (!length) {
                    this.checkAllGroups = false;
                } else if (this.filteredGroups.length === length) {
                    this.checkAllGroups = true;
                }
            },
            checkAllGroups(cheched) {
                this.groups = cheched ? this.filteredGroups.slice() : [];
            },
        },
        computed: {
            showPinnedTabs() {
                return this.data.pinnedTabs?.length > 0;
            },
            showGeneral() {
                return Object.keys(this.data).some(key => key !== 'hotkeys' && Constants.ALL_OPTIONS_KEYS.includes(key));
            },
            showHotkeys() {
                return this.data.hotkeys?.length > 0;
            },
        },
        mounted() {
            this.$nextTick(() => this.$emit('clear-addon-data-update', this.allowClearAddonData));
        },
        data() {
            let filteredGroups = this.disableEmptyGroups ? this.data.groups.filter(group => group.tabs.length) : this.data.groups;

            return {
                TEMPORARY_CONTAINER: Constants.TEMPORARY_CONTAINER,
                DEFAULT_COOKIE_STORE_ID: Constants.DEFAULT_COOKIE_STORE_ID,
                allContainers: Containers.getAll(),

                filteredGroups,

                clearAddonData: this.allowClearAddonData ? true : false,

                includePinnedTabs: true,
                includeGeneral: true,
                includeHotkeys: true,

                checkAllGroups: true,

                groups: filteredGroups.slice(),
                disabledGroups: this.disableEmptyGroups ? this.data.groups.filter(group => !group.tabs.length) : [],
            };
        },
        methods: {
            lang: browser.i18n.getMessage,

            getGroupIconUrl: Groups.getIconUrl,

            getData() {
                const result = {
                    groups: this.groups,
                };

                if (typeof this.data.version === 'string' && this.data.version.length) {
                    result.version = this.data.version;
                }

                if (this.data.containers && result.groups.length) {
                    result.containers = this.data.containers;
                }

                if (Number.isSafeInteger(this.data.lastCreatedGroupPosition)) {
                    result.lastCreatedGroupPosition = this.data.lastCreatedGroupPosition;
                }

                if (this.showPinnedTabs && this.includePinnedTabs && this.data.pinnedTabs && this.data.pinnedTabs.length) {
                    result.pinnedTabs = this.data.pinnedTabs;
                }

                if (this.showGeneral && this.includeGeneral) {
                    for (let key in this.data) {
                        if (key !== 'hotkeys' && Constants.ALL_OPTIONS_KEYS.includes(key)) {
                            result[key] = this.data[key];
                        }
                    }
                }

                if (this.showHotkeys && this.includeHotkeys) {
                    result.hotkeys = this.data.hotkeys;
                }

                return JSON.clone(result);
            },
        },
    }
</script>

<template>
    <div id="manageAddonBackup">
        <div v-if="allowClearAddonData" class="field">
            <div class="field">
                <label class="checkbox">
                    <input type="checkbox" v-model="clearAddonData" />
                    <span class="has-text-weight-bold" v-text="lang('deleteAllAddonDataAndSettingsBeforeRestoringBackup')"></span>
                </label>
                <br>
                <span class="has-text-danger has-text-weight-bold" v-html="lang('eraseAddonSettingsWarningTitle')"></span>
            </div>
            <hr>
        </div>

        <div v-if="showPinnedTabs" class="field">
            <div class="field">
                <label class="checkbox">
                    <input type="checkbox" v-model="includePinnedTabs" />
                    <span v-text="lang('pinnedTabs')"></span>
                    &nbsp;
                    <small class="is-italic">
                        (<span v-text="lang('groupTabsCount', data.pinnedTabs.length)"></span>)
                    </small>
                </label>
            </div>
            <hr>
        </div>

        <div v-if="showGeneral || showHotkeys" class="field">
            <label class="label" v-text="lang('importAddonSettings')"></label>
            <div v-if="showGeneral" class="field">
                <label class="checkbox">
                    <input type="checkbox" v-model="includeGeneral" />
                    <span v-text="lang('generalTitle')"></span>
                </label>
            </div>
            <div v-if="showHotkeys" class="field">
                <label class="checkbox">
                    <input type="checkbox" v-model="includeHotkeys" />
                    <span v-text="lang('hotkeysTitle')"></span>
                </label>
            </div>
            <hr>
        </div>

        <div class="field">
            <label class="label checkbox">
                <input type="checkbox" v-model="checkAllGroups" />
                <span v-text="lang('importGroups')"></span>
            </label>

            <div class="control" v-for="group in data.groups" :key="group.id">
                <label class="checkbox" :disabled="disabledGroups.includes(group)">
                    <input type="checkbox" v-model="groups" :value="group" :disabled="disabledGroups.includes(group)" />
                    <template v-if="group.iconUrl || group.iconColor">
                        <figure class="image is-16x16 is-inline-block">
                            <img :src="getGroupIconUrl(group)" />
                        </figure>
                        &nbsp;
                    </template>
                    <template v-if="group.newTabContainer !== DEFAULT_COOKIE_STORE_ID">
                        <figure v-if="group.newTabContainer === TEMPORARY_CONTAINER" class="image is-16x16 is-inline-block">
                            <img :src="allContainers[TEMPORARY_CONTAINER].iconUrl" class="size-16 fill-context" />
                        </figure>
                        <figure v-else-if="data.containers && data.containers[group.newTabContainer] && data.containers[group.newTabContainer].iconUrl" class="image is-16x16 is-inline-block">
                            <span :class="`size-16 userContext-icon identity-icon-${data.containers[group.newTabContainer].icon} identity-color-${data.containers[group.newTabContainer].color}`"></span>
                        </figure>
                        &nbsp;
                    </template>
                    <span class="group-title" v-text="group.title"></span>
                    &nbsp;
                    <small class="is-italic">
                        (<span v-text="lang('groupTabsCount', group.tabs.length)"></span>)
                    </small>
                </label>
            </div>
        </div>

    </div>
</template>

<style lang="scss">
    #manageAddonBackup {
        .image.is-16x16 {
            min-width: 16px;
        }

        .group-title {
            word-wrap: anywhere;
        }
    }

</style>
