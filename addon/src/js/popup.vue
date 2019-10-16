<script>
    'use strict';

    export default {
        props: {
            title: {
                type: String,
                default: '',
            },
            buttons: {
                type: Array,
                default: () => [],
            },
            autofocusOnButton: {
                type: Boolean,
                default: true,
            },
        },
        methods: {
            lang: browser.i18n.getMessage,
        },
        mounted() {
            this.$nextTick(function() {
                this.$emit('show-popup');

                if (this.autofocusOnButton) {
                    let button = this.$el.querySelector('footer button');
                    button && button.focus();
                }

            });
        },
    }
</script>

<template>
    <div class="modal popup is-active" @keydown.esc.stop="$emit('close-popup')">
        <div class="modal-background" @click="$emit('close-popup')" @keydown.enter="$emit('close-popup')" tabindex="0"></div>
        <div class="modal-card">
            <header class="modal-card-head">
                <p class="modal-card-title" v-text="title"></p>
                <button class="delete" aria-label="close" @click="$emit('close-popup')"></button>
            </header>
            <section class="modal-card-body">
                <slot></slot>
            </section>
            <footer v-if="buttons.length" class="modal-card-foot">
                <button v-for="button in buttons" :key="button.lang" @click="$emit(button.event)" :class="['button', button.classList]" v-text="lang(button.lang)"></button>
            </footer>
        </div>
    </div>
</template>

<style lang="scss">
    .modal-card-title {
        font-size: 1.2rem;
        color: inherit;
    }

    @media screen and (max-width: 769px) {
        .modal-card,
        .modal-content {
            width: calc(100% - var(--indent) * 2);
        }
    }

    .modal-card-head,
    .modal-card-body,
    .modal-card-foot {
        padding: var(--indent);
    }

    .modal-background {
        background-color: rgba(10, 10, 10, 0.6);
    }

    .modal-card-foot,
    .modal-card-head {
        background-color: var(--background-color-other);
    }

    .modal-card-body {
        background-color: var(--background-color);
    }

    .modal-card-head {
        border-bottom-color: var(--color-hr);
    }

    .modal-card-foot {
        border-top-color: var(--color-hr);
        justify-content: flex-end;
    }
</style>
