# Reference: Firefox behavior of `tab.openerTabId`

Verified live on Firefox 155 (August 2026) with a throwaway test add-on, in a clean profile with
no other add-ons — and, for the Tree Style Tab section, in a profile with that add-on alone. All
tests — without native groups, and without pinned tabs except §17, whose subject is the pin. Every
fact here is one browser build on one machine; a claim is as strong as the runs cited next to it,
and no stronger.

Only facts confirmed by an actual test run belong here — never assumptions about how the browser
"probably" works. This file holds the opener link itself: how it is set, what carries it, what
erases it. The closing section, "How STG carries the link", is the one exception: not browser
facts but the model STG implements on top of them. Where a fact is also about creation or movement, a copy lives in CREATE-TABS-BEHAVIOR.md
or MOVE-TABS-BEHAVIOR.md with a cross-reference, and both copies are kept in sync.

State tables, markers, confirmation rules and how the tests are written — BEHAVIOR-NOTATION.md.
In this document every cell also prints the opener: `c1→p` means `c1.openerTabId` points at `p`,
no arrow — no opener (notation §2).

**A new fact is appended as the next number at the end of "Verified facts". Numbers are never
renumbered or reused** — code comments reference them by number (`docs/OPENER-BEHAVIOR.md §7`).

---

## Verified facts

### 1. `tabs.create({openerTabId})` carries the opener everywhere (R14.01)

The object `tabs.create` resolves with, a fresh `tabs.get` and `tabs.query` all report the opener
right away. No `tabs.onUpdated` follows — the link is part of the creation.

| tab index | 0 | 1 | 2 |
| - | - | - | - |
| before | p* | x | |
| `tabs.create({url: c, openerTabId: p})` — settled 2170 ms | | | |
| after | p* | x | ➕c→p |

### 2. Under relatedAfterCurrent a tab created WITH an opener and WITHOUT an index lands right after its opener; an explicit index still wins (R14.02)

CREATE-TABS-BEHAVIOR.md §1 covers tabs without an opener — for them relatedAfterCurrent equals
atEnd. With an opener the "related" half of the setting kicks in: the new tab goes directly after
its opener, whether the opener is the active tab or not. An explicit `index` overrides that
placement exactly as CREATE-TABS-BEHAVIOR.md §2 states for tabs without an opener — the opener is
kept, the position is the requested one. (Copy: CREATE-TABS-BEHAVIOR.md §14.)

| tab index | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
| - | - | - | - | - | - | - | - |
| before | p* | a | b | | | | |
| `tabs.create({openerTabId: p})  // p is active, no index` — settled 2114 ms | | | | | | | |
| no index, opener active | p* | ➕c1→p | a | b | | | |
| `tabs.create({openerTabId: a})  // a is NOT active, no index` — settled 2135 ms | | | | | | | |
| no index, opener inactive | p* | ➕c1→p | a | ➕c2→a | b | | |
| `tabs.create({openerTabId: p, index: 0})` — settled 2127 ms | | | | | | | |
| index 0 | ➕c3→p | p* | ➕c1→p | a | ➕c2→a | b | |
| `tabs.create({openerTabId: p, index: 6})  // the end of the window` — settled 2143 ms | | | | | | | |
| index at the end | ➕c3→p | p* | ➕c1→p | a | ➕c2→a | b | ➕c4→p |

### 3. `tabs.update({openerTabId})` sets, re-points and clears the opener; every change is announced by `tabs.onUpdated` (R14.03)

- Setting and re-pointing work on any existing tab; the resolved object already carries the new
  opener.
- `-1` clears the link: afterwards the property is **absent** from the Tab object
  (`'openerTabId' in tab → false`), not `-1`.
- A tab may be pointed at **itself** — the call resolves and `c→c` is what every read reports
  afterwards. Nothing in the browser refuses it.
- Each call fires exactly one `tabs.onUpdated` with `changeInfo.openerTabId` — the new id, or `-1`
  for the clear. This is the channel a tree extension listens on.

| tab index | 0 | 1 | 2 |
| - | - | - | - |
| before | p* | c | x |
| `tabs.update(c, {openerTabId: p})` — settled 2118 ms | | | |
| set | p* | c→p | x |
| `tabs.update(c, {openerTabId: x})  // re-point` — settled 2155 ms | | | |
| re-pointed | p* | c→x | x |
| `tabs.update(c, {openerTabId: -1})  // clear` — settled 2132 ms | | | |
| cleared | p* | c | x |
| `tabs.update(c, {openerTabId: c})  // itself` — settled 2116 ms | | | |
| after | p* | c→c | x |

```text
    1ms  tabs.onUpdated        c  {openerTabId: p}
    1ms  tabs.onUpdated        c  {openerTabId: x}
    1ms  tabs.onUpdated        c  {openerTabId: none}
    2ms  tabs.onUpdated        c  {openerTabId: c}
```

### 4. hide / show never touch the opener; a hidden tab can be re-pointed, at a hidden opener too (R14.04)

Hiding the child, hiding the opener, showing them back — the link is the same before and after,
and `tabs.query` reports it on hidden tabs exactly as on visible ones. `tabs.update({openerTabId})`
works on a hidden tab, whether the new opener is visible or hidden itself. The only events are the
`hidden` flips.

| tab index | 0 | 1 | 2 | 3 |
| - | - | - | - | - |
| before | x* | p | c1→p | c2→p |
| `tabs.hide([c1])  // the child` — settled 2116 ms | | | | |
| child hidden | x* | p | c1→p(h) | c2→p |
| `tabs.hide([p])  // the opener` — settled 2105 ms | | | | |
| opener hidden | x* | p(h) | c1→p(h) | c2→p |
| `tabs.hide([c2]), then tabs.update(c2, {openerTabId: x})  // hidden child → visible opener` — settled 2132 ms | | | | |
| hidden child re-pointed | x* | p(h) | c1→p(h) | c2→x(h) |
| `tabs.update(c2, {openerTabId: p})  // hidden child → hidden opener` — settled 2122 ms | | | | |
| hidden → hidden | x* | p(h) | c1→p(h) | c2→p(h) |
| `tabs.show([p, c1, c2])` — settled 2092 ms | | | | |
| shown | x* | p | c1→p | c2→p |

### 5. discard never touches the opener; a discarded tab can be re-pointed, at a discarded opener too; the reload keeps it (R14.05)

Discarding the child, discarding the opener, re-pointing a discarded tab (to a loaded or a
discarded opener), then reloading the child by activating it — the link survives every step.
STG creates restored tabs `discarded` and sets the opener afterwards; this is the fact that path
rests on.

| tab index | 0 | 1 | 2 | 3 |
| - | - | - | - | - |
| before | x* | p | c1→p | c2→p |
| `tabs.discard(c1)  // the child` — settled 2128 ms | | | | |
| child discarded | x* | p | c1→p | c2→p |
| `tabs.discard(p)  // the opener` — settled 2096 ms | | | | |
| opener discarded | x* | p | c1→p | c2→p |
| `tabs.discard(c2), then tabs.update(c2, {openerTabId: x})  // discarded child re-pointed` — settled 2137 ms | | | | |
| discarded child re-pointed | x* | p | c1→p | c2→x |
| `tabs.update(c2, {openerTabId: p})  // discarded child → discarded opener` — settled 2117 ms | | | | |
| discarded → discarded | x* | p | c1→p | c2→p |
| `tabs.update(c1, {active: true})  // reloads the discarded child` — settled 2125 ms | | | | |
| child reloaded | x | p | c1→p* | c2→p |

### 6. Removing the opener deletes the child's link silently — no re-parenting, no event (R14.06)

With a chain `c→p→g`, closing `p` leaves `c` with **no** opener (the property is absent, exactly
as after a `-1` clear, §3) — the child is not handed to the grandparent. The only event is
`tabs.onRemoved` for `p`; no `tabs.onUpdated` announces the lost link.

| tab index | 0 | 1 | 2 | 3 |
| - | - | - | - | - |
| before | x* | g | p→g | c→p |
| `tabs.remove(p)  // the opener of c, itself a child of g` — settled 2125 ms | | | | |
| after | x* | g | c | |

```text
    3ms  tabs.onRemoved        p  isWindowClosing:false
```

### 7. Same-window moves keep the opener; ANY cross-window move erases it silently; `tabs.update` restores it in the new window; an opener in another window is refused (R14.07)

- A single-tab move and an array move **within the window** leave every link untouched.
- A move **to another window** erases the moved tab's opener — when the child goes alone, and
  just the same when the opener and the child travel **together in one `tabs.move` call**. Moving
  the child back next to its opener does not bring the link back. No `tabs.onUpdated` announces
  the erasure — only `onDetached`/`onAttached` are delivered. (Copy: MOVE-TABS-BEHAVIOR.md §4.)
- After the move `tabs.update({openerTabId})` restores the link, provided both tabs are in the
  same window now.
- Pointing a tab at an opener that lives in another window is rejected:
  `Opener tab must be in the same window as the tab being updated`. The tab keeps having no opener.

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

### 8. A browser restart drops every opener (R14.08)

Four links of four kinds — set by `tabs.update`, set by `tabs.create`, on a hidden child, on a
discarded child — and a chain `c2→c1→p`. After the restart the window comes back with the same
tabs in the same order, the hidden one still hidden, every tab but the active one discarded, and
**not one opener**: `openerTabId` is absent on all of them. The session store does not carry the
link; whatever shows a tree after a restart does it from its own memory.

| tab index | 0 | 1 | 2 | 3 | 4 | 5 |
| - | - | - | - | - | - | - |
| before restart | x* | p | c1→p | c2→c1 | c3→p(h) | ➕c4→p |
| after restart | x* | p | c1 | c2 | c3(h) | c4 |

Before: `c2` discarded, `c3` hidden, the rest loaded. After: `x` loaded, everything else
discarded, `c3` hidden.

### 9. Moving the OPENER to another window erases the links of the children it leaves behind — silently; a child that follows arrives without a link; inside `onDetached` / `onAttached` `tabs.get` already reports the new window and no opener (R14.16)

§7 covers the moved tab losing its own opener. The other direction: `p` moves out alone, `c1` and
`c2` stay — both report **no** opener afterwards, and no `tabs.onUpdated` announces it, only the
detach/attach pair of `p`. `c1` moved after its opener into the same window arrives without a link
as well (the third cross-window shape after "child alone" and "pair together" of §7);
`tabs.update` restores it once both are there. A `tabs.get` made right inside `tabs.onDetached`
and again inside `tabs.onAttached` already shows the moved tab in the **new** window with no
opener — the erasure is done before the first event is delivered. Identical in the TST profile.

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

### 10. `openerTabId` is not accepted as a `properties` filter value of `tabs.onUpdated`; a listener filtered by `properties` never receives an opener change, an unfiltered one gets every change with `openerTabId` as the only key (R14.15)

- `browser.tabs.UpdatePropertyName` on Firefox 155: attention, audible, autoDiscardable, discarded,
  favIconUrl, groupId, hidden, isArticle, mutedInfo, pinned, sharingState, splitViewId, status,
  title, url — **no `openerTabId`**. `addListener(fn, {properties: ['openerTabId']})` is rejected:
  `Type error for parameter filter (Error processing properties.0: Invalid enumeration value
  "openerTabId") for tabs.onUpdated`. MDN lists the value as supported since Firefox 131: the
  docs follow the intent of bug 1409262 — `ext-tabs.js` does handle
  `filter.properties.has("openerTabId")` — but that patch never added the value to the schema
  enum `UpdatePropertyName`, and the schema rejects the filter before the code runs (the same
  in mozilla-central tip, August 2026; no bug about the gap is filed). In the sources the event
  is emitted by `TabTracker.setOpener` — only from `tabs.update`, and only when the native
  opener actually changes: that is why T5 saw no event for a same-opener update, and why the
  erasures of §6, §7 and §9 come with no event at all.
- A listener with a typical tab-keys `properties` filter (title, status, favIconUrl, hidden,
  pinned, discarded, audible, groupId — the filter STG's subscription would otherwise use; it is
  unfiltered for exactly this reason) received **0** of the 4 opener changes below; the unfiltered
  listener received all 4, each with `changeInfo` holding `openerTabId` alone — the new id, or
  `-1` for the clear — and the `tab` argument already carrying the new value (absent after the
  clear, §3). `tabs.create({openerTabId})` fired no `tabs.onUpdated` for either (§1). The events
  are identical in the TST profile; the rows differ there by T2 only.

| tab index | 0 | 1 | 2 | 3 |
| - | - | - | - | - |
| before | p* | c | x | |
| `tabs.update(c, {openerTabId: p})` — settled 2118 ms | | | | |
| set | p* | c→p | x | |
| `tabs.update(c, {openerTabId: x})  // re-point` — settled 2110 ms | | | | |
| re-pointed | p* | c→x | x | |
| `tabs.update(c, {openerTabId: -1})  // clear` — settled 2111 ms | | | | |
| cleared | p* | c | x | |
| `tabs.update(c, {openerTabId: c})  // itself, the way a tree extension writes "detached"` — settled 2116 ms | | | | |
| self-pointed | p* | c→c | x | |
| `tabs.create({url: c2, openerTabId: p, index: 3})  // the link set at creation` — settled 2126 ms | | | | |
| created | p* | c→c | x | ➕c2→p |

```text
    1ms  onUpdated[none]       c  {openerTabId: p}  tab.opener=p
    1ms  onUpdated[none]       c  {openerTabId: x}  tab.opener=x
    2ms  onUpdated[none]       c  {openerTabId: none}  tab.opener=absent
    1ms  onUpdated[none]       c  {openerTabId: c}  tab.opener=c
(8 noisy tabs.onUpdated dropped: status/url/title/favIconUrl/isArticle/audible/attention)
```

`onUpdated[stg]` — the listener with that filter — has no line at all; `tab.opener` is the
`openerTabId` of the `tab` argument the event delivers.

### 11. `tabs.create({openerTabId})` takes the link on a hidden, a hidden-and-discarded and a discarded opener; a tab created discarded carries it too (R16.01, R16.04)

The states an unloaded-group parent lives in — hidden, hidden and discarded, discarded (shown
back) — and in all three the created tab carries the link right away: the resolved object and a
fresh `tabs.get` alike, no `tabs.onUpdated` follows (the link is part of the creation, §1), and
the explicit index is honored. A tab created `discarded: true` with a real http url and a title —
the shape STG restores background tabs with — takes the link the same way and stays discarded.

| tab index | 0 | 1 | 2 | 3 | 4 | 5 |
| - | - | - | - | - | - | - |
| before | x* | p | a | | | |
| `tabs.hide([p])` — settled 2132 ms | | | | | | |
| opener hidden | x* | p(h) | a | | | |
| `tabs.create({url: c1, openerTabId: p, index: 3})  // hidden opener` — settled 2146 ms | | | | | | |
| created with hidden opener | x* | p(h) | a | ➕c1→p | | |
| `tabs.discard(p)` — settled 2134 ms | | | | | | |
| opener hidden and discarded | x* | p(h) | a | ➕c1→p | | |
| `tabs.create({url: c2, openerTabId: p, index: 4})  // hidden and discarded opener` — settled 2114 ms | | | | | | |
| created with hidden and discarded opener | x* | p(h) | a | ➕c1→p | ➕c2→p | |
| `tabs.show([p])` — settled 2123 ms | | | | | | |
| opener shown, still discarded | x* | p | a | ➕c1→p | ➕c2→p | |
| `tabs.create({url: c3, openerTabId: p, index: 5})  // discarded opener` — settled 2120 ms | | | | | | |
| created with discarded opener | x* | p | a | ➕c1→p | ➕c2→p | ➕c3→p |

| tab index | 0 | 1 | 2 |
| - | - | - | - |
| before | p* | x | |
| `tabs.create({url: https://…/?tab=c1, title: c1, discarded: true, openerTabId: p, index: 2})` — settled 2114 ms | | | |
| after | p* | x | ➕c1→p |

### 12. `tabs.create({openerTabId})` pointing across windows is refused — the call rejects and NO tab is created (R16.02)

Both directions — a tab created in window 2 with an opener living in window 1, and one created in
window 1 with an opener living in window 2 — reject with `Opener tab must be in the same window
as the tab being created`, and both windows stay exactly as they were: the refusal does not leave
a tab without a link behind, there is no tab at all. The same-window rule of `tabs.update` (§7)
holds for creation, with a harsher outcome — an update refusal leaves the tab intact, a create
refusal cancels the creation.

| tab index | 0 | 1 |
| - | - | - |
| before (window 1) | p* | x |
| before (window 2) | w* | |
| `tabs.create({windowId: 2, url: c1, openerTabId: p})  // the opener stays in window 1` — settled 2113 ms | | |
| created in window 2 (window 1) | p* | x |
| created in window 2 (window 2) | w* | |
| `tabs.create({url: c2, openerTabId: w})  // created in window 1, the opener lives in window 2` — settled 2121 ms | | |
| created in window 1 (window 1) | p* | x |
| created in window 1 (window 2) | w* | |

### 13. `tabs.create({openerTabId})` pointing at a removed tab is refused — `Invalid tab ID`, no tab is created (R16.03)

The opener is closed, then `tabs.create` names its id: the call rejects with `Invalid tab ID: …`
and creates nothing. Together with §12 this makes an inherited live `openerTabId` unsafe to pass
into `tabs.create` — a parent that died or stayed in another window kills the whole creation, not
just the link.

| tab index | 0 | 1 |
| - | - | - |
| before | x* | p |
| `tabs.remove(p)  // the future opener` — settled 2106 ms | | |
| opener removed | x* | |
| `tabs.create({url: c1, openerTabId: p, index: 1})  // p is already closed` — settled 2133 ms | | |
| after | x* | |

```text
    4ms  tabs.onRemoved        p  isWindowClosing:false
```

### 15. `sessions.restore()` of a closed window brings every tab back WITHOUT its opener — the session record itself has no `openerTabId` field (R18.01)

The API behind Ctrl+Shift+N. A window with a chain `c2→c1→p`, a second child and a hidden child
(`h1→p`), closed by `windows.remove` and brought back by `sessions.restore()`. The window returns
exactly the way TABGROUPS-BEHAVIOR §18 recorded for the manual gesture — populated only through
`tabs.onCreated` with fresh ids (0 of 5 reused), the first `tabs.onCreated` delivered before
`windows.onCreated`, the hidden tab back hidden (`tabs.onUpdated {hidden: true}` in the same
millisecond as its creation) — but **not one opener**: every restored tab reports `openerTabId`
absent, both in the `tabs.onCreated` snapshot and on a later read. The record
`sessions.getRecentlyClosed()` hands out does not carry the link either — a session tab's keys
are `active, hidden, highlighted, incognito, index, lastAccessed, pinned, sessionId, title, url,
windowId`, no `openerTabId`. The same loss as a restart (§8), through the same session store:
whoever wants links across an undo-close must save and re-apply them itself.

| tab index | 0 | 1 | 2 | 3 | 4 |
| - | - | - | - | - | - |
| before (second window) | p* | c1→p | c2→c1 | x | h1→p(h) |
| before (scene window) | keep1* | | | | |
| `windows.remove(second)` — settled 300 ms | | | | | |
| `sessions.restore(sessionId of the window)` — settled 234 ms | | | | | |
| restored (second window) | p* | c1 | c2 | x | h1(h) |
| after (scene window) | keep1* | | | | |

```text
    8ms  tabs.onRemoved        p  isWindowClosing:true  [second]
    9ms  tabs.onRemoved        c1  isWindowClosing:true  [second]
    9ms  tabs.onRemoved        c2  isWindowClosing:true  [second]
    9ms  tabs.onRemoved        x  isWindowClosing:true  [second]
    9ms  tabs.onRemoved        h1  isWindowClosing:true  [second]
    9ms  windows.onRemoved     second
   85ms  tabs.onCreated        p  index:0 opener:absent  [restored]
   85ms  tabs.onActivated      p  previous:-  [restored]
   85ms  windows.onCreated     restored  type:normal
   93ms  tabs.onCreated        c1  index:1 opener:absent  [restored]
   94ms  tabs.onCreated        c2  index:2 opener:absent  [restored]
   94ms  tabs.onCreated        x  index:3 opener:absent  [restored]
   94ms  tabs.onCreated        h1  index:4 opener:absent  [restored]
   94ms  tabs.onUpdated        h1  {hidden: true}  [restored]
```

The trailing lines of the test's own cleanup close are omitted; 13 noisy `tabs.onUpdated`
dropped.

### 16. `sessions.restore()` of a closed TAB does not re-link it either — even though its opener is still alive with the SAME id (R18.02)

The API behind Ctrl+Shift+T. `c→p` is closed alone; `d→c` loses its link at the close (§6). The
restored `c` arrives with a fresh id, at its old index, activated — and with **no** opener,
although `p` never went anywhere and its id is still valid, so the link could have been restored
verbatim. The session record of the closed tab has no `openerTabId` field (the same keys as §15).
`d` stays cut. So the undo-close loss is not an id-mapping problem: the session store simply does
not keep the link at all.

| tab index | 0 | 1 | 2 | 3 |
| - | - | - | - | - |
| before | x* | p | c→p | d→c |
| `tabs.remove(c)` — settled 261 ms | | | | |
| closed | x* | p | d | |
| `sessions.restore(sessionId of the tab)` — settled 226 ms | | | | |
| restored | x | p | c* | d |

```text
    2ms  tabs.onRemoved        c  isWindowClosing:false
    8ms  tabs.onCreated        c  index:2 opener:absent
    8ms  tabs.onActivated      c  previous:x
```

### 17. Pinning keeps every link, to and from the tab; a pinned tab takes a fresh link, is an opener for `tabs.update` and `tabs.create`, takes the `-1`; unpin brings nothing back (R14.17)

`p→g` with a child `c1→p` and a grandchild `c2→c1` is pinned. The pin moves the tab into the
pinned zone and changes nothing about the links: `p→g` and `c1→p` are what every read reports
afterwards, and the only events are `tabs.onMoved` and `{pinned: true}` — no `openerTabId` line
(the same two events as the pin of a group member, TABGROUPS-BEHAVIOR.md §19, without the
membership one). Pinned, the tab takes a fresh link (`p→x`), becomes the opener of a tab
re-pointed at it (`y→p`) and of a tab created with it at an explicit index (`n→p`), and takes the
`-1` (§3) — each write with its one `tabs.onUpdated` (§10), exactly as on a plain tab. The `-1` on
its pre-pin child clears just the same. Unpin moves nothing and brings nothing back: the cleared
links stay cleared, the links set while pinned stay, the only event is `{pinned: false}`; the
grandchild `c2→c1` never changed. The browser does not put a pinned tab outside the opener graph.

| tab index | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
| - | - | - | - | - | - | - | - |
| before | x* | g | p→g | c1→p | c2→c1 | y | |
| `tabs.update(p, {pinned: true})  // p → g and c1 → p are the links at stake, c2 → c1 the control` — settled 2143 ms | | | | | | | |
| pinned | p→g(p) | x* | g | c1→p | c2→c1 | y | |
| `tabs.update(p, {openerTabId: x})  // a link p never had, set ON the pinned tab` — settled 2111 ms | | | | | | | |
| p → x set on the pinned tab | p→x(p) | x* | g | c1→p | c2→c1 | y | |
| `tabs.update(y, {openerTabId: p})  // from a tab that never pointed at p, set ONTO the pinned tab` — settled 2123 ms | | | | | | | |
| y → p set onto the pinned tab | p→x(p) | x* | g | c1→p | c2→c1 | y→p | |
| `tabs.create({url: n, openerTabId: p, index: 6})  // the pinned tab as the opener at creation` — settled 2121 ms | | | | | | | |
| created with the pinned opener | p→x(p) | x* | g | c1→p | c2→c1 | y→p | ➕n→p |
| `tabs.update(p, {openerTabId: -1})  // the clear on the pinned tab, which holds a link` — settled 2117 ms | | | | | | | |
| cleared on the pinned tab | p(p) | x* | g | c1→p | c2→c1 | y→p | ➕n→p |
| `tabs.update(c1, {openerTabId: -1})  // the clear on its pre-pin child` — settled 2134 ms | | | | | | | |
| cleared on the child | p(p) | x* | g | c1 | c2→c1 | y→p | ➕n→p |
| `tabs.update(p, {pinned: false})` — settled 2098 ms | | | | | | | |
| unpinned | p | x* | g | c1 | c2→c1 | y→p | ➕n→p |

```text
    2ms  tabs.onMoved          p  2 → 0
    3ms  tabs.onUpdated        p  {pinned: true}
    2ms  tabs.onUpdated        p  {openerTabId: x}
    1ms  tabs.onUpdated        y  {openerTabId: p}
    8ms  tabs.onCreated        n  index:6 group:-1
    1ms  tabs.onUpdated        p  {openerTabId: none}
    1ms  tabs.onUpdated        c1  {openerTabId: none}
    2ms  tabs.onUpdated        p  {pinned: false}
(4 noisy tabs.onUpdated dropped: status/url/title/favIconUrl/isArticle/audible/attention)
```

---

## The same round in a profile with Tree Style Tab

Firefox 155, a profile with Tree Style Tab and no other add-on (STG included), the same
`round-14` with a 2 s silence window (`OTHER_ADDON_WAIT`) — TST acts with a delay of its own,
and a 200 ms window had snapshotted one of its moves too early. The tables above are what the
browser does on its own; the rows below are where TST changes the picture — in the report they
are the MISMATCH lines. Cited as `R14.xx (with TST)`.

### T1. TST never blocks the link, never restores it after a move, and writes nothing back after a restart (R14.01, R14.03, R14.07, R14.08 with TST)

`tabs.create({openerTabId})` and `tabs.update({openerTabId})` behave exactly as in §1 and §3,
`-1` clears, a self-pointer is accepted. The cross-window rows of §7 came out identical, with
2 s of silence after every move: the browser erases the link and TST does not put it back —
`tabs.update` does. After the restart every opener is absent exactly as in §8: TST shows its
tree again from its own session data and does not write it into `openerTabId`. For anyone
reading `tabs.query`, a TST tree after a restart does not exist.

| tab index | 0 | 1 | 2 | 3 | 4 | 5 |
| - | - | - | - | - | - | - |
| before restart | x* | p | c1→p | c2→c1 | c3→p(h) | ➕c4→p |
| after restart | x* | p | c1 | c2 | c3(h) | c4 |

### T2. TST moves a tab under its opener — neither newTabPosition nor an explicit `index` sticks (R14.01, R14.02, R14.03, R14.04, R14.05 with TST)

A tab **created** with an opener is moved behind the opener's existing children, whatever the
setting or the `index` asked for: under `atEnd` the new `c` left the end of the window for the
slot after `p`; under relatedAfterCurrent `c3` created at 0 ended at 2, `c4` created at 6 ended
at 3. A tab **re-pointed** with `tabs.update` from ABOVE its new opener is moved directly after
the opener, before that opener's existing children — `c2→p` lands between `p` and `c1`; hidden
and discarded tabs are moved just the same. (A tab re-pointed from below is appended after the
opener's last child, and one already standing there is not moved at all — T6.) The move is
TST's own `tabs.move`, a moment after the link appears; in the first run, with a 200 ms window,
the "index 0" row was snapshotted before `c3` moved. R14.15 (with TST) shows the same two
rules once more: `c` re-pointed at `x` standing below it moved right after `x` and stayed there
through the clear and the self-pointer; `c2` created at index 3 with opener `p` landed at index 1,
right after `p`.

| tab index | 0 | 1 | 2 |
| - | - | - | - |
| before | p* | x | |
| `tabs.create({url: c, openerTabId: p})  // newTabPosition atEnd` — settled 2375 ms | | | |
| after | p* | ➕c→p | x |

| tab index | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
| - | - | - | - | - | - | - | - |
| no index, opener inactive | p* | ➕c1→p | a | ➕c2→a | b | | |
| `tabs.create({openerTabId: p, index: 0})` — settled 2382 ms | | | | | | | |
| index 0 | p* | ➕c1→p | ➕c3→p | a | ➕c2→a | b | |
| `tabs.create({openerTabId: p, index: 6})  // the end of the window` — settled 2397 ms | | | | | | | |
| index at the end | p* | ➕c1→p | ➕c3→p | ➕c4→p | a | ➕c2→a | b |

| tab index | 0 | 1 | 2 | 3 |
| - | - | - | - | - |
| opener hidden | x* | p(h) | c1→p(h) | c2→p |
| `tabs.hide([c2]), then tabs.update(c2, {openerTabId: x})  // hidden child → visible opener` — settled 2366 ms | | | | |
| hidden child re-pointed | x* | c2→x(h) | p(h) | c1→p(h) |
| `tabs.update(c2, {openerTabId: p})  // hidden child → hidden opener` — settled 2380 ms | | | | |
| hidden → hidden | x* | p(h) | c2→p(h) | c1→p(h) |

### T3. TST hands an orphan to the grandparent, through its own `tabs.update` (R14.06 with TST)

Where the browser alone leaves `c` with no opener (§6), TST re-points it at `g` — and does it
with the public API, so the change is announced like any other (§3).

| tab index | 0 | 1 | 2 | 3 |
| - | - | - | - | - |
| before | x* | g | p→g | c→p |
| `tabs.remove(p)  // the opener of c, itself a child of g` — settled 2119 ms | | | | |
| after | x* | g | c→g | |

```text
    7ms  tabs.onRemoved        p  isWindowClosing:false
   10ms  tabs.onUpdated        c  {openerTabId: g}
```

### T4. TST writes "detached" as a self-pointing opener (R14.07 with TST)

A same-window `tabs.move` that takes a child out of its parent's subtree makes TST detach it,
and TST records that by pointing the tab at **itself** — `openerTabId = the tab's own id`,
announced by `tabs.onUpdated`: `c2→c2` after moving `c2` above `p`, `c1→c1` after `[p, c1]`
moved to the end in one call. §3 shows the browser accepts the self-pointer; this is what it is
used for. A reader must take `openerTabId === tab.id` as "no opener".

| tab index | 0 | 1 | 2 | 3 |
| - | - | - | - | - |
| before | p* | c1→p | c2→p | x |
| `tabs.move(c2, {index: 0})  // same window` — settled 2118 ms | | | | |
| moved in the window | c2→c2 | p* | c1→p | x |
| `tabs.move([p, c1], {index: -1})  // array, same window` — settled 2112 ms | | | | |
| array moved in the window | c2→c2 | x | p* | c1→c1 |

```text
    6ms  tabs.onUpdated        c2  {openerTabId: c2}
   17ms  tabs.onUpdated        c1  {openerTabId: c1}
```

### T5. An update to the opener a tab already has changes nothing; links applied again after a restart are taken silently (R14.09, R14.10 with TST)

`tabs.update(c1, {openerTabId: p})` for a `c1` that already points at `p` — the first child, the
last child, all three at once — moved nothing, and the browser fired no `tabs.onUpdated` at all
(the report has no events block: nothing to announce). After a restart the browser has no openers
(§8, T1) while TST still shows the tree from its own memory; applying the saved links again, in
the saved order and in parallel, restored every `openerTabId`, fired one `tabs.onUpdated` per
tab, and left the order exactly as it was before the restart — TST took its own tree back as a
no-op. This is what makes re-applying a saved link to a tab that is not new safe.

| tab index | 0 | 1 | 2 | 3 | 4 |
| - | - | - | - | - | - |
| before | x* | p | c1→p | c2→p | c3→p |
| `tabs.update(c1, {openerTabId: p})  // c1 → p again, c1 is the first child` — settled 2111 ms | | | | | |
| first child re-pointed | x* | p | c1→p | c2→p | c3→p |
| `tabs.update(c3, {openerTabId: p})  // c3 → p again, c3 is the last child` — settled 2120 ms | | | | | |
| last child re-pointed | x* | p | c1→p | c2→p | c3→p |
| `all three → p again, in order, in parallel` — settled 2121 ms | | | | | |
| all re-pointed | x* | p | c1→p | c2→p | c3→p |

| tab index | 0 | 1 | 2 | 3 | 4 |
| - | - | - | - | - | - |
| before restart | x* | p | c1→p | c2→p | c3→c2 |
| after restart | x* | p | c1 | c2 | c3 |
| `the saved links again, in order, in parallel: c1 → p, c2 → p, c3 → c2` — settled 2082 ms | | | | | |
| links applied | x* | p | c1→p | c2→p | c3→c2 |

```text
    5ms  tabs.onUpdated        c1  {openerTabId: p}
    6ms  tabs.onUpdated        c2  {openerTabId: p}
    6ms  tabs.onUpdated        c3  {openerTabId: c2}
```

### T6. Tabs created without an opener right after their parent and linked afterwards stay where they are — a re-pointed tab moves only when it stands outside the opener's subtree (R14.11–R14.14 with TST)

The restore path of STG: `c1`, `c2`, `c3` are created at explicit indexes 2–4 right after `p`,
without an opener, and linked to `p` afterwards. Linked all at once (R14.11) and one by one in
creation order (R14.12) — not a single `tabs.onMoved`, the order is untouched. Linked in reverse
order (R14.13) the picture explains the rule: `c3`, standing below its future siblings, was moved
right after `p` (the last child so far — none), `c2` was appended after `c3`, and `c1`, already
standing after the last child, was left in place. Together with T2: TST moves a re-pointed tab
into the opener's subtree — from above to the first-child slot, from below to the slot after the
last child — and leaves a tab that is already there alone. An array `tabs.move` back into the
saved order after the links (R14.14) drew no reaction: no move, no detach.

| tab index | 0 | 1 | 2 | 3 | 4 |
| - | - | - | - | - | - |
| created | x* | p | ➕c1 | ➕c2 | ➕c3 |
| `tabs.update → p for c1, c2, c3, all at once` — settled 2113 ms | | | | | |
| linked | x* | p | ➕c1→p | ➕c2→p | ➕c3→p |

| tab index | 0 | 1 | 2 | 3 | 4 |
| - | - | - | - | - | - |
| created | x* | p | ➕c1 | ➕c2 | ➕c3 |
| `tabs.update(c3, {openerTabId: p})` — settled 2392 ms | | | | | |
| c3 linked | x* | p | ➕c3→p | ➕c1 | ➕c2 |
| `tabs.update(c2, {openerTabId: p})` — settled 2367 ms | | | | | |
| c2 linked | x* | p | ➕c3→p | ➕c2→p | ➕c1 |
| `tabs.update(c1, {openerTabId: p})` — settled 2103 ms | | | | | |
| c1 linked | x* | p | ➕c3→p | ➕c2→p | ➕c1→p |

```text
    2ms  tabs.onUpdated        c3  {openerTabId: p}
  261ms  tabs.onMoved          c3  4 → 2
    4ms  tabs.onUpdated        c2  {openerTabId: p}
  267ms  tabs.onMoved          c2  4 → 3
    2ms  tabs.onUpdated        c1  {openerTabId: p}
```

---

## Implications for STG code

1. **The opener can be set after creation, on any tab** — hidden, discarded, or both (§3–§5).
   A restore path may create tabs first (discarded, hidden, in any order) and link them in one
   pass at the end (`Tabs.applyOpeners`); nothing has to be visible or loaded for
   `tabs.update({openerTabId})`.
2. **Absent, never `-1`.** A tab without an opener has no `openerTabId` property at all (§3, §6);
   the check is `tab.openerTabId > 0` / `!== undefined`, never a comparison with `-1`.
3. **Every cross-window move needs a re-link** (§7): after `tabs.move({windowId})` the opener is
   gone even when it moved along — re-apply it for the tabs whose opener is in the target window,
   and only for them: an opener left behind is refused (`Tabs.moveNative`). The children an opener
   leaves behind lose their links too, with no event (§9) — nothing can be re-applied for them,
   and nothing announces it: whatever remembers openers of live tabs must treat a cross-window
   move of a tab as the end of every link to and from it.
4. **The addon's own `tabs.update({openerTabId})` fires `tabs.onUpdated`** (§3). STG does not
   listen for that key, so nothing has to be muted; tree extensions do listen, which is the whole
   reason the link is re-applied at all.
5. **Closing a tab silently orphans its children** (§6) — no event to react to; a saved link that
   points at a tab which no longer exists is simply dropped on save.
6. **After a restart nothing has an opener — with or without TST** (§8, T1). What `tabs.query`
   reports after a restart says nothing about the tree the user still sees in TST. A sync that
   takes "absent" for "removed" wipes the cloud copy of the tree on the first trust-local after
   every restart; the saved link may only be replaced by another explicit link, never by absence.
7. **A self-pointing opener is TST's "detached"** (T4) — read it as no opener; never save it as a
   link and never compute an offset of zero.
8. **TST re-positions the tabs it links** (T2): right after the links are applied, TST moves each
   child under its opener, ignoring the explicit `index` the tab was created with. The order STG
   restores is not final in a TST profile. Two exceptions make the restore path safe: **a link a
   tab already has, or that TST already shows after a restart, is taken as a no-op** (T5) — so
   `Tabs.applyOpeners` sets the saved link on every tab, not only on the tabs it has just created,
   and never compares with the tab's current opener (its snapshot may be stale by then); and **a
   tab already standing after its opener's last child is
   not moved when linked** (T6) — a saved order where children follow their parents, created as
   is and linked afterwards, in any order, comes out untouched. Hence: sort first, link last.
9. **An opener change reaches only a listener without a `properties` filter** (§10): the value
   cannot be named in the filter, and a filter naming anything else drops the change. Whatever
   keeps a copy of live openers — the tab cache that the closed-window restore reads — has to
   be fed by an unfiltered `tabs.onUpdated`, or it never learns that a tree extension detached a
   tab (T4) or that a link was cleared.
10. **An inherited `openerTabId` must never reach `tabs.create`.** Copying a live tab's
    properties into `tabs.create` kills the whole creation — not just the link — the moment the
    opener is closed (§13) or left in another window (§12). Passing an opener at creation is safe
    only when the code guarantees it alive and in the target window, in any load state (§11);
    everywhere else: create clean and link afterwards — `tabs.update({openerTabId})` covers every
    accepted state (§3–§5), and its refusal costs nothing, the tab stays.
11. **A pin cuts nothing** (§17): a tab keeps its opener and its children through
    `tabs.update({pinned: true})`, with no event about the links, and unpin brings nothing back.
    A pinned tab takes a fresh link and is an opener like any other tab, by `tabs.update` and by
    `tabs.create`. STG leaves all of it alone: a pinned tab is outside its groups, so such a link
    lives as long as the browser keeps it and never reaches a store.

---

## How STG carries the link — the model in the code

Not browser facts: the contract the STG code implements on top of the facts above. STG never
builds a tree and never invents a link — placement and everything visual belong to the tree
extensions (TST and the like). What STG guarantees is one thing: **a link does not get lost
through STG's own actions** — tracking, backup/archive/undo-remove, closed-window restore, cloud
sync, a group transfer and the recreate of a tab all carry it. STG never cuts a link either — not
on a transfer between groups, not on a pin, not when another add-on hides a tab: no `-1` is
written anywhere in the addon. Who is linked to whom is decided by the user, the browser and the
tree extensions. The one limit is the saved form: an offset lives inside a group's own list, so a
link between two groups goes through no store and lives in the window as long as the browser
keeps it.

**A live tab.** The browser's `openerTabId` is the single truth. A self-pointer is "detached"
(T4); a live opener outside the tab's group is "no parent" in the group's coordinates — both are
an explicit "no". A live link never points into another window (§3, §7, §9); after a browser
restart nobody has an opener (§8). The tab cache (`js/cache.js`) mirrors the live opener — the closed-window
save reads only the cache — fed by the `tabs.onUpdated` subscription without a `properties`
filter (§10, Implications 9), refreshed by every read with the session (`Tabs.query`,
`Tabs.get`, `Tabs.list`; `onUpdated` reads without it and feeds the mirror itself through
`Cache.setTab`), and by the single writer itself: `setOpeners` mirrors every link it writes. A
cross-window move erases every
link to and from the moved tab with no event (§7, §9) — the cache drops those links the moment
the tab detaches, ahead of the per-tab mutes: the addon's own moves erase them just the same
(Implications 3).

**A transfer.** `Tabs.move` touches no link on purpose: what the movers were linked to before,
they stay linked to after, as far as the browser allows. Two of its steps erase links by
themselves and undo that on the spot. A container recreation goes through `Tabs.recreate`: the
copy is created clean — an inherited opener can kill the whole creation (Implications 10) —
then every link of the original lands on the new id, and every live child of the original,
pinned or not, is re-pointed at it; an original is removed only once its copy exists — a copy
that could not be created leaves its original where it is, with its links, and out of the
transfer. The copy is born in place, in the original's window, at its slot (the copy of a live
sub-group's first member one slot further, TABGROUPS-BEHAVIOR.md §7), with whatever the caller
builds for it: the transfer builds it with no binding at all — no group, no native sub-group,
nothing of the original's session but its icon, its thumbnail and the url the mirror knows for a
tab still loading its first page (`Tabs.fillEmptyUrl`); a container reopen (`onBeforeTabRequest`,
the temporary-container menu item) keeps the original's group and sub-group, and the copy of a
hidden tab, or of an unloaded group's tab, is hidden. So the links `recreate` writes never cross a window, and a
transfer to another window is the move's business, once the copy exists; the group and the
sub-group are written after the move, once. A window change
goes through `Tabs.moveNative`: the browser erases the mover's link (§7), STG writes it back
and the browser judges — an opener now in the same window is accepted, one left behind is
refused, so a link travels only when parent and child move in one call, and the children an
opener leaves behind lose theirs for good (§9). A same-window move keeps everything (§7), a
pin keeps everything (§17) — the tab STG pins away before an unload (`beforeUnload`, a tab
that cannot be hidden) and a tab pinned by anyone else keep their links just the same. A link
that ends up between two groups lives on in the window exactly as the browser keeps it; only
the saved form cannot hold it.

**A saved tab.** `openerOffset` = the opener's index − the tab's index, inside the group's own
saved list only; forward and backward alike — the model does not require the parent to stand
first; no parent — no key; an offset of 0 is never written and never read. Saved tabs carry no
tab ids; pinned tabs are saved without links on purpose. `tabsToRestore` (the tabs of closed
windows) is one flat list of many groups: an offset lives inside the group's own subsequence of
it (`Map.groupBy` — the group's entries need not be contiguous), and every rebuild of the list
goes through `Windows.rebuildTabsToRestore`.

**The arithmetic** lives in `js/tabs.js`, one reader per source: `Tabs.getOpenersById(tabs)` —
who is whose parent by `openerTabId`; `Tabs.getOpenersByOffset(fromTabs, toTabs)` — by the
`openerOffset` of the first list, the links land on the tabs of the second at the same indexes
(without the second — the same list); `Tabs.getOpeners(tabs)` — both, the offset wins. The offset
side must be dense; the live list of a restore may hold an empty slot where a creation failed
(the `aligned` list of `createMultiple`) — the offset reader skips such pairs, `withOffsets`
accepts no holes at all. An explicit "no" is a present entry of the readers' map, not a missing
one: `getOpenersById` records a self-pointer as the tab itself and an opener outside the list as
an empty value, `assignOpeners` in `cloud.js` tells such an entry from absence by `has`, and
`withOffsets` writes no offset for either.
`Tabs.withOffsets(tabs, openers, {removeIds})` returns a new list of copies with `openerOffset`
written by the given map (without a map — by `getOpeners`), stripping `id`/`openerTabId` when
asked, and never touches the input objects; `Tabs.prepareForSave` calls it itself — after
a merge the rewritten offsets win over the live `openerTabId` (`getOpeners`), so a save always
keeps what the merge wrote, and `includeOpener: false` (the pinned tabs of a backup) skips the
links entirely. Every link reaches the browser through one writer (`setOpeners` in
`js/tabs.js`): the browser is the judge, a refused link costs nothing. Migration 6 converts the
old `id`/`openerTabId` format.

**The cloud** is the only memory of a tree: the link is **sticky** — only another explicit link
or an explicit "no" replaces it; absence never removes it, or the first upload after every
restart would wipe the tree (§8). In `cloud.js` the links of both sides are snapshotted as
object references before the lists are rebuilt, and the offsets are written over the aligned
lists (`assignOpeners`). The live `openerTabId` of local tabs always speaks for its group —
a device carries whatever links its tabs have, tree extension or not; an archived group's
saved offsets speak for themselves. The accepted
limitations of the format both grow from one fact — a link carries no timestamp, trust is chosen
once per whole sync: a detach does not reach a device that still holds the old live link, that
device brings the link back on its next sync; and a trust-cloud sync re-points a link the user
has just edited locally back to the cloud's older one, and applies it — there is nothing to tell
the fresher side by. An archive lives under the same limitations: it freezes whatever links the
live group had at the moment of archiving — a deliberate detach and the post-restart erasure
(§8) freeze identically — so absence in an archive is no explicit "no", and the cloud fills the
link back in.

**Applying.** The tail of a restore is one function, `Groups.settleTabs`: the group's live
tabs sorted into the saved order, the native groups applied to a loaded group or stripped and
hidden by the group's options for an unloaded one, and the links last — unarchive, undo-remove, the closed windows and
the cloud apply all end there; `Tabs.reconcile` of a backup keeps only the sort and the links,
the addon reload that follows does the rest. `Tabs.applyOpeners` — over the group's final list,
to every tab with a saved link, never comparing with the tab's current opener: the
objects may be stale by then, and re-applying the link a tab already has is a no-op for a tree
extension (T5). Applying does not depend on any extension being present: `openerTabId` is a
native tab property, not a tree extension's invention, and a saved link that is never applied
would be gone from the next save of the live group. A window the browser itself brings back
(undo-close, the startup restore) returns with fresh ids and without a single link (§15) —
`GrandRestore` finds the group already alive, matches the saved tabs with the live ones by url
and container inside the group, applies the saved links the same way, and only then drops the
group's entries from `tabsToRestore`; the closing window's write lands even at a full browser
shutdown (LIFECYCLE-BEHAVIOR §8), so the tree survives a restart without the cloud.
`Tabs.moveNative` writes the opener back after
a cross-window move — the browser erases it (§7, §9) — and the browser is the judge: an opener
in the tab's new window is accepted, one left elsewhere is refused, so a link travels only when
parent and child move in one call.
