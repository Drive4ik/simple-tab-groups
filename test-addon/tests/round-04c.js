// Round 04c — §6: do HIDDEN tabs survive a browser restart, and do they keep their group?
//
// Run with:  await T.start('round-04c')

export const note = `PRECONDITION: about:preferences → Startup → "Open previous windows and tabs" must be ON.

Step 1 — this run opens a window; keep it.
Step 2 — restart Firefox.
Step 3 — about:debugging → Load Temporary Add-on… again, wait for "harness ready", then run:
         await T.report('after restart')

hid1 is a group member, hid2 is not, so the report separates "hidden survived" from
"membership survived".`;

export const tests = [

{
    name: 'R4.03 §6 — hidden tabs and membership before a browser restart',
    async run(t) {
        await t.scene(['x1', 'gr1', 'hid1', 'gr2', 'hid2', 'x2']);
        await t.group(['gr1', 'hid1', 'gr2'], {title: 'survivor', color: 'red'});

        await t.hide(['hid1', 'hid2']);
        t.act('tabs.hide([hid1, hid2])  // hid1 is inside the group, hid2 is not');
        await t.snap('before restart');

        const tabs = await t.query();
        t.note(`hidden flags: ${tabs.map(tab => `${t.cell(tab)}=${tab.hidden}`).join(', ')}`);
        t.note(`groups: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
        t.note('now restart Firefox, reload the add-on, and run:  await T.report("after restart")');
        t.note('in the report, (h) means the tab came back hidden and 🟥 means it kept its group');
    },
    keepOpen: true,
},

];
