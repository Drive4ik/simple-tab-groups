// Round 05b — the newTabPosition matrix: six creation patterns run under all three settings,
// then two window-targeting tests. The script sets the pref itself, so nothing is toggled by hand.
// Everything auto-closes, no 👁️ questions. Takes a couple of minutes.
// Run with:  await T.start('round-05b')

const SETTINGS = ['atEnd', 'afterCurrent', 'relatedAfterCurrent'];

const PATTERNS = [
    {
        title: 'parallel batch, no index, all inactive',
        async run(t) {
            await t.scene(['w1', 'w2', 'w3', 'w4']);
            await t.activate('w3');
            await t.snap('before');

            await t.createMany([{name: 'n0'}, {name: 'n1'}, {name: 'n2'}]);
            t.act('Promise.all([create(n0), create(n1), create(n2)])  // no index');
            await t.snap('after');
        },
    },
    {
        title: 'sequential batch, no index, all inactive',
        async run(t) {
            await t.scene(['w1', 'w2', 'w3', 'w4']);
            await t.activate('w3');
            await t.snap('before');

            for (const name of ['n0', 'n1', 'n2']) {
                await t.create(name);
            }

            t.act('await create(n0); await create(n1); await create(n2)  // no index');
            await T.wait(2000);
            await t.snap('after');
        },
    },
    {
        title: 'parallel batch, no index, n1 active:true',
        async run(t) {
            await t.scene(['w1', 'w2', 'w3', 'w4']);
            await t.activate('w3');
            await t.snap('before');

            await t.createMany([{name: 'n0'}, {name: 'n1', active: true}, {name: 'n2'}]);
            t.act('Promise.all([...])  // no index, n1 has active: true');
            await t.snap('after');
        },
    },
    {
        title: 'parallel batch, explicit index, all inactive',
        async run(t) {
            await t.scene(['s0', 'w1', 'w2', 'w3', 'w4']);
            await t.activate('w2');
            await t.snap('before');

            await t.createMany([{name: 'n0', index: 5}, {name: 'n1', index: 6}, {name: 'n2', index: 7}]);
            t.act('Promise.all([create(n0, 5), create(n1, 6), create(n2, 7)])');
            await t.snap('after');
        },
    },
    {
        title: 'parallel batch, explicit index, n1 active:true',
        async run(t) {
            await t.scene(['s0', 'w1', 'w2', 'w3', 'w4']);
            await t.activate('w2');
            await t.snap('before');

            await t.createMany([{name: 'n0', index: 5}, {name: 'n1', index: 6, active: true}, {name: 'n2', index: 7}]);
            t.act('Promise.all([...])  // index 5,6,7 and n1 has active: true');
            await t.snap('after');
        },
    },
    {
        title: 'explicit index out of order (clamp)',
        async run(t) {
            await t.scene(['a', 'b']);
            await t.snap('before');

            await t.create('i4', {index: 4});
            await t.create('i2', {index: 2});
            await t.create('i3', {index: 3});

            t.act('create(index: 4), then create(index: 2), then create(index: 3)');
            await T.wait(2000);
            await t.snap('after');
        },
    },
];

export const tests = [];
let number = 6;

for (const setting of SETTINGS) {
    for (const pattern of PATTERNS) {
        tests.push({
            name: `R5.${String(number++).padStart(2, '0')} ${setting} — ${pattern.title}`,
            async run(t) {
                const applied = await T.newTabPosition(setting);
                t.note(`newTabPosition: ${JSON.stringify(applied)}`);

                if (!applied.ok) {
                    throw new Error(`could not set newTabPosition to ${setting}`);
                }

                await pattern.run(t);
            },
        });
    }
}

tests.push({
    name: `R5.${String(number++).padStart(2, '0')} afterCurrent — tabs.create with NO windowId while another window is focused`,
    async run(t) {
        t.note(`newTabPosition: ${JSON.stringify(await T.newTabPosition('afterCurrent'))}`);

        await t.scene(['w1', 'w2', 'w3']);
        await t.activate('w2');
        await t.snap('scene window before');

        const focused = await browser.windows.create({url: 'https://example.com/?tab=other'});
        await T.wait(2000);

        const created = await browser.tabs.create({url: 'https://example.com/?tab=nowin', active: false});
        await T.wait(2000);

        t.note(`the new tab landed in the ${created.windowId === t.win ? 'SCENE window' : 'other, freshly focused window'} at index ${created.index}`);

        await t.snap('scene window after');
        await browser.windows.remove(focused.id);
    },
});

tests.push({
    name: `R5.${String(number++).padStart(2, '0')} afterCurrent — explicit windowId into a NON-focused window, no index`,
    async run(t) {
        t.note(`newTabPosition: ${JSON.stringify(await T.newTabPosition('afterCurrent'))}`);

        await t.scene(['w1', 'w2', 'w3', 'w4']);
        await t.activate('w3');
        await t.snap('before');

        const focused = await browser.windows.create({url: 'https://example.com/?tab=other'});
        await T.wait(2000);
        t.note('another window now holds the focus; the scene window is in the background');

        await t.create('n0');
        t.act('tabs.create({windowId: sceneWindow})  // no index, scene window NOT focused');
        await T.wait(2000);
        await t.snap('after');

        await browser.windows.remove(focused.id);
    },
});

export async function after() {
    await T.clearNewTabPosition();
    console.debug('newTabPosition restored to the browser default');
}
