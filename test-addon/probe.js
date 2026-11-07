// a page that asks for the background page (runtime.getBackgroundPage, extension.getBackgroundPage,
// getViews) and reports the answers to the background with runtime.sendMessage. With ?token= it
// reports too what of the background it sees from its container - a localStorage key, a
// storage.local key and a storage.session key the background wrote before the page opened - writes
// the token into a localStorage key of its own, says hello in the BroadcastChannel, and answers a
// message of the background in that channel with a second report, round-20
import {PROBE_CHANNEL, PROBE_KEYS} from './constants.js';

const params = new URL(location.href).searchParams;
const name = params.get('probe') ?? '';
const token = params.get('token'); // of the run that asks for the storage part; without it the page only asks for the background page

document.title = name;
document.getElementById('name').textContent = name;

const describe = value => value === null ? 'null' : value === undefined ? 'undefined' : typeof value === 'object' ? 'window' : typeof value;

// what a synchronous call gives, or the error it throws
const outcome = run => {
    try {
        return run();
    } catch (error) {
        return `throws: ${error.message}`;
    }
};

// what a storage area holds under the key, null when nothing, or the error of the read
async function stored(area, key) {
    try {
        const {[key]: value} = await browser.storage[area].get(key);

        return value ?? null;
    } catch (error) {
        return `rejected: ${error.message}`;
    }
}

// the listener comes before anything else: the message of the background may follow the first report at once
const channel = token === null ? null : outcome(() => new BroadcastChannel(PROBE_CHANNEL));

if (channel instanceof BroadcastChannel) {
    channel.addEventListener('message', ({data}) => {
        if (data?.to === name) {
            browser.runtime.sendMessage({probe: name, channelFromBackground: true}).catch(() => {});
        }
    });
}

async function probe() {
    const report = {probe: name};

    try {
        report.runtimeGetBackgroundPage = describe(await browser.runtime.getBackgroundPage());
    } catch (error) {
        report.runtimeGetBackgroundPage = `rejected: ${error.message}`;
    }

    try {
        report.extensionGetBackgroundPage = describe(browser.extension.getBackgroundPage());
    } catch (error) {
        report.extensionGetBackgroundPage = `threw: ${error.message}`;
    }

    try {
        report.getViewsTabCount = browser.extension.getViews({type: 'tab'}).length;
    } catch (error) {
        report.getViewsTabCount = `threw: ${error.message}`;
    }

    try {
        const tab = await browser.tabs.getCurrent();
        report.cookieStoreId = tab.cookieStoreId;
    } catch (error) {
        report.cookieStoreId = `rejected: ${error.message}`;
    }

    if (token !== null) {
        report.localStorageFromBackground = outcome(() => localStorage.getItem(PROBE_KEYS.fromBackground));
        report.storageLocalFromBackground = await stored('local', PROBE_KEYS.fromBackground);
        report.storageSessionFromBackground = await stored('session', PROBE_KEYS.fromBackground);
        report.localStorageFromPage = outcome(() => {
            localStorage.setItem(`${PROBE_KEYS.fromPage}:${name}`, token);

            return 'written';
        });
        report.channel = channel instanceof BroadcastChannel ? 'open' : channel;

        if (channel instanceof BroadcastChannel) {
            channel.postMessage({probe: name, hello: true});
        }
    }

    await browser.runtime.sendMessage(report);
}

probe();
