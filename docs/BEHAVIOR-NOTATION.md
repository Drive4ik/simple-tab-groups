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

A test with several steps just keeps appending `action` / `state` rows to the same table. More
than one window in a test → one table per window, each with its own heading.

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
- **Suffixes** are plain text on purpose: `*` active, `(h)` hidden. Text and emoji are instantly
  told apart; two emoji next to each other are not.

Emoji are for the two things you scan for — which group a tab is in, and what is new. Everything
else stays text. Adding a third emoji axis makes the table noise again, which is exactly what this
notation replaced.

## 3. Events

When the fact is about event order, the events go in a fenced block under the table, with the
elapsed time from the start of the test:

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
  tab bar, the empty-title group button, part of the collapsed behavior). For those the harness
  builds the scene, leaves the window open, says what to look at, and the answer is recorded as
  👁️ plus the question that was answered.
- **`E<n>`** — legacy marker from the runs made before this harness existed. Those runs are not
  reproducible and their tables carry raw tab ids. Every `E<n>` fact is being re-verified; the
  marker is replaced with an `R` one as that happens. Do not mint new `E` numbers.

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
  TABGROUPS-BEHAVIOR.md. A fact that genuinely belongs to both is duplicated in both, with
  cross-references, and both copies are kept in sync.
- **No pinned tabs.** STG does not work with them, so they are outside the scope of these tests.

## 6. How a test is written

The add-on itself is disposable and lives outside the repo; these constraints are not, because a
test that breaks one of them produces a table that looks like a fact and is not one.

**Environment.** A clean profile, no other add-ons, `test-addon/` loaded through about:debugging
with `tabs`, `tabGroups`, `tabHide` and `browserSettings` permissions. Output goes through
`console.debug`, with console timestamps turned on.

**Isolation.** One test = one window it opens itself = one table. Tests never share a window and
never depend on the order they ran in. Between rounds the add-on is **reloaded** rather than cleaned
up: wiping all state is more reliable than unwinding it, and it is the only way an edited test file
is picked up.

**The scene is asserted.** After building it, the test compares the actual tab order against the
requested one and aborts on any mismatch. A scene that silently came out wrong must never reach a
conclusion. This also means a test may not lean on an unverified fact to build its scene.

**Identity.** Every tab gets a meaningful name at creation, carried in its url (`?tab=<name>`) so
it stays identifiable even across a browser restart, when nothing remembers its id. Real ids are
used only to call the API and never printed.

**Timing.** Browsers answer late. Wait ~2s after creating tabs that load a real url, ~100ms after
changing a browser setting, and ~500ms between an action and the snapshot that measures it.

**Events.** Listeners are attached before the action and removed after, filtered to the test's own
window. Noisy `tabs.onUpdated` (status, url, title, favicon) is dropped and the dropped count is
printed — a fact must never look more complete than it is.

**Distinguishing hypotheses.** When two explanations both fit, the test matrix must contain the
cells where they disagree, and the output must print whatever the hypotheses differ about. §1 of
TABGROUPS-BEHAVIOR.md was settled by exactly two rows out of eight.

**Visual checks.** A 👁️ test leaves its window open, asks its question in the output, and is run
alone — nobody remembers what a tab bar looked like twenty tests ago. The question may only be
about **the state the window is left in**: a test that acts once more after the interesting moment
has destroyed the very thing it asks about. One state to look at per run; another state means
another run.
