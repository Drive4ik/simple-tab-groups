/**
 * Standalone node test for the PERSISTENCE of the last-synced content marks
 * (`sync-marks.js`).
 *
 * Plain `node sync-marks.test.mjs` (STG has no test runner). `sync-marks.js` opens a
 * prefixed `localStorage` view at module scope, so the browser-dependent imports are
 * stubbed by `sync-marks.test.loader.mjs` (registered below) and the backing store is
 * installed on `globalThis.localStorage` before the first dynamic import. Re-importing the
 * module under a fresh query string against that SAME store is our background restart.
 *
 * Bug 1: capture-side marks were mutated on the object handed back by `loadContentMarks`
 * and never written anywhere, so they died with the background page while the delta log
 * they mirrored survived. A tab synced at U0, navigated to U1 (TAB_MODIFY(U1) queued), then
 * navigated BACK to U0 after a restart had its U0 capture suppressed by the reloaded U0
 * mark — the next push carried only TAB_MODIFY(U1) and the user's newest intent was
 * overwritten by their older one. The marks are now DERIVED: the stored snapshot marks
 * overlaid with the un-pushed delta events, which the log already persists. Capture
 * therefore writes nothing at all, so there is no per-title-tick storage write.
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs).
 */

import {register} from 'node:module';

register(new URL('./sync-marks.test.loader.mjs', import.meta.url));

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

const DEVICE = 'device-a';

const backing = new Map();
let writes = 0;

const store = new Proxy({}, {
    get(target, prop) {
        const raw = backing.get(prop);
        if (raw === undefined) {
            return undefined;
        }
        try {
            return JSON.parse(raw);
        } catch {
            return undefined;
        }
    },
    set(target, prop, value) {
        writes++;
        backing.set(prop, JSON.stringify(value ?? null));
        return true;
    },
    has(target, prop) {
        return backing.has(prop);
    },
    deleteProperty(target, prop) {
        backing.delete(prop);
        return true;
    },
});

globalThis.localStorage = {create: () => store};
globalThis.__deltaLogEvents = [];

let lastSeq = 0;

function appendEvent(event) {
    globalThis.__deltaLogEvents.push({seq: ++lastSeq, ...event});
}

let restarts = 0;

function restartBackground() {
    return import(`./sync-marks.js?restart=${++restarts}`);
}

const {contentMark, contentMarksFromSnapshot, isSyncedContent} = await import('./content-marks.js');

function tabRecord(uid, url, title = 'T') {
    return {uid, url, title, pinned: false};
}

/** The `tabModified` capture path, reduced to its content-mark decisions. */
async function captureTabModify(SyncMarks, uid, record) {
    const marks = await SyncMarks.loadContentMarks(DEVICE);

    if (isSyncedContent(marks, uid, record)) {
        return false;
    }

    appendEvent({op: 'tab.modify', groupId: 1, tab: record});
    SyncMarks.rememberContentMark(DEVICE, uid, contentMark(record));

    return true;
}

function resetWorld() {
    backing.clear();
    globalThis.__deltaLogEvents = [];
    lastSeq = 0;
    writes = 0;
}

/** A completed sync cycle: the pushed events fold into the snapshot marks. */
function completeSyncCycle(SyncMarks, snapshot) {
    store[SyncMarks.lastPushedSeqKey(DEVICE)] = lastSeq;
    SyncMarks.saveContentMarks(DEVICE, contentMarksFromSnapshot(snapshot));
}

// --- 1. a capture-time mark survives a background restart ------------------------------
{
    resetWorld();
    const before = await restartBackground();

    completeSyncCycle(before, {groups: [{id: 1, tabs: [tabRecord('u1', 'https://u0.test/')]}]});

    check('the synced value is recognised as already-synced content',
        await captureTabModify(before, 'u1', tabRecord('u1', 'https://u0.test/')) === false);

    check('a user navigation away from the synced value IS captured',
        await captureTabModify(before, 'u1', tabRecord('u1', 'https://u1.test/')) === true);

    check('the capture-time mark suppresses an immediate repeat of the same value',
        await captureTabModify(before, 'u1', tabRecord('u1', 'https://u1.test/')) === false);

    const after = await restartBackground();

    check('the capture-time mark still suppresses the same value after a restart',
        await captureTabModify(after, 'u1', tabRecord('u1', 'https://u1.test/')) === false,
        JSON.stringify(globalThis.__deltaLogEvents));

    check('the restart derived the mark without inventing extra events',
        globalThis.__deltaLogEvents.length === 1);
}

// --- 2. U0 -> U1 -> restart -> U0: the user's newest intent wins ------------------------
{
    resetWorld();
    const before = await restartBackground();

    completeSyncCycle(before, {groups: [{id: 1, tabs: [tabRecord('u1', 'https://u0.test/')]}]});

    await captureTabModify(before, 'u1', tabRecord('u1', 'https://u1.test/'));

    const after = await restartBackground();

    check('navigating BACK to the pre-restart value is captured, not swallowed',
        await captureTabModify(after, 'u1', tabRecord('u1', 'https://u0.test/')) === true);

    const pushed = globalThis.__deltaLogEvents.map(event => event.tab.url);

    check('the push carries U1 then U0, so the LAST write applied is the user\'s U0',
        pushed.join(',') === 'https://u1.test/,https://u0.test/', JSON.stringify(pushed));
}

// --- 3. a tab-remove capture forgets the mark, before and after a restart --------------
{
    resetWorld();
    const before = await restartBackground();

    completeSyncCycle(before, {groups: [{id: 1, tabs: [tabRecord('u1', 'https://u0.test/')]}]});

    await captureTabModify(before, 'u1', tabRecord('u1', 'https://u0.test/'));

    appendEvent({op: 'tab.remove', groupId: 1, uid: 'u1'});
    before.forgetContentMark(DEVICE, 'u1');

    check('a removed uid has no mark left in memory',
        await captureTabModify(before, 'u1', tabRecord('u1', 'https://u0.test/')) === true);

    resetWorld();
    const restarted = await restartBackground();

    completeSyncCycle(restarted, {groups: [{id: 1, tabs: [tabRecord('u1', 'https://u0.test/')]}]});
    appendEvent({op: 'tab.remove', groupId: 1, uid: 'u1'});

    const afterRestart = await restartBackground();

    check('the remove event drops the mark when it is re-derived after a restart',
        await captureTabModify(afterRestart, 'u1', tabRecord('u1', 'https://u0.test/')) === true);
}

// --- 4. no write storm: capture never touches storage ----------------------------------
{
    resetWorld();
    const SyncMarks = await restartBackground();

    completeSyncCycle(SyncMarks, {groups: [{id: 1, tabs: [tabRecord('u1', 'https://u0.test/')]}]});

    const writesAfterSync = writes;

    check('a completed sync cycle writes lastPushedSeq and the mark store once each',
        writesAfterSync === 2, `expected 2 writes, got ${writesAfterSync}`);

    for (let tick = 0; tick < 200; tick++) {
        await captureTabModify(SyncMarks, 'u1', tabRecord('u1', 'https://u0.test/', `Title ${tick}`));
    }

    check('200 title ticks add ZERO storage writes (the log is the only durable record)',
        writes === writesAfterSync, `writes went ${writesAfterSync} -> ${writes}`);

    check('a re-captured identical value appends no further event',
        await captureTabModify(SyncMarks, 'u1', tabRecord('u1', 'https://u0.test/', 'Title 199')) === false);

    check('every distinct tick was still logged once',
        globalThis.__deltaLogEvents.length === 200);
}

// --- 5. a missing or corrupt mark store falls back to capturing ------------------------
{
    for (const [name, value] of [['missing', undefined], ['a string', 'garbage'], ['an array', ['x']], ['null', null]]) {
        resetWorld();
        const SyncMarks = await restartBackground();

        if (value !== undefined) {
            store[SyncMarks.contentMarksKey(DEVICE)] = value;
        }

        check(`a mark store that is ${name} falls back to capturing`,
            await captureTabModify(SyncMarks, 'u1', tabRecord('u1', 'https://u0.test/')) === true);
    }

    resetWorld();
    const SyncMarks = await restartBackground();
    backing.set(SyncMarks.contentMarksKey(DEVICE), '{not json');

    check('an unparseable mark store falls back to capturing instead of throwing',
        await captureTabModify(SyncMarks, 'u1', tabRecord('u1', 'https://u0.test/')) === true);
}

// --- 6. the cache is not served across a device-id change ------------------------------
{
    resetWorld();
    const SyncMarks = await restartBackground();

    completeSyncCycle(SyncMarks, {groups: [{id: 1, tabs: [tabRecord('u1', 'https://u0.test/')]}]});
    await SyncMarks.loadContentMarks(DEVICE);

    const otherMarks = await SyncMarks.loadContentMarks('device-b');

    check('another device id derives its own (empty) marks',
        Object.keys(otherMarks).length === 0, JSON.stringify(otherMarks));

    SyncMarks.rememberContentMark(DEVICE, 'u1', contentMark(tabRecord('u1', 'https://x.test/')));

    check('a remember for a non-cached device id is a no-op, not a cross-device write',
        (await SyncMarks.loadContentMarks('device-b')).u1 === undefined);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
