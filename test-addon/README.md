# STG behavior test harness

The add-on that produced every fact in `docs/BEHAVIOR-TABGROUPS.md`, `docs/BEHAVIOR-CREATE-TABS.md`,
`docs/BEHAVIOR-MOVE-TABS.md`, `docs/BEHAVIOR-OPENER.md` and `docs/BEHAVIOR-STORAGE.md`. It is committed so those facts can be re-run and disputed: a
marker like `R5.16` points at the test with that id in `tests/round-05.js`, and running it must
reproduce the table printed next to the fact.

Not part of STG, never published, never built into the extension.

Notation and the rules a test has to follow: `docs/BEHAVIOR-NOTATION.md`.

## Setup

1. A **fresh Firefox profile with no other add-ons** — STG especially. STG mirrors native groups and
   would rewrite the very state a test is measuring.
2. For the restart tests: about:preferences → Startup → "Open previous windows and tabs" **on**.
3. `about:debugging` → This Firefox → Load Temporary Add-on… → pick `test-addon/manifest.json`.
4. Press **Inspect** next to it — that console is where runs are started and questions are answered.
5. Wait for `STG behavior test harness ready`.

## Running

```js
T.start()                          // every round, in order
T.start('round-05')                // one round
T.start('round-01', 'round-07')    // a few rounds
T.start('round-05:R5.01:R5.38')    // named tests of one round, for a re-check after a fix
```

The console shows one line per test while the run goes. At the end the full report opens in a tab,
already selected — Ctrl+A, Ctrl+C. `T.logs()` opens the last report again.

A run is not unattended:

- **👁️ questions.** The run stops at the frame the question is about, prints the window as the API
  sees it, and waits. Look at the tab bar, then answer in the same console:
  `T.visualAnswer('only gr2 is visible')`. `T.visualAnswer()` with no argument records "not looked
  at" and moves on. The answer goes into the report under its question.
- **Restarts.** R3.05, R4.03, R14.08, R14.10, R19.01, R27.09 and R28.13 stop and ask for a browser
  restart (R19.01 — for a complete quit: the shutdown itself is its subject; the exact ask is
  printed by the test). The scene window is left open on purpose — keep it. Restart Firefox, load
  the add-on again in about:debugging, then run `T.continue()`: the harness finds the scene window
  by the names in the tab urls and finishes the test in the same table. R28.13 is the exception:
  its subject is the start of the background together with the browser, so the harness has to be
  INSTALLED in the profile before the test is started — zip the contents of `test-addon`,
  `manifest.json` at the root of the archive, and install the zip from about:addons, in a browser
  that takes unsigned add-ons (`xpinstall.signatures.required = false`); after the restart it is
  already there, nothing is loaded by hand. Remove the installed harness once the report is saved:
  a temporary load over it shares its storage, and removing that temporary copy wipes the storage
  (BEHAVIOR-LIFECYCLE.md §5).

`T.continue()` also picks a run back up after an add-on reload or a crash — the queue and everything
measured so far are checkpointed after every test. `T.stop()` ends a run after the current test and
still produces the report. `T.forget()` throws a stuck checkpoint away.

Nothing has to be cleaned up by hand between runs: when a test ends the harness removes its
listeners, restores every browser setting the test changed and closes every window of the stand,
the scene window and the ones `t.buildWindow` opened alike. Before every test it sweeps once more
— windows and settings left behind by a run that crashed or is coming back from a restart — and
writes into the report whatever it had to clean up.

## Rounds

| round | what it establishes |
| - | - |
| `round-01` | API/event self-check, TABGROUPS §1 and §2, explicit-index array moves past the end and cross-window, the array-as-a-block rule |
| `round-02` | the membership rule on `tabs.move`, then §3 and §4 |
| `round-03` | group id immutability, collapsed, the hidden-tab header, groups across a restart |
| `round-04` | collapsed seen from the tab bar, hidden tabs across a restart |
| `round-05` | CREATE-TABS: the newTabPosition matrix, speed, window targeting, the races; no-index creates against a hidden block at the end of the window (R5.41–R5.43) |
| `round-06` | explicit index at restore scale, 100–300 tabs, all three settings |
| `round-07` | the `hidden` flag on what `tabs.move` resolves with, ungroup/hide of an active member, membership at creation next to a span, array move onto a member slot, ungroup of a hidden member |
| `round-08` | MANUAL: mouse and menu gestures on native groups — which events each gesture emits. Fully attended: every test waits for a gesture and a `T.visualAnswer('done')` |
| `round-09` | MANUAL: windows born from moved tabs (move group to new window, drag out, `windows.create({tabId})`) and undo-close restore — `windows.onCreated` vs the attaches, the initial tab, fresh ids, hidden tabs on both trips |
| `round-10` | API pinning: what `tabs.update({pinned})` does to native-group membership, session values and the active state; where `tabs.create` with an index inside the pinned block lands; R10.03 and R10.05 are MANUAL — they need a microphone permission grant; R10.05 moves the tab with the live microphone into another window and back and reports whether the capture survived |
| `round-11` | `browser.menus` registration lifecycle: duplicate ids, cascade removal, `removeAll`, bookmark context vs the optional `bookmarks` permission; R11.06 is MANUAL — permission grants and 👁️ looks at a bookmark's context menu |
| `round-12` | delivery timing of `tabs.onAttached`/`onDetached` against the `tabs.move()` resolve: paced and rapid cross-window ping-pong, hidden and discarded arrays, a move-then-show chain |
| `round-13` | removing the last VISIBLE tabs of a window that still holds hidden ones: does the window survive, which hidden tab is revealed, which events announce it; pinned and discarded variants |
| `round-14` | `tab.openerTabId`: set by `tabs.create` / `tabs.update`, cleared with `-1`, the events; what survives hide/show, discard, same-window and cross-window moves, the opener's removal, a browser restart (R14.08); an update to the opener a tab already has, and the saved links applied again after a restart (R14.09–R14.10); tabs created without an opener and linked afterwards — in parallel, one by one, in reverse, and sorted back after linking (R14.11–R14.14); a change of openerTabId alone against `tabs.onUpdated` listeners — the STG `properties` filter and no filter, and whether openerTabId is accepted as a filter value at all (R14.15); the opener leaving the window while the child stays, the child following, and what `tabs.get` reports right inside onDetached/onAttached (R14.16); a pin on a tab with an opener and a child — do the links to and from it survive the pin, a link set on and onto the pinned tab, a tab created with the pinned opener, a `-1` on the pinned tab and on its child, what unpin brings back (R14.17). Meant to be run twice — clean profile, and a profile with Tree Style Tab and no STG |
| `round-15` | a plain array `tabs.move` to an explicit index, no native groups — the calls `Tabs.ensureSorted` makes to collect a group into a block: gathered at the first mover's own slot with the rest beyond it and a hidden outsider block in between (R15.01), a reversed set gathered at its smallest index (R15.02), movers standing before the target (R15.03) and on both sides of it (R15.04) |
| `round-16` | what `tabs.create({openerTabId})` accepts — the opener states a recreate path meets: a hidden / hidden+discarded / discarded opener at an explicit index takes the link (R16.01), an opener in another window rejects the call in both directions (R16.02), a removed opener rejects it too (R16.03), a discarded create carries the link (R16.04); BEHAVIOR-OPENER.md §11–§13 |
| `round-18` | `sessions.restore()` and `tab.openerTabId` — the API behind Ctrl+Shift+N / Ctrl+Shift+T: a closed window brought back — what the fresh tabs report as their opener, what the session record itself carries, the hidden member on the way back (R18.01); a closed tab restored while its opener is still alive with the same id (R18.02) |
| `round-19` | browser shutdown seen from inside the addon: are `tabs.onRemoved {isWindowClosing}` / `windows.onRemoved` delivered while the process goes down, does the storage.local get → set chain started in `windows.onRemoved` land (the STG `tabsToRestore` path), do API calls still answer; R19.01 stops and asks to quit the browser completely |
| `round-20` | what `tabs.create` accepts and what a page of the add-on may navigate to: the url classes it refuses and with which error, and what a create without url opens (R20.01), the accepted classes in a non-default container (R20.02), which `data:` content types a top-level `location.replace` from an extension page reaches (R20.03), `getBackgroundPage()` from an extension page in the default and in another container, and whether the background's `getViews` sees it (R20.04), the exact byte limit of a `tabs.create` url, bytes versus characters (R20.05), which schemes a `webRequest` main_frame listener sees (R20.06), whether a page can still navigate to a url over the limit and hold it as its tab url (R20.07), what `searchParams.set`, the `search` setter and the `URL` constructor do when asked for an address over the limit, built the way the add-on builds the address of its stub page (R20.08). Needs the `cookies`, `contextualIdentities`, `webRequest` and `<all_urls>` permissions, creates and removes its own container |
| `round-21` | the first load of a NEW tab: the order of `tabs.onCreated` and a blocking `webRequest.onBeforeRequest`, the distance between them, what `tabs.get` and `sessions.setTabValue` report from inside the request listener, and whether `tabs.onCreated` and the resolve of `tabs.create` still arrive while the listener holds the request. A tab from `tabs.create` (R21.01), the same under a hold (R21.02), `window.open` from a page of the add-on (R21.03). R21.04 and R21.05 are MANUAL, a middle-click on a link in a page of the add-on and in a web page. Needs the `webRequest`, `webRequestBlocking` and `<all_urls>` permissions |
| `round-22` | a window appears: what its active tab reports from `windows.onCreated` until the first page is loaded, sampled every `TIGHT_POLL_WAIT`, with the state at `WINDOW_READ_WAIT` marked as the moment STG reads a new window. `windows.create` with one http url (R22.01), with three (R22.02), without a url (R22.03), and a closed window brought back by `sessions.restore` (R22.04) |
| `round-23` | a tab that is being removed, seen through `tabs.query` (bugzilla 1396758): is it still returned from inside `tabs.onRemoved`, at the resolve of `tabs.remove`, and for how long after (R23.01); does a closing tab still occupy an index slot for `tabs.create` — a create from inside the onRemoved handler at the count WITH the closing tab (R23.02) and WITHOUT it (R23.03), the closing tab standing in the middle so the two hypotheses land in different slots; the same WITHOUT-count create when the removed tab was the ACTIVE one (R23.04); the addon's own shape — `tabs.remove` awaited, then the WITHOUT-count create (R23.05); R23.06 and R23.07 are MANUAL — the user closes the tab with the close button of an inactive tab and with Ctrl+W on the active one, the gestures the bug report ties to the closing animation, with the same sampling and the same WITHOUT-count create from the handler. BEHAVIOR-REMOVE-TABS.md §3 and §4: the appending index of `Tabs.createMultiple` / `Tabs.resolveMoveIndex` is the browser's own count, a read that filters closing tabs out lands one short after a user's close |
| `round-24` | `sessions.setTabValue` values across `sessions.restore()`: does the value set on the closed tab's old id come back on the fresh one, and is it readable already inside `tabs.onCreated` — a single closed tab (R24.01); a closed window with a loaded active tab, a background tab that comes back discarded and a hidden member (R24.02); a `setTabValue` from inside `tabs.onCreated` of the restored tab against the value the restore brings, the shape of the STG onCreated handler (R24.03); a `sessions.setWindowValue` value across the restore of its window, probed from every `tabs.onCreated` of the restored window and from `windows.onCreated` (R24.04) |
| `round-25` | `storage.onChanged` for a key of `storage.local`: the change object of the FIRST write (is `oldValue` absent or present as undefined), of the same value written again, of a change and of a removal, as seen by `storage.onChanged` and by `storage.local.onChanged`; one test per value type — boolean (R25.01), string (R25.02), number (R25.03), array (R25.04), object (R25.05). The facts behind `Storage.isChangedKey` |
| `round-26` | the calls `Tabs.hide` / `Tabs.remove` / `Tabs.recreate` make, BEHAVIOR-TABGROUPS.md §22–§26: `tabs.ungroup` of a tab in NO group, alone (R26.01) and mixed with a member (R26.02), of a PINNED tab, alone (R26.03) and mixed with a member (R26.04); `tabs.group({tabIds, groupId})` joining an EXISTING group — the tab right before the span (R26.05), right after it (R26.06), far before it (R26.07), a tab that already is a member (R26.08), an array from both sides of the span, reversed (R26.13); `tabs.hide` of an already hidden tab, alone and mixed with a visible one (R26.09); `tabs.create` at the slot of a SINGLE-member span (R26.10). R26.11, R26.12, R26.14 and R26.15 are MANUAL — 👁️ whether the browser keeps a saved group when every member of a live group is closed by one `tabs.remove` (R26.11), when the members are ungrouped first (R26.12), when they are closed one by one (R26.14), and the positive control, a window with a live group closed by `windows.remove` (R26.15); every saved group they leave behind is deleted by hand before the answer |
| `round-27` | reader mode and extension pages through the tabs API: `tabs.create` with `openInReaderMode` on an article, what the tab reports at the resolve, once loaded, after `tabs.discard` and after activation (R27.01), the same tab created `discarded` (R27.02), the flag on a page that cannot be put into reader mode (R27.03), on `view-source:`, an own extension page, `about:blank` and no url (R27.04), in a non-default container (R27.05); `tabs.update` with an `about:reader` url and `tabs.create` with one that wraps `view-source:` (R27.06); `tabs.toggleReaderMode` on an article and on a page that cannot be put into reader mode, with the urls a `webRequest` main_frame listener and `tabs.onUpdated` deliver (R27.07); a reader tab brought back by `sessions.restore` (R27.08) and by a browser restart (R27.09, stops and asks for it); `management.getSelf().hostPermissions` against the extension's own origin, and `tabs.create` with a `moz-extension://` url of an unknown uuid and of an extension id (R27.10); R27.11 is MANUAL — the reader-mode button (F9) pressed by hand on the shown article, to enter the reader view and to leave it, with the same listeners armed; reader tabs hidden and discarded right after their creation, before and after the reader url has committed, the shape of `Groups.settleTabs` on an unloaded group (R27.12); what the `URL` constructor makes of an extension page address that names the extension by its id, for every shape an id takes (R27.14); `tabs.update` with a url on a discarded tab — born discarded, discarded after its load, hidden, and born on a page of an unknown uuid, shown and hidden (R27.15). BEHAVIOR-CREATE-TABS.md §30–§35, §40, §41, §53. Needs the network: the article is a real page (`READER_URL`) |
| `round-28` | other add-ons in the profile. **Not a part of `T.start()`**: run it by name, `T.start('round-28')`, in a profile prepared for it — two more add-ons next to the harness, one enabled and one disabled, STG not among them; the enabled one has an options page. `management.getAll()` for a disabled and for an enabled extension (R28.01); the `manifest.json` of another enabled extension opened by `tabs.create`, by `tabs.update` and by `location.replace` from a page of the harness (R28.02); the same opened by `tabs.update` that a page of the harness calls on its own tab, in the default container and in another one (R28.03); whether `management.getAll()` lists the calling extension itself (R28.04); R28.05 is MANUAL — `management.onDisabled` and `onEnabled` as the background and a page of the harness in a background tab, in a container and in a hidden tab get them, with what `management.getAll()` reports to each at the event, `MANAGEMENT_READ_WAIT` later and `LOAD_WAIT` after that, and how long a `setTimeout` of `MANAGEMENT_READ_WAIT` takes in each context; the `manifest.json` created `discarded` and then activated (R28.07); `tabs.update` called by a page as soon as its script runs, and by a page in a hidden tab (R28.08); R28.10 is MANUAL — the tabs on the options page of an extension the user disables, a page that runs the code of the extension: a loaded, a discarded, a hidden and a hidden discarded one, what is there once it is enabled again, the management events the background gets and whether the extension keeps its uuid; the options page opened by `tabs.create`, created `discarded` and activated, and by `tabs.update` a page of the harness calls (R28.12); what `management.getAll()` tells about every extension at the first line of a background that starts with the browser, and at which ms a later read first tells something else, with the windows there are at that line and whether `runtime.onStartup` comes (R28.13, stops and asks for a restart, needs the harness installed in the profile); R28.14 is MANUAL — `management.onUninstalled` and `onInstalled` as the background and a page of the harness in a background tab and in a hidden tab get them, with what `management.getAll()` reports to each at the event and after it, the add-on is removed and installed again by hand; R28.11 is MANUAL and stands last on purpose — the same tabs of an extension the user removes, the add-on has to be installed again afterwards. A MANUAL test names the add-on the user has to act on and checks through `management.getAll()` that the step was made. BEHAVIOR-CREATE-TABS.md §36, §37, §39, §43, §44, §46–§50, §55, §57. Needs the `management` permission |
| `round-29` | the urls `bookmarks.create` takes: every url class a saved tab can hold — http, `about:reader`, `about:blank`, `about:config`, `file:`, `data:`, `javascript:`, `view-source:`, an own extension page, an extension page of an unknown uuid and of an extension id in every shape, a url without a scheme — which are accepted, which are refused and with what error, and whether the created node and `bookmarks.getChildren` give the url back as it was passed (R29.01). MANUAL: the `bookmarks` permission is granted on the page the test opens. The bookmarks live in a folder the test makes in Other Bookmarks and removes at the end. BEHAVIOR-CREATE-TABS.md §42 |
| `round-30` | what a blocking `webRequest` listener learns about who asked for a load; the loads go to an https address of a host no server answers for, so nothing but the request itself decides the outcome. What a tab on such an address reports when nobody listens, for a made-up top-level domain and for a reserved one (R30.01); which requests reach the listener and what they say about who asked — `tabs.create`, `tabs.update`, `location.replace` of a page of the add-on, a script of a web page that sets its location, a web address a listener redirects (R30.02). BEHAVIOR-CREATE-TABS.md §51, §52. Needs the network for the web page of R30.02 |
| `round-31` | what `runtime.MessageSender` tells the background about who sent a message: a page of the add-on in a tab, and the content script the manifest declares — the way the add-on declares its own, for every frame and for `about:blank` — in the main frame of a web page, in a frame of the same site and in an `about:blank` frame; each sends a message and opens a port, and the background prints the keys of the sender, whether the id is the add-on's, the url, the tab, the frame, the envType, and whether the url starts with the origin of the add-on (R31.01). No popup of a toolbar button and no sidebar among the senders: the harness has neither. BEHAVIOR-CREATE-TABS.md §56. Needs the network: the web page is `https://example.org/` |
| `round-32` | `sessions.setTabValue` values across `tabs.move`: a loaded tab moved to another window, the control (R32.01); a DISCARDED tab moved to another window (R32.02); a discarded tab moved inside its own window (R32.03); three hidden + discarded tabs moved to another window as an array, an unloaded group of the add-on (R32.04); a discarded tab moved to another window, its values written again and moved back (R32.05). The values are read at the resolve of the move, after quiet and `LOAD_WAIT` later, then written again and read back — the repair `Tabs.moveNative` makes |

## Files

| file | what is in it |
| - | - |
| `constants.js` | every constant and timing |
| `test.js` | `class Test` — the table, notes, questions, events, `expect`, the report. Knows nothing about tabs |
| `tabs.js` | `class TabsTest extends Test` — windows, tabs, groups, and the `tabs.*` / `tabGroups.*` event formatters; `withContainer`, a container that lives for one test |
| `opener.js` | `class OpenerTest extends TabsTest` — the opener suffix in every cell (`c1→p`), opener readers and setters, `tryStep` for a call that may be refused; shared by the opener rounds |
| `menus.js` | `class MenusTest extends Test` — `browser.menus` wrappers that return `{ok, error}`, existence probing, the `bookmarks` permission helpers; `requireBookmarks(t)` for a test of any class — it opens the grant page when the permission is missing, waits for the answer and aborts the test without the permission |
| `storage.js` | `class StorageTest extends Test` — formatters for `storage.onChanged` and `storage.local.onChanged` printing every change object property as absent or as type and value; every action goes into the event log as its own line, there is no state table |
| `management.js` | what `management.getAll()` reports for an extension (`hosts`, `ownOrigin`), `probe` — whether a context reaches `management.getAll` and `storage.session`, `watch` — every management event of a context with three reads of `management.getAll()` next to it, each with the ms from the event it started at, and the ms a `setTimeout` of `MANAGEMENT_READ_WAIT` took there; shared by round-28 and the page below |
| `startup.js` | the first import of `harness.js`: a probe a test arms before a browser restart, run once as the first thing the background does at its next start — what `management.getAll()` tells at the first line and at which ms a later read first tells something else, the windows there are, whether `runtime.onStartup` and `windows.onCreated` come; `arm` and `take` for the test, round-28 |
| `sender.html` + `sender.js` | a context that tells the background who it is, by `runtime.sendMessage` and by a port of `runtime.connect`. `sender.js` is the content script the manifest declares for `https://example.org/*`, for every frame and for `about:blank`; in a scene tab it adds a frame of the same site and an `about:blank` frame to the page. `sender.html` loads the same file as a page of the add-on, round-31 |
| `grant.html` + `grant.js` | the page R11.06 and R29.01 open — a button that calls `permissions.request` from a real user click |
| `sessions.js` | `sessions.getRecentlyClosed` helpers: the session ids known before a close, the record of a window or a tab closed by the test, shared by the rounds that restore through the API |
| `harness.js` | the runner, checkpoints, `globalThis.T` |
| `tab.html` + `tab.js` | the page every scene tab loads — it names itself from `?tab=` so the tab strip shows the tab's test name |
| `navigate.html` + `navigate.js` | a page that calls `location.replace(?to=)` as soon as it loads, round-20 and round-28 use it to see which top-level navigations the browser lets an extension page make, round-27 takes it as a second page of the add-on. On a `{action: 'navigate'}` message it calls `location.replace` on the address of the message, on `{action: 'update'}` it calls `tabs.update` on its own tab and replies whether the call resolved. With `?update=` it makes the same `tabs.update` as soon as its script runs and reports only a refusal, `runtime.sendMessage({navigate, error})`: an accepted update takes the page away |
| `management.html` + `management-page.js` | a page that runs `probe` and `watch` of `management.js` in its own context and sends every report to the background with `runtime.sendMessage({management})`, round-28 opens it in the default container, in another one and in a hidden tab |
| `link.html` + `link.js` | a page with one link to `?to=`, for a user's middle-click. On a `{action: 'open'}` message it calls `window.open` on the same address and replies whether the browser returned a window, round-21 |
| `probe.html` + `probe.js` | a page that asks for the background page (`runtime.getBackgroundPage`, `extension.getBackgroundPage`, `getViews`) and reports the answers to the background with `runtime.sendMessage`, round-20 opens it in the default container and in another one |
| `results.html` + `results.js` | the report page — it reads the last run out of `localStorage` itself |

A round for another API brings its own domain class next to `tabs.js` and names it:
`export const testClass = BookmarksTest`. Everything in `test.js` works as it is.

## Writing a round

A round is a module exporting an array called `tests`:

```js
import {LOAD_WAIT} from '../constants.js';

export const tests = [
    {
        id: 'R7.04',
        title: 'something — what it shows',
        async run(t) {
            await t.scene(['x1', 'gr1', 'gr2', 'x2']);
            await t.group(['gr1', 'gr2']);

            t.watch(['tabs.onMoved', 'tabs.onUpdated']);
            await t.snap('before');

            await t.step('tabs.move(x1, {index: 2})', () => browser.tabs.move(t.id('x1'), {index: 2}));

            t.expect('x1 joined the group', (await t.query())[1].groupId !== -1, true);
        },
    },
];

export const note = 'preconditions…';    // optional, printed above the round
export const gap = BATCH_GAP * 2;        // optional, ms between tests, default BATCH_GAP
export const quiet = OTHER_ADDON_WAIT;   // optional, ms of silence before a step counts as settled, default QUIET_WAIT
export const testClass = TabsTest;       // optional, default TabsTest
export const url = 'https://example.com/';  // optional, what the scene tabs load
```

Scene tabs load `tab.html` from the add-on itself, which names itself from `?tab=` — clicking a tab
to read its url does not change the stand. A test that needs a real site instead sets `url` on
itself (`{id: 'R8.01', url: 'https://example.com/', …}`) or the whole round sets the default above;
either way the name still travels in `?tab=` and everything else works unchanged.

- **A test goes into the round it shares its logic with** — an existing round that fits, or a new
  one when none does. The assistant decides the placement on its own, without asking.
- **The assistant also designs the tests on its own** — which scenes, states and events to cover —
  without asking the developer. To run a round, the assistant hands the developer just the bare
  command (`T.start('round-12')`) — the developer knows the setup, no need to re-explain it — and
  the developer sends back the report; the facts it establishes are then written into
  `docs/BEHAVIOR-*.md`.
- **The id is written, never computed.** Docs point at ids; a counter would shift every marker below
  an inserted test.
- **No timings and no urls spelled out.** Everything shared comes from `constants.js`, and `t.step`
  waits for the browser to go quiet by itself.
- **A test that needs a browser restart** splits into `run(t)`, which builds the scene and ends with
  `await t.restart()`, and `afterRestart(t)`, which measures. The window is found again by the names
  in the tab urls; the table continues in the same report.
- **A window a test opens with a raw API call** is either put into `openedWindows`
  (`openedWindows.add(win.id)`) — then the harness closes it when the test ends, like the ones it
  opened itself — or closed by the test.
- **Never put a foreign window into `openedWindows`.** That set marks windows as the harness's own,
  and the harness CLOSES everything in it, when the test ends and again before the next one —
  including the user's main browser window, if a test grabbed it while enumerating
  `windows.getAll()`. Add only windows the test itself created; to inspect a window some gesture
  produced, locate it from a tab you know:

  ```js
  // wrong: brands every other window as ours - the cleanup closes them all, user's window included
  for (const win of await browser.windows.getAll()) {
      if (win.id !== t.win) openedWindows.add(win.id);
  }

  // right: find the exact window the gesture moved the tab into
  const movedTo = (await browser.tabs.get(t.id('gr1'))).windowId;
  ```

## API

`T` is the console surface:

| call | what it does |
| - | - |
| `T.start()` / `T.start('round-05')` / `T.start('round-01', 'round-07')` | run every round, one round, or a few |
| `T.start('round-05:R5.01')` | run only the named tests of a round |
| `T.visualAnswer('…')` | answer the 👁️ question the run is waiting on |
| `T.continue()` | pick a run back up after a restart, a reload or a crash |
| `T.stop()` | end the run after the current test, keep the report |
| `T.forget()` | drop a stuck checkpoint |
| `T.logs()` | open the last report again |
| `T.report('after restart')` | dump every normal window on demand — names come back from the tab urls |

Imported by a round from `../constants.js`:

| import | what it is |
| - | - |
| `TAB_GROUP_ID_NONE` | `-1`, the groupId of an ungrouped tab |
| `SCENE_URL` | `moz-extension://…/tab.html`, the page every scene tab loads — local, so a run needs no network and never touches a real site |
| `NAVIGATE_URL` | `moz-extension://…/navigate.html`, the page that navigates itself to `?to=` |
| `MANAGEMENT_URL` | `moz-extension://…/management.html`, the page that reports the management events it gets |
| `SENDER_URL` | `moz-extension://…/sender.html`, the page that tells the background who it is |
| `CONTENT_SCRIPT_URL` | the site the manifest declares the content script for, read from the manifest |
| `NETWORK_URL` | the site a test loads when it deliberately needs a real page instead |
| `READER_URL` | a real article the browser can put into reader mode |
| `SQUARES` | the group markers used in the tables |
| `NEW_TAB_POSITIONS` | all three `newTabPosition` values |
| `QUIET_WAIT` 200 | how long nothing may happen before a step counts as settled |
| `OTHER_ADDON_WAIT` 2000 | the same window for a round that studies another add-on's reaction — it acts with a delay of its own (`export const quiet`) |
| `POLL_WAIT` 250 | how often the harness re-checks while waiting |
| `TIGHT_POLL_WAIT` 25 | how often a stress loop re-checks while draining its own events |
| `ACTION_WAIT` 500 | the old fixed pause, for a step that wants a number |
| `HOLD_WAIT` 500 | how long a blocking `webRequest` listener keeps a request suspended when the hold itself is the subject |
| `WINDOW_READ_WAIT` 1000 | how long STG waits after `windows.onCreated` before it reads the new window, the moment a round marks in its samples |
| `MANAGEMENT_READ_WAIT` 50 | how long STG waits after a management event before it reads `management.getAll()`, the moment a round reads at |
| `BACKGROUND_TAB_TIMER` 1000 | what the browser holds a timer of a page in a background tab back to, BEHAVIOR-CREATE-TABS.md §44 |
| `LOAD_WAIT` 2000 | a real page load, where the number is the fact |
| `SETTING_WAIT` 100 | a `browserSettings` write to land |
| `SETTLE_TIMEOUT` 20000 | when waiting gives up and says so in the report |
| `BATCH_GAP` 1500 | between two tests |
| `BOOKMARKS_PARENT_ID`, `BOOKMARKS_FOLDER` | Other Bookmarks, and the name of the folder a test keeps its bookmarks in until it ends |

From `../test.js`: `wait(ms)`. From `../tabs.js`: `sceneUrl('a')` and `nameFromUrl(url)` — name to
url and back, the reason a tab stays identifiable across a restart.

The `t` passed to a test:

| call | what it does |
| - | - |
| `t.scene(['a', 'b', 'c'])` | opens a window with these tabs in this order, waits until they are all loaded, **asserts the order** and aborts on mismatch |
| `t.buildWindow(['w'])` | opens one more window with these tabs in this order, asserts the order and returns the window id; the harness closes it when the test ends |
| `t.step('tabs.move(…)', fn)` | resets the event clock, writes the action row, runs `fn`, waits for the browser to go quiet, snapshots, returns what `fn` returned |
| `t.step(…, {wait: 0})` / `{wait: LOAD_WAIT}` / `{snap: false}` | no pause at all for speed and race tests, a fixed pause, or no snapshot |
| `t.snap('before')` / `t.act('…')` | a state row / an action row, for the cases `t.step` does not fit |
| `t.settled()` | wait for quiet without an action |
| `t.group(['b','c'], props)` / `t.joinGroup(names, groupId)` / `t.ungroup` / `t.hide` / `t.show` / `t.activate` | the API call plus a settle; pass `{settle: false}` inside a `t.step`. `t.group` and `t.joinGroup` return the group id the call resolved with, `t.hide` the ids it actually hid |
| `t.create('new1', props)` / `t.createMany([{name, index, active}])` | one tab / a parallel batch, both marked ➕ in the table |
| `t.expect('label', actual, expected)` | records OK or MISMATCH and counts into the run summary |
| `t.expectRow('after', ['a*', '🟥 b', 'c(h)'])` | the same, against a snapshot row — this is how a table recorded in the docs is asserted |
| `t.require('label', ok, detail)` | a precondition — aborts the test |
| `t.ask('…')` | stops the run and waits for `T.visualAnswer('…')` |
| `t.restart()` | checkpoint, ask for a browser restart, continue in `afterRestart` |
| `t.setting('newTabPosition', 'atEnd')` | sets a browser setting and reports what actually applied; the harness restores it after the test |
| `t.note('…')` | a line under the table |
| `t.mask = text => …` | every event line goes through it before it is written — for what must never reach a report, a uuid |
| `t.query()` / `t.groupsInfo()` / `t.hiddenFlags()` / `t.cell(tab)` | the window as the API sees it |
| `t.snapWindow('label', windowId)` | a state row of another window the test built or a gesture produced |
| `t.settleRestored(windowId, names)` / `t.bindFresh(tabs)` / `t.bindAsOld(tabs)` | a window repopulated by `sessions.restore`: wait for the named tabs and for quiet, then read the window again; bind the fresh tabs by the names in their urls; rename the dead pre-close ids to `old-…` |
| `t.id('name')` / `t.ids([…])` | real tab ids, for a raw API call — they never reach the printed output |

`t.query()` uses `tabs.query`, not `windows.getAll({populate: true})` — only the former is known to
return hidden tabs.
