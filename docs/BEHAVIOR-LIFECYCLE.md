# Extension lifecycle behavior

`runtime.onInstalled`, `runtime.onUpdateAvailable` and what each storage survives across install,
update, enable/disable, browser restart, a reload of the addon and uninstall; what a page of the
addon can still do while the addon reloads (§9). The version system of the addon stands on these
facts: when the stored version marker can be missing, when `previousVersion` is available to heal
it, and which storage survives what.

Install/update facts here are produced by a throwaway two-addon stand (§6), not by `test-addon/` —
the addon under test is killed by every install and update those facts are about, so it cannot
host a harness; their markers are `L<n>`, the format is registered in `BEHAVIOR-NOTATION.md` §4
and §7. The shutdown facts (§8) and the reload facts (§9) are the exception: the shutdown and the
reload take the addon down too, but the evidence lands in its `localStorage`, which both keep, and
is read back after the restart, so the regular harness hosts them — their markers are the usual
`R<round>.<test>`.

Recorded run: 2026-08-07, Firefox 154, clean profile, no Firefox account, MV2 background,
permanent installs of unsigned zips (`xpinstall.signatures.required=false`), temporary loads via
about:debugging. Sessions are cited by their ids from the recorded log (§7).

## 1. When runtime.onInstalled fires — L1

| action | onInstalled |
| - | - |
| fresh install | `{reason: "install", temporary: false}` — `36qr`, `lyjx` |
| update of a running addon | `{reason: "update", previousVersion, temporary: false}` — `nw5e` |
| browser restart | no event — `g1jh`, `571w` |
| disable → enable | no event — `ttic` |
| update installed while disabled → enable | **no event, ever** — `631k` |
| downgrade (older version loaded over newer) | no event — `e6t8` |
| Reload of a temporary addon | `{reason: "update", previousVersion: <same version>, temporary: true}` — `83qf` |

The critical row is the disabled update: the new version starts on enable with **no
`onInstalled` at all**, so `previousVersion` does not exist for exactly the "user disabled the
addon on an old version, updated it and enabled it later" path. Code must treat `previousVersion`
as an optional hint, never as a guaranteed input.

## 2. onInstalled delivery time — L2

In every session where the event fired it was delivered **+4…+11 ms** after the first line of the
background script, always before a 200 ms timer and interleaved with (usually before) the first
`storage.local.get` completion. Sessions: `36qr` +5, `nw5e` +4, `lyjx` +4, `83qf` +11, `zltx` +6.
One machine, so this is a typical figure, not a guarantee — code must not rely on the ordering,
only use it to size timeouts.

## 3. What survives what — L3

| storage | browser restart | disable→enable | update (running) | update while disabled | uninstall → install |
| - | - | - | - | - | - |
| `storage.local` | ✓ | ✓ | ✓ | ✓ | wiped |
| `storage.sync` | ✓ | ✓ | ✓ | ✓ | **wiped** |
| `localStorage` (background page) | ✓ | ✓ | ✓ | ✓ | wiped |

Survivals: `g1jh` `571w` (restart), `ttic` (disable/enable), `nw5e` (update), `631k` (disabled
update). Wipes: `lyjx` (uninstall + reinstall — all three read back empty). A reload of a temporary
addon keeps `localStorage` as well, a write made at the unload of a page included, and keeps the
origin of the addon (§9).

`storage.sync` was wiped in a profile **without** a Firefox account; with an account the data may
come back from the server, which was not tested. Either way sync storage cannot be treated as a
copy that outlives the local one.

## 4. A listener on runtime.onUpdateAvailable defers the update — L4

With a listener registered, installing a new version over a running addon does not restart it:
the running version receives `onUpdateAvailable` (`ttic` +60838 ms) and keeps running; the update
applies on `runtime.reload()` or the next browser restart (`nw5e` started only after a manual
reload). STG does not register this listener, so its updates apply immediately — mid-session.

## 5. A temporary addon with the id of an installed one — L5

Loading a temporary addon with the same id over an installed one replaces it and **shares its
storage** (`e6t8` read the permanent addon's data). Removing the temporary one uninstalls that id —
the storage is wiped — and restores the permanent addon through
`{reason: "update", previousVersion: <temporary's version>, temporary: false}` (`zltx`, empty
storage). Developer-facing: a temporary load over a real profile destroys that profile's addon
data on remove.

## 6. The stand

Two MV2 addons with explicit gecko ids (an explicit id is required for `storage.sync`).

**lifecycle** — the addon under test, installed/updated/disabled/removed during the run. Its whole
background script, in delivery order: register `runtime.onInstalled` and `runtime.onUpdateAvailable`
listeners synchronously and log their payloads with a ms-delta from script start; log
`background start`; log a snapshot of `localStorage`, then write `{version, starts, lastStart}`
markers into it; the same read-then-write probe for `storage.local` and `storage.sync` (logging the
read duration); log timer marks at 0/200/1000 ms. Every line carries a per-session random id, a
sequence number, the manifest version and the absolute time.

**collector** — a second, permanently installed addon; receives every line via
`runtime.sendMessage(collectorId, line)` (the sender retries while the collector is not up),
appends it to its own `storage.local` and renders the log live on an extension page with a button
that inserts user marks ("what I just did") between the lines.

Versions for the update steps are produced by zipping the lifecycle addon with a hand-bumped
manifest version. Re-verifying a fact = rebuilding this stand and replaying the action of that
fact.

## 7. The recorded log

Condensed to the lines the facts stand on; full lines carry `sid#seq version +delta event`.

```text
36qr v1.0  install v1.0.zip:        onInstalled {install, temporary:false} +5ms; local/sync/localStorage empty
g1jh v1.0  browser restart:         no onInstalled; all three storages intact
ttic v1.0  disable → enable:        no onInstalled; all intact
ttic v1.0  install v1.1 over running: +60838ms onUpdateAvailable {version:"1.1"}; addon keeps running v1.0
nw5e v1.1  manual reload applied it: onInstalled {update, previousVersion:"1.0", temporary:false} +4ms; all intact
     v1.1  disabled; v1.2 installed over disabled: no session, no events
631k v1.2  enable:                  NO onInstalled; all intact, markers still v1.1
571w v1.2  browser restart:         no onInstalled; all intact
lyjx v1.2  uninstall → install:     onInstalled {install, temporary:false} +4ms; local/sync/localStorage ALL empty
e6t8 v1.0  temporary load over installed v1.2 (downgrade): NO onInstalled; sees v1.2 data of the permanent addon
83qf v1.0  Reload of temporary:     onInstalled {update, previousVersion:"1.0", temporary:true} +11ms
zltx v1.2  Remove of temporary:     permanent v1.2 restored: onInstalled {update, previousVersion:"1.0",
           temporary:false} +6ms; storage of the id wiped by the temporary's uninstall
```

## 8. Browser shutdown delivers the close events, and a storage write started from them lands — R19.01

A quit (≡ menu → Exit) with two windows open: the harness scene window (one tab hidden by
tabHide) and the user's own window. The probe mirrors the STG `tabsToRestore` path: the close
events feed an in-memory list, `windows.onRemoved` snapshots it, reads `storage.local` and writes
the merge back. Delivery was recorded synchronously into the background page's localStorage, the
async chain proved itself by what was readable from `storage.local` after the restart.

- Every window gets the same close shape as a manual window close: `tabs.onRemoved
  {isWindowClosing: true}` for **every** tab — the hidden one included — then that window's
  `windows.onRemoved`.
- The windows go down one by one (the second window's events came ~75 ms after the first's).
- The `storage.local.get → set` chain started inside `windows.onRemoved` completes and the write
  survives the restart — **for the last window too** (get resolved +0 ms, set resolved +1 ms
  after its `windows.onRemoved`).
- `browser.windows.getAll()` called inside `windows.onRemoved` still answers during the shutdown:
  it resolved (1 window left) for the first window. For the last window neither a resolve nor a
  reject line survived — either the promise never settled or the final localStorage flush lost
  the tail; the two are indistinguishable from inside the process.

The recorded log (times count from the probe's registration; `foreignA` is the user's window):

```text
+12794ms  tabs.onRemoved  foreign  isWindowClosing:true  [foreignA]
+12794ms  tabs.onRemoved  foreign  isWindowClosing:true  [foreignA]
+12794ms  windows.onRemoved  foreignA  collected tabs: foreign, foreign
+12802ms  storage.local.get resolved  foreignA  +8ms
+12805ms  storage.local.set resolved  foreignA  +11ms
+12847ms  windows.getAll resolved  foreignA  1 window(s) left
+12869ms  tabs.onRemoved  s1  isWindowClosing:true  [scene]
+12869ms  tabs.onRemoved  s2  isWindowClosing:true  [scene]
+12869ms  tabs.onRemoved  sh1  isWindowClosing:true  [scene]
+12870ms  windows.onRemoved  scene  collected tabs: s1, s2, sh1
+12870ms  storage.local.get resolved  scene  +0ms
+12871ms  storage.local.set resolved  scene  +1ms
```

`storage.local` after the restart:
`[{"window":"foreignA","tabs":["foreign","foreign"]},{"window":"scene","tabs":["s1","s2","sh1"]}]`.

## 9. A reload of the addon closes its pages before the background goes: the page unloads with the background object alive, a message it sends then reaches nobody, and nothing comes back to it — R41.01, R41.02, R41.03

§9 comes from `round-41`, run in November 2026, a temporary load of the harness. A page of the
addon (`unload.html`) is open, active, in a window next to a real page; at its load it keeps the
object `runtime.getBackgroundPage()` resolved with and opens a port to the background. At its
`pagehide` and at its `unload` it records what every call gives: `Object.prototype.toString.call`
on the object (the check `Utils.isDeadObject` of STG makes), `runtime.id`, `runtime.sendMessage`,
`port.postMessage`, and a `Promise.reject` against the `unhandledrejection` event, which a rejection
at the load of the page does fire. The background that reloads records its own `pagehide` and
`unload`, every message and port event and every close event; the background that starts records
the moment of its first line and what reaches it. All three write into the `localStorage` of the
addon, and the test merges the records after the reload. The control is the same page closed by
`tabs.remove` while the background lives (R41.01); the reload is `browser.runtime.reload()` from
the background, the call `Utils.safeReloadAddon` makes (R41.02), and the Reload button of
about:debugging, the path of an update and of the developer (R41.03).

- **The page goes first.** After `browser.runtime.reload()` the page's `pagehide` and `unload` come
  9 ms after the call, the `pagehide` and `unload` of the old background 10 ms after it; after the
  Reload button all four come in one ms, the page's `pagehide` first. The first line of the new
  background runs ~30 ms after the `unload` of the old one, its `runtime.onInstalled
  {reason: "update", temporary: true}` 3 ms after that (§1, `83qf`).
- **The background object is alive at the page's unload**, at `pagehide` and at `unload`, in a
  reload and with a live background alike: `[object Window]`, never a dead object. `runtime.id`
  answers too.
- **A message sent at the unload reaches nobody in a reload.** `runtime.sendMessage` and
  `port.postMessage` return as they always do, at `pagehide` and at `unload` alike, and nothing
  throws; the old background, 1 ms from its own `unload`, gets none of the four messages, and the
  new background gets none either. With the background alive (R41.01) all four arrive 4 ms after
  the page's `unload`, in the order they were sent. In no case does the promise of `sendMessage`
  settle while the page lives.
- **Nothing comes back to the page.** `port.onDisconnect` never reaches the page, with a live
  background or in a reload: the page is gone before its port is. The live background gets the
  disconnect 6 ms after the page's `unload` (R41.01); in a reload neither `port.onDisconnect` nor
  `tabs.onRemoved` of the page reaches the old background.
- **A rejection made at `pagehide` or `unload` fires no `unhandledrejection`** in the page, in
  every case; the control rejection at the load fired it.
- **The reload closes the page.** At the first line of the new background its tab is gone
  (`tabs.query`: 0 tabs at the first line, 500 ms and 2500 ms later; `extension.getViews` lists no
  tab), the window with the real page stays.
- **`localStorage` written at the unload survives the reload**, and the addon keeps its origin.

So at the unload of the debug page of STG (`stg-debug.js`) the background object is never dead:
`setDebug(null)` lands in `localStorage`, and `safe-reload-addon` sent while the addon reloads is
lost without an error, with no rejection the page could see.

The recorded logs; times count from the call under test, `=` marks lines of different sources in
one ms, whose order is not measured:

R41.01, `tabs.remove(page)` with the background alive:

```text
    6ms  page                  pagehide  backgroundPage: gives "[object Window]"; runtime.id: gives "stg-behavior-tests@drive4ik"; runtime.sendMessage: gives "returned a promise"; port.postMessage: ok; Promise.reject: gives "made"
    6ms  page                  unload  backgroundPage: gives "[object Window]"; runtime.id: gives "stg-behavior-tests@drive4ik"; runtime.sendMessage: gives "returned a promise"; port.postMessage: ok; Promise.reject: gives "made"
    7ms  old background        tabs.onRemoved  page  isWindowClosing:false  [scene]
   10ms  old background        runtime.onMessage  pagehide: sendMessage  from page
   10ms  old background        port.onMessage  pagehide: postMessage  from page
   10ms  old background        runtime.onMessage  unload: sendMessage  from page
   10ms  old background        port.onMessage  unload: postMessage  from page
   12ms  old background        port.onDisconnect  reload: page, port.error: null
```

R41.02, `browser.runtime.reload()` from the background:

```text
    9ms  page                  pagehide  backgroundPage: gives "[object Window]"; runtime.id: gives "stg-behavior-tests@drive4ik"; runtime.sendMessage: gives "returned a promise"; port.postMessage: ok; Promise.reject: gives "made"
    9ms  page                  unload  backgroundPage: gives "[object Window]"; runtime.id: gives "stg-behavior-tests@drive4ik"; runtime.sendMessage: gives "returned a promise"; port.postMessage: ok; Promise.reject: gives "made"
   10ms  old background        pagehide
   10ms  old background        unload
   39ms  new background        the first line
   40ms  new background        extension.getViews at the first line  0 view(s) of type tab
   42ms  new background        tabs.query at the first line  /unload.html: 0 tab(s)
   42ms  new background        runtime.onInstalled  {"reason":"update","previousVersion":"1.0","temporary":true}
  545ms  new background        tabs.query 500 ms later  /unload.html: 0 tab(s)
 2546ms  new background        tabs.query 2500 ms later  /unload.html: 0 tab(s)
```

R41.03, the Reload button of about:debugging, times from the first record after the test was
suspended:

```text
    0ms  page                  pagehide  backgroundPage: gives "[object Window]"; runtime.id: gives "stg-behavior-tests@drive4ik"; runtime.sendMessage: gives "returned a promise"; port.postMessage: ok; Promise.reject: gives "made"
    0ms  page                  = unload  backgroundPage: gives "[object Window]"; runtime.id: gives "stg-behavior-tests@drive4ik"; runtime.sendMessage: gives "returned a promise"; port.postMessage: ok; Promise.reject: gives "made"
    0ms  old background        = pagehide
    0ms  old background        unload
   29ms  new background        the first line
   30ms  new background        extension.getViews at the first line  0 view(s) of type tab
   32ms  new background        tabs.query at the first line  /unload.html: 0 tab(s)
   32ms  new background        runtime.onInstalled  {"reason":"update","previousVersion":"1.0","temporary":true}
  535ms  new background        tabs.query 500 ms later  /unload.html: 0 tab(s)
 2537ms  new background        tabs.query 2500 ms later  /unload.html: 0 tab(s)
```
