/**
 * Standalone node test for the delta-log FIRST-HYDRATION RACE fix (E1, data loss) and the
 * IndexedDB-backed store migration.
 *
 * Plain `node delta-log-hydration.test.mjs` (STG has no test runner). Unlike the sibling
 * delta tests, the contract under test lives INSIDE the impure `delta-log.js`
 * (`ensureLoaded()`'s lazy hydration + seq machinery), so re-implementing it would not test
 * the fix. Instead we load the REAL module and stub only its browser-dependent imports via
 * `delta-log-hydration.loader.mjs` (registered below), plus a controllable mock of
 * `browser.storage.local` and a controllable in-memory mock of the IndexedDB store.
 *
 * The bug: `ensureLoaded()`'s only guard was `if (events !== null) return`, but `events` is
 * assigned AFTER the awaited hydration read. Two concurrent first-touch callers both saw
 * `events === null`, both awaited the read, and the second OVERWROTE `events` with a fresh
 * stored array — dropping the event the first had already appended and recomputing `lastSeq`
 * from storage, so the next append reused a collided seq.
 *
 * The fix memoizes the hydration as a single in-flight promise so all first-touch callers
 * await ONE read + migration. This test drives two operations that BOTH start before the
 * hydration's read resolves, then asserts: no event lost, seq strictly monotonic (no
 * collision), and exactly one underlying read was issued (proof of memoization). It also
 * checks the reset path (clear() lets a later hydration re-run), the favicon migration, and
 * the one-time storage.local -> IndexedDB migration.
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs); it uses
 * node globals (process, console, module.register) the browser config bans.
 */

import {register} from 'node:module';

// redirect delta-log.js's browser-impure imports to tiny virtual stubs (worker-thread hook).
register(new URL('./delta-log-hydration.loader.mjs', import.meta.url));

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

/**
 * Controllable in-memory mock of the IndexedDB delta-log store (`delta-log-store.js`):
 * one entry per event keyed by seq, plus a meta record.
 *
 * `load` returns a promise that ONLY resolves when the test calls `releaseLoads()`, so two
 * concurrent first-touch callers can both be parked mid-hydration — exactly the window the
 * old guard left open. `loadCallCount` proves how many loads the module actually issued.
 * The loader stub reads/writes this object via `globalThis.__deltaLogIdb`.
 */
function makeMockIdb({meta, events = []} = {}) {
    let pendingLoadResolvers = [];
    const eventsBySeq = new Map(events.map(event => [event.seq, structuredClone(event)]));
    const mock = {
        meta: meta === undefined ? undefined : structuredClone(meta),
        loadCallCount: 0,
        saveMetaCallCount: 0,
        putEventsCallCount: 0,
        deleteUpToCallCount: 0,
        replaceEventsCallCount: 0,
        storedEvents() {
            return [...eventsBySeq.keys()].sort((a, b) => a - b).map(seq => eventsBySeq.get(seq));
        },
        async load() {
            mock.loadCallCount++;
            const snapshot = {
                meta: mock.meta === undefined ? undefined : structuredClone(mock.meta),
                events: structuredClone(mock.storedEvents()),
            };
            await new Promise(resolve => pendingLoadResolvers.push(resolve));
            return snapshot;
        },
        async saveMeta(newMeta) {
            mock.saveMetaCallCount++;
            mock.meta = structuredClone(newMeta);
        },
        async putEvents(list) {
            mock.putEventsCallCount++;
            for (const event of list) {
                eventsBySeq.set(event.seq, structuredClone(event));
            }
        },
        async deleteUpTo(seq) {
            mock.deleteUpToCallCount++;
            for (const key of [...eventsBySeq.keys()]) {
                if (key <= seq) {
                    eventsBySeq.delete(key);
                }
            }
        },
        async replaceEvents(list) {
            mock.replaceEventsCallCount++;
            eventsBySeq.clear();
            for (const event of list) {
                eventsBySeq.set(event.seq, structuredClone(event));
            }
        },
        releaseLoads() {
            const resolvers = pendingLoadResolvers;
            pendingLoadResolvers = [];
            resolvers.forEach(r => r());
        },
        async releaseLoadsSequentially() {
            while (pendingLoadResolvers.length) {
                const next = pendingLoadResolvers.shift();
                next();
                for (let i = 0; i < 50; i++) {
                    await Promise.resolve();
                }
            }
        },
        pendingLoadCount() {
            return pendingLoadResolvers.length;
        },
    };
    return mock;
}

/**
 * Mock of `browser.storage.local`, used only for the legacy-migration path now: the delta log
 * no longer writes here, but a one-time hydration reads (and then removes) a legacy
 * `syncDeltaLog` key. `get`/`remove` are immediate; counts prove the migration touched it.
 */
function makeMockStorage(initial = {}) {
    const store = {...initial};
    const mock = {
        getCallCount: 0,
        setCallCount: 0,
        removeCallCount: 0,
        async get(key) {
            mock.getCallCount++;
            const value = store[key];
            return value === undefined ? {} : {[key]: structuredClone(value)};
        },
        async set(obj) {
            mock.setCallCount++;
            Object.assign(store, structuredClone(obj));
        },
        async remove(key) {
            mock.removeCallCount++;
            delete store[key];
        },
        rawStore() {
            return store;
        },
    };
    return mock;
}

/**
 * Install a fresh IDB mock + storage.local mock + a freshly-imported delta-log module
 * (module state is per-import). `meta`/`events` seed the IndexedDB store; `storageLocal`
 * seeds the legacy storage.local store (e.g. {syncDeltaLog: {...}} to exercise migration).
 */
async function freshLog({meta, events, storageLocal = {}} = {}) {
    const idb = makeMockIdb({meta, events});
    globalThis.__deltaLogIdb = idb;
    const storage = makeMockStorage(storageLocal);
    globalThis.browser = {storage: {local: storage}};
    // cache-bust the import so each test gets pristine module-level `events`/`loadingPromise`.
    const mod = await import(`./delta-log.js?fresh=${Math.random()}`);
    return {idb, storage, mod};
}

const TEST_META = {v: 1, deviceId: 'test-device'};

// --- 1. THE RACE: two concurrent first-touch ops, both parked mid-hydration -------
{
    const {idb, mod} = await freshLog();

    // both calls enter ensureLoaded() before any load resolves.
    const p1 = mod.append(mod.OPS.GROUP_ADD, {group: {id: 1, title: 'g1'}});
    const p2 = mod.append(mod.OPS.GROUP_ADD, {group: {id: 2, title: 'g2'}});

    // let microtasks run so both callers have reached the awaited load.
    await Promise.resolve();
    await Promise.resolve();

    check('memoized hydration issues exactly ONE store load for concurrent first-touch',
        idb.loadCallCount === 1, `got ${idb.loadCallCount}`);

    // release sequentially to FORCE the lossy ordering on buggy code (2nd load's overwrite
    // lands after the 1st caller's append); a no-op past the first load on fixed code.
    await idb.releaseLoadsSequentially();
    const [e1, e2] = await Promise.all([p1, p2]);

    const all = await mod.getEvents();
    check('no event lost under the first-hydration race', all.length === 2,
        `expected 2 events, got ${all.length}`);

    const seqs = all.map(e => e.seq).sort((a, b) => a - b);
    check('no seq collision (seqs are distinct)', new Set(seqs).size === seqs.length,
        `seqs=${JSON.stringify(seqs)}`);
    check('seq is strictly monotonic from 1', seqs[0] === 1 && seqs[1] === 2,
        `seqs=${JSON.stringify(seqs)}`);
    check('both appends returned distinct events with their own seq',
        e1 && e2 && e1.seq !== e2.seq, `e1=${e1?.seq} e2=${e2?.seq}`);

    // a follow-up append continues monotonically — proves lastSeq was not rewound.
    const e3 = await mod.append(mod.OPS.GROUP_ADD, {group: {id: 3, title: 'g3'}});
    check('next append continues monotonically (lastSeq not rewound)', e3.seq === 3,
        `e3.seq=${e3.seq}`);

    check('appends persist one meta record exactly once', idb.saveMetaCallCount === 1,
        `saveMetaCallCount=${idb.saveMetaCallCount}`);
    check('all appended events are persisted per-event', idb.storedEvents().length === 3,
        JSON.stringify(idb.storedEvents().map(e => e.seq)));
}

// --- 2. concurrent append + getEvents (capture racing the transport) --------------
{
    const {idb, mod} = await freshLog();

    const pAppend = mod.append(mod.OPS.TAB_ADD, {groupId: 1, tab: {uid: 't1', url: 'https://a', title: 'A'}});
    const pRead = mod.getEvents();

    await Promise.resolve();
    await Promise.resolve();
    check('append racing getEvents still issues ONE load', idb.loadCallCount === 1,
        `got ${idb.loadCallCount}`);

    idb.releaseLoads();
    await Promise.all([pAppend, pRead]);

    const all = await mod.getEvents();
    check('append survives a concurrent first-touch getEvents', all.length === 1 && all[0].seq === 1,
        `events=${JSON.stringify(all.map(e => e.seq))}`);
}

// --- 3. hydration reads an EXISTING persisted IDB log without losing the new append --
{
    const seeded = [
        {seq: 1, ts: 1, op: 'group.add', group: {id: 1, title: 'g1'}},
        {seq: 2, ts: 2, op: 'group.add', group: {id: 2, title: 'g2'}},
    ];
    const {idb, storage, mod} = await freshLog({meta: TEST_META, events: seeded});

    const p1 = mod.append(mod.OPS.GROUP_ADD, {group: {id: 3, title: 'g3'}});
    const p2 = mod.getLastSeq();
    await Promise.resolve();
    await Promise.resolve();
    idb.releaseLoads();
    const [appended] = await Promise.all([p1, p2]);

    const all = await mod.getEvents();
    check('appends after hydrating a non-empty log keep all prior events', all.length === 3,
        `len=${all.length}`);
    check('new event seq follows the persisted max (no collision with stored seqs)',
        appended.seq === 3, `seq=${appended.seq}`);
    check('only one load for the concurrent first touch on a non-empty log',
        idb.loadCallCount === 1, `got ${idb.loadCallCount}`);
    check('hydrating from IDB does not touch storage.local',
        storage.getCallCount === 0 && storage.removeCallCount === 0,
        `get=${storage.getCallCount} remove=${storage.removeCallCount}`);
    check('an append to a log with stored meta does not rewrite the meta record',
        idb.saveMetaCallCount === 0, `saveMetaCallCount=${idb.saveMetaCallCount}`);
    check('the append persisted only the new event (no whole-log rewrite)',
        idb.putEventsCallCount === 1 && idb.replaceEventsCallCount === 0,
        `putEvents=${idb.putEventsCallCount} replaceEvents=${idb.replaceEventsCallCount}`);
}

// --- 4. favicon migration still runs exactly once on hydrate (from IDB) ------------
{
    const seeded = [
        {seq: 1, ts: 1, op: 'tab.add', groupId: 1, tab: {uid: 't1', url: 'https://a', title: 'A', favIconUrl: 'data:image/png;base64,AAAA'}},
        {seq: 2, ts: 2, op: 'tab.modify', groupId: 1, tab: {uid: 't1', url: 'https://a', title: 'B', favIconUrl: 'https://a/favicon.ico'}},
    ];
    const {idb, mod} = await freshLog({meta: TEST_META, events: seeded});

    // two concurrent first-touch reads — migration must run once, not twice.
    const p1 = mod.getEvents();
    const p2 = mod.getEvents();
    await Promise.resolve();
    await Promise.resolve();
    idb.releaseLoads();
    const [a] = await Promise.all([p1, p2]);

    check('migration strips favicons from all stored events', a.every(e => !Object.hasOwn(e.tab ?? {}, 'favIconUrl')),
        JSON.stringify(a));
    // migration rewrites the events exactly once. A second get-touch must not re-run the
    // body, so no extra write beyond the single migration rewrite.
    check('favicon migration rewrites the log exactly once (single write)', idb.putEventsCallCount === 1,
        `putEventsCallCount=${idb.putEventsCallCount}`);
    check('favicon migration strips the persisted events too',
        idb.storedEvents().every(e => !Object.hasOwn(e.tab ?? {}, 'favIconUrl')),
        JSON.stringify(idb.storedEvents()));
    check('a single load serves both concurrent first-touch reads', idb.loadCallCount === 1,
        `loadCallCount=${idb.loadCallCount}`);

    // a second touch after hydration completes must not re-hydrate (no extra load).
    await mod.getEvents();
    check('post-hydration read does not re-issue a load', idb.loadCallCount === 1,
        `loadCallCount=${idb.loadCallCount}`);
}

// --- 5. reset path: clear() lets a LATER hydration re-run cleanly ------------------
{
    const {idb, mod} = await freshLog();

    const p = mod.append(mod.OPS.GROUP_ADD, {group: {id: 1, title: 'g1'}});
    await Promise.resolve();
    idb.releaseLoads();
    await p;
    check('pre-clear: one load so far', idb.loadCallCount === 1, `got ${idb.loadCallCount}`);

    await mod.clear();
    const loadsAfterClear = idb.loadCallCount;
    check('clear() reuses the already-resolved hydration (no extra load during clear)',
        loadsAfterClear === 1, `got ${loadsAfterClear}`);
    check('clear() empties the persisted events', idb.storedEvents().length === 0,
        JSON.stringify(idb.storedEvents()));

    // clear() dropped the memoized promise, so the NEXT first touch re-runs hydration cleanly
    // (re-issues a load) rather than being short-circuited by the stale resolved promise.
    // clear() persisted the empty log, so the re-hydration reads back an empty log.
    const pRead = mod.getEvents();
    await Promise.resolve();
    await Promise.resolve();
    check('clear() dropped the memoized promise → a later first touch re-hydrates',
        idb.loadCallCount === loadsAfterClear + 1, `got ${idb.loadCallCount}`);
    idb.releaseLoads();
    check('clear() resets the log to empty', (await pRead).length === 0);
    check('clear() resets lastSeq to 0', (await mod.getLastSeq()) === 0);

    // append continues from a fresh seq 1 (hard reset semantics).
    const e = await mod.append(mod.OPS.GROUP_ADD, {group: {id: 9, title: 'g9'}});
    check('post-clear append restarts at seq 1', e.seq === 1, `seq=${e.seq}`);
}

// --- 6. a FAILED hydration is not cached forever — a later call retries -----------
{
    const idb = makeMockIdb();
    let failNext = true;
    const realLoad = idb.load.bind(idb);
    idb.load = async () => {
        if (failNext) {
            failNext = false;
            idb.loadCallCount++;
            throw new Error('store unavailable');
        }
        return realLoad();
    };
    globalThis.__deltaLogIdb = idb;
    globalThis.browser = {storage: {local: makeMockStorage()}};
    const mod = await import(`./delta-log.js?fresh=${Math.random()}`);

    let threw = false;
    try {
        await mod.getLastSeq();
    } catch {
        threw = true;
    }
    check('a failed hydration surfaces the error', threw === true);

    // a later call must RETRY (not replay the cached rejection).
    const p = mod.append(mod.OPS.GROUP_ADD, {group: {id: 1, title: 'g1'}});
    await Promise.resolve();
    await Promise.resolve();
    idb.releaseLoads();
    const e = await p;
    check('a later first touch retries after a failed hydration', e?.seq === 1, `e=${JSON.stringify(e)}`);
}

// --- 7. appendMany: one persist for a batch, sequential seqs ----------------------
{
    const {idb, mod} = await freshLog();

    const batch = [
        {op: mod.OPS.GROUP_ADD, group: {id: 1, title: 'g1'}},
        {op: 'bogus.op', group: {id: 99, title: 'skip'}},
        {op: mod.OPS.TAB_ADD, groupId: 1, tab: {uid: 'x', url: 'https://a', title: 'A'}},
        {op: mod.OPS.GROUP_ADD, group: {id: 2, title: 'g2'}},
    ];
    const validCount = 3;

    const p = mod.appendMany(batch);
    await Promise.resolve();
    await Promise.resolve();
    idb.releaseLoads();
    const appended = await p;

    check('appendMany skips invalid ops but keeps the valid ones',
        appended.length === validCount, `len=${appended.length}`);
    check('appendMany persists the whole batch in ONE write', idb.putEventsCallCount === 1,
        `putEventsCallCount=${idb.putEventsCallCount}`);

    const batchSeqs = appended.map(e => e.seq);
    check('appendMany assigns sequential seqs from 1 with no gaps',
        batchSeqs.every((s, i) => s === i + 1), `seqs=${JSON.stringify(batchSeqs)}`);
    check('appendMany preserves each item op', appended[0].op === mod.OPS.GROUP_ADD
        && appended[1].op === mod.OPS.TAB_ADD && appended[2].op === mod.OPS.GROUP_ADD,
        JSON.stringify(appended.map(e => e.op)));

    const all = await mod.getEvents();
    check('appendMany stored exactly the valid events', all.length === validCount,
        `len=${all.length}`);

    const e = await mod.append(mod.OPS.GROUP_ADD, {group: {id: 3, title: 'g3'}});
    check('a single append after appendMany continues monotonically',
        e.seq === validCount + 1, `seq=${e.seq}`);
}

// --- 8. appendMany([]) is a no-op: no persist ------------------------------------
{
    const {idb, mod} = await freshLog();

    const pRead = mod.getEvents();
    await Promise.resolve();
    await Promise.resolve();
    idb.releaseLoads();
    await pRead;

    check('hydrating an empty store issues no writes',
        idb.saveMetaCallCount === 0 && idb.putEventsCallCount === 0 && idb.replaceEventsCallCount === 0,
        `saveMeta=${idb.saveMetaCallCount} putEvents=${idb.putEventsCallCount} replaceEvents=${idb.replaceEventsCallCount}`);

    const result = await mod.appendMany([]);
    check('appendMany([]) returns an empty array', Array.isArray(result) && result.length === 0,
        JSON.stringify(result));
    check('appendMany([]) issues no write', idb.putEventsCallCount === 0,
        `putEventsCallCount=${idb.putEventsCallCount}`);
}

// --- 9. legacy storage.local -> IndexedDB migration -------------------------------
{
    const legacy = {
        syncDeltaLog: {
            v: 1,
            deviceId: 'test-device',
            events: [
                {seq: 1, ts: 1, op: 'group.add', group: {id: 1, title: 'g1'}},
                {seq: 2, ts: 2, op: 'tab.add', groupId: 1, tab: {uid: 't1', url: 'https://a', title: 'A', favIconUrl: 'data:image/png;base64,AAAA'}},
            ],
        },
    };
    const {idb, storage, mod} = await freshLog({storageLocal: legacy});

    // IDB is empty → hydration falls back to storage.local, adopts its events, saves to IDB,
    // then removes the legacy key.
    const pEvents = mod.getEvents();
    await Promise.resolve();
    idb.releaseLoads();
    const events = await pEvents;
    check('migration adopts the legacy storage.local events', events.length === 2,
        `len=${events.length}`);
    check('migration reads storage.local exactly once', storage.getCallCount === 1,
        `getCallCount=${storage.getCallCount}`);
    check('migration saves the adopted meta into IndexedDB exactly once', idb.saveMetaCallCount === 1,
        `saveMetaCallCount=${idb.saveMetaCallCount}`);
    check('migration writes the adopted events into IndexedDB exactly once', idb.replaceEventsCallCount === 1,
        `replaceEventsCallCount=${idb.replaceEventsCallCount}`);
    check('migration removes the legacy storage.local key exactly once', storage.removeCallCount === 1,
        `removeCallCount=${storage.removeCallCount}`);
    check('migration removed the legacy syncDeltaLog from storage.local',
        storage.rawStore().syncDeltaLog === undefined, JSON.stringify(storage.rawStore()));
    check('migration persisted the adopted log into the IDB store',
        idb.storedEvents().length === 2 && idb.meta?.deviceId === 'test-device',
        JSON.stringify({meta: idb.meta, events: idb.storedEvents()}));
    check('favicon strip still runs during the storage.local migration',
        events.every(e => !Object.hasOwn(e.tab ?? {}, 'favIconUrl')), JSON.stringify(events));

    // a second hydration reads from IDB and does NOT re-read or re-remove storage.local.
    const {idb: idb2, storage: storage2, mod: mod2} = await freshLog({meta: idb.meta, events: idb.storedEvents()});
    const pEvents2 = mod2.getEvents();
    await Promise.resolve();
    idb2.releaseLoads();
    const events2 = await pEvents2;
    check('second hydration reads from IndexedDB', events2.length === 2, `len=${events2.length}`);
    check('second hydration issues exactly one IDB load', idb2.loadCallCount === 1,
        `loadCallCount=${idb2.loadCallCount}`);
    check('second hydration does NOT read storage.local', storage2.getCallCount === 0,
        `getCallCount=${storage2.getCallCount}`);
    check('second hydration does NOT remove storage.local', storage2.removeCallCount === 0,
        `removeCallCount=${storage2.removeCallCount}`);
    check('second hydration does not re-write (no further migration)',
        idb2.saveMetaCallCount === 0 && idb2.putEventsCallCount === 0 && idb2.replaceEventsCallCount === 0,
        `saveMeta=${idb2.saveMetaCallCount} putEvents=${idb2.putEventsCallCount} replaceEvents=${idb2.replaceEventsCallCount}`);
}

{
    const oversizedIcon = 'data:image/png;base64,' + 'A'.repeat(60000);
    const seeded = [
        {seq: 1, ts: 1, op: 'group.modify', group: {id: 'g1', title: 'G1', iconUrl: oversizedIcon, tabs: [
            {uid: 't1', url: 'https://a', title: 'A', favIconUrl: 'data:image/png;base64,AAAA', thumbnail: 'data:image/jpeg;base64,BBBB'},
            {uid: 't2', url: 'https://b', title: 'B', favIconUrl: 'https://b/favicon.ico'},
        ]}},
        {seq: 2, ts: 2, op: 'group.add', group: {id: 'g2', title: 'G2', iconUrl: 'data:image/png;base64,small', tabs: []}},
    ];
    const {idb, mod} = await freshLog({meta: TEST_META, events: seeded});

    const p = mod.getEvents();
    await Promise.resolve();
    idb.releaseLoads();
    const events = await p;

    const migrated = events[0].group;
    check('migration strips group-event tab favicons', migrated.tabs.every(t => !Object.hasOwn(t, 'favIconUrl')),
        JSON.stringify(migrated.tabs));
    check('migration strips group-event tab thumbnails', migrated.tabs.every(t => !Object.hasOwn(t, 'thumbnail')),
        JSON.stringify(migrated.tabs));
    check('migration drops an oversized group iconUrl', !Object.hasOwn(migrated, 'iconUrl'),
        JSON.stringify(Object.keys(migrated)));
    check('migration keeps a small group iconUrl', events[1].group.iconUrl === 'data:image/png;base64,small');
    check('migration keeps group identity fields', migrated.id === 'g1' && migrated.title === 'G1' && migrated.tabs[0].url === 'https://a');
    check('group-event migration rewrites the log exactly once', idb.putEventsCallCount === 1,
        `putEventsCallCount=${idb.putEventsCallCount}`);
    check('group-event migration strips the persisted events too',
        idb.storedEvents()[0].group.tabs.every(t => !Object.hasOwn(t, 'favIconUrl') && !Object.hasOwn(t, 'thumbnail')),
        JSON.stringify(idb.storedEvents()[0].group.tabs));

    const {idb: idb2, mod: mod2} = await freshLog({meta: idb.meta, events: idb.storedEvents()});
    const p2 = mod2.getEvents();
    await Promise.resolve();
    idb2.releaseLoads();
    await p2;
    check('group-event migration is idempotent (no re-save on a clean log)',
        idb2.saveMetaCallCount === 0 && idb2.putEventsCallCount === 0 && idb2.replaceEventsCallCount === 0,
        `saveMeta=${idb2.saveMetaCallCount} putEvents=${idb2.putEventsCallCount} replaceEvents=${idb2.replaceEventsCallCount}`);
}

{
    const {idb, mod} = await freshLog();

    const p = mod.append(mod.OPS.TAB_ADD, {groupId: 1, tab: {uid: 't1', url: 'https://a', title: 'A', cookieStoreId: 'firefox-container-5'}});
    await Promise.resolve();
    idb.releaseLoads();
    await p;

    const [pending] = await mod.getEventsSince(0);
    pending.tab.cookieStoreId = 'Workbluebriefcase';
    pending.tab.url = 'mutated';

    const [rereadSince] = await mod.getEventsSince(0);
    check('getEventsSince returns clones: caller mutation never leaks into the log',
        rereadSince.tab.cookieStoreId === 'firefox-container-5' && rereadSince.tab.url === 'https://a',
        JSON.stringify(rereadSince.tab));

    const [copy] = await mod.getEvents();
    copy.tab.cookieStoreId = 'Shoppingredcart';
    const [reread] = await mod.getEvents();
    check('getEvents returns clones: caller mutation never leaks into the log',
        reread.tab.cookieStoreId === 'firefox-container-5', JSON.stringify(reread.tab));

    check('a re-read after outbound container mapping still holds the LOCAL cookieStoreId (no double-mapping)',
        rereadSince.tab.cookieStoreId.startsWith('firefox-container-'), rereadSince.tab.cookieStoreId);
}

// --- 10. a failed persist does not poison the write chain -------------------------
{
    const {idb, mod} = await freshLog();

    const pWarm = mod.getEvents();
    await Promise.resolve();
    await Promise.resolve();
    idb.releaseLoads();
    await pWarm;

    let failNextPut = true;
    const realPutEvents = idb.putEvents.bind(idb);
    idb.putEvents = async list => {
        if (failNextPut) {
            failNextPut = false;
            idb.putEventsCallCount++;
            throw new Error('disk full');
        }
        return realPutEvents(list);
    };

    let firstAppendThrew = false;
    try {
        await mod.append(mod.OPS.GROUP_ADD, {group: {id: 1, title: 'g1'}});
    } catch {
        firstAppendThrew = true;
    }
    check('a failed persist surfaces its error to the caller once', firstAppendThrew === true);

    const e2 = await mod.append(mod.OPS.GROUP_ADD, {group: {id: 2, title: 'g2'}});
    check('the write chain recovers: the next append persists', e2?.seq === 2, `e2=${JSON.stringify(e2)}`);

    const storedSeqs = idb.storedEvents().map(e => e.seq);
    check('the recovered write resyncs the event that failed to persist',
        storedSeqs.length === 2 && storedSeqs[0] === 1 && storedSeqs[1] === 2,
        `storedSeqs=${JSON.stringify(storedSeqs)}`);

    const all = await mod.getEvents();
    check('the in-memory log kept both events across the failed persist', all.length === 2,
        `len=${all.length}`);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
