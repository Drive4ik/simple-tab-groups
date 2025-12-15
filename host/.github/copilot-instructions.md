# Copilot Instructions for STGHost

## Project overview
- Delphi VCL app `STGHost` that acts as a native messaging host for Firefox extensions **Simple Tab Groups** and **Group Notes**.
- Dual entry modes:
  - GUI: standard VCL forms app (`MainForm`, `AboutForm`).
  - Native messaging: stdin/stdout pipe mode when started with piped stdin; processes JSON commands.
- Build output and runtime assets live beside the exe (settings.ini, manifest.json, logs.log, backup files).

## Key modules
- `STGHost.dpr`: entry; detects pipe mode vs GUI, validates extension id, runs `HandleNativeMessaging`, registers manifest in HKCU for GUI mode.
- `Settings.pas`: settings storage (INI in exe dir or HKCU `Software\STGHost`), allowed extensions map (`STG`, `NOTES`), backup folder/delete/keep settings, logging flag, `ExeInfo` metadata; init in unit initialization.
- `Pipe.pas`: native-messaging protocol handlers. Supported actions: `save-backup`, `get-last-backup`, `get-backup-folder`, `open-backup-folder`, `select-backup-folder`. Validates size (100 MB), ensures backups stay under configured folder, adds `id` to saved JSON, prunes old backups (`DeleteBackupDays`, `KeepBackupFiles`). Responses include `version`, `ok`, and optional data/lang/message. Logging via `Log` from Main.
- `Main.pas`: VCL UI to configure backup folders, delete/keep retention, enable logs; writes settings through `Set*` helpers. Generates native-messaging `manifest.json` and writes HKCU registration on GUI start.
- `Utils.pas`: helpers: JSON read/write, env expansion, theme detection, shell open, EXE metadata, icon extraction, `MergeJSON` used by responses.
- `About.pas`: about dialog displaying exe metadata and links.

## Data & file layout
- Backup files are JSON with extension `.json`, stored under user-selected folders per extension; files must include `id` matching extension.
- `manifest.json` generated next to exe; registry entry under `HKCU\Software\Mozilla\NativeMessagingHosts` maps host name to manifest path.
- Logs go to `logs.log` beside exe when logging enabled; auto-truncates to ~100 KB by keeping latter half.
- Settings: `settings.ini` in exe dir if present, otherwise registry `HKCU\Software\STGHost`.

## Build & run
- Embarcadero Delphi 13.0 Florence was used to create the project.
- Main project file: `STGHost.dproj`; exe output expected under `Win32\Debug` for tests.

## Conventions & gotchas
- Native messaging mode triggers when stdin is a pipe; expect JSON framed with 4-byte length prefix. Respect `MAX_MSG_SIZE` 100 MB.
- All responses must include `version` and `ok`; prefer `CreateResponse*` helpers. Use `Log` for diagnostics (automatically truncated, requires logging flag set).
- When saving backups, enforce path under configured folder and extension `.json`; prune old backups respecting `KeepBackupFiles` (min 1) and `DeleteBackupsAfterDays` (>0 enables).
- Initialization: `Settings` unit initializes `AllowedExtensionsMap` and `SettingsIni` on unit load; `ExeInfo` populated there.
- UI events guard with `.Focused` checks to avoid spurious writes when programmatic updates occur.

## How to extend
- To add a new native-messaging action: implement handler in `Pipe.pas`, register in `Handlers` dictionary in `HandleNativeMessaging`, return via `CreateResponse*` helpers, and update client extension accordingly.
- To support another extension: add `TExtension` constant in `Settings.pas`, register in `InitAllowedExtensionsMap`, adjust UI as needed, and ensure manifest generation includes it.

## Testing tips
- To simulate native messaging, pipe length-prefixed UTF-8 JSON to stdin; check `logs.log` for traces.
- For GUI settings, run Win32 Debug build from `Win32\Debug\STGHost.exe` so it uses local `settings.ini` and writes `manifest.json`/registry entry.

## Key files
- `STGHost.dpr`, `Pipe.pas`, `Settings.pas`, `Main.pas`, `Utils.pas`, `About.pas`.
