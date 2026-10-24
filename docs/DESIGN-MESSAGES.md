# Messages — whom the background trusts

Who may ask the background to run a module by name, what the content script is allowed to send,
and how a change of the debug flag reaches everyone. The code is `addon/src/background.js`
(`isStgSender`), `addon/src/js/messages.js`, `addon/src/web/content-script.js` and
`addon/src/js/logger.js` (the debug flag); the browser fact is `BEHAVIOR-CREATE-TABS.md` §56.

## 1. The own sender

The own sender is `isStgSender` in `background.js`: the background itself, or a message with our
`sender.id`. That covers a page of the add-on and the content script (`web/content-script.js`):
its `id` is ours too (§56). Only for the own sender does the background run a module by name
(`INTERNAL_MODULES`, `Messages.sendMessageModule`). Another extension gets none of that, and
when a group is removed at its request the user gets a notification.

## 2. The content script runs inside foreign pages

- It sends to the background only what it got from the background or from `storage`, and only an
  `action` and a `groupId`: a hotkey from its own list and the action of the groups popup.
  Nothing from the page — neither a `window` `message` nor data from the DOM — goes into a
  message to the background: any frame of the page can `postMessage` the window.
- It takes a key press and a click from the user only (`event.isTrusted`): an event made by a
  script of the page starts no hotkey and picks no group in the popup.

## 3. The debug flag

`enableDebug` in the `localStorage` of the add-on (`mainStorage` of `logger.js`) holds one of the
two modes of `Constants.DEBUG`. Both turn on the console output, the debug prefixes of the titles
(`Groups.getTitle`, `Tabs.getTitle`) and the badge of the pages (`enableDebug` of
`tab-groups.mixin.js`); they differ in who sets the flag and in what ends it.

- `manual` — the button of the debug page. It survives a restart of the add-on and of the browser
  and ends only by the other button of the page, which then offers the log file
  (`saveConsoleLogs`: the last 5000 log lines and the saved errors) and clears both once the file
  is saved.
- `auto` — `errorEventHandler`, on every uncaught error, over a `manual` too, together with a
  notification that opens the debug page. This is a decision: a user who does not understand the
  error reloads the add-on or the browser, and the error goes away — the start of the background
  drops an `auto` flag — while its record stays in the saved errors (`storage.errors` of
  `logger.js`, the last 50, in `localStorage`), so the file the user sends when the errors get too
  many holds every one of them. The debug page closed without the button while the flag is `auto`,
  or opened while it was (`wasAutoDebug`), drops the flag and reloads the add-on: the badge and
  the prefixes go away by themselves, nothing asks the user.

The flag has one writer, `setDebug` of `logger.js`. A change goes out on the broadcast channel
`debug` (`onDebugChanged`), to the writer's own document too. The titles of the group items in the
menus and of the button of every window carry the debug prefix, so the background rebuilds the
items (`MenusMain.groupsUpdated`) and redraws the buttons (`Browser.actionAllGroups`); a page of
the groups updates its `enableDebug`, and its titles are drawn anew with it.
