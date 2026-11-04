// a page that opens a port to the background as soon as its script runs and acts right after the
// connect, before the background had a chance to listen to the port - what ?do= says: posts three
// messages (post), disconnects (disconnect), reports what its own end of the port tells it when
// the background has no runtime.onConnect listener (report), or just stays connected (wait). On a
// message from the background it posts back or disconnects. Every result of its own calls goes to
// the background by runtime.sendMessage, round-38
import {ACTION_WAIT} from './constants.js';

const params = new URL(location.href).searchParams;
const name = params.get('tab') ?? '';
const action = params.get('do') ?? 'wait';

document.title = name;
document.getElementById('name').textContent = name;

const report = (event, detail) => browser.runtime.sendMessage({report: name, event, detail}).catch(() => {});

const tryPost = (port, message) => {
    try {
        port.postMessage(message);
        return 'ok';
    } catch (error) {
        return `throws: ${error.message}`;
    }
};

const port = browser.runtime.connect({name: `port: ${name}`});
const connectedAt = Date.now();
const since = () => `${Date.now() - connectedAt} ms after the connect`;

port.onMessage.addListener(message => {
    if (message.action === 'post') {
        port.postMessage({n: message.n});
    } else if (message.action === 'disconnect') {
        port.disconnect();
    }
});

if (action === 'post') {
    for (const n of [1, 2, 3]) {
        report(`port.postMessage n=${n} right after the connect`, tryPost(port, {n}));
    }
}

if (action === 'disconnect') {
    port.disconnect();
}

if (action === 'report') {
    let disconnected = false;

    port.onDisconnect.addListener(() => {
        disconnected = true;
        report('port.onDisconnect', `${since()}, port.error: ${port.error?.message ?? 'null'}`);
    });

    report('port.postMessage right after the connect', tryPost(port, {n: 1}));

    // the timer of a page in a background tab is held back (BEHAVIOR-CREATE-TABS.md §44): the report carries the measured delay
    setTimeout(() => report('port.postMessage later', `${since()}, port.onDisconnect fired before it: ${disconnected}, ${tryPost(port, {n: 2})}`), ACTION_WAIT);
}
