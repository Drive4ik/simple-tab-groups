/**
 * Standalone node test for the PURE user-priority lock (`user-priority-lock.js`).
 *
 * Plain `node user-priority-lock.test.mjs` (STG has no test runner). The module is pure
 * (no `browser.*` / `constants.js`), so it imports directly. Proves the concurrency policy:
 *   - mutual exclusion: two critical sections never interleave;
 *   - FIFO ordering of the mutex;
 *   - the lock always releases even when a critical section throws;
 *   - USER mutations set the user-active signal (incl. a trailing window);
 *   - SYNC apply DEFERS when the user is active (pre-check) and when a user mutation slips
 *     in mid-wait, but RUNS when the user is idle;
 *   - the sync acquisition safety timeout DEFERS rather than blocking forever.
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs).
 */

import {
    runExclusive,
    runUserMutation,
    runSyncApply,
    beginUserMutation,
    endUserMutation,
    isUserActive,
    __resetForTests,
    DEFAULT_TRAILING_MS,
    DEFAULT_SYNC_APPLY_WATCHDOG_MS,
} from './user-priority-lock.js';

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

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run() {
    // --- mutual exclusion: overlapping critical sections never interleave ---------------
    {
        __resetForTests();
        const events = [];
        const a = runExclusive(async () => {
            events.push('a-start');
            await sleep(20);
            events.push('a-end');
        });
        const b = runExclusive(async () => {
            events.push('b-start');
            await sleep(5);
            events.push('b-end');
        });
        await Promise.all([a, b]);
        check('mutual exclusion: a fully precedes b (no interleave)',
            JSON.stringify(events) === JSON.stringify(['a-start', 'a-end', 'b-start', 'b-end']),
            JSON.stringify(events));
    }

    // --- FIFO ordering ------------------------------------------------------------------
    {
        __resetForTests();
        const order = [];
        const ps = [];
        for (let i = 0; i < 5; i++) {
            ps.push(runExclusive(async () => {
                order.push(i);
                await sleep(2);
            }));
        }
        await Promise.all(ps);
        check('FIFO: sections run in submission order',
            JSON.stringify(order) === JSON.stringify([0, 1, 2, 3, 4]), JSON.stringify(order));
    }

    // --- lock releases even when a section throws ---------------------------------------
    {
        __resetForTests();
        let secondRan = false;
        const first = runExclusive(async () => {
            throw new Error('boom');
        }).catch(e => e.message);
        const second = runExclusive(async () => {
            secondRan = true;
            return 'ok';
        });
        const firstResult = await first;
        const secondResult = await second;
        check('throwing section: caller sees its error', firstResult === 'boom', firstResult);
        check('throwing section: lock still releases, next section runs',
            secondRan && secondResult === 'ok');
    }

    // --- USER mutation sets the user-active signal --------------------------------------
    {
        __resetForTests();
        check('idle: isUserActive false before any mutation', isUserActive() === false);
        let activeDuring = false;
        const m = runUserMutation(async () => {
            activeDuring = isUserActive();
            await sleep(5);
        }, 30);
        await m;
        check('during user mutation: isUserActive true', activeDuring);
        check('right after user mutation: still active (trailing window)', isUserActive() === true);
        await sleep(45);
        check('after trailing window lapses: isUserActive false', isUserActive() === false);
    }

    // --- SYNC apply DEFERS when user active (fast pre-check) -----------------------------
    {
        __resetForTests();
        beginUserMutation(50);
        let applied = false;
        const outcome = await runSyncApply(async () => {
            applied = true;
        });
        check('sync defers when user active (pre-check): deferred true', outcome.deferred === true);
        check('sync defers when user active: apply NOT run', applied === false);
        endUserMutation(0);
    }

    // --- SYNC apply RUNS when user idle -------------------------------------------------
    {
        __resetForTests();
        let applied = false;
        const outcome = await runSyncApply(async () => {
            applied = true;
            return 42;
        });
        check('sync runs when idle: deferred false', outcome.deferred === false);
        check('sync runs when idle: apply ran', applied === true);
        check('sync runs when idle: result threaded through', outcome.result === 42);
    }

    // --- USER mutation has PRIORITY over a concurrent sync (sync defers, user runs) ------
    {
        __resetForTests();
        const events = [];
        // user starts first and holds the lock + marks active
        const user = runUserMutation(async () => {
            events.push('user-start');
            await sleep(20);
            events.push('user-end');
        }, 30);
        // sync tries to apply while user is active → must defer without running
        await sleep(2);
        const syncOutcome = await runSyncApply(async () => {
            events.push('sync-applied'); // must NOT happen
        });
        await user;
        check('user-priority: sync deferred while user mutating', syncOutcome.deferred === true);
        check('user-priority: sync apply never ran during user mutation',
            !events.includes('sync-applied'), JSON.stringify(events));
    }

    // --- SYNC acquire safety timeout DEFERS rather than blocking forever -----------------
    {
        __resetForTests();
        // Occupy the lock with a long section, but DON'T mark user-active so the fast
        // pre-check passes and sync proceeds to wait on the chain. With a tiny timeout it
        // should give up and defer.
        let longDone = false;
        const long = runExclusive(async () => {
            await sleep(60);
            longDone = true;
        });
        const outcome = await runSyncApply(async () => {
            // should never run: timeout fires first
            return 'ran';
        }, {timeoutMs: 10});
        check('sync acquire timeout: deferred true', outcome.deferred === true);
        check('sync acquire timeout: apply did not run', outcome.result === undefined);
        await long;
        check('sync acquire timeout: occupying section still completed', longDone === true);
    }

    // --- ACQUIRE TIMEOUT stops at acquisition: a long apply must finish with its result,
    //     never be misreported as deferred by the still-ticking acquire timer -------------
    {
        __resetForTests();
        const outcome = await runSyncApply(async () => {
            await sleep(40);
            return 'long-apply-result';
        }, {timeoutMs: 10});
        check('acquired apply longer than acquire timeout: deferred false', outcome.deferred === false, JSON.stringify(outcome));
        check('acquired apply longer than acquire timeout: result returned', outcome.result === 'long-apply-result');
    }

    // --- COMPLETION WATCHDOG: a never-settling apply trips the watchdog, RELEASES the lock,
    //     and a subsequent USER mutation acquires it (the post-sync UI-freeze self-recovery) --
    {
        __resetForTests();
        const events = [];
        let watchdogInfo = null;

        // sync apply whose `fn` NEVER resolves (the modeled stall). With a tiny watchdog it
        // must trip, settle the critical section, and free the lock.
        let applyEverFinished = false;
        const syncOutcome = await runSyncApply(() => {
            events.push('apply-start');
            return new Promise(() => {}).finally(() => { applyEverFinished = true; }); // never settles
        }, {
            watchdogMs: 15,
            onWatchdog: info => { watchdogInfo = info; },
        });

        check('watchdog: sync apply returns (not deferred) once watchdog trips',
            syncOutcome.deferred === false && syncOutcome.watchdog === true, JSON.stringify(syncOutcome));
        check('watchdog: onWatchdog fired with elapsedMs', watchdogInfo && typeof watchdogInfo.elapsedMs === 'number');
        check('watchdog: the in-flight apply did start', events.includes('apply-start'));
        check('watchdog: the stalled apply has NOT finished (still detached)', applyEverFinished === false);

        // CRITICAL: the lock must now be FREE, so a subsequent USER mutation acquires + runs
        // even though the prior apply is still pending forever.
        let userRan = false;
        const user = runUserMutation(async () => {
            userRan = true;
            events.push('user-ran');
        });
        // give the user mutation a chance to acquire + run.
        await Promise.race([user, sleep(100)]);
        check('watchdog: subsequent user mutation ACQUIRES the freed lock and runs', userRan === true,
            JSON.stringify(events));
    }

    // --- IDEMPOTENT RELEASE: an apply that finishes JUST BEFORE the watchdog must NOT be
    //     reported as a watchdog trip, and the lock releases exactly once (next section runs) --
    {
        __resetForTests();
        let watchdogFired = false;
        // apply completes well within the watchdog window.
        const outcome = await runSyncApply(async () => {
            await sleep(5);
            return 'done';
        }, {
            watchdogMs: 200,
            onWatchdog: () => { watchdogFired = true; },
        });
        check('idempotent: apply finishing before watchdog ⇒ normal result', outcome.deferred === false
            && outcome.result === 'done' && !outcome.watchdog, JSON.stringify(outcome));
        check('idempotent: watchdog did NOT fire for a fast apply', watchdogFired === false);

        // lock released exactly once ⇒ a following section runs normally.
        let nextRan = false;
        await runExclusive(async () => { nextRan = true; });
        check('idempotent: lock released exactly once (next section runs)', nextRan === true);
        // wait out the watchdog timer to confirm it stays a no-op after a normal completion.
        await sleep(220);
        check('idempotent: watchdog still did not fire after its deadline lapsed (settled guard)',
            watchdogFired === false);
    }

    // --- trailing window default is sane ------------------------------------------------
    {
        check('DEFAULT_TRAILING_MS is a few hundred ms',
            DEFAULT_TRAILING_MS >= 100 && DEFAULT_TRAILING_MS <= 1000, String(DEFAULT_TRAILING_MS));
        check('DEFAULT_SYNC_APPLY_WATCHDOG_MS is generous (well above a real apply)',
            DEFAULT_SYNC_APPLY_WATCHDOG_MS >= 30_000, String(DEFAULT_SYNC_APPLY_WATCHDOG_MS));
    }

    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) {
        process.exitCode = 1;
    }
}

run();
