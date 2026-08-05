# STG behavior test harness

The add-on that produced every fact in `docs/TABGROUPS-BEHAVIOR.md`, `docs/CREATE-TABS-BEHAVIOR.md`
and `docs/MOVE-TABS-BEHAVIOR.md`. It is committed so those facts can be re-run and disputed: a
marker like `R5.16` points at the test with that id in `tests/round-05.js`, and running it must
reproduce the table printed next to the fact.

Not part of STG, never published, never built into the extension.

Notation and the rules a test has to follow: `docs/BEHAVIOR-NOTATION.md`.

## Setup

1. A **fresh Firefox profile with no other add-ons** — STG especially. STG mirrors native groups and
   would rewrite the very state a test is measuring.
2. For the restart tests: about:preferences → Startup → "Open previous windows and tabs" **on**.
3. `about:debugging` → This Firefox → Load Temporary Add-on… → pick `test-addon/manifest.json`.
4. Press **Inspect** next to it — that console is where runs are started and questions are answered.
5. Wait for `STG behavior test harness ready`.

## Running

```js
T.start()                          // every round, in order
T.start('round-05')                // one round
T.start('round-01', 'round-07')    // a few rounds
T.start('round-05:R5.01:R5.38')    // named tests of one round, for a re-check after a fix
```

The console shows one line per test while the run goes. At the end the full report opens in a tab,
already selected — Ctrl+A, Ctrl+C. `T.logs()` opens the last report again.

A run is not unattended:

- **👁️ questions.** The run stops at the frame the question is about, prints the window as the API
  sees it, and waits. Look at the tab bar, then answer in the same console:
  `T.visualAnswer('only gr2 is visible')`. `T.visualAnswer()` with no argument records "not looked
  at" and moves on. The answer goes into the report under its question.
- **Restarts.** R3.05 and R4.03 stop and ask for a browser restart. The scene window is left open on
  purpose — keep it. Restart Firefox, load the add-on again in about:debugging, then run
  `T.continue()`: the harness finds the scene window by the names in the tab urls and finishes the
  test in the same table.

`T.continue()` also picks a run back up after an add-on reload or a crash — the queue and everything
measured so far are checkpointed after every test. `T.stop()` ends a run after the current test and
still produces the report. `T.forget()` throws a stuck checkpoint away.

Nothing has to be cleaned up by hand between runs: before every test the harness removes its
listeners, closes the windows it opened and restores any browser setting a test changed, and it
writes into the report whatever it had to clean up.

## Rounds

| round | what it establishes |
| - | - |
| `round-01` | API/event self-check, TABGROUPS §1 and §2 |
| `round-02` | the membership rule on `tabs.move`, then §3 and §4 |
| `round-03` | group id immutability, collapsed, the hidden-tab header, groups across a restart |
| `round-04` | collapsed seen from the tab bar, hidden tabs across a restart |
| `round-05` | CREATE-TABS: the newTabPosition matrix, speed, window targeting, the races |
| `round-06` | explicit index at restore scale, 100–300 tabs, all three settings |
| `round-07` | the `hidden` flag on what `tabs.move` resolves with, ungroup/hide of an active member |

## Files

| file | what is in it |
| - | - |
| `constants.js` | every constant and timing |
| `test.js` | `class Test` — the table, notes, questions, events, `expect`, the report. Knows nothing about tabs |
| `tabs.js` | `class TabsTest extends Test` — windows, tabs, groups, and the `tabs.*` / `tabGroups.*` event formatters |
| `harness.js` | the runner, checkpoints, `globalThis.T` |
| `tab.html` + `tab.js` | the page every scene tab loads — it names itself from `?tab=` so the tab strip shows the tab's test name |
| `results.html` + `results.js` | the report page — it reads the last run out of `localStorage` itself |

A round for another API brings its own domain class next to `tabs.js` and names it:
`export const testClass = BookmarksTest`. Everything in `test.js` works as it is.

## Writing a round

A round is a module exporting an array called `tests`:

```js
import {LOAD_WAIT} from '../constants.js';

export const tests = [
    {
        id: 'R7.04',
        title: 'something — what it shows',
        async run(t) {
            await t.scene(['x1', 'gr1', 'gr2', 'x2']);
            await t.group(['gr1', 'gr2']);

            t.watch(['tabs.onMoved', 'tabs.onUpdated']);
            await t.snap('before');

            await t.step('tabs.move(x1, {index: 2})', () => browser.tabs.move(t.id('x1'), {index: 2}));

            t.expect('x1 joined the group', (await t.query())[1].groupId !== -1, true);
        },
    },
];

export const note = 'preconditions…';    // optional, printed above the round
export const gap = BATCH_GAP * 2;        // optional, ms between tests, default BATCH_GAP
export const testClass = TabsTest;       // optional, default TabsTest
export const url = 'https://example.com/';  // optional, what the scene tabs load
```

Scene tabs load `tab.html` from the add-on itself, which names itself from `?tab=` — clicking a tab
to read its url does not change the stand. A test that needs a real site instead sets `url` on
itself (`{id: 'R8.01', url: 'https://example.com/', …}`) or the whole round sets the default above;
either way the name still travels in `?tab=` and everything else works unchanged.

- **The id is written, never computed.** Docs point at ids; a counter would shift every marker below
  an inserted test.
- **No timings and no urls spelled out.** Everything shared comes from `constants.js`, and `t.step`
  waits for the browser to go quiet by itself.
- **A test that needs a browser restart** splits into `run(t)`, which builds the scene and ends with
  `await t.restart()`, and `afterRestart(t)`, which measures. The window is found again by the names
  in the tab urls; the table continues in the same report.

## API

`T` is the console surface:

| call | what it does |
| - | - |
| `T.start()` / `T.start('round-05')` / `T.start('round-01', 'round-07')` | run every round, one round, or a few |
| `T.start('round-05:R5.01')` | run only the named tests of a round |
| `T.visualAnswer('…')` | answer the 👁️ question the run is waiting on |
| `T.continue()` | pick a run back up after a restart, a reload or a crash |
| `T.stop()` | end the run after the current test, keep the report |
| `T.forget()` | drop a stuck checkpoint |
| `T.logs()` | open the last report again |
| `T.report('after restart')` | dump every normal window on demand — names come back from the tab urls |

Imported by a round from `../constants.js`:

| import | what it is |
| - | - |
| `TAB_GROUP_ID_NONE` | `-1`, the groupId of an ungrouped tab |
| `SCENE_URL` | `moz-extension://…/tab.html`, the page every scene tab loads — local, so a run needs no network and never touches a real site |
| `NETWORK_URL` | the site a test loads when it deliberately needs a real page instead |
| `SQUARES` | the group markers used in the tables |
| `NEW_TAB_POSITIONS` | all three `newTabPosition` values |
| `QUIET_WAIT` 200 | how long nothing may happen before a step counts as settled |
| `POLL_WAIT` 250 | how often the harness re-checks while waiting |
| `ACTION_WAIT` 500 | the old fixed pause, for a step that wants a number |
| `LOAD_WAIT` 2000 | a real page load, where the number is the fact |
| `SETTING_WAIT` 100 | a `browserSettings` write to land |
| `SETTLE_TIMEOUT` 20000 | when waiting gives up and says so in the report |
| `BATCH_GAP` 1500 | between two tests |

From `../test.js`: `wait(ms)`. From `../tabs.js`: `sceneUrl('a')` and `nameFromUrl(url)` — name to
url and back, the reason a tab stays identifiable across a restart.

The `t` passed to a test:

| call | what it does |
| - | - |
| `t.scene(['a', 'b', 'c'])` | opens a window with these tabs in this order, waits until they are all loaded, **asserts the order** and aborts on mismatch |
| `t.step('tabs.move(…)', fn)` | resets the event clock, writes the action row, runs `fn`, waits for the browser to go quiet, snapshots, returns what `fn` returned |
| `t.step(…, {wait: 0})` / `{wait: LOAD_WAIT}` / `{snap: false}` | no pause at all for speed and race tests, a fixed pause, or no snapshot |
| `t.snap('before')` / `t.act('…')` | a state row / an action row, for the cases `t.step` does not fit |
| `t.settled()` | wait for quiet without an action |
| `t.group(['b','c'], props)` / `t.joinGroup` / `t.ungroup` / `t.hide` / `t.show` / `t.activate` | the API call plus a settle; pass `{settle: false}` inside a `t.step` |
| `t.create('new1', props)` / `t.createMany([{name, index, active}])` | one tab / a parallel batch, both marked ➕ in the table |
| `t.expect('label', actual, expected)` | records OK or MISMATCH and counts into the run summary |
| `t.expectRow('after', ['a*', '🟥 b', 'c(h)'])` | the same, against a snapshot row — this is how a table recorded in the docs is asserted |
| `t.require('label', ok, detail)` | a precondition — aborts the test |
| `t.ask('…')` | stops the run and waits for `T.visualAnswer('…')` |
| `t.restart()` | checkpoint, ask for a browser restart, continue in `afterRestart` |
| `t.setting('newTabPosition', 'atEnd')` | sets a browser setting and reports what actually applied; the harness restores it after the test |
| `t.note('…')` | a line under the table |
| `t.query()` / `t.groupsInfo()` / `t.hiddenFlags()` / `t.cell(tab)` | the window as the API sees it |
| `t.id('name')` / `t.ids([…])` | real tab ids, for a raw API call — they never reach the printed output |

`t.query()` uses `tabs.query`, not `windows.getAll({populate: true})` — only the former is known to
return hidden tabs.
