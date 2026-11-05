# The logger — records, scopes, errors, the debug flag

What a line of the log is, how a scope opens and closes, what happens to an error, where the
records go and who turns the debug mode on. The code is `addon/src/js/logger.js` (the class, the
stores of the lines and of the errors, the debug flag), `addon/src/js/logger-utils.js` (the
arguments, the stacks, an error to an object and back), `addon/src/help/stg-debug.js` (the debug
page and its file) and `addon/debug-viewer/` (the viewer of that file). The port a page writes
through is `DESIGN-MESSAGES.md` §3; the browser facts about it are `BEHAVIOR-CREATE-TABS.md` §63.

## 1. A logger and its lines

A logger is `new Logger(prefix, {prefixes, enabled, debugOnly})`; its prefixes, joined with a dot,
head every line. A module names its logger by itself (`Constants.MODULES.*` or a string). A page
names its logger, `self.logger`, by `Constants.PAGES.current`: `Background` for the background;
the popup, the sidebar, the manager and the options by their `MODULES` names; a help page by the
name of its file. The mixins of the pages (`global.mixin.js`, `options.mixin.js`) take that name as
their first prefix. `create(prefix)` gives a logger with one more prefix and the same `enabled`
and `debugOnly`.

The levels are `log`, `info`, `warn`, `debug`, `assert(condition, …)` and `error`. A logger
created with `debugOnly: true` writes its `log` lines and the START and STOP of its scopes at the
`debug` level (the menu modules: `menus.js`, `menus-tab.js`, `menus-link.js`,
`menus-bookmark.js`).

A line passes one gate: `assert` is written when its condition is false; `error` and `warn`
always; `debug` only while a debug mode is set (§6); the rest when the logger is enabled
(`enable()`, `disable()`) or the mode is `manual`.

A record is `{level, prefix, args, scope, action, indentIndex, time, stack}`: the level of the
line, the prefixes joined with a dot, the arguments normalized (§4) with the condition of an
`assert` first, the number of the scope the line belongs to or `null`, `START` or `STOP` for the
line that opens or closes a scope and `null` for the rest (§2), the stack of the place that
wrote it, five frames (`STACK_FRAMES`).

## 2. Scopes

`using log = logger.start(name, …args)` opens a scope: a child logger with a number of its own.
The name is a string or a function, whose name is taken; the array form `start([level, name],
…args)` sets the level of the START line; an empty name keeps the prefix of the parent — a step
of a loop that is no function (`migrate`).

START goes through the gate at the level of the logger. STOP is written by the end of the block
(`Symbol.dispose` calls `stop()`), once, and only when START was written, past the gate: a mode
switched inside the scope does not lose it. A scope that outlives its block closes itself with
`stop(…args)` (`Operations.start`); STOP carries the arguments of `stop` at the level of the
logger.

The indent is one counter of depth per document: START takes the current depth and raises the
counter, STOP lowers it; the lines of a scope stand at its depth, the lines of a module logger at
the current one.

## 3. Errors

`error(…args)` returns an `Error`: the last one among the arguments, or a new one from their
text — `throw log.error('text')`, `throw log.error('step', e)`.

An `Error` object written as `warn` or `error` is marked (`writtenErrors`), the one `error()`
creates too. The first writer decides the level: an `error` line with an unmarked error, or with
no error object at all, goes into the saved errors; a `warn` or `error` line with a marked error
goes into the file only. A failed `assert` stands between `warn` and `error`: it is written in
any mode and the viewer paints it as an error, so a file the user sends shows it, but it stops
nothing and is never saved. Which level a place writes is the rule "Log levels" of `CLAUDE.md`.

The saved errors are `Errors`: the last 50 (`MAX_ERRORS`) in the `localStorage` of the add-on
under the `Logger` prefix. When the storage refuses by its quota, the oldest records give way one
by one; a record that does not fit alone goes to the console only. `Errors.get()` is a copy.

`catch(…args)` writes the error with `Catch error on:` and rethrows it; `catchSilent(…args)`
writes it with `[silent] Catch error on:` and returns `undefined`. `catchFunc(func)` wraps an
async function: its error, with the stack of the place of wrapping before `Native error stack:`,
goes to `handleError` next to the arguments of the call (`{args}`, an argument of the line of its
own, so the cap of §4 cuts them and not the error), and the wrapped call resolves with
`undefined`.

`handleError(event, …details)` takes an `error` event, an `unhandledrejection` event or the
error itself (`toError`, the event is prevented), sets the `auto` debug mode (§6), writes the
error and asks for the notification `show-error-notification`: in the background through
`onBackgroundMessage`, once the background is up; from a page through the port of the logger. It
is called by `errorEventHandler`, on `error` and `unhandledrejection` of every document, with
`self.logger` or a logger named by the page; by `Vue.config.errorHandler` of the popup, the
manager and the options; and by hand where a caught error must still reach the user:
`Groups.apply`, `init`, `catchFunc`.

`CloudError` and `HostError` write themselves in their constructors, a `CloudError` that is
`temporary` or `expected` as `warn`: `throw log.error('step', new CloudError(…))` gives one
saved record (`DESIGN-CLOUD-UPLOAD.md` §7).

## 4. Arguments and stacks

`normalizeArgumentValue` (`logger-utils.js`) makes every argument fit a record. A string over
100 KB (`MAX_LENGTH`) becomes `VERY_BIG_STRING_LENGTH_<n>: <its first 100 characters>`; a function
becomes its name; an object or an array goes through one `JSON.stringify` with a replacer — an
`Error` becomes `{time, name, message, lang, fileName, lineNumber, columnNumber, cause, stack}`
with the stack as an array (`lang` is the key of the locale on a `CloudError` or a
`HostError`), nested strings are cut and functions named, cycles are
handled by `json.js` — and a JSON over 100 KB becomes `VERY_BIG_OBJECT_LENGTH_<n>: <the top-level
keys, or the count of items>`, nothing of the content. An `Error` is wrapped into a new one with
its JSON as the message, and a `FORCE STACK` mark when it had no stack, in three cases: its name
has no `error` (the `PageStack` breadcrumbs of a module call from a page); its file is the string
`undefined`, the mark of a refusal the browser answers from its parent process
(`BEHAVIOR-ERRORS.md` §1); its stack is empty (the same refusals, a `DOMException` after a
structured clone, §3). The new `Error` carries the stack of the place that wrote the line, which
the browser's one does not have.

What the browser hands over, measured in `BEHAVIOR-ERRORS.md`: a refusal from the parent process
(`tabs.get`, `windows.get`, `tabs.update` with an id that is gone) is an `Error` with the message
only, `fileName` `"undefined"`, `lineNumber` 0 and an empty stack (§1); a refusal of the schema is
thrown at the call, not rejected (§2), so a `.catch` chained on the call does not see it; a
`DOMException` is an error to `Error.isError` and names its file `filename` (§3); a structured
clone drops the own properties of an `Error` (`lang`) and a custom name (§4), which is
why an error crosses a port as the plain object of `nativeErrorToObject`, never as itself. Read
from the Firefox sources, not measured: the parent process re-creates the error as
`new Error(message, error.fileName)` with `fileName` of a `DOMException`, that is `undefined`, and
the engine turns an explicit `undefined` into the string (`ExtensionCommon.sys.mjs`,
`ErrorObject.cpp`); a refusal the browser cannot read gets the message
`An unexpected error occurred`; the frames of the caller would come as async frames, which the
engine records only while the devtools are open; a call made from a page that is unloading never
settles, neither resolves nor rejects; every rejection of `browser.*` is an `Error`, a plain
object or a string thrown inside the browser is turned into one.

An argument that holds an object of a page that was closed makes the line throw: `Error.isError`,
which the replacer asks for every value, throws on a dead object (§5). Taken as given: the add-on
logs no objects of other pages, the pages send plain data through their ports.

`getStack` turns a stack into an array of frames `name@file:line:column`, up to 50 for an error
object and five for the place a line was written (§1): the uuid base
of the add-on and the `async*` marks are cut; the frames of the Vue runtime, `listeners.js`,
`logger.js`, `logger-utils.js` and `json.js` are dropped, and so are the messaging helpers
(`sendMessage…`, `sendExternalMessage`, `getArgumentsModuleCall`), except their namesakes in
`host.js` and `tabs.js` (`KEEP_STACK_LINE_INCLUDES`). The console shows the first two frames of a
record.

`nativeErrorToObject` and `objectToNativeError` carry an error through a message and back (the
reply of a port, `syncResult`), `cause` included; a `Response` in `cause` is reduced to its status
fields, the headers only under the `manual` mode. A value that is not an error, a thrown string or
`null`, is made an `Error` first (`toError`). The file is `fileName`, or `filename` of a
`DOMException`, and is left out when there is none: the string `undefined` in it is the browser's
mark alone.

## 5. Where the records go

The background keeps the lines in memory, `Logs`: the last 10000 (`MAX_LOGS`), cut back once the
list grows `LOGS_TRIM_STEP` past that. A page sends every record as `save-log` through the port
of the logger without waiting for a reply (`DESIGN-MESSAGES.md` §3); the background stores and
prints it. The lines a page writes before the background has attached its listener to the port
are lost (`BEHAVIOR-CREATE-TABS.md` §63).

`showLog` prints a record to the console only while debugging: a debug mode set, or a temporary
install. The line is the indent, the prefix, ▷ or ◁ for a START or a STOP by `action`, the
arguments and the first two frames of the stack; an `assert` goes to `console.assert` with its
condition before all of it.

The debug page takes `self.loggerFuncs = {Logs, Errors}` of the background. The file it saves
(`saveConsoleLogs`) holds the add-on and the browser (version, up time, permissions, storage,
platform, extensions), the windows and the tabs, `logs` (`Logs.get()`) and `errorLogs`
(`Errors.get()`), anonymized unless the install is temporary (`normalizeAndClear`: titles,
icons, thumbnails, file names and catch rules are replaced by a word, http and file addresses by
`URL_n` and `FILE_n`, the own uuid is cut); once the file is saved, both stores are cleared.
`addon/debug-viewer/` shows the file and knows every shape of a record above; the logs of a
version before 6, where the level and the arguments were one key `console.<level>` with the
prefix as the first argument and the scope a mark among them, are brought to that shape as they
are read.

## 6. The debug flag

`debugMode` in the `localStorage` of the add-on (`mainStorage` of `logger.js`) holds one of the
two modes of `Constants.DEBUG`. Both turn on the console output, the debug prefixes of the titles
(`Groups.getTitle`, `Tabs.getTitle`) and the badge of the pages (`debugMode` of
`tab-groups.mixin.js`); they differ in who sets the flag and in what ends it.

- `manual` — the button of the debug page. It survives a restart of the add-on and of the browser
  and ends only by the other button of the page, which then offers the log file (§5) and clears
  the stores once the file is saved. It is also the one mode in which a logger created turned off
  (`enabled: false`) writes its ordinary lines; its errors, warnings and failed asserts are
  written in any mode. The `debug` level of every logger is written only while the flag is set,
  in either mode.
- `auto` — `handleError` (§3), on every error it gets, over a `manual` too, together with a
  notification that opens the debug page. This is a decision: a user who does not understand the
  error reloads the add-on or the browser, and the error goes away — the start of the background
  drops an `auto` flag — while its record stays in the saved errors, so the file the user sends
  when the errors get too many holds every one of them. The debug page closed without the button
  while the flag is `auto`, or opened while it was (`wasAutoDebug`), drops the flag and reloads
  the add-on: the badge and the prefixes go away by themselves, nothing asks the user.

The flag has one writer, `setDebug` of `logger.js`. A change goes out on the broadcast channel
`debug` (`onDebugChanged`), to the writer's own document too. `logger.js` gates every record by
the flag and by `IS_TEMPORARY` of the background and keeps both in memory (`debugMode`,
`isTemporaryInstall`): the storage is read once, when the module loads; the channel brings a
change of the flag to every document; `IS_TEMPORARY` is written by the background through
`setTemporaryInstall` — `false` at its start, `true` at `runtime.onInstalled` with `temporary` —
and a page keeps it as it was at its load. The titles of the group items in the menus and of the
button of every window carry the debug prefix, so the background rebuilds the items
(`MenusMain.groupsUpdated`) and redraws the buttons (`Browser.actionAllGroups`); a page of the
groups updates its `debugMode`, and its titles are drawn anew with it.
