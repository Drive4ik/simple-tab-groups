import '/js/wait-background.js';
import Vue from 'vue';
import OfflineRemove from './OfflineRemove.vue';

new Vue({
    el: '#stg-offline-remove',
    render: h => h(OfflineRemove),
});
