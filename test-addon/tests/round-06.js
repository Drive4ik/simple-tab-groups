import {BATCH_GAP, NETWORK_URL} from '../constants.js';

export const note = `Round 06 — does an explicit index still hold at restore scale, and under the settings that
round 05 only covered at batch size 3.

Tabs are created discarded so nothing hits the network — that is also what a real restore does for an
unloaded group. R6.08 repeats one case with really loading tabs, to show the discarded flag does not
change placement.`;

export const gap = BATCH_GAP * 2;

const orderTest = (id, {setting, count, activeAt = null, loading = false}) => {
    const shape = [
        `${count} tabs`,
        activeAt === null ? 'all inactive' : `n${activeAt} active:true`,
        loading ? 'really loading' : 'discarded',
    ].join(', ');

    return {
        id,
        title: `${setting} — explicit index, ${shape}`,
        url: loading ? NETWORK_URL : undefined,
        async run(t) {
            const applied = await t.setting('newTabPosition', setting);
            t.require(`newTabPosition set to ${setting}`, applied.ok, JSON.stringify(applied));

            await t.scene(['anchor']);

            const entries = Array.from({length: count}, (_, index) => {
                const base = {name: `n${String(index).padStart(3, '0')}`, index: 1 + index};

                if (activeAt === index) {
                    return {...base, active: true};
                }

                return loading ? base : {...base, discarded: true};
            });

            let createMs = 0;

            await t.step(`Promise.all of ${count} creates`, async () => {
                const started = Date.now();
                await t.createMany(entries);
                createMs = Date.now() - started;
            }, {snap: false});

            t.note(`Promise.all returned after ${createMs} ms`);

            const tabs = await t.query();
            const misplaced = [];

            for (const entry of entries) {
                const tab = tabs.find(candidate => candidate.id === t.id(entry.name));

                if (!tab) {
                    misplaced.push(`${entry.name}: MISSING`);
                } else if (tab.index !== entry.index) {
                    misplaced.push(`${entry.name}: asked for ${entry.index}, sits at ${tab.index}`);
                }
            }

            t.expect('every requested tab exists', tabs.length, count + 1);
            t.expect('every tab sits at its requested index', misplaced.slice(0, 12), []);

            t.note(`head: ${tabs.slice(0, 6).map(tab => t.cell(tab)).join(' | ')}`);
            t.note(`tail: ${tabs.slice(-4).map(tab => t.cell(tab)).join(' | ')}`);

            const active = tabs.find(tab => tab.active);
            t.note(`active tab: ${active ? t.cell(active) : '(none)'}`);
        },
    };
};

export const tests = [

orderTest('R6.01', {setting: 'atEnd', count: 100}),
orderTest('R6.02', {setting: 'afterCurrent', count: 100}),
orderTest('R6.03', {setting: 'relatedAfterCurrent', count: 100}),

orderTest('R6.04', {setting: 'atEnd', count: 100, activeAt: 50}),
orderTest('R6.05', {setting: 'afterCurrent', count: 100, activeAt: 50}),
orderTest('R6.06', {setting: 'relatedAfterCurrent', count: 100, activeAt: 50}),

orderTest('R6.07', {setting: 'afterCurrent', count: 300}),

orderTest('R6.08', {setting: 'afterCurrent', count: 30, loading: true}),

];
