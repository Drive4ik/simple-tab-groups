
/**
 * Local append-only delta event log for hybrid snapshot + delta sync (Phase P1).
 *
 * This module records the changes the user makes to tabs and groups as an ordered
 * stream of events for THIS device. It is purely additive and inert in P1: events
 * accumulate locally and nothing consumes them yet. The replay engine (P2) and the
 * gist transport (P3) build on top of this; see `.project/DESIGN_DELTA_SYNC.md`.
 *
 * ## Event schema (per DESIGN_DELTA_SYNC.md "Event schema")
 * Each event:
 *   { seq, ts, op, ...payload }
 * where
 *   - `seq` — per-device monotonic integer, assigned on append. Disambiguates
 *      same-device ordering when wall-clock `ts` ties.
 *   - `ts`  — `Utils.unixNowMs()` at append time (best-effort wall clock).
 *   - `op`  — one of the OPS below.
 *
 * Payloads by op (the writer always has the full local record, so modify/add carry
 * it in full so a later resurrection during replay is faithful):
 *   tab.add      { groupId, tab: <full tab record incl. uid> }
 *   tab.modify   { groupId, tab: <full tab record incl. uid> }
 *   tab.move     { groupId, uid, toIndex }
 *   tab.remove   { groupId, uid }
 *   group.add    { group: <full group record> }
 *   group.modify { group: <full or partial group record incl. id> }
 *   group.move   { groupId, toIndex }   // group reordered to 0-based position in groups list
 *   group.remove { groupId }
 *   option.set   { key, value }   // one global STG option key changed to `value`
 *   pinned.add    { tab: <full pinned tab record incl. uid> }
 *   pinned.modify { tab: <full pinned tab record incl. uid> }
 *   pinned.move   { uid, toIndex }
 *   pinned.remove { uid }
 *
 * Global pinned tabs are window-global in Firefox (NOT in any STG group), so their
 * events carry NO groupId — identity is the tab `uid` and they fold into a separate
 * ordered `pinnedTabs` array in the snapshot (mirrors the legacy backup field
 * `data.pinnedTabs`), rather than into `groups`. See `sync/delta/replay.js` for how
 * they replay. A tab that becomes pinned emits `pinned.add` (and a `tab.remove` for the
 * group it left); a tab that becomes unpinned emits `pinned.remove`.
 *
 * The persisted file shape (for the future transport) is:
 *   { v: SCHEMA_VERSION, deviceId, events: [ ...event ] }
 *
 * ## Backing store
 * `browser.storage.local` (the same async store the snapshot uses, see storage.js),
 * NOT the synchronous localStorage proxy. An append-only log must stay cheap to
 * append to and survive restarts; the async storage handles larger payloads and
 * does not block, whereas the localStorage proxy re-stringifies a whole value per
 * key write and is synchronous. An in-memory mirror keeps `seq` monotonic and makes
 * reads cheap; appends serialize through a write chain so concurrent appends keep
 * their order and never lose an event.
 *
 * @module sync/delta/delta-log
 */

import '/js/prefixed-storage.js';
import * as Utils from '/js/utils.js';
import Logger from '/js/logger.js';
import {getDeviceId} from './device-id.js';
import {sanitizeGroupIconUrl} from './url-sync.js';
import DeltaLogStore from './delta-log-store.js';
import {isCaptureGateOpen} from './capture-gate-state.js';

const logger = new Logger('DeltaLog');

/** Event schema version (the `v` field in the persisted file). */
export const SCHEMA_VERSION = 1;

/** browser.storage.local key holding this device's event log. */
const STORAGE_KEY = 'syncDeltaLog';

/**
 * Supported operations. Frozen so callers can reference them without typos.
 * @readonly
 */
export const OPS = Object.freeze({
    TAB_ADD: 'tab.add',
    TAB_MODIFY: 'tab.modify',
    TAB_MOVE: 'tab.move',
    TAB_REMOVE: 'tab.remove',
    GROUP_ADD: 'group.add',
    GROUP_MODIFY: 'group.modify',
    GROUP_MOVE: 'group.move',
    GROUP_REMOVE: 'group.remove',
    // one global STG option key set to a value; per-key last-writer-wins on replay
    OPTION_SET: 'option.set',
    // global pinned tabs (window-global, no groupId); fold into `snapshot.pinnedTabs`
    PINNED_ADD: 'pinned.add',
    PINNED_MODIFY: 'pinned.modify',
    PINNED_MOVE: 'pinned.move',
    PINNED_REMOVE: 'pinned.remove',
});

const VALID_OPS = new Set(Object.values(OPS));

// in-memory mirror of the persisted log; lazily hydrated on first access
let events = null;
let lastSeq = 0;

// memoizes the single in-flight first hydration so concurrent first-touch callers all
// await ONE `browser.storage.local.get(...)` + migration instead of each running their own
// (which would clobber `events`/`lastSeq` and lose an event + collide its seq). Reset to
// null by clear() so a post-reset hydration can re-run. See `ensureLoaded`.
let loadingPromise = null;

// serializes persistence so overlapping appends keep order and don't clobber
let writeChain = Promise.resolve();

let metaPersisted = false;

let storeOutOfSync = false;

function enqueueWrite(operation) {
    const write = writeChain.then(async () => {
        if (storeOutOfSync) {
            await DeltaLogStore.replaceEvents(events);
            storeOutOfSync = false;
        }
        return operation();
    });
    writeChain = write.then(() => {}, () => {
        storeOutOfSync = true;
    });
    return write;
}

function currentMeta() {
    return {v: SCHEMA_VERSION, deviceId: getDeviceId()};
}

function persistAppended(newEvents) {
    return enqueueWrite(async () => {
        if (!metaPersisted) {
            await DeltaLogStore.saveMeta(currentMeta());
            metaPersisted = true;
        }
        await DeltaLogStore.putEvents(newEvents);
    });
}

function stripHistoricalTabFavicon(tabRecord) {
    if (tabRecord && typeof tabRecord === 'object' && Object.hasOwn(tabRecord, 'favIconUrl')) {
        delete tabRecord.favIconUrl;
        return true;
    }
    return false;
}

function stripHistoricalGroupBloat(group) {
    if (!group || typeof group !== 'object') {
        return false;
    }

    let changed = false;

    if (typeof group.iconUrl === 'string' && sanitizeGroupIconUrl(group.iconUrl) === undefined) {
        delete group.iconUrl;
        changed = true;
    }

    for (const groupTab of Array.isArray(group.tabs) ? group.tabs : []) {
        if (stripHistoricalTabFavicon(groupTab)) {
            changed = true;
        }
        if (groupTab && typeof groupTab === 'object' && Object.hasOwn(groupTab, 'thumbnail')) {
            delete groupTab.thumbnail;
            changed = true;
        }
    }

    return changed;
}

function stripEventBloat(event) {
    const tabChanged = stripHistoricalTabFavicon(event?.tab);
    const groupChanged = stripHistoricalGroupBloat(event?.group);
    return tabChanged || groupChanged;
}

/**
 * Hydrate the in-memory mirror from storage exactly once.
 *
 * On hydrate we run a ONE-TIME MIGRATION over the stored log: every historical event has
 * its `favIconUrl` stripped and the log is rewritten ONCE. This is the recovery path for
 * existing users whose `syncDeltaLog` had grown to gigabytes of duplicated base64 favicons
 * — it reclaims that RAM without a manual reset. Safe + idempotent: the stripped favicons
 * are redundant (the snapshot holds each tab's latest favicon and live tabs re-capture it),
 * identity/url/title/group/pinned are untouched, and a log already free of favicons triggers
 * no rewrite.
 *
 * ## First-hydration race
 * The hydration is memoized as a SINGLE in-flight promise (`loadingPromise`). A bare
 * `if (events !== null) return` guard is not enough: `events` is only assigned AFTER the
 * `await browser.storage.local.get(...)`, so two concurrent first-touch callers (e.g. a
 * capture `append` racing the transport's `getEvents`/`append` at background startup) would
 * BOTH observe `events === null`, BOTH await the get, and the second would overwrite `events`
 * with a fresh stored array — dropping any event the first already pushed and recomputing
 * `lastSeq` from storage, so the next append reuses a collided seq (data loss). Memoizing the
 * promise makes every caller await the same hydration; the body runs at most once per reset.
 * If the hydration FAILS, `loadingPromise` is cleared so a later call can retry (preserving
 * the pre-fix behaviour of leaving `events === null` on a failed get) rather than caching the
 * rejection forever.
 * @returns {Promise<void>}
 */
function ensureLoaded() {
    return loadingPromise ??= (async () => {
        const {meta, events: storedEvents} = await DeltaLogStore.load();
        metaPersisted = Boolean(meta);

        let legacyLog = null;
        if (!meta && storedEvents.length === 0) {
            const stored = await browser.storage.local.get(STORAGE_KEY);
            legacyLog = stored[STORAGE_KEY] ?? null;
        }

        events = legacyLog
            ? (Array.isArray(legacyLog.events) ? legacyLog.events : [])
            : storedEvents;
        lastSeq = events.length ? events[events.length - 1].seq : 0;

        let changed = false;
        for (const event of events) {
            if (stripEventBloat(event)) {
                changed = true;
            }
        }

        if (legacyLog) {
            logger.info('migrated delta log from storage.local to IndexedDB', {events: events.length});
            await enqueueWrite(async () => {
                await DeltaLogStore.saveMeta(currentMeta());
                metaPersisted = true;
                await DeltaLogStore.replaceEvents(events);
            });
            await browser.storage.local.remove(STORAGE_KEY);
        } else if (changed) {
            logger.info('migrated stored delta log: stripped historical favicons/thumbnails/icons', {events: events.length});
            await enqueueWrite(() => DeltaLogStore.putEvents(events));
        }
    })().catch(err => {
        // let a later first touch retry instead of permanently caching the rejection.
        loadingPromise = null;
        throw err;
    });
}

/**
 * Append one event to this device's log. Assigns the next `seq`, stamps `ts`,
 * and persists. Unknown ops are rejected (logged + ignored) so a caller typo can
 * never corrupt the stream.
 *
 * @param {string} op - one of {@link OPS}.
 * @param {object} [payload={}] - op-specific payload (see module docs).
 * @returns {Promise<object|undefined>} the appended event, or undefined if ignored.
 */
export async function append(op, payload = {}) {
    if (!VALID_OPS.has(op)) {
        logger.error('append: unknown op', op);
        return;
    }

    if (!await isCaptureGateOpen()) {
        return;
    }

    await ensureLoaded();

    const event = {
        seq: ++lastSeq,
        ts: Utils.unixNowMs(),
        op,
        ...payload,
    };

    events.push(event);

    await persistAppended([event]);

    return event;
}

/**
 * Append many events in one batch, persisting only once. Each item is shaped
 * `{op, ...payload}`. Items with an unknown op are logged and skipped (the rest
 * of the batch still proceeds). Persists once if at least one event was appended.
 *
 * @param {object[]} items - each `{op, ...payload}` (see {@link OPS}).
 * @returns {Promise<object[]>} the appended events, in order.
 */
export async function appendMany(items) {
    if (!Array.isArray(items) || items.length === 0) {
        return [];
    }

    if (!await isCaptureGateOpen()) {
        return [];
    }

    await ensureLoaded();

    const appended = [];

    for (const item of items) {
        if (!VALID_OPS.has(item.op)) {
            logger.error('appendMany: unknown op', item.op);
            continue;
        }

        const event = {
            ...item,
            seq: ++lastSeq,
            ts: Utils.unixNowMs(),
        };

        events.push(event);
        appended.push(event);
    }

    if (appended.length) {
        await persistAppended(appended);
    }

    return appended;
}

/**
 * Returns a deep clone of all events currently in this device's log. Callers may
 * mutate the result freely (e.g. the transport's in-place container mapping)
 * without corrupting the log state.
 * @returns {Promise<object[]>}
 */
export async function getEvents() {
    await ensureLoaded();
    return structuredClone(events);
}

/**
 * Returns deep clones of the events with `seq` strictly greater than `seq` (in
 * order). Used by the transport to push only not-yet-synced events; clones for
 * the same reason as {@link getEvents}.
 * @param {number} seq
 * @returns {Promise<object[]>}
 */
export async function getEventsSince(seq) {
    await ensureLoaded();
    return structuredClone(events.filter(event => event.seq > seq));
}

/**
 * Drops events with `seq` less than or equal to `seq` (compaction support, P4).
 * Events newer than `seq` are kept; `lastSeq` is unchanged so future appends stay
 * monotonic even after the head is trimmed.
 * @param {number} seq
 * @returns {Promise<void>}
 */
export async function clearUpTo(seq) {
    await ensureLoaded();
    events = events.filter(event => event.seq > seq);
    await enqueueWrite(() => DeltaLogStore.deleteUpTo(seq));
}

/**
 * Returns the highest assigned seq (0 if empty). Useful for watermark math (P3/P4).
 * @returns {Promise<number>}
 */
export async function getLastSeq() {
    await ensureLoaded();
    return lastSeq;
}

/**
 * Fully reset this device's local delta log: empties the persisted events, resets the
 * `seq` counter to 0, and refreshes the in-memory mirror. Unlike {@link clearUpTo}
 * (which trims the head but keeps `lastSeq` monotonic for ongoing compaction), this is
 * a hard reset for the recovery flow — after it the next append starts from `seq` 1,
 * matching a fresh install. Local only: it never touches the cloud delta file (the
 * stale cloud file is reconciled/compacted on the next sync, or deleted manually).
 * @returns {Promise<void>}
 */
export async function clear() {
    await ensureLoaded();
    events = [];
    lastSeq = 0;
    // Reset the memoized hydration too: the in-memory mirror above is now the authoritative
    // (empty) state and is persisted below, but dropping `loadingPromise` lets a later first
    // touch re-run the memoized hydration cleanly instead of being short-circuited by the
    // already-resolved promise from before the reset.
    loadingPromise = null;
    await enqueueWrite(() => DeltaLogStore.replaceEvents([]));
}

/**
 * RESET/WATERMARK TRAP recovery (E2). After a local {@link resetSyncState}, this
 * device's `lastSeq` is rewound to 0 so fresh appends start at seq 1 — but the
 * CLOUD snapshot still carries `watermark[thisDevice] = N` from before the reset,
 * which reset cannot clear. replay() dedups every event with `seq <= watermark`
 * (replay.js rule 4), so those re-issued low-seq events would be SILENTLY SKIPPED
 * and the post-reset local changes lost until seq organically climbs past N.
 *
 * This fast-forwards THIS device's log so EVERY event sits strictly above `minSeq`
 * (the stale cloud watermark): it shifts every event's `seq` up by a SINGLE constant
 * offset chosen so the LOWEST event seq lands at `minSeq + 1` (preserving relative
 * order and any gaps), and bumps `lastSeq` to match, so future appends also stay above
 * the watermark. For an EMPTY log there is no event to anchor on, so it just advances
 * `lastSeq` to `minSeq + 1`. A no-op when nothing is at risk — i.e. the lowest event
 * seq already exceeds `minSeq` (and, for an empty log, `lastSeq` already does) — which
 * is the normal, non-reset case.
 *
 * Safe to call on every sync: it only acts when the trap is actually present, never
 * lowers a seq, and keeps the log monotonic. The caller must re-read pending events
 * afterwards (their seqs may have changed).
 *
 * @param {number} minSeq - the highest seq already folded into the cloud base for this
 *   device (its cloud watermark). Events must end up strictly greater than this.
 * @returns {Promise<boolean>} true iff a fast-forward was applied (seqs shifted).
 */
export async function fastForwardSeqsAbove(minSeq) {
    await ensureLoaded();

    if (!Number.isFinite(minSeq)) {
        return false;
    }

    // anchor on the LOWEST event seq (the one most at risk of dedup); for an empty log
    // anchor on lastSeq + 1 so the counter alone advances. A single constant offset
    // preserves relative order and any pre-existing gaps.
    const lowest = events.length
        ? events.reduce((min, e) => (e.seq < min ? e.seq : min), Infinity)
        : lastSeq + 1;

    if (lowest > minSeq) {
        return false; // normal path: nothing sits at/below the cloud watermark
    }

    const offset = (minSeq + 1) - lowest;
    for (const event of events) {
        event.seq += offset;
    }
    lastSeq += offset;

    const shifted = events.slice();
    await enqueueWrite(() => DeltaLogStore.replaceEvents(shifted));
    return true;
}
