
/**
 * Capture layer: translates STG's existing tab/group lifecycle into delta events
 * and appends them to the local {@link module:sync/delta/delta-log} (Phase P1).
 *
 * Design constraints (see `.project/DESIGN_DELTA_SYNC.md`):
 *  - HOOK existing handlers; never add raw `browser.tabs.on*` listeners. The tab
 *    functions here are invoked from `tabs.js` handlers AFTER STG's own skip checks
 *    (`skip.created/tracking/removed`, `skipTrackingWindows`), and the group
 *    functions from groups.js `send*` helpers. Sync-originated changes bypass both
 *    (cloud.js creates tabs with `skipListener`/`skip.*` and saves groups via
 *    `Groups.save` directly, not `Groups.add/update/remove`), so they are NOT
 *    recorded as fresh deltas. See "Sync-origination guard" note below.
 *  - Tab identity is the stable `uid` (cache.js). GROUPED tabs (a groupId in cache) fold
 *    into `groups`; GLOBAL PINNED tabs (window-global, no groupId) fold into the separate
 *    `pinnedTabs` snapshot section via the `pinned.*` ops below. Untracked tabs that are
 *    neither (e.g. transient unsync tabs) are still ignored, mirroring backups. The
 *    groupId is the discriminator: a per-group pinned tab (one that HAS a groupId) is NOT
 *    a global pinned tab and is never captured here — only via the group `tab.*` ops.
 *  - modify/add carry the FULL record so a future resurrection on replay is faithful.
 *  - tab/pinned capture gates URL on the SYNCABLE allow-list ({@link module:sync/delta/url-sync}
 *    `isUrlSyncable`): everything `Utils.isUrlAllowToCreate` admits PLUS non-trivial
 *    `about:` URLs (which the receiving machine renders as the "unsupported URL" stub),
 *    minus trivial new-tab states. A tab whose LIVE url is that stub page is decoded back
 *    to its embedded original (`unwrapStubUrl`) so it keeps its original identity.
 *
 * Inert in P1: nothing reads these events yet; failures are swallowed (logged) so
 * capture can never affect current behaviour.
 *
 * ### Sync-origination guard
 * P1 relies on STG's existing skip flags: the tab handlers return early for any tab
 * STG is itself manipulating during sync, so this layer is never invoked for those.
 * P3b (the delta transport, `delta-sync.js`) routes its applies through those same
 * skip flags — BUT not every capture entry point sits behind one: notably the
 * `onUpdated` url/title `tab.modify` path fires when a freshly sync-created tab loads
 * its url, which no skip flag covers. To close that residual feedback loop, the
 * transport brackets its whole apply with {@link beginApply}/{@link endApply}, which
 * sets a module-level flag so EVERY capture function below early-returns while a sync
 * apply is in progress. The flag is a depth counter so nested/overlapping applies are
 * safe, and it is reset defensively by `endApply` even on error.
 *
 * @module sync/delta/delta-capture
 */

import Logger from '/js/logger.js';
import * as Cache from '/js/cache.js';
import * as Constants from '/js/constants.js';
import * as DeltaLog from './delta-log.js';
import {syncedOptionKeys} from './option-keys.js';
import {isUrlSyncable, unwrapStubUrl, sanitizeFavIconUrl, sanitizeGroupRecordForSync} from './url-sync.js';
import {computeGroupRelativeIndex} from './group-relative-index.js';
import {isAppliedNavigationEcho} from './applied-nav-echo.js';

const logger = new Logger('DeltaCapture');

// Depth of in-progress sync applies. While > 0, every capture function early-returns
// so transport-applied changes are never recorded as fresh local deltas (feedback
// loop). A counter (not a bool) tolerates overlapping begin/end pairs.
let applyDepth = 0;

/** Suppress capture while a sync apply runs. Pair with {@link endApply}. */
export function beginApply() {
    applyDepth++;
}

/** End the suppression started by {@link beginApply}. Never drops below zero. */
export function endApply() {
    if (applyDepth > 0) {
        applyDepth--;
        if (applyDepth === 0) {
            // remember when the OUTERMOST apply finished: the navigation it just issued via
            // `browser.tabs.update` settles ASYNCHRONOUSLY, so its onUpdated echo arrives AFTER
            // this point and must still be recognised as an apply echo (see the guard below).
            lastApplyEndedAt = Date.now();
        }
    }
}

/** @returns {boolean} true while a sync apply is suppressing capture. */
export function isApplying() {
    return applyDepth > 0;
}

// ---------------------------------------------------------------------------
// Post-apply navigation-echo guard (feedback-loop protection for sync-APPLIED url changes).
//
// The synchronous {@link isApplying} counter only suppresses capture for changes that land
// WHILE an apply runs. But the transport's content-update path
// (`delta-sync.applyTabContentUpdate`) navigates a LOADED tab via
// `browser.tabs.update(liveId, {url})`, which resolves as soon as the navigation STARTS — the
// resulting `onUpdated` (status/url) fires ASYNCHRONOUSLY, and `tabs.js onUpdated` itself
// `await`s ~70ms before reaching the capture fn. By then `endApply()` has already run, so the
// applied navigation surfaces as a "fresh" url `tab.modify`/`pinned.modify`.
//
// URL-NARROWED suppression (the convergence fix for "loads infinitely"): the mark records the
// EXACT url the apply navigated the tab to. While the mark is live:
//   · a settle whose url EQUALS the applied url is the plain echo of our own write ⇒ SUPPRESS
//     (re-capturing it would push it back and grow the log for no reason);
//   · a settle whose url DIFFERS from the applied url is a server REDIRECT (applied X → landed on
//     Y: http→https, trailing slash, login bounce, SPA fragment) ⇒ CAPTURE + push. This is the
//     crucial change from the old window-based guard, which dropped the redirect too: when the
//     redirect is dropped, the cloud stays at X while live is Y forever, so the planner re-emits
//     `tabsToUpdate{url:X}` and the apply re-navigates X→Y EVERY cycle (the perpetual spinner).
//     Capturing Y lets the cloud CONVERGE to Y; then resolved==live and the planner emits nothing.
//   (The no-op guard in `applyTabContentUpdate` is the complementary half: once converged, an
//    update whose url already matches the live url issues ZERO browser ops.)
//
// SCOPING — echo vs USER navigation: a tab is armed ONLY when its content change is observed
// WHILE a sync apply is in progress, OR within a tight trailing window after the apply ended
// (`APPLIED_NAV_WINDOW_MS`). A user navigation of a grouped/pinned tab made OUTSIDE that causal
// window is never marked and syncs normally (the whole point of the A6 url-capture fix). tabs.js
// arms the mark via {@link markAppliedNavigation} when {@link shouldArmAppliedNavigation} holds;
// capture suppresses only the exact-url echo while the mark is live. The synchronous `isApplying()`
// in-apply suppression is left fully intact.
const appliedNavTabs = new Map(); // tabId -> {expiry: epoch ms, url: applied url} (suppression mark)
const APPLIED_NAV_WINDOW_MS = 4_000; // trailing causal window after endApply for the async echo
let lastApplyEndedAt = 0; // epoch ms when the outermost apply last finished

/**
 * Should a content change observed RIGHT NOW (in `tabs.js onUpdated`) be armed as a sync-applied
 * navigation? True while an apply is in progress, or within the trailing causal window after the
 * last apply ended (covering the async `onUpdated` that fires after `endApply`). When this holds,
 * tabs.js calls {@link markAppliedNavigation} so the echo of the exact applied url is suppressed
 * (a redirect to a different url is still captured — see the module guard note above).
 * @returns {boolean}
 */
export function shouldArmAppliedNavigation() {
    return isApplying() || (Date.now() - lastApplyEndedAt) < APPLIED_NAV_WINDOW_MS;
}

/**
 * Mark a tab id as having just been navigated by a sync apply (or as having a content change
 * observed inside the apply's causal window), recording the APPLIED url so the capture layer can
 * suppress the echo of EXACTLY that url while still letting a server-redirect to a DIFFERENT url
 * through (so the cloud converges to the redirect target). No-op for a non-finite id.
 *
 * The url is captured ONCE — on the first arm of a fresh mark — and PRESERVED across subsequent
 * arms within the window: a redirect-chain hop re-arms the mark (refreshing its expiry so the
 * whole chain stays inside one causal window) but must NOT overwrite the recorded applied url
 * with the redirect's url, or the redirect would compare equal to itself and be suppressed
 * instead of captured. The url is decoded through STG's "unsupported URL" stub so a stub-rendered
 * about: tab is marked by its embedded original identity (matching how the observed url is
 * compared + how the record url is stored).
 *
 * @param {number} tabId
 * @param {string} [url] - the url the apply navigated this tab to (recorded only on first arm).
 */
export function markAppliedNavigation(tabId, url) {
    if (!Number.isFinite(tabId)) {
        return;
    }
    const existing = appliedNavTabs.get(tabId);
    const expiry = Date.now() + APPLIED_NAV_WINDOW_MS;
    // preserve the FIRST recorded url across re-arms (redirect hops keep the applied url).
    const markUrl = (existing && existing.url != null)
        ? existing.url
        : (typeof url === 'string' ? unwrapStubUrl(url) : undefined);
    appliedNavTabs.set(tabId, {expiry, url: markUrl});
}

/** Drop an applied-navigation mark (e.g. on tab removal, or once consumed). */
export function clearAppliedNavigation(tabId) {
    appliedNavTabs.delete(tabId);
}

/**
 * Is the content change for `tabId` (now at `observedUrl`) a sync-applied navigation echo right
 * now? Reads the live {@link isApplying} state and the tab's mark, delegating to
 * {@link isAppliedNavigationEcho}.
 *
 * Suppression is NARROWED BY URL (the convergence fix): while the mark is live, ONLY the echo of
 * the EXACT applied url is dropped; a settle whose url DIFFERS from the applied url is a server
 * REDIRECT and is CAPTURED so the cloud can converge to the redirect target (and then live==cloud,
 * ending the perpetual re-navigation). The applied url and the observed url are both compared
 * stub-decoded so a stub-rendered about: tab matches by its embedded identity. An EXPIRED mark is
 * pruned (returns false) so the next user navigation of the same tab is captured normally.
 *
 * @param {number} tabId
 * @param {string} [observedUrl] - the url of the content change being classified.
 * @returns {boolean}
 */
function consumeAppliedNavigationEcho(tabId, observedUrl) {
    const mark = appliedNavTabs.get(tabId);
    const now = Date.now();
    const echo = isAppliedNavigationEcho({
        applying: isApplying(),
        markExpiry: mark?.expiry,
        markUrl: mark?.url,
        observedUrl: typeof observedUrl === 'string' ? unwrapStubUrl(observedUrl) : observedUrl,
        now,
    });
    if (mark != null && now >= mark.expiry) {
        appliedNavTabs.delete(tabId); // prune the stale mark so later user navs aren't blocked.
    }
    return echo;
}

/**
 * Resolve the stable uid for a tracked tab, assigning + persisting one if absent
 * (mirrors cache.js lazy backfill). Returns null if it can't be resolved.
 * @param {number} tabId
 * @returns {Promise<string|null>}
 */
async function resolveUid(tabId) {
    const uid = Cache.getTabUid(tabId);
    if (uid) {
        return uid;
    }
    try {
        return await Cache.setTabUid(tabId);
    } catch {
        return null;
    }
}

/**
 * Compute a tab's GROUP-RELATIVE index: its 0-based position among the tabs of the
 * SAME group within the same window, ordered by browser index.
 *
 * The delta/replay model treats a tab's `index` as the position WITHIN its group's
 * ordered tab list (0..n-1), NOT the browser-window-absolute `tab.index`. The browser
 * index is shifted by pinned tabs and by other groups' tabs sharing the window, and it
 * differs per machine — replaying by it shuffles the group's tab order on every other
 * device. So at capture time we derive the position within the group instead.
 *
 * Cheap and side-effect-light: one `browser.tabs.query` for the tab's window, filtered
 * to the same group via the cache. Returns null (⇒ caller omits `index` ⇒ replay
 * appends) if the position can't be determined — better an append than a wrong slot. The
 * pure positional math lives in {@link computeGroupRelativeIndex} (unit-tested).
 *
 * @param {number} tabId
 * @param {number} windowId
 * @param {string} groupId
 * @returns {Promise<number|null>}
 */
async function getGroupRelativeIndex(tabId, windowId, groupId) {
    try {
        if (!Number.isFinite(windowId) || !groupId) {
            return null;
        }

        const windowTabs = await browser.tabs.query({windowId});

        return computeGroupRelativeIndex(windowTabs, Cache.getTabGroup, tabId, groupId);
    } catch {
        return null;
    }
}

/**
 * Build the full tab record an add/modify event carries.
 *
 * `index` is GROUP-RELATIVE (0-based position within the group's ordered tab list),
 * resolved from the live browser via {@link getGroupRelativeIndex}. When it can't be
 * resolved the field is OMITTED, which the replay engine treats as append-at-end.
 *
 * @param {object} tab - browser tab merged with cache session.
 * @param {string} uid
 * @param {number|null} groupRelativeIndex - precomputed group-relative position, or null.
 * @param {object} [snapshot] - synchronously-read cache fields pinned at the call site (A4),
 *   used instead of re-reading the (possibly torn-down) cache. Recognised keys:
 *   `lastModified`, `groupPinned`, `favIconUrl`.
 * @returns {object}
 */
function buildTabRecord(tab, uid, groupRelativeIndex, snapshot = null) {
    const record = {
        uid,
        // decode STG's "unsupported URL" stub page back to the original about: url it
        // embeds, so a tab the receiving machine rendered as the stub keeps its original
        // identity instead of syncing the moz-extension stub url (feedback/divergence loop).
        url: unwrapStubUrl(tab.url),
        title: tab.title,
        cookieStoreId: tab.cookieStoreId,
        // sanitizeFavIconUrl DROPS inline `data:` favicons (they caused the multi-GB bloat) and
        // any oversized URL; only a small http(s)/moz-extension reference is kept. The favicon
        // is just a field that RIDES ALONG in this record (written for a real url/title change);
        // there is no favicon-only event. undefined ⇒ field omitted.
        // A4: prefer the live tab favicon, fall back to the snapshot taken at the call site.
        favIconUrl: sanitizeFavIconUrl(tab.favIconUrl ?? snapshot?.favIconUrl),
        // A4: prefer the snapshot's lastModified (pinned at the call site, after the bump);
        // fall back to a live cache read for callers that pass no snapshot.
        lastModified: snapshot?.lastModified ?? Cache.getTabLastModified(tab.id),
    };
    if (Number.isInteger(groupRelativeIndex)) {
        record.index = groupRelativeIndex;
    }
    // group-scoped pin flag: a tab pinned WITHIN its group (pinned only while the group
    // is active). Rides the group tab.add/tab.modify record (NEVER a global pinned.* op —
    // a group-pinned tab still has a groupId, so the pinned.* discriminator excludes it).
    // ALWAYS emitted explicitly (true or false): replay clobber-safety preserves an OMITTED
    // flag (legacy records carried it only when true), so emitting `false` is what lets a
    // genuine un-pin actually clear a previously-synced pinned:true. See replay.js.
    // A4: prefer the snapshot's value (pinned at the call site) over a live cache read.
    record.pinned = (snapshot ? snapshot.groupPinned : Cache.getTabGroupPinned(tab.id)) === true;
    // source loaded-state: was this tab loaded (NOT discarded) on THIS machine when
    // captured? Carried so a receiving device with `syncActivatePreviouslyActiveTabs`
    // on can re-activate the tabs the user had open here. ALWAYS emitted explicitly so a
    // genuine un-load clears it (same reasoning as `pinned`). A tab whose discarded state
    // is unknown (undefined) is treated as not-loaded (safe: replays as asleep).
    record.loaded = tab.discarded === false;
    return record;
}

/**
 * Record a tab addition (op `tab.add`). Called from tabs.js `onCreated` after skip
 * checks. Ignores pinned / ungrouped tabs (no groupId ⇒ STG doesn't track it).
 * @param {object} tab
 */
export async function tabAdded(tab) {
    try {
        if (isApplying()) {
            return;
        }

        const groupId = Cache.getTabGroup(tab.id);
        if (!groupId) {
            return;
        }

        // gate on the SYNCABLE allow-list (the unwrapped url so a stub-rendered tab is
        // judged by its original about: url). Non-syncable urls (about:blank/newtab/…)
        // are noise and never enter the log.
        if (!isUrlSyncable(unwrapStubUrl(tab.url))) {
            return;
        }

        const uid = await resolveUid(tab.id);
        if (!uid) {
            return;
        }

        const index = await getGroupRelativeIndex(tab.id, tab.windowId, groupId);

        await DeltaLog.append(DeltaLog.OPS.TAB_ADD, {
            groupId,
            tab: buildTabRecord(tab, uid, index),
        });
    } catch (e) {
        logger.onCatch('tabAdded', false)(e);
    }
}

/**
 * Record a tab content change (op `tab.modify`) - url/title/favIcon. Called from
 * tabs.js `onUpdated` after skip checks. Ignores ungrouped tabs.
 * @param {object} tab
 * @param {object} [snapshot] - A4: cache fields read SYNCHRONOUSLY at the call site
 *   (`{groupId, uid, lastModified, groupPinned, favIconUrl}`), pinned before this
 *   fire-and-forget fn awaits. Used in place of re-reading the cache, which may be torn
 *   down if the tab was removed in the meantime → garbled/empty record. Omitting it keeps
 *   the legacy live-read behaviour.
 */
export async function tabModified(tab, snapshot = null) {
    try {
        if (isApplying()) {
            return;
        }

        // suppress the async echo of a sync-APPLIED navigation: a tab the apply just navigated is
        // marked with the applied url (see markAppliedNavigation); a settle whose url MATCHES that
        // applied url is dropped so it is not re-captured and pushed back (perpetual churn). A
        // server REDIRECT to a DIFFERENT url is intentionally let through so the cloud converges to
        // the redirect target. A genuine later user navigation is NOT marked → still syncs.
        if (consumeAppliedNavigationEcho(tab.id, tab.url)) {
            return;
        }

        const groupId = snapshot?.groupId ?? Cache.getTabGroup(tab.id);
        if (!groupId) {
            return;
        }

        // see tabAdded: gate on the syncable allow-list of the unwrapped url.
        if (!isUrlSyncable(unwrapStubUrl(tab.url))) {
            return;
        }

        // prefer the uid pinned at the call site; fall back to resolve/mint if absent.
        const uid = snapshot?.uid || await resolveUid(tab.id);
        if (!uid) {
            return;
        }

        const index = await getGroupRelativeIndex(tab.id, tab.windowId, groupId);

        await DeltaLog.append(DeltaLog.OPS.TAB_MODIFY, {
            groupId,
            tab: buildTabRecord(tab, uid, index, snapshot),
        });
    } catch (e) {
        logger.onCatch('tabModified', false)(e);
    }
}

/**
 * Record a tab move (op `tab.move`). Called from tabs.js `onMoved`/`onAttached`
 * after skip checks. Carries uid + the GROUP-RELATIVE target index.
 *
 * The browser `toIndex` passed by the handler is the window-absolute destination,
 * which is meaningless to the other devices (see {@link getGroupRelativeIndex}). The
 * move has already landed by the time the handler fires, so we re-derive the tab's
 * 0-based position WITHIN its group from the live browser. If it can't be resolved we
 * OMIT `toIndex`, which replay treats as append-at-end (better than a wrong slot).
 *
 * @param {number} tabId
 * @param {number} [toIndex] - browser window-absolute index (informational only).
 */
export async function tabMoved(tabId, toIndex) {
    void toIndex;
    try {
        if (isApplying()) {
            return;
        }

        const groupId = Cache.getTabGroup(tabId);
        if (!groupId) {
            return;
        }

        const uid = await resolveUid(tabId);
        if (!uid) {
            return;
        }

        const windowId = Cache.getWindowId(groupId);
        const groupRelativeIndex = await getGroupRelativeIndex(tabId, windowId, groupId);

        const payload = {groupId, uid};
        if (Number.isInteger(groupRelativeIndex)) {
            payload.toIndex = groupRelativeIndex;
        }

        await DeltaLog.append(DeltaLog.OPS.TAB_MOVE, payload);
    } catch (e) {
        logger.onCatch('tabMoved', false)(e);
    }
}

/**
 * Record a tab removal (op `tab.remove`). Called from tabs.js `onRemoved` for
 * tracked (grouped) tabs only. The caller reads uid/groupId from the cache BEFORE
 * the cache entry is dropped and passes them in (cache is gone by send time).
 * @param {string} uid
 * @param {string} groupId
 */
export async function tabRemoved(uid, groupId) {
    try {
        if (isApplying()) {
            return;
        }

        if (!uid || !groupId) {
            return;
        }

        await DeltaLog.append(DeltaLog.OPS.TAB_REMOVE, {
            groupId,
            uid,
        });
    } catch (e) {
        logger.onCatch('tabRemoved', false)(e);
    }
}

/**
 * Record a group addition (op `group.add`). Called from groups.js `sendAdded`.
 * @param {object} group - full group record.
 */
export async function groupAdded(group) {
    try {
        if (isApplying()) {
            return;
        }

        await DeltaLog.append(DeltaLog.OPS.GROUP_ADD, {group: sanitizeGroupRecordForSync(group)});
    } catch (e) {
        logger.onCatch('groupAdded', false)(e);
    }
}

/**
 * Record a group change (op `group.modify`). Called from groups.js `sendUpdated`.
 * Carries the full group record (not just the changed keys) so replay can faithfully
 * resurrect a group deleted elsewhere.
 * @param {object} fullGroup - the full, post-update group record (incl. id).
 */
export async function groupModified(fullGroup) {
    try {
        if (isApplying()) {
            return;
        }

        await DeltaLog.append(DeltaLog.OPS.GROUP_MODIFY, {group: sanitizeGroupRecordForSync(fullGroup)});
    } catch (e) {
        logger.onCatch('groupModified', false)(e);
    }
}

/**
 * Record a group reorder (op `group.move`). Called from groups.js `move`.
 *
 * Group order is the snapshot's group-array position, so we capture the group's final
 * 0-based index in the persisted groups list. Replay applies last-writer-wins by event
 * order (see {@link module:sync/delta/replay}). Without this op a local reorder produced
 * no delta, so the cloud kept the stale order and apply reverted the local change.
 *
 * @param {string} groupId
 * @param {number} toIndex - final 0-based position of the group in the groups list.
 */
export async function groupMoved(groupId, toIndex) {
    try {
        if (isApplying()) {
            return;
        }

        if (groupId == null || !Number.isInteger(toIndex)) {
            return;
        }

        await DeltaLog.append(DeltaLog.OPS.GROUP_MOVE, {groupId, toIndex});
    } catch (e) {
        logger.onCatch('groupMoved', false)(e);
    }
}

/**
 * Record a group removal (op `group.remove`). Called from groups.js `sendRemoved`.
 * @param {string} groupId
 */
export async function groupRemoved(groupId) {
    try {
        if (isApplying()) {
            return;
        }

        await DeltaLog.append(DeltaLog.OPS.GROUP_REMOVE, {groupId});
    } catch (e) {
        logger.onCatch('groupRemoved', false)(e);
    }
}

/** The concrete set of option keys that roam (derived from constants via the predicate). */
const SYNCED_OPTION_KEYS = new Set(syncedOptionKeys(Constants.ALL_OPTION_KEYS));

/**
 * Record changes to global STG option values (op `option.set`, one event per changed
 * SYNCED key). Called from the single option-save choke point — background.js
 * `saveOptions(...)` — AFTER the values have been persisted, with the just-saved
 * key/value bag. Mirrors the tab/group capture entry points:
 *  - early-returns while a sync apply runs ({@link isApplying}) so the transport's own
 *    option writes (which go through that same `saveOptions`) are NOT re-captured into a
 *    feedback loop;
 *  - only synced keys are recorded — per-device/local keys (`sync*`, `autoBackup*`, see
 *    {@link module:sync/delta/option-keys}) never enter the log;
 *  - one `option.set` per key so replay resolves each key independently (per-key LWW).
 *
 * @param {object} savedOptions - the {key: value} bag that was just persisted.
 */
export async function optionsChanged(savedOptions) {
    try {
        if (isApplying()) {
            return;
        }

        for (const [key, value] of Object.entries(savedOptions || {})) {
            if (!SYNCED_OPTION_KEYS.has(key)) {
                continue;
            }
            await DeltaLog.append(DeltaLog.OPS.OPTION_SET, {key, value});
        }
    } catch (e) {
        logger.onCatch('optionsChanged', false)(e);
    }
}

// ---------------------------------------------------------------------------
// Global pinned tabs (window-global, NOT in any STG group). Captured into the separate
// `pinnedTabs` snapshot section via the `pinned.*` ops. Identity is the tab `uid`
// (assigned/backfilled here, since pinned tabs don't get one from the group machinery).
// URL is gated by `isUrlSyncable` (see module header) — a pinned tab whose url is pure
// noise (about:blank/newtab/…) is not worth syncing; non-trivial about: urls DO sync.
//
// DISCRIMINATOR: these entry points are only reached from tabs.js for tabs with NO
// groupId in the cache. A per-group pinned tab (one that HAS a groupId) is a group tab
// and is captured via the `tab.*` ops instead — the two never collide.
// ---------------------------------------------------------------------------

/**
 * Build the full pinned-tab record a pinned.add/modify event carries. Like
 * {@link buildTabRecord} but carries NO groupId (pinned is window-global) and NO
 * group-relative index — pinned tabs are first in the window, so their browser `index`
 * already equals their pinned-relative position. Replay re-stamps index from array order.
 * @param {object} tab - browser tab.
 * @param {string} uid
 * @param {object} [snapshot] - A4: synchronously-read cache fields pinned at the call site
 *   (`lastModified`, `favIconUrl`), used instead of re-reading the torn-down cache.
 * @returns {object}
 */
function buildPinnedRecord(tab, uid, snapshot = null) {
    const record = {
        uid,
        // decode the "unsupported URL" stub page back to the embedded original (see
        // buildTabRecord) — keeps a synced about: pinned tab on its original identity.
        url: unwrapStubUrl(tab.url),
        title: tab.title,
        cookieStoreId: tab.cookieStoreId,
        // see buildTabRecord: sanitizeFavIconUrl DROPS inline data: favicons and oversized
        // URLs, keeping only a small http(s)/moz-extension reference.
        // A4: prefer the live tab favicon, fall back to the call-site snapshot.
        favIconUrl: sanitizeFavIconUrl(tab.favIconUrl ?? snapshot?.favIconUrl),
        // A4: prefer the snapshot's lastModified (pinned at the call site), else live cache.
        lastModified: snapshot?.lastModified ?? Cache.getTabLastModified(tab.id),
    };
    if (Number.isInteger(tab.index)) {
        record.index = tab.index;
    }
    // source loaded-state (see buildTabRecord): pinned tabs are usually loaded by
    // Firefox, but we still record the live signal so `syncActivatePreviouslyActiveTabs`
    // can honor it. ALWAYS emitted explicitly (true or false) so a genuine un-load clears
    // it and the replay clobber-safety has an unambiguous value to work with.
    record.loaded = tab.discarded === false;
    return record;
}

/**
 * Record a pinned-tab addition (op `pinned.add`). Called from tabs.js when a tab is
 * created already pinned, or when an existing tab transitions to pinned (`onUpdated`
 * with `changeInfo.pinned === true`). Only URLs that {@link isUrlSyncable}
 * are recorded.
 * @param {object} tab
 */
export async function pinnedAdded(tab) {
    try {
        if (isApplying()) {
            return;
        }

        if (!isUrlSyncable(unwrapStubUrl(tab.url))) {
            return;
        }

        const uid = await resolveUid(tab.id);
        if (!uid) {
            return;
        }

        await DeltaLog.append(DeltaLog.OPS.PINNED_ADD, {
            tab: buildPinnedRecord(tab, uid),
        });
    } catch (e) {
        logger.onCatch('pinnedAdded', false)(e);
    }
}

/**
 * Record a pinned-tab content change (op `pinned.modify`) - url/title/favIcon. Called
 * from tabs.js `onUpdated` for an already-pinned tab whose content changed.
 * @param {object} tab
 * @param {object} [snapshot] - A4: cache fields read synchronously at the call site,
 *   used in place of re-reading the (possibly torn-down) cache. See {@link tabModified}.
 */
export async function pinnedModified(tab, snapshot = null) {
    try {
        if (isApplying()) {
            return;
        }

        // suppress the async echo of a sync-APPLIED navigation (see tabModified): the echo of the
        // EXACT applied pinned url is dropped, while a redirect to a DIFFERENT url is captured so
        // the cloud converges to it (rather than re-navigating the pinned tab every cycle).
        if (consumeAppliedNavigationEcho(tab.id, tab.url)) {
            return;
        }

        if (!isUrlSyncable(unwrapStubUrl(tab.url))) {
            return;
        }

        const uid = snapshot?.uid || await resolveUid(tab.id);
        if (!uid) {
            return;
        }

        await DeltaLog.append(DeltaLog.OPS.PINNED_MODIFY, {
            tab: buildPinnedRecord(tab, uid, snapshot),
        });
    } catch (e) {
        logger.onCatch('pinnedModified', false)(e);
    }
}

/**
 * Record a pinned-tab reorder (op `pinned.move`). Called from tabs.js `onMoved` for a
 * pinned tab. Carries only uid + target index per the schema. Pinned tabs are first in
 * the window, so the browser `toIndex` is already the pinned-relative position.
 * @param {number} tabId
 * @param {number} [toIndex]
 */
export async function pinnedMoved(tabId, toIndex) {
    try {
        if (isApplying()) {
            return;
        }

        const uid = await resolveUid(tabId);
        if (!uid) {
            return;
        }

        const payload = {uid};
        if (Number.isInteger(toIndex)) {
            payload.toIndex = toIndex;
        }

        await DeltaLog.append(DeltaLog.OPS.PINNED_MOVE, payload);
    } catch (e) {
        logger.onCatch('pinnedMoved', false)(e);
    }
}

/**
 * Record a pinned-tab removal (op `pinned.remove`). Called from tabs.js `onRemoved` for
 * a pinned tab, AND on the unpin transition (a tab becoming unpinned leaves the global
 * pinned set). The caller passes the uid (read from cache before it is dropped on
 * removal, or resolved live on unpin).
 * @param {string} uid
 */
export async function pinnedRemoved(uid) {
    try {
        if (isApplying()) {
            return;
        }

        if (!uid) {
            return;
        }

        await DeltaLog.append(DeltaLog.OPS.PINNED_REMOVE, {uid});
    } catch (e) {
        logger.onCatch('pinnedRemoved', false)(e);
    }
}
