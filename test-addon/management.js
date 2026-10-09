import {MANAGEMENT_READ_WAIT, LOAD_WAIT} from './constants.js';
import {wait} from './test.js';

const EXTENSION_PROTOCOL = 'moz-extension:';
const EVENTS = ['onEnabled', 'onDisabled', 'onInstalled', 'onUninstalled'];

export const READ_MOMENTS = ['at the event', `${MANAGEMENT_READ_WAIT} ms later`, `${LOAD_WAIT} ms after that`];

export const ownOrigin = extension => extension.hostPermissions?.find(pattern => pattern.startsWith(EXTENSION_PROTOCOL));

export function hosts(extension) {
    if (extension.hostPermissions === undefined) {
        return 'absent';
    }

    return ownOrigin(extension) ? 'lists its own origin' : 'present, no own origin';
}

export async function extensions() {
    const all = await browser.management.getAll();

    return all.filter(extension => extension.type === 'extension');
}

async function read(id) {
    try {
        const extension = (await extensions()).find(candidate => candidate.id === id);

        return extension ? `enabled:${extension.enabled} hostPermissions: ${hosts(extension)}` : 'not in the list';
    } catch (error) {
        return `getAll rejected - ${error.message}`;
    }
}

// a wait that takes no timer: how long a timer of the context really takes is a measurement of its own (report.timer)
function waitUntil(moment) {
    const {port1, port2} = new MessageChannel();
    const {promise, resolve} = Promise.withResolvers();

    port1.onmessage = () => {
        if (performance.now() < moment) {
            port2.postMessage(null);
        } else {
            port1.close();
            resolve();
        }
    };

    port2.postMessage(null);

    return promise;
}

// what the context can reach at all: the two calls a page has to make before it may trust a management event
export async function probe(context) {
    const report = {context, probe: true};

    try {
        report.getAll = `resolved, ${(await extensions()).length} extension(s)`;
    } catch (error) {
        report.getAll = `rejected - ${error.message}`;
    }

    try {
        await browser.storage.session.get('probe');
        report.sessionStorage = 'resolved';
    } catch (error) {
        report.sessionStorage = `rejected - ${error.message}`;
    }

    return report;
}

// every management event this context gets, with what management.getAll() of the same context
// reports for that add-on at the three READ_MOMENTS, each read with the ms from the event it
// really started at, and with the ms a setTimeout of MANAGEMENT_READ_WAIT took in this context;
// the report is sent once the last read is in
export function watch(context, send) {
    return EVENTS.map(event => {
        const target = browser.management[event];

        const handler = async info => {
            const at = performance.now();
            const elapsed = () => Math.round(performance.now() - at);
            const timer = wait(MANAGEMENT_READ_WAIT).then(elapsed);
            const report = {context, event, id: info.id, type: info.type, reads: []};

            const readNow = async () => {
                const ms = elapsed();

                report.reads.push({ms, state: await read(info.id)});
            };

            await readNow();
            await waitUntil(at + MANAGEMENT_READ_WAIT);
            await readNow();
            await wait(LOAD_WAIT);
            await readNow();

            report.timer = await timer;

            send(report);
        };

        target.addListener(handler);

        return {target, handler};
    });
}
