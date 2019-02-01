<template>
    <div
        class="v-context-menu no-outline"
        v-show="show"
        :style="style"
        tabindex="-1"
        @blur="close"
        @click="close"
        @contextmenu.capture.prevent="close"
        >
        <slot :data="data"></slot>
    </div>
</template>

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
                show: false
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
            }
        },
        methods: {
            close() {
                this.top = this.left = this.data = null;
                this.show = false;
            },

            open(event, data = null) {
                this.data = data;
                this.show = true;

                this.$nextTick(function() {
                    this.setMenu(event.clientY, event.clientX);
                    this.$el.focus();
                });
            },

            setMenu(top, left) {
                this.top = Math.min(top, window.innerHeight - this.$el.offsetHeight - this.minMargin);
                this.left = Math.min(left, window.innerWidth - this.$el.offsetWidth - this.minMargin);
            }
        }
    }
</script>

<style lang="scss" scoped>
    .v-context-menu {
        --top-bottom-indent-blocks: 6px;
        --left-right-indent-blocks: 10px;

        background: #f2f2f2;
        border: 1px solid #bdbdbd;
        box-shadow: 0 2px 2px 0 rgba(0, 0, 0, 0.14), 0 3px 1px -2px rgba(0, 0, 0, 0.2), 0 1px 5px 0 rgba(0, 0, 0, 0.12);
        display: block;
        margin: 0;
        padding: 0;
        position: fixed;
        min-width: 150px;
        max-width: calc(100vw - 30px);
        max-height: calc(100vh - 30px);
        overflow-y: auto;
        z-index: 99999;

        ul {
            list-style: none;
            padding: var(--top-bottom-indent-blocks) 0;
            margin: 0;
            font-size: 12px;
            font-weight: normal;

            li {
                display: flex;
                align-items: center;
                margin: 0;
                padding: 0 var(--left-right-indent-blocks) 0 var(--top-bottom-indent-blocks);
                cursor: pointer;
                height: 25px;

                > img {
                    margin-right: var(--left-right-indent-blocks);
                    width: 16px;
                    height: 16px;
                }

                > span {
                    white-space: nowrap;
                    text-overflow: ellipsis;
                    overflow: hidden;
                }

                &.is-disabled {
                    color: GrayText;
                }

                &.is-disabled:hover {
                    background: #e3e3e3;
                }

                &:not(.is-disabled):hover {
                    background: #91c9f7;
                }
            }

            hr {
                margin: var(--top-bottom-indent-blocks) 0 var(--top-bottom-indent-blocks) calc(var(--left-right-indent-blocks) + 16px + var(--top-bottom-indent-blocks));
            }
        }
    }

    .dark-theme {
        .v-context-menu {
            background-color: var(--input-background-color);

            li {
                &.is-disabled:hover {
                    background: #393939;
                }

                &:not(.is-disabled):hover {
                    background: #5d5d5d;
                }
            }
        }
    }
</style>
