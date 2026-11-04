# Listeners — `listeners.js`, the subscription is synchronous, the handler comes later

How the add-on subscribes to the browser events: the module `addon/src/js/listeners.js`,
universal and shared with the plugins (`CLAUDE.md`, "Modules shared with the plugins"). The module
lives outside this repository as well, so its code names no document of STG. Its promises are
checked by a test in Node, `addon/test/listeners.test.js` (`npm run test` in the root). What the
handlers of the events do is `DESIGN-EVENTS.md`.

## 1. The subscription

A module names the events it needs in the query of its import:
`import Listeners from './listeners.js?tabs.onCreated&windows.onCreated'`; a value is the array of
the extra arguments of `addListener` (`webRequest.onBeforeRequest=[filter, ["blocking"]]`), or an
object of prefs of this subscription with the arguments in `args`
(`tabs.onCreated={"keepAllPending":true}`). The value is read as a query string: `&`, `#` and `+`
inside it are written as `%26`, `%23` and `%2B`. The keys are described in one place,
`PREF_RULES`: the default of a key, what value is valid for it, whether the query may set it, what
it needs and what it excludes (`keepAllPending` needs `canKeepAllPending` in the scheme of the
event). A key the module does not know, a key the query may not set, a value that is not valid
for its key, keys that do not fit each other, and a name that is not an event of the browser (a
namespace, a function, a name that is not there) throw at load; every scheme of the module is
checked at load the same way, subscribed or not, and so are the rules themselves: a name a rule
needs or excludes must be a key of the rules.

An add-on adds schemes of its own, for events the module has none for and for own events: a
module evaluated before every instance of `listeners.js` puts a `Map` of name → scheme on
`self[Symbol.for('__listeners_custom_event_schemes__')]`, the first import of every entry that
needs them, the background and the pages alike: the modules are evaluated in the order of the
imports, and an instance imported after that module sees what it set, at every load
(`BEHAVIOR-LISTENERS.md` §15, §16). A scheme holds the keys of `PREF_RULES`; `event`
gives an own event its object with the methods of a browser event, as `extension.onStart` has.
The schemes are checked at load like the module's own, and a name the module already has throws:
what the query may set is set in the query, the rest is changed in the module. An instance
evaluated before that module does not see the schemes, and the module cannot tell: the order of
the imports is the add-on's to keep.
Every distinct
query is its own instance of the module, with its own real listeners, its own handlers and its
own kept events; the same query from two modules is one instance, they share the handlers and the
kept events, and the replay goes to whichever of them adds a handler first. The instance
registers the real browser listener of every named event
(`event.addListener`) while the module is evaluated — and `listeners.js` imports nothing and
awaits nothing, so that evaluation is one synchronous run at the very start of the module graph,
before the body of any module that imports it. Nothing can subscribe earlier: a top-level `await`
elsewhere in the graph does not delay it, and the browser may deliver an event the moment the
synchronous part ends — the listener is already there. This is the value of the module and what
wakes an event page under MV3; it holds only with a static `import`. A dynamic `import()` would
subscribe after the task that loaded it, and the module would be of no use.

## 2. The handlers and the events kept before them

The handlers come later, from the body of the importing module:
`Listeners.tabs.onCreated.add(handler)` returns the function that removes it; `remove`, `has`
and `clear` (which does not unsubscribe the real listener). While the instance has no handler,
before the first one and after the last one is removed or cleared alike, it keeps what comes:

- `waitListener` (the default): the last event, replayed once to the first handler added; a
  handler added with `{waitListener: false}` takes nothing and drops what was kept.
- `keepAllPending`: every event, replayed in order. By the scheme of `runtime.onConnect` — each
  one is the port of a page that loaded while the background was still loading its modules, and a
  port nobody handled is lost for good (`BEHAVIOR-CREATE-TABS.md` §63). By the subscription of
  `tabs.js` and `windows.js` for `tabs.onCreated` and `windows.onCreated` — a tab or a window the
  user opened while `init` was still at work after it had read them would otherwise reach the
  handler only when it was the last one. The query may set it for every event that is a fact of
  its own and not a state (`CAN_KEEP_ALL_PENDING_EVENTS`: the events of tabs, windows, tab groups,
  storage, bookmarks, downloads, history, cookies, navigation, the non-blocking requests, menus,
  commands, alarms, notifications, containers, permissions and management); a state, such as
  `tabs.onActivated` or `windows.onFocusChanged`, keeps the last one only.
- `calledOnce` (`runtime.onInstalled`, `onStartup`, `onUpdateAvailable`, `extension.onStart`,
  `extension.onWake`): every delivery is kept, with a handler in place or without one, and reaches
  every handler once (`calledOnceListeners`); a handler added later gets the latest delivery once
  — after a top-level `await` between two `add` calls, or at run time, as well. A handler added with `{waitListener: false}`
  after the delivery declines the event and is not called at a later `add`; the event stays kept
  for the others. No module of STG adds handlers that way: the
  `add` calls stand in the body of a module, one synchronous run. The module keeps the promise
  all the same, for any add-on that imports it (`CLAUDE.md`, "A universal module keeps its
  promise for any add-on").
- `returnPromise`: the browser takes an answer from the listener. The instance calls every
  handler, collects the outcome of each (`result`, `threw`, `error`, and `response` — the answer
  channel of its own when the scheme names the argument a handler answers through, `answerArg`:
  `sendResponse` of a message, `asyncCallback` of `asyncBlocking`), and the scheme makes one
  answer out of the outcomes, `combineAnswers`, by the rules of the browser for several real
  listeners (`BEHAVIOR-LISTENERS.md`): a message (`runtime.onMessage`, §3; the instance applies the
  same rules to `onMessageExternal` and `onUserScriptMessage`) — the first settled answer wins the race, a returned promise is an
  answer, `true` means the answer comes through `sendResponse`, a `sendResponse` called inside the
  handler is the answer, a throw is a refusal, anything else is no answer, and a returned promise
  is held back one turn so that it loses to a throw and to an immediate `sendResponse` as it does
  in the browser; a blocking request (`webRequest.onBeforeRequest`, `onBeforeSendHeaders`,
  `onHeadersReceived`, `onAuthRequired`, §5–§7) — the results in the order of adding, each awaited
  in its turn, the first `cancel` or `redirectUrl` decides, `upgradeToSecure` holds, the headers
  merge list by list against the original ones, the first `authCredentials` win, a throw, a
  rejection and a non-object are skipped, and a rejection is consumed, after the result that
  decided as well, since the browser shows nothing for it (§5); `onAuthRequired` with
  `asyncBlocking` (§8) — every
  handler gets a callback of its own, its return value is ignored, and the combined answer goes
  into the callback of the browser (`answerOnlyThroughArg`); a proxy (`proxy.onRequest`, §9, §13) —
  the results chain as the listeners of the browser do: a `ProxyInfo` or a list of them goes before
  the chain so far, which becomes its failover, a `{type: "direct"}` entry after a result keeps what
  is so far, `null` makes the connection direct, `undefined`, a throw and a rejection keep the chain
  so far, and the answer is the list of the chain. Without a handler a message waits up to
  `pendingPromiseTimeout` (8 s) for one and is then refused with "No listener …, please call back
  later", a newer message refuses the one waiting; the browser holds the promise of the waiting
  message, and the handlers it is replayed to answer through that promise by the same rules. A
  request and a proxy wait for nobody by their schemes: without a handler the answer is `{}`, for
  a proxy `undefined`; a subscription that sets `waitListener` in the query waits like a message,
  and the answer of the timeout and of `unsubscribe` goes back the way the browser takes it, into
  the `asyncBlocking` callback as well.

Every handler gets the arguments of the event as a listener of the browser gets them: a
structured clone of each one, the functions of the browser (`sendResponse`, `asyncCallback`) as
they are. What a handler changes in place the next handler does not see (§11, §12), and the
answers are combined against the arguments as the browser gave them. The schemes of the messages
and of the ports (`runtime.onMessage`, `onMessageExternal`, `onUserScriptMessage`, `onConnect`,
`onConnectExternal`, `onUserScriptConnect`) set `sharedArgs`: the handlers get the very objects,
as the listeners of a message do (§10), and a port cannot be cloned. The query sets it for an
event whose arguments cannot be cloned either, a page or an object with methods
(`devtools.panels.*.onShown`, `devtools.network.onRequestFinished`).

What the instance cannot copy from the browser: the merge of a CSP header between handlers, a
header name that appears twice, `proxy.onError` for a handler whose promise rejects, and the
proxy handlers are all called at once while the browser calls its listeners one after another.
What it does not copy on purpose: the `error` event of a message handler that throws carries the
thrown object itself, where the browser puts a copy of it (§4); and a message that comes after
the last handler was removed waits for a handler up to `pendingPromiseTimeout` like one before
the first, where the browser without a listener refuses the sender at once — the real listener
stays, a handler may come back.

A handler that throws is reported as an uncaught error of its page (`self.reportError`: the
`error` event of the window and the console line, what the browser does with a listener that
throws, `BEHAVIOR-LISTENERS.md` §2, §4), and the other handlers still run (§1). A rejected
promise a handler of an ordinary event returns stays an unhandled rejection of the page: the
browser hides the rejection of a real listener (§2), the instance does not, on purpose — the
logger of the add-on records it. A handler may remove itself or unsubscribe the event while it
runs, in a replay as well: the message it handles still gets its answer. A dispatch goes over a
snapshot of the handlers: a handler added by a handler during the dispatch is not called for that
event, one removed before its turn is not called; a replay takes the kept events out before it
starts, so an `add` from a replayed handler replays nothing again and the new handler gets the
events that are still to come.

`unsubscribe` removes the real listener, forgets the handlers and drops the kept events; an `add`
after it throws. A page of the add-on gets the instances of `tabs.js` and `windows.js` with its
imports and never handles their events: outside the background the two modules unsubscribe the
events of tabs and windows as they load.

## 3. `extension.onStart` and `extension.onWake`

They are not browser events: they come from the start time the background writes into
`storage.session` (`getExtensionStartTime`) once, when it finds none there. Every context that
names them asks the same question at its load: no time yet — `onStart`; a time already there —
`onWake`. In the background that is a fresh start of the add-on against a wake-up of the
background. In another page it tells whether the page loaded before the background wrote the time
or after: a popup opened after the start gets `onWake` at every open, a page that loaded while the
background was still starting gets `onStart`. Only the background writes; an add-on without a
background has `onStart` in every page at every load. The read is made by the first start event
subscribed on the page and shared by every other instance that names one; an instance that names
no start event never touches the storage. The write is part of that read: every instance sees the
time as it was before this start, and a handler runs after the write. The background is known by
the manifest: the page of `background.page`, the one the browser generates for
`background.scripts`, or the script of `background.service_worker`. The path is resolved against
the root of the extension the way the browser resolves the manifest: `bg.html`, `./bg.html` and
`/bg.html` name one page. Their event objects have the methods of a browser event
(`addListener`, `removeListener`, `hasListener`), so `unsubscribe` and the check of `add` work
for them the same way.
