/**
 * Standalone node test for the PURE container-mapping helpers (`container-map.js`).
 *
 * Plain `node container-map.test.mjs` (STG has no test runner). The module is pure
 * (no `browser.*` / `constants.js`), so it imports directly. We fake "local containers"
 * and the impure find-or-create callback to prove the portable round-trip:
 *   - a tab/group in a custom container round-trips to the SAME logical container;
 *   - default/temporary markers are handled (never registered as real containers);
 *   - a missing registry definition falls back to the local default (never fails).
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs).
 */

import {
    stringifyContainer,
    mapStateContainers,
    mapEventContainers,
    makeOutboundMapper,
    makeInboundMapper,
    DEFAULT_MARKER,
    TEMPORARY_MARKER,
} from './container-map.js';

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

// --- fixtures ---------------------------------------------------------------
// PC1 local containers (per-install cookieStoreIds).
const PC1_CONTAINERS = {
    'firefox-container-1': {name: 'Work', color: 'blue', icon: 'briefcase'},
    'firefox-container-2': {name: 'Shopping', color: 'red', icon: 'cart'},
    'firefox-container-9': {name: 'temp', color: 'toolbar', icon: 'chill'}, // temporary
};
// PC2 local containers: SAME "Work" identity at a DIFFERENT cookieStoreId, no Shopping.
const PC2_CONTAINERS = {
    'firefox-container-7': {name: 'Work', color: 'blue', icon: 'briefcase'},
};

const isDefault = csId => !csId || csId === DEFAULT_MARKER || csId.includes('default');
const isPc1Temp = csId => csId === 'firefox-container-9';
const isPc2Temp = () => false;

// ---------------------------------------------------------------------------
// 1. stringifyContainer is name+color+icon, stable across machines for one identity.
// ---------------------------------------------------------------------------
{
    const a = stringifyContainer(PC1_CONTAINERS['firefox-container-1']);
    const b = stringifyContainer(PC2_CONTAINERS['firefox-container-7']);
    check('stringifyContainer = name+color+icon', a === 'Workbluebriefcase');
    check('same identity -> same key across machines (diff cookieStoreId)', a === b);
}

// ---------------------------------------------------------------------------
// 2. OUTBOUND: a tab/group state maps local cookieStoreIds to portable keys and
//    populates the registry; default/temporary/unknown handled.
// ---------------------------------------------------------------------------
{
    const registry = {};
    const out = makeOutboundMapper(PC1_CONTAINERS, registry, isDefault, isPc1Temp);

    const state = {
        groups: [{
            id: 'g1',
            newTabContainer: 'firefox-container-1',
            catchTabContainers: ['firefox-container-2', 'firefox-container-1'],
            excludeContainersForReOpen: ['firefox-default'],
            tabs: [
                {uid: 't1', cookieStoreId: 'firefox-container-1'},
                {uid: 't2', cookieStoreId: 'firefox-default'},
                {uid: 't3', cookieStoreId: 'firefox-container-9'}, // temporary
                {uid: 't4', cookieStoreId: 'firefox-container-404'}, // unknown / missing
            ],
        }],
        pinnedTabs: [{uid: 'p1', cookieStoreId: 'firefox-container-2'}],
        options: {defaultGroupProps: {newTabContainer: 'firefox-container-1', catchTabContainers: []}},
    };

    mapStateContainers(state, out);

    const g = state.groups[0];
    check('outbound: newTabContainer -> portable key', g.newTabContainer === 'Workbluebriefcase');
    check('outbound: array field mapped elementwise', g.catchTabContainers[0] === 'Shoppingredcart' && g.catchTabContainers[1] === 'Workbluebriefcase');
    check('outbound: default field -> DEFAULT_MARKER', g.excludeContainersForReOpen[0] === DEFAULT_MARKER);
    check('outbound: tab in custom container -> portable key', g.tabs[0].cookieStoreId === 'Workbluebriefcase');
    check('outbound: tab in default -> DEFAULT_MARKER', g.tabs[1].cookieStoreId === DEFAULT_MARKER);
    check('outbound: tab in temporary -> TEMPORARY_MARKER', g.tabs[2].cookieStoreId === TEMPORARY_MARKER);
    check('outbound: tab in unknown container -> DEFAULT_MARKER (no fail)', g.tabs[3].cookieStoreId === DEFAULT_MARKER);
    check('outbound: pinned tab mapped', state.pinnedTabs[0].cookieStoreId === 'Shoppingredcart');
    check('outbound: defaultGroupProps option mapped', state.options.defaultGroupProps.newTabContainer === 'Workbluebriefcase');

    check('registry has Work + Shopping', !!registry['Workbluebriefcase'] && !!registry['Shoppingredcart']);
    check('registry value is {name,color,icon}', registry['Workbluebriefcase'].name === 'Work' && registry['Workbluebriefcase'].color === 'blue' && registry['Workbluebriefcase'].icon === 'briefcase');
    check('registry never holds temporary as a real container', !Object.values(registry).some(c => c.icon === 'chill'));
}

// ---------------------------------------------------------------------------
// 3. ROUND-TRIP: PC1 outbound (Work/Shopping) -> portable -> PC2 inbound.
//    PC2 already has Work (diff id) so it REUSES it; Shopping is absent so it CREATES.
// ---------------------------------------------------------------------------
{
    const registry = {};
    const out = makeOutboundMapper(PC1_CONTAINERS, registry, isDefault, isPc1Temp);

    const state = {groups: [{id: 'g', tabs: [
        {uid: 'tWork', cookieStoreId: 'firefox-container-1'},
        {uid: 'tShop', cookieStoreId: 'firefox-container-2'},
        {uid: 'tDef', cookieStoreId: 'firefox-default'},
    ]}]};
    mapStateContainers(state, out);

    // PC2 inbound: find-or-create against PC2 containers.
    const created = [];
    let nextId = 100;
    const findOrCreate = identity => {
        // find a PC2 container whose name+color+icon match.
        for (const [csId, c] of Object.entries(PC2_CONTAINERS)) {
            if (c.name === identity.name && c.color === identity.color && c.icon === identity.icon) {
                return csId;
            }
        }
        const csId = 'firefox-container-' + (nextId++);
        PC2_CONTAINERS[csId] = {...identity};
        created.push(csId);
        return csId;
    };
    const inb = makeInboundMapper(registry, 'firefox-default', findOrCreate, () => 'firefox-default');

    mapStateContainers(state, inb);
    const tabs = state.groups[0].tabs;

    check('round-trip: Work reuses existing PC2 container (no create)', tabs[0].cookieStoreId === 'firefox-container-7');
    check('round-trip: Shopping created on PC2', created.length === 1 && tabs[1].cookieStoreId === created[0]);
    check('round-trip: default -> PC2 local default', tabs[2].cookieStoreId === 'firefox-default');
}

// ---------------------------------------------------------------------------
// 4. INBOUND: find-or-create called AT MOST ONCE per identity (cached per round).
// ---------------------------------------------------------------------------
{
    const registry = {'Workbluebriefcase': {name: 'Work', color: 'blue', icon: 'briefcase'}};
    let calls = 0;
    const findOrCreate = () => { calls++; return 'firefox-container-50'; };
    const inb = makeInboundMapper(registry, 'firefox-default', findOrCreate, () => 'firefox-default');

    const state = {groups: [{id: 'g', tabs: [
        {uid: 'a', cookieStoreId: 'Workbluebriefcase'},
        {uid: 'b', cookieStoreId: 'Workbluebriefcase'},
        {uid: 'c', cookieStoreId: 'Workbluebriefcase'},
    ]}]};
    mapStateContainers(state, inb);

    check('inbound: find-or-create cached (one call for repeated identity)', calls === 1, `calls=${calls}`);
    check('inbound: all three tabs resolved to same local id', state.groups[0].tabs.every(t => t.cookieStoreId === 'firefox-container-50'));
}

// ---------------------------------------------------------------------------
// 5. INBOUND: missing registry definition -> local default (never fail).
//    TEMPORARY_MARKER -> resolveTemporary(); DEFAULT_MARKER -> localDefault.
// ---------------------------------------------------------------------------
{
    const inb = makeInboundMapper({}, 'icecat-default', () => 'should-not-be-called', () => 'firefox-tmp-1');
    check('inbound: unknown portable key -> local default', inb('GhostgreenX') === 'icecat-default');
    check('inbound: DEFAULT_MARKER -> local default', inb(DEFAULT_MARKER) === 'icecat-default');
    check('inbound: null -> local default', inb(null) === 'icecat-default');
    check('inbound: TEMPORARY_MARKER -> resolveTemporary', inb(TEMPORARY_MARKER) === 'firefox-tmp-1');
}

// ---------------------------------------------------------------------------
// 6. mapEventContainers maps tab/group/pinned/option.set(defaultGroupProps) payloads.
// ---------------------------------------------------------------------------
{
    const registry = {};
    const out = makeOutboundMapper(PC1_CONTAINERS, registry, isDefault, isPc1Temp);

    const tabEvent = {op: 'tab.add', groupId: 'g', tab: {uid: 't', cookieStoreId: 'firefox-container-1'}};
    const groupEvent = {op: 'group.add', group: {id: 'g', newTabContainer: 'firefox-container-2', catchTabContainers: ['firefox-container-1']}};
    const pinnedEvent = {op: 'pinned.add', tab: {uid: 'p', cookieStoreId: 'firefox-container-2'}};
    const optEvent = {op: 'option.set', key: 'defaultGroupProps', value: {newTabContainer: 'firefox-container-1'}};
    const otherOpt = {op: 'option.set', key: 'showContextMenuOnTabs', value: true};

    mapEventContainers(tabEvent, out);
    mapEventContainers(groupEvent, out);
    mapEventContainers(pinnedEvent, out);
    mapEventContainers(optEvent, out);
    mapEventContainers(otherOpt, out);

    check('event: tab.add cookieStoreId mapped', tabEvent.tab.cookieStoreId === 'Workbluebriefcase');
    check('event: group.add container keys mapped', groupEvent.group.newTabContainer === 'Shoppingredcart' && groupEvent.group.catchTabContainers[0] === 'Workbluebriefcase');
    check('event: pinned.add cookieStoreId mapped', pinnedEvent.tab.cookieStoreId === 'Shoppingredcart');
    check('event: option.set defaultGroupProps mapped', optEvent.value.newTabContainer === 'Workbluebriefcase');
    check('event: non-container option.set untouched', otherOpt.value === true);
}

{
    const registry = {};
    const out = makeOutboundMapper(PC1_CONTAINERS, registry, isDefault, isPc1Temp);

    const event = {op: 'tab.add', groupId: 'g', tab: {uid: 't', cookieStoreId: 'firefox-container-1'}};
    mapEventContainers(event, out);
    check('double-map hazard: first outbound pass yields the portable key', event.tab.cookieStoreId === 'Workbluebriefcase');

    mapEventContainers(event, out);
    check('double-map hazard: re-mapping an already-portable key silently degrades it to DEFAULT_MARKER',
        event.tab.cookieStoreId === DEFAULT_MARKER, event.tab.cookieStoreId);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
