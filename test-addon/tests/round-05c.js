// Round 05c — the two facts of round 05a that did NOT reproduce, retested harder.
// Run after round-05b, with:  await T.start('round-05c')
// Everything auto-closes, no 👁️ questions. Takes a couple of minutes.

export const tests = [

{
    name: 'R5.26 §8 — windows.create({url: [...]}) order, 10 attempts with 8 urls',
    async run(t) {
        const names = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8'];
        const expected = names.join(' | ');
        let mismatches = 0;

        for (let attempt = 1; attempt <= 10; attempt++) {
            const win = await browser.windows.create({url: names.map(name => `https://example.com/?tab=${name}`)});
            await T.wait(2000);

            const tabs = (await browser.tabs.query({windowId: win.id})).sort((a, b) => a.index - b.index);
            const got = tabs.map(tab => new URL(tab.url).searchParams.get('tab') ?? '(about:blank)').join(' | ');

            if (got === expected) {
                t.note(`attempt ${String(attempt).padStart(2)}: in order`);
            } else {
                mismatches++;
                t.note(`attempt ${String(attempt).padStart(2)}: OUT OF ORDER — ${got}`);
            }

            await browser.windows.remove(win.id);
        }

        t.note(`requested order: ${expected}`);
        t.note(`out of 10 attempts, ${mismatches} came back out of order`);
        t.note('the docs claim this races; 05a saw 3/3 in order, so this run decides it');
    },
},

{
    name: 'R5.27 §10 — bulk creation speed at two sizes, both orders, to cancel warm-up bias',
    async run(t) {
        const spec = (windowId, i) => ({
            windowId,
            url: `https://example.com/?tab=p${i}`,
            active: false,
            discarded: true,
            title: `p${i}`,
        });

        const measure = async (count, parallel) => {
            const win = await browser.windows.create();
            await T.wait(500);

            const start = Date.now();

            if (parallel) {
                await Promise.all(Array.from({length: count}, (_, i) => browser.tabs.create(spec(win.id, i))));
            } else {
                for (let i = 0; i < count; i++) {
                    await browser.tabs.create(spec(win.id, i));
                }
            }

            const elapsed = Date.now() - start;
            await browser.windows.remove(win.id);
            await T.wait(500);

            return elapsed;
        };

        for (const count of [30, 100]) {
            // parallel first in one pass, sequential first in the other: whichever runs first pays
            // the warm-up cost, so a ratio that survives both orders is real
            const parallelFirst = await measure(count, true);
            const sequentialSecond = await measure(count, false);
            const sequentialFirst = await measure(count, false);
            const parallelSecond = await measure(count, true);

            t.note(`${count} tabs, pass A (parallel first): parallel ${parallelFirst} ms, sequential ${sequentialSecond} ms`);
            t.note(`${count} tabs, pass B (sequential first): sequential ${sequentialFirst} ms, parallel ${parallelSecond} ms`);
            t.note(`${count} tabs, ratio A ${(sequentialSecond / parallelFirst).toFixed(1)}x, ratio B ${(sequentialFirst / parallelSecond).toFixed(1)}x`);
        }

        t.note('the docs quote 38 ms vs 90 ms for 30 tabs (2.4x); 05a measured 34 vs 52 (1.5x)');
        t.note('if the ratio holds or grows from 30 to 100, the "never create sequentially" rule stands');
    },
},

];
