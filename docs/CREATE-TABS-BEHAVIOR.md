# Reference: creating tabs and the newTabPosition setting (`tabs.create`)

Verified live on Firefox 154 (August 2026) with a throwaway test add-on, in a clean profile with no
other add-ons. All tests — without pinned tabs. Every fact here is one browser build on one machine;
a claim is as strong as the runs cited next to it, and no stronger.

Only facts confirmed by an actual test run belong in "Verified facts" — never assumptions about how
the browser "probably" works. Native tab group facts live in TABGROUPS-BEHAVIOR.md; what overlaps is
duplicated in both files with cross-references.

State tables, markers, confirmation rules and how the tests are written — BEHAVIOR-NOTATION.md.

**A new fact is appended as the next number at the end of "Verified facts". Numbers are never
renumbered or reused** — code comments reference them by number
(`docs/CREATE-TABS-BEHAVIOR.md §4-5`, `§11`).

Mapping between the setting and prefs (the same thing `browser.browserSettings.newTabPosition`
reads/writes):

| newTabPosition | prefs |
| --- | --- |
| `afterCurrent` | `browser.tabs.insertAfterCurrent = true` |
| `relatedAfterCurrent` (browser default) | `browser.tabs.insertRelatedAfterCurrent = true`, `insertAfterCurrent = false` |
| `atEnd` | both false |

An extension holding the `browserSettings` permission can set this itself —
`browserSettings.newTabPosition.set({value})` applies immediately and reports
`levelOfControl: "controlled_by_this_extension"`; `.clear({})` gives the browser its default back,
which is `relatedAfterCurrent`. Tests switch it themselves; nothing is toggled by hand. (R1.01)

---

## Verified facts

### 1. relatedAfterCurrent behaves exactly like atEnd for tabs without an opener (R5.18–R5.23)

Under `relatedAfterCurrent` every pattern below produced the same result as under `atEnd` — end of
window, call order preserved, explicit index respected. Tabs created by the add-on almost never
have an opener (`createMultiple` strips `openerTabId` before creation) ⇒ for add-on tabs
**relatedAfterCurrent is equivalent to atEnd**. Hence also: the fallback "no permission for
`browserSettings` → assume atEnd" exactly matches the browser's default behavior.

### 2. An explicit `index` overrides newTabPosition completely (R5.09–R5.11, R5.15–R5.17, R5.21–R5.23, R5.28–R5.34)

This is the strongest fact in this document. **Every tab landed at exactly its requested index, in
every single run** — 21 runs, zero deviations:

| batch | settings covered | with an `active: true` tab | runs |
| - | - | - | - |
| 3 | all three | both with and without | R5.09/R5.10, R5.15/R5.16, R5.21/R5.22 |
| 5 | `afterCurrent` | with | R5.28–R5.31 |
| 10 | `afterCurrent` | with | R5.32–R5.34 |
| 30, really loading | `afterCurrent` | without | R6.08 |
| 100 | all three | both with and without | R6.01–R6.06 |
| 300 | `afterCurrent` | without | R6.07 |

The clamp runs below are counted separately: there the requested index is out of range on arrival.

The 30-tab run is the odd one out on purpose — every other large batch is created `discarded`, so it
shows the clean ordering is not an artefact of skipping the load.

| tab index | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
| - | - | - | - | - | - | - | - | - | - | - |
| before | s0 | w1 | w2* | w3 | w4 | | | | | |
| `Promise.all` of 5 creates with index 5..9, n2 has `active: true` — under `afterCurrent` | | | | | | | | | | |
| after | s0 | w1 | w2 | w3 | w4 | ➕n0 | ➕n1 | ➕n2* | ➕n3 | ➕n4 |

One out-of-order sequence was tested, and it self-healed through clamp — a window of 2 tabs,
creating with index 4, then 2, then 3, gives the same result under all three settings
(R5.11, R5.17, R5.23). The too-large index 4 is clamped to the end of the window, and the two later
calls push that tab back out to 4:

| tab index | 0 | 1 | 2 | 3 | 4 |
| - | - | - | - | - | - |
| before | a* | b | | | |
| `create(index: 4)`, then `create(index: 2)`, then `create(index: 3)` | | | | | |
| after | a* | b | ➕i2 | ➕i3 | ➕i4 |

That is the only out-of-order sequence anyone has run, so it says nothing about out-of-order calls
in general. For **increasing** indexes — which is what the add-on always sends — there is no known
exception. See §11 for the claim this replaced.

### 3. Hidden tabs occupy the window's index space (R5.02)

`tabs.create` with an index inside a hidden block inserts the tab exactly there, and the new tab is
of course visible:

| tab index | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
| - | - | - | - | - | - | - | - |
| before | t1* | t2(h) | t3(h) | t4(h) | t5 | t6 | |
| `tabs.create({index: 2})` | | | | | | | |
| after | t1* | t2(h) | ➕inserted | t3(h) | t4(h) | t5 | t6 |

The foundation for creating tabs in unloaded groups by anchor.

### 4. afterCurrent without index: every new tab goes right after the active one, so a batch comes out REVERSED (R5.12, R5.13, R5.38–R5.40)

`afterCurrent` inserts each new tab at "index of the active tab + 1". The active tab does not move,
so each new tab pushes the previous ones further right and the batch ends up in **reverse call
order**:

| tab index | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
| - | - | - | - | - | - | - | - | - | - | - |
| before | s0 | w1 | w2* | w3 | w4 | | | | | |
| `Promise.all([create(n0) … create(n4)])` — no index | | | | | | | | | | |
| after | s0 | w1 | w2* | ➕n4 | ➕n3 | ➕n2 | ➕n1 | ➕n0 | w3 | w4 |

**`Promise.all` and a sequential `await` loop give identical results** (R5.12 vs R5.13) — the
mechanism is the insertion point, not the concurrency. Three repetitions produced byte-identical
output: this is deterministic, not a race.

### 5. afterCurrent without index + `active: true` on a batch tab → that tab becomes the anchor (R5.14, R5.35–R5.37)

The tab created with `active: true` becomes the window's active tab the moment it appears, so every
tab created **after** it is inserted right after **it** rather than after the original active tab:

| tab index | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
| - | - | - | - | - | - | - | - | - | - | - |
| before | s0 | w1 | w2* | w3 | w4 | | | | | |
| `Promise.all` of 5 creates, no index, n2 has `active: true` | | | | | | | | | | |
| after | s0 | w1 | w2 | ➕n2* | ➕n4 | ➕n3 | ➕n1 | ➕n0 | w3 | w4 |

Step by step: n0 lands at 3; n1 lands at 3 and pushes n0 to 4; n2 lands at 3, pushes n1 and n0
right, and becomes active; n3 now lands at 4, right after n2; n4 lands at 4 and pushes n3 to 5.
The result reads as "the activating tab first, then everything else in reverse call order", and it
reproduced identically three times out of three.

### 6. Without an explicit `windowId` the target is the last active window (R5.24)

With a scene window in the background and another window freshly focused, `tabs.create` without
`windowId` put the tab in the **focused** window, leaving the scene window untouched. The add-on's
standard is still explicit windowId+index for bulk creation.

### 7. An explicit index inside a native group's span → the tab joins the group (R5.03)

`tabs.create` obeys the same membership rule as `tabs.move`: the new tab takes the group of
whichever tab held that index. It is grouped from birth — `tabs.onCreated` already reports the group
(`group:🟥`), with no follow-up `tabs.onUpdated {groupId}` the way a `tabs.move` produces one.

| tab index | 0 | 1 | 2 | 3 | 4 | 5 |
| - | - | - | - | - | - | - |
| before | a* | 🟥 gr1 | 🟥 gr2 | b | | |
| `tabs.create({index: 2})` — that slot held 🟥 gr2 | | | | | | |
| after | a* | 🟥 gr1 | 🟥 ➕onMember | 🟥 gr2 | b | |
| `tabs.create({index: 4})` — that slot held b | | | | | | |
| after | a* | 🟥 gr1 | 🟥 ➕onMember | 🟥 gr2 | ➕onOutsider | b |

Duplicate of TABGROUPS-BEHAVIOR.md §7, which states the same rule from the groups side — keep both
copies in sync.

### 8. `windows.create({url: [...]})` preserved the array order in every run (R5.04, R5.26)

13 attempts — three with 5 urls, ten with 8 urls — all came back in the requested order.

An earlier note in this document claimed the opposite, with examples of scrambled windows
(`w1 w5 w2 w3 w4`). **That did not reproduce, not once.** The claim is withdrawn: it is either
fixed, or it depended on something these runs did not have.

This is *not* a promise of ordering — the API does not document one, and 13 clean runs cannot prove
a negative. STG creates its own windows empty (`windows.create()` + `Groups.apply`) and fills them
with explicit indexes, which is immune either way; keep it that way.

### 9. afterCurrent works in a non-focused window when windowId is explicit (R5.25)

With another window holding the focus, a tab created with an explicit `windowId` and no index still
landed immediately after the **target** window's active tab:

| tab index | 0 | 1 | 2 | 3 | 4 |
| - | - | - | - | - | - |
| before | w1 | w2 | w3* | w4 | |
| `tabs.create({windowId: sceneWindow})` — no index, that window not focused | | | | | |
| after | w1 | w2 | w3* | ➕n0 | w4 |

### 10. Parallel creation is consistently faster, by roughly 1.8x (R5.05, R5.27)

Discarded tabs, measured in both orders so the warm-up cost falls on each side in turn:

| batch | parallel | sequential | ratio |
| - | - | - | - |
| 30 tabs, parallel first | 35 ms | 110 ms | 3.1x |
| 30 tabs, sequential first | 43 ms | 50 ms | 1.2x |
| 100 tabs, parallel first | 98 ms | 166 ms | 1.7x |
| 100 tabs, sequential first | 98 ms | 172 ms | 1.8x |

At 30 tabs the measurement is noise; at 100 it is stable at **1.7–1.8x**. Parallel wins in every
single pass, so `Promise.all` remains the rule for bulk creation — it costs nothing and is never
slower.

**Only the ratio travels; the milliseconds do not.** These runs are from a fast machine, and STG has
users restoring 1000+ tabs on hardware from 2016. An earlier note here extrapolated "minutes of
delay" from numbers like these — that extrapolation was never measured and is not a fact. What is
measured is that the sequential path costs about 1.8x more of whatever a tab costs on the machine in
front of you, and that multiplier is exactly what hurts most on the slow ones.

### 11. `active: true` does NOT break an explicit index (R5.10, R5.16, R5.22, R5.28–R5.34)

An earlier version of this document claimed that under `afterCurrent` and the default
`relatedAfterCurrent` an activating tab ignores its own index, lands right after the former active
tab and scatters the whole batch, and that only `atEnd` respects index fully.

**None of that reproduced.** Batches of 3 and of 100, each with explicit indexes and one
`active: true` in the middle, placed every tab exactly where asked under all three settings
(R5.10/R5.16/R5.22, R6.04–R6.06), and batches of 5 and 10 did the same under `afterCurrent` in all
seven attempts (R5.28–R5.34). See the table in §2. The claim is withdrawn.

`active: true` only matters when there is **no** explicit index — that is §5.

### 12. A tab is created with `about:blank`, the real `url` arrives later (R5.01)

`tabs.create` resolves with `url: "about:blank"`, and `tabs.get` still reports `about:blank`
immediately after — whatever the url was. How long it stays blank is what differs:

| requested url | at `create` | immediately after | after 200 ms | after a further 2 s |
| - | - | - | - | - |
| a page of the add-on itself | `about:blank` | `about:blank` | the real url | the real url |
| `https://example.com/` | `about:blank` | `about:blank` | `about:blank` | the real url |

When within those 2 s the network page's url arrived was not measured. Any code that filters tabs by
url has to wait, and must not take the local timing as the general case.

---

## Conclusions for the add-on

- **Bulk creation** (restore, unarchive, sync, bookmarks): explicit `windowId` + explicit
  increasing `index` (anchor + i) + `Promise.all`. §2 held in every run — all three settings, with
  and without an `active: true` tab, at batch sizes up to 300. That is restore scale, so this is
  measured rather than extrapolated; above 300 it is still an expectation, and `needSorting` stays
  as the net (last bullet).
- **Anchor** for a group — `Tabs.getNewTabIndex(group.tabs)`: afterCurrent → after the tab with
  max `lastAccessed`, otherwise/without permission — end of the group (exactly matches the
  browser, §1). Without group context — end of the window.
- The anchor may land inside a native subgroup's span → the tab will join that subgroup
  (§7); this is expected, the mirror syncs membership.
- **A single new tab**: into a loaded group — do NOT pass index, the browser itself will place
  it by newTabPosition, including non-focused windows (§9); into an unloaded one — an
  explicit index by the `getNewTabIndex` anchor (hidden tabs are addressable by index, §3).
- **The historical reason for creating a batch inactive and activating afterwards is gone.** It
  rested on the old §11, which no longer holds: an explicit index survives `active: true`. Creating
  inactive and activating in a separate `tabs.update` is still perfectly safe, just no longer
  required for correct ordering. Whether `createMultiple` keeps that shape is a code decision, not
  a browser constraint.
- `needSorting` in `createMultiple` still guards the no-index paths, where §4 and §5 make the order
  genuinely non-obvious; on the explicit-index paths it must stay silent — log any firing as warn.

## Open questions

None. Add new facts and test results to the end of "Verified facts" under the next free number.
