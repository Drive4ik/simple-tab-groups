<script>
    'use strict';

    import {isDefaultCookieStoreId} from '../js/utils';

    const BG = (function(bgWin) {
        return bgWin && bgWin.background && bgWin.background.inited ? bgWin.background : false;
    })(browser.extension.getBackgroundPage());

    export default {
        props: {
            tab: {
                required: true,
                type: Object,
            },
            containers: {
                required: true,
                type: Array,
            },
            showActive: {
                type: Boolean,
                default: false,
            },
            showUrlTooltipOnTabHover: {
                type: Boolean,
                default: false,
            },
            useFavIconsFromGoogleConverter: {
                type: Boolean,
                default: false,
            },
        },
        data() {
            return {
                favIconUrl: '',
                isDefaultCookieStoreId: true,
                textStyle: {},
            };
        },
        async created() {
            console.log('created', this.tab.title);
            this.favIconUrl = BG.getTabFavIconUrl(this.tab, this.useTabsFavIconsFromGoogleS2Converter);

            this.isDefaultCookieStoreId = isDefaultCookieStoreId(this.tab.cookieStoreId);

            if (!this.isDefaultCookieStoreId) {
                let container = await utils.getContainer(this.tab.cookieStoreId, this.containers);
                this.textStyle.borderBottom = '2px solid ' + container.colorCode;
            }
        },
        mounted() {
            console.log('mounted()', this.tab.title);
        },
        methods: {
            lang: browser.i18n.getMessage,
        },
    }
</script>

<template>
    <div @contextmenu.prevent="$emit('contextmenu', $event)"
        @click="$emit('click')"
        @mousedown.middle.prevent
        @mouseup.middle.prevent="$emit('remove-tab')"
        :class="['item is-unselectable', {'is-active': showActive && tab.active}]"
        :title="showUrlTooltipOnTabHover && (tab.title + '\n' + tab.url)"
        >
        <div class="item-icon">
            <img :src="favIconUrl" class="size-16 no-events" alt="" />
        </div>
        <div class="item-title">
            <span :class="{bordered: !isDefaultCookieStoreId}" :style="textStyle">
                <img v-if="!tab.id" src="/icons/refresh.svg" class="size-16" :title="lang('thisTabWillCreateAsNew')" />
                <span v-text="tab.title"></span>
            </span>
        </div>
        <div class="item-action flex-on-hover">
            <span class="icon cursor-pointer" @click.stop="$emit('remove-tab')" :title="lang('deleteTab')">
                <img class="size-16 no-events" src="/icons/close.svg" alt="" />
            </span>
        </div>
    </div>
</template>

<style lang="scss">
    .bordered {
        display: inline-block;
        border-bottom-right-radius: 5px;
        border-bottom-left-radius: 5px;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        vertical-align: middle;
    }
</style>
