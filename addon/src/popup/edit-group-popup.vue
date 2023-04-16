<script>
    'use strict';

    export default {
        props: {
            title: {
                type: String,
                default: 'groupSettings',
            },
            buttons: {
                required: true,
                type: Array,
            },
        },
        methods: {
            lang: browser.i18n.getMessage,
        },
    }
</script>

<template>
    <div id="editGroupPopup">
        <div class="popup-back-toolbar">
            <div tabindex="0" class="back-button" @click="$emit('close-popup')" @keydown.enter="$emit('close-popup')" :title="lang('goBackButtonTitle')">
                <img class="size-16" src="/icons/arrow-left.svg" />
            </div>
            <div class="text" v-text="lang(title)"></div>
        </div>

        <hr>

        <div class="body is-full-width" tabindex="-1">
            <slot></slot>
        </div>

        <div class="field is-grouped is-grouped-right action-buttons">
            <div class="control" v-for="button in buttons" :key="button.lang">
                <button @click="$emit(button.event)" :class="['button', button.classList]" v-text="lang(button.lang)"></button>
            </div>
        </div>
    </div>
</template>

<style lang="scss">
    #editGroupPopup {
        display: flex;
        flex-direction: column;
        position: fixed;
        padding-top: 4px;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background-color: var(--background-color);
        z-index: 5;

        > hr {
            margin-top: 4px;
        }

        .body {
            flex-grow: 1;
            padding: 0 var(--indent);
            overflow-y: auto;
            scrollbar-width: thin;
        }

        .action-buttons {
            padding: var(--indent);
        }

        .popup-back-toolbar {
            display: flex;
            align-items: center;
            padding: 0 4px;

            > .back-button {
                width: 32px;
                height: 32px;
                padding: 8px;
                display: flex;

                &:hover {
                    background-color: var(--item-background-color-hover);
                }

                &:active {
                    background-color: var(--item-background-color-active-hover);
                }

            }

            > .text {
                text-align: center;
                font-weight: 700;
                flex-grow: 1;
                padding-right: 32px;
            }
        }
    }

</style>
