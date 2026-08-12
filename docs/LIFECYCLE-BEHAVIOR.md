# Extension lifecycle behavior

`runtime.onInstalled`, `runtime.onUpdateAvailable` and what each storage survives across install,
update, enable/disable, browser restart and uninstall. The version system of the addon stands on
these facts: when the stored version marker can be missing, when `previousVersion` is available to
heal it, and which storage survives what.

Facts here are produced by a throwaway two-addon stand (§6), not by `test-addon/` — the addon under
test is killed by every install and update these facts are about, so it cannot host a harness.
Markers are `L<n>`; the format is registered in `BEHAVIOR-NOTATION.md` §4 and §7.

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
update). Wipes: `lyjx` (uninstall + reinstall — all three read back empty).

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
