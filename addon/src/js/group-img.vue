<template>
    <img :src="url" class="is-inline-block size-16" alt="" />
</template>

<script>
    import {getGroupIconUrl} from '../js/utils';

    export default {
        props: {
            group: {
                required: true,
                type: Object,
            },
        },
        data() {
            return {
                url: '',
            };
        },
        watch: {
            group: {
                handler: 'loadGroupIconUrl',
                deep: true,
                immediate: true,
            },
        },
        methods: {
            async loadGroupIconUrl() {
                this.url = await getGroupIconUrl(this.group);
            },
        },
    }
</script>
