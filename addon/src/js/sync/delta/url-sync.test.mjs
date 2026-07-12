/**
 * Standalone node test for the PURE URL classifiers (`url-sync.js`).
 *
 * Plain `node url-sync.test.mjs` (STG has no test runner). The module is pure (no
 * `browser.*` / `constants.js`), so it imports directly. Proves:
 *   - non-trivial about: URLs (about:debugging/config/…) ARE syncable, while the trivial
 *     new-tab/blank states (about:blank/newtab/home/privatebrowsing) are NOT;
 *   - everything the real-creation allow-list admits (http/moz-extension/view-source) stays
 *     syncable;
 *   - STG's "unsupported URL" stub page (moz-extension://…/help/stg-unsupported-url.html
 *     ?url=ORIG) decodes back to the embedded original — so a stub-rendered about: tab keeps
 *     its original identity and never diverges into a competing moz-extension tab record.
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs).
 */

import {
    isUrlSyncable,
    unwrapStubUrl,
    sanitizeFavIconUrlForFile,
    MAX_FILE_FAVICON_LENGTH,
    liveUrlMatchesSource,
    shouldNavigateLiveTabUrl,
} from './url-sync.js';

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

const STUB = 'moz-extension://abcd-1234-uuid/help/stg-unsupported-url.html';

// --- isUrlSyncable: non-trivial about: URLs sync ----------------------------
{
    for (const url of ['about:debugging', 'about:config', 'about:addons', 'about:preferences']) {
        check(`syncable: ${url}`, isUrlSyncable(url) === true);
    }
}

// --- isUrlSyncable: trivial about: states do NOT sync -----------------------
{
    for (const url of ['about:blank', 'about:newtab', 'about:home', 'about:privatebrowsing']) {
        check(`NOT syncable: ${url}`, isUrlSyncable(url) === false);
    }
}

// --- isUrlSyncable: ordinary creatable URLs stay syncable -------------------
{
    check('syncable: http', isUrlSyncable('http://example.com/') === true);
    check('syncable: https', isUrlSyncable('https://example.com/') === true);
    check('syncable: moz-extension', isUrlSyncable('moz-extension://uuid/page.html') === true);
    check('syncable: view-source', isUrlSyncable('view-source:http://example.com/') === true);
}

// --- isUrlSyncable: junk / empty --------------------------------------------
{
    check('NOT syncable: empty string', isUrlSyncable('') === false);
    check('NOT syncable: null', isUrlSyncable(null) === false);
    check('NOT syncable: ftp', isUrlSyncable('ftp://example.com/') === false);
}

// --- unwrapStubUrl: stub decodes back to embedded original ------------------
{
    const stubbed = `${STUB}?url=${encodeURIComponent('about:debugging')}`;
    check('stub decodes back to about:debugging', unwrapStubUrl(stubbed) === 'about:debugging');

    const stubbedConfig = `${STUB}?url=${encodeURIComponent('about:config')}`;
    check('stub decodes back to about:config', unwrapStubUrl(stubbedConfig) === 'about:config');
}

// --- unwrapStubUrl: NO divergence — round trip identity ---------------------
{
    // the captured record of a stub-rendered tab must match the ORIGINAL about: uid url,
    // not the moz-extension stub url, so the two machines never diverge.
    const original = 'about:debugging';
    const stubbed = `${STUB}?url=${encodeURIComponent(original)}`;
    const recovered = unwrapStubUrl(stubbed);
    check('stub round-trip does not diverge', recovered === original);
    check('recovered url is itself syncable', isUrlSyncable(recovered) === true);
    check('recovered url is NOT the moz-extension stub', recovered !== stubbed);
}

// --- unwrapStubUrl: non-stub URLs pass through unchanged ---------------------
{
    check('plain http passes through', unwrapStubUrl('http://example.com/') === 'http://example.com/');
    check('about: passes through', unwrapStubUrl('about:debugging') === 'about:debugging');
    // a genuine non-stub moz-extension page (real STG page) must NOT be unwrapped.
    const realPage = 'moz-extension://uuid/manage/manage.html?x=1';
    check('non-stub moz-extension passes through', unwrapStubUrl(realPage) === realPage);
    // malformed / non-string input never throws.
    check('null passes through', unwrapStubUrl(null) === null);
}

// --- sanitizeFavIconUrlForFile: ADMIT http(s)/moz-extension AND data: favicons, size-capped ---
{
    // The favicon file (never the delta log) is the only favicon channel; it carries the live
    // tab.favIconUrl verbatim — almost always an http(s) URL, occasionally a data: blob.
    const normalDataPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg' + 'A'.repeat(2000);
    check('normal data:image/png favicon kept for file', sanitizeFavIconUrlForFile(normalDataPng) === normalDataPng);
    check('short data: favicon kept for file', sanitizeFavIconUrlForFile('data:image/x,abc') === 'data:image/x,abc');

    // an oversized data: blob (over the per-favicon cap) is dropped so one page can't blow the budget.
    const hugeData = 'data:image/png;base64,' + 'A'.repeat(MAX_FILE_FAVICON_LENGTH + 1);
    check('oversized data: favicon (> cap) dropped', sanitizeFavIconUrlForFile(hugeData) === undefined);

    // a data: favicon EXACTLY at the cap is still kept (boundary: only > cap is dropped).
    const atCap = 'data:' + 'x'.repeat(MAX_FILE_FAVICON_LENGTH - 5);
    check('data: favicon at exactly the cap KEPT', sanitizeFavIconUrlForFile(atCap) === atCap);

    // remote favicon urls ARE stored now (live tabs carry http favIconUrls; the receiver renders
    // the stored string as an <img src>, so unloaded/discarded tabs still show the icon).
    check('http favicon stored in file', sanitizeFavIconUrlForFile('http://e/favicon.ico') === 'http://e/favicon.ico');
    check('https favicon stored in file', sanitizeFavIconUrlForFile('https://e.com/static/icon.png') === 'https://e.com/static/icon.png');
    check('moz-extension favicon stored in file',
        sanitizeFavIconUrlForFile('moz-extension://uuid/icon.png') === 'moz-extension://uuid/icon.png');

    // unsupported schemes are still rejected (only http(s)/moz-extension/data: are admitted).
    check('ftp favicon dropped', sanitizeFavIconUrlForFile('ftp://e/favicon.ico') === undefined);
    check('chrome favicon dropped', sanitizeFavIconUrlForFile('chrome://favicon') === undefined);

    // empty / missing favicon → undefined (omitted).
    check('empty favicon dropped', sanitizeFavIconUrlForFile('') === undefined);
    check('null favicon dropped', sanitizeFavIconUrlForFile(null) === undefined);
    check('undefined favicon dropped', sanitizeFavIconUrlForFile(undefined) === undefined);

    // idempotent: a kept favicon stays kept.
    check('sanitize idempotent on kept data: favicon',
        sanitizeFavIconUrlForFile(sanitizeFavIconUrlForFile(normalDataPng)) === normalDataPng);
    check('sanitize idempotent on kept http favicon',
        sanitizeFavIconUrlForFile(sanitizeFavIconUrlForFile('https://e.com/i.png')) === 'https://e.com/i.png');
}

// ---------------------------------------------------------------------------
// liveUrlMatchesSource — STUB-AWARE uid-stamp match (apply side).
// ---------------------------------------------------------------------------
{
    const stub = url => {
        const u = new URL('moz-extension://uuid/help/stg-unsupported-url.html');
        u.searchParams.set('url', url);
        return u.href;
    };
    check('match: identical http urls', liveUrlMatchesSource('http://a', 'http://a') === true);
    check('match: stub-rendered about: tab matches about: source',
        liveUrlMatchesSource(stub('about:config'), 'about:config') === true);
    check('match: real moz-extension url matches itself',
        liveUrlMatchesSource('moz-extension://uuid/options/options.html', 'moz-extension://uuid/options/options.html') === true);
    check('no match: different urls', liveUrlMatchesSource('http://a', 'http://b') === false);
    check('no match: about:blank live vs http source (mid-load) ⇒ caller falls back to index',
        liveUrlMatchesSource('about:blank', 'http://a') === false);
}

// ---------------------------------------------------------------------------
// shouldNavigateLiveTabUrl — NO-OP convergence guard (apply side).
// ---------------------------------------------------------------------------
{
    const stub = url => {
        const u = new URL('moz-extension://uuid/help/stg-unsupported-url.html');
        u.searchParams.set('url', url);
        return u.href;
    };
    check('navigate when live differs from target', shouldNavigateLiveTabUrl('http://old', 'http://new') === true);
    check('NO-OP when live already equals target', shouldNavigateLiveTabUrl('http://x', 'http://x') === false);
    check('NO-OP when stub-rendered about: tab already at target (stub-decoded)',
        shouldNavigateLiveTabUrl(stub('about:debugging'), 'about:debugging') === false);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
