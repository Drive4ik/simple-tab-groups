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

The background asks the user through the content script of the active tab of the window in
focus: `Tabs.prompt` — a text (`show-prompt`), answered in the reply, `null` when the user
cancelled or a dialog is already open; `Tabs.showGroupsPopup` — a choice of a group
(`show-groups-popup`), answered later by a new message with the action of the popup and the
`groupId`. A tab that cannot take the content script (`DESIGN-URLS.md` §5), or one that does not
answer — no content script in it yet — shows no dialog: the user gets the notification with the
link to the doc, unless `showNotification` is off, and the caller gets its text as `error`.
`Groups.addByUser` creates a group that way while `alwaysAskNewGroupName` is on, and answers
`{group}` or `{error}`: a cancelled dialog creates nothing, a tab that cannot ask gets the group
under the proposed name and the notification, without a normal window in focus nothing is
created; with the option off the group gets the default name, the proposal is not used. The
menus and the actions do nothing more on an `error`.

## 3. The port of a page

A page of the add-on talks to the background through a port, `Messages.connectToBackground`,
opened by the module that needs it (`logger.js`, `global.mixin.js`, `stg-debug.js`,
`wait-background.js`). `sendMessage` and `sendMessageModule` wait for the reply: the message
carries a `postId`, and the background answers it with the result or the error
(`createListenerOnConnectedBackground`), two minutes at most. `postMessage` waits for nothing:
the message carries no `postId`, the background sends nothing back, and an error of such a
message goes into the log of the background only. The log lines of a page (`save-log`) go that
way. A port opened while the background
is still loading its modules waits in `listeners.js` and is handed to the handler once it is added
(`DESIGN-LISTENERS.md` §2); what the page posted into it before that is lost, and a port whose page
left before that never reports its disconnect — a `postMessage` into it throws
(`BEHAVIOR-CREATE-TABS.md` §63), so `sendMessageFromBackground` takes the throw as the disconnect
and forgets the port.

The size of a message is not a limit for the add-on. Read from the Firefox sources, not measured: a
message of a port travels as a structured clone, a clone over 64 KB goes through shared memory and
not inside the IPC message (`ipc_message_utils.h`, `kMessageBufferShmemThreshold`), inline only
when the shared memory could not be made, and then a message of 256 MiB or more closes the
channel with an error (`ipc_channel.h`, `kMaximumMessageSize`); one clone over 4 GB is refused
(`SerializedStructuredCloneBuffer.cpp`). So the whole log of the background, up to 10000 records,
reaches the debug page by its port (`DESIGN-LOGGER.md` §5); the price is the copies on the way,
seen only as the time of saving the file.

## 4. External extensions

The plugins and the other extensions the add-on talks to are `Constants.EXTENSIONS_WHITE_LIST`,
two lists of actions per extension; the code is `addon/src/js/external.js`.

- `getActions` — what the extension may ask of the background. `onMessageExternal`
  (`background.js`) takes `ignore-ext-for-reopen-container` from any sender, refuses everything
  while the background is not inited, checks the rest by `External.isAllowedRequest` — the
  refusal carries the rules of the sender — and hands the request to `onBackgroundMessage`.
- `postActions` — what the background posts to the extension. `External.send(action, data)` goes
  to every enabled extension of the list whose `postActions` name the action; nothing goes out
  before the add-on is inited, the plugins take `i-am-back` as the start, sent by `init` right
  after the pages get theirs. The events of the `groups` channel go out that way as
  `group-added`, `group-updated` (only for a change of a key the extensions show,
  `EXTERNAL_GROUP_UPDATE_KEYS`), `group-removed`, `group-loaded` and `group-unloaded`, the group
  mapped by `Groups.mapForExternalExtension`; the subscription lives with the other events of the
  background (`addEvents` / `removeEvents`).
- `Messages.sendExternalMessage(id, message)` is the call of one extension with an answer, past
  the white list: the migration asks the notes plugin for its backup and gives it back.

## 5. The answer to an action

`onBackgroundMessage` answers an action — of an own page, of a command, of an external
extension — in one shape: `{ok: true}` with the data of the action next to it, or
`{ok: false, error}` with the text of the refusal. Never both, never neither: an error thrown
inside becomes `{ok: false, error}` with its text, and a module that refused with a bare `false`
(`Groups.apply`, `Groups.applyByHistory`, `Groups.unload`, `Bookmarks.removeGroup`: a warn, and a
notification where the module had something to tell the user) gets the text
`the action "…" was not done` after the switch. The plugins show `error` as a notification when
`ok` is false, so the string is what the user sees. A failed assert at the end marks a branch
that broke the shape. A module called by name (`INTERNAL_MODULES`, §1) answers differently: with
the value of the method, and its error rejects the promise of the sender.
