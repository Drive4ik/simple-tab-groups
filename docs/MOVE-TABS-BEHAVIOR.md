# Reference: Firefox behavior of plain `tabs.move` (no native groups)

Verified live on Firefox 154–155 (August 2026) with a throwaway test add-on, in a clean profile
with no other add-ons. All tests — without pinned tabs. Every fact here is one browser build on one machine;
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
  resolved Tab objects and a fresh `tabs.get` report `hidden: false`. (R7.02) The browser's own
  gestures reveal the same way — and silently, with no `tabs.onUpdated {hidden}` at all:
  TABGROUPS-BEHAVIOR.md §17 (R9.02).

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

## 2. `tabs.onDetached` / `tabs.onAttached` vs the `tabs.move()` promise

- **Both events are delivered BEFORE the move promise resolves — every time.** Firefox 155,
  445 cross-window moves in seven regimes, 890 attach and 890 detach events: not one landed after
  the resolve. Order was judged by a shared sequence counter, not clocks (clock reads are clamped
  to ~1 ms); the clocks put the events 0–5 ms before the resolve. (R12.01–R12.07)

  | run | trips × tabs | regime | after resolve | attach gap min/med/max ms | detach gap min/med/max ms |
  | - | - | - | - | - | - |
  | R12.01 | 30 × 1 | paced, visible | none | 0/0/1 | 0/0/1 |
  | R12.02 | 60 × 1 | rapid, visible | none | 0/0/1 | 0/0/1 |
  | R12.03 | 20 × 5 | paced, hidden | none | 0/1/3 | 0/1/3 |
  | R12.04 | 20 × 5 | paced, hidden+discarded | none | 0/1/4 | 0/1/4 |
  | R12.05 | 20 × 5 | paced, hidden, `show()` right after the move | none | 0/2/3 | 1/2/3 |
  | R12.06 | 40 × 10 | rapid, visible | none | 0/3/5 | 1/3/5 |
  | R12.07 | 20 × 5 | rapid, hidden+discarded, `show()` right after | none | 0/1/3 | 0/1/3 |

  "Paced" waits for each trip's events before the next trip; "rapid" fires trips back to back with
  no waits. In R12.05/R12.07 `tabs.show()` was called immediately after the move resolve — no event
  slipped past even that second resolve. Tested exactly this matrix: ping-pong between two windows
  with `{windowId, index: -1}`; explicit indices, moves into live spans and a deliberately loaded
  machine were not part of the run.

## 3. Hidden + discarded tabs moved to another window arrive still HIDDEN

- **Discard cancels the §1 reveal.** The same cross-window ping-pong that ends visible with plain
  hidden tabs (R12.03) ends hidden when the tabs are also discarded (R12.04): after the final
  `tabs.move([m1..m5], {windowId: A, index: -1})` of hidden+discarded tabs all five arrived
  hidden. The only difference between the two runs is the `tabs.discard` before each move.

  | tab index | 0 | 1 | 2 | 3 | 4 | 5 |
  | - | - | - | - | - | - | - |
  | after (window A), hidden movers — R12.03 | keepA* | m1 | m2 | m3 | m4 | m5 |
  | after (window A), hidden+discarded movers — R12.04 | keepA* | m1(h) | m2(h) | m3(h) | m4(h) | m5(h) |

  The evidence is the end state of a 20-trip loop (`hide`, `discard`, `move`, both directions):
  only the final arrival is snapshotted, and only for an array of 5 with `{index: -1}` and no
  groups anywhere. Before code leans on this, a dedicated test should pin it down — single tab,
  both directions, explicit indices.

## Implications for STG code

1. **A cross-window `tabs.move` reveals hidden tabs** (§1) — never assume a tab is still hidden
   after moving it to another window; re-hide it explicitly. The resolved Tab objects report the
   post-move truth (§1), so `hidden`-filters must run on them, not on pre-move snapshots. The
   exception is a hidden tab that is also **discarded** — it arrives still hidden (§3), but §3
   needs a dedicated test before code relies on it.
2. **Per-tab mute flags removed right after the `tabs.move()` resolve DO cover the move's own
   `onDetached`/`onAttached`** (§2): the browser delivers both before the promise resolves, so a
   handler's synchronous prologue — the skip-flag checks — always runs while the flags are still
   set.
