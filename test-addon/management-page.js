import {watch, probe} from './management.js';

const name = new URL(location.href).searchParams.get('tab') ?? '';
const send = report => browser.runtime.sendMessage({management: report});

document.title = name;
document.getElementById('name').textContent = name;

watch(name, send);
probe(name).then(send);
