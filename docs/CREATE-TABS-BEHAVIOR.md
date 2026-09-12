# Reference: creating tabs and the newTabPosition setting (`tabs.create`)

Verified live on Firefox 154–155 (August 2026) with a throwaway test add-on, in a clean profile
with no other add-ons. All tests — without pinned tabs; the one exception is §13, whose subject is
the pinned block itself. Every fact here is one browser build on one machine; a claim is as strong
as the runs cited next to it, and no stronger.

Only facts confirmed by an actual test run belong in "Verified facts" — never assumptions about how
the browser "probably" works. Native tab group facts — including the membership of created tabs —
live in TABGROUPS-BEHAVIOR.md (§7, §10 there). A copy lands here only when creation next to native
groups behaves differently from what this document itself states.

State tables, markers, confirmation rules and how the tests are written — BEHAVIOR-NOTATION.md.

**A new fact is appended as the next number at the end of "Verified facts". Numbers are never
renumbered or reused** — code comments reference them by number
(`docs/CREATE-TABS-BEHAVIOR.md §4-5`, `§11`).

Mapping between the setting and prefs (the same thing `browser.browserSettings.newTabPosition`
reads/writes):

| newTabPosition | prefs |
| --- | --- |
| `afterCurrent` | `browser.tabs.insertAfterCurrent = true` |
| `relatedAfterCurrent` (browser default) | `browser.tabs.insertRelatedAfterCurrent = true`, `insertAfterCurrent = false` |
| `atEnd` | both false |

An extension holding the `browserSettings` permission can set this itself —
`browserSettings.newTabPosition.set({value})` applies immediately and reports
`levelOfControl: "controlled_by_this_extension"`; `.clear({})` gives the browser its default back,
which is `relatedAfterCurrent`. Tests switch it themselves; nothing is toggled by hand. (R1.01)

---

## Verified facts

### 1. relatedAfterCurrent behaves exactly like atEnd for tabs without an opener (R5.18–R5.23)

Under `relatedAfterCurrent` every pattern below produced the same result as under `atEnd` — end of
window, call order preserved, explicit index respected. The tabs `Tabs.createMultiple` creates
never carry an opener at creation — the link is applied afterwards by `Tabs.applyOpeners`
(OPENER-BEHAVIOR.md) ⇒ for them **relatedAfterCurrent is equivalent to atEnd**. Hence also: the
fallback "no permission for `browserSettings` → assume atEnd" exactly matches the browser's
default behavior. With an opener in the call the picture changes — §14: the one path that passes
an opener at creation is a deliberate single-tab call whose opener is alive in the same window
(the temporary-container menu item); a re-created tab is created clean and linked afterwards
(`Tabs.recreate`).

### 2. An explicit `index` overrides newTabPosition completely (R5.09–R5.11, R5.15–R5.17, R5.21–R5.23, R5.28–R5.34)

This is the strongest fact in this document. **Every tab landed at exactly its requested index, in
every single run** — 21 runs, zero deviations:

| batch | settings covered | with an `active: true` tab | runs |
| - | - | - | - |
| 3 | all three | both with and without | R5.09/R5.10, R5.15/R5.16, R5.21/R5.22 |
| 5 | `afterCurrent` | with | R5.28–R5.31 |
| 10 | `afterCurrent` | with | R5.32–R5.34 |
| 30, really loading | `afterCurrent` | without | R6.08 |
| 100 | all three | both with and without | R6.01–R6.06 |
| 300 | `afterCurrent` | without | R6.07 |

The clamp runs below are counted separately: there the requested index is out of range on arrival.

The 30-tab run is the odd one out on purpose — every other large batch is created `discarded`, so it
shows the clean ordering is not an artefact of skipping the load.

| tab index | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
| - | - | - | - | - | - | - | - | - | - | - |
| before | s0 | w1 | w2* | w3 | w4 | | | | | |
| `Promise.all` of 5 creates with index 5..9, n2 has `active: true` — under `afterCurrent` | | | | | | | | | | |
| after | s0 | w1 | w2 | w3 | w4 | ➕n0 | ➕n1 | ➕n2* | ➕n3 | ➕n4 |

One out-of-order sequence was tested, and it self-healed through clamp — a window of 2 tabs,
creating with index 4, then 2, then 3, gives the same result under all three settings
(R5.11, R5.17, R5.23). The too-large index 4 is clamped to the end of the window, and the two later
calls push that tab back out to 4:

| tab index | 0 | 1 | 2 | 3 | 4 |
| - | - | - | - | - | - |
| before | a* | b | | | |
| `create(index: 4)`, then `create(index: 2)`, then `create(index: 3)` | | | | | |
| after | a* | b | ➕i2 | ➕i3 | ➕i4 |

That is the only out-of-order sequence anyone has run, so it says nothing about out-of-order calls
in general. For **increasing** indexes — which is what the add-on always sends — there is no known
exception. See §11 for the claim this replaced.

### 3. Hidden tabs occupy the window's index space (R5.02)

`tabs.create` with an index inside a hidden block inserts the tab exactly there, and the new tab is
of course visible:

| tab index | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
| - | - | - | - | - | - | - | - |
| before | t1* | t2(h) | t3(h) | t4(h) | t5 | t6 | |
| `tabs.create({index: 2})` | | | | | | | |
| after | t1* | t2(h) | ➕inserted | t3(h) | t4(h) | t5 | t6 |

The foundation for creating tabs in unloaded groups by anchor.

### 4. afterCurrent without index: every new tab goes right after the active one, so a batch comes out REVERSED (R5.12, R5.13, R5.38–R5.40)

`afterCurrent` inserts each new tab at "index of the active tab + 1". The active tab does not move,
so each new tab pushes the previous ones further right and the batch ends up in **reverse call
order**:

| tab index | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
| - | - | - | - | - | - | - | - | - | - | - |
| before | s0 | w1 | w2* | w3 | w4 | | | | | |
| `Promise.all([create(n0) … create(n4)])` — no index | | | | | | | | | | |
| after | s0 | w1 | w2* | ➕n4 | ➕n3 | ➕n2 | ➕n1 | ➕n0 | w3 | w4 |

**`Promise.all` and a sequential `await` loop give identical results** (R5.12 vs R5.13) — the
mechanism is the insertion point, not the concurrency. Three repetitions produced byte-identical
output: this is deterministic, not a race.

### 5. afterCurrent without index + `active: true` on a batch tab → that tab becomes the anchor (R5.14, R5.35–R5.37)

The tab created with `active: true` becomes the window's active tab the moment it appears, so every
tab created **after** it is inserted right after **it** rather than after the original active tab:

| tab index | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
| - | - | - | - | - | - | - | - | - | - | - |
| before | s0 | w1 | w2* | w3 | w4 | | | | | |
| `Promise.all` of 5 creates, no index, n2 has `active: true` | | | | | | | | | | |
| after | s0 | w1 | w2 | ➕n2* | ➕n4 | ➕n3 | ➕n1 | ➕n0 | w3 | w4 |

Step by step: n0 lands at 3; n1 lands at 3 and pushes n0 to 4; n2 lands at 3, pushes n1 and n0
right, and becomes active; n3 now lands at 4, right after n2; n4 lands at 4 and pushes n3 to 5.
The result reads as "the activating tab first, then everything else in reverse call order", and it
reproduced identically three times out of three.

### 6. Without an explicit `windowId` the target is the last active window (R5.24)

With a scene window in the background and another window freshly focused, `tabs.create` without
`windowId` put the tab in the **focused** window, leaving the scene window untouched. The add-on's
standard is still explicit windowId+index for bulk creation.

### 8. `windows.create({url: [...]})` preserved the array order in every run (R5.04, R5.26)

13 attempts — three with 5 urls, ten with 8 urls — all came back in the requested order.

An earlier note in this document claimed the opposite, with examples of scrambled windows
(`w1 w5 w2 w3 w4`). **That did not reproduce, not once.** The claim is withdrawn: it is either
fixed, or it depended on something these runs did not have.

This is *not* a promise of ordering — the API does not document one, and 13 clean runs cannot prove
a negative. STG creates its own windows empty (`windows.create()` + `Groups.apply`) and fills them
with explicit indexes, which is immune either way; keep it that way.

### 9. afterCurrent works in a non-focused window when windowId is explicit (R5.25)

With another window holding the focus, a tab created with an explicit `windowId` and no index still
landed immediately after the **target** window's active tab:

| tab index | 0 | 1 | 2 | 3 | 4 |
| - | - | - | - | - | - |
| before | w1 | w2 | w3* | w4 | |
| `tabs.create({windowId: sceneWindow})` — no index, that window not focused | | | | | |
| after | w1 | w2 | w3* | ➕n0 | w4 |

### 10. Parallel creation is consistently faster, by roughly 1.8x (R5.05, R5.27)

Discarded tabs, measured in both orders so the warm-up cost falls on each side in turn:

| batch | parallel | sequential | ratio |
| - | - | - | - |
| 30 tabs, parallel first | 35 ms | 110 ms | 3.1x |
| 30 tabs, sequential first | 43 ms | 50 ms | 1.2x |
| 100 tabs, parallel first | 98 ms | 166 ms | 1.7x |
| 100 tabs, sequential first | 98 ms | 172 ms | 1.8x |

At 30 tabs the measurement is noise; at 100 it is stable at **1.7–1.8x**. Parallel wins in every
single pass, so `Promise.all` remains the rule for bulk creation — it costs nothing and is never
slower.

**Only the ratio travels; the milliseconds do not.** These runs are from a fast machine, and STG has
users restoring 1000+ tabs on hardware from 2016. An earlier note here extrapolated "minutes of
delay" from numbers like these — that extrapolation was never measured and is not a fact. What is
measured is that the sequential path costs about 1.8x more of whatever a tab costs on the machine in
front of you, and that multiplier is exactly what hurts most on the slow ones.

### 11. `active: true` does NOT break an explicit index (R5.10, R5.16, R5.22, R5.28–R5.34)

An earlier version of this document claimed that under `afterCurrent` and the default
`relatedAfterCurrent` an activating tab ignores its own index, lands right after the former active
tab and scatters the whole batch, and that only `atEnd` respects index fully.

**None of that reproduced.** Batches of 3 and of 100, each with explicit indexes and one
`active: true` in the middle, placed every tab exactly where asked under all three settings
(R5.10/R5.16/R5.22, R6.04–R6.06), and batches of 5 and 10 did the same under `afterCurrent` in all
seven attempts (R5.28–R5.34). See the table in §2. The claim is withdrawn.

`active: true` only matters when there is **no** explicit index — that is §5.

### 12. A tab is created with `about:blank`, the real `url` arrives later (R5.01)

`tabs.create` resolves with `url: "about:blank"`, and `tabs.get` still reports `about:blank`
immediately after — whatever the url was. How long it stays blank is what differs:

| requested url | at `create` | immediately after | after 200 ms | after a further 2 s |
| - | - | - | - | - |
| a page of the add-on itself | `about:blank` | `about:blank` | the real url | the real url |
| `https://example.com/` | `about:blank` | `about:blank` | `about:blank` | the real url |

When within those 2 s the network page's url arrived was not measured. Any code that filters tabs by
url has to wait, and must not take the local timing as the general case.

### 13. An explicit index inside the PINNED block clamps to the first unpinned slot (R10.04)

An unpinned tab cannot be created before pinned tabs: with `p1`, `p2` pinned at 0 and 1, both
`tabs.create({index: 0})` and `tabs.create({index: 1})` landed at **index 2** — the first unpinned
slot, not "requested + 1". The resolved Tab object, a fresh `tabs.get` and `tabs.onCreated` all
report the final index right away; no `tabs.onMoved` follows.

| tab index | 0 | 1 | 2 | 3 | 4 | 5 |
| - | - | - | - | - | - | - |
| before | p1*(p) | p2(p) | a | b | | |
| `tabs.create(n0, {index: 0})` — the slot of pinned p1 | | | | | | |
| after | p1*(p) | p2(p) | ➕n0 | a | b | |
| `tabs.create(n1, {index: 1})` — the slot of pinned p2 | | | | | | |
| after 2 | p1*(p) | p2(p) | ➕n1 | ➕n0 | a | b |

The run lives in the pinning round (`round-10`) — the one exception to "no pinned tabs in a scene".

### 14. A tab created WITH an opener under relatedAfterCurrent lands right after its opener; an explicit index still wins (R14.02)

§1 is the no-opener half of the picture. With `openerTabId` in the call and no `index`, the
"related" part of the setting applies: the new tab goes directly after its opener — whether the
opener is the active tab (`c1` after `p`) or not (`c2` after `a`). With an explicit `index` the
tab lands at that index and keeps its opener: §2 holds with an opener exactly as without one.
Cells print the opener as `c1→p` (notation §2); the full opener picture is OPENER-BEHAVIOR.md §2.

| tab index | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
| - | - | - | - | - | - | - | - |
| before | p* | a | b | | | | |
| `tabs.create({openerTabId: p})  // p is active, no index` — settled 2114 ms | | | | | | | |
| no index, opener active | p* | ➕c1→p | a | b | | | |
| `tabs.create({openerTabId: a})  // a is NOT active, no index` — settled 2135 ms | | | | | | | |
| no index, opener inactive | p* | ➕c1→p | a | ➕c2→a | b | | |
| `tabs.create({openerTabId: p, index: 0})` — settled 2127 ms | | | | | | | |
| index 0 | ➕c3→p | p* | ➕c1→p | a | ➕c2→a | b | |
| `tabs.create({openerTabId: p, index: 6})  // the end of the window` — settled 2143 ms | | | | | | | |
| index at the end | ➕c3→p | p* | ➕c1→p | a | ➕c2→a | b | ➕c4→p |

### 15. A no-index create lands at the REAL end of the strip, past a hidden tail — under all three newTabPosition values (R5.41–R5.43)

With a hidden block at the end of the window, `tabs.create` without an `index` (inactive, with an
explicit `windowId` — the shape of STG's own create) does not stop after the last visible tab and
does not push the hidden block right: the new tab lands past it, at the real end of the strip, and
the next one right after. `atEnd` and `relatedAfterCurrent` without an opener behave identically —
§1's equivalence survives a hidden tail. Under `afterCurrent` with the active tab standing LAST
among the visible ones and the hidden block beginning right after it, the tab also landed at the
real end — NOT at "active + 1". In this scene the hidden run reaches the end of the window, so
"skips just the hidden run" and "goes to the very end" are not distinguished; an afterCurrent
scene with visible tabs beyond the hidden block has not been run. Hence the
`query({windowId}).length` fallback of `Tabs.createMultiple` puts a tab exactly where the browser
itself would — the two "ends" agree even with a hidden tail.

| tab index | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
| - | - | - | - | - | - | - | - | - |
| before | v1* | v2 | v3 | h1(h) | h2(h) | h3(h) | | |
| `tabs.create(n1)  // no index` — settled 243 ms | | | | | | | | |
| first created | v1* | v2 | v3 | h1(h) | h2(h) | h3(h) | ➕n1 | |
| `tabs.create(n2)  // no index, right after` — settled 238 ms | | | | | | | | |
| second created | v1* | v2 | v3 | h1(h) | h2(h) | h3(h) | ➕n1 | ➕n2 |

Under `relatedAfterCurrent` (R5.42) the same scene came out cell-for-cell identical
(settled 235/229 ms). Under `afterCurrent` (R5.43):

| tab index | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
| - | - | - | - | - | - | - | - |
| before | v1 | v2 | v3* | h1(h) | h2(h) | h3(h) | |
| `tabs.create(n1)  // no index, the active v3 at index 2, the hidden block at 3-5` — settled 242 ms | | | | | | | |
| after | v1 | v2 | v3* | h1(h) | h2(h) | h3(h) | ➕n1 |

### 16. What `tabs.create` accepts, what it refuses and with which error, and what a call without `url` opens (R20.01)

§16 to §21 come from `round-20`, run in September 2026. Every refusal is the same rejection,
`Illegal URL: <the url as passed>`, and creates no tab.

- **Accepted:** `about:blank`, `view-source:https://…`, a page of the add-on itself
  (`moz-extension://<own uuid>/…`), `https://…`, and a call **without `url`**, which opens
  `about:newtab`. `ftp://example.com/` is accepted too, but the tab stays on `about:blank`:
  Firefox has no ftp any more, the url loads nothing.
- **Refused:** `about:newtab` passed explicitly (the New Tab page is reachable only by omitting
  `url`), `about:home`, `about:config`, `about:addons`, `about:reader?url=…`, `data:` of any type
  (plain text and a png alike), `file:///`, `javascript:`, `chrome://…`, `view-source:file:///`.

The add-on's `Utils.isUrlAllowToCreate` (http, moz-extension, view-source, about:blank) matches
this list with two harmless edges: `view-source:file:` passes the regexp and is refused by the
browser, `ftp:` fails the regexp and is accepted by the browser into a blank tab. A refusal costs
nothing but the call, so neither edge needs a rule.

| tab index | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
| - | - | - | - | - | - | - | - |
| before | x* | | | | | | |
| `tabs.create({url: about:blank}, {index: 1})`, settled 233 ms | | | | | | | |
| blank | x* | ➕blank | | | | | |
| `tabs.create({url: about:newtab}, {index: 2})`, settled 259 ms | | | | | | | |
| newtab | x* | ➕blank | | | | | |
| `tabs.create({url: about:home}, {index: 2})`, settled 266 ms | | | | | | | |
| home | x* | ➕blank | | | | | |
| `tabs.create({url: about:config}, {index: 2})`, settled 258 ms | | | | | | | |
| config | x* | ➕blank | | | | | |
| `tabs.create({url: about:addons}, {index: 2})`, settled 279 ms | | | | | | | |
| addons | x* | ➕blank | | | | | |
| `tabs.create({url: about:reader?url=https%3A%2F%2Fexample.com%2F}, {index: 2})`, settled 266 ms | | | | | | | |
| reader | x* | ➕blank | | | | | |
| `tabs.create({url: data:text/plain,hello}, {index: 2})`, settled 266 ms | | | | | | | |
| datatext | x* | ➕blank | | | | | |
| `tabs.create({url: data:image/png;base64,…}, {index: 2})`, settled 262 ms | | | | | | | |
| dataimg | x* | ➕blank | | | | | |
| `tabs.create({url: file:///}, {index: 2})`, settled 265 ms | | | | | | | |
| file | x* | ➕blank | | | | | |
| `tabs.create({url: javascript:void(0)}, {index: 2})`, settled 258 ms | | | | | | | |
| js | x* | ➕blank | | | | | |
| `tabs.create({url: chrome://browser/content/browser.xhtml}, {index: 2})`, settled 263 ms | | | | | | | |
| chrome | x* | ➕blank | | | | | |
| `tabs.create({url: ftp://example.com/}, {index: 2})`, settled 237 ms | | | | | | | |
| ftp | x* | ➕blank | ➕ftp | | | | |
| `tabs.create({url: view-source:https://example.com/}, {index: 3})`, settled 267 ms | | | | | | | |
| view | x* | ➕blank | ➕ftp | ➕view | | | |
| `tabs.create({url: view-source:file:///}, {index: 4})`, settled 258 ms | | | | | | | |
| viewfile | x* | ➕blank | ➕ftp | ➕view | | | |
| `tabs.create({url: moz-extension://<own uuid>/tab.html?tab=own}, {index: 4})`, settled 238 ms | | | | | | | |
| own | x* | ➕blank | ➕ftp | ➕view | ➕own | | |
| `tabs.create({url: https://example.com/}, {index: 5})`, settled 524 ms | | | | | | | |
| http | x* | ➕blank | ➕ftp | ➕view | ➕own | ➕http | |
| `tabs.create(no url at all, {index: 6})`, settled 260 ms | | | | | | | |
| nourl | x* | ➕blank | ➕ftp | ➕view | ➕own | ➕http | ➕nourl |

After 2 s: `blank` on `about:blank`, `ftp` on `about:blank`, `view` on
`view-source:https://example.com/`, `own` on its page, `http` on `https://example.com/`,
`nourl` on `about:newtab`, all in `firefox-default`.

### 17. Every accepted url class is accepted in a non-default container too, the no-url New Tab page included (R20.02)

The same calls with `cookieStoreId` of a container created for the run (`firefox-container-8`):
`about:blank`, `view-source:https://…`, the add-on's own page, `https://…` and the call without
`url` all resolve, and every created tab reports that container. `about:newtab` and `about:home`
are refused exactly as in the default container. The url decides nothing about the container, and
the container decides nothing about the url. MDN's own example for containers is
`tabs.create({url: "about:blank", cookieStoreId})`, this run shows the rest of the list.

| tab index | 0 | 1 | 2 | 3 | 4 | 5 |
| - | - | - | - | - | - | - |
| before | x* | | | | | |
| `tabs.create({url: about:blank, cookieStoreId: container}, {index: 1})`, settled 244 ms | | | | | | |
| blank | x* | ➕blank | | | | |
| `tabs.create({url: about:newtab, cookieStoreId: container}, {index: 2})`, settled 283 ms | | | | | | |
| newtab | x* | ➕blank | | | | |
| `tabs.create({url: about:home, cookieStoreId: container}, {index: 2})`, settled 260 ms | | | | | | |
| home | x* | ➕blank | | | | |
| `tabs.create({url: view-source:https://example.com/, cookieStoreId: container}, {index: 2})`, settled 528 ms | | | | | | |
| view | x* | ➕blank | ➕view | | | |
| `tabs.create({url: moz-extension://<own uuid>/tab.html?tab=own, cookieStoreId: container}, {index: 3})`, settled 242 ms | | | | | | |
| own | x* | ➕blank | ➕view | ➕own | | |
| `tabs.create({url: https://example.com/, cookieStoreId: container}, {index: 4})`, settled 509 ms | | | | | | |
| http | x* | ➕blank | ➕view | ➕own | ➕http | |
| `tabs.create(no url, cookieStoreId: container, {index: 5})`, settled 508 ms | | | | | | |
| nourl | x* | ➕blank | ➕view | ➕own | ➕http | ➕nourl |

After 2 s every created tab reports `firefox-container-8`, `nourl` on `about:newtab`.

### 18. A top-level `location.replace` to a `data:` url from a page of the add-on reaches images except svg, PDF and JSON, nothing else (R20.03)

A page of the add-on (`navigate.html?to=…`) calls `location.replace(to)` as soon as it loads.
Two seconds later the tab is either on the `data:` url or still on the page, and the browser
console prints `Navigation to toplevel data: URI not allowed (Blocked loading of: …)` for every
blocked one.

| content type | outcome |
| - | - |
| `image/png` | navigated |
| `image/gif` | navigated |
| `image/svg+xml` | blocked |
| `application/pdf` | navigated |
| `application/json` | navigated |
| `text/json` | navigated |
| `text/plain` | blocked |
| `text/html` | blocked |
| `video/mp4` | blocked |
| no type (`data:,hello`) | blocked |

This is the rule of `nsContentSecurityManager::AllowTopLevelNavigationToDataURI` seen live: an
extension page navigates with a content principal, so only the type exceptions apply. The
add-on's `Utils.isDataUrlAllowToNavigate` is this table as a regexp. What a user types into the
address bar is a different principal and is not covered by this run.

### 19. An extension page in a non-default container gets `null` from `getBackgroundPage`, is invisible to the background's `getViews`, and still reaches the background with `runtime.sendMessage` (R20.04)

Two copies of the same page (`probe.html`), one in `firefox-default`, one in a container created
for the run, each asked for the background page and reported by `runtime.sendMessage`:

| probe | `runtime.getBackgroundPage()` | `extension.getBackgroundPage()` | own `getViews({type: 'tab'})` | reached the background |
| - | - | - | - | - |
| default container | resolves with the window | the window | 2 (itself and the scene tab) | yes |
| other container | resolves with `null`, no rejection | `null` | 1 (itself only) | yes |

The background's own `extension.getViews({type: 'tab'})` listed the default-container probe and
not the other one. This is the reason `js/wait-background.js` of STG reopens the popup and the
manage page in the default container, and the reason the stub pages, which only need messaging,
work anywhere.

### 20. The url length limit of `tabs.create` is 1 048 572 characters of the SERIALIZED url, 4 short of 1 MiB, not UTF-8 bytes, and the `URL` constructor enforces the same boundary (R20.05)

An `https://` url of exactly 1 048 572 ascii characters is accepted (created discarded, so nothing
is loaded), one of 1 048 573 is refused with `Illegal URL: <the whole url>`, as are 1 048 576 and
1 048 577. The measure is the url as the browser serializes it: a url with 524 000 two-byte
letters is 1 048 033 UTF-8 bytes, under the limit in bytes, and is refused, because every such
letter serializes to `%D1%8F`, six characters. The boundary is exact for that form too: two-byte
letters padded with ascii to a serialized length of 1 048 572 are accepted, one character more is
refused. And `new URL(url)` in the add-on's own JavaScript throws `URL constructor: <the url> is
not a valid URL` for exactly the urls `tabs.create` refuses, and parses exactly the ones it
accepts: the limit lives in the url parser, not in the tabs API.

| case | chars | UTF-8 bytes | serialized | `tabs.create` | `new URL` |
| - | - | - | - | - | - |
| ascii, 1 048 572 | 1 048 572 | 1 048 572 | 1 048 572 | accepted | parses |
| ascii, 1 048 573 | 1 048 573 | 1 048 573 | 1 048 573 | refused | throws |
| ascii, 1 048 576 | 1 048 576 | 1 048 576 | 1 048 576 | refused | throws |
| ascii, 1 048 577 | 1 048 577 | 1 048 577 | 1 048 577 | refused | throws |
| 524 000 two-byte letters | 524 033 | 1 048 033 | 3 144 033 | refused | throws |
| two-byte letters plus ascii, serialized 1 048 572 | 174 792 | 349 548 | 1 048 572 | accepted | parses |
| the same plus one character | 174 793 | 349 549 | 1 048 573 | refused | throws |
| own extension page, a path with `.html` and a query, 1 048 572 | 1 048 572 | 1 048 572 | 1 048 572 | accepted | parses |
| own extension page, the same shape, 1 048 571 | 1 048 571 | 1 048 571 | 1 048 571 | accepted | parses |
| `https://user@example.com/…`, 1 048 573 | 1 048 573 | 1 048 573 | 1 048 573 | accepted | parses |
| `https://user@example.com/…`, 1 048 572 | 1 048 572 | 1 048 572 | 1 048 572 | accepted | parses |

**The boundary moves by a character with the shape of the url.** With `user@` in front of the
host 1 048 573 characters are accepted, one more than without it. The reason is in the parser
source, `netwerk/base/nsStandardURL.cpp`: the limit is the pref `network.standard-url.max-length`,
1 048 576, compared against `nsACString::Length()`, so in bytes, twice. First the raw UTF-8 input
must fit (that is why the 524 000 letters, 1 048 033 bytes, get past it), then the escaped spec
must fit, and the escaped spec is pure ASCII, so its bytes are its characters. The second check
uses a pessimistic estimate of the escaped length plus one: a slot is reserved for `@` even when
there is no user name, another for a leading `/`, and the segment counters round up. For a url
without user info that slack is 3, plus the 1 of the check itself, hence 1 048 572. The add-on's
own shape, an extension page with `.html` and a query and no user info, accepts 1 048 572 too, so
`MAX_URL_LENGTH` is exact for the one url the add-on measures against it, the address of its stub
page. Urls of the simple schemes (`data:`, `about:`, `javascript:`) go through `nsSimpleURI.cpp`
and a different pref, `network.url.max-length`, 512 MiB, zero meaning no limit, which is why a
`data:` url can be far longer (§22).

The refusal text embeds the full url: a note that prints it verbatim for a megabyte url is what
overflowed the harness report the first time this round ran. A consequence for the add-on: a tab
url of an ordinary scheme can never be longer than this, because the browser could not have parsed
it. A `data:` url can, §22.

### 21. `webRequest.onBeforeRequest` with `main_frame` and `<all_urls>` sees http(s) loads only, and a `view-source:` load as its inner url (R20.06)

Five loads in one window with the listener armed: `https://example.com/`, the add-on's own page,
`about:blank`, `view-source:https://example.com/`, and the add-on's page navigating itself to a
`data:image/png` url. The listener fired twice, both times with `https://example.com/`: once for
the http tab and once for the view-source tab, whose url arrives stripped of `view-source:`. The
extension page, `about:blank` and the `data:` navigation produced no event at all. So STG's
`onBeforeTabRequest` never sees a non-http url, and a `view-source:` tab it reopens in a container
comes back as the plain page.

### 22. A page navigates to a `data:` image far over the limit and the tab then holds that url, while an `https://` url over the limit is refused by `location.replace` itself (R20.07)

The address is too long to travel in the page's own url, so `navigate.html` receives it by
`tabs.sendMessage` and calls `location.replace` on it, the way STG's `help/dummy.html` receives
the real url of a tab. A `data:image/png` of 1 148 594 characters is navigated to, and
`tabs.get` reports that full url as the tab's url: a `data:` tab url may exceed the limit of
§20. An `https://` url of the same length is refused inside the page:
`Location.replace: '<the url>' is not a valid URL`, the same parser refusal as `new URL` in
§20, and the tab stays on the page. So the only urls longer than the limit that can exist
in a window are `data:` urls, and they are also the only ones that cannot be passed to
`tabs.create` at any length (§16).

| tab index | 0 | 1 | 2 |
| - | - | - | - |
| before | x* | | |
| `tabs.create(navigate.html, no ?to=  // data:image/png over the limit will arrive by message, {index: 1})`, settled 245 ms | | | |
| bigpng | x* | ➕bigpng | |
| `tabs.sendMessage(bigpng, {action: navigate, to: data:image/png over the limit, 1148594 chars})`, waited 2000 ms | | | |
| bigpng 2 | x* | ➕bigpng | |
| `tabs.create(navigate.html, no ?to=  // https url over the limit will arrive by message, {index: 2})`, settled 249 ms | | | |
| bighttp | x* | ➕bigpng | ➕bighttp |
| `tabs.sendMessage(bighttp, {action: navigate, to: https url over the limit, 1148609 chars})`, waited 2000 ms | | | |
| bighttp 2 | x* | ➕bigpng | ➕bighttp |

`bigpng`: the message was delivered, the tab url is the full target, 1 148 594 characters,
status complete. `bighttp`: the listener threw `Location.replace: … is not a valid URL`, the tab
url is still the page, 78 characters.

### 23. `tabs.onCreated` is delivered before `webRequest.onBeforeRequest` of a new tab's first load, whichever way the tab was made, and `tabs.create` resolves before that request too (R21.01–R21.05)

Five ways to make a tab with an http url, one blocking `main_frame` listener without a window
filter, one timeline each: `tabs.create` (R21.01), the same with the listener holding the request
500 ms after its probe (R21.02), `window.open` from a page of the add-on (R21.03), a user's
middle-click on a link in a page of the add-on (R21.04) and on the only link of a web page
(R21.05). In every run `tabs.onCreated` came first, 1–21 ms ahead of the request, carrying
`about:blank` and status `complete`. `tabs.create` resolved in the same millisecond as
`tabs.onCreated`, before the request. Holding the request changed nothing before it: the creation
event and the resolve arrived at once, the tab kept `about:blank` while the request was suspended
(§24), and the `{url}` update came only after the release. R21.03 ran with the pop-up
permission granted to the add-on's page: without it `window.open` from a page without a user
gesture returned `null` and the tab appeared only when the permission was granted in the browser's
bar. In the manual tests the clock starts at the question, so only the distances between events
mean anything. What STG takes from this is the first-load bullet of "Conclusions".

| tab index | 0 | 1 |
| - | - | - |
| before | x* | |
| `tabs.create({url: http?tab=new, active: false})`, settled 519 ms | | |
| after | x* | ➕new |

```text
    4ms  tabs.onCreated              new  index:1 url:about:blank status:complete
    4ms  tabs.create                 new  resolved
    6ms  webRequest.onBeforeRequest  new  https://example.com/?tab=new  the first request of the tab, tabs.onCreated delivered before this: true
    7ms  probe tabs.get              new  url:about:blank status:complete index:1 in the scene window:true
    7ms  probe setTabValue           new  ok, took 0 ms
    7ms  webRequest.onBeforeRequest  new  released
    9ms  tabs.onUpdated              new  {status: loading}
   23ms  tabs.onUpdated              new  {status: loading, url: https://example.com/?tab=new}
   86ms  tabs.onUpdated              new  {status: complete}
(1 tabs.onUpdated dropped, only these keys were kept: url/status)
```

R21.02, the listener holds the request 500 ms after the probe:

| tab index | 0 | 1 |
| - | - | - |
| before | x* | |
| `tabs.create({url: http?tab=new, active: false})`, settled 1069 ms | | |
| after | x* | ➕new |

```text
    7ms  tabs.onCreated              new  index:1 url:about:blank status:complete
    7ms  tabs.create                 new  resolved
   10ms  webRequest.onBeforeRequest  new  https://example.com/?tab=new  the first request of the tab, tabs.onCreated delivered before this: true
   10ms  tabs.onUpdated              new  {status: loading}
   10ms  probe tabs.get              new  url:about:blank status:loading index:1 in the scene window:true
   10ms  probe setTabValue           new  ok, took 0 ms
  524ms  webRequest.onBeforeRequest  new  released after holding the request 500 ms more
  551ms  tabs.onUpdated              new  {status: loading, url: https://example.com/?tab=new}
  633ms  tabs.onUpdated              new  {status: complete}
(1 tabs.onUpdated dropped, only these keys were kept: url/status)
```

R21.03, `window.open` from a page of the add-on:

| tab index | 0 | 1 | 2 |
| - | - | - | - |
| before | x | page* | |
| `tabs.sendMessage(page, {action: open})  // the page calls window.open(http?tab=opened, _blank)` | | | |
| after | x | page | ➕opened* |

```text
    9ms  tabs.onCreated              opened  index:2 url:about:blank status:complete
   29ms  tabs.onUpdated              opened  {status: complete, url: about:blank}
   30ms  tabs.onUpdated              opened  {status: loading}
   30ms  window.open                 returned a window
   30ms  webRequest.onBeforeRequest  opened  https://example.com/?tab=opened  the first request of the tab, tabs.onCreated delivered before this: true
   30ms  probe tabs.get              opened  url:about:blank status:loading index:2 in the scene window:true
   32ms  probe setTabValue           opened  ok, took 2 ms
   32ms  webRequest.onBeforeRequest  opened  released
   45ms  tabs.onUpdated              opened  {status: loading, url: https://example.com/?tab=opened}
   51ms  tabs.onUpdated              opened  {status: complete}
(2 tabs.onUpdated dropped, only these keys were kept: url/status)
```

R21.04, the user middle-clicks a link in a page of the add-on:

| tab index | 0 | 1 | 2 |
| - | - | - | - |
| before | x | page* | |
| `USER: middle-click the link on the active page` | | | |
| after | x | page* | ➕opened |

```text
 7583ms  tabs.onCreated              opened  index:2 url:about:blank status:complete
 7586ms  tabs.onUpdated              opened  {status: loading}
 7586ms  webRequest.onBeforeRequest  opened  https://example.com/?tab=opened  the first request of the tab, tabs.onCreated delivered before this: true
 7586ms  probe tabs.get              opened  url:about:blank status:loading index:2 in the scene window:true
 7587ms  probe setTabValue           opened  ok, took 1 ms
 7587ms  webRequest.onBeforeRequest  opened  released
 7598ms  tabs.onUpdated              opened  {status: loading, url: https://example.com/?tab=opened}
 7650ms  tabs.onUpdated              opened  {status: complete}
(1 tabs.onUpdated dropped, only these keys were kept: url/status)
```

R21.05, the user middle-clicks the only link of a web page (the events block is under §25).

### 24. Inside the blocking `onBeforeRequest` listener of the first load `tabs.get` resolves and `sessions.setTabValue` succeeds, and the value survives the load (R21.01–R21.05)

Probed before the listener let the request go, in every run: `tabs.get` returned the tab with
`about:blank`, status `loading` or `complete`, at its real index. `sessions.setTabValue` resolved
in 0–2 ms, and `sessions.getTabValue` after the load returned the value. The evidence is the
`probe` lines of the blocks under §23 and §25.

### 25. A redirect chain fires `onBeforeRequest` once per hop, every hop with the same `requestId`, while the tab still reports `about:blank` (R21.05)

The link of `example.com` led through four hops, `https://iana.org/domains/example`,
`https://www.iana.org/domains/example`, `http://www.iana.org/help/example-domains`,
`https://www.iana.org/help/example-domains`. Each hop was a separate `onBeforeRequest` with the
`requestId` of the first, `tabs.get` inside every one of them still reported `about:blank`, and the
`{url}` update of the tab came once, after the last hop. The chain itself belongs to the site, so
the test asserts only that all hops of a first load share one `requestId`.

| tab index | 0 | 1 |
| - | - | - |
| before | x* | |
| `USER: middle-click the only link of the web page` | | |
| after | x* | ➕opened |

```text
 3960ms  tabs.onCreated              opened  index:1 url:about:blank status:complete
 3961ms  webRequest.onBeforeRequest  opened  https://iana.org/domains/example  the first request of the tab, tabs.onCreated delivered before this: true
 3961ms  probe tabs.get              opened  url:about:blank status:complete index:1 in the scene window:true
 3961ms  probe setTabValue           opened  ok, took 0 ms
 3961ms  webRequest.onBeforeRequest  opened  released
 3962ms  webRequest.onBeforeRequest  opened  https://www.iana.org/domains/example  the same requestId as the previous hop, a redirect, tabs.onCreated delivered before this: true
 3963ms  probe tabs.get              opened  url:about:blank status:complete index:1 in the scene window:true
 3965ms  probe setTabValue           opened  ok, took 2 ms
 3965ms  webRequest.onBeforeRequest  opened  released
 3966ms  tabs.onUpdated              opened  {status: loading}
 3968ms  webRequest.onBeforeRequest  opened  http://www.iana.org/help/example-domains  the same requestId as the previous hop, a redirect, tabs.onCreated delivered before this: true
 3968ms  probe tabs.get              opened  url:about:blank status:loading index:1 in the scene window:true
 3968ms  probe setTabValue           opened  ok, took 0 ms
 3968ms  webRequest.onBeforeRequest  opened  released
 3969ms  webRequest.onBeforeRequest  opened  https://www.iana.org/help/example-domains  the same requestId as the previous hop, a redirect, tabs.onCreated delivered before this: true
 3969ms  probe tabs.get              opened  url:about:blank status:loading index:1 in the scene window:true
 3970ms  probe setTabValue           opened  ok, took 1 ms
 3970ms  webRequest.onBeforeRequest  opened  released
 3999ms  tabs.onUpdated              opened  {status: loading, url: https://www.iana.org/help/example-domains}
 4257ms  tabs.onUpdated              opened  {status: complete}
(2 tabs.onUpdated dropped, only these keys were kept: url/status)
```

### 26. A window that has just appeared reports its active tab as `about:blank` with status `complete`, the load starts 50–65 ms later, and 1000 ms after `windows.onCreated` the tab holds its real url (R22.01–R22.04)

The active tab sampled every 25 ms from `windows.onCreated`, four ways of making a window:
`windows.create` with one http url (R22.01), with three (R22.02), without a url (R22.03), and
`sessions.restore` of a closed window (R22.04). In every run `tabs.onCreated` of the active tab
came in the same millisecond as `windows.onCreated` and before it, carrying `about:blank` and
status `complete`, and a `tabs.query` issued from the `windows.onCreated` handler reported the
same. `{status: loading}` arrived 50–65 ms later, the real url with the next update, and at
STG's read moment, 1000 ms after `windows.onCreated`, the active tab held its real url with
status `complete` in every http run. So a guard on `status === loading` misses the first 50–65 ms
of a new window, when the url is empty and the status still says `complete`, and `tab.active`
is the guard that holds there. Without a url (R22.03) the first page is `about:home`: it arrives
at 60 ms, the status is `complete` from 115 ms on, and the url stays one of the empty three for
good, including the read moment.

| tab index | 0 |
| - | - |
| before (scene window) | x* |
| `windows.create({url: http?tab=a})`, settled 261 ms | |
| after (born window) | ➕a* |
| after (scene window) | x* |

```text
   97ms  tabs.onCreated           a  index:0 active:true url:about:blank status:complete discarded:false  [born]
   97ms  tabs.onActivated         a  [born]
   97ms  windows.onCreated        born  type:normal
   97ms  windows.onCreated+query  1 tab(s): a* url:about:blank status:complete discarded:false
  156ms  tabs.onUpdated           a  {status: loading}  [born]
  163ms  active tab               a  url:about:blank status:loading discarded:false
  753ms  tabs.onUpdated           a  {status: loading, url: https://example.com/?tab=a}  [born]
  760ms  tabs.onUpdated           a  {status: complete}  [born]
  769ms  active tab               a  url:https://example.com/?tab=a status:complete discarded:false
 1110ms  at the read moment       a  url:https://example.com/?tab=a status:complete discarded:false  empty url:false  1013 ms after windows.onCreated
(2 tabs.onUpdated dropped, only these keys were kept: url/status)
```

R22.03, `windows.create()` without a url:

| tab index | 0 |
| - | - |
| before (scene window) | x* |
| `windows.create()`, settled 264 ms | |
| after (born window) | ➕tab0* |
| after (scene window) | x* |

```text
   93ms  tabs.onCreated           tab0  index:0 active:true url:about:blank status:complete discarded:false  [born]
   93ms  tabs.onActivated         tab0  [born]
   93ms  windows.onCreated        born  type:normal
   93ms  windows.onCreated+query  1 tab(s): tab0* url:about:blank status:complete discarded:false
  145ms  tabs.onUpdated           tab0  {status: loading}  [born]
  145ms  active tab               tab0  url:about:blank status:complete discarded:false
  154ms  tabs.onUpdated           tab0  {status: loading, url: about:home}  [born]
  172ms  active tab               tab0  url:about:home status:complete discarded:false
  207ms  tabs.onUpdated           tab0  {status: complete}  [born]
 1110ms  at the read moment       tab0  url:about:home status:complete discarded:false  empty url:true  1017 ms after windows.onCreated
```

The blocks of R22.02 and R22.04 are under §27 and §28.

### 27. `windows.create` with several urls loads every tab, `sessions.restore` brings the background tabs back discarded with their real urls already in `tabs.onCreated` (R22.02, R22.04)

Three urls in one `windows.create`: the two background tabs are born `about:blank`, status
`complete`, not discarded, 44 ms after the active one, and load like it, the real url at 681 ms.
The same three tabs closed with their window and brought back by `sessions.restore`: the two
background tabs are born 8 ms after the active one already carrying their real urls, status
`complete`, `discarded: true`, and never load. Only the active tab goes through `about:blank` and
a load, in both cases.

| tab index | 0 | 1 | 2 |
| - | - | - | - |
| before (scene window) | x* | | |
| `windows.create({url: [http?tab=a, http?tab=b, http?tab=c]})`, settled 264 ms | | | |
| after (born window) | ➕a* | ➕b | ➕c |
| after (scene window) | x* | | |

```text
   92ms  tabs.onCreated           a  index:0 active:true url:about:blank status:complete discarded:false  [born]
   92ms  tabs.onActivated         a  [born]
   92ms  windows.onCreated        born  type:normal
  136ms  tabs.onCreated           b  index:1 active:false url:about:blank status:complete discarded:false  [born]
  136ms  tabs.onCreated           c  index:2 active:false url:about:blank status:complete discarded:false  [born]
   92ms  windows.onCreated+query  3 tab(s): a* url:about:blank status:complete discarded:false | b url:about:blank status:complete discarded:false | c url:about:blank status:complete discarded:false
  152ms  tabs.onUpdated           a  {status: loading}  [born]
  153ms  tabs.onUpdated           b  {status: complete, url: about:blank}  [born]
  154ms  tabs.onUpdated           b  {status: loading}  [born]
  155ms  tabs.onUpdated           c  {status: complete, url: about:blank}  [born]
  155ms  tabs.onUpdated           c  {status: loading}  [born]
  157ms  active tab               a  url:about:blank status:loading discarded:false
  170ms  tabs.onUpdated           a  {status: loading, url: https://example.com/?tab=a}  [born]
  174ms  tabs.onUpdated           a  {status: complete}  [born]
  183ms  active tab               a  url:https://example.com/?tab=a status:complete discarded:false
  681ms  tabs.onUpdated           b  {status: loading, url: https://example.com/?tab=b}  [born]
  681ms  tabs.onUpdated           c  {status: loading, url: https://example.com/?tab=c}  [born]
  735ms  tabs.onUpdated           b  {status: complete}  [born]
  736ms  tabs.onUpdated           c  {status: complete}  [born]
 1092ms  at the read moment       a  url:https://example.com/?tab=a status:complete discarded:false  empty url:false  1000 ms after windows.onCreated
(4 tabs.onUpdated dropped, only these keys were kept: url/status)
```

### 28. While the active tab of a restored window loads, `tabs.query` reports its real url, then `about:blank` again, then the real url for good (R22.04)

One run, three samples 25 ms apart: at 155 ms after the restore call the loading active tab
reported `https://example.com/?tab=p`, at 181 ms `about:blank` with the same `loading` status,
and from 235 ms the real url with status `complete`. The url of a tab in the middle of its first
load is not monotonic: a reader that takes a real url as final and a later `about:blank` as a
navigation to an empty page is fooled by a single sample.

| tab index | 0 | 1 | 2 |
| - | - | - | - |
| before (second window) | p* | a | b |
| before (scene window) | x* | | |
| `windows.remove(second)`, settled 301 ms | | | |
| `sessions.restore(sessionId of the window)`, settled 261 ms | | | |
| restored (born window) | ➕p* | ➕a | ➕b |
| after (scene window) | x* | | |

```text
   85ms  tabs.onCreated           p  index:0 active:true url:about:blank status:complete discarded:false  [born]
   85ms  tabs.onActivated         p  [born]
   85ms  windows.onCreated        born  type:normal
   93ms  tabs.onCreated           a  index:1 active:false url:https://example.com/?tab=a status:complete discarded:true  [born]
   93ms  tabs.onCreated           b  index:2 active:false url:https://example.com/?tab=b status:complete discarded:true  [born]
   85ms  windows.onCreated+query  3 tab(s): p* url:about:blank status:complete discarded:false | a url:https://example.com/?tab=a status:complete discarded:true | b url:https://example.com/?tab=b status:complete discarded:true
  152ms  tabs.onUpdated           p  {status: loading}  [born]
  155ms  active tab               p  url:https://example.com/?tab=p status:loading discarded:false
  181ms  active tab               p  url:about:blank status:loading discarded:false
  227ms  tabs.onUpdated           p  {status: loading, url: https://example.com/?tab=p}  [born]
  235ms  tabs.onUpdated           p  {status: complete}  [born]
  235ms  active tab               p  url:https://example.com/?tab=p status:complete discarded:false
 1094ms  at the read moment       p  url:https://example.com/?tab=p status:complete discarded:false  empty url:false  1009 ms after windows.onCreated
(7 tabs.onUpdated dropped, only these keys were kept: url/status)
```

### 29. A `sessions.setTabValue` value rides through `sessions.restore()` onto the fresh tab, is readable inside its `tabs.onCreated`, and a write from inside that handler wins over it; a `sessions.setWindowValue` value does the same for a restored window (R24.01–R24.04)

A tab restored by `sessions.restore()` — a closed tab or a whole closed window — comes back with a
fresh id (OPENER-BEHAVIOR.md §15, §16) and with the value that was set on the OLD id: for a loaded
active tab, for a background tab that comes back discarded (§27) and for a hidden member alike.
The value is already there when `tabs.onCreated` fires: a `sessions.getTabValue` started inside
the handler returns it, 6–7 ms for a single restored tab, 40–52 ms for the three tabs of a
restored window read at once. The dead id rejects the read (`Invalid tab ID`). A
`sessions.setTabValue` issued from inside the handler right after that read is what the tab
holds once the restore has settled: the restore does not write its value again afterwards.

A window value behaves the same (R24.04): the restored window gets a fresh id, the dead id rejects
the read (`Invalid window ID`), and `sessions.getWindowValue` returns the value from inside the
first `tabs.onCreated` of the restored window — the one delivered before `windows.onCreated`
(TABGROUPS-BEHAVIOR.md §18) — as well as from inside `windows.onCreated` and after the restore
has settled, 51–73 ms per read with the three reads in flight together.

R24.01, a single closed tab:

| tab index | 0 | 1 |
| - | - | - |
| before | keep* | c |
| `tabs.remove(c)` — settled 281 ms | | |
| closed | keep* | |
| `sessions.restore(sessionId of the tab)` — settled 227 ms | | |
| restored | keep | c* |

```text
    2ms  tabs.onRemoved        c  isWindowClosing:false
    7ms  tabs.onCreated        c  index:1 active:true discarded:false hidden:false
    7ms  tabs.onActivated      c
    7ms  probe getTabValue     c  "value-c", took 7 ms
(9 tabs.onUpdated dropped, only these keys were kept: hidden/discarded)
```

- c after the close, read on the OLD id: rejected, Invalid tab ID: `<id>`
- restored c: a fresh id, index:1, discarded:false hidden:false status:complete
- inside tabs.onCreated of the restored tab: "value-c"
- after the restore settled: "value-c"

R24.02, a closed window with a loaded active tab, a background tab and a hidden member:

| tab index | 0 | 1 | 2 |
| - | - | - | - |
| before (second window) | p* | q | h1(h) |
| before (scene window) | keep* | | |
| `windows.remove(second)` — settled 283 ms | | | |
| `sessions.restore(sessionId of the window)` — settled 223 ms | | | |
| restored (second window) | p* | q | h1(h) |
| after (scene window) | keep* | | |

```text
    9ms  tabs.onRemoved        p  isWindowClosing:true  [second]
    9ms  tabs.onRemoved        q  isWindowClosing:true  [second]
    9ms  tabs.onRemoved        h1  isWindowClosing:true  [second]
    9ms  windows.onRemoved     closed
   90ms  tabs.onCreated        p  index:0 active:true discarded:false hidden:false  [restored]
   90ms  tabs.onActivated      p  [restored]
   91ms  windows.onCreated     type:normal
   97ms  tabs.onCreated        q  index:1 active:false discarded:true hidden:false  [restored]
   98ms  tabs.onCreated        h1  index:2 active:false discarded:true hidden:true  [restored]
   98ms  tabs.onUpdated        h1  {hidden: true}  [restored]
   90ms  probe getTabValue     p  "value-p", took 40 ms
   97ms  probe getTabValue     q  "value-q", took 52 ms
   98ms  probe getTabValue     h1  "value-h1", took 51 ms
(11 tabs.onUpdated dropped, only these keys were kept: hidden/discarded)
```

- tabs in the session record: p, q, h1
- restored p: discarded:false hidden:false status:complete
- restored q: discarded:true hidden:false status:complete
- restored h1: discarded:true hidden:true status:complete
- inside tabs.onCreated: p "value-p", q "value-q", h1 "value-h1"
- after the restore settled: p "value-p", q "value-q", h1 "value-h1"

R24.03, the same single tab with a write from inside `tabs.onCreated`:

| tab index | 0 | 1 |
| - | - | - |
| before | keep* | c |
| `tabs.remove(c)` — settled 278 ms | | |
| closed | keep* | |
| `sessions.restore(sessionId of the tab)` — settled 230 ms | | |
| restored | keep | c* |

```text
    2ms  tabs.onRemoved        c  isWindowClosing:false
   11ms  tabs.onCreated        c  index:1 active:true discarded:false hidden:false
   11ms  tabs.onActivated      c
   11ms  probe getTabValue     c  "value-c", took 6 ms
   20ms  probe setTabValue     c  ok
(9 tabs.onUpdated dropped, only these keys were kept: hidden/discarded)
```

- inside tabs.onCreated of the restored tab, before the write: "value-c"
- after the restore settled: "written-inside-onCreated" (the handler wrote "written-inside-onCreated")

R24.04, a `sessions.setWindowValue` value across the restore of its window:

| tab index | 0 | 1 |
| - | - | - |
| before (second window) | p* | q |
| before (scene window) | keep* | |
| `windows.remove(second)` — settled 278 ms | | |
| `sessions.restore(sessionId of the window)` — settled 234 ms | | |
| restored (second window) | p* | q |
| after (scene window) | keep* | |

```text
   10ms  tabs.onRemoved        p  isWindowClosing:true  [second]
   10ms  tabs.onRemoved        q  isWindowClosing:true  [second]
   10ms  windows.onRemoved     closed
   93ms  tabs.onCreated        p  index:0 active:true discarded:false hidden:false  [restored]
   93ms  tabs.onActivated      p  [restored]
   93ms  windows.onCreated     type:normal
   99ms  tabs.onCreated        q  index:1 active:false discarded:true hidden:false  [restored]
   93ms  probe getWindowValue  from tabs.onCreated of p  "value-window", took 51 ms  [restored]
   93ms  probe getWindowValue  from windows.onCreated  "value-window", took 51 ms  [restored]
   99ms  probe getWindowValue  from tabs.onCreated of q  "value-window", took 73 ms  [restored]
(10 tabs.onUpdated dropped, only these keys were kept: hidden/discarded)
```

- after the close, read on the OLD window id: rejected, Invalid window ID: `<id>`
- restored window: a fresh id
- after the restore settled: "value-window"

---

## Conclusions for the add-on

- **Bulk creation** (restore, unarchive, sync, bookmarks): explicit `windowId` + explicit
  increasing `index` (anchor + i) + `Promise.all`. §2 held in every run — all three settings, with
  and without an `active: true` tab, at batch sizes up to 300. That is restore scale, so this is
  measured rather than extrapolated; above 300 it is still an expectation, and `ensureSorted` stays
  as the net (last bullet).
- **Anchor** for a group — `Tabs.getNewTabIndex(group.tabs)`: afterCurrent → after the tab with
  max `lastAccessed`, otherwise/without permission — end of the group (exactly matches the
  browser, §1). Without group context — end of the window.
- The anchor may land inside a native subgroup's span → the tab will join that subgroup
  (TABGROUPS-BEHAVIOR.md §7); this is expected, the mirror syncs membership.
- **A single new tab**: into a loaded group — do NOT pass index, the browser itself will place
  it by newTabPosition, including non-focused windows (§9); into an unloaded one — an
  explicit index by the `getNewTabIndex` anchor (hidden tabs are addressable by index, §3).
  A hidden block does not catch a no-index tab: it lands past it, at the real end of the
  strip, even under afterCurrent with the active tab right before the block (§15).
- **The historical reason for creating a batch inactive and activating afterwards is gone.** It
  rested on the old §11, which no longer holds: an explicit index survives `active: true`. Creating
  inactive and activating in a separate `tabs.update` is still perfectly safe, just no longer
  required for correct ordering. Whether `createMultiple` keeps that shape is a code decision, not
  a browser constraint.
- The `ensureSorted` net in `createMultiple` guards the no-index paths, where §4 and §5 make the
  order genuinely non-obvious; on the explicit-index paths it re-checks contiguity and order and
  is expected to move nothing — a move there is visible in its log (`isBlock`).
- **A url `tabs.create` refuses is the add-on's stub page** (§16): `data:`, `file:`,
  privileged `about:` and the like never reach `tabs.create` as they are. `Tabs.create` opens
  `help/stg-unsupported-url.html` for them, and `help/dummy.html` with the real url handed over by
  message for what a page can navigate to itself: a `data:` url of a type from §18, of any
  size (§22). No url of another scheme can be longer than the limit (§20, §22), so `data:`
  is the only reason the handover exists. The stub pages need no background page, so they live in
  any container (§19).
- **The container never depends on the url** (§17): `Tabs.getNewTabContainer` decides from
  `cookieStoreId` and the group's rules alone. Whether a tab may be destroyed and recreated is a
  different question, and `onBeforeTabRequest` only ever asks it about http(s) loads (§21).
- **The first load of a new tab is announced by `tabs.onCreated` first** (§23), a few
  milliseconds before `onBeforeTabRequest` sees the request, for every way a tab gets made. So
  the group decision of `Tabs.onCreated` is always already in progress when the request handler
  starts: the handler may wait for that decision itself instead of a timer, and it may hold the
  request as long as it needs, the creation events and the resolve of `tabs.create` do not wait
  for the request. While it holds, the tab is still `about:blank` and can be read and written
  (§24). A redirect brings the handler back for every hop with the same `requestId` (§25).
- **The active tab of a window that has just appeared is not loading yet** (§26): for the first
  50–65 ms after `windows.onCreated` it is `about:blank` with status `complete`, so
  `Tabs.fillEmptyUrl` replaces an empty url by the mirror's for a tab that is loading OR active,
  never for a settled background tab. The mirror can only help where it knows more than the
  live tab does: a snapshot older than the mirror (the group lists `runGrandRestoreNow` keeps
  from its first read), or a tab whose request the add-on has seen (`onBeforeTabRequest` mirrors
  the requested url on a catch). A newborn active tab is known to nobody but `tabsToRestore`:
  by the time STG reads the window, 1000 ms later, it holds its real url in every run here, and
  on a machine that has not started the load by then the tab is matched by an empty url and the
  saved links do not find it. A background tab of an undo-closed window needs nothing: it comes back
  discarded with its real url (§27). A url read once from a loading tab is not final (§28).
- **The url length check counts characters of the serialized url** (§20). Every url the
  add-on measures is already serialized: a tab url comes from the browser that way, and the
  address of the stub page is built with `URLSearchParams`. For such urls `url.length` is the
  exact measure, no byte counting.
- **An undo-closed tab is a new tab with an old session** (§29): it reaches `Tabs.onCreated`
  under a fresh id, but `groupId` and `groupNativeId` of the closed tab are already on it, and
  discarded and hidden members of a restored window carry theirs too. The handler may decide
  from that value right away, and whatever it writes there stays: `setTabGroup` binding the tab
  to the window's group is not undone by the restore. A window without a group is the case to
  handle explicitly: nothing overwrites the old group, so it has to be read or removed, not
  assumed absent. The window's own `groupId` session value is there just as early: a cache that
  reads a window session once, at the first `Windows.load` after `windows.onCreated`, never
  reads it too soon.

## Open questions

None. Add new facts and test results to the end of "Verified facts" under the next free number.
