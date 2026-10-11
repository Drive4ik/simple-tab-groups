import {LOAD_WAIT} from '../constants.js';
import {wait} from '../test.js';

export const note = `Round 32 - sessions.setTabValue values of a tab across tabs.move: a LOADED tab moved to
another window, the control (R32.01); a DISCARDED tab moved to another window, then loaded by
activation (R32.02); a discarded tab moved inside its own window (R32.03); three HIDDEN + DISCARDED
tabs moved to another window as an array with the values written again right at the resolve of
the move - an unloaded group of the add-on and the repair Tabs.moveNative makes in tabs.js,
"fixing session after move" (R32.04); a discarded tab moved to another window, repaired at the
resolve and moved back (R32.05); a tab BORN discarded, never loaded, moved to another window and
then loaded (R32.06). Two keys per tab, the way the add-on keeps the group of a tab and its
favicon. The values are read right at the resolve of tabs.move, once the browser went quiet and
LOAD_WAIT later, so a value that is late is told from a value that is lost; a repair at the
resolve is read the same three times. Cross-window moves use {windowId, index: -1}. The
expectations are the fact of BEHAVIOR-MOVE-TABS.md 7.`;

const KEYS = ['key1', 'key2'];

const valueOf = (name, key) => `${name}-${key}`;
const expectedValues = name => KEYS.map(key => JSON.stringify(valueOf(name, key))).join(', ');
const ABSENT = KEYS.map(() => 'absent').join(', ');

async function setValues(t, name) {
    for (const key of KEYS) {
        await browser.sessions.setTabValue(t.id(name), key, valueOf(name, key));
    }
}

async function readValues(t, name) {
    const values = [];

    for (const key of KEYS) {
        values.push(await browser.sessions.getTabValue(t.id(name), key).then(
            value => value === undefined ? 'absent' : JSON.stringify(value),
            error => `rejected: ${error.message.replace(/\d+/g, 'N')}`,
        ));
    }

    return values.join(', ');
}

// the movers get their values and the state asked for; the move, with the values read right at
// its resolve and, when asked, written again there; the values read after quiet and LOAD_WAIT
// later; then the extra steps a test asks for - a load, a late repair, a move back
async function moveAndRead(t, {movers, discard = false, hide = false, bornDiscarded = false, crossWindow = true, repairAtResolve = false, load = false, back = false}) {
    await t.scene(bornDiscarded ? ['keepA'] : ['keepA', ...movers]);

    if (bornDiscarded) {
        for (const name of movers) {
            await t.create(name, {discarded: true});
        }

        await t.settled();
    }

    const winB = crossWindow ? await t.buildWindow(['keepB']) : null;
    const where = windowId => windowId === t.win ? 'A' : windowId === winB ? 'B' : 'other window';
    const flags = async name => {
        const tab = await browser.tabs.get(t.id(name));
        return `window ${where(tab.windowId)}, index ${tab.index}, discarded ${tab.discarded}, hidden ${tab.hidden}`;
    };
    const discarded = discard || bornDiscarded;

    for (const name of movers) {
        await setValues(t, name);
    }

    if (hide) {
        await t.hide(movers);
    }

    if (discard) {
        await browser.tabs.discard(t.ids(movers));
        await t.settled();
    }

    for (const name of movers) {
        const tab = await browser.tabs.get(t.id(name));
        const before = await readValues(t, name);

        t.require(`${name} is ${discarded ? 'discarded' : 'loaded'}${hide ? ' and hidden' : ''} before the move`, tab.discarded === discarded && tab.hidden === hide, await flags(name));
        t.require(`${name}: the values are set before the move`, before === expectedValues(name), before);
    }

    t.watch(['tabs.onAttached', 'tabs.onDetached', 'tabs.onMoved']);
    await t.snap('before (window A)');

    if (winB) {
        await t.snapWindow('before (window B)', winB);
    }

    const target = crossWindow ? {windowId: winB, index: -1} : {index: 0};
    const atResolve = new Map();

    await t.step(`tabs.move([${movers.join(', ')}], ${crossWindow ? '{windowId: B, index: -1}' : '{index: 0}'})${repairAtResolve ? ', then sessions.setTabValue(...) again right at the resolve  // the repair of the add-on' : ''}`, async () => {
        await browser.tabs.move(t.ids(movers), target);

        for (const name of movers) {
            atResolve.set(name, await readValues(t, name));
        }

        if (repairAtResolve) {
            for (const name of movers) {
                await setValues(t, name);
            }
        }
    }, {snap: 'after (window A)'});

    if (winB) {
        await t.snapWindow('after (window B)', winB);
    }

    const afterQuiet = new Map();

    for (const name of movers) {
        afterQuiet.set(name, await readValues(t, name));
    }

    await wait(LOAD_WAIT);

    const lost = discarded && crossWindow; // BEHAVIOR-MOVE-TABS.md §7
    const cellOf = name => `${bornDiscarded ? '➕' : ''}${name}${hide ? '(h)' : ''}`;

    if (crossWindow) {
        t.expectRow('after (window A)', ['keepA*']);
        t.expectRow('after (window B)', ['keepB*', ...movers.map(cellOf)]);
    } else {
        t.expectRow('after (window A)', [...movers.map(cellOf), 'keepA*']);
    }

    for (const name of movers) {
        const later = await readValues(t, name);

        t.note(`${name} after the move: ${await flags(name)}`);
        t.note(`${name} values - at the resolve: ${atResolve.get(name)}${repairAtResolve ? ' (then written again)' : ''}; after quiet: ${afterQuiet.get(name)}; ${LOAD_WAIT} ms later: ${later}`);

        if (!lost) {
            t.expect(`${name}: the values of a ${discarded ? 'discarded tab moved inside its own window' : 'loaded tab'} survive the move (BEHAVIOR-MOVE-TABS.md §7)`, later, expectedValues(name));
        } else if (repairAtResolve) {
            t.expect(`${name}: lost at the resolve, before the repair (§7)`, atResolve.get(name), ABSENT);
            t.expect(`${name}: the values written again at the resolve are there ${LOAD_WAIT} ms later - what the add-on relies on (§7)`, later, expectedValues(name));
        } else {
            t.expect(`${name}: a discarded tab moved to another window loses the values at the resolve already, and they stay lost (§7)`, [atResolve.get(name), afterQuiet.get(name), later], [ABSENT, ABSENT, ABSENT]);
        }
    }

    if (load) {
        await t.step(`tabs.update(${movers[0]}, {active: true})  // the moved tab loads`, () => t.activate(movers[0], {settle: false}), {snap: false});
        await wait(LOAD_WAIT);

        for (const name of movers) {
            const afterLoad = await readValues(t, name);

            t.note(`${name} after the load: ${await flags(name)}; values: ${afterLoad}`);

            if (lost && !repairAtResolve) {
                t.expect(`${name}: still lost after the load (§7)`, afterLoad, ABSENT);
            }
        }
    }

    if (!repairAtResolve) {
        await t.step(`sessions.setTabValue(...) again on [${movers.join(', ')}]  // a late repair`, async () => {
            for (const name of movers) {
                await setValues(t, name);
            }
        }, {snap: false});

        for (const name of movers) {
            t.expect(`${name}: the values written again after the move are read back`, await readValues(t, name), expectedValues(name));
        }
    }

    if (back) {
        await t.step(`tabs.move([${movers.join(', ')}], {windowId: A, index: -1})  // back, with the repaired values`, () => browser.tabs.move(t.ids(movers), {windowId: t.win, index: -1}), {snap: 'back (window A)'});
        await t.snapWindow('back (window B)', winB);
        await wait(LOAD_WAIT);

        t.expectRow('back (window A)', ['keepA*', ...movers.map(cellOf)]);
        t.expectRow('back (window B)', ['keepB*']);

        for (const name of movers) {
            const afterBack = await readValues(t, name);

            t.note(`${name} back in window A: ${await flags(name)}; values: ${afterBack}`);
            t.expect(`${name}: the move back loses the repaired values again (§7)`, afterBack, ABSENT);
        }
    }
}

export const tests = [

{
    id: 'R32.01',
    title: 'a LOADED tab moved to another window - the control: the values set with sessions.setTabValue before the move, read at the resolve, after quiet and LOAD_WAIT later',
    run: t => moveAndRead(t, {movers: ['mover']}),
},

{
    id: 'R32.02',
    title: 'a DISCARDED tab moved to another window - the values after the move, after the tab is loaded by activation, and a late repair',
    run: t => moveAndRead(t, {movers: ['mover'], discard: true, load: true}),
},

{
    id: 'R32.03',
    title: 'a DISCARDED tab moved inside its own window - the values after the move',
    run: t => moveAndRead(t, {movers: ['mover'], discard: true, crossWindow: false}),
},

{
    id: 'R32.04',
    title: 'three HIDDEN + DISCARDED tabs moved to another window as an array, the values written again right at the resolve - an unloaded group of the add-on and its repair',
    run: t => moveAndRead(t, {movers: ['m1', 'm2', 'm3'], discard: true, hide: true, repairAtResolve: true}),
},

{
    id: 'R32.05',
    title: 'a DISCARDED tab moved to another window, repaired at the resolve, and moved back - do the repaired values survive the second move',
    run: t => moveAndRead(t, {movers: ['mover'], discard: true, repairAtResolve: true, back: true}),
},

{
    id: 'R32.06',
    title: 'a tab BORN discarded, never loaded, moved to another window and then loaded by activation',
    run: t => moveAndRead(t, {movers: ['born'], bornDiscarded: true, load: true}),
},

];
