import 'wait-background';
import backgroundSelf from 'background';
import Vue from 'vue';
import Manage from './Manage.vue';

backgroundSelf?.inited && new Vue({
    el: '#stg-manage',
    render: h => h(Manage),
});
