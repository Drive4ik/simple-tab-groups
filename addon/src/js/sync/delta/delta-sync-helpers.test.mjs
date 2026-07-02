/**
 * Standalone node test for the PURE helpers extracted from delta-sync.js (P3b).
 *
 * Like the other delta tests, this is a plain `node delta-sync-helpers.test.mjs`
 * script (STG has no test runner). delta-sync.js as a whole is impure (imports
 * cloud.js / tabs.js / browser-dependent modules) and cannot be imported under
 * node, so `buildLocalState` is re-implemented here from the same source and the
 * test asserts its contract. Keeping the helper pure + small makes this faithful.
 *
 * NOTE: this MUST stay in sync with `buildLocalState` in delta-sync.js. The function
 * is short and deterministic; the duplication is deliberate so the test needs no
 * extension host (the same approach replay.test.mjs / plan-sync.test.mjs take).
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs).
 */

import {planSync} from './plan-sync.js';
import {sanitizeFavIconUrl} from './url-sync.js';

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

// --- copy of delta-sync.js buildLocalState (kept identical) ------------------
function buildLocalState(loadedGroups, syncedOptions = {}, livePinnedTabs = []) {
    const groups = (loadedGroups || []).map(group => {
        const {tabs, ...props} = group;

        const mappedTabs = (Array.isArray(tabs) ? tabs : [])
            .filter(tab => tab && tab.uid != null)
            .map((tab, index) => ({
                uid: tab.uid,
                url: tab.url,
                title: tab.title,
                cookieStoreId: tab.cookieStoreId,
                // GROUP-RELATIVE position: always the local array position within the
                // group (Groups.load returns group.tabs in group order). NOT tab.index
                // (browser-window-absolute), which would shuffle order across machines.
                index,
                lastModified: tab.lastModified,
                // sanitizeFavIconUrl drops inline data: favicons and oversized URLs.
                favIconUrl: sanitizeFavIconUrl(tab.favIconUrl),
                id: tab.id,
            }));

        return {...props, tabs: mappedTabs};
    });

    const pinnedTabs = (Array.isArray(livePinnedTabs) ? livePinnedTabs : [])
        .filter(tab => tab && tab.uid != null)
        .map((tab, index) => ({
            uid: tab.uid,
            url: tab.url,
            title: tab.title,
            cookieStoreId: tab.cookieStoreId,
            index: Number.isFinite(tab.index) ? tab.index : index,
            lastModified: tab.lastModified,
            // KEEP the current favicon (incl. small data:); only a >~50 KB blob is dropped.
            favIconUrl: sanitizeFavIconUrl(tab.favIconUrl),
            id: tab.id,
        }));

    return {groups, pinnedTabs, options: {...syncedOptions}};
}

// --- copy of delta-sync.js getLivePinnedTabs filter pipeline (kept identical) ---
// MUST stay in sync with `getLivePinnedTabs` in delta-sync.js. The load-bearing line is
// the FIRST filter: drop any browser-pinned tab that STG tracks in a group (an active
// group's group-pinned tabs are browser-pinned but belong to the groups path, NOT the
// global pinned section). `cache`/`isSyncable`/`unwrap` are injected mocks standing in for
// Cache.getTabGroup / isUrlSyncable / unwrapStubUrl so this needs no extension host.
async function getLivePinnedTabs(rawPinnedTabs, {cache, isSyncable, unwrap}) {
    return Promise.all(
        rawPinnedTabs
            // keep ONLY truly-global pinned tabs: drop any tab STG tracks in a group.
            .filter(tab => !cache.getTabGroup(tab.id))
            .map(tab => {
                tab.url = unwrap(tab.url);
                return tab;
            })
            .filter(tab => isSyncable(tab.url))
            .map(async tab => {
                const uid = cache.getTabUid(tab.id) || await cache.setTabUid(tab.id);
                tab.uid = uid;
                tab.lastModified = cache.getTabLastModified(tab.id);
                return tab;
            })
    );
}

// ---------------------------------------------------------------------------
// 0a. REGRESSION (pinned-sync-leak H1/H2/H3): a group-pinned tab of the ACTIVE group is
//     browser-pinned, so browser.tabs.query({pinned:true}) returns it — but it MUST be
//     excluded from the global pinned set (it syncs as a NORMAL group tab). Without the
//     Cache.getTabGroup filter it would leak in, and the uid->tabId index built from this
//     set would resolve a pinnedToRemove to the real group tab and DELETE it.
// ---------------------------------------------------------------------------
{
    // gA1 is a group-pinned tab of the currently-active group g1 (browser-pinned). gB2/gB3
    // are truly-global pinned tabs (no group). All three come back from the pinned query.
    const groupOf = {101: 'g1', 102: null, 103: null};
    const cache = {
        getTabGroup: id => groupOf[id] || null,
        getTabUid: id => ({101: 'uGroupPinned', 102: 'uGlobalA', 103: 'uGlobalB'})[id],
        setTabUid: async () => null,
        getTabLastModified: () => 0,
    };
    const mocks = {cache, isSyncable: () => true, unwrap: u => u};

    const raw = [
        {id: 101, url: 'https://group-pinned', index: 0},
        {id: 102, url: 'https://global-a', index: 1},
        {id: 103, url: 'https://global-b', index: 2},
    ];
    const live = await getLivePinnedTabs(raw, mocks);
    const uids = live.map(t => t.uid);

    check('group-pinned tab of active group is EXCLUDED from global pinned set',
        !uids.includes('uGroupPinned'), JSON.stringify(uids));
    check('truly-global pinned tabs are KEPT',
        uids.includes('uGlobalA') && uids.includes('uGlobalB'), JSON.stringify(uids));

    // The uid->tabId index (move/remove resolution) must NOT be able to resolve the group
    // tab's uid — that is exactly what prevented H1 (deleting the real group tab).
    const idByUid = new Map(live.filter(t => t.uid != null).map(t => [t.uid, t.id]));
    check('group-pinned uid cannot be resolved to a tabId (H1: no phantom group-tab delete)',
        !idByUid.has('uGroupPinned'), JSON.stringify([...idByUid]));
}

// ---------------------------------------------------------------------------
// 0b. REGRESSION (pinned-sync-leak H3): once the leak is gone the global pinned region is
//     globals-only, so its uids land at 0..N-1 in order — buildLocalState's pinnedTabs
//     index matches a peer's resolved order and the planner emits NO pinnedToMove churn.
//     (Convergence is asserted against the planner in plan-sync.test.mjs; here we assert the
//     filtered set carries contiguous globals-only indices, the precondition for that.)
// ---------------------------------------------------------------------------
{
    const groupOf = {201: 'gActive', 202: null, 203: null}; // 201 = leaked group-pinned
    const cache = {
        getTabGroup: id => groupOf[id] || null,
        getTabUid: id => ({201: 'uG', 202: 'uGlobal1', 203: 'uGlobal2'})[id],
        setTabUid: async () => null,
        getTabLastModified: () => 0,
    };
    const live = await getLivePinnedTabs(
        [
            {id: 201, url: 'https://grp', index: 0},
            {id: 202, url: 'https://g1', index: 1},
            {id: 203, url: 'https://g2', index: 2},
        ],
        {cache, isSyncable: () => true, unwrap: u => u},
    );
    const state = buildLocalState([], {}, live);
    const pinnedUids = state.pinnedTabs.map(t => t.uid);
    check('localState.pinnedTabs holds only the globals (group-pinned filtered out)',
        pinnedUids.length === 2 && pinnedUids.join(',') === 'uGlobal1,uGlobal2', JSON.stringify(pinnedUids));
}

// ---------------------------------------------------------------------------
// 1. mapping keeps group props, maps tabs, drops un-uided tabs, keeps live id
// ---------------------------------------------------------------------------
{
    const loaded = [
        {
            id: 'g1', title: 'G1', isArchive: false,
            tabs: [
                {id: 11, uid: 'u1', url: 'https://a', title: 'A', cookieStoreId: 'firefox-default', index: 0, lastModified: 5},
                {id: 12, url: 'https://noid', title: 'NoUid', index: 1}, // no uid -> dropped
            ],
        },
        {id: 'g2', title: 'G2', isArchive: true, tabs: [{id: 21, uid: 'u2', url: 'https://b', title: 'B', index: 0}]},
    ];

    const {groups} = buildLocalState(loaded);

    check('group props preserved', groups[0].title === 'G1' && groups[0].isArchive === false);
    check('un-uided tab dropped', groups[0].tabs.length === 1 && groups[0].tabs[0].uid === 'u1');
    check('live id kept on mapped tab', groups[0].tabs[0].id === 11);
    check('archived group still mapped', groups[1].tabs[0].uid === 'u2');
    check('tabs key present + remapped', Array.isArray(groups[0].tabs));
}

// ---------------------------------------------------------------------------
// 2. index is the GROUP-RELATIVE array position, NOT the browser tab.index.
//    Even when the incoming tabs carry browser-absolute indices (e.g. 7, 9 —
//    shifted by pinned/other-group tabs), buildLocalState assigns 0,1 by order.
// ---------------------------------------------------------------------------
{
    const {groups} = buildLocalState([
        {id: 'g', title: 'g', tabs: [
            {uid: 'a', url: 'x', index: 7},
            {uid: 'b', url: 'y', index: 9},
        ]},
    ]);
    check('index is group-relative array position (ignores browser index)',
        groups[0].tabs[0].index === 0 && groups[0].tabs[1].index === 1);
}

// ---------------------------------------------------------------------------
// 3. end-to-end: localState built from loaded groups feeds planSync so a remote
//    pending add surfaces as tabsToCreate. Removal is gated by the per-device
//    baseline: a tab IN the baseline (synced before) that is absent from resolved
//    surfaces as tabsToRemove; a never-synced local-only tab is KEPT.
// ---------------------------------------------------------------------------
{
    const SELF = 'self', REMOTE = 'remote';

    const loaded = [
        {id: 'g1', title: 'G1', tabs: [
            {id: 1, uid: 'syncedBefore', url: 'https://synced', title: 'S', index: 0}, // in baseline -> removed
            {id: 2, uid: 'localOnly', url: 'https://local', title: 'L', index: 1},      // never synced -> kept
        ]},
    ];
    const localState = buildLocalState(loaded);

    const pulledSnapshot = {groups: [{id: 'g1', title: 'G1', tabs: []}], watermark: {}};
    const pulledDeltaLogs = [
        {deviceId: REMOTE, events: [
            {seq: 1, ts: 100, op: 'tab.add', groupId: 'g1', tab: {uid: 'remoteTab', url: 'https://remote', title: 'R', index: 0}},
        ]},
    ];
    // baseline remembers g1 + syncedBefore as previously reconciled (localOnly is new).
    const priorBaseline = {tabUids: ['syncedBefore'], groupIds: ['g1']};

    const plan = planSync({pulledSnapshot, pulledDeltaLogs, localPendingEvents: [], selfDeviceId: SELF, localState, priorBaseline});

    const creates = plan.browserOps.tabsToCreate.map(t => t.uid);
    const removes = plan.browserOps.tabsToRemove.map(t => t.uid);

    check('remote add -> tabsToCreate', creates.includes('remoteTab'), JSON.stringify(creates));
    check('create carries target group', plan.browserOps.tabsToCreate.find(t => t.uid === 'remoteTab')?.target?.groupId === 'g1');
    check('baseline tab absent from resolved -> tabsToRemove', removes.includes('syncedBefore'), JSON.stringify(removes));
    check('remove carries groupId', plan.browserOps.tabsToRemove.find(t => t.uid === 'syncedBefore')?.groupId === 'g1');
    check('never-synced local-only tab is KEPT (not removed)', !removes.includes('localOnly'), JSON.stringify(removes));
}

// ---------------------------------------------------------------------------
// pinned: live pinned tabs map into a flat pinnedTabs array (uid-required, live id
// kept) and feed planSync so a baseline-known pinned tab gone from cloud → pinnedToRemove.
// ---------------------------------------------------------------------------
{
    const SELF = 'self';
    const livePinned = [
        {id: 91, uid: 'pinLocal', url: 'https://p', title: 'P', cookieStoreId: 'firefox-default', index: 0, lastModified: 7},
        {id: 92, url: 'https://noid', title: 'NoUid', index: 1}, // no uid -> dropped
    ];
    const localState = buildLocalState([], {}, livePinned);

    check('pinned tab mapped into pinnedTabs', localState.pinnedTabs.length === 1 && localState.pinnedTabs[0].uid === 'pinLocal');
    check('pinned un-uided tab dropped', !localState.pinnedTabs.some(t => t.id === 92));
    check('pinned live id kept', localState.pinnedTabs[0].id === 91);

    // an inline data: favicon on a pinned tab is DROPPED from the snapshot (it caused the
    // multi-GB bloat); a small URL reference is kept and an oversized URL is dropped.
    const dataFavicon = 'data:image/png;base64,' + 'A'.repeat(2000);
    const hugeFavicon = 'https://h/favicon.ico?' + 'A'.repeat(60000);
    const stWithFavicon = buildLocalState([], {}, [
        {id: 93, uid: 'pinFav', url: 'https://f', title: 'F', index: 0, favIconUrl: dataFavicon},
        {id: 94, uid: 'pinHttp', url: 'https://g', title: 'G', index: 1, favIconUrl: 'https://g/favicon.ico'},
        {id: 95, uid: 'pinHuge', url: 'https://h', title: 'H', index: 2, favIconUrl: hugeFavicon},
    ]);
    check('pinned data: favicon dropped from snapshot', stWithFavicon.pinnedTabs[0].favIconUrl === undefined);
    check('pinned normal favicon preserved', stWithFavicon.pinnedTabs[1].favIconUrl === 'https://g/favicon.ico');
    check('pinned pathological favicon dropped from snapshot', stWithFavicon.pinnedTabs[2].favIconUrl === undefined);

    // grouped tabs also carry their current favicon URL reference in the snapshot (read live).
    const stGrouped = buildLocalState([
        {id: 'gf', title: 'GF', tabs: [{id: 50, uid: 'gtab', url: 'https://x', title: 'X', index: 0, favIconUrl: 'https://x/favicon.ico'}]},
    ]);
    check('grouped tab favicon kept in snapshot', stGrouped.groups[0].tabs[0].favIconUrl === 'https://x/favicon.ico');

    const pulledSnapshot = {groups: [], pinnedTabs: [], watermark: {}};
    const plan = planSync({
        pulledSnapshot, pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF, localState,
        priorBaseline: {pinnedUids: ['pinLocal']}, // synced before ⇒ delete elsewhere ⇒ remove
    });
    check('baseline-known pinned gone from cloud -> pinnedToRemove',
        plan.browserOps.pinnedToRemove.some(t => t.uid === 'pinLocal'), JSON.stringify(plan.browserOps.pinnedToRemove));
}

// ---------------------------------------------------------------------------
// orderedGroupTabIds: PURE helper that realizes a group's RESOLVED tab order.
// Copy kept identical to delta-sync.js (same convention as buildLocalState above).
// ---------------------------------------------------------------------------
function orderedGroupTabIds(resolvedUidOrder, liveTabs) {
    const live = (Array.isArray(liveTabs) ? liveTabs : []).filter(t => t && t.id != null);
    if (live.length < 2) {
        return [];
    }

    const byUid = new Map();
    for (const t of live) {
        if (t.uid != null && !byUid.has(t.uid)) {
            byUid.set(t.uid, t);
        }
    }

    const placed = new Set();
    const ordered = [];

    for (const uid of (Array.isArray(resolvedUidOrder) ? resolvedUidOrder : [])) {
        const t = byUid.get(uid);
        if (t && !placed.has(t.id)) {
            ordered.push(t);
            placed.add(t.id);
        }
    }
    for (const t of live) {
        if (!placed.has(t.id)) {
            ordered.push(t);
            placed.add(t.id);
        }
    }

    const orderedIds = ordered.map(t => t.id);

    const sameOrder = orderedIds.length === live.length
        && orderedIds.every((id, i) => id === live[i].id);

    return sameOrder ? [] : orderedIds;
}

{
    // live created OUT OF ORDER vs resolved [A,B,C,D,E]: helper returns the resolved id sequence.
    const resolved = ['A', 'B', 'C', 'D', 'E'];
    const live = [
        {id: 3, uid: 'C'},
        {id: 1, uid: 'A'},
        {id: 5, uid: 'E'},
        {id: 2, uid: 'B'},
        {id: 4, uid: 'D'},
    ];
    const out = orderedGroupTabIds(resolved, live);
    check('shuffled live → resolved id order', JSON.stringify(out) === JSON.stringify([1, 2, 3, 4, 5]), JSON.stringify(out));
}

{
    // live ALREADY in resolved order → no-op (empty result, avoid needless moves).
    const resolved = ['A', 'B', 'C'];
    const live = [{id: 1, uid: 'A'}, {id: 2, uid: 'B'}, {id: 3, uid: 'C'}];
    check('already-ordered → no moves', orderedGroupTabIds(resolved, live).length === 0);
}

{
    // single / empty group → nothing to order.
    check('single tab → no moves', orderedGroupTabIds(['A'], [{id: 1, uid: 'A'}]).length === 0);
    check('empty group → no moves', orderedGroupTabIds([], []).length === 0);
}

{
    // resolved uid with no live tab is skipped; resolved drives the order of those present.
    const resolved = ['A', 'GONE', 'B'];
    const live = [{id: 2, uid: 'B'}, {id: 1, uid: 'A'}];
    check('missing resolved uid skipped, present reordered', JSON.stringify(orderedGroupTabIds(resolved, live)) === JSON.stringify([1, 2]));
}

{
    // local-only live tab (uid not in resolved) keeps relative order, appended after resolved.
    const resolved = ['B', 'A'];
    const live = [
        {id: 1, uid: 'A'},
        {id: 2, uid: 'B'},
        {id: 9, uid: 'LOCAL'}, // not in resolved
    ];
    check('local-only tab appended after resolved order',
        JSON.stringify(orderedGroupTabIds(resolved, live)) === JSON.stringify([2, 1, 9]));
}

{
    // tabs without an id are ignored (can't be moved); falls below 2 → no moves.
    check('id-less live tabs ignored', orderedGroupTabIds(['A', 'B'], [{uid: 'A'}, {id: 2, uid: 'B'}]).length === 0);
}

// ---------------------------------------------------------------------------
// summarizeOps: SINGLE source of truth (D-3) for "does this plan mutate the browser?".
// Copy kept identical to delta-sync.js (same convention as buildLocalState above). The
// REGRESSION GUARD here is that tabsToUpdate / pinnedToUpdate are counted — their prior
// omission caused B1 (content-only apply skipped the safety backup) and B2 (changes.local
// under-reported so the UI didn't refresh).
// ---------------------------------------------------------------------------
function summarizeOps(browserOps, optionsToApply) {
    const ops = browserOps || {};
    const len = arr => (Array.isArray(arr) ? arr.length : 0);

    const groupsChanged = !!(
        len(ops.groupsToCreate) || len(ops.groupsToUpdate)
        || len(ops.groupsToRemove) || ops.groupsOrder
    );

    const anyBrowserOp = !!(
        groupsChanged
        || len(ops.tabsToCreate) || len(ops.tabsToMove) || len(ops.tabsToRemove) || len(ops.tabsToUpdate)
        || len(ops.pinnedToCreate) || len(ops.pinnedToMove) || len(ops.pinnedToRemove) || len(ops.pinnedToUpdate)
    );

    const anyOption = Object.keys(optionsToApply || {}).length > 0;

    return {
        anyBrowserOp,
        anyOption,
        groupsChanged,
        mutatesBrowser: anyBrowserOp || anyOption,
    };
}

{
    // empty plan ⇒ idle no-op sync: nothing to back up, nothing to report.
    const s = summarizeOps({}, {});
    check('summarizeOps: empty ⇒ no mutation', !s.mutatesBrowser && !s.anyBrowserOp && !s.groupsChanged && !s.anyOption);
}

{
    // B1/B2 REGRESSION GUARD: a content-only apply (only tabsToUpdate) MUST count as a browser
    // mutation so the pre-apply safety backup fires and changes.local flips true.
    const s = summarizeOps({tabsToUpdate: [{uid: 't1', target: {url: 'x'}}]}, {});
    check('summarizeOps: tabsToUpdate ⇒ mutatesBrowser', s.mutatesBrowser === true && s.anyBrowserOp === true);
    check('summarizeOps: tabsToUpdate is NOT a group change', s.groupsChanged === false);
}

{
    // same for pinnedToUpdate (the pinned analogue) — the other previously-omitted op.
    const s = summarizeOps({pinnedToUpdate: [{uid: 'p1', target: {title: 'x'}}]}, {});
    check('summarizeOps: pinnedToUpdate ⇒ mutatesBrowser', s.mutatesBrowser === true && s.anyBrowserOp === true);
}

{
    // group-set ops drive both anyBrowserOp AND groupsChanged (menu-rebuild gate).
    const s1 = summarizeOps({groupsToCreate: [{id: 1}]}, {});
    check('summarizeOps: groupsToCreate ⇒ groupsChanged + mutates', s1.groupsChanged && s1.mutatesBrowser);
    const s2 = summarizeOps({groupsOrder: [3, 1, 2]}, {});
    check('summarizeOps: groupsOrder ⇒ groupsChanged + mutates', s2.groupsChanged && s2.mutatesBrowser);
}

{
    // a tab op is a browser mutation but NOT a group change (menu rebuild must stay no-op).
    const s = summarizeOps({tabsToMove: [{uid: 't1'}]}, {});
    check('summarizeOps: tab op ⇒ mutates but groupsChanged=false', s.mutatesBrowser && !s.groupsChanged);
}

{
    // options-only apply ⇒ mutatesBrowser via anyOption, but no browser op / no group change.
    const s = summarizeOps({}, {discardTabsAfterHide: true});
    check('summarizeOps: options-only ⇒ mutates via anyOption', s.mutatesBrowser && s.anyOption && !s.anyBrowserOp && !s.groupsChanged);
}

// ---------------------------------------------------------------------------
// DeltaLog.fastForwardSeqsAbove (E2): re-issue this device's log above a stale cloud
// watermark after a reset so replay() does not dedup-skip the re-uploaded events. Copy
// kept identical to delta-log.js; modeled as a function over an {events, lastSeq} log.
// ---------------------------------------------------------------------------
function fastForwardSeqsAbove(logState, minSeq) {
    // returns {shifted, lastSeq, events} — mirrors the in-module mutation of events/lastSeq.
    if (!Number.isFinite(minSeq)) {
        return {shifted: false, lastSeq: logState.lastSeq, events: logState.events};
    }
    const lowest = logState.events.length
        ? logState.events.reduce((min, e) => (e.seq < min ? e.seq : min), Infinity)
        : logState.lastSeq + 1;
    if (lowest > minSeq) {
        return {shifted: false, lastSeq: logState.lastSeq, events: logState.events};
    }
    const offset = (minSeq + 1) - lowest;
    const events = logState.events.map(e => ({...e, seq: e.seq + offset}));
    return {shifted: true, lastSeq: logState.lastSeq + offset, events};
}

{
    // NORMAL (non-reset) path: lowest event seq already leads the watermark ⇒ untouched.
    const before = {lastSeq: 12, events: [{seq: 11, op: 'x'}, {seq: 12, op: 'y'}]};
    const out = fastForwardSeqsAbove(before, 5);
    check('fastForward: lowest>minSeq ⇒ no-op', out.shifted === false && out.lastSeq === 12);
    check('fastForward: no-op keeps seqs', JSON.stringify(out.events.map(e => e.seq)) === JSON.stringify([11, 12]));
}

{
    // RESET TRAP: lastSeq rewound to 3 (seqs 1..3) but cloud watermark[self]=10. Every event
    // must end up STRICTLY above 10 (lowest anchored to minSeq+1), preserving order + gaps.
    const before = {lastSeq: 3, events: [{seq: 1, op: 'a'}, {seq: 2, op: 'b'}, {seq: 3, op: 'c'}]};
    const out = fastForwardSeqsAbove(before, 10);
    check('fastForward: trap ⇒ shifted', out.shifted === true);
    check('fastForward: lowest lands at minSeq+1', out.events[0].seq === 11);
    check('fastForward: all events strictly above watermark', out.events.every(e => e.seq > 10));
    check('fastForward: lastSeq tracks highest', out.lastSeq === 13);
    check('fastForward: order + gaps preserved', JSON.stringify(out.events.map(e => e.seq)) === JSON.stringify([11, 12, 13]));
}

{
    // gaps in the original log are preserved by the single constant offset (anchor = lowest).
    const before = {lastSeq: 4, events: [{seq: 1}, {seq: 4}]}; // a gap between 1 and 4
    const out = fastForwardSeqsAbove(before, 10);
    check('fastForward: preserves internal gap', JSON.stringify(out.events.map(e => e.seq)) === JSON.stringify([11, 14]));
    check('fastForward: still all above watermark', out.events.every(e => e.seq > 10));
}

{
    // boundary: lowest event seq EXACTLY equals minSeq ⇒ still a trap (replay skips
    // seq <= watermark), so it must shift it to minSeq+1.
    const before = {lastSeq: 7, events: [{seq: 7}]};
    const out = fastForwardSeqsAbove(before, 7);
    check('fastForward: lowest==minSeq ⇒ shifts to minSeq+1', out.shifted === true && out.events[0].seq === 8);
}

{
    // empty log ⇒ no events to shift, but counter still advances so the NEXT append (at
    // lastSeq+1) lands strictly above the watermark.
    const before = {lastSeq: 0, events: []};
    const out = fastForwardSeqsAbove(before, 9);
    check('fastForward: empty log advances lastSeq above watermark', out.shifted === true && out.lastSeq === 9 && (out.lastSeq + 1) > 9 && out.events.length === 0);
}

{
    // non-finite minSeq (missing cloud watermark entry) ⇒ no-op, never crashes.
    const before = {lastSeq: 2, events: [{seq: 1}, {seq: 2}]};
    const out = fastForwardSeqsAbove(before, NaN);
    check('fastForward: non-finite minSeq ⇒ no-op', out.shifted === false && out.lastSeq === 2);
}

// ---------------------------------------------------------------------------
// extractArchiveTransition: copy kept identical to delta-sync.js (same convention as
// buildLocalState above). An isArchive flip must NOT be blind-assigned + saved (Storage.set
// wipes a non-archived group's stored tabs), so the apply splits it out and routes it
// through the real archive machinery; plain prop updates stay as-is.
// ---------------------------------------------------------------------------
function extractArchiveTransition(currentIsArchive, props) {
    if (!props || !Object.hasOwn(props, 'isArchive')) {
        return {props, archiveTransition: null};
    }

    const {isArchive, ...plainProps} = props;

    if (Boolean(isArchive) === Boolean(currentIsArchive)) {
        return {props, archiveTransition: null};
    }

    return {props: plainProps, archiveTransition: Boolean(isArchive)};
}

{
    const flip = extractArchiveTransition(false, {id: 'g1', title: 'T', isArchive: true});
    check('archive transition detected on false -> true', flip.archiveTransition === true);
    check('transition strips isArchive from the plain props', !Object.hasOwn(flip.props, 'isArchive') && flip.props.title === 'T');

    const unflip = extractArchiveTransition(true, {id: 'g1', isArchive: false});
    check('archive transition detected on true -> false', unflip.archiveTransition === false);
    check('unarchive transition also strips isArchive', !Object.hasOwn(unflip.props, 'isArchive'));

    const same = extractArchiveTransition(true, {id: 'g1', isArchive: true, title: 'X'});
    check('no transition when isArchive is unchanged', same.archiveTransition === null);
    check('unchanged isArchive keeps the full props', same.props.isArchive === true && same.props.title === 'X');

    const absent = extractArchiveTransition(false, {id: 'g1', title: 'X'});
    check('no transition when the update carries no isArchive', absent.archiveTransition === null && absent.props.title === 'X');

    const coerced = extractArchiveTransition(undefined, {id: 'g1', isArchive: false});
    check('undefined current and explicit false compare equal (no spurious toggle)', coerced.archiveTransition === null);

    check('null props never crash', extractArchiveTransition(false, null).archiveTransition === null);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
