/**
 * Standalone node test for the pure replay engine (Phase P2).
 *
 * STG has no test runner, so this is a plain node script: `node replay.test.mjs`.
 * It imports the engine directly (which is import-free / browser-free by contract)
 * and asserts every conflict rule from `.project/DESIGN_DELTA_SYNC.md`. Exits non-zero
 * on the first failed assertion so it can gate CI / a manual check.
 *
 * This file is intentionally NOT matched by eslint (config targets `addon/**\/*.js`,
 * not `.mjs`); it uses node globals (process, console) that the browser config bans.
 */

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

function tabUids(snapshot, groupId) {
    const g = snapshot.groups.find(x => x.id === groupId);
    return g ? g.tabs.map(t => t.uid) : null;
}

// ---------------------------------------------------------------------------
// 1. modify-beats-delete: a tab deleted on one device, modified on another, with
//    the modify ordered AFTER the delete, must be resurrected with the new data.
// ---------------------------------------------------------------------------
{
    const base = {
        groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://a', title: 'A'}]}],
    };
    const logs = [
        {deviceId: 'devA', events: [
            {seq: 1, ts: 100, op: 'tab.remove', groupId: 'g1', uid: 't1'},
        ]},
        {deviceId: 'devB', events: [
            {seq: 1, ts: 200, op: 'tab.modify', groupId: 'g1', tab: {uid: 't1', url: 'http://a2', title: 'A2'}},
        ]},
    ];
    const {snapshot} = replay(base, logs);
    const g1 = snapshot.groups.find(g => g.id === 'g1');
    const t1 = g1.tabs.find(t => t.uid === 't1');
    check('modify-beats-delete resurrects the tab', !!t1, 'tab t1 missing');
    check('modify-beats-delete uses the new record', t1?.url === 'http://a2' && t1?.title === 'A2',
        JSON.stringify(t1));
}

// ---------------------------------------------------------------------------
// 2. duplicate on hard index conflict: two distinct uids both target index 0 →
//    keep both; incoming takes the slot, existing shifts down.
// ---------------------------------------------------------------------------
{
    const base = {groups: [{id: 'g1', title: 'G1', tabs: []}]};
    const logs = [
        {deviceId: 'devA', events: [
            {seq: 1, ts: 100, op: 'tab.add', groupId: 'g1', tab: {uid: 't1', url: 'http://1', index: 0}},
            {seq: 2, ts: 200, op: 'tab.add', groupId: 'g1', tab: {uid: 't2', url: 'http://2', index: 0}},
        ]},
    ];
    const {snapshot} = replay(base, logs);
    const uids = tabUids(snapshot, 'g1');
    check('index conflict keeps BOTH tabs', uids.length === 2, JSON.stringify(uids));
    check('index conflict: incoming takes slot 0, existing shifts down',
        uids[0] === 't2' && uids[1] === 't1', JSON.stringify(uids));
}

// ---------------------------------------------------------------------------
// 3. tab.modify into a removed group → group recreated (fallback rule 3).
// ---------------------------------------------------------------------------
{
    const base = {
        groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://a'}]}],
    };
    const logs = [
        {deviceId: 'devA', events: [
            {seq: 1, ts: 100, op: 'group.remove', groupId: 'g1'},
        ]},
        {deviceId: 'devB', events: [
            {seq: 1, ts: 200, op: 'tab.modify', groupId: 'g1', tab: {uid: 't1', url: 'http://a2'}},
        ]},
    ];
    const {snapshot} = replay(base, logs);
    const g1 = snapshot.groups.find(g => g.id === 'g1');
    check('fallback recreates the removed group', !!g1, 'group g1 missing');
    check('fallback group holds the resurrected tab',
        g1?.tabs.length === 1 && g1.tabs[0].uid === 't1' && g1.tabs[0].url === 'http://a2',
        JSON.stringify(g1));
}

// ---------------------------------------------------------------------------
// 4. watermark dedup: an event whose seq <= base watermark for its device is skipped.
// ---------------------------------------------------------------------------
{
    const base = {
        groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://a'}]}],
        watermark: {devA: 5},
    };
    const logs = [
        {deviceId: 'devA', events: [
            // already folded — must be ignored, otherwise t1 would be removed
            {seq: 3, ts: 100, op: 'tab.remove', groupId: 'g1', uid: 't1'},
            // new — must apply
            {seq: 6, ts: 300, op: 'tab.add', groupId: 'g1', tab: {uid: 't9', url: 'http://9', index: 1}},
        ]},
    ];
    const {snapshot, watermark} = replay(base, logs);
    const uids = tabUids(snapshot, 'g1');
    check('watermark dedup skips already-folded remove', uids.includes('t1'), JSON.stringify(uids));
    check('watermark dedup still applies the new event', uids.includes('t9'), JSON.stringify(uids));
    check('watermark advances to max applied seq', watermark.devA === 6, JSON.stringify(watermark));
}

// ---------------------------------------------------------------------------
// 5. ordering across two devices by ts, tie-break by (deviceId, seq).
//    Three adds with two sharing a ts; final order must be deterministic.
// ---------------------------------------------------------------------------
{
    const base = {groups: [{id: 'g1', title: 'G1', tabs: []}]};
    const logs = [
        {deviceId: 'devB', events: [
            // same ts=100 as devA seq1; devA sorts first by deviceId
            {seq: 1, ts: 100, op: 'tab.add', groupId: 'g1', tab: {uid: 'B1', index: 99}},
        ]},
        {deviceId: 'devA', events: [
            {seq: 1, ts: 100, op: 'tab.add', groupId: 'g1', tab: {uid: 'A1', index: 99}},
            {seq: 2, ts: 50, op: 'tab.add', groupId: 'g1', tab: {uid: 'A0', index: 99}},
        ]},
    ];
    const {snapshot} = replay(base, logs);
    const uids = tabUids(snapshot, 'g1');
    // ts order: A0(ts50), then ts100 group {devA seq1 = A1, devB seq1 = B1}.
    // All append (index 99 out of range) → insertion order = A0, A1, B1.
    check('cross-device ordering by ts then (deviceId,seq)',
        JSON.stringify(uids) === JSON.stringify(['A0', 'A1', 'B1']), JSON.stringify(uids));
}

// ---------------------------------------------------------------------------
// 6a. add-of-existing behaves as modify (replaces record, no duplicate).
// ---------------------------------------------------------------------------
{
    const base = {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://old'}]}]};
    const logs = [
        {deviceId: 'devA', events: [
            {seq: 1, ts: 100, op: 'tab.add', groupId: 'g1', tab: {uid: 't1', url: 'http://new', index: 0}},
        ]},
    ];
    const {snapshot} = replay(base, logs);
    const uids = tabUids(snapshot, 'g1');
    const t1 = snapshot.groups[0].tabs.find(t => t.uid === 't1');
    check('add-of-existing does not duplicate', uids.length === 1, JSON.stringify(uids));
    check('add-of-existing replaces the record (modify semantics)', t1.url === 'http://new', t1.url);
}

// ---------------------------------------------------------------------------
// 6b. remove-of-absent is a no-op (no throw, state unchanged).
// ---------------------------------------------------------------------------
{
    const base = {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1'}]}]};
    const logs = [
        {deviceId: 'devA', events: [
            {seq: 1, ts: 100, op: 'tab.remove', groupId: 'g1', uid: 'ghost'},
        ]},
    ];
    const {snapshot} = replay(base, logs);
    const uids = tabUids(snapshot, 'g1');
    check('remove-of-absent is a no-op', JSON.stringify(uids) === JSON.stringify(['t1']), JSON.stringify(uids));
}

// ---------------------------------------------------------------------------
// purity / immutability: inputs must not be mutated.
// ---------------------------------------------------------------------------
{
    const base = {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://a'}]}], watermark: {devA: 1}};
    const baseCopy = JSON.parse(JSON.stringify(base));
    const logs = [{deviceId: 'devA', events: [{seq: 2, ts: 100, op: 'tab.remove', groupId: 'g1', uid: 't1'}]}];
    const logsCopy = JSON.parse(JSON.stringify(logs));
    replay(base, logs);
    check('replay does not mutate baseSnapshot', JSON.stringify(base) === JSON.stringify(baseCopy));
    check('replay does not mutate deltaLogs', JSON.stringify(logs) === JSON.stringify(logsCopy));
}

// ---------------------------------------------------------------------------
// TAB-ORDER REGRESSION (group-relative index): a remote tab.add must not shuffle
// the receiving side's existing tab order. Base group [A,B,C] (group-relative
// indices 0,1,2). Remote appends X (index 3) → resolved order is EXACTLY [A,B,C,X].
// ---------------------------------------------------------------------------
{
    const base = {
        groups: [{id: 'g1', title: 'G1', tabs: [
            {uid: 'A', url: 'http://a', index: 0},
            {uid: 'B', url: 'http://b', index: 1},
            {uid: 'C', url: 'http://c', index: 2},
        ]}],
    };
    const logs = [{deviceId: 'devA', events: [
        {seq: 1, ts: 100, op: 'tab.add', groupId: 'g1', tab: {uid: 'X', url: 'http://x', index: 3}},
    ]}];
    const {snapshot} = replay(base, logs);
    const uids = tabUids(snapshot, 'g1');
    check('append add: order is [A,B,C,X] not shuffled',
        JSON.stringify(uids) === JSON.stringify(['A', 'B', 'C', 'X']), JSON.stringify(uids));
    const indices = snapshot.groups[0].tabs.map(t => t.index);
    check('append add: resolved indices are 0..n-1',
        JSON.stringify(indices) === JSON.stringify([0, 1, 2, 3]), JSON.stringify(indices));
}

// ---------------------------------------------------------------------------
// A remote add in the MIDDLE (group-relative index 1) → resolved [A,X,B,C]: the
// existing tabs keep their relative order (A before B before C), no shuffle.
// ---------------------------------------------------------------------------
{
    const base = {
        groups: [{id: 'g1', title: 'G1', tabs: [
            {uid: 'A', url: 'http://a', index: 0},
            {uid: 'B', url: 'http://b', index: 1},
            {uid: 'C', url: 'http://c', index: 2},
        ]}],
    };
    const logs = [{deviceId: 'devA', events: [
        {seq: 1, ts: 100, op: 'tab.add', groupId: 'g1', tab: {uid: 'X', url: 'http://x', index: 1}},
    ]}];
    const {snapshot} = replay(base, logs);
    const uids = tabUids(snapshot, 'g1');
    check('mid add: resolved order is [A,X,B,C]',
        JSON.stringify(uids) === JSON.stringify(['A', 'X', 'B', 'C']), JSON.stringify(uids));
    // existing tabs keep relative order
    const existing = uids.filter(u => u !== 'X');
    check('mid add: existing tabs keep relative order [A,B,C]',
        JSON.stringify(existing) === JSON.stringify(['A', 'B', 'C']), JSON.stringify(existing));
}

// ---------------------------------------------------------------------------
// Missing index on add ⇒ append-at-end (clamp), still no shuffle: [A,B,Y].
// ---------------------------------------------------------------------------
{
    const base = {
        groups: [{id: 'g1', title: 'G1', tabs: [
            {uid: 'A', url: 'http://a', index: 0},
            {uid: 'B', url: 'http://b', index: 1},
        ]}],
    };
    const logs = [{deviceId: 'devA', events: [
        {seq: 1, ts: 100, op: 'tab.add', groupId: 'g1', tab: {uid: 'Y', url: 'http://y'}}, // no index
    ]}];
    const {snapshot} = replay(base, logs);
    const uids = tabUids(snapshot, 'g1');
    check('missing-index add: appended -> [A,B,Y]',
        JSON.stringify(uids) === JSON.stringify(['A', 'B', 'Y']), JSON.stringify(uids));
}

// ---------------------------------------------------------------------------
// option.set: two devices set the SAME key at different ts ⇒ later ts wins (LWW).
// ---------------------------------------------------------------------------
{
    const base = {groups: [], options: {}};
    const logs = [
        {deviceId: 'devA', events: [
            {seq: 1, ts: 100, op: 'option.set', key: 'colorScheme', value: 'light'},
        ]},
        {deviceId: 'devB', events: [
            {seq: 1, ts: 200, op: 'option.set', key: 'colorScheme', value: 'dark'},
        ]},
    ];
    const {snapshot} = replay(base, logs);
    check('option.set LWW: later ts wins', snapshot.options.colorScheme === 'dark',
        JSON.stringify(snapshot.options));
}

// reverse the ts: the other device wins, proving it's ts-driven not order-of-supply
{
    const base = {groups: [], options: {}};
    const logs = [
        {deviceId: 'devB', events: [
            {seq: 1, ts: 300, op: 'option.set', key: 'colorScheme', value: 'dark'},
        ]},
        {deviceId: 'devA', events: [
            {seq: 1, ts: 400, op: 'option.set', key: 'colorScheme', value: 'auto'},
        ]},
    ];
    const {snapshot} = replay(base, logs);
    check('option.set LWW: highest ts wins regardless of log order',
        snapshot.options.colorScheme === 'auto', JSON.stringify(snapshot.options));
}

// object-valued option (hotkeys / defaultGroupProps) resolves by LWW too
{
    const base = {groups: [], options: {defaultGroupProps: {iconColor: 'red'}}};
    const logs = [
        {deviceId: 'devA', events: [
            {seq: 1, ts: 500, op: 'option.set', key: 'defaultGroupProps', value: {iconColor: 'blue'}},
        ]},
    ];
    const {snapshot} = replay(base, logs);
    check('option.set: object value overrides base by LWW',
        JSON.stringify(snapshot.options.defaultGroupProps) === JSON.stringify({iconColor: 'blue'}),
        JSON.stringify(snapshot.options));
}

// base snapshot options are seeded when no events touch a key
{
    const base = {groups: [], options: {fullPopupWidth: true}};
    const {snapshot} = replay(base, []);
    check('option.set: base options seeded into resolved when untouched',
        snapshot.options.fullPopupWidth === true, JSON.stringify(snapshot.options));
}

// empty: resolved.options is {} when no base options and no option events
{
    const {snapshot} = replay({groups: []}, [{deviceId: 'devA', events: [
        {seq: 1, ts: 1, op: 'tab.add', groupId: 'g1', tab: {uid: 't1', url: 'http://a'}},
    ]}]);
    check('option.set: resolved.options is {} when nothing sets an option',
        snapshot.options && Object.keys(snapshot.options).length === 0, JSON.stringify(snapshot.options));
}

// ---------------------------------------------------------------------------
// PINNED TABS — fold into the separate global `pinnedTabs` array (identity = uid).
// ---------------------------------------------------------------------------

function pinnedUids(snapshot) {
    return (snapshot.pinnedTabs || []).map(t => t.uid);
}

// P1. pinned.add replays into pinnedTabs (ordered by index) and NOT into any group.
{
    const base = {groups: [{id: 'g1', title: 'G1', tabs: []}], pinnedTabs: []};
    const logs = [
        {deviceId: 'devA', events: [
            {seq: 1, ts: 100, op: 'pinned.add', tab: {uid: 'p1', url: 'http://p1', index: 0}},
            {seq: 2, ts: 200, op: 'pinned.add', tab: {uid: 'p2', url: 'http://p2', index: 1}},
        ]},
    ];
    const {snapshot} = replay(base, logs);
    check('pinned.add folds into pinnedTabs in order',
        JSON.stringify(pinnedUids(snapshot)) === JSON.stringify(['p1', 'p2']), JSON.stringify(pinnedUids(snapshot)));
    check('pinned.add does not leak into any group',
        snapshot.groups.every(g => g.tabs.every(t => t.uid !== 'p1' && t.uid !== 'p2')), JSON.stringify(snapshot.groups));
    check('pinned index stamped to array position',
        snapshot.pinnedTabs[0].index === 0 && snapshot.pinnedTabs[1].index === 1, JSON.stringify(snapshot.pinnedTabs));
}

// P2. pinned.remove drops the tab from pinnedTabs.
{
    const base = {pinnedTabs: [{uid: 'p1', url: 'http://p1'}, {uid: 'p2', url: 'http://p2'}]};
    const logs = [
        {deviceId: 'devA', events: [
            {seq: 1, ts: 100, op: 'pinned.remove', uid: 'p1'},
        ]},
    ];
    const {snapshot} = replay(base, logs);
    check('pinned.remove drops the tab',
        JSON.stringify(pinnedUids(snapshot)) === JSON.stringify(['p2']), JSON.stringify(pinnedUids(snapshot)));
}

// P3. pinned.move reorders within pinnedTabs.
{
    const base = {pinnedTabs: [{uid: 'p1'}, {uid: 'p2'}, {uid: 'p3'}]};
    const logs = [
        {deviceId: 'devA', events: [
            {seq: 1, ts: 100, op: 'pinned.move', uid: 'p3', toIndex: 0},
        ]},
    ];
    const {snapshot} = replay(base, logs);
    check('pinned.move reorders the global pinned list',
        JSON.stringify(pinnedUids(snapshot)) === JSON.stringify(['p3', 'p1', 'p2']), JSON.stringify(pinnedUids(snapshot)));
}

// P4. modify-beats-delete resurrects a pinned tab (rule 1 on the pinned section).
{
    const base = {pinnedTabs: [{uid: 'p1', url: 'http://p1', title: 'P1'}]};
    const logs = [
        {deviceId: 'devA', events: [
            {seq: 1, ts: 100, op: 'pinned.remove', uid: 'p1'},
        ]},
        {deviceId: 'devB', events: [
            {seq: 1, ts: 200, op: 'pinned.modify', tab: {uid: 'p1', url: 'http://p1b', title: 'P1B'}},
        ]},
    ];
    const {snapshot} = replay(base, logs);
    const p1 = (snapshot.pinnedTabs || []).find(t => t.uid === 'p1');
    check('pinned modify-beats-delete resurrects the tab', !!p1, JSON.stringify(snapshot.pinnedTabs));
    check('pinned modify-beats-delete uses the new record',
        p1?.url === 'http://p1b' && p1?.title === 'P1B', JSON.stringify(p1));
}

// P5. pinned add-of-existing folds to modify (no duplicate); watermark dedup applies.
{
    const base = {pinnedTabs: [{uid: 'p1', url: 'http://old'}], watermark: {devA: 5}};
    const logs = [
        {deviceId: 'devA', events: [
            // already folded — must be ignored, otherwise p1 would be removed
            {seq: 3, ts: 100, op: 'pinned.remove', uid: 'p1'},
            // new — add-of-existing replaces record
            {seq: 6, ts: 300, op: 'pinned.add', tab: {uid: 'p1', url: 'http://new', index: 0}},
        ]},
    ];
    const {snapshot} = replay(base, logs);
    const uids = pinnedUids(snapshot);
    const p1 = snapshot.pinnedTabs.find(t => t.uid === 'p1');
    check('pinned watermark dedup skips already-folded remove', uids.includes('p1'), JSON.stringify(uids));
    check('pinned add-of-existing does not duplicate', uids.length === 1, JSON.stringify(uids));
    check('pinned add-of-existing replaces the record', p1?.url === 'http://new', JSON.stringify(p1));
}

// P6. base without pinnedTabs still yields an array; groups unaffected by pinned ops.
{
    const base = {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1'}]}]};
    const logs = [
        {deviceId: 'devA', events: [
            {seq: 1, ts: 100, op: 'pinned.add', tab: {uid: 'p1', url: 'http://p1', index: 0}},
        ]},
    ];
    const {snapshot} = replay(base, logs);
    check('pinnedTabs defaults to an array when base omits it', Array.isArray(snapshot.pinnedTabs));
    check('groups untouched by pinned ops',
        JSON.stringify(tabUids(snapshot, 'g1')) === JSON.stringify(['t1']), JSON.stringify(tabUids(snapshot, 'g1')));
}

// GP. group-scoped pinned flag rides the group tab record through replay: tab.add with
// pinned:true keeps it; a later tab.modify can flip it off; it stays a group tab.
{
    const base = {groups: [{id: 'g1', title: 'G1', tabs: []}], pinnedTabs: []};
    const logs = [
        {deviceId: 'devA', events: [
            {seq: 1, ts: 100, op: 'tab.add', groupId: 'g1', tab: {uid: 'gp', url: 'http://gp', index: 0, pinned: true}},
        ]},
    ];
    const {snapshot} = replay(base, logs);
    const tab = snapshot.groups[0].tabs.find(t => t.uid === 'gp');
    check('replay: group tab.add preserves pinned:true', tab?.pinned === true, JSON.stringify(tab));
    check('replay: group-pinned tab does NOT enter pinnedTabs',
        !(snapshot.pinnedTabs || []).some(t => t.uid === 'gp'), JSON.stringify(snapshot.pinnedTabs));

    // CLOBBER-SAFETY: a later modify that OMITS pinned must PRESERVE a previously-synced
    // pinned:true (legacy records carried the flag only when true — its absence is "no
    // information", not "turn off"). This is the fix for the half-wired clobber bug; the
    // old behaviour (absence wipes the flag) silently lost a synced group-pin.
    const logs2 = [
        {deviceId: 'devA', events: [
            {seq: 1, ts: 100, op: 'tab.add', groupId: 'g1', tab: {uid: 'gp', url: 'http://gp', index: 0, pinned: true}},
            {seq: 2, ts: 200, op: 'tab.modify', groupId: 'g1', tab: {uid: 'gp', url: 'http://gp2', index: 0}},
        ]},
    ];
    const {snapshot: snap2} = replay(base, logs2);
    const tab2 = snap2.groups[0].tabs.find(t => t.uid === 'gp');
    check('replay: tab.modify OMITTING pinned PRESERVES the prior pinned:true (clobber-safe)',
        tab2 && tab2.pinned === true, JSON.stringify(tab2));
    check('replay: the omitting modify still applies its other content (url)',
        tab2 && tab2.url === 'http://gp2', JSON.stringify(tab2));

    // …but an EXPLICIT pinned:false (a genuine un-pin) DOES clear it — the flag is never
    // made impossible to turn off. Capture now always emits pinned explicitly, so a real
    // un-pin carries false.
    const logs3 = [
        {deviceId: 'devA', events: [
            {seq: 1, ts: 100, op: 'tab.add', groupId: 'g1', tab: {uid: 'gp', url: 'http://gp', index: 0, pinned: true}},
            {seq: 2, ts: 200, op: 'tab.modify', groupId: 'g1', tab: {uid: 'gp', url: 'http://gp', index: 0, pinned: false}},
        ]},
    ];
    const {snapshot: snap3} = replay(base, logs3);
    const tab3 = snap3.groups[0].tabs.find(t => t.uid === 'gp');
    check('replay: tab.modify with EXPLICIT pinned:false clears the group-pin flag (genuine un-pin)',
        tab3 && tab3.pinned === false, JSON.stringify(tab3));

    // loaded behaves the same way: omission preserves, explicit false clears.
    const logs4 = [
        {deviceId: 'devA', events: [
            {seq: 1, ts: 100, op: 'tab.add', groupId: 'g1', tab: {uid: 'lp', url: 'http://lp', index: 0, loaded: true}},
            {seq: 2, ts: 200, op: 'tab.modify', groupId: 'g1', tab: {uid: 'lp', url: 'http://lp2', index: 0}},
            {seq: 3, ts: 300, op: 'tab.modify', groupId: 'g1', tab: {uid: 'lp', url: 'http://lp2', index: 0, loaded: false}},
        ]},
    ];
    const {snapshot: snap4} = replay(base, logs4);
    const tab4 = snap4.groups[0].tabs.find(t => t.uid === 'lp');
    check('replay: omitting loaded preserves then explicit false clears it',
        tab4 && tab4.loaded === false, JSON.stringify(tab4));
}

// ---------------------------------------------------------------------------
// group.move: a reorder on one device propagates and the resolved group order
//   matches the move (the regression: a reorder used to emit no event so order reverted).
// ---------------------------------------------------------------------------
{
    const base = {groups: [
        {id: 'g1', title: 'G1', tabs: []},
        {id: 'g2', title: 'G2', tabs: []},
        {id: 'g3', title: 'G3', tabs: []},
    ]};
    // move g3 to the front (index 0)
    const logs = [
        {deviceId: 'devA', events: [
            {seq: 1, ts: 100, op: 'group.move', groupId: 'g3', toIndex: 0},
        ]},
    ];
    const {snapshot} = replay(base, logs);
    const order = snapshot.groups.map(g => g.id);
    check('group.move reorders group to the target index',
        JSON.stringify(order) === JSON.stringify(['g3', 'g1', 'g2']), JSON.stringify(order));
}

// ---------------------------------------------------------------------------
// group.move: last-writer-wins by ts — two devices reorder the same group, the
//   later move (by ts) wins, and both devices converge to that order.
// ---------------------------------------------------------------------------
{
    const base = {groups: [
        {id: 'g1', title: 'G1', tabs: []},
        {id: 'g2', title: 'G2', tabs: []},
        {id: 'g3', title: 'G3', tabs: []},
    ]};
    const logs = [
        {deviceId: 'devA', events: [
            {seq: 1, ts: 100, op: 'group.move', groupId: 'g1', toIndex: 2}, // earlier
        ]},
        {deviceId: 'devB', events: [
            {seq: 1, ts: 200, op: 'group.move', groupId: 'g1', toIndex: 0}, // later wins
        ]},
    ];
    const {snapshot} = replay(base, logs);
    const order = snapshot.groups.map(g => g.id);
    check('group.move LWW: latest move (by ts) wins',
        order[0] === 'g1', JSON.stringify(order));
}

// ---------------------------------------------------------------------------
// group.move: out-of-range index clamps to append; unknown group is a no-op.
// ---------------------------------------------------------------------------
{
    const base = {groups: [
        {id: 'g1', title: 'G1', tabs: []},
        {id: 'g2', title: 'G2', tabs: []},
    ]};
    const logs = [
        {deviceId: 'devA', events: [
            {seq: 1, ts: 100, op: 'group.move', groupId: 'g1', toIndex: 99},   // clamp to end
            {seq: 2, ts: 200, op: 'group.move', groupId: 'gX', toIndex: 0},     // unknown — no-op
        ]},
    ];
    const {snapshot} = replay(base, logs);
    const order = snapshot.groups.map(g => g.id);
    check('group.move clamps over-range index to append; unknown group ignored',
        JSON.stringify(order) === JSON.stringify(['g2', 'g1']), JSON.stringify(order));
}

// ---------------------------------------------------------------------------
// Regression: a tab.add referencing a group with NO group.add (the receiver missed /
// compacted away the original group.add) must NOT name the fabricated group with the
// raw UUID/id. It gets STG's default "Group <uid>" name; no UUID is surfaced as a title.
// ---------------------------------------------------------------------------
{
    const groupId = 'afc2963f-d003-4c96-9213-63d4ef57c0d6';
    const base = {groups: []};
    const logs = [
        {deviceId: 'devA', events: [
            {seq: 1, ts: 100, op: 'tab.add', groupId, tab: {uid: 't1', url: 'http://a'}},
        ]},
    ];
    const {snapshot} = replay(base, logs);
    const g = snapshot.groups.find(x => x.id === groupId);
    check('tab.add into a never-seen group fabricates the group', !!g, 'group missing');
    check('fabricated group title is NOT the raw UUID/id', g?.title !== groupId, JSON.stringify(g?.title));
    check('fabricated group gets STGs default "Group <uid>" name',
        g?.title === 'Group c0d6', JSON.stringify(g?.title));
    check('fabricated group still holds the tab',
        g?.tabs.length === 1 && g.tabs[0].uid === 't1', JSON.stringify(g?.tabs));
}

// ---------------------------------------------------------------------------
// A real group.add that (defensively) carries a UUID/id as its title is sanitised too;
// a genuine human title is preserved verbatim; a partial group.modify omitting title
// leaves the existing title untouched.
// ---------------------------------------------------------------------------
{
    const groupId = 'afc2963f-d003-4c96-9213-63d4ef57c0d6';
    const base = {groups: []};
    const logs = [
        {deviceId: 'devA', events: [
            // group.add whose title IS the id (the bad value we must never surface)
            {seq: 1, ts: 100, op: 'group.add', group: {id: groupId, title: groupId, tabs: []}},
        ]},
        {deviceId: 'devB', events: [
            {seq: 1, ts: 50, op: 'group.add', group: {id: 'g2', title: 'My work', tabs: []}},
            {seq: 2, ts: 200, op: 'group.modify', group: {id: 'g2', iconColor: 'red'}}, // no title
        ]},
    ];
    const {snapshot} = replay(base, logs);
    const g1 = snapshot.groups.find(x => x.id === groupId);
    const g2 = snapshot.groups.find(x => x.id === 'g2');
    check('group.add with UUID-as-title is sanitised to default name', g1?.title === 'Group c0d6',
        JSON.stringify(g1?.title));
    check('group.add with a real title keeps it verbatim', g2?.title === 'My work',
        JSON.stringify(g2?.title));
    check('partial group.modify (no title) leaves the existing title untouched',
        g2?.title === 'My work' && g2?.iconColor === 'red', JSON.stringify(g2));
}

// ---------------------------------------------------------------------------
// pinned group ordering: when options.pinnedGroupId is given, the pinned group is
// forced to index 0 of the resolved snapshot, regardless of where it sits in the
// base or where a group.add appended it — so a device that keeps it first locally
// never sees it reordered by sync.
// ---------------------------------------------------------------------------
const PIN = '70696e6e-6564-4000-8000-000000000001';
{
    const base = {groups: [
        {id: 'g1', title: 'G1', tabs: []},
        {id: PIN, title: 'Pinned', isPinnedGroup: true, tabs: []},
        {id: 'g2', title: 'G2', tabs: []},
    ]};
    const {snapshot} = replay(base, [], {pinnedGroupId: PIN});
    check('pinned group hoisted to index 0 from mid-base',
        snapshot.groups[0]?.id === PIN, snapshot.groups.map(g => g.id).join(','));
    check('non-pinned relative order preserved after hoist',
        snapshot.groups.map(g => g.id).join(',') === `${PIN},g1,g2`,
        snapshot.groups.map(g => g.id).join(','));
}
{
    // the real-world break: base has only work groups, the pinned group arrives via a
    // group.add (which appends) — without the hoist it lands last.
    const base = {groups: [{id: 'g1', title: 'G1', tabs: []}]};
    const logs = [{deviceId: 'devA', events: [
        {seq: 1, ts: 100, op: 'group.add', group: {id: 'g2', title: 'G2', tabs: []}},
        {seq: 2, ts: 200, op: 'group.add', group: {id: PIN, title: 'Pinned', isPinnedGroup: true, tabs: []}},
    ]}];
    const {snapshot} = replay(base, logs, {pinnedGroupId: PIN});
    check('pinned group added via group.add is hoisted to index 0',
        snapshot.groups[0]?.id === PIN, snapshot.groups.map(g => g.id).join(','));
}
{
    // without pinnedGroupId the engine stays untouched (pure default behaviour).
    const base = {groups: [
        {id: 'g1', title: 'G1', tabs: []},
        {id: PIN, title: 'Pinned', isPinnedGroup: true, tabs: []},
    ]};
    const {snapshot} = replay(base, []);
    check('no pinnedGroupId option: order left as-is',
        snapshot.groups[0]?.id === 'g1', snapshot.groups.map(g => g.id).join(','));
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.error('FAILURES:', failures.join(', '));
    process.exit(1);
}
