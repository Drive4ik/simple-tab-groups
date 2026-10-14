# Sub-groups — the browser's tab groups inside a group

What the add-on keeps about Firefox's own tab groups, who decides the membership of a tab, and
how the browser, the storage and the cloud are kept in step. The code is
`addon/src/js/sub-groups.js`; the callers are `tabs.js` (the events, the moves, the saving of a
tab), `groups.js`, `windows.js`, `background.js` (the backup) and `sync/cloud/cloud.js`. The
browser facts are in `BEHAVIOR-TABGROUPS.md`, cited by `§` below.

## 1. The words

One thing — one word, everywhere in the add-on:

- **sub-group** (`subGroup`, `subGroupId`, `group.subGroups`, `tab.subGroupId`) — STG's record of
  a browser tab group inside an STG group: a stable string id (`createSubGroupId`, eight
  characters of a UUID) and the metadata `{id, title, collapsed, color}`.
- **live group** (`liveGroup`, `liveId`) — the browser's tab group as it is right now, and its
  numeric id from `browser.tabGroups`. Ephemeral: a re-created group gets a new id (§5), so live
  ids never leave the runtime — the module translates them to sub-group ids and back.

## 2. What is stored, and what is the truth

```txt
tab.subGroupId         session value of the tab (Cache.KEYS) = the sub-group of the tab
group.subGroups        [{id, title, collapsed, color}] in the group, the order is meaningless
```

The session value is the single source of truth for membership: it survives a restart of the
add-on and of the browser (§6), `Tabs.prepareForSaveTab` carries it into the backup, the cloud,
the archive and the undo snapshot, `Tabs.create` writes it back. The metadata only follows the
tabs: a record no tab references is garbage, collected by `apply` once the group is loaded and
dropped from every snapshot by `referencedSubGroups` (the backup, the archive, the undo, the
cloud record). So whether a group holds an id is judged by its tabs, never by its metadata
(`collectSubGroupIds` reads the tabs and throws on a group read without them).

A tab whose id has no record is harmless: nothing materializes it, the mirror keeps it as a
pending import (§4 below) until the record arrives or the tab is seen live in that window.

The same shape lives in the storage, the backup, the cloud and the archive — there is no other
representation. Both keys are created by `Groups.create` and by the migration of 6.0, so the
code reads them without defaults: a group without them is a developer's mistake and breaks
loudly.

## 3. The invariants

1. **Membership lives on the tabs**, the metadata follows (§2 above).
2. **One sub-group id never lives in two STG groups.** The moves keep it (§7), the paths that
   bring groups in from outside restore it (§8).
3. **A hidden tab is never a member of a live group by the add-on's doing.** `Tabs.hide` and
   `Tabs.remove` ungroup first (`ungroupNative`): a group whose tabs are all hidden keeps an
   empty header in the tab bar (§4), and closing a whole span in one call leaves a saved group
   no API can remove (§26). `apply` groups only the visible members of a record. A hidden tab
   inside a live group can still happen without the add-on — the browser moves a hidden tab onto a
   member's slot (§4) or restores hidden members after a restart (§6), another add-on hides a
   member — and the add-on does not know why and has no right to unbind or move it
   (`DESIGN-EVENTS.md` §3). It goes by what the user sees in the tab strip: a hidden tab is out of
   the picture, the mirror reads visible tabs only and leaves such a tab as it is, session
   included.
4. **Pinned tabs are outside.** Pinning strips the live membership itself (§19); the add-on drops
   the session in `tabs.onUpdated {pinned}` and in `Groups.pinSharingTabs`. The mirror never
   reads pinned tabs.
5. **Unsync tabs** (tabs without a group in a window that gets a group) lose their sub-groups on
   purpose (`clearMembership`): the add-on manages them, their groups are destroyed.

## 4. The mirror — the user's actions become sub-groups

The mirror turns what the user does in the tab strip into sessions and metadata. It is the one
exception to "the add-on's own actions are muted" (`DESIGN-EVENTS.md`): it listens to every
event — `tabGroups.onCreated / onUpdated / onMoved / onRemoved`, `tabs.onCreated` for every
appeared tab, the add-on's own included (`newTabPosition = afterCurrent` can drop a new tab
inside a live span and the browser joins it, §10), `tabs.onUpdated {groupId}`, `tabs.onMoved`,
`tabs.onDetached / onAttached` — and the add-on's own `Tabs.moveNative` schedules it too, since
its events are muted. The skip flags of the handlers only suppress STG's own bookkeeping.
Everything ends in `scheduleMirrorWindow(windowId)`.

**One pass per window, on a settled state.** The triggers are batched per window. While a
composite operation runs (`Operations.isBusy()`, `DESIGN-QUEUES.md`) the window is parked and
one pass runs on idle: an operation in flight shows transient states — tabs visible and ungrouped
a moment before they are hidden — that the mirror would honestly record as the user's doing. The
pass re-checks the operations at three points, after every read, and once more inside the
`Groups.update` move: a reading that an operation overtook is thrown away, nothing is written.

**The pass.** It reads the visible tabs of the window raw (their `groupId` is the live id) and
the live groups, and loads the sessions of the tabs. A live group the module does not know —
after a restart of the browser or of the add-on the live ids are new (§6), and the user may have
created the group — is **adopted**: its sub-group id is elected by the majority of its members'
sessions among the ids no other live group holds, otherwise a new one is minted. This is how a
sub-group survives a restart under its own id. The live ids of the window are linked to their
sub-group ids and marked as materialized in that window.

**Sessions.** Live membership wins immediately: a visible member gets the sub-group id of its live
group. A visible tab OUT of every live group is only **nominated** to lose its session, and only
when its id was live once in that window: the user pulled the tab out or destroyed the group.
An id the window never saw live is a **pending import** — a tab that arrived with a session the
window has not materialized yet; the session is the only thing that will materialize it, so it
stays. The erase itself runs in a second settled pass (`clearWindowSessionsNow`) that re-reads
the window: a candidate that changed in between — rehidden, regrouped, moved away, its session
rewritten — is dropped silently. Detection is state-based: any later pass re-nominates a still
real pull-out, nothing depends on catching an event exactly once. When a session changed, the UI
is told to refetch the tabs (`Tabs.sendUpdatedGroup`): membership lives on the tabs, a
metadata broadcast is not enough.

**Metadata.** The window's group gets the live groups of the window as records, plus the stored
records a visible tab still references (pending imports); everything else is dropped. The write
is a `Groups.update` after the gate (§5). A window without an active group gets the sessions
only.

## 5. The window gate

`withWindowGate`: the `SubGroups` queue keyed by window serializes the mirror, the erase,
`apply` and `restoreMembership` within a window, and suppresses the mirror while one of them
runs — a trigger that arrives under the gate marks the window dirty, and one mirror pass follows
the release, no event is lost. Nothing under the gate waits for the groups queue: a gated
operation returns the metadata it has collected, and the write goes after the gate is released
(`DESIGN-QUEUES.md` §3).

## 6. apply — the storage becomes live groups

`apply(windowId, group)` re-creates the sub-groups of a loaded group in its window from the
sessions of its tabs. It runs when a group is shown in a window (`Groups.apply`), at the tail of
a restore of tabs for a loaded group (`Groups.settleTabs`), after the grand restore gathers a
torn group into its window (an array move can tear live groups apart, §2, §11), and at the start
of the add-on right after a backup restore (`reconcileWindow(windowId, true)`: the storage is
the truth then). An ordinary start mirrors instead: after a restart of the browser the live
groups are the truth (§6).

First `isLiveStateSame`: nothing is touched when every live group of the window is adopted and
matches a record by title, collapsed and color, and the live membership of every visible tab
equals the sub-group its session names. Otherwise every tab of the group is ungrouped and the
records are applied one by one: the visible members are grouped and the live group gets the
metadata; a record whose members are all hidden is kept as it is; a record with no members at
all is dropped — the garbage collection, the only way `apply` changes `group.subGroups`. A
record that failed to apply is kept: the sessions still reference it, the next `apply` retries.

## 7. A move by the add-on

`Tabs.move` takes `snapshotMembership` before the move and `restoreMembership` after it. The
census of a sub-group is its sessions over all tabs — visible, hidden and unsync alike. The
rules, in this order:

1. A sub-group whose EVERY member is in the moved set travels as itself, same id, wherever it
   goes — the add-on's counterpart of the browser's header drag, which STG's UI does not have.
2. A partial move within the sub-group's own STG group follows the browser rule: the movers lose
   it (§1), there is no cloning inside one group.
3. A partial move to ANOTHER group follows `cloneSubGroupsWhenMovingTabs`: off — the movers lose
   it; on — the sub-group is cloned into the target under a fresh id, the original stays behind.
4. Landing inside another sub-group's span wins over all of the above — the browser's occupant
   rule (§1): a tab dropped into a span joins it. A mover that arrived inside a live span keeps
   the browser's placement (a cross-window arrival at an inner index joins silently, §20); a
   drop onto a tab of an unloaded group's sub-group (`destSubGroupId` in `moveNow`) gives the
   movers that sub-group instead of anything carried — the same rule for a group whose spans are
   not live, so a drop into a sub-group behaves the same whether the group is loaded or not.

The record of a carried sub-group comes from any group's `subGroups`, or from the live group
itself for unsync tabs in a window without an active group.

After the move, into a loaded group: the carried sub-group is created live in the window — or
joined, when it is still live there (a move within the group where the browser kept the group
alive, §2) — and linked; the mirror writes it into the metadata. Into an unloaded group: the
sessions are written and the record is appended to `group.subGroups`. A mover that carried
nothing loses its stale session. The tab objects a move returns come from `moveNative` with
the session keys stripped: the cache is asked, not the object.

A recreation in another container (`Tabs.recreate`) keeps the live membership of the copies by
the occupant rule: a copy is born at the original's slot — one slot further for the first member
of a span, whose slot is the boundary (§7, §25) — and the copies the rule left out join in place
(§23). The snapshot is taken on the originals and mapped onto the copies; the carried sub-group
is written after the move.

## 8. One id, one group — the paths that bring groups in

`collectSubGroupIds(groups)` builds the lookup "which sub-group ids each group holds", by the
tabs, the groups coming with their tabs; an id is listed under the FIRST group of the list that
holds it, so the order of the list decides who keeps a duplicated id. `reissueSubGroupIds(copies,
lookup)` gives a fresh id to every sub-group of a group whose id another group holds — the same
fresh id in the metadata and on every tab, in every copy of the group — and says whether it
changed anything. The copies are the same group in several records (the local and the cloud
one); the group's own key in the lookup is skipped, its ids are not taken from itself.

- **The backup** (`restoreBackup`): the lookup is the current groups, the archived ones included
  — unarchiving brings their sub-groups live. A restored group whose own id is taken gets a
  fresh group id first.
- **The undo of a removal** (`Groups.restore`): the same, over the stored groups loaded with
  their tabs; a taken group id is renewed too — while the undo waits, a backup or the cloud can
  bring the same group back.
- **The cloud merge** (`syncGroups`): the merge is per group — `mergeSubGroups` lets the cloud
  record win by id, adds the local-only sub-groups that still have members and drops the
  unreferenced ones on both sides; `syncTabSubGroup` lets the cloud win the membership of a
  matched tab. A sub-group moved whole on one device while another device kept its tabs by
  `lastAccessed` ends in two groups. So after the merge, over the result lists: the stale
  records are dropped from the local copies (a record without member tabs would be reissued as
  if the group held the id), and the lookup over the local result decides — the first group
  keeps a duplicated id, the others are reissued in the local and the cloud copy alike, with
  `changes.local` and `changes.cloud` set by hand. One copy alone would not do: the next merge
  brings the old id back from the other one. After the sync the final ids go into the sessions
  and `Groups.settleTabs` → `apply` re-links a renamed sub-group that is live
  (`DESIGN-CLOUD-UPLOAD.md`).

## 9. Start, windows, migration

- An ordinary start mirrors every window (`Windows.initializeGroups` → `reconcileWindow`): the
  sessions survived, the live ids are new, adoption by the votes restores the ids. A start right
  after a backup restore applies instead.
- A removed window takes its per-window bookkeeping with it (`forgetWindow`);
  `tabGroups.onRemoved` with `isWindowClosing` unlinks the live id without a mirror pass.
- The migration to 6.0 (`migrations-main.js`) adopts the live groups of every window as
  sub-groups: every (live group, owner STG group) pair gets its own fresh id, because one live
  group can span several STG groups — the add-on before 5.5 hid tabs without ungrouping, so the
  hidden members belong to their unloaded groups by session and the visible ones to the window's
  active group.

## 10. The UI

The popup and the manager get `tab.subGroupId` with the tabs (`defaultAvailableTabKeys` of
`tab-groups.mixin.js`) and `group.subGroups` with the group, join them in `subGroupByTab` and
draw the color of the sub-group (`subGroupColorStyle`, the CSS variable `--sub-group-color`).
A change of membership reaches them as a refetch of the tabs (`Tabs.sendUpdatedGroup`), a
change of the metadata as the usual group update.
