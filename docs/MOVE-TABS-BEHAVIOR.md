# Reference: Firefox behavior of plain `tabs.move` (no native groups)

Verified live on Firefox 154 (August 2026) with a throwaway test add-on, in a clean profile with no
other add-ons. All tests — without pinned tabs. Every fact here is one browser build on one machine;
a claim is as strong as the runs cited next to it, and no stronger.

Only facts confirmed by an actual test run belong here — never assumptions about how the browser
"probably" works. This file holds `tabs.move` behavior with **no native groups involved**; how a
move changes native-group membership lives in TABGROUPS-BEHAVIOR.md, tab creation and `index` —
in CREATE-TABS-BEHAVIOR.md. What overlaps is duplicated in both files with cross-references.

State tables, markers, confirmation rules and how the tests are written — BEHAVIOR-NOTATION.md.

**A new fact is appended as the next number at the end of the numbered sections, right before
"Implications for STG code". Numbers are never renumbered or reused** — code comments reference
them by number (`docs/MOVE-TABS-BEHAVIOR.md §1`).

---

## 1. Moving hidden tabs (tabHide)

- **A hidden tab moved within its own window stays hidden**, and the Tab object the call resolves
  with reports the truth: `hidden: true`. (R7.01)

  | tab index | 0 | 1 | 2 |
  | - | - | - | - |
  | before | a* | mover(h) | b |
  | `tabs.move(mover, {index: 0})` | | | |
  | after | mover(h) | a* | b |

  Resolved object: `hidden:true index:0 groupId:-1`; a fresh `tabs.get` agrees.

- **A hidden tab moved to another window arrives VISIBLE.** The move itself reveals it: both the
  resolved Tab objects and a fresh `tabs.get` report `hidden: false`. (R7.02)

  | tab index | 0 | 1 | 2 |
  | - | - | - | - |
  | before (window 1) | a* | mover(h) | vis |
  | before (window 2) | not created yet | | |
  | `tabs.move([mover(h), vis], {windowId: win2, index: -1})` | | | |
  | after (window 1) | a* | | |
  | after (window 2) | w2tab* | mover | vis |

  `w2tab` is the target window's own initial tab. `mover` arrived **visible** — no `(h)`:
  resolved objects reported `mover: hidden:false index:1`, `vis: hidden:false index:2`, and fresh
  `tabs.get` for both agreed. Tested exactly this configuration: an array of two tabs, one of them
  hidden, `{index: -1}`, no groups in the target window. Single-tab moves, explicit indices and a
  grouped target slot were not part of the run.

## Implications for STG code

1. **A cross-window `tabs.move` reveals hidden tabs** (§1) — never assume a tab is still hidden
   after moving it to another window; re-hide it explicitly. The resolved Tab objects report the
   post-move truth (§1), so `hidden`-filters must run on them, not on pre-move snapshots.
