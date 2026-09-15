import {TAB_GROUP_ID_NONE} from '../constants.js';

export const note = `Round 26 — the calls Tabs.hide / Tabs.remove / Tabs.recreate make, recorded as TABGROUPS-BEHAVIOR.md §22–§26.
(A) tabs.ungroup on a tab that is in NO group — alone (R26.01) and mixed with a member (R26.02);
on a PINNED tab — alone (R26.03) and mixed with a member (R26.04), the odd tab second in both arrays:
does the call resolve or reject, what happens to the member next to it, which events fire (§22);
(B) tabs.group({tabIds, groupId}) joining an EXISTING group — §3 covers creation only: where the joined
tab lands from right before the span (R26.05), from right after it (R26.06), from far before it (R26.07),
what a join of a tab that already IS a member does (R26.08), and where an ARRAY from both sides of the
span lands and in which order (R26.13) — the shape Tabs.recreate and the native mirror use (§23);
(C) tabs.hide on an already hidden tab — alone and mixed with a visible one (R26.09): the resolved ids, events (§24);
(D) tabs.create at the slot of a SINGLE-member span (R26.10) — §7 verified the first-member boundary on
two-member spans only (§25);
(E) MANUAL: does the browser keep a saved group when every member of a live group is closed by ONE
tabs.remove (R26.11), when the members are ungrouped first (R26.12), when they are closed one by one
(R26.14), and the positive control — a window with a live group closed by windows.remove (R26.15) (§26).
A saved group has no API and no event: the answer is the "List all tabs" menu. Every saved group these
tests leave behind is deleted by hand, before the answer is given.`;

const WATCH = [
    'tabs.onMoved', 'tabs.onUpdated', 'tabs.onRemoved',
    'tabGroups.onCreated', 'tabGroups.onUpdated', 'tabGroups.onMoved', 'tabGroups.onRemoved',
];
const UPDATED_KEYS = ['groupId', 'hidden', 'pinned'];

const SAVED_GROUP_QUESTION = name => `Is there a SAVED (closed) tab group named "${name}" in the "List all tabs" menu (the ⌄ button at the right end of the tab strip) or anywhere else the browser lists tab groups? Say where you looked and what you saw. If it is there, delete it by hand FIRST, then answer`;

async function outcome(call) {
    try {
        return {ok: true, value: await call()};
    } catch (error) {
        return {ok: false, error: String(error)};
    }
}

function noteOutcome(t, label, result) {
    t.note(result.ok ? `${label} resolved${result.value === undefined ? '' : ` with ${JSON.stringify(result.value)}`}` : `${label} REJECTED: ${result.error}`);
}

function noteJoin(t, result) {
    t.note(result.ok ? `tabs.group resolved with group ${t.square(result.value) || result.value}` : `tabs.group REJECTED: ${result.error}`);
}

async function noteTab(t, name) {
    const tab = await browser.tabs.get(t.id(name));
    t.note(`${name}: index:${tab.index} group:${t.square(tab.groupId) || tab.groupId} hidden:${tab.hidden} pinned:${tab.pinned}`);
}

async function noteGroups(t) {
    t.note(`groups: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
}

async function pin(t, names) {
    for (const name of names) {
        await browser.tabs.update(t.id(name), {pinned: true});
    }

    await t.settled();

    const tabs = await Promise.all(t.ids(names).map(id => browser.tabs.get(id)));

    t.require(
        `setup: [${names.join(', ')}] pinned at [${names.map((name, index) => index).join(', ')}]`,
        tabs.every((tab, index) => tab.pinned && tab.index === index),
        tabs.map(tab => `${t.nameOf(tab)}: pinned:${tab.pinned} index:${tab.index}`).join(', '),
    );
}

async function requireHidden(t, names) {
    const tabs = await t.query();
    const hidden = names.filter(name => tabs.find(tab => t.nameOf(tab) === name)?.hidden);

    t.require('setup: tabs are hidden', hidden.length === names.length, `hidden: [${hidden.join(', ')}] of [${names.join(', ')}]`);
}

export const tests = [

{
    id: 'R26.01',
    title: 'tabs.ungroup([b]) — b is in no group: resolve or reject, events, position',
    async run(t) {
        await t.scene(['a', 'b', 'c']);

        t.watch(WATCH, {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        const result = await t.step('tabs.ungroup([b])  — b is in no group', () => outcome(() => browser.tabs.ungroup([t.id('b')])));

        noteOutcome(t, 'tabs.ungroup', result);
        await noteTab(t, 'b');

        t.expectRow('after', ['a*', 'b', 'c']);
        t.expect('the call resolved', result.ok, true);
    },
},

{
    id: 'R26.02',
    title: 'tabs.ungroup([gr2, y]) — a member and an outsider in one call',
    async run(t) {
        await t.scene(['x', 'gr1', 'gr2', 'y']);
        await t.group(['gr1', 'gr2'], {title: 'G'});

        t.watch(WATCH, {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        const result = await t.step('tabs.ungroup([gr2, y])  — gr2 is a member, y is not', () => outcome(() => browser.tabs.ungroup(t.ids(['gr2', 'y']))));

        noteOutcome(t, 'tabs.ungroup', result);
        await noteTab(t, 'gr2');
        await noteTab(t, 'y');
        await noteGroups(t);

        t.expectRow('after', ['x*', '🟥 gr1', 'gr2', 'y']);
        t.expect('the call resolved, the member left, the outsider stayed', result.ok, true);
    },
},

{
    id: 'R26.03',
    title: 'tabs.ungroup([p1]) — p1 is pinned and in no group',
    async run(t) {
        await t.scene(['p1', 'a', 'b']);
        await pin(t, ['p1']);

        t.watch(WATCH, {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        const result = await t.step('tabs.ungroup([p1])  — p1 is pinned', () => outcome(() => browser.tabs.ungroup([t.id('p1')])));

        noteOutcome(t, 'tabs.ungroup', result);
        await noteTab(t, 'p1');

        t.expectRow('after', ['p1*(p)', 'a', 'b']);
        t.expect('the call resolved', result.ok, true);
    },
},

{
    id: 'R26.04',
    title: 'tabs.ungroup([gr2, p1]) — a member and a pinned outsider in one call, the odd tab second as in R26.02',
    async run(t) {
        await t.scene(['p1', 'x', 'gr1', 'gr2']);
        await pin(t, ['p1']);
        await t.group(['gr1', 'gr2'], {title: 'G'});

        t.watch(WATCH, {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        const result = await t.step('tabs.ungroup([gr2, p1])  — gr2 is a member, p1 is pinned', () => outcome(() => browser.tabs.ungroup(t.ids(['gr2', 'p1']))));

        noteOutcome(t, 'tabs.ungroup', result);
        await noteTab(t, 'gr2');
        await noteTab(t, 'p1');
        await noteGroups(t);

        t.expectRow('after', ['p1*(p)', 'x', '🟥 gr1', 'gr2']);
        t.expect('the call resolved, the member left, the pinned tab stayed', result.ok, true);
    },
},

{
    id: 'R26.05',
    title: 'tabs.group({tabIds: [x], groupId}) — x stands right BEFORE the span: where it lands',
    async run(t) {
        await t.scene(['k', 'x', 'gr1', 'gr2', 'y']);
        const groupId = await t.group(['gr1', 'gr2'], {title: 'G'});

        t.watch(WATCH, {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        const result = await t.step('tabs.group({tabIds: [x], groupId: 🟥})  — x is right before the first member', () => {
            return outcome(() => t.joinGroup(['x'], groupId, {settle: false}));
        });

        noteJoin(t, result);
        await noteTab(t, 'x');
        await noteGroups(t);

        t.expectRow('after', ['k*', '🟥 x', '🟥 gr1', '🟥 gr2', 'y']);
        t.expect('joined in place, the same group', [result.ok, result.value], [true, groupId]);
    },
},

{
    id: 'R26.06',
    title: 'tabs.group({tabIds: [y], groupId}) — y stands right AFTER the span: where it lands',
    async run(t) {
        await t.scene(['k', 'gr1', 'gr2', 'y', 'z']);
        const groupId = await t.group(['gr1', 'gr2'], {title: 'G'});

        t.watch(WATCH, {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        const result = await t.step('tabs.group({tabIds: [y], groupId: 🟥})  — y is right after the last member', () => {
            return outcome(() => t.joinGroup(['y'], groupId, {settle: false}));
        });

        noteJoin(t, result);
        await noteTab(t, 'y');
        await noteGroups(t);

        t.expectRow('after', ['k*', '🟥 gr1', '🟥 gr2', '🟥 y', 'z']);
        t.expect('joined in place, the same group', [result.ok, result.value], [true, groupId]);
    },
},

{
    id: 'R26.07',
    title: 'tabs.group({tabIds: [x], groupId}) — x stands two tabs BEFORE the span: where it lands',
    async run(t) {
        await t.scene(['x', 'k1', 'k2', 'gr1', 'gr2', 'y']);
        const groupId = await t.group(['gr1', 'gr2'], {title: 'G'});

        t.watch(WATCH, {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        const result = await t.step('tabs.group({tabIds: [x], groupId: 🟥})  — two outsiders between x and the span', () => {
            return outcome(() => t.joinGroup(['x'], groupId, {settle: false}));
        });

        noteJoin(t, result);
        await noteTab(t, 'x');
        await noteGroups(t);

        t.expectRow('after', ['k1', 'k2', '🟥 x*', '🟥 gr1', '🟥 gr2', 'y']);
        t.expect('pulled to the near edge of the span, the same group', [result.ok, result.value], [true, groupId]);
    },
},

{
    id: 'R26.08',
    title: 'tabs.group({tabIds: [gr1], groupId}) — gr1 already IS a member of that group',
    async run(t) {
        await t.scene(['k', 'gr1', 'gr2', 'gr3', 'y']);
        const groupId = await t.group(['gr1', 'gr2', 'gr3'], {title: 'G'});

        t.watch(WATCH, {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        const result = await t.step('tabs.group({tabIds: [gr1], groupId: 🟥})  — gr1 is the first member already', () => {
            return outcome(() => t.joinGroup(['gr1'], groupId, {settle: false}));
        });

        noteJoin(t, result);
        await noteTab(t, 'gr1');

        const again = await t.step('tabs.group({tabIds: [gr2], groupId: 🟥})  — gr2 is also a member already', () => {
            return outcome(() => t.joinGroup(['gr2'], groupId, {settle: false}));
        });

        noteJoin(t, again);
        await noteTab(t, 'gr2');
        await noteGroups(t);

        t.expectRow('after', ['k*', '🟥 gr1', '🟥 gr2', '🟥 gr3', 'y']);
        t.expectRow('after 2', ['k*', '🟥 gr1', '🟥 gr2', '🟥 gr3', 'y']);
        t.expect('both joins resolved with the same group and moved nothing', [result.ok, result.value, again.ok, again.value], [true, groupId, true, groupId]);
    },
},

{
    id: 'R26.13',
    title: 'tabs.group({tabIds: [y, x], groupId}) — an ARRAY from both sides of the span, reversed on purpose: where and in which order',
    async run(t) {
        await t.scene(['k', 'x', 'gr1', 'gr2', 'y']);
        const groupId = await t.group(['gr1', 'gr2'], {title: 'G'});

        t.watch(WATCH, {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        const result = await t.step('tabs.group({tabIds: [y, x], groupId: 🟥})  — y after the span, x before it, y first in the array', () => {
            return outcome(() => t.joinGroup(['y', 'x'], groupId, {settle: false}));
        });

        noteJoin(t, result);
        await noteTab(t, 'x');
        await noteTab(t, 'y');
        await noteGroups(t);

        t.expectRow('after', ['k*', '🟥 x', '🟥 gr1', '🟥 gr2', '🟥 y']);
        t.expect('both joined in place, the same group', [result.ok, result.value], [true, groupId]);
    },
},

{
    id: 'R26.09',
    title: 'tabs.hide of an already hidden tab — alone, then mixed with a visible one',
    async run(t) {
        await t.scene(['a', 'b', 'c']);
        await t.hide(['b']);
        await requireHidden(t, ['b']);

        t.watch(WATCH, {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        const alone = await t.step('tabs.hide([b])  — b is hidden already', () => outcome(() => browser.tabs.hide([t.id('b')])));

        noteOutcome(t, 'tabs.hide', alone);
        alone.ok && t.note(`hidden by the call: [${alone.value.map(id => t.known(id)).join(', ')}]`);

        const mixed = await t.step('tabs.hide([b, c])  — b hidden, c visible', () => outcome(() => browser.tabs.hide(t.ids(['b', 'c']))));

        noteOutcome(t, 'tabs.hide', mixed);
        mixed.ok && t.note(`hidden by the call: [${mixed.value.map(id => t.known(id)).join(', ')}]`);
        t.note(`hidden flags: ${await t.hiddenFlags()}`);

        t.expectRow('after', ['a*', 'b(h)', 'c']);
        t.expectRow('after 2', ['a*', 'b(h)', 'c(h)']);
        t.expect('a hidden tab alone: resolved with nothing', [alone.ok, alone.value], [true, []]);
        t.expect('mixed: resolved with the visible tab only', [mixed.ok, mixed.value?.map(id => t.known(id))], [true, ['c']]);
    },
},

{
    id: 'R26.10',
    title: 'tabs.create at the slot of a SINGLE-member span — boundary or inside?',
    async run(t) {
        await t.scene(['x', 'gr1', 'y']);
        await t.group(['gr1'], {title: 'G'});

        t.watch(['tabs.onCreated', 'tabs.onUpdated', 'tabs.onMoved', 'tabGroups.onCreated', 'tabGroups.onUpdated'], {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        const created = await t.step('tabs.create(new1, {index: 1})  — that slot held 🟥 gr1, the only member', () => {
            return t.create('new1', {index: 1});
        });

        const fresh = await browser.tabs.get(created.id);
        t.note(`new1: index:${fresh.index} group:${t.square(fresh.groupId) || fresh.groupId}`);

        t.expectRow('after', ['x*', '➕new1', '🟥 gr1', 'y']);
        t.expect('landed before the span, no membership', [fresh.index, fresh.groupId], [1, TAB_GROUP_ID_NONE]);
    },
},

{
    id: 'R26.11',
    title: 'MANUAL: every member of a live group closed by ONE tabs.remove — does the browser keep a saved group?',
    async run(t) {
        await t.scene(['keep', 'gr1', 'gr2']);
        await t.group(['gr1', 'gr2'], {title: 'SAVED-BY-ONE-REMOVE'});

        t.watch(WATCH, {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        const result = await t.step('tabs.remove([gr1, gr2])  — the whole span in one call', () => outcome(() => browser.tabs.remove(t.ids(['gr1', 'gr2']))));

        noteOutcome(t, 'tabs.remove', result);
        await noteGroups(t);

        t.expectRow('after', ['keep*']);
        t.expect('the call resolved, no live group left', [result.ok, (await t.groupsInfo()).length], [true, 0]);

        await t.ask(SAVED_GROUP_QUESTION('SAVED-BY-ONE-REMOVE'));
    },
},

{
    id: 'R26.12',
    title: 'MANUAL: the members ungrouped first, then closed by one tabs.remove — control for R26.11',
    async run(t) {
        await t.scene(['keep', 'gr1', 'gr2']);
        await t.group(['gr1', 'gr2'], {title: 'SAVED-BY-UNGROUP'});

        t.watch(WATCH, {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        await t.step('tabs.ungroup([gr1, gr2])', () => browser.tabs.ungroup(t.ids(['gr1', 'gr2'])));

        const result = await t.step('tabs.remove([gr1, gr2])  — no group any more', () => outcome(() => browser.tabs.remove(t.ids(['gr1', 'gr2']))));

        noteOutcome(t, 'tabs.remove', result);
        await noteGroups(t);

        t.expectRow('after', ['keep*', 'gr1', 'gr2']);
        t.expectRow('after 2', ['keep*']);
        t.expect('the call resolved', result.ok, true);

        await t.ask(SAVED_GROUP_QUESTION('SAVED-BY-UNGROUP'));
    },
},

{
    id: 'R26.14',
    title: 'MANUAL: the members closed ONE BY ONE, two tabs.remove calls — does "in one call" matter?',
    async run(t) {
        await t.scene(['keep', 'gr1', 'gr2']);
        await t.group(['gr1', 'gr2'], {title: 'SAVED-BY-TWO-REMOVES'});

        t.watch(WATCH, {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        const first = await t.step('tabs.remove([gr1])  — the first member alone', () => outcome(() => browser.tabs.remove([t.id('gr1')])));

        noteOutcome(t, 'tabs.remove', first);

        const last = await t.step('tabs.remove([gr2])  — the last member, the group dies now', () => outcome(() => browser.tabs.remove([t.id('gr2')])));

        noteOutcome(t, 'tabs.remove', last);
        await noteGroups(t);

        t.expectRow('after', ['keep*', '🟥 gr2']);
        t.expectRow('after 2', ['keep*']);
        t.expect('both calls resolved, no live group left', [first.ok, last.ok, (await t.groupsInfo()).length], [true, true, 0]);

        await t.ask(SAVED_GROUP_QUESTION('SAVED-BY-TWO-REMOVES'));
    },
},

{
    id: 'R26.15',
    title: 'MANUAL: a WINDOW with a live group closed by windows.remove — the positive control: where a saved group shows up',
    async run(t) {
        await t.scene(['keep']);

        const windowId = await t.buildWindow(['g1', 'g2']);
        const groupId = await browser.tabs.group({tabIds: t.ids(['g1', 'g2']), createProperties: {windowId}});

        await browser.tabGroups.update(groupId, {title: 'SAVED-BY-WINDOW-CLOSE'});
        await t.settled();
        await t.snapWindow('before (window 2)', windowId);

        await t.step('windows.remove(window 2)  — a live group inside', () => browser.windows.remove(windowId), {snap: false});

        const alive = Boolean(await browser.windows.get(windowId).catch(() => null));
        t.note(`window 2 still exists: ${alive}`);
        t.expect('window 2 is gone', alive, false);

        await t.ask(SAVED_GROUP_QUESTION('SAVED-BY-WINDOW-CLOSE'));
    },
},

];
