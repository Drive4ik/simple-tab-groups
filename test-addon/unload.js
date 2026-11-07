// a page that records what it can still do at its own pagehide and unload: the object
// runtime.getBackgroundPage() gave it at its load (the check Utils.isDeadObject of STG makes on it),
// runtime.id, runtime.sendMessage, port.postMessage into the port it opened at its load, a rejected
// promise against the unhandledrejection event. Every record goes into localStorage with the id of
// this load of the page, read back by the test after the add-on has reloaded; what the page reports
// by runtime.sendMessage is the second channel, round-41
import {RELOAD_LOG_KEYS} from './constants.js';

const params = new URL(location.href).searchParams;
const name = params.get('tab') ?? '';
const instance = crypto.randomUUID().slice(0, 8); // this load of the page: a page the reload loaded anew must not pass for the old one

document.title = name;
document.getElementById('name').textContent = name;

// appended, never replaced: another load of the page keeps the records of this one
function record(event, detail = '') {
    const records = JSON.parse(localStorage.getItem(RELOAD_LOG_KEYS.page) ?? '[]');

    records.push({at: Date.now(), who: 'page', instance, event, detail});
    localStorage.setItem(RELOAD_LOG_KEYS.page, JSON.stringify(records));
}

// what a call gives, or the error it throws
const outcome = run => {
    try {
        const result = run();

        return result === undefined ? 'ok' : `gives ${JSON.stringify(result)}`;
    } catch (error) {
        return `throws ${error.name}: ${error.message}`;
    }
};

const describe = value => value === null ? 'null' : typeof value === 'object' ? 'window' : typeof value;
const report = event => browser.runtime.sendMessage({report: name, instance, event});

let backgroundPage = null; // what runtime.getBackgroundPage() resolved with, as backgroundSelf of js/background.js
const port = browser.runtime.connect({name: `reload: ${name}`});

port.onDisconnect.addListener(() => record('port.onDisconnect', `port.error: ${port.error?.message ?? 'null'}`));

window.addEventListener('unhandledrejection', event => {
    event.preventDefault(); // the rejections are the controls of the page itself: the console must not show them as errors
    record('unhandledrejection', event.reason?.message ?? String(event.reason));
});
window.addEventListener('error', event => record('error', event.message));

record('loaded');
Promise.reject(new Error('rejected at load')); // the control: unhandledrejection must come for it

browser.runtime.getBackgroundPage().then(page => {
    backgroundPage = page;
    record('getBackgroundPage', describe(page));
    report('ready').catch(error => record('ready rejected', error.message));
}, error => record('getBackgroundPage rejected', error.message));

// what the page can still do while it goes; a sendMessage promise that settles writes a line of its own
for (const type of ['pagehide', 'unload']) {
    window.addEventListener(type, () => {
        record(type, [
            `backgroundPage: ${outcome(() => Object.prototype.toString.call(backgroundPage))}`,
            `runtime.id: ${outcome(() => browser.runtime.id)}`,
            `runtime.sendMessage: ${outcome(() => {
                report(`${type}: sendMessage`).then(
                    () => record(`${type}: sendMessage resolved`),
                    error => record(`${type}: sendMessage rejected`, error.message),
                );

                return 'returned a promise';
            })}`,
            `port.postMessage: ${outcome(() => port.postMessage({report: name, instance, event: `${type}: postMessage`}))}`,
            `Promise.reject: ${outcome(() => {
                Promise.reject(new Error(`rejected at ${type}`));

                return 'made';
            })}`,
        ].join('; '));
    });
}
