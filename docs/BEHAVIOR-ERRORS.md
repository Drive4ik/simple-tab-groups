# The error objects the browser hands to an extension

What a refusal of a `browser.*` call, a `DOMException` and an `Error` across a structured clone
carry, field by field, as the logger of the add-on reads them (`addon/src/js/logger-utils.js`:
`normalizeError`, `nativeErrorToObject`, `getStack`; the model is `DESIGN-LOGGER.md` §4). The
facts come from `test-addon/tests/round-40.js`; the notation is `BEHAVIOR-NOTATION.md`. There is no
state table: every action is its own line of the event log, and the lines under it are the fields
of the error it produced, as `absent`, `undefined`, or the type and the value. A line or a column
is printed only as present or not: the number depends on the file of the test. The stack is a count
of frames and the first frame. The own uuid is never printed.

## 1. A rejection answered from the parent process

A `browser.*` call the browser answers from its parent process and refuses (`windows.get`,
`tabs.get`, `tabs.update` with an id no window or tab has) rejects with an `Error` of the page:
`name` `Error`, the message of the refusal, `fileName` the **string** `"undefined"`, `lineNumber`
`0`, a `columnNumber`, and an **empty** `stack`. Nothing in it says where the call was made. The
plain constructor shows where the string comes from: `new Error('message', undefined)` with an
explicit `undefined` as its second argument gets `fileName` `"undefined"`, while `new Error('message')`
gets the file of the caller. R40.01.

```text
    0ms  action                new Error('message', undefined) - the control
    0ms  made                  Error.isError: true; instanceof Error: true; instanceof DOMException: false; name: string "Error"; message: string "message"; fileName: string "undefined"; filename: absent; lineNumber: number >0; columnNumber: number >0; stack: 8 frame(s), first: run/<@<own page>/tests/round-40.js; cause: absent; code: absent; result: absent; own keys: []
    0ms  action                new Error('message') - one argument
    0ms  made                  Error.isError: true; instanceof Error: true; instanceof DOMException: false; name: string "Error"; message: string "message"; fileName: string "<own page>/tests/round-40.js"; filename: absent; lineNumber: number >0; columnNumber: number >0; stack: 8 frame(s), first: run/<@<own page>/tests/round-40.js; cause: absent; code: absent; result: absent; own keys: []
    0ms  action                browser.windows.get(UNKNOWN_ID)
    1ms  rejected with         Error.isError: true; instanceof Error: true; instanceof DOMException: false; name: string "Error"; message: string "Invalid window ID: 2147483647"; fileName: string "undefined"; filename: absent; lineNumber: number 0; columnNumber: number >0; stack: empty; cause: absent; code: absent; result: absent; own keys: []
    0ms  action                browser.tabs.get(UNKNOWN_ID)
    1ms  rejected with         Error.isError: true; instanceof Error: true; instanceof DOMException: false; name: string "Error"; message: string "Invalid tab ID: 2147483647"; fileName: string "undefined"; filename: absent; lineNumber: number 0; columnNumber: number >0; stack: empty; cause: absent; code: absent; result: absent; own keys: []
    0ms  action                browser.tabs.update(UNKNOWN_ID, {active: true})
    1ms  rejected with         Error.isError: true; instanceof Error: true; instanceof DOMException: false; name: string "Error"; message: string "Invalid tab ID: 2147483647"; fileName: string "undefined"; filename: absent; lineNumber: number 0; columnNumber: number >0; stack: empty; cause: absent; code: absent; result: absent; own keys: []
```

## 2. A rejection with no receiver, and a schema error at the call

`runtime.sendMessage` with no receiver rejects with an `Error` that carries the file and the line
of the caller and a stack of one frame, the call itself. A call the schema refuses (`tabs.get(-1)`
and `tabs.update(-1, …)`: the id must be at least 0; `tabs.get('x')`) does not reject: the `Error`
is **thrown at the call**, synchronously, with the file, the line and the full stack of the caller.
A `.catch` chained on such a call never runs; inside an `async` function the throw becomes the
rejection of that function. R40.01.

```text
    0ms  action                browser.runtime.sendMessage({}) - no receiver
    3ms  rejected with         Error.isError: true; instanceof Error: true; instanceof DOMException: false; name: string "Error"; message: string "Could not establish connection. Receiving end does not exist."; fileName: string "<own page>/tests/round-40.js"; filename: absent; lineNumber: number >0; columnNumber: number >0; stack: 1 frame(s), first: @<own page>/tests/round-40.js; cause: absent; code: absent; result: absent; own keys: []
    0ms  action                browser.tabs.get(-1) - a schema error
    1ms  threw at the call     Error.isError: true; instanceof Error: true; instanceof DOMException: false; name: string "Error"; message: string "Type error for parameter tabId (Integer -1 is too small (must be at least 0)) for tabs.get."; fileName: string "<own page>/tests/round-40.js"; filename: absent; lineNumber: number >0; columnNumber: number >0; stack: 10 frame(s), first: run/<@<own page>/tests/round-40.js; cause: absent; code: absent; result: absent; own keys: []
    0ms  action                browser.tabs.update(-1, {active: true}) - a schema error
    0ms  threw at the call     Error.isError: true; instanceof Error: true; instanceof DOMException: false; name: string "Error"; message: string "Type error for parameter tabId (Integer -1 is too small (must be at least 0)) for tabs.update."; fileName: string "<own page>/tests/round-40.js"; filename: absent; lineNumber: number >0; columnNumber: number >0; stack: 10 frame(s), first: run/<@<own page>/tests/round-40.js; cause: absent; code: absent; result: absent; own keys: []
    0ms  action                browser.tabs.get('x') - a schema error
    0ms  threw at the call     Error.isError: true; instanceof Error: true; instanceof DOMException: false; name: string "Error"; message: string "Incorrect argument types for tabs.get."; fileName: string "<own page>/tests/round-40.js"; filename: absent; lineNumber: number >0; columnNumber: number >0; stack: 10 frame(s), first: run/<@<own page>/tests/round-40.js; cause: absent; code: absent; result: absent; own keys: []
```

## 3. A `DOMException`

A `DOMException` is an error to `Error.isError` and to `instanceof Error`. It has no `fileName`:
its file is `filename`, in lower case, next to `lineNumber`, `columnNumber`, `code` and `result`.
Made from a script, it carries the place and the stack of that script; `fetch` on an aborted
signal rejects with an `AbortError` that carries the place of the `fetch` call, and `structuredClone`
of a function throws a `DataCloneError` at the call. After `structuredClone` a `DOMException` keeps
its name, message, `code` and `result` and loses the place: `filename` is `""`, the line and the
column are `0`, the stack is empty. R40.02.

```text
    0ms  action                new DOMException('message', 'AbortError')
    0ms  made                  Error.isError: true; instanceof Error: true; instanceof DOMException: true; name: string "AbortError"; message: string "message"; fileName: absent; filename: string "<own page>/tests/round-40.js"; lineNumber: number >0; columnNumber: number >0; stack: 6 frame(s), first: run@<own page>/tests/round-40.js; cause: absent; code: number 20; result: number 2152923156; own keys: []
    0ms  action                structuredClone(the DOMException)
    0ms  the clone             Error.isError: true; instanceof Error: true; instanceof DOMException: true; name: string "AbortError"; message: string "message"; fileName: absent; filename: string ""; lineNumber: number 0; columnNumber: number 0; stack: empty; cause: absent; code: number 20; result: number 2152923156; own keys: []
    0ms  action                fetch(an own page, {signal: AbortSignal.abort()})
    0ms  rejected with         Error.isError: true; instanceof Error: true; instanceof DOMException: true; name: string "AbortError"; message: string "The operation was aborted. "; fileName: absent; filename: string "<own page>/tests/round-40.js"; lineNumber: number >0; columnNumber: number >0; stack: 10 frame(s), first: @<own page>/tests/round-40.js; cause: absent; code: number 20; result: number 2152923156; own keys: []
    0ms  action                structuredClone(() => {})
    0ms  threw at the call     Error.isError: true; instanceof Error: true; instanceof DOMException: true; name: string "DataCloneError"; message: string "Function object could not be cloned."; fileName: absent; filename: string "<own page>/tests/round-40.js"; lineNumber: number >0; columnNumber: number >0; stack: 10 frame(s), first: @<own page>/tests/round-40.js; cause: absent; code: number 25; result: number 2152923161; own keys: []
```

## 4. An `Error` across `structuredClone`

The clone of an `Error` keeps the message, the `cause`, the file and the line, and the stack the
engine recorded. It loses every own property: a custom `name` becomes `Error`, `lang`, `arguments`
and a stack string assigned by hand are gone (the clone carries the recorded stack instead). A
`name` set to a standard one (`RangeError`) survives. R40.03.

```text
    0ms  action                an Error with name 'CustomError', lang, arguments, cause {a: 1} and stack 'assigned stack'
    1ms  the original          Error.isError: true; instanceof Error: true; instanceof DOMException: false; name: string "CustomError"; message: string "message"; fileName: string "<own page>/tests/round-40.js"; filename: absent; lineNumber: number >0; columnNumber: number >0; stack: 1 frame(s), first: assigned stack; cause: object {"a":1}; code: absent; result: absent; own keys: [name, lang, arguments, stack]
    0ms  action                structuredClone(the Error)
    1ms  the clone             Error.isError: true; instanceof Error: true; instanceof DOMException: false; name: string "Error"; message: string "message"; fileName: string "<own page>/tests/round-40.js"; filename: absent; lineNumber: number >0; columnNumber: number >0; stack: 6 frame(s), first: run@<own page>/tests/round-40.js; cause: object {"a":1}; code: absent; result: absent; own keys: []
    0ms  action                an Error renamed to 'RangeError', then structuredClone
    0ms  the original          Error.isError: true; instanceof Error: true; instanceof DOMException: false; name: string "RangeError"; message: string "message"; fileName: string "<own page>/tests/round-40.js"; filename: absent; lineNumber: number >0; columnNumber: number >0; stack: 6 frame(s), first: run@<own page>/tests/round-40.js; cause: absent; code: absent; result: absent; own keys: [name]
    0ms  the clone             Error.isError: true; instanceof Error: true; instanceof DOMException: false; name: string "RangeError"; message: string "message"; fileName: string "<own page>/tests/round-40.js"; filename: absent; lineNumber: number >0; columnNumber: number >0; stack: 6 frame(s), first: run@<own page>/tests/round-40.js; cause: absent; code: absent; result: absent; own keys: []
```

## 5. An object of a page that was closed

An object of another page of the add-on (`extension.getViews`) answers while the page lives:
`Error.isError` says `false`, `JSON.stringify`, `Object.keys` and `in` work. Once the page is
closed, every one of them throws `TypeError: can't access dead object`, `Error.isError` included;
only `typeof` still answers `object`. R40.04.

```text
    0ms  action                        the page is open: an object made by its Object and its document
    0ms  new view.Object() with a = 1  Error.isError: false; typeof: gives "object"; JSON.stringify: gives "{\"a\":1}"; Object.keys: gives ["a"]; 'a' in: gives true
    0ms  view.document                 Error.isError: false; typeof: gives "object"; JSON.stringify: gives "{\"location\":{\"href\":\"<own page>/tab.html?tab=dead\",\"origin\":\"moz-extension://<uuid>\",\"protocol\":\"moz-extension:\",\"host\":\"<uuid>\",\"hostname\":\"<uuid>\",\"port\":\"\",\"pathname\":\"/tab.html\",\"search\":\"?tab=dead\",\"hash\":\"\",\"ancestorOrigins\":{}}}"; Object.keys: gives ["location"]; 'a' in: gives false
    0ms  action                        browser.windows.remove(the window of the page)
    0ms  action                        the page is closed: the same object and document
    0ms  new view.Object() with a = 1  Error.isError: throws TypeError: can't access dead object; typeof: gives "object"; JSON.stringify: throws TypeError: can't access dead object; Object.keys: throws TypeError: can't access dead object; 'a' in: throws TypeError: can't access dead object
    0ms  view.document                 Error.isError: throws TypeError: can't access dead object; typeof: gives "object"; JSON.stringify: throws TypeError: can't access dead object; Object.keys: throws TypeError: can't access dead object; 'a' in: throws TypeError: can't access dead object
```
