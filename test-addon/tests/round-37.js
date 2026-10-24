import {ACTION_WAIT, LOAD_WAIT, TIGHT_POLL_WAIT} from '../constants.js';
import {wait} from '../test.js';

export const note = `Round 37 — delivery timing of tabs.onUpdated {hidden} against the resolve of
browser.tabs.hide() and browser.tabs.show(): can the event land AFTER the resolve, and how late.
STG mutes its own hide and show by a per-tab flag removed right at the resolve; an event past the
resolve would pass for a foreign hide and the tab would lose its group. Order is judged by one
shared sequence counter bumped in the listener and right after each await — clock reads are for
magnitude only, they are clamped to ~1 ms and cannot order two close moments. Events pair with
calls first-in-first-out per (tab, hidden value); a slot whose event count or order cannot be
trusted is EXCLUDED from the late/early lines and reported as such. Asserts the recorded facts:
BEHAVIOR-CREATE-TABS.md §62 (full delivery, zero events after the resolve, the R37.05 after-row).`;

const PACED_SINGLE = 30;
const RAPID_SINGLE = 60;
const ARRAY_TRIPS = 20;
const RAPID_ARRAY = 40;
const FRESH_TABS = 10;

const FIVE = Array.from({length: 5}, (_, index) => `m${index + 1}`);
const TEN = Array.from({length: 10}, (_, index) => `m${index + 1}`);

const statLine = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return `min ${sorted[0]} / med ${sorted[Math.floor(sorted.length / 2)]} / max ${sorted.at(-1)} ms`;
};

const listOrStat = (values, prefix = '') => values.length <= 12
    ? values.map(value => `${prefix}${value} ms`).join(', ')
    : statLine(values);

class HideTiming {
    constructor() {
        this.seq = 0;
        this.calls = [];
        this.slots = new Map();
        this.anomalies = [];
        this.handler = (tabId, changeInfo) => {
            if (Object.hasOwn(changeInfo, 'hidden')) {
                this.slot(tabId, changeInfo.hidden).events.push({seq: ++this.seq, at: Date.now()});
            }
        };

        browser.tabs.onUpdated.addListener(this.handler);
    }

    slot(tabId, hidden) {
        const key = `${tabId}:${hidden}`;
        let slot = this.slots.get(key);

        if (!slot) {
            slot = {hidden, events: [], expected: []};
            this.slots.set(key, slot);
        }

        return slot;
    }

    // action: 'hide' | 'show'
    async call(action, tabIds) {
        const hidden = action === 'hide';
        const record = {action, hidden, tabIds: [...tabIds], startSeq: ++this.seq, resolveSeq: null, resolveAt: null, resolved: null};

        for (const tabId of record.tabIds) {
            this.slot(tabId, hidden).expected.push(record);
        }

        this.calls.push(record);

        record.resolved = await browser.tabs[action](record.tabIds);

        record.resolveSeq = ++this.seq;
        record.resolveAt = Date.now();

        return record;
    }

    anomaly(text) {
        this.anomalies.push(text);
    }

    delivered(record) {
        return record.tabIds.every(tabId => {
            const slot = this.slot(tabId, record.hidden);
            return slot.events.length > slot.expected.indexOf(record);
        });
    }

    async drain(records, timeout) {
        const started = Date.now();

        while (!records.every(record => this.delivered(record))) {
            if (Date.now() - started >= timeout) {
                return false;
            }

            await wait(TIGHT_POLL_WAIT);
        }

        return true;
    }

    unreliableSlots() {
        const unreliable = new Set();

        for (const slot of this.slots.values()) {
            if (!slot.expected.length) {
                continue;
            }

            const broken = slot.events.length !== slot.expected.length
                || slot.events.some((event, index) => event.seq <= slot.expected[index].startSeq);

            if (broken) {
                unreliable.add(slot);
            }
        }

        return unreliable;
    }

    summarize(t) {
        const unreliable = this.unreliableSlots();

        for (const action of ['hide', 'show']) {
            const records = this.calls.filter(record => record.action === action);

            if (!records.length) {
                continue;
            }

            const hidden = action === 'hide';
            const name = `tabs.${action}() → {hidden: ${hidden}}`;
            const late = [];
            const early = [];
            let expected = 0;
            let excluded = 0;

            for (const record of records) {
                for (const tabId of record.tabIds) {
                    expected++;

                    const slot = this.slot(tabId, hidden);

                    if (unreliable.has(slot)) {
                        excluded++;
                        continue;
                    }

                    const event = slot.events[slot.expected.indexOf(record)];

                    if (event.seq > record.resolveSeq) {
                        late.push(event.at - record.resolveAt);
                    } else {
                        early.push(record.resolveAt - event.at);
                    }
                }
            }

            let delivered = 0;
            let brokenSlots = 0;

            for (const slot of this.slots.values()) {
                if (slot.hidden === hidden && slot.expected.length) {
                    delivered += slot.events.length;
                    brokenSlots += unreliable.has(slot) ? 1 : 0;
                }
            }

            t.note(`${name}: ${expected} expected, ${delivered} delivered`);

            if (excluded) {
                t.note(`${name}: pairing unreliable in ${brokenSlots} slot(s) — ${excluded} call-event(s) EXCLUDED from the lines below`);
            }

            const reliable = expected - excluded;

            t.note(`${name} AFTER the resolve: ${late.length ? `${late.length} of ${reliable} — ${listOrStat(late, '+')}` : reliable ? 'none' : 'no reliable data'}`);

            t.expect(`${name}: all events delivered`, delivered, expected);
            t.expect(`${name} after the resolve`, late.length, 0);

            if (early.length) {
                t.note(`${name} before the resolve, gap: ${statLine(early)}`);
            }
        }

        let extra = 0;

        for (const slot of this.slots.values()) {
            if (!slot.expected.length) {
                extra += slot.events.length;
            }
        }

        if (extra) {
            t.note(`{hidden} events outside any expected slot: ${extra}`);
        }

        for (const text of this.anomalies) {
            t.note(`anomaly: ${text}`);
        }
    }

    stop() {
        try {
            browser.tabs.onUpdated.removeListener(this.handler);
        } catch {}
    }
}

async function finishTiming(t, timing, stopped) {
    const completed = timing.calls.filter(record => record.resolveSeq !== null);

    if (!stopped && completed.length && !await timing.drain(completed, LOAD_WAIT)) {
        timing.anomaly(`final drain: events still missing after ${LOAD_WAIT} ms`);
    }

    await wait(ACTION_WAIT);
    timing.summarize(t);

    await t.settled();
    await t.snap('after');
}

// keep stays active: tabs.hide skips the active tab of the window (BEHAVIOR-TABGROUPS.md §9)
async function hideShow(t, {movers, iterations, paced, discardBetween = false}) {
    await t.scene(['keep', ...movers]);

    const timing = new HideTiming();

    try {
        await t.snap('before');

        const trip = ['hide', discardBetween && 'discard', 'show'].filter(Boolean).join('+');

        t.act(`${iterations} × ${trip} of ${movers.length} tab(s), ${paced ? 'paced — each call waits for its events' : 'rapid — no waits between calls'}`);

        const ids = t.ids(movers);
        let stopped = false; // the paced drain timed out: nothing more to wait for
        let aborted = false; // a call rejected: the completed calls still get the final drain

        for (let index = 0; index < iterations && !stopped && !aborted; index++) {
            for (const action of ['hide', 'show']) {
                let record;

                try {
                    record = await timing.call(action, ids);
                } catch (error) {
                    timing.anomaly(`${action}, trip ${index}: ${error.message} — the loop STOPS here, ${index} full trips done`);
                    aborted = true;
                    break;
                }

                if (action === 'hide') {
                    if (record.resolved.length !== ids.length) {
                        timing.anomaly(`hide, trip ${index}: ${record.resolved.length} of ${ids.length} tabs hidden`);
                    }

                    if (discardBetween) {
                        await browser.tabs.discard(ids).catch(error => timing.anomaly(`discard, trip ${index}: ${error.message}`));
                    }
                }

                if (paced && !await timing.drain([record], LOAD_WAIT)) {
                    timing.anomaly(`${action}, trip ${index}: events not delivered within ${LOAD_WAIT} ms — the loop STOPS here after the ${action} of trip ${index}, ${index} full trips done`);
                    stopped = true;
                    break;
                }
            }
        }

        await finishTiming(t, timing, stopped);
    } finally {
        timing.stop();
    }
}

// the shape of Tabs.add and createMultiple: a tab is hidden right at the resolve of tabs.create
async function freshHide(t) {
    await t.scene(['keep']);

    const timing = new HideTiming();

    try {
        await t.snap('before');

        t.act(`${FRESH_TABS} × tabs.create(loaded) and ${FRESH_TABS} × tabs.create({discarded: true}), each hidden by tabs.hide() right at the create resolve`);

        const names = [];

        for (const discarded of [false, true]) {
            for (let index = 0; index < FRESH_TABS; index++) {
                const name = `${discarded ? 'd' : 'n'}${index + 1}`;
                const tab = await t.create(name, discarded ? {discarded: true} : {});

                names.push(name);
                let record;

                try {
                    record = await timing.call('hide', [tab.id]);
                } catch (error) {
                    timing.anomaly(`hide of ${name}: ${error.message}`);
                    continue;
                }

                if (record.resolved.length !== 1) {
                    timing.anomaly(`hide of ${name}: the tab was not hidden`);
                }

                if (!await timing.drain([record], LOAD_WAIT)) {
                    timing.anomaly(`${name}: the event not delivered within ${LOAD_WAIT} ms`);
                }
            }
        }

        await finishTiming(t, timing, false);

        t.expectRow('after', ['keep*', ...names.map(name => `➕${name}(h)`)]);
    } finally {
        timing.stop();
    }
}

export const tests = [

{
    id: 'R37.01',
    title: 'paced hide/show, one visible tab — the calm baseline',
    async run(t) {
        const info = await browser.runtime.getBrowserInfo?.() ?? {};
        t.note(`browser: ${info.name ?? '?'} ${info.version ?? '?'}`);

        await hideShow(t, {movers: ['mover'], iterations: PACED_SINGLE, paced: true});
    },
},

{
    id: 'R37.02',
    title: 'rapid hide/show, one tab — no waits between calls',
    run: t => hideShow(t, {movers: ['mover'], iterations: RAPID_SINGLE, paced: false}),
},

{
    id: 'R37.03',
    title: 'paced hide/show, array of 5 tabs',
    run: t => hideShow(t, {movers: FIVE, iterations: ARRAY_TRIPS, paced: true}),
},

{
    id: 'R37.04',
    title: 'rapid hide/show, array of 10 tabs — event pressure at volume',
    run: t => hideShow(t, {movers: TEN, iterations: RAPID_ARRAY, paced: false}),
},

{
    id: 'R37.05',
    title: 'a fresh tab hidden right at its create resolve, loaded and born discarded — the shape of Tabs.add and createMultiple',
    run: freshHide,
},

{
    id: 'R37.06',
    title: 'paced hide+discard+show, array of 5 tabs — the shape of Groups.hideTabs',
    run: t => hideShow(t, {movers: FIVE, iterations: ARRAY_TRIPS, paced: true, discardBetween: true}),
},

];
