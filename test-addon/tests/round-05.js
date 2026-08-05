import {ACTION_WAIT, LOAD_WAIT, NEW_TAB_POSITIONS, NETWORK_URL} from '../constants.js';
import {wait} from '../test.js';
import {sceneUrl, nameFromUrl} from '../tabs.js';

export const note = `Round 05 — CREATE-TABS: what tabs.create does on its own (R5.01–R5.05), the full
newTabPosition matrix (R5.06–R5.25), the two facts that did not reproduce, retested harder
(R5.26–R5.27), and the afterCurrent races repeated for volume (R5.28–R5.40).

The script sets newTabPosition itself and the harness restores it after every test.`;

const PROBE_WAIT = 200;

const discarded = (windowId, index) => ({
    windowId,
    url: sceneUrl(`p${index}`),
    active: false,
    discarded: true,
    title: `p${index}`,
});

const measure = async (count, parallel) => {
    const win = await browser.windows.create();

    try {
        await wait(ACTION_WAIT);

        const started = Date.now();

        if (parallel) {
            await Promise.all(Array.from({length: count}, (_, index) => browser.tabs.create(discarded(win.id, index))));
        } else {
            for (let index = 0; index < count; index++) {
                await browser.tabs.create(discarded(win.id, index));
            }
        }

        return Date.now() - started;
    } finally {
        await browser.windows.remove(win.id).catch(() => {});
        await wait(ACTION_WAIT);
    }
};

const PATTERNS = [
    {
        title: 'parallel batch, no index, all inactive',
        async run(t) {
            await t.scene(['w1', 'w2', 'w3', 'w4']);
            await t.activate('w3');
            await t.snap('before');

            await t.step('Promise.all([create(n0), create(n1), create(n2)])  // no index', () => {
                return t.createMany([{name: 'n0'}, {name: 'n1'}, {name: 'n2'}]);
            });
        },
    },
    {
        title: 'sequential batch, no index, all inactive',
        async run(t) {
            await t.scene(['w1', 'w2', 'w3', 'w4']);
            await t.activate('w3');
            await t.snap('before');

            await t.step('await create(n0); await create(n1); await create(n2)  // no index', async () => {
                for (const name of ['n0', 'n1', 'n2']) {
                    await t.create(name);
                }
            });
        },
    },
    {
        title: 'parallel batch, no index, n1 active:true',
        async run(t) {
            await t.scene(['w1', 'w2', 'w3', 'w4']);
            await t.activate('w3');
            await t.snap('before');

            await t.step('Promise.all([...])  // no index, n1 has active: true', () => {
                return t.createMany([{name: 'n0'}, {name: 'n1', active: true}, {name: 'n2'}]);
            });
        },
    },
    {
        title: 'parallel batch, explicit index, all inactive',
        async run(t) {
            await t.scene(['s0', 'w1', 'w2', 'w3', 'w4']);
            await t.activate('w2');
            await t.snap('before');

            await t.step('Promise.all([create(n0, 5), create(n1, 6), create(n2, 7)])', () => {
                return t.createMany([{name: 'n0', index: 5}, {name: 'n1', index: 6}, {name: 'n2', index: 7}]);
            });
        },
    },
    {
        title: 'parallel batch, explicit index, n1 active:true',
        async run(t) {
            await t.scene(['s0', 'w1', 'w2', 'w3', 'w4']);
            await t.activate('w2');
            await t.snap('before');

            await t.step('Promise.all([...])  // index 5,6,7 and n1 has active: true', () => {
                return t.createMany([{name: 'n0', index: 5}, {name: 'n1', index: 6, active: true}, {name: 'n2', index: 7}]);
            });
        },
    },
    {
        title: 'explicit index out of order (clamp)',
        async run(t) {
            await t.scene(['a', 'b']);
            await t.snap('before');

            await t.step('create(index: 4), then create(index: 2), then create(index: 3)', async () => {
                await t.create('i4', {index: 4});
                await t.create('i2', {index: 2});
                await t.create('i3', {index: 3});
            });
        },
    },
];

const MATRIX = [
    {setting: 'atEnd', ids: ['R5.06', 'R5.07', 'R5.08', 'R5.09', 'R5.10', 'R5.11']},
    {setting: 'afterCurrent', ids: ['R5.12', 'R5.13', 'R5.14', 'R5.15', 'R5.16', 'R5.17']},
    {setting: 'relatedAfterCurrent', ids: ['R5.18', 'R5.19', 'R5.20', 'R5.21', 'R5.22', 'R5.23']},
];

const withSetting = async (t, setting) => {
    const applied = await t.setting('newTabPosition', setting);

    t.note(`newTabPosition: ${JSON.stringify(applied)}`);
    t.require(`newTabPosition set to ${setting}`, applied.ok, JSON.stringify(applied));
};

const race = (id, {count, withIndex, activeAt, attempt}) => {
    const shape = [
        `${count} tabs`,
        withIndex ? `explicit index 5..${4 + count}` : 'no index',
        activeAt === undefined ? 'all inactive' : `n${activeAt} active:true`,
    ].join(', ');

    return {
        id,
        title: `afterCurrent — ${shape} (attempt ${attempt})`,
        async run(t) {
            await withSetting(t, 'afterCurrent');

            await t.scene(['s0', 'w1', 'w2', 'w3', 'w4']);
            await t.activate('w2');
            await t.snap('before');

            const entries = Array.from({length: count}, (_, index) => ({
                name: `n${index}`,
                ...(withIndex ? {index: 5 + index} : {}),
                ...(activeAt === index ? {active: true} : {}),
            }));

            await t.step(`Promise.all of ${count} creates — ${shape}`, () => t.createMany(entries));

            const tabs = await t.query();
            const created = tabs.filter(tab => t.createdByAction.has(tab.id)).map(tab => t.nameOf(tab));
            const wanted = entries.map(entry => entry.name);

            const expected = withIndex
                ? wanted
                : [
                    ...(activeAt === undefined ? [] : [wanted[activeAt]]),
                    ...wanted.filter((_, index) => index !== activeAt).reverse(),
                ];

            t.note(`call order:  ${wanted.join(', ')}`);
            t.note(`final order: ${created.join(', ')}`);
            t.expect(withIndex ? 'creation order preserved' : 'order matches CREATE-TABS §4/§5', created, expected);

            if (withIndex) {
                const misplaced = entries
                    .filter((entry, index) => tabs[5 + index]?.id !== t.id(entry.name))
                    .map(entry => entry.name);

                t.expect('every tab sits at its requested index', misplaced, []);
            }
        },
    };
};

export const tests = [

{
    id: 'R5.01',
    title: '§12 — a created tab starts on about:blank, the real url arrives later',
    async run(t) {
        await t.scene(['x1']);

        const probe = async (label, url) => {
            const created = await browser.tabs.create({windowId: t.win, url, active: false});
            const now = async () => JSON.stringify((await browser.tabs.get(created.id)).url);

            t.note(`${label} — tabs.create resolved with: ${JSON.stringify(created.url)}`);
            t.note(`${label} — tabs.get immediately after: ${await now()}`);

            await wait(PROBE_WAIT);
            t.note(`${label} — after ${PROBE_WAIT} ms: ${await now()}`);

            await wait(LOAD_WAIT);
            t.note(`${label} — after a further ${LOAD_WAIT} ms: ${await now()}`);
        };

        await probe('add-on page', t.tabUrl('probe-local'));
        await probe('network page', sceneUrl('probe-network', NETWORK_URL));
    },
},

{
    id: 'R5.02',
    title: '§3 — do hidden tabs occupy the window index space',
    async run(t) {
        await t.scene(['t1', 't2', 't3', 't4', 't5', 't6']);
        await t.hide(['t2', 't3', 't4']);
        await t.snap('before');

        await t.step('tabs.create({index: 2})  // index 2 is inside the hidden block', () => t.create('inserted', {index: 2}));

        t.expectRow('after', ['t1*', 't2(h)', '➕inserted', 't3(h)', 't4(h)', 't5', 't6']);
        t.note(`hidden flags: ${await t.hiddenFlags()}`);
    },
},

{
    id: 'R5.03',
    title: '§7 — an explicit index inside / next to a native group span',
    async run(t) {
        await t.scene(['a', 'gr1', 'gr2', 'b']);
        await t.group(['gr1', 'gr2']);

        t.watch(['tabs.onCreated', 'tabs.onUpdated']);

        const before = await t.query();
        t.note(`index 2 before the first create held: ${t.cell(before[2])}`);
        await t.snap('before');

        await t.step('tabs.create({index: 2})  // that slot belongs to a group member', () => t.create('onMember', {index: 2}));

        const middle = await t.query();
        const outsiderIndex = middle.findIndex(tab => tab.id === t.id('b'));
        t.note(`index ${outsiderIndex} before the second create held: ${t.cell(middle[outsiderIndex])}`);

        await t.step(`tabs.create({index: ${outsiderIndex}})  // that slot belongs to a tab outside the group`, () => {
            return t.create('onOutsider', {index: outsiderIndex});
        });

        t.expectRow('after', ['a*', '🟥 gr1', '🟥 ➕onMember', '🟥 gr2', 'b']);
        t.expectRow('after 2', ['a*', '🟥 gr1', '🟥 ➕onMember', '🟥 gr2', '➕onOutsider', 'b']);
        t.note('the §1 membership rule holds for tabs.create: joins on a member slot, stays out on an outsider slot');
    },
},

{
    id: 'R5.04',
    title: '§8 — does windows.create({url: [...]}) preserve the array order',
    async run(t) {
        const names = ['w1', 'w2', 'w3', 'w4', 'w5'];

        for (let attempt = 1; attempt <= 3; attempt++) {
            const win = await browser.windows.create({url: names.map(name => sceneUrl(name))});
            await wait(LOAD_WAIT);

            const tabs = (await browser.tabs.query({windowId: win.id})).sort((a, b) => a.index - b.index);
            const got = tabs.map(tab => nameFromUrl(tab.url) ?? '(about:blank)');

            t.note(`attempt ${attempt}: ${got.join(' | ')}`);
            t.expect(`attempt ${attempt} came back in order`, got, names);

            await browser.windows.remove(win.id);
        }
    },
},

{
    id: 'R5.05',
    title: '§10 — bulk creation speed, parallel vs sequential',
    async run(t) {
        const COUNT = 30;

        const parallelMs = await measure(COUNT, true);
        const sequentialMs = await measure(COUNT, false);

        t.note(`${COUNT} discarded tabs — parallel: ${parallelMs} ms, sequential: ${sequentialMs} ms`);
        t.note(`sequential is ${(sequentialMs / parallelMs).toFixed(1)}x slower`);
        t.note('no table here: 31 columns would be unreadable, and the fact is the timing');
    },
},

...MATRIX.flatMap(({setting, ids}) => PATTERNS.map((pattern, index) => ({
    id: ids[index],
    title: `${setting} — ${pattern.title}`,
    async run(t) {
        await withSetting(t, setting);
        await pattern.run(t);
    },
}))),

{
    id: 'R5.24',
    title: 'afterCurrent — tabs.create with NO windowId while another window is focused',
    async run(t) {
        await withSetting(t, 'afterCurrent');

        await t.scene(['w1', 'w2', 'w3']);
        await t.activate('w2');
        await t.snap('scene window before');

        const focused = await browser.windows.create({url: sceneUrl('other')});
        await wait(LOAD_WAIT);

        const created = await browser.tabs.create({url: sceneUrl('nowin'), active: false});
        await wait(LOAD_WAIT);

        t.note(`the new tab landed in the ${created.windowId === t.win ? 'SCENE window' : 'other, freshly focused window'} at index ${created.index}`);
        t.expect('a windowId-less create goes to the focused window', created.windowId !== t.win, true);

        await t.snap('scene window after');
        await browser.windows.remove(focused.id);
    },
},

{
    id: 'R5.25',
    title: 'afterCurrent — explicit windowId into a NON-focused window, no index',
    async run(t) {
        await withSetting(t, 'afterCurrent');

        await t.scene(['w1', 'w2', 'w3', 'w4']);
        await t.activate('w3');
        await t.snap('before');

        const focused = await browser.windows.create({url: sceneUrl('other')});
        await wait(LOAD_WAIT);
        t.note('another window now holds the focus; the scene window is in the background');

        await t.step('tabs.create({windowId: sceneWindow})  // no index, scene window NOT focused', () => t.create('n0'));

        t.expectRow('after', ['w1', 'w2', 'w3*', '➕n0', 'w4']);

        await browser.windows.remove(focused.id);
    },
},

{
    id: 'R5.26',
    title: '§8 — windows.create({url: [...]}) order, 10 attempts with 8 urls',
    async run(t) {
        const names = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8'];
        let mismatches = 0;

        for (let attempt = 1; attempt <= 10; attempt++) {
            const win = await browser.windows.create({url: names.map(name => sceneUrl(name))});
            await wait(LOAD_WAIT);

            const tabs = (await browser.tabs.query({windowId: win.id})).sort((a, b) => a.index - b.index);
            const got = tabs.map(tab => nameFromUrl(tab.url) ?? '(about:blank)');

            if (got.join(' | ') === names.join(' | ')) {
                t.note(`attempt ${String(attempt).padStart(2)}: in order`);
            } else {
                mismatches++;
                t.note(`attempt ${String(attempt).padStart(2)}: OUT OF ORDER — ${got.join(' | ')}`);
            }

            await browser.windows.remove(win.id);
        }

        t.note(`requested order: ${names.join(' | ')}`);
        t.expect('all 10 attempts came back in order', mismatches, 0);
    },
},

{
    id: 'R5.27',
    title: '§10 — bulk creation speed at two sizes, both orders, to cancel warm-up bias',
    async run(t) {
        for (const count of [30, 100]) {
            const parallelFirst = await measure(count, true);
            const sequentialSecond = await measure(count, false);
            const sequentialFirst = await measure(count, false);
            const parallelSecond = await measure(count, true);

            t.note(`${count} tabs, pass A (parallel first): parallel ${parallelFirst} ms, sequential ${sequentialSecond} ms`);
            t.note(`${count} tabs, pass B (sequential first): sequential ${sequentialFirst} ms, parallel ${parallelSecond} ms`);
            t.note(`${count} tabs, ratio A ${(sequentialSecond / parallelFirst).toFixed(1)}x, ratio B ${(sequentialFirst / parallelSecond).toFixed(1)}x`);
        }

        t.note('whichever runs first pays the warm-up cost, so a ratio that survives both orders is real');
    },
},

race('R5.28', {count: 5, withIndex: true, activeAt: 2, attempt: 1}),
race('R5.29', {count: 5, withIndex: true, activeAt: 2, attempt: 2}),
race('R5.30', {count: 5, withIndex: true, activeAt: 2, attempt: 3}),
race('R5.31', {count: 5, withIndex: true, activeAt: 2, attempt: 4}),

race('R5.32', {count: 10, withIndex: true, activeAt: 5, attempt: 1}),
race('R5.33', {count: 10, withIndex: true, activeAt: 5, attempt: 2}),
race('R5.34', {count: 10, withIndex: true, activeAt: 5, attempt: 3}),

race('R5.35', {count: 5, withIndex: false, activeAt: 2, attempt: 1}),
race('R5.36', {count: 5, withIndex: false, activeAt: 2, attempt: 2}),
race('R5.37', {count: 5, withIndex: false, activeAt: 2, attempt: 3}),

race('R5.38', {count: 5, withIndex: false, attempt: 1}),
race('R5.39', {count: 5, withIndex: false, attempt: 2}),
race('R5.40', {count: 5, withIndex: false, attempt: 3}),

];
