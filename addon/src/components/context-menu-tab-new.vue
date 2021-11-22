<script>
import contextMenu from './context-menu.vue';

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
                containers = Object.values(Containers.getAll());

            if (group.ifDifferentContainerReOpen) {
                containers = containers.filter(container => {
                    return group.excludeContainersForReOpen.includes(container.cookieStoreId) ||
                        group.newTabContainer === container.cookieStoreId ||
                        container.cookieStoreId === TEMPORARY_CONTAINER;
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
                    <img :src="container.iconUrl" class="is-inline-block size-16" :style="{fill: container.colorCode}" />
                    <span v-text="container.name"></span>
                </li>
            </ul>
        </template>
    </context-menu>
</template>
