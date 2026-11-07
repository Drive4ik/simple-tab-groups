import {ACTION_WAIT, LOAD_WAIT, POLL_WAIT, SETTLE_TIMEOUT} from './constants.js';
import {wait} from './test.js';

const KEY = 'reloadProbe';
const ARMED = 'armed';
export const PAGE_PATH = '/unload.html'; // the page of the add-on a test of round-41 leaves open across the reload

export const arm = () => localStorage.setItem(KEY, ARMED);

// settles once the probe has dropped its listeners
export let finished = Promise.resolve();

// the record of the one start the probe ran at, null when it never ran; a mark nobody used is dropped too
export function take() {
    const stored = localStorage.getItem(KEY);

    localStorage.removeItem(KEY);

    return stored === null || stored === ARMED ? null : JSON.parse(stored);
}

// armed by a test before a reload of the add-on, and the first thing the background does at its next
// start: the moment of its first line, every message and port that reaches it, runtime.onInstalled,
// and the tabs left on the page of the add-on - at the first line, ACTION_WAIT and LOAD_WAIT later.
// It runs once: the record takes the place of the mark, round-41
if (localStorage.getItem(KEY) === ARMED) {
    const record = {startedAt: Date.now(), events: []};
    const save = () => localStorage.setItem(KEY, JSON.stringify(record));
    const event = (name, detail, instance = null) => {
        record.events.push({at: Date.now(), event: name, detail, instance});
        save();
    };

    const onMessage = message => message?.report ? event('runtime.onMessage', message.event, message.instance) : event('runtime.onMessage', JSON.stringify(message));
    const onConnect = port => event('runtime.onConnect', port.name);
    const onInstalled = details => event('runtime.onInstalled', JSON.stringify(details));

    browser.runtime.onMessage.addListener(onMessage);
    browser.runtime.onConnect.addListener(onConnect);
    browser.runtime.onInstalled.addListener(onInstalled);

    // the tabs on the page of the add-on, by the path of the page: a uuid that changed must not read as "closed"
    const pages = async label => {
        const tabs = await browser.tabs.query({});
        const found = tabs.filter(tab => tab.url.startsWith('moz-extension:') && new URL(tab.url).pathname === PAGE_PATH);
        const states = found.map(tab => `${tab.status}${tab.discarded ? ' discarded' : ''}`);

        event(`tabs.query ${label}`, `${PAGE_PATH}: ${found.length} tab(s)${states.length ? ` (${states.join(', ')})` : ''}`);
    };

    event('extension.getViews at the first line', `${browser.extension.getViews({type: 'tab'}).length} view(s) of type tab`);

    // the first read is called here, in the same turn the module runs in
    finished = (async () => {
        await pages('at the first line');
        await wait(ACTION_WAIT);
        await pages(`${ACTION_WAIT} ms later`);
        await wait(LOAD_WAIT);
        await pages(`${ACTION_WAIT + LOAD_WAIT} ms later`);

        while (Date.now() - record.startedAt < SETTLE_TIMEOUT) {
            await wait(POLL_WAIT);
        }

        browser.runtime.onMessage.removeListener(onMessage);
        browser.runtime.onConnect.removeListener(onConnect);
        browser.runtime.onInstalled.removeListener(onInstalled);
    })();

    save();
}
