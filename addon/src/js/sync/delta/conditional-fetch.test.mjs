/**
 * Standalone node test for the CONDITIONAL-FETCH fast-path logic. Like the other delta
 * tests, this is a plain `node conditional-fetch.test.mjs` script (STG has no test runner).
 *
 * The fast path is a per-sync-cycle handle (githubgist.js beginSyncCycle/commitSyncCycle):
 *   1. ONE conditional GET per cycle decides "unchanged?" — a 304 against the marker
 *      committed by the LAST SUCCESSFUL cycle, or an identical non-lock-file content
 *      fingerprint (so peers' advisory-lock churn can't defeat the fast path). The 200
 *      response body becomes the cycle's cached gist state served to every read.
 *   2. The marker {etag, fingerprint} is persisted ONLY by commitSyncCycle, which the
 *      orchestrator (delta-sync.js) calls ONLY after a fully successful cycle. Lock stamp
 *      writes / the lock delete never advance it.
 *
 * The impure halves can't be imported under node (githubgist.js pulls in browser
 * fetch/localStorage; delta-sync.js pulls in tabs/groups), so — exactly as
 * `delta-sync-helpers.test.mjs` does for buildLocalState — the small deterministic control
 * flows are re-implemented here from the same source and the test pins the contract. The
 * PURE fingerprint (fingerprint.js) is imported and exercised directly. Keep the copies in
 * sync with githubgist.js / delta-sync.js.
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs).
 */

import {contentFingerprint} from './fingerprint.js';
import {LOCK_FILE_NAME} from './layout.js';

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

// --- copy of githubgist.js per-gist sync-marker store (kept identical) -------
function makeMarkerStore() {
    let raw; // mirrors `storage[SYNC_MARKER_STORAGE_KEY]` (a JSON object, or undefined)

    const readSyncMarkerMap = () => (raw && typeof raw === 'object') ? raw : {};

    const getStoredSyncMarker = gistId => {
        const marker = gistId ? readSyncMarkerMap()[gistId] : null;
        if (marker && typeof marker === 'object' && typeof marker.fingerprint === 'string') {
            return marker;
        }
        return null;
    };

    const setStoredSyncMarker = (gistId, marker) => {
        if (!gistId || typeof marker?.fingerprint !== 'string') {
            return;
        }
        const map = readSyncMarkerMap();
        map[gistId] = {etag: marker.etag ?? null, fingerprint: marker.fingerprint};
        raw = map;
    };

    return {getStoredSyncMarker, setStoredSyncMarker, _corrupt: v => { raw = v; }};
}

// --- copy of githubgist.js beginSyncCycle / commitSyncCycle (kept identical) --
// condGet models the single conditional GET of a cycle: takes the If-None-Match etag,
// returns {status, etag, gist} or throws (transport error).
function beginSyncCycle({hasGist, condGet}, store, gistId) {
    const cycle = {unchanged: false, gist: null, etag: null};

    try {
        if (!hasGist) {
            return cycle;
        }

        const marker = store.getStoredSyncMarker(gistId);
        const {status, etag, gist} = condGet(marker?.etag);

        if (status === 304) {
            cycle.unchanged = true;
            cycle.etag = marker.etag;
            return cycle;
        }

        if (gist) {
            cycle.gist = gist;
            cycle.etag = etag;
            cycle.unchanged = !!marker && contentFingerprint(gist.files) === marker.fingerprint;
        }

        return cycle;
    } catch {
        return cycle;
    }
}

function commitSyncCycle(cycle, store, gistId) {
    if (!cycle?.gist) {
        return;
    }
    store.setStoredSyncMarker(gistId, {
        etag: cycle.etag,
        fingerprint: contentFingerprint(cycle.gist.files),
    });
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

// --- in-memory gist remote: files + a revision-derived etag ------------------
function makeRemote() {
    let rev = 0;
    const files = {};

    return {
        files,
        get etag() { return `W/"rev-${rev}"`; },
        write(name, content) {
            files[name] = {content: JSON.stringify(content)};
            rev++;
        },
        remove(name) {
            delete files[name];
            rev++;
        },
        condGet(ifNoneMatch) {
            if (ifNoneMatch && ifNoneMatch === this.etag) {
                return {status: 304, etag: this.etag, gist: null};
            }
            return {status: 200, etag: this.etag, gist: {files: {...files}}};
        },
        snapshotCycleState() {
            return {gist: {files: {...files}}, etag: this.etag};
        },
    };
}

// ======================= fingerprint (real module) ===========================
{
    const f = content => ({content});

    const base = {'STG-sync-snapshot.json': f('{"groups":[]}'), 'STG-sync-delta-a.json': f('{"events":[1]}')};

    check('fingerprint: deterministic for equal content',
        contentFingerprint(base) === contentFingerprint({...base}));

    check('fingerprint: insertion order does not matter',
        contentFingerprint({x: f('1'), y: f('2')}) === contentFingerprint({y: f('2'), x: f('1')}));

    check('fingerprint: non-lock content change changes it',
        contentFingerprint(base)
        !== contentFingerprint({...base, 'STG-sync-delta-a.json': f('{"events":[1,2]}')}));

    check('fingerprint: added file changes it',
        contentFingerprint(base) !== contentFingerprint({...base, 'STG-sync-delta-b.json': f('{}')}));

    check('fingerprint: removed file changes it',
        contentFingerprint(base) !== contentFingerprint({'STG-sync-snapshot.json': base['STG-sync-snapshot.json']}));

    check('fingerprint: the advisory-lock file is IGNORED (appear/change/disappear)',
        contentFingerprint(base) === contentFingerprint({...base, [LOCK_FILE_NAME]: f('{"deviceId":"a"}')})
        && contentFingerprint({...base, [LOCK_FILE_NAME]: f('{"deviceId":"a"}')})
            === contentFingerprint({...base, [LOCK_FILE_NAME]: f('{"deviceId":"b"}')}));

    const truncatedA = {big: {content: 'partial', truncated: true, size: 2_000_000, raw_url: 'https://x/raw/sha1/big'}};
    const truncatedB = {big: {content: 'partial', truncated: true, size: 2_000_001, raw_url: 'https://x/raw/sha2/big'}};
    check('fingerprint: truncated files fall back to size+raw_url sensitivity',
        contentFingerprint(truncatedA) !== contentFingerprint(truncatedB));

    check('fingerprint: empty/absent files map is stable',
        contentFingerprint({}) === contentFingerprint(undefined));
}

// ============================ marker store ===================================
{
    const s = makeMarkerStore();
    check('marker store: empty ⇒ null', s.getStoredSyncMarker('g1') === null);

    s.setStoredSyncMarker('g1', {etag: 'W/"a"', fingerprint: 'fp1'});
    check('marker store: round-trips per gist',
        s.getStoredSyncMarker('g1')?.etag === 'W/"a"' && s.getStoredSyncMarker('g1')?.fingerprint === 'fp1');
    check('marker store: unknown gist id ⇒ null', s.getStoredSyncMarker('g2') === null);

    s.setStoredSyncMarker('g1', {fingerprint: 'fp2'});
    check('marker store: etag is optional (fingerprint-only marker)',
        s.getStoredSyncMarker('g1')?.etag === null && s.getStoredSyncMarker('g1')?.fingerprint === 'fp2');

    s.setStoredSyncMarker('', {etag: 'W/"e"', fingerprint: 'fp'});
    s.setStoredSyncMarker('g3', {etag: 'W/"e"'});
    check('marker store: ignores empty gistId / missing fingerprint',
        s.getStoredSyncMarker('') === null && s.getStoredSyncMarker('g3') === null);

    s._corrupt({g1: 'W/"legacy-plain-etag"'});
    check('marker store: a legacy plain-string etag entry is IGNORED (forces one full cycle)',
        s.getStoredSyncMarker('g1') === null);

    s._corrupt('not-an-object');
    check('marker store: corrupt map ⇒ null (fail-safe)', s.getStoredSyncMarker('g1') === null);
}

// ===================== beginSyncCycle fail-safe ==============================
{
    const remote = makeRemote();
    remote.write('STG-sync-snapshot.json', {groups: []});

    // no marker (first sync) ⇒ changed, but the 200 body is cached for the cycle's reads
    const store1 = makeMarkerStore();
    const c1 = beginSyncCycle({hasGist: true, condGet: inm => remote.condGet(inm)}, store1, 'g');
    check('probe: no marker ⇒ changed (full fetch)', c1.unchanged === false);
    check('probe: the 200 body is cached as the cycle gist state', !!c1.gist && c1.etag === remote.etag);

    // committed marker + unchanged remote ⇒ 304
    commitSyncCycle(c1, store1, 'g');
    const c2 = beginSyncCycle({hasGist: true, condGet: inm => remote.condGet(inm)}, store1, 'g');
    check('probe: marker etag + 304 ⇒ unchanged (skip), nothing downloaded',
        c2.unchanged === true && c2.gist === null);

    // lock-only churn ⇒ 200 but fingerprint matches ⇒ unchanged + etag re-pin material
    remote.write(LOCK_FILE_NAME, {deviceId: 'peer', expiresAt: 1});
    remote.remove(LOCK_FILE_NAME);
    const c3 = beginSyncCycle({hasGist: true, condGet: inm => remote.condGet(inm)}, store1, 'g');
    check('probe: 200 with lock-only changes ⇒ unchanged via fingerprint', c3.unchanged === true);
    check('probe: fingerprint-match cycle carries the fresh etag for re-pin',
        c3.etag === remote.etag && !!c3.gist);

    // real non-lock change ⇒ changed
    remote.write('STG-sync-delta-b.json', {events: [1]});
    const c4 = beginSyncCycle({hasGist: true, condGet: inm => remote.condGet(inm)}, store1, 'g');
    check('probe: 200 with non-lock changes ⇒ changed (full fetch)', c4.unchanged === false);

    check('probe: no gist yet ⇒ changed (discovery/first sync)',
        beginSyncCycle({hasGist: false, condGet: () => ({status: 304})}, store1, 'g').unchanged === false);

    check('probe: transport error ⇒ changed (fail-safe)',
        beginSyncCycle({hasGist: true, condGet: () => { throw new Error('boom'); }}, store1, 'g')
            .unchanged === false);

    check('probe: unexpected non-304 status without body ⇒ changed',
        beginSyncCycle({hasGist: true, condGet: () => ({status: 500, etag: null, gist: null})}, store1, 'g')
            .unchanged === false);
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

// ========== marker lifecycle: committed ONLY after a fully successful cycle ==========
{
    const remote = makeRemote();
    remote.write('STG-sync-snapshot.json', {groups: []});

    // device D committed at the current revision
    const store = makeMarkerStore();
    const seed = beginSyncCycle({hasGist: true, condGet: inm => remote.condGet(inm)}, store, 'g');
    commitSyncCycle(seed, store, 'g');
    const committedMarker = store.getStoredSyncMarker('g');

    // a peer pushes revision N; D probes (200), locks (bump), then the pull/apply THROWS.
    // No commit runs on the failure path — the marker must still point at the LAST APPLIED
    // revision, so the next probe sees the peer's revision as CHANGED and re-applies it.
    remote.write('STG-sync-delta-peer.json', {events: ['unapplied']});
    const failing = beginSyncCycle({hasGist: true, condGet: inm => remote.condGet(inm)}, store, 'g');
    check('lifecycle: peer change probes as changed', failing.unchanged === false);
    remote.write(LOCK_FILE_NAME, {deviceId: 'D', expiresAt: 1});
    remote.remove(LOCK_FILE_NAME);
    check('lifecycle: failed cycle (no commit) leaves the marker at the last applied revision',
        store.getStoredSyncMarker('g') === committedMarker);

    const retry = beginSyncCycle({hasGist: true, condGet: inm => remote.condGet(inm)}, store, 'g');
    check('lifecycle: retry after a failed cycle still sees the peer revision as CHANGED',
        retry.unchanged === false && !!retry.gist);

    // the retry succeeds: pull+apply from the cycle state, then commit
    commitSyncCycle(retry, store, 'g');
    const afterRetry = beginSyncCycle({hasGist: true, condGet: inm => remote.condGet(inm)}, store, 'g');
    check('lifecycle: successful cycle commits ⇒ next probe is 304',
        afterRetry.unchanged === true && afterRetry.gist === null);

    // lock stamp + release never advance the marker (only commit writes the store)
    const beforeLockChurn = store.getStoredSyncMarker('g');
    remote.write(LOCK_FILE_NAME, {deviceId: 'peer', expiresAt: 2});
    remote.remove(LOCK_FILE_NAME);
    check('lifecycle: lock write/delete never touch the stored marker',
        store.getStoredSyncMarker('g') === beforeLockChurn);
}

// ====== steady state: ≥2 devices converge to cheap 304 probes despite lock churn ======
{
    const remote = makeRemote();
    remote.write('STG-sync-snapshot.json', {groups: ['g1']});

    const storeA = makeMarkerStore();
    const storeB = makeMarkerStore();
    const probe = store => beginSyncCycle({hasGist: true, condGet: inm => remote.condGet(inm)}, store, 'g');

    // both devices have completed a successful cycle at the current revision
    let a = probe(storeA);
    commitSyncCycle(a, storeA, 'g');
    let b = probe(storeB);
    commitSyncCycle(b, storeB, 'g');

    // A runs a full cycle with a real push: lock stamp, push, release. The commit uses the
    // PUSH-response state (the release bump lands after the commit, marker-invisible).
    remote.write(LOCK_FILE_NAME, {deviceId: 'A', expiresAt: 1});
    remote.write('STG-sync-delta-A.json', {events: [1]});
    commitSyncCycle(remote.snapshotCycleState(), storeA, 'g');
    remote.remove(LOCK_FILE_NAME);

    // B sees A's REAL change as changed (fingerprint differs), full cycle, commits
    b = probe(storeB);
    check('steady: peer data change is NEVER skipped (fingerprint mismatch ⇒ full cycle)',
        b.unchanged === false && !!b.gist);
    commitSyncCycle(b, storeB, 'g');

    // A's next probe: remote etag moved (its own lock release) ⇒ 200, but the fingerprint
    // matches ⇒ unchanged; the commit re-pins A's etag to the current revision.
    a = probe(storeA);
    check('steady: own lock-release churn probes as unchanged (fingerprint match)',
        a.unchanged === true);
    commitSyncCycle(a, storeA, 'g');

    // idle from here: every probe on every device is a cheap 304
    check('steady: A converges to 304 probes', probe(storeA).unchanged === true && probe(storeA).gist === null);
    check('steady: B converges to 304 probes', probe(storeB).unchanged === true && probe(storeB).gist === null);
}

// ===== C1: snapshot-write If-Match guard + 412 re-pull/retry-once decision ======
// Pure model of a guarded snapshot write: guard ONLY a snapshot-bearing write for which we
// already know the ETag; on 412 re-pull the current ETag and retry once.
{
    // doWrite returns the result; here it throws 'githubPreconditionFailed' for a stale If-Match.
    function writeWithSnapshotGuard({guard, hasGist, storedEtag, currentEtag}) {
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
    r = writeWithSnapshotGuard({guard: true, hasGist: true, storedEtag: 'W/"stale"', currentEtag: 'W/"current"'});
    check('snapshot guard: 412 ⇒ re-pull current ETag + retry once (succeeds)',
        r.attempts.length === 2
        && r.attempts[0] === 'W/"stale"'
        && r.attempts[1] === 'W/"current"'
        && r.result === 'ok');
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
