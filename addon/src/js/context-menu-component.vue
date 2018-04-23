<template>
    <div
        class="v-context-menu"
        v-show="show"
        :style="style"
        tabindex="-1"
        @blur="close"
        @click="close"
        @contextmenu.capture.prevent
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
    $blue600: #1e88e5;
    $gray74: #bdbdbd;
    $gray93: #ededed;
    $gray98: #fafafa;

    .v-context-menu {
        background: $gray98;
        border: 1px solid $gray74;
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
            padding: 6px 0;
            margin: 0;
            font-size: 12px;
            font-weight: 600;

            li {
                margin: 0;
                padding: 0 10px;
                cursor: pointer;
                white-space: nowrap;
                text-overflow: ellipsis;
                overflow: hidden;
                height: 25px;
                line-height: 25px;

                > img {
                    margin-right: 5px;
                }

                &.is-disabled {
                    color: GrayText;
                }

                &.is-disabled:hover {
                    background: $gray93;
                }

                &:not(.is-disabled):hover {
                    background: $blue600;
                    color: $gray98;
                }
            }
        }
    }
</style>
