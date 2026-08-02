'use strict';

const TAB_GROUP_ID_NONE = -1;
const SQUARES = ['🟥', '🟩', '🟦', '🟨', '🟪', '⬛'];
const SCENE_URL = 'https://example.com/';

const LOAD_WAIT = 2000;
const SETTLE_WAIT = 300;
const SETTING_WAIT = 100;

const NOISY_UPDATE_KEYS = ['status', 'url', 'title', 'favIconUrl', 'isArticle', 'audible', 'attention'];

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// the name travels in the url, so a tab stays identifiable across a browser restart,
// when no harness instance remembers its id
const sceneUrl = name => `${SCENE_URL}?tab=${encodeURIComponent(name)}`;
const nameFromUrl = url => new URL(url).searchParams.get('tab');

const openedWindows = new Set();

class Test {
    constructor(name) {
        this.name = name;
        this.t0 = Date.now();
        this.win = null;
        this.idByName = new Map();
        this.nameById = new Map();
        this.createdByAction = new Set();
        this.squareByGroupId = new Map();
        this.rows = [];
        this.notes = [];
        this.questions = [];
        this.events = [];
        this.listeners = [];
        this.droppedEvents = 0;
        this.unknownCount = 0;
        this.reported = false;
    }

    ms() {
        return Date.now() - this.t0;
    }

    note(text) {
        this.notes.push(text);
    }

    ask(question) {
        this.questions.push(question);
    }

    bind(tabId, name) {
        this.idByName.set(name, tabId);
        this.nameById.set(tabId, name);
    }

    id(name) {
        const tabId = this.idByName.get(name);

        if (tabId === undefined) {
            throw new Error(`unknown tab name "${name}"`);
        }

        return tabId;
    }

    ids(names) {
        return names.map(name => this.id(name));
    }

    nameOf(tab) {
        if (!this.nameById.has(tab.id)) {
            this.unknownCount++;
            this.bind(tab.id, `unknown${this.unknownCount}`);
        }

        return this.nameById.get(tab.id);
    }

    square(groupId) {
        if (groupId === TAB_GROUP_ID_NONE || groupId === undefined || groupId === null) {
            return '';
        }

        if (!this.squareByGroupId.has(groupId)) {
            this.squareByGroupId.set(groupId, SQUARES[this.squareByGroupId.size % SQUARES.length]);
        }

        return this.squareByGroupId.get(groupId);
    }

    async query() {
        const tabs = await browser.tabs.query({windowId: this.win});
        return tabs.sort((a, b) => a.index - b.index);
    }

    async scene(names) {
        const win = await browser.windows.create({url: SCENE_URL});

        this.win = win.id;
        openedWindows.add(win.id);

        const firstTabs = win.tabs?.length ? win.tabs : await browser.tabs.query({windowId: this.win});
        this.bind(firstTabs[0].id, names[0]);
        await browser.tabs.update(firstTabs[0].id, {url: sceneUrl(names[0])});

        for (let index = 1; index < names.length; index++) {
            const tab = await browser.tabs.create({
                windowId: this.win,
                url: sceneUrl(names[index]),
                index,
                active: false,
            });

            this.bind(tab.id, names[index]);
        }

        await wait(LOAD_WAIT);
        await this.assertScene(names);

        return this;
    }

    async assertScene(expected) {
        const actual = (await this.query()).map(tab => this.nameOf(tab));

        if (actual.join(',') !== expected.join(',')) {
            this.note(`SCENE MISMATCH — requested [${expected.join(', ')}], got [${actual.join(', ')}]`);
            throw new Error('scene mismatch, test aborted');
        }
    }

    async activate(name) {
        await browser.tabs.update(this.id(name), {active: true});
        await wait(SETTLE_WAIT);
    }

    async group(names, properties) {
        const groupId = await browser.tabs.group({
            tabIds: this.ids(names),
            createProperties: {windowId: this.win},
        });

        this.square(groupId);

        if (properties) {
            await browser.tabGroups.update(groupId, properties);
        }

        await wait(SETTLE_WAIT);

        return groupId;
    }

    async joinGroup(names, groupId) {
        await browser.tabs.group({tabIds: this.ids(names), groupId});
        await wait(SETTLE_WAIT);
    }

    async ungroup(names) {
        await browser.tabs.ungroup(this.ids(names));
        await wait(SETTLE_WAIT);
    }

    async hide(names) {
        await browser.tabs.hide(this.ids(names));
        await wait(SETTLE_WAIT);
    }

    async show(names) {
        await browser.tabs.show(this.ids(names));
        await wait(SETTLE_WAIT);
    }

    async create(name, properties = {}) {
        const tab = await browser.tabs.create({
            windowId: this.win,
            url: sceneUrl(name),
            active: false,
            ...properties,
        });

        this.bind(tab.id, name);
        this.createdByAction.add(tab.id);

        return tab;
    }

    async createMany(entries) {
        const tabs = await Promise.all(entries.map(({name, ...properties}) => browser.tabs.create({
            windowId: this.win,
            url: sceneUrl(name),
            active: false,
            ...properties,
        }).then(tab => ({tab, name}))));

        for (const {tab, name} of tabs) {
            this.bind(tab.id, name);
            this.createdByAction.add(tab.id);
        }

        await wait(LOAD_WAIT);
    }

    cell(tab) {
        const square = this.square(tab.groupId);
        const prefix = this.createdByAction.has(tab.id) ? '➕' : '';

        let text = (square ? square + ' ' : '') + prefix + this.nameOf(tab);

        if (tab.active) {
            text += '*';
        }

        if (tab.hidden) {
            text += '(h)';
        }

        return text;
    }

    // polls until the window really holds the tabs it should and nothing is still on about:blank.
    // a fast batch can otherwise be measured before the browser has caught up
    async settle({expect = null, timeout = 20000} = {}) {
        const started = Date.now();
        let tabs = [];
        let pending = 0;

        while (Date.now() - started < timeout) {
            tabs = await this.query();
            pending = tabs.filter(tab => !tab.discarded && (!tab.url || tab.url === 'about:blank')).length;

            if (!pending && (expect === null || tabs.length === expect)) {
                this.note(`settled after ${Date.now() - started} ms — ${tabs.length} tabs, none pending`);
                return tabs;
            }

            await wait(250);
        }

        this.note(`SETTLE TIMEOUT after ${timeout} ms — ${tabs.length} tabs${expect === null ? '' : ` (expected ${expect})`}, ${pending} still on about:blank`);

        return tabs;
    }

    async snap(label) {
        const tabs = await this.query();
        this.rows.push({kind: 'state', label, cells: tabs.map(tab => this.cell(tab))});
    }

    act(text) {
        this.rows.push({kind: 'action', label: '`' + text + '`'});
    }

    async groupsInfo() {
        const groups = await browser.tabGroups.query({windowId: this.win});

        return groups.map(group => {
            const parts = [`${this.square(group.id)} title:${JSON.stringify(group.title ?? '')}`];

            if (group.color !== undefined) {
                parts.push(`color:${group.color}`);
            }

            if (group.collapsed !== undefined) {
                parts.push(`collapsed:${group.collapsed}`);
            }

            return parts.join(' ');
        });
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

    // rendered lazily: tabs.onCreated arrives before create() has bound the tab's name
    push(spec, text) {
        const at = String(this.ms()).padStart(5);
        this.events.push(() => `${at}ms  ${spec.padEnd(22)}${typeof text === 'function' ? text() : text}`);
    }

    known(tabId) {
        return this.nameById.get(tabId) ?? `unknown(${this.nameById.size})`;
    }

    onEvent(spec, args, updatedKeys) {
        if (spec === 'tabs.onMoved') {
            const [tabId, info] = args;

            if (info.windowId === this.win) {
                this.push(spec, `${this.known(tabId)}  ${info.fromIndex} → ${info.toIndex}`);
            }
        } else if (spec === 'tabs.onUpdated') {
            const [tabId, changeInfo, tab] = args;

            if (tab.windowId !== this.win) {
                return;
            }

            const keys = Object.keys(changeInfo).filter(key => {
                return updatedKeys ? updatedKeys.includes(key) : !NOISY_UPDATE_KEYS.includes(key);
            });

            if (!keys.length) {
                this.droppedEvents++;
                return;
            }

            const shown = keys.map(key => {
                const value = changeInfo[key];
                return key === 'groupId' ? `groupId: ${this.square(value) || value}` : `${key}: ${value}`;
            });

            this.push(spec, `${this.known(tabId)}  {${shown.join(', ')}}`);
        } else if (spec === 'tabs.onCreated') {
            const [tab] = args;

            if (tab.windowId === this.win) {
                this.push(spec, () => `${this.known(tab.id)}  index:${tab.index} group:${this.square(tab.groupId) || tab.groupId}`);
            }
        } else if (spec === 'tabs.onRemoved') {
            const [tabId, info] = args;

            if (info.windowId === this.win) {
                this.push(spec, `${this.known(tabId)}  isWindowClosing:${info.isWindowClosing}`);
            }
        } else if (spec === 'tabs.onActivated') {
            const [info] = args;

            if (info.windowId === this.win) {
                this.push(spec, `${this.known(info.tabId)}  previous:${info.previousTabId ? this.known(info.previousTabId) : '-'}`);
            }
        } else if (spec.startsWith('tabGroups.')) {
            const [group] = args;

            if (group.windowId === undefined || group.windowId === this.win) {
                this.push(spec, `${this.square(group.id)}  title:${JSON.stringify(group.title ?? '')} collapsed:${group.collapsed}`);
            }
        } else {
            this.push(spec, JSON.stringify(args));
        }
    }

    stopWatching() {
        for (const {target, handler} of this.listeners) {
            try {
                target.removeListener(handler);
            } catch {}
        }

        this.listeners = [];
    }

    render() {
        const states = this.rows.filter(row => row.kind === 'state');
        const width = states.reduce((max, row) => Math.max(max, row.cells.length), 0);
        const header = ['tab index', ...Array.from({length: width}, (_, index) => String(index))];

        const lines = [`### ${this.name}`, ''];

        if (width) {
            lines.push(`| ${header.join(' | ')} |`);
            lines.push(`| ${header.map(() => '-').join(' | ')} |`);

            for (const row of this.rows) {
                if (row.kind === 'action') {
                    lines.push(`| ${[row.label, ...Array.from({length: width}, () => '')].join(' | ')} |`);
                } else {
                    const cells = [...row.cells];

                    while (cells.length < width) {
                        cells.push('');
                    }

                    lines.push(`| ${row.label} | ${cells.join(' | ')} |`);
                }
            }
        }

        if (this.events.length || this.droppedEvents) {
            lines.push('', 'events:', '```text');
            lines.push(...(this.events.length ? this.events.map(event => event()) : ['(none)']));

            if (this.droppedEvents) {
                lines.push(`(${this.droppedEvents} noisy tabs.onUpdated dropped: ${NOISY_UPDATE_KEYS.join('/')})`);
            }

            lines.push('```');
        }

        if (this.notes.length) {
            lines.push('', 'notes:');
            lines.push(...this.notes.map(note => `- ${note}`));
        }

        if (this.questions.length) {
            lines.push('', '👁️ look at the window and answer:');
            lines.push(...this.questions.map((question, index) => `${index + 1}. ${question}`));
        }

        return lines.join('\n');
    }

    async done({keepOpen = false} = {}) {
        if (this.reported) {
            return;
        }

        this.reported = true;
        this.stopWatching();

        console.debug(this.render());

        if (keepOpen) {
            console.debug(`### ${this.name}: window left open — answer the 👁️ questions, then close that window and hit Reload on the add-on before the next run`);
        } else {
            await this.close();
        }
    }

    async close() {
        if (this.win !== null) {
            openedWindows.delete(this.win);
            await browser.windows.remove(this.win).catch(() => {});
            this.win = null;
        }
    }
}

const T = {
    TAB_GROUP_ID_NONE,
    SQUARES,
    SCENE_URL,
    wait,

    test(name) {
        return new Test(name);
    },

    // the only entry point: T.start('round-06') loads tests/round-06.js and runs what it exports.
    // edited a test file? reload the add-on in about:debugging - modules are cached per load
    async start(name) {
        const module = await import(browser.runtime.getURL(`tests/${name}.js`));

        if (!Array.isArray(module.tests)) {
            throw new Error(`tests/${name}.js must export an array named "tests"`);
        }

        if (module.note) {
            console.debug(module.note);
        }

        await T.batch(module.tests, {gap: module.gap ?? 1500});

        if (module.after) {
            await module.after();
        }
    },

    async batch(tests, {gap = 1500} = {}) {
        console.debug(`=== batch start: ${tests.length} test(s) ===`);

        for (const [position, {name, run, keepOpen = false}] of tests.entries()) {
            if (position > 0) {
                await wait(gap);
            }

            const test = new Test(name);

            try {
                await run(test);
                await test.done({keepOpen});
            } catch (error) {
                test.note(`FAILED: ${error.message}`);
                await test.done();
            }
        }

        console.debug('=== batch done ===');
    },

    // dumps every normal window without relying on harness memory - names come back from the urls.
    // this is what survives a browser restart, where no Test instance exists any more
    async report(title = 'current state') {
        const windows = await browser.windows.getAll({windowTypes: ['normal']});
        const test = new Test(title);

        for (const [position, win] of windows.entries()) {
            // tabs.query, not windows.getAll({populate}) - only this one is known to return hidden tabs
            const tabs = (await browser.tabs.query({windowId: win.id})).sort((a, b) => a.index - b.index);

            for (const tab of tabs) {
                const name = nameFromUrl(tab.url);

                if (name) {
                    test.bind(tab.id, name);
                }
            }

            test.rows.push({
                kind: 'state',
                label: `window ${position + 1}`,
                cells: tabs.map(tab => test.cell(tab)),
            });

            const groups = await browser.tabGroups.query({windowId: win.id});
            const described = groups.map(group => `${test.square(group.id)} title:${JSON.stringify(group.title ?? '')} collapsed:${group.collapsed}`);
            test.note(`window ${position + 1}: ${described.join(' | ') || 'no groups'}`);
        }

        console.debug(test.render());
    },

    async newTabPosition(value) {
        const api = browser.browserSettings?.newTabPosition;

        if (!api) {
            return {ok: false, reason: 'browser.browserSettings.newTabPosition is missing'};
        }

        const before = await api.get({});
        let setResult;

        try {
            setResult = await api.set({value});
        } catch (error) {
            return {ok: false, reason: error.message, previous: before.value};
        }

        await wait(SETTING_WAIT);

        const after = await api.get({});

        return {
            ok: after.value === value,
            setResult,
            requested: value,
            applied: after.value,
            previous: before.value,
            levelOfControl: after.levelOfControl,
        };
    },

    async clearNewTabPosition() {
        const api = browser.browserSettings?.newTabPosition;

        if (!api) {
            return {ok: false, reason: 'browser.browserSettings.newTabPosition is missing'};
        }

        const cleared = await api.clear({});
        await wait(SETTING_WAIT);

        return {cleared, value: (await api.get({})).value};
    },
};

globalThis.T = T;

console.debug('STG behavior test harness ready — run a round with:  await T.start("round-01")');
