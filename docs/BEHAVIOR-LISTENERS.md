# Reference: several listeners of one event in one context, and a listener that throws

Verified live on Firefox 160.0b4 (November 2026), Windows, with the throwaway test add-on
(`test-addon/`, `round-39`), in a clean profile with no other add-ons. Every fact here is one browser build on one
machine; a claim is as strong as the runs cited next to it, and no stronger.

The subject: an extension context (the background page) registers SEVERAL listeners of one event,
and what the browser does with their answers and their errors. These are the rules a layer that
calls several handlers from one real listener has to follow to stay indistinguishable from real
listeners (`DESIGN-LISTENERS.md`). The "window" below is the window of the background page: its
`error` and `unhandledrejection` events are what the logger of an add-on sees.

Only facts confirmed by an actual test run belong in "Verified facts" — never assumptions about how
the browser "probably" works. State tables, markers, confirmation rules and how the tests are
written — BEHAVIOR-NOTATION.md. There is no state table here: the event log carries the calls of
the listeners, what each returned, and what the request or the sender got.

**A new fact is appended as the next number at the end of "Verified facts". Numbers are never
renumbered or reused** — code comments reference them by number (`docs/BEHAVIOR-LISTENERS.md §1`).

---

## Verified facts

### 1. An ordinary event: every listener of the context runs on its own, in the order of adding; a listener that throws stops nothing (R39.01)

Four listeners of `tabs.onCreated`: L1 throws, L2 records, L3 calls `self.reportError` and goes on,
L4 returns a rejected promise. All four are called, in the order they were added, the throw of L1
included.

```text
    4ms  tabs.onCreated L1     throws
    4ms  window error          the error L1 threw, event.message: Error: L1 throws, event.error is the thrown object: true
    4ms  tabs.onCreated L2     called
    4ms  tabs.onCreated L3     calls self.reportError and goes on
    4ms  window error          the error L3 passed to self.reportError, event.message: Error: L3 reportError, event.error is the thrown object: true
    4ms  tabs.onCreated L4     returns a rejected promise
```

### 2. A listener that throws is an `error` event of the window with the thrown object itself, and an "Uncaught Error" line of the console; `self.reportError(e)` from a listener is the same event; a rejected promise returned by a listener is nothing — no `unhandledrejection` event, no line in the console (R39.01, the console of the run)

The events are in §1: for the throw of L1 and for the `reportError` of L3 the window gets an
`error` event whose `event.error` is the very object, `event.message` is `Error: <message>`. The
console of the run shows `Uncaught Error: L1 throws` and `Uncaught Error: L3 reportError` with the
location of the listener. For the rejected promise of L4 the window gets no `unhandledrejection`
event and the console shows nothing.

### 3. `runtime.onMessage`, several listeners of one context: every listener is called, after an answer too; the first settled answer wins — a `sendResponse` called inside the listener beats a promise, a throw beats a promise returned by an earlier listener, a promise resolved at once beats `true` with a late `sendResponse` and a promise settled later; a promise of `undefined` is an answer; a string, an object or `false` is no answer; a throw or a rejection alone is the error of the sender (R39.02)

A page of the add-on sends `runtime.sendMessage({ask})` for every case and reports what it got.
Three listeners in the background; a listener without an entry in the case returns `undefined`.

- `sync-vs-promise`: L1 calls `sendResponse("L1")` at once, L2 returns `Promise.resolve("L2")` —
  the sender gets `"L1"`.
- `promise-vs-throw`: L1 returns `Promise.resolve("L1")`, L2 throws — the sender gets the error
  `L2 throws`: the throw is settled at once, the promise one turn later.
- `true-vs-promise`: L1 returns `true` and calls `sendResponse("L1")` 500 ms later, L2 returns
  `Promise.resolve("L2")` — `"L2"`.
- `promise-order`: L1 returns a promise settled 500 ms later, L2 `Promise.resolve("L2")` — `"L2"`:
  the first settled wins, not the first added.
- `undefined-promise`: L1 returns `Promise.resolve(undefined)`, L2 a promise of `"L2"` 500 ms later
  — the sender gets `undefined` at once: a promise resolved with `undefined` is an answer.
- `no-answer`: a string, an object, `false` — the sender gets `undefined`, no error.
- `true-only`: `true` and `sendResponse("L1")` 500 ms later — `"L1"` at 545 ms.
- `throw-only` — the error `L1 throws`; `reject-only` — the error `L1 rejects`.

Every listener with something to do was called in every case, in the order of adding, after an
earlier listener had answered as well.

```text
   32ms  runtime.onMessage L1  sync-vs-promise: calls sendResponse("L1") at once, returns nothing
   33ms  runtime.onMessage L2  sync-vs-promise: returns Promise.resolve("L2")
   34ms  page reports          sync-vs-promise: answer "L1"
   36ms  runtime.onMessage L1  promise-vs-throw: returns Promise.resolve("L1")
   36ms  runtime.onMessage L2  promise-vs-throw: throws
   36ms  window error          an unknown error: L2 throws, event.message: Error: L2 throws, event.error is the thrown object: false
   39ms  page reports          promise-vs-throw: error "L2 throws"
   39ms  runtime.onMessage L1  true-vs-promise: returns true, calls sendResponse("L1") 500 ms later
   39ms  runtime.onMessage L2  true-vs-promise: returns Promise.resolve("L2")
   39ms  page reports          true-vs-promise: answer "L2"
   40ms  runtime.onMessage L1  promise-order: returns a promise of "L1" settled 500 ms later
   40ms  runtime.onMessage L2  promise-order: returns Promise.resolve("L2")
   40ms  page reports          promise-order: answer "L2"
   40ms  runtime.onMessage L1  undefined-promise: returns Promise.resolve(undefined)
   41ms  runtime.onMessage L2  undefined-promise: returns a promise of "L2" settled 500 ms later
   41ms  page reports          undefined-promise: answer undefined
   41ms  runtime.onMessage L1  no-answer: returns a string
   41ms  runtime.onMessage L2  no-answer: returns an object
   41ms  runtime.onMessage L3  no-answer: returns false
   42ms  page reports          no-answer: answer undefined
   42ms  runtime.onMessage L1  true-only: returns true, calls sendResponse("L1") 500 ms later
  545ms  page reports          true-only: answer "L1"
  547ms  runtime.onMessage L1  throw-only: throws
  547ms  window error          an unknown error: L1 throws, event.message: Error: L1 throws, event.error is the thrown object: false
  553ms  page reports          throw-only: error "L1 throws"
  554ms  runtime.onMessage L1  reject-only: returns Promise.reject
  556ms  page reports          reject-only: error "L1 rejects"
```

### 4. A `runtime.onMessage` listener that throws: an `error` event of the window whose `event.error` is a copy, not the thrown object, and an "Uncaught Error" line of the console; a rejected promise: nothing (R39.02, the console of the run)

In §3 the two throws (`promise-vs-throw`, `throw-only`) each gave one `error` event with
`event.error is the thrown object: false` — unlike an ordinary event (§2), the object in the event
is not the one the listener threw, its message is the same. The console shows `Uncaught Error:
L2 throws` and `Uncaught Error: L1 throws`. The rejection of `reject-only` gave no
`unhandledrejection` event and no console line.

### 5. Blocking `webRequest.onBeforeRequest`, two listeners of one extension: both are called; the results are taken in the order of adding and each is awaited in its turn — the first `redirectUrl` or `cancel` in that order decides, a `cancel` settled 500 ms later still beats a `redirectUrl` returned at once; a rejected promise and a throw are skipped and the next listener decides; the throw is an `error` event of the window and a console line, the rejection is nothing (R39.03)

Every case is a `tabs.update` of the scene tab to a url of the site with the case in its query; the
listeners act on that url only. The outcome is what `webRequest.onBeforeRedirect`, `onCompleted`
and `onErrorOccurred` report for the request.

- `redirect-then-cancel`: redirected, the redirected hop completed 200.
- `cancel-then-redirect`: canceled (`NS_ERROR_ABORT`).
- `reject-then-cancel`: canceled — the rejection of L1 is skipped. No `unhandledrejection`.
- `throw-then-redirect`: redirected — the throw of L1 is skipped; the window got an `error` event
  (`event.error` a copy) and the console `Uncaught Error: L1 throws`.
- `async-order`: L1 returns a promise of `{cancel: true}` settled 500 ms later, L2 returns
  `{redirectUrl}` at once — canceled, at 505 ms: the first in the order of adding decides, not the
  first settled.

```text
    3ms  onBeforeRequest L1           redirect-then-cancel: returns {redirectUrl}
    4ms  onBeforeRequest L2           redirect-then-cancel: returns {cancel: true}
    6ms  webRequest.onBeforeRequest   <site>/?stg-case=redirect-then-cancel  proxy: none, direct
    6ms  webRequest.onBeforeRedirect  <site>/?stg-case=redirect-then-cancel → <site>/?stg-redirected=run
    9ms  webRequest.onBeforeRequest   <site>/?stg-redirected=run  proxy: none, direct
  492ms  webRequest.onCompleted       <site>/?stg-redirected=run  status 200
    2ms  onBeforeRequest L1           cancel-then-redirect: returns {cancel: true}
    2ms  onBeforeRequest L2           cancel-then-redirect: returns {redirectUrl}
   11ms  webRequest.onBeforeRequest   <site>/?stg-case=cancel-then-redirect  proxy: none, direct
   11ms  webRequest.onErrorOccurred   <site>/?stg-case=cancel-then-redirect  NS_ERROR_ABORT
    9ms  onBeforeRequest L1           reject-then-cancel: returns Promise.reject
    9ms  onBeforeRequest L2           reject-then-cancel: returns {cancel: true}
    9ms  webRequest.onBeforeRequest   <site>/?stg-case=reject-then-cancel  proxy: none, direct
   10ms  webRequest.onErrorOccurred   <site>/?stg-case=reject-then-cancel  NS_ERROR_ABORT
    5ms  onBeforeRequest L1           throw-then-redirect: throws
    5ms  window error                 an unknown error: L1 throws, event.message: Error: L1 throws, event.error is the thrown object: false
    6ms  onBeforeRequest L2           throw-then-redirect: returns {redirectUrl}
   12ms  webRequest.onBeforeRequest   <site>/?stg-case=throw-then-redirect  proxy: none, direct
   12ms  webRequest.onBeforeRedirect  <site>/?stg-case=throw-then-redirect → <site>/?stg-redirected=run
   13ms  webRequest.onBeforeRequest   <site>/?stg-redirected=run  proxy: none, direct
   15ms  webRequest.onCompleted       <site>/?stg-redirected=run  status 200, from the cache
    4ms  onBeforeRequest L1           async-order: returns a promise of {cancel: true} settled 500 ms later
    4ms  onBeforeRequest L2           async-order: returns {redirectUrl} at once
    5ms  webRequest.onBeforeRequest   <site>/?stg-case=async-order  proxy: none, direct
  505ms  webRequest.onErrorOccurred   <site>/?stg-case=async-order  NS_ERROR_ABORT
```

### 6. Blocking `webRequest.onBeforeSendHeaders`, two listeners: both get the original headers, the second does not see what the first added; what is sent is the merge — the last change of a header wins, an addition of the first stays although the second returned a list without it (R39.04)

L1 adds `X-Stg-A: 1` and `X-Stg-B: 1`; L2 sees none of them, sets `X-Stg-A: 2` and returns a list
without `X-Stg-B`; `onSendHeaders` reports `X-Stg-A: 2, X-Stg-B: 1` sent.

```text
    3ms  webRequest.onBeforeRequest  <site>/?stg-case=headers  proxy: none, direct
    3ms  onBeforeSendHeaders L1      sees none; adds X-Stg-A: 1 and X-Stg-B: 1
    3ms  onBeforeSendHeaders L2      sees none; sets X-Stg-A: 2
    7ms  webRequest.onSendHeaders    sent X-Stg-A: 2, X-Stg-B: 1
  459ms  webRequest.onCompleted      <site>/?stg-case=headers  status 200
```

### 7. Blocking `webRequest.onAuthRequired`, two listeners: the first `authCredentials` in the order of adding are applied; credentials the server refuses bring another challenge to every listener, with `onBeforeRequest` fired again for the same request; the request completes with the credentials of the later challenge (R39.05)

The page answers 401 until the right credentials come; the tab is in a fresh container, since the
browser remembers accepted credentials by host, realm and container. Challenge 1: L1 returns wrong
credentials, L2 the right ones — the wrong ones are sent (the server answers 401 again). Challenge
2: L1 returns `{}`, L2 the right ones — the request completes 200. `onBeforeRequest` came three
times for the one request: at the start and once per attempt with credentials.

```text
    7ms  webRequest.onBeforeRequest  <auth page>  proxy: none, direct
  662ms  onAuthRequired L1           challenge 1, status 401: returns wrong credentials
  662ms  onAuthRequired L2           challenge 1: returns the right credentials
  664ms  webRequest.onBeforeRequest  <auth page>  proxy: none, direct
  816ms  onAuthRequired L1           challenge 2, status 401: returns {}
  816ms  onAuthRequired L2           challenge 2: returns the right credentials
  818ms  webRequest.onBeforeRequest  <auth page>  proxy: none, direct
  972ms  webRequest.onCompleted      <auth page>  status 200
```

### 8. `webRequest.onAuthRequired` with `asyncBlocking`: the return value of the listener is ignored, the credentials passed to `asyncCallback` apply (R39.06)

One listener returns wrong credentials and calls `asyncCallback` with the right ones 500 ms later:
one challenge, the request completes 200 after the callback.

```text
    8ms  webRequest.onBeforeRequest  <auth page>  proxy: none, direct
  712ms  onAuthRequired L1           challenge 1, status 401: returns wrong credentials, asyncCallback with the right ones 500 ms later (asyncCallback is function)
 1214ms  webRequest.onBeforeRequest  <auth page>  proxy: none, direct
 1407ms  webRequest.onCompleted      <auth page>  status 200
```

### 9. `proxy.onRequest`, three listeners: called in the order of adding, and twice for one navigation of a tab; `undefined` keeps the result of the listener before, `null` replaces it with a direct connection, a `ProxyInfo` after no result is the proxy of the request (after a `ProxyInfo` — §13); a dead proxy left in place fails the request with `NS_ERROR_PROXY_CONNECTION_REFUSED`, no fallback to a direct connection; a throw: the request goes direct, no `proxy.onError`, an `error` event of the window and a console line; a rejected promise: `proxy.onError` fires, the request goes direct, no `unhandledrejection` (R39.07)

The proxy the request got is `details.proxyInfo` of `webRequest.onBeforeRequest`. Every listener
was called twice for every `tabs.update`, the three in order both times.

- `dead-undefined-null`: L1 a dead proxy, L2 `undefined`, L3 `null` — direct, completed 200.
- `dead-undefined-undefined`: L1 another dead proxy, L2 and L3 `undefined` — the dead proxy,
  `NS_ERROR_PROXY_CONNECTION_REFUSED` at 4359 ms.
- `throw-first`: L1 throws — direct, completed 200; `proxy.onError` silent; the window got an
  `error` event per call (two), the console `Uncaught Error: L1 throws`.
- `reject-first`: L1 returns a rejected promise — direct, completed 200; `proxy.onError` fired
  twice, once per call; no `unhandledrejection`.

```text
    2ms  proxy.onRequest L1          dead-undefined-null: returns a dead proxy
    2ms  proxy.onRequest L1          dead-undefined-null: returns a dead proxy
    4ms  proxy.onRequest L2          dead-undefined-null: returns undefined
    4ms  proxy.onRequest L2          dead-undefined-null: returns undefined
    4ms  proxy.onRequest L3          dead-undefined-null: returns null
    4ms  proxy.onRequest L3          dead-undefined-null: returns null
   10ms  webRequest.onBeforeRequest  <site>/?stg-case=dead-undefined-null  proxy: none, direct
  484ms  webRequest.onCompleted      <site>/?stg-case=dead-undefined-null  status 200
    1ms  proxy.onRequest L1          dead-undefined-undefined: returns another dead proxy
    1ms  proxy.onRequest L1          dead-undefined-undefined: returns another dead proxy
    3ms  proxy.onRequest L2          dead-undefined-undefined: returns undefined
    3ms  proxy.onRequest L2          dead-undefined-undefined: returns undefined
    4ms  proxy.onRequest L3          dead-undefined-undefined: returns undefined
    4ms  proxy.onRequest L3          dead-undefined-undefined: returns undefined
    8ms  webRequest.onBeforeRequest  <site>/?stg-case=dead-undefined-undefined  proxy: http 127.0.0.1:65534
 4359ms  webRequest.onErrorOccurred  <site>/?stg-case=dead-undefined-undefined  NS_ERROR_PROXY_CONNECTION_REFUSED
    2ms  proxy.onRequest L1          throw-first: throws
    2ms  window error                an unknown error: L1 throws, event.message: Error: L1 throws, event.error is the thrown object: false
    3ms  proxy.onRequest L1          throw-first: throws
    3ms  window error                an unknown error: L1 throws, event.message: Error: L1 throws, event.error is the thrown object: false
    3ms  proxy.onRequest L2          throw-first: returns undefined
    8ms  proxy.onRequest L2          throw-first: returns undefined
    8ms  proxy.onRequest L3          throw-first: returns undefined
    8ms  proxy.onRequest L3          throw-first: returns undefined
   12ms  webRequest.onBeforeRequest  <site>/?stg-case=throw-first  proxy: none, direct
  462ms  webRequest.onCompleted      <site>/?stg-case=throw-first  status 200
    1ms  proxy.onRequest L1          reject-first: returns Promise.reject
    1ms  proxy.onRequest L1          reject-first: returns Promise.reject
    3ms  proxy.onError               [object Object]
    5ms  proxy.onError               [object Object]
    9ms  proxy.onRequest L2          reject-first: returns undefined
    9ms  proxy.onRequest L2          reject-first: returns undefined
    9ms  proxy.onRequest L3          reject-first: returns undefined
    9ms  proxy.onRequest L3          reject-first: returns undefined
   11ms  webRequest.onBeforeRequest  <site>/?stg-case=reject-first  proxy: none, direct
  552ms  webRequest.onCompleted      <site>/?stg-case=reject-first  status 200
```

### 10. `runtime.onMessage`, two listeners: a `sendResponse` the second listener calls at once beats a resolved promise the first returned; the listeners of one context get one and the same message object — a field the first adds, the second sees (R39.08)

- `promise-vs-sync`: L1 returns `Promise.resolve("L1")`, L2 calls `sendResponse("L2")` at once — the
  sender gets `"L2"`: with §3, a `sendResponse` called inside a listener beats a promise whichever
  listener is first.
- `mutate`: L1 sets `message.touched = "L1"` and answers nothing, L2 answers with a promise of
  `message.touched` — the sender gets `"L1"`.

```text
   33ms  runtime.onMessage L1  promise-vs-sync: returns Promise.resolve("L1")
   33ms  runtime.onMessage L2  promise-vs-sync: calls sendResponse("L2") at once, returns nothing
   33ms  page reports          promise-vs-sync: answer "L2"
   34ms  runtime.onMessage L1  mutate: sets message.touched = "L1", returns nothing
   34ms  runtime.onMessage L2  mutate: returns a promise of message.touched, "nothing" when there is none
   35ms  page reports          mutate: answer "L1"
```

### 11. `tabs.onCreated`, two listeners: every listener gets a tab object of its own — a field the first adds, the second does not see (R39.09)

```text
    6ms  tabs.onCreated L1     sets tab.touched = "L1"
    6ms  tabs.onCreated L2     sees tab.touched: nothing
```

### 12. Blocking `webRequest.onBeforeSendHeaders`, two listeners: every listener gets a `details` of its own — a header pushed into `details.requestHeaders` in place is not seen by the second; the list a listener returns is applied as its changes against the original headers: an original header missing from the list of any one listener is removed, whether the other listener returned it before or after; a header pushed into `details.requestHeaders` in place and returned with it is added; a string result is skipped and the changes of the next listener apply (R39.10)

Every case is a `tabs.update` of the scene tab to a url of the site with the case in its query; what
is sent is reported by `onSendHeaders`. `Accept-Language` is a header of the original request,
every listener saw it in every case.

- `omit-second`: L1 pushes `X-Stg-Mut: 1` into `details.requestHeaders` in place and returns that
  array, L2 returns its list without `Accept-Language` — L2 saw no `X-Stg-Mut`; sent: no
  `Accept-Language` although L1 returned it, `X-Stg-Mut: 1`.
- `omit-first`: L1 returns its list without `Accept-Language`, L2 returns its list as it is — sent:
  no `Accept-Language`; the unchanged header in the later list does not bring it back.
- `omit-both`: the control — no `Accept-Language`.
- `string-then-add`: L1 returns a string, L2 adds `X-Stg-C: 1` — sent: `Accept-Language`, `X-Stg-C: 1`.

```text
    2ms  webRequest.onBeforeRequest  <site>/?stg-case=omit-second  proxy: none, direct
    2ms  onBeforeSendHeaders L1      omit-second: sees Accept-Language present, X-Stg-*: none; pushes X-Stg-Mut: 1 into details.requestHeaders in place and returns that array
    2ms  onBeforeSendHeaders L2      omit-second: sees Accept-Language present, X-Stg-*: none; returns its list without Accept-Language
    6ms  webRequest.onSendHeaders    omit-second: sent Accept-Language absent, X-Stg-*: X-Stg-Mut: 1
  466ms  webRequest.onCompleted      <site>/?stg-case=omit-second  status 200
    2ms  webRequest.onBeforeRequest  <site>/?stg-case=omit-first  proxy: none, direct
    2ms  onBeforeSendHeaders L1      omit-first: sees Accept-Language present, X-Stg-*: none; returns its list without Accept-Language
    2ms  onBeforeSendHeaders L2      omit-first: sees Accept-Language present, X-Stg-*: none; returns its list as it is
    2ms  webRequest.onSendHeaders    omit-first: sent Accept-Language absent, X-Stg-*: none
  534ms  webRequest.onCompleted      <site>/?stg-case=omit-first  status 200
    5ms  webRequest.onBeforeRequest  <site>/?stg-case=omit-both  proxy: none, direct
    5ms  onBeforeSendHeaders L1      omit-both: sees Accept-Language present, X-Stg-*: none; returns its list without Accept-Language
    5ms  onBeforeSendHeaders L2      omit-both: sees Accept-Language present, X-Stg-*: none; returns its list without Accept-Language
   11ms  webRequest.onSendHeaders    omit-both: sent Accept-Language absent, X-Stg-*: none
  464ms  webRequest.onCompleted      <site>/?stg-case=omit-both  status 200
    4ms  webRequest.onBeforeRequest  <site>/?stg-case=string-then-add  proxy: none, direct
    4ms  onBeforeSendHeaders L1      string-then-add: sees Accept-Language present, X-Stg-*: none; returns a string
    4ms  onBeforeSendHeaders L2      string-then-add: sees Accept-Language present, X-Stg-*: none; adds X-Stg-C: 1
    7ms  webRequest.onSendHeaders    string-then-add: sent Accept-Language present, X-Stg-*: X-Stg-C: 1
  475ms  webRequest.onCompleted      <site>/?stg-case=string-then-add  status 200
```

### 13. `proxy.onRequest`, two listeners, a result after a `ProxyInfo`: a `ProxyInfo` goes before the one of the listener before, which becomes its failover — the request tries the second proxy, then the first; `{type: "direct"}` after a `ProxyInfo` leaves that `ProxyInfo`; `{type: "direct"}` before a `ProxyInfo` is no failover — the request fails on the proxy; a rejected promise after a `ProxyInfo` leaves it and fires `proxy.onError` once per call (R39.11)

The proxy the request got is `details.proxyInfo` of `webRequest.onBeforeRequest`, which comes again
when the request moves to the failover. No proxy is configured in the browser or in the system.

- `dead-then-other`: L1 a dead proxy, L2 another dead proxy — `onBeforeRequest` with the proxy of
  L2, after its refusal `onBeforeRequest` again with the proxy of L1, then
  `NS_ERROR_PROXY_CONNECTION_REFUSED` at 8733 ms.
- `direct-then-dead`: L1 `{type: "direct"}`, L2 a dead proxy — the proxy of L2, refused at 4359 ms,
  no second attempt.
- `dead-then-direct`: L1 a dead proxy, L2 `{type: "direct"}` — the proxy of L1, refused.
- `dead-then-reject`: L1 a dead proxy, L2 a rejected promise — the proxy of L1, refused;
  `proxy.onError` twice, once per call of L2.

```text
    1ms  proxy.onRequest L1          dead-then-other: returns a dead proxy
    1ms  proxy.onRequest L1          dead-then-other: returns a dead proxy
    5ms  proxy.onRequest L2          dead-then-other: returns another dead proxy
    5ms  proxy.onRequest L2          dead-then-other: returns another dead proxy
    6ms  webRequest.onBeforeRequest  <site>/?stg-case=dead-then-other  proxy: http 127.0.0.1:65532
 4367ms  webRequest.onBeforeRequest  <site>/?stg-case=dead-then-other  proxy: http 127.0.0.1:65533
 8733ms  webRequest.onErrorOccurred  <site>/?stg-case=dead-then-other  NS_ERROR_PROXY_CONNECTION_REFUSED
    2ms  proxy.onRequest L1          direct-then-dead: returns {type: "direct"}
    2ms  proxy.onRequest L1          direct-then-dead: returns {type: "direct"}
    3ms  proxy.onRequest L2          direct-then-dead: returns a dead proxy
    3ms  proxy.onRequest L2          direct-then-dead: returns a dead proxy
    8ms  webRequest.onBeforeRequest  <site>/?stg-case=direct-then-dead  proxy: http 127.0.0.1:65531
 4359ms  webRequest.onErrorOccurred  <site>/?stg-case=direct-then-dead  NS_ERROR_PROXY_CONNECTION_REFUSED
    4ms  proxy.onRequest L1          dead-then-direct: returns a dead proxy
    4ms  proxy.onRequest L1          dead-then-direct: returns a dead proxy
    8ms  proxy.onRequest L2          dead-then-direct: returns {type: "direct"}
    8ms  proxy.onRequest L2          dead-then-direct: returns {type: "direct"}
   11ms  webRequest.onBeforeRequest  <site>/?stg-case=dead-then-direct  proxy: http 127.0.0.1:65530
 4348ms  webRequest.onErrorOccurred  <site>/?stg-case=dead-then-direct  NS_ERROR_PROXY_CONNECTION_REFUSED
    3ms  proxy.onRequest L1          dead-then-reject: returns a dead proxy
    3ms  proxy.onRequest L1          dead-then-reject: returns a dead proxy
    6ms  proxy.onRequest L2          dead-then-reject: returns Promise.reject
    6ms  proxy.onRequest L2          dead-then-reject: returns Promise.reject
    6ms  proxy.onError               An unexpected error occurred
    7ms  proxy.onError               An unexpected error occurred
    7ms  webRequest.onBeforeRequest  <site>/?stg-case=dead-then-reject  proxy: http 127.0.0.1:65529
 4355ms  webRequest.onErrorOccurred  <site>/?stg-case=dead-then-reject  NS_ERROR_PROXY_CONNECTION_REFUSED
```

### 14. `webRequest.onAuthRequired` with `asyncBlocking`, two listeners: the credentials of the first listener in the order of adding apply, although its `asyncCallback` came later than the one of the second (R39.12)

Challenge 1: L1 passes wrong credentials to its `asyncCallback` 500 ms later, L2 passes the right
ones at once — the wrong ones are sent, the server answers 401 again. Challenge 2: both pass the
right ones — the request completes 200. Each challenge came to both listeners.

```text
   13ms  webRequest.onBeforeRequest  <auth page>  proxy: none, direct
  409ms  onAuthRequired L1           challenge 1, status 401: asyncCallback with wrong credentials 500 ms later
  409ms  onAuthRequired L2           challenge 1: asyncCallback with the right credentials at once
  912ms  webRequest.onBeforeRequest  <auth page>  proxy: none, direct
 1028ms  onAuthRequired L1           challenge 2, status 401: asyncCallback with the right credentials 500 ms later
 1028ms  onAuthRequired L2           challenge 2: asyncCallback with the right credentials at once
 1531ms  webRequest.onBeforeRequest  <auth page>  proxy: none, direct
 1666ms  webRequest.onCompleted      <auth page>  status 200
```

### 15. ES modules of a page of the extension are evaluated in the order of the imports, depth first: a global one import sets on `self` is there for every instance of a module imported after it, and not for an instance imported before it (R39.13)

`order.js` imports a module that imports a probe of its own, then a module that sets a global on
`self`, then ten instances of the probe, one per query. The early probe did not see the global,
the ten after it did, in order.

```text
   33ms  order-probe.js?early  does not see the global at its evaluation
   33ms  order-probe.js?1      sees the global at its evaluation
   33ms  order-probe.js?2      sees the global at its evaluation
   33ms  order-probe.js?3      sees the global at its evaluation
   33ms  order-probe.js?4      sees the global at its evaluation
   33ms  order-probe.js?5      sees the global at its evaluation
   33ms  order-probe.js?6      sees the global at its evaluation
   33ms  order-probe.js?7      sees the global at its evaluation
   33ms  order-probe.js?8      sees the global at its evaluation
   33ms  order-probe.js?9      sees the global at its evaluation
   33ms  order-probe.js?10     sees the global at its evaluation
```

### 16. The order of §15 holds for every load of the page the browser makes: ten loads, every second one past the cache, give the same records (R39.14)

The page of §15 is created once and reloaded nine times by `tabs.reload`, `bypassCache` on every
second load. Every load reports the same: the early probe does not see the global, the ten after
it do.

```text
   34ms  load 1                early does not see the global, 10 later see it
   25ms  load 2                early does not see the global, 10 later see it
   30ms  load 3                early does not see the global, 10 later see it
   34ms  load 4                early does not see the global, 10 later see it
   29ms  load 5                early does not see the global, 10 later see it
   29ms  load 6                early does not see the global, 10 later see it
   32ms  load 7                early does not see the global, 10 later see it
   33ms  load 8                early does not see the global, 10 later see it
   26ms  load 9                early does not see the global, 10 later see it
   37ms  load 10               early does not see the global, 10 later see it
```
