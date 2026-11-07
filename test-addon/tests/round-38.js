import {ACTION_WAIT, PORT_URL} from '../constants.js';
import {wait, until} from '../test.js';
import {sceneUrl} from '../tabs.js';

export const note = `Round 38 - a port of runtime.connect seen from the end that was late to listen. The background
gets the port in runtime.onConnect and attaches port.onMessage and port.onDisconnect only ACTION_WAIT
later: what it gets from the messages the page posted right after the connect (R38.01), from a
disconnect the page made right after the connect, next to a disconnect made after the attach
(R38.02), from a page closed after the background got the port and before the attach, next to a
page closed after the attach (R38.03); and what the page gets from its own end of the port when the
background has no runtime.onConnect listener at all (R38.04). The shape of the add-on at its start:
the pages connect while the background still loads its modules, and listeners.js hands the ports to
the handler later (DESIGN-LISTENERS.md §2, DESIGN-MESSAGES.md §3). The expectations are the fact of
BEHAVIOR-CREATE-TABS.md 63. The own uuid is never printed.`;

const PORT_PREFIX = 'port: ';
const OWN_ORIGIN = browser.runtime.getURL('');
const DISCONNECTED = 'throws: Attempt to postMessage on disconnected port';
const REFUSED = 'port.error: Could not establish connection. Receiving end does not exist.';

const mask = text => text.replaceAll(OWN_ORIGIN, '<own page>/');
const error = port => `port.error: ${port.error?.message ?? 'null'}`;

const tryPost = (port, message) => {
    try {
        port.postMessage(message);
        return 'ok';
    } catch (e) {
        return `throws: ${e.message}`;
    }
};

// the background's end: every port of a page is kept by its name, nothing listens to it until told
function listenConnects(t) {
    const ports = new Map;
    const onConnect = port => {
        if (port.name.startsWith(PORT_PREFIX)) {
            const name = port.name.slice(PORT_PREFIX.length);

            ports.set(name, port);
            t.record('runtime.onConnect', `${name}, ${error(port)}`);
        }
    };

    browser.runtime.onConnect.addListener(onConnect);
    t.listeners.push({target: browser.runtime.onConnect, handler: onConnect});

    return ports;
}

// what the page says about its own end of the port, by runtime.sendMessage
function listenReports(t) {
    const reports = [];
    const onMessage = message => {
        if (message?.report) {
            reports.push(message);
            t.record('page reports', `${message.report}: ${message.event} - ${message.detail}`);
        }
    };

    browser.runtime.onMessage.addListener(onMessage);
    t.listeners.push({target: browser.runtime.onMessage, handler: onMessage});

    return reports;
}

async function openPage(t, name, action) {
    const tab = await browser.tabs.create({windowId: t.win, active: false, url: `${sceneUrl(name, PORT_URL)}&do=${action}`});

    t.bind(tab.id, name);
    t.createdByAction.add(tab.id);
}

// the port of the page once runtime.onConnect handed it out, undefined when it never did
async function portOf(ports, name) {
    await until(() => ports.has(name));

    return ports.get(name);
}

function attach(t, port, name) {
    const heard = {messages: [], disconnects: 0};

    port.onMessage.addListener(message => {
        heard.messages.push(message.n);
        t.record('port.onMessage', `${name}: ${JSON.stringify(message)}`);
    });

    port.onDisconnect.addListener(() => {
        heard.disconnects++;
        t.record('port.onDisconnect', `${name}, ${error(port)}`);
    });

    return heard;
}

// a post from the background into the port of the page, as an action row with its outcome
async function post(t, port, name, message) {
    let outcome;

    await t.step(`port.postMessage(${JSON.stringify(message)}) into the port of ${name}`, async () => {
        outcome = tryPost(port, message);
        t.record('port.postMessage', `${name}: ${outcome}`);
        await pause();
    }, {wait: 0, snap: false});

    return outcome;
}

const pause = () => wait(ACTION_WAIT);
const told = (reports, event) => reports.find(report => report.event === event)?.detail ?? 'no report';

export const tests = [

{
    id: 'R38.01',
    title: 'the page posts n=1, n=2, n=3 right after the connect, the background attaches port.onMessage ACTION_WAIT later: are the three delivered then, or lost; the control - n=4 asked for after the attach',
    async run(t) {
        t.mask = mask;

        const ports = listenConnects(t);
        const reports = listenReports(t);

        await t.scene(['x']);
        await t.snap('before');

        await t.step('tabs.create(port.html?do=post)  // posts n=1, n=2, n=3 right after the connect', () => openPage(t, 'page', 'post'), {wait: 0, snap: false});

        const port = await portOf(ports, 'page');

        t.require('the port of page arrived', Boolean(port));

        let heard;

        await t.step(`wait ${ACTION_WAIT} ms, port.onMessage.addListener, wait ${ACTION_WAIT} ms`, async () => {
            await pause();
            heard = attach(t, port, 'page');
            await pause();
        }, {wait: 0, snap: false});

        const before = [...heard.messages];

        await post(t, port, 'page', {action: 'post', n: 4});
        await until(() => reports.length >= 3);

        const own = [1, 2, 3].map(n => told(reports, `port.postMessage n=${n} right after the connect`));
        const after = heard.messages.slice(before.length);

        t.note(`the page's own port.postMessage of n=1, n=2, n=3: ${own.join(', ')}`);
        t.note(`posted before the listener and delivered after it: ${before.join(', ') || 'none'}`);
        t.note(`delivered after the control: ${after.join(', ') || 'none'}`);

        t.expect("the page's postMessage into a port nobody listens to yet returns without an error (BEHAVIOR-CREATE-TABS.md §63)", own, ['ok', 'ok', 'ok']);
        t.expect('a message posted before the listener was attached is lost (BEHAVIOR-CREATE-TABS.md §63)', before, []);
        t.expect('a message asked for after the attach arrives (BEHAVIOR-CREATE-TABS.md §63)', after, [4]);
    },
},

{
    id: 'R38.02',
    title: 'the page disconnects right after the connect, the background attaches port.onDisconnect ACTION_WAIT later: does the port reach runtime.onConnect at all, does the late listener fire, what port.error says, does port.postMessage throw; the control - a page that disconnects after the attach',
    async run(t) {
        t.mask = mask;

        const ports = listenConnects(t);

        await t.scene(['x']);
        await t.snap('before');

        await t.step('tabs.create(port.html?do=disconnect)  // disconnects right after the connect', () => openPage(t, 'early', 'disconnect'), {wait: 0, snap: false});

        const early = await portOf(ports, 'early');

        t.expect('a port disconnected right after the connect still reaches runtime.onConnect (BEHAVIOR-CREATE-TABS.md §63)', Boolean(early), true);

        if (early) {
            let heard;

            await t.step(`wait ${ACTION_WAIT} ms, port.onDisconnect.addListener on the port of early, wait ${ACTION_WAIT} ms`, async () => {
                await pause();
                heard = attach(t, early, 'early');
                await pause();
            }, {wait: 0, snap: false});

            const posted = await post(t, early, 'early', {action: 'post', n: 1});

            t.note(`early, disconnected before the listener: port.onDisconnect fired ${heard.disconnects} time(s), ${error(early)}`);

            t.expect('port.onDisconnect attached after the disconnect never fires, port.error stays null (BEHAVIOR-CREATE-TABS.md §63)', [heard.disconnects, error(early)], [0, 'port.error: null']);
            t.expect('port.postMessage into the port of early throws (BEHAVIOR-CREATE-TABS.md §63)', posted, DISCONNECTED);
        } else {
            t.note('early, disconnected right after the connect: the port never reached runtime.onConnect');
        }

        await t.step('tabs.create(port.html?do=wait)  // the control: stays connected', () => openPage(t, 'late', 'wait'), {wait: 0, snap: false});

        const late = await portOf(ports, 'late');

        t.require('the port of late arrived', Boolean(late));

        const heardLate = attach(t, late, 'late');

        await post(t, late, 'late', {action: 'disconnect'});

        const posted = await post(t, late, 'late', {action: 'post', n: 1});

        t.note(`late, disconnected after the listener: port.onDisconnect fired ${heardLate.disconnects} time(s), ${error(late)}`);

        t.expect('port.onDisconnect attached before the disconnect fires once, port.error null (BEHAVIOR-CREATE-TABS.md §63)', [heardLate.disconnects, error(late)], [1, 'port.error: null']);
        t.expect('port.postMessage into the port of late throws (BEHAVIOR-CREATE-TABS.md §63)', posted, DISCONNECTED);
    },
},

{
    id: 'R38.03',
    title: 'the page is closed by tabs.remove after the background got its port and before the attach, port.onDisconnect attached ACTION_WAIT later: does it fire, what port.error says, does port.postMessage throw; the control - a page closed after the attach',
    async run(t) {
        t.mask = mask;

        const ports = listenConnects(t);

        await t.scene(['x']);
        await t.snap('before');

        await t.step('tabs.create(port.html?do=wait)', () => openPage(t, 'early', 'wait'), {wait: 0, snap: false});

        const early = await portOf(ports, 'early');

        t.require('the port of early arrived', Boolean(early));

        await t.step('tabs.remove(early)  // the background has the port, nothing listens to it yet', () => browser.tabs.remove(t.id('early')), {wait: 0, snap: false});

        let heardEarly;

        await t.step(`wait ${ACTION_WAIT} ms, port.onDisconnect.addListener on the port of early, wait ${ACTION_WAIT} ms`, async () => {
            await pause();
            heardEarly = attach(t, early, 'early');
            await pause();
        }, {wait: 0, snap: false});

        const postedEarly = await post(t, early, 'early', {action: 'post', n: 1});

        t.note(`early, closed before the listener: port.onDisconnect fired ${heardEarly.disconnects} time(s), ${error(early)}`);

        t.expect('port.onDisconnect attached after the page closed never fires, port.error stays null (BEHAVIOR-CREATE-TABS.md §63)', [heardEarly.disconnects, error(early)], [0, 'port.error: null']);
        t.expect('port.postMessage into the port of early throws (BEHAVIOR-CREATE-TABS.md §63)', postedEarly, DISCONNECTED);

        await t.step('tabs.create(port.html?do=wait)  // the control: the listener is attached right at the port', () => openPage(t, 'late', 'wait'), {wait: 0, snap: false});

        const late = await portOf(ports, 'late');

        t.require('the port of late arrived', Boolean(late));

        const heardLate = attach(t, late, 'late');

        await t.step('tabs.remove(late)  // the listener is there', async () => {
            await browser.tabs.remove(t.id('late'));
            await pause();
        }, {wait: 0, snap: false});

        const postedLate = await post(t, late, 'late', {action: 'post', n: 1});

        t.note(`late, closed after the listener: port.onDisconnect fired ${heardLate.disconnects} time(s), ${error(late)}`);

        t.expect('port.onDisconnect attached before the page closed fires once, port.error null (BEHAVIOR-CREATE-TABS.md §63)', [heardLate.disconnects, error(late)], [1, 'port.error: null']);
        t.expect('port.postMessage into the port of late throws (BEHAVIOR-CREATE-TABS.md §63)', postedLate, DISCONNECTED);
    },
},

{
    id: 'R38.04',
    title: 'the background has no runtime.onConnect listener: what the page gets from its own end of the port - port.onDisconnect and port.error, port.postMessage right after the connect and a timer later',
    async run(t) {
        t.mask = mask;

        const reports = listenReports(t);

        await t.scene(['x']);
        await t.snap('before');

        await t.step('tabs.create(port.html?do=report)  // nothing listens to runtime.onConnect', () => openPage(t, 'page', 'report'), {wait: 0, snap: false});

        await t.step('wait for the later report of the page', () => until(() => reports.some(report => report.event === 'port.postMessage later')), {wait: 0, snap: false});

        const disconnect = told(reports, 'port.onDisconnect');
        const first = told(reports, 'port.postMessage right after the connect');
        const later = told(reports, 'port.postMessage later');

        t.note(`port.onDisconnect: ${disconnect}`);
        t.note(`port.postMessage right after the connect: ${first}`);
        t.note(`port.postMessage later: ${later}`);

        t.expect('the connect nobody listens to is refused on the page by port.onDisconnect with port.error (BEHAVIOR-CREATE-TABS.md §63)', disconnect.endsWith(REFUSED), true);
        t.expect('the postMessage right after the connect returns without an error (BEHAVIOR-CREATE-TABS.md §63)', first, 'ok');
        t.expect('the postMessage after the refusal throws (BEHAVIOR-CREATE-TABS.md §63)', [later.includes('port.onDisconnect fired before it: true'), later.endsWith(DISCONNECTED)], [true, true]);
    },
},

];
