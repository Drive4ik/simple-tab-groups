<script>
import contextMenu from './context-menu.vue';
import * as Groups from '/js/groups.js';

export default {
    props: {
        menu: {
            type: Array,
            required: true,
        },
        groups: {
            type: Array,
            required: true,
        },
        multipleTabIds: {
            type: Array,
            default: () => [],
        },
        showUpdateThumbnail: {
            type: Boolean,
            default: false,
        },
    },
    components: {
        'context-menu': contextMenu,
    },
    computed: {
        nonArchivedGroups() {
            return this.groups.filter(group => !group.isArchive);
        },
    },
    methods: {
        lang: browser.i18n.getMessage,
        getGroupTitle: Groups.getTitle,
        open(...args) {
            this.$refs.contextMenu.open(...args);
        },
    },
};

</script>

<template>
    <context-menu ref="contextMenu">
        <template v-slot="{data}">
            <ul v-if="data" class="is-unselectable">
                <li
                    v-if="menu.includes('open-in-new-window') && data.group"
                    @click="$emit('open-in-new-window', data.group, data.tab)">
                    <figure class="image is-16x16">
                        <img src="/icons/window-new.svg" />
                    </figure>
                    <span v-text="lang('openGroupInNewWindow')"></span>
                </li>
                <li
                    v-if="menu.includes('reload')"
                    @click="$emit('reload', data.tab, $event.ctrlKey || $event.metaKey)">
                    <figure class="image is-16x16">
                        <img src="/icons/reload.svg" />
                    </figure>
                    <span v-text="lang('reloadTab')"></span>
                </li>
                <li
                    v-if="menu.includes('discard') && !data.tab.discarded"
                    @click="$emit('discard', data.tab)">
                    <figure class="image is-16x16">
                        <img src="/icons/snowflake.svg" />
                    </figure>
                    <span v-text="lang('discardTabTitle')"></span>
                </li>
                <li
                    v-if="menu.includes('remove') && multipleTabIds.length"
                    @click="$emit('remove', data.tab)">
                    <figure class="image is-16x16">
                        <img src="/icons/close.svg" />
                    </figure>
                    <span v-text="lang('deleteTab')"></span>
                </li>
                <li
                    v-if="menu.includes('update-thumbnail') && showUpdateThumbnail"
                    @click="$emit('update-thumbnail', data.tab)">
                    <figure class="image is-16x16">
                        <img src="/icons/image.svg" />
                    </figure>
                    <span v-text="lang('updateTabThumbnail')"></span>
                </li>
                <li
                    v-if="menu.includes('set-group-icon') && data.group"
                    @click="$emit('set-group-icon', data.tab, data.group)">
                    <figure class="image is-16x16">
                        <img src="/icons/image.svg" />
                    </figure>
                    <span v-text="lang('setTabIconAsGroupIcon')"></span>
                </li>

                <template v-if="menu.includes('move-tab-to-group')">
                    <hr>

                    <li class="is-disabled">
                        <figure class="image is-16x16"></figure>
                        <span class="colon" v-text="lang('moveTabToGroupDisabledTitle')"></span>
                    </li>

                    <li
                        v-for="group in nonArchivedGroups"
                        :key="group.id"
                        @click="$emit('move-tab',       data.tab.id, group.id, !data.group, undefined, $event.ctrlKey || $event.metaKey)"
                        @contextmenu="$emit('move-tab', data.tab.id, group.id, !data.group, true)"
                        >
                        <figure :class="['image is-16x16', {'is-sticky': group.isSticky}]">
                            <img :src="group.iconUrlToDisplay" />
                        </figure>
                        <span v-text="getGroupTitle(group, 'withActiveGroup withContainer')"></span>
                    </li>

                    <li
                        @click="$emit('move-tab-new-group', data.tab.id, !data.group)"
                        @contextmenu="$emit('move-tab-new-group', data.tab.id, !data.group, true)">
                        <figure class="image is-16x16">
                            <img src="/icons/group-new.svg" />
                        </figure>
                        <span v-text="lang('createNewGroup')"></span>
                    </li>
                </template>
            </ul>
        </template>
    </context-menu>
</template>
