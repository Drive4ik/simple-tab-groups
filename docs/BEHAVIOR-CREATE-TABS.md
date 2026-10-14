# Reference: creating tabs and the newTabPosition setting (`tabs.create`)

Verified live on Firefox 154–155 (August 2026) with a throwaway test add-on, in a clean profile
with no other add-ons. All tests — without pinned tabs; the one exception is §13, whose subject is
the pinned block itself. Every fact here is one browser build on one machine; a claim is as strong
as the runs cited next to it, and no stronger.

Only facts confirmed by an actual test run belong in "Verified facts" — never assumptions about how
the browser "probably" works. Native tab group facts — including the membership of created tabs —
live in BEHAVIOR-TABGROUPS.md (§7, §10 there). A copy lands here only when creation next to native
groups behaves differently from what this document itself states.

State tables, markers, confirmation rules and how the tests are written — BEHAVIOR-NOTATION.md.

**A new fact is appended as the next number at the end of "Verified facts". Numbers are never
renumbered or reused** — code comments reference them by number
(`docs/BEHAVIOR-CREATE-TABS.md §4-5`, `§11`).

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
(BEHAVIOR-OPENER.md) ⇒ for them **relatedAfterCurrent is equivalent to atEnd**. Hence also: the
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
Cells print the opener as `c1→p` (notation §2); the full opener picture is BEHAVIOR-OPENER.md §2.

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

The add-on's `Utils.isUrlAllowToCreate` (`https?:`, `view-source:https?:`, `moz-extension:`,
`about:blank`) matches this list with one harmless edge: `ftp:` fails the regexp and is accepted
by the browser into a blank tab, so such a url goes to the stub page instead, where it is at least
kept. The schemes are spelled whole: `view-source:file:` is refused by the browser, and a refusal
in `Tabs.create` would cost the tab, not just the call. Whether a given extension page can be
opened is a question of its own, §34 and §36.

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
fresh id (BEHAVIOR-OPENER.md §15, §16) and with the value that was set on the OLD id: for a loaded
active tab, for a background tab that comes back discarded (§27) and for a hidden member alike.
The value is already there when `tabs.onCreated` fires: a `sessions.getTabValue` started inside
the handler returns it, 6–7 ms for a single restored tab, 40–52 ms for the three tabs of a
restored window read at once. The dead id rejects the read (`Invalid tab ID`). A
`sessions.setTabValue` issued from inside the handler right after that read is what the tab
holds once the restore has settled: the restore does not write its value again afterwards.

A window value behaves the same (R24.04): the restored window gets a fresh id, the dead id rejects
the read (`Invalid window ID`), and `sessions.getWindowValue` returns the value from inside the
first `tabs.onCreated` of the restored window — the one delivered before `windows.onCreated`
(BEHAVIOR-TABGROUPS.md §18) — as well as from inside `windows.onCreated` and after the restore
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

### 30. `tabs.create({url, openInReaderMode: true})` opens the page as `about:reader?url=<the url, encoded>` with `isInReaderMode: true`, in a container too; the flag cannot be combined with `discarded: true`, does nothing for `about:blank` and no url, and leaves a `view-source:` url or an extension page on `about:blank` for good (R27.01–R27.05)

§30 to §35 come from `round-27`, run in September 2026. A tab in reader mode reports
`url: about:reader?url=<the page url, encodeURIComponent-encoded>` and `isInReaderMode: true`;
`about:reader?url=…` passed to `tabs.create` is refused (§16), the flag is the only way in.

- **An article, as a background tab** (R27.01): the call resolves with `about:blank`, status
  `complete`, `isInReaderMode: false`, like any created tab (§12). Then `tabs.onUpdated` delivers
  `{status: loading}`, `{status: loading, url: about:reader?url=…}`, `{status: complete}`, and the
  loaded tab reports the reader url with `isInReaderMode: true`; `isArticle` is `undefined`.
  `tabs.discard` keeps both the url and the flag. Activating the discarded tab reloads the reader
  page on the same url. A `webRequest.onBeforeRequest` listener for `main_frame` with `<all_urls>`,
  armed before the create, saw no request at any point; how the article gets fetched was not measured.
- **`discarded: true` together with the flag** (R27.02): refused, `Cannot create a discarded new
  tab or "about" urls.` — the text the browser gives an `about:` url.
- **A page the browser cannot put into reader mode** (R27.03, `https://example.com/`, the page
  §32 shows `toggleReaderMode` refusing): the call resolves and the tab lands on
  `about:reader?url=https%3A%2F%2Fexample.com%2F` with `isInReaderMode: true` all the same, and
  stays there once activated. What the reader view shows there was not looked at.
- **`view-source:`, an own extension page, `about:blank` with the flag** (R27.04): every call
  resolves, and every tab stays on `about:blank` with `isInReaderMode: false`, status `complete`,
  for good — the url is lost. No url with the flag opens `about:newtab`, as without it (§16).
- **A container** (R27.05): the reader tab opens in the requested container, with the reader url.

R27.01:

| tab index | 0 | 1 |
| - | - | - |
| before | x* | |
| `tabs.create({url: article, openInReaderMode: true})` — settled 508 ms | | |
| reader | x* | ➕reader |
| `tabs.discard(reader)` — settled 269 ms | | |
| discarded | x* | ➕reader |
| `tabs.update(reader, {active: true})` — settled 519 ms | | |
| reader activated | x | ➕reader* |

```text
    8ms  tabs.onUpdated        reader  {status: loading}
   39ms  tabs.onUpdated        reader  {status: loading, url: about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page}
  229ms  tabs.onUpdated        reader  {status: complete}
    9ms  tabs.onUpdated        reader  {discarded: true}
   12ms  tabs.onUpdated        reader  {discarded: false}
   17ms  tabs.onUpdated        reader  {status: complete, url: about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page}
   18ms  tabs.onUpdated        reader  {status: loading}
   31ms  tabs.onUpdated        reader  {status: loading, url: about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page}
   62ms  tabs.onUpdated        reader  {status: complete}
(7 tabs.onUpdated dropped, only these keys were kept: url/status/isArticle/discarded)
```

- reader at the resolve: `url:about:blank` isInReaderMode:false isArticle:undefined status:complete discarded:false
- reader loaded: `url:about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page` isInReaderMode:true isArticle:undefined status:complete discarded:false
- reader discarded: `url:about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page` isInReaderMode:true isArticle:undefined status:complete discarded:true
- reader activated and loaded: `url:about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page` isInReaderMode:true isArticle:undefined status:complete discarded:false

R27.02:

| tab index | 0 |
| - | - |
| before | x* |
| `tabs.create({url: article, openInReaderMode: true, discarded: true, title: lazy})` — settled 269 ms | |
| lazy | x* |

- lazy: rejected - Cannot create a discarded new tab or "about" urls.

R27.03:

| tab index | 0 | 1 |
| - | - | - |
| before | x* | |
| `tabs.create({url: https://example.com/, openInReaderMode: true})` — settled 511 ms | | |
| plain | x* | ➕plain |
| `tabs.update(plain, {active: true})` — settled 271 ms | | |
| plain activated | x | ➕plain* |

```text
   10ms  tabs.onUpdated        plain  {status: loading}
   45ms  tabs.onUpdated        plain  {status: loading, url: about:reader?url=https%3A%2F%2Fexample.com%2F}
  216ms  tabs.onUpdated        plain  {status: complete}
(1 tabs.onUpdated dropped, only these keys were kept: url/status/isArticle/discarded)
```

- plain loaded: `url:about:reader?url=https%3A%2F%2Fexample.com%2F` isInReaderMode:true isArticle:undefined status:complete discarded:false
- plain activated and loaded: `url:about:reader?url=https%3A%2F%2Fexample.com%2F` isInReaderMode:true isArticle:undefined status:complete discarded:false

R27.04:

| tab index | 0 | 1 | 2 | 3 | 4 |
| - | - | - | - | - | - |
| before | x* | | | | |
| `tabs.create({url: view-source:https://example.com/, openInReaderMode: true})` — settled 530 ms | | | | | |
| view | x* | ➕view | | | |
| `tabs.create({url: moz-extension://<own uuid>/tab.html?tab=own, openInReaderMode: true})` — settled 264 ms | | | | | |
| own | x* | ➕view | ➕own | | |
| `tabs.create({url: about:blank, openInReaderMode: true})` — settled 523 ms | | | | | |
| blank | x* | ➕view | ➕own | ➕blank | |
| `tabs.create({openInReaderMode: true}, no url)` — settled 267 ms | | | | | |
| nourl | x* | ➕view | ➕own | ➕blank | ➕nourl |

- view, 20 s later: `url:about:blank` isInReaderMode:false isArticle:false status:complete discarded:false
- own, 20 s later: `url:about:blank` isInReaderMode:false isArticle:undefined status:complete discarded:false
- blank, 20 s later: `url:about:blank` isInReaderMode:false isArticle:false status:complete discarded:false
- nourl settled: `url:about:newtab` isInReaderMode:false isArticle:undefined status:complete discarded:false

R27.05:

| tab index | 0 | 1 |
| - | - | - |
| before | x* | |
| `tabs.create({url: article, openInReaderMode: true, cookieStoreId: container})` — settled 509 ms | | |
| reader | x* | ➕reader |

- reader loaded: `url:about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page` isInReaderMode:true isArticle:undefined status:complete discarded:false
- reader container: firefox-container-15 (the requested one)

### 31. `tabs.update({url: about:reader?url=…})` is refused like `tabs.create`, with `Illegal URL: <the url>`, whatever the reader url wraps (R27.06)

An article, a `view-source:` url and a page that is not an article, each wrapped into
`about:reader?url=…` and given to `tabs.update` of a live tab: every call is rejected with
`Illegal URL: <the url as passed>` and the tab stays on its page. `tabs.create` with the
`view-source:` wrapper is rejected the same way, as §16 already showed for an `https://` one.

| tab index | 0 | 1 | 2 |
| - | - | - | - |
| before | x* | y | z |
| `tabs.update(x, {url: about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page})` — settled 278 ms | | | |
| x updated | x* | y | z |
| `tabs.update(y, {url: about:reader?url=view-source%3Ahttps%3A%2F%2Fexample.com%2F})` — settled 258 ms | | | |
| y updated | x* | y | z |
| `tabs.update(z, {url: about:reader?url=https%3A%2F%2Fexample.com%2F})` — settled 263 ms | | | |
| z updated | x* | y | z |
| `tabs.create({url: about:reader?url=view-source%3Ahttps%3A%2F%2Fexample.com%2F})` — settled 264 ms | | | |
| created | x* | y | z |

- x: rejected - Illegal URL: about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page
- y: rejected - Illegal URL: about:reader?url=view-source%3Ahttps%3A%2F%2Fexample.com%2F
- z: rejected - Illegal URL: about:reader?url=https%3A%2F%2Fexample.com%2F
- created: rejected - Illegal URL: about:reader?url=view-source%3Ahttps%3A%2F%2Fexample.com%2F

### 32. `tabs.toggleReaderMode` refuses a tab that has never been shown and a page that is not an article; `isArticle` appears only once the tab has been shown; the toggle on and off is announced by `tabs.onUpdated` as a load of the new url and is invisible to `webRequest` (R27.07)

An article loaded in the background reports `isArticle: undefined`, and `toggleReaderMode` on it
is rejected: `The specified tab cannot be placed into reader mode.` Once the tab is activated,
`tabs.onUpdated` delivers `{isArticle: true}` 34 ms later, and the same call resolves: the tab
goes through `{status: loading}`, `{isArticle: false}`, `{status: loading, url: about:reader?url=…}`,
`{status: complete}` and reports the reader url with `isInReaderMode: true` and `isArticle: false`.
The second call brings the page back: `{status: loading}`, `{status: loading, url: <the page>}`,
`{isArticle: true}`, `{status: complete}`, and the tab reports the plain url with
`isInReaderMode: false`, `isArticle: true`. A shown `https://example.com/` reports
`isArticle: undefined` and is rejected with the same text. A `webRequest.onBeforeRequest`
listener for `main_frame` with `<all_urls>`, armed before the first toggle, saw no request for
either direction.

| tab index | 0 | 1 | 2 |
| - | - | - | - |
| before | x* | | |
| `tabs.create({url: article})` — settled 801 ms | | | |
| article | x* | ➕article | |
| `tabs.create({url: https://example.com/})` — settled 521 ms | | | |
| plain | x* | ➕article | ➕plain |
| `tabs.toggleReaderMode(article)  // a background tab` — settled 264 ms | | | |
| reader on | x* | ➕article | ➕plain |
| `tabs.update(article, {active: true})` — settled 235 ms | | | |
| article activated | x | ➕article* | ➕plain |
| `tabs.toggleReaderMode(article)  // the active tab` — settled 526 ms | | | |
| reader on 2 | x | ➕article* | ➕plain |
| `tabs.toggleReaderMode(article) again` — settled 228 ms | | | |
| reader off | x | ➕article* | ➕plain |
| `tabs.update(plain, {active: true})` — settled 275 ms | | | |
| plain activated | x | ➕article | ➕plain* |
| `tabs.toggleReaderMode(plain)  // the active tab` — settled 263 ms | | | |
| plain toggled | x | ➕article | ➕plain* |

```text
   34ms  tabs.onUpdated        article  {isArticle: true}
   58ms  tabs.onUpdated        article  {status: loading}
   62ms  tabs.onUpdated        article  {isArticle: false}
   67ms  tabs.onUpdated        article  {status: loading, url: about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page}
  139ms  tabs.onUpdated        article  {status: complete}
    4ms  tabs.onUpdated        article  {status: loading}
   10ms  tabs.onUpdated        article  {status: loading, url: https://en.wikipedia.org/wiki/Main_Page}
   10ms  tabs.onUpdated        article  {isArticle: true}
   11ms  tabs.onUpdated        article  {status: complete}
(4 tabs.onUpdated dropped, only these keys were kept: url/status/isArticle/discarded)
```

- article loaded in the background: `url:https://en.wikipedia.org/wiki/Main_Page` isInReaderMode:false isArticle:undefined status:complete discarded:false
- article: rejected - The specified tab cannot be placed into reader mode.
- article activated and loaded: `url:https://en.wikipedia.org/wiki/Main_Page` isInReaderMode:false isArticle:true status:complete discarded:false
- article after the toggle on: `url:about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page` isInReaderMode:true isArticle:false status:complete discarded:false
- article after the toggle off: `url:https://en.wikipedia.org/wiki/Main_Page` isInReaderMode:false isArticle:true status:complete discarded:false
- plain activated and loaded: `url:https://example.com/` isInReaderMode:false isArticle:undefined status:complete discarded:false
- plain: rejected - The specified tab cannot be placed into reader mode.

### 33. A tab in reader mode comes back from `sessions.restore()` and from a browser restart discarded, with `about:reader?url=…` and `isInReaderMode: true` already on it, and loads the reader page on that url when activated; the session record holds the reader url (R27.08, R27.09)

The record of the closed window in `sessions.getRecentlyClosed` carries the reader url as the
tab's `url` (with `favIconUrl`, which the scene tab's record lacks). After `sessions.restore()`
the fresh tab reports the reader url, `isInReaderMode: true` and `discarded: true` before it is
ever shown, like the background tabs of §27; activated, it loads the reader page on the same url.
A browser restart with the tab in the window behaves the same (R27.09).

R27.08:

| tab index | 0 | 1 |
| - | - | - |
| before (second window) | w* | |
| `tabs.create({url: article, openInReaderMode: true} in the second window)` — settled 508 ms | | |
| reader (second window) | w* | ➕reader |
| before close (second window) | w* | ➕reader |
| `windows.remove(second)` — settled 279 ms | | |
| `sessions.restore(sessionId of the window)` — settled 232 ms | | |
| restored (second window) | w* | reader |
| `tabs.update(reader, {active: true})` — settled 253 ms | | |
| activated (second window) | w | reader* |

- session record: `url:moz-extension://<own uuid>/tab.html?tab=w`; keys: active, hidden, highlighted, incognito, index, lastAccessed, pinned, sessionId, title, url, windowId
- session record: `url:about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page`; keys: active, favIconUrl, hidden, highlighted, incognito, index, lastAccessed, pinned, sessionId, title, url, windowId
- reader restored: `url:about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page` isInReaderMode:true isArticle:undefined status:complete discarded:true
- reader activated and loaded: `url:about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page` isInReaderMode:true isArticle:undefined status:complete discarded:false

R27.09:

| tab index | 0 | 1 |
| - | - | - |
| `tabs.create({url: article, openInReaderMode: true})` — settled 518 ms | | |
| reader | x* | ➕reader |
| before restart | x* | ➕reader |
| after restart | x* | reader |
| `tabs.update(reader, {active: true})` — settled 253 ms | | |
| reader activated | x | reader* |

- reader after the restart: `url:about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page` isInReaderMode:true isArticle:undefined status:complete discarded:true
- reader activated and loaded: `url:about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page` isInReaderMode:true isArticle:undefined status:complete discarded:false

### 34. `ExtensionInfo.hostPermissions` names the extension's own origin `moz-extension://<uuid>/*`; `tabs.create` accepts a `moz-extension://` url with an unknown uuid and one with an extension id in place of the uuid, and the tab stays on `about:blank` for good (R27.10)

`management.getSelf()` of the harness, whose manifest asks for `<all_urls>` only, reports
`hostPermissions: ["<all_urls>", "moz-extension://<own uuid>/*"]`: the extension's own origin is
listed next to the host permissions it asked for. A `moz-extension://` url with a uuid that
belongs to no installed extension, and one with the extension id where the uuid goes
(`moz-extension://stg-behavior-tests@drive4ik/tab.html`, which the URL parser reads as a user name
and a host, §41), both resolve `tabs.create`, and both tabs stay on `about:blank` with status
`complete` 20 s later — nothing is ever loaded.

| tab index | 0 | 1 | 2 |
| - | - | - | - |
| before | x* | | |
| `tabs.create({url: moz-extension://<unknown uuid>/tab.html?tab=unknown})` — settled 285 ms | | | |
| unknown | x* | ➕unknown | |
| `tabs.create({url: moz-extension://stg-behavior-tests@drive4ik/tab.html?tab=idform})` — settled 272 ms | | | |
| idform | x* | ➕unknown | ➕idform |

- getSelf: id `stg-behavior-tests@drive4ik`; `hostPermissions: ["<all_urls>","moz-extension://<own uuid>/*"]`
- unknown, 20 s later: `url:about:blank` isInReaderMode:false isArticle:undefined status:complete discarded:false
- idform, 20 s later: `url:about:blank` isInReaderMode:false isArticle:undefined status:complete discarded:false

### 35. A reader tab discarded before its url has committed reports `about:blank` without the flag until it is activated, hidden and shown alike, and then loads the reader page; discarded once the url has committed it keeps the reader url (R27.12)

Three tabs created in parallel with the flag and hidden and discarded right away: `tabs.hide`
hides all three, `tabs.discard` resolves, and every tab reports `url: about:blank`,
`isInReaderMode: false`, `discarded: true` — after the discard, and still after `tabs.show`. The
first `tabs.onUpdated` of each was `{status: loading}` 12–15 ms after the create, `{discarded:
true}` came at 37–38 ms, no url ever arrived. Activated, the tab loads the reader page:
`{discarded: false}`, `{status: loading}`, `{status: loading, url: about:reader?url=…}`,
`{status: complete}`, and reports the reader url with the flag. Three more created the same way,
hidden and discarded once each url read `about:reader?url=…` (187 ms after the resolve; `tabs.get`
read status `complete` on all three by then, though no `{status: complete}` event had arrived):
the reader url and the flag stay through the discard and the show, and the activated tab loads the
reader page on it. So the url a tab is discarded on is the url it reports until activated, and the
navigation itself is not lost either way.

| tab index | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
| - | - | - | - | - | - | - | - |
| before | x* | | | | | | |
| `tabs.create x3 ({url: article, openInReaderMode: true}) in parallel, then tabs.hide and tabs.discard at once` — settled 275 ms | | | | | | | |
| early batch hidden and discarded | x* | ➕e1(h) | ➕e2(h) | ➕e3(h) | | | |
| `tabs.create x3 in parallel, wait until every url reads about:reader, then tabs.hide and tabs.discard` — settled 278 ms | | | | | | | |
| committed batch hidden and discarded | x* | ➕e1(h) | ➕e2(h) | ➕e3(h) | ➕c1(h) | ➕c2(h) | ➕c3(h) |
| `tabs.show(all six)` — settled 264 ms | | | | | | | |
| shown | x* | ➕e1 | ➕e2 | ➕e3 | ➕c1 | ➕c2 | ➕c3 |
| `tabs.update(e1, {active: true})` — settled 794 ms | | | | | | | |
| e1 activated | x | ➕e1* | ➕e2 | ➕e3 | ➕c1 | ➕c2 | ➕c3 |
| `tabs.update(c1, {active: true})` — settled 516 ms | | | | | | | |
| c1 activated | x | ➕e1 | ➕e2 | ➕e3 | ➕c1* | ➕c2 | ➕c3 |

```text
   12ms  tabs.onUpdated        e1  {status: loading}
   13ms  tabs.onUpdated        e2  {status: loading}
   15ms  tabs.onUpdated        e3  {status: loading}
   37ms  tabs.onUpdated        e1  {discarded: true}
   37ms  tabs.onUpdated        e2  {discarded: true}
   38ms  tabs.onUpdated        e3  {discarded: true}
  118ms  tabs.onUpdated        c1  {status: loading}
  121ms  tabs.onUpdated        c2  {status: loading}
  140ms  tabs.onUpdated        c3  {status: loading}
  169ms  tabs.onUpdated        c1  {status: loading, url: about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page}
  170ms  tabs.onUpdated        c2  {status: loading, url: about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page}
  190ms  tabs.onUpdated        c3  {status: loading, url: about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page}
  242ms  tabs.onUpdated        c1  {discarded: true}
  242ms  tabs.onUpdated        c2  {discarded: true}
  242ms  tabs.onUpdated        c3  {discarded: true}
   13ms  tabs.onUpdated        e1  {discarded: false}
   16ms  tabs.onUpdated        e1  {status: loading}
   30ms  tabs.onUpdated        e1  {status: loading, url: about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page}
   59ms  tabs.onUpdated        e1  {status: complete}
    8ms  tabs.onUpdated        c1  {discarded: false}
   13ms  tabs.onUpdated        c1  {status: complete, url: about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page}
   15ms  tabs.onUpdated        c1  {status: loading}
   28ms  tabs.onUpdated        c1  {status: loading, url: about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page}
   58ms  tabs.onUpdated        c1  {status: complete}
(26 tabs.onUpdated dropped, only these keys were kept: url/status/isArticle/discarded)
```

- at the discard: e1 `url:about:blank` isInReaderMode:false isArticle:undefined status:complete discarded:false | e2 the same | e3 the same
- e1, e2, e3 after hide + discard, and shown: `url:about:blank` isInReaderMode:false isArticle:undefined status:complete discarded:true
- at the discard, 187 ms after the resolve: c1 `url:about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page` isInReaderMode:true isArticle:undefined status:complete discarded:false | c2 the same | c3 the same
- c1, c2, c3 after hide + discard, and shown: `url:about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page` isInReaderMode:true isArticle:undefined status:complete discarded:true
- e1 activated and loaded: `url:about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page` isInReaderMode:true isArticle:undefined status:complete discarded:false
- c1 activated and loaded: `url:about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page` isInReaderMode:true isArticle:undefined status:complete discarded:false

### 36. `management.getAll()` reports no `hostPermissions` for a disabled extension, an enabled one lists its own origin there: the uuid of an extension can be read only while it is enabled (R28.01, with other add-ons installed)

§36, §37 and §39 come from `round-28`, run in September 2026 in a profile prepared for it. A disabled
extension comes back without the `hostPermissions` field at all: its id is there, its uuid is
not. An enabled extension lists its own origin `moz-extension://<uuid>/*` in the field, as §34
showed for the harness through `getSelf`.

R28.01, a profile with two more add-ons next to the harness, one disabled and one enabled:

- extension 1: enabled:false hostPermissions: absent
- extension 2: enabled:true hostPermissions: lists its own origin

### 37. `tabs.create` and `tabs.update` open a page of another enabled extension, `location.replace` from an extension page to it is denied (R28.02, with other add-ons installed)

The `manifest.json` of another enabled extension, by its uuid. `tabs.create` resolves and the
tab is on the page with status `complete`; `tabs.update` of a live tab does the same. A page of
the harness that calls `location.replace` with the same url stays where it is, and the browser
console prints `Uncaught TypeError: Location.replace: Access to
'moz-extension://<other uuid>/manifest.json' from script denied.` Of the three ways tried, the
two calls of the tabs API reach the page, the navigation of the page itself does not. The tabs
were created without an index, their places in the rows are the profile's `newTabPosition`.

| tab index | 0 | 1 | 2 | 3 |
| - | - | - | - | - |
| before | x* | y | | |
| `tabs.create({url: <manifest.json of the other extension>})` — settled 228 ms | | | | |
| created | x* | ➕created | y | |
| `tabs.update(y, {url: <the same page>})` — settled 228 ms | | | | |
| y updated | x* | ➕created | y | |
| `tabs.create({url: navigate.html?to=<the same page>})  // the page of the harness calls location.replace on load` — settled 250 ms | | | | |
| nav | x* | ➕nav | ➕created | y |

- created: resolved, on the page, status complete
- y: resolved, on the page, status complete
- nav: BLOCKED - still on the page of the harness, status complete

### 39. `tabs.update` called by an extension page on its own tab opens a page of another enabled extension, in the default container and in a non-default one (R28.03, with other add-ons installed)

A page of the harness (`navigate.html`), loaded in a background tab, calls `tabs.getCurrent()`
and then `tabs.update(<its own tab>, {url: <manifest.json of the other extension>, loadReplace:
true})`. The call resolves, and the tab is on that page with status `complete`, in the container
it was created in. §37 measured the call made by the background page, here the page of the tab
makes it itself. The tabs were created without an index, their places in the rows are the
profile's `newTabPosition`.

| tab index | 0 | 1 | 2 |
| - | - | - | - |
| before | x* | | |
| `tabs.create({url: navigate.html})` — waited 2000 ms | | | |
| plain | x* | ➕plain | |
| `plain calls tabs.update(its own tab, {url: <manifest.json of the other extension>, loadReplace: true})` — waited 2000 ms | | | |
| plain updated | x* | ➕plain | |
| `tabs.create({url: navigate.html}, cookieStoreId: container)` — waited 2000 ms | | | |
| contained | x* | ➕contained | ➕plain |
| `contained calls tabs.update(its own tab, {url: <manifest.json of the other extension>, loadReplace: true})` — waited 2000 ms | | | |
| contained updated | x* | ➕contained | ➕plain |

- plain: resolved, on the page, status complete, container firefox-default
- container created for the test: firefox-container-17 (stg-test); removed at the end
- contained: resolved, on the page, status complete, container the requested one

### 40. The reader button pressed by the user makes no `main_frame` request, entering the reader view and leaving it (R27.11)

§40 and §41 come from `round-27`, run in September 2026. On a shown article the user presses F9:
`tabs.onUpdated` delivers `{status: loading}`, `{isArticle: false}`, `{status: loading, url:
about:reader?url=…}`, `{status: complete}`, and the tab reports the reader url with
`isInReaderMode: true` and `isArticle: false`. The second press brings the page back: `{status:
loading}`, `{status: loading, url: <the page>}`, `{isArticle: true}`, `{status: complete}`. A
`webRequest.onBeforeRequest` listener for `main_frame` with `<all_urls>`, armed before the first
press, counting the tabs of the test and the requests of no tab, saw no request for either press
— the button behaves like `tabs.toggleReaderMode` (§32). This is one run on Firefox 158: the
developer has seen the browser reload the page on leaving the reader view, under conditions this
run did not meet (see "Open questions").

| tab index | 0 | 1 |
| - | - | - |
| `tabs.create({url: article})` — settled 780 ms | | |
| article | x* | ➕article |
| `tabs.update(article, {active: true})` — settled 260 ms | | |
| article activated | x | ➕article* |
| `the user presses F9 in the article tab to enter the reader view` | | |
| entered | x | ➕article* |
| `the user presses F9 in the article tab to leave the reader view` | | |
| left | x | ➕article* |

```text
 3180ms  tabs.onUpdated        article  {status: loading}
 3182ms  tabs.onUpdated        article  {isArticle: false}
 3187ms  tabs.onUpdated        article  {status: loading, url: about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page}
 3321ms  tabs.onUpdated        article  {status: complete}
 2928ms  tabs.onUpdated        article  {status: loading}
 2933ms  tabs.onUpdated        article  {status: loading, url: https://en.wikipedia.org/wiki/Main_Page}
 2934ms  tabs.onUpdated        article  {isArticle: true}
 2935ms  tabs.onUpdated        article  {status: complete}
(4 tabs.onUpdated dropped, only these keys were kept: url/status/isArticle/discarded)
```

- article activated and loaded: `url:https://en.wikipedia.org/wiki/Main_Page` isInReaderMode:false isArticle:true status:complete discarded:false
- article entered: `url:about:reader?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMain_Page` isInReaderMode:true isArticle:false status:complete discarded:false
- main_frame requests, reader view entered: 0
- article left: `url:https://en.wikipedia.org/wiki/Main_Page` isInReaderMode:false isArticle:true status:complete discarded:false
- main_frame requests, reader view left: 0

### 41. The `URL` constructor parses an extension page address that names the extension by its id, in every shape an id takes, and reads its path, query and hash — but it does not give every id back: the host comes out in lower case and a leading `@` is dropped (R27.14)

`new URL('moz-extension://<id>/dir/page.html?url=…&x=1#part')` with made-up ids of every shape an
extension id takes, and with a uuid for comparison. The constructor throws for none of them, and
`pathname`, `search`, `hash` and `searchParams.get('url')` are read correctly for all. What the id
itself turns into differs: the part before an `@` is the user name and keeps its case, the part
after it is the host and comes out in lower case, an id in braces is a host as a whole, and an
`@` with nothing before it disappears from `href`. `origin` is `moz-extension://<host>`, never
the id. After `searchParams.set` the serialized address carries the same changes.

| id shape | id | `href` | `username` | `host` |
| - | - | - | - | - |
| uuid | `9a1b7c52-3f0e-4d8a-b6c1-2e5f7a9d0c34` | unchanged | empty | the uuid |
| `name@domain` | `some-addon@example.com` | unchanged | `some-addon` | `example.com` |
| `Name@Domain` | `Some-Addon@Example.Com` | CHANGED: `Some-Addon@example.com` | `Some-Addon` | `example.com` |
| `name_name@domain` | `some_addon@example.com` | unchanged | `some_addon` | `example.com` |
| `@name` | `@some-addon` | CHANGED: `some-addon`, the `@` is gone | empty | `some-addon` |
| `{guid}` | `{506e023c-7f2b-40a3-8066-bc5deb40aebe}` | unchanged | empty | the id as it is |
| `{GUID}` | `{66E978CD-981F-47DF-AC42-E3CF417C1467}` | CHANGED: `{66e978cd-981f-47df-ac42-e3cf417c1467}` | empty | the id in lower case |

### 42. `bookmarks.create` accepts every url that has a scheme and refuses one without it; the bookmark holds the url as the `URL` constructor serializes it (R29.01)

§42 comes from `round-29`, run in September 2026, with the optional `bookmarks` permission
granted by hand. Every url class a saved tab can hold was accepted, the ones `tabs.create`
refuses (§16) included. The only refusal was a url without a scheme: `Invalid bookmark:
{"title":"noscheme","type":1,"url":"example.com","parentGuid":"…"}`. The created node and
`bookmarks.getChildren` give the same url, and it is the url as it was passed except for the
three id shapes the `URL` constructor changes (§41).

| url | `bookmarks.create` | the bookmark holds |
| - | - | - |
| `https://example.com/` | accepted | the url as passed |
| `about:reader?url=https%3A%2F%2Fexample.com%2F` | accepted | the url as passed |
| `about:blank` | accepted | the url as passed |
| `about:config` | accepted | the url as passed |
| `file:///C:/stg-behavior-tests.txt` | accepted | the url as passed |
| `data:text/plain,hello` | accepted | the url as passed |
| `javascript:void(0)` | accepted | the url as passed |
| `view-source:https://example.com/` | accepted | the url as passed |
| `moz-extension://<own uuid>/tab.html?tab=own` | accepted | the url as passed |
| `moz-extension://9a1b7c52-3f0e-4d8a-b6c1-2e5f7a9d0c34/page.html` | accepted | the url as passed |
| `moz-extension://some-addon@example.com/page.html?url=https%3A%2F%2Fexample.com%2F` | accepted | the url as passed |
| `moz-extension://Some-Addon@Example.Com/page.html` | accepted | `moz-extension://Some-Addon@example.com/page.html` |
| `moz-extension://@some-addon/page.html` | accepted | `moz-extension://some-addon/page.html` |
| `moz-extension://{506e023c-7f2b-40a3-8066-bc5deb40aebe}/page.html` | accepted | the url as passed |
| `moz-extension://{66E978CD-981F-47DF-AC42-E3CF417C1467}/page.html` | accepted | `moz-extension://{66e978cd-981f-47df-ac42-e3cf417c1467}/page.html` |
| `example.com` | refused | |

### 43. `management.getAll()` lists the calling extension itself, and its entry names the origin `runtime.getURL` gives (R28.04, with other add-ons installed)

§43, §46 and §47 come from `round-28`, run in September 2026 in the profile prepared for it, the add-on
the user acted on was "YT Tweaks". The harness, loaded through about:debugging, is in its own
list with `installType: development` and its own origin among the host permissions; the two
other add-ons are `installType: normal`.

- the list holds 2 other extension(s), the harness is in it too
- the harness: enabled:true installType:development hostPermissions: lists its own origin, the origin is the one runtime.getURL gives
- extension 1: enabled:false installType:normal hostPermissions: absent
- extension 2: enabled:true installType:normal hostPermissions: lists its own origin

### 44. `management.onDisabled` and `onEnabled` reach the background and a page of the add-on in a background tab, in a container and in a hidden tab alike, and `management.getAll()` reports the new state right at the event; a timer of a page in a background or a hidden tab is held back to a second (R28.05, with other add-ons installed)

§44 comes from `round-28`, run in October 2026, the add-on the user acted on was "To Google
Translate". The background and three copies of a page of the harness — one in the default
container, one in a container made for the test, and one whose tab is hidden once the page has
loaded — all four with listeners on the management events; the user disables the add-on and
enables it again. Every context gets the event, the page in the hidden tab like the others.
`management.getAll()` called from the same context right at the event already reports the new
state — disabled: no `hostPermissions`, enabled: the own origin is back — and the reads 50 ms and
2 s later report the same. `management.getAll()` and `storage.session.get` both resolve in a page
of a container tab. A `setTimeout` of 50 ms took 50 ms in the background page and 1053–1070 ms in
the pages, the hidden one included: none of their tabs was the active one.

| tab index | 0 | 1 | 2 | 3 | 4 |
| - | - | - | - | - | - |
| before | x* | | | | |
| `tabs.create({url: management.html})` — settled 236 ms | | | | | |
| plain | x* | ➕plain | | | |
| `tabs.create({url: management.html}, cookieStoreId: container)` — settled 250 ms | | | | | |
| contained | x* | ➕plain | ➕contained | | |
| `tabs.create({url: management.html})` — settled 248 ms | | | | | |
| hidden | x* | ➕plain | ➕contained | ➕hidden | |
| `tabs.hide(hidden)` — settled 276 ms | | | | | |
| page hidden | x* | ➕plain | ➕contained | ➕hidden(h) | |
| `the user disables "To Google Translate"` | | | | | |
| disabled | x | ➕plain | ➕contained | ➕hidden(h) | unknown1* |
| `the user enables "To Google Translate"` | | | | | |
| enabled again | x | ➕plain | ➕contained | ➕hidden(h) | unknown1* |

`unknown1` is the about:addons tab the user opened in the scene window.

- background: management.getAll resolved, 2 extension(s); storage.session.get resolved
- plain: management.getAll resolved, 2 extension(s); storage.session.get resolved
- contained: management.getAll resolved, 2 extension(s); storage.session.get resolved
- disabled, background: onDisabled of extension 1, type extension - at the event (+0 ms): enabled:false hostPermissions: absent; 50 ms later (+50 ms): enabled:false hostPermissions: absent; 2000 ms after that (+2066 ms): enabled:false hostPermissions: absent; a setTimeout of 50 ms took 50 ms
- disabled, plain: onDisabled of extension 1, type extension - at the event (+0 ms): enabled:false hostPermissions: absent; 50 ms later (+50 ms): enabled:false hostPermissions: absent; 2000 ms after that (+2065 ms): enabled:false hostPermissions: absent; a setTimeout of 50 ms took 1053 ms
- disabled, contained: onDisabled of extension 1, type extension - at the event (+0 ms): enabled:false hostPermissions: absent; 50 ms later (+50 ms): enabled:false hostPermissions: absent; 2000 ms after that (+2066 ms): enabled:false hostPermissions: absent; a setTimeout of 50 ms took 1055 ms
- disabled, hidden: onDisabled of extension 1, type extension - at the event (+0 ms): enabled:false hostPermissions: absent; 50 ms later (+50 ms): enabled:false hostPermissions: absent; 2000 ms after that (+2066 ms): enabled:false hostPermissions: absent; a setTimeout of 50 ms took 1054 ms
- enabled again, background: onEnabled of extension 1, type extension - at the event (+0 ms): enabled:true hostPermissions: lists its own origin; 50 ms later (+50 ms): enabled:true hostPermissions: lists its own origin; 2000 ms after that (+2082 ms): enabled:true hostPermissions: lists its own origin; a setTimeout of 50 ms took 50 ms
- enabled again, plain: onEnabled of extension 1, type extension - at the event (+0 ms): enabled:true hostPermissions: lists its own origin; 50 ms later (+50 ms): enabled:true hostPermissions: lists its own origin; 2000 ms after that (+2082 ms): enabled:true hostPermissions: lists its own origin; a setTimeout of 50 ms took 1069 ms
- enabled again, contained: onEnabled of extension 1, type extension - at the event (+0 ms): enabled:true hostPermissions: lists its own origin; 50 ms later (+50 ms): enabled:true hostPermissions: lists its own origin; 2000 ms after that (+2082 ms): enabled:true hostPermissions: lists its own origin; a setTimeout of 50 ms took 1070 ms
- enabled again, hidden: onEnabled of extension 1, type extension - at the event (+0 ms): enabled:true hostPermissions: lists its own origin; 50 ms later (+50 ms): enabled:true hostPermissions: lists its own origin; 2000 ms after that (+2081 ms): enabled:true hostPermissions: lists its own origin; a setTimeout of 50 ms took 1069 ms

### 46. A page of another enabled extension can be created discarded: the tab reports the url while it is discarded and loads the page when activated, in a container too (R28.07, with other add-ons installed)

| tab index | 0 | 1 | 2 |
| - | - | - | - |
| before | x* | | |
| `tabs.create({url: <manifest.json of the other extension>, discarded: true, title})` — settled 262 ms | | | |
| lazy | x* | ➕lazy | |
| `tabs.update(lazy, {active: true})` — waited 2000 ms | | | |
| lazy activated | x | ➕lazy* | |
| `tabs.create({url: <manifest.json of the other extension>, discarded: true, title}, cookieStoreId: container)` — settled 274 ms | | | |
| lazycontained | x | ➕lazy* | ➕lazycontained |
| `tabs.update(lazycontained, {active: true})` — waited 2000 ms | | | |
| lazycontained activated | x | ➕lazy | ➕lazycontained* |

- lazy at the resolve: `url:moz-extension://<other uuid>/manifest.json` status:complete discarded:true hidden:false
- lazy settled: `url:moz-extension://<other uuid>/manifest.json` status:complete discarded:true hidden:false
- lazy activated: `url:moz-extension://<other uuid>/manifest.json` status:complete discarded:false hidden:false, container firefox-default
- container created for the test: firefox-container-18 (stg-test); removed at the end
- lazycontained at the resolve: `url:moz-extension://<other uuid>/manifest.json` status:complete discarded:true hidden:false
- lazycontained settled: `url:moz-extension://<other uuid>/manifest.json` status:complete discarded:true hidden:false
- lazycontained activated: `url:moz-extension://<other uuid>/manifest.json` status:complete discarded:false hidden:false, container the requested one

### 47. `tabs.update` to a page of another extension works when the page calls it as soon as its script runs, and from a hidden tab, which stays hidden (R28.08, with other add-ons installed)

A page whose script calls `tabs.getCurrent()` and `tabs.update` on its own tab right away: the
page reaches `complete` first, 35 ms after the create, the navigation of the update starts 2 ms
later, and the tab is on the target. A page in a hidden tab, asked by a message: the call
resolves, the tab is on the target and still hidden, not discarded.

| tab index | 0 | 1 | 2 |
| - | - | - | - |
| before | x* | | |
| `tabs.create({url: navigate.html?update=<manifest.json of the other extension>})  // the script of the page calls tabs.update on its own tab as soon as it runs` — waited 2000 ms | | | |
| atload | x* | ➕atload | |
| `tabs.create({url: navigate.html})` — waited 2000 ms | | | |
| hidden created | x* | ➕atload | ➕hidden |
| `tabs.hide(hidden)` — settled 275 ms | | | |
| hidden | x* | ➕atload | ➕hidden(h) |
| `hidden calls tabs.update(its own tab, {url: <manifest.json of the other extension>, loadReplace: true})` — waited 2000 ms | | | |
| hidden updated | x* | ➕atload | ➕hidden(h) |

```text
    8ms  tabs.onUpdated        atload  {status: loading}
   17ms  tabs.onUpdated        atload  {status: loading}
   35ms  tabs.onUpdated        atload  {status: complete}
   37ms  tabs.onUpdated        atload  {status: loading}
   46ms  tabs.onUpdated        atload  {status: loading}
   47ms  tabs.onUpdated        atload  {status: complete}
    9ms  tabs.onUpdated        hidden  {status: loading}
   19ms  tabs.onUpdated        hidden  {status: loading}
   37ms  tabs.onUpdated        hidden  {status: complete}
    7ms  tabs.onUpdated        hidden  {status: loading}
   18ms  tabs.onUpdated        hidden  {status: loading}
   19ms  tabs.onUpdated        hidden  {status: complete}
(5 tabs.onUpdated dropped, only these keys were kept: status)
```

- atload: no refusal reported, on the page, status complete
- hidden: resolved, on the page, status complete, hidden true, discarded false

### 48. When an extension is disabled, the browser closes the loaded tabs on a page that runs its code, visible and hidden alike, and keeps the discarded ones on the same url; enabling it again brings nothing back, and the extension keeps its uuid (R28.10, with other add-ons installed)

§48 to §50 come from `round-28`, run in September 2026 in the profile prepared for it, the add-on
the user acted on was "YT Tweaks", the page is its options page — `optionsUrl` of
`management.getAll()`, a page that runs the code of the extension. Four tabs on it: a loaded
one, a discarded one, a hidden one and a hidden discarded one. The
user disables the add-on: `tabs.onRemoved` comes for the loaded tab and for the hidden tab, in
the same millisecond; the two discarded tabs stay, on the same url, discarded. Enabling the add-on
again changes nothing: the two closed tabs are gone for good, the two discarded ones are still
there, still discarded. The background gets `onDisabled` and `onEnabled`, and
`management.getAll()` reports the new state right at the event, as in §44. After the enable the
add-on lists the same origin as before: a disable and an enable keep the uuid. `unknown1` is the
about:addons tab the user opened in the scene window.

| tab index | 0 | 1 | 2 | 3 | 4 |
| - | - | - | - | - | - |
| before | x* | loaded | lazy | hidden(h) | hiddenlazy(h) |
| `the user disables "YT Tweaks"` | | | | | |
| disabled | x | lazy | hiddenlazy(h) | unknown1* | |
| `the user enables "YT Tweaks"` | | | | | |
| enabled again | x | lazy | hiddenlazy(h) | unknown1* | |

```text
10560ms  tabs.onUpdated        unknown1  {status: loading}
10572ms  tabs.onUpdated        unknown1  {status: loading}
10619ms  tabs.onUpdated        unknown1  {status: loading}
10625ms  tabs.onUpdated        unknown1  {status: complete}
12768ms  tabs.onRemoved        loaded  isWindowClosing:false
12768ms  tabs.onRemoved        hidden  isWindowClosing:false
(2 tabs.onUpdated dropped, only these keys were kept: status/discarded/hidden)
```

- before, loaded: `url:moz-extension://<other uuid>/options/options.html` status:complete discarded:false hidden:false
- before, lazy: `url:moz-extension://<other uuid>/options/options.html` status:complete discarded:true hidden:false
- before, hidden: `url:moz-extension://<other uuid>/options/options.html` status:complete discarded:false hidden:true
- before, hiddenlazy: `url:moz-extension://<other uuid>/options/options.html` status:complete discarded:true hidden:true
- disabled, loaded: the tab is gone
- disabled, lazy: `url:moz-extension://<other uuid>/options/options.html` status:complete discarded:true hidden:false
- disabled, hidden: the tab is gone
- disabled, hiddenlazy: `url:moz-extension://<other uuid>/options/options.html` status:complete discarded:true hidden:true
- disabled, background: onDisabled of extension 2, type extension - at the event (+0 ms): enabled:false hostPermissions: absent; 50 ms later (+50 ms): enabled:false hostPermissions: absent; 2000 ms after that (+2052 ms): enabled:false hostPermissions: absent; a setTimeout of 50 ms took 51 ms
- enabled again, loaded: the tab is gone
- enabled again, lazy: `url:moz-extension://<other uuid>/options/options.html` status:complete discarded:true hidden:false
- enabled again, hidden: the tab is gone
- enabled again, hiddenlazy: `url:moz-extension://<other uuid>/options/options.html` status:complete discarded:true hidden:true
- enabled again, background: onEnabled of extension 2, type extension - at the event (+0 ms): enabled:true hostPermissions: lists its own origin; 50 ms later (+50 ms): enabled:true hostPermissions: lists its own origin; 2000 ms after that (+2064 ms): enabled:true hostPermissions: lists its own origin; a setTimeout of 50 ms took 171 ms
- the add-on has the same uuid as before

### 49. When an extension is removed, the browser closes the same tabs and keeps the discarded ones on the url with the old uuid; `management.getAll()` no longer lists it right at `onUninstalled`, and right at `onInstalled` the call is REJECTED with "An unexpected error occurred" — 50 ms later it lists the add-on, enabled and with a NEW uuid (R28.11, with other add-ons installed)

The same four tabs on the options page. The user removes the add-on and closes about:addons:
`tabs.onRemoved` for the loaded tab and the hidden tab, in the same millisecond, the discarded ones
stay. The background gets `onUninstalled`, and `management.getAll()` right at the event does not
list the add-on any more. The user installs the add-on again: the background gets `onInstalled`,
and `management.getAll()` called right at the event rejects with `An unexpected error occurred`;
50 ms later, and 2 s after that, it lists the add-on enabled with its origin among the host
permissions — an origin with ANOTHER uuid. The two discarded tabs are still there, on the url with
the old uuid, discarded. `unknown1` is the about:addons tab, `unknown2` the tab the add-on was
installed from.

| tab index | 0 | 1 | 2 | 3 | 4 |
| - | - | - | - | - | - |
| before | x* | loaded | lazy | hidden(h) | hiddenlazy(h) |
| `the user removes "YT Tweaks"` | | | | | |
| removed | x* | lazy | hiddenlazy(h) | | |
| `the user installs again "YT Tweaks"` | | | | | |
| installed again | x | lazy | hiddenlazy(h) | unknown2* | |

```text
14209ms  tabs.onUpdated        unknown1  {status: loading}
14221ms  tabs.onUpdated        unknown1  {status: loading}
14267ms  tabs.onUpdated        unknown1  {status: loading}
14273ms  tabs.onUpdated        unknown1  {status: complete}
18324ms  tabs.onRemoved        loaded  isWindowClosing:false
18324ms  tabs.onRemoved        hidden  isWindowClosing:false
32848ms  tabs.onRemoved        unknown1  isWindowClosing:false
 4791ms  tabs.onUpdated        unknown2  {status: loading}
 5184ms  tabs.onUpdated        unknown2  {status: loading}
 5551ms  tabs.onUpdated        unknown2  {status: complete}
(8 tabs.onUpdated dropped, only these keys were kept: status/discarded/hidden)
```

- before: the four tabs read as in §48
- removed, loaded: the tab is gone
- removed, lazy: `url:moz-extension://<other uuid>/options/options.html` status:complete discarded:true hidden:false
- removed, hidden: the tab is gone
- removed, hiddenlazy: `url:moz-extension://<other uuid>/options/options.html` status:complete discarded:true hidden:true
- removed, background: onUninstalled of extension 2, type extension - at the event (+0 ms): not in the list; 50 ms later (+50 ms): not in the list; 2000 ms after that (+2253 ms): not in the list; a setTimeout of 50 ms took 50 ms
- installed again, loaded: the tab is gone
- installed again, lazy: `url:moz-extension://<other uuid>/options/options.html` status:complete discarded:true hidden:false
- installed again, hidden: the tab is gone
- installed again, hiddenlazy: `url:moz-extension://<other uuid>/options/options.html` status:complete discarded:true hidden:true
- installed again, background: onInstalled of extension 2, type extension - at the event (+0 ms): getAll rejected - An unexpected error occurred; 50 ms later (+50 ms): enabled:true hostPermissions: lists its own origin; 2000 ms after that (+2070 ms): enabled:true hostPermissions: lists its own origin; a setTimeout of 50 ms took 50 ms
- the add-on has ANOTHER uuid

### 50. A page that runs the code of another enabled extension opens the way its `manifest.json` does: by `tabs.create`, created discarded and then activated, and by `tabs.update` a page calls on its own tab (R28.12, with other add-ons installed)

The options page of the add-on, as §37, §39 and §46 measured its `manifest.json`: a tab created
on it starts on `about:blank` and is on the page once loaded; created discarded it reports the
url at once and is on the page once activated; a page of the harness sends its own tab there
with `tabs.update`, the call resolves and the tab is on the page.

| tab index | 0 | 1 | 2 | 3 |
| - | - | - | - | - |
| before | x* | | | |
| `tabs.create({url: <options page of the other extension>})` — waited 2000 ms | | | | |
| created | x* | ➕created | | |
| `tabs.create({url: <options page of the other extension>, discarded: true, title})` — waited 2000 ms | | | | |
| lazy | x* | ➕created | ➕lazy | |
| `tabs.update(lazy, {active: true})` — waited 2000 ms | | | | |
| lazy activated | x | ➕created | ➕lazy* | |
| `tabs.create({url: navigate.html})` — waited 2000 ms | | | | |
| page | x | ➕created | ➕lazy* | ➕page |
| `page calls tabs.update(its own tab, {url: <options page of the other extension>, loadReplace: true})` — waited 2000 ms | | | | |
| page updated | x | ➕created | ➕lazy* | ➕page |

- created at the resolve: `url:about:blank` status:complete discarded:false hidden:false
- created loaded: on a page of the extension, `url:moz-extension://<other uuid>/options/options.html` status:complete discarded:false hidden:false
- lazy at the resolve: `url:moz-extension://<other uuid>/options/options.html` status:complete discarded:true hidden:false
- lazy activated: on a page of the extension, `url:moz-extension://<other uuid>/options/options.html` status:complete discarded:false hidden:false
- page at the resolve: `url:about:blank` status:complete discarded:false hidden:false
- page: the call resolved
- page updated: on a page of the extension, `url:moz-extension://<other uuid>/options/options.html` status:complete discarded:false hidden:false

### 53. `tabs.update({url, loadReplace: true})` on a discarded tab loads the new page in place: the tab stops being discarded at the resolve, where it reports `about:blank`, and is on the new page once settled; a hidden tab stays hidden, and a tab born discarded on a page of an unknown uuid is updated the same way (R27.15)

§53 comes from `round-27`, run in October 2026. Five discarded tabs: one born discarded on a page
of the add-on, one discarded after its load, one discarded and hidden, and two born discarded on
`moz-extension://<unknown uuid>/tab.html` — the shape of a tab another install of an add-on left
behind — one of them hidden. The browser lets a tab be born discarded on a page of an unknown
uuid, and the tab reports that url while it is discarded. Each of the five is sent to another
page of the add-on. Every call resolves, and the tab it resolves with is no longer discarded and
reports `about:blank` with status `complete`. `tabs.onUpdated` delivers `{discarded: false}`
first and the load of the new page after it; the tab is on the new page some 40 ms after the
call, and 330 ms after it for the two tabs of the unknown uuid, whose load starts 300 ms after
`{discarded: false}`. A tab discarded after its load reports its old page for a moment in
between, `{status: complete, url: <the old page>}`. A hidden tab is loaded the same way and stays
hidden. Activated afterwards, every tab is on the new page.

| tab index | 0 | 1 | 2 | 3 | 4 | 5 |
| - | - | - | - | - | - | - |
| before | x* | | | | | |
| `tabs.create({url: own page, discarded: true, title})` — settled 264 ms | | | | | | |
| born | x* | ➕born | | | | |
| `tabs.create({url: own page})` — settled 238 ms | | | | | | |
| unloaded | x* | ➕born | ➕unloaded | | | |
| `tabs.create({url: own page})` — settled 242 ms | | | | | | |
| hidden | x* | ➕born | ➕unloaded | ➕hidden | | |
| `tabs.discard([unloaded, hidden])` — settled 268 ms | | | | | | |
| discarded | x* | ➕born | ➕unloaded | ➕hidden | | |
| `tabs.create({url: moz-extension://<unknown uuid>/tab.html, discarded: true, title})` — settled 266 ms | | | | | | |
| dead | x* | ➕born | ➕unloaded | ➕hidden | ➕dead | |
| `tabs.create({url: moz-extension://<unknown uuid>/tab.html, discarded: true, title})` — settled 272 ms | | | | | | |
| deadhidden | x* | ➕born | ➕unloaded | ➕hidden | ➕dead | ➕deadhidden |
| `tabs.hide([hidden, deadhidden])` — settled 256 ms | | | | | | |
| hidden 2 | x* | ➕born | ➕unloaded | ➕hidden(h) | ➕dead | ➕deadhidden(h) |
| `tabs.update(born, {url: <another own page>, loadReplace: true})` — settled 245 ms | | | | | | |
| born updated | x* | ➕born | ➕unloaded | ➕hidden(h) | ➕dead | ➕deadhidden(h) |
| `tabs.update(unloaded, {url: <another own page>, loadReplace: true})` — settled 244 ms | | | | | | |
| unloaded updated | x* | ➕born | ➕unloaded | ➕hidden(h) | ➕dead | ➕deadhidden(h) |
| `tabs.update(hidden, {url: <another own page>, loadReplace: true})` — settled 241 ms | | | | | | |
| hidden updated | x* | ➕born | ➕unloaded | ➕hidden(h) | ➕dead | ➕deadhidden(h) |
| `tabs.update(dead, {url: <another own page>, loadReplace: true})` — settled 530 ms | | | | | | |
| dead updated | x* | ➕born | ➕unloaded | ➕hidden(h) | ➕dead | ➕deadhidden(h) |
| `tabs.update(deadhidden, {url: <another own page>, loadReplace: true})` — settled 774 ms | | | | | | |
| deadhidden updated | x* | ➕born | ➕unloaded | ➕hidden(h) | ➕dead | ➕deadhidden(h) |
| `tabs.show([hidden, deadhidden])` — settled 265 ms | | | | | | |
| shown | x* | ➕born | ➕unloaded | ➕hidden | ➕dead | ➕deadhidden |
| `tabs.update(born, {active: true})` — waited 2000 ms | | | | | | |
| born activated | x | ➕born* | ➕unloaded | ➕hidden | ➕dead | ➕deadhidden |
| `tabs.update(unloaded, {active: true})` — waited 2000 ms | | | | | | |
| unloaded activated | x | ➕born | ➕unloaded* | ➕hidden | ➕dead | ➕deadhidden |
| `tabs.update(hidden, {active: true})` — waited 2000 ms | | | | | | |
| hidden activated | x | ➕born | ➕unloaded | ➕hidden* | ➕dead | ➕deadhidden |
| `tabs.update(dead, {active: true})` — waited 2000 ms | | | | | | |
| dead activated | x | ➕born | ➕unloaded | ➕hidden | ➕dead* | ➕deadhidden |
| `tabs.update(deadhidden, {active: true})` — waited 2000 ms | | | | | | |
| deadhidden activated | x | ➕born | ➕unloaded | ➕hidden | ➕dead | ➕deadhidden* |

The events of the five updates, each clock starting at its own call:

```text
    2ms  tabs.onUpdated        born  {discarded: false}
    8ms  tabs.onUpdated        born  {status: loading}
   17ms  tabs.onUpdated        born  {status: loading, url: <own page>/navigate.html?tab=born}
   36ms  tabs.onUpdated        born  {status: complete}
    6ms  tabs.onUpdated        unloaded  {discarded: false}
    8ms  tabs.onUpdated        unloaded  {status: complete, url: <own page>/tab.html?tab=unloaded}
   11ms  tabs.onUpdated        unloaded  {status: loading}
   18ms  tabs.onUpdated        unloaded  {status: loading, url: <own page>/navigate.html?tab=unloaded}
   36ms  tabs.onUpdated        unloaded  {status: complete}
    6ms  tabs.onUpdated        hidden  {discarded: false}
   10ms  tabs.onUpdated        hidden  {status: complete, url: <own page>/tab.html?tab=hidden}
   11ms  tabs.onUpdated        hidden  {status: loading}
   21ms  tabs.onUpdated        hidden  {status: loading, url: <own page>/navigate.html?tab=hidden}
   40ms  tabs.onUpdated        hidden  {status: complete}
   12ms  tabs.onUpdated        dead  {discarded: false}
  302ms  tabs.onUpdated        dead  {status: loading}
  312ms  tabs.onUpdated        dead  {status: loading, url: <own page>/navigate.html?tab=dead}
  330ms  tabs.onUpdated        dead  {status: complete}
    8ms  tabs.onUpdated        deadhidden  {discarded: false}
  314ms  tabs.onUpdated        deadhidden  {status: loading}
  323ms  tabs.onUpdated        deadhidden  {status: loading, url: <own page>/navigate.html?tab=deadhidden}
  338ms  tabs.onUpdated        deadhidden  {status: complete}
```

- born, unloaded, dead before the update: on the old page, status complete, discarded true, hidden false
- hidden, deadhidden before the update: on the old page, status complete, discarded true, hidden true
- born, unloaded, dead at the resolve: on about:blank, status complete, discarded false, hidden false
- hidden, deadhidden at the resolve: on about:blank, status complete, discarded false, hidden true
- born, unloaded, dead settled: on the new page, status complete, discarded false, hidden false
- hidden, deadhidden settled: on the new page, status complete, discarded false, hidden true
- all five activated: on the new page, status complete, discarded false, hidden false

### 54. A `searchParams.set` or a `search` setter that takes the address over the length limit does not throw: one character over, the address is built all the same; far over, the address is left as it was, without the key, while `searchParams` of the same object still gives the value after `set`; the `URL` constructor throws from one character over (R20.08)

§54 comes from `round-20`, run in October 2026. The address is built the way the add-on builds
the address of its stub page: a page of the add-on with the url in the search key `url`. Three
ways of building it — `new URL(page)` followed by `searchParams.set('url', value)`, the same
followed by `url.search = <the serialized key>`, and `new URL(<the whole address>)` — against the
address a plain string concatenation gives. None of the setters throws for any value. Up to the
limit of §20 all three build the address. One character over it the two setters still build it,
`href` is 1 048 573 characters long, and only the constructor throws. A hundred thousand
characters over, both setters leave `href` as the bare page address, without the key; the list
the object keeps says otherwise after `searchParams.set`, where `searchParams.get('url')` still
gives the value, and agrees after the `search` setter, where it gives `null`. A value that is
under the limit itself and goes over it only when serialized, a slash taking three characters,
behaves like one that is over as it is. Where between one character and a hundred thousand the
setters stop building the address was not measured.

| the address asked for | `searchParams.set` | the `search` setter | the constructor |
| - | - | - | - |
| 1 066 chars, a value of 1 000 letters | the address asked for | the address asked for | the address asked for |
| 1 048 572 chars, the limit | the address asked for | the address asked for | the address asked for |
| 1 048 573 chars, one over | the address asked for | the address asked for | throws |
| 1 148 572 chars, 100 000 over | the bare page address, no key in it; `searchParams.get('url')` gives the value | the bare page address, no key in it; `searchParams.get('url')` gives `null` | throws |
| 1 148 574 chars, a value of 382 836 slashes | the bare page address, no key in it; `searchParams.get('url')` gives the value | the bare page address, no key in it; `searchParams.get('url')` gives `null` | throws |

### 55. At the first line of a background that starts with the browser, `management.getAll()` already tells every enabled extension with its own origin, and twenty seconds of reads tell nothing else — in a start where the windows are already there (R28.13, with another add-on installed, the harness installed in the profile)

§55 comes from `round-28`, run in October 2026 with the harness installed in the profile as an
unsigned zip (`installType: normal`) next to one enabled add-on. A probe armed before the restart
runs as the first import of the background script: it calls `management.getAll()` in the turn the
module is evaluated in, then every 250 ms for 20 s, and keeps every read that tells something
new. After the restart the background started once. Its first line ran when the background page
was 110 ms old; the browser already had its two windows, `runtime.onStartup` came 8 ms later, and
no `windows.onCreated` followed. The first read lists the harness and the other add-on enabled,
each with its own origin among the host permissions, and none of the 75 reads over 19.9 s told
anything else. This is a background started once the windows are there; a background that finds
no normal window (private and popup windows do not count) attaches no listener: `init` of the
add-on waits for `windows.onCreated` and reloads the add-on.

| tab index | 0 |
| - | - |
| before restart | x* |
| after restart | x* |

- add-on starts while the test was suspended: 1; the harness now: installType normal
- the first line ran when the background page was 110 ms old; windows at the first line: 2; runtime.onStartup: +8 ms; the first windows.onCreated: none
- 75 read(s) of management.getAll() over 19918 ms, 1 of them told something new
- the harness: at the first line (+1 ms) - enabled:true hostPermissions: lists its own origin
- extension 1: at the first line (+1 ms) - enabled:true hostPermissions: lists its own origin

### 56. `runtime.MessageSender` carries the id of the add-on for a page of the add-on and for its content script alike; `url` is the address of the page of the add-on for the first and the address of the web page for the second, and `envType` is `addon_child` against `content_child` — for a message and for a port alike (R31.01)

§56 comes from `round-31`, run in October 2026. The senders are a page of the add-on in a tab and
the content script the manifest declares for `https://example.org/*`, with `all_frames` and
`match_about_blank`, in the main frame of the page and in a frame of the same address the script
adds to it. Each calls `runtime.sendMessage` and opens a port with `runtime.connect`; the
background reads the sender of the message and `port.sender`, and the two are the same for every
sender. The keys are `contextId`, `documentId`, `envType`, `frameId`, `id`, `origin`, `tab` and
`url`. `id` is the id of the add-on for all of them: it does not tell a page of the add-on from
its content script. `url` does, and `envType` does. `frameId` is 0 for the page and for the main
frame and another number for the frame. From the `about:blank` frame the script added to the page
nothing arrived by either way; whether the script ran there at all, the run does not tell.

| the sender | `id` | `url` | `tab` | `frameId` | `envType` |
| - | - | - | - | - | - |
| a page of the add-on in a tab | of the add-on | `moz-extension://<own uuid>/sender.html?tab=page` | page | 0 | `addon_child` |
| the content script, main frame | of the add-on | `https://example.org/?tab=web` | web | 0 | `content_child` |
| the content script, a frame of the same address | of the add-on | `https://example.org/?tab=web` | web | not 0 | `content_child` |
| the content script, an `about:blank` frame | nothing arrived | | | | |

| tab index | 0 | 1 | 2 |
| - | - | - | - |
| before | x* | | |
| `tabs.create({url: sender.html})` — settled 245 ms | | | |
| page | x* | ➕page | |
| `tabs.create({url: https://example.org/})  // the content script adds a frame of the same site and an about:blank frame` — settled 1065 ms | | | |
| web | x* | ➕page | ➕web |

- web: status complete, title "Example Domain"

### 57. `management.onUninstalled` and `onInstalled` reach a page of the add-on in a background tab and in a hidden tab the same way they reach the background: at the removal `management.getAll()` of every context no longer lists the add-on, right at the install the call is rejected in every context and 50 ms later lists the add-on enabled with its own origin (R28.14, with other add-ons installed)

§57 comes from `round-28`, run in October 2026 in the profile prepared for it, the add-on the user
acted on was "To Google Translate". The background and two copies of a page of the harness — one
in a background tab and one whose tab is hidden once the page has loaded — with listeners on the
management events; the user removes the add-on and installs it again. Every context gets both
events, the page in the hidden tab like the others, and the reads of every context are the ones
§49 recorded for the background: at `onUninstalled` the add-on is no longer in the list, at
`onInstalled` `management.getAll()` is rejected with "An unexpected error occurred" and answers
50 ms later, the add-on enabled with its own origin. A `setTimeout` of 50 ms took 50–51 ms in the
background and 1005–1008 ms in the pages (§44).

| tab index | 0 | 1 | 2 |
| - | - | - | - |
| before | x* | | |
| `tabs.create({url: management.html})` — settled 242 ms | | | |
| plain | x* | ➕plain | |
| `tabs.create({url: management.html})` — settled 244 ms | | | |
| hidden | x* | ➕plain | ➕hidden |
| `tabs.hide(hidden)` — settled 265 ms | | | |
| page hidden | x* | ➕plain | ➕hidden(h) |
| `the user removes "To Google Translate"` | | | |
| removed | x* | ➕plain | ➕hidden(h) |
| `the user installs again "To Google Translate"` | | | |
| installed again | x* | ➕plain | ➕hidden(h) |

- removed, background: onUninstalled of extension 1, type extension - at the event (+0 ms): not in the list; 50 ms later (+50 ms): not in the list; 2000 ms after that (+2056 ms): not in the list; a setTimeout of 50 ms took 51 ms
- removed, plain: onUninstalled of extension 1, type extension - at the event (+0 ms): not in the list; 50 ms later (+50 ms): not in the list; 2000 ms after that (+2055 ms): not in the list; a setTimeout of 50 ms took 1008 ms
- removed, hidden: onUninstalled of extension 1, type extension - at the event (+0 ms): not in the list; 50 ms later (+50 ms): not in the list; 2000 ms after that (+2056 ms): not in the list; a setTimeout of 50 ms took 1007 ms
- installed again, background: onInstalled of extension 1, type extension - at the event (+0 ms): getAll rejected - An unexpected error occurred; 50 ms later (+50 ms): enabled:true hostPermissions: lists its own origin; 2000 ms after that (+2070 ms): enabled:true hostPermissions: lists its own origin; a setTimeout of 50 ms took 50 ms
- installed again, plain: onInstalled of extension 1, type extension - at the event (+0 ms): getAll rejected - An unexpected error occurred; 50 ms later (+50 ms): enabled:true hostPermissions: lists its own origin; 2000 ms after that (+2069 ms): enabled:true hostPermissions: lists its own origin; a setTimeout of 50 ms took 1005 ms
- installed again, hidden: onInstalled of extension 1, type extension - at the event (+0 ms): getAll rejected - An unexpected error occurred; 50 ms later (+50 ms): enabled:true hostPermissions: lists its own origin; 2000 ms after that (+2069 ms): enabled:true hostPermissions: lists its own origin; a setTimeout of 50 ms took 1005 ms

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
- The anchor may land inside a native group's span → the tab will join that group
  (BEHAVIOR-TABGROUPS.md §7); this is expected, the mirror syncs membership.
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
  privileged `about:` and the like never reach `tabs.create` as they are — `about:reader` alone
  becomes the flag instead (§30, the bullet below). `Tabs.create` opens
  `help/stg-unsupported-url.html` for them, and `help/dummy.html` with the real url handed over by
  message for what a page can navigate to itself: a `data:` url of a type from §18, of any
  size (§22). No url of another scheme can be longer than the limit (§20, §22), but the stub
  address of such a url, with the url in its search key, can be: it is handed over the same way,
  to the stub page without the key. `searchParams.set` gives no sign that the address has
  outgrown the limit — one character over it builds the address all the same, far over it
  leaves the bare page address behind (§54) — so the address is measured as a string, before a
  `URL` object is asked to hold it. The stub pages need no background page, so they live in
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
  50–65 ms after `windows.onCreated` it is `about:blank` with status `complete`, and a created
  tab is the same for its first 9–10 ms (§23), so the browser's state gives no sign that a page
  is on its way. The cache keeps that sign itself, as the requested url: the address the tab was
  asked for (`Tabs.create`, `onBeforeTabRequest`), kept until the tab settles on a non-empty url
  (status `complete`: a url read from a loading tab is not final, §28) or the browser announces
  `complete` on an empty tab. `Tabs.fillEmptyUrl` replaces an empty url in a
  snapshot by what the cache knows: the requested url, else the last reported one, for a
  snapshot older than the mirror (the group lists `runGrandRestoreNow` keeps from its first
  read). A newborn active tab is known to nobody but `tabsToRestore` until its request is seen:
  by the time STG reads the window, 1000 ms later, it holds its real url in every run here, and
  on a machine that has not started the load by then the tab is matched by an empty url and the
  saved links do not find it. A background tab of an undo-closed window needs nothing: it comes back
  discarded with its real url (§27). A url read once from a loading tab is not final (§28).
- **The url length check counts characters of the serialized url** (§20). Every url the
  add-on measures is already serialized: a tab url comes from the browser that way, and the
  address of the stub page is built with `URLSearchParams`. For such urls `url.length` is the
  exact measure, no byte counting.
- **An undo-closed tab is a new tab with an old session** (§29): it reaches `Tabs.onCreated`
  under a fresh id, but `groupId` and `subGroupId` of the closed tab are already on it, and
  discarded and hidden members of a restored window carry theirs too. The handler may decide
  from that value right away, and whatever it writes there stays: `setTabGroup` binding the tab
  to the window's group is not undone by the restore. A window without a group is the case to
  handle explicitly: nothing overwrites the old group, so it has to be read or removed, not
  assumed absent. The window's own `groupId` session value is there just as early: a cache that
  reads a window session once, at the first `Windows.load` after `windows.onCreated`, never
  reads it too soon.
- **A tab in reader mode is created by the flag, and kept by its own url** (§30, §31, §33):
  `about:reader?url=…` is refused by `tabs.create` and `tabs.update` alike, so `Tabs.create` turns
  it into `{url: <the page>, openInReaderMode: true}` — for an http(s) page only: any other url
  stays blank under the flag, so a reader url over another page goes to the stub page whole —
  and never discarded, the flag cannot be born discarded. The url the
  add-on holds for such a tab is the browser's own `about:reader?url=…`: it survives `tabs.discard`,
  an undo-close and a restart unchanged, so `isSame` matches it as it is. Neither a tab created
  with the flag, nor `tabs.toggleReaderMode`, nor the reader button pressed by the user makes a
  `main_frame` request (§30, §32, §40): `onBeforeTabRequest` sees none of them, the reader url
  is requested by `Tabs.create` and confirmed by `tabs.onUpdated`. A reload of the page on leaving the reader view, which the
  developer has seen under conditions not found yet (open question), reaches `onBeforeTabRequest`
  as an ordinary load of the page url, and needs nothing of its own. A reader tab is born loading
  (§30) and starts on `about:blank` like every created tab (§12); discarded there it reports
  `about:blank` to every read until the user activates it (§35). `Groups.hideTabs` runs right
  after `createMultiple`, so `Tabs.discard` skips an empty tab (`about:blank`, the New Tab page,
  Firefox Home) — there is nothing worth freeing in it anyway — and such a tab stays loaded until
  the next unload of its group.
- **The uuid ↔ id map rests on `hostPermissions`, so it holds enabled extensions only** (§34,
  §36): `extensions.js` maps every extension whose `hostPermissions` name its own origin, and
  `Extensions.urlToId` / `urlToUUID` turn a page url from one form into the other. The map is
  built at the first line of the module, and at a start of the browser every enabled extension
  is already in the list there, once the windows are there (§55). A
  `moz-extension://` url the browser cannot serve — an unknown uuid, an extension id in place of
  it — is accepted by `tabs.create` and opens a blank tab that never loads, so `Tabs.create`
  resolves such a url first: a page of an enabled extension by its uuid, a page of a disabled or
  missing one by the stub page. The stub page looks at the extension again when it loads and
  whenever the list of extensions changes — the management events reach a page in a tab, in a
  container and in a hidden tab too, a removal and an install included (§44, §57) — and once the extension is enabled it sends its own
  tab to the page with `tabs.update` (§39, §47): `location.replace` is denied there (§37).
  `management.getAll()` called right at `onInstalled` rejects and answers 50 ms later (§49):
  `load` in `extensions.js` waits that long after a rejection and reads the list again. A tab left
  on a page of the add-on under another uuid is sent to the page of this install the same way
  (`Tabs.restoreOldExtensionUrls`): `tabs.update` loads a discarded tab, and a hidden one stays
  hidden (§53). What the browser does with the
  tabs of an extension that goes away: the loaded tabs on a page that runs its code are closed,
  visible and hidden alike, the discarded ones stay on the same url, and nothing comes back when
  the extension returns (§48, §49). The uuid survives a disable and an enable (§48) and changes
  with a removal and an install (§49): a discarded tab left behind then names a uuid no extension
  has, and its id is known only to whoever remembered the pair while the extension was enabled.
- **`originUrl` names who asked for a load**: a blocking `onBeforeRequest` listener gets the
  origin of the add-on for a load its `tabs.create` or `tabs.update` started, the page for a
  navigation a page of the add-on makes itself, the web page for a script of a web page, and a
  redirect keeps the `originUrl` of the first request. `onBeforeTabRequest` reads it to tell its
  own loads from the loads another add-on started (`Extensions.getEnabledByUrl(originUrl)`): a
  container add-on it does not fight with. The evidence is the published add-on, which has read
  `originUrl` this way since 2019.
- **The id of a sender does not tell a page of the add-on from its content script, the url does**
  (§56): both carry the id of the add-on, a page of the add-on carries its own
  `moz-extension://` address in `url`, the content script the address of the web page it runs
  in. `isStgSender` in `background.js` trusts a sender by its `id`, the content script included:
  it sends only an `action` and a `groupId` from its own list, nothing a web page can shape.

## Open questions

- **Does the browser sometimes reload the page on leaving the reader view?** The developer has
  seen it; the conditions are not known — a large page, a cache that ran out while the page was
  read? R27.11 on Firefox 158 saw no `main_frame` request for either press (§40). Not
  reproduced yet.
- **What does a discarded tab left behind by a removed extension (§49) do when activated after the
  extension is installed again with its new uuid?** Not measured.

Add new facts and test results to the end of "Verified facts" under the next free number.
