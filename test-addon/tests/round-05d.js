// Round 05d — the four CREATE-TABS facts that did not reproduce are all about races, and a race
// needs repetition and volume before it can be declared absent. Everything here runs under
// afterCurrent, the only setting where the docs claim disorder.
//
// The scene is always 5 tabs with w2 (index 2) active, matching the scene the old facts used.
// Explicit indexes start at 5, i.e. appended past the end, exactly as fact 11 did.
//
// Auto-closes, no 👁️ questions. Takes a few minutes.
// Run with:  await T.start('round-05d')

const build = (id, {count, withIndex, activeAt, attempt}) => {
    const shape = [
        `${count} tabs`,
        withIndex ? `explicit index 5..${4 + count}` : 'no index',
        activeAt === undefined ? 'all inactive' : `n${activeAt} active:true`,
    ].join(', ');

    return {
        name: `${id} afterCurrent — ${shape} (attempt ${attempt})`,
        async run(t) {
            const applied = await T.newTabPosition('afterCurrent');

            if (!applied.ok) {
                throw new Error('could not set newTabPosition to afterCurrent');
            }

            await t.scene(['s0', 'w1', 'w2', 'w3', 'w4']);
            await t.activate('w2');
            await t.snap('before');

            const entries = Array.from({length: count}, (_, i) => ({
                name: `n${i}`,
                ...(withIndex ? {index: 5 + i} : {}),
                ...(activeAt === i ? {active: true} : {}),
            }));

            await t.createMany(entries);
            t.act(`Promise.all of ${count} creates — ${shape}`);
            await t.snap('after');

            const created = (await t.query())
                .filter(tab => t.createdByAction.has(tab.id))
                .map(tab => t.nameOf(tab));

            t.note(`call order:  ${entries.map(entry => entry.name).join(', ')}`);
            t.note(`final order: ${created.join(', ')}`);
            t.note(`order preserved: ${created.join(',') === entries.map(entry => entry.name).join(',')}`);

            if (withIndex) {
                const tabs = await t.query();
                const placed = entries.every((entry, i) => tabs[5 + i] && t.nameOf(tabs[5 + i]) === entry.name);
                t.note(`every tab sits at its requested index: ${placed}`);
            }
        },
    };
};

export const tests = [];
let number = 28;
const next = () => `R5.${number++}`;

// fact 11: explicit index + an activating tab. 5 tabs, the size the original fact used
for (const attempt of [1, 2, 3, 4]) {
    tests.push(build(next(), {count: 5, withIndex: true, activeAt: 2, attempt}));
}

// same, with double the concurrency - if it is a race, more parallel creates should surface it
for (const attempt of [1, 2, 3]) {
    tests.push(build(next(), {count: 10, withIndex: true, activeAt: 5, attempt}));
}

// fact 5: no index + an activating tab
for (const attempt of [1, 2, 3]) {
    tests.push(build(next(), {count: 5, withIndex: false, activeAt: 2, attempt}));
}

// fact 4: no index, all inactive - is the reversal stable, or does it vary run to run
for (const attempt of [1, 2, 3]) {
    tests.push(build(next(), {count: 5, withIndex: false, attempt}));
}

export async function after() {
    await T.clearNewTabPosition();
    console.debug('newTabPosition restored to the browser default');
}
