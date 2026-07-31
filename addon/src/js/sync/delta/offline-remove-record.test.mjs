import {
    pendingKey,
    loadPendingOfflineRemoves,
    persistPendingOfflineRemoves,
    dropPendingOfflineRemoves,
    takePendingOfflineRemoves,
} from './offline-remove-record.js';

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

const removes = [
    {op: 'tab.remove', groupId: 'g1', uid: 'a'},
    {op: 'tab.remove', groupId: 'g1', uid: 'b'},
    {op: 'pinned.remove', uid: 'p1'},
];

// persist then load round-trips the pending batch.
{
    const store = {};
    persistPendingOfflineRemoves(store, 'devA', removes);
    check('persist writes under the device-scoped key', store[pendingKey('devA')] !== undefined);
    const loaded = loadPendingOfflineRemoves(store, 'devA');
    check('load returns the persisted batch', loaded.length === 3 && loaded[2].uid === 'p1', JSON.stringify(loaded));
}

// discard (No): drops the record, keeps nothing to apply, no re-prompt.
{
    const store = {};
    persistPendingOfflineRemoves(store, 'devA', removes);
    dropPendingOfflineRemoves(store, 'devA');
    check('discard clears the pending record', store[pendingKey('devA')] === undefined);
    check('after discard load is empty (user not re-prompted)', loadPendingOfflineRemoves(store, 'devA').length === 0);
}

// confirm (Yes): take returns the batch to apply AND clears the record.
{
    const store = {};
    persistPendingOfflineRemoves(store, 'devA', removes);
    const taken = takePendingOfflineRemoves(store, 'devA');
    check('confirm takes the batch to apply', taken.length === 3, JSON.stringify(taken));
    check('confirm clears the pending record', store[pendingKey('devA')] === undefined);
    check('after confirm load is empty (user not re-prompted)', loadPendingOfflineRemoves(store, 'devA').length === 0);
}

// per-device isolation: one device's decision does not touch another's pending batch.
{
    const store = {};
    persistPendingOfflineRemoves(store, 'devA', removes);
    persistPendingOfflineRemoves(store, 'devB', removes.slice(0, 1));
    dropPendingOfflineRemoves(store, 'devA');
    check('dropping devA leaves devB pending intact', loadPendingOfflineRemoves(store, 'devB').length === 1);
}

// empty / absent record loads as an empty batch.
{
    const store = {};
    check('absent record loads as empty', loadPendingOfflineRemoves(store, 'devA').length === 0);
    store[pendingKey('devA')] = 'not json';
    check('corrupt record loads as empty', loadPendingOfflineRemoves(store, 'devA').length === 0);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.error('FAILURES:', failures.join(', '));
    process.exit(1);
}
