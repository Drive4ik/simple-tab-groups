// Round 06 — does an explicit index still hold at restore scale, and under the settings that
// rounds 05b/05d only covered at batch size 3.
//
// The verification found two gaps: nothing above 10 tabs was ever checked for ORDER (the 30- and
// 100-tab runs measured only speed), and batches larger than 3 were only ever run under
// afterCurrent. This round closes both.
//
// Tabs are created discarded so nothing hits the network — that is also what a real restore does
// for an unloaded group. The last test repeats one case with really loading tabs, to show the
// discarded flag does not change placement.
//
// Every test waits for the window to actually settle before it measures, and the batch leaves a
// gap between tests. No 👁️ questions, everything auto-closes. Several minutes.
// Run with:  await T.start('round-06')

export const gap = 3000;

const orderTest = (id, {setting, count, activeAt = null, discarded = true}) => {
    const shape = [
        `${count} tabs`,
        activeAt === null ? 'all inactive' : `n${activeAt} active:true`,
        discarded ? 'discarded' : 'really loading',
    ].join(', ');

    return {
        name: `${id} ${setting} — explicit index, ${shape}`,
        async run(t) {
            const applied = await T.newTabPosition(setting);

            if (!applied.ok) {
                throw new Error(`could not set newTabPosition to ${setting}`);
            }

            await t.scene(['anchor']);
            await t.settle({expect: 1});

            const entries = Array.from({length: count}, (_, i) => {
                const base = {name: `n${String(i).padStart(3, '0')}`, index: 1 + i};

                if (activeAt === i) {
                    return {...base, active: true};
                }

                return discarded ? {...base, discarded: true, title: base.name} : base;
            });

            const started = Date.now();
            await t.createMany(entries);
            t.note(`Promise.all of ${count} creates took ${Date.now() - started} ms (incl. the harness load wait)`);

            const tabs = await t.settle({expect: count + 1});

            const problems = [];

            for (const entry of entries) {
                const tab = tabs.find(candidate => candidate.id === t.id(entry.name));

                if (!tab) {
                    problems.push(`${entry.name}: MISSING from the window`);
                } else if (tab.index !== entry.index) {
                    problems.push(`${entry.name}: asked for ${entry.index}, sits at ${tab.index}`);
                }
            }

            t.note(`tabs in window: ${tabs.length}, expected ${count + 1}`);
            t.note(`tabs not at their requested index: ${problems.length}`);

            if (problems.length) {
                t.note(`first mismatches — ${problems.slice(0, 12).join(' | ')}`);
            }

            t.note(`head: ${tabs.slice(0, 6).map(tab => t.cell(tab)).join(' | ')}`);
            t.note(`tail: ${tabs.slice(-4).map(tab => t.cell(tab)).join(' | ')}`);

            const active = tabs.find(tab => tab.active);
            t.note(`active tab: ${active ? t.cell(active) : '(none)'}`);
        },
    };
};

export const tests = [

    // the coverage gap: batches larger than 3 were only ever run under afterCurrent
    orderTest('R6.01', {setting: 'atEnd', count: 100}),
    orderTest('R6.02', {setting: 'afterCurrent', count: 100}),
    orderTest('R6.03', {setting: 'relatedAfterCurrent', count: 100}),

    // the same three, with an activating tab in the middle
    orderTest('R6.04', {setting: 'atEnd', count: 100, activeAt: 50}),
    orderTest('R6.05', {setting: 'afterCurrent', count: 100, activeAt: 50}),
    orderTest('R6.06', {setting: 'relatedAfterCurrent', count: 100, activeAt: 50}),

    // the scale gap: restore batches are far bigger than anything tested so far
    orderTest('R6.07', {setting: 'afterCurrent', count: 300}),

    // cross-check that the discarded flag is not what is keeping the order clean
    orderTest('R6.08', {setting: 'afterCurrent', count: 30, discarded: false}),

];

export async function after() {
    await T.clearNewTabPosition();
    console.debug('newTabPosition restored to the browser default');
}
