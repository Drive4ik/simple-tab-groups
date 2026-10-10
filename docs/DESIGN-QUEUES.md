# Queues and operations — who waits for whom

How a shared resource is changed without two flows interleaving, and which queue may wait for
which. The code is `addon/src/js/queue.js`, `queue-core.js` and `operations.js`; the queues
themselves live in the modules that own them.

## 1. A move of a queue

A shared resource that is changed by "read, change, write" is changed only by a move of a
`Queue` (`js/queue.js`): the moves of one key run one at a time, in the order of the calls; the
error of a move goes to its caller and does not break the chain. A queue belongs to one module
and is never handed out: the only way into it is the API of the owner. A move has a mandatory
name, it goes into the log.

## 2. The queues, top down

- `Groups` (`groups.js`) — the array of groups in `storage.local`.
- `NativeGroups` (`groups-native.js`), keyed by window — the native groups of a window; it is
  also the gate of the window (`withWindowGate`).
- `MenusTransaction` (`menus.js`, `Menus.transaction`) — a batch of menu calls as one whole:
  everything `menus-main.js` exports, and the listeners of settings and permissions in the menu
  modules.
- `Menus` (`menus.js`) — the map of menus in `storage.session`.
- `TabsToRestore` (`windows.js`) — the key `tabsToRestore`.
- `Action` (`browser.js`) — the button of the add-on: icon, title, availability. A move is the
  whole drawing chain (`actionAllWindows`, `actionLoading`, `actionGroup`, `action`), so the
  order of the calls is the order of drawing: the last caller is the one that shows.
- `Cache` (`cache.js`), keyed by a session value of a tab or a window.

## 3. A move waits only for the queues below its own

Never for its own and never for one above: both moves hang, and everyone queued behind them.
Hence:

- Inside a `Groups` move `saveNow` and `updateNow` are called, not `save` and `update`, and
  nothing that ends with a write of the groups: `settleTabs`, `GroupsNative.apply`,
  `GroupsNative.restoreMembership`, `Tabs.move`, `Groups.apply`.
- Under the gate of a window the write of the groups is not awaited: the move of the gate returns
  the assembled `groupsNative`, and `Groups.update` goes after the gate is left
  (`GroupsNative.apply`, `mirrorWindow`).
- Inside `Menus.transaction` the functions of the menu modules are called, not `MenusMain.*`. A
  single `Menus.update` of one item is not wrapped into a transaction: during a rebuild the item
  may not exist, the error is not fatal and is swallowed by `.catch`.
- Inside an `Action` move `actionNow`, `actionGroupNow`, `actionAllWindowsNow` are called, not
  `Browser.action*`.
- A decision that depends on the state at the moment of the write is taken inside the move:
  `Groups.update` takes a function, the mirror checks `Operations.isBusy()` in it.

## 4. Operations are not a queue

`Operations.run` (`js/operations.js`): composite flows run in parallel, the module only knows
whether at least one is running. While `isBusy()`, the observers (the mirror of native groups,
the notifications to the popup) put their work off until `onIdle`.

## 5. Stuck moves

The watch is shared (`js/queue-core.js`): a move that stayed in one state for about 30 seconds,
and an operation longer than about 5 minutes, go into the log as `stuck` with the call stack —
a waiting move together with the move that holds it; one that finishes after that logs
`released`. Nothing is cancelled. `trace: false` on a queue turns the stack off; that is for
`Cache` only: a stack per move is expensive on thousands of tabs.
