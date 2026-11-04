# Queues and operations — who waits for whom

How a shared resource is changed without two flows interleaving, and which queue may wait for
which. The code is `addon/src/js/queue.js`, `queue-core.js` and `operations.js`; the queues
themselves live in the modules that own them.

## 1. A turn of a queue

A shared resource that is changed by "read, change, write" is changed only by a turn of a
`Queue` (`js/queue.js`): `using turn = await queue.wait(name, outerTurn, {key, stuckAfter})`. The
turns of one key run one at a time, in the order of the calls; `wait` resolves when it is the caller's turn,
and the turn is released when the block that declares it ends — normally, by `return` or by an
error. So inside such a block a returned promise is awaited (`return await …`): a promise
returned as it is leaves the block, and the turn, before the promise settles. The error of a turn
goes to its caller and does not break the chain. A turn has a mandatory name, it goes into the
log.

A queue belongs to one module and is never handed out: the only way into it is the API of the
owner. What may leave the module is the release of a turn — an object whose dispose releases it
(`Menus.transaction` returns a `DisposableStack` that holds the turn and the log of the
transaction to the menu modules); the queue itself does not.

A function that is called inside a turn of its own queue takes the outer turn in `this`:
`using turn = await queue.wait(name, this)`, and the call inside the turn is
`fn.call(turn, …)`. From outside the function is called as usual, and `this` is not a turn.
`wait` hands out the same turn when `outerTurn` is a live turn of the queue with the same key;
the turn counts the blocks that hold it and is released with the last one. Only a function that
is called inside a turn passes `this`; the others call `wait(name)` or `wait(name, null, {key})`.
A call inside the turn without `.call(turn, …)` — a bare call, `ids.map(fn)` — takes a second
turn of the same queue and hangs for good; the watch reports it after about 30 seconds (§5): the
browser cannot tell a nested call from a neighbouring one.

A turn that is the middle of a function goes into a bare block `{ using turn = …; … }`, and
what must run after the release (§3) goes after the block.

## 2. The queues, top down

- `MissedTabs` (`windows.js`) — the readers of `tabsToRestore` that create tabs and forget what
  they read: the restore of the tabs of closed windows (`tryRestoreMissedTabs`) and the grand
  restore (`runGrandRestore`), one at a time, each reading the list after the previous one has
  forgotten. Above everything: they create tabs and write the groups.
- `Groups` (`groups.js`) — the array of groups in `storage.local`.
- `SubGroups` (`sub-groups.js`), keyed by window — the live groups of a window; it is
  also the gate of the window (`openWindowGate`).
- `MenusTransaction` (`menus.js`, `Menus.transaction`) — a batch of menu calls as one whole:
  everything `menus-main.js` exports, and the listeners of settings and permissions in the menu
  modules.
- `Menus` (`menus.js`) — the map of menus in `storage.session`.
- `TabsToRestore` (`windows.js`) — the key `tabsToRestore`.
- `Action` (`browser.js`) — the button of the add-on: icon, title, availability. A turn is the
  whole drawing chain (`actionAllWindows`, `actionAllGroups`, `actionLoading`, `actionGroup`,
  `action`), so the order of the calls is the order of drawing: the last caller is the one that
  shows.
- `Cache` (`cache.js`), keyed by a session value of a tab or a window.
- `Host` (`host.js`) — the native messaging host: one message at a time per page (the
  background and the options page run their own instances of the module, each with its own
  queue). The version check (`checkVersion`, the background only) holds the turn over its own
  messages, so no other message of the background reaches the host while it is being updated.

## 3. A turn waits only for the queues below its own

Never for its own and never for one above: both turns hang, and everyone queued behind them.
Hence:

- Inside a `Groups` turn `save.call(turn, groups)` is called, not `save`, and nothing that ends
  with a write of the groups: `Groups.update`, `settleTabs`, `SubGroups.apply`,
  `SubGroups.restoreMembership`, `Tabs.move`, `Groups.apply`.
- Under the gate of a window the write of the groups is not awaited: the gate is left, and
  `Groups.update` goes after it (`SubGroups.apply`, `mirrorWindow`). A mirror trigger under the
  gate marks it dirty, and the gate schedules one pass at its release (`DESIGN-SUB-GROUPS.md`
  §5).
- Inside `Menus.transaction` the functions of the menu modules are called, not `MenusMain.*`. A
  single `Menus.update` of one item is not wrapped into a transaction: during a rebuild the item
  may not exist, the error is not fatal and is swallowed by `.catch`.
- Inside an `Action` turn the functions of `browser.js` are called through `.call(turn, …)`:
  `action`, `actionGroup`, `actionAllWindows`, `actionAllGroups`.
- Inside a `Host` turn (`checkVersion`) `sendMessage.call(turn, …)` is called, not `sendMessage`.
- A decision that depends on the state at the moment of the write is taken inside the turn:
  `Groups.update` takes a function, the mirror checks `Operations.isBusy()` in it.

## 4. Operations are not a queue

`Operations.start` (`js/operations.js`): `using operation = Operations.start(name)` for the whole
duration of a composite flow. The flows run in parallel, the module only knows whether at least
one is running; a flow started inside another one just raises the count. While `isBusy()`, the
observers (the mirror of live groups, the notifications to the popup) put their work off until
`onIdle`.

## 5. Stuck turns

The watch is shared (`js/queue-core.js`): a turn that stayed in one state longer than its
`stuckAfter` (30 seconds unless the queue sets its own in the constructor or the caller in `wait`;
the folder dialog and the update of the host get 10 minutes), and an operation longer than 5
minutes, go into the log as `stuck` with the call stack —
a waiting turn together with the turn that holds it; one that finishes after that logs
`released`. Nothing is cancelled. `trace: false` on a queue turns the stack off; that is for
`Cache` only: a stack per turn is expensive on thousands of tabs.
