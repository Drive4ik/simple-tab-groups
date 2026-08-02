// Round 01 — TABGROUPS-BEHAVIOR.md §1 and §2, plus a harness/API self-check.
// Run with:  await T.start('round-01')

export const tests = [

{
    name: 'R1.01 self-check: which APIs and events actually exist',
    async run(t) {
        t.note(`browser.tabGroups: ${browser.tabGroups ? 'present' : 'MISSING'}`);

        for (const spec of [
            'tabs.onCreated', 'tabs.onMoved', 'tabs.onUpdated', 'tabs.onRemoved', 'tabs.onActivated',
            'tabGroups.onCreated', 'tabGroups.onMoved', 'tabGroups.onUpdated', 'tabGroups.onRemoved',
        ]) {
            const [namespace, event] = spec.split('.');
            t.note(`${spec}: ${browser[namespace]?.[event]?.addListener ? 'present' : 'MISSING'}`);
        }

        for (const value of ['atEnd', 'afterCurrent', 'relatedAfterCurrent']) {
            t.note(`newTabPosition.set(${value}) → ${JSON.stringify(await T.newTabPosition(value))}`);
        }

        t.note(`newTabPosition.clear() → ${JSON.stringify(await T.clearNewTabPosition())}`);

        await t.scene(['a', 'b']);
        await t.snap('scene');

        const tabs = await t.query();
        t.note(`groupId of an ungrouped tab = ${tabs[0].groupId} (docs claim TAB_GROUP_ID_NONE = -1)`);
        t.note(`tabGroups.query on a window with no groups → ${JSON.stringify(await browser.tabGroups.query({windowId: t.win}))}`);
    },
},

{
    name: 'R1.02 §1 — move a tab INTO a group span',
    async run(t) {
        await t.scene(['mover', 'out1', 'gr1', 'gr2', 'out2', 'out3']);
        await t.group(['gr1', 'gr2']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated']);
        await t.snap('before');

        await browser.tabs.move(t.id('mover'), {index: 2});
        t.act('tabs.move(mover, {index: 2})');
        await T.wait(500);

        await t.snap('after');
        t.note(`groups: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
    },
},

{
    name: 'R1.03 §1 — a member moved WITHIN the span',
    async run(t) {
        await t.scene(['out1', 'gr1', 'gr2', 'gr3', 'out2']);
        await t.group(['gr1', 'gr2', 'gr3']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated']);
        await t.snap('before');

        await browser.tabs.move(t.id('gr3'), {index: 1});
        t.act('tabs.move(gr3, {index: 1})');
        await T.wait(500);

        await t.snap('after');
        t.note(`groups: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
    },
},

{
    name: 'R1.04 §1 — landing immediately BEFORE the first member',
    async run(t) {
        await t.scene(['mover', 'out1', 'gr1', 'gr2', 'out2']);
        await t.group(['gr1', 'gr2']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated']);
        await t.snap('before');

        await browser.tabs.move(t.id('mover'), {index: 1});
        t.act('tabs.move(mover, {index: 1})');
        await T.wait(500);

        await t.snap('after');
        t.note(`groups: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
    },
},

{
    name: 'R1.05 §1 — landing immediately AFTER the last member',
    async run(t) {
        await t.scene(['mover', 'out1', 'gr1', 'gr2', 'gr3', 'out2']);
        await t.group(['gr1', 'gr2', 'gr3']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated']);
        await t.snap('before');

        await browser.tabs.move(t.id('mover'), {index: 4});
        t.act('tabs.move(mover, {index: 4})');
        await T.wait(500);

        await t.snap('after');
        t.note(`groups: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
    },
},

{
    name: 'R1.06 §1 — a member leaves the span, then the last one leaves',
    async run(t) {
        await t.scene(['out1', 'gr1', 'gr2', 'out2']);
        await t.group(['gr1', 'gr2']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated', 'tabGroups.onRemoved']);
        await t.snap('before');

        await browser.tabs.move(t.id('gr2'), {index: -1});
        t.act('tabs.move(gr2, {index: -1})');
        await T.wait(500);
        await t.snap('after 1');
        t.note(`groups after step 1: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);

        await browser.tabs.move(t.id('gr1'), {index: -1});
        t.act('tabs.move(gr1, {index: -1})  // the last member leaves');
        await T.wait(500);
        await t.snap('after 2');
        t.note(`groups after step 2: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
    },
},

{
    name: 'R1.07 §2 — array of members → {index: -1}, group NOT at the end',
    async run(t) {
        await t.scene(['out1', 'out2', 'gr1', 'gr2', 'gr3', 'out3']);
        await t.group(['gr1', 'gr2', 'gr3']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated', 'tabGroups.onRemoved']);
        await t.snap('before');

        await browser.tabs.move(t.ids(['gr1', 'gr2', 'gr3']), {index: -1});
        t.act('tabs.move([gr1, gr2, gr3], {index: -1})');
        await T.wait(500);

        await t.snap('after');
        t.note(`groups: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
    },
},

{
    name: 'R1.08 §2 — array of members → {index: 0}, group NOT at the start',
    async run(t) {
        await t.scene(['out1', 'out2', 'gr1', 'gr2', 'gr3', 'out3']);
        await t.group(['gr1', 'gr2', 'gr3']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated', 'tabGroups.onRemoved']);
        await t.snap('before');

        await browser.tabs.move(t.ids(['gr1', 'gr2', 'gr3']), {index: 0});
        t.act('tabs.move([gr1, gr2, gr3], {index: 0})');
        await T.wait(500);

        await t.snap('after');
        t.note(`groups: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
    },
},

{
    name: 'R1.09 §2 — group already at the END, moved to {index: -1}',
    async run(t) {
        await t.scene(['out1', 'out2', 'out3', 'gr1', 'gr2', 'gr3']);
        await t.group(['gr1', 'gr2', 'gr3']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated', 'tabGroups.onRemoved']);
        await t.snap('before');

        await browser.tabs.move(t.ids(['gr1', 'gr2', 'gr3']), {index: -1});
        t.act('tabs.move([gr1, gr2, gr3], {index: -1})');
        await T.wait(500);

        await t.snap('after');
        t.note(`groups: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
    },
},

{
    name: 'R1.10 §2 — group already at the START, moved to {index: 0}',
    async run(t) {
        await t.scene(['gr1', 'gr2', 'gr3', 'out1', 'out2', 'out3']);
        await t.group(['gr1', 'gr2', 'gr3']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated', 'tabGroups.onRemoved']);
        await t.snap('before');

        await browser.tabs.move(t.ids(['gr1', 'gr2', 'gr3']), {index: 0});
        t.act('tabs.move([gr1, gr2, gr3], {index: 0})');
        await T.wait(500);

        await t.snap('after');
        t.note(`groups: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
    },
},

{
    name: 'R1.11 §2 — ALL window tabs → {index: -1}, group at the START',
    async run(t) {
        await t.scene(['gr1', 'gr2', 'out1', 'out2']);
        await t.group(['gr1', 'gr2']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated', 'tabGroups.onRemoved']);
        await t.snap('before');

        await browser.tabs.move((await t.query()).map(tab => tab.id), {index: -1});
        t.act('tabs.move(allWindowTabs, {index: -1})');
        await T.wait(500);

        await t.snap('after');
        t.note(`groups: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
    },
},

{
    name: 'R1.12 §2 — ALL window tabs → {index: -1}, group in the MIDDLE',
    async run(t) {
        await t.scene(['out1', 'gr1', 'gr2', 'out2']);
        await t.group(['gr1', 'gr2']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated', 'tabGroups.onRemoved']);
        await t.snap('before');

        await browser.tabs.move((await t.query()).map(tab => tab.id), {index: -1});
        t.act('tabs.move(allWindowTabs, {index: -1})');
        await T.wait(500);

        await t.snap('after');
        t.note(`groups: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
    },
},

{
    name: 'R1.13 §2 — ALL window tabs → {index: -1}, group at the END (the claimed Firefox bug)',
    async run(t) {
        await t.scene(['out1', 'out2', 'out3', 'gr1', 'gr2', 'gr3']);
        await t.group(['gr1', 'gr2', 'gr3']);

        t.watch(['tabs.onMoved', 'tabs.onUpdated', 'tabGroups.onCreated', 'tabGroups.onRemoved']);
        await t.snap('before');

        await browser.tabs.move((await t.query()).map(tab => tab.id), {index: -1});
        t.act('tabs.move(allWindowTabs, {index: -1})');
        await T.wait(500);

        await t.snap('after');
        t.note(`groups: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
    },
},

];
