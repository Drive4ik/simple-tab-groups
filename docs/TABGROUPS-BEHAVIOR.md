# Reference: Firefox behavior with native tab groups (tabGroups)

Verified live on Firefox 154 (August 2026) with a throwaway test add-on, in a clean profile with no
other add-ons. All tests — without pinned tabs. Every fact here is one browser build on one machine;
a claim is as strong as the runs cited next to it, and no stronger.

Only facts confirmed by an actual test run belong here — never assumptions about how the browser
"probably" works. Tab-creation facts (`tabs.create`, `index`, newTabPosition) live in
CREATE-TABS-BEHAVIOR.md; what overlaps is duplicated in both files with cross-references.

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

  Duplicate of CREATE-TABS-BEHAVIOR.md §7 — keep both copies in sync.

## Implications for STG code

1. **Do not move tabs as an array to `{index: -1}`/`{index: 0}` if their native groups must be
   preserved.** For "reorder without changing positions" (creating an STG group from all window
   tabs) — `tabs.move(ids, {index: tabs[0].index})` or do not move them at all.
2. **Never do `move(allWindowTabs, {index: -1})`** — §2, the bug that assigns the group to them all.
3. Group (`tabs.group`) only visible tabs; before `hide` — ungroup (§3, §4).
4. Membership on insertion is decided by **the tab that currently occupies the target index**, for
   both `tabs.move` and `tabs.create` (§1, §7). To place a tab outside every group, aim at an index
   held by a tab that is itself outside every group — computing the "final order" and reasoning
   about which tabs it ends up between gives the wrong answer, as §1 shows.
5. The order in `tabs.group({tabIds})` is controlled by us — the browser preserves it (§3). The
   first id is the anchor that stays put, so put the tab whose position should survive first.
