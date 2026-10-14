# Simple Tab Groups — project guide

**Simple Tab Groups (STG)** is a Firefox extension: create, edit and quickly switch groups of
tabs. Inspired by the classic "Tab Groups" add-on that Mozilla removed from the browser. What the
add-on does, the companion plugins, the Gesturefy commands, the build and the links — `README.md`
in the root; the notes for the Mozilla reviewers — `addon/README.md`.

## Read before writing code

`docs/DESIGN-*.md` — how the add-on is built: the model, the invariants, the methods that carry
them. Before changing code read the ones every change touches:

- `docs/DESIGN-QUEUES.md` — the queues, who waits for whom
- `docs/DESIGN-EVENTS.md` — the browser events: own actions muted, the user's mirrored
- `docs/DESIGN-PARAMS.md` — the `params` object and the dictionary of its keys
- `docs/DESIGN-CACHE.md` — the cache: the mirror of the tabs, the requested url, the session values

By the area of the task:

- `docs/DESIGN-GROUPS.md` — groups, tabs and windows
- `docs/DESIGN-URLS.md` — extension page addresses
- `docs/DESIGN-MESSAGES.md` — messages and the content script
- `docs/DESIGN-CLOUD-UPLOAD.md` — the cloud sync of a group
- the header of `addon/src/js/groups-native.js` — native groups
- `docs/BEHAVIOR-OPENER.md`, the section "How STG carries the link" — tab openers

`docs/BEHAVIOR-*.md` — measured facts of the browser. Read them when the task touches that
behavior; the code cites them by `§`. `docs/BEHAVIOR-NOTATION.md` — before writing a test or a
fact.

## Principles of the add-on

- **Firefox 153+** (the minimum is set in the manifest): Firefox-only APIs are used — tabHide,
  contextualIdentities, sidebar_action and so on.
- **Private mode** is not supported on purpose (`"incognito": "not_allowed"`).
- **Pinned tabs** are outside the logic. The one exception is a tab that cannot be hidden (a
  microphone, a camera, a screen share): the add-on pins it itself and unbinds it from its group
  — `DESIGN-GROUPS.md`.
- **The tabs of a group are one block** of indexes, no foreign tab in between. Every operation
  keeps the block; a loaded and an unloaded group behave the same — `DESIGN-GROUPS.md`.
- **The options of a group set the state of its tabs**: a tab that lands in an unloaded group by
  any route is muted and discarded as the group says, and there is a single coupling for hiding
  and showing the tabs of a group — `DESIGN-GROUPS.md`.
- **Normal windows only.** The current window of a user action is the normal window in focus;
  a private or a popup window in focus means no action — `DESIGN-GROUPS.md`.
- Conflicts with add-ons of the same kind are possible (OneTab, Panorama Tab Groups, Tiled Tab
  Groups and the like).

## Repository layout

```txt
/
├── addon/                  # The extension; the build and the commands — README.md in the root and addon/README.md
│   ├── src/                # Sources: manifest.json, background.js (the background script), popup/ (the popup and the sidebar), options/, web/ (the content script), js/ (the modules), _locales/, icons/
│   ├── dist/               # The build output (not in git)
│   └── dist-zip/           # The zip archives for publishing (not in git)
├── docs/                   # DESIGN-*.md — how the add-on is built; BEHAVIOR-*.md — measured facts of the browser; BEHAVIOR-NOTATION.md — how a fact and a test are written
├── host/                   # The native messaging host: backups into any folder (Pascal, Windows only)
├── plugins/                # The companion plugins — separate small add-ons (the list — README.md)
├── sandbox/                # Temporary scripts and data of the assistant (not in git)
├── test-addon/             # The throwaway add-on for the browser behavior tests (how to run — its README.md)
└── translate/              # Not used — do nothing in it
```

- **Stack:** Vue 2.7 — a local copy, `addon/src/js/vue.runtime.esm.js`, no CDN (an AMO
  requirement for the code verification; where the file comes from and its version —
  `addon/README.md`); the logic is plain JS, ES modules; the build is Webpack. `background.js` is
  an ES module, the other JS files go through Webpack; new modules use the standard `import` /
  `export`.

## Native groups

Firefox has its own tab groups (`browser.tabGroups`); STG supports them inside its groups. All
the logic is `js/groups-native.js`, the model is described in the comments of the file; the
measured facts of the browser — `docs/BEHAVIOR-TABGROUPS.md`.

## Tab openers (`openerTabId`)

The link "tab → opener" is a native field of the browser: Firefox itself uses it (the focus goes
to the opener on close), and so do the tree add-ons (TST and the like). **STG does not manage
the links — it only carries them through its own actions.** That is the single rule and it is
strict: STG never invents a link and never breaks one; a `-1` written by the add-on must not
exist in the code. The whole model, the map of the code and the browser facts —
`docs/BEHAVIOR-OPENER.md`, the section "How STG carries the link".

## Extension page addresses

In the browser a page of an extension lives at `moz-extension://<uuid>/…`, the uuid differs per
profile. Inside the add-on the page is named by the id of the extension, the add-on's own pages
too, and a wrapper page of the add-on is read as the address it wraps. A browser tab is brought
to that form at a single entry, and the real url stays on the tab in a hidden field. The model —
`docs/DESIGN-URLS.md`; what the cache keeps of a tab's address — `docs/DESIGN-CACHE.md`.

## Code standards

### ESNext and style

All new code is modern ECMAScript only: `async`/`await`, ES modules, `const`/`let`, `?.` and
`??`, destructuring and spread, `structuredClone()`, `Object.hasOwn()`, `at()`, `findLast()`,
the `&&=`/`||=`/`??=` operators, `Promise.allSettled()` and so on.
`Map.prototype.getOrInsert()` / `getOrInsertComputed()` are **native in Firefox 144+, use them**.

- `using` / `await using` are not allowed yet: `addons-linter` (the constant `ECMA_VERSION = 17`
  in `addons-scanner-utils`) parses ES2026, but the AMO validator that checks the uploaded zip is
  still behind and fails on them with `JS_SYNTAX_ERROR`. The check before a release —
  `npx addons-linter addon/dist`.
- Code is code, docs are docs. A comment in the code is a link to a doc and a few words. The
  mechanisms of the add-on live in `docs/DESIGN-*.md`, the facts of the browser in
  `docs/BEHAVIOR-*.md`. A model described in the header of a module — only at the developer's
  request.
- Code that works around a bug or exists because of one carries the link to the bug itself, in
  every place the bug touches — not only the `§` of the doc. For a bug of the browser that is the
  Bugzilla address: `// BUG https://bugzilla.mozilla.org/show_bug.cgi?id=…`. A comment that marks
  a defect or work to do starts with one of the tags the editor highlights (ToDo Tree): `BUG`,
  `HACK`, `FIXME`, `TODO`, `[ ]`, `[x]`.
- The names of variables, functions and modules are simple, say what they hold, and follow the
  style of the add-on.
- The name of a method names the action and is clear without context: inside the module and
  outside, should it ever be exported. Words like `normalize` do not say what the method does to
  its argument.
- A call is convenient for the caller — one line, for one item and for a batch
  (`tabs.forEach(method)`). So a conversion has two forms: one method takes and returns a value,
  the other changes tabs and returns them.
- An export nobody calls is removed. The exception is a module whose header declares it
  universal: its methods stay even while nothing calls them.
- A helper may be able to do more than its callers need today, as long as it stays simple: the
  check of the accepted inputs at its top is also its documentation. Breadth is fine, complexity
  is not.
- Logic over convenience. An action that cannot be done in parts lives in one method, and there
  is no convenient form around it: better to build an object somewhere for the sake of one
  value than to have a place where the second part can be forgotten.
- Methods that are the inverse of each other are symmetric: paired names (`urlToId` /
  `urlToUUID`), the same arguments, the same shape of the result and the same behavior where
  there is nothing to translate (both return what they got). One returning a value and its
  inverse returning `undefined` is not allowed.
- A constant is named by what it holds: `…_PROTOCOL` is the whole protocol and only it
  (`'moz-extension:'`), the address of a page without the protocol in its name is `…_PAGE`
  (`'about:reader'`). A regular expression out of a constant is built with
  `new RegExp(RegExp.escape(…) + …)`.
- Structured code.
- No duplicated code or logic — move it to one place and make it universal.

Old code in the repository may not follow this — that is normal, it is not rewritten on purpose.

### Lookups are built once

A lookup over a list (which ids each group holds, which tabs each window has) is the rule about
duplicated logic applied to data: one method of the module that owns the data builds it, and it
travels to its users as an argument, a `Map` or a `Set` keyed by what they look up by. Collecting
the same thing at every call site, each with loops of its own, reads badly and drifts apart; a
method that needs such a lookup asks for it ready-made instead of rebuilding it inside.

### The design docs match the code

`docs/DESIGN-*.md` describe the code as it is, strictly. Every change of the code that matters —
a mechanism, an invariant, a contract between modules — is written into them in the same pass;
trivia is not. They may name methods, files and the keys that matter, never local variables and
never line numbers. Nothing unverified, invented or imprecise goes in: a claim about the browser
is a `§` of a `BEHAVIOR-*.md`, a claim about the code is read from the code.

### Manifest V3 is ahead

The add-on is on MV2, the move to MV3 is planned. All new development takes every MV3 trait
into account. Events are subscribed through `addon/src/js/listeners.js`.

### Which version is being worked on

When the data format changes, check which version the change belongs to. The published version:

```bash
curl -s https://addons.mozilla.org/api/v5/addons/addon/simple-tab-groups/ | jq -r ".current_version.version"
```

Compare it with the version in `addon/src/manifest.json`:

- **The major of the manifest is above the published one** — a new major is in development. The
  data format is not frozen yet: changes of the format go freely into the current, not yet
  published migration entry.
- **The majors are equal** — the format is published and frozen: any change of the data format is
  a new major in the manifest and a new migration entry. Published entries are never edited.

Users come exactly from the published version — the migration must digest its format. The
versioning and migration system is described in the header of `addon/src/js/migration.js`; the
rules — `migrations-main.js` (storage.local, backups, the gist) and `migrations-sync.js`
(storage.sync).

### Reliability: whose fault, whose problem

The code of the add-on must be free of bugs, naturally, but the add-on **is not obliged** to
defend itself against corrupted data the user brought from outside: a restored crooked backup, a
git gist edited by hand and edited wrong, and so on. Such states are the user's problem; the code
is not inflated with checks "what if the data is garbage".

The other side: when **the add-on itself** changes its data format or its behavior, the migration
must be detailed and stable — the migration code takes every possible previous state of the
add-on's data into account and brings it to the format of the latest version. And the add-on must
never corrupt correct data on any of its paths. The user's faults are the user's; the add-on has
none.

### A developer's mistake breaks loudly

Where a small slip is easy while writing code (a second name for the same queue, an unknown key,
a call in the wrong order), the code must break loudly: throw, not log and go on. Such an error
must show up at the first start of the add-on after the change and never reach the users. For
example, registering a second queue under the same name throws when the module loads.

The same goes for the arguments of a method that must stand in a relation to each other: an item
and the list it must not be part of, two ids that must differ, a value and the set it must belong
to. The caller is where the slip happens (a wrong list, a stale id, the call before the step that
makes the relation true), and the method cannot tell such a call from a right one by the shape of
its arguments alone. So the method checks the relation at its top and throws. The price is one
check; without it the method quietly does the wrong thing with correct-looking data, and the
damage shows up far away, in the user's storage, with no trace back to the call.

### Scale of a change

The best code is the code not written. Pick the smallest intervention. The order of preference,
top down:

1. **Delete.** If the task is solved by deleting code — delete.
2. **Change what exists.** Edit in place, do not build a parallel path next to the old one.
3. **Add.** Only when 1 and 2 do not work. Add the minimum the request needs.
4. **Create a new file.** The last resort. Always prefer editing an existing file to creating a
   new one — `.md` included.

The rules:

- Success is measured by the final state of the code base, not by the size of the diff.
- Do not leave the old version next to the new one. Delete what your change made unnecessary.
- Do not create documentation, READMEs or note files on your own initiative — only on an explicit
  request.
- Before finishing, go through the final diff piece by piece and revert everything the request
  did not ask for.
- If the amount of code grew, explain in one line why the addition was necessary.
- Do not rewrite working code the task did not touch.

### Load: users have 1500+ tabs

Some users have more than 1500 tabs in the browser, by their screenshots. Every analysis and every
new piece of code is designed for that volume: mass reads of tabs, session calls and walks over
lists are expensive. No extra passes over all tabs and no extra API calls; where the snapshot at
hand is enough, the tabs are not read again.

### Events: the add-on's own actions are muted, the user's are mirrored

- The flows of the add-on mute the events of their own actions, and the handlers allow for the
  late delivery of events: a snapshot may be older than reality.
- The actions of the user are mirrored into the add-on through its own rules.
- Other add-ons do strange things — the add-on obeys, it does not fight.

These policies are deliberate and are not changed in passing while fixing a bug. The mechanics —
`docs/DESIGN-EVENTS.md`.

### Messages: whom the background trusts

Only the add-on's own sender may run a module by name; the content script runs inside foreign
pages and sends nothing it got from the page. The rules — `docs/DESIGN-MESSAGES.md`.

### A bug fix starts with the analysis

First the analysis: why the bug appeared, which flows and events take part. Then the fix — in
exactly the right place, not a plug in a random one. If along the way the logic turns out to be
fundamentally bad, do not patch it: stop and propose a rework with the reasoning.

### The add-on is one whole

Developing the add-on is not a fix in a few places. Every change is weighed by what the user
will see: how the action shows in the popup, in the tab strip, in the groups. The code stays
whole — its parts do not contradict each other, and the result of a user action is explained by
the rules of the add-on, not by the route it came by. A place where the parts conflict is
reported to the developer.

### Fix one level up

A problem cannot be solved at the level where it showed up: the symptom lives there, the cause is
one level up, in the mechanism that produced it. A fix at the level of the symptom is recognised
by its shape: a whitelist, an extra check, a prop next to the old mechanism. Seeing one in your
own solution — stop and go up: state in one sentence what the mechanism must do by its meaning
("the changes are saved — so exactly what the user changed in the form"), and rebuild the
mechanism to that sentence. The right solution is recognised by simplification: less code and
fewer links, and a whole class of problems disappears, not one case.

### Refactoring

Make it better, more stable, clearer, more readable than it was.

### Module boundaries

The logic of a module lives in the module. Outer code informs the module through its API, and
the module decides what to do. The common place for constants is `constants.js`. A value the
cache remembers is written by the cache only: it remembers the absence of a value too, so a write
past it makes it a liar — `docs/DESIGN-CACHE.md`.

### Queues and operations

A shared resource that is changed by "read, change, write" is changed only by a move of the
queue of its owner, and a queue is never handed out of its module. A move waits only for the
queues below its own, never for its own or one above. Operations are not a queue: composite
flows run in parallel, and the observers wait for them to go idle. The queues, their order and
the rules per queue — `docs/DESIGN-QUEUES.md`.

### The `params` object

Flags that travel the whole call chain ride as the last argument in one `params` object. A
reader reads its keys once, at the top of the function, one constant per key with its default;
nobody writes into `params`; a different value for a callee is a new object. A key means the
same thing everywhere, and a new key goes into the dictionary first — `docs/DESIGN-PARAMS.md`.

### Locales

- Translations are made by the assistant at the developer's request.
- **`en` is the reference**: in every locale `addon/src/_locales/*/messages.json` the keys stand
  in the same positions as in `en`, and the `description` of every key is a verbatim copy of the
  English `description`.
- **A new key** and **a change of a key's text** go into every locale at once: `message` in the
  language of the locale, `description` in English. No locale may stay with the old meaning.
- **A rename or a removal of a key** goes into every locale at once: no dead keys are left.
- **Regional locales (`lang_REGION`)**: the browser looks each key up along the chain
  `de_CH` → `de` → `default_locale` (en) — per key, not per file (MDN, Internationalization →
  Localized string selection). So a regional locale holds **only** the keys whose text differs
  from the base `lang`. When the add-on has no base locale (`es_ES`, `pt_BR`, `zh_CN`, …), the
  regional one is complete and falls straight to `en`.

### Browser behavior — facts only

Nothing about the behavior of the browser (the WebExtensions API, the positions and the events
of tabs, the native groups) is invented — "most likely" and "usually" are not accepted. Not sure
— stop and prepare a test: it builds the scene itself (a window, tabs, groups), performs the
action and prints the result — the developer only runs it and sends the output back. Verified
facts are written into `docs/BEHAVIOR-*.md` (for example `BEHAVIOR-TABGROUPS.md`,
`BEHAVIOR-CREATE-TABS.md`), and from then on the code relies on them, not on memory.

Two exceptions:

- A refactoring that keeps a dependency on an unmeasured fact the code already had needs no new
  test; a new dependency does.
- A fact the published version has relied on for years is accepted, with a note that this is
  the evidence.

The tests are written for the throwaway add-on `test-addon/` (how to run it and how a round is
built — its README.md). The notation of a fact, the legend of the tables, the numbering rules and
the requirements for the tests themselves — `docs/BEHAVIOR-NOTATION.md`; read it before writing
a test or adding a fact.

### No history — the current state only

The code and the docs describe what is now. No notes like "moved there", "used to be different",
"dropped / revised" — a thing just lives in its place, and what is not needed is deleted without
a trace. A link to another place — only when the reader needs it by the meaning, not as a trace
of a move. The history lives in git, not in the files.

### All or nothing

A change of a convention or a mechanism is applied everywhere at once: in the same pass every
existing place is brought to the new shape — the code, the tests, the docs. No half states "new
here, old there". (This does not cancel the rule about old code from "ESNext and style": the
style of old code is not rewritten on purpose; this is about the conventions and the mechanisms
being changed.)

### Done means

Broken code appears where the contract of a function changed and the check was not carried
through. So "done" is said only after every item, none skipped:

1. Renamed, removed, changed the shape of the arguments or of the return — grep the whole code,
   every use reread.
2. Changed what a function does inside — reread everyone who calls it and everything it calls,
   one level deep, the queues and the gates included.
3. The edits are finished — reread the result, not the diff: every changed function whole and the
   header of the module (imports, exports, constants) with a fresh eye, as foreign code. The
   leftovers of the transition are gone: a helper for a single call, a check or a key only the
   old shape needed, unused imports and exports, `async` without `await`, a different contract
   in functions of one kind (one returns a result, its twin does not). The same logic that grew
   out of the edits is brought into one place; foreign duplicates go into the list of remarks.
4. The syntax check and the editor diagnostics after the last edit of the file; the messages
   between the edits of one pass do not count.
5. A doubt about a fact of the browser or about foreign code — reread it, do not reason about it.

## Rules without method names

The rules of this file are written with abstract examples, without the names of methods from the
code: a renamed method does not touch this file. The names live in `docs/DESIGN-*.md` and in the
code.
