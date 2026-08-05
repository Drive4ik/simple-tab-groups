import {QUIET_WAIT, POLL_WAIT, SETTLE_TIMEOUT, SETTING_WAIT, NOISY_UPDATE_KEYS} from './constants.js';

export const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export class RestartRequested extends Error {}

const same = (actual, expected) => {
    if (Object.is(actual, expected)) {
        return true;
    }

    return JSON.stringify(actual) === JSON.stringify(expected);
};

const show = value => typeof value === 'string' ? value : JSON.stringify(value);

export class Test {
    constructor({id, title, round, onQuestion, data = null}) {
        this.onQuestion = onQuestion;

        this.data = data ?? {
            id,
            title,
            round,
            rows: [],
            notes: [],
            events: [],
            checks: [],
            asked: [],
            dropped: 0,
            settings: [],
            scene: [],
            failed: null,
        };

        this.listeners = [];
        this.queued = [];
        this.labels = new Map();
        this.t0 = Date.now();
        this.lastEventAt = Date.now();
        this.wake = null;
        this.quietTimer = null;
    }

    async state() {
        return null;
    }

    fingerprint() {
        return '';
    }

    pending() {
        return [];
    }

    async snap() {}

    async describe() {
        return [];
    }

    eventFormatters() {
        return {};
    }

    ms() {
        return Date.now() - this.t0;
    }

    note(text) {
        this.data.notes.push(text);
    }

    row(label, cells, extra = {}) {
        this.data.rows.push({kind: 'state', label, cells, ...extra});
    }

    act(text) {
        this.t0 = Date.now();
        this.data.rows.push({kind: 'action', label: text});
    }

    expect(label, actual, expected) {
        const ok = same(actual, expected);
        this.data.checks.push({kind: 'expect', label, ok, actual: show(actual), expected: show(expected)});
        return ok;
    }

    expectRow(label, cells) {
        const row = this.data.rows.findLast(candidate => candidate.kind === 'state' && candidate.label === label);

        return this.expect(`row "${label}"`, row ? row.cells.join(' | ') : '(no such row)', cells.join(' | '));
    }

    require(label, ok, detail = '') {
        this.data.checks.push({kind: 'require', label, ok, actual: detail, expected: ''});

        if (!ok) {
            throw new Error(`${label}${detail ? ` — ${detail}` : ''}`);
        }
    }

    uniqueLabel(label) {
        const seen = (this.labels.get(label) ?? 0) + 1;
        this.labels.set(label, seen);
        return seen === 1 ? label : `${label} ${seen}`;
    }

    bump() {
        this.lastEventAt = Date.now();

        clearTimeout(this.quietTimer);
        this.quietTimer = this.wake ? setTimeout(() => this.wake?.(), QUIET_WAIT) : null;
    }

    async tick() {
        const {promise, resolve} = Promise.withResolvers();

        this.wake = resolve;
        await Promise.race([promise, wait(POLL_WAIT)]);

        this.wake = null;
        clearTimeout(this.quietTimer);
        this.quietTimer = null;
    }

    async settled({timeout = SETTLE_TIMEOUT, until = null} = {}) {
        const started = Date.now();
        let previous = null;

        while (true) {
            const state = await this.state();
            const key = this.fingerprint(state);
            const pending = this.pending(state);
            const quiet = Date.now() - this.lastEventAt >= QUIET_WAIT;

            if (!pending.length && quiet && key === previous && (!until || until(state))) {
                return {ms: Date.now() - started, timedOut: false};
            }

            if (Date.now() - started >= timeout) {
                const stuck = pending.length ? `, still loading: ${pending.join(', ')}` : '';
                this.note(`quiet timeout after ${timeout} ms${stuck}`);
                return {ms: Date.now() - started, timedOut: true};
            }

            previous = key;
            await this.tick();
        }
    }

    async settleFor(waitFor) {
        if (waitFor === 0 || waitFor === false) {
            return null;
        }

        if (typeof waitFor === 'number') {
            await wait(waitFor);
            return {ms: waitFor, fixed: true};
        }

        return this.settled();
    }

    async step(label, run, {wait: waitFor = 'quiet', snap = 'after'} = {}) {
        this.act(label);

        const result = await run();
        const settled = await this.settleFor(waitFor);
        const action = this.data.rows.at(-1);

        if (settled) {
            action.timing = settled.fixed ? `waited ${settled.ms} ms` : `settled ${settled.ms} ms`;
        }

        if (snap !== false) {
            await this.snap(this.uniqueLabel(snap));
        }

        return result;
    }

    async ask(question) {
        this.flushEvents();

        const answer = await this.onQuestion(this, question);
        this.data.asked.push({question, answer});

        return answer;
    }

    async restart(message = 'restart the browser, load the add-on again, then run:  T.continue()') {
        this.flushEvents();
        throw new RestartRequested(message);
    }

    async setting(name, value) {
        const api = browser.browserSettings?.[name];

        if (!api) {
            return {ok: false, reason: `browser.browserSettings.${name} is missing`};
        }

        const before = await api.get({});

        try {
            await api.set({value});
        } catch (error) {
            return {ok: false, reason: error.message, previous: before.value};
        }

        if (!this.data.settings.includes(name)) {
            this.data.settings.push(name);
        }

        await wait(SETTING_WAIT);

        const after = await api.get({});

        return {
            ok: after.value === value,
            requested: value,
            applied: after.value,
            previous: before.value,
            levelOfControl: after.levelOfControl,
        };
    }

    async clearSetting(name) {
        const api = browser.browserSettings?.[name];

        if (!api) {
            return {ok: false, reason: `browser.browserSettings.${name} is missing`};
        }

        const cleared = await api.clear({});
        await wait(SETTING_WAIT);

        return {cleared, value: (await api.get({})).value};
    }

    async clearSettings() {
        for (const name of this.data.settings) {
            await this.clearSetting(name);
        }

        this.data.settings = [];
    }

    watch(specs, {updatedKeys} = {}) {
        for (const spec of specs) {
            const [namespace, event] = spec.split('.');
            const target = browser[namespace]?.[event];

            if (!target?.addListener) {
                this.note(`event API missing: ${spec}`);
                continue;
            }

            const handler = (...args) => this.onEvent(spec, args, updatedKeys);

            try {
                target.addListener(handler);
                this.listeners.push({target, handler});
            } catch (error) {
                this.note(`cannot listen ${spec}: ${error.message}`);
            }
        }
    }

    formatterFor(spec) {
        const formatters = this.eventFormatters();
        const namespace = `${spec.split('.')[0]}.`;

        return formatters[spec] ?? formatters[namespace] ?? null;
    }

    onEvent(spec, args, updatedKeys) {
        const formatter = this.formatterFor(spec);
        const text = formatter ? formatter(args, {updatedKeys, test: this}) : JSON.stringify(args);

        if (text === null) {
            return;
        }

        this.queued.push({at: this.ms(), spec, text});
    }

    flushEvents() {
        for (const {at, spec, text} of this.queued) {
            const rendered = typeof text === 'function' ? text() : text;
            this.data.events.push(`${String(at).padStart(5)}ms  ${spec.padEnd(22)}${rendered}`);
        }

        this.queued = [];
    }

    stopWatching() {
        for (const {target, handler} of this.listeners) {
            try {
                target.removeListener(handler);
            } catch {}
        }

        this.listeners = [];
    }

    async finish() {
        clearTimeout(this.quietTimer);
        this.quietTimer = null;

        this.flushEvents();
        this.stopWatching();
        await this.clearSettings();
    }

    render() {
        const states = this.data.rows.filter(row => row.kind === 'state');
        const width = states.reduce((max, row) => Math.max(max, row.cells.length), 0);
        const lines = [`### ${this.data.id} ${this.data.title}`, ''];

        if (width) {
            const header = ['tab index', ...Array.from({length: width}, (_, index) => String(index))];

            lines.push(`| ${header.join(' | ')} |`);
            lines.push(`| ${header.map(() => '-').join(' | ')} |`);

            for (const row of this.data.rows) {
                if (row.kind === 'action') {
                    lines.push(`| \`${row.label}\`${row.timing ? ` — ${row.timing}` : ''} |${' |'.repeat(width)}`);
                } else {
                    const cells = [...row.cells];

                    while (cells.length < width) {
                        cells.push('');
                    }

                    lines.push(`| ${row.label} | ${cells.join(' | ')} |`);
                }
            }
        }

        const groups = [];
        let previousGroups = null;

        for (const row of states) {
            const described = row.groups?.join(' | ') ?? '';

            if (described && described !== previousGroups) {
                groups.push(`- ${row.label}: ${described}`);
            }

            previousGroups = described;
        }

        if (groups.length) {
            lines.push('', 'groups:', ...groups);
        }

        if (this.data.events.length || this.data.dropped) {
            lines.push('', 'events:', '```text');
            lines.push(...(this.data.events.length ? this.data.events : ['(none)']));

            if (this.data.dropped) {
                lines.push(`(${this.data.dropped} noisy tabs.onUpdated dropped: ${NOISY_UPDATE_KEYS.join('/')})`);
            }

            lines.push('```');
        }

        if (this.data.checks.length) {
            lines.push('', 'checks:');

            for (const {kind, label, ok, actual, expected} of this.data.checks) {
                if (ok) {
                    lines.push(`- OK        ${label}`);
                } else if (kind === 'require') {
                    lines.push(`- ABORTED   ${label}${actual ? ` — ${actual}` : ''}`);
                } else {
                    lines.push(`- MISMATCH  ${label} — got: ${actual}, want: ${expected}`);
                }
            }
        }

        if (this.data.notes.length) {
            lines.push('', 'notes:');
            lines.push(...this.data.notes.map(note => `- ${note}`));
        }

        if (this.data.asked.length) {
            lines.push('', '👁️ answers:');

            for (const {question, answer} of this.data.asked) {
                lines.push(`- ${question}`, `  → ${answer}`);
            }
        }

        if (this.data.failed) {
            lines.push('', `FAILED: ${this.data.failed}`);
        }

        return lines.join('\n');
    }
}
