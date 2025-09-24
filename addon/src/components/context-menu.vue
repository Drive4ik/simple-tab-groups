<script>
export default {
    props: {
        minMargin: {
            type: Number,
            default: 25,
        },
    },
    data() {
        return {
            top: null,
            left: null,
            data: null,
            show: false,
        };
    },
    computed: {
        style() {
            if (!this.show) {
                return {};
            }

            return {
                top: this.top + 'px',
                left: this.left + 'px',
            };
        },
    },
    methods: {
        close() {
            this.top = this.left = this.data = null;
            this.show = false;
            document.querySelectorAll('.is-context-active')
                .forEach(node => node.classList.remove('is-context-active'));
        },

        open(event, data = null) {
            this.data = data;
            this.show = true;

            this.$nextTick(function() {
                this.setMenu(event.clientY, event.clientX);
                this.$el.focus();

                [...this.$el.firstElementChild.children]
                    .filter(node => 'LI' === node.nodeName && !node.classList.contains('is-disabled'))
                    .forEach(function(node) {
                        node.tabIndex = 0;
                        node.addEventListener('keydown', function(event) {
                            if (event.key === 'Enter') {
                                event.stopPropagation();
                                event.stopImmediatePropagation();
                                node.click();
                            }
                        });
                        node.addEventListener('blur', this.onblur.bind(this));
                    }, this);
            });
        },

        setMenu(top, left) {
            this.top = Math.min(top, window.innerHeight - this.$el.offsetHeight - this.minMargin);
            this.left = Math.min(left, window.innerWidth - this.$el.offsetWidth - this.minMargin);
        },

        onblur(event) {
            if (!this.$el.contains(event.relatedTarget)) {
                this.close();
            }
        },
    }
}
</script>

<template>
<div
    class="v-context-menu no-outline"
    v-show="show"
    :style="style"
    tabindex="-1"
    @blur="onblur"
    @click="close"
    @keydown.esc.stop="close"
    @contextmenu.prevent="close"
    >
    <slot :data="data"></slot>
</div>
</template>

<style>
.v-context-menu {
    --scroll-indent: 20px;

    background: var(--bulma-scheme-main-bis);
    border: 1px solid var(--bulma-border);
    box-shadow: 0 2px 2px 0 rgba(0, 0, 0, 0.14), 0 3px 1px -2px rgba(0, 0, 0, 0.2), 0 1px 5px 0 rgba(0, 0, 0, 0.12);
    display: block;
    margin: 0;
    padding: 0;
    position: fixed;
    min-width: 150px;
    max-width: calc(100vw - 30px);
    max-height: calc(100vh - 30px);
    overflow-y: auto;
    overflow-x: hidden;
    z-index: 99999;
    scrollbar-width: thin;

    ul {
        list-style: none;
        padding: var(--gap-indent-mini) 0;
        font-size: 12px;
        font-weight: normal;

        li {
            display: flex;
            align-items: center;
            gap: var(--gap-indent);
            margin: 0;
            padding: 0 var(--bulma-block-spacing);
            cursor: pointer;
            height: 2.2em;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;

            &:not(.is-disabled):hover,
            &:not(.is-disabled):focus {
                background: var(--bulma-scheme-main-ter);
            }

            &.is-disabled {
                color: var(--bulma-text-05-invert);
                cursor: default;
            }
        }

        hr {
            margin-block: var(--gap-indent-mini);
        }
    }
}
</style>
