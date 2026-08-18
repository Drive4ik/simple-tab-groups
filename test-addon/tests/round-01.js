import {TAB_GROUP_ID_NONE, NEW_TAB_POSITIONS} from '../constants.js';
import {openedWindows} from '../tabs.js';

export const note = 'Round 01 — TABGROUPS-BEHAVIOR.md §1, §2, §20 and §21, plus a harness/API self-check.';

const EVENT_APIS = [
    'tabs.onCreated', 'tabs.onMoved', 'tabs.onUpdated', 'tabs.onRemoved', 'tabs.onActivated',
    'tabGroups.onCreated', 'tabGroups.onMoved', 'tabGroups.onUpdated', 'tabGroups.onRemoved',
];

const moveTest = (id, title, {scene, members, move, index, after}) => ({
    id,
    title,
    async run(t) {
        await t.scene(scene);
        await t.group(members);

        t.watch(['tabs.onMoved', 'tabs.onUpdated', 'tabGroups.onCreated', 'tabGroups.onRemoved']);
        await t.snap('before');

        const label = Array.isArray(move) ? `[${move.join(', ')}]` : move;

        await t.step(`tabs.move(${label}, {index: ${index}})`, () => {
            return browser.tabs.move(Array.isArray(move) ? t.ids(move) : t.id(move), {index});
        });

        t.expectRow('after', after);
    },
});

const moveAllTest = (id, title, {scene, members, after}) => ({
    id,
    title,
    async run(t) {
        await t.scene(scene);
        await t.group(members);

        t.watch(['tabs.onMoved', 'tabs.onUpdated', 'tabGroups.onCreated', 'tabGroups.onRemoved']);
        await t.snap('before');

        await t.step('tabs.move(allWindowTabs, {index: -1})', async () => {
            return browser.tabs.move((await t.query()).map(tab => tab.id), {index: -1});
        });

        t.expectRow('after', after);
    },
});

export const tests = [

{
    id: 'R1.01',
    title: 'self-check: which APIs and events actually exist',
    async run(t) {
        t.note(`browser.tabGroups: ${browser.tabGroups ? 'present' : 'MISSING'}`);

        for (const spec of EVENT_APIS) {
            const [namespace, event] = spec.split('.');
            t.note(`${spec}: ${browser[namespace]?.[event]?.addListener ? 'present' : 'MISSING'}`);
        }

        for (const value of NEW_TAB_POSITIONS) {
            t.note(`newTabPosition.set(${value}) → ${JSON.stringify(await t.setting('newTabPosition', value))}`);
        }

        t.note(`newTabPosition.clear() → ${JSON.stringify(await t.clearSetting('newTabPosition'))}`);

        await t.scene(['a', 'b']);
        await t.snap('scene');

        const tabs = await t.query();
        t.expect('groupId of an ungrouped tab is TAB_GROUP_ID_NONE', tabs[0].groupId, TAB_GROUP_ID_NONE);
        t.note(`tabGroups.query on a window with no groups → ${JSON.stringify(await browser.tabGroups.query({windowId: t.win}))}`);
    },
},

moveTest('R1.02', '§1 — move a tab INTO a group span', {
    scene: ['mover', 'out1', 'gr1', 'gr2', 'out2', 'out3'],
    members: ['gr1', 'gr2'],
    move: 'mover',
    index: 2,
    after: ['out1', '🟥 gr1', '🟥 mover*', '🟥 gr2', 'out2', 'out3'],
}),

moveTest('R1.03', '§1 — a member moved WITHIN the span', {
    scene: ['out1', 'gr1', 'gr2', 'gr3', 'out2'],
    members: ['gr1', 'gr2', 'gr3'],
    move: 'gr3',
    index: 1,
    after: ['out1*', '🟥 gr3', '🟥 gr1', '🟥 gr2', 'out2'],
}),

moveTest('R1.04', '§1 — landing immediately BEFORE the first member', {
    scene: ['mover', 'out1', 'gr1', 'gr2', 'out2'],
    members: ['gr1', 'gr2'],
    move: 'mover',
    index: 1,
    after: ['out1', 'mover*', '🟥 gr1', '🟥 gr2', 'out2'],
}),

moveTest('R1.05', '§1 — landing immediately AFTER the last member', {
    scene: ['mover', 'out1', 'gr1', 'gr2', 'gr3', 'out2'],
    members: ['gr1', 'gr2', 'gr3'],
    move: 'mover',
    index: 4,
    after: ['out1', '🟥 gr1', '🟥 gr2', '🟥 gr3', '🟥 mover*', 'out2'],
}),

{
    id: 'R1.06',
    title: '§1 — a member leaves the span, then the last one leaves',
    async run(t) {
        await t.scene(['out1', 'gr1', 'gr2', 'out2']);
        await t.group(['gr1', 'gr2']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated', 'tabGroups.onRemoved']);
        await t.snap('before');

        await t.step('tabs.move(gr2, {index: -1})', () => browser.tabs.move(t.id('gr2'), {index: -1}));
        t.expectRow('after', ['out1*', '🟥 gr1', 'out2', 'gr2']);

        await t.step('tabs.move(gr1, {index: -1})  // the last member leaves', () => browser.tabs.move(t.id('gr1'), {index: -1}));
        t.expectRow('after 2', ['out1*', 'out2', 'gr2', 'gr1']);
    },
},

moveTest('R1.07', '§2 — array of members → {index: -1}, group NOT at the end', {
    scene: ['out1', 'out2', 'gr1', 'gr2', 'gr3', 'out3'],
    members: ['gr1', 'gr2', 'gr3'],
    move: ['gr1', 'gr2', 'gr3'],
    index: -1,
    after: ['out1*', 'out2', 'out3', 'gr1', 'gr2', 'gr3'],
}),

moveTest('R1.08', '§2 — array of members → {index: 0}, group NOT at the start', {
    scene: ['out1', 'out2', 'gr1', 'gr2', 'gr3', 'out3'],
    members: ['gr1', 'gr2', 'gr3'],
    move: ['gr1', 'gr2', 'gr3'],
    index: 0,
    after: ['gr1', 'gr2', 'gr3', 'out1*', 'out2', 'out3'],
}),

moveTest('R1.09', '§2 — group already at the END, moved to {index: -1}', {
    scene: ['out1', 'out2', 'out3', 'gr1', 'gr2', 'gr3'],
    members: ['gr1', 'gr2', 'gr3'],
    move: ['gr1', 'gr2', 'gr3'],
    index: -1,
    after: ['out1*', 'out2', 'out3', '🟥 gr1', '🟥 gr2', '🟥 gr3'],
}),

moveTest('R1.10', '§2 — group already at the START, moved to {index: 0}', {
    scene: ['gr1', 'gr2', 'gr3', 'out1', 'out2', 'out3'],
    members: ['gr1', 'gr2', 'gr3'],
    move: ['gr1', 'gr2', 'gr3'],
    index: 0,
    after: ['🟥 gr1*', '🟥 gr2', '🟥 gr3', 'out1', 'out2', 'out3'],
}),

moveAllTest('R1.11', '§2 — ALL window tabs → {index: -1}, group at the START', {
    scene: ['gr1', 'gr2', 'out1', 'out2'],
    members: ['gr1', 'gr2'],
    after: ['gr1*', 'gr2', 'out1', 'out2'],
}),

moveAllTest('R1.12', '§2 — ALL window tabs → {index: -1}, group in the MIDDLE', {
    scene: ['out1', 'gr1', 'gr2', 'out2'],
    members: ['gr1', 'gr2'],
    after: ['out1*', 'gr1', 'gr2', 'out2'],
}),

moveAllTest('R1.13', '§2 — ALL window tabs → {index: -1}, group at the END (the claimed Firefox bug)', {
    scene: ['out1', 'out2', 'out3', 'gr1', 'gr2', 'gr3'],
    members: ['gr1', 'gr2', 'gr3'],
    after: ['🟥 out1*', '🟥 out2', '🟥 out3', '🟥 gr1', '🟥 gr2', '🟥 gr3'],
}),

{
    id: 'R1.14',
    title: '§20 — array of outsiders → explicit index PAST THE END (= tabs count), group at the END',
    async run(t) {
        await t.scene(['m1', 'm2', 'keep1', 'gr1', 'gr2', 'gr3']);
        await t.group(['gr1', 'gr2', 'gr3']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated', 'tabGroups.onCreated', 'tabGroups.onRemoved']);
        await t.snap('before');

        const pastEnd = (await t.query()).length;

        const resolved = await t.step(`tabs.move([m1, m2], {index: ${pastEnd}})  // index === tabs count`, () => {
            return browser.tabs.move(t.ids(['m1', 'm2']), {index: pastEnd}).catch(e => {
                t.note(`tabs.move threw: ${e.message}`);
                return null;
            });
        });

        await noteMovers(t, ['m1', 'm2'], resolved);

        t.expectRow('after', ['keep1', '🟥 gr1', '🟥 gr2', '🟥 gr3', '🟥 m1*', '🟥 m2']);
    },
},

crossMoveTest('R1.15', '§20 — array from ANOTHER window → explicit index PAST THE END, group at the END of the target', {
    dest: ['keep1', 'gr1', 'gr2', 'gr3'],
    members: ['gr1', 'gr2', 'gr3'],
    movers: ['m1', 'm2'],
    index: 4,
    after: ['keep1*', '🟥 gr1', '🟥 gr2', '🟥 gr3', 'm1', 'm2'],
}),

crossMoveTest('R1.16', '§20 — array from ANOTHER window → a MEMBER\'s slot (the §11 occupant rule, cross-window)', {
    dest: ['keep1', 'gr1', 'gr2', 'gr3', 'keep2'],
    members: ['gr1', 'gr2', 'gr3'],
    movers: ['m1', 'm2'],
    index: 2,
    after: ['keep1*', '🟥 gr1', '🟥 m1', '🟥 m2', '🟥 gr2', '🟥 gr3', 'keep2'],
}),

crossMoveTest('R1.17', '§20 — array from ANOTHER window → the OUTSIDER slot right after the span', {
    dest: ['keep1', 'gr1', 'gr2', 'gr3', 'keep2'],
    members: ['gr1', 'gr2', 'gr3'],
    movers: ['m1', 'm2'],
    index: 4,
    after: ['keep1*', '🟥 gr1', '🟥 gr2', '🟥 gr3', 'm1', 'm2', 'keep2'],
}),

crossMoveTest('R1.18', '§20 — array from ANOTHER window → {index: -1}, group at the END of the target', {
    dest: ['keep1', 'gr1', 'gr2', 'gr3'],
    members: ['gr1', 'gr2', 'gr3'],
    movers: ['m1', 'm2'],
    index: -1,
    after: ['keep1*', '🟥 gr1', '🟥 gr2', '🟥 gr3', 'm1', 'm2'],
}),

{
    id: 'R1.19',
    title: '§21 — array gathered at the FIRST mover\'s own slot, the first mover is a MEMBER of a span',
    async run(t) {
        await t.scene(['m1', 's2', 'free1', 'free2']);
        await t.group(['m1', 's2']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated', 'tabGroups.onCreated', 'tabGroups.onRemoved']);
        await t.snap('before');

        const resolved = await t.step('tabs.move([m1, free1, free2], {index: 0})  // index of m1 itself', () => {
            return browser.tabs.move(t.ids(['m1', 'free1', 'free2']), {index: 0}).catch(e => {
                t.note(`tabs.move threw: ${e.message}`);
                return null;
            });
        });

        await noteMovers(t, ['m1', 'free1', 'free2'], resolved);

        t.expectRow('after', ['🟥 m1*', '🟥 free1', '🟥 free2', '🟥 s2']);
    },
},

{
    id: 'R1.20',
    title: '§20 — array of outsiders → {index: -1}, group at the END, same window',
    async run(t) {
        await t.scene(['m1', 'm2', 'keep1', 'gr1', 'gr2', 'gr3']);
        await t.group(['gr1', 'gr2', 'gr3']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated', 'tabGroups.onCreated', 'tabGroups.onRemoved']);
        await t.snap('before');

        const resolved = await t.step('tabs.move([m1, m2], {index: -1})', () => {
            return browser.tabs.move(t.ids(['m1', 'm2']), {index: -1}).catch(e => {
                t.note(`tabs.move threw: ${e.message}`);
                return null;
            });
        });

        await noteMovers(t, ['m1', 'm2'], resolved);

        t.expectRow('after', ['keep1', '🟥 gr1', '🟥 gr2', '🟥 gr3', '🟥 m1*', '🟥 m2']);
    },
},

];

async function sourceRow(t, label, windowId) {
    const tabs = (await browser.tabs.query({windowId})).sort((a, b) => a.index - b.index);
    t.row(label, tabs.map(tab => t.cell(tab)));
}

async function noteMovers(t, movers, resolved) {
    if (resolved) {
        t.note(`resolved: ${resolved.map(tab => `${t.nameOf(tab)} index:${tab.index} group:${t.square(tab.groupId) || tab.groupId}`).join(', ')}`);
    }

    for (const name of movers) {
        const fresh = await browser.tabs.get(t.id(name));
        t.note(`${name} fresh: index:${fresh.index} group:${t.square(fresh.groupId) || fresh.groupId} inTarget:${fresh.windowId === t.win}`);
    }
}

function crossMoveTest(id, title, {dest, members, movers, index, after}) {
    return {
        id,
        title,
        async run(t) {
            await t.scene(dest);
            await t.group(members);

            const sourceWindowId = await t.buildWindow(['src1', ...movers]);

            try {
                t.watch(['tabs.onMoved', 'tabs.onUpdated', 'tabs.onAttached', 'tabs.onDetached', 'tabGroups.onCreated', 'tabGroups.onRemoved']);
                await sourceRow(t, 'before (source window)', sourceWindowId);
                await t.snap('before (target window)');

                const resolved = await t.step(`tabs.move([${movers.join(', ')}], {windowId: target, index: ${index}})`, () => {
                    return browser.tabs.move(t.ids(movers), {windowId: t.win, index}).catch(e => {
                        t.note(`tabs.move threw: ${e.message}`);
                        return null;
                    });
                }, {snap: 'after (target window)'});

                await sourceRow(t, 'after (source window)', sourceWindowId);

                await noteMovers(t, movers, resolved);

                t.expectRow('after (target window)', after);
                t.expectRow('after (source window)', ['src1*']);
            } finally {
                openedWindows.delete(sourceWindowId);
                await browser.windows.remove(sourceWindowId).catch(() => {});
            }
        },
    };
}
