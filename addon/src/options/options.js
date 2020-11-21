import Vue from 'vue';
import Options from './Options.vue';

browser.runtime.onMessage.addListener(({action}) => 'i-am-back' === action && window.location.reload());

new Vue({
    el: '#stg-options',
    render: h => h(Options),
});
