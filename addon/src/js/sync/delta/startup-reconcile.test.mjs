/**
 * Standalone node test for the startup reconciliation planner (`startup-reconcile.js`).
 *
 * Plain `node startup-reconcile.test.mjs` (STG has no test runner). The module is pure:
 * `planStartupReconcile` inspects the local delta log's un-pushed events and, for every
 * tab record whose uid has no live local tab (background was dead when the tab closed),
 * plans the closure events the dead tab would have produced: `tab.remove` for group tabs
 * (plus the retiring `pinned.remove` for pinned-group tabs) and `pinned.remove` for
 * legacy global pinned records. Uids owned by other devices (baseline/cloud only, never
 * in the local log) and uids whose latest local event is already a remove are untouched,
 * so a second run is a no-op.
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs); it uses
 * node globals (process, console) the browser config bans.
 */

import {planStartupReconcile} from './startup-reconcile.js';

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

const PINNED_GROUP_ID = '70696e6e-6564-4000-8000-000000000001';
const isPinnedGroupId = groupId => groupId === PINNED_GROUP_ID;

function plan({events, lastPushedSeq = 0, aliveUids = []}) {
    return planStartupReconcile({
        events,
        lastPushedSeq,
        aliveUids: new Set(aliveUids),
        isPinnedGroupId,
    });
}

// --- 1. dead group-tab record in the un-pushed local log gets a tab.remove ----------
{
    const items = plan({
        events: [
            {seq: 1, op: 'tab.add', groupId: 'g1', tab: {uid: 'dead-1', url: 'https://a'}},
        ],
    });

    check('dead uid produces exactly one event', items.length === 1, JSON.stringify(items));
    check('the event is a tab.remove into the recorded group',
        items[0]?.op === 'tab.remove' && items[0]?.groupId === 'g1' && items[0]?.uid === 'dead-1',
        JSON.stringify(items[0]));
}

// --- 2. a live tab with the same uid is untouched ------------------------------------
{
    const items = plan({
        events: [
            {seq: 1, op: 'tab.add', groupId: 'g1', tab: {uid: 'alive-1', url: 'https://a'}},
            {seq: 2, op: 'tab.modify', groupId: 'g1', tab: {uid: 'alive-1', url: 'https://b'}},
        ],
        aliveUids: ['alive-1'],
    });

    check('live uid produces no events', items.length === 0, JSON.stringify(items));
}

// --- 3. uids not present in the local log (baseline/cloud only) are untouched --------
{
    const items = plan({
        events: [
            {seq: 1, op: 'tab.add', groupId: 'g1', tab: {uid: 'mine', url: 'https://a'}},
        ],
        aliveUids: ['mine'],
    });

    check('a second device\'s uid, absent from the local log, is never removed',
        items.every(item => item.uid !== 'theirs') && items.length === 0,
        JSON.stringify(items));
}

// --- 4. only un-pushed events nominate candidates ------------------------------------
{
    const items = plan({
        events: [
            {seq: 1, op: 'tab.add', groupId: 'g1', tab: {uid: 'pushed-dead', url: 'https://a'}},
            {seq: 2, op: 'tab.add', groupId: 'g1', tab: {uid: 'unpushed-dead', url: 'https://b'}},
        ],
        lastPushedSeq: 1,
    });

    check('a uid whose events are all pushed is not reconciled',
        items.every(item => item.uid !== 'pushed-dead'), JSON.stringify(items));
    check('a dead uid with an un-pushed event is reconciled',
        items.length === 1 && items[0].op === 'tab.remove' && items[0].uid === 'unpushed-dead',
        JSON.stringify(items));
}

// --- 5. second run adds nothing (idempotent) ------------------------------------------
{
    const events = [
        {seq: 1, op: 'tab.add', groupId: 'g1', tab: {uid: 'dead-1', url: 'https://a'}},
        {seq: 2, op: 'pinned.modify', tab: {uid: 'dead-pin', url: 'https://p'}},
    ];

    const firstRun = plan({events});
    check('first run emits removals for both dead records', firstRun.length === 2,
        JSON.stringify(firstRun));

    const afterFirstRun = events.concat(
        firstRun.map((item, i) => ({...item, seq: 3 + i})),
    );
    const secondRun = plan({events: afterFirstRun});
    check('second run over the appended log emits nothing', secondRun.length === 0,
        JSON.stringify(secondRun));
}

// --- 6. legacy global pinned record → pinned.remove -----------------------------------
{
    const items = plan({
        events: [
            {seq: 1, op: 'pinned.add', tab: {uid: 'pin-1', url: 'https://p'}},
            {seq: 2, op: 'pinned.move', uid: 'pin-1', toIndex: 0},
        ],
    });

    check('dead legacy pinned uid produces exactly one event', items.length === 1,
        JSON.stringify(items));
    check('the event is a pinned.remove',
        items[0]?.op === 'pinned.remove' && items[0]?.uid === 'pin-1', JSON.stringify(items[0]));
}

// --- 7. dead pinned-group tab → tab.remove + retiring pinned.remove -------------------
{
    const items = plan({
        events: [
            {seq: 1, op: 'tab.add', groupId: PINNED_GROUP_ID, tab: {uid: 'pg-1', url: 'https://p'}},
        ],
    });

    check('dead pinned-group tab produces two events', items.length === 2, JSON.stringify(items));
    check('it removes the tab from the pinned group',
        items.some(item => item.op === 'tab.remove' && item.groupId === PINNED_GROUP_ID && item.uid === 'pg-1'),
        JSON.stringify(items));
    check('it retires the migrated pinned record',
        items.some(item => item.op === 'pinned.remove' && item.uid === 'pg-1'),
        JSON.stringify(items));
}

// --- 8. the LATEST local event decides ------------------------------------------------
{
    const items = plan({
        events: [
            {seq: 1, op: 'tab.add', groupId: 'g1', tab: {uid: 'moved', url: 'https://a'}},
            {seq: 2, op: 'tab.move', groupId: 'g2', uid: 'moved', toIndex: 0},
            {seq: 3, op: 'tab.add', groupId: 'g1', tab: {uid: 'gone', url: 'https://b'}},
            {seq: 4, op: 'tab.remove', groupId: 'g1', uid: 'gone'},
        ],
    });

    check('a uid already removed by its latest event is skipped',
        items.every(item => item.uid !== 'gone'), JSON.stringify(items));
    check('a moved uid is removed from its latest group',
        items.length === 1 && items[0].op === 'tab.remove' && items[0].groupId === 'g2' && items[0].uid === 'moved',
        JSON.stringify(items));
}

// --- 9. non-tab events and uid-less events are ignored --------------------------------
{
    const items = plan({
        events: [
            {seq: 1, op: 'group.add', group: {id: 'g1', title: 'G1'}},
            {seq: 2, op: 'option.set', key: 'theme', value: 'dark'},
            {seq: 3, op: 'group.modify', group: {id: 'g1', title: 'G1', tabs: [{uid: 'embedded'}]}},
        ],
    });

    check('group/option events nominate no candidates', items.length === 0, JSON.stringify(items));
}

// --- 10. empty and missing inputs are safe --------------------------------------------
{
    check('empty log plans nothing', plan({events: []}).length === 0);
    check('missing log plans nothing', plan({events: undefined}).length === 0);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
