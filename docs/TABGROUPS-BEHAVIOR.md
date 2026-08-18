# Reference: Firefox behavior with native tab groups (tabGroups)

Verified live on Firefox 154 (August 2026) with a throwaway test add-on, in a clean profile with no
other add-ons. All tests — without pinned tabs; the one exception is §19, whose subject is pinning.
Every fact here is one browser build on one machine; a claim is as strong as the runs cited next to
it, and no stronger.

Only facts confirmed by an actual test run belong here — never assumptions about how the browser
"probably" works. Tab-creation facts (`tabs.create`, `index`, newTabPosition) live in
CREATE-TABS-BEHAVIOR.md; plain `tabs.move` facts with no groups involved — in
MOVE-TABS-BEHAVIOR.md. Anything involving a native group lives here; a copy goes into those
documents only when groups make creation or movement deviate from what they themselves state.

State tables, markers, confirmation rules and how the tests are written — BEHAVIOR-NOTATION.md.

**A new fact is appended as the next number at the end of the numbered sections, right before
"Implications for STG code". Numbers are never renumbered or reused** — code comments reference
them by number (`docs/TABGROUPS-BEHAVIOR.md §2`, `§4`, `§5`).

`browser.tabGroups.TAB_GROUP_ID_NONE` is `-1`, and an ungrouped tab really does report that as its
`groupId`. `tabGroups.query` on a window without groups returns `[]`. (R1.01)

---

## 1. Moving a single visible tab (`tabs.move`)

**A moved tab takes the group of whichever tab occupied the target index at the moment of the
call.** Not the final adjacency, not the neighbours it ends up between — the previous occupant of
that index. The tab always lands at exactly the requested index. (R2.01–R2.08)

| test | mover started at | called with | who held that index before | joined |
| - | - | - | - | - |
| R2.01 | 0 | `{index: 1}` | 🟥 gr1 | yes |
| R2.02 | 0 | `{index: 2}` | 🟥 gr2 | yes |
| R2.03 | 0 | `{index: 3}` | 🟥 gr3 | yes |
| R2.04 | 0 | `{index: 4}` | high1 | no |
| R2.05 | 5 | `{index: 1}` | 🟥 gr1 | yes |
| R2.06 | 5 | `{index: 2}` | 🟥 gr2 | yes |
| R2.07 | 5 | `{index: 3}` | 🟥 gr3 | yes |
| R2.08 | 5 | `{index: 4}` | high1 | no |

R2.03 and R2.08 are the pair that settles it. In both, the tab ends up immediately **after** the
group's last member — identical final arrangement, opposite membership:

| tab index | 0 | 1 | 2 | 3 | 4 | 5 |
| - | - | - | - | - | - | - |
| before | mover* | 🟥 gr1 | 🟥 gr2 | 🟥 gr3 | high1 | high2 |
| `tabs.move(mover, {index: 3})` | | | | | | |
| after | 🟥 gr1 | 🟥 gr2 | 🟥 gr3 | 🟥 mover* | high1 | high2 |

| tab index | 0 | 1 | 2 | 3 | 4 | 5 |
| - | - | - | - | - | - | - |
| before | low1* | 🟥 gr1 | 🟥 gr2 | 🟥 gr3 | high1 | mover |
| `tabs.move(mover, {index: 4})` | | | | | | |
| after | low1* | 🟥 gr1 | 🟥 gr2 | 🟥 gr3 | mover | high1 |

R2.03 also pins down **when** the occupant is read: before the move, not after the tab is lifted
out. Remove `mover` from index 0 first and index 3 would hold `high1`, a non-member — yet the tab
joined 🟥. The browser looks at the window as it was when `tabs.move` was called.

- **A member moved within the span stays a member** and may become the group's first tab. No
  `tabs.onUpdated` fires — membership never changed. (R1.03)
- **A member that lands on a slot held by a non-member leaves the group.** If it was the last
  member, the group is destroyed and `tabGroups.onRemoved` fires. A group with a single tab is
  perfectly valid and survives. (R1.06)
- Events for a move that changes membership: `tabs.onMoved`, then `tabs.onUpdated` with the new
  `groupId`. (R1.02, R2.01–R2.08)

## 2. Moving an array of tabs (`tabs.move([ids], …)`)

- **Members moved as an array to `{index: -1}` or `{index: 0}` lose their group, and the group is
  destroyed** — whenever the tabs actually change position. (R1.07, R1.08)

  | tab index | 0 | 1 | 2 | 3 | 4 | 5 |
  | - | - | - | - | - | - | - |
  | before | out1* | out2 | 🟥 gr1 | 🟥 gr2 | 🟥 gr3 | out3 |
  | `tabs.move([gr1, gr2, gr3], {index: -1})` | | | | | | |
  | after | out1* | out2 | out3 | gr1 | gr2 | gr3 |

- **If the tabs end up exactly where they already were, the group survives.** Note the wording: it
  is the *final position* that matters, not whether the browser did any work. With `{index: -1}` on
  a group already at the end, `tabs.onMoved` still fires for every member (each reported as
  `3 → 5`) and the group lives. With `{index: 0}` on a group already at the start, no event fires
  at all. (R1.09, R1.10)

  Compare with the case above: same final layout — members contiguous at 3,4,5 — but there the
  group died, because it had started at 2,3,4 and genuinely moved.

- **ALL window tabs → `{index: -1}`, group at the start or in the middle → the group is destroyed**
  and every tab is left ungrouped. Tab order is unchanged. (R1.11, R1.12)

- **Firefox BUG. ALL window tabs → `{index: -1}`, group at the END of the list → the group is
  assigned to every tab in the window.** (R1.13)

  | tab index | 0 | 1 | 2 | 3 | 4 | 5 |
  | - | - | - | - | - | - | - |
  | before | out1* | out2 | out3 | 🟥 gr1 | 🟥 gr2 | 🟥 gr3 |
  | `tabs.move(allWindowTabs, {index: -1})` | | | | | | |
  | after | 🟥 out1* | 🟥 out2 | 🟥 out3 | 🟥 gr1 | 🟥 gr2 | 🟥 gr3 |

  `tabs.onUpdated {groupId: 🟥}` fires for the three tabs that were dragged in. A bug will be filed
  in Bugzilla; until it is fixed, the behavior must be accounted for in code.

## 3. Creating and ungrouping (`tabs.group` / `tabs.ungroup`)

- **The first tab of `tabIds` does not move; the rest are pulled to it in `tabIds` order.** Its
  *index* can still shift, because members taken from before it leave gaps. The resulting block
  order is always the `tabIds` order, whatever the tabs' original positions were. (R2.09, R2.10)

  | tab index | 0 | 1 | 2 | 3 | 4 |
  | - | - | - | - | - | - |
  | before | gr1* | x1 | gr2 | x2 | gr3 |
  | `tabs.group({tabIds: [gr3, gr1, gr2]})` | | | | | |
  | after | x1 | x2 | 🟥 gr3 | 🟥 gr1* | 🟥 gr2 |

  `gr3` never moved — it was the first of `tabIds`. It slid from index 4 to index 2 only because
  `gr1` and `gr2` were lifted out from before it. Saying the group "forms at the position of the
  first tab" is therefore misleading: it forms *around* that tab.

  Events: `tabGroups.onCreated` first, then `tabs.onMoved` for each pulled tab, then
  `tabs.onUpdated {groupId}` for every member including the anchor.

- `tabs.group` on a **hidden** tab: the group is created and the tab stays hidden (R2.12), and
  **its header appears in the tab bar — expanded, with an empty title, showing no tabs at all**
  (R3.04 + 👁️) → group only visible tabs.
- `tabs.ungroup([ids])` for **part** of a group: the tabs **are moved** to the position immediately
  after the group's last remaining member, the array order is preserved. Events: `tabs.onMoved` for
  each moved tab, then `tabs.onUpdated` with `{groupId: -1}` for each. (R2.11)

  | tab index | 0 | 1 | 2 | 3 | 4 | 5 |
  | - | - | - | - | - | - | - |
  | before | x1* | 🟥 gr1 | 🟥 gr2 | 🟥 gr3 | 🟥 gr4 | x2 |
  | `tabs.ungroup([gr2, gr3])` | | | | | | |
  | after | x1* | 🟥 gr1 | 🟥 gr4 | gr2 | gr3 | x2 |

## 4. Hidden tabs (tabHide) and groups

- `tabs.hide()` **preserves** the tab's `groupId`; `tabs.show()` brings the membership back in
  place. Only `tabs.onUpdated {hidden}` fires — the group is never touched. `tabGroups.query` keeps
  seeing a group whose tabs are hidden. (R2.13)
- **A group whose every tab is hidden still exists**, and **its header stays in the tab bar** —
  with an empty title, still collapsible, showing no tabs at all (R2.15 + 👁️). The header cannot be
  removed (only userChrome.css — not an option for users). That is exactly why STG must ungroup
  tabs before hiding them.
- Moving a **hidden** tab onto a slot held by a group member → it **gets the `groupId`** and stays
  hidden. The membership rule of §1 does not care whether the tab is visible. (R2.14)

  | tab index | 0 | 1 | 2 | 3 | 4 |
  | - | - | - | - | - | - |
  | before | x1* | hid(h) | 🟥 gr1 | 🟥 gr2 | x2 |
  | `tabs.move(hid, {index: 2})` | | | | | |
  | after | x1* | 🟥 gr1 | 🟥 hid(h) | 🟥 gr2 | x2 |

## 5. Collapsed

- **A native group id cannot be changed.** `tabGroups.update` rejects the property outright:
  `Type error for parameter updateProperties (Unexpected property "id")`. Grouping the same tabs
  again after an ungroup produces a **different** id — native ids are unfit as stable identifiers.
  (R3.01)
- **Collapsing is not `tabHide`.** Every tab of a collapsed group still reports `hidden: false`,
  whether the active tab is inside the group or outside it. (R3.02, R3.03)
- **Collapsing hides only the group's inactive tabs.** The active tab stays in the tab bar, drawn
  outside the collapsed header:

  ```text
  x1 | [🟥 collapsed header] | gr2* | x2        gr1 and gr3 are gone from the bar
  ```

  It works from either direction — collapsing a group whose active tab is inside it (R4.01 + 👁️),
  or activating a tab inside an already collapsed group (R4.02 + 👁️) — and both end in exactly the
  same picture. Activating something outside the group takes that last tab away too (R3.02 + 👁️).
- With the active tab **outside** the group, a collapsed group shows **none of its tabs**, while
  **its header stays in the tab bar** (R3.03 + 👁️). Only the tabs go — the group does not vanish
  from the bar.
- **The `collapsed` flag does not describe what is drawn.** `tabGroups.query` keeps reporting
  `collapsed: true` while one of the group's tabs sits visible in the bar, and activating a tab
  inside a collapsed group fires only `tabs.onActivated` — no `tabGroups.onUpdated`. (R4.02)

## 6. Browser restart

- **A native group survives a browser restart intact** — tab order, membership, titles and
  collapsed state all come back. (R3.05)

  | tab index | 0 | 1 | 2 | 3 | 4 | 5 |
  | - | - | - | - | - | - | - |
  | before restart | x1* | 🟥 gr1 | 🟥 gr2 | x2 | 🟩 gr3 | 🟩 gr4 |
  | *browser restarted* | | | | | | |
  | after restart | x1* | 🟥 gr1 | 🟥 gr2 | x2 | 🟩 gr3 | 🟩 gr4 |

  🟥 kept `title:"first"`, 🟩 kept `title:"second"`. Live group ids are of course new (§5).

- **Hidden tabs come back hidden, and keep their group.** (R4.03)

  | tab index | 0 | 1 | 2 | 3 | 4 | 5 |
  | - | - | - | - | - | - | - |
  | before restart | x1* | 🟥 gr1 | 🟥 hid1(h) | 🟥 gr2 | hid2(h) | x2 |
  | *browser restarted* | | | | | | |
  | after restart | x1* | 🟥 gr1 | 🟥 hid1(h) | 🟥 gr2 | hid2(h) | x2 |

  This holds **even though the add-on that hid them was a temporary one, gone at startup**: the
  browser does not reveal tabs whose hider disappeared. Hidden state and membership are properties
  of the browser session, not of the add-on — the same session that keeps `sessions.setTabValue`
  values. `hid1` came back inside 🟥, `hid2` came back hidden and ungrouped.

## 7. Creating a tab inside a group's span (`tabs.create`)

- **`tabs.create` with an explicit `index` obeys exactly the membership rule of §1**: the new tab
  takes the group of whichever tab held that index. Both halves in one run — index 2 belonged to a
  member, index 4 to an outsider. (R5.03)

  | tab index | 0 | 1 | 2 | 3 | 4 | 5 |
  | - | - | - | - | - | - | - |
  | before | a* | 🟥 gr1 | 🟥 gr2 | b | | |
  | `tabs.create({index: 2})` — that slot held 🟥 gr2 | | | | | | |
  | after | a* | 🟥 gr1 | 🟥 ➕onMember | 🟥 gr2 | b | |
  | `tabs.create({index: 4})` — that slot held b | | | | | | |
  | after | a* | 🟥 gr1 | 🟥 ➕onMember | 🟥 gr2 | ➕onOutsider | b |

- **The tab is grouped from birth.** `tabs.onCreated` already reports the group (`group:🟥`); there
  is no follow-up `tabs.onUpdated {groupId}` the way a `tabs.move` produces one. (R5.03)

- **The FIRST member's slot is the boundary, not the inside**: a tab created at the index of the
  group's first member lands BEFORE the span and joins nothing — even though a member held that
  index. Holds with visible neighbours (R7.13) and with hidden tabs before the span (R7.12);
  R5.03's joining slot was an inside one (the second member). For creation the occupant rule
  reaches only INSIDE the span — unlike `tabs.move`, which joins at the first member's slot
  (§1, R2.01, R2.05).

  | tab index | 0 | 1 | 2 | 3 | 4 |
  | - | - | - | - | - | - |
  | before | x1* | x2 | 🟥 gr1 | 🟥 gr2 | |
  | `tabs.create({index: 2})` — that slot held 🟥 gr1, the first member | | | | | |
  | after | x1* | x2 | ➕new1 | 🟥 gr1 | 🟥 gr2 |

  | tab index | 0 | 1 | 2 | 3 | 4 |
  | - | - | - | - | - | - |
  | before | hid1(h) | hid2(h) | 🟥 gr1* | 🟥 gr2 | |
  | `tabs.create({index: 2})` — the same call with hidden tabs before the span | | | | | |
  | after | hid1(h) | hid2(h) | ➕new1 | 🟥 gr1* | 🟥 gr2 |

## 9. `tabs.ungroup` and `tabs.hide` vs the active tab

- **`tabs.ungroup` treats the active tab like any other member**: it leaves the group
  (`groupId: -1`), and when that empties the group, the group is destroyed and
  `tabGroups.onRemoved` fires. (R7.03)
- **`tabs.hide` silently skips the window's active tab**: no error, the call resolves with only
  the ids it actually hid, and the active tab stays visible and ungrouped. After another tab is
  activated, a second `tabs.hide` on the former active tab hides it normally. (R7.03)

  | tab index | 0 | 1 | 2 | 3 |
  | - | - | - | - | - |
  | before | x | 🟥 a* | 🟥 b | 🟥 c |
  | `tabs.ungroup([a, b, c])  — a is active` | | | | |
  | after ungroup | x | a* | b | c |
  | `tabs.hide([a, b, c])  — a is active` | | | | |
  | after hide | x | a* | b(h) | c(h) |
  | `activate(x), then tabs.hide([a])` | | | | |
  | after activate x + hide a | x* | a(h) | b(h) | c(h) |

  events:

  ```text
   2841ms  tabGroups.onRemoved   🟥  title:"G" collapsed:false
   2841ms  tabs.onUpdated        a  {groupId: -1}
   2841ms  tabs.onUpdated        b  {groupId: -1}
   2842ms  tabs.onUpdated        c  {groupId: -1}
   3357ms  tabs.onUpdated        b  {hidden: true}
   3357ms  tabs.onUpdated        c  {hidden: true}
   4204ms  tabs.onUpdated        a  {hidden: true}
  ```

  `tabs.hide([a, b, c])` resolved with `[b, c]`; the later `tabs.hide([a])` resolved with `[a]`.

## 10. Creating a tab next to a group span

- **Appending past the end of a strip that ends with a group span → the tab does NOT join.** Both
  with an explicit `index` equal to the strip length and with no index under `atEnd`.
  `tabs.onCreated` already reports `group:-1`. (R7.04)

  | tab index | 0 | 1 | 2 | 3 | 4 |
  | - | - | - | - | - | - |
  | before | keep1* | 🟥 gr1 | 🟥 gr2 | | |
  | `tabs.create(new1, {index: 3})` | | | | | |
  | after | keep1* | 🟥 gr1 | 🟥 gr2 | ➕new1 | |
  | `tabs.create(new2)  — no index, atEnd` | | | | | |
  | after | keep1* | 🟥 gr1 | 🟥 gr2 | ➕new1 | ➕new2 |

- **`afterCurrent` without an index, active tab is a member → the new tab JOINS the group**, born
  inside it (`tabs.onCreated` reports the group, no follow-up `onUpdated`). Holds both for a middle
  member (R7.05) and for the last member of a span at the very end of the strip (R7.06) — in the
  latter case the tab is effectively appended past the end and still joins, unlike the
  explicit-index append above.

  | tab index | 0 | 1 | 2 | 3 |
  | - | - | - | - | - |
  | before | keep1 | 🟥 gr1 | 🟥 gr2* | |
  | `tabs.create(new1)  — no index, afterCurrent` | | | | |
  | after | keep1 | 🟥 gr1 | 🟥 gr2* | 🟥 ➕new1 |

## 11. Moving an ARRAY onto a member's slot

- **The §1 occupant rule applies to arrays: every moved tab joins.** `tabs.move([m1, m2],
  {index: 4})` where index 4 was held by a member → both tabs join, in array order. Moving the
  array back onto a slot held by an outsider → both leave; the group survives while it keeps other
  members. Events per tab: `tabs.onMoved`, then `tabs.onUpdated {groupId}`. (R7.07)

  | tab index | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
  | - | - | - | - | - | - | - | - |
  | before | m1* | m2 | keep1 | 🟥 gr1 | 🟥 gr2 | 🟥 gr3 | keep2 |
  | `tabs.move([m1, m2], {index: 4})  — that slot held 🟥 gr2` | | | | | | | |
  | after | keep1 | 🟥 gr1 | 🟥 gr2 | 🟥 m1* | 🟥 m2 | 🟥 gr3 | keep2 |
  | `tabs.move([m1, m2], {index: 0})` | | | | | | | |
  | after | m1* | m2 | keep1 | 🟥 gr1 | 🟥 gr2 | 🟥 gr3 | keep2 |

## 12. `tabs.ungroup` of a hidden member

- **Works like on a visible member**: the call resolves, the tab loses the group and is MOVED to
  the position after the group's last remaining member (the §3 partial-ungroup relocation applies
  to hidden tabs too), staying hidden. `tabs.show` afterwards reveals it in place — no further
  move. Events: `tabs.onMoved`, `tabs.onUpdated {groupId: -1}`. (R7.08)

  | tab index | 0 | 1 | 2 | 3 |
  | - | - | - | - | - |
  | before | keep1* | 🟥 gr1 | 🟥 gr2(h) | 🟥 gr3 |
  | `tabs.ungroup([gr2])` | | | | |
  | after | keep1* | 🟥 gr1 | 🟥 gr3 | gr2(h) |

## 13. User gestures in the same window emit the same events as the API

Every fact above this section came from API calls; these are the mouse/menu counterparts.

- **Dragging a member out of the span** → `tabs.onMoved`, `tabs.onUpdated {groupId: -1}` (R8.01);
  dragging the LAST member out additionally fires `tabGroups.onRemoved` (R8.02) — same as §1/R1.06.
- **Dragging an outsider into the span** → `tabs.onMoved`, `tabs.onUpdated {groupId}` (R8.03).
- **The ungroup item of the header context menu** → `tabGroups.onRemoved` first, then
  `tabs.onUpdated {groupId: -1}` per member; the tabs do NOT move (R8.05) — the full-ungroup
  behavior of §9, not the partial-ungroup relocation of §3.
- **The delete item of the header context menu closes the tabs**: `tabs.onRemoved` per member,
  then `tabGroups.onRemoved`. No confirmation prompt. (R8.06)

## 14. Dragging a whole group by its header

- **The browser collapses the group for the duration of the drag and re-expands it on drop**:
  `tabGroups.onUpdated {collapsed: true}`, then `tabs.onMoved` per member and
  `tabGroups.onMoved`, then `tabGroups.onUpdated {collapsed: false}`. **Membership never
  flaps** — no `{groupId}` updates at all. (R8.04)

## 15. UI edits of the group header

- **Renaming types per keystroke**: every keystroke fires its own `tabGroups.onUpdated` with the
  partial title (`"R"`, `"Re"`, `"Ren"`, …). Collapse, expand and recolor fire one
  `tabGroups.onUpdated` each. (R8.07)

## 16. Native groups across windows

- **"Move group to new window" (header menu) keeps the group alive**: the SAME live group id
  arrives in the new window, every member keeps its membership. Events: `tabs.onDetached` +
  `tabs.onAttached` per member, then `tabGroups.onMoved` (in the new window). **No membership
  events fire** — nothing ever reports `groupId: -1`. (R8.08)
- **A single member dragged into another window arrives UNGROUPED** — and no `tabs.onUpdated
  {groupId: -1}` fires anywhere: only `tabs.onDetached` + `tabs.onAttached`. The source group
  survives with the remaining members. The membership is dropped silently — the only signal is
  the arrived tab's own `groupId`. (R8.09)

## 17. Windows born from moved tabs

How a window created by moving existing tabs announces itself. Three paths, two different orders.

- **"Move group to new window" (header menu): `windows.onCreated` is delivered FIRST**, tens of
  milliseconds before the first tab event; then `tabs.onDetached` + `tabs.onAttached` per member
  in group order, then `tabGroups.onMoved` — same live id, membership intact, as §16/R8.08.
  (R9.01, R9.02)
- **The initial tab of that window never fires `tabs.onCreated`.** The window is born with a
  regular initial tab, but the only event it ever emits is `tabs.onRemoved`
  (`isWindowClosing:false`), right after the attaches, when the browser closes it itself.
  (R9.01, R9.02)

  ```text
  21361ms  windows.onCreated     winA  type:normal
  21437ms  tabs.onDetached       gr1  from index:1
  21437ms  tabs.onAttached       gr1  to index:0  [winA]
  21437ms  tabs.onDetached       gr2  from index:1
  21437ms  tabs.onAttached       gr2  to index:1  [winA]
  21437ms  tabs.onDetached       gr3  from index:1
  21437ms  tabs.onAttached       gr3  to index:2  [winA]
  21437ms  tabGroups.onMoved     🟥  title:"G" color:blue collapsed:false  [winA]
  21438ms  tabs.onRemoved        initial  isWindowClosing:false  [winA]
  21439ms  tabs.onActivated      gr3  previous:-  [winA]
  ```

- **A hidden member travels with the group and arrives VISIBLE — silently.** No
  `tabs.onUpdated {hidden}` fires anywhere; the reveal is observable only by re-reading the tab.
  The reveal itself matches a cross-window `tabs.move` (MOVE-TABS-BEHAVIOR.md §1, R7.02); the
  no-event part is this run's addition. (R9.02)

  | tab index | 0 | 1 | 2 | 3 | 4 |
  | - | - | - | - | - | - |
  | before (scene) | keep1* | 🟥 gr1 | 🟥 hid1(h) | 🟥 gr2 | keep2 |
  | `USER: header context menu → move group to new window` | | | | | |
  | after (scene) | keep1* | keep2 | | | |
  | after (new window) | 🟥 gr1 | 🟥 hid1 | 🟥 gr2* | | |

- **A single tab dragged out to empty space (its own new window): the attach is delivered
  FIRST.** `tabs.onDetached` + `tabs.onAttached` arrive before `windows.onCreated` — same
  millisecond, attach ahead in the queue. The tab arrives UNGROUPED (extends §16/R8.09 to the
  new-window case), the source group survives, and the new window has NO initial tab at all —
  no `tabs.onCreated`, no `tabs.onRemoved`. (R9.03)

  ```text
  28943ms  tabs.onDetached       gr2  from index:2
  28943ms  tabs.onAttached       gr2  to index:0  [winA]
  28943ms  windows.onCreated     winA  type:normal
  28989ms  tabs.onActivated      keep2  previous:-
  28989ms  tabs.onActivated      gr2  previous:gr2  [winA]
  ```

- **`windows.create({tabId})` with a group member behaves exactly like the mouse drag**: attach
  delivered before `windows.onCreated`, no initial tab, the tab arrives ungrouped, the source
  group survives. (R9.05)

The two orders are the trap: a moved GROUP announces the window first, a moved single tab
announces the tab first. Per-window state initialized in `windows.onCreated` is already too late
for the single-tab paths.

## 18. Undo close window (Ctrl+Shift+N)

Scene closed with the window's X button, restored with Ctrl+Shift+N — came back exactly the same:
`res1* | 🟥 resGr1 | 🟥 resHid1(h) | 🟥 resGr2 | resHid2(h)`, group title/color included. (R9.04)

- **The restored window is populated ONLY through `tabs.onCreated`, with FRESH tab ids** — 0 of 5
  ids reused, not a single `tabs.onAttached`. (R9.04)
- **The first tab's `tabs.onCreated` is delivered BEFORE `windows.onCreated`** — 1 ms ahead in
  the queue. (R9.04)
- **The native group returns with the SAME live id it had before the close** — the one known
  exception to "grouping again produces a different id" (§5). Its `tabGroups.onCreated` fires
  between the first and the remaining tab creations. (R9.04)
- **Grouped tabs are born already grouped** (`tabs.onCreated` reports the group, like §7);
  **hidden tabs are born and immediately hidden by a follow-up `tabs.onUpdated {hidden: true}`**
  in the same millisecond. Hidden state and membership are fully restored, including the hidden
  tab inside the group. (R9.04)

  ```text
  10518ms  tabs.onCreated        res1  index:0 group:-1  [restored]
  10518ms  tabs.onActivated      res1  previous:-  [restored]
  10519ms  windows.onCreated     winB  type:normal
  10528ms  tabGroups.onCreated   🟥  title:"R" color:blue collapsed:false  [winB]
  10529ms  tabs.onCreated        resGr1  index:1 group:🟥  [restored]
  10530ms  tabs.onCreated        resHid1  index:2 group:🟥  [restored]
  10530ms  tabs.onCreated        resGr2  index:3 group:🟥  [restored]
  10530ms  tabs.onCreated        resHid2  index:4 group:-1  [restored]
  10530ms  tabs.onUpdated        unknown1  {hidden: true}  [winB]
  10530ms  tabs.onUpdated        unknown2  {hidden: true}  [winB]
  ```

  `unknown1`/`unknown2` are resHid1/resHid2 under their fresh ids — the harness had not learned
  their names yet at event time; the final state confirms exactly those two tabs are hidden.

## 19. Pinning a member (`tabs.update({pinned})`)

**Pinning a grouped tab is a clean detach: the browser itself strips the membership.** The tab
moves into the pinned zone and loses its group in one operation — `tabs.onMoved` first, then
`tabs.onUpdated {groupId: -1}`, then `tabs.onUpdated {pinned: true}`. The group survives while it
still has members. (R10.01)

| tab index | 0 | 1 | 2 | 3 |
| - | - | - | - | - |
| before | keep1* | 🟥 gr1 | 🟥 gr2 | 🟥 gr3 |
| `tabs.update(gr2, {pinned: true})` settled 260 ms | | | | |
| after | gr2(p) | keep1* | 🟥 gr1 | 🟥 gr3 |
| `tabs.update(gr2, {pinned: false})` settled 259 ms | | | | |
| after 2 | gr2 | keep1* | 🟥 gr1 | 🟥 gr3 |

```text
    3ms  tabs.onMoved          gr2  2 → 0
    3ms  tabs.onUpdated        gr2  {groupId: -1}
    3ms  tabs.onUpdated        gr2  {pinned: true}
    1ms  tabs.onUpdated        gr2  {pinned: false}
```

- **Unpinning does NOT restore the membership and does not move the tab** — it stays where the
  pinned zone ends, as the window's first normal tab, ungrouped; the only event is
  `tabs.onUpdated {pinned: false}`. (R10.01)
- **Pinning the LAST member destroys the group** — `tabGroups.onRemoved` fires between the move
  and the `{groupId: -1}` event. A pinned active tab stays active. (R10.02)

  ```text
      3ms  tabs.onMoved          gr1  1 → 0
      3ms  tabGroups.onRemoved   🟥  title:"G" collapsed:false
      4ms  tabs.onUpdated        gr1  {groupId: -1}
      4ms  tabs.onUpdated        gr1  {pinned: true}
  ```

- **`sessions` values survive both pin and unpin** — a value set before the pin reads back
  unchanged after each step. (R10.01)
- **`tabs.hide` silently SKIPS a tab sharing the microphone** — the call resolves with `[]`, no
  error, the tab stays visible. Same shape as the active-tab skip (§9). (R10.03)
- **Pinning works on a sharing tab**: `tabs.update({pinned: true})` on a tab with a live
  microphone resolves normally, the tab is pinned, the microphone and its tab-bar indicator stay
  live — behavior identical to a plain tab (👁️). (R10.03)

## 20. Moving an array to the end of the strip, and cross-window index moves

- **Same window: outsiders moved to the end of a strip that ends with a span → the movers JOIN
  the group.** An explicit index equal to the tabs count (R1.14) and `{index: -1}` (R1.20)
  behave identically: the call is accepted, the tabs land at the end, `tabs.onUpdated {groupId}`
  fires for each. Same family as the all-tabs `{index: -1}` bug of §2.

  | tab index | 0 | 1 | 2 | 3 | 4 | 5 |
  | - | - | - | - | - | - | - |
  | before | m1* | m2 | keep1 | 🟥 gr1 | 🟥 gr2 | 🟥 gr3 |
  | `tabs.move([m1, m2], {index: 6})  — index === tabs count` | | | | | | |
  | after | keep1 | 🟥 gr1 | 🟥 gr2 | 🟥 gr3 | 🟥 m1* | 🟥 m2 |

- **Cross-window: an array arriving past the end does NOT join the trailing span** — neither with
  an explicit index equal to the target's tabs count (R1.15) nor with `{index: -1}` (R1.18). The
  end of the strip is membership-safe only for arrivals from another window.

  | tab index | 0 | 1 | 2 | 3 | 4 | 5 |
  | - | - | - | - | - | - | - |
  | before (source window) | src1* | m1 | m2 | | | |
  | before (target window) | keep1* | 🟥 gr1 | 🟥 gr2 | 🟥 gr3 | | |
  | `tabs.move([m1, m2], {windowId: target, index: 4})` | | | | | | |
  | after (target window) | keep1* | 🟥 gr1 | 🟥 gr2 | 🟥 gr3 | m1 | m2 |
  | after (source window) | src1* | | | | | |

- **Cross-window arrivals at an inner index obey the §1/§11 occupant rule**: a MEMBER's slot joins
  the group, in array order (R1.16); the outsider slot right after the span joins nothing (R1.17).
  **The cross-window join is SILENT**: only `tabs.onDetached`/`tabs.onAttached` fire per tab — no
  `tabs.onUpdated {groupId}`, unlike the same-window moves of §1/§11 and R1.14 above. (R1.16)

  | tab index | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
  | - | - | - | - | - | - | - | - |
  | before (source window) | src1* | m1 | m2 | | | | |
  | before (target window) | keep1* | 🟥 gr1 | 🟥 gr2 | 🟥 gr3 | keep2 | | |
  | `tabs.move([m1, m2], {windowId: target, index: 2})` | | | | | | | |
  | after (target window) | keep1* | 🟥 gr1 | 🟥 m1 | 🟥 m2 | 🟥 gr2 | 🟥 gr3 | keep2 |
  | after (source window) | src1* | | | | | | |

  ```text
   10ms  tabs.onDetached       m1  from index:1  [other window]
   10ms  tabs.onAttached       m1  to index:2
   10ms  tabs.onDetached       m2  from index:1  [other window]
   10ms  tabs.onAttached       m2  to index:3
  ```

## 21. An array moves as a block

- **The array lands as one contiguous block in array order, starting at the requested index** —
  not tab-by-tab. Movers taken from beyond the target index would come out reversed under a
  one-by-one model; the real result keeps the array order. (R1.19; the §11 landing agrees.)

- **A block that lands between the members of a live span is swallowed whole.** The first mover —
  the span's own first member — was "moved" to its own slot; the free tabs of the block slid in
  after it, before the span's second member, and every mover reported the span's `groupId`. The
  displaced member keeps its membership. Gathering an in-window set at its first tab's slot is
  therefore membership-neutral ONLY when the first tab is span-free. (R1.19)

  | tab index | 0 | 1 | 2 | 3 |
  | - | - | - | - | - |
  | before | 🟥 m1* | 🟥 s2 | free1 | free2 |
  | `tabs.move([m1, free1, free2], {index: 0})  — index of m1 itself` | | | | |
  | after | 🟥 m1* | 🟥 free1 | 🟥 free2 | 🟥 s2 |

  events:

  ```text
    2ms  tabs.onMoved          free1  2 → 1
    2ms  tabs.onMoved          free2  3 → 2
    2ms  tabs.onUpdated        free1  {groupId: 🟥}
    2ms  tabs.onUpdated        free2  {groupId: 🟥}
  ```

## Implications for STG code

1. **Do not move tabs as an array to `{index: -1}`/`{index: 0}` if their native groups must be
   preserved.** For "reorder without changing positions" (creating an STG group from all window
   tabs) — `tabs.move(ids, {index: tabs[0].index})` or do not move them at all.
2. **Never do `move(allWindowTabs, {index: -1})`** — §2, the bug that assigns the group to them all.
3. Group (`tabs.group`) only visible tabs; before `hide` — ungroup (§3, §4).
4. Membership on insertion is decided by **the tab that currently occupies the target index**, for
   both `tabs.move` and `tabs.create` (§1, §7) — with one creation-only exception: at the FIRST
   member's slot `tabs.create` lands before the span and joins nothing, while `tabs.move` joins
   (§7 R7.12/R7.13 vs §1 R2.01). To place a tab outside every group, aim at an index held by a tab
   that is itself outside every group — computing the "final order" and reasoning about which tabs
   it ends up between gives the wrong answer, as §1 shows.
5. The order in `tabs.group({tabIds})` is controlled by us — the browser preserves it (§3). The
   first id is the anchor that stays put, so put the tab whose position should survive first.
6. **`tabs.hide` never hides the window's active tab** (§9) — hiding a whole group takes two
   steps (hide the rest, hand activity to another tab, hide the former active tab), and the state
   between the steps is observable from outside: the former active tab sits visible and ungrouped.
7. **Tabs appended past the end of the strip with explicit indexes can never join a live group**
   (§10) — hiding freshly appended tabs (restore, unarchive, bookmark import) needs no ungroup.
   A tab created WITHOUT an index CAN be born inside a group under `afterCurrent` (§10) — those
   paths must ungroup before hide.
8. **`tabs.onAttached` must not treat every arrival as a membership loss**: a group moved to
   another window arrives with its members and the same live id (§16), while a single dragged
   member arrives ungrouped with no `groupId` event (§16) — the arrived tab's own `groupId` is
   the only signal, decide by it.
9. **Array moves change membership by the same occupant rule as single moves** (§11) — sorting or
   moving arrays of tabs around live spans can silently join them to a group; §2 destruction rules
   and §11 join rules together mean no array move near spans is membership-neutral.
10. **A restored window and a window assembled from moved tabs differ by MECHANISM, not by
    heuristics**: a restored window repopulates only through `tabs.onCreated` with fresh ids
    (§18), moved tabs arrive through `tabs.onAttached` keeping their ids (§17). But the order
    relative to `windows.onCreated` varies by path — for single-tab windows the attach, and for
    restored windows the first creation, are delivered BEFORE `windows.onCreated` (§17, §18).
    Per-tab events must never be gated on state initialized in `windows.onCreated`.
11. **The browser reveals hidden tabs it moves between windows silently** — no `{hidden}` event
    at all (§17). Hidden-state bookkeeping driven by `tabs.onUpdated` misses the transition;
    re-read the tab.
12. **Pin-and-detach is one call**: pinning strips the native membership itself (§19) — no
    ungroup needed first; unpin does not bring the group back, and session values ride through
    both, so state for a later return can live in the session.
13. **The end of the strip is membership-safe only for arrivals from another window** (§20):
    a same-window move to the end joins a trailing span, a cross-window arrival joins nothing —
    explicit past-the-end index and `{index: -1}` alike, on both sides. Same-window tabs can be
    placed after a span only onto an outsider slot — or need an ungroup afterwards.
14. **A cross-window arrival that joins by the occupant rule joins SILENTLY** — only
    `tabs.onDetached`/`tabs.onAttached`, no `tabs.onUpdated {groupId}` (§20). Membership after
    a cross-window move must be re-read from the tabs, never derived from events.
15. **Gathering an in-window array at its first tab's slot is not membership-neutral** (§21):
    a first mover inside a live span swallows the whole set. A same-window gather is safe only
    with a span-free first mover and final positions equal to the initial ones (§2).
