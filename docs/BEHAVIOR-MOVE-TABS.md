# Reference: Firefox behavior of plain `tabs.move` (no native groups)

Verified live on Firefox 154–155 (August 2026), §7 on Firefox 158 (October 2026), §8 in October 2026, with a throwaway
test add-on, in a clean profile with no other add-ons. All tests — without pinned tabs. Every fact here is one browser build on one machine;
a claim is as strong as the runs cited next to it, and no stronger.

Only facts confirmed by an actual test run belong here — never assumptions about how the browser
"probably" works. This file holds `tabs.move` behavior with **no native groups involved**; how a
move changes native-group membership lives in BEHAVIOR-TABGROUPS.md, tab creation and `index` —
in BEHAVIOR-CREATE-TABS.md. What overlaps is duplicated in both files with cross-references.

State tables, markers, confirmation rules and how the tests are written — BEHAVIOR-NOTATION.md.

**A new fact is appended as the next number at the end of the numbered sections, right before
"Implications for STG code". Numbers are never renumbered or reused** — code comments reference
them by number (`docs/BEHAVIOR-MOVE-TABS.md §1`).

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
  BEHAVIOR-TABGROUPS.md §17 (R9.02).

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
  `c1→p` (notation §2); the full opener picture is BEHAVIOR-OPENER.md §7. (R14.07)

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
  BEHAVIOR-OPENER.md §9. (R14.16)

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

BEHAVIOR-TABGROUPS.md §21 shows the block landing at the requested index when every other mover
stands beyond it. The rows below are the other cases — the calls `Tabs.ensureSorted` makes to
collect a group into a block: the target is the first tab's own index or the smallest index of
the set. In every run the set came out contiguous and in array order; the first mover behaves
like the anchor of `tabs.group` (BEHAVIOR-TABGROUPS.md §3) — it goes to the requested index (no
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

## 6. A tab with a LIVE microphone survives a cross-window move

- **`tabs.move` into another window keeps the capture.** The tab keeps its id, `sharingState`
  still reports `microphone: true`, the track of the page's own stream stays `live`, and the
  microphone indicator on the tab keeps blinking (👁️) — after the move out and after the move
  back alike. A `tabs.onUpdated {sharingState}` arrives right after the attach of the move back
  (the harness shows only window 1, the value itself was not printed). The microphone is requested by an
  injected script on a real page, the mover is not the active tab of its window. (R10.05)

  | tab index | 0 | 1 |
  | - | - | - |
  | before (window 1) | keep1* | ➕mic1 |
  | before (window 2) | w* | |
  | `tabs.move(mic1, {windowId: 2, index: -1})  — microphone is live, mic1 is not active` — settled 258 ms | | |
  | moved out (window 1) | keep1* | |
  | moved out (window 2) | w* | ➕mic1 |
  | `tabs.move(mic1, {windowId: 1, index: -1})  — back` — settled 265 ms | | |
  | moved back (window 1) | keep1* | ➕mic1 |
  | moved back (window 2) | w* | |

  The camera and screen sharing are not measured.

## 7. A cross-window move of a DISCARDED tab drops its `sessions` values; a loaded tab and a same-window move keep them; a value written again right after the resolve stays — until the next cross-window move

- **Gone at the resolve already, and gone for good.** `sessions.getTabValue` returns `undefined`
  for every key of the moved discarded tab right at the resolve of `tabs.move`, after the browser
  went quiet, 2000 ms later, and still after the tab is loaded by activation (R32.02). A tab born
  discarded, never loaded, loses them the same way (R32.06). Nothing announces the loss: the move
  delivers its `onDetached` / `onAttached` and no `tabs.onUpdated`.
- **A loaded tab keeps every value through the same move** (R32.01), and **a discarded tab moved
  inside its own window keeps them too** (R32.03).
- **`sessions.setTabValue` right after the resolve sticks.** Values written again on the moved
  discarded tabs are read back after quiet and 2000 ms later — three hidden and discarded tabs
  moved as one array, every one of them (R32.04). A late write, 2000 ms after the move and after
  the load, is read back too (R32.02, R32.06).
- **The next cross-window move loses them again.** The values written again after the first move
  are gone after the move back (R32.05).

  R32.04, the shape of an unloaded group of the add-on:

  | tab index | 0 | 1 | 2 | 3 |
  | - | - | - | - | - |
  | before (window A) | keepA* | m1(h) | m2(h) | m3(h) |
  | before (window B) | keepB* | | | |
  | `tabs.move([m1, m2, m3], {windowId: B, index: -1}), then sessions.setTabValue(...) again right at the resolve  // the repair of the add-on` — settled 276 ms | | | | |
  | after (window A) | keepA* | | | |
  | after (window B) | keepB* | m1(h) | m2(h) | m3(h) |

  ```text
      7ms  tabs.onDetached       m1  from index:1
      7ms  tabs.onAttached       m1  to index:1  [other window]
      7ms  tabs.onDetached       m2  from index:1
      7ms  tabs.onAttached       m2  to index:2  [other window]
      8ms  tabs.onDetached       m3  from index:1
      8ms  tabs.onAttached       m3  to index:3  [other window]
  ```

  Every mover: at the resolve `absent, absent` (then written again); after quiet and 2000 ms later
  `"m1-key1", "m1-key2"` — the written values.

  R32.05, the move back:

  | tab index | 0 | 1 |
  | - | - | - |
  | before (window A) | keepA* | mover |
  | before (window B) | keepB* | |
  | `tabs.move([mover], {windowId: B, index: -1}), then sessions.setTabValue(...) again right at the resolve  // the repair of the add-on` — settled 264 ms | | |
  | after (window A) | keepA* | |
  | after (window B) | keepB* | mover |
  | `tabs.move([mover], {windowId: A, index: -1})  // back, with the repaired values` — settled 259 ms | | |
  | back (window A) | keepA* | mover |
  | back (window B) | keepB* | |

  After the first move: at the resolve `absent, absent` (then written again), after quiet and
  2000 ms later the written values. Back in window A, 2000 ms later: `absent, absent`.

## 8. A cross-window move of a LOADED tab stamps `lastAccessed` with the moment of the move; a discarded tab and a hidden + discarded array keep it, and so does any same-window move

§8 comes from `round-34`, run in October 2026. Every stamp is printed as ms from the moment the
scene of the test was ready, next to the clock read right before and right after it (`read a..b`)
and the bracket of the move (`the move a..b`); the clock of the harness is the `Date.now()` of an
extension page, reduced to 1 ms buckets with jitter, so a bracket is widened by 1 ms on both sides
(`TIMER_PRECISION`). A stamp inside the bracket of the move is the moment of the move, equal to the
previous reading — unchanged. What the stamp is otherwise — creation, activation, a switch, hide,
discard, show, a restart — BEHAVIOR-CREATE-TABS.md §58.

- **A loaded tab arrives with the moment of the move** (R34.06): right at the resolve `a` carries
  a stamp inside the `tabs.move` call, and the readings after quiet and 2000 ms later give the
  same number. Before the move it held the moment of its creation.
- **A discarded tab keeps its stamp** (R34.06): `b`, discarded, and `c`, `d`, hidden and discarded
  and moved as one array, carry their creation stamps unchanged at the resolve, after quiet and
  2000 ms later; `c` and `d` arrive still hidden (§3).
- **A same-window move keeps it too** (R34.05): `a`, loaded, moved to the end, and `b`, `c`, hidden
  and discarded and moved as one array to the end — unchanged after the move and 2000 ms later.

  R34.05:

  | tab index | 0 | 1 | 2 | 3 |
  | - | - | - | - | - |
  | before | keep* | a | b(h) | c(h) |
  | `tabs.move([a], {index: -1})  // loaded` — settled 255 ms | | | | |
  | a moved | keep* | b(h) | c(h) | a |
  | `tabs.move([b, c], {index: -1})  // hidden and discarded` — settled 254 ms | | | | |
  | b, c moved | keep* | a | b(h) | c(h) |

  ```text
   1043ms  lastAccessed          a: -287 ms  [before]  read +534..+534  → other
   1044ms  lastAccessed          b: -277 ms  [before]  read +534..+535  → other
   1044ms  lastAccessed          c: -270 ms  [before]  read +535..+535  → other
      2ms  tabs.onMoved          a  1 → 3
    259ms  lastAccessed          a: -287 ms  [a moved]  read +794..+794, the move +535..+537, previous -287  → unchanged
      2ms  tabs.onMoved          b  1 → 3
      2ms  tabs.onMoved          c  1 → 3
    257ms  lastAccessed          b: -277 ms  [b, c moved]  read +1051..+1051, the move +794..+796, previous -277  → unchanged
    257ms  lastAccessed          c: -270 ms  [b, c moved]  read +1051..+1051, the move +794..+796, previous -270  → unchanged
   2259ms  lastAccessed          a: -287 ms  [2000 ms later]  read +3051..+3053, previous -287  → unchanged
   2260ms  lastAccessed          b: -277 ms  [2000 ms later]  read +3053..+3054, previous -277  → unchanged
   2261ms  lastAccessed          c: -270 ms  [2000 ms later]  read +3054..+3055, previous -270  → unchanged
  ```

  R34.06:

  | tab index | 0 | 1 | 2 | 3 | 4 |
  | - | - | - | - | - | - |
  | before (window A) | keep* | a | b | c(h) | d(h) |
  | before (window B) | keepB* | | | | |
  | `tabs.move([a], {windowId: B, index: -1})  // loaded` — settled 257 ms | | | | | |
  | a moved (window A) | keep* | b | c(h) | d(h) | |
  | a moved (window B) | keepB* | a | | | |
  | `tabs.move([b], {windowId: B, index: -1})  // discarded` — settled 257 ms | | | | | |
  | b moved (window A) | keep* | c(h) | d(h) | | |
  | b moved (window B) | keepB* | a | b | | |
  | `tabs.move([c, d], {windowId: B, index: -1})  // hidden and discarded` — settled 260 ms | | | | | |
  | c, d moved (window A) | keep* | | | | |
  | c, d moved (window B) | keepB* | a | b | c(h) | d(h) |

  ```text
   1438ms  lastAccessed          a: -295 ms  [before]  read +974..+975  → other
   1438ms  lastAccessed          b: -283 ms  [before]  read +975..+975  → other
   1438ms  lastAccessed          c: -277 ms  [before]  read +975..+975  → other
   1438ms  lastAccessed          d: -259 ms  [before]  read +975..+975  → other
     23ms  tabs.onDetached       a  from index:1
     23ms  tabs.onAttached       a  to index:1  [other window]
     28ms  lastAccessed          a: +977 ms  [a moved, at the resolve]  read +999..+1003, the move +975..+999, previous -295  → = the move
    289ms  lastAccessed          a: +977 ms  [a moved, after quiet]  read +1263..+1264, the move +975..+999, previous +977  → = the move, unchanged
   2292ms  lastAccessed          a: +977 ms  [a moved, 2000 ms later]  read +3265..+3267, the move +975..+999, previous +977  → = the move, unchanged
      9ms  tabs.onDetached       b  from index:1
     10ms  tabs.onAttached       b  to index:2  [other window]
     15ms  lastAccessed          b: -283 ms  [b moved, at the resolve]  read +3279..+3283, the move +3268..+3279, previous -283  → unchanged
    276ms  lastAccessed          b: -283 ms  [b moved, after quiet]  read +3544..+3544, the move +3268..+3279, previous -283  → unchanged
   2282ms  lastAccessed          b: -283 ms  [b moved, 2000 ms later]  read +5546..+5550, the move +3268..+3279, previous -283  → unchanged
     14ms  tabs.onDetached       c  from index:1
     14ms  tabs.onAttached       c  to index:3  [other window]
     15ms  tabs.onDetached       d  from index:1
     15ms  tabs.onAttached       d  to index:4  [other window]
     19ms  lastAccessed          c: -277 ms  [c, d moved, at the resolve]  read +5567..+5570, the move +5551..+5567, previous -277  → unchanged
     20ms  lastAccessed          d: -259 ms  [c, d moved, at the resolve]  read +5570..+5571, the move +5551..+5567, previous -259  → unchanged
    283ms  lastAccessed          c: -277 ms  [c, d moved, after quiet]  read +5833..+5834, the move +5551..+5567, previous -277  → unchanged
    284ms  lastAccessed          d: -259 ms  [c, d moved, after quiet]  read +5834..+5835, the move +5551..+5567, previous -259  → unchanged
   2286ms  lastAccessed          c: -277 ms  [c, d moved, 2000 ms later]  read +7835..+7837, the move +5551..+5567, previous -277  → unchanged
   2287ms  lastAccessed          d: -259 ms  [c, d moved, 2000 ms later]  read +7837..+7838, the move +5551..+5567, previous -259  → unchanged
  ```

  - a after the move: window B, index 1, active false, discarded false, hidden false, status complete
  - b after the move: window B, index 2, active false, discarded true, hidden false, status complete
  - c after the move: window B, index 3, active false, discarded true, hidden true, status complete
  - d after the move: window B, index 4, active false, discarded true, hidden true, status complete

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
   is refused (BEHAVIOR-OPENER.md §7). The children an opener leaves behind lose their links as
   well, with no event (§4, BEHAVIOR-OPENER.md §9).
4. **A same-window array gather forms the block around its first mover, not at the requested
   index** (§5): with the first tab's own index — or the set's smallest — as the target, the set
   always ends up contiguous and in array order, but it starts earlier by the number of tabs that
   stood before the first mover, and the first mover already in place fires no `tabs.onMoved`.
   `Tabs.ensureSorted` needs only contiguity and order, so that target is right for it; code that
   needs an exact landing index must read it from the resolved objects, not from the request.
5. **A tab with a live microphone can be moved between windows** (§6): `Tabs.move` into a LOADED
   group carries it like any other tab, the capture is not lost on the way. Into an unloaded
   group it is pinned away instead, because it cannot be hidden (BEHAVIOR-TABGROUPS.md §19).
6. **A discarded tab moved to another window needs its session values written again right
   after the move** (§7): `Tabs.moveNative` reads them before the move and writes them back after
   the resolve for every discarded tab whose window changed; a loaded tab and a same-window move
   need nothing. The loss repeats on every cross-window move, so the repair runs on every move.
7. **A cross-window move of a loaded tab marks it as touched** (§8): its `lastAccessed` becomes
   the moment of the move, so for the cloud sync the tabs of a loaded group moved to another
   window count as touched since (DESIGN-CLOUD-UPLOAD.md §1 "Keep local tabs since"); an unloaded
   group — hidden and discarded tabs — keeps its stamps, and so does a same-window sort
   (`Tabs.ensureSorted`). What the stamp is otherwise — BEHAVIOR-CREATE-TABS.md §58.
