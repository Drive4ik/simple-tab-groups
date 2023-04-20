import 'js/wait-background.js';
import backgroundSelf from 'js/background.js';
import Vue from 'vue';
import Popup from './Popup.vue';

backgroundSelf?.inited && new Vue({
    el: '#stg-popup',
    render: h => h(Popup),
});
