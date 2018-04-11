<script>
    'use strict';

    import groupImg from '../js/group-img.vue';

    const BG = (function(bgWin) {
        return bgWin && bgWin.background && bgWin.background.inited ? bgWin.background : false;
    })(browser.extension.getBackgroundPage());

    export default {
        props: {
            group: {
                required: true,
                type: Object,
            },
            isActive: {
                type: Boolean,
                default: false,
            },
        },
        components: {
            'group-img': groupImg,
        },
        methods: {
            lang: browser.i18n.getMessage,
        },
    }
</script>

<template>
    <div class="group">
        <div :class="['item', {'is-active': isActive}]" @click="$emit('load-group')">
            <div class="item-icon" :title="group.title">
                <group-img :group="group"></group-img>
            </div>
            <div class="item-title" :title="group.title" v-text="group.title"></div>
            <div class="item-action hover is-unselectable" @click.stop="$emit('show-group')">
                <img class="size-16 rotate-180 no-events" src="/icons/arrow-left.svg" alt="" />
                <span class="tabs-text" v-text="lang('groupTabsCount', group.tabs.length)"></span>
            </div>
        </div>

        <slot name="tabs"></slot>
    </div>
</template>

<style lang="scss">
    .group .tabs-text {
        white-space: nowrap;
        overflow: hidden;
        display: inline-block;
        text-overflow: ellipsis;
    }
</style>
