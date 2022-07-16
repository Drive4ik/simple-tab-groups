import Vue from 'vue';
import Popup from './Popup.vue';

if (window.BG?.inited) {
    new Vue({
        el: '#stg-popup',
        render: h => h(Popup),
    });
} else {
    browser.runtime.onMessage.addListener(({action}) => 'i-am-back' === action && window.location.reload());
}
