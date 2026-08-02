# STG behavior test harness

The add-on that produced every fact in `docs/TABGROUPS-BEHAVIOR.md` and
`docs/CREATE-TABS-BEHAVIOR.md`. It is committed so those facts can be re-run and disputed: a marker
like `R5.16` in the docs points at test 16 of `tests/round-05.js`, and running it must reproduce the
table printed next to that fact.

Not part of STG, never published, never built into the extension.

Notation and the rules a test has to follow: `docs/BEHAVIOR-NOTATION.md`.

## Setup

1. A **fresh Firefox profile with no other add-ons** — STG especially. STG mirrors native groups and
   would rewrite the very state a test is measuring.
2. `about:debugging` → This Firefox → Load Temporary Add-on… → pick `test-addon/manifest.json`.
3. Press **Inspect** next to it — that console is where rounds are started.
4. In the console settings (gear icon) turn on **Show timestamps**.
5. Wait for `STG behavior test harness ready`.

## Running

```js
await T.start('round-06')
```

Wait for `=== batch done ===`, then right-click in the console → **Export Visible Messages To** →
**Clipboard**.

Each test opens its own window, prints one table, and closes the window. Tests marked 👁️ leave the
window open and ask what to look at — answer those first.

**Between rounds: close any window a test left open, then press Reload on the add-on in
about:debugging.** Reloading wipes all harness state, which is more reliable than unwinding it, and
it is also how an edited test file gets picked up — modules are cached for the life of a load. Do
not reload while a round is running, and note that reloading clears the console, so copy the output
first.

## Rounds

| round | what it establishes |
| - | - |
| `round-01` | API/event self-check, TABGROUPS §1 and §2 |
| `round-02` | the membership rule on `tabs.move`, then §3 and §4 |
| `round-03a`…`03d` | group id immutability, collapsed, the hidden-tab header, restart |
| `round-04a`…`04c` | collapsed with the active tab inside, hidden tabs across a restart |
| `round-05a`…`05d` | CREATE-TABS: the newTabPosition matrix, speed, window targeting |
| `round-06` | explicit index at restore scale, 100–300 tabs, all three settings |

## Writing a round

A round is a module exporting an array called `tests`:

```js
export const tests = [
    {
        name: 'R7.01 something — what it shows',
        async run(t) {
            await t.scene(['x1', 'gr1', 'gr2', 'x2']);
            await t.group(['gr1', 'gr2']);
            t.watch(['tabs.onMoved', 'tabs.onUpdated']);
            await t.snap('before');

            await browser.tabs.move(t.id('x1'), {index: 2});
            t.act('tabs.move(x1, {index: 2})');
            await T.wait(500);

            await t.snap('after');
            t.note(`groups: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);
        },
    },
];

export const gap = 3000;                    // optional, ms between tests, default 1500
export const note = 'preconditions…';       // optional, printed before the batch
export async function after() {}            // optional, e.g. restore a browser setting
```

Add `keepOpen: true` to a test that asks a 👁️ question, and make sure nothing happens after the
snapshot it asks about — the window has to be left in exactly the state the question is about.

## Harness API

| call | what it does |
| - | - |
| `T.start('round-06')` | loads `tests/round-06.js` and runs it |
| `T.report('after restart')` | dumps every normal window without relying on harness memory — names come back from the tab urls |
| `t.scene(['a', 'b', 'c'])` | opens a window with these tabs in this order, waits for load, **asserts the order** and aborts on mismatch |
| `t.settle({expect, timeout})` | polls until the window holds `expect` tabs and none is still on `about:blank` |
| `t.group(['b', 'c'], props)` | `tabs.group` + optional `tabGroups.update`, assigns the next square |
| `t.joinGroup(['d'], groupId)` | `tabs.group({tabIds, groupId})` |
| `t.ungroup(['b'])` | `tabs.ungroup` |
| `t.hide/show(['b'])` | `tabs.hide` / `tabs.show` |
| `t.activate('b')` | `tabs.update({active: true})` |
| `t.create('new1', props)` | one tab, marked ➕ in the table |
| `t.createMany([{name, index, active}])` | parallel batch via `Promise.all`, all marked ➕ |
| `t.snap('before')` | captures a state row |
| `t.act('tabs.move(a, {index: 2})')` | writes the action row |
| `t.watch(['tabs.onMoved'])` | records events, filtered to this window |
| `t.groupsInfo()` | `tabGroups.query` metadata for the window |
| `t.note('…')` / `t.ask('…')` | a note under the table / a 👁️ question |
| `T.newTabPosition('atEnd')` | sets the pref, waits, reports what actually applied |
| `T.clearNewTabPosition()` | restores the browser default |

`t.id('name')` gives the real tab id when a raw API call needs one. Real ids never reach the printed
output — the table only ever shows names.
