/*
Ids of groups the cloud has not seen yet. The cloud sync keeps and uploads a marked
local group that is absent in the cloud instead of deleting it as "removed on another
device". A group is marked on every path where it appears locally: creation,
undo-remove, backup restore, turning uploadToCloud on. The mark is written before the
group is saved, so a sync can never see the group without its mark. The sync snapshots
the ids after taking its groups snapshot and, after a successful run, removes those of
them whose group went to the cloud as a full record - a mark set mid-sync survives until
the next sync, a group kept local by uploadToCloud off stays marked until it is uploaded.
Removing a group drops its mark; undo-remove re-adds it. A mark whose group never got
saved (orphan) is swept by keepOnly on addon start.
*/

import '/js/prefixed-storage.js';
import * as Utils from '/js/utils.js';

const storage = localStorage.create('NewCloudGroups');

export function add(...groupIds) {
    for (const groupId of Utils.toSet(groupIds)) {
        storage[groupId] = true;
    }
}

export function getIds() {
    return new Set(Object.keys(storage));
}

export function remove(...groupIds) {
    for (const groupId of Utils.toSet(groupIds)) {
        delete storage[groupId];
    }
}

export function keepOnly(...groupIds) {
    const alive = Utils.toSet(groupIds);

    for (const groupId of Object.keys(storage)) {
        if (!alive.has(groupId)) {
            delete storage[groupId];
        }
    }
}
