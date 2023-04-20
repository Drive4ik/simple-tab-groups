import 'js/wait-background.js';
import backgroundSelf from 'js/background.js';
import Vue from 'vue';
import Manage from './Manage.vue';

backgroundSelf?.inited && new Vue({
    el: '#stg-manage',
    render: h => h(Manage),
});
