import 'wait-background';
import backgroundSelf from 'background';
import Vue from 'vue';
import Popup from './Popup.vue';

backgroundSelf?.inited && new Vue({
    el: '#stg-popup',
    render: h => h(Popup),
});
