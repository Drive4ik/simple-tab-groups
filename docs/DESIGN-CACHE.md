# The cache — the mirror of the tabs and the requested url

What `addon/src/js/cache.js` knows about every tab and window, who feeds it and who may write
into it. The browser facts are in `BEHAVIOR-CREATE-TABS.md` (§12, §23, §26–§28, §35, §46).

## 1. Three things the cache keeps per tab

```txt
the mirror (record.url, title, favIconUrl, cookieStoreId, openerTabId, session values)
    = the last state the browser reported: by events (Cache.setTab) and by reads (loadTabSession, setOpeners) alike, with no condition
record.requestedUrl
    = the address the tab was asked to load, until the load has an outcome; set by Tabs.create and onBeforeTabRequest, an empty address is never requested
lastTabsState (the diff base of tabs.onUpdated)
    = the state the last processed event left; a read seeds it only for a tab it does not know yet
```

The group lists leave the pinned tabs out, the mirror does not: `Tabs.clearPinnedSessions` reads
them with the session at the start of the add-on and at every window the browser opens, where the
tabs appear without events the add-on processes (`DESIGN-GROUPS.md` §1, §5). So a pinned tab the
add-on has never touched is known before its first event: the diff base is there when the tab is
unpinned, and the unpin binds it to the group of its window (`tabs.js onUpdated`), and the mirror
holds its opener for a recreate (`getTabChildren`).

The mirror and the base hold only what the browser said. The requested url holds what the add-on
knows ahead of the browser: a created tab is born on `about:blank` (§12), a tab that starts a
load reports `about:blank` until the url commits, and the browser gives no honest "in transit"
sign — a newborn is `complete` + `about:blank` for its first 9–10 ms (§23), the active tab of a
new window for 50–65 ms (§26), and the url of a restored window's active tab dips back to
`about:blank` while loading (§28).

## 2. The outcome of a load

`removeTabRequestedUrl` takes the requested url off when:

1. the tab settled on a non-empty url — status `complete`, by an event or by a read (a url read
   from a loading tab is not final, §28);
2. the event announced `status: complete` and the tab, as read now, is still `complete` and
   empty — the load ended on nothing (`Cache.setTab(tab, changeInfo)`, `changeInfo` is what the
   event announced; `tabs.js onUpdated` passes it in both of its paths; a snapshot without an
   event, `processCreated` and `setTabSession`, passes none: the `tabs.onCreated` snapshot is
   always `complete` + `about:blank`);
3. the tab is removed (`removeTab`).

## 3. The browser's url is `tab.browserUrl`

`Tabs.fillEmptyUrl` replaces an empty url in a snapshot by what the cache knows,
`Cache.getTabUrl(id)`: the requested url, else the last reported one (for a snapshot older than
the mirror, the group lists `runGrandRestoreNow` keeps from its first read). Such filled objects
come back into the cache: `Groups.load(…, true)` → `SubGroups.apply` → `Cache.loadTabSession`,
`settleTabs`, `reconcile` → `Cache.setTabSession`. So the cache judges emptiness by
`tab.browserUrl`, the non-enumerable field `browserTabToAddon` sets and `fillEmptyUrl` never
touches, and stores `tab.url` only when `browserUrl` is not empty (`reportedUrl`). Every object
that reaches the cache has passed `browserTabToAddon`; an object without `browserUrl` (the
`stg-debug.js` page feeds its own instance of the module with raw tabs) is taken as it is.

## 4. Who writes the session values

The session values the cache knows — `Cache.KEYS` of a tab (`groupId`, `subGroupId`,
`favIconUrl`, `thumbnail`) and `groupId` of a window — are written by `cache.js` only. The cache
remembers the absence of a value too, so a write past it makes the cache a liar; the migrations
go through `Cache` as well. Operations on one id and one key run one after another (the `Cache`
queue, `DESIGN-QUEUES.md`), different keys in parallel. `getTabsSessionAndRemove` hands the
record of a closing window's tab to `tabsToRestore`: the url is the requested one when there is
one, and then without a title — a tab still waiting for its page shows the title of no page.
