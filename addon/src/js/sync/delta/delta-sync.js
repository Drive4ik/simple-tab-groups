
/**
 * Live delta-sync orchestrator (Phase P3b).
 *
 * Wires the pure delta pipeline (`plan-sync.js` → `replay.js`) into the real sync
 * flow: pull the cloud snapshot + every device's delta log, compute the resolved
 * effective state and a declarative `browserOps` diff (PURE, via {@link planSync}),
 * then APPLY that diff to the live browser through STG's existing tab/group apply
 * paths, and finally PUSH this device's own delta file back.
 *
 * This module is the impure transport half of the contract documented in
 * `plan-sync.js`. It deliberately reuses `cloud.js`'s scaffolding rather than
 * duplicating it: the provider factory, the `inProgress` guard, the
 * `send('sync-*')` broadcast, and `CloudError` are all imported from there. The
 * old URL-based `synchronization()` in `cloud.js` is left intact for explicit Cloud
 * backup push/restore; the manual button and the alarm route here instead.
 *
 * ## Feedback-loop guard (critical)
 * Applying remote changes must NOT be re-captured by `delta-capture.js` as fresh
 * local deltas, or every sync would grow the log and duplicate tabs forever. Two
 * layers protect against this:
 *   1. We route every apply through STG's existing skip machinery — `createMultiple`
 *      / `moveNative` with `skipTrackingFlag=true`, `Tabs.remove(arr, true)` with
 *      `silentRemove`, and `Groups.save(...)` directly (which never fires the
 *      `sendAdded/sendUpdated/sendRemoved` helpers the capture layer hooks). Those
 *      paths make the `tabs.js` `onCreated/onMoved/onRemoved` handlers early-return,
 *      so capture is never invoked.
 *   2. Belt-and-suspenders: we wrap the whole apply in
 *      {@link module:sync/delta/delta-capture.beginApply}/`endApply`, which sets a
 *      module-level flag so that even capture entry points NOT covered by a skip
 *      flag (notably the `onUpdated` url/title `tab.modify` path, which a freshly
 *      created sync tab triggers when it loads) early-return during apply.
 *
 * @module sync/delta/delta-sync
 */

import * as Constants from '/js/constants.js';
import * as Storage from '/js/storage.js';
import * as Tabs from '/js/tabs.js';
import * as Groups from '/js/groups.js';
import * as MenusMain from '/js/menus-main.js';
import * as Windows from '/js/windows.js';
import * as Cache from '/js/cache.js';
import * as Containers from '/js/containers.js';
import backgroundSelf from '/js/background.js';
import Logger from '/js/logger.js';
import {createCloudProvider} from '../cloud/provider.js';
import * as SyncStorage from '../sync-storage.js';
// Same `?can-do-synchronization` instance the background page uses, so `send`
// broadcasts on the one cloud channel and there is no duplicate cloud.js module.
import {CloudError, send, ALARM_NAME_RETRY} from '../cloud/cloud.js?can-do-synchronization';
import {runSyncApply, isUserActive, DEFAULT_SYNC_APPLY_WATCHDOG_MS} from './user-priority-lock.js';
import * as DeltaLog from './delta-log.js';
import * as DeltaCapture from './delta-capture.js';
import {getDeviceId} from './device-id.js';
import {planSync, computeBootstrapEvents, baselineFromSnapshot} from './plan-sync.js';
import {
    evaluateCompaction,
    selfFoldedSeq,
    truncateSelfEvents,
    resolveDeferredTruncation,
} from './compaction.js';
import {
    makeOutboundMapper,
    makeInboundMapper,
    mapStateContainers,
    mapEventContainers,
} from './container-map.js';
import {syncedOptionKeys} from './option-keys.js';
import {shouldSleepSyncedTab, SLEEP_OPTION_KEYS} from './tab-sleep.js';
import {isUrlSyncable, unwrapStubUrl, sanitizeFavIconUrl, liveUrlMatchesSource, shouldNavigateLiveTabUrl} from './url-sync.js';
import {
    SNAPSHOT_FILE_NAME,
    DELTA_FILE_PREFIX,
    deltaFileName,
    deviceIdFromDeltaFileName,
} from './layout.js';

const logger = new Logger('DeltaSync');

const storage = localStorage.create(Constants.MODULES.CLOUD);

// --- Apply-phase diagnostics + completion watchdog --------------------------
// The sync apply runs as the critical section of the user-priority mutex (every user
// group/tab mutation queues behind it on the same promise tail). If any await inside the
// apply never settles, the lock never releases and EVERY future user action hangs forever
// — the reported post-sync UI freeze. To both DIAGNOSE and BOUND that, we (a) time each
// major apply phase and record the most-recently-STARTED one in `currentApplyPhase`, and
// (b) wrap the apply in a completion watchdog (see runSyncApply): if it trips, the WARN it
// logs names exactly the phase that stalled.
//
// `currentApplyPhase` is module-level (single bg-page realm; one apply at a time under the
// mutex) so the watchdog callback can read the stuck phase without threading it through.
let currentApplyPhase = null;

// How long the apply may HOLD the user-priority lock before the completion watchdog frees
// it (see runSyncApply in user-priority-lock.js). Generous — well above any legitimate
// apply (a real apply of dozens of tabs completes in a few seconds per the debug logs) —
// so it only ever fires on a genuine never-settling stall, never on a slow-but-fine apply.
const SYNC_APPLY_WATCHDOG_MS = DEFAULT_SYNC_APPLY_WATCHDOG_MS;

/**
 * Begin one apply phase: record it as the current phase (overwriting any prior phase, so a
 * stall leaves `currentApplyPhase` holding the phase that hung) and return an `endPhase()`
 * that logs the phase duration. Phase-level only — no per-tab spam, no blobs. Call the
 * returned `endPhase()` when the phase finishes; it is a no-op if a later phase already
 * started (so an early-return that forgets to call it can't mislabel the next phase's timing).
 * @param {string} name  phase name (shows in the debug log + the watchdog WARN).
 * @param {object} log   parent logger context.
 * @returns {() => void} endPhase
 */
function beginApplyPhase(name, log) {
    currentApplyPhase = name;
    const startedAt = Date.now();
    return function endPhase() {
        log.log('apply phase done', {phase: name, ms: Date.now() - startedAt});
    };
}

// Per-device, per-install persisted high-water marks for the delta pipeline. Kept
// in the synchronous CLOUD localStorage (same store as deviceId/githubGistFileName)
// so they survive restarts and never need an await. Keyed by selfDeviceId so a
// shared profile copied between installs can't cross its marks.
const LAST_PUSHED_SEQ_PREFIX = 'deltaLastPushedSeq:';
const WATERMARK_PREFIX = 'deltaBaseWatermark:';
// Per-device "a local reset happened; reconcile against the stale CLOUD watermark on
// the next sync" flag (E2). resetSyncState rewinds local lastSeq to 0 but CANNOT clear
// the cloud snapshot's watermark[self]=N, so re-issued seq 1..N would be silently
// dedup-skipped by replay. While this flag is set we force a FULL pull (bypassing the
// conditional fast path, which can't see the cloud watermark) so we can fast-forward
// this device's log above that watermark, then clear the flag. Keyed by selfDeviceId.
const RESET_PENDING_PREFIX = 'deltaResetPending:';
// Per-device DEFERRED SELF-TRUNCATION marker (Part C, the data-loss backstop). When a
// compaction cycle writes a new snapshot, it does NOT truncate its own log in the same cycle
// (a peer could clobber that just-written snapshot before its durability is confirmed, and
// the snapshot is the ONLY home of folded history — see compaction.js). Instead it records
// here the self watermark seq it folded into the snapshot it wrote. On a SUBSEQUENT cycle,
// once the PULLED cloud snapshot's watermark[self] proves >= this seq (our snapshot survived
// or a later one supersedes it), the truncation is confirmed safe: we clearUpTo it locally
// and drop seq <= it from the cloud self-delta, then clear the marker. If the snapshot was
// clobbered (watermark below the marker), we keep deferring (events stay in the cloud delta,
// nothing lost). Stored as a number string in the synchronous CLOUD localStorage, keyed by
// selfDeviceId.
const PENDING_TRUNCATE_PREFIX = 'deltaPendingTruncateSeq:';
// Per-device durable baseline = the set of group ids + tab uids this device last
// reconciled as synced (the ids/uids in the resolved snapshot at the end of its last
// successful sync). It is the authoritative "did THIS device know this as synced"
// signal that gates removals: it survives cloud compaction (which prunes the delete
// events the old cloud-known gate relied on), so a delete still propagates to a
// device that was offline across a compaction window, while never deleting a
// never-synced local item. Stored as JSON {tabUids, groupIds} in the synchronous
// CLOUD localStorage, keyed by selfDeviceId.
const BASELINE_PREFIX = 'deltaBaseline:';

// --- Pre-apply safety backup (Feature 1) -----------------------------------
// Number of rolling backup slots kept on disk. Each pre-apply backup overwrites
// the next slot (round-robin), so disk use is bounded to exactly this many files
// instead of growing unbounded. 5 mirrors a "last few" retention window.
const PRE_APPLY_BACKUP_SLOTS = 5;
// CLOUD-localStorage key holding the next slot index to (over)write. Synchronous,
// survives restarts. A missing/corrupt value restarts from slot 0 (harmless).
const PRE_APPLY_BACKUP_SLOT_KEY = 'deltaPreApplyBackupSlot';
// Expand the user-configurable `syncBackupFilePath` template's `{slot}` token to the
// current round-robin slot; the remaining placeholders (`{ff-version}`, dates) are
// expanded later by File.save's getFilePathVariables() and `.json` appended by
// File.saveBackup. Keeping `{slot}` in the default template bounds the on-disk set to
// PRE_APPLY_BACKUP_SLOTS files; a template without it overwrites a single file.
function preApplyBackupFilePath(template, slot) {
    return template.replaceAll('{slot}', String(slot));
}

function lastPushedSeqKey(deviceId) {
    return LAST_PUSHED_SEQ_PREFIX + deviceId;
}

function watermarkKey(deviceId) {
    return WATERMARK_PREFIX + deviceId;
}

function baselineKey(deviceId) {
    return BASELINE_PREFIX + deviceId;
}

function resetPendingKey(deviceId) {
    return RESET_PENDING_PREFIX + deviceId;
}

function pendingTruncateKey(deviceId) {
    return PENDING_TRUNCATE_PREFIX + deviceId;
}

/**
 * Load this device's persisted baseline. Returns empty sets on first run (or if the
 * stored value is missing/corrupt) — the conservative default: an empty baseline
 * authorizes NO removals, so a lost/cleared baseline can never cause data loss, only
 * a transient failure to propagate a delete (re-established on the next sync once the
 * item is reconciled again).
 * @param {string} deviceId
 * @returns {{tabUids: Set<*>, groupIds: Set<*>, optionKeys: Set<*>, pinnedUids: Set<*>}}
 */
function loadBaseline(deviceId) {
    const raw = storage[baselineKey(deviceId)];
    if (!raw) {
        return {tabUids: new Set(), groupIds: new Set(), optionKeys: new Set(), pinnedUids: new Set()};
    }
    try {
        const parsed = JSON.parse(raw);
        return {
            tabUids: new Set(parsed.tabUids || []),
            groupIds: new Set(parsed.groupIds || []),
            optionKeys: new Set(parsed.optionKeys || []),
            pinnedUids: new Set(parsed.pinnedUids || []),
        };
    } catch {
        return {tabUids: new Set(), groupIds: new Set(), optionKeys: new Set(), pinnedUids: new Set()};
    }
}

/**
 * Persist this device's baseline (arrays of ids/uids + synced option keys + global
 * pinned uids). Called ONLY after a successful sync, with the ids/uids/keys of the
 * resolved snapshot. `pinnedUids` MUST round-trip: it is what gates global-pinned-tab
 * removal (see {@link module:sync/delta/plan-sync.diffToBrowserOps}) — without it a
 * synced pinned tab deleted on another device would never be removed here, because the
 * removal gate `in baseline AND absent from resolved` could never see it as synced.
 * @param {string} deviceId
 * @param {{tabUids: Array<*>, groupIds: Array<*>, optionKeys: Array<*>, pinnedUids: Array<*>}} baseline
 */
function saveBaseline(deviceId, baseline) {
    storage[baselineKey(deviceId)] = JSON.stringify({
        tabUids: baseline.tabUids || [],
        groupIds: baseline.groupIds || [],
        optionKeys: baseline.optionKeys || [],
        pinnedUids: baseline.pinnedUids || [],
    });
}

/**
 * Map STG's loaded groups into the snapshot shape the planner consumes:
 * `{groups: [{id, ...props, tabs: [{uid, url, title, cookieStoreId, index, ...}]}]}`.
 *
 * PURE: no `browser.*`, reads the input, returns a fresh structure. Archived groups
 * keep their stored `tabs` as-is (they already carry uid via `prepareForSave`); live
 * groups carry the session-hydrated tabs (uid/lastModified applied by `Tabs.get`).
 * Tabs without a `uid` are dropped from localState: the planner keys tabs by uid, and
 * an un-uided tab can't be reconciled — leaving it out means the planner treats it as
 * "not present locally" rather than mis-removing it (bias to keep, never to lose).
 *
 * Global pinned tabs (window-global, not in any group) are passed in separately and
 * Tab URLs are decoded back from STG's "unsupported URL" stub page to their embedded
 * original (see {@link module:sync/delta/url-sync} `unwrapStubUrl`) so a tab a previous
 * sync rendered as the stub keeps its original about: identity in this snapshot.
 *
 * mapped into a flat `pinnedTabs` array — the planner diffs them as a parallel section
 * keyed by uid. Same uid-required filter as group tabs (an un-uided pinned tab can't be
 * reconciled, so leaving it out biases to keep rather than mis-remove).
 *
 * @param {object[]} loadedGroups - result of `Groups.load(null, true).groups`.
 * @param {object} [syncedOptions] - this device's current values for the SYNCED option
 *   keys (already filtered to the synced subset by the caller). Folded into
 *   `localState.options` so the planner can diff resolved-vs-local options. Defaults to
 *   `{}` (so existing callers/tests that pass only groups keep working).
 * @param {object[]} [livePinnedTabs] - live global pinned tabs (uid-hydrated) for this device.
 * @returns {{groups: object[], pinnedTabs: object[], options: object}}
 */
export function buildLocalState(loadedGroups, syncedOptions = {}, livePinnedTabs = []) {
    const groups = (loadedGroups || []).map(group => {
        const {tabs, ...props} = group;

        const mappedTabs = (Array.isArray(tabs) ? tabs : [])
            .filter(tab => tab && tab.uid != null)
            .map((tab, index) => ({
                uid: tab.uid,
                url: unwrapStubUrl(tab.url),
                title: tab.title,
                cookieStoreId: tab.cookieStoreId,
                // GROUP-RELATIVE position: `Groups.load` returns `group.tabs` already in
                // group order (sorted by browser index), so the local ARRAY POSITION is
                // the correct 0-based order WITHIN the group. The raw `tab.index` is the
                // browser-window-absolute index (shifted by pinned tabs and other groups'
                // tabs sharing the window, and different per machine) — using it would
                // shuffle tab order on the receiving side. See replay.js for the contract.
                index,
                lastModified: tab.lastModified,
                // Carry only a small URL favicon reference: sanitizeFavIconUrl DROPS inline
                // data: favicons (they caused the multi-GB bloat) and oversized URLs. Read live
                // here so the compaction snapshot carries the tab's current favicon reference —
                // the propagation path for a favicon that changed without a title/url change.
                favIconUrl: sanitizeFavIconUrl(tab.favIconUrl),
                // group-scoped pin flag (pinned within an active group). Mirrors the
                // delta-capture record field; only present when true so it round-trips
                // through replay/plan without perturbing other tabs.
                ...(tab.groupPinned ? {pinned: true} : {}),
                // source loaded-state (mirrors delta-capture buildTabRecord): true when the
                // tab is loaded (not discarded) here, so a receiving device with
                // `syncActivatePreviouslyActiveTabs` on can re-activate it. Additive/true-only.
                ...(tab.discarded === false ? {loaded: true} : {}),
                // keep the live browser id so the apply step can target real tabs
                id: tab.id,
            }));

        // NO-SILENT-DROP SAFEGUARD: a non-archived group's tabs are LIVE-enumerated (see
        // Groups.load: `group.tabs` is rebuilt from the browser query, not from storage), so
        // a normal grouped tab that fails to enumerate (or whose uid never committed) silently
        // vanishes from the pushed snapshot — the exact shape of the group-normal-tabs sync
        // data loss this guards against. If a non-archived group HAD input tabs but every one
        // was dropped (no uid), or fewer survived than came in, surface it in the debug log so
        // this class of loss is visible rather than silent. Archived groups carry stored tabs
        // (already uid'd) and aren't live-enumerated, so they're exempt. Warn only, never throw
        // — biasing to keep what we can over failing the whole sync.
        const inputTabCount = Array.isArray(tabs) ? tabs.length : 0;
        if (!group.isArchive && inputTabCount > mappedTabs.length) {
            logger.warn('buildLocalState: non-archived group dropped tabs from local snapshot', {
                groupId: group.id,
                inputTabCount,
                mappedTabCount: mappedTabs.length,
                droppedCount: inputTabCount - mappedTabs.length,
            });
        }

        return {...props, tabs: mappedTabs};
    });

    const pinnedTabs = (Array.isArray(livePinnedTabs) ? livePinnedTabs : [])
        .filter(tab => tab && tab.uid != null)
        .map((tab, index) => ({
            uid: tab.uid,
            url: tab.url,
            title: tab.title,
            cookieStoreId: tab.cookieStoreId,
            // pinned tabs are first in the window, so the live browser `index` is already
            // the pinned-relative position; fall back to array order if it's not finite.
            index: Number.isFinite(tab.index) ? tab.index : index,
            lastModified: tab.lastModified,
            // sanitizeFavIconUrl DROPS inline data: favicons (they caused the multi-GB bloat)
            // and oversized URLs; only a small URL reference is kept ⇒ undefined ⇒ field omitted.
            favIconUrl: sanitizeFavIconUrl(tab.favIconUrl),
            // source loaded-state (see grouped tabs above): pinned tabs are usually loaded,
            // but we record the live signal so `syncActivatePreviouslyActiveTabs` can honor
            // it on the receiving side. Additive/true-only.
            ...(tab.discarded === false ? {loaded: true} : {}),
            // keep the live browser id so the apply step can target real tabs
            id: tab.id,
        }));

    return {groups, pinnedTabs, options: {...syncedOptions}};
}

/**
 * Resolve the base snapshot to plan against: the delta-era snapshot file when it exists,
 * else an empty snapshot. Never throws on "absent" — `readFile` resolves null. A brand-new
 * gist starts from the empty snapshot; the first sync then seeds it from the CURRENT LOCAL
 * app state via the bootstrap step (see {@link gatherLocalPending}/{@link computeBootstrapEvents}).
 *
 * `snapshotExists` reports whether the `STG-sync-snapshot.json` FILE was actually present in
 * the gist (true) or had to be synthesized from the empty default (false). The push step
 * uses it to FIRST-CREATE the snapshot when it does not yet exist, even on a cycle that did
 * not compact (see the snapshot-write gate in {@link deltaSynchronization}).
 * @param {object} Cloud - provider instance.
 * @returns {Promise<{snapshot: {groups: object[], watermark?: object}, snapshotExists: boolean}>}
 */
async function resolveBaseSnapshot(Cloud) {
    const snapshot = await Cloud.readFile(SNAPSHOT_FILE_NAME);
    if (snapshot) {
        return {snapshot, snapshotExists: true};
    }

    return {snapshot: {groups: [], watermark: {}}, snapshotExists: false};
}

/**
 * Read every per-device delta log from the cloud and normalize to the planner shape
 * `[{deviceId, events}]`. The deviceId comes from the file content when present,
 * else is parsed from the file name (resilient to a hand-edited file). The gist file
 * `name` it was read from is carried through too (used when rewriting a device's own
 * delta file, rather than reconstructing the name and risking a mismatch between a
 * hand-edited `content.deviceId` and the filename).
 * @param {object} Cloud - provider instance.
 * @returns {Promise<Array<{name: string, deviceId: string, events: object[]}>>}
 */
async function resolvePulledDeltaLogs(Cloud) {
    const files = await Cloud.readAllMatching(DELTA_FILE_PREFIX);

    return (files || []).map(({name, content}) => ({
        name,
        deviceId: content?.deviceId ?? deviceIdFromDeltaFileName(name),
        events: Array.isArray(content?.events) ? content.events : [],
    }));
}

/**
 * Apply the planner's declarative `browserOps` to the live browser through STG's
 * existing apply paths, using skip/silent flags so the capture layer does not record
 * these as new deltas. Conservative ordering: create groups first (so tab targets
 * exist), then create/move tabs, then remove tabs, then remove groups last.
 *
 * Removal is the resolved-says-gone set ONLY (the planner derives it by uid/id
 * difference); when in doubt the pipeline biases to keeping/creating a tab (replay
 * rule 1), so a removal here genuinely means the resolved state dropped it.
 *
 * @param {object} browserOps - from {@link planSync}.
 * @param {object} [resolvedSnapshot] - from {@link planSync} (`plan.resolvedSnapshot`).
 *   Its per-group tab arrays are the AUTHORITATIVE order; after creates/moves we reconcile
 *   each touched group's live tab order to it (see {@link reconcileGroupTabOrders}).
 * @returns {Promise<void>}
 */
async function applyBrowserOps(browserOps, resolvedSnapshot) {
    const log = logger.start('applyBrowserOps', {
        groupsToCreate: browserOps.groupsToCreate.length,
        groupsToUpdate: browserOps.groupsToUpdate.length,
        groupsToRemove: browserOps.groupsToRemove.length,
        groupsReorder: browserOps.groupsOrder ? browserOps.groupsOrder.length : 0,
        tabsToCreate: browserOps.tabsToCreate.length,
        tabsToMove: browserOps.tabsToMove.length,
        tabsToUpdate: browserOps.tabsToUpdate?.length || 0,
        tabsToRemove: browserOps.tabsToRemove.length,
        pinnedToCreate: browserOps.pinnedToCreate?.length || 0,
        pinnedToMove: browserOps.pinnedToMove?.length || 0,
        pinnedToUpdate: browserOps.pinnedToUpdate?.length || 0,
        pinnedToRemove: browserOps.pinnedToRemove?.length || 0,
    });

    // belt-and-suspenders: suppress capture for anything we apply (see module docs)
    DeltaCapture.beginApply();

    // LOCAL-ONLY sleep/activate options that decide whether each sync-created tab is
    // created asleep (discarded) or loaded. Read once here and threaded into both the
    // grouped-create and pinned-create paths via shouldSleepSyncedTab (see tab-sleep.js).
    const sleepOptions = await Storage.get(SLEEP_OPTION_KEYS);

    try {
        // --- groups create/update: persist via Groups.save (bypasses send* helpers
        // the capture layer hooks). We load current groups, fold the changes, save once.
        const needGroupWrite = browserOps.groupsToCreate.length
            || browserOps.groupsToUpdate.length
            || browserOps.groupsToRemove.length
            || browserOps.groupsOrder;

        if (needGroupWrite) {
            const endPhase = beginApplyPhase('groups-write', log);
            const {groups} = await Groups.load(null, false);
            const byId = new Map(groups.map(g => [g.id, g]));

            for (const props of browserOps.groupsToCreate) {
                if (!byId.has(props.id)) {
                    const created = {...Groups.create(props.id, props.title), ...props, tabs: []};
                    groups.push(created);
                    byId.set(created.id, created);
                }
            }

            const archiveTransitions = [];
            for (const props of browserOps.groupsToUpdate) {
                const existing = byId.get(props.id);
                if (existing) {
                    const {props: plainProps, archiveTransition} = extractArchiveTransition(existing.isArchive, props);
                    Object.assign(existing, plainProps);
                    if (archiveTransition !== null) {
                        archiveTransitions.push({groupId: existing.id, isArchive: archiveTransition});
                    }
                }
            }

            // unload (move out of windows) any group we're about to remove, then drop it
            const removeIds = new Set(browserOps.groupsToRemove.map(g => g.id));
            for (const id of removeIds) {
                if (Groups.isLoaded(id)) {
                    await Groups.unload(id).catch(log.onCatch(['cant unload group', id], false));
                }
            }

            let nextGroups = groups.filter(g => !removeIds.has(g.id));

            // GROUP ORDER: `Groups.save` persists the array order = the order STG shows,
            // so reorder to match the resolved (authoritative) group order. Groups present
            // only locally (not in the resolved order) are KEPT, appended after the ordered
            // ones — never dropped.
            if (browserOps.groupsOrder) {
                nextGroups = reorderGroups(nextGroups, browserOps.groupsOrder);
            }

            await Groups.save(nextGroups);

            for (const {groupId, isArchive} of archiveTransitions) {
                if (removeIds.has(groupId)) {
                    continue;
                }
                await Groups.setArchiveStateWhileHoldingLock(groupId, isArchive)
                    .catch(log.onCatch(['cant apply archive state', groupId], false));
            }
            endPhase();
        }

        // --- tabs create: group by target group so each batch gets the right
        // groupId/windowId (mirrors cloud.js:316-324). Stamp the REMOTE uid onto each
        // created tab afterwards so its identity is stable across the next sync round
        // (otherwise apply→re-pull would churn: remove + recreate the same tab forever).
        //
        // IDEMPOTENT CREATE (anti-duplication): a tab whose uid is ALREADY live must never
        // be re-created. The planner emits a create when a resolved uid is absent from the
        // snapshot localState, but uid↔cloud correspondence can drift (partial reset, or a
        // Firefox session restore minting fresh uids while the cloud still holds old-uid
        // records) so that the live cache here disagrees with that snapshot — re-creating
        // then puts a second copy next to the existing tab (the duplicate-in-active-group
        // bug). Build the live-by-uid index ONCE and skip any create whose uid is already
        // live; a tab that already exists at most needs a move/update, which other ops do.
        const endCreatePhase = browserOps.tabsToCreate.length ? beginApplyPhase('tabs-create', log) : null;
        const liveByUidForCreate = await buildLiveTabIndexByUid();

        const createsByGroup = new Map();
        for (const tab of browserOps.tabsToCreate) {
            const groupId = tab.target?.groupId;
            if (groupId == null) {
                continue;
            }
            if (tab.uid != null && liveByUidForCreate.has(tab.uid)) {
                log.log('idempotent create: skip already-live tab uid', tab.uid);
                continue;
            }
            if (!createsByGroup.has(groupId)) {
                createsByGroup.set(groupId, []);
            }
            createsByGroup.get(groupId).push(tab);
        }

        for (const [groupId, allTabs] of createsByGroup) {
            const groupWindowId = Cache.getWindowId(groupId); // null if group not loaded

            // URL-LESS / BLANK GUARD (anti-freeze): never create a bare tab from a url-less or
            // trivial-blank sync record. A record with no syncable url would yield a loading
            // about:blank tab (Tabs.create with no url) that carries a uid the cloud never had —
            // re-created every cycle (the unstamped-create flood). The cloud is structurally
            // clean of such records (verified against the gist), so this is a belt-and-suspenders
            // guard against a malformed/partial record rather than an expected case; a dropped
            // create is re-attempted on the next sync if the record gains a real url.
            const tabs = allTabs.filter(tab => {
                if (isUrlSyncable(unwrapStubUrl(tab.url))) {
                    return true;
                }
                log.log('skip create of url-less/blank tab record', tab.uid, tab.url);
                return false;
            });
            if (!tabs.length) {
                continue;
            }

            const toCreate = tabs.map(tab => ({
                url: tab.url,
                title: tab.title,
                cookieStoreId: tab.cookieStoreId,
                index: tab.target?.index,
                groupId,
                windowId: groupWindowId,
                favIconUrl: tab.favIconUrl,
                // group-scoped pin flag rides the create; persisted as a session value so
                // the group's next apply pins it in the right slot. We do NOT create it
                // browser-pinned here: a not-loaded group keeps its tabs hidden, and a
                // pinned tab can't be hidden — apply does the live pin when the group shows.
                groupPinned: tab.pinned === true,
                // sleep-by-default: create the tab asleep (discarded) unless the user's
                // activate-options say otherwise (see tab-sleep.js). STG's create path
                // already discards inactive-group tabs and refuses to discard the active
                // group's foreground tab, so this only widens "asleep" to cases STG would
                // otherwise force-load; it never force-loads the active group's tab.
                discarded: shouldSleepSyncedTab(tab, false, sleepOptions),
            }));

            const created = await Tabs.createMultiple(toCreate, true);

            // Stamp the REMOTE uid (+ lastModified) onto each created tab so identity is
            // stable across the next sync round; otherwise apply→re-pull would churn
            // (remove + recreate the same tab forever — the unstamped-create flood that left the
            // M2 device with re-created tabs whose uids the cloud never had).
            //
            // createMultiple may re-order / drop tabs (per-window grouping, index re-sort), so we
            // match in precision order:
            //   (1) STUB-AWARE url match: a created tab's url equals the source url, OR — for a
            //       privileged about: url that STG rendered as the moz-extension "unsupported URL"
            //       stub — its DECODED url equals the source url. This is the key fix: without the
            //       decode, an about:debugging/about:memory source (created.url = stub) never
            //       matched its source.url = about:… → left UNSTAMPED → re-created next cycle.
            //   (2) ORDER-STABLE positional fallback for anything still unmatched: `toCreate` was
            //       built in `tabs` order and createMultiple returns each window's tabs sorted by
            //       index (the order we requested), so pairing the remaining created tabs to the
            //       remaining sources IN ORDER reliably stamps tabs whose live url differs from
            //       both source and stub (e.g. a tab still at about:blank mid-navigation).
            // A source we still can't pair (more sources than created tabs — a create failed) is
            // left unstamped, but the idempotent-by-uid create guard above will NOT re-create it
            // while a live same-url tab exists, so it cannot flood.
            const createdPool = created.filter(Boolean);
            const usedCreated = new Set();

            const stamp = async (newTab, source) => {
                await Cache.setTabUid(newTab.id, source.uid).catch(log.onCatch(['cant set uid', newTab.id], false));
                if (source.lastModified != null) {
                    await Cache.setTabLastModified(newTab.id, source.lastModified)
                        .catch(log.onCatch(['cant set lastModified', newTab.id], false));
                }
            };

            const unmatchedSources = [];
            for (const source of tabs) {
                const match = createdPool.find(t => !usedCreated.has(t.id)
                    && liveUrlMatchesSource(t.url, source.url));
                if (match) {
                    usedCreated.add(match.id);
                    await stamp(match, source);
                } else {
                    unmatchedSources.push(source);
                }
            }

            const remainingCreated = createdPool.filter(t => !usedCreated.has(t.id));
            for (let k = 0; k < unmatchedSources.length && k < remainingCreated.length; k++) {
                await stamp(remainingCreated[k], unmatchedSources[k]);
            }

            // if the group isn't shown in a window, keep the created tabs hidden
            if (!Groups.isLoaded(groupId)) {
                await Tabs.hide(created, true).catch(log.onCatch(['cant hide tabs for group', groupId], false));
            } else if (tabs.some(tab => tab.pinned === true)) {
                // the group is shown and at least one created tab is group-pinned →
                // re-apply pin ordering so it lands after the global pinned region.
                await Groups.applyGroupPinnedOrder(groupId)
                    .catch(log.onCatch(['cant apply group-pinned order', groupId], false));
            }
        }
        endCreatePhase?.();

        if (browserOps.tabsToMove.length) {
            const endPhase = beginApplyPhase('tabs-move', log);
            const liveByUid = await buildLiveTabRecordByUid();

            for (const move of browserOps.tabsToMove) {
                const liveTab = liveByUid.get(move.uid);
                if (liveTab == null) {
                    continue;
                }
                await applyTabMove(liveTab, move.target || {}, log);
            }
            endPhase();
        }

        // --- tabs update: CONTENT changes (url/title/favIcon/group-pin/…) to a tab that
        // ALREADY exists on this device. The per-tab analogue of groupsToUpdate; without it a
        // content change to an existing peer tab never landed (the "half-wired" sync bug).
        // Applied via the create path's mechanisms (Cache session values + a guarded live url
        // navigation); see applyTabContentUpdate. Runs after move so it lands on the final tab.
        if (browserOps.tabsToUpdate?.length) {
            const endPhase = beginApplyPhase('tabs-update', log);
            const liveByUid = await buildLiveTabRecordByUid();

            for (const update of browserOps.tabsToUpdate) {
                const liveTab = liveByUid.get(update.uid);
                if (liveTab == null) {
                    continue; // not live (a resurrected tab surfaces as create, not update)
                }
                await applyTabContentUpdate(liveTab, update.target || {}, log);
            }
            endPhase();
        }

        // --- tabs remove: resolved-says-gone set ONLY. Silent so the removal isn't
        // captured and so the UI reloads in one pass.
        if (browserOps.tabsToRemove.length) {
            const endPhase = beginApplyPhase('tabs-remove', log);
            const liveByUid = await buildLiveTabIndexByUid();
            const removeIds = browserOps.tabsToRemove
                .map(t => liveByUid.get(t.uid))
                .filter(id => id != null);

            if (removeIds.length) {
                await Tabs.remove(removeIds.map(id => ({id})), true)
                    .catch(log.onCatch('cant remove tabs', false));
            }
            endPhase();
        }

        // --- realize the RESOLVED group tab order. createMultiple may place created
        // tabs out of order and the planner emits no `tabsToMove` for not-yet-local
        // creates, so the live order can diverge from the resolved (authoritative) order
        // for created and/or unloaded-group tabs. Reconcile every group the resolved
        // state knows, matching live tabs to resolved tabs by uid. Runs AFTER creates +
        // moves + removes so it orders the group's FINAL membership.
        const endReconcile = beginApplyPhase('reconcile-group-tab-orders', log);
        await reconcileGroupTabOrders(resolvedSnapshot, log);
        endReconcile();

        const endPinned = beginApplyPhase('pinned-ops', log);
        await applyPinnedOps(browserOps, log, sleepOptions);
        endPinned();

        log.stop();
    } finally {
        DeltaCapture.endApply();
    }
}

/**
 * Reconcile every resolved group's LIVE browser tab order to its RESOLVED (authoritative)
 * order, for BOTH loaded and unloaded groups. The bug this fixes: on a clean sync the
 * receiving machine creates a group's tabs via {@link Tabs.createMultiple}, which re-sorts
 * by absolute window index (and, for an unloaded group, drops them into a shared hidden
 * pool) — so the group can show its tabs SHUFFLED, while the planner emits no `tabsToMove`
 * to fix it (the created tabs weren't "local" at plan time). Since a non-archived group's
 * order lives ONLY in the browser tab indices (`Storage.set` wipes the stored `tabs`), the
 * robust fix is to physically `moveNative` the group's tabs into the resolved sequence.
 *
 * We move the group's tabs AS AN ORDERED ARRAY to the group's current minimum index in one
 * `moveNative` call (the same pattern `Groups.showGroup` uses): Firefox places an array of
 * ids contiguously starting at that index, so the global-pinned / group-pinned / other-group
 * offset ahead of the group is preserved and the tabs just permute among the slots they
 * already occupy. Match is by `uid` (see {@link orderedGroupTabIds}). Conservative on
 * failure: logs and never removes/loses a tab.
 *
 * @param {object} [resolvedSnapshot] - from {@link planSync} (`plan.resolvedSnapshot`).
 * @param {object} log - parent logger context.
 * @returns {Promise<void>}
 */
async function reconcileGroupTabOrders(resolvedSnapshot, log) {
    const resolvedGroups = resolvedSnapshot?.groups;
    if (!Array.isArray(resolvedGroups) || !resolvedGroups.length) {
        return;
    }

    // resolved uid order per group id
    const resolvedOrderByGroupId = new Map();
    for (const group of resolvedGroups) {
        const uids = (Array.isArray(group.tabs) ? group.tabs : [])
            .map(tab => tab?.uid)
            .filter(uid => uid != null);
        if (uids.length) {
            resolvedOrderByGroupId.set(group.id, uids);
        }
    }
    if (!resolvedOrderByGroupId.size) {
        return;
    }

    // live tabs per group (with their current browser index, sorted by it via Groups.load).
    const {groups: liveGroups} = await Groups.load(null, true);

    for (const group of liveGroups) {
        if (group.isArchive || !Array.isArray(group.tabs)) {
            continue;
        }
        const resolvedUidOrder = resolvedOrderByGroupId.get(group.id);
        if (!resolvedUidOrder) {
            continue;
        }

        const orderedIds = orderedGroupTabIds(resolvedUidOrder, group.tabs);
        if (!orderedIds.length) {
            continue; // <2 tabs or already in order
        }

        // anchor: the smallest index this group's tabs currently occupy, so the move
        // preserves the offset of anything ahead of the group (pinned / other groups).
        const minIndex = Math.min(...group.tabs.map(tab => tab.index).filter(Number.isFinite));
        if (!Number.isFinite(minIndex)) {
            continue;
        }

        await Tabs.moveNative(orderedIds.map(id => ({id})), {index: minIndex}, true)
            .catch(log.onCatch(['cant reorder group tabs to resolved order', group.id], false));

        // a LOADED group with group-pinned tabs: the moveNative above ignores the pin
        // boundary, so re-settle the group-pinned region (pins flagged tabs right after the
        // global pinned tabs, before this group's normal tabs). No-op when not loaded / none pinned.
        if (Groups.isLoaded(group.id) && group.tabs.some(tab => tab.groupPinned)) {
            await Groups.applyGroupPinnedOrder(group.id)
                .catch(log.onCatch(['cant re-apply group-pinned order after reorder', group.id], false));
        }
    }
}

/**
 * Apply the planner's pinned `browserOps` (`pinnedToCreate/Move/Remove`) to the live
 * browser through STG's skip machinery. Global pinned tabs are window-global; created
 * ones go into the last-focused NORMAL window (reusing {@link Windows.getLastFocusedNormalWindow}),
 * with `pinned:true` and `skipTrackingFlag` so capture does not re-record them. STG group
 * tabs are never created here — the planner only emits pinned ops for the global pinned
 * section. Order: create, then update (content), then move (reorder), then remove (silent).
 *
 * @param {object} browserOps - from {@link planSync}.
 * @param {object} log - the parent logger context.
 * @param {object} sleepOptions - the LOCAL-ONLY sleep/activate option bag (read by
 *   {@link applyBrowserOps}); decides whether created pinned tabs are asleep or loaded.
 * @returns {Promise<void>}
 */
async function applyPinnedOps(browserOps, log, sleepOptions = {}) {
    const toCreate = browserOps.pinnedToCreate || [];
    const toMove = browserOps.pinnedToMove || [];
    const toRemove = browserOps.pinnedToRemove || [];
    const toUpdate = browserOps.pinnedToUpdate || [];

    if (!toCreate.length && !toMove.length && !toRemove.length && !toUpdate.length) {
        return;
    }

    // --- pinned create: window-global ⇒ last-focused normal window. Stamp the REMOTE
    // uid (+ lastModified) onto each created tab so identity is stable across rounds
    // (otherwise apply→re-pull would churn: remove + recreate forever). Same matching
    // strategy as the grouped create path.
    if (toCreate.length) {
        // IDEMPOTENT CREATE (anti-duplication): skip creating a pinned tab whose uid is
        // already live. Mirrors the grouped create guard — uid drift must never spawn a
        // second copy of a tab that already exists; at worst it needs a move/update.
        const liveByUidForCreate = new Map(
            (await getLivePinnedTabs()).filter(t => t.uid != null).map(t => [t.uid, t.id])
        );
        const pinnedToActuallyCreate = toCreate.filter(tab => {
            if (tab.uid != null && liveByUidForCreate.has(tab.uid)) {
                log.log('idempotent pinned create: skip already-live pinned uid', tab.uid);
                return false;
            }
            // URL-LESS / BLANK GUARD (anti-freeze): never create a bare pinned tab from a
            // url-less / trivial-blank record. Pinned tabs are created LOADED (Firefox refuses a
            // discarded pinned tab), so a url-less record would spawn a loading about:blank pinned
            // tab carrying a uid the cloud never had — re-created every cycle (the about:blank
            // pinned-tab flood seen on the M2 device). The cloud is verified clean of such records.
            if (!isUrlSyncable(unwrapStubUrl(tab.url))) {
                log.log('skip create of url-less/blank pinned record', tab.uid, tab.url);
                return false;
            }
            return true;
        });

        const windowId = await Windows.getLastFocusedNormalWindow()
            .catch(log.onCatch('cant resolve normal window for pinned create', false));

        const createProps = pinnedToActuallyCreate.map(tab => ({
            url: tab.url,
            title: tab.title,
            cookieStoreId: tab.cookieStoreId,
            index: tab.target?.index,
            pinned: true,
            // Sleep-by-default: create the synced pinned tab ASLEEP (discarded) so it shows
            // title+favicon but never navigates/loads until the user activates it — unless
            // the user's activate-options say otherwise (see tab-sleep.js). Besides the UX
            // win, an asleep pinned tab can't redirect (e.g. a logged-out
            // meet.google.com → accounts.google.com) and so can't be re-captured as a
            // pinned.modify that pollutes the cloud URL. Tabs.create only honors `discarded`
            // for tabs with a real, restorable URL (about:/long urls still load).
            discarded: shouldSleepSyncedTab(tab, true, sleepOptions),
            windowId: Number.isFinite(windowId) ? windowId : undefined,
            favIconUrl: tab.favIconUrl,
        }));

        const created = await Tabs.createMultiple(createProps, true);
        const createdPool = (created || []).filter(Boolean);
        const usedCreated = new Set();

        const stamp = async (newTab, source) => {
            await Cache.setTabUid(newTab.id, source.uid).catch(log.onCatch(['cant set pinned uid', newTab.id], false));
            if (source.lastModified != null) {
                await Cache.setTabLastModified(newTab.id, source.lastModified)
                    .catch(log.onCatch(['cant set pinned lastModified', newTab.id], false));
            }
        };

        // UID-STABLE MATCHING (anti-duplication + anti-flood): stamp each source uid onto the
        // created tab that actually IS that source. `createdPool` is NOT in source order — Tabs
        // .createMultiple regroups/re-sorts by window+index — and a freshly-created LOADED pinned
        // tab's `url` is UNRELIABLE: Firefox creates pinned tabs loaded (it refuses a discarded
        // pinned tab), so while the tab is still navigating, `created.url` is `about:blank`, not the
        // target url. That is exactly why URL-only matching left the M2 device's claude.ai/gmail
        // pinned tabs UNSTAMPED → re-created every cycle with fresh uids the cloud never had (the
        // about:blank pinned-tab flood). So we match in precision order, ending in an order-stable
        // index fallback that does NOT depend on the (possibly about:blank) live url:
        //   (1) STUB-AWARE url + matching index — unambiguous even when the url repeats; the decode
        //       lets a privileged about: source (created.url = stub) match its source.url = about:…
        //   (2) STUB-AWARE url alone, only when that url is unique among the create sources;
        //   (3) ORDER-STABLE index fallback: pair the still-unmatched sources to the still-unmatched
        //       created tabs IN ASCENDING-INDEX ORDER. createMultiple returns the window's pinned
        //       tabs sorted by index, and each source was requested at its own target.index, so this
        //       reliably stamps a tab whose live url is still about:blank mid-navigation.
        // Only if a source STILL can't be paired (fewer created tabs than sources — a create failed)
        // is the stamp skipped; the idempotent-by-uid guard above then prevents a re-create flood.
        const indexOf = source => source.target?.index;
        const matchesUrl = (t, source) => liveUrlMatchesSource(t.url, source.url);
        const urlCount = new Map();
        for (const source of pinnedToActuallyCreate) {
            urlCount.set(source.url, (urlCount.get(source.url) || 0) + 1);
        }

        const stillUnmatched = [];
        for (const source of pinnedToActuallyCreate) {
            // (1) stub-aware url + matching index — unambiguous even when the url repeats.
            let match = Number.isInteger(indexOf(source))
                ? createdPool.find(t => !usedCreated.has(t.id) && matchesUrl(t, source) && t.index === indexOf(source))
                : undefined;

            // (2) stub-aware url alone, only if this url is not shared by another create source.
            if (!match && urlCount.get(source.url) === 1) {
                match = createdPool.find(t => !usedCreated.has(t.id) && matchesUrl(t, source));
            }

            if (match) {
                usedCreated.add(match.id);
                await stamp(match, source);
            } else {
                stillUnmatched.push(source);
            }
        }

        // (3) ORDER-STABLE index fallback for anything URL matching couldn't pair (e.g. a tab still
        // at about:blank mid-load). Sort both remaining lists by index and pair positionally — this
        // is what stamps the navigating pinned tabs that URL matching used to skip → no more flood.
        if (stillUnmatched.length) {
            const remainingCreated = createdPool
                .filter(t => !usedCreated.has(t.id))
                .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
            const remainingSources = stillUnmatched
                .slice()
                .sort((a, b) => (indexOf(a) ?? 0) - (indexOf(b) ?? 0));
            for (let k = 0; k < remainingSources.length && k < remainingCreated.length; k++) {
                usedCreated.add(remainingCreated[k].id);
                await stamp(remainingCreated[k], remainingSources[k]);
            }
            const leftover = remainingSources.length - remainingCreated.length;
            if (leftover > 0) {
                log.log('pinned create: more sources than created tabs, left unstamped', leftover);
            }
        }
    }

    // --- pinned update / move / remove: resolve live pinned tabs by uid.
    if (toUpdate.length || toMove.length || toRemove.length) {
        const livePinned = await getLivePinnedTabs();
        const idByUid = new Map(livePinned.filter(t => t.uid != null).map(t => [t.uid, t.id]));
        const tabByUid = new Map(livePinned.filter(t => t.uid != null).map(t => [t.uid, t]));

        // --- pinned update: CONTENT change (url/title/favIcon) on an existing global pinned
        // tab. Same mechanism as the grouped update path (Cache for title/favicon, a guarded
        // tabs.update for url that never wakes a discarded tab). `pinned`/`loaded` are filtered
        // out by the planner for global pinned tabs, so only url/title/favIcon arrive here.
        for (const update of toUpdate) {
            const liveTab = tabByUid.get(update.uid);
            if (liveTab == null) {
                continue; // not live (a resurrected pinned tab surfaces as create, not update)
            }
            await applyTabContentUpdate(liveTab, update.target || {}, log);
        }

        for (const move of toMove) {
            const tabId = idByUid.get(move.uid);
            if (tabId == null) {
                continue; // not live (a resurrected pinned tab surfaces as create, not move)
            }
            await Tabs.moveNative([{id: tabId}], {index: move.target?.index}, true)
                .catch(log.onCatch(['cant move pinned tab', move.uid], false));
        }

        const removeIds = toRemove
            .map(t => idByUid.get(t.uid))
            .filter(id => id != null);

        if (removeIds.length) {
            await Tabs.remove(removeIds.map(id => ({id})), true)
                .catch(log.onCatch('cant remove pinned tabs', false));
        }
    }
}

/**
 * Query the live GLOBAL pinned tabs (across all normal windows) and hydrate each with
 * its `uid`/`lastModified` session value, backfilling a uid where missing (pinned tabs
 * don't get one from the group machinery). Mirrors `background.js` createBackup: only
 * tabs whose URL passes the syncable allow-list ({@link module:sync/delta/url-sync}
 * `isUrlSyncable`) are considered — non-trivial about: urls DO sync (rendered as the stub
 * on apply), trivial new-tab states do not. Used for both `localState.pinnedTabs` and as
 * the `uid -> live tabId` index for pinned move/remove.
 *
 * CRITICAL — GLOBAL vs GROUP-SCOPED pinned: `browser.tabs.query({pinned:true})` returns
 * BOTH truly-global pinned tabs (no STG group) AND the group-pinned tabs of whatever group
 * is currently ACTIVE (while a group is active, its group-pinned tabs are genuinely
 * browser-pinned). Only the GLOBAL ones belong to `localState.pinnedTabs` / the pinned
 * `OPS.PINNED_*` section — group-pinned tabs sync as NORMAL group tabs (+ groupPinned flag)
 * through the groups path. So we EXCLUDE any tab STG tracks in a group (`Cache.getTabGroup`),
 * exactly as the capture path discriminates (see delta-capture.js `tabAdded`). Without this
 * filter an active group's pinned tabs leak into the global pinned set, which (a) lets the
 * planner emit `pinnedToRemove` against a uid that is really a live GROUP tab — and the
 * uid→tabId index built from this set would then resolve+DELETE that real group tab; (b)
 * double-counts a uid as both a group `tab.add` and a global `pinned.add` on bootstrap →
 * duplicate pinned copies on the peer; (c) shifts globals' live pinned indices → a
 * never-converging `pinnedToMove` churn. Filtering here fixes all three at the source.
 *
 * @returns {Promise<object[]>} live GLOBAL (groupless) pinned tabs (each with id, uid, url, title, ...).
 */
async function getLivePinnedTabs() {
    // windowId=null ⇒ all normal windows; pinned=true ⇒ only pinned tabs; hidden=null ⇒ any.
    // (Tabs.get skips session hydration for pinned, so we hydrate uid/lastModified below.)
    let pinnedTabs = await Tabs.get(null, true, null).catch(() => []);

    // decode the "unsupported URL" stub page back to its embedded original (so a
    // stub-rendered about: tab keeps its original identity instead of bootstrapping the
    // moz-extension stub url), then gate on the syncable allow-list. See url-sync.js.
    return Promise.all(
        pinnedTabs
            // keep ONLY truly-global pinned tabs: drop any tab STG tracks in a group (an
            // active group's group-pinned tabs are browser-pinned but belong to the groups
            // path, not the global pinned section). See the doc comment above.
            .filter(tab => !Cache.getTabGroup(tab.id))
            .map(tab => {
                tab.url = unwrapStubUrl(tab.url);
                return tab;
            })
            .filter(tab => isUrlSyncable(tab.url))
            .map(async tab => {
                const uid = Cache.getTabUid(tab.id) || await Cache.setTabUid(tab.id).catch(() => null);
                tab.uid = uid;
                tab.lastModified = Cache.getTabLastModified(tab.id);
                return tab;
            })
    );
}

/**
 * Apply the planner's resolved option diff (`optionsToApply`, a `{key: value}` bag) to
 * this device through STG's REAL save path — background.js `saveOptions(...)` — so all
 * side effects run (it persists via `Storage.set`, refreshes `options`, re-broadcasts
 * hotkeys to content scripts, resets the backup/sync alarms, updates the temporary
 * container title). We bracket the call with {@link module:sync/delta/delta-capture.beginApply}/
 * `endApply` so the `option.set` deltas that `saveOptions` would otherwise re-capture
 * (it calls `DeltaCapture.optionsChanged`) are suppressed — no feedback loop. Nothing to
 * do when the diff is empty.
 *
 * @param {object} optionsToApply - from {@link planSync}.
 * @returns {Promise<void>}
 */
async function applyOptions(optionsToApply) {
    const keys = Object.keys(optionsToApply || {});
    if (!keys.length) {
        return;
    }

    const log = logger.start('applyOptions', {keys});

    DeltaCapture.beginApply();
    try {
        // real save path → persists + runs all side effects (alarms/hotkeys/container);
        // suppressed from re-capture by the beginApply bracket.
        await backgroundSelf.saveOptions(optionsToApply);
        log.stop();
    } catch (e) {
        log.logError('cant apply options', e);
    } finally {
        DeltaCapture.endApply();
    }
}

/**
 * Build the OUTBOUND local→portable container mapper + the registry it populates, from
 * the live local containers. The registry ({portableKey: {name,color,icon}}) is what
 * travels in the snapshot so a receiving device can find-or-create the matching container.
 *
 * Seeds from the pulled snapshot's registry so container definitions contributed by OTHER
 * devices survive into the next write even if this device has no local copy of them.
 *
 * @param {object} [pulledContainers] - the pulled snapshot's `containers` registry.
 * @returns {{registry: object, mapToPortable: (cookieStoreId: string) => string}}
 */
function buildOutboundContainerMapping(pulledContainers) {
    // real, non-temporary local containers keyed by cookieStoreId.
    const localContainers = Containers.query({temporaryContainers: false});

    const registry = {...(pulledContainers || {})};

    const mapToPortable = makeOutboundMapper(
        localContainers,
        registry,
        Containers.isDefault,
        Containers.isTemporary,
    );

    return {registry, mapToPortable};
}

/**
 * Build the INBOUND portable→local container mapper for a resolved snapshot's registry.
 * The find-or-create is the IMPURE boundary: it reuses {@link module:containers.findExistOrCreateSimilar}
 * (find a local container whose name+color+icon match, else create one), caching the
 * cookieStoreId per portable identity for the round via its own `storageMap`. The default
 * marker maps to this install's default `cookieStoreId`; the temporary marker maps to the
 * local default too (conservative: a synced reference to a temporary container has no stable
 * identity to recreate, so a stable, never-failing default is safer than spinning up a
 * throwaway temporary container on every apply).
 *
 * @param {object} [registry] - resolved snapshot's `containers` registry.
 * @returns {{mapper: (portableKey: string) => string, findOrCreateMap: Map<string,string>}}
 */
function buildInboundContainerMapper(registry) {
    // a single shared map so identical identities resolve to one created container per round.
    const findOrCreateMap = new Map();

    const findOrCreate = identity => {
        // resolving synchronously is not possible (Containers.findExistOrCreateSimilar is
        // async), so all identities are pre-resolved up-front in translateInboundContainers.
        // This mapper is only used by the synchronous mapStateContainers/mapEventContainers
        // walk AFTER the identities have been resolved into findOrCreateMap (see
        // resolveInboundContainers); an unresolved key conservatively falls back to default.
        const key = identity.name + identity.color + identity.icon;
        return findOrCreateMap.has(key) ? findOrCreateMap.get(key) : Constants.DEFAULT_COOKIE_STORE_ID;
    };

    const mapper = makeInboundMapper(
        registry || {},
        Constants.DEFAULT_COOKIE_STORE_ID,
        findOrCreate,
        () => Constants.DEFAULT_COOKIE_STORE_ID,
    );

    return {mapper, findOrCreateMap};
}

/**
 * Pre-resolve (find-or-create) a local `cookieStoreId` for every portable identity in a
 * resolved snapshot's container registry, populating `findOrCreateMap` so the synchronous
 * inbound mapper can translate without awaiting. This is the impure half: it calls
 * {@link module:containers.findExistOrCreateSimilar} per identity (which finds a name+color+icon
 * match or creates the container). Conservative: a create failure leaves the identity
 * unmapped, so the mapper falls back to the local default (never fails the sync).
 *
 * @param {object} registry - resolved snapshot's `containers` registry.
 * @param {Map<string,string>} findOrCreateMap - mutated in place ({identityKey: cookieStoreId}).
 * @param {object} log - parent logger context.
 * @returns {Promise<void>}
 */
async function resolveInboundContainers(registry, findOrCreateMap, log) {
    // Containers.findExistOrCreateSimilar(cookieStoreId, data, map) finds a local container
    // whose name+color+icon match `data`, else creates one, caching into `map` keyed by the
    // first arg. We pass a SYNTHETIC first arg (prefixed so it can never be read as a default
    // cookieStoreId by its internal `isDefault` check, nor collide with a real cookieStoreId)
    // and reuse one shared map so identical identities resolve to a single created container.
    const containerStorageMap = new Map();

    for (const [, identity] of Object.entries(registry || {})) {
        const identityKey = identity.name + identity.color + identity.icon;
        if (findOrCreateMap.has(identityKey)) {
            continue;
        }
        const syntheticId = 'sync-container:' + identityKey;
        const cookieStoreId = await Containers.findExistOrCreateSimilar(syntheticId, identity, containerStorageMap)
            .catch(log.onCatch(['cant find-or-create container', identityKey], false));
        if (cookieStoreId) {
            findOrCreateMap.set(identityKey, cookieStoreId);
        }
    }
}

/**
 * Translate every portable container key in the planner's `browserOps` + resolved option
 * diff back to a real local `cookieStoreId`, IN PLACE. The impure boundary: it first
 * find-or-creates the local containers for the resolved registry, then walks the ops with
 * the synchronous inbound mapper. Tab creates/pinned creates carry `cookieStoreId`; group
 * create/update carry the group container keys; `optionsToApply.defaultGroupProps` carries
 * them inside its value.
 *
 * @param {object} browserOps - from {@link planSync} (mutated in place).
 * @param {object} optionsToApply - from {@link planSync} (mutated in place).
 * @param {object} containerRegistry - resolved snapshot's `containers` registry.
 * @param {object} log - parent logger context.
 * @returns {Promise<void>}
 */
async function translateInboundContainers(browserOps, optionsToApply, containerRegistry, log) {
    const {mapper, findOrCreateMap} = buildInboundContainerMapper(containerRegistry);

    await resolveInboundContainers(containerRegistry, findOrCreateMap, log);

    // groups: create + update carry the group container keys.
    for (const props of browserOps.groupsToCreate || []) {
        mapEventContainers({group: props}, mapper);
    }
    for (const props of browserOps.groupsToUpdate || []) {
        mapEventContainers({group: props}, mapper);
    }

    // tabs / pinned create carry cookieStoreId directly.
    for (const tab of browserOps.tabsToCreate || []) {
        if (tab.cookieStoreId != null) {
            tab.cookieStoreId = mapper(tab.cookieStoreId);
        }
    }
    for (const tab of browserOps.pinnedToCreate || []) {
        if (tab.cookieStoreId != null) {
            tab.cookieStoreId = mapper(tab.cookieStoreId);
        }
    }

    // resolved options: only defaultGroupProps carries container keys.
    if (optionsToApply && optionsToApply.defaultGroupProps) {
        mapStateContainers({options: optionsToApply}, mapper);
    }
}

/**
 * Reorder a groups array to match the resolved group-id order. Groups whose id is in
 * `order` are placed in that order (skipping ids that aren't present locally); any
 * remaining local-only group keeps its relative order and is appended at the end so a
 * group that exists only on this device is NEVER dropped by the reorder.
 *
 * @param {object[]} groups - current local groups (post create/update/remove).
 * @param {Array<*>} order - resolved group-id order from the planner.
 * @returns {object[]} a reordered shallow copy (same group object references).
 */
function reorderGroups(groups, order) {
    const byId = new Map(groups.map(g => [g.id, g]));
    const placed = new Set();
    const result = [];

    for (const id of order) {
        const group = byId.get(id);
        if (group && !placed.has(id)) {
            result.push(group);
            placed.add(id);
        }
    }

    for (const group of groups) {
        if (!placed.has(group.id)) {
            result.push(group);
            placed.add(group.id);
        }
    }

    return result;
}

/**
 * PURE: compute the ordered live-tab-id sequence to realize a group's RESOLVED tab
 * order in the browser.
 *
 * The receiving side's create path ({@link Tabs.createMultiple}) may place created tabs
 * in the WRONG ORDER for a group — it re-sorts by ABSOLUTE window index per window and,
 * for an UNLOADED group, the created tabs land hidden in a shared pool whose absolute
 * indices don't encode the group-relative order. `Storage.set` then wipes a non-archived
 * group's stored `tabs` (it is re-derived from the live browser indices on every
 * `Groups.load`), so the only durable source of a group's order is the BROWSER INDEX of
 * its tabs. The planner's `tabsToMove` never fixes this because freshly created tabs
 * aren't "local" yet at plan time, so no move is emitted for them. We therefore reconcile
 * the live order to the resolved order explicitly, AFTER apply, by `moveNative`-ing the
 * group's tabs into the resolved sequence (works for loaded AND unloaded groups, since
 * `Groups.load` sorts by browser index either way).
 *
 * Match is by `uid` (createMultiple may reorder/drop tabs, so creation order is not
 * trustworthy — we stamp the remote uid onto each created tab and key off that). Resolved
 * uids with no live tab are skipped; live tabs whose uid is NOT in the resolved order keep
 * their relative order and are appended after the resolved ones (never dropped).
 *
 * @param {Array<*>} resolvedUidOrder - the resolved group's tab uids, in authoritative order.
 * @param {object[]} liveTabs - the group's live tabs `{id, uid}` (any order).
 * @returns {number[]} live tab ids in the order they should appear in the group, or `[]`
 *   when there is nothing to do (fewer than 2 tabs, or the live order already matches).
 */
export function orderedGroupTabIds(resolvedUidOrder, liveTabs) {
    const live = (Array.isArray(liveTabs) ? liveTabs : []).filter(t => t && t.id != null);
    if (live.length < 2) {
        return []; // 0/1 tabs ⇒ no ordering to realize
    }

    const byUid = new Map();
    for (const t of live) {
        if (t.uid != null && !byUid.has(t.uid)) {
            byUid.set(t.uid, t);
        }
    }

    const placed = new Set();
    const ordered = [];

    for (const uid of (Array.isArray(resolvedUidOrder) ? resolvedUidOrder : [])) {
        const t = byUid.get(uid);
        if (t && !placed.has(t.id)) {
            ordered.push(t);
            placed.add(t.id);
        }
    }
    // local-only tabs (uid not in resolved order) keep their current relative order, appended.
    for (const t of live) {
        if (!placed.has(t.id)) {
            ordered.push(t);
            placed.add(t.id);
        }
    }

    const orderedIds = ordered.map(t => t.id);

    // no-op if the live order already equals the desired order (avoid needless moves).
    const sameOrder = orderedIds.length === live.length
        && orderedIds.every((id, i) => id === live[i].id);

    return sameOrder ? [] : orderedIds;
}

/**
 * Build a `uid -> live tabId` index from the current cache. Used to translate the
 * planner's uid-keyed ops into real browser tab ids at apply time.
 * @returns {Promise<Map<string, number>>}
 */
async function buildLiveTabIndexByUid() {
    const {groups} = await Groups.load(null, true);
    const byUid = new Map();
    for (const group of groups) {
        if (group.isArchive || !Array.isArray(group.tabs)) {
            continue;
        }
        for (const tab of group.tabs) {
            if (tab.uid != null && tab.id != null) {
                byUid.set(tab.uid, tab.id);
            }
        }
    }
    return byUid;
}

/**
 * Build a `uid -> live group tab` index (the FULL hydrated browser tab, carrying `id`,
 * `groupId`, `discarded`, `cookieStoreId`, …) for the `tabsToUpdate` apply path, which
 * needs more than the bare id `buildLiveTabIndexByUid` returns (e.g. to avoid waking a
 * discarded tab when applying a url change). Archived groups are skipped.
 * @returns {Promise<Map<string, object>>}
 */
async function buildLiveTabRecordByUid() {
    const {groups} = await Groups.load(null, true);
    const byUid = new Map();
    for (const group of groups) {
        if (group.isArchive || !Array.isArray(group.tabs)) {
            continue;
        }
        for (const tab of group.tabs) {
            if (tab.uid != null && tab.id != null) {
                byUid.set(tab.uid, tab);
            }
        }
    }
    return byUid;
}

async function applyTabMove(liveTab, target, log) {
    const groupId = target.groupId;
    const destinationWindowId = groupId != null ? Cache.getWindowId(groupId) : null;
    const groupChanged = groupId != null && Cache.getTabGroup(liveTab.id) !== groupId;

    if (!groupChanged) {
        const moveProps = {index: target.index};
        if (Number.isFinite(destinationWindowId)) {
            moveProps.windowId = destinationWindowId;
        }
        await Tabs.moveNative([{id: liveTab.id}], moveProps, true)
            .catch(log.onCatch(['cant move tab', liveTab.id], false));
        return;
    }

    if (Number.isFinite(destinationWindowId)) {
        await Tabs.moveNative([{id: liveTab.id}], {index: target.index, windowId: destinationWindowId}, true)
            .catch(log.onCatch(['cant move tab', liveTab.id], false));
        if (liveTab.hidden) {
            await Tabs.show([{id: liveTab.id}], true)
                .catch(log.onCatch(['cant show moved tab', liveTab.id], false));
        }
    } else if (!liveTab.hidden) {
        await Tabs.hide([{id: liveTab.id}], true)
            .catch(log.onCatch(['cant hide moved tab', liveTab.id], false));
    }

    await Cache.setTabGroup(liveTab.id, groupId)
        .catch(log.onCatch(['cant set moved tab group', liveTab.id], false));
}

/**
 * Apply ONE `tabsToUpdate` entry's content changes to a live tab through the SAME
 * mechanism the create path uses (Cache session values for STG-display fields; a guarded
 * `tabs.update` only for the genuinely live-settable `url`). All session writes funnel
 * through `Cache.*` so nothing here is captured as a fresh delta (and we are already inside
 * the `beginApply` bracket regardless). Conservative throughout — a single field failing is
 * logged and never aborts the rest.
 *
 *  - `title` is NOT settable via `tabs.update` (Firefox only honors `title` on a discarded
 *    tab at CREATE time). So we update STG's cached title via {@link Cache.setTab}, which is
 *    what STG's UI / a discarded tab's display reads.
 *  - `favIconUrl` is likewise a session/cache field: {@link Cache.setTabFavIcon} (which, as
 *    on the create path, persists the favicon reference to sessions and updates the in-memory
 *    cache). The favicon refreshes from the live page on load, same as create.
 *  - `url`: settable live, but we MUST NOT force-load a discarded/unloaded tab. So for a
 *    discarded tab we update the cached url only (mirrors how STG stores an unloaded tab's
 *    url; it navigates there when the user wakes it); a loaded tab is navigated via
 *    `tabs.update` (the content genuinely changed elsewhere — same as a created tab's url).
 *  - `cookieStoreId`: changing a live tab's container requires recreating the tab (tabs.update
 *    can't move containers); doing that here risks losing tab state, so we DO NOT reopen —
 *    the cached value is refreshed and the container converges on the next create/reload.
 *  - `pinned` (group-pin): {@link Cache.setTabGroupPinned}; if the group is loaded, reflect
 *    it live via {@link Groups.applyGroupPinnedOrder} (pin) / a Groups re-settle (unpin).
 *  - `loaded`: a hint only; we never force-load (sleep-by-default UX, see tab-sleep.js).
 *
 * @param {object} liveTab - the hydrated live tab (from {@link buildLiveTabRecordByUid}).
 * @param {object} target - the changed-fields bag from the planner's `tabsToUpdate` entry.
 * @param {object} log - parent logger context.
 * @returns {Promise<void>}
 */
async function applyTabContentUpdate(liveTab, target, log) {
    const liveId = liveTab.id;

    // url/title/favicon → STG cache (display) + a guarded live navigation for url only.
    if (Object.hasOwn(target, 'url') || Object.hasOwn(target, 'title') || Object.hasOwn(target, 'favIconUrl')) {
        const nextUrl = Object.hasOwn(target, 'url') ? target.url : liveTab.url;
        const nextTitle = Object.hasOwn(target, 'title') ? target.title : liveTab.title;

        // refresh STG's cached url/title (display + identity); never wakes the tab.
        Cache.setTab({
            id: liveId,
            url: nextUrl,
            title: nextTitle,
            favIconUrl: Object.hasOwn(target, 'favIconUrl') ? target.favIconUrl : liveTab.favIconUrl,
            cookieStoreId: liveTab.cookieStoreId,
            status: liveTab.status,
        });

        if (Object.hasOwn(target, 'favIconUrl')) {
            await Cache.setTabFavIcon(liveId, target.favIconUrl)
                .catch(log.onCatch(['cant set favIcon (update)', liveId], false));
        }

        // a URL change is settable LIVE, but only navigate a LOADED tab — navigating a
        // discarded tab would force it to load (defeats sleep-by-default and can trigger
        // a redirect that re-pollutes the synced url). A discarded tab keeps the cached
        // url set above and navigates there when the user wakes it.
        //
        // NO-OP CONVERGENCE GUARD (fix for "loads infinitely"): only navigate when the live
        // tab's CURRENT url actually differs from the target. The planner can re-emit a
        // `tabsToUpdate{url}` for a tab that is ALREADY at that url (e.g. the cloud url X was
        // applied, the page server-redirected to Y, and until the cloud learns Y the planner
        // keeps diffing cloud-X vs live-Y) — re-issuing `tabs.update(url:X)` every cycle then
        // re-navigates the tab perpetually (the spinner the user sees). Comparing first makes a
        // repeat-apply a true no-op, so a stable tab incurs ZERO browser ops. We unwrap the
        // live url through the "unsupported URL" stub so a stub-rendered about: tab compares by
        // its embedded original identity (which is what `target.url` carries) and is not
        // needlessly re-navigated. The redirect case itself converges via the narrowed echo
        // guard (the redirect target is now captured + pushed, so the cloud learns Y).
        if (Object.hasOwn(target, 'url') && liveTab.discarded !== true
            && shouldNavigateLiveTabUrl(liveTab.url, target.url)) {
            await browser.tabs.update(liveId, {url: target.url})
                .catch(log.onCatch(['cant update tab url', liveId], false));
        }
    }

    // group-pin flag (the per-group pin, NOT global pinned). Delegate to the canonical
    // toggle: it persists the cache flag AND — when the group is loaded — pins (placing the
    // tab at the front of the group's pinned block) or unpins+re-settles it live, the exact
    // same path the user's toggle uses. Its internal pin/unpin uses Tabs.skipTracking and the
    // delta it would emit is suppressed by the surrounding beginApply() bracket, so this does
    // not re-capture. When the group is NOT loaded it just sets the flag. We compare against
    // the current cache value to avoid a redundant toggle (idempotent re-apply).
    if (Object.hasOwn(target, 'pinned') && Cache.getTabGroupPinned(liveId) !== (target.pinned === true)) {
        await Groups.setTabGroupPinned(liveId, target.pinned === true)
            .catch(log.onCatch(['cant set group-pin (update)', liveId], false));
    }

    // `cookieStoreId`/`loaded`: intentionally NOT applied to the live tab (see fn docs).
}

/**
 * The delta-era replacement for `cloud.js` `synchronization()`. Mirrors its
 * scaffolding: the same `send('sync-*')` broadcast (imported from cloud.js so the UI
 * / background progress wiring is identical) and the same `CloudError` wrapping. It
 * carries its OWN `inProgress` guard (the legacy `synchronization()` guard belongs to
 * a path we no longer call) so a second trigger while a delta sync runs is a no-op.
 *
 * @returns {Promise<object>} syncResult ({ok, progress, ...}).
 */
let inProgress = false;

// How soon (in minutes) to reschedule a sync cycle that DEFERRED because the user was
// mutating groups/tabs at apply time. Short — the work (pull/plan) was already done and is
// cheap to repeat; we just want to retry once the user's burst settles. Reuses the existing
// `cloud-retry` alarm (background.js `onAlarm` → cloudSync TRIGGER_RETRY) so no new wiring.
const USER_DEFER_RESCHEDULE_MINUTES = 0.2; // ~12s

// How soon (in minutes) to reschedule a sync cycle that could NOT acquire the advisory lock
// because a peer holds it. Short (~30s per the design): the peer's cycle finishes well under
// the lock TTL, so we just want to retry shortly after it releases. Reuses the existing
// `cloud-retry` alarm, exactly like the user-defer reschedule above (no new scheduler).
const LOCK_CONTENDED_RESCHEDULE_MINUTES = 0.5; // ~30s

/**
 * Reschedule a soon sync after a user-active DEFER, reusing the existing retry alarm. Best
 * effort: a failure to (re)create the alarm only delays the next sync to the regular
 * periodic alarm — never an error. Not awaited on the hot path's correctness.
 * @param {object} log - parent logger context.
 */
async function rescheduleSoonAfterDefer(log) {
    try {
        await browser.alarms.create(ALARM_NAME_RETRY, {
            delayInMinutes: USER_DEFER_RESCHEDULE_MINUTES,
        });
    } catch (e) {
        log.warn('cant reschedule deferred sync; will run on next periodic alarm', String(e));
    }
}

/**
 * Reschedule a soon sync after we could NOT acquire the advisory lock (a peer holds it),
 * reusing the same `cloud-retry` alarm. Best effort — a failure only delays the next sync to
 * the regular periodic alarm.
 * @param {object} log - parent logger context.
 */
async function rescheduleSoonAfterLockContention(log) {
    try {
        await browser.alarms.create(ALARM_NAME_RETRY, {
            delayInMinutes: LOCK_CONTENDED_RESCHEDULE_MINUTES,
        });
    } catch (e) {
        log.warn('cant reschedule lock-contended sync; will run on next periodic alarm', String(e));
    }
}

/**
 * Reset THIS device's local delta-sync state so the next sync behaves like a first
 * sync. A recovery action for a bad/inconsistent local state that lets a user (or
 * tester) recover WITHOUT making a fresh Firefox profile.
 *
 * Clears, for `selfDeviceId = getDeviceId()`:
 *   - the durable baseline (`deltaBaseline:<id>`) — so removals are re-gated from an
 *     EMPTY baseline, which authorizes NO removals (a delete propagates only once an
 *     item is reconciled as synced again). This is the data-loss-safe default.
 *   - the last-pushed-seq mark (`deltaLastPushedSeq:<id>`) — so the local log is
 *     considered fully un-pushed and gets re-uploaded.
 *   - the base watermark (`deltaBaseWatermark:<id>`).
 *   - the local event log (`DeltaLog.clear()`) — events + seq reset.
 *
 * The deviceId itself is PRESERVED (kept in the same store but under a different key).
 * Cloud is untouched: the gist/snapshot/delta files are not modified or deleted here
 * (delete those manually on GitHub if a full reset is wanted). After reset, the next
 * sync re-establishes the baseline from the resolved snapshot and bootstrap-uploads
 * the current local groups/tabs.
 *
 * E2 — RESET vs CLOUD-WATERMARK TRAP. Clearing local lastSeq (via DeltaLog.clear) means
 * the next appends re-issue seq 1..N, but the AUTHORITATIVE `watermark[self]=N` lives in
 * the CLOUD snapshot, which reset cannot touch. replay() dedups every event with
 * `seq <= watermark[self]` (replay.js rule 4), so without intervention every re-issued
 * event would be SILENTLY SKIPPED until seq organically climbs past N — losing the
 * post-reset local changes. We fix this with the LEAST-SURPRISING, data-preserving option
 * (keeping the deviceId stable, as documented above, rather than minting a new one and
 * orphaning the cloud delta file): set a durable per-device "reset pending" flag here, and
 * on the NEXT sync force a full pull (the conditional fast path can't see the cloud
 * watermark) so the flow can fast-forward this device's log strictly above the stale cloud
 * watermark[self] BEFORE pushing (see DeltaLog.fastForwardSeqsAbove + the deltaSynchronization
 * full path). The fast-forward never lowers a seq and is a no-op on the normal path, so the
 * non-reset flow is unaffected, with no double-apply and no data loss.
 *
 * Refuses while a sync is in progress so it can't race the live pipeline.
 * @returns {Promise<{ok: boolean, inProgress?: boolean}>}
 */
export async function resetSyncState() {
    if (inProgress) {
        return {ok: false, inProgress: true};
    }

    const log = logger.start(resetSyncState);

    const selfDeviceId = getDeviceId();

    delete storage[baselineKey(selfDeviceId)];
    delete storage[lastPushedSeqKey(selfDeviceId)];
    delete storage[watermarkKey(selfDeviceId)];
    // a hard reset clears the whole local log, so any deferred-truncation marker (a seq into
    // that log) is moot — drop it so a stale seq can't trim the post-reset re-issued log.
    delete storage[pendingTruncateKey(selfDeviceId)];

    await DeltaLog.clear();

    // arm the E2 reconciliation for the next sync (see the doc-comment above and the
    // RESET_PENDING_PREFIX flag handling in deltaSynchronization).
    storage[resetPendingKey(selfDeviceId)] = '1';

    log.stop('reset local delta-sync state (cloud untouched)', {selfDeviceId});

    return {ok: true};
}

export function extractArchiveTransition(currentIsArchive, props) {
    if (!props || !Object.hasOwn(props, 'isArchive')) {
        return {props, archiveTransition: null};
    }

    const {isArchive, ...plainProps} = props;

    if (Boolean(isArchive) === Boolean(currentIsArchive)) {
        return {props, archiveTransition: null};
    }

    return {props: plainProps, archiveTransition: Boolean(isArchive)};
}

/**
 * SINGLE SOURCE OF TRUTH (D-3) for "what kind of change does this plan carry?".
 *
 * The "is there any browser op" question was previously open-coded in THREE places
 * with subtly DIFFERENT op subsets — the pre-apply backup gate, the menu-rebuild gate,
 * and the `syncResult.changes.local` flag. That drift is exactly what caused B1/B2:
 * two of those sites OMITTED `tabsToUpdate` / `pinnedToUpdate` (the only ops that
 * overwrite an existing live tab's url/title/favicon/group-pin), so a content-only sync
 * mutated the browser yet (B1) took NO pre-apply safety backup and (B2) reported
 * `changes.local = false` so the UI never refreshed.
 *
 * Every caller now derives its boolean from THIS pure helper so they can never diverge
 * again. The granular booleans returned:
 *   - `anyBrowserOp` — any live browser mutation: group/tab/pinned create/move/remove/
 *     update/reorder, INCLUDING the previously-omitted tabsToUpdate / pinnedToUpdate.
 *   - `anyOption` — at least one resolved global option to apply.
 *   - `groupsChanged` — only the group-set ops (create/update/remove/reorder); used by
 *     the per-group menu rebuild, which cares ONLY about the group set, not tabs.
 *   - `mutatesBrowser` — `anyBrowserOp || anyOption`: the predicate the pre-apply backup
 *     and `changes.local` consume.
 *
 * Pure (no browser deref); exported for unit testing.
 *
 * @param {object} [browserOps] - `plan.browserOps`.
 * @param {object} [optionsToApply] - `plan.optionsToApply`.
 * @returns {{anyBrowserOp: boolean, anyOption: boolean, groupsChanged: boolean, mutatesBrowser: boolean}}
 */
export function summarizeOps(browserOps, optionsToApply) {
    const ops = browserOps || {};
    const len = arr => (Array.isArray(arr) ? arr.length : 0);

    const groupsChanged = !!(
        len(ops.groupsToCreate) || len(ops.groupsToUpdate)
        || len(ops.groupsToRemove) || ops.groupsOrder
    );

    const anyBrowserOp = !!(
        groupsChanged
        || len(ops.tabsToCreate) || len(ops.tabsToMove) || len(ops.tabsToRemove) || len(ops.tabsToUpdate)
        || len(ops.pinnedToCreate) || len(ops.pinnedToMove) || len(ops.pinnedToRemove) || len(ops.pinnedToUpdate)
    );

    const anyOption = Object.keys(optionsToApply || {}).length > 0;

    return {
        anyBrowserOp,
        anyOption,
        groupsChanged,
        mutatesBrowser: anyBrowserOp || anyOption,
    };
}

/**
 * Does this plan actually MUTATE the live browser? True iff any browser op is a
 * create/move/remove/update/reorder OR there is at least one resolved option to apply.
 * An idle/no-op sync (the common 5-min alarm case) returns false, so we never take a
 * backup for it. Thin wrapper over {@link summarizeOps} — same source of truth as the
 * `syncResult.changes.local` predicate and the menu-rebuild gate below.
 * @param {object} plan - from {@link planSync}.
 * @returns {boolean}
 */
function planMutatesBrowser(plan) {
    return summarizeOps(plan.browserOps, plan.optionsToApply).mutatesBrowser;
}

/**
 * SAFETY NET (Feature 1): take a full local STG backup BEFORE delta-sync applies any
 * browser-mutating change, so a bad sync can be rolled back via STG's normal restore.
 *
 * Reuses STG's existing backup serializer end-to-end — `background.js` `createBackup`
 * (the exact code path the auto-backup alarm and the manual "create backup" button
 * use) — invoked here with a rolling override path so it writes a BOUNDED round-robin
 * set ({@link PRE_APPLY_BACKUP_SLOTS} slots) instead of growing unbounded. It runs in
 * the background page (no DOM / no user gesture needed) and honors the user's
 * configured backup location (downloads vs native host).
 *
 * Gated by the LOCAL-ONLY `syncBackupBeforeApply` option (default ON). Only fires when
 * the plan actually mutates the browser (see {@link planMutatesBrowser}) so idle syncs
 * don't spam backups. AWAITS completion before returning; the caller ABORTS the apply
 * if this throws (a safety net that doesn't catch is worse than none).
 *
 * @param {object} plan - from {@link planSync}.
 * @param {object} log - parent logger context.
 * @returns {Promise<void>}
 * @throws if the backup itself fails (so the caller can abort before mutating).
 */
async function maybeBackupBeforeApply(plan, log) {
    if (!planMutatesBrowser(plan)) {
        return; // no-op sync ⇒ nothing to back up
    }

    const {syncBackupBeforeApply, syncBackupFilePath, syncBackupLocation} = await Storage.get([
        'syncBackupBeforeApply',
        'syncBackupFilePath',
        'syncBackupLocation',
    ]);
    if (!syncBackupBeforeApply) {
        return; // user opted out
    }

    // round-robin slot so the on-disk set is bounded to PRE_APPLY_BACKUP_SLOTS files.
    const prevSlot = Number(storage[PRE_APPLY_BACKUP_SLOT_KEY]);
    const slot = Number.isInteger(prevSlot) && prevSlot >= 0 ? prevSlot % PRE_APPLY_BACKUP_SLOTS : 0;

    log.info('pre-apply safety backup', {slot});

    // createBackup(includeTabFavIcons, includeTabThumbnails, isAutoBackup, filePathOverride, locationOverride).
    // isAutoBackup=false ⇒ never skipped on empty groups and no autoBackup side effects;
    // filePathOverride ⇒ non-interactive write to the configured sync-backup path;
    // locationOverride ⇒ downloads vs native host per syncBackupLocation.
    // Throws on failure → propagates to the caller, which aborts the apply.
    await backgroundSelf.createBackup(true, false, false, preApplyBackupFilePath(syncBackupFilePath, slot), syncBackupLocation);

    // advance the slot ONLY after a successful write, so a failed backup re-uses the
    // same slot next time rather than silently skipping ahead.
    storage[PRE_APPLY_BACKUP_SLOT_KEY] = (slot + 1) % PRE_APPLY_BACKUP_SLOTS;
}

/**
 * Gather THIS device's local sync inputs and run the BOOTSTRAP step — everything that is
 * derivable WITHOUT pulling the cloud. Extracted so the conditional fast path (remote
 * unchanged) can decide "do we have local pending to push?" without a download, while the
 * full path reuses the exact same local state for the planner.
 *
 * Side effect: appends synthetic bootstrap events to the local delta log (idempotent; see
 * {@link computeBootstrapEvents}). After it runs, `localPendingEvents` includes any such
 * synthetic adds, so a never-synced local item is pushed even on the unchanged-remote path.
 *
 * @param {string} selfDeviceId
 * @param {object} log - parent logger context.
 * @returns {Promise<{localState: object, priorBaseline: object, localPendingEvents: object[], lastPushedSeq: number}>}
 */
async function gatherLocalPending(selfDeviceId, log) {
    // this device's last-synced baseline (gates removals). Empty on first run.
    const priorBaseline = loadBaseline(selfDeviceId);

    // live local state in snapshot shape, incl. this device's current values for the
    // SYNCED option keys (per-device keys filtered out by syncedOptionKeys).
    // includeFavIconUrl=true ⇒ each grouped tab carries its CURRENT favicon (live, or the
    // session-stored one for a sleeping/discarded tab). This is what makes the sync CONVERGE
    // the favicon: the planner diffs this live favicon against the resolved snapshot's folded
    // value and emits an update when they differ — so the stored favicon always snaps to the
    // tab's current value, even if the favicon-emit throttle dropped intermediate changes.
    const {groups: loadedGroups} = await Groups.load(null, true, true);
    const syncedKeys = syncedOptionKeys(Constants.ALL_OPTION_KEYS);
    const allLocalOptions = await Storage.get(syncedKeys);
    const localSyncedOptions = {};
    for (const key of syncedKeys) {
        localSyncedOptions[key] = allLocalOptions[key];
    }
    const livePinnedTabs = await getLivePinnedTabs();
    const localState = buildLocalState(loadedGroups, localSyncedOptions, livePinnedTabs);

    // BOOTSTRAP: emit synthetic add events for local groups/tabs this device never
    // reconciled as synced AND that its local delta log doesn't already reference — so they
    // get uploaded instead of lingering local-only. Idempotent (skipped if in baseline OR
    // already in the log), so re-runs never double-add.
    const localLogEvents = await DeltaLog.getEvents();
    const logUids = new Set();
    const logGroupIds = new Set();
    const logOptionKeys = new Set();
    for (const event of localLogEvents) {
        if (event.groupId != null) {
            logGroupIds.add(event.groupId);
        }
        if (event.group?.id != null) {
            logGroupIds.add(event.group.id);
        }
        if (event.uid != null) {
            logUids.add(event.uid);
        }
        if (event.tab?.uid != null) {
            logUids.add(event.tab.uid);
        }
        if (event.op === DeltaLog.OPS.OPTION_SET && event.key != null) {
            logOptionKeys.add(event.key);
        }
    }

    const bootstrapEvents = computeBootstrapEvents(localState, priorBaseline, logUids, logGroupIds, logOptionKeys);
    await DeltaLog.appendMany(bootstrapEvents);
    if (bootstrapEvents.length) {
        log.info('bootstrap-uploaded never-synced local items', {count: bootstrapEvents.length});
    }

    // RE-READ pending AFTER bootstrap appends so the synthetic adds (with their
    // now-assigned seqs) are included in this round's push.
    const lastPushedSeq = Number(storage[lastPushedSeqKey(selfDeviceId)]) || 0;
    const localPendingEvents = await DeltaLog.getEventsSince(lastPushedSeq);

    return {localState, priorBaseline, localPendingEvents, lastPushedSeq};
}

/**
 * CONDITIONAL FAST PATH: the remote gist was confirmed UNCHANGED since our last pull, so
 * there is nothing new to download/replay/apply. We still must PUSH if THIS device has
 * pending local events (a local change must propagate even when the remote is unchanged).
 *
 * Because the remote is unchanged, the cloud's copy of THIS device's delta file equals what
 * we last pushed; the correct new self delta file is therefore simply our ENTIRE local log
 * (= cloud-self + pending), container-mapped to portable — identical to what the full
 * planner would emit for the self file (see plan-sync `buildFullLogs`/`deltaFileToWrite`).
 * We write ONLY that delta file: the snapshot is already present + valid in the unchanged
 * gist (it is re-consolidated by the next full-fetch cycle on this or another device).
 *
 * We DO NOT advance the watermark/baseline here — those record a fully-reconciled state, and
 * this path deliberately skips plan/apply. Leaving them untouched (like the user-defer path)
 * means the next full cycle reconciles them; correctness is never weakened, only deferred.
 *
 * @param {object} Cloud - provider instance.
 * @param {string} selfDeviceId
 * @param {object[]} localPendingEvents - this device's pending events (post-bootstrap).
 * @param {number} lastPushedSeq
 * @param {object} pulledContainers - currently null on this path; outbound mapping seeds an
 *   empty registry (the pending events carry their own local cookieStoreIds to translate).
 * @param {object} log - parent logger context.
 * @returns {Promise<{pushed: boolean}>}
 */
async function pushLocalPendingOnly(Cloud, selfDeviceId, localPendingEvents, lastPushedSeq, log) {
    if (!localPendingEvents.length) {
        return {pushed: false}; // remote unchanged AND nothing local to push ⇒ true no-op
    }

    // The full self delta file = the entire local log (cloud-self == last-pushed under the
    // unchanged precondition, so cloud-self + pending == all local events). Map outbound
    // container ids to portable keys exactly as the full path does for the self file.
    // DeltaLog.getEvents() returns deep clones, so the in-place mapping below can never
    // write portable keys back into the live local log.
    const {mapToPortable} = buildOutboundContainerMapping(null);
    const allEvents = await DeltaLog.getEvents();
    for (const event of allEvents) {
        mapEventContainers(event, mapToPortable);
    }

    await Cloud.writeFiles({
        [deltaFileName(selfDeviceId)]: {
            v: DeltaLog.SCHEMA_VERSION,
            deviceId: selfDeviceId,
            events: allEvents,
        },
    });

    // advance lastPushedSeq to the highest pending seq so we don't re-push next cycle.
    const maxSelfSeq = localPendingEvents.reduce(
        (max, e) => (e.seq > max ? e.seq : max),
        lastPushedSeq,
    );
    storage[lastPushedSeqKey(selfDeviceId)] = maxSelfSeq;

    // refresh the stored ETag from the post-push gist so the NEXT probe compares against
    // the revision we just created (otherwise our own push reads back as "changed").
    await Cloud.refreshEtagFromWrite?.();

    log.info('conditional fast path: pushed local pending without pull/apply', {
        events: localPendingEvents.length,
    });

    return {pushed: true};
}

export async function deltaSynchronization() {
    const syncResult = {ok: false};

    if (inProgress) {
        syncResult.inProgress = true;
        return syncResult;
    }

    const log = logger.start(deltaSynchronization);
    let lastProgress = 0;

    const progress = percent => {
        lastProgress = percent;
        send('sync-progress', {progress: percent});
    };

    // Advisory-lock state, hoisted so the `finally` can release whatever we acquired no
    // matter which path (success / error / apply-watchdog) we exit through. `Cloud` is set
    // inside the try (provider creation can throw), so the finally guards both.
    let Cloud = null;
    let lockAcquired = false;

    try {
        inProgress = true;
        send('sync-start');
        progress(1);

        const {syncOptionsLocation, syncProvider} = await Storage.get(['syncOptionsLocation', 'syncProvider']);

        // Read sync options from the same store as the legacy path: Firefox Sync
        // storage when configured, otherwise local storage. Without this the token
        // (saved in FF Sync by default on Firefox) reads back empty → githubInvalidToken.
        if (syncOptionsLocation === Constants.SYNC_STORAGE_FSYNC && !SyncStorage.IS_AVAILABLE) {
            const error = new CloudError('ffSyncNotSupported');
            storage.lastError = String(error);
            log.throwError('sync not supported', error);
        }

        const syncOptions = syncOptionsLocation === Constants.SYNC_STORAGE_FSYNC
            ? await SyncStorage.get()
            : await Storage.get(null, Constants.DEFAULT_SYNC_OPTIONS);

        try {
            Cloud = createCloudProvider(syncProvider, syncOptions);
        } catch (error) {
            const cloudError = new CloudError(error.message, {cause: error});
            storage.lastError = String(cloudError);
            log.throwError('create cloud provider instance', cloudError);
        }

        const selfDeviceId = getDeviceId();

        progress(10);

        // 0. LOCAL INPUTS + BOOTSTRAP (no network): build this device's local state and run
        // the bootstrap step. Needed by BOTH the conditional fast path (to know if there is
        // local pending to push) and the full path (planner inputs). See gatherLocalPending.
        const {localState, priorBaseline, lastPushedSeq} =
            await gatherLocalPending(selfDeviceId, log);
        // re-read into a mutable binding: the E2 reset reconciliation below may rewrite the
        // pending events' seqs after the pull, and container mapping mutates them in place.
        let localPendingEvents = await DeltaLog.getEventsSince(lastPushedSeq);

        // E2: did a local resetSyncState arm the watermark-trap reconciliation? When set, the
        // conditional fast path is BYPASSED (it can't read the cloud watermark) so we take the
        // full pull and fast-forward this device's log above the stale cloud watermark[self].
        const resetPending = !!storage[resetPendingKey(selfDeviceId)];

        // 0b. CONDITIONAL FAST PATH: ask the provider whether the remote changed since our
        // last pull (HTTP ETag / If-None-Match). FAIL-SAFE: `isUnchangedSince` returns true
        // ONLY on a positive "unchanged" confirmation (no stored marker / first sync /
        // discovery / any transport error all return false ⇒ full fetch below). When it is
        // unchanged we SKIP the download + replay/plan/apply entirely, but STILL push this
        // device's pending local events so a local change propagates. The provider may not
        // implement the probe at all (optional contract) ⇒ treated as "changed" (full fetch).
        // SKIPPED while a reset is pending (resetPending), see E2 above.
        const remoteUnchanged = !resetPending
            && (Cloud.isUnchangedSince ? await Cloud.isUnchangedSince() : false);
        if (remoteUnchanged) {
            const {pushed} = await pushLocalPendingOnly(
                Cloud, selfDeviceId, localPendingEvents, lastPushedSeq, log,
            );

            progress(100);
            syncResult.ok = true;
            syncResult.progress = 100;
            syncResult.skippedPull = true;
            // local = applied nothing this cycle (pull/apply skipped); cloud = pushed iff we
            // had pending local events to propagate.
            syncResult.changes = {local: false, cloud: pushed};

            send('sync-end', syncResult);
            log.stop('remote unchanged: skipped pull/apply', {pushedLocalPending: pushed});
            return syncResult;
        }

        // 0c. ADVISORY LOCK. Serialize the snapshot-writing full cycle across devices so two
        // don't write the snapshot concurrently and clobber it (GitHub has no atomic CAS). It
        // is ADVISORY/best-effort — a crashed holder is reclaimed via the server-clock TTL, and
        // deferred self-truncation (compaction.js) is the real data-safety backstop. Acquired
        // BEFORE the pull so the whole pull→apply→push runs under it; ALWAYS released in the
        // `finally`. If a peer holds it, skip THIS cycle cleanly and retry in ~30s (reusing the
        // existing retry alarm — NOT an error). The provider may not implement the lock at all
        // (optional contract) ⇒ we proceed unserialized, relying on the deferred-truncation
        // backstop. The conditional fast path above is exempt: it writes only this device's
        // per-device delta file (never the snapshot), which never clobbers a peer.
        if (Cloud.acquireLock) {
            lockAcquired = await Cloud.acquireLock(selfDeviceId);
            if (!lockAcquired) {
                log.info('advisory lock held by a peer; skipping this cycle, retry soon');
                await rescheduleSoonAfterLockContention(log);

                progress(100);
                syncResult.ok = true;
                syncResult.progress = 100;
                syncResult.lockContended = true;
                syncResult.changes = {local: false, cloud: false};

                send('sync-end', syncResult);
                log.stop('advisory lock contended: skipped cycle');
                return syncResult;
            }
        }

        // 1. pull base snapshot (empty default on a brand-new gist) and all device delta logs
        const {snapshot: pulledSnapshot, snapshotExists} = await resolveBaseSnapshot(Cloud);
        progress(30);
        const pulledDeltaLogs = await resolvePulledDeltaLogs(Cloud);
        progress(45);

        // 1a. E2 RESET/WATERMARK-TRAP RECONCILIATION. If a local reset rewound our lastSeq
        // (so our re-issued events now sit at seq 1..K) while the CLOUD still carries our prior
        // history, replay would (a) dedup-skip every re-issued event with seq <= the cloud
        // watermark[self]=N (replay.js rule 4) and (b) COLLIDE with the events still present in
        // our cloud delta file (which plan-sync merges by seq). Now that we have both from the
        // pull, fast-forward THIS device's log so every event sits strictly above the MAX of the
        // stale cloud watermark AND the highest seq remaining in our cloud delta file — clearing
        // both hazards — then RE-READ pending (their seqs may have shifted). No-op when the device
        // already leads that floor (the normal, non-reset path is gated out entirely). Clear the
        // flag AFTER the attempt so a crash before this point retries the reconciliation.
        if (resetPending) {
            const cloudSelfWatermark = Number(pulledSnapshot?.watermark?.[selfDeviceId]) || 0;
            const pulledSelfLog = (pulledDeltaLogs || []).find(dl => dl.deviceId === selfDeviceId);
            const highestCloudSelfSeq = (pulledSelfLog?.events || []).reduce(
                (max, e) => (Number(e.seq) > max ? Number(e.seq) : max), 0,
            );
            const floor = Math.max(cloudSelfWatermark, highestCloudSelfSeq);
            const shifted = await DeltaLog.fastForwardSeqsAbove(floor);
            if (shifted) {
                localPendingEvents = await DeltaLog.getEventsSince(lastPushedSeq);
                log.info('E2: fast-forwarded local log above stale cloud watermark/delta after reset', {
                    cloudSelfWatermark,
                    highestCloudSelfSeq,
                    floor,
                    pendingEvents: localPendingEvents.length,
                });
            }
            delete storage[resetPendingKey(selfDeviceId)];
        }

        // 1a-bis. DEFERRED SELF-TRUNCATION reconciliation (Part C — the data-loss backstop).
        // A prior compaction cycle on this device recorded a pending marker = the self
        // watermark seq it folded into the snapshot it wrote, but did NOT truncate (a peer
        // could clobber that snapshot before its durability is confirmed; the snapshot is the
        // ONLY home of folded history). Now that we have the PULLED snapshot, confirm: if its
        // watermark[self] >= the pending seq, our snapshot survived (or a later one supersedes
        // it) and the folded events are durably in the cloud base — it is safe to truncate up
        // to that seq (clearUpTo locally below + drop seq <= it from the cloud self-delta in the
        // push) and clear the marker. If the snapshot was CLOBBERED (watermark below the
        // marker), the events still live in the cloud self-delta (we deferred), so they get
        // re-folded — we keep the marker (do NOT truncate). See compaction.resolveDeferredTruncation.
        const pendingTruncateSeq = Number(storage[pendingTruncateKey(selfDeviceId)]) || 0;
        const {confirmed: deferredTruncateConfirmed, truncateSeq: confirmedTruncateSeq} =
            resolveDeferredTruncation(pendingTruncateSeq, pulledSnapshot?.watermark, selfDeviceId);

        // 1b. COMPACTION decision (PURE): how many events are UNFOLDED — beyond the pulled
        // snapshot's BASE watermark (the exact predicate replay uses to fold) — across ALL
        // pulled device logs. Over the threshold ⇒ this cycle compacts: it persists the
        // resolved snapshot as the new base (advancing each device's watermark to the highest
        // folded seq) and truncates THIS device's own log. Non-blocking w.r.t. lagging/lost
        // devices: we count + fold only this device's pulled view and never wait for any device
        // to catch up; a behind device later pulls the new base (folded effect present) + its
        // remaining unfolded deltas, losing nothing (see compaction.js). Evaluated on the
        // PULLED (pre-replay) watermark so the count matches what replay will actually fold.
        const {shouldCompact, unfoldedCount} = evaluateCompaction(
            pulledDeltaLogs, pulledSnapshot?.watermark,
        );

        // 2. CONTAINER BOUNDARY (outbound): translate every LOCAL `cookieStoreId` in this
        // device's inputs to a PORTABLE key (a container's name+color+icon identity, or a
        // default/temporary marker), and collect a registry of {portableKey: {name,color,icon}}
        // that travels in the snapshot so a receiving device can find-or-create the matching
        // container. We translate (a) `localState` (its group/tab/pinned/defaultGroupProps
        // fields) and (b) this device's `localPendingEvents` — both currently hold raw local
        // cookieStoreIds (buildLocalState reads live tabs; capture logs the local id). The
        // pulled snapshot + other devices' delta logs are ALREADY portable (prior delta
        // syncs wrote them so). Pending events are mutated in place here so the SAME portable
        // records flow into both `planSync` (replay) and `deltaFileToWrite` (the push). The
        // registry is seeded from the pulled snapshot's registry so other devices' container
        // defs survive into this device's next write. From here the pure engine (replay /
        // plan-sync) sees only portable keys (see container-map.js).
        const {registry: containerRegistry, mapToPortable} = buildOutboundContainerMapping(pulledSnapshot.containers);
        mapStateContainers(localState, mapToPortable);
        for (const event of localPendingEvents) {
            mapEventContainers(event, mapToPortable);
        }

        progress(50);

        // 6. PURE plan (priorBaseline gates removals)
        const plan = planSync({
            pulledSnapshot,
            pulledDeltaLogs,
            localPendingEvents,
            selfDeviceId,
            localState,
            priorBaseline,
        });

        // The resolved snapshot carries the merged container registry (pulled + this
        // device's local defs) so it is written back as the portable definition source
        // for every device. replay() carries the pulled registry through; we fold in any
        // new local containers collected during the outbound translation above.
        plan.resolvedSnapshot.containers = {...plan.resolvedSnapshot.containers, ...containerRegistry};

        // SAFETY: never wipe everything from an empty cloud. If the resolved state has
        // no groups but the user DOES have local groups (e.g. a brand-new install/empty
        // gist, or a cloud that hasn't received this device's deltas yet), suppress the
        // destructive removal ops for this round. The local groups/tabs are still
        // captured locally and will be pushed; the next round reconciles non-destructively.
        const resolvedEmpty = (plan.resolvedSnapshot.groups || []).length === 0
            && (plan.resolvedSnapshot.pinnedTabs || []).length === 0;
        const localHasState = (localState.groups || []).length > 0
            || (localState.pinnedTabs || []).length > 0;
        if (resolvedEmpty && localHasState) {
            log.warn('resolved state empty but local has groups/pinned - suppressing removals this round');
            plan.browserOps.groupsToRemove = [];
            plan.browserOps.tabsToRemove = [];
            plan.browserOps.pinnedToRemove = [];
        }

        log.info('plan', {
            ops: {
                groupsToCreate: plan.browserOps.groupsToCreate.length,
                groupsToUpdate: plan.browserOps.groupsToUpdate.length,
                groupsToRemove: plan.browserOps.groupsToRemove.length,
                tabsToCreate: plan.browserOps.tabsToCreate.length,
                tabsToMove: plan.browserOps.tabsToMove.length,
                tabsToRemove: plan.browserOps.tabsToRemove.length,
                pinnedToCreate: plan.browserOps.pinnedToCreate.length,
                pinnedToMove: plan.browserOps.pinnedToMove.length,
                pinnedToRemove: plan.browserOps.pinnedToRemove.length,
            },
            willPush: !!plan.deltaFileToWrite,
        });

        progress(55);

        // 6b. CONTAINER BOUNDARY (inbound): translate every PORTABLE container key in the
        // ops we are about to apply back to a real local `cookieStoreId`, find-or-creating
        // the matching local container (name+color+icon) when absent. The resolved snapshot's
        // `containers` registry is the portable→identity source. Markers map to local
        // default/temporary. After this, browserOps/optionsToApply hold local ids the apply
        // path can use directly (see translateInboundContainers).
        await translateInboundContainers(plan.browserOps, plan.optionsToApply, plan.resolvedSnapshot.containers, log);

        // 6c. SAFETY NET: before mutating the live browser, take a full local STG backup
        // (gated by the LOCAL-ONLY `syncBackupBeforeApply` option, default ON) so a bad
        // sync is fully rollback-able. Fires only when the plan actually mutates the
        // browser, AWAITS completion, and THROWS on failure — which jumps to catch and
        // aborts the apply, so we never mutate without a safety net in place.
        await maybeBackupBeforeApply(plan, log);

        // 7. APPLY to the live browser, under the USER-PRIORITY LOCK so it can't interleave
        // with a concurrent user group/tab mutation (lost-update race: both do load→modify→
        // save against the blind `Groups.save`). The lock is held ONLY around this short
        // local apply — NEVER around the network pull (steps 1-2) or push (step 8).
        //
        // YIELD POLICY: if the user is mutating right now (or in the short trailing window),
        // `runSyncApply` DEFERS — it does NOT apply this cycle. We then skip the push too
        // (nothing was applied; watermark/baseline are left untouched so no state is recorded)
        // and reschedule a sync soon via the existing retry alarm. Deferring one periodic
        // cycle is cheap; the user never waits on us. A safety timeout inside `runSyncApply`
        // makes us defer rather than block forever if a user mutation is mid-flight.
        // reset the phase marker so the watchdog (below) can only ever report a phase from
        // THIS apply, never a stale one from a prior cycle.
        currentApplyPhase = null;
        const applyStartedAt = Date.now();
        const applyOutcome = await runSyncApply(async () => {
            // 7a. live browser ops (groups save/reorder/order + tabs create/move/remove +
            // pinned ops). Skip-flagged so it's not re-captured. Pass the resolved snapshot so
            // the apply reconciles each group's live tab order to the authoritative order.
            await applyBrowserOps(plan.browserOps, plan.resolvedSnapshot);

            // 7b. resolved global option changes via STG's real save path (so alarms/hotkeys/
            // container side effects run), suppressed from re-capture.
            const endOptions = beginApplyPhase('apply-options', log);
            await applyOptions(plan.optionsToApply);
            endOptions();

            // 7c. REBUILD per-group context menus. The apply step persists group create/remove/
            // reorder via `Groups.save`, which deliberately bypasses the `sendAdded/sendUpdated/
            // sendRemoved` helpers (so capture isn't re-triggered) — but those helpers are also
            // what drive the `MenusMain.group*` calls that create/remove the per-group menu items
            // (`tab-<groupId>` etc. in menus-tab/link/bookmark). So a synced group exists in data
            // but has NO menu item, and the next `Menus.update(groupId)` (e.g. from `Groups.apply`
            // → `MenusMain.groupLoaded`) used to throw "doesn't exist" and abort the apply mid-way
            // (dropping the group's tabs). We rebuild the full per-group menu set here (the same
            // remove+recreate `MenusMain.groupsUpdated` does for `Groups.move`/`sort`), but ONLY
            // when this round actually changed the local group set, so an idle sync is a no-op.
            // This rebuild touches only the browser.menus API — it performs no tab/group mutation,
            // so the delta-capture layer (which keys off real tab/group events) cannot re-record it.
            const {groupsChanged} = summarizeOps(plan.browserOps, plan.optionsToApply);
            if (groupsChanged) {
                const endMenus = beginApplyPhase('menus-rebuild', log);
                const {groups: rebuiltGroups} = await Groups.load(null, false);
                await MenusMain.groupsUpdated(rebuiltGroups)
                    .catch(log.onCatch('cant rebuild group menus after delta sync', false));
                endMenus();
            }
            currentApplyPhase = null; // apply finished cleanly; nothing is "in progress"
        }, {
            // COMPLETION WATCHDOG: if the apply holds the user-priority lock past this bound
            // (a never-settling await would otherwise wedge EVERY future user action forever),
            // log a WARN naming the last-started phase + elapsed ms and release the lock so the
            // UI recovers. The in-flight apply keeps running detached. The phase name in this
            // WARN is the diagnostic that pins where a stalled apply hung on the user's device.
            watchdogMs: SYNC_APPLY_WATCHDOG_MS,
            onWatchdog: ({elapsedMs}) => {
                log.warn('SYNC APPLY WATCHDOG TRIPPED: apply exceeded the held-lock bound; releasing the user-priority lock so user actions recover. Apply continues detached.', {
                    stuckPhase: currentApplyPhase,
                    elapsedMs,
                    watchdogMs: SYNC_APPLY_WATCHDOG_MS,
                    sinceApplyStartMs: Date.now() - applyStartedAt,
                });
            },
        });

        if (applyOutcome.deferred || applyOutcome.watchdog) {
            log.info('apply did not complete this cycle: skipping push/watermark/baseline; rescheduling sync soon', {
                deferred: applyOutcome.deferred === true,
                watchdog: applyOutcome.watchdog === true,
                userActive: isUserActive(),
            });
            await rescheduleSoonAfterDefer(log);

            syncResult.ok = true;
            syncResult.deferred = applyOutcome.deferred === true;
            syncResult.watchdog = applyOutcome.watchdog === true;
            syncResult.progress = lastProgress;
            syncResult.changes = {local: false, cloud: false};

            send('sync-end', syncResult);
            log.stop(applyOutcome.watchdog ? 'apply watchdog tripped: no push this cycle' : 'deferred to user');
            return syncResult;
        }

        progress(85);

        // 8. PUSH. The self delta file is written whenever this device has new events.
        // The full snapshot (STG-sync-snapshot.json) is the gist-discovery MARKER + the
        // consolidated base; it is REWRITTEN ONLY when (a) this cycle COMPACTS, or (b) it
        // does not yet exist (first create). Between compactions a normal sync pushes ONLY
        // this device's delta file — no snapshot rewrite — so idle/steady cycles stop
        // re-uploading the whole snapshot (the point-2 optimization, coupled to compaction).
        //
        // DEFERRED SELF-TRUNCATION (Part C): a COMPACTION cycle no longer truncates its own
        // log in the SAME cycle it writes the snapshot. The snapshot is the ONLY home of folded
        // history; a peer could clobber the just-written snapshot with an older one (rare under
        // the advisory lock, but possible without conditional writes / after a crash), and the
        // truncated events would then live ONLY in the clobbered snapshot ⇒ permanent loss. So:
        //   - the COMPACTION cycle writes the FULL self log to the cloud (no truncation) and
        //     records a pending marker = the self watermark seq it folded into the snapshot;
        //   - a SUBSEQUENT cycle, once the PULLED snapshot's watermark[self] proves >= that seq
        //     (durability confirmed — reconciled in step 1a-bis above), truncates up to it: both
        //     the LOCAL log (clearUpTo) and the cloud self-delta (drop seq <= it), then clears
        //     the marker. The invariant: an event always lives in (a) a cloud delta file OR (b) a
        //     cloud snapshot whose durability we CONFIRMED — never truncate the only copy first.
        const writeSnapshot = shouldCompact || !snapshotExists;

        // The cloud self-delta is truncated ONLY by a CONFIRMED deferred truncation (step
        // 1a-bis) — never in the compaction cycle that wrote the snapshot. CLAMPED to
        // lastPushedSeq via selfFoldedSeq when the marker was first set, so it can never exceed
        // an unpushed/unfolded tail. 0 ⇒ keep the full self log in the cloud (still deferring).
        const cloudSelfTruncateSeq = deferredTruncateConfirmed ? confirmedTruncateSeq : 0;

        const filesToWrite = {};
        if (writeSnapshot) {
            filesToWrite[SNAPSHOT_FILE_NAME] = plan.resolvedSnapshot;
        }
        if (plan.deltaFileToWrite) {
            // Keep the full self log in the cloud UNLESS a deferred truncation is confirmed this
            // cycle (then drop its confirmed-folded head). A compaction cycle writes FULL events
            // (cloudSelfTruncateSeq === 0) so the not-yet-confirmed events stay recoverable.
            const selfEvents = cloudSelfTruncateSeq > 0
                ? truncateSelfEvents(plan.deltaFileToWrite.events, cloudSelfTruncateSeq)
                : plan.deltaFileToWrite.events;
            filesToWrite[deltaFileName(selfDeviceId)] = {
                v: DeltaLog.SCHEMA_VERSION,
                deviceId: plan.deltaFileToWrite.deviceId,
                events: selfEvents,
            };
        }

        // A pure-compaction cycle (snapshot to write but no new self events to push) must
        // still PATCH the snapshot. writeFiles with only the snapshot covers that; an empty
        // object would be a no-op, so guard it.
        if (Object.keys(filesToWrite).length) {
            await Cloud.writeFiles(filesToWrite);
        }

        // refresh the stored conditional-request ETag from the post-push gist so the NEXT
        // cycle's isUnchangedSince probe compares against the revision we just wrote (else
        // our own push always reads back as "changed"). Optional + best-effort (fail-safe).
        await Cloud.refreshEtagFromWrite?.();

        if (plan.deltaFileToWrite) {
            // advance lastPushedSeq to the highest self seq written
            const maxSelfSeq = plan.deltaFileToWrite.events.reduce(
                (max, e) => (e.seq > max ? e.seq : max),
                lastPushedSeq,
            );
            storage[lastPushedSeqKey(selfDeviceId)] = maxSelfSeq;
        }

        // 8b. CONFIRMED DEFERRED TRUNCATION (own log + clear marker). Runs BEFORE recording a new
        // marker below so a cycle that BOTH confirms a prior deferral AND compacts does not delete
        // the fresh marker (8c re-records it afterwards from the just-folded seq). When step
        // 1a-bis confirmed the pulled snapshot durably carries the folded events, NOW drop the
        // folded head of THIS device's LOCAL delta log (the cloud self-delta head was dropped in
        // the write above) and clear the marker. clearUpTo keeps lastSeq monotonic so future
        // appends never collide. Safe by the invariant: the cloud snapshot's watermark[self] >=
        // the seq we trim, so any device pulling sees the folded effect in the base and replay
        // skips the trimmed events (seq <= watermark) — no double-apply, no loss.
        if (deferredTruncateConfirmed && confirmedTruncateSeq > 0) {
            await DeltaLog.clearUpTo(confirmedTruncateSeq);
            delete storage[pendingTruncateKey(selfDeviceId)];
            log.info('deferred truncation CONFIRMED: cloud snapshot durably carries folded events; truncated own log', {
                truncatedUpToSeq: confirmedTruncateSeq,
                cloudSelfWatermark: Number(pulledSnapshot?.watermark?.[selfDeviceId]) || 0,
            });
        }

        // 8c. RECORD the deferred-truncation marker for THIS compaction (no local truncation
        // here). Runs AFTER the confirmed-truncation step above so a same-cycle confirm can't
        // delete this fresh marker. The seq we'd fold = the new base's advanced self watermark,
        // CLAMPED to lastPushedSeq (never mark an unpushed/unfolded tail). The snapshot carrying
        // that fold has just been written, but its durability is not yet CONFIRMED (a peer could
        // clobber it), so we only RECORD; a later cycle truncates once the pulled watermark proves
        // it survived. If a marker is already pending (an earlier compaction not yet confirmed),
        // keep the LARGER seq — the latest snapshot folds at least as much. No truncation until
        // confirmed ⇒ the only copy of folded events is never removed prematurely.
        if (shouldCompact) {
            const foldedSelfSeq = selfFoldedSeq(plan.newWatermark, selfDeviceId, lastPushedSeq);
            if (foldedSelfSeq > 0) {
                const newPending = Math.max(pendingTruncateSeq, foldedSelfSeq);
                storage[pendingTruncateKey(selfDeviceId)] = newPending;
                log.info('compaction: wrote snapshot base + recorded DEFERRED self-truncation marker', {
                    unfoldedCount,
                    pendingTruncateSeq: newPending,
                    newWatermark: plan.newWatermark,
                });
            } else {
                log.info('compaction: rewrote snapshot base (nothing foldable to defer-truncate)', {
                    unfoldedCount,
                    newWatermark: plan.newWatermark,
                });
            }
        }

        // 8d. NO ORPHAN DELTA-FILE GC. We deliberately do NOT delete other devices' folded
        // delta files. GitHub has no conditional write (If-Match → bare 400), so a peer can
        // clobber the snapshot we just wrote with an older one; a delta file deleted here
        // would then be unrecoverable (the snapshot is the ONLY home of folded history — delta
        // files are truncated tails, not a full replay source). Instead we rely on the
        // permanently-kept watermark: a returning device re-pushing its full log is skipped by
        // replay for every event with seq <= watermark[D] (replay.js: `event.seq <= folded` ⇒
        // skip), so a never-deleted peer file never double-applies or resurrects. The only cost
        // is that a dead device's file lingers — harmless over-keeping. Each device still trims
        // ONLY its OWN delta tail (deferred, on a later confirmed cycle above), which is safe
        // because that tail's effect is durably in the snapshot the pulled watermark confirmed.

        progress(90);

        // 9. persist the resolved watermark as the base for the next round. This advances
        // every device's high-water mark to the highest folded seq, exactly as written into
        // the snapshot when this cycle compacted. (Snapshot rewrites are gated above; on a
        // non-compacting cycle the cloud snapshot keeps its prior watermark, but the resolved
        // watermark is a superset that is re-persisted to the snapshot on the next compaction.)
        storage[watermarkKey(selfDeviceId)] = JSON.stringify(plan.newWatermark || {});

        // 10. persist the NEW baseline = the ids/uids of the resolved snapshot. This
        // runs ONLY on the success path (after apply + push succeeded); if any earlier
        // step threw, control jumps to catch and the baseline is left untouched, so we
        // never record a state we didn't actually reconcile.
        saveBaseline(selfDeviceId, baselineFromSnapshot(plan.resolvedSnapshot));

        progress(100);

        syncResult.ok = true;
        syncResult.progress = 100;

        // Shape-compatible with the legacy synchronization() result so UI listeners
        // (tab-groups.mixin `sync-end` → request.changes.local) don't crash.
        // local = applied any change to this browser; cloud = pushed a delta file.
        // Routed through summarizeOps (same source of truth as the pre-apply backup
        // gate) so a content-only apply (tabsToUpdate / pinnedToUpdate) flips local=true
        // and the UI refreshes (B2).
        syncResult.changes = {
            local: summarizeOps(plan.browserOps, plan.optionsToApply).mutatesBrowser,
            cloud: !!plan.deltaFileToWrite,
        };

        send('sync-end', syncResult);
        log.stop();
    } catch (e) {
        syncResult.langId = e.langId;
        syncResult.progress = lastProgress;
        Object.assign(syncResult, {message: String(e), stack: e.stack});

        send('sync-error', syncResult);
        log.logError('cant delta sync', e);
        log.stopError();
    } finally {
        // Release the advisory lock no matter how we exit (success, error, or the apply
        // watchdog firing). Best-effort + idempotent; a lock we fail to delete is reclaimed by
        // the TTL. Only release one we actually acquired (a contended-skip never held it).
        if (lockAcquired && Cloud?.releaseLock) {
            await Cloud.releaseLock().catch(e =>
                log.warn('cant release advisory lock; TTL will reclaim it', String(e)));
        }
        inProgress = false;
        send('sync-finish', syncResult);
    }

    return syncResult;
}
