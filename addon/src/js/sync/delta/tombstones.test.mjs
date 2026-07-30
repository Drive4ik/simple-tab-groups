/**
 * Standalone node test for the tombstone store (presence checks + GC bounds).
 * STG has no test runner: `node tombstones.test.mjs`. Exits non-zero on first failure.
 */

import {
    TOMBSTONE_MAX_ENTRIES,
    TOMBSTONE_MAX_AGE_MS,
    seedTombstones,
    serializeTombstones,
    recordTabTombstone,
    recordPinnedTombstone,
    hasTabTombstone,
    hasPinnedTombstone,
} from './tombstones.js';

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

// presence: record then query is a pure presence check (composite key for tabs, uid for pinned).
{
    const t = seedTombstones();
    recordTabTombstone(t, 'g1', 'u1', 100);
    recordPinnedTombstone(t, 'p1', 100);
    check('tab tombstone present for its (groupId,uid)', hasTabTombstone(t, 'g1', 'u1'));
    check('tab tombstone is group-scoped (same uid, other group absent)', !hasTabTombstone(t, 'g2', 'u1'));
    check('pinned tombstone present for its uid', hasPinnedTombstone(t, 'p1'));
    check('absent tab tombstone is not reported', !hasTabTombstone(t, 'g1', 'nope'));
}

// seed round-trips a serialized set.
{
    const t = seedTombstones();
    recordTabTombstone(t, 'g1', 'u1', 100);
    recordPinnedTombstone(t, 'p1', 100);
    const reseed = seedTombstones(serializeTombstones(t));
    check('serialize→seed preserves tab tombstone', hasTabTombstone(reseed, 'g1', 'u1'));
    check('serialize→seed preserves pinned tombstone', hasPinnedTombstone(reseed, 'p1'));
}

// dedup: recording the same key twice keeps a single entry, with the max ts.
{
    const t = seedTombstones();
    recordTabTombstone(t, 'g1', 'u1', 100);
    recordTabTombstone(t, 'g1', 'u1', 300);
    recordTabTombstone(t, 'g1', 'u1', 200);
    const out = serializeTombstones(t);
    const entries = out.tabs.filter(e => e.groupId === 'g1' && e.uid === 'u1');
    check('same-key tombstone is deduped to one entry', entries.length === 1, JSON.stringify(out.tabs));
    check('deduped tombstone keeps the max ts', entries[0]?.ts === 300, JSON.stringify(entries));
}

// GC count bound: never exceeds TOMBSTONE_MAX_ENTRIES; keeps the highest-ts entries.
{
    const t = seedTombstones();
    const total = TOMBSTONE_MAX_ENTRIES + 250;
    for (let i = 0; i < total; i++) {
        recordTabTombstone(t, 'g1', `u${i}`, 1000 + i);
    }
    const out = serializeTombstones(t);
    check('GC count bound holds (tabs <= MAX_ENTRIES)', out.tabs.length === TOMBSTONE_MAX_ENTRIES,
        String(out.tabs.length));
    const minTs = Math.min(...out.tabs.map(e => e.ts));
    check('GC count bound keeps the highest-ts entries', minTs === 1000 + (total - TOMBSTONE_MAX_ENTRIES),
        String(minTs));
}

// GC age bound: entries older than MAX_AGE relative to the newest ts are dropped.
{
    const t = seedTombstones();
    const newest = 10 * TOMBSTONE_MAX_AGE_MS;
    recordTabTombstone(t, 'g1', 'old', newest - TOMBSTONE_MAX_AGE_MS - 1);
    recordTabTombstone(t, 'g1', 'edge', newest - TOMBSTONE_MAX_AGE_MS);
    recordTabTombstone(t, 'g1', 'new', newest);
    const out = serializeTombstones(t);
    const uids = out.tabs.map(e => e.uid);
    check('GC age bound drops entries older than MAX_AGE', !uids.includes('old'), JSON.stringify(uids));
    check('GC age bound keeps entries within MAX_AGE', uids.includes('edge') && uids.includes('new'),
        JSON.stringify(uids));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.error('FAILURES:', failures.join(', '));
    process.exit(1);
}
