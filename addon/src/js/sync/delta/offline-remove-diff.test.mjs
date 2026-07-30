import {computeOfflineRemoveEvents, baselineFromSnapshot} from './plan-sync.js';
import {replay} from './replay.js';

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

function baseline(overrides = {}) {
    return {
        tabUids: [],
        groupIds: [],
        optionKeys: [],
        pinnedUids: [],
        tabGroups: {},
        tombstones: {tabs: [], pinned: []},
        ...overrides,
    };
}

function group(id, uids) {
    return {id, tabs: uids.map((uid, index) => ({uid, url: `https://${uid}`, index}))};
}

// mirror of sync-marks.js saveBaseline/loadBaseline persisted shape (the transport is impure
// and cannot be imported under node; this reproduces the JSON round-trip for tabGroups).
const saveBaseline = b => JSON.stringify({
    tabUids: b.tabUids || [],
    groupIds: b.groupIds || [],
    optionKeys: b.optionKeys || [],
    pinnedUids: b.pinnedUids || [],
    tabGroups: b.tabGroups || {},
    tombstones: b.tombstones || {tabs: [], pinned: []},
});
const loadBaseline = raw => {
    const parsed = JSON.parse(raw);
    return {
        tabUids: new Set(parsed.tabUids || []),
        groupIds: new Set(parsed.groupIds || []),
        optionKeys: new Set(parsed.optionKeys || []),
        pinnedUids: new Set(parsed.pinnedUids || []),
        tabGroups: parsed.tabGroups && typeof parsed.tabGroups === 'object' ? parsed.tabGroups : {},
        tombstones: parsed.tombstones || {tabs: [], pinned: []},
    };
};

// ---------------------------------------------------------------------------
// baselineFromSnapshot now records a uid -> groupId map, and it survives the
// save/load JSON round-trip.
// ---------------------------------------------------------------------------
{
    const snapshot = {groups: [group('g1', ['a', 'b']), group('g2', ['c'])], pinnedTabs: []};
    const b = baselineFromSnapshot(snapshot);
    check('baselineFromSnapshot records tabGroups uid->groupId',
        b.tabGroups.a === 'g1' && b.tabGroups.b === 'g1' && b.tabGroups.c === 'g2', JSON.stringify(b.tabGroups));

    const reloaded = loadBaseline(saveBaseline(b));
    check('tabGroups survives the baseline JSON round-trip',
        reloaded.tabGroups.a === 'g1' && reloaded.tabGroups.c === 'g2', JSON.stringify(reloaded.tabGroups));
}

// ---------------------------------------------------------------------------
// Crash-restored tab present in post-restore localState -> NO remove.
// ---------------------------------------------------------------------------
{
    const b = baseline({tabUids: ['u1'], tabGroups: {u1: 'g1'}});
    const localState = {groups: [group('g1', ['u1'])], pinnedTabs: []};
    const removes = computeOfflineRemoveEvents(localState, b, {knownLocalLogUids: [], aliveUids: []});
    check('present tab -> no remove', removes.length === 0, JSON.stringify(removes));
}

// ---------------------------------------------------------------------------
// Tab live but URL-filtered / uid-unhydrated -> NO remove (guard C/D via aliveUids).
// ---------------------------------------------------------------------------
{
    const b = baseline({tabUids: ['u2'], tabGroups: {u2: 'g1'}});
    const localState = {groups: [group('g1', [])], pinnedTabs: []};
    const removes = computeOfflineRemoveEvents(localState, b, {knownLocalLogUids: [], aliveUids: ['u2']});
    check('live-but-filtered tab protected by aliveUids -> no remove', removes.length === 0, JSON.stringify(removes));
}

// ---------------------------------------------------------------------------
// baseline uid genuinely gone -> tab.remove{baseline group, uid}.
// ---------------------------------------------------------------------------
{
    const b = baseline({tabUids: ['u3'], tabGroups: {u3: 'g1'}});
    const localState = {groups: [group('g1', [])], pinnedTabs: []};
    const removes = computeOfflineRemoveEvents(localState, b, {knownLocalLogUids: [], aliveUids: []});
    check('gone tab -> exactly one tab.remove with the baseline group',
        removes.length === 1 && removes[0].op === 'tab.remove' && removes[0].groupId === 'g1' && removes[0].uid === 'u3',
        JSON.stringify(removes));
}

// ---------------------------------------------------------------------------
// uid already in logUids -> no double-emit.
// ---------------------------------------------------------------------------
{
    const b = baseline({tabUids: ['u4'], tabGroups: {u4: 'g1'}});
    const localState = {groups: [group('g1', [])], pinnedTabs: []};
    const removes = computeOfflineRemoveEvents(localState, b, {knownLocalLogUids: ['u4'], aliveUids: []});
    check('uid in local log -> no remove (dormant reconcile owns it)', removes.length === 0, JSON.stringify(removes));
}

// ---------------------------------------------------------------------------
// old baseline without tabGroups -> no removes (backward compat / self-heal).
// ---------------------------------------------------------------------------
{
    const b = baseline({tabUids: ['u5']});
    const localState = {groups: [group('g1', [])], pinnedTabs: []};
    const removes = computeOfflineRemoveEvents(localState, b, {knownLocalLogUids: [], aliveUids: []});
    check('old baseline without tabGroups -> no removes', removes.length === 0, JSON.stringify(removes));
}

// ---------------------------------------------------------------------------
// already-tombstoned (group, uid) -> no remove.
// ---------------------------------------------------------------------------
{
    const b = baseline({
        tabUids: ['u6'],
        tabGroups: {u6: 'g1'},
        tombstones: {tabs: [{groupId: 'g1', uid: 'u6', ts: 1}], pinned: []},
    });
    const localState = {groups: [group('g1', [])], pinnedTabs: []};
    const removes = computeOfflineRemoveEvents(localState, b, {knownLocalLogUids: [], aliveUids: []});
    check('already-tombstoned tab -> no remove', removes.length === 0, JSON.stringify(removes));
}

// ---------------------------------------------------------------------------
// pinned gone -> pinned.remove.
// ---------------------------------------------------------------------------
{
    const b = baseline({pinnedUids: ['p1']});
    const localState = {groups: [], pinnedTabs: []};
    const removes = computeOfflineRemoveEvents(localState, b, {knownLocalLogUids: [], aliveUids: []});
    check('gone pinned -> pinned.remove',
        removes.length === 1 && removes[0].op === 'pinned.remove' && removes[0].uid === 'p1', JSON.stringify(removes));
}

// ---------------------------------------------------------------------------
// pinned migrated into a group -> NO pinned.remove from this path (owned by the
// existing bootstrap migration retirement).
// ---------------------------------------------------------------------------
{
    const b = baseline({pinnedUids: ['p2']});
    const localState = {groups: [group('g1', ['p2'])], pinnedTabs: []};
    const removes = computeOfflineRemoveEvents(localState, b, {knownLocalLogUids: [], aliveUids: []});
    check('pinned migrated to group -> no pinned.remove here', removes.length === 0, JSON.stringify(removes));
}

// ---------------------------------------------------------------------------
// pinned still live / alive-guarded / tombstoned -> no remove.
// ---------------------------------------------------------------------------
{
    const b = baseline({pinnedUids: ['p3', 'p4', 'p5'], tombstones: {tabs: [], pinned: [{uid: 'p5', ts: 1}]}});
    const localState = {groups: [], pinnedTabs: [{uid: 'p3', url: 'https://p3', index: 0}]};
    const removes = computeOfflineRemoveEvents(localState, b, {knownLocalLogUids: [], aliveUids: ['p4']});
    check('pinned live/alive/tombstoned all skipped -> no removes', removes.length === 0, JSON.stringify(removes));
}

// ---------------------------------------------------------------------------
// Integration via replay: removed-then-reappears-in-a-DIFFERENT-group is NOT
// blocked by the (originalGroup, uid) tombstone.
// ---------------------------------------------------------------------------
{
    const snapshot = {groups: [group('g1', ['x'])], pinnedTabs: []};
    const b = baselineFromSnapshot(snapshot);

    const localGone = {groups: [group('g1', []), group('g2', [])], pinnedTabs: []};
    const removes = computeOfflineRemoveEvents(localGone, b, {knownLocalLogUids: [], aliveUids: []});
    check('integration: uid gone -> tab.remove for its original group',
        removes.length === 1 && removes[0].groupId === 'g1' && removes[0].uid === 'x', JSON.stringify(removes));

    const events = [
        {...removes[0], seq: 1, ts: 10},
        {op: 'tab.add', groupId: 'g2', tab: {uid: 'x', url: 'https://x', index: 0}, seq: 2, ts: 20},
    ];
    const {snapshot: resolved} = replay(snapshot, [{deviceId: 'devSelf', events}]);

    const g1 = resolved.groups.find(g => g.id === 'g1');
    const g2 = resolved.groups.find(g => g.id === 'g2');
    const inG1 = (g1?.tabs || []).some(t => t.uid === 'x');
    const inG2 = (g2?.tabs || []).some(t => t.uid === 'x');
    check('integration: reappearance in a different group is applied (not tombstone-blocked)',
        !inG1 && inG2, JSON.stringify({inG1, inG2}));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.error('FAILURES:', failures.join(', '));
    process.exit(1);
}
