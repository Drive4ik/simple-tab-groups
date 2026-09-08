# Reference: Firefox behavior of `tabs.remove` (no native groups)

Verified live on Firefox 155 (August 2026) with a throwaway test add-on, in a clean profile with no
other add-ons. All tests — without pinned tabs, except §2 whose subject is the pinned tab itself.
Every fact here is one browser build on one machine; a claim is as strong as the runs cited next
to it, and no stronger.

Only facts confirmed by an actual test run belong here — never assumptions about how the browser
"probably" works. This file holds `tabs.remove` behavior; moving tabs — MOVE-TABS-BEHAVIOR.md,
creation and `index` — CREATE-TABS-BEHAVIOR.md, native groups — TABGROUPS-BEHAVIOR.md.

State tables, markers, confirmation rules and how the tests are written — BEHAVIOR-NOTATION.md.

**A new fact is appended as the next number at the end of the numbered sections, right before
"Implications for STG code". Numbers are never renumbered or reused** — code comments reference
them by number (`docs/REMOVE-TABS-BEHAVIOR.md §1`).

---

## 1. Removing the last visible tab closes the WINDOW — hidden tabs die with it

- **A window left with only hidden (tabHide) tabs is not allowed to exist: removing the last
  visible tab closes the whole window, killing every hidden tab in it.** No hidden tab is
  revealed — there is no `tabs.onUpdated {hidden: false}` and no `tabs.onActivated`; the hidden
  tabs get `tabs.onRemoved {isWindowClosing: true}` and the window fires `windows.onRemoved`. The
  `tabs.remove` promise resolves normally. Confirmed in three shapes: every visible tab removed in
  ONE array call (R13.01), one-by-one with the active tab last (R13.02), and hidden neighbours on
  both sides of the removed tab (R13.03) — nobody is revealed, adjacency never comes into play.

  | tab index | 0 | 1 | 2 | 3 |
  | - | - | - | - | - |
  | before | v1* | v2 | h1(h) | h2(h) |
  | `tabs.remove([v1, v2])` — every visible tab in one call | | | | |

  ```text
      5ms  tabs.onRemoved        v2  isWindowClosing:false
     15ms  tabs.onRemoved        v1  isWindowClosing:true
     16ms  tabs.onRemoved        h1  isWindowClosing:true
     16ms  tabs.onRemoved        h2  isWindowClosing:true
     16ms  windows.onRemoved     SCENE window closed
  ```

  The array is removed sequentially: `v2` still reports `isWindowClosing: false` (a visible tab
  remains at that instant), removing `v1` — the last visible — flips the window into closing, and
  `v1`, `h1`, `h2` all report `isWindowClosing: true`. (R13.01)

- **A discarded hidden tab does not save the window either** — same closure, same events. (R13.05)

## 2. A pinned tab keeps the window alive

- **With a pinned tab present the window survives**: the pinned tab becomes active
  (`tabs.onActivated`), the hidden tab stays hidden — no reveal, no closure. (R13.04)

  | tab index | 0 | 1 | 2 |
  | - | - | - | - |
  | before | p(p) | v1* | h1(h) |
  | `tabs.remove(v1)` — the only visible unpinned tab | | | |
  | after | p*(p) | h1(h) | |

  ```text
      9ms  tabs.onRemoved        v1  isWindowClosing:false
      9ms  tabs.onActivated      p  previous:-
  ```

## 3. A tab removed by `tabs.remove` has left `tabs.query` before `tabs.onRemoved` fires

- **From inside the `onRemoved` handler `tabs.query` no longer returns the removed tab; at the
  resolve of `tabs.remove` it is gone as well.** The state bugzilla 1396758 describes — a closing
  tab still in `tabs.query` after `onRemoved` — did not arise for an API removal: neither for an
  inactive tab from the middle of the window (R23.01) nor for the ACTIVE tab, whose blur
  (`tabs.onActivated`) is delivered together with `onRemoved` (R23.04).

  | tab index | 0 | 1 | 2 | 3 |
  | - | - | - | - | - |
  | before | a* | b | c | d |
  | `tabs.remove(b)` — sampled from onRemoved until gone | | | | |
  | after | a* | c | d | |

  ```text
      3ms  tabs.onRemoved        b  isWindowClosing:false
      5ms  onRemoved+query       count:3, b gone
      5ms  tabs.remove resolved  count:3, b gone
      7ms  tabs.query            b gone after 0 more sample(s), 2 ms after onRemoved
  ```

- **A create issued from inside the handler at `index: 3` — the count of the remaining tabs —
  appends** at the real end of the strip; with the removed tab already gone, the count with and
  without it is the same number (R23.02, R23.03, R23.05). Whether a tab that IS still closing
  holds an index slot for `tabs.create` is not answered by these runs: no run had such a tab.

  | tab index | 0 | 1 | 2 | 3 |
  | - | - | - | - | - |
  | before | a* | b | c | d |
  | `await tabs.remove(b); tabs.create(n1, {index: count WITHOUT b})` — settled 249 ms | | | | |
  | after | a* | c | d | ➕n1 |

  ```text
      2ms  tabs.onRemoved        b  isWindowClosing:false
      2ms  tabs.remove resolved
      3ms  tabs.query            count:3, b gone
      3ms  tabs.create           index:3 (count WITHOUT the closing tab)
      9ms  tabs.onCreated        n1  index:3 group:-1
     12ms  tabs.create resolved  n1 at index 3; count:4, b gone
  ```

## 4. A tab the USER closes stays in `tabs.query` after `tabs.onRemoved` — and keeps its index slot

- **After a user's close — the close button of an inactive tab (R23.06), Ctrl+W on the active
  one (R23.07) — `tabs.query` from inside the `onRemoved` handler still returns the tab at its
  old index, and keeps returning it for about 110 ms** (4 samples of 25 ms), the state of
  bugzilla 1396758. The closing tab occupies a real slot: a `tabs.create` at `index: 3` — the
  count of the tabs WITHOUT it — lands between `c` and `d`, and the strip settles as
  `[a, c, ➕n1, d]`, one slot short of the end. The count WITH the closing tab, `4`, is the
  browser's own coordinate for "append". The ACTIVE tab is no different: its blur
  (`tabs.onActivated`) comes right after `onRemoved`, the tab itself stays for the same ~110 ms.

  | tab index | 0 | 1 | 2 | 3 |
  | - | - | - | - | - |
  | before | a* | b | c | d |
  | `USER: Hover tab b (the second tab, NOT the active one) and click its close button` | | | | |
  | after | a* | c | ➕n1 | d |

  ```text
  18977ms  tabs.onRemoved        b  isWindowClosing:false
  18985ms  tabs.query            count:4, b present at index 1
  18985ms  tabs.create           index:3 (count WITHOUT the closing tab)
  18989ms  tabs.onCreated        n1  index:3 group:-1
  18995ms  tabs.create resolved  n1 at index 3; count:5, b present at index 1
  19105ms  tabs.query            b gone after 4 more sample(s), 110 ms after onRemoved
  ```

  (R23.06; the clock counts from the moment the harness asked for the gesture)

  | tab index | 0 | 1 | 2 | 3 |
  | - | - | - | - | - |
  | before | a | b* | c | d |
  | `USER: Click into the scene window so tab b (the active one) has focus and press Ctrl+W` | | | | |
  | after | a | c* | ➕n1 | d |

  ```text
  13172ms  tabs.onRemoved        b  isWindowClosing:false
  13174ms  tabs.onActivated      c  previous:-
  13178ms  tabs.query            count:4, b present at index 1
  13178ms  tabs.create           index:3 (count WITHOUT the closing tab)
  13183ms  tabs.onCreated        n1  index:3 group:-1
  13187ms  tabs.create resolved  n1 at index 3; count:5, b present at index 1
  13298ms  tabs.query            b gone after 4 more sample(s), 111 ms after onRemoved
  ```

  (R23.07)

## Implications for STG code

1. **Any addon flow that removes tabs can close a user's window as a side effect** (§1): if the
   removal covers all visible tabs of a window that stores hidden tabs of unloaded groups, the
   window dies and takes them along. `Tabs.createTempActiveTab` before such a removal is the
   existing prevention pattern; a pinned tab also prevents the closure by itself (§2), and
   `Tabs.createTempActiveTab` already prefers activating a pinned tab over creating a temp one.
2. **The closure is announced only by `tabs.onRemoved {isWindowClosing: true}` plus
   `windows.onRemoved`** (§1) — never by a `{hidden: false}` update. Bookkeeping that waits for a
   reveal event will never see one.
3. **An appending index is the browser's own count, closing tabs included** (§4): the
   `tabs.query({windowId}).length` reads in `Tabs.createMultiple` and `Tabs.resolveMoveIndex`
   go to the browser directly, past `Tabs.query`. A tab the user has just closed holds its slot
   for ~110 ms after `onRemoved`, so a count taken from a read that filters `skip.removed` out
   lands the new tab one slot short. For a tab the addon removes itself the two counts agree
   (§3), which is why the API runs alone could not tell the hypotheses apart.
4. **The `skip.removed` filter in `Tabs.prepare` is for the user's closes, not the addon's**
   (§3, §4): a tab removed through `tabs.remove` is gone from `tabs.query` before its
   `onRemoved` arrives, a tab closed by the user lingers for ~110 ms and would otherwise show
   up in every read the addon makes in that window.
