# Copilot Instructions for STGHost

## Project overview
- Delphi VCL app `STGHost` that acts as a native messaging host for Firefox extensions **Simple Tab Groups** and **Group Notes**.
- Dual entry modes:
  - GUI: standard VCL forms app (`MainForm`, `AboutForm`).
  - Native messaging: stdin/stdout pipe mode when started with piped stdin; processes JSON commands.
- Build output and runtime assets live beside the exe (settings.ini, manifest.json, logs.log, backup files).

## Key modules
- `STGHost.dpr`: entry point; detects GUI vs native messaging, validates extension, dispatches `HandleNativeMessaging`, registers manifest in HKCU when GUI.
- `Settings.pas`: manages INI/registry persistence for backup folders, delete/keep/day retention, logging flag; fills `AllowedExtensionsMap` and `ExeInfo` on unit init.
- `Pipe.pas`: native messaging router; handlers for `get-version`, `update`, `save-backup`, `get-last-backup`, `get-backup-folder`, `open-backup-folder`, `select-backup-folder`; enforces `MAX_MSG_SIZE`, backup path constraints, `id` enforcement, retention pruning, and response shaping with `version`/`ok`.
- `Main.pas`: GUI form that wires settings UI, generates `manifest.json`, registers native host, and toggles logging/UI state safely (guards `.Focused`).
- `Utils.pas`: helpers: JSON merging, ini helpers, env expansion, theme detection, shell helpers, icon/text combining, EXE metadata.
- `About.pas`: displays build/author info using `VerInfo.pas`, links, `GithubUpdater.pas` release checks.
- `Logger.pas`: `logs.log` writer that rotates to keep the last ~100 KB when logging is enabled.
- `GithubUpdater.pas`: release-check helper used by About UI; not involved in native messaging.
- `VerInfo.pas`: resource-backed version info shared between About dialog and manifest metadata.

## Data & file layout
- Backups are `.json` including an `id` field and are saved inside extension-specific folders configured via the UI.
- `manifest.json` is generated next to the exe and registered under `HKCU\\Software\\Mozilla\\NativeMessagingHosts`.
- Logging goes to `logs.log` beside the exe and is truncated by `Logger.pas` after ~100 KB.
- Settings prefer `settings.ini` in exe dir; fall back to `HKCU\\Software\\STGHost` when absent.

## Build & run
- Embarcadero Delphi 13.0 Florence project; `STGHost.dproj` is the main project file.
- Binary output is expected under `Win32\\Debug` for local testing.
- VS Code exposes `.vscode/CompileOmniPascalServerProject.bat build` and `.vscode/CompileOmniPascalServerProject.bat test` as tasks `build`/`test`.

## Conventions & gotchas
- Native messaging expects 4-byte length-prefixed UTF-8 JSON up to `MAX_MSG_SIZE` (100 MB).
- All protocol responses share `ok`; use `CreateResponse*` helpers so `Log` can capture diagnostics when logging is enabled.
- Backups must remain inside the configured folder with `.json` extension; pruning respects `KeepBackupFiles` (min 1) and `DeleteBackupsAfterDays`.
- GUI controls guard `Focused` to avoid writing settings while programmatically syncing values.

## How to extend
- To add a new native-messaging action: implement handler in `Pipe.pas`, register in `Handlers` dictionary in `HandleNativeMessaging`, return via `CreateResponse*` helpers, and update client extension accordingly.
- To support another extension: add `TExtension` constant in `Settings.pas`, register in `InitAllowedExtensionsMap`, adjust UI as needed, and ensure manifest generation includes it.

## Testing tips
- To simulate native messaging, pipe length-prefixed UTF-8 JSON to stdin; check `logs.log` for traces.
- For GUI settings, run Win32 Debug build from `Win32\Debug\STGHost.exe` so it uses local `settings.ini` and writes `manifest.json`/registry entry.
- Use the VS Code `build` task before pushing to ensure resources compile cleanly.

## Key files
- `STGHost.dpr`, `Pipe.pas`, `Settings.pas`, `Main.pas`, `Utils.pas`, `About.pas`, `Logger.pas`, `GithubUpdater.pas`, `VerInfo.pas`.
