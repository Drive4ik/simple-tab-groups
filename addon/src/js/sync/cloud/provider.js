
import GithubGist from './githubgist.js';

/**
 * Provider-type constants. These identify which cloud backend the sync engine
 * talks to. The selected value is stored as the local (per-device) option
 * `syncProvider` (see `DEFAULT_OPTIONS` in constants.js) and is NOT part of the
 * synced payload.
 */
export const PROVIDER_GITHUB_GIST = 'github-gist';
export const PROVIDER_GOOGLE_DRIVE = 'google-drive';

/**
 * CloudProvider contract.
 *
 * The sync engine (`cloud.js`) is provider-agnostic: it only depends on the
 * methods documented below. Any new backend must implement this same contract
 * so it can be returned by `createCloudProvider()` without further changes to
 * the engine.
 *
 * @typedef {Object} CloudInfo
 * @property {string} lastUpdate - ISO 8601 timestamp of the last cloud update
 *      (e.g. `"2024-01-01T00:00:00Z"`). Used by the engine to decide the source
 *      of truth (local vs cloud).
 *
 * @typedef {Object} CloudProvider
 *
 * @property {(revision: ?string, progressFunc: ?function) => Promise<CloudInfo>} getInfo
 *      Fetch metadata about the current cloud content (optionally for a given
 *      revision). Resolves with a `CloudInfo`. Throws `Error('githubNotFound')`
 *      (provider-specific "not found" marker) when there is no cloud content yet.
 *
 * @property {(revision: ?string, withInfo: ?boolean, progressFunc: ?function) => Promise<(Object|[Object, CloudInfo])>} getContent
 *      Fetch the stored backup content. When `withInfo` is falsy, resolves with
 *      the parsed content object. When `withInfo` is truthy, resolves with the
 *      tuple `[content, info]` where `info` is a `CloudInfo`. Throws
 *      `Error('githubNotFound')` when there is no cloud content yet (the engine
 *      treats this as "first sync").
 *
 * @property {(content: Object, description: ?string, progressFunc: ?function) => Promise<CloudInfo>} setContent
 *      Upload/replace the backup content. Resolves with the resulting
 *      `CloudInfo` (notably `info.lastUpdate`, which the engine writes back to
 *      `syncLastUpdate`).
 *
 * @property {() => Promise<(boolean|undefined)>} checkToken
 *      Validate the provider credentials. Used by the options UI. Resolves
 *      (truthy/undefined) when valid; throws a provider-specific error otherwise.
 *
 * --- Multi-file (delta-era) methods (Phase P3a) -------------------------------
 * These back the hybrid snapshot + delta layout (one container holding
 * `STG-sync-snapshot.json` + per-device `STG-sync-delta-<deviceId>.json`; see
 * `.project/DESIGN_DELTA_SYNC.md` and `../delta/layout.js`). They are ADDITIVE:
 * the single-file methods above remain the contract the current `cloud.js` sync
 * flow uses. A multi-file container is located by the presence of the snapshot
 * file, so absence of the container resolves to "empty" rather than throwing.
 *
 * @property {(name: string, progressFunc: ?function, cycle: ?object) => Promise<?Object>} readFile
 *      Read+parse one named file from the container. Resolves with the parsed
 *      content, or `null` if the file (or the whole container) is absent. Large
 *      files are fetched transparently. A malformed JSON file throws
 *      `Error('githubInvalidGistContent')`. When a `cycle` handle is passed, the
 *      read is served from the cycle's cached container state (one download per
 *      sync cycle instead of one per read).
 *
 * @property {(progressFunc: ?function) => Promise<string[]>} listFiles
 *      List the names of every file in the container (`[]` if no container yet).
 *
 * @property {(prefix: string, progressFunc: ?function, cycle: ?object) => Promise<Array<{name: string, content: Object}>>} readAllMatching
 *      Read+parse every file whose name starts with `prefix` (e.g. all per-device
 *      delta logs). Resolves with `[{name, content}, ...]` (`[]` if no container).
 *      Served from the `cycle` cache like `readFile`.
 *
 * @property {(contents: Object<string, Object>, progressFunc: ?function, cycle: ?object) => Promise<CloudInfo>} writeFiles
 *      Write multiple files in a single atomic request (creating the container on
 *      first write). `contents` maps file name → content object. Resolves with the
 *      resulting `CloudInfo` taken from the write RESPONSE (no follow-up read).
 *      Updates a passed `cycle` handle's cached state with that response, so later
 *      reads and the cycle commit see exactly the revision this write produced.
 *      Per-file granularity lets concurrent devices write their own delta files
 *      without clobbering each other.
 *
 * @property {(name: string, progressFunc: ?function) => Promise<CloudInfo>} deleteFile
 *      Delete a single named file from the container. Resolves with the resulting
 *      `CloudInfo` from the write response. Throws `Error('githubNotFound')`
 *      if there is no container.
 *
 * --- Sync-cycle fast path + read cache (optimization, optional) ----------------
 * `beginSyncCycle` opens a per-cycle handle that (a) answers "did the remote change
 * since the last SUCCESSFUL cycle?" with ONE conditional request, and (b) caches the
 * container state fetched by that probe so every read in the cycle reuses it. The
 * unchanged verdict is FAIL-SAFE: `cycle.unchanged` is true ONLY on a positive
 * confirmation — the backend's conditional-request marker matched (e.g. HTTP 304), or
 * the container's non-lock-file content fingerprint is identical to the marker
 * committed by the last successful cycle (so advisory-lock churn by peers does not
 * defeat the fast path). No marker, first sync, discovery, or any transport error ⇒
 * `unchanged: false` (full fetch; correctness identical to an unconditional sync).
 *
 * The marker lifecycle is the engine's responsibility: `commitSyncCycle` persists the
 * marker for the state recorded in the cycle handle, and the engine calls it ONLY
 * after a fully successful cycle (pull+apply+push complete, or the confirmed-unchanged
 * fast path). A failed/aborted cycle never commits, so the marker always points at the
 * last revision this device actually reconciled. Lock stamp writes and the lock-file
 * delete never advance the marker (the fingerprint ignores the lock file, and
 * `releaseLock` bypasses the cycle handle).
 *
 * @property {(progressFunc: ?function) => Promise<{unchanged: boolean}>} [beginSyncCycle]
 *      Open the cycle handle. MUST NOT throw (errors resolve to `{unchanged: false}`).
 *      The handle is opaque apart from `unchanged`; thread it through the cycle's
 *      readFile/readAllMatching/writeFiles/acquireLock calls.
 *
 * @property {(cycle: ?object) => void} [commitSyncCycle]
 *      Persist the conditional-request marker for the cycle's final recorded state.
 *      Call ONLY after the cycle fully succeeded. No-op when the cycle never fetched
 *      or wrote container state (e.g. a confirmed-304 fast path with nothing to push).
 *
 * --- Advisory distributed lock (Part A, optional) -----------------------------
 * Serializes sync cycles across devices so two don't write the snapshot concurrently. Since
 * the backend has no atomic compare-and-set (a gist `If-Match` PATCH returns a bare 400), the
 * lock is ADVISORY: acquire = write-then-read-back-to-confirm; a crashed holder is reclaimed
 * via a server-clock TTL. All three methods are OPTIONAL: a provider omitting them simply runs
 * unserialized (deferred self-truncation in delta-sync.js is the data-safety backstop).
 *
 * @property {(deviceId: string, progressFunc: ?function, cycle: ?object) => Promise<boolean>} [acquireLock]
 *      Try to acquire the lock for `deviceId`. Resolves `true` iff this device now holds it,
 *      `false` if a peer holds a fresh lock or on ANY error (caller skips + retries). MUST NOT
 *      throw. A failure after the stamp write best-effort releases the own stamp so a crashed
 *      confirm cannot strand the lock for the whole TTL. The initial lock read is served from
 *      the `cycle` cache; the confirm re-read is always fresh and refreshes the cycle cache.
 *
 * @property {(progressFunc: ?function) => Promise<void>} [releaseLock]
 *      Release the lock (delete the lock file). Idempotent + best-effort; MUST NOT throw.
 *      Always call in a `finally` (success, error, and watchdog paths). Never updates the
 *      cycle handle or the conditional-request marker.
 *
 * @property {() => ?number} [getServerTimeMs]
 *      The SERVER time (ms) most recently observed from a response `Date` header, or null if
 *      none seen yet. Lets the lock judge TTLs against the backend clock, not the device's.
 *
 * Notes:
 * - `progressFunc` is an optional `(percent: number) => void` callback the
 *   provider may call to report transfer progress.
 * - Errors thrown by providers use short language-id messages (see `Lang`),
 *   which `cloud.js` wraps in `CloudError`.
 */

/**
 * Factory that returns the cloud provider instance for the given type.
 *
 * Existing GitHub Gist users (no `syncProvider`, or `syncProvider === 'github-gist'`)
 * get exactly the same `GithubGist` instance as before, so behavior is preserved.
 *
 * @param {string} providerType - one of the `PROVIDER_*` constants.
 * @param {Object} syncOptions - the resolved sync options (token, file name, ...).
 * @returns {CloudProvider}
 */
export function createCloudProvider(providerType, syncOptions) {
    switch (providerType) {
        case PROVIDER_GOOGLE_DRIVE:
            // Extension point: a later branch will return a GoogleDrive provider
            // instance here, implementing the CloudProvider contract above.
            throw new Error('cloudProviderNotImplemented');

        case PROVIDER_GITHUB_GIST:
        default:
            // Default/fallback so existing users (and unset option) keep working. The gist is
            // identified by `githubGistName` (its description); the file name is only the file
            // this provider reads/writes inside that gist. The delta layout (STG-sync-*) and the
            // Cloud backup file thus share one named gist, differing only by file name.
            return new GithubGist(
                syncOptions.githubGistToken,
                syncOptions.githubGistFileName,
                syncOptions.githubGistName
            );
    }
}
