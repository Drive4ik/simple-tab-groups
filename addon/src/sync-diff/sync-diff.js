import '/js/wait-background.js';
import Vue from 'vue';
import SyncDiff from './SyncDiff.vue';

new Vue({
    el: '#stg-sync-diff',
    render: h => h(SyncDiff),
});
