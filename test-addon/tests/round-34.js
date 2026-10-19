import {ACTION_WAIT, LOAD_WAIT, TIMER_PRECISION} from '../constants.js';
import {wait} from '../test.js';

export const note = `Round 34 - tab.lastAccessed the way the cloud sync reads it: in a trust-cloud merge the stamp
decides whether a local tab absent in the cloud was touched since the last sync or removed on
another device (DESIGN-CLOUD-UPLOAD.md 1 "Keep local tabs since", the gaps in 5). What the stamp
is on a tab created in the background, loaded and born discarded - on the resolved object of
tabs.create, after quiet and LOAD_WAIT later (R34.01); what the active tab of the focused window
and of an unfocused one reports, read twice ACTION_WAIT apart, next to a background tab read the
same way (R34.02); what a tab keeps once it was active and is not any more, and what the tab that
took the focus reports (R34.03); hide, discard of the hidden tabs, show, then the activation of a
discarded tab and the switch back - the calls the add-on makes when it switches groups (R34.04); a
move inside the window, a loaded tab and a hidden + discarded array - the sort of an unloaded group
(R34.05); a move to another window, a loaded tab, a discarded one and a hidden + discarded array
(R34.06); the stamps across a browser restart (R34.07, stops and asks for it).

Every stamp is printed as ms from the moment the scene of the test was ready, next to the clock
read right before and right after it (read a..b) and the brackets of the calls that may have set it
(the creation a..b, the switch a..b, ...), so a verdict needs no tolerance: a stamp inside the
bracket of its own read is the moment of the read, a stamp inside the bracket of a call is the
moment of that call, a stamp equal to the previous reading is unchanged. The one allowance is
TIMER_PRECISION: Date.now() of an extension page is reduced to 1 ms buckets with jitter, so a
bracket is widened by that much on both sides. The ms column of the events block is the harness
clock since the last action row, not the clock of the stamps. The expectations are the facts of
BEHAVIOR-CREATE-TABS.md 58 and BEHAVIOR-MOVE-TABS.md 8.

PRECONDITION for R34.07: about:preferences → Startup → "Open previous windows and tabs" must be ON.`;

const SPECS = ['tabs.onActivated', 'tabs.onMoved', 'tabs.onAttached', 'tabs.onDetached', 'tabs.onUpdated'];
const UPDATED_KEYS = ['hidden', 'discarded'];

const CREATE_TABS = 'BEHAVIOR-CREATE-TABS.md §58';
const MOVE_TABS = 'BEHAVIOR-MOVE-TABS.md §8';

// the clock read right before and right after a call - the bracket a stamp set by the call falls into;
// the bracket is plain numbers: it is kept across a restart in t.data
async function timed(fn) {
    const before = Date.now();
    const result = await fn();
    const after = Date.now();

    return {result, bracket: {before, after}};
}

const inside = (stamp, bracket) => bracket.before - TIMER_PRECISION <= stamp && stamp <= bracket.after + TIMER_PRECISION;

// ms from the moment the scene was ready
const at = (t, value) => `${value >= t.origin ? '+' : ''}${value - t.origin}`;

const span = (t, bracket) => `${at(t, bracket.before)}..${at(t, bracket.after)}`;

// inside the bracket of its own read, inside the bracket of a call that may have set it, equal
// to the previous reading
function verdict(stamp, {read, actions, previous}) {
    const words = [];

    if (inside(stamp, read)) {
        words.push('= the read');
    }

    for (const [label, bracket] of Object.entries(actions)) {
        if (inside(stamp, bracket)) {
            words.push(`= ${label}`);
        }
    }

    if (previous !== null && stamp === previous) {
        words.push('unchanged');
    }

    return words.length ? words.join(', ') : 'other';
}

// one line per reading: the stamp, the brackets it is compared against, the verdict
function report(t, label, name, stamp, {read, actions = {}, previous = null}) {
    const shown = Number.isFinite(stamp) && stamp > 0 ? `${at(t, stamp)} ms` : `raw ${stamp}`;
    const brackets = [
        `read ${span(t, read)}`,
        ...Object.entries(actions).map(([actionLabel, bracket]) => `${actionLabel} ${span(t, bracket)}`),
        ...(previous !== null ? [`previous ${at(t, previous)}`] : []),
    ];
    const words = verdict(stamp, {read, actions, previous});

    t.record('lastAccessed', `${name}: ${shown}  [${label}]  ${brackets.join(', ')}  → ${words}`);

    return {stamp, verdict: words};
}

// tabs.get between two readings of the clock
async function read(t, label, name, {actions = {}, previous = null} = {}) {
    const {result: tab, bracket} = await timed(() => browser.tabs.get(t.id(name)));

    return report(t, label, name, tab.lastAccessed, {read: bracket, actions, previous});
}

// previous: the readings of the same names from before, {name: {stamp}}
async function readAll(t, label, names, {actions = {}, previous = {}} = {}) {
    const readings = {};

    for (const name of names) {
        readings[name] = await read(t, label, name, {actions, previous: previous[name]?.stamp ?? null});
    }

    return readings;
}

// the verdicts of one reading against the fact, in the order of the expected names
function expectVerdicts(t, label, readings, expected) {
    const got = Object.fromEntries(Object.keys(expected).map(name => [name, readings[name]?.verdict ?? 'not read']));

    t.expect(label, got, expected);
}

// a step whose call is bracketed by the clock; atResolve runs right after the call, before quiet
async function stepTimed(t, text, fn, {snap, atResolve = null}) {
    let bracket;

    await t.step(text, async () => {
        ({bracket} = await timed(fn));

        await atResolve?.(bracket);
    }, {snap});

    return bracket;
}

async function flags(t, name) {
    const tab = await browser.tabs.get(t.id(name));

    return `window ${tab.windowId === t.win ? 'A' : 'B'}, index ${tab.index}, active ${tab.active}, discarded ${tab.discarded}, hidden ${tab.hidden}, status ${tab.status}`;
}

async function requireUnloaded(t, names, {hidden}) {
    for (const name of names) {
        const tab = await browser.tabs.get(t.id(name));

        t.require(`${name} is discarded${hidden ? ' and hidden' : ''} before the readings`, tab.discarded && tab.hidden === hidden, await flags(t, name));
    }
}

export const tests = [

{
    id: 'R34.01',
    title: 'a tab created in the background, loaded and born discarded - the stamp on the resolved object of tabs.create, after quiet and LOAD_WAIT later',
    async run(t) {
        await t.scene(['keep']);
        t.origin = Date.now();

        // status is kept: the load of the created tab has to show between the readings
        t.watch(['tabs.onCreated', 'tabs.onUpdated'], {updatedKeys: [...UPDATED_KEYS, 'status']});
        await t.snap('before');

        for (const [name, properties, text] of [['born', {}, ''], ['lazy', {discarded: true}, ', discarded: true']]) {
            let resolved;

            const creation = await stepTimed(t, `tabs.create({url: ${name}, active: false${text}})`, async () => {
                const tab = await t.create(name, properties);
                resolved = tab.lastAccessed;
            }, {
                snap: `${name} created`,
                // the read is the create call itself
                atResolve: bracket => {
                    resolved = report(t, 'the resolved object', name, resolved, {read: bracket, actions: {'the creation': bracket}});
                },
            });

            const afterQuiet = await read(t, 'after quiet', name, {actions: {'the creation': creation}, previous: resolved.stamp});

            await wait(LOAD_WAIT);
            const later = await read(t, `${LOAD_WAIT} ms later`, name, {actions: {'the creation': creation}, previous: afterQuiet.stamp});

            t.note(`${name}: ${await flags(t, name)}`);

            t.expect(`${name}: the stamp is the moment of the creation, on the resolved object already, and the load does not move it (${CREATE_TABS})`,
                [resolved.verdict, afterQuiet.verdict, later.verdict],
                ['= the read, = the creation', '= the creation, unchanged', '= the creation, unchanged']);
        }

        t.expectRow('born created', ['keep*', '➕born']);
        t.expectRow('lazy created', ['keep*', '➕born', '➕lazy']);
    },
},

{
    id: 'R34.02',
    title: 'the active tab of the focused window and of an unfocused one, read twice ACTION_WAIT apart, next to a background tab read the same way',
    async run(t) {
        const {bracket: scene} = await timed(() => t.scene(['a', 'b']));
        t.origin = Date.now();

        // the window that takes the focus: the moment A lost it is the alternative to "reads as now" for a
        const {result: winB, bracket: building} = await timed(() => t.buildWindow(['c']));
        t.trackWindow(winB);

        await t.snap('scene (window A)');
        await t.snapWindow('scene (window B)', winB);

        const focusedA = (await browser.windows.get(t.win)).focused;
        const focusedB = (await browser.windows.get(winB)).focused;

        const names = ['a', 'b', 'c'];
        const actions = {'the scene build': scene, 'window B built': building};
        let first, second;

        await t.step(`tabs.get(a), tabs.get(b), tabs.get(c)  // twice, ACTION_WAIT apart; a active in A, c active in B, b in the background; window A focused: ${focusedA}, window B focused: ${focusedB}`, async () => {
            first = await readAll(t, 'first read', names, {actions});

            await wait(ACTION_WAIT);
            second = await readAll(t, `second read, ${ACTION_WAIT} ms later`, names, {actions, previous: first});
        }, {wait: 0, snap: false});

        t.expect('window B took the focus, window A lost it', [focusedA, focusedB], [false, true]);
        expectVerdicts(t, `the active tab reads as the moment of the read, in the unfocused window A too; the background tab keeps its creation (${CREATE_TABS})`, first, {a: '= the read', b: '= the scene build', c: '= the read'});
        expectVerdicts(t, `the same ${ACTION_WAIT} ms later (${CREATE_TABS})`, second, {a: '= the read', b: '= the scene build, unchanged', c: '= the read'});
        t.expectRow('scene (window A)', ['a*', 'b']);
        t.expectRow('scene (window B)', ['c*']);
    },
},

{
    id: 'R34.03',
    title: 'a tab that was active and is not any more - what it keeps, and what the tab that took the focus reports; read after quiet and ACTION_WAIT later',
    async run(t) {
        await t.scene(['a', 'b']);
        t.origin = Date.now();

        t.watch(SPECS, {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        const names = ['a', 'b'];
        let readings = await readAll(t, 'before', names);

        for (const [name, other, label] of [['b', 'a', 'b active'], ['a', 'b', 'a active again']]) {
            const switching = await stepTimed(t, `tabs.update(${name}, {active: true})`, () => t.activate(name, {settle: false}), {snap: label});
            const actions = {[`the switch to ${name}`]: switching};

            readings = await readAll(t, label, names, {actions, previous: readings});
            expectVerdicts(t, `${label}: ${other} keeps the moment of the switch, ${name} reads as the moment of the read (${CREATE_TABS})`, readings, {[name]: '= the read', [other]: `= the switch to ${name}`});

            await wait(ACTION_WAIT);
            readings = await readAll(t, `${label}, ${ACTION_WAIT} ms later`, names, {actions, previous: readings});
            expectVerdicts(t, `${label}, ${ACTION_WAIT} ms later: the same, ${other} unchanged (${CREATE_TABS})`, readings, {[name]: '= the read', [other]: `= the switch to ${name}, unchanged`});
        }

        t.expectRow('b active', ['a', 'b*']);
        t.expectRow('a active again', ['a*', 'b']);
    },
},

{
    id: 'R34.04',
    title: 'hide, discard of the hidden tabs, show, then the activation of a discarded tab and the switch back - the calls the add-on makes when it switches groups',
    async run(t) {
        await t.scene(['keep', 'a', 'b']);
        t.origin = Date.now();

        t.watch(SPECS, {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        const names = ['a', 'b'];
        const unchanged = {a: 'unchanged', b: 'unchanged'};
        let readings = await readAll(t, 'before', names);

        const hide = await stepTimed(t, 'tabs.hide([a, b])', () => t.hide(names, {settle: false}), {snap: 'hidden'});
        readings = await readAll(t, 'hidden', names, {actions: {'the hide': hide}, previous: readings});
        expectVerdicts(t, `hide leaves the stamps as they are (${CREATE_TABS})`, readings, unchanged);

        const discard = await stepTimed(t, 'tabs.discard([a, b])  // hidden and discarded, an unloaded group', () => browser.tabs.discard(t.ids(names)), {snap: 'hidden and discarded'});
        await requireUnloaded(t, names, {hidden: true});
        readings = await readAll(t, 'hidden and discarded', names, {actions: {'the discard': discard}, previous: readings});
        expectVerdicts(t, `discard leaves the stamps as they are (${CREATE_TABS})`, readings, unchanged);

        const show = await stepTimed(t, 'tabs.show([a, b])', () => t.show(names, {settle: false}), {snap: 'shown'});
        readings = await readAll(t, 'shown', names, {actions: {'the show': show}, previous: readings});
        expectVerdicts(t, `show leaves the stamps as they are (${CREATE_TABS})`, readings, unchanged);

        // the switch of a group ends with an activation; a discarded tab loads at it
        const toA = await stepTimed(t, 'tabs.update(a, {active: true})  // a discarded tab loads', () => t.activate('a', {settle: false}), {snap: 'a active'});
        readings = await readAll(t, 'a active', names, {actions: {'the switch to a': toA}, previous: readings});
        expectVerdicts(t, `the activated discarded tab reads as the moment of the read, the other one is unchanged (${CREATE_TABS})`, readings, {a: '= the read', b: 'unchanged'});

        await wait(ACTION_WAIT);
        readings = await readAll(t, `a active, ${ACTION_WAIT} ms later`, names, {actions: {'the switch to a': toA}, previous: readings});
        expectVerdicts(t, `the same ${ACTION_WAIT} ms later (${CREATE_TABS})`, readings, {a: '= the read', b: 'unchanged'});

        const toKeep = await stepTimed(t, 'tabs.update(keep, {active: true})', () => t.activate('keep', {settle: false}), {snap: 'keep active again'});
        readings = await readAll(t, 'keep active again', names, {actions: {'the switch to keep': toKeep}, previous: readings});
        expectVerdicts(t, `the tab that lost the focus keeps the moment of the switch, the never activated one is unchanged (${CREATE_TABS})`, readings, {a: '= the switch to keep', b: 'unchanged'});

        await wait(ACTION_WAIT);
        readings = await readAll(t, `keep active again, ${ACTION_WAIT} ms later`, names, {actions: {'the switch to keep': toKeep}, previous: readings});
        expectVerdicts(t, `the same ${ACTION_WAIT} ms later (${CREATE_TABS})`, readings, {a: '= the switch to keep, unchanged', b: 'unchanged'});

        for (const name of names) {
            t.note(`${name}: ${await flags(t, name)}`);
        }

        t.expectRow('hidden', ['keep*', 'a(h)', 'b(h)']);
        t.expectRow('hidden and discarded', ['keep*', 'a(h)', 'b(h)']);
        t.expectRow('shown', ['keep*', 'a', 'b']);
        t.expectRow('a active', ['keep', 'a*', 'b']);
        t.expectRow('keep active again', ['keep*', 'a', 'b']);
    },
},

{
    id: 'R34.05',
    title: 'a move inside the window - a loaded tab to the end, then a hidden + discarded array to the end: the sort of an unloaded group',
    async run(t) {
        await t.scene(['keep', 'a', 'b', 'c']);
        t.origin = Date.now();

        await t.hide(['b', 'c']);
        await browser.tabs.discard(t.ids(['b', 'c']));
        await t.settled();
        await requireUnloaded(t, ['b', 'c'], {hidden: true});

        t.watch(SPECS, {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        const names = ['a', 'b', 'c'];
        let readings = await readAll(t, 'before', names);

        for (const {movers, text, label} of [
            {movers: ['a'], text: 'tabs.move([a], {index: -1})  // loaded', label: 'a moved'},
            {movers: ['b', 'c'], text: 'tabs.move([b, c], {index: -1})  // hidden and discarded', label: 'b, c moved'},
        ]) {
            const move = await stepTimed(t, text, () => browser.tabs.move(t.ids(movers), {index: -1}), {snap: label});
            const moved = await readAll(t, label, movers, {actions: {'the move': move}, previous: readings});

            readings = {...readings, ...moved};
            expectVerdicts(t, `${label} inside the window: the stamps are unchanged (${MOVE_TABS})`, moved, Object.fromEntries(movers.map(name => [name, 'unchanged'])));
        }

        await wait(LOAD_WAIT);
        const later = await readAll(t, `${LOAD_WAIT} ms later`, names, {previous: readings});
        expectVerdicts(t, `${LOAD_WAIT} ms later: still unchanged (${MOVE_TABS})`, later, {a: 'unchanged', b: 'unchanged', c: 'unchanged'});

        t.expectRow('a moved', ['keep*', 'b(h)', 'c(h)', 'a']);
        t.expectRow('b, c moved', ['keep*', 'a', 'b(h)', 'c(h)']);
    },
},

{
    id: 'R34.06',
    title: 'a move to another window - a loaded tab, a discarded one, a hidden + discarded array: the stamp at the resolve, after quiet and LOAD_WAIT later',
    async run(t) {
        await t.scene(['keep', 'a', 'b', 'c', 'd']);
        t.origin = Date.now();

        const winB = await t.buildWindow(['keepB']);
        t.trackWindow(winB);

        await browser.tabs.discard(t.id('b'));
        await t.hide(['c', 'd']);
        await browser.tabs.discard(t.ids(['c', 'd']));
        await t.settled();
        await requireUnloaded(t, ['b'], {hidden: false});
        await requireUnloaded(t, ['c', 'd'], {hidden: true});

        t.watch(SPECS, {updatedKeys: UPDATED_KEYS});
        t.note('the tabs.onUpdated and tabs.onActivated lines are those of window A: the formatters keep the scene window only, the arrivals in window B are read by tabs.get');
        await t.snap('before (window A)');
        await t.snapWindow('before (window B)', winB);

        const names = ['a', 'b', 'c', 'd'];
        let readings = await readAll(t, 'before', names);

        for (const {movers, text, label, expected} of [
            {movers: ['a'], text: 'tabs.move([a], {windowId: B, index: -1})  // loaded', label: 'a moved', expected: {atResolve: {a: '= the move'}, later: {a: '= the move, unchanged'}, what: 'a loaded tab gets the moment of the move'}},
            {movers: ['b'], text: 'tabs.move([b], {windowId: B, index: -1})  // discarded', label: 'b moved', expected: {atResolve: {b: 'unchanged'}, later: {b: 'unchanged'}, what: 'a discarded tab keeps its stamp'}},
            {movers: ['c', 'd'], text: 'tabs.move([c, d], {windowId: B, index: -1})  // hidden and discarded', label: 'c, d moved', expected: {atResolve: {c: 'unchanged', d: 'unchanged'}, later: {c: 'unchanged', d: 'unchanged'}, what: 'a hidden + discarded array keeps its stamps'}},
        ]) {
            let atResolve;

            const move = await stepTimed(t, text, () => browser.tabs.move(t.ids(movers), {windowId: winB, index: -1}), {
                snap: `${label} (window A)`,
                atResolve: async bracket => {
                    atResolve = await readAll(t, `${label}, at the resolve`, movers, {actions: {'the move': bracket}, previous: readings});
                    readings = {...readings, ...atResolve};
                },
            });

            await t.snapWindow(`${label} (window B)`, winB);

            const afterQuiet = await readAll(t, `${label}, after quiet`, movers, {actions: {'the move': move}, previous: readings});
            readings = {...readings, ...afterQuiet};

            await wait(LOAD_WAIT);
            const later = await readAll(t, `${label}, ${LOAD_WAIT} ms later`, movers, {actions: {'the move': move}, previous: readings});
            readings = {...readings, ...later};

            for (const name of movers) {
                t.note(`${name} after the move: ${await flags(t, name)}`);
            }

            expectVerdicts(t, `${label} to another window, at the resolve: ${expected.what} (${MOVE_TABS})`, atResolve, expected.atResolve);
            expectVerdicts(t, `${label}, after quiet (${MOVE_TABS})`, afterQuiet, expected.later);
            expectVerdicts(t, `${label}, ${LOAD_WAIT} ms later (${MOVE_TABS})`, later, expected.later);
        }

        t.expectRow('a moved (window A)', ['keep*', 'b', 'c(h)', 'd(h)']);
        t.expectRow('a moved (window B)', ['keepB*', 'a']);
        t.expectRow('b moved (window A)', ['keep*', 'c(h)', 'd(h)']);
        t.expectRow('b moved (window B)', ['keepB*', 'a', 'b']);
        t.expectRow('c, d moved (window A)', ['keep*']);
        t.expectRow('c, d moved (window B)', ['keepB*', 'a', 'b', 'c(h)', 'd(h)']);
    },
},

{
    id: 'R34.07',
    title: 'the stamps across a browser restart - a tab that was active once, a tab never activated, and the active one; stops and asks for the restart',
    async run(t) {
        const {bracket: scene} = await timed(() => t.scene(['a', 'b', 'c']));
        t.origin = Date.now();

        // b carries the stamp of its deactivation, c the stamp of its creation, a reads as now
        await t.activate('b');
        const {bracket: toA} = await timed(() => t.activate('a'));

        await t.snap('before the restart');

        t.data.origin = t.origin;
        t.data.actions = {'the scene build': scene, 'the switch to a': toA};
        t.data.readings = await readAll(t, 'before the restart', ['a', 'b', 'c'], {actions: t.data.actions});

        expectVerdicts(t, `before the restart: a reads as the moment of the read, b keeps the switch, c its creation (${CREATE_TABS})`, t.data.readings, {a: '= the read', b: '= the switch to a', c: '= the scene build'});

        await t.restart();
    },
    async afterRestart(t) {
        t.origin = t.data.origin;

        t.note(`after the restart: now is ${at(t, Date.now())} ms`);

        await t.snap('after the restart');

        const readings = await readAll(t, 'after the restart', ['a', 'b', 'c'], {actions: t.data.actions, previous: t.data.readings});

        for (const name of ['a', 'b', 'c']) {
            t.note(`${name}: ${await flags(t, name)}`);
        }

        expectVerdicts(t, `after the restart: the stamps of b and c survived, a reads as the moment of the read (${CREATE_TABS})`, readings, {a: '= the read', b: '= the switch to a, unchanged', c: '= the scene build, unchanged'});
        t.expectRow('after the restart', ['a*', 'b', 'c']);
    },
},

];
