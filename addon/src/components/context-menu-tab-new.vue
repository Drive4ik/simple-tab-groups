<script>
import contextMenu from './context-menu.vue';
import * as Constants from '/js/constants.js';
import * as Containers from '/js/containers.js';

export default {
    components: {
        'context-menu': contextMenu,
    },
    data() {
        return {
            containers: [],
        };
    },
    methods: {
        open(...args) {
            let [, {group}] = args,
                containers = Object.values(Containers.query({temporaryContainer: true}));

            if (group.ifDifferentContainerReOpen) {
                containers = containers.filter(container => {
                    return group.excludeContainersForReOpen.includes(container.cookieStoreId) ||
                        group.newTabContainer === container.cookieStoreId ||
                        container.cookieStoreId === Constants.TEMPORARY_CONTAINER;
                });
            }

            this.containers = Object.freeze(containers);

            this.$refs.contextMenu.open(...args);
        },
    },
};

</script>

<template>
<context-menu ref="contextMenu">
    <template v-slot="{data}">
        <ul v-if="data" class="is-unselectable">
            <li
                v-for="container in containers" :key="container.cookieStoreId"
                @click="$emit('add', data.group, container.cookieStoreId)"
                >
                <figure :class="`image is-16x16 userContext-icon identity-icon-${container.icon} identity-color-${container.color}`"></figure>
                <span v-text="container.name"></span>
            </li>
        </ul>
    </template>
</context-menu>
</template>
