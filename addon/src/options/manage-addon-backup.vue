<script>
    'use strict';

    import * as Constants from '/js/constants.js';
    import * as Containers from '/js/containers.js';
    import * as Groups from '/js/groups.js';
    import JSON from '/js/json.js';

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
            enableGetData(value) {
                this.$emit('enable-get-data', value);
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
                return Object.keys(this.data).some(this.isGeneralOptionsKey, this);
            },
            showHotkeys() {
                return this.data.hotkeys?.length > 0;
            },
            readyPinnedTabs() {
                return this.showPinnedTabs && this.includePinnedTabs;
            },
            getGeneral() {
                return this.showGeneral && this.includeGeneral;
            },
            getHotkeys() {
                return this.showHotkeys && this.includeHotkeys;
            },
            getGroups() {
                return this.groups.length > 0;
            },
            enableGetData() {
                return this.getGeneral || this.getHotkeys || this.getGroups;
            },
        },
        mounted() {
            this.$nextTick(() => this.$emit('clear-addon-data-update', this.allowClearAddonData));
        },
        data() {
            let filteredGroups,
                disabledGroups;

            if (this.disableEmptyGroups) {
                filteredGroups = this.data.groups.filter(group => group.tabs.length);
                disabledGroups = this.data.groups.filter(group => !group.tabs.length);
            } else {
                filteredGroups = this.data.groups;
                disabledGroups = [];
            }

            return {
                TEMPORARY_CONTAINER: Constants.TEMPORARY_CONTAINER,
                DEFAULT_COOKIE_STORE_ID: Constants.DEFAULT_COOKIE_STORE_ID,
                allContainers: Containers.getAll(),

                filteredGroups,

                clearAddonData: this.allowClearAddonData,

                includePinnedTabs: true,
                includeGeneral: true,
                includeHotkeys: true,

                checkAllGroups: true,

                groups: filteredGroups.slice(),
                disabledGroups,
            };
        },
        methods: {
            lang: browser.i18n.getMessage,

            getGroupIconUrl: Groups.getIconUrl,

            getGroupTitle: Groups.getTitle,

            isGeneralOptionsKey(key) {
                if (key === 'hotkeys') {
                    return false;
                }

                return Constants.ALL_OPTION_KEYS.includes(key);
            },

            getData() {
                const result = {};

                if (this.getGroups) {
                    result.groups = this.groups;

                    if (this.data.containers) {
                        result.containers = this.data.containers;
                    }

                    if (this.readyPinnedTabs) {
                        result.pinnedTabs = this.data.pinnedTabs;
                    }
                }

                if (this.getGeneral) {
                    for (const key in this.data) {
                        if (this.isGeneralOptionsKey(key)) {
                            result[key] = this.data[key];
                        }
                    }
                }

                if (this.getHotkeys) {
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
            <div class="field">
                <div class="control">
                    <label class="label checkbox">
                        <input type="checkbox" v-model="checkAllGroups" />
                        <span v-text="lang('importGroups')"></span>
                    </label>
                </div>
            </div>

            <div class="field" v-for="group in data.groups" :key="group.id">
                <div class="control">
                    <label class="checkbox indent-children" :disabled="disabledGroups.includes(group)">
                        <input type="checkbox" v-model="groups" :value="group" :disabled="disabledGroups.includes(group)" />

                        <figure v-if="group.iconUrl || group.iconColor" class="image is-16x16 is-inline-block">
                            <img :src="getGroupIconUrl(group)" />
                        </figure>

                        <figure v-if="group.isArchive" class="image is-16x16">
                            <img src="/icons/archive.svg" />
                        </figure>

                        <template v-if="group.newTabContainer !== DEFAULT_COOKIE_STORE_ID">
                            <figure v-if="group.newTabContainer === TEMPORARY_CONTAINER" class="image is-16x16 is-inline-block">
                                <img :src="allContainers[TEMPORARY_CONTAINER].iconUrl" class="size-16 fill-context" />
                            </figure>
                            <figure v-else-if="data.containers && data.containers[group.newTabContainer] && data.containers[group.newTabContainer].iconUrl" class="image is-16x16 is-inline-block">
                                <span :class="`size-16 userContext-icon identity-icon-${data.containers[group.newTabContainer].icon} identity-color-${data.containers[group.newTabContainer].color}`"></span>
                            </figure>
                        </template>

                        <span class="group-title" v-text="getGroupTitle(group)"></span>

                        <small class="is-italic">
                            (<span v-text="lang('groupTabsCount', group.tabs.length)"></span>)
                        </small>
                    </label>
                </div>
            </div>
        </div>

    </div>
</template>

<style>
    #manageAddonBackup {
        .group-title {
            word-wrap: anywhere;
        }
    }

</style>
