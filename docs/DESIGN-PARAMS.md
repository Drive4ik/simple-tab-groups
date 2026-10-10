# The `params` object — flags that travel the whole call chain

The convention for the flags of an operation and the dictionary of the keys. The chains are in
`addon/src/js/groups.js`, `tabs.js`, `cache.js` and `windows.js`.

## 1. The convention

Flags that go down the whole call chain and may be needed by an inner function, even through one
link (`include*`, `skipTracking`, `hideUnloaded`), travel as the last argument in one `params`
object (`Groups.load` → `Tabs.query` → `prepare` → `Cache.loadTabSession`). An argument only the
function itself needs (`withTabs` of `Groups.load`, `isAutoBackup` of `createBackup`) stays
positional, before `params`. The rules:

- A method that reads nothing from `params` passes the object on as it is.
- A reader reads at the top of the function, one constant per key with its default:
  `const raw = params.raw ?? false;` (then `params.raw` is found in the code by one line). Below
  that `params` is only passed down the chain, never read. Destructuring in the signature is
  for the last link of the chain only (`cache.js`).
- A link passes `params` to the callees that read from it themselves or pass it further
  (`createMultiple` → `ensureSorted` → `moveNative` → `tabsAction`): a new key reaches its
  consumer without repacking, even when the links in between do not need it. A terminal function
  that reads only its own key and calls nothing further does not get `params`: it gets its key
  or nothing (`createMultiple` calls `create` without `params`).
- A key without which the function's own logic would go wrong is set by the function itself, on
  top of `params`: `pin` mutes its own `update` with `skipTracking: true`, `createMultiple` calls
  `ensureSorted` with `byMinIndex: true`. That is the contract of the function: the caller may
  not know about it and cannot override it. The reads a function makes inside its operation go
  with the keys it needs, without `params` (`ensureSorted` reads `{withSession: false}`): a
  foreign `sortByIndex` in that read would break the block check.
- Nobody writes into `params`. A different value for a callee is a new object:
  `Tabs.query({pinned: false}, {...params, includeFavIconUrl: false})`.
- The default of a key lives only at its consumer; the links in between pass `undefined`
  through. A default that depends on loaded data (`showTab` from the group in `moveNow`) is read
  right after the load, still as one constant.
- The constant is named like the key, so a function of the module never carries such a name
  (`skipTrackingTabs`, not `skipTracking`).
- A key means the same thing everywhere. A new key goes into the dictionary first.

## 2. The dictionary

Reading a tab — `raw`, `withSession`, `includeFavIconUrl`, `includeThumbnail` (`Tabs.prepare`,
`Cache.loadTabSession`; the group and the sub-group are always read, the icon and the thumbnail
default to `false`). `includeThumbnail` on a read means "if the thumbnails option is on": the
option is known to the cache (`Cache.setUseThumbnails`, set by `tabs.js` at the start and on a
change of the option, by `restoreBackup` from the backup), the callers do not check it.
`sortByIndex` — `Tabs.list`.

Saving a tab — `includeGroupId`, `includeGroupNativeId`, `includeFavIconUrl`,
`includeThumbnail`, `includeOpener`, `includeLastAccessed` (`Tabs.prepareForSaveTab`).

Operations:

- `skipTracking` — the tab events are muted (`tabsAction` and everything through it; for
  `remove` it is also a silent removal; the default per action is set by `tabsActionSchema`).
- `skipTrackingCreated` — the created tab bypasses its own `onCreated` (`Tabs.create`; the
  default is set by `tabsActionSchema` too).
- `allowDiscarded` — `Tabs.create`: may the tab be born discarded from memory; `create` decides
  itself, `false` forbids it.
- `activateOther` — `Tabs.hide`: the active tab of the set yields to another visible one.
- `onlyMutedBySelf` — `Tabs.setMute`: touch only the tabs whose mute the add-on set itself.
- `ungroupNative` — `Tabs.hide`, `Tabs.remove`: first detach from the live native groups.
- `keepWindowsAlive` — `Tabs.remove`: a window losing its last visible tab gets a temporary one.
- `startIndex`, `createMissing`, `hideUnloaded` — `createMultiple`.
- `byMinIndex` — `ensureSorted`.
- `joinLiveGroupId` — `Tabs.group`.
- `newTabIndex`, `auto`, `showTab`, `showOnlyActiveTab`, `showNotification` — `Tabs.move`.
