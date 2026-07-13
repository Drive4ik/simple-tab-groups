import {computeBootstrapEvents} from './plan-sync.js';

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

function normalizeSet(input) {
    return new Set(input || []);
}

function foldRepresented(baseline, known, events) {
    const represented = {
        groupIds: new Set([...normalizeSet(baseline.groupIds), ...normalizeSet(known.groupRecordIds)]),
        tabUids: new Set([...normalizeSet(baseline.tabUids), ...normalizeSet(known.uids)]),
        optionKeys: new Set([...normalizeSet(baseline.optionKeys), ...normalizeSet(known.optionKeys)]),
        pinnedUids: new Set([...normalizeSet(baseline.pinnedUids), ...normalizeSet(known.uids)]),
    };
    const emittedGroups = new Map();
    const emittedTabGroupId = new Map();

    for (const event of events) {
        switch (event.op) {
            case 'group.add':
                if (event.group && event.group.id != null) {
                    represented.groupIds.add(event.group.id);
                    emittedGroups.set(event.group.id, event.group);
                }
                break;
            case 'tab.add':
                if (event.tab && event.tab.uid != null) {
                    represented.tabUids.add(event.tab.uid);
                    emittedTabGroupId.set(event.tab.uid, event.groupId);
                }
                break;
            case 'pinned.add':
                if (event.tab && event.tab.uid != null) {
                    represented.pinnedUids.add(event.tab.uid);
                }
                break;
            case 'option.set':
                if (event.key != null) {
                    represented.optionKeys.add(event.key);
                }
                break;
            default:
                break;
        }
    }

    return {represented, emittedGroups, emittedTabGroupId};
}

function collectLocal(localState) {
    const groups = (localState && localState.groups) || [];
    const localGroups = groups.filter(g => g.id != null);
    const localTabs = [];
    const groupTabUids = new Set();
    for (const group of localGroups) {
        for (const tab of Array.isArray(group.tabs) ? group.tabs : []) {
            if (tab.uid != null) {
                localTabs.push({groupId: group.id, tab});
                groupTabUids.add(tab.uid);
            }
        }
    }
    const localPinned = ((localState && localState.pinnedTabs) || [])
        .filter(t => t && t.uid != null);
    const localOptionKeys = Object.keys((localState && localState.options) || {});
    return {localGroups, localTabs, groupTabUids, localPinned, localOptionKeys};
}

function assertInvariants(label, localState, baseline, logUids, logGroupRecordIds, logOptionKeys) {
    const events = computeBootstrapEvents(localState, baseline, logUids, logGroupRecordIds, logOptionKeys);
    const {represented, emittedGroups, emittedTabGroupId} = foldRepresented(baseline,
        {uids: logUids, groupRecordIds: logGroupRecordIds, optionKeys: logOptionKeys}, events);
    const {localGroups, localTabs, groupTabUids, localPinned, localOptionKeys} = collectLocal(localState);

    const baseGroupIds = normalizeSet(baseline.groupIds);
    const baseTabUids = normalizeSet(baseline.tabUids);
    const baseOptionKeys = normalizeSet(baseline.optionKeys);
    const basePinnedUids = normalizeSet(baseline.pinnedUids);
    const knownUids = normalizeSet(logUids);
    const knownGroupRecordIds = normalizeSet(logGroupRecordIds);
    const knownOptionKeys = normalizeSet(logOptionKeys);

    for (const group of localGroups) {
        check(`${label}: group ${group.id} represented`,
            represented.groupIds.has(group.id), JSON.stringify(events));
        const emitted = emittedGroups.get(group.id);
        if (emitted) {
            check(`${label}: emitted group ${group.id} carries real title`,
                emitted.title === group.title, JSON.stringify(emitted));
            check(`${label}: emitted group ${group.id} drops tabs`,
                !('tabs' in emitted), JSON.stringify(emitted));
        }
    }

    for (const {groupId, tab} of localTabs) {
        check(`${label}: tab ${tab.uid} represented`,
            represented.tabUids.has(tab.uid), JSON.stringify(events));
        if (emittedTabGroupId.has(tab.uid)) {
            check(`${label}: emitted tab ${tab.uid} carries correct groupId`,
                emittedTabGroupId.get(tab.uid) === groupId, JSON.stringify(events));
        }
    }

    for (const tab of localPinned) {
        if (groupTabUids.has(tab.uid)) {
            check(`${label}: pinned uid ${tab.uid} that is ALSO a group tab is NOT double-emitted as pinned.add`,
                !events.some(e => e.op === 'pinned.add' && e.tab?.uid === tab.uid), JSON.stringify(events));
            continue;
        }
        check(`${label}: pinned ${tab.uid} represented`,
            represented.pinnedUids.has(tab.uid), JSON.stringify(events));
    }

    for (const key of localOptionKeys) {
        check(`${label}: option ${key} represented`,
            represented.optionKeys.has(key), JSON.stringify(events));
    }

    for (const event of events) {
        if (event.op === 'group.add') {
            const id = event.group?.id;
            check(`${label}: no-churn group.add ${id} not already covered`,
                !baseGroupIds.has(id) && !knownGroupRecordIds.has(id), JSON.stringify(event));
        } else if (event.op === 'tab.add') {
            const uid = event.tab?.uid;
            check(`${label}: no-churn tab.add ${uid} not already covered`,
                !baseTabUids.has(uid) && !knownUids.has(uid), JSON.stringify(event));
        } else if (event.op === 'pinned.add') {
            const uid = event.tab?.uid;
            check(`${label}: no-churn pinned.add ${uid} not already covered`,
                !basePinnedUids.has(uid) && !knownUids.has(uid) && !groupTabUids.has(uid), JSON.stringify(event));
        } else if (event.op === 'option.set') {
            const key = event.key;
            check(`${label}: no-churn option.set ${key} not already covered`,
                !baseOptionKeys.has(key) && !knownOptionKeys.has(key), JSON.stringify(event));
        }
    }

    return events;
}

function localStateFixtures() {
    const fixtures = [];

    fixtures.push({name: 'empty', state: {groups: [], pinnedTabs: [], options: {}}});

    fixtures.push({name: 'one-group-no-tabs',
        state: {groups: [{id: 'g1', title: 'G1', tabs: []}], pinnedTabs: [], options: {}}});

    fixtures.push({name: 'one-group-one-tab',
        state: {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://a', index: 0}]}], pinnedTabs: [], options: {}}});

    fixtures.push({name: 'one-group-many-tabs',
        state: {groups: [{id: 'g1', title: 'G1', tabs: [
            {uid: 't1', url: 'http://a', index: 0},
            {uid: 't2', url: 'http://b', index: 1},
            {uid: 't3', url: 'http://c', index: 2},
        ]}], pinnedTabs: [], options: {}}});

    fixtures.push({name: 'many-groups-mixed-tabs',
        state: {groups: [
            {id: 'g1', title: 'Alpha', tabs: [{uid: 't1', url: 'http://a', index: 0}]},
            {id: 'g2', title: 'Beta', tabs: []},
            {id: 'g3', title: 'Gamma', tabs: [
                {uid: 't2', url: 'http://b', index: 0},
                {uid: 't3', url: 'http://c', index: 1, pinned: true},
            ]},
        ], pinnedTabs: [], options: {}}});

    fixtures.push({name: 'with-global-pinned',
        state: {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://a', index: 0}]}],
            pinnedTabs: [{uid: 'p1', url: 'http://p1', index: 0}, {uid: 'p2', url: 'http://p2', index: 1}], options: {}}});

    fixtures.push({name: 'pinned-also-group-tab',
        state: {groups: [{id: 'g1', title: 'G1', tabs: [
            {uid: 'dup', url: 'http://d', index: 0},
            {uid: 'onlyGroup', url: 'http://o', index: 1},
        ]}],
        pinnedTabs: [{uid: 'dup', url: 'http://d', index: 0}, {uid: 'onlyPinned', url: 'http://z', index: 1}], options: {}}});

    fixtures.push({name: 'with-options',
        state: {groups: [{id: 'g1', title: 'G1', tabs: [{uid: 't1', url: 'http://a', index: 0}]}],
            pinnedTabs: [], options: {colorScheme: 'dark', fullPopupWidth: true}}});

    fixtures.push({name: 'full-mix',
        state: {groups: [
            {id: 'g1', title: 'Work', tabs: [{uid: 't1', url: 'http://a', index: 0}, {uid: 'dup', url: 'http://d', index: 1}]},
            {id: 'g2', title: 'Home', tabs: [{uid: 't2', url: 'http://b', index: 0}]},
        ],
        pinnedTabs: [{uid: 'dup', url: 'http://d', index: 0}, {uid: 'p1', url: 'http://p1', index: 1}],
        options: {colorScheme: 'light', hotkeys: []}}});

    return fixtures;
}

function priorInputVariants(state) {
    const {localGroups, localTabs, groupTabUids, localPinned, localOptionKeys} = collectLocal(state);
    const groupIds = localGroups.map(g => g.id);
    const tabUids = localTabs.map(t => t.tab.uid);
    const pinnedUids = localPinned.map(t => t.uid).filter(uid => !groupTabUids.has(uid));

    const first = arr => (arr.length ? [arr[0]] : []);

    const variants = [];

    variants.push({name: 'empty-inputs',
        baseline: {}, logUids: [], logGroupRecordIds: [], logOptionKeys: []});

    variants.push({name: 'baseline-covers-all',
        baseline: {groupIds, tabUids, optionKeys: localOptionKeys, pinnedUids},
        logUids: [], logGroupRecordIds: [], logOptionKeys: []});

    variants.push({name: 'baseline-covers-some',
        baseline: {groupIds: first(groupIds), tabUids: first(tabUids), optionKeys: first(localOptionKeys), pinnedUids: first(pinnedUids)},
        logUids: [], logGroupRecordIds: [], logOptionKeys: []});

    variants.push({name: 'log-group-records-cover-some',
        baseline: {}, logUids: [], logGroupRecordIds: first(groupIds), logOptionKeys: []});

    variants.push({name: 'log-uids-cover-some',
        baseline: {}, logUids: first(tabUids), logGroupRecordIds: [], logOptionKeys: []});

    variants.push({name: 'log-option-keys-cover-some',
        baseline: {}, logUids: [], logGroupRecordIds: [], logOptionKeys: first(localOptionKeys)});

    variants.push({name: 'log-covers-tabs-not-groups',
        baseline: {}, logUids: tabUids, logGroupRecordIds: [], logOptionKeys: []});

    variants.push({name: 'baseline-tabs-log-groups',
        baseline: {tabUids, pinnedUids}, logUids: [], logGroupRecordIds: groupIds, logOptionKeys: localOptionKeys});

    return variants;
}

console.log('bootstrap-invariants: combinatorial matrix');

let combinations = 0;
for (const {name: stateName, state} of localStateFixtures()) {
    for (const variant of priorInputVariants(state)) {
        combinations++;
        assertInvariants(
            `${stateName}/${variant.name}`,
            state,
            variant.baseline,
            variant.logUids,
            variant.logGroupRecordIds,
            variant.logOptionKeys,
        );
    }
}

console.log('bootstrap-invariants: adversarial + named regressions');

{
    const state = {groups: [{id: 'gPre', title: 'Real Title', tabs: [{uid: 'tPre', url: 'http://p', index: 0}]}], pinnedTabs: [], options: {}};
    const events = assertInvariants('adversarial/group-only-via-tab-refs', state, {}, [], [], []);
    check('adversarial: group only referenced via tab-refs still gets group.add',
        events.some(e => e.op === 'group.add' && e.group?.id === 'gPre'), JSON.stringify(events));
    combinations++;
}

{
    const state = {groups: [{id: 'gPre', title: 'Preexisting Title', tabs: [{uid: 'tA', url: 'http://a', index: 0}]}], pinnedTabs: [], options: {}};
    const events = computeBootstrapEvents(state, {}, ['tA'], [], []);
    const groupAdd = events.find(e => e.op === 'group.add' && e.group?.id === 'gPre');
    check('regression B5b: group not in baseline nor group-record set (only tab-refs) emits group.add',
        !!groupAdd, JSON.stringify(events));
    check('regression B5b: emitted group.add carries the real title',
        groupAdd?.group?.title === 'Preexisting Title', JSON.stringify(groupAdd));
    combinations++;
}

{
    const state = {groups: [{id: 'g1', title: 'Group One', tabs: [
        {uid: 'normal1', url: 'http://n', index: 0},
        {uid: 'gpin1', url: 'http://g', index: 1, pinned: true},
    ]}], pinnedTabs: [], options: {}};
    const events = computeBootstrapEvents(state, {tabUids: [], groupIds: ['g1']}, [], ['g1'], []);
    check('regression normal+pinned: group already in baseline emits NO group.add',
        !events.some(e => e.op === 'group.add' && e.group?.id === 'g1'), JSON.stringify(events));
    check('regression normal+pinned: normal grouped tab bootstraps as tab.add',
        events.some(e => e.op === 'tab.add' && e.tab?.uid === 'normal1' && e.groupId === 'g1'), JSON.stringify(events));
    check('regression normal+pinned: group-pinned tab bootstraps as tab.add with pinned',
        events.some(e => e.op === 'tab.add' && e.tab?.uid === 'gpin1' && e.tab.pinned === true), JSON.stringify(events));
    combinations++;
}

{
    const state = {groups: [{id: 'g1', title: 'G1', tabs: [
        {uid: 'dup', url: 'http://d', index: 0},
    ]}], pinnedTabs: [{uid: 'dup', url: 'http://d', index: 0}, {uid: 'realPin', url: 'http://r', index: 1}], options: {}};
    const events = computeBootstrapEvents(state, {}, [], [], []);
    const pinAdds = events.filter(e => e.op === 'pinned.add').map(e => e.tab.uid);
    check('regression H2: uid that is a group tab is NOT emitted as pinned.add',
        !pinAdds.includes('dup'), JSON.stringify(pinAdds));
    check('regression H2: genuine global pin still emits pinned.add',
        pinAdds.includes('realPin'), JSON.stringify(pinAdds));
    combinations++;
}

console.log(`\ncombinations run: ${combinations}`);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.error('FAILURES:', failures.join(', '));
    process.exit(1);
}
