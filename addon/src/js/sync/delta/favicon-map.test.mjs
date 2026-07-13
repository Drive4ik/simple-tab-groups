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

import {buildFavIconMap, serializeFavIconMap, mergeFavIconMaps, MAX_FAVICON_ENTRY_BYTES} from './favicon-map.js';

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
const HTTP_A = 'https://a.example/favicon.ico';
const HTTP_B = 'https://b.example/static/icon.png';

// resolve the built {tabs, blobs} file back to a flat {uid: favIconUrl} view for assertions.
function resolve(map) {
    const flat = {};
    for (const [uid, hash] of Object.entries(map.tabs)) {
        flat[uid] = map.blobs[hash];
    }
    return flat;
}

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
    const flat = resolve(map);

    check('build: live group tab favicon captured', flat.live1 === FAV_A);
    check('build: ARCHIVED group tab favicon captured', flat.arch1 === FAV_B);
    check('build: pinned tab favicon captured', flat.pin1 === FAV_C);
    check('build: exactly the three data: favicons', Object.keys(map.tabs).length === 3);
}

// --- 2. map build admits http(s) favicons, skips favicon-less and uid-less tabs ----
{
    const map = buildFavIconMap([{id: 'g', title: 'G', tabs: [
        {uid: 'u1', url: 'https://a', favIconUrl: HTTP_A},   // http ⇒ stored (the common case)
        {uid: 'u2', url: 'https://b'},                        // none ⇒ skip
        {url: 'https://c', favIconUrl: FAV_A},               // no uid ⇒ skip
        {uid: 'u4', url: 'ftp://d', favIconUrl: 'ftp://d/i'}, // unsupported scheme ⇒ skip
    ]}], []);
    check('build: http favicon stored under its uid', resolve(map).u1 === HTTP_A);
    check('build: only the uid-bearing supported favicon is stored', Object.keys(map.tabs).length === 1);
}

// --- 3. overwrite-on-change write gating (serialize compare) ------------------
{
    let marker = null; // stands in for storage[favIconMapKey(deviceId)]
    const gate = map => {
        const serialized = serializeFavIconMap(map);
        if (serialized === marker) {
            return {write: false};
        }
        if (!Object.keys(map.tabs).length && marker == null) {
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
    const a = serializeFavIconMap({tabs: {u2: 'h2', u1: 'h1'}, blobs: {h2: FAV_B, h1: FAV_A}});
    const b = serializeFavIconMap({tabs: {u1: 'h1', u2: 'h2'}, blobs: {h1: FAV_A, h2: FAV_B}});
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
    const device1Flat = resolve(device1Map);
    check('acceptance: device1 favicon file has both archived-tab favicons',
        device1Flat['arch-uid-1'] === FAV_A && device1Flat['arch-uid-2'] === FAV_B);

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

// --- 6. HTTP round-trip: an archived tab's http favicon reaches the receiver -----
// Regression guard: http(s) favicons (nearly every live tab) must propagate, not be dropped.
{
    const archivedGroup = {
        id: 'g-http',
        title: 'Archived',
        isArchive: true,
        tabs: [
            {uid: 'http-uid-1', url: 'https://a', title: 'A', favIconUrl: HTTP_A},
            {uid: 'http-uid-2', url: 'https://b', title: 'B', favIconUrl: HTTP_B},
        ],
    };

    const device1Map = buildFavIconMap([archivedGroup], []);
    const device1Flat = resolve(device1Map);
    check('http round-trip: device1 file carries both archived http favicons',
        device1Flat['http-uid-1'] === HTTP_A && device1Flat['http-uid-2'] === HTTP_B);

    const device2Groups = [{
        id: 'g-http',
        title: 'Archived',
        isArchive: true,
        tabs: [
            {uid: 'http-uid-1', url: 'https://a', title: 'A'},
            {uid: 'http-uid-2', url: 'https://b', title: 'B'},
        ],
    }];

    const merged = mergeFavIconMaps([{name: 'STG-sync-favicons-D1.json', content: device1Map}]);
    const changed = applyToRecords(device2Groups, merged);

    check('http round-trip: applying http favicons mutated the archived records', changed === true);
    check('http round-trip: device2 archived tab 1 http favicon resolved by uid', device2Groups[0].tabs[0].favIconUrl === HTTP_A);
    check('http round-trip: device2 archived tab 2 http favicon resolved by uid', device2Groups[0].tabs[1].favIconUrl === HTTP_B);
    check('http round-trip: re-apply is idempotent', applyToRecords(device2Groups, merged) === false);
}

// --- 7. overflow policy: cheap http URLs are kept, huge distinct data: blobs evicted first, warns ----
{
    // distinct near-cap blobs whose total blows the per-file budget; http URLs stay cheap.
    const bigBlob = i => 'data:image/png;base64,' + String.fromCharCode(65 + (i % 26)) + 'A'.repeat(MAX_FAVICON_ENTRY_BYTES - 200);
    const tabs = [];
    for (let i = 0; i < 40; i++) {
        tabs.push({uid: `blob${String(i).padStart(3, '0')}`, url: `https://x/${i}`, favIconUrl: bigBlob(i)});
    }
    for (let i = 0; i < 40; i++) {
        tabs.push({uid: `http${String(i).padStart(3, '0')}`, url: `https://y/${i}`, favIconUrl: `https://y.example/${i}/favicon.ico`});
    }

    let overflow = null;
    const map = buildFavIconMap([{id: 'g', title: 'G', tabs}], [], info => { overflow = info; });

    const keptTabs = Object.keys(map.tabs);
    const keptHttp = keptTabs.filter(k => k.startsWith('http')).length;
    const keptBlob = keptTabs.filter(k => k.startsWith('blob')).length;
    check('overflow: every cheap http favicon is kept', keptHttp === 40);
    check('overflow: huge data: blobs are the ones evicted', keptBlob < 40);
    check('overflow: an overflow warning is emitted', overflow !== null && overflow.dropped > 0);
    check('overflow: no silent truncation (dropped count reported)', overflow.dropped === 80 - keptTabs.length);
    check('overflow: reported drops are budget evictions, not per-favicon oversize', overflow.budgetDropped === overflow.dropped && overflow.oversized === 0);
}

// --- 8. LARGE data: favicon round-trips into the map and applies on the receiver ----
// Regression: a real 40KB data: PNG favicon used to be silently dropped by the 30000-char
// per-favicon cap. It must now survive build → merge → apply.
{
    const bigDataFavicon = 'data:image/png;base64,iVBORw0KGgoAAAANSU' + 'Z'.repeat(40_000);
    check('large-favicon: test blob is bigger than the old 30000 cap', bigDataFavicon.length > 30_000);

    const device1Map = buildFavIconMap([{id: 'g', title: 'G', tabs: [
        {uid: 'big-uid', url: 'https://a', favIconUrl: bigDataFavicon},
    ]}], []);
    check('large-favicon: 40KB data: favicon is stored (not dropped)', resolve(device1Map)['big-uid'] === bigDataFavicon);

    const merged = mergeFavIconMaps([{name: 'STG-sync-favicons-D1.json', content: device1Map}]);
    const receiver = [{id: 'g', title: 'G', isArchive: true, tabs: [{uid: 'big-uid', url: 'https://a', title: 'A'}]}];
    const changed = applyToRecords(receiver, merged);
    check('large-favicon: applies onto the receiver record', changed === true && receiver[0].tabs[0].favIconUrl === bigDataFavicon);
}

// --- 9. content-hash dedup: many tabs sharing one favicon store the blob ONCE ----
{
    const shared = 'data:image/png;base64,' + 'Q'.repeat(5_000);
    const tabs = [];
    for (let i = 0; i < 25; i++) {
        tabs.push({uid: `dup${String(i).padStart(3, '0')}`, url: `https://x/${i}`, favIconUrl: shared});
    }
    tabs.push({uid: 'other', url: 'https://z', favIconUrl: FAV_A});

    const map = buildFavIconMap([{id: 'g', title: 'G', tabs}], []);
    check('dedup: every tab still has an entry', Object.keys(map.tabs).length === 26);
    check('dedup: the shared favicon is stored exactly once', Object.values(map.blobs).filter(v => v === shared).length === 1);
    check('dedup: distinct favicon adds a second blob', Object.keys(map.blobs).length === 2);

    const flat = resolve(map);
    check('dedup: all 25 shared-favicon tabs resolve to the blob', Array.from({length: 25}, (_, i) => flat[`dup${String(i).padStart(3, '0')}`]).every(v => v === shared));
    check('dedup: the distinct tab resolves to its own favicon', flat.other === FAV_A);

    // the deduped file is far smaller than storing the blob per tab.
    const dedupedSize = serializeFavIconMap(map).length;
    check('dedup: file is much smaller than 25 copies of the blob', dedupedSize < shared.length * 3);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
