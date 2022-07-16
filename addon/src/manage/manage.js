import Vue from 'vue';
import Manage from './Manage.vue';

if (window.BG?.inited) {
    new Vue({
        el: '#stg-manage',
        render: h => h(Manage),
    });
} else {
    browser.runtime.onMessage.addListener(({action}) => 'i-am-back' === action && window.location.reload());
}
