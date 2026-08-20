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

## Implications for STG code

1. **Any addon flow that removes tabs can close a user's window as a side effect** (§1): if the
   removal covers all visible tabs of a window that stores hidden tabs of unloaded groups, the
   window dies and takes them along. `Tabs.createTempActiveTab` before such a removal is the
   existing prevention pattern; a pinned tab also prevents the closure by itself (§2), and
   `Tabs.createTempActiveTab` already prefers activating a pinned tab over creating a temp one.
2. **The closure is announced only by `tabs.onRemoved {isWindowClosing: true}` plus
   `windows.onRemoved`** (§1) — never by a `{hidden: false}` update. Bookkeeping that waits for a
   reveal event will never see one.
