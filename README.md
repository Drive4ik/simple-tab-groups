<h2><a href="https://addons.mozilla.org/firefox/addon/simple-tab-groups/" target="_blank" rel="noopener noreferrer"><img width="48" src="https://rawgit.com/Drive4ik/simple-tab-groups/master/addon/src/icons/icon.svg" alt="Simple Tab Groups"></a> Simple Tab Groups</h2>

[![Mozilla Add-on](https://img.shields.io/amo/v/simple-tab-groups.svg)](https://addons.mozilla.org/firefox/addon/simple-tab-groups/) [![](https://img.shields.io/amo/d/simple-tab-groups.svg)](https://addons.mozilla.org/firefox/addon/simple-tab-groups/statistics/?last=365) [![](https://img.shields.io/amo/users/simple-tab-groups.svg)](https://addons.mozilla.org/firefox/addon/simple-tab-groups/statistics/usage/?last=365) [![](https://img.shields.io/amo/rating/simple-tab-groups.svg)](https://addons.mozilla.org/firefox/addon/simple-tab-groups/reviews/)

[![https://addons.mozilla.org/firefox/addon/simple-tab-groups/](https://addons.cdn.mozilla.net/static/img/addons-buttons/AMO-button_2.png)](https://addons.mozilla.org/firefox/addon/simple-tab-groups/)

## Translations

Please, help me [translate this addon](https://drive4ik.github.io/simple-tab-groups/translate/index.html) into your language!

## Usage

```bash
$ cd addon
$ npm install
$ npm run build
```

### `npm run build`

Build the extension into `addon/dist` folder for **development**.

### `npm run build-prod`

Build the extension into `addon/dist` folder for **production**.

### `npm run watch`

Watch for modifications then run `npm run build`.

### `npm run watch-prod`

Watch for modifications then run `npm run build-prod`.

### `npm run build-zip`

Build a zip file following this format `<name>-v<version>-(dev|prod).zip`, by reading `name` and `version` from `manifest.json` file.
Zip file is located in `dist-zip` folder.


## Description

Simple Tab Groups works across browser instances/windows too. If you select a group in another window, the selected window will jump to the foreground with the chosen group selected. You can even select the specific tab within that group in background browser windows. [GIF example](https://user-images.githubusercontent.com/7843031/33828871-806ccf6e-de76-11e7-9a0e-1ddfb97e878d.gif)

This allows for easy switching between active and pre-loaded tabs across multiple browser windows.

### This extension has these plugins:

 * [Create new group](https://addons.mozilla.org/firefox/addon/stg-plugin-create-new-group/)
 * [Create new tab](https://addons.mozilla.org/firefox/addon/stg-plugin-create-new-tab/)
 * [Create new tab in temporary container](https://addons.mozilla.org/firefox/addon/stg-plugin-create-temp-tab/)
 * [Delete current group](https://addons.mozilla.org/firefox/addon/stg-plugin-del-current-group/)
 * [Group notes](https://addons.mozilla.org/firefox/addon/stg-plugin-group-notes/)
 * [Load custom group](https://addons.mozilla.org/firefox/addon/stg-plugin-load-custom-group/)
 * [Open Manage groups](https://addons.mozilla.org/firefox/addon/stg-plugin-manage-groups/)

Allow support message actions from Gesturify addon.
Allow import groups from addons "Panorama View" and "Sync Tab Groups".

### Work with Gesturefy addon
[How to configure the work with the plugin Gesturefy](https://user-images.githubusercontent.com/7843031/44263498-dffb1b00-a227-11e8-95c7-1b9474199ef0.png)

You have to copy and paste into Gesturefy addon

`Add-on ID` : `simple-tab-groups@drive4ik`

`Parse message` -> `On`

Supported actions:
* `{"action": "add-new-group"}`
* `{"action": "rename-group"}`
* `{"action": "load-next-group"}`
* `{"action": "load-prev-group"}`
* `{"action": "load-next-unloaded-group"}`
* `{"action": "load-prev-unloaded-group"}`
* `{"action": "load-next-non-empty-group"}`
* `{"action": "load-prev-non-empty-group"}`
* `{"action": "load-history-next-group"}`
* `{"action": "load-history-prev-group"}`
* `{"action": "load-first-group"}`
* `{"action": "load-last-group"}`
* `{"action": "load-custom-group"}`
* `{"action": "delete-current-group"}`
* `{"action": "open-manage-groups"}`
* `{"action": "move-selected-tabs-to-custom-group"}`
* `{"action": "discard-group"}`
* `{"action": "discard-other-groups"}`
* `{"action": "reload-all-tabs-in-current-group"}`
* `{"action": "create-temp-tab"}`
* `{"action": "create-backup"}`


This extension may conflict with other programs similar in functionality.
Conflicted addons:
 * Tab Open/Close Control
 * OneTab
 * Tiled Tab Groups
 * Totally not Panorama (Tab Groups with tab hiding)
 * Panorama Tab Groups
 * Panorama View (etc.)

Open popup shortcut: `F8`. [You can change this hotkey](https://support.mozilla.org/kb/manage-extension-shortcuts-firefox)

Current list of functionality / development notes:

 * Design like old add-on "Tab Groups"
 * Added colored group icon
 * Added the ability to import the backup groups of the old plug-in "Tab Groups"
 * Added support of "Firefox Multi-Account Containers"
 * Now fully supports multiple windows
 * Saves last active tab after change group
 * Show currently used group in addon icon (see screenshot)
 * Specially NOT supported Private (Incognito) Mode
 * Added close tab by middle mouse click
 * Added simple switching between groups and tabs in search mode using the up, down, right and left keys
 * "Manage groups" functional is here! (so far only "Grid")
 * Added support Drag&Drop for tabs and groups in popup window
 * Added support sorting groups (context menu in popup window)
 * Added field for search/filter tabs in "Manage Groups"
 * Added support to Backup/Restore tabs, groups and settings to/from json file
 * Custom group icons, set group icon from tab icon (by context menu)
 * Added undo remove group by context menu browser button (see in screenshots)
 * Added support for catch tabs by containers (#76)
 * Added dark theme
 * Added support SideBar


Permissions used:
 * **tabs**: for tab handling
 * **tabHide**: for hide tabs
 * **contextualIdentities & cookies**: for work with Firefox Multi-Account Containers
 * **notifications**: for notification on move tab to group etc.
 * **menus**: for creating tabs context menus
 * **sessions**: for save session data (last used group, etc)
 * **downloads**: for create auto backups
 * **management**: for automatically detect the required addons
 * **storage**: for saving groups localy
 * **unlimitedStorage**: restore tabs after close window, there can be a lot of tabs
 * **<all_urls>(Access your data for all websites)**: for tab thumbnails and catch/move/reopen tabs in needed containers/groups
 * **webRequest** & **webRequestBlocking**: for catch/move/reopen tabs in needed containers/groups</li>
 * **(optional) bookmarks**: access for create bookmarks

## License and Credits

This project is licensed under the terms of the [Mozilla Public License 2.0](LICENSE).
