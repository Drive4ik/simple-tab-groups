<script>
    'use strict';

    export default {
        props: {
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
        <div class="item" @click="$emit('close-popup')">
            <span class="item-icon">
                <img class="size-16" src="/icons/arrow-left.svg" />
            </span>
            <span class="item-title" v-text="lang('goBackButtonTitle')"></span>
        </div>

        <hr>

        <div class="body is-full-width">
            <h3 class="has-text-centered" v-text="lang('groupSettings')"></h3>
            <slot></slot>
        </div>

        <div class="field is-grouped is-grouped-right action-buttons">
            <div class="control" v-for="button in buttons">
                <button @click="$emit(button.event)" :class="['button', button.classList]" v-text="lang(button.lang)"></button>
            </div>
        </div>
    </div>
</template>

<style lang="scss">
    #editGroupPopup {
        position: fixed;
        padding: var(--indent) 0;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background-color: #ffffff;
        z-index: 5;

        h3 {
            font-size: 1.2rem;
            font-weight: bold;
        }

        .body {
            padding: 0 var(--indent);
            max-height: 500px;
            overflow-y: auto;
        }

        .action-buttons {
            margin: var(--indent);
        }
    }

</style>
