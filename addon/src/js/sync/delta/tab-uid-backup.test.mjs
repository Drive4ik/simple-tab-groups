/**
 * Standalone node test for the durable tab-uid backup / recovery contract.
 *
 * cache.js itself is NOT node-importable: it depends on the browser host globals
 * (Storage/self/browser) and its import chain pulls in the whole background.js
 * graph (`import('./cache.js')` fails with "Storage is not defined"). So this test
 * mirrors the exact persist/recover algorithm of cache.js
 * (setTabUid / loadTabUid / ensureTabUid — session-first, then re-persist from the
 * storage.local backup, mint only when both are empty) against in-memory mocks of
 * the session store, the in-memory cache and the storage.local backup map, then
 * drives the REAL `planSync` to prove the end-to-end property: after a session-value
 * loss, recovery from backup yields the SAME uid, so the planner produces zero
 * tabsToCreate for that tab.
 *
 * Like the sibling tests this is a plain `node tab-uid-backup.test.mjs` script with
 * no runner; it exits non-zero on the first failure.
 */

import {planSync} from './plan-sync.js';

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

function createCacheHarness() {
    let mem = {};
    let session = {};
    let backup = {};
    let minted = 0;

    function mint() {
        minted++;
        return `minted-uid-${minted}`;
    }

    function setTabUid(id, uid = null) {
        uid ||= mem[id] || mint();
        session[id] = uid;
        mem[id] = uid;
        backup[id] = uid;
        return uid;
    }

    function loadTabUid(id) {
        if (mem[id]) {
            return mem[id];
        }
        if (session[id]) {
            return mem[id] = session[id];
        }
        const backupUid = backup[id];
        if (backupUid) {
            session[id] = backupUid;
            return mem[id] = backupUid;
        }
        return undefined;
    }

    function ensureTabUid(id) {
        loadTabUid(id);
        return mem[id] || setTabUid(id);
    }

    return {
        setTabUid, loadTabUid, ensureTabUid,
        loseSession() { mem = {}; session = {}; },
        wipeAll() { mem = {}; session = {}; backup = {}; },
        peekSession(id) { return session[id]; },
        get mintCount() { return minted; },
    };
}

function planFor(localUid) {
    const url = 'http://synced-tab';
    const pulledSnapshot = {
        groups: [{id: 'g1', title: 'G1', tabs: [{uid: 'U', url, index: 0}]}],
        watermark: {},
    };
    const localState = {
        groups: [{id: 'g1', title: 'G1', tabs: [{uid: localUid, url, index: 0}]}],
    };

    return planSync({
        pulledSnapshot,
        pulledDeltaLogs: [],
        localPendingEvents: [],
        selfDeviceId: 'devSelf',
        localState,
    });
}

// ---------------------------------------------------------------------------
// 1. Baseline: a tab is stamped once, its uid lands in session + backup.
// ---------------------------------------------------------------------------
const cache = createCacheHarness();
const original = cache.ensureTabUid('T');
cache.setTabUid('T', 'U');

check('stamped uid is reachable via a plain read', cache.loadTabUid('T') === 'U');

// ---------------------------------------------------------------------------
// 2. Session-value loss (restart / bug 1818392): recovery from backup must
//    return the SAME uid and re-persist it to the session store — never mint.
// ---------------------------------------------------------------------------
cache.loseSession();
const mintedBefore = cache.mintCount;
const recovered = cache.loadTabUid('T');

check('recovery yields the SAME uid', recovered === 'U', `got ${recovered}`);
check('recovery did NOT mint a new uid', cache.mintCount === mintedBefore);
check('recovery re-persists uid to the session store', cache.peekSession('T') === 'U');

// ---------------------------------------------------------------------------
// 3. End-to-end: with the recovered uid, the REAL planner creates nothing for
//    the tab the cloud already knows about.
// ---------------------------------------------------------------------------
const recoveredPlan = planFor(recovered);
check(
    'recovered uid => zero tabsToCreate (no sync duplication)',
    !recoveredPlan.browserOps.tabsToCreate.some(t => t.uid === 'U'),
    JSON.stringify(recoveredPlan.browserOps.tabsToCreate),
);

// ---------------------------------------------------------------------------
// 4. Negative control: if the backup is ALSO gone, ensureTabUid mints a fresh
//    uid and the planner WOULD re-create the tab — proving the backup is what
//    prevents duplication (guards against a no-op recovery path).
// ---------------------------------------------------------------------------
const wiped = createCacheHarness();
wiped.setTabUid('T', 'U');
wiped.wipeAll();
const reminted = wiped.ensureTabUid('T');
check('without backup a NEW uid is minted', reminted !== 'U', `got ${reminted}`);

const remintedPlan = planFor(reminted);
check(
    'lost uid => planner re-creates the tab (duplication)',
    remintedPlan.browserOps.tabsToCreate.some(t => t.uid === 'U'),
    JSON.stringify(remintedPlan.browserOps.tabsToCreate),
);

check('original ensureTabUid returned a value', typeof original === 'string');

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
