# Reference: `browser.downloads` as the add-on uses it for a backup

Verified live on Firefox 158 (October 2026), Windows, with the throwaway test add-on
(`test-addon/`), in a clean profile with no other add-ons. Every fact here is one browser build on
one machine; a claim is as strong as the runs cited next to it, and no stronger. The file-name
rules of §3 are the rules of the file system the run was made on.

Only facts confirmed by an actual test run belong in "Verified facts" — never assumptions about how
the browser "probably" works. State tables, markers, confirmation rules and how the tests are
written — BEHAVIOR-NOTATION.md. There is no state table for downloads: the event log carries every
action as its own line, and the lines under it are the events and the `downloads.search` samples
that action caused.

**A new fact is appended as the next number at the end of "Verified facts". Numbers are never
renumbered or reused** — code comments reference them by number (`docs/BEHAVIOR-DOWNLOADS.md §1`).

---

## Verified facts

### 1. `downloads.download` resolves a few ms after the call; `downloads.onCreated` comes before the resolve and `downloads.search({id})` right at the resolve finds the item; the end is announced by `downloads.onChanged {state: complete, exists: true}` after the resolve (R33.01–R33.03)

The call: `downloads.download({url: <object url of a Blob>, filename: '<folder>/<name>', saveAs:
false, conflictAction: 'overwrite'})`.

- A 1 KB json file: `onCreated` at 4 ms, the resolve at 5 ms, `downloads.search({id})` right at
  the resolve finds the item and reports `state in_progress, bytes 0/-1, exists false`; the next
  sample already `bytes 1035/1035` and still `in_progress`; `onChanged {state: complete, exists:
  true}` at 23 ms; `search` reports `complete` from then on (R33.01).
- A 64 MiB file: the resolve at 2 ms, `onChanged {state: complete}` at 322 ms (R33.02).
- Two started at once, the small and the large: two ids, the resolves at 2 and 4 ms, each one
  completes on its own — the small at 21 ms, the large at 161 ms — and every event names its own id
  (R33.03).

```text
    0ms  action                 downloads.download({filename: stg-behavior-tests/"small.json", saveAs: false, conflictAction: overwrite})  // small
    4ms  downloads.onCreated    small  state in_progress, error none, bytes 0/-1, exists false, file stg-behavior-tests/small.json
    5ms  download() resolved    small
   10ms  search at the resolve  small: state in_progress, error none, bytes 0/-1, exists false, file stg-behavior-tests/small.json
   11ms  search                 small: state in_progress, error none, bytes 1035/1035, exists false, file stg-behavior-tests/small.json
   23ms  downloads.onChanged    small  state: "complete", exists: true
   37ms  search                 small: state complete, error none, bytes 1035/1035, exists true, file stg-behavior-tests/small.json
```

### 2. `bytesReceived` of a completed large download can stay below `totalBytes` (R33.02, R33.03)

The 64 MiB file ends with `state complete, exists true, bytes 3932160/67108864`; in the parallel
run `bytes 1310720/67108864` — in both runs the number of the last sample before the end, not the
size of the file. The state and `exists`, not the byte count, tell that a download is done.

```text
    0ms  action                 downloads.download({filename: stg-behavior-tests/"large.bin", saveAs: false, conflictAction: overwrite})  // large
    2ms  downloads.onCreated    large  state in_progress, error none, bytes 0/-1, exists false, file stg-behavior-tests/large.bin
    2ms  download() resolved    large
    5ms  search at the resolve  large: state in_progress, error none, bytes 0/-1, exists false, file stg-behavior-tests/large.bin
    9ms  search                 large: state in_progress, error none, bytes 3932160/67108864, exists false, file stg-behavior-tests/large.bin
  322ms  downloads.onChanged    large  state: "complete", exists: true
  334ms  search                 large: state complete, error none, bytes 3932160/67108864, exists true, file stg-behavior-tests/large.bin
```

### 3. The file names `downloads.download` refuses — the refusal is the rejection of the call itself, 1–3 ms, no item is created and no event comes (R33.04, Windows)

Rejected with `filename must not contain illegal characters`:

- a narrow no-break space, U+202F, inside the name (`STG-backup 10-31 AM.json` with U+202F
  before `AM`)
- a trailing dot (`STG-backup 11.`)
- a colon (`STG 10:31.json`)
- a question mark (`STG?.json`)
- a pipe and an asterisk (`STG|*.json`)
- a sub-folder name with a trailing space (`sub /STG-backup.json`)

Rejected with `filename must not contain back-references (..)`: a parent reference
(`../STG-backup.json`).

Accepted, and the download completes: Cyrillic letters (`STG-бэкап 11.10.2026.json`), a space
before the extension (`STG-backup .json`), a sub-folder (`sub/STG-backup.json`, the browser creates
the folder).

### 4. `downloads.cancel` ends a download with two `onChanged` deltas: `{state: interrupted}` first, `{error: USER_CANCELED}` in a delta of its own 1–3 ms after it; both come before the resolve of `cancel()`; a `search` issued at the `state` delta still reads `error none`, the one after the `error` delta reads `USER_CANCELED` (R33.05, two runs)

The 64 MiB file, canceled 1–2 ms after the resolve of `download()`, while `search` still said
`in_progress, bytes 0/-1`. The interruption is announced after the resolve, the way the completion
is (§1). The reason is not readable at the `state` delta: the `search` issued right there answered
`state interrupted, error none`, 1 ms before the `error` delta; the reason is in that second delta
and in every `search` after it.

```text
    0ms  action                   downloads.download({filename: stg-behavior-tests/"large.bin", saveAs: false, conflictAction: overwrite})  // large
    3ms  downloads.onCreated      large  state in_progress, error none, bytes 0/-1, exists false, file stg-behavior-tests/large.bin
    4ms  download() resolved      large
    5ms  search at the resolve    large: state in_progress, error none, bytes 0/-1, exists false, file stg-behavior-tests/large.bin
    5ms  cancel()                 large  // right after the search at the resolve
   11ms  downloads.onChanged      large  state: "interrupted"
   12ms  search at the end event  large: state interrupted, error none, bytes 0/-1, exists false, file stg-behavior-tests/large.bin
   12ms  downloads.onChanged      large  error: "USER_CANCELED"
   12ms  cancel() resolved        large
   13ms  search                   large: state interrupted, error USER_CANCELED, bytes 0/-1, exists false, file stg-behavior-tests/large.bin
```

### 5. `URL.revokeObjectURL` of the object url right after the resolve, the download in progress, does not touch the download: it completes, `exists true` (R33.06)

The 64 MiB file, the url revoked 2 ms after the resolve of `download()`, `search` right before it
saying `in_progress, bytes 0/-1`; the next sample already `bytes 4521984/67108864`, complete at
255 ms. The shape `File.save` had from 2018 to 2020 — the url revoked once a 5 s wait ran out — did
not kill a started download; the failures of issue #374 came from elsewhere.

```text
    0ms  action                 downloads.download({filename: stg-behavior-tests/"large.bin", saveAs: false, conflictAction: overwrite})  // large
    3ms  downloads.onCreated    large  state in_progress, error none, bytes 0/-1, exists false, file stg-behavior-tests/large.bin
    3ms  download() resolved    large
    5ms  search at the resolve  large: state in_progress, error none, bytes 0/-1, exists false, file stg-behavior-tests/large.bin
    5ms  URL.revokeObjectURL()  large  // right after the search at the resolve, the download in progress
    9ms  search                 large: state in_progress, error none, bytes 4521984/67108864, exists false, file stg-behavior-tests/large.bin
  255ms  downloads.onChanged    large  state: "complete", exists: true
  268ms  search                 large: state complete, error none, bytes 4521984/67108864, exists true, file stg-behavior-tests/large.bin
```

### 6. `saveAs: true`: the dialog answered with Cancel rejects `download()` with `Download canceled by the user`, no item is created and no event comes; answered with Save, `onCreated` and the resolve come after the dialog closes and the download ends the usual way (R33.07, 👁️)

The 1 KB json file. Cancel: the rejection at 2352 ms, the moment the user pressed the button,
nothing else in the log. Save: `onCreated` at 3790 ms and the resolve at 3791 ms — the time the
dialog stayed open — then `search` right at the resolve `in_progress, bytes 0/-1`, `onChanged
{state: complete, exists: true}` 16 ms later. The suggested name and folder were kept: the file
landed in `stg-behavior-tests/`.

```text
    0ms  action                downloads.download({filename: stg-behavior-tests/"saveas.json", saveAs: true, conflictAction: overwrite})  // canceled
 2352ms  download() rejected   canceled: Download canceled by the user
    0ms  action                 downloads.download({filename: stg-behavior-tests/"saveas.json", saveAs: true, conflictAction: overwrite})  // saved
 3790ms  downloads.onCreated    saved  state in_progress, error none, bytes 0/-1, exists false, file stg-behavior-tests/saveas.json
 3791ms  download() resolved    saved
 3793ms  search at the resolve  saved: state in_progress, error none, bytes 0/-1, exists false, file stg-behavior-tests/saveas.json
 3796ms  search                 saved: state in_progress, error none, bytes 1035/1035, exists false, file stg-behavior-tests/saveas.json
 3807ms  downloads.onChanged    saved  state: "complete", exists: true
 3940ms  search                 saved: state complete, error none, bytes 1035/1035, exists true, file stg-behavior-tests/saveas.json
```

### 7. A download that fails on its own — an https host no server answers for — resolves `download()` like any other, and its failure is one `onChanged` delta with `state: interrupted` and `error: NETWORK_FAILED` together; a `search` issued at that delta already reads the reason (R33.08)

The item is created and found at the resolve the usual way (§1); the failure comes 76 ms later, and
unlike the user's cancel (§4) the state and the reason arrive in one delta.

```text
    0ms  action                   downloads.download({url: https://unreachable.invalid/unreachable.bin, filename: stg-behavior-tests/"unreachable.bin", saveAs: false, conflictAction: overwrite})  // unreachable
    9ms  downloads.onCreated      unreachable  state in_progress, error none, bytes 0/-1, exists false, file stg-behavior-tests/unreachable.bin
   11ms  download() resolved      unreachable
   19ms  search at the resolve    unreachable: state in_progress, error none, bytes 0/-1, exists false, file stg-behavior-tests/unreachable.bin
   87ms  downloads.onChanged      unreachable  state: "interrupted", error: "NETWORK_FAILED"
   88ms  search at the end event  unreachable: state interrupted, error NETWORK_FAILED, bytes 0/-1, exists false, file stg-behavior-tests/unreachable.bin
   99ms  search                   unreachable: state interrupted, error NETWORK_FAILED, bytes 0/-1, exists false, file stg-behavior-tests/unreachable.bin
```

## Conclusions for the add-on

1. **`File.waitDownload` can wait on `downloads.onChanged` instead of polling `downloads.search`
   every 200 ms** (§1): the end is announced by the event with the `state`, it names the id the
   resolve gave, and in every measured case it came after the resolve — 23 ms for a small file,
   322 ms for 64 MiB. The id is known only at the resolve, so the listener goes right after it,
   with nothing awaited in between. The end of a download is its `state`, never its byte count
   (§2). An interrupted end is announced the same way, by the `state` delta; the reason comes with
   it in the same delta when the download fails on its own (§7), and in a delta of its own after it
   when the user cancels — then a `search` issued at the `state` delta does not have it yet (§4).
   So an interrupted download is done once both the state and the reason have come through the
   deltas, and a `search` after that reads the full item.
2. **The date variables of the backup path carry whatever `toLocaleString` puts there**, and
   `download()` refuses the whole path for one U+202F, a trailing dot or any of `? | *` (§3) — a
   refused path is a rejected `download()`, and the backup is not saved. The user cannot change a
   date, so `Utils.getFilePathVariables` makes every variable safe silently: the characters of §3
   become `-`, every Unicode space a plain space, a dot or a space at the end is cut. The typed
   part of the path is the user's own; the options page checks it with a test save and rolls a
   refused value back.
3. **The object url may be revoked only after the end — but an early revoke is not what failed
   the backups of issue #374** (§5): a started download survives it. The cause of those failures
   is still unknown, so the retry `File.save` has had since 2020 rests on no measured fact either
   way.
4. **The user's Cancel in the Save As dialog is a rejected `download()` with the text
   `Download canceled by the user`, nothing is created** (§6) — the check of that text in
   `File.save` is the right branch for it, and there is no item to erase.
