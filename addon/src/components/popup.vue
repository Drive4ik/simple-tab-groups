<script>
    import JSON from '/js/json.js';

    export default {
        name: 'popup-dialog',
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
                buttonsClone: JSON.clone(this.buttons),
            };
        },
        methods: {
            lang: browser.i18n.getMessage,
        },
        mounted() {
            this.$nextTick(() => {
                if (this.buttons.length) {
                    let focusedButtonIndex = this.buttons.findIndex(button => button.hasOwnProperty('focused'));

                    if (focusedButtonIndex === -1) {
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
    <div class="modal popup is-active" @keydown.stop.esc="$emit('close-popup')" @keyup.stop>
        <div class="modal-background" @click="$emit('close-popup')"></div>
        <div class="modal-card">
            <header class="modal-card-head gap-indent">
                <p class="modal-card-title is-flex-shrink-1 is-size-5" v-text="title"></p>
                <button class="delete" aria-label="close" @click="$emit('close-popup')"></button>
            </header>
            <section class="modal-card-body">
                <slot></slot>
            </section>
            <footer v-if="buttonsClone.length" class="modal-card-foot is-justify-content-end gap-indent">
                <button
                    v-for="button in buttonsClone"
                    :key="button.lang"
                    :disabled="button.disabled"
                    @click="button.event && $emit(button.event)"
                    class="button is-soft"
                    :class="button.classList"
                    v-text="lang(button.lang)"></button>
            </footer>
        </div>
    </div>
</template>

<style>
    .modal {
        --bulma-modal-card-head-padding: var(--bulma-block-spacing);
        --bulma-modal-card-body-padding: var(--bulma-block-spacing);
        --bulma-modal-content-width: 50rem;

        .modal-card-body {
            white-space: pre-line;
        }
    }
</style>
