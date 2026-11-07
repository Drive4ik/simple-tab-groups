import {POLL_WAIT, SETTLE_TIMEOUT, NETWORK_URL, UNLOAD_URL, RELOAD_LOG_KEYS} from '../constants.js';
import {wait, until} from '../test.js';
import {TabsTest, sceneUrl, nameFromUrl} from '../tabs.js';
import * as Reload from '../reload.js';

export const note = `Round 41 - a reload of the add-on seen from a page of the add-on that is open at that moment, the
shape of the debug page of STG (stg-debug.js, onClosePage): in which order the old background unloads, the
page gets pagehide and unload, its tab is closed and the new background starts its first line; whether the
port of the page reports its disconnect before the unload; what the page can still do at its unload - the
object runtime.getBackgroundPage() gave it at its load (the check Utils.isDeadObject makes), runtime.id,
runtime.sendMessage, port.postMessage, a rejected promise against unhandledrejection; whom a message sent from
the unloading page reaches - the old background, the new one, nobody; and whether a localStorage write made
at the unload survives the reload. The control is the same page closed by tabs.remove while the background
lives (R41.01); the reload comes from browser.runtime.reload(), the call Utils.safeReloadAddon makes, made by
the harness right after the checkpoint (R41.02), and from the Reload button of about:debugging, the path of
an update and of the developer (R41.03, MANUAL). The page, the old background and the new one write their
records into localStorage with the clock of the page; after the reload the test merges them into one
timeline, from the moment of the reload call or, for the button, from the first record after the test was
suspended. Lines of different sources in one ms are marked with "=": their order is not measured. A line
that is there is evidence, a missing tail proves nothing (BEHAVIOR-LIFECYCLE.md §8); the reports of the page
that reached a background are the second channel. The expectations are the facts of BEHAVIOR-LIFECYCLE.md §9.
The own uuid is never printed. Needs the network: the scene tab is a real page, so that the reload closes the
page of the add-on and not the window with it.`;

// the scene after a reload: a window the reload closed is a fact of the round, not an abort - the
// base reattach would stop the test before afterRestart
class ReloadTest extends TabsTest {
    async reattach() {
        const names = this.data.scene;
        const tabs = await browser.tabs.query({});

        if (tabs.some(tab => names.includes(nameFromUrl(tab.url) ?? ''))) {
            return super.reattach();
        }

        this.win = null;
        this.note('the scene window is gone after the reload');
    }
}

export const testClass = ReloadTest;
export const url = NETWORK_URL;

const PAGE = 'page';
const PORT_PREFIX = 'reload: ';
const OWN_ORIGIN = browser.runtime.getURL('');
const SAME_MS = '=';
const MESSAGE_EVENTS = ['runtime.onMessage', 'port.onMessage'];
const ALIVE = `backgroundPage: gives "[object Window]"; runtime.id: gives ${JSON.stringify(browser.runtime.id)}; runtime.sendMessage: gives "returned a promise"; port.postMessage: ok; Promise.reject: gives "made"`;

const maskOrigins = (...origins) => text => origins.reduce((masked, origin) => masked.replaceAll(origin, '<own page>/'), text);
const readLog = key => JSON.parse(localStorage.getItem(key) ?? '[]');
const clearLogs = () => Object.values(RELOAD_LOG_KEYS).forEach(key => localStorage.removeItem(key));
const hasEvent = (entries, event) => entries.some(entry => entry.event === event);
const detailOf = (entries, event) => entries.find(entry => entry.event === event)?.detail ?? 'no record';
const messagesSince = (entries, since) => entries.filter(entry => MESSAGE_EVENTS.includes(entry.event) && entry.at >= since).map(entry => entry.detail);
const removedPage = entries => entries.some(entry => entry.event === 'tabs.onRemoved' && entry.detail.startsWith(`${PAGE}  `));

// the journals are read once nothing has been written into them between two polls
async function logsSettled() {
    const started = Date.now();
    let previous = null;

    while (Date.now() - started < SETTLE_TIMEOUT) {
        await wait(POLL_WAIT);

        const current = Object.values(RELOAD_LOG_KEYS).map(key => localStorage.getItem(key)).join('|');

        if (current === previous) {
            return true;
        }

        previous = current;
    }

    return false;
}

// the background's end before the reload: raw listeners, kept past test.finish() in
// globalThis.shutdownProbe like the probe of round-19 (the harness drops it before the next test and
// on T.forget()); every record goes into localStorage with the clock of the page
function installProbe(t) {
    const sceneWin = t.win;
    const foreign = new Map;
    const records = [];
    let ready = false;

    const record = (event, detail = '', instance = null) => {
        records.push({at: Date.now(), who: 'old background', event, detail, instance});
        localStorage.setItem(RELOAD_LOG_KEYS.background, JSON.stringify(records));
    };

    const winName = windowId => {
        if (windowId === sceneWin) {
            return 'scene';
        }

        if (!foreign.has(windowId)) {
            foreign.set(windowId, `foreign${String.fromCharCode(65 + foreign.size)}`);
        }

        return foreign.get(windowId);
    };

    const onMessage = message => {
        if (message?.report) {
            record('runtime.onMessage', message.event, message.instance);
            ready ||= message.event === 'ready';
        }
    };

    const onConnect = port => {
        if (port.name.startsWith(PORT_PREFIX)) {
            record('runtime.onConnect', port.name);
            port.onMessage.addListener(message => record('port.onMessage', message.event, message.instance));
            port.onDisconnect.addListener(() => record('port.onDisconnect', `${port.name}, port.error: ${port.error?.message ?? 'null'}`));
        }
    };

    const onTabRemoved = (tabId, {windowId, isWindowClosing}) => record('tabs.onRemoved', `${t.nameById.get(tabId) ?? 'foreign'}  isWindowClosing:${isWindowClosing}  [${winName(windowId)}]`);
    const onWindowRemoved = windowId => record('windows.onRemoved', winName(windowId));
    const onPageHide = () => record('pagehide');
    const onUnload = () => record('unload');

    browser.runtime.onMessage.addListener(onMessage);
    browser.runtime.onConnect.addListener(onConnect);
    browser.tabs.onRemoved.addListener(onTabRemoved);
    browser.windows.onRemoved.addListener(onWindowRemoved);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('unload', onUnload);

    globalThis.shutdownProbe = {
        ready: () => ready,
        remove() {
            browser.runtime.onMessage.removeListener(onMessage);
            browser.runtime.onConnect.removeListener(onConnect);
            browser.tabs.onRemoved.removeListener(onTabRemoved);
            browser.windows.onRemoved.removeListener(onWindowRemoved);
            window.removeEventListener('pagehide', onPageHide);
            window.removeEventListener('unload', onUnload);
            delete globalThis.shutdownProbe;
        },
    };

    return globalThis.shutdownProbe;
}

// the scene of every test: a real page as the scene tab, the probe, then the page of the add-on,
// active as the debug page is for the user. The page is up once it reported ready; its records
// readable here, the unhandledrejection control among them, prove that the page and the background
// share one localStorage and that the event works in the page
async function prepare(t) {
    t.mask = maskOrigins(OWN_ORIGIN);
    clearLogs();
    Reload.take();

    await t.scene(['x']);

    const probe = installProbe(t);

    try {
        const tab = await browser.tabs.create({windowId: t.win, active: true, url: sceneUrl(PAGE, UNLOAD_URL)});

        t.bind(tab.id, PAGE);

        const ready = await until(() => probe.ready());

        t.require('the page reported ready', ready, `no ready report within ${SETTLE_TIMEOUT} ms`);

        const control = await until(() => hasEvent(readLog(RELOAD_LOG_KEYS.page), 'unhandledrejection'));

        t.require('the background reads the records of the page, the unhandledrejection control among them', control, 'no such record: the localStorage of the page is not the one of the background, or the event never came');

        const cells = (await t.query()).map(tab => t.cell(tab)).join(' | ');

        t.require('the page is the active tab next to x', cells === `x | ${PAGE}*`, `got [${cells}]`);
    } catch (error) {
        probe.remove();
        throw error;
    }

    await t.snap('before');

    return probe;
}

// the records of every source on one scale, from the zero of the test; what came before the zero is
// the setup. A load of the page is named by its order: the first is "page", a page the reload loaded
// anew is "page (load 2)". Lines of different sources in one ms carry the mark: their order is not measured
function timeline(t, zero, entries) {
    const sorted = [...entries].sort((a, b) => a.at - b.at);
    const loads = new Map;
    const loadName = instance => {
        if (!loads.has(instance)) {
            loads.set(instance, loads.size ? `${PAGE} (load ${loads.size + 1})` : PAGE);
        }

        return loads.get(instance);
    };

    for (const entry of sorted) {
        if (entry.who === 'page') {
            loadName(entry.instance);
        }
    }

    const shown = sorted.filter(entry => entry.at >= zero);
    let marked = false;

    shown.forEach((entry, index) => {
        const neighbours = [shown[index - 1], shown[index + 1]].filter(Boolean);
        const sameMs = neighbours.some(other => other.at === entry.at && other.who !== entry.who);
        const who = entry.who === 'page' ? loadName(entry.instance) : entry.who;
        const from = entry.instance && entry.who !== 'page' ? `  from ${loadName(entry.instance)}` : '';
        const text = `${entry.event}${entry.detail ? `  ${entry.detail}` : ''}${from}`;

        marked ||= sameMs;
        t.record(who, sameMs ? `${SAME_MS} ${text}` : text, entry.at - zero);
    });

    if (marked) {
        t.note(`${SAME_MS} marks lines of different sources in one ms: their order is not measured, the clock is reduced to 1 ms buckets`);
    }
}

// what the page records in every case, with a live background and in a reload alike (BEHAVIOR-LIFECYCLE.md §9)
function expectPage(t, page) {
    t.expect('the background object is alive at pagehide and at unload, every call returns (BEHAVIOR-LIFECYCLE.md §9)', [detailOf(page, 'pagehide'), detailOf(page, 'unload')], [ALIVE, ALIVE]);
    t.expect('a rejection at pagehide or unload fires no unhandledrejection, the one at the load did (§9)', page.filter(entry => entry.event === 'unhandledrejection').map(entry => entry.detail), ['rejected at load']);
    t.expect('the promise of sendMessage never settles while the page lives (§9)', page.filter(entry => entry.event.includes('sendMessage')).map(entry => entry.event), []);
    t.expect('port.onDisconnect never reaches the page (§9)', hasEvent(page, 'port.onDisconnect'), false);
}

async function suspend(t, message, {reload = false} = {}) {
    t.data.ownOrigin = OWN_ORIGIN; // compared and masked after the reload, never printed
    t.data.suspendedAt = Date.now();
    Reload.arm();

    await t.restart(`open about:debugging in a window of your own, not in the scene window; ${message}`, {reload});
}

async function afterReload(t, action) {
    t.mask = maskOrigins(OWN_ORIGIN, t.data.ownOrigin);

    const probeStillLive = Boolean(globalThis.shutdownProbe);
    globalThis.shutdownProbe?.remove();

    await Reload.finished;

    const fresh = Reload.take();
    const page = readLog(RELOAD_LOG_KEYS.page);
    const background = readLog(RELOAD_LOG_KEYS.background);

    clearLogs();

    const entries = [...page, ...background];

    if (fresh) {
        entries.push({at: fresh.startedAt, who: 'new background', event: 'the first line'});
        entries.push(...fresh.events.map(entry => ({...entry, who: 'new background'})));
    }

    const cleanTrip = t.rebirths === 1 && !probeStillLive;
    const suspendedEntries = entries.filter(entry => entry.at >= t.data.suspendedAt).sort((a, b) => a.at - b.at);
    const zero = t.data.reloadedAt ?? suspendedEntries[0]?.at ?? t.data.suspendedAt;

    if (!cleanTrip) {
        t.note('⚠ NOT A CLEAN MEASUREMENT — see the aborted check below; the lines are kept only for debugging');
    }

    t.act(action);
    timeline(t, zero, entries);

    t.note('a line that is there is evidence, a missing tail proves nothing (BEHAVIOR-LIFECYCLE.md §8); a report of the page that reached a background is the second channel');
    t.note(`the origin of the add-on after the reload is ${t.data.ownOrigin === OWN_ORIGIN ? 'the same' : 'ANOTHER one'}`);

    if (!fresh) {
        t.note('the probe of the new start never ran: no record of the first line of the new background');
    }

    if (t.win === null) {
        t.row('after the reload', ['(scene window gone)']);
    } else {
        await t.settled();
        await t.snap('after the reload');
    }

    {
        const pageUnload = page.find(entry => entry.event === 'unload')?.at;
        const backgroundPagehide = background.find(entry => entry.event === 'pagehide')?.at;
        const freshEvents = fresh?.events ?? [];

        expectPage(t, page);
        t.expect('the page unloads before the old background, or in the same ms (§9)', pageUnload !== undefined && backgroundPagehide !== undefined && pageUnload <= backgroundPagehide, true);
        t.expect('a message sent at the unload reaches neither the old background nor the new one (§9)', [messagesSince(background, t.data.suspendedAt), messagesSince(freshEvents, 0)], [[], []]);
        t.expect('neither port.onDisconnect nor tabs.onRemoved of the page reaches the old background (§9)', [hasEvent(background, 'port.onDisconnect'), removedPage(background)], [false, false]);
        t.expect('the tab of the page is gone at the first line of the new background (§9)', detailOf(freshEvents, 'tabs.query at the first line'), `${Reload.PAGE_PATH}: 0 tab(s)`);
        t.expect('the add-on keeps its origin across the reload (§9)', t.data.ownOrigin === OWN_ORIGIN, true);
    }

    t.require('the loaded record of the page survived the reload', hasEvent(page, 'loaded'), 'the localStorage of the page is gone - its channel proves nothing');
    t.require(
        'the add-on was reloaded exactly once while the probe was armed',
        cleanTrip,
        probeStillLive
            ? 'the probe is still alive - the add-on was never reloaded'
            : `add-on loads while the test was suspended: ${t.rebirths} (need exactly 1); re-run the round`,
    );
    t.require(
        'the start was a reload of the add-on: runtime.onInstalled with reason update (BEHAVIOR-LIFECYCLE.md §1)',
        Boolean(fresh?.events.some(entry => entry.event === 'runtime.onInstalled' && entry.detail.includes('"reason":"update"'))),
        'no such event at the start - a browser restart is not a reload; re-run the round',
    );
}

export const tests = [

{
    id: 'R41.01',
    title: 'the control: the page is closed by tabs.remove while the background lives - what the page records at its pagehide and unload (the object of getBackgroundPage, runtime.id, runtime.sendMessage, port.postMessage, a rejected promise) and what of it reaches the background',
    async run(t) {
        const probe = await prepare(t);
        let removedAt;

        await t.step('tabs.remove(page)', () => {
            removedAt = Date.now();

            return browser.tabs.remove(t.id(PAGE));
        });

        await logsSettled();
        probe.remove();

        const page = readLog(RELOAD_LOG_KEYS.page);
        const background = readLog(RELOAD_LOG_KEYS.background);

        clearLogs();
        timeline(t, removedAt, [...page, ...background]);

        expectPage(t, page);
        t.expect('with the background alive the four messages of the page arrive, in the order they were sent (§9)', messagesSince(background, removedAt), ['pagehide: sendMessage', 'pagehide: postMessage', 'unload: sendMessage', 'unload: postMessage']);
        t.expect('the live background gets tabs.onRemoved and port.onDisconnect of the page (§9)', [removedPage(background), hasEvent(background, 'port.onDisconnect')], [true, true]);
    },
},

{
    id: 'R41.02',
    title: 'browser.runtime.reload() with the page open, the call Utils.safeReloadAddon makes: the order of the old background\'s pagehide and unload, the page\'s pagehide and unload, the close of its tab and the first line of the new background; the port of the page before its unload; what the page can still do at its unload and whom its messages reach; the add-on reloads itself, the run continues with T.continue()',
    async run(t) {
        await prepare(t);
        await suspend(t, 'the harness reloads the add-on itself now: wait for "STG behavior test harness ready" in its console (Inspect it again in about:debugging), then run:  T.continue()', {reload: true});
    },
    afterRestart: t => afterReload(t, 'browser.runtime.reload()  // by the harness, right after the checkpoint'),
},

{
    id: 'R41.03',
    title: 'MANUAL - the Reload button of about:debugging with the page open, the path of an update and of the developer: the same timeline, from the first record after the test was suspended',
    async run(t) {
        await prepare(t);
        await suspend(t, 'press Reload next to the harness in about:debugging, Inspect it again, then run:  T.continue()');
    },
    afterRestart: t => afterReload(t, 'Reload in about:debugging  // by hand; the zero is the first record after the test was suspended'),
},

];
