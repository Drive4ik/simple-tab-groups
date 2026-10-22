# Groups, tabs and windows — how a group owns its tabs

What a group promises about its tabs and which windows the add-on works in. The code is
`addon/src/js/groups.js`, `tabs.js` and `windows.js`; the browser facts are in
`BEHAVIOR-CREATE-TABS.md`, `BEHAVIOR-MOVE-TABS.md`, `BEHAVIOR-REMOVE-TABS.md` and
`BEHAVIOR-TABGROUPS.md`.

## 1. Pinned tabs are outside the logic

The add-on never touches a pinned tab. The one exception is a tab that cannot be hidden — a
microphone, a camera or a screen share, `Tabs.isSharing`: wherever the add-on would have to hide
it, it pins the tab itself and unbinds it from its group completely (`Groups.pinSharingTabs`, the
first step of `Groups.hideTabs`), and tells the user about it a couple of times
(`thisTabsWerePinned`). A move into an unloaded group (`moveNow`) pins such tabs in advance,
before the focus leaves and before the move. Into a loaded group such a tab moves like any
other; its copy on a recreate in another container (`recreate`) is loaded right away
(`allowDiscarded: false`). A pinned tab holds no group and no sub-group: `Tabs.clearPinnedSessions`
drops them — on every pin `tabs.onUpdated` delivers, under the mute of an operation too (a pin is
never an action of the add-on, bar the pin of a sharing tab), on the pin of a sharing tab, and over
every pinned tab at the start of the add-on (§5) and at every window the browser opens (the grand
restore of `windows.onCreated`, once for its whole batch of windows: the pinned tabs of a restored
window are in by the time it reads, `BEHAVIOR-CREATE-TABS.md` §59), for the pins the add-on did
not see.

## 2. The tabs of a group are one block

The tabs of a group always sit next to each other: a contiguous run of indexes with no foreign
tab in between. Every operation keeps the block. A move into a group aims at an edge of the
block (the anchor follows `newTabPosition`), and when that edge is a sub-group the moved
tabs join it. A loaded and an unloaded group must behave the same.

## 3. The options of a group set the state of its tabs

A tab that lands in an unloaded group by any route — a switch of groups, an unload, a move, an
add, the restore of a group or of a window, a sync, the start of the add-on — goes through the
options of the group:

- `muteTabsWhenGroupCloseAndRestoreWhenOpen` mutes it.
- `discardTabsAfterHide` discards it from memory, except an audible tab under
  `discardExcludeAudioTabs`, and except a tab that is empty by its real url (`tab.browserUrl`,
  `Utils.isUrlEmpty`): `Tabs.discard` skips such a tab — there is nothing to free, and a tab in
  reader mode discarded before its url has committed reports `about:blank` until it is activated
  (`BEHAVIOR-CREATE-TABS.md` §35); a skipped tab stays loaded until the next unload of its
  group.

A tab that lands in a loaded group with the mute option (a drag into its window included) gets
its sound back. The add-on's own mute (`mutedInfo.extensionId` is our id, `Tabs.setMute` with
`onlyMutedBySelf`) lives only while the group requires it: wherever the coupling brings a tab to
the state of a group without the mute option — a move, the opening of a group after the option
was turned off, a tab without a group — it is removed; a mute the user set in the browser is
touched only by the "restore when open" option. The speaker button of the popup mutes through
`tabs.update` too, and the browser marks it with our id: the add-on counts such a mute as its own
and removes it the same way — on purpose, the two cannot be told apart without keeping state.

The only coupling is `Groups.hideTabs` / `Groups.showTabs`; without a group (`null`) they just
hide or show, and that is how tabs without a group go in `groups.js` and `windows.js`. Hiding or
showing the tabs of a group past the coupling is forbidden. `Groups.hideTabs` does not touch an
already pinned tab at all, and it returns the tabs it hid: without the pinned ones, but with the
active tab of the window, which the browser refuses to hide (`applyNow` finds it in that list and
hides it in a second pass).

The exception is the tabs `createMultiple` (`hideUnloaded`) or `recreate` hides itself: with an
ordinary url they are born discarded; without a url, with `about:`, `data:`, a url over the
length limit or in reader mode (`about:reader`, created by the `openInReaderMode` flag) they are
born loaded, but a new tab has no sound.

## 4. Windows

The add-on acts in normal windows only. The "current" window of a user action — a hotkey, a
browser command, an external extension — is the normal window in focus,
`Windows.getFocusedNormalWindow`; with a private window or a `popup` window (the management
page in its own window) in focus there is no action. The one list past the normal windows is the
one the cleanup of temporary containers gets (`Containers.removeTemporaryUnusedBy`): a
container is removed only when no tab of the browser uses it, so the list comes from
`Tabs.removeUnusedTemporaryContainers` alone — every tab, the pinned ones and the windows of every
type, without sessions — at the start of the add-on and on the reopen of tabs in temporary
containers: a window of type `popup` holds a tab in a container like a normal one, and a container
removed under a living tab leaves the tab alive with the site data of the container wiped
(`BEHAVIOR-CREATE-TABS.md` §60, §61). Taken as given, not measured: a `popup`
window has no tab strip, a tab there cannot be clicked and has no context menu; a private window
is invisible to the add-on (`incognito: not_allowed`), `windows.getLastFocused()` rejects while
it is in focus (by the Firefox sources), and `windowTypes` is not read by that call (MDN). Tabs
that have no window of their own (a restore, the cloud, the archive — `Tabs.createMultiple`) get
one separately: the window of their group when it is loaded, else the window of the group's live
tabs — the kept tabs of the list (`createMissing`: the missing tabs of a group join its live ones,
§2), and for the tabs of closed windows any live tab of the group (`tryRestoreMissedTabs`: a
record may match none of them) — else the normal window in focus, else the first normal window by
id, `Windows.getFirstNormalWindowId`.

## 5. Start of the add-on

The add-on assumes the browser starts it once the browser itself is fully loaded: the windows,
the tabs and the native groups are restored by then. The one measured start,
`BEHAVIOR-CREATE-TABS.md` §55, had the windows there. A background that finds no normal window —
private and popup windows do not count — attaches no listener: `init` waits for
`windows.onCreated` and reloads the add-on. `initializeGroups` puts the windows and the tabs in
order. A group or a sub-group session left on a pinned tab — a pin the add-on did not see while it
was off, or one that landed between the read of a tab and the write of its group inside one
operation (`moveNow`) — is dropped (`Tabs.clearPinnedSessions`, §1),
and the mirror of the cache learns the pinned tabs by that read (`DESIGN-CACHE.md` §1). A live
tab whose session names an archived group is a
leftover of an archiving interrupted between the write of the storage and the closing of its tabs:
its copy already lives in the archive, and the start closes it — after the window sessions are put
in order, because a window left without visible tabs gets a temporary tab bound to the window's
group, and a stale session must not reach it. Not after a backup restore: the restored archives
hold no copies of the live tabs that were there before, so those tabs only lose their group. The
sync does not clean such leftovers, it closes only the tabs its own merge listed.

## 6. Other add-ons

Conflicts with add-ons of the same kind are possible (OneTab, Panorama Tab Groups, Tiled Tab
Groups and the like). The private mode is not supported on purpose (`"incognito": "not_allowed"`).

## 7. A backup restore

`restoreBackup` (`background.js`) materializes the live groups of the backup through
`Tabs.reconcile`: a saved tab takes a live tab with the same url and container, otherwise it is
created (`Tabs.createMultiple`, §4). A container that the restored tabs use and this profile lacks
is matched by name, color and icon or created (`Containers.findExistOrCreateSimilar`), and the map
of the old ids to the new ones travels into `reconcile`, so the tabs follow their groups into the
matched container. The tabs saved in temporary containers (`TEMPORARY_CONTAINER`) and the tabs of
a container the backup does not describe share one temporary container created for the restore. Without clearing, the current groups stay as they are and only
the tabs of no current group are offered for adoption; with clearing, every tab is free. Then the
add-on reloads, and `initializeGroups` applies the sub-groups of the group loaded in each window
from the storage (`DESIGN-SUB-GROUPS.md` §6).
