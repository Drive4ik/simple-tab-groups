<script>
import contextMenu from './context-menu.vue';
import * as Parents from '/js/parents.js';

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
        parents: {
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
                    <img src="/icons/window-new.svg" class="size-16" />
                    <span v-text="lang('openGroupInNewWindow')"></span>
                </li>
                <li
                    v-if="menu.includes('sort-asc')"
                    @click="$emit('sort', 'asc')">
                    <img src="/icons/sort-alpha-asc.svg" class="size-16" />
                    <span v-text="lang('sortGroupsAZ')"></span>
                </li>
                <li
                    v-if="menu.includes('sort-desc')"
                    @click="$emit('sort', 'desc')">
                    <img src="/icons/sort-alpha-desc.svg" class="size-16" />
                    <span v-text="lang('sortGroupsZA')"></span>
                </li>
                <li
                    v-if="menu.includes('discard') && !data.group.isArchive"
                    @click="$emit('discard', data.group)">
                    <img src="/icons/snowflake.svg" class="size-16" />
                    <span v-text="lang('hotkeyActionTitleDiscardGroup')"></span>
                </li>
                <li
                    v-if="menu.includes('discard-other') && groups.length > 1"
                    @click="$emit('discard-other', data.group)">
                    <img src="/icons/snowflake.svg" class="size-16" />
                    <span v-text="lang('hotkeyActionTitleDiscardOtherGroups')"></span>
                </li>
                <li
                    v-if="menu.includes('export-to-bookmarks')"
                    @click="$emit('export-to-bookmarks', data.group)">
                    <img src="/icons/bookmark.svg" class="size-16" />
                    <span v-text="lang('exportGroupToBookmarks')"></span>
                </li>
                <li
                    v-if="menu.includes('unload') && isOpened(data.group)"
                    @click="$emit('unload', data.group)">
                    <img src="/icons/upload.svg" class="size-16" />
                    <span v-text="lang('unloadGroup')"></span>
                </li>
                <li
                    v-if="menu.includes('archive') && !data.group.isArchive"
                    @click="$emit('archive', data.group)">
                    <img :src="'/icons/archive.svg'" class="size-16" />
                    <span v-text="lang('archiveGroup')"></span>
                </li>
                <li
                    v-if="menu.includes('archive') && data.group.isArchive"
                    @click="$emit('unarchive', data.group)">
                    <img :src="'/icons/unarchive.svg'" class="size-16" />
                    <span v-text="lang('unArchiveGroup')"></span>
                </li>
                <li
                    v-if="menu.includes('rename') && showRename"
                    @click="$emit('rename', data.group)">
                    <img src="/icons/edit.svg" class="size-16" />
                    <span v-text="lang('hotkeyActionTitleRenameGroup') + ' (F2)'"></span>
                </li>

                <template v-if="menu.includes('reload-all-tabs') && !data.group.isArchive">
                    <hr>

                    <li @click="$emit('reload-all-tabs', data.group, $event.ctrlKey || $event.metaKey)">
                        <img src="/icons/refresh.svg" class="size-16" />
                        <span v-text="lang('reloadAllTabsInGroup')"></span>
                    </li>
                </template>

                <template v-if="menu.includes('move-group-to-parent')">
                    <hr>

                    <li class="is-disabled">
                        <img class="size-16" />
                        <span v-text="lang('moveGroupToParentDisabledTitle') + ':'"></span>
                    </li>

                    <li
                      v-for="parent in parents"
                      v-if="parent.id !== data.group.parentId"
                      :key="parent.id"
                      @click="$emit('move-group',       data.group, parent, $event.ctrlKey || $event.metaKey)"
                      @contextmenu="$emit('move-group', data.group, parent, true)"
                    >
                        <figure :class="['image is-16x16']">
                            <img src="/icons/parent-new.svg" />
                        </figure>
                        <span v-text="parent.title"></span>
                    </li>

<!--                    <li-->
<!--                      @click="$emit('move-group-new-parent', data.tab.id, !data.group)"-->
<!--                      @contextmenu="$emit('move-group-new-parent', data.tab.id, !data.group, true)">-->
<!--                        <img src="/icons/new.svg" class="size-16" />-->
<!--                        <span v-text="lang('createNewParent')"></span>-->
<!--                    </li>-->
                </template>

                <template v-if="showSettings || showRemove">
                    <hr>

                    <li
                        v-if="showSettings"
                        @click="$emit('settings', data.group)">
                        <img src="/icons/settings.svg" class="size-16" />
                        <span v-text="lang('groupSettings')"></span>
                    </li>
                    <li
                        v-if="showRemove"
                        @click="$emit('remove', data.group)">
                        <img src="/icons/group-delete.svg" class="size-16" />
                        <span v-text="lang('deleteGroup')"></span>
                    </li>
                </template>

            </ul>
        </template>
    </context-menu>
</template>
