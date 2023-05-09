<script>
import contextMenu from './context-menu.vue';
import * as Parents from '/js/parents.js';

export default {
    props: {
        menu: {
            type: Array,
            required: true,
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
                    v-if="menu.includes('switch-to-context') && !data.parent.isArchive"
                    @click="$emit('switch-to-context', data.parent)">
                    <img src="/icons/settings.svg" class="size-16" />
                    <span v-text="lang('switchToContext')"></span>
                </li>
            </ul>
        </template>
    </context-menu>
</template>
