import 'wait-background';
import backgroundSelf from 'background';
import Vue from 'vue';
import Options from './Options.vue';

backgroundSelf?.inited && new Vue({
    el: '#stg-options',
    render: h => h(Options),
});
