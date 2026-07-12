/**
 * Standalone node test for the favicon bloat-bound (the 5 GB `syncDeltaLog` regression).
 *
 * Plain `node favicon-bloat.test.mjs` (STG has no test runner). The delta log events and
 * the snapshot now carry NO favicon at all — favicons (including `data:` blobs) travel in a
 * separate per-device favicon file keyed by `uid`, so a single favicon can only ever exist
 * once per tab, never duplicated across O(events). The PURE contracts are asserted here:
 *
 *   1. Event/record building strips favicons entirely — neither a `data:` blob nor a URL
 *      reference is written into any tab/pinned/group record.
 *   2. A favicon-ONLY change emits NO delta event (unchanged behaviour).
 *   3. The favicon file (built by buildFavIconMap) carries `data:` favicons keyed by uid,
 *      exactly one entry per tab, capped per-favicon and per-file.
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs).
 */

import {sanitizeFavIconUrlForFile, sanitizeGroupIconUrl, sanitizeGroupRecordForSync} from './url-sync.js';
import {buildFavIconMap, serializeFavIconMap, MAX_FAVICON_FILE_BYTES, MAX_FAVICON_ENTRY_BYTES} from './favicon-map.js';

// resolve the built {tabs, blobs} file back to a flat {uid: favIconUrl} view for assertions.
function resolve(map) {
    const flat = {};
    for (const [uid, hash] of Object.entries(map.tabs)) {
        flat[uid] = map.blobs[hash];
    }
    return flat;
}

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

// --- copy of delta-capture.js buildBaseTabRecord favicon handling (kept identical) ----
// The record NEVER carries a favicon field now; buildFavIconMap is the only favicon path.
function buildTabRecord(tab) {
    return {
        uid: tab.uid,
        url: tab.url,
        title: tab.title,
    };
}

// --- copy of tabs.js onUpdated emit gate (kept identical to the grouped + pinned paths) ---
function wouldEmitDelta(changeInfo) {
    return Object.hasOwn(changeInfo, 'title') || Object.hasOwn(changeInfo, 'url');
}

const NORMAL_DATA_FAVICON = 'data:image/png;base64,iVBORw0KGgoAAAANSU' + 'A'.repeat(2000);

// --- 1. records carry NO favicon (neither data: nor url) ---------------------
{
    const groupTab = buildTabRecord({uid: 'u1', url: 'https://a', title: 'A', favIconUrl: NORMAL_DATA_FAVICON});
    check('tab record carries no favicon field', !('favIconUrl' in groupTab));

    const groupTabHttp = buildTabRecord({uid: 'u2', url: 'https://a', title: 'A', favIconUrl: 'https://a/favicon.ico'});
    check('tab record carries no url favicon either', !('favIconUrl' in groupTabHttp));
}

// --- 2. a favicon-only change does NOT produce a delta event -----------------
{
    check('favicon-only change emits NO delta', wouldEmitDelta({favIconUrl: NORMAL_DATA_FAVICON}) === false);
    check('title change still emits a delta', wouldEmitDelta({title: 'New'}) === true);
    check('url change still emits a delta', wouldEmitDelta({url: 'https://new'}) === true);
}

// --- 3. group records (which carry their tabs) are stripped of favicons + thumbnails ----
{
    const archivedGroup = {
        id: 'g1',
        title: 'Archived',
        isArchive: true,
        iconUrl: 'data:image/png;base64,' + 'B'.repeat(200),
        tabs: [
            {uid: 't1', url: 'https://a', title: 'A', favIconUrl: NORMAL_DATA_FAVICON, thumbnail: 'data:image/jpeg;base64,' + 'C'.repeat(5000)},
            {uid: 't2', url: 'https://b', title: 'B', favIconUrl: 'https://b/favicon.ico'},
        ],
    };
    const sanitized = sanitizeGroupRecordForSync(archivedGroup);

    check('group record: tab thumbnails stripped', sanitized.tabs.every(t => !Object.hasOwn(t, 'thumbnail')));
    check('group record: data: tab favicon dropped', !Object.hasOwn(sanitized.tabs[0], 'favIconUrl'));
    check('group record: url tab favicon dropped too', !Object.hasOwn(sanitized.tabs[1], 'favIconUrl'));
    check('group record: small data: group icon kept', sanitized.iconUrl === archivedGroup.iconUrl);
    check('group record: other props preserved', sanitized.id === 'g1' && sanitized.isArchive === true && sanitized.tabs[0].url === 'https://a');
    check('group record: source group untouched',
        Object.hasOwn(archivedGroup.tabs[0], 'thumbnail') && archivedGroup.tabs[0].favIconUrl === NORMAL_DATA_FAVICON);
}

// --- 4. the favicon file keeps favicons (data: AND http) keyed by uid (one entry per tab) ----
// Favicons never ride the delta log/snapshot; they travel ONLY in this per-device file, so a
// single favicon exists once per tab regardless of how many events touch it (no O(events) bloat).
{
    const map = buildFavIconMap(
        [{id: 'g1', title: 'G', tabs: [
            {uid: 'u1', url: 'https://a', favIconUrl: NORMAL_DATA_FAVICON},
            {uid: 'u2', url: 'https://b', favIconUrl: 'https://b/favicon.ico'}, // http ⇒ stored
            {uid: 'u3', url: 'https://c'},                                       // no favicon
        ]}],
        [],
    );
    const flat = resolve(map);
    check('favicon file: data: favicon stored under uid', flat.u1 === NORMAL_DATA_FAVICON);
    check('favicon file: http favicon stored under uid', flat.u2 === 'https://b/favicon.ico');
    check('favicon file: favicon-less tab has no entry', !('u3' in map.tabs));
    check('favicon file: exactly one entry per favicon-bearing tab', Object.keys(map.tabs).length === 2);
}

// --- 5. per-favicon cap + per-file budget guard the file size (caps tied to gist limit) ----
{
    // an ordinary embedded data: favicon (well under the per-favicon cap) is KEPT, not dropped.
    const normalBlob = 'data:image/png;base64,' + 'A'.repeat(40_000);
    check('normal 40KB data: favicon is under the per-favicon cap', normalBlob.length < MAX_FAVICON_ENTRY_BYTES);
    const kept = buildFavIconMap([{id: 'g', title: 'G', tabs: [{uid: 'k', url: 'https://x', favIconUrl: normalBlob}]}], []);
    check('favicon file: a normal data: favicon is stored (not silently dropped)', resolve(kept).k === normalBlob);

    // a genuinely pathological favicon (over the per-favicon cap) is dropped LOUDLY, never silently.
    const pathological = 'data:image/png;base64,' + 'A'.repeat(MAX_FAVICON_ENTRY_BYTES + 1);
    let entryOverflow = null;
    const capped = buildFavIconMap(
        [{id: 'g', title: 'G', tabs: [{uid: 'big', url: 'https://x', favIconUrl: pathological}]}],
        [],
        info => { entryOverflow = info; },
    );
    check('favicon file: pathological favicon dropped', !('big' in capped.tabs));
    check('favicon file: per-favicon drop is reported (not silent)', entryOverflow !== null && entryOverflow.oversized === 1);

    // per-file budget: distinct near-cap blobs are evicted (largest first) to stay within budget.
    const nearCap = 'data:image/png;base64,' + 'A'.repeat(MAX_FAVICON_ENTRY_BYTES - 100);
    const many = [];
    for (let i = 0; i < 200; i++) {
        many.push({uid: `k${String(i).padStart(3, '0')}`, url: `https://x/${i}`, favIconUrl: nearCap + i});
    }
    let budgetOverflow = null;
    const budgeted = buildFavIconMap([{id: 'g', title: 'G', tabs: many}], [], info => { budgetOverflow = info; });
    check('favicon file: total serialized stays within the per-file budget', serializeFavIconMap(budgeted).length <= MAX_FAVICON_FILE_BYTES);
    check('favicon file: budget drops the overflow entries', Object.keys(budgeted.tabs).length < many.length);
    check('favicon file: budget drop is reported (not silent)', budgetOverflow !== null && budgetOverflow.budgetDropped > 0);
}

// --- group icon sanitizer (unchanged) ---------------------------------------
{
    check('sanitizeGroupIconUrl keeps a small data: icon', sanitizeGroupIconUrl('data:image/png;base64,AAA') === 'data:image/png;base64,AAA');
    check('sanitizeGroupIconUrl keeps a small url icon', sanitizeGroupIconUrl('https://a/icon.svg') === 'https://a/icon.svg');
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
