import {ACTION_WAIT, LOAD_WAIT, TIGHT_POLL_WAIT} from '../constants.js';
import {wait} from '../test.js';
import {openedWindows} from '../tabs.js';

export const note = `Round 12 — delivery timing of tabs.onAttached / tabs.onDetached against the
resolve of the browser.tabs.move() promise: can an event land AFTER the resolve, and how late.
Order is judged by one shared sequence counter bumped in the listeners and right after each await —
clock reads are for magnitude only, they are clamped to ~1 ms and cannot order two close moments.
Events pair with moves first-in-first-out per (event, tab, window); a slot whose event count or
order cannot be trusted is EXCLUDED from the late/early lines and reported as such — a broken
pairing must not fabricate a latency. Cross-window moves use {windowId, index: -1}. Asserts the
recorded facts: MOVE-TABS-BEHAVIOR.md §2 (full delivery, zero events after the resolve) and §3
(the R12.03/R12.04 after-rows).`;

const PACED_SINGLE = 30;
const RAPID_SINGLE = 60;
const ARRAY_TRIPS = 20;
const RAPID_ARRAY = 40;

const FIVE = Array.from({length: 5}, (_, index) => `m${index + 1}`);
const TEN = Array.from({length: 10}, (_, index) => `m${index + 1}`);

const statLine = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return `min ${sorted[0]} / med ${sorted[Math.floor(sorted.length / 2)]} / max ${sorted.at(-1)} ms`;
};

const listOrStat = (values, prefix = '') => values.length <= 12
    ? values.map(value => `${prefix}${value} ms`).join(', ')
    : statLine(values);

class MoveTiming {
    constructor() {
        this.seq = 0;
        this.moves = [];
        this.slots = new Map();
        this.anomalies = [];
        this.listeners = [];

        for (const [spec, windowKey] of [['tabs.onAttached', 'newWindowId'], ['tabs.onDetached', 'oldWindowId']]) {
            const [namespace, event] = spec.split('.');
            const target = browser[namespace][event];
            const handler = (tabId, info) => this.slot(spec, tabId, info[windowKey]).events.push({seq: ++this.seq, at: Date.now()});

            target.addListener(handler);
            this.listeners.push({target, handler});
        }
    }

    slot(spec, tabId, windowId) {
        const key = `${spec}:${tabId}:${windowId}`;
        let slot = this.slots.get(key);

        if (!slot) {
            slot = {spec, events: [], expected: []};
            this.slots.set(key, slot);
        }

        return slot;
    }

    async move(tabIds, {from, to}) {
        const record = {tabIds: [...tabIds], from, to, startSeq: ++this.seq, resolveSeq: null, resolveAt: null, marks: []};

        for (const tabId of record.tabIds) {
            this.slot('tabs.onAttached', tabId, to).expected.push(record);
            this.slot('tabs.onDetached', tabId, from).expected.push(record);
        }

        this.moves.push(record);

        await browser.tabs.move(record.tabIds, {windowId: to, index: -1});

        record.resolveSeq = ++this.seq;
        record.resolveAt = Date.now();

        return record;
    }

    mark(record, label) {
        record.marks.push({label, seq: ++this.seq, at: Date.now()});
    }

    anomaly(text) {
        this.anomalies.push(text);
    }

    delivered(record) {
        return record.tabIds.every(tabId => {
            return [['tabs.onAttached', record.to], ['tabs.onDetached', record.from]].every(([spec, windowId]) => {
                const slot = this.slot(spec, tabId, windowId);
                return slot.events.length > slot.expected.indexOf(record);
            });
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

        for (const [spec, targetOf] of [['tabs.onAttached', record => record.to], ['tabs.onDetached', record => record.from]]) {
            const late = [];
            const early = [];
            const afterMark = new Map();
            let expected = 0;
            let excluded = 0;

            for (const record of this.moves) {
                for (const tabId of record.tabIds) {
                    expected++;

                    const slot = this.slot(spec, tabId, targetOf(record));

                    if (unreliable.has(slot)) {
                        excluded++;
                        continue;
                    }

                    const event = slot.events[slot.expected.indexOf(record)];

                    if (event.seq > record.resolveSeq) {
                        late.push(event.at - record.resolveAt);

                        for (const mark of record.marks) {
                            if (event.seq > mark.seq) {
                                afterMark.set(mark.label, (afterMark.get(mark.label) ?? 0) + 1);
                            }
                        }
                    } else {
                        early.push(record.resolveAt - event.at);
                    }
                }
            }

            let delivered = 0;
            let brokenSlots = 0;

            for (const slot of this.slots.values()) {
                if (slot.spec === spec && slot.expected.length) {
                    delivered += slot.events.length;
                    brokenSlots += unreliable.has(slot) ? 1 : 0;
                }
            }

            const name = spec.replace('tabs.', '');

            t.note(`${name}: ${expected} expected, ${delivered} delivered`);

            if (excluded) {
                t.note(`${name}: pairing unreliable in ${brokenSlots} slot(s) — ${excluded} trip-event(s) EXCLUDED from the lines below`);
            }

            const reliable = expected - excluded;

            t.note(`${name} AFTER the move() resolve: ${late.length ? `${late.length} of ${reliable} — ${listOrStat(late, '+')}` : reliable ? 'none' : 'no reliable data'}`);

            t.expect(`${name}: all events delivered`, delivered, expected);
            t.expect(`${name} after the move() resolve`, late.length, 0);

            if (early.length) {
                t.note(`${name} before the resolve, gap: ${statLine(early)}`);
            }

            for (const [label, count] of afterMark) {
                t.note(`${name} after ${label}: ${count}`);
            }
        }

        let extra = 0;

        for (const slot of this.slots.values()) {
            if (!slot.expected.length) {
                extra += slot.events.length;
            }
        }

        if (extra) {
            t.note(`attach/detach events outside any expected slot: ${extra}`);
        }

        for (const text of this.anomalies) {
            t.note(`anomaly: ${text}`);
        }
    }

    stop() {
        for (const {target, handler} of this.listeners) {
            try {
                target.removeListener(handler);
            } catch {}
        }

        this.listeners = [];
    }
}

async function windowRow(t, label, windowId) {
    const tabs = (await browser.tabs.query({windowId})).sort((a, b) => a.index - b.index);
    t.row(label, tabs.map(tab => t.cell(tab)));
}

async function pingPong(t, {movers, iterations, paced, hideEachTrip = false, discardEachTrip = false, showAfterMove = false, expectAfterA = null}) {
    await t.scene(['keepA', ...movers]);

    const winB = await t.buildWindow(['keepB']);
    const timing = new MoveTiming();

    try {
        await t.snap('before (window A)');
        await windowRow(t, 'before (window B)', winB);

        const trip = [
            hideEachTrip && 'hide',
            discardEachTrip && 'discard',
            'move',
            showAfterMove && 'show',
        ].filter(Boolean).join('+');

        t.act(`${iterations} × ${trip} of ${movers.length} tab(s) A⇄B, ${paced ? 'paced — each trip waits for its events' : 'rapid — no waits between trips'}`);

        const ids = t.ids(movers);
        let from = t.win;
        let to = winB;
        let stopped = false;

        for (let index = 0; index < iterations; index++) {
            if (hideEachTrip) {
                await browser.tabs.hide(ids).catch(error => timing.anomaly(`hide, trip ${index}: ${error.message}`));
            }

            if (discardEachTrip) {
                await browser.tabs.discard(ids).catch(error => timing.anomaly(`discard, trip ${index}: ${error.message}`));
            }

            let record;

            try {
                record = await timing.move(ids, {from, to});
            } catch (error) {
                timing.anomaly(`move, trip ${index}: ${error.message} — the loop STOPS here, ${index} of ${iterations} trips done`);
                break;
            }

            if (showAfterMove) {
                try {
                    await browser.tabs.show(ids);
                    timing.mark(record, 'the show() resolve');
                } catch (error) {
                    timing.anomaly(`show, trip ${index}: ${error.message}`);
                }
            }

            if (paced && !await timing.drain([record], LOAD_WAIT)) {
                timing.anomaly(`trip ${index}: events not delivered within ${LOAD_WAIT} ms — the loop STOPS here, ${index + 1} of ${iterations} trips done`);
                stopped = true;
                break;
            }

            [from, to] = [to, from];
        }

        const completed = timing.moves.filter(record => record.resolveSeq !== null);

        if (!stopped && completed.length && !await timing.drain(completed, LOAD_WAIT)) {
            timing.anomaly(`final drain: events still missing after ${LOAD_WAIT} ms`);
        }

        await wait(ACTION_WAIT);
        timing.summarize(t);

        await t.settled();
        await t.snap('after (window A)');
        await windowRow(t, 'after (window B)', winB);

        if (expectAfterA) {
            t.expectRow('after (window A)', expectAfterA);
        }
    } finally {
        timing.stop();
        openedWindows.delete(winB);
        await browser.windows.remove(winB).catch(() => {});
    }
}

export const tests = [

{
    id: 'R12.01',
    title: 'paced ping-pong, one visible tab — the calm baseline',
    async run(t) {
        const info = await browser.runtime.getBrowserInfo?.() ?? {};
        t.note(`browser: ${info.name ?? '?'} ${info.version ?? '?'}`);

        await pingPong(t, {movers: ['mover'], iterations: PACED_SINGLE, paced: true});
    },
},

{
    id: 'R12.02',
    title: 'rapid ping-pong, one visible tab — no waits between trips',
    run: t => pingPong(t, {movers: ['mover'], iterations: RAPID_SINGLE, paced: false}),
},

{
    id: 'R12.03',
    title: 'paced ping-pong, array of 5 HIDDEN tabs — re-hidden before every trip',
    run: t => pingPong(t, {movers: FIVE, iterations: ARRAY_TRIPS, paced: true, hideEachTrip: true,
        expectAfterA: ['keepA*', 'm1', 'm2', 'm3', 'm4', 'm5']}),
},

{
    id: 'R12.04',
    title: 'paced ping-pong, array of 5 HIDDEN + DISCARDED tabs',
    run: t => pingPong(t, {movers: FIVE, iterations: ARRAY_TRIPS, paced: true, hideEachTrip: true, discardEachTrip: true,
        expectAfterA: ['keepA*', 'm1(h)', 'm2(h)', 'm3(h)', 'm4(h)', 'm5(h)']}),
},

{
    id: 'R12.05',
    title: 'paced ping-pong, array of 5 HIDDEN tabs, show() right after the move — events vs BOTH resolves',
    run: t => pingPong(t, {movers: FIVE, iterations: ARRAY_TRIPS, paced: true, hideEachTrip: true, showAfterMove: true}),
},

{
    id: 'R12.06',
    title: 'rapid ping-pong, array of 10 visible tabs — event pressure at volume',
    run: t => pingPong(t, {movers: TEN, iterations: RAPID_ARRAY, paced: false}),
},

{
    id: 'R12.07',
    title: 'rapid ping-pong, array of 5 HIDDEN + DISCARDED tabs, show() right after the move — the full burst',
    run: t => pingPong(t, {movers: FIVE, iterations: ARRAY_TRIPS, paced: false, hideEachTrip: true, discardEachTrip: true, showAfterMove: true}),
},

];
