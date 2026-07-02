/**
 * Standalone node test for the CONDITIONAL-FETCH fast-path decision logic (feat:
 * sync-conditional-fetch). Like the other delta tests, this is a plain
 * `node conditional-fetch.test.mjs` script (STG has no test runner).
 *
 * The real decision lives in two impure places that can't be imported under node
 * (githubgist.js pulls in browser fetch/localStorage; delta-sync.js pulls in tabs/groups):
 *   1. The per-gist ETag store (githubgist.js getStoredEtag/setStoredEtag) and the
 *      FAIL-SAFE rule of `isUnchangedSince` (true ONLY on a positive 304; false on no
 *      gist / no stored etag / non-304 / any error).
 *   2. The orchestrator branch (delta-sync.js): when the remote is unchanged we SKIP
 *      pull+apply but STILL push iff this device has pending local events.
 *
 * Both are small + deterministic, so — exactly as `delta-sync-helpers.test.mjs` does for
 * buildLocalState — the pure logic is re-implemented here from the same source and the
 * test pins the contract. Keep these in sync with githubgist.js / delta-sync.js.
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs).
 */

let passed = 0;
const failures = [];

function check(name, cond, detail) {
    if (cond) {
        passed++;
        console.log(`  PASS  ${name}`);
    } else {
        failures.push(name);
        console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

// --- copy of githubgist.js per-gist ETag store (kept identical) --------------
function makeEtagStore() {
    let raw; // mirrors `storage[ETAG_STORAGE_KEY]` (a JSON object, or undefined)

    const readEtagMap = () => (raw && typeof raw === 'object') ? raw : {};

    const getStoredEtag = gistId => gistId ? (readEtagMap()[gistId] ?? null) : null;

    const setStoredEtag = (gistId, etag) => {
        if (!gistId || !etag) {
            return;
        }
        const map = readEtagMap();
        map[gistId] = etag;
        raw = map;
    };

    return {getStoredEtag, setStoredEtag, _corrupt: v => { raw = v; }};
}

// --- copy of githubgist.js isUnchangedSince decision (kept identical) --------
// FAIL-SAFE = "changed" (false). Pure model of the method's control flow: inputs are the
// resolved gist id, the stored etag, and the conditional GET outcome ({status, etag} or a
// thrown error). On 200 it captures the fresh etag as a side effect, then reports false.
function isUnchangedDecision({hasGist, storedEtag, condGet}, store, gistId) {
    try {
        if (!hasGist) {
            return false; // no gist discovered yet ⇒ full fetch
        }
        if (!storedEtag) {
            return false; // nothing to compare against ⇒ full fetch
        }
        const {status, etag} = condGet(); // may throw
        if (status === 304) {
            return true;
        }
        if (etag) {
            store.setStoredEtag(gistId, etag);
        }
        return false;
    } catch {
        return false; // transport/parse/HTTP error ⇒ fail safe to full fetch
    }
}

// --- copy of delta-sync.js orchestrator branch (kept identical) --------------
// Given the probe result + whether this device has pending local events, decide what the
// cycle does. Mirrors the `if (remoteUnchanged)` block + pushLocalPendingOnly guard.
function planCycle({remoteUnchanged, hasPending}) {
    if (!remoteUnchanged) {
        return {didFullFetch: true, didApply: 'maybe', pushed: 'maybe'};
    }
    // unchanged: skip pull/apply; push iff pending.
    return {didFullFetch: false, didApply: false, pushed: hasPending};
}

// ============================ ETag store =====================================
{
    const s = makeEtagStore();
    check('etag store: empty ⇒ null', s.getStoredEtag('g1') === null);

    s.setStoredEtag('g1', 'W/"abc"');
    check('etag store: round-trips per gist', s.getStoredEtag('g1') === 'W/"abc"');
    check('etag store: unknown gist id ⇒ null', s.getStoredEtag('g2') === null);

    s.setStoredEtag('g2', 'W/"def"');
    check('etag store: two gists coexist',
        s.getStoredEtag('g1') === 'W/"abc"' && s.getStoredEtag('g2') === 'W/"def"');

    s.setStoredEtag('g1', 'W/"xyz"');
    check('etag store: overwrite same gist', s.getStoredEtag('g1') === 'W/"xyz"');

    s.setStoredEtag('', 'W/"e"');
    s.setStoredEtag('g3', '');
    check('etag store: ignores empty gistId/etag',
        s.getStoredEtag('') === null && s.getStoredEtag('g3') === null);

    s._corrupt('not-an-object');
    check('etag store: corrupt map ⇒ null (fail-safe)', s.getStoredEtag('g1') === null);
}

// ===================== isUnchangedSince fail-safe ============================
{
    const store = makeEtagStore();

    // positive 304 confirmation ⇒ unchanged (the ONLY true case)
    check('probe: stored etag + 304 ⇒ unchanged (skip)',
        isUnchangedDecision(
            {hasGist: true, storedEtag: 'W/"a"', condGet: () => ({status: 304, etag: 'W/"a"'})},
            store, 'g',
        ) === true);

    // 200 (changed) ⇒ NOT unchanged, and the fresh etag is captured for next cycle
    const store2 = makeEtagStore();
    check('probe: 200 ⇒ changed (full fetch)',
        isUnchangedDecision(
            {hasGist: true, storedEtag: 'W/"a"', condGet: () => ({status: 200, etag: 'W/"b"'})},
            store2, 'g',
        ) === false);
    check('probe: 200 captures the fresh etag', store2.getStoredEtag('g') === 'W/"b"');

    check('probe: no gist yet ⇒ changed (full fetch / discovery)',
        isUnchangedDecision(
            {hasGist: false, storedEtag: 'W/"a"', condGet: () => ({status: 304})},
            store, 'g',
        ) === false);

    check('probe: no stored etag (first sync) ⇒ changed (full fetch)',
        isUnchangedDecision(
            {hasGist: true, storedEtag: null, condGet: () => ({status: 304})},
            store, 'g',
        ) === false);

    check('probe: transport error ⇒ changed (fail-safe)',
        isUnchangedDecision(
            {hasGist: true, storedEtag: 'W/"a"', condGet: () => { throw new Error('boom'); }},
            store, 'g',
        ) === false);

    check('probe: unexpected non-304/non-200 status ⇒ changed',
        isUnchangedDecision(
            {hasGist: true, storedEtag: 'W/"a"', condGet: () => ({status: 500, etag: null})},
            store, 'g',
        ) === false);
}

// ===================== orchestrator skip decision ============================
{
    const unchangedNoPending = planCycle({remoteUnchanged: true, hasPending: false});
    check('cycle: unchanged + no pending ⇒ skip pull/apply, no push',
        unchangedNoPending.didFullFetch === false
        && unchangedNoPending.didApply === false
        && unchangedNoPending.pushed === false);

    const unchangedPending = planCycle({remoteUnchanged: true, hasPending: true});
    check('cycle: unchanged + pending ⇒ skip pull/apply BUT still push',
        unchangedPending.didFullFetch === false
        && unchangedPending.didApply === false
        && unchangedPending.pushed === true);

    const changed = planCycle({remoteUnchanged: false, hasPending: false});
    check('cycle: changed ⇒ full fetch (pull/plan/apply/push as today)',
        changed.didFullFetch === true);

    const changedPending = planCycle({remoteUnchanged: false, hasPending: true});
    check('cycle: changed + pending ⇒ full fetch (never skipped)',
        changedPending.didFullFetch === true);
}

// ============= C2: ETag captured from the WRITE response, not a follow-up GET ===========
// The hardening fix makes a write store the ETag from its OWN response, and makes
// refreshEtagFromWrite() a no-op while that fresh write-ETag is in hand (so a follow-up GET
// can't overwrite our exact-revision marker with a third device's interleaved revision).
// Pure model of githubgist.js #patchOrCreate + refreshEtagFromWrite control flow.
{
    function makeWriter(store, gistId) {
        let haveFreshWriteEtag = false;

        // mirrors #patchOrCreate: store the ETag from the write RESPONSE and arm the suppress flag
        const write = writeResponseEtag => {
            if (writeResponseEtag) {
                store.setStoredEtag(gistId, writeResponseEtag);
                haveFreshWriteEtag = true;
            }
        };

        // mirrors refreshEtagFromWrite: skip the GET while a fresh write-ETag is in hand
        const refreshEtagFromWrite = getResponseEtag => {
            if (haveFreshWriteEtag) {
                haveFreshWriteEtag = false;
                return; // suppressed: write already pinned the exact revision
            }
            if (getResponseEtag) {
                store.setStoredEtag(gistId, getResponseEtag);
            }
        };

        return {write, refreshEtagFromWrite};
    }

    const store = makeEtagStore();
    const w = makeWriter(store, 'g');

    w.write('W/"rev-we-wrote"');
    check('write captures the write-response ETag', store.getStoredEtag('g') === 'W/"rev-we-wrote"');

    // a THIRD device wrote between our PATCH and the follow-up GET — that GET would return a
    // revision we never applied. The suppressed refresh must NOT clobber our marker.
    w.refreshEtagFromWrite('W/"third-device-rev"');
    check('refreshEtagFromWrite suppressed after a write (keeps our exact revision)',
        store.getStoredEtag('g') === 'W/"rev-we-wrote"');

    // once suppression is consumed, a later refresh (no preceding write) does fetch+store again
    w.refreshEtagFromWrite('W/"later-rev"');
    check('refreshEtagFromWrite resumes GET after the flag is consumed',
        store.getStoredEtag('g') === 'W/"later-rev"');

    // a write with no ETag in the response leaves the prior marker untouched (fail-safe)
    const store2 = makeEtagStore();
    store2.setStoredEtag('g', 'W/"prior"');
    const w2 = makeWriter(store2, 'g');
    w2.write(null);
    check('write with no response ETag leaves prior marker untouched',
        store2.getStoredEtag('g') === 'W/"prior"');
    w2.refreshEtagFromWrite('W/"fresh-from-get"');
    check('no-ETag write does NOT suppress the next refresh',
        store2.getStoredEtag('g') === 'W/"fresh-from-get"');
}

// ===== C1: snapshot-write If-Match guard + 412 re-pull/retry-once decision ======
// Pure model of githubgist.js #writeWithSnapshotGuard: guard ONLY a snapshot-bearing write
// for which we already know the ETag; on 412 re-pull the current ETag and retry once.
{
    // doWrite returns the result; here it throws 'githubPreconditionFailed' for a stale If-Match.
    function writeWithSnapshotGuard({guard, hasGist, storedEtag, currentEtag}, store, gistId) {
        const attempts = [];
        const doWrite = ifMatch => {
            attempts.push(ifMatch);
            // a 412 occurs when guarding with an If-Match that is NOT the current revision
            if (ifMatch && ifMatch !== currentEtag) {
                throw new Error('githubPreconditionFailed');
            }
            return 'ok';
        };

        const ifMatch = (guard && hasGist) ? storedEtag : null;
        if (!ifMatch) {
            return {result: doWrite(null), attempts};
        }
        try {
            return {result: doWrite(ifMatch), attempts};
        } catch (e) {
            if (e.message !== 'githubPreconditionFailed') throw e;
        }
        // re-pull current ETag, retry once
        store?.setStoredEtag?.(gistId, currentEtag);
        return {result: doWrite(currentEtag), attempts};
    }

    // first write (no gist yet) ⇒ unconditional create, no If-Match
    let r = writeWithSnapshotGuard({guard: true, hasGist: false, storedEtag: null, currentEtag: 'W/"x"'});
    check('snapshot guard: first write is unconditional (no If-Match)',
        r.attempts.length === 1 && r.attempts[0] === null && r.result === 'ok');

    // non-snapshot write (delta file) ⇒ never guarded even with a known ETag
    r = writeWithSnapshotGuard({guard: false, hasGist: true, storedEtag: 'W/"a"', currentEtag: 'W/"a"'});
    check('snapshot guard: delta-only write is unconditional (per-device files are clobber-free)',
        r.attempts.length === 1 && r.attempts[0] === null);

    // snapshot write, our ETag is current ⇒ guarded, single attempt succeeds
    r = writeWithSnapshotGuard({guard: true, hasGist: true, storedEtag: 'W/"a"', currentEtag: 'W/"a"'});
    check('snapshot guard: sends If-Match when ETag known and current',
        r.attempts.length === 1 && r.attempts[0] === 'W/"a"' && r.result === 'ok');

    // snapshot write, our ETag is stale (peer wrote) ⇒ 412 then re-pull + retry once
    const store = makeEtagStore();
    store.setStoredEtag('g', 'W/"stale"');
    r = writeWithSnapshotGuard(
        {guard: true, hasGist: true, storedEtag: 'W/"stale"', currentEtag: 'W/"current"'}, store, 'g');
    check('snapshot guard: 412 ⇒ re-pull current ETag + retry once (succeeds)',
        r.attempts.length === 2
        && r.attempts[0] === 'W/"stale"'
        && r.attempts[1] === 'W/"current"'
        && r.result === 'ok');
    check('snapshot guard: retry updates the stored ETag to the current revision',
        store.getStoredEtag('g') === 'W/"current"');
}

// ===== C3: rate-limit / precondition retry classification (cloud.js) ============
// Pure model of cloud.js syncErrorText/getRateLimitResetMs/isRetryableSyncError. The error
// can arrive as a CloudError langId (legacy) OR only in message (delta path), so both fields
// are inspected.
{
    const syncErrorText = sr => [sr?.langId, sr?.message].filter(s => typeof s === 'string').join(' ');
    const getRateLimitResetMs = sr => {
        const m = syncErrorText(sr).match(/githubRateLimit:(\d+)/);
        if (!m) return null;
        const ms = Number(m[1]);
        return Number.isFinite(ms) ? ms : null;
    };
    const isNetworkError = sr => /NetworkError|NS_ERROR_NET_/.test(syncErrorText(sr));
    const isRetryable = sr =>
        isNetworkError(sr) || getRateLimitResetMs(sr) !== null || syncErrorText(sr).includes('githubPreconditionFailed');

    check('retry: rate-limit via langId ⇒ retryable + reset parsed',
        isRetryable({langId: 'githubRateLimit:1700000000000'}) === true
        && getRateLimitResetMs({langId: 'githubRateLimit:1700000000000'}) === 1700000000000);

    check('retry: rate-limit only in message (delta path) ⇒ retryable',
        isRetryable({message: 'Error: githubRateLimit:1700000000000'}) === true
        && getRateLimitResetMs({message: 'Error: githubRateLimit:1700000000000'}) === 1700000000000);

    check('retry: secondary-limit (429-derived) reset still parsed from message',
        getRateLimitResetMs({message: 'Error: githubRateLimit:1699999999999'}) === 1699999999999);

    check('retry: precondition-failed (concurrent peer write) ⇒ retryable',
        isRetryable({message: 'Error: githubPreconditionFailed'}) === true);

    check('retry: network error ⇒ retryable, no reset',
        isRetryable({message: 'NetworkError when attempting to fetch'}) === true
        && getRateLimitResetMs({message: 'NetworkError when attempting to fetch'}) === null);

    check('retry: plain auth error ⇒ NOT retryable',
        isRetryable({langId: 'githubTokenNoAccess', message: 'Error: githubTokenNoAccess'}) === false);

    check('retry: invalid-content error ⇒ NOT retryable',
        isRetryable({message: 'Error: githubInvalidGistContent'}) === false);

    check('retry: no error text ⇒ NOT retryable / no reset',
        isRetryable({}) === false && getRateLimitResetMs({}) === null);
}

// ===== gist discovery: description match with pre-fork file-based fallback ======
// Pure model of githubgist.js #findGistByName / #getGistById. A gist is picked by
// description === gistName first; when no page has a description match, the pre-fork
// predicate (private gist whose files contain the configured fileName) adopts an
// existing upstream gist so upgrading users keep their history.
{
    const GIST_NAME = 'Simple Tab Groups';
    const FILE_NAME = 'STG-backup.json';

    const matchesGistName = g => !!g && !g.public && g.description === GIST_NAME;
    const holdsConfiguredFile = g => !!g && !g.public && !!g.files?.[FILE_NAME];

    function findGistByName(pages, perPage, page = 1, fileMatch = null) {
        const gists = pages[page - 1] ?? [];
        const named = gists.find(g => matchesGistName(g));
        if (named) {
            return named;
        }
        fileMatch ??= gists.find(g => holdsConfiguredFile(g)) ?? null;
        if (gists.length === perPage) {
            return findGistByName(pages, perPage, page + 1, fileMatch);
        }
        return fileMatch;
    }

    const isUsableById = g => matchesGistName(g) || holdsConfiguredFile(g);

    const named = {id: 'named', public: false, description: GIST_NAME, files: {}};
    const upstream = {id: 'upstream', public: false, description: 'Резервная копия', files: {[FILE_NAME]: {}}};
    const publicNamed = {id: 'pub', public: true, description: GIST_NAME, files: {[FILE_NAME]: {}}};
    const unrelated = {id: 'other', public: false, description: 'notes', files: {'todo.md': {}}};

    check('discovery: description match wins',
        findGistByName([[unrelated, named]], 30)?.id === 'named');

    check('discovery: no description match ⇒ adopts pre-fork gist holding the file',
        findGistByName([[unrelated, upstream]], 30)?.id === 'upstream');

    check('discovery: description match on a later page beats an earlier file match',
        findGistByName([[upstream, unrelated], [named]], 2)?.id === 'named');

    check('discovery: file fallback found on page 1 survives paging to the end',
        findGistByName([[upstream, unrelated], [unrelated]], 2)?.id === 'upstream');

    check('discovery: public gists are never adopted',
        findGistByName([[publicNamed]], 30) === null);

    check('discovery: nothing matches ⇒ null (create a new gist later)',
        findGistByName([[unrelated]], 30) === null);

    check('discovery: cached-id revalidation accepts an adopted pre-fork gist',
        isUsableById(upstream) === true);

    check('discovery: cached-id revalidation accepts a description-named gist',
        isUsableById(named) === true);

    check('discovery: cached-id revalidation rejects public/unrelated gists',
        isUsableById(publicNamed) === false && isUsableById(unrelated) === false);
}

// ============================ summary ========================================
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.error('FAILED:', failures.join(', '));
    process.exit(1);
}
