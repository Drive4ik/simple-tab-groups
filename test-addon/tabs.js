import {SCENE_URL, SQUARES, TAB_GROUP_ID_NONE, NOISY_UPDATE_KEYS} from './constants.js';
import {Test} from './test.js';

export const sceneUrl = (name, base = SCENE_URL) => `${base}?tab=${encodeURIComponent(name)}`;
export const nameFromUrl = url => {
    try {
        return new URL(url).searchParams.get('tab');
    } catch {
        return null;
    }
};

export const openedWindows = new Set();

const WATCHED = [
    'tabs.onCreated', 'tabs.onUpdated', 'tabs.onMoved', 'tabs.onRemoved',
    'tabs.onActivated', 'tabs.onAttached', 'tabs.onDetached',
    'tabGroups.onCreated', 'tabGroups.onUpdated', 'tabGroups.onMoved', 'tabGroups.onRemoved',
];

const windowOf = args => {
    for (const arg of args) {
        if (arg?.windowId !== undefined) {
            return arg.windowId;
        }
    }

    return undefined;
};

export async function closeHarnessWindows() {
    const closed = [];

    for (const win of await browser.windows.getAll({windowTypes: ['normal'], populate: false})) {
        const tabs = await browser.tabs.query({windowId: win.id});
        const ours = openedWindows.has(win.id) || (tabs.length > 0 && tabs.every(tab => nameFromUrl(tab.url)));

        if (ours) {
            await browser.windows.remove(win.id).catch(() => {});
            openedWindows.delete(win.id);
            closed.push(win.id);
        }
    }

    return closed;
}

export class TabsTest extends Test {
    constructor(options) {
        super(options);

        this.page = options.url ?? SCENE_URL;
        this.win = null;
        this.idByName = new Map();
        this.nameById = new Map();
        this.expected = new Map();
        this.createdByAction = new Set();
        this.squareByGroupId = new Map();
        this.unknownCount = 0;
        this.internal = [];

        this.listenInternally();
    }

    listenInternally() {
        for (const spec of WATCHED) {
            const [namespace, event] = spec.split('.');
            const target = browser[namespace]?.[event];

            if (!target?.addListener) {
                continue;
            }

            const handler = (...args) => {
                const windowId = windowOf(args);

                if (this.win === null || windowId === undefined || windowId === this.win) {
                    this.bump();
                }
            };

            target.addListener(handler);
            this.internal.push({target, handler});
        }
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

    known(tabId) {
        if (!this.nameById.has(tabId)) {
            this.unknownCount++;
            this.bind(tabId, `unknown${this.unknownCount}`);
        }

        return this.nameById.get(tabId);
    }

    nameOf(tab) {
        return this.known(tab.id);
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

    cell(tab) {
        const square = this.square(tab.groupId);
        const prefix = this.createdByAction.has(tab.id) ? '➕' : '';

        let text = (square ? `${square} ` : '') + prefix + this.nameOf(tab);

        if (tab.active) {
            text += '*';
        }

        if (tab.hidden) {
            text += '(h)';
        }

        return text;
    }

    async query() {
        const tabs = await browser.tabs.query({windowId: this.win});
        return tabs.sort((a, b) => a.index - b.index);
    }

    async groupsInfo() {
        if (!browser.tabGroups || this.win === null) {
            return [];
        }

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

    async state() {
        if (this.win === null) {
            return {tabs: [], groups: []};
        }

        const tabs = await this.query();
        const groups = browser.tabGroups ? await browser.tabGroups.query({windowId: this.win}) : [];

        return {tabs, groups};
    }

    fingerprint({tabs, groups}) {
        const tabPart = tabs.map(tab => `${tab.id}:${tab.index}:${tab.groupId}:${tab.hidden ? 1 : 0}:${tab.active ? 1 : 0}:${tab.pinned ? 1 : 0}`);
        const groupPart = groups.map(group => `${group.id}:${group.title}:${group.color}:${group.collapsed}`);

        return `${tabPart.join(',')}|${groupPart.join(',')}`;
    }

    pending({tabs}) {
        return tabs
            .filter(tab => this.expected.has(tab.id) && !tab.discarded && nameFromUrl(tab.url) !== this.expected.get(tab.id))
            .map(tab => this.expected.get(tab.id));
    }

    async snap(label) {
        const tabs = await this.query();
        this.row(label, tabs.map(tab => this.cell(tab)), {groups: await this.groupsInfo()});
    }

    async describe() {
        const tabs = await this.query();
        const groups = await this.groupsInfo();
        const lines = [`window: ${tabs.map(tab => this.cell(tab)).join(' | ')}`];

        if (groups.length) {
            lines.push(`groups: ${groups.join(' | ')}`);
        }

        return lines;
    }

    async hiddenFlags() {
        const tabs = await this.query();
        return tabs.map(tab => `${this.cell(tab)}=${tab.hidden}`).join(', ');
    }

    async scene(names) {
        const win = await browser.windows.create({url: this.tabUrl(names[0])});

        this.win = win.id;
        openedWindows.add(win.id);
        this.data.scene = [...names];

        const first = win.tabs?.length ? win.tabs : await browser.tabs.query({windowId: this.win});

        this.bind(first[0].id, names[0]);
        this.expected.set(first[0].id, names[0]);

        for (let index = 1; index < names.length; index++) {
            const tab = await browser.tabs.create({
                windowId: this.win,
                url: this.tabUrl(names[index]),
                index,
                active: false,
            });

            this.bind(tab.id, names[index]);
            this.expected.set(tab.id, names[index]);
        }

        const settled = await this.settled({until: state => state.tabs.length === names.length});
        const actual = (await this.query()).map(tab => this.nameOf(tab));

        this.require(
            'scene built as requested',
            actual.join(',') === names.join(','),
            `requested [${names.join(', ')}], got [${actual.join(', ')}] after ${settled.ms} ms`,
        );

        return this;
    }

    async reattach() {
        const names = this.data.scene;
        let best = null;

        for (const win of await browser.windows.getAll({windowTypes: ['normal']})) {
            const tabs = (await browser.tabs.query({windowId: win.id})).sort((a, b) => a.index - b.index);
            const found = tabs.filter(tab => names.includes(nameFromUrl(tab.url) ?? ''));

            if (!best || found.length > best.found.length) {
                best = {win, tabs, found};
            }
        }

        this.require(
            'scene window found after the restart',
            best !== null && best.found.length > 0,
            `looked for [${names.join(', ')}]`,
        );

        this.win = best.win.id;
        openedWindows.add(this.win);

        for (const tab of best.tabs) {
            const name = nameFromUrl(tab.url);

            if (name) {
                this.bind(tab.id, name);
                this.expected.set(tab.id, name);
            }
        }

        this.note(`reattached to the scene window, ${best.found.length} of ${names.length} tabs found by name`);
    }

    async activate(name, {settle = true} = {}) {
        await browser.tabs.update(this.id(name), {active: true});

        if (settle) {
            await this.settled();
        }
    }

    async group(names, properties, {settle = true} = {}) {
        const groupId = await browser.tabs.group({
            tabIds: this.ids(names),
            createProperties: {windowId: this.win},
        });

        this.square(groupId);

        if (properties) {
            await browser.tabGroups.update(groupId, properties);
        }

        if (settle) {
            await this.settled();
        }

        return groupId;
    }

    async joinGroup(names, groupId, {settle = true} = {}) {
        await browser.tabs.group({tabIds: this.ids(names), groupId});

        if (settle) {
            await this.settled();
        }
    }

    async ungroup(names, {settle = true} = {}) {
        await browser.tabs.ungroup(this.ids(names));

        if (settle) {
            await this.settled();
        }
    }

    async hide(names, {settle = true} = {}) {
        const hidden = await browser.tabs.hide(this.ids(names));

        if (settle) {
            await this.settled();
        }

        return hidden;
    }

    async show(names, {settle = true} = {}) {
        await browser.tabs.show(this.ids(names));

        if (settle) {
            await this.settled();
        }
    }

    tabUrl(name) {
        return sceneUrl(name, this.page);
    }

    createProperties(name, properties) {
        return {
            windowId: this.win,
            url: this.tabUrl(name),
            active: false,
            ...(properties.discarded ? {title: name} : {}),
            ...properties,
        };
    }

    remember(tab, name, properties) {
        this.bind(tab.id, name);
        this.createdByAction.add(tab.id);

        if (!properties.url) {
            this.expected.set(tab.id, name);
        }
    }

    async create(name, properties = {}) {
        const tab = await browser.tabs.create(this.createProperties(name, properties));

        this.remember(tab, name, properties);

        return tab;
    }

    async createMany(entries) {
        const created = await Promise.all(entries.map(({name, ...properties}) => {
            return browser.tabs.create(this.createProperties(name, properties)).then(tab => ({tab, name, properties}));
        }));

        for (const {tab, name, properties} of created) {
            this.remember(tab, name, properties);
        }

        return created.map(({tab}) => tab);
    }

    eventFormatters() {
        return {
            'tabs.onMoved': ([tabId, info]) => {
                return info.windowId === this.win ? `${this.known(tabId)}  ${info.fromIndex} → ${info.toIndex}` : null;
            },
            'tabs.onUpdated': ([tabId, changeInfo, tab], {updatedKeys}) => {
                if (tab.windowId !== this.win) {
                    return null;
                }

                const keys = Object.keys(changeInfo).filter(key => {
                    return updatedKeys ? updatedKeys.includes(key) : !NOISY_UPDATE_KEYS.includes(key);
                });

                if (!keys.length) {
                    this.data.dropped++;
                    return null;
                }

                const shown = keys.map(key => {
                    const value = changeInfo[key];
                    return key === 'groupId' ? `groupId: ${this.square(value) || value}` : `${key}: ${value}`;
                });

                return `${this.known(tabId)}  {${shown.join(', ')}}`;
            },
            'tabs.onCreated': ([tab]) => {
                if (tab.windowId !== this.win) {
                    return null;
                }

                return () => `${this.known(tab.id)}  index:${tab.index} group:${this.square(tab.groupId) || tab.groupId}`;
            },
            'tabs.onRemoved': ([tabId, info]) => {
                return info.windowId === this.win ? `${this.known(tabId)}  isWindowClosing:${info.isWindowClosing}` : null;
            },
            'tabs.onActivated': ([info]) => {
                if (info.windowId !== this.win) {
                    return null;
                }

                return `${this.known(info.tabId)}  previous:${info.previousTabId ? this.known(info.previousTabId) : '-'}`;
            },
            'tabGroups.': ([group]) => {
                if (group.windowId !== undefined && group.windowId !== this.win) {
                    return null;
                }

                return `${this.square(group.id)}  title:${JSON.stringify(group.title ?? '')} collapsed:${group.collapsed}`;
            },
        };
    }

    async finish() {
        for (const {target, handler} of this.internal) {
            try {
                target.removeListener(handler);
            } catch {}
        }

        this.internal = [];

        await super.finish();
    }

    async close() {
        if (this.win !== null) {
            openedWindows.delete(this.win);
            await browser.windows.remove(this.win).catch(() => {});
            this.win = null;
        }
    }
}
