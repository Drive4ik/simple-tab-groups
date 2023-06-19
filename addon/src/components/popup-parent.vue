<script>
import JSON from '/js/json.js';

export default {
    name: 'popup-dialog-parent',
    props: {
        title: {
            type: String,
            default: '',
        },
        groups: {
            type: Array,
            default: [],
        },
        buttons: {
            type: Array,
            default: () => [],
        },
    },
    data() {
        return {
            buttonsClone: JSON.clone(this.buttons),
            selectedGroups: [],
        };
    },
    methods: {
        lang: browser.i18n.getMessage,
        selectGroup(group) {
            if (this.selectedGroups.includes(group)) {
                this.selectedGroups.splice(this.selectedGroups.indexOf(group), 1);
            } else {
                this.selectedGroups.push(group);
            }
        },
    },
    mounted() {
        this.$nextTick(function () {
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

            this.$emit('show-popup-parent');
        });
    },
}
</script>

<template>
    <div class="modal popup is-active" @keydown.stop.esc="$emit('close-popup-parent')" @keyup.stop>
        <div class="modal-background" @click="$emit('close-popup-parent')"></div>
        <div class="modal-card">
            <header class="modal-card-head">
                <p class="modal-card-title" v-text="title"></p>
                <button class="delete" aria-label="close" @click="$emit('close-popup-parent')"></button>
            </header>
            <section class="modal-card-body">
                <slot></slot>
                <hr/>
                <div>Choose tag groups to be added</div>
                <div class="groups">
                    <div
                            v-for="group in groups"
                            @click="selectGroup(group)"
                            class="item"
                    >
                        <img class="check size-14" src="/icons/check.svg" v-if="selectedGroups.includes(group)">
                        <span class="ml-5"><img :src="group.iconUrlToDisplay"
                                                class="size-14 mr-5"/>{{group.title}} ({{group.tabs.length}} tabs)</span>
                    </div>
                </div>
            </section>
            <footer v-if="buttonsClone.length" class="modal-card-foot">
                <button
                        v-for="button in buttonsClone"
                        :key="button.lang"
                        :disabled="button.disabled"
                        @click="button.event && $emit(button.event, selectedGroups)"
                        :class="['button', button.classList]"
                        v-text="lang(button.lang)"></button>
            </footer>
        </div>
    </div>
</template>

<style lang="scss">
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

.groups {
  padding: var(--indent);
}

.item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  position: relative;
  cursor: pointer;
}

.check {
  position: absolute;
  left: 0;
}
</style>
