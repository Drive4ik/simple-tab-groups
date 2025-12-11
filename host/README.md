# Simple Tab Groups Host

![Simple Tab Groups Host icon](STGHost.ico)

Author: Vitalii Bavykin <drive4ik+stghost@protonmail.com>

Native Windows host for Firefox extensions Simple Tab Groups and Group Notes. Built with Delphi VCL, it runs as a GUI app or a native-messaging bridge over stdin/stdout to save and restore tab-group backups.

## Usage

- Run `STGHost.exe` normally to open the settings UI.
- Pick backup folders for Simple Tab Groups and Group Notes; the app writes backups as `.json` in those folders.
- Adjust retention (days / keep last files) if needed.
- If something goes wrong, enable logging in the UI, reproduce the issue, then send `logs.log` to the developer.

## Files

- `STGHost.exe` — main binary (latest builds: [releases](https://github.com/Drive4ik/simple-tab-groups/releases))
- `manifest.json` — Firefox native messaging manifest written beside the exe
- `settings.ini` or HKCU\Software\STGHost — configuration
- `logs.log` — optional diagnostics when logging is enabled
