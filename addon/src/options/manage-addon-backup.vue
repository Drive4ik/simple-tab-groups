<script>
import * as Constants from '/js/constants.js';
import * as Containers from '/js/containers.js';
import * as Groups from '/js/groups.js';
import Lang from '/js/lang.js';
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
            allContainers: Containers.query({temporaryContainer: true}),

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
        lang: Lang,

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
    <div v-if="allowClearAddonData" class="block">
        <label class="checkbox">
            <input type="checkbox" v-model="clearAddonData" />
            <span class="has-text-weight-bold" v-text="lang('deleteAllAddonDataAndSettingsBeforeRestoringBackup')"></span>
        </label>
        <br>
        <span class="has-text-danger has-text-weight-bold white-space-pre-line" v-html="lang('eraseAddonSettingsWarningTitle')"></span>
    </div>

    <hr/>

    <div v-if="showPinnedTabs" class="block">
        <label class="checkbox">
            <input type="checkbox" v-model="includePinnedTabs" />
            <span>
                <span v-text="lang('pinnedTabs')"></span>
                <small class="is-italic brackets-round" v-text="lang('groupTabsCount', data.pinnedTabs.length)"></small>
            </span>
        </label>
    </div>

    <hr/>

    <div v-if="showGeneral || showHotkeys" class="block">
        <label class="label" v-text="lang('importAddonSettings')"></label>
        <div class="checkboxes as-column">
            <label v-if="showGeneral" class="checkbox">
                <input type="checkbox" v-model="includeGeneral" />
                <span v-text="lang('generalTitle')"></span>
            </label>
            <label v-if="showHotkeys" class="checkbox">
                <input type="checkbox" v-model="includeHotkeys" />
                <span v-text="lang('hotkeysTitle')"></span>
            </label>
        </div>
    </div>

    <hr/>

    <div class="block">
        <div class="checkboxes as-column">
            <label class="checkbox label">
                <input type="checkbox" v-model="checkAllGroups" />
                <span v-text="lang('importGroups')"></span>
            </label>

            <label v-for="group in data.groups" :key="group.id" class="checkbox" :disabled="disabledGroups.includes(group)">
                <input type="checkbox" v-model="groups" :value="group" :disabled="disabledGroups.includes(group)" />

                <span class="icon-text is-flex-wrap-nowrap">
                    <figure v-if="group.iconViewType" class="icon image is-16x16">
                        <img :src="getGroupIconUrl(group)" />
                    </figure>

                    <figure v-if="group.isArchive" class="icon image is-16x16">
                        <img src="/icons/archive.svg" />
                    </figure>

                    <figure v-if="group.newTabContainer === TEMPORARY_CONTAINER" class="icon image is-16x16">
                        <img :src="allContainers[TEMPORARY_CONTAINER].iconUrl" />
                    </figure>
                    <figure v-else-if="data.containers?.[group.newTabContainer]?.iconUrl" :class="`icon image is-16x16 userContext-icon identity-icon-${data.containers[group.newTabContainer]?.icon} identity-color-${data.containers[group.newTabContainer]?.color}`">
                        <figure></figure>
                    </figure>

                    <span class="word-wrap-anywhere" v-text="getGroupTitle(group)"></span>

                    <small class="brackets-round is-italic" v-text="lang('groupTabsCount', group.tabs.length)"></small>
                </span>
            </label>
        </div>
    </div>

</div>
</template>
