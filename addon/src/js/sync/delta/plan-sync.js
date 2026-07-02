
/**
 * Pure sync planner for hybrid snapshot + delta sync (Phase P3a).
 *
 * Given what was pulled from the cloud (base snapshot + every device's delta log)
 * plus this device's not-yet-pushed local events and its current live state, this
 * module computes — WITHOUT touching the browser or the network — three things:
 *   1. the resolved effective state (via the pure {@link module:sync/delta/replay});
 *   2. the delta file this device should PATCH back (its own events incl. pending);
 *   3. a declarative `browserOps` diff describing how to bring the live browser into
 *      line with the resolved state.
 *
 * The transport (P3b) does the I/O around this: pull → **planSync** → execute
 * `browserOps` via STG's existing apply logic → write `deltaFileToWrite` → persist
 * `newWatermark`. Keeping the decision logic pure means the riskiest part — the
 * conflict resolution AND the live-diff — runs and is unit-tested under plain
 * `node`. See `.project/DESIGN_DELTA_SYNC.md` "Sync flow".
 *
 * ## Purity (hard requirement)
 * No `browser.*`, no network, no `constants.js` import. Only depends on the pure
 * `replay.js` and `option-keys.js`. Inputs are read, never mutated.
 *
 * ## Shapes
 *   pulledSnapshot   : { groups: [...], watermark?: { [deviceId]: seq } }
 *   pulledDeltaLogs  : [ { deviceId, events: [ {seq, ts, op, ...} ] } ]
 *   localPendingEvents : [ {seq, ts, op, ...} ]  // self events not yet pushed
 *   selfDeviceId     : string
 *   localState       : { groups: [ {id, ...props, tabs: [ {uid, ...} ]} ], pinnedTabs?: [ {uid, ...} ], options?: {key: value} }
 *   priorBaseline    : { tabUids: Set|array, groupIds: Set|array, pinnedUids: Set|array }  // gates removals
 *
 *   returns {
 *     resolvedSnapshot : { groups, pinnedTabs, options, watermark },   // == replay() result
 *     newWatermark     : { [deviceId]: seq },      // == resolved.watermark
 *     deltaFileToWrite : { deviceId, events } | null,
 *     browserOps       : { groupsToCreate, groupsToRemove, groupsToUpdate,
 *                          tabsToCreate, tabsToRemove, tabsToMove, tabsToUpdate,
 *                          pinnedToCreate, pinnedToRemove, pinnedToMove, pinnedToUpdate },
 *     optionsToApply   : { [key]: value },         // resolved options differing from local
 *   }
 *
 * @module sync/delta/plan-sync
 */

import {replay} from './replay.js';
import {isSyncedOptionKey} from './option-keys.js';

/**
 * Deep clone of a plain JSON-ish value (mirrors replay.js to stay obviously pure).
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepClone(value) {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(deepClone);
    }
    const out = {};
    for (const key of Object.keys(value)) {
        out[key] = deepClone(value[key]);
    }
    return out;
}

/**
 * Merge this device's not-yet-pushed `localPendingEvents` onto its entry in the
 * pulled delta logs, returning the FULL set of logs to replay.
 *
 * The pulled logs already contain whatever this device previously pushed; the
 * pending events are the tail it has captured locally but not yet uploaded. We
 * append only pending events with a `seq` strictly greater than the highest seq
 * already present for this device (dedup: a pending event may overlap the pulled
 * log if a prior push partially landed). The result for self is exactly what
 * `deltaFileToWrite` will carry.
 *
 * @param {Array<{deviceId: string, events: object[]}>} pulledDeltaLogs
 * @param {object[]} localPendingEvents
 * @param {string} selfDeviceId
 * @returns {{fullLogs: Array<{deviceId: string, events: object[]}>, selfEvents: object[]}}
 */
function buildFullLogs(pulledDeltaLogs, localPendingEvents, selfDeviceId) {
    const logs = deepClone(pulledDeltaLogs || []);

    let selfLog = logs.find(log => log.deviceId === selfDeviceId);
    if (!selfLog) {
        selfLog = {deviceId: selfDeviceId, events: []};
        logs.push(selfLog);
    }
    if (!Array.isArray(selfLog.events)) {
        selfLog.events = [];
    }

    const highestPulledSeq = selfLog.events.reduce((max, e) => (e.seq > max ? e.seq : max), 0);

    for (const event of localPendingEvents || []) {
        if (event.seq == null || event.seq > highestPulledSeq) {
            selfLog.events.push(deepClone(event));
        }
    }

    return {fullLogs: logs, selfEvents: selfLog.events};
}

/**
 * Index every tab by uid across a snapshot's groups.
 * @param {object} snapshot - { groups: [ {id, tabs:[{uid,...}]} ] }
 * @returns {Map<string, {groupId: *, index: number, tab: object}>}
 */
function indexTabs(snapshot) {
    const byUid = new Map();
    for (const group of snapshot.groups || []) {
        const tabs = Array.isArray(group.tabs) ? group.tabs : [];
        tabs.forEach((tab, index) => {
            if (tab.uid != null) {
                byUid.set(tab.uid, {groupId: group.id, index, tab});
            }
        });
    }
    return byUid;
}

/**
 * Shallow group props (everything except `tabs`), used for groupsToUpdate change
 * detection. Tab membership is expressed via the tab ops, never group props.
 * @param {object} group
 * @returns {object}
 */
function groupProps(group) {
    const {tabs, ...props} = group;
    void tabs;
    return props;
}

/**
 * Stable stringify of group props for equality (keys sorted so key order can't
 * cause a spurious "update").
 * @param {object} props
 * @returns {string}
 */
function stableStringify(props) {
    const keys = Object.keys(props).sort();
    return JSON.stringify(keys.map(k => [k, props[k]]));
}

/**
 * Coerce a `priorBaseline` (which may arrive as arrays — that is how it is
 * persisted in JSON — or as Sets) into a normalized `{tabUids: Set, groupIds: Set}`.
 * A missing/partial baseline degrades to empty sets (first run, or a baseline that
 * was cleared) which keeps the removal gate conservative: nothing is removed.
 *
 * @param {{tabUids?: (Set<*>|Array<*>), groupIds?: (Set<*>|Array<*>), optionKeys?: (Set<*>|Array<*>), pinnedUids?: (Set<*>|Array<*>)}} [priorBaseline]
 * @returns {{tabUids: Set<*>, groupIds: Set<*>, optionKeys: Set<*>, pinnedUids: Set<*>}}
 */
function normalizeBaseline(priorBaseline) {
    const src = priorBaseline || {};
    return {
        tabUids: new Set(src.tabUids || []),
        groupIds: new Set(src.groupIds || []),
        optionKeys: new Set(src.optionKeys || []),
        pinnedUids: new Set(src.pinnedUids || []),
    };
}

/**
 * The per-tab CONTENT attributes reconciled on a uid-matched EXISTING tab (group tabs
 * and global pinned tabs alike). Identity (`uid`), placement (`groupId`/`index`) and
 * `lastModified` are intentionally EXCLUDED: placement is reconciled via the move ops
 * and identity/lastModified are bookkeeping, not user-visible content.
 *
 * `pinned` is the group-scoped pin flag (only meaningful for group tabs). It is an additive
 * boolean that may be ABSENT on the resolved record (replay/capture only carries it when
 * relevant) — `resolveTabContentChanges` treats a genuine on⟷off transition as a change so a
 * flip propagates, but a record that simply never carried the flag does not manufacture a
 * spurious update.
 *
 * `loaded` is deliberately NOT here. It is a CREATE-TIME hint only: a tab.add record carries
 * `loaded:true` so a receiving device with `syncActivatePreviouslyActiveTabs` can create the
 * tab loaded instead of asleep. But the apply NEVER force-loads an already-existing tab (lazy
 * sleep-by-default UX — see `applyTabContentUpdate`, which intentionally ignores `loaded`). So
 * if `loaded` were diffed here it would produce a `tabsToUpdate{loaded:true}` the apply can
 * never satisfy: the source device had the tab loaded, but THIS device created it discarded,
 * so `buildLocalState` keeps omitting `loaded` and the SAME update re-emits EVERY cycle — a
 * non-converging diff (wasted work, log/op churn, part of the reported post-sync sluggishness).
 * Excluding it makes "resolved wants loaded but the tab was created asleep" a reconciled no-op,
 * restoring the core invariant that repeated syncs with no real change converge to ZERO ops.
 * `loaded` still propagates at CREATE time via the tab.add record; it just never drives an update.
 *
 * `favIconUrl` is deliberately NOT here either: favicons have no dedicated delta events, and
 * `buildLocalState` reads the LIVE favicon while the cloud snapshot holds a possibly-folded
 * value — so including it would emit a favicon-only `tabsToUpdate` EVERY sync cycle (log
 * churn / wasted work) without any user-meaningful change. The favicon STILL rides inside
 * records written for other reasons (the tab.add on create, the compaction snapshot via
 * buildTabRecord/buildLocalState), so it propagates at those points; it just never triggers
 * an update on its own.
 */
const TAB_CONTENT_FIELDS = ['url', 'title', 'cookieStoreId', 'pinned'];

/**
 * Compute the subset of {@link TAB_CONTENT_FIELDS} whose RESOLVED value differs from the
 * matched LOCAL tab — the payload of a `tabsToUpdate` / `pinnedToUpdate` entry's `target`.
 *
 * Normalizes any additive boolean field (currently `pinned`; `loaded` is also recognised
 * defensively though it is no longer a {@link TAB_CONTENT_FIELDS}) so `undefined`/`false`/
 * absent all compare equal (a tab that was never pinned and one explicitly `pinned:false`
 * are the same state) — this stops a record gaining/losing the field as mere metadata from
 * looking like a content change, while a true⟷false(/absent) transition is still detected.
 * Other fields compare with `null`/`undefined` coalesced so a value simply missing on one
 * side and empty on the other does not churn.
 *
 * @param {object} resolved - the resolved (authoritative) tab record.
 * @param {object} local - the matched live local tab record.
 * @returns {object} `{field: resolvedValue}` for each changed field (empty ⇒ no change).
 */
function resolveTabContentChanges(resolved, local) {
    const changed = {};
    for (const field of TAB_CONTENT_FIELDS) {
        if (field === 'pinned' || field === 'loaded') {
            // additive boolean: absent / false / undefined are all "off".
            if ((resolved[field] === true) !== (local[field] === true)) {
                changed[field] = resolved[field] === true;
            }
        } else if ((resolved[field] ?? null) !== (local[field] ?? null)) {
            changed[field] = deepClone(resolved[field]);
        }
    }
    return changed;
}

/**
 * Diff the resolved snapshot against the live local state into a declarative op set.
 *
 * Reconciliation is by stable identity: groups by `id`, tabs by `uid`. The ops are
 * DATA ONLY — no execution — so P3b can route them through STG's existing apply
 * logic (and through its skip machinery, so applied changes are not re-captured as
 * new deltas). Decisions:
 *  - group in resolved but not local ⇒ `groupsToCreate` (full resolved group, sans
 *    tabs — its tabs arrive via `tabsToCreate` so creation order is independent);
 *  - group in local but not resolved ⇒ `groupsToRemove` (id only);
 *  - group in both with differing props ⇒ `groupsToUpdate` (full resolved props);
 *  - tab uid in resolved but not local ⇒ `tabsToCreate` with `target {groupId, index}`;
 *  - tab uid in local but not resolved ⇒ `tabsToRemove` (uid + its local groupId);
 *  - tab uid in both but group or index differs ⇒ `tabsToMove` with
 *    `target {groupId, index}`. (A tab resurrected by replay rule 1 that is absent
 *    locally surfaces as `tabsToCreate`; if it still exists locally it surfaces as a
 *    move/no-op — either way no work is lost.)
 *  - tab uid in both with differing CONTENT (any of url/title/cookieStoreId/
 *    pinned[group-pin]; favIconUrl and loaded are excluded — see TAB_CONTENT_FIELDS) ⇒
 *    `tabsToUpdate` with `target {…changed fields…}`. This is
 *    independent of the move op — a tab can be in BOTH `tabsToMove` and `tabsToUpdate`. It
 *    is the per-tab analogue of `groupsToUpdate`; without it a content change to a tab that
 *    already exists on the peer was never reconciled.
 *
 * ## Group ORDER reconciliation
 * The resolved snapshot's `groups` ARRAY ORDER is the authoritative group order (it is
 * what STG persists + shows). When the local group order differs from the resolved
 * order — among the groups they share — we emit `groupsOrder`: the resolved group-id
 * order. The transport reorders the saved groups array to match it before `Groups.save`
 * (groups present only locally and not in the resolved order are kept, appended after
 * the ordered ones — never dropped). `groupsOrder` is null when the shared groups are
 * already in the same relative order, so an identity-only diff never triggers a reorder.
 *
 * ## Removal gate — per-device baseline (replaces the cloud-known stopgap)
 * A local group/tab is REMOVED only if it is in this device's `priorBaseline` (the
 * set of ids/uids it last reconciled as synced) AND absent from the resolved state.
 * `in baseline ⇒ was synced before ⇒ its absence now is a delete elsewhere ⇒ remove`.
 * `not in baseline ⇒ new local, never synced ⇒ keep` (it is bootstrap-uploaded, not
 * removed). Unlike the old "is it in the current cloud snapshot/deltas" gate, the
 * baseline is local + durable and survives cloud COMPACTION (which prunes the very
 * delete events that gate relied on) — so a delete still propagates to a device that
 * was offline across a compaction window. A local pending `modify` resurrects the
 * item into the resolved state (modification beats deletion), so it never reaches
 * the remove branch.
 *
 * ## Pinned tabs (global, no group)
 * Diffed in parallel as a flat list keyed by `uid` (they belong to no group; target is
 * just an `{index}` in the global pinned strip):
 *  - uid in resolved but not local ⇒ `pinnedToCreate` with `target {index}`;
 *  - uid in local but not resolved AND in `priorBaseline.pinnedUids` ⇒ `pinnedToRemove`
 *    (uid only). Same baseline gate as group tabs: a local-only pinned tab the device
 *    never reconciled as synced is KEPT (bootstrap-uploaded), never removed;
 *  - uid in both at a different index ⇒ `pinnedToMove` with `target {index}`;
 *  - uid in both with differing CONTENT ⇒ `pinnedToUpdate` with `target {…changed fields…}`
 *    (url/title/cookieStoreId; favIconUrl is excluded — see TAB_CONTENT_FIELDS; the group-pin/`loaded` flags do not apply to a
 *    global pinned tab and are filtered out). The pinned analogue of `tabsToUpdate`.
 *
 * @param {object} resolvedSnapshot - { groups: [...], pinnedTabs?: [...] }
 * @param {object} localState - { groups: [...], pinnedTabs?: [...] }
 * @param {{tabUids: Set<*>, groupIds: Set<*>, pinnedUids: Set<*>}} priorBaseline - normalized baseline.
 * @returns {{groupsToCreate: object[], groupsToRemove: object[], groupsToUpdate: object[],
 *            tabsToCreate: object[], tabsToRemove: object[], tabsToMove: object[], tabsToUpdate: object[],
 *            pinnedToCreate: object[], pinnedToRemove: object[], pinnedToMove: object[], pinnedToUpdate: object[]}}
 */
function diffToBrowserOps(resolvedSnapshot, localState, priorBaseline = {tabUids: new Set(), groupIds: new Set(), pinnedUids: new Set()}) {
    const resolvedGroups = resolvedSnapshot.groups || [];
    const localGroups = (localState && localState.groups) || [];

    const localGroupById = new Map(localGroups.map(g => [g.id, g]));
    const resolvedGroupById = new Map(resolvedGroups.map(g => [g.id, g]));

    const groupsToCreate = [];
    const groupsToRemove = [];
    const groupsToUpdate = [];

    for (const group of resolvedGroups) {
        const local = localGroupById.get(group.id);
        if (!local) {
            const {tabs, ...props} = group;
            void tabs;
            groupsToCreate.push(deepClone(props));
        } else if (stableStringify(groupProps(group)) !== stableStringify(groupProps(local))) {
            groupsToUpdate.push(deepClone(groupProps(group)));
        }
    }

    for (const group of localGroups) {
        // Only remove a local group this device previously reconciled as synced
        // (in baseline) and that the resolved state has now dropped — a delete
        // elsewhere. A group not in the baseline is new-local, never synced — keep
        // it (it is bootstrap-uploaded), never delete.
        if (!resolvedGroupById.has(group.id) && priorBaseline.groupIds.has(group.id)) {
            groupsToRemove.push({id: group.id});
        }
    }

    const resolvedTabs = indexTabs(resolvedSnapshot);
    const localTabs = indexTabs({groups: localGroups});

    const tabsToCreate = [];
    const tabsToRemove = [];
    const tabsToMove = [];
    const tabsToUpdate = [];

    for (const [uid, {groupId, index, tab}] of resolvedTabs) {
        const local = localTabs.get(uid);
        if (!local) {
            tabsToCreate.push({
                ...deepClone(tab),
                target: {groupId, index},
            });
        } else {
            // placement (group/index) reconciles via tabsToMove…
            if (local.groupId !== groupId || local.index !== index) {
                tabsToMove.push({
                    uid,
                    target: {groupId, index},
                });
            }
            // …and CONTENT (url/title/container/group-pin) via tabsToUpdate.
            // A tab can legitimately be in BOTH (it moved AND its content changed). Without
            // this branch a content change to an already-existing peer tab was never
            // reconciled (the "half-wired" sync bug).
            const changed = resolveTabContentChanges(tab, local.tab);
            if (Object.keys(changed).length) {
                tabsToUpdate.push({uid, target: changed});
            }
        }
    }

    for (const [uid, {groupId}] of localTabs) {
        // Only remove a local tab this device previously reconciled as synced (in
        // baseline) and that the resolved state has now dropped — a delete elsewhere.
        // A uid not in the baseline is new-local, never synced (e.g. a tab that
        // pre-dates delta tracking) — keep it (it is bootstrap-uploaded), never
        // delete. This was the data-loss bug.
        if (!resolvedTabs.has(uid) && priorBaseline.tabUids.has(uid)) {
            tabsToRemove.push({uid, groupId});
        }
    }

    // --- pinned tabs (flat global list, keyed by uid; target is just {index}) ---
    const indexPinned = list => {
        const byUid = new Map();
        (Array.isArray(list) ? list : []).forEach((tab, index) => {
            if (tab && tab.uid != null) {
                byUid.set(tab.uid, {index, tab});
            }
        });
        return byUid;
    };

    const resolvedPinned = indexPinned(resolvedSnapshot.pinnedTabs);
    const localPinned = indexPinned(localState && localState.pinnedTabs);

    const pinnedToCreate = [];
    const pinnedToRemove = [];
    const pinnedToMove = [];
    const pinnedToUpdate = [];

    for (const [uid, {index, tab}] of resolvedPinned) {
        const local = localPinned.get(uid);
        if (!local) {
            pinnedToCreate.push({
                ...deepClone(tab),
                target: {index},
            });
        } else {
            if (local.index !== index) {
                pinnedToMove.push({uid, target: {index}});
            }
            // CONTENT (url/title/cookieStoreId) change on an existing GLOBAL pinned tab.
            // The group-pin flag is meaningless for a global pinned tab, so it is filtered
            // out below. (`loaded` is no longer a TAB_CONTENT_FIELD — it never reaches here
            // — so it needs no explicit delete; a discarded global pinned tab is never
            // force-loaded by the apply, the reason `loaded` was excluded from the diff.)
            const changed = resolveTabContentChanges(tab, local.tab);
            delete changed.pinned;
            if (Object.keys(changed).length) {
                pinnedToUpdate.push({uid, target: changed});
            }
        }
    }

    for (const [uid] of localPinned) {
        // Same baseline gate as group tabs: only remove a local pinned tab this device
        // previously reconciled as synced and that the resolved state has now dropped.
        // A pinned uid not in the baseline is new-local, never synced — keep it (it is
        // bootstrap-uploaded), never delete.
        if (!resolvedPinned.has(uid) && priorBaseline.pinnedUids.has(uid)) {
            pinnedToRemove.push({uid});
        }
    }

    const groupsOrder = computeGroupsOrder(resolvedGroups, localGroups);

    return {
        groupsToCreate, groupsToRemove, groupsToUpdate,
        tabsToCreate, tabsToRemove, tabsToMove, tabsToUpdate, groupsOrder,
        pinnedToCreate, pinnedToRemove, pinnedToMove, pinnedToUpdate,
    };
}

/**
 * Compute the resolved group-id order to impose locally, or null if the groups the
 * resolved and local states SHARE are already in the same relative order.
 *
 * The resolved `groups` array order is authoritative. We compare the resolved order
 * restricted to ids that also exist locally against the local order restricted to ids
 * that also exist in the resolved state — i.e. only the shared groups, in each side's
 * order. If those sequences match, no reorder is needed (groups created/removed this
 * round are handled by groupsToCreate/groupsToRemove and don't by themselves count as
 * a reorder). Otherwise we return the full resolved group-id order; the transport maps
 * it onto the saved array (keeping any local-only group, appended at the end).
 *
 * @param {object[]} resolvedGroups
 * @param {object[]} localGroups
 * @returns {Array<*>|null} resolved group-id order, or null when already in order.
 */
function computeGroupsOrder(resolvedGroups, localGroups) {
    const localIds = new Set(localGroups.map(g => g.id));
    const resolvedIds = new Set(resolvedGroups.map(g => g.id));

    const resolvedShared = resolvedGroups.map(g => g.id).filter(id => localIds.has(id));
    const localShared = localGroups.map(g => g.id).filter(id => resolvedIds.has(id));

    const sameOrder = resolvedShared.length === localShared.length
        && resolvedShared.every((id, i) => id === localShared[i]);

    if (sameOrder) {
        return null;
    }

    return resolvedGroups.map(g => g.id);
}

/**
 * Diff the resolved synced options against the local option values into the subset to
 * APPLY locally — `{key: value}` for every resolved key whose value differs from the
 * local one. Equality is by stable JSON so object/array values (e.g. `defaultGroupProps`,
 * `hotkeys`) compare by content, not reference. Keys absent from `resolvedOptions` are
 * never touched (an option is only ever set, never deleted, by sync); a key whose
 * resolved value equals local is omitted (no spurious write / side-effect).
 *
 * The capture side only logs synced keys, but the pulled logs are UNTRUSTED input (a
 * tampered gist can carry `option.set` for any key), so non-synced keys — `sync*`,
 * `autoBackup*`, the explicit local-only list — are filtered out here too, never applied.
 *
 * @param {object} resolvedOptions - resolved synced settings from replay.
 * @param {object} localOptions - this device's current values for the same keys.
 * @returns {object} `{key: value}` to apply locally (empty when nothing differs).
 */
function diffOptionsToApply(resolvedOptions, localOptions) {
    const resolved = resolvedOptions || {};
    const local = localOptions || {};
    const toApply = {};

    for (const key of Object.keys(resolved)) {
        if (!isSyncedOptionKey(key)) {
            continue;
        }
        if (JSON.stringify(resolved[key]) !== JSON.stringify(local[key])) {
            toApply[key] = deepClone(resolved[key]);
        }
    }

    return toApply;
}

/**
 * Plan a sync round — PURE. See module docs for the full contract.
 *
 * @param {object} args
 * @param {object} args.pulledSnapshot - base snapshot pulled from the cloud.
 * @param {Array<{deviceId: string, events: object[]}>} args.pulledDeltaLogs
 * @param {object[]} args.localPendingEvents - self events not yet pushed.
 * @param {string} args.selfDeviceId
 * @param {object} args.localState - { groups: [...] } live browser state.
 * @param {{tabUids?: (Set<*>|Array<*>), groupIds?: (Set<*>|Array<*>), pinnedUids?: (Set<*>|Array<*>)}} [args.priorBaseline]
 *        this device's last-synced baseline (ids/uids it reconciled as synced at the
 *        end of its previous successful sync). Gates removals. Default empty.
 * @returns {{resolvedSnapshot: object, newWatermark: object, deltaFileToWrite: ?object, browserOps: object}}
 */
export function planSync({pulledSnapshot, pulledDeltaLogs, localPendingEvents, selfDeviceId, localState, priorBaseline}) {
    const {fullLogs, selfEvents} = buildFullLogs(pulledDeltaLogs, localPendingEvents, selfDeviceId);

    const {snapshot: resolvedSnapshot, watermark: newWatermark} = replay(pulledSnapshot || {groups: []}, fullLogs);

    // We "changed" the self log iff there were pending events to push. Compare
    // against what the pulled self log already held.
    const pulledSelfLog = (pulledDeltaLogs || []).find(log => log.deviceId === selfDeviceId);
    const pulledSelfCount = pulledSelfLog && Array.isArray(pulledSelfLog.events) ? pulledSelfLog.events.length : 0;

    const deltaFileToWrite = selfEvents.length > pulledSelfCount
        ? {deviceId: selfDeviceId, events: selfEvents}
        : null;

    // This device's last-synced baseline — gates removals so we never delete
    // local groups/tabs this device never reconciled as synced (new-local items),
    // while still propagating deletes for items it DID sync (survives compaction).
    const baseline = normalizeBaseline(priorBaseline);

    const browserOps = diffToBrowserOps(resolvedSnapshot, localState || {groups: []}, baseline);

    const optionsToApply = diffOptionsToApply(resolvedSnapshot.options, (localState || {}).options);

    return {
        resolvedSnapshot,
        newWatermark,
        deltaFileToWrite,
        browserOps,
        optionsToApply,
    };
}

/**
 * Compute the synthetic "bootstrap" add events this device must emit so its
 * never-synced local groups/tabs get uploaded to the cloud (instead of silently
 * lingering local-only forever). PURE — returns plain payloads; the transport
 * (`delta-sync.js`) assigns seqs by appending them to the local delta log.
 *
 * A local item needs bootstrapping iff it is BOTH:
 *   - NOT in `priorBaseline` (it was never reconciled as synced), AND
 *   - NOT already referenced by this device's local delta log (no add/event for it
 *     yet) — `knownLocalLogUids` / `knownLocalLogGroupIds`.
 * Both checks make this idempotent: re-running a sync re-derives the same set and
 * skips anything already in the baseline or already logged, so it never double-adds.
 *
 * Group adds are ordered BEFORE their tabs so a replay/apply that consumes them in
 * order always has the target group available first. Option bootstraps come last (they
 * are independent of groups/tabs).
 *
 * ## Options bootstrap
 * Each synced local option value in `localState.options` becomes an `option.set` unless
 * it is already in the baseline's `optionKeys` (reconciled as synced before) or already
 * logged (`knownLocalLogOptionKeys`). Same idempotency contract as groups/tabs. The
 * caller supplies `localState.options` already filtered to the synced subset, so this
 * never uploads a per-device key.
 *
 * ## Pinned bootstrap
 * Each local global-pinned tab in `localState.pinnedTabs` becomes a `pinned.add` unless
 * it is already in the baseline's `pinnedUids` or already logged (`knownLocalLogUids` —
 * pinned ops are keyed by tab uid, the same namespace as group tab uids). Emitted after
 * groups/tabs (they are independent of any group). Same idempotency contract.
 *
 * @param {object} localState - { groups: [{id, ...props, tabs:[{uid,...}]}], pinnedTabs?: [{uid,...}], options?: {key: value} }.
 * @param {{tabUids?: (Set<*>|Array<*>), groupIds?: (Set<*>|Array<*>), optionKeys?: (Set<*>|Array<*>), pinnedUids?: (Set<*>|Array<*>)}} [priorBaseline]
 * @param {Set<*>|Array<*>} [knownLocalLogUids] - tab uids already in this device's log (group + pinned share the uid namespace).
 * @param {Set<*>|Array<*>} [knownLocalLogGroupIds] - group ids already in this device's log.
 * @param {Set<*>|Array<*>} [knownLocalLogOptionKeys] - option keys already in this device's log.
 * @returns {Array<{op: string, group?: object, groupId?: *, tab?: object, key?: string, value?: *}>}
 */
export function computeBootstrapEvents(localState, priorBaseline, knownLocalLogUids, knownLocalLogGroupIds, knownLocalLogOptionKeys) {
    const baseline = normalizeBaseline(priorBaseline);
    const logUids = new Set(knownLocalLogUids || []);
    const logGroupIds = new Set(knownLocalLogGroupIds || []);
    const logOptionKeys = new Set(knownLocalLogOptionKeys || []);

    const events = [];
    const groups = (localState && localState.groups) || [];

    // Track every uid that belongs to a group tab in THIS bootstrap so we never also emit a
    // global `pinned.add` for the same uid (a uid is EITHER a group tab OR a global pin, never
    // both). delta-sync.getLivePinnedTabs already excludes group tabs from the global pinned
    // set, so localState.pinnedTabs should not overlap localState.groups[].tabs — this is a
    // belt-and-suspenders guard so the double-identity (group tab.add + pinned.add for one uid
    // → a DUPLICATE pinned copy on the peer) can never occur even if a leaked browser-pinned
    // group tab ever slips into pinnedTabs. See delta-sync.js getLivePinnedTabs.
    const groupTabUids = new Set();

    for (const group of groups) {
        if (group.id == null) {
            continue;
        }

        // group.add first, so its tabs always have a target on replay/apply
        if (!baseline.groupIds.has(group.id) && !logGroupIds.has(group.id)) {
            const {tabs, ...props} = group;
            void tabs;
            events.push({op: 'group.add', group: deepClone(props)});
        }

        for (const tab of Array.isArray(group.tabs) ? group.tabs : []) {
            if (tab.uid == null) {
                continue;
            }
            groupTabUids.add(tab.uid);
            if (!baseline.tabUids.has(tab.uid) && !logUids.has(tab.uid)) {
                events.push({op: 'tab.add', groupId: group.id, tab: deepClone(tab)});
            }
        }
    }

    const localOptions = (localState && localState.options) || {};
    for (const key of Object.keys(localOptions)) {
        if (!baseline.optionKeys.has(key) && !logOptionKeys.has(key)) {
            events.push({op: 'option.set', key, value: deepClone(localOptions[key])});
        }
    }

    // global pinned tabs (no group): bootstrap each never-synced one as a pinned.add.
    // Keyed by tab uid (same namespace as group tabs), gated by baseline.pinnedUids and
    // the log uids so re-runs never double-add.
    const localPinnedTabs = (localState && localState.pinnedTabs) || [];
    for (const tab of Array.isArray(localPinnedTabs) ? localPinnedTabs : []) {
        if (tab.uid == null) {
            continue;
        }
        // DOUBLE-IDENTITY GUARD: a uid that belongs to a group tab is NOT a global pin.
        // Never emit pinned.add for it, even if it leaked into pinnedTabs — that would
        // create a duplicate pinned copy of a tab that's also a group tab on the peer.
        if (groupTabUids.has(tab.uid)) {
            continue;
        }
        if (!baseline.pinnedUids.has(tab.uid) && !logUids.has(tab.uid)) {
            events.push({op: 'pinned.add', tab: deepClone(tab)});
        }
    }

    return events;
}

/**
 * Derive a fresh baseline from a resolved snapshot: every group id and every tab
 * uid present in it. PURE. The transport persists this after a SUCCESSFUL sync so
 * that the next round can tell "synced before, now gone" (remove) from "never
 * synced" (keep / bootstrap). See {@link diffToBrowserOps} removal gate.
 *
 * @param {object} snapshot - { groups: [{id, tabs:[{uid,...}]}], pinnedTabs?: [{uid,...}], options?: {key: value} }.
 * @returns {{tabUids: Array<*>, groupIds: Array<*>, optionKeys: Array<*>, pinnedUids: Array<*>}}
 */
export function baselineFromSnapshot(snapshot) {
    const tabUids = [];
    const groupIds = [];

    for (const group of (snapshot && snapshot.groups) || []) {
        if (group.id != null) {
            groupIds.push(group.id);
        }
        for (const tab of Array.isArray(group.tabs) ? group.tabs : []) {
            if (tab.uid != null) {
                tabUids.push(tab.uid);
            }
        }
    }

    const optionKeys = Object.keys((snapshot && snapshot.options) || {});

    const pinnedUids = [];
    for (const tab of Array.isArray(snapshot && snapshot.pinnedTabs) ? snapshot.pinnedTabs : []) {
        if (tab.uid != null) {
            pinnedUids.push(tab.uid);
        }
    }

    return {tabUids, groupIds, optionKeys, pinnedUids};
}
