import {LOGS_KEY} from './constants.js';

const box = document.getElementById('report');

box.value = localStorage.getItem(LOGS_KEY) ?? 'no report yet — run T.start() first';
box.focus();
box.select();
