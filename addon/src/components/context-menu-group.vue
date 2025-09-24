<script>
import contextMenu from './context-menu.vue';

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
        openedWindows: {
            type: Array,
            required: true,
        },
        showRename: {
            type: Boolean,
            default: true,
        },
        showSettings: {
            type: Boolean,
            default: true,
        },
        showRemove: {
            type: Boolean,
            default: true,
        },
    },
    components: {
        'context-menu': contextMenu,
    },
    methods: {
        lang: browser.i18n.getMessage,
        open(...args) {
            this.$refs.contextMenu.open(...args);
        },
        isOpened({id}) {
            return this.openedWindows.some(win => win.groupId === id);
        },
    },
};

</script>

<template>
<context-menu ref="contextMenu">
    <template v-slot="{data}">
        <ul v-if="data" class="is-unselectable">
            <li
                v-if="menu.includes('open-in-new-window') && !data.group.isArchive"
                @click="$emit('open-in-new-window', data.group)">
                <figure class="image is-16x16">
                    <img src="/icons/window-new.svg" />
                </figure>
                <span v-text="lang('openGroupInNewWindow')"></span>
            </li>
            <li
                v-if="menu.includes('sort-asc')"
                @click="$emit('sort', 'asc')">
                <figure class="image is-16x16">
                    <img src="/icons/sort-alpha-asc.svg" />
                </figure>
                <span v-text="lang('sortGroupsAZ')"></span>
            </li>
            <li
                v-if="menu.includes('sort-desc')"
                @click="$emit('sort', 'desc')">
                <figure class="image is-16x16">
                    <img src="/icons/sort-alpha-desc.svg" />
                </figure>
                <span v-text="lang('sortGroupsZA')"></span>
            </li>
            <li
                v-if="menu.includes('discard') && !data.group.isArchive"
                @click="$emit('discard', data.group)">
                <figure class="image is-16x16">
                    <img src="/icons/snowflake.svg" />
                </figure>
                <span v-text="lang('hotkeyActionTitleDiscardGroup')"></span>
            </li>
            <li
                v-if="menu.includes('discard-other') && groups.length > 1"
                @click="$emit('discard-other', data.group)">
                <figure class="image is-16x16">
                    <img src="/icons/snowflake.svg" />
                </figure>
                <span v-text="lang('hotkeyActionTitleDiscardOtherGroups')"></span>
            </li>
            <li
                v-if="menu.includes('export-to-bookmarks') && data.group.exportToBookmarks"
                @click="$emit('export-to-bookmarks', data.group)">
                <figure class="image is-16x16">
                    <img src="/icons/bookmark.svg" />
                </figure>
                <span v-text="lang('exportGroupToBookmarks')"></span>
            </li>
            <li
                v-if="menu.includes('unload') && isOpened(data.group)"
                @click="$emit('unload', data.group)">
                <figure class="image is-16x16">
                    <img src="/icons/upload.svg" />
                </figure>
                <span v-text="lang('unloadGroup')"></span>
            </li>
            <li
                v-if="menu.includes('archive') && !data.group.isArchive"
                @click="$emit('archive', data.group)">
                <figure class="image is-16x16">
                    <img src="/icons/archive.svg" />
                </figure>
                <span v-text="lang('archiveGroup')"></span>
            </li>
            <li
                v-if="menu.includes('archive') && data.group.isArchive"
                @click="$emit('unarchive', data.group)">
                <figure class="image is-16x16">
                    <img src="/icons/unarchive.svg" />
                </figure>
                <span v-text="lang('unArchiveGroup')"></span>
            </li>
            <li
                v-if="menu.includes('rename') && showRename"
                @click="$emit('rename', data.group)">
                <figure class="image is-16x16">
                    <img src="/icons/edit.svg" />
                </figure>
                <span v-text="lang('hotkeyActionTitleRenameGroup') + ' (F2)'"></span>
            </li>

            <template v-if="menu.includes('reload-all-tabs') && !data.group.isArchive">
                <hr>

                <li @click="$emit('reload-all-tabs', data.group, $event.ctrlKey || $event.metaKey)">
                    <figure class="image is-16x16">
                        <img src="/icons/reload.svg" />
                    </figure>
                    <span v-text="lang('reloadAllTabsInGroup')"></span>
                </li>
            </template>

            <template v-if="showSettings || showRemove">
                <hr>

                <li
                    v-if="showSettings"
                    @click="$emit('settings', data.group)">
                    <figure class="image is-16x16">
                        <img src="/icons/settings.svg" />
                    </figure>
                    <span v-text="lang('groupSettings')"></span>
                </li>
                <li
                    v-if="showRemove"
                    @click="$emit('remove', data.group)">
                    <figure class="image is-16x16">
                        <img src="/icons/group-delete.svg" />
                    </figure>
                    <span v-text="lang('deleteGroup')"></span>
                </li>
            </template>

        </ul>
    </template>
</context-menu>
</template>
