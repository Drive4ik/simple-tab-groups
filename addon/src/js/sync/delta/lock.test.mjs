/**
 * Standalone node test for the ADVISORY DISTRIBUTED LOCK (Part A: feat sync-lock).
 *
 * Like the sibling delta tests this is a plain `node lock.test.mjs` script (STG has no test
 * runner). The lock has two halves:
 *   1. PURE decision helpers (lock.js — import-free / browser-free by contract): staleness,
 *      may-write, who-won, and the stamp shape. Imported + exercised directly.
 *   2. The impure acquire/release PROTOCOL in githubgist.js (which pulls in browser
 *      fetch/localStorage and can't load under node). Exactly as conditional-fetch.test.mjs
 *      does for beginSyncCycle, we re-implement that small control flow here over a mocked
 *      provider and pin the contract: acquire when free / not when held-fresh-by-other /
 *      acquire when expired / two racers resolve ONE winner / release clears the lock.
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs); it uses
 * node globals (process, console) the browser config bans.
 */

import {
    LOCK_TTL_MS,
    LOCK_CONFIRM_DELAY_MS,
    isLockStale,
    canWriteLock,
    didWinLock,
    makeLockStamp,
} from './lock.js';

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

// ============================ pure helpers ===================================
{
    check('LOCK_TTL_MS is 2 minutes', LOCK_TTL_MS === 120000);
    check('LOCK_CONFIRM_DELAY_MS is a short positive delay',
        LOCK_CONFIRM_DELAY_MS > 0 && LOCK_CONFIRM_DELAY_MS < LOCK_TTL_MS);

    const NOW = 1_000_000;

    // staleness
    check('isLockStale: absent lock ⇒ stale', isLockStale(null, NOW) === true);
    check('isLockStale: malformed (no expiresAt) ⇒ stale', isLockStale({deviceId: 'a'}, NOW) === true);
    check('isLockStale: NaN expiresAt ⇒ stale', isLockStale({expiresAt: 'soon'}, NOW) === true);
    check('isLockStale: future expiry ⇒ fresh', isLockStale({expiresAt: NOW + 1}, NOW) === false);
    check('isLockStale: exactly expired ⇒ stale (>=)', isLockStale({expiresAt: NOW}, NOW) === true);
    check('isLockStale: past expiry ⇒ stale', isLockStale({expiresAt: NOW - 1}, NOW) === true);

    // canWriteLock
    check('canWriteLock: free (absent) ⇒ may write',
        canWriteLock(null, 'self', NOW) === true);
    check('canWriteLock: held fresh by OTHER ⇒ may NOT write',
        canWriteLock({deviceId: 'other', expiresAt: NOW + LOCK_TTL_MS}, 'self', NOW) === false);
    check('canWriteLock: held fresh by SELF ⇒ may write (re-entrant/renew)',
        canWriteLock({deviceId: 'self', expiresAt: NOW + LOCK_TTL_MS}, 'self', NOW) === true);
    check('canWriteLock: STALE other ⇒ may write (reclaim crashed holder)',
        canWriteLock({deviceId: 'other', expiresAt: NOW - 1}, 'self', NOW) === true);

    // didWinLock
    check('didWinLock: re-read is ours ⇒ won',
        didWinLock({deviceId: 'self', expiresAt: NOW + 1}, 'self') === true);
    check('didWinLock: re-read is a peer ⇒ lost',
        didWinLock({deviceId: 'other', expiresAt: NOW + 1}, 'self') === false);
    check('didWinLock: re-read absent ⇒ lost', didWinLock(null, 'self') === false);

    // stamp
    const stamp = makeLockStamp('self', NOW);
    check('makeLockStamp: carries deviceId + server-clock expiry',
        stamp.deviceId === 'self' && stamp.expiresAt === NOW + LOCK_TTL_MS);
    const stamp2 = makeLockStamp('self', NOW, 5000);
    check('makeLockStamp: honors a custom ttl', stamp2.expiresAt === NOW + 5000);
}

// ===================== impure acquire/release protocol =======================
// A minimal in-memory model of the gist lock file + the SERVER clock, plus a faithful copy
// of githubgist.js acquireLock/releaseLock control flow (kept identical: read → canWriteLock
// → write stamp → confirm re-read → didWinLock; a failure AFTER our stamp was written
// best-effort releases it so a failed confirm can't strand the lock for the whole TTL;
// release deletes the file). The confirm "delay" is modeled by an injected onConfirmGap hook
// that lets a test simulate a peer writing in the gap; readConfirm models the confirm
// re-read and may throw to simulate a transport failure.
function makeGistLockModel({serverNow}) {
    let lockFile = null; // mirrors the LOCK_FILE_NAME content, or null when absent

    const releaseLock = () => { lockFile = null; };      // delete the lock file (idempotent)

    const acquireLock = (deviceId, {onConfirmGap = () => {}, readConfirm = () => lockFile} = {}) => {
        let stamped = false;
        try {
            const lock = lockFile;                       // 1. read (refreshes server clock IRL)
            if (!canWriteLock(lock, deviceId, serverNow)) {
                return false;                            //    held fresh by other ⇒ back off
            }
            lockFile = makeLockStamp(deviceId, serverNow); // 2. write our stamp
            stamped = true;
            onConfirmGap();                              // (confirm delay; peer may write here)
            const confirmed = readConfirm();             // 3. re-read (may throw)
            return didWinLock(confirmed, deviceId);      //    won iff still ours
        } catch {
            if (stamped) {
                releaseLock();                           // never strand our own stamp
            }
            return false;                                // fail-safe: not acquired
        }
    };

    return {
        acquireLock,
        releaseLock,
        peerWrite: deviceId => { lockFile = makeLockStamp(deviceId, serverNow); },
        seedExpired: deviceId => { lockFile = {deviceId, expiresAt: serverNow - 1}; },
        get raw() { return lockFile; },
    };
}

{
    const NOW = 5_000_000;

    // acquire when free
    const g1 = makeGistLockModel({serverNow: NOW});
    check('acquire: free lock ⇒ acquired', g1.acquireLock('A') === true);
    check('acquire: stamp is ours with server-clock TTL',
        g1.raw.deviceId === 'A' && g1.raw.expiresAt === NOW + LOCK_TTL_MS);

    // not-acquire when held fresh by another
    const g2 = makeGistLockModel({serverNow: NOW});
    g2.peerWrite('B'); // peer B holds a fresh lock
    check('acquire: held fresh by another ⇒ NOT acquired', g2.acquireLock('A') === false);
    check('acquire: a contended attempt leaves the peer lock intact',
        g2.raw.deviceId === 'B');

    // acquire when held but EXPIRED (server clock past expiresAt)
    const g3 = makeGistLockModel({serverNow: NOW});
    g3.seedExpired('B'); // peer B's lock is stale
    check('acquire: expired peer lock ⇒ reclaimed/acquired', g3.acquireLock('A') === true);
    check('acquire: reclaim rewrites the stamp to us', g3.raw.deviceId === 'A');

    // two concurrent acquirers → read-back resolves exactly ONE winner, the other backs off.
    // TRUE concurrency: both read the FREE lock before either writes (so both pass
    // canWriteLock), both write their stamp, then both do the confirm re-read. The LAST write
    // survives the file, so its owner's confirm re-read sees itself (WINS) and the other's
    // confirm re-read sees the survivor (LOSES). We model the low-level steps directly rather
    // than nesting full acquires (a nested acquire would re-read the first writer's fresh stamp
    // and back off at canWriteLock — a different, also-valid interleaving covered above).
    const g4 = makeGistLockModel({serverNow: NOW});
    // both A and B read free + decide to write (canWriteLock(null,...) === true for both)
    check('race: both racers see the lock free initially',
        canWriteLock(g4.raw, 'A', NOW) === true && canWriteLock(g4.raw, 'B', NOW) === true);
    g4.peerWrite('A'); // A writes its stamp
    g4.peerWrite('B'); // B writes last ⇒ B's stamp survives the file
    const aConfirm = didWinLock(g4.raw, 'A'); // A's confirm re-read
    const bConfirm = didWinLock(g4.raw, 'B'); // B's confirm re-read
    check('race: the racer that wrote LAST wins (B)', bConfirm === true);
    check('race: the racer whose stamp was overwritten LOSES (A)', aConfirm === false);
    check('race: exactly ONE winner (B), the other backs off',
        bConfirm === true && aConfirm === false && g4.raw.deviceId === 'B');

    // release clears the lock
    const g5 = makeGistLockModel({serverNow: NOW});
    g5.acquireLock('A');
    check('release: precondition lock is held', g5.raw !== null);
    g5.releaseLock();
    check('release: clears the lock file', g5.raw === null);
    g5.releaseLock(); // idempotent
    check('release: idempotent (second release is a no-op)', g5.raw === null);

    // after release, a peer can freely acquire
    check('release: a peer acquires the freed lock', g5.acquireLock('C') === true);

    // confirm-read failure AFTER a successful stamp: not acquired AND our stamp is
    // best-effort released, so peers are not blocked for the whole TTL by a lock
    // nobody holds.
    const g6 = makeGistLockModel({serverNow: NOW});
    const confirmFailed = g6.acquireLock('A', {readConfirm: () => { throw new Error('network down'); }});
    check('confirm failure: returns not-acquired', confirmFailed === false);
    check('confirm failure: our own stranded stamp is released', g6.raw === null);
    check('confirm failure: a peer acquires immediately (no TTL wait)', g6.acquireLock('B') === true);

    // losing the confirm race is NOT a failure: the winner's stamp must stay intact
    const g7 = makeGistLockModel({serverNow: NOW});
    const lost = g7.acquireLock('A', {onConfirmGap: () => g7.peerWrite('B')});
    check('lost race: not acquired', lost === false);
    check('lost race: the winning peer stamp is left intact (no release)', g7.raw?.deviceId === 'B');
}

// ============================ summary ========================================
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.error('FAILED:', failures.join(', '));
    process.exit(1);
}
