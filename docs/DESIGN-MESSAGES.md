# Messages — whom the background trusts

Who may ask the background to run a module by name, and what the content script is allowed to
send. The code is `addon/src/background.js` (`isStgSender`), `addon/src/js/messages.js` and
`addon/src/web/content-script.js`; the browser fact is `BEHAVIOR-CREATE-TABS.md` §56.

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
