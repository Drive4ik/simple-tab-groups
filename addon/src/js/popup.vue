<script>
    'use strict';

    export default {
        props: {
            title: {
                type: String,
                default: '',
            },
            buttons: {
                required: true,
                type: Array,
            },
        },
        methods: {
            lang: browser.i18n.getMessage,
        }
    }
</script>

<template>
    <div class="modal popup is-active">
        <div class="modal-background" @click="$emit('close-popup')"></div>
        <div class="modal-card">
            <header class="modal-card-head">
                <p class="modal-card-title" v-text="title"></p>
                <button class="delete" aria-label="close" @click="$emit('close-popup')"></button>
            </header>
            <section class="modal-card-body">
                <slot></slot>
            </section>
            <footer class="modal-card-foot">
                <button v-for="button in buttons" @click="$emit(button.event)" :class="['button', button.classList]" v-text="lang(button.lang)"></button>
            </footer>
        </div>
    </div>
</template>

<style lang="scss">
    .modal-card-title {
        font-size: 1.2rem;
    }

    .modal-card-head,
    .modal-card-body,
    .modal-card-foot {
        padding: var(--indent);
    }

    .modal-card-foot {
        justify-content: flex-end;
    }

    .modal-background {
        background-color: rgba(10, 10, 10, 0.6);
    }
</style>
