# Messages — whom the background trusts

Who may ask the background to run a module by name, what the content script is allowed to send,
and how a page talks to the background through its port. The code is `addon/src/background.js`
(`isStgSender`), `addon/src/js/messages.js` and `addon/src/web/content-script.js`; the browser
facts are `BEHAVIOR-CREATE-TABS.md` §56 and §63.

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

## 3. The port of a page

A page of the add-on talks to the background through a port, `Messages.connectToBackground`,
opened by the module that needs it (`logger.js`, `global.mixin.js`, `stg-debug.js`,
`wait-background.js`). `sendMessage` and `sendMessageModule` wait for the reply: the message
carries a `postId`, and the background answers it with the result or the error
(`createListenerOnConnectedBackground`), two minutes at most. `postMessage` waits for nothing:
the message carries no `postId`, the background sends nothing back, and an error of such a
message goes into the log of the background only. The log lines of a page (`save-log`) and the
error notification (`show-error-notification`) go that way. A port opened while the background
is still loading its modules waits in `listeners.js` and is handed to the handler once it is added
(`DESIGN-LISTENERS.md` §2); what the page posted into it before that is lost, and a port whose page
left before that never reports its disconnect — a `postMessage` into it throws
(`BEHAVIOR-CREATE-TABS.md` §63), so `sendMessageFromBackground` takes the throw as the disconnect
and forgets the port.
