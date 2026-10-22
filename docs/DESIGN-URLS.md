# Extension page addresses — the browser's form and the add-on's form

How the add-on names a page of an extension, its own pages included, and how a tab gets from the
browser's form to the add-on's and back. The code is `addon/src/js/extensions.js` (the uuid ↔ id
map, the model is in its header), `tabs.js` and `constants.js`; the browser facts and the
conclusions drawn from them are in `BEHAVIOR-CREATE-TABS.md`. The cache's part — the requested
url of a tab — is in `DESIGN-CACHE.md`.

## 1. Two forms of one address

In the browser a page of an extension lives at `moz-extension://<uuid>/…`, and the uuid differs
per profile. Inside the add-on — in the tabs it reads, in the mirror of the cache, in the
storage, in backups, in the cloud, in the popup — the page is named by the id of the extension,
`moz-extension://<extension id>/…`, the add-on's own pages too. A wrapper page (`isWrapper` in
`PAGES_CONFIG`: the stub page `help/stg-unsupported-url.html?url=X` and the container question
`help/open-in-container.html?url=X`) is read as `X`.

A browser tab is brought to this form by the single entry of `tabs.js`, `browserTabToAddon`. It
also puts the real url into the non-enumerable `tab.browserUrl`: the field stays out of
messages to the pages, out of the logs and out of saved data, and a copy made with `{...tab}`
does not have it.

The map uuid ↔ id and the translation in both directions are `extensions.js`. The map does not
remember the pairs of disabled extensions; a discarded tab with the dead uuid of a removed
extension is not repaired, the user closes it. A link or a bookmark to any
`moz-extension://…` page is opened as it is, with no check: a site cannot open a page of the
add-on (the manifest lists no `web_accessible_resources`), and what the user opened is the user's
business.

## 2. Creating a tab

`Tabs.create` (`prepareUrlForCreate`): a page of an extension with a known uuid
(`Extensions.urlToBrowserOrNull`, the add-on's own pages always) opens by its uuid; a page of a
disabled or absent extension opens as the stub page with the whole address. Reader mode is the
`openInReaderMode` flag, and only when the page under the `about:reader?url=…` wrapper is
http(s) (§30); a reader url over any other page goes to the stub page whole and is read back the
same way, so the wrapper layer survives the round trip "created → read". The tab `create`
returns carries the requested url in the add-on's form, not `about:blank` (§12): how the cache
keeps it is in `DESIGN-CACHE.md`.

## 3. The stub page

The stub page shows the address. When the address is a page of an extension, the page checks it
on load and on every change of the list of extensions (`Extensions.onChanged`; the `management`
events reach a page in a tab, §44): once the uuid is known the page sends its own tab to the
address through `tabs.update` (§39, §47), since `location.replace` to a page of another extension
is denied by the browser (§37). The button "open the nested address" is shown when the address
holds a key from `Constants.NESTED_URL_KEYS` (`url`, `u`, `go`) with an address the browser will
open: http(s) or a page of an extension with a known uuid. When reading a tab, the add-on does
not unwrap the keys of pages of other extensions: their page is its own address. The page has no
fallback for an old address format: the old is cured by the migration only.

An address the key cannot carry — the whole stub address would be over the url limit
(`BEHAVIOR-CREATE-TABS.md` §20, §54), a `data:` page of a megabyte or more — reaches the page by a
message (`real-url`, `pendingRealUrls` in `tabs.js`) once the page has loaded, and the page is its
only holder. The add-on keeps it neither in the tab session nor in its storage, on purpose: such an
address can weigh hundreds of megabytes (a scanned PDF as `data:`), which would bloat the session
store and the backups past use and add one more session read per tab to every load. So the tab
reads as the bare stub page everywhere: in the cache, in the archive, in the backup, in the cloud
and in `tabsToRestore`. A reload of the page — a discard, a browser restart, a restore from any
of those — shows the stub without the address, and the page closes itself after 30 seconds. The
add-on cannot open such an address itself; the page shows it once, the user copies it, and there
the duty of the add-on ends. This is a decision, not a defect. The `dummy` page (`data:` images,
PDF and JSON, §18) gets its address the same way and navigates to it at once; only the moments
before that read as the dummy page.

## 4. All html pages in one place

Every html page of the add-on is described in `PAGES_CONFIG` in `constants.js`: the path of the
page, its key in `Constants.PAGES`, whether it is a help page (`isHelp` → `PAGES.HELP_PATHS`: in
the browser the add-on's own page lives at its uuid, and after a reinstall of the add-on
`restoreOldExtensionUrls` moves the live help pages to the new uuid), whether it wraps an
address in its `url` key (`isWrapper` → `PAGES.WRAPPER_PATHS`, `Extensions.isWrapperUrl`). A new
page is added there and nowhere else.

## 5. Messages to the content script of a tab

Whether a message can be sent to the content script of a tab — `Tabs.isCanSendMessage(tab)`, by
the real url (`tab.browserUrl`): the stub page and the other own pages attach the content script
themselves, so they get the message; a page of another extension and `about:` pages do not.

## 6. Backups and migration

`restoreBackup` and the migration bring everything that comes in to the add-on's form
(`Tabs.tabUrlToAddon`): an imported foreign backup names the pages the browser's way, and the
data of 5.3.2 keeps the stub page as `…#X` and the own pages by uuid. The migration recognises
the `…#X` stub by its path under any uuid and takes the address after `#`. The add-on's own page
under the uuid of another profile or of a previous install is left alone: a path like
`options/options.html` exists in many extensions, and `Tabs.create` opens it as the stub page.
The old form of an address is not supported after the migration: the migration translates the
live tabs, the rest does not matter.

## 7. Bookmarks, comparisons, the shown url

- **Bookmarks** — a page of an extension is bookmarked by its uuid (`Extensions.urlToUUIDOrNull`):
  the one the map knows for an enabled extension, the add-on's own page too, or the one the
  address of the tab itself carries — a disable keeps the uuid (`BEHAVIOR-CREATE-TABS.md` §48), a
  removal leaves the old one on a discarded tab (§49); without a known uuid there is no bookmark
  and `exportGroup` skips the tab; any other address is bookmarked as it is kept. The folder of a
  group mirrors the tabs bookmarked in the pass: every other bookmark in it is removed.
- **Comparing with an own page** — `Extensions.isOwnUrl` or
  `Extensions.urlToId(Constants.PAGES.…)`.
- **The url of a tab for display and search** — `Tabs.getPageUrl`: the reader-mode wrapper is
  taken off.
