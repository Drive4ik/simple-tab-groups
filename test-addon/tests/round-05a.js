// Round 05a — CREATE-TABS facts that do not depend on newTabPosition.
// Everything auto-closes, no 👁️ questions. Run with:  await T.start('round-05a')

export const tests = [

{
    name: 'R5.01 §12 — a created tab starts on about:blank, the real url arrives later',
    async run(t) {
        await t.scene(['x1']);

        const url = 'https://example.com/?tab=probe';
        const created = await browser.tabs.create({windowId: t.win, url, active: false});

        t.note(`url on the object returned by tabs.create: ${JSON.stringify(created.url)}`);
        t.note(`url from tabs.get immediately after: ${JSON.stringify((await browser.tabs.get(created.id)).url)}`);

        await T.wait(200);
        t.note(`url after 200ms: ${JSON.stringify((await browser.tabs.get(created.id)).url)}`);

        await T.wait(2000);
        t.note(`url after a further 2000ms: ${JSON.stringify((await browser.tabs.get(created.id)).url)}`);
    },
},

{
    name: 'R5.02 §3 — do hidden tabs occupy the window index space',
    async run(t) {
        await t.scene(['t1', 't2', 't3', 't4', 't5', 't6']);
        await t.hide(['t2', 't3', 't4']);

        await t.snap('before');

        await t.create('inserted', {index: 2});
        t.act('tabs.create({index: 2})  // index 2 is inside the hidden block');
        await T.wait(2000);

        await t.snap('after');

        const tabs = await t.query();
        t.note(`hidden flags: ${tabs.map(tab => `${t.cell(tab)}=${tab.hidden}`).join(', ')}`);
    },
},

{
    name: 'R5.03 §7 — an explicit index inside / next to a native group span',
    async run(t) {
        await t.scene(['a', 'gr1', 'gr2', 'b']);
        await t.group(['gr1', 'gr2']);

        t.watch(['tabs.onCreated', 'tabs.onUpdated']);

        const before = await t.query();
        t.note(`index 2 before the first create held: ${t.cell(before[2])}`);
        await t.snap('before');

        await t.create('onMember', {index: 2});
        t.act('tabs.create({index: 2})  // that slot belongs to a group member');
        await T.wait(2000);
        await t.snap('after 1');

        const middle = await t.query();
        const nonMemberIndex = middle.findIndex(tab => tab.id === t.id('b'));
        t.note(`index ${nonMemberIndex} before the second create held: ${t.cell(middle[nonMemberIndex])}`);

        await t.create('onOutsider', {index: nonMemberIndex});
        t.act(`tabs.create({index: ${nonMemberIndex}})  // that slot belongs to a tab outside the group`);
        await T.wait(2000);
        await t.snap('after 2');

        t.note('§1 rule predicts: joins in the first case, stays out in the second');
        t.note(`groups: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
    },
},

{
    name: 'R5.04 §8 — does windows.create({url: [...]}) preserve the array order',
    async run(t) {
        const names = ['w1', 'w2', 'w3', 'w4', 'w5'];

        for (let attempt = 1; attempt <= 3; attempt++) {
            const win = await browser.windows.create({url: names.map(name => `https://example.com/?tab=${name}`)});
            await T.wait(2000);

            const tabs = (await browser.tabs.query({windowId: win.id})).sort((a, b) => a.index - b.index);
            const got = tabs.map(tab => new URL(tab.url).searchParams.get('tab') ?? '(about:blank)');

            t.note(`attempt ${attempt}: ${got.join(' | ')}`);
            await browser.windows.remove(win.id);
        }

        t.note(`requested order was: ${names.join(' | ')}`);
    },
},

{
    name: 'R5.05 §10 — bulk creation speed, parallel vs sequential',
    async run(t) {
        const COUNT = 30;
        const spec = (windowId, i) => ({
            windowId,
            url: `https://example.com/?tab=p${i}`,
            active: false,
            discarded: true,
            title: `p${i}`,
        });

        await t.scene(['x1']);

        let parallelMs;
        const parallelStart = Date.now();

        try {
            await Promise.all(Array.from({length: COUNT}, (_, i) => browser.tabs.create(spec(t.win, i))));
            parallelMs = Date.now() - parallelStart;
        } catch (error) {
            t.note(`parallel batch failed: ${error.message}`);
            return;
        }

        const second = await browser.windows.create();
        await T.wait(500);

        const sequentialStart = Date.now();

        for (let i = 0; i < COUNT; i++) {
            await browser.tabs.create(spec(second.id, i));
        }

        const sequentialMs = Date.now() - sequentialStart;
        await browser.windows.remove(second.id);

        t.note(`${COUNT} discarded tabs — parallel: ${parallelMs} ms, sequential: ${sequentialMs} ms`);
        t.note(`sequential is ${(sequentialMs / parallelMs).toFixed(1)}x slower`);
        t.note('no table here: 31 columns would be unreadable, and the fact is the timing');
    },
},

];
