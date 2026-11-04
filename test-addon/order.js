// a page that measures the order of the evaluation of ES modules: a module that imports a probe of its own comes
// first, then the module that sets the global, then ten probes; every probe records at its evaluation whether the
// global was there, and the page reports the records by runtime.sendMessage({orderProbes}); round-39
import './order-early.js';
import './order-global.js';
import './order-probe.js?1';
import './order-probe.js?2';
import './order-probe.js?3';
import './order-probe.js?4';
import './order-probe.js?5';
import './order-probe.js?6';
import './order-probe.js?7';
import './order-probe.js?8';
import './order-probe.js?9';
import './order-probe.js?10';

const params = new URL(location.href).searchParams;
const name = params.get('tab') ?? '';

document.title = name;
document.getElementById('name').textContent = name;

await browser.runtime.sendMessage({report: name, orderProbes: self.orderProbes}).catch(() => {});
