# Uploading a group to the cloud — `uploadToCloud`

The group option "Upload to the cloud" (`group.uploadToCloud`, `true` by default). Unchecked, the
group becomes **local**: its content and settings neither go to the cloud nor come from it — on
this device and on every other one, because by `id` it is one and the same group. This document
describes how the cloud sync (`addon/src/js/sync/cloud/cloud.js`, function `syncGroupUpload`)
treats such a group.

## 1. Terms

| Term | Meaning |
| - | - |
| Full record | The group in the gist as it is: every key, the tabs, `uploadToCloud: true` |
| Stub | The group in the gist as `{id, uploadToCloud: false}` — nothing else. The group keeps its place in the `groups` array, the content is gone |
| Local copy | A group on a device with `uploadToCloud: false`. The copies of one group on different devices live independently and drift apart |
| Sync memory | After a successful sync, `storage.gist` (next to the gist id and sha) keeps three lists of ids: `uploadedGroupIds` — my groups that were uploaded; `localOnlyGroupIds` — my local copies; `stubGroupIds` — the stubs in the cloud. After a change of the gist or of the file name the memory is empty |
| NewCloudGroups mark | "The cloud has not seen this group yet" (`sync/new-cloud-groups.js`): the group is uploaded instead of being removed as "removed on another device". Set on creation, undo-remove, backup restore and when the checkbox is turned on; cleared only after the group went to the cloud as a full record |
| Trust local / trust cloud | The sync branch: the cloud has not changed since my last sync → local wins; it has → the cloud wins. A manual sync picks the branch explicitly |

## 2. The rules per group

`Copy` is the local group, `cloud` is its record in the gist, "last sync" is the sync memory.
"The regular path" is the existing sync: merging settings and tabs (trust cloud) or uploading
(trust local), creating and removing groups as for any group.

The principle: the sync tells **my** checkbox change from **another device's** by the memory
about my own groups. Last sync the group was my local copy and now the checkbox is on → I turned
it on. It was uploaded and now the checkbox is off → I turned it off. Nothing remembered (a new
gist, a group that came from a backup or an undo-remove) → the cloud wins.

### Trust cloud

| Row | Copy | Cloud | What the sync does |
| - | - | - | - |
| C1 | `uploadToCloud: true` | full | the regular merge; a copy that **was local last sync** merges by union (§3) |
| C2 | `uploadToCloud: true` | stub | last sync it **was my local copy** → I turned the upload on: the full record replaces the stub. Otherwise → another device turned it off: the copy gets `uploadToCloud: false`, its content is left alone |
| C3 | `uploadToCloud: true` | none | as before: new to the cloud (mark, first sync) → upload; otherwise remove locally — "removed on another device" |
| C4 | `uploadToCloud: false` | full | last sync it **was uploaded** → I turned the upload off: a stub replaces the record. Otherwise → another device turned it on: the regular merge, `uploadToCloud: true` comes from the cloud with the other settings, the tabs merge by union (§3) |
| C5 | `uploadToCloud: false` | stub | nothing |
| C6 | `uploadToCloud: false` | none | last sync **the stub was there** → another device removed its copy together with the stub and my copy is alive: restore the stub. Otherwise → the cloud holds no record and I never replaced it by a stub (the group is new or was removed the regular way): the copy stays local, nothing goes to the cloud |
| C7 | none | full | as before: create the group from the cloud |
| C8 | none | stub | last sync **I had** a local copy → I removed it: drop the stub. Otherwise → a stub of another device, keep it |

### Trust local

| Row | Copy | Cloud | What the sync does |
| - | - | - | - |
| L1 | `uploadToCloud: true` | any | upload the full record (as before) |
| L2 | `uploadToCloud: false` | full or stub | a stub in the cloud |
| L3 | `uploadToCloud: false` | none | last sync the stub was there → restore it; otherwise nothing |
| L4 | none | full | drop from the cloud (as before — the removal reaches the other devices) |
| L5 | none | stub | I had a local copy → drop it; otherwise keep it in its place |

Stubs bypass the merge of tabs, settings and native sub-groups; a stub never enters the local
list of groups. When the gist does not exist yet, the cloud is built from the local data without
the local copies — for them the cloud is "none".

## 3. Merging a copy that returns to the cloud

While a copy is local, its tabs never reach the cloud. So when it returns (C1 with a copy that
was local last sync, C4 when another device turned the upload on), the absence of a tab in the
cloud does not mean "removed on another device", and the usual lastAccessed cutoff does not
apply. The copy and the cloud record merge by union: a tab present on both sides (by URL and
container) is taken once, a tab present on one side only is kept — the cloud tabs are created
locally, the local tabs go to the cloud. The group settings come from the cloud as in any merge.
From the next sync on the group is a regular one.

## 4. What the user sees

Computer A and laptop B, the group G is synced.

**The upload is turned off on A.** Sync A: last sync G was uploaded → a stub replaces it in the
cloud, the content disappears from the new gist revisions. Sync B: a stub, and G was uploaded →
the checkbox of the copy on B goes off, the tabs and settings of B are left alone. From now on G
on A and G on B live their own lives, the stub stays in the cloud.

**The upload is turned on on A.** Sync A: G was my local copy → the full record goes up. Sync B:
the copy on B has the checkbox off, the cloud holds a full record, and B did not turn anything
on → another device brought the group back: the settings come from the cloud, the checkbox goes
on, the tabs merge by union. The group is regular again.

**The local G is removed on A.** Sync A: no copy, a stub in the cloud, and last sync the copy was
there → the stub is dropped. Sync B: the copy on B is alive, last sync the stub was there and
now it is gone → B restores the stub. The user sees that G is still on B: it is local, a removal
on A does not touch it. Removed on B → sync B drops the stub. The last holder drops it for good;
the gist collects no garbage.

**A new group is created with the checkbox off.** There was no stub in the cloud — no stub is
created. Checkbox on → the group is uploaded as a new one.

One sync is enough: the checkbox reaches the cloud whether or not another device changed the
cloud meanwhile — the sync memory tells "I switched it" from "another device switched it".

## 5. Limits

- **Gist history.** GitHub keeps the revisions: content that has been in the cloud stays in the
  old revisions. The sync only stops putting it into the new ones.
- **A copy becomes local only by a sync.** Until B has synced after the switch-off on A, the copy
  on B is a regular group: if A removed its local copy and synced meanwhile, the stub is gone and
  B removes G on its next sync as "removed on another device". One rule: sync first, then
  change, then sync.
- **A change of the gist or of the file name** empties the sync memory: on the first sync with
  the new gist the cloud wins — an unchecked copy is raised from the full record, a checked one
  goes off because of a stub. Switch the checkboxes after the first sync.
- **A manual trust local** behaves as for any group: a local copy with the checkbox on replaces
  the cloud record as a whole, without a merge.
- **A failed upload.** The memory is updated only after a successful sync. When the sync itself
  switched the checkbox of a copy (adopted a foreign stub or a foreign full record) and the upload
  failed, the memory lags behind the copy until the first successful sync: a checkbox switched on
  another device in that window is attributed to this device, and a copy that returned by union
  keeps merging by union (a tab removed on another device in that window comes back). The sync
  shows an error meanwhile — fix the sync first, change things after.
- **A holder restores the stub by its memory, not by the reason the stub vanished.** If B saw the
  stub last sync and then, while B stayed unsynced, the group was brought back to the cloud on A
  and removed the regular way, B still restores the stub, and a third device C adopts G as local
  instead of removing it. Without extra state "a holder dropped the stub" and "the record was
  removed the regular way" cannot be told apart; the copy on B is the user's will too.
- **A backup restore and an undo-remove** set the NewCloudGroups mark: a restored regular group is
  uploaded, not removed. The memory about a group lives until the next successful sync: a group
  removed and restored with no sync in between is still "mine" for the memory, its checkbox
  counts as my switch; a group the memory does not know (a sync happened between the removal and
  the restore, or the gist changed) is foreign — the cloud wins.

## 6. Data format

- Every group carries the key `uploadToCloud` (`true`/`false`); the default group settings
  (`defaultGroupProps`) carry it only when the user changed the default. Migration entry "6"
  fills the groups with `true` - the cloud appeared in 6, the pre-6 data has nothing to carry
  over.
- In the gist: a full record or a stub `{id, uploadToCloud: false}`. A migration of the gist
  data must skip the stubs — they have no `tabs`. The sync memory —
  `storage.gist.uploadedGroupIds`, `localOnlyGroupIds`, `stubGroupIds`.
