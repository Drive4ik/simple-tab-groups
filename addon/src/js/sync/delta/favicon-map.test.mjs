/**
 * Standalone node test for the per-device favicon file (`favicon-map.js`).
 *
 * Plain `node favicon-map.test.mjs` (STG has no test runner). `favicon-map.js` is PURE
 * (only imports the pure `sanitizeFavIconUrlForFile` from `url-sync.js`), so it is imported
 * directly and its real contracts are asserted. The impure apply path (`favicon-file.js`,
 * `Cache.setTabFavIcon` / `Groups.save`) is modelled here by a tiny pure reducer that mirrors
 * `applyArchivedFavIcons` — the same by-uid assignment into archived-group tab records.
 *
 * Covers: map build (live + archived + pinned), overwrite-on-change write gating,
 * merge-on-pull (union by uid), and the ARCHIVED backup→restore→sync acceptance case.
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs).
 */

import {buildFavIconMap, serializeFavIconMap, mergeFavIconMaps} from './favicon-map.js';

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

const FAV_A = 'data:image/png;base64,' + 'A'.repeat(64);
const FAV_B = 'data:image/png;base64,' + 'B'.repeat(64);
const FAV_C = 'data:image/png;base64,' + 'C'.repeat(64);

// mirror of favicon-file.js applyArchivedFavIcons (pure): assign favicons by uid into records.
function applyToRecords(groups, mergedMap) {
    let changed = false;
    for (const group of groups) {
        for (const tab of group.tabs || []) {
            if (tab.uid != null && Object.hasOwn(mergedMap, tab.uid) && tab.favIconUrl !== mergedMap[tab.uid]) {
                tab.favIconUrl = mergedMap[tab.uid];
                changed = true;
            }
        }
    }
    return changed;
}

// --- 1. map build spans live groups, archived groups, and pinned tabs --------
{
    const liveGroup = {id: 'g1', title: 'Live', tabs: [{uid: 'live1', url: 'https://a', favIconUrl: FAV_A}]};
    const archivedGroup = {id: 'g2', title: 'Arch', isArchive: true, tabs: [{uid: 'arch1', url: 'https://b', favIconUrl: FAV_B}]};
    const pinned = [{uid: 'pin1', url: 'https://c', favIconUrl: FAV_C}];

    const map = buildFavIconMap([liveGroup, archivedGroup], pinned);

    check('build: live group tab favicon captured', map.live1 === FAV_A);
    check('build: ARCHIVED group tab favicon captured', map.arch1 === FAV_B);
    check('build: pinned tab favicon captured', map.pin1 === FAV_C);
    check('build: exactly the three data: favicons', Object.keys(map).length === 3);
}

// --- 2. map build ignores url favicons, favicon-less and uid-less tabs --------
{
    const map = buildFavIconMap([{id: 'g', title: 'G', tabs: [
        {uid: 'u1', url: 'https://a', favIconUrl: 'https://a/favicon.ico'}, // url ⇒ skip
        {uid: 'u2', url: 'https://b'},                                       // none ⇒ skip
        {url: 'https://c', favIconUrl: FAV_A},                              // no uid ⇒ skip
    ]}], []);
    check('build: only data: favicons with a uid are stored', Object.keys(map).length === 0);
}

// --- 3. overwrite-on-change write gating (serialize compare) ------------------
{
    let marker = null; // stands in for storage[favIconMapKey(deviceId)]
    const gate = map => {
        const serialized = serializeFavIconMap(map);
        if (serialized === marker) {
            return {write: false};
        }
        if (!Object.keys(map).length && marker == null) {
            return {write: false};
        }
        return {write: true, serialized};
    };

    const map1 = buildFavIconMap([{id: 'g', title: 'G', tabs: [{uid: 'u1', url: 'x', favIconUrl: FAV_A}]}], []);
    const first = gate(map1);
    check('gate: first non-empty map writes', first.write === true);
    marker = first.serialized;

    const map2 = buildFavIconMap([{id: 'g', title: 'G', tabs: [{uid: 'u1', url: 'x', favIconUrl: FAV_A}]}], []);
    check('gate: unchanged map does NOT rewrite', gate(map2).write === false);

    const map3 = buildFavIconMap([{id: 'g', title: 'G', tabs: [{uid: 'u1', url: 'x', favIconUrl: FAV_B}]}], []);
    const third = gate(map3);
    check('gate: a changed favicon rewrites', third.write === true);
    marker = third.serialized;

    // serialization is key-order independent (stable compare).
    const a = serializeFavIconMap({u2: FAV_B, u1: FAV_A});
    const b = serializeFavIconMap({u1: FAV_A, u2: FAV_B});
    check('gate: serialization is deterministic regardless of key order', a === b);
}

// --- 4. merge-on-pull unions every device's file by uid ----------------------
{
    const deviceFiles = [
        {name: 'STG-sync-favicons-A.json', content: {shared: FAV_A, onlyA: FAV_A}},
        {name: 'STG-sync-favicons-B.json', content: {shared: FAV_B, onlyB: FAV_B}},
        {name: 'STG-sync-favicons-C.json', content: null}, // tolerated
    ];
    const merged = mergeFavIconMaps(deviceFiles);
    check('merge: union carries every uid', merged.onlyA === FAV_A && merged.onlyB === FAV_B);
    check('merge: collision resolves to one value (first device wins)', merged.shared === FAV_A);
    check('merge: null/garbage files tolerated', Object.keys(merged).length === 3);
}

// --- 5. ACCEPTANCE: archived group favicons survive backup→restore→sync ------
// Device 1 restores a backup whose ARCHIVED group tabs keep their uid + data: favicon
// verbatim (uid is stable through backup→restore — archived tab records are copied as-is).
{
    const restoredArchivedGroup = {
        id: 'restored-g',
        title: 'Archived',
        isArchive: true,
        tabs: [
            {uid: 'arch-uid-1', url: 'https://a', title: 'A', favIconUrl: FAV_A},
            {uid: 'arch-uid-2', url: 'https://b', title: 'B', favIconUrl: FAV_B},
        ],
    };

    // Device 1 push: build the favicon file from the full model (archived group included).
    const device1Map = buildFavIconMap([restoredArchivedGroup], []);
    check('acceptance: device1 favicon file has both archived-tab favicons',
        device1Map['arch-uid-1'] === FAV_A && device1Map['arch-uid-2'] === FAV_B);

    // Device 2 has the same archived group by uid (from delta-synced group/tab events) but
    // WITHOUT favicons — favicons never ride the delta log.
    const device2Groups = [{
        id: 'restored-g',
        title: 'Archived',
        isArchive: true,
        tabs: [
            {uid: 'arch-uid-1', url: 'https://a', title: 'A'},
            {uid: 'arch-uid-2', url: 'https://b', title: 'B'},
        ],
    }];
    check('acceptance: device2 archived tabs start with no favicon',
        device2Groups[0].tabs.every(t => t.favIconUrl == null));

    // Device 2 pull: merge device1's favicon file, apply by uid into the archived records.
    const merged = mergeFavIconMaps([{name: 'STG-sync-favicons-D1.json', content: device1Map}]);
    const changed = applyToRecords(device2Groups, merged);

    check('acceptance: applying favicons mutated the archived records', changed === true);
    check('acceptance: device2 archived tab 1 favicon resolved by uid', device2Groups[0].tabs[0].favIconUrl === FAV_A);
    check('acceptance: device2 archived tab 2 favicon resolved by uid', device2Groups[0].tabs[1].favIconUrl === FAV_B);

    // idempotent: a second apply with the same map changes nothing.
    check('acceptance: re-apply is idempotent', applyToRecords(device2Groups, merged) === false);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
