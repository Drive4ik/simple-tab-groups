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
        },
        data() {
            return {
                buttonsClone: utils.clone(this.buttons),
            };
        },
        methods: {
            lang: browser.i18n.getMessage,
            focusTo(vector) {
                let buttons = this.$refs.modal.querySelectorAll('button');

                if (vector === 'first') {
                    buttons[0].focus();
                } else {
                    buttons[buttons.length - 1].focus();
                }
            },
        },
        mounted() {
            this.$nextTick(function() {
                if (this.buttons.length) {
                    let focusedButtonIndex = this.buttons.findIndex(button => button.hasOwnProperty('focused'));

                    if (-1 === focusedButtonIndex) {
                        focusedButtonIndex = 1;
                    } else if (this.buttons[focusedButtonIndex].focused) {
                        focusedButtonIndex++;
                    } else {
                        focusedButtonIndex = 0;
                    }

                    if (focusedButtonIndex) {
                        this.$el.querySelector(`footer button:nth-child(${focusedButtonIndex})`).focus();
                    }
                }

                this.$emit('show-popup');
            });
        },
    }
</script>

<template>
    <div class="modal popup is-active" ref="modal" @keyup.stop @keydown.stop @keydown.esc="$emit('close-popup')" tabindex="0" @focus="focusTo()">
        <div class="modal-card">
            <header class="modal-card-head">
                <p class="modal-card-title" v-text="title"></p>
                <button class="delete" aria-label="close" @click="$emit('close-popup')"></button>
            </header>
            <section class="modal-card-body">
                <slot></slot>
            </section>
            <footer v-if="buttonsClone.length" class="modal-card-foot">
                <button v-for="button in buttonsClone" :key="button.lang" @click="button.event && $emit(button.event)" :class="['button', button.classList]" v-text="lang(button.lang)"></button>
            </footer>
        </div>
        <div class="modal-background" @click="$emit('close-popup')" tabindex="0" @focus="focusTo('first')"></div>
    </div>
</template>

<style lang="scss">
    .modal-card {
        z-index: 9999;
    }

    .modal-card-title {
        font-size: 1.2rem;
        color: inherit;
        max-width: 97%;
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
        scrollbar-width: thin;
    }

    .modal-card-head {
        border-bottom-color: var(--color-hr);
    }

    .modal-card-foot {
        border-top-color: var(--color-hr);
        justify-content: flex-end;
    }
</style>
