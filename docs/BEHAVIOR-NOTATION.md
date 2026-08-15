# Notation for the browser-behavior docs

How a verified fact is written down in `docs/*-BEHAVIOR.md`. One format for all of them, so a
state map can be read at a glance and never has to be decoded.

Facts are produced by `test-addon/` — a small add-on loaded into a clean Firefox profile with no
other add-ons (STG included: it mirrors native groups and would poison every result). It prints
tables in exactly this notation, so nothing is transcribed by hand.

It is committed for one reason: **a fact here can be disputed by re-running it.** A marker points at
a test, the test still exists, and running it must reproduce the table printed next to the fact. If
it does not, either the browser changed or the fact was wrong — both worth knowing. How a test has
to be written is in §6; how to run one is in `test-addon/README.md`.

---

## 1. The state table

Columns are tab indices, rows are the timeline. A state row shows the window; an action row shows
what was called between the two states around it.

```md
| tab index | 0 | 1 | 2 | 3 | 4 |
| - | - | - | - | - | - |
| before | keep1 | 🟥 member1 | 🟥 member2 | keep2 | keep3 |
| `tabs.move(keep1, {index: 2})` | | | | | |
| after | 🟥 member1 | 🟥 keep1 | 🟥 member2 | keep2 | keep3 |
```

Renders as:

| tab index | 0 | 1 | 2 | 3 | 4 |
| - | - | - | - | - | - |
| before | keep1 | 🟥 member1 | 🟥 member2 | keep2 | keep3 |
| `tabs.move(keep1, {index: 2})` | | | | | |
| after | 🟥 member1 | 🟥 keep1 | 🟥 member2 | keep2 | keep3 |

Reading a column top to bottom shows what happened at that index. The action row keeps the call in
the first column and pads the rest with empty cells — it reads across the full width, and the table
stays valid markdown.

The action row also carries how long the harness waited after the call before measuring —
`settled 212 ms`. That is not decoration: it is the difference between a state that had finished
moving and one that was measured too early.

A test with several steps just keeps appending `action` / `state` rows to the same table.

More than one window in a test (e.g. a transfer from one window to another) → still **one table**:
it shows the state of **every participating window both before and after each action**, as
separate rows — `before (window 1)`, `before (window 2)`, `after (window 1)`, `after (window 2)`.
A window that does not exist yet at that point is written as `not created yet`.

## 2. What goes in a cell

A cell is a tab. Always a **meaningful name**, never a real `tab.id`:

```txt
🟥 member1*(h)
│  │      ││
│  │      │└─ (h)  hidden (tabHide)
│  │      └── *    active tab of the window
│  └───────── name given by the test
└──────────── group membership
```

- **Name** — describes the tab's role in the test (`mover`, `member1`, `keep2`, `anchor`), so the
  table can be read without the test source. Real ids are meaningless a day later and were the
  reason this notation exists.
- **Group** — a colored square prefix: 🟥 🟩 🟦 🟨 🟪 ⬛, one per native group in the test, assigned
  in creation order. No square = no group (`TAB_GROUP_ID_NONE`).
- **➕ prefix** — the tab was created by the action under test, not by the scene setup. Makes new
  arrivals obvious in the `after` row.
- **Suffixes** are plain text on purpose: `*` active, `(h)` hidden, `(p)` pinned. Text and emoji
  are instantly told apart; two emoji next to each other are not.

Emoji are for the two things you scan for — which group a tab is in, and what is new. Everything
else stays text. Adding a third emoji axis makes the table noise again, which is exactly what this
notation replaced.

## 3. Events

When the fact is about event order, the events go in a fenced block under the table, with the
elapsed time from the **preceding action row** — the harness clock resets when `t.act()` writes
the row, so scene-setup waits never inflate the numbers. For that to hold, `t.act()` is called
right **before** the API call it names:

```text
  312ms  tabs.onMoved      member2  3 → 4
  318ms  tabs.onUpdated    member2  {groupId: -1}
```

Noisy `tabs.onUpdated` (status, url, title, favicon) is dropped, and the harness prints how many
were dropped — a fact must never look more complete than it is.

## 4. How a fact is confirmed

Every fact carries the run that produced it:

- **`R<round>.<test>`** — confirmed by the API output of that test, e.g. `R1.07` is test 07 of
  round 1. The table in the doc is the harness output, not a retelling.
- **👁️** — confirmed by eye. Some facts have no API surface at all (a group header staying in the
  tab bar, the empty-title group button, part of the collapsed behavior). For those the run stops
  at the exact frame in question, prints what to look at, and waits for `T.visualAnswer('…')`. The
  answer is recorded as 👁️ next to the question that was answered, in the same report.
- **`E<n>`** — legacy marker from the runs made before this harness existed. Those runs are not
  reproducible and their tables carry raw tab ids. Every `E<n>` fact is being re-verified; the
  marker is replaced with an `R` one as that happens. Do not mint new `E` numbers.
- **`L<n>`** — a lifecycle fact from `LIFECYCLE-BEHAVIOR.md`, produced by the throwaway stand
  described inside that document (§7 here). The evidence is the recorded session log kept in the
  document; re-verifying means rebuilding the stand from its description and replaying the action.

A statement with neither marker is not a fact and does not belong in these docs.

Test numbers, like fact numbers, are never reused: a new round keeps counting, so `R1.07` always
means the same run.

## 5. Rules

- **Real `tab.id` / group ids never reach a doc.** Native group ids are not stable anyway
  (TABGROUPS-BEHAVIOR.md §5) — a square plus a name says everything an id could.
- **The scene is asserted, not assumed.** The harness builds the scene, then compares the result
  against what was requested and aborts the test on any mismatch. No fact is ever derived from a
  scene that silently came out wrong.
- **New facts are appended** at the end of their document under the next free number. Numbers are
  never renumbered or reused — code comments point at them.
- **One topic per document.** Tab creation and `index` → CREATE-TABS-BEHAVIOR.md; native groups →
  TABGROUPS-BEHAVIOR.md. Anything involving a native group — including the membership of created
  or moved tabs — lives in TABGROUPS-BEHAVIOR.md; other documents cross-reference it instead of
  copying. The exception that DOES get a copy: when creation or movement in the presence of native
  groups behaves differently from what CREATE-TABS/MOVE-TABS themselves document — such a deviation
  is recorded in both documents, with cross-references, and both copies are kept in sync. Overlaps
  with no groups involved (create vs move) are duplicated the same way.
- **No pinned tabs in a scene**, except in tests whose subject is pinning itself. STG never
  groups pinned tabs — they stay outside every other test's scene.

## 6. How a test is written

The add-on itself is disposable and lives outside the repo; these constraints are not, because a
test that breaks one of them produces a table that looks like a fact and is not one.

**Environment.** A clean profile, no other add-ons, `test-addon/` loaded through about:debugging
with the permissions its manifest lists (`tabs`, `tabGroups`, `tabHide`, `sessions`,
`browserSettings`, and the `example.com` host permission — the page an injected script asks for
the microphone on). Progress goes to `console.debug`; the report itself opens in a tab at the end
of the run.

**Isolation.** One test = one window it opens itself = one table. Tests never share a window and
never depend on the order they ran in. Cleanliness is the harness's job, not the test's: before
every test it removes every listener, closes every window it opened, and restores every browser
setting a previous test changed — and writes into the report whatever it had to clean up. Each
round is imported fresh, so nothing a round file holds at module level survives into the next run.

**The scene is asserted.** After building it, the test compares the actual tab order against the
requested one and aborts on any mismatch. A scene that silently came out wrong must never reach a
conclusion. This also means a test may not lean on an unverified fact to build its scene.

**A recorded fact is asserted too.** Once a table is written down here, the test that produced it
carries that table as an expectation (`t.expectRow`), so a re-run either reproduces it or prints
`MISMATCH` with both sides. Discovering a new fact is the one case where a test only prints: the
expectation is added when the fact is written down.

**Identity.** Every tab gets a meaningful name at creation, carried in its url (`?tab=<name>`) so
it stays identifiable even across a browser restart, when nothing remembers its id. Real ids are
used only to call the API and never printed.

**Timing.** A test waits for a condition, not for a number. After the action under test the harness
waits until nothing has moved: no watched event for `QUIET_WAIT`, two identical readings of the
state, and every tab it created showing its own url instead of `about:blank` — a created tab always
starts blank, and a tab that has not arrived yet cannot be identified. How long that took is
printed in the action row. A fixed number is used only where the number is the fact itself, and
then it comes from a named constant of `test-addon/constants.js`.

**Events.** Listeners are attached before the action and removed after, filtered to the test's own
window. Noisy `tabs.onUpdated` (status, url, title, favicon) is dropped and the dropped count is
printed — a fact must never look more complete than it is.

**Distinguishing hypotheses.** When two explanations both fit, the test matrix must contain the
cells where they disagree, and the output must print whatever the hypotheses differ about. §1 of
TABGROUPS-BEHAVIOR.md was settled by exactly two rows out of eight.

**Visual checks.** `await t.ask('…')` stops the run at that exact frame, prints the window as the
API sees it and the question, and waits for `T.visualAnswer('…')`. The answer lands in the report
under its own question. A test may act again after an answer and ask about the next frame — each
question is answered while its own state is on screen, so several visual facts can live in one
test.

## 7. Lifecycle facts

Facts about the extension's own lifecycle — `runtime.onInstalled`, updates, enable/disable,
uninstall, what each storage survives — cannot be produced by `test-addon/`: the addon under test
is killed by the very actions being measured. They come from a throwaway stand of two addons (the
addon under test plus a log collector) that lives outside the repo and is rebuilt from its
description when a fact is disputed.

Their document keeps the same rules as the rest (§5), with these deviations:

- The table maps **actions to outcomes**, not tab indices to states — there is no window scene.
- The evidence marker is `L<n>` (§4). Next to each fact stand the **session ids** of the recorded
  log that produced it; the condensed log itself is an appendix of the document.
- The document must carry a description of the stand precise enough to rebuild it, and the
  environment of the recorded run (browser version, signed/unsigned installs, Firefox account
  state) — lifecycle behavior depends on all of it.
