import '/js/wait-background.js';
import Vue from 'vue';
import Popup from './Popup.vue';

new Vue({
    el: '#stg-popup',
    render: h => h(Popup),
});
