# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## About

STGHost is a Delphi VCL application for Windows. It bridges the Firefox extensions **Simple Tab Groups**
(`simple-tab-groups@drive4ik`) and **Group Notes** (`stg-plugin-group-notes@drive4ik`) to the file
system: it saves and returns backups in an arbitrary folder that the extension itself cannot pick.

Lives in the `host/` subfolder of the Simple Tab Groups repository. The root `../CLAUDE.md`
describes the extension itself and does not apply to this Pascal code.

---

## Working rules

- **Look documentation up, never recall it.** Use the Context7 MCP server and the internet for
  current docs and for what today's best solution actually is — for Delphi, the RTL sources under
  `$(BDS)\source` are the authority for the installed version. Memory of an API is not evidence.

---

## Build

```bat
_build.bat          :: rsvars + msbuild, Config=Release, Platform=Win32
_clear.bat          :: wipe .res/.dcu/.local/cache and other build leftovers
```

Manually:

```bat
call "rsvars.bat"
msbuild STGHost.dproj /t:Build /p:Config=Release /p:Platform=Win32
```

- Embarcadero Delphi 13 Florence (`Studio\37.0`), project file `STGHost.dproj`.
- Output: `Win32\STGHost.exe` (Debug and Release write to the same file), DCUs go to
  `cache\<Platform>\<Config>\`.
- No tests. The VS Code `Delphi: Build` task just runs `_build.bat`.
- After a **Release** build the `StripResources` target runs `strip-res.ps1`, which deletes unused
  VCL resources straight from the exe — TBitBtn glyphs, drag&drop cursors, message-dialog icons,
  `DVCLAL`, `PACKAGEINFO` — about 85 KB. The header of that script also lists what must stay and
  why (notably the `SPINUP`/`SPINDOWN` bitmaps that `TSpinEdit` needs); read it before touching
  `$StripRules`. Its own failures are swallowed and never break the build.

---

## Two launch modes

`STGHost.dpr` decides what to do based on the stdin handle type:

| stdin | mode |
| --- | --- |
| `FILE_TYPE_PIPE` | native messaging: `ReadStdIn` → `HandleNativeMessaging` → `WriteStdOut` → exit |
| otherwise | GUI: writes `manifest.json`, registers it in the registry, shows `MainForm` |

**Registration happens in GUI mode only.** So after moving the exe to another folder the user must
run it once by hand — otherwise Firefox still looks for the host at the old path.

The extension id arrives as the second argument (`ParamStr(2)`, that is how Firefox invokes the
host) and is checked against `AllowedExtensionsMap`. An unknown id raises, which turns into an
`ok: false` response.

---

## Native messaging protocol (`Pipe.pas`)

Firefox wire format: 4 length bytes (little-endian) + UTF-8 JSON.

- Request: `{"action": "...", ...}`. The router is the `Handlers` dictionary in
  `HandleNativeMessaging`.
- Every response carries `ok`. Build responses only through the `CreateResponse*` helpers:
  - `CreateResponseMessage` — ready-made text (errors and diagnostics);
  - `CreateResponseLang` — localization key `lang` plus `args`; the extension renders the text;
  - `CreateResponseJSON` — payload in `data`.
- `MAX_OUT_MSG_SIZE = 1 MB` is a hard cap on the outgoing message. Incoming messages have no size
  limit; only a zero length is rejected, because the read would otherwise index an empty buffer.

Actions: `get-version`, `update`, `save-backup`, `get-last-backup`, `get-backup-folder`,
`open-backup-folder`, `select-backup-folder`, `get-settings`, `set-settings`.

### Backups

- A backup is a `.json` file with an `id` field holding the extension id. It is **added** on
  `save-backup` and **removed** on `get-last-backup`. Files with a foreign or missing `id` are
  skipped — that is how two sets of backups can share one folder.
- `save-backup` resolves `filePath` against the backup folder and rejects anything that escapes it
  (`StartsWith`) or has the wrong extension. The `test: true` flag writes and immediately deletes an
  empty file — a folder reachability probe.
- Retention runs after every save: `DeleteBackupDays = 0` disables it entirely; otherwise files
  older than N days are deleted, but the `KeepBackupFiles` newest ones always survive. Empty
  subfolders are pruned.

### `get-last-backup` chunking

When a backup does not fit the cap, the response is split:

1. Overhead is measured by serializing an empty response containing every service field.
2. The JSON is base64-encoded and sliced into chunks of `MAX_OUT_MSG_SIZE - overhead`.
3. The extension asks for a `partIndex` and gets `encoding: ["base64","json"]`, `nextPartIndex`
   (absent on the last part) and `lastPartIndex`.

If it fits, the object is returned as-is, with no `encoding`.

---

## Settings (`Settings.pas`)

`settings.ini` next to the exe when that file exists; otherwise `HKCU\Software\STGHost`. The mere
existence of the file is what selects the storage — nothing records the choice.

The file is a `TMemIniFile` written as UTF-8; the registry is a `TRegistryIniFile`. Only the file
needs saving — the registry storage writes every value through as it is set, so `UpdateFile` is a
no-op there.

Who saves depends on how the process was started, which is what `Utils.IsPipeMode` is for:

- **GUI.** Every setter calls `SaveSettingsIfGUI`, so a change is on disk the moment it is made. The
  window can stay open for hours and whatever Firefox launches meanwhile must not read a stale file.
- **Host process.** `SaveSettingsIfGUI` does nothing; the handler that changed something calls
  `SaveSettings` once at the end (`select-backup-folder`, `set-settings`). One message, one write —
  and a process that only read settings writes nothing at all.

`finalization` saves nothing. Anything that changes settings is responsible for persisting them,
so shutting down cleanly is never load-bearing.

Do not reach for `TIniFile`: the WinAPI profile API behind it cannot write UTF-8 at all, and it
raised an access violation inside `WritePrivateProfileString` on the very first write here.

The **Portable** checkbox on the Settings tab moves the settings between the two storages. By the
time it is clicked the settings are already loaded, so `SetPortableMode` simply reads them through
the normal getters into `TExtensionSettings` records, swaps `SettingsIni`, and writes them back
through the normal setters. Consequences worth knowing:

- only keys the host actually knows are carried over, so leftovers from older versions (there used
  to be `DeleteBackupsAfterDays`, then `DeleteOldBackupDays`) are dropped on the way;
- `GetBackupFolder` is called with `PreparePath = false`, otherwise `%USERPROFILE%`-style folders
  would be persisted already expanded.

Do not go back to a generic section-by-section copy. `TRegIniFile.ReadSectionValues` renders values
through `GetDataAsString(..., PrefixType := True)`, so anything that is not `REG_SZ` comes out as
`dword:00000000` — and it drags dead keys along with it.

The section name is the extension id; keys are `BackupFolder`
(environment variables are expanded), `DeleteBackupDays` (default 30) and `KeepBackupFiles`
(default 10, minimum 1). `WriteLogs` lives in the root section.

`InitSettings` runs both in the unit's `initialization` and at the top of `HandleNativeMessaging` —
the process only lives for one message, but the GUI may have changed settings in between.

---

## Version info and manifest.json

The version, description, icon and application manifest all come from **`STGHost.rc`**, not from
`.dproj` — `Manifest_File` there is deliberately `(None)` and there are no `VerInfo_*` keys. Edit
the version or description in the `.rc` only.

`CreateManifest` builds `manifest.json` from the exe version info:

- `name` ← `InternalName` (`simple_tab_groups_host`) — this is **also the key name** under
  `HKCU\Software\Mozilla\NativeMessagingHosts`, so changing it breaks the link to the extension;
- `description` ← `FileDescription`;
- `allowed_extensions` ← every id in `AllowedExtensionsMap`.

---

## Updates (`GithubUpdater.pas`)

Releases are matched by tags shaped like `v<version>-host`. The asset is picked by matching its
name against `OriginalFilename` from the exe version info, and the sha256 in the `digest` field is
mandatory. Replacement is done by a background `cmd.exe` that waits for the process to disappear
from `tasklist` and then does a `move /Y`.

`GithubCheckLatestVersion` deliberately **skips major updates**: it only fires when
`CompareNumericVersions(...) >= 2`, i.e. for minor and below.

---

## Logging (`Logger.pas`)

`logs.log` next to the exe, written only while `WriteLogs = true`. Access is serialized through the
named mutex `STGHostLogMutex`, because a burst of extension messages makes Firefox launch a host
process per message and they all append to the same file. Past `MaxLogSize` the file is truncated
to its second half.

The timestamp is taken **after** the mutex is acquired, not when `Log` was called: the order of the
lines in the file is decided by who wins the mutex, so stamping earlier produced a file whose order
disagreed with its own timestamps. Note that `Now` resolves to about 15 ms, so a burst legitimately
yields repeated stamps — the file order is still right.

`Log` swallows its own failures. It is diagnostics: a missing folder or a locked file must never
take down the request being logged, and the first log line of a host process runs before anything
has been answered to Firefox.

To debug: enable logging in the GUI, reproduce the problem, read `logs.log`.

---

## Code notes

- **GUI handlers check `.Focused`** before persisting a setting — otherwise filling the controls
  programmatically in `FormCreate` would overwrite the stored settings. Do not remove those guards.
- `WriteJSONFile` writes LF line endings and no BOM (`TFile.WriteAllText` with no encoding
  argument).
- In Release the `.dpr` enables `WEAKLINKRTTI`, strips RTTI and sets PE flags — the binary is
  intentionally slimmed down.
- Style is modern Delphi: inline `var`/`const` inside routine bodies, `for var`, generics,
  `TJSONObject.GetValue<T>` with a default.

## Where new things go

- **New protocol action:** add a handler in `Pipe.pas` matching the `TActionHandler` signature,
  register it in the `Handlers` dictionary, respond through `CreateResponse*`.
- **New extension:** add a `TExtension` constant in `Settings.pas`, list it in the array inside
  `InitAllowedExtensionsMap`, and add a tab to `MainForm` if needed. `manifest.json` picks the id up
  automatically.
