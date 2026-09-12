# Reference: `browser.storage` events (`storage.onChanged`)

Verified live on Firefox 156 (September 2026) with the throwaway test add-on (`test-addon/`), in a
clean profile with no other add-ons. Every fact here is one browser build on one machine; a claim
is as strong as the runs cited next to it, and no stronger.

Only facts confirmed by an actual test run belong in "Verified facts" — never assumptions about how
the browser "probably" works. State tables, markers, confirmation rules and how the tests are
written — BEHAVIOR-NOTATION.md. There is no state table for storage: the event log carries every
action as its own line, and the lines under it are the events that action caused; nothing under
an action means no event.

**A new fact is appended as the next number at the end of "Verified facts". Numbers are never
renumbered or reused** — code comments reference them by number (`docs/STORAGE-BEHAVIOR.md §1`).

---

## Verified facts

### 1. The first write of a key delivers `oldValue` PRESENT with the value `undefined`, a removal delivers no `newValue` at all, and a removal of an absent key delivers nothing (R25.01–R25.05)

The change object of `storage.local.set` on a key that had no value has both properties
(`keys:[oldValue, newValue]`), and `oldValue` is `undefined` — present, not absent. The change
object of `storage.local.remove` has only `oldValue` (`keys:[oldValue]`); `newValue` is not on the
object. `storage.local.remove` of a key that is not there fires no event. The same for every value
type tried: boolean, string, number, array, object.

### 2. Writing the same value again fires the event, with equal `oldValue` and `newValue` — arrays and objects included (R25.01–R25.05)

The browser does not compare: a `set` with the value the key already holds delivers a change with
`oldValue` equal to `newValue`. For an array and an object the second write was a fresh copy with
the same content, and the event came just the same. A listener that wants "changed" has to
compare the two itself.

### 3. `storage.onChanged` and `storage.local.onChanged` report the same change objects (R25.01–R25.05)

Every action delivered one event to each listener with identical `keys`, `oldValue` and
`newValue`; the global one adds `areaName: "local"`.

R25.01, a boolean key:

```text
    0ms  action                   storage.local.remove(testKey) while the key is absent
    0ms  action                   storage.local.set({testKey: true}) - the first write
   14ms  storage.onChanged        testKey  areaName:local  keys:[oldValue, newValue]  oldValue: undefined undefined  newValue: boolean true
   14ms  storage.local.onChanged  testKey  keys:[oldValue, newValue]  oldValue: undefined undefined  newValue: boolean true
    0ms  action                   storage.local.set({testKey: true}) - the same value again, a fresh copy
    1ms  storage.onChanged        testKey  areaName:local  keys:[oldValue, newValue]  oldValue: boolean true  newValue: boolean true
    1ms  storage.local.onChanged  testKey  keys:[oldValue, newValue]  oldValue: boolean true  newValue: boolean true
    0ms  action                   storage.local.set({testKey: false}) - a changed value
    3ms  storage.onChanged        testKey  areaName:local  keys:[oldValue, newValue]  oldValue: boolean true  newValue: boolean false
    4ms  storage.local.onChanged  testKey  keys:[oldValue, newValue]  oldValue: boolean true  newValue: boolean false
    0ms  action                   storage.local.remove(testKey)
    1ms  storage.onChanged        testKey  areaName:local  keys:[oldValue]  oldValue: boolean false  newValue: absent
    1ms  storage.local.onChanged  testKey  keys:[oldValue]  oldValue: boolean false  newValue: absent
```

R25.05, an object key (R25.02 string, R25.03 number and R25.04 array differ only in the values):

```text
    0ms  action                   storage.local.remove(testKey) while the key is absent
    0ms  action                   storage.local.set({testKey: {"a":1}}) - the first write
    3ms  storage.onChanged        testKey  areaName:local  keys:[oldValue, newValue]  oldValue: undefined undefined  newValue: object {"a":1}
    3ms  storage.local.onChanged  testKey  keys:[oldValue, newValue]  oldValue: undefined undefined  newValue: object {"a":1}
    0ms  action                   storage.local.set({testKey: {"a":1}}) - the same value again, a fresh copy
    1ms  storage.onChanged        testKey  areaName:local  keys:[oldValue, newValue]  oldValue: object {"a":1}  newValue: object {"a":1}
    1ms  storage.local.onChanged  testKey  keys:[oldValue, newValue]  oldValue: object {"a":1}  newValue: object {"a":1}
    0ms  action                   storage.local.set({testKey: {"a":2}}) - a changed value
    3ms  storage.onChanged        testKey  areaName:local  keys:[oldValue, newValue]  oldValue: object {"a":1}  newValue: object {"a":2}
    4ms  storage.local.onChanged  testKey  keys:[oldValue, newValue]  oldValue: object {"a":1}  newValue: object {"a":2}
    0ms  action                   storage.local.remove(testKey)
    5ms  storage.onChanged        testKey  areaName:local  keys:[oldValue]  oldValue: object {"a":2}  newValue: absent
    5ms  storage.local.onChanged  testKey  keys:[oldValue]  oldValue: object {"a":2}  newValue: absent
```

---

## Conclusions for the add-on

- **The first write of an option is a change with `oldValue: undefined`** (§1). On a fresh
  install the storage holds only `version` until the user saves something, so the first switch-on
  of a subscribed option (thumbnails, `cloneSubGroupsWhenMovingTabs`, `showContextMenuOnLinks`, …)
  arrives exactly like that. `Storage.isChangedKey` (`storage-utils.js`) counts an absent old
  value as a change; a demand for the old value to be of the key's type would drop the first
  switch-on until an add-on restart.
- **An unchanged write still fires** (§2): the comparison in `isChangedKey` is what filters it,
  and for arrays and objects it compares by content, not by reference.
- **A removal has no `newValue`** (§1): `isChangedKey` reports no change for it, the module
  keeps its value. The add-on removes only the legacy keys of a migration, which nobody
  subscribes to.
- **The first write reaches every subscriber at once**: a cloud sync saves all option keys
  through `saveOptions`, so on a fresh profile every subscriber sees its key's first write in
  one event. A handler must act on the real state (is the menu there), not on the delta, or it
  re-creates what the defaults already created.

## Open questions

None. Add new facts and test results to the end of "Verified facts" under the next free number.
