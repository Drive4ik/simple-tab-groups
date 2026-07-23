/**
 * Standalone node test for local coalescing of UN-PUSHED delta events.
 * Plain `node coalesce-unpushed.test.mjs` (STG has no test runner).
 *
 * The coalescer collapses superseded operations on the same target inside the un-pushed
 * tail (seq > lastPushedSeq). The hard invariant it must never break is a REPLAY NO-OP:
 * for any base snapshot S and any un-pushed suffix E,
 *   resolvedState(replay(S, coalesce(E))) === resolvedState(replay(S, E)).
 * Only the resolved state is compared — the replay watermark is bookkeeping and legitimately
 * shrinks when the tail's highest-seq events are cancelled (add+remove of a locally-born uid).
 *
 * Both engines are import-free / browser-free by contract, so this runs under plain node.
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs).
 */

import {replay} from './replay.js';
import {coalesceEvents} from './coalesce.js';

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

function deepEqual(a, b) {
    if (a === b) {
        return true;
    }
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
        return false;
    }
    if (Array.isArray(a) !== Array.isArray(b)) {
        return false;
    }
    if (Array.isArray(a)) {
        if (a.length !== b.length) {
            return false;
        }
        return a.every((v, i) => deepEqual(v, b[i]));
    }
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) {
        return false;
    }
    return ka.every(k => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

function resolvedState(snapshot) {
    return {
        groups: snapshot.groups,
        pinnedTabs: snapshot.pinnedTabs,
        options: snapshot.options,
        containers: snapshot.containers,
    };
}

let nextTs = 1;
function ev(seq, op, payload = {}) {
    return {seq, ts: nextTs++, op, ...payload};
}

// Drive both engines through a single self-log and assert the resolved state is byte-identical.
function assertNoOp(name, base, events, floor = 0) {
    const coalesced = coalesceEvents(events, floor);
    const original = resolvedState(replay(base, [{deviceId: 'self', events}]).snapshot);
    const reduced = resolvedState(replay(base, [{deviceId: 'self', events: coalesced}]).snapshot);
    check(`${name}: replay no-op`, deepEqual(original, reduced),
        `\n    orig=${JSON.stringify(original)}\n    red =${JSON.stringify(reduced)}`);
    return coalesced;
}

const tab = (uid, extra = {}) => ({uid, url: `http://${uid}`, title: uid, cookieStoreId: 'firefox-default', pinned: false, loaded: true, ...extra});

// ===================== 3 renames of the same tab collapse to 1 =======================
{
    const base = {groups: [{id: 'g1', title: 'G1', tabs: [{...tab('t1'), index: 0}]}]};
    const E = [
        ev(1, 'tab.modify', {groupId: 'g1', tab: {...tab('t1', {title: 'Peta'}), index: 0}}),
        ev(2, 'tab.modify', {groupId: 'g1', tab: {...tab('t1', {title: 'Anton'}), index: 0}}),
        ev(3, 'tab.modify', {groupId: 'g1', tab: {...tab('t1', {title: 'Anton2'}), index: 0}}),
    ];
    const c = assertNoOp('renames', base, E);
    check('renames: tail shrank 3 -> 1', c.length === 1, `len=${c.length}`);
    check('renames: kept the final title', c[0].tab.title === 'Anton2', JSON.stringify(c[0]));
}

// ===================== add then update(s) fold into a single add =====================
{
    const base = {groups: [{id: 'g1', title: 'G1', tabs: []}]};
    const E = [
        ev(1, 'tab.add', {groupId: 'g1', tab: {...tab('t9', {title: 'v1'}), index: 0}}),
        ev(2, 'tab.modify', {groupId: 'g1', tab: {...tab('t9', {title: 'v2'}), index: 0}}),
        ev(3, 'tab.modify', {groupId: 'g1', tab: {...tab('t9', {title: 'v3'}), index: 2}}),
    ];
    const c = assertNoOp('add+updates', base, E);
    check('add+updates: shrank 3 -> 1', c.length === 1, `len=${c.length}`);
    check('add+updates: stays an add', c[0].op === 'tab.add', c[0].op);
}

// ===================== add then remove of a locally-born uid cancels to nothing ======
{
    const base = {groups: [{id: 'g1', title: 'G1', tabs: [{...tab('keep'), index: 0}]}]};
    const E = [
        ev(1, 'tab.add', {groupId: 'g1', tab: {...tab('born'), index: 1}}),
        ev(2, 'tab.modify', {groupId: 'g1', tab: {...tab('born', {title: 'x'}), index: 1}}),
        ev(3, 'tab.remove', {groupId: 'g1', uid: 'born'}),
    ];
    const c = assertNoOp('add+remove', base, E);
    check('add+remove: cancelled to 0', c.length === 0, `len=${c.length}`);
}

// ===================== update then remove of a pre-existing uid -> single remove =====
{
    const withT = {groups: [{id: 'g1', title: 'G1', tabs: [{...tab('t1'), index: 0}, {...tab('t2'), index: 1}]}]};
    const withoutT = {groups: [{id: 'g1', title: 'G1', tabs: [{...tab('t2'), index: 0}]}]};
    const E = [
        ev(1, 'tab.modify', {groupId: 'g1', tab: {...tab('t1', {title: 'edited'}), index: 0}}),
        ev(2, 'tab.remove', {groupId: 'g1', uid: 't1'}),
    ];
    const c = assertNoOp('update+remove (base has uid)', withT, E);
    assertNoOp('update+remove (base lacks uid)', withoutT, E);
    check('update+remove: shrank to a single remove', c.length === 1 && c[0].op === 'tab.remove', JSON.stringify(c));
}

// ===================== interleaved uids are NOT collapsed (left intact) ==============
{
    const base = {groups: [{id: 'g1', title: 'G1', tabs: [{...tab('A'), index: 0}, {...tab('B'), index: 1}]}]};
    const E = [
        ev(1, 'tab.modify', {groupId: 'g1', tab: {...tab('A', {title: 'A1'}), index: 0}}),
        ev(2, 'tab.modify', {groupId: 'g1', tab: {...tab('B', {title: 'B1'}), index: 1}}),
        ev(3, 'tab.modify', {groupId: 'g1', tab: {...tab('A', {title: 'A2'}), index: 0}}),
    ];
    const c = assertNoOp('interleaved uids', base, E);
    check('interleaved uids: left intact (no unsafe cross-uid collapse)', c.length === 3, `len=${c.length}`);
}

// ===================== consecutive moves collapse to the final move =================
{
    const base = {groups: [{id: 'g1', title: 'G1', tabs: [{...tab('m'), index: 0}, {...tab('x'), index: 1}, {...tab('y'), index: 2}]}]};
    const E = [
        ev(1, 'tab.move', {groupId: 'g1', uid: 'm', toIndex: 2}),
        ev(2, 'tab.move', {groupId: 'g1', uid: 'm', toIndex: 1}),
        ev(3, 'tab.move', {groupId: 'g1', uid: 'm', toIndex: 0}),
    ];
    const c = assertNoOp('moves', base, E);
    check('moves: shrank 3 -> 1', c.length === 1 && c[0].op === 'tab.move' && c[0].toIndex === 0, JSON.stringify(c));
}

// ===================== add then move folds into one add at the move target ==========
{
    const base = {groups: [{id: 'g1', title: 'G1', tabs: [{...tab('a'), index: 0}, {...tab('b'), index: 1}]}]};
    const E = [
        ev(1, 'tab.add', {groupId: 'g1', tab: {...tab('n'), index: 0}}),
        ev(2, 'tab.move', {groupId: 'g1', uid: 'n', toIndex: 2}),
    ];
    const c = assertNoOp('add+move', base, E);
    check('add+move: shrank 2 -> 1 add', c.length === 1 && c[0].op === 'tab.add', JSON.stringify(c));
}

// ===================== option.set: last-per-key wins, keys independent ==============
{
    const base = {groups: [], options: {}};
    const E = [
        ev(1, 'option.set', {key: 'theme', value: 'a'}),
        ev(2, 'option.set', {key: 'lang', value: 'en'}),
        ev(3, 'option.set', {key: 'theme', value: 'b'}),
        ev(4, 'option.set', {key: 'theme', value: 'c'}),
    ];
    const c = assertNoOp('options LWW', base, E);
    check('options LWW: theme collapsed, lang kept (4 -> 2)', c.length === 2, `len=${c.length}`);
}

// ===================== group.modify runs merge props (partial keys) =================
{
    const base = {groups: [{id: 'g1', title: 'old', tabs: [{...tab('t'), index: 0}]}]};
    const E = [
        ev(1, 'group.modify', {group: {id: 'g1', title: 'n1'}}),
        ev(2, 'group.modify', {group: {id: 'g1', color: 'red'}}),
        ev(3, 'group.modify', {group: {id: 'g1', title: 'n2'}}),
    ];
    const c = assertNoOp('group modify merge', base, E);
    check('group modify merge: 3 -> 1', c.length === 1, `len=${c.length}`);
    check('group modify merge: last title + accumulated color',
        c[0].group.title === 'n2' && c[0].group.color === 'red', JSON.stringify(c[0]));
}

// ===================== group.add then group.remove cancels ==========================
{
    const base = {groups: [{id: 'g0', title: 'G0', tabs: []}]};
    const E = [
        ev(1, 'group.add', {group: {id: 'gNew', title: 'X', tabs: []}}),
        ev(2, 'group.modify', {group: {id: 'gNew', title: 'Y'}}),
        ev(3, 'group.remove', {groupId: 'gNew'}),
    ];
    const c = assertNoOp('group add+remove', base, E);
    check('group add+remove: cancelled to 0', c.length === 0, `len=${c.length}`);
}

// ===================== group.move run collapses to the final move ===================
{
    const base = {groups: [{id: 'g1', title: '1', tabs: []}, {id: 'g2', title: '2', tabs: []}, {id: 'g3', title: '3', tabs: []}]};
    const E = [
        ev(1, 'group.move', {groupId: 'g3', toIndex: 0}),
        ev(2, 'group.move', {groupId: 'g3', toIndex: 1}),
    ];
    const c = assertNoOp('group moves', base, E);
    check('group moves: 2 -> 1', c.length === 1 && c[0].op === 'group.move' && c[0].toIndex === 1, JSON.stringify(c));
}

// ===================== mixed group upsert+move is left intact (unprovable) ==========
{
    const base = {groups: [{id: 'g1', title: '1', tabs: []}, {id: 'g2', title: '2', tabs: []}]};
    const E = [
        ev(1, 'group.modify', {group: {id: 'g2', title: 'renamed'}}),
        ev(2, 'group.move', {groupId: 'g2', toIndex: 0}),
    ];
    const c = assertNoOp('group mixed', base, E);
    check('group mixed: left intact', c.length === 2, `len=${c.length}`);
}

// ===================== pinned modify run + pinned add/remove cancel ==================
{
    const base = {groups: [], pinnedTabs: [{...tab('p1'), index: 0}]};
    const E = [
        ev(1, 'pinned.modify', {tab: {...tab('p1', {title: 'a'}), index: 0}}),
        ev(2, 'pinned.modify', {tab: {...tab('p1', {title: 'b'}), index: 0}}),
        ev(3, 'pinned.modify', {tab: {...tab('p1', {title: 'c'}), index: 0}}),
    ];
    const c = assertNoOp('pinned modify run', base, E);
    check('pinned modify run: 3 -> 1', c.length === 1, `len=${c.length}`);

    const base2 = {groups: [], pinnedTabs: []};
    const E2 = [
        ev(1, 'pinned.add', {tab: {...tab('pNew'), index: 0}}),
        ev(2, 'pinned.remove', {uid: 'pNew'}),
    ];
    const c2 = assertNoOp('pinned add+remove', base2, E2);
    check('pinned add+remove: cancelled to 0', c2.length === 0, `len=${c2.length}`);
}

// ===================== pushed events (seq <= floor) are NEVER touched ================
{
    const base = {groups: [{id: 'g1', title: 'G1', tabs: []}]};
    const E = [
        ev(1, 'tab.add', {groupId: 'g1', tab: {...tab('a'), index: 0}}),
        ev(2, 'tab.modify', {groupId: 'g1', tab: {...tab('a', {title: 'pushed-edit'}), index: 0}}),
        ev(3, 'tab.modify', {groupId: 'g1', tab: {...tab('a', {title: 'unpushed-1'}), index: 0}}),
        ev(4, 'tab.modify', {groupId: 'g1', tab: {...tab('a', {title: 'unpushed-2'}), index: 0}}),
    ];
    const floor = 2;
    const c = coalesceEvents(E, floor);
    const pushedIntact = c.filter(e => e.seq <= floor);
    check('floor: pushed events kept byte-identical',
        pushedIntact.length === 2 && deepEqual(pushedIntact, E.slice(0, 2)), JSON.stringify(pushedIntact));
    check('floor: only the un-pushed tail collapsed (seq 3,4 -> 1 event)',
        c.length === 3 && c.filter(e => e.seq > floor).length === 1, `len=${c.length}`);
    // and it is still a replay no-op against a base that already carries the pushed prefix
    assertNoOp('floor: full-log replay no-op', base, E, floor);
}

// ===================== broad invariant sweep across mixed sequences =================
{
    const base = {
        groups: [
            {id: 'g1', title: 'G1', tabs: [{...tab('t1'), index: 0}, {...tab('t2'), index: 1}]},
            {id: 'g2', title: 'G2', tabs: [{...tab('t3'), index: 0}]},
        ],
        pinnedTabs: [{...tab('p1'), index: 0}],
        options: {theme: 'x'},
    };
    const E = [
        ev(1, 'tab.modify', {groupId: 'g1', tab: {...tab('t1', {title: 'r1'}), index: 0}}),
        ev(2, 'tab.modify', {groupId: 'g1', tab: {...tab('t1', {title: 'r2'}), index: 0}}),
        ev(3, 'option.set', {key: 'theme', value: 'y'}),
        ev(4, 'tab.add', {groupId: 'g2', tab: {...tab('t4'), index: 1}}),
        ev(5, 'tab.move', {groupId: 'g2', uid: 't4', toIndex: 0}),
        ev(6, 'pinned.modify', {tab: {...tab('p1', {title: 'pp'}), index: 0}}),
        ev(7, 'pinned.modify', {tab: {...tab('p1', {title: 'pp2'}), index: 0}}),
        ev(8, 'tab.modify', {groupId: 'g1', tab: {...tab('t1', {title: 'r3'}), index: 1}}),
        ev(9, 'tab.remove', {groupId: 'g1', uid: 't2'}),
        ev(10, 'option.set', {key: 'theme', value: 'z'}),
    ];
    const c = assertNoOp('sweep', base, E);
    check('sweep: tail shrank', c.length < E.length, `len=${c.length} of ${E.length}`);
}

// ============================ summary ========================================
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.error('FAILED:', failures.join(', '));
    process.exit(1);
}
