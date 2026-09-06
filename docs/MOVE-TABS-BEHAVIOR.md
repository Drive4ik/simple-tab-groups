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

## 4. Same-window moves keep `openerTabId`; ANY cross-window move erases it silently

- A single-tab move and an array move within the window leave the opener link untouched. A move
  to another window erases the moved tab's `openerTabId` — when the child goes alone, and just
  the same when the opener and the child travel together in one call; moving the child back does
  not bring the link back, and no `tabs.onUpdated` announces the loss — only
  `onDetached`/`onAttached` are delivered. `tabs.update({openerTabId})` restores it once both
  tabs share a window; an opener left in another window is refused. Cells print the opener as
  `c1→p` (notation §2); the full opener picture is OPENER-BEHAVIOR.md §7. (R14.07)

  | tab index | 0 | 1 | 2 | 3 |
  | - | - | - | - | - |
  | before | p* | c1→p | c2→p | x |
  | `tabs.move(c2, {index: 0})  // same window` — settled 2129 ms | | | | |
  | moved in the window | c2→p | p* | c1→p | x |
  | `tabs.move([p, c1], {index: -1})  // array, same window` — settled 2122 ms | | | | |
  | array moved in the window | c2→p | x | p* | c1→p |
  | before (window 2) | w* | | | |
  | `tabs.move(c1, {windowId: 2, index: -1})  // the child alone` — settled 2136 ms | | | | |
  | child moved out (window 1) | c2→p | x | p* | |
  | child moved out (window 2) | w* | c1 | | |
  | `tabs.move(c1, {windowId: 1, index: -1})  // back to its opener` — settled 2124 ms | | | | |
  | child moved back (window 1) | c2→p | x | p* | c1 |
  | `tabs.move([p, c2], {windowId: 2, index: -1})  // opener and child together, one call` — settled 2120 ms | | | | |
  | pair moved out (window 1) | x | c1* | | |
  | pair moved out (window 2) | w* | p | c2 | |
  | `tabs.update(c2, {openerTabId: p})  // both in window 2 now` — settled 2120 ms | | | | |
  | restored by update (window 2) | w* | p | c2→p | |
  | `tabs.update(c1, {openerTabId: p})  // c1 in window 1, p in window 2` — settled 2117 ms | | | | |
  | after | x | c1* | | |

  ```text
      7ms  tabs.onDetached       c1  from index:3
      7ms  tabs.onAttached       c1  to index:1  [other window]
      8ms  tabs.onDetached       c1  from index:1  [other window]
      8ms  tabs.onAttached       c1  to index:3
     13ms  tabs.onDetached       p  from index:2
     13ms  tabs.onAttached       p  to index:1  [other window]
     14ms  tabs.onDetached       c2  from index:0
     15ms  tabs.onAttached       c2  to index:2  [other window]
  ```

- The other direction: the **opener** moves out alone and its children stay — the children lose
  their links too, silently; a child that follows into the opener's window arrives without a
  link, `tabs.update` restores it. A `tabs.get` inside `onDetached` and inside `onAttached`
  already shows the moved tab in the new window with no opener. The full picture is
  OPENER-BEHAVIOR.md §9. (R14.16)

  | tab index | 0 | 1 | 2 | 3 |
  | - | - | - | - | - |
  | before (window 1) | p* | c1→p | c2→p | x |
  | before (window 2) | w* | | | |
  | `tabs.move(p, {windowId: 2, index: -1})  // the opener alone, both children stay` — settled 2106 ms | | | | |
  | opener moved out (window 1) | c1* | c2 | x | |
  | opener moved out (window 2) | w* | p | | |
  | `tabs.move(c1, {windowId: 2, index: -1})  // the child follows into the opener's window` — settled 2157 ms | | | | |
  | child followed (window 1) | c2* | x | | |
  | child followed (window 2) | w* | p | c1 | |
  | `tabs.update(c1, {openerTabId: p})  // both in window 2` — settled 2125 ms | | | | |
  | restored by update (window 2) | w* | p | c1→p | |

  ```text
     11ms  tabs.onDetached       p  from index:0
     12ms  tabs.onAttached       p  to index:1  [other window]
     11ms  tabs.onDetached+get   p  opener absent  [other window]
     12ms  tabs.onAttached+get   p  opener absent  [other window]
     12ms  tabs.onDetached       c1  from index:0
     12ms  tabs.onAttached       c1  to index:2  [other window]
     12ms  tabs.onDetached+get   c1  opener absent  [other window]
     13ms  tabs.onAttached+get   c1  opener absent  [other window]
  ```

  `+get` lines are a `tabs.get` issued inside the listener, stamped with the listener's own time.

## 5. An array moved to an explicit index in its own window lands as one block in array order — around its first mover, not at the requested index

TABGROUPS-BEHAVIOR.md §21 shows the block landing at the requested index when every other mover
stands beyond it. The rows below are the other cases — the calls `Tabs.ensureSorted` makes to
collect a group into a block: the target is the first tab's own index or the smallest index of
the set. In every run the set came out contiguous and in array order; the first mover behaves
like the anchor of `tabs.group` (TABGROUPS-BEHAVIOR.md §3) — it goes to the requested index (no
move and no event when it already stands there) and each next mover lands right after the
previous one, wherever that one is by then.

- **Movers beyond the first mover's slot slide in after it; a hidden outsider block inside the
  set is pushed past the block and stays hidden — no `{hidden}` event.** Only the tab that had to
  travel fires `tabs.onMoved`. (R15.01)

  | tab index | 0 | 1 | 2 | 3 | 4 | 5 |
  | - | - | - | - | - | - | - |
  | before | g0* | g1 | h0(h) | h1(h) | h2(h) | gnew |
  | `tabs.move([g0, g1, gnew], {index: 0})  // index of g0 itself` — settled 259 ms | | | | | | |
  | after | g0* | g1 | gnew | h0(h) | h1(h) | h2(h) |

  ```text
      1ms  tabs.onMoved          gnew  5 → 2
  ```

- **A set standing in reverse order, gathered at its smallest index, comes out in array order.**
  The first mover travels to the requested index, the second lands after it; the third, already
  standing where the block ends, fires nothing. (R15.02)

  | tab index | 0 | 1 | 2 | 3 | 4 |
  | - | - | - | - | - | - |
  | before | x* | c | b | a | y |
  | `tabs.move([a, b, c], {index: 1})  // the smallest index of the set, held by c` — settled 256 ms | | | | | |
  | after | x* | a | b | c | y |

  ```text
      6ms  tabs.onMoved          a  3 → 1
      7ms  tabs.onMoved          b  3 → 2
  ```

- **A mover standing BEFORE the target makes the block start one slot EARLIER than requested.**
  The first mover stays put and fires nothing; the second is lifted from before it and placed
  right after — the gap closes and the pair sits at 1–2 though index 2 was asked for. The
  resolved objects report the real indexes. (R15.03)

  | tab index | 0 | 1 | 2 | 3 |
  | - | - | - | - | - |
  | before | x* | a | b | y |
  | `tabs.move([b, a], {index: 2})  // index of b itself, a stands before it` — settled 262 ms | | | | |
  | after | x* | b | a | y |

  ```text
      2ms  tabs.onMoved          a  1 → 2
  ```

- **Movers on both sides of the first mover: the same rule.** The block forms around the first
  mover in array order and slides left by the number of movers lifted from before it. (R15.04)

  | tab index | 0 | 1 | 2 | 3 | 4 |
  | - | - | - | - | - | - |
  | before | p* | x | q | y | r |
  | `tabs.move([q, p, r], {index: 2})  // index of q itself, p stands before it, r beyond` — settled 267 ms | | | | | |
  | after | x | q | p* | r | y |

  ```text
      1ms  tabs.onMoved          p  0 → 2
      1ms  tabs.onMoved          r  4 → 3
  ```

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
3. **Every cross-window move needs a re-link of `openerTabId`** (§4): the link is gone even when
   the opener moved along in the same call, and nothing announces it. Re-apply it after the move
   for the tabs whose opener is in the target window — and only for them, an opener left behind
   is refused (OPENER-BEHAVIOR.md §7). The children an opener leaves behind lose their links as
   well, with no event (§4, OPENER-BEHAVIOR.md §9).
4. **A same-window array gather forms the block around its first mover, not at the requested
   index** (§5): with the first tab's own index — or the set's smallest — as the target, the set
   always ends up contiguous and in array order, but it starts earlier by the number of tabs that
   stood before the first mover, and the first mover already in place fires no `tabs.onMoved`.
   `Tabs.ensureSorted` needs only contiguity and order, so that target is right for it; code that
   needs an exact landing index must read it from the resolved objects, not from the request.
