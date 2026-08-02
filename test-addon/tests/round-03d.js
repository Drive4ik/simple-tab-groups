// Round 03d — §6: does a native group survive a browser restart.
// Run with:  await T.start('round-03d')

export const note = `PRECONDITION: about:preferences → Startup → "Open previous windows and tabs" must be ON,
otherwise the scene window is gone after the restart and the test proves nothing.

Step 1 — this run opens a window; keep it.
Step 2 — restart Firefox.
Step 3 — about:debugging → Load Temporary Add-on… again (a temporary add-on does not survive a
         restart), wait for "harness ready", then run:  await T.report('after restart')`;

export const tests = [

{
    name: 'R3.05 §6 — native group before a browser restart',
    async run(t) {
        await t.scene(['x1', 'gr1', 'gr2', 'x2', 'gr3', 'gr4']);
        await t.group(['gr1', 'gr2'], {title: 'first', color: 'red'});
        await t.group(['gr3', 'gr4'], {title: 'second', color: 'green'});

        await t.snap('before restart');
        t.note(`groups: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
        t.note('now restart Firefox, reload the add-on, and run:  await T.report("after restart")');
        t.note('compare the table above with the one T.report prints — names travel in the tab urls');
    },
    keepOpen: true,
},

];
