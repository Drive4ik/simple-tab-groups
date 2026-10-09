import {POLL_WAIT, SETTLE_TIMEOUT} from './constants.js';
import {wait} from './test.js';
import {extensions, hosts} from './management.js';

const KEY = 'startupProbe';
const ARMED = 'armed';

export const arm = () => localStorage.setItem(KEY, ARMED);

// settles once the probe has made its last read
export let finished = Promise.resolve();

// the record of the one start the probe ran at, null when it never ran
export function take() {
    const stored = localStorage.getItem(KEY);

    localStorage.removeItem(KEY);

    return stored === null || stored === ARMED ? null : JSON.parse(stored);
}

// armed by a test before a browser restart, and the first thing the background does at its next
// start: what management.getAll() tells about every extension at the first line and at which ms a
// later read first tells something else, how many windows there are, and whether
// runtime.onStartup and windows.onCreated come. It runs once: the record takes the place of the mark
if (localStorage.getItem(KEY) === ARMED) {
    const at = performance.now();
    const elapsed = () => Math.round(performance.now() - at);
    const record = {pageAge: Math.round(at), reads: [], polls: 0, watched: 0, windows: null, onStartup: null, windowCreated: null};
    const save = () => localStorage.setItem(KEY, JSON.stringify(record));
    let told = null;

    const read = async () => {
        const ms = elapsed();
        let state;

        try {
            state = (await extensions()).map(extension => ({id: extension.id, enabled: extension.enabled, hosts: hosts(extension)}));
        } catch (error) {
            state = `rejected - ${error.message}`;
        }

        const telling = JSON.stringify(state);

        if (telling !== told) {
            told = telling;
            record.reads.push({ms, state});
        }

        record.polls++;
        record.watched = elapsed();
        save();
    };

    const onStartup = () => {
        record.onStartup = elapsed();
        save();
    };
    const onWindowCreated = () => {
        record.windowCreated ??= elapsed();
        save();
    };

    browser.runtime.onStartup.addListener(onStartup);
    browser.windows.onCreated.addListener(onWindowCreated);

    // the first read is called here, in the same turn the module runs in
    finished = (async () => {
        while (elapsed() < SETTLE_TIMEOUT) {
            await read();
            await wait(POLL_WAIT);
        }

        browser.runtime.onStartup.removeListener(onStartup);
        browser.windows.onCreated.removeListener(onWindowCreated);
    })();

    browser.windows.getAll().then(windows => {
        record.windows = windows.length;
        save();
    });
}
