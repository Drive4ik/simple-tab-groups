/**
 * Standalone node regression test: STG's own extension pages (bare moz-extension URLs,
 * e.g. the sync-diff page opened as an in-group tab) must NEVER enter the synced state.
 *
 * A per-install moz-extension UUID can never converge across machines, so such a tab, if
 * synced, (a) poisons the cloud snapshot and (b) drives a perpetual local reorder loop.
 *
 * Plain `node extension-page-sync.test.mjs` (STG has no test runner). `local-state.js` and
 * `apply-engine.js` are impure (browser-dependent) and cannot be imported under node, so the
 * two load-bearing predicates they use are exercised via the REAL, pure `url-sync.js`:
 *   - buildLocalState drops a group tab when `!isUrlSyncable(unwrapStubUrl(tab.url))`;
 *   - apply-engine's create paths skip a resolved record failing the same guard.
 * The re-implemented group mapping below mirrors `buildLocalState` in `local-state.js`.
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs).
 */

import {planSync} from './plan-sync.js';
import {isUrlSyncable, unwrapStubUrl} from './url-sync.js';

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

const SELF = 'devSelf';
const REMOTE = 'devRemote';

const DIFF_PAGE = 'moz-extension://self-uuid/sync-diff/sync-diff.html?entry=1';
const FOREIGN_PAGE = 'moz-extension://foreign-uuid/sync-diff/sync-diff.html?entry=1';

// mirrors buildLocalState group-tab mapping in local-state.js: keep only tabs with a uid whose
// unwrapped url is syncable, indexed by group-relative position.
function buildLocalStateGroups(loadedGroups) {
    return (loadedGroups || []).map(group => {
        const {tabs, ...props} = group;
        const mappedTabs = [];
        for (const tab of Array.isArray(tabs) ? tabs : []) {
            if (!tab || tab.uid == null) {
                continue;
            }
            const url = unwrapStubUrl(tab.url);
            if (!isUrlSyncable(url)) {
                continue;
            }
            mappedTabs.push({uid: tab.uid, url, title: tab.title, index: mappedTabs.length});
        }
        return {...props, tabs: mappedTabs};
    });
}

// ===========================================================================
// (a) A group containing an in-group moz-extension diff-page tab does NOT emit that tab into
//     buildLocalState (it is invisible to the S0/S1 comparison).
// ===========================================================================
{
    const groups = buildLocalStateGroups([
        {id: 'g1', title: 'G1', tabs: [
            {uid: 't1', url: 'http://a', title: 'A'},
            {uid: 'diff', url: DIFF_PAGE, title: 'Sync diff'},
            {uid: 't2', url: 'https://b', title: 'B'},
        ]},
    ]);
    const uids = groups[0].tabs.map(t => t.uid);
    check('(a) diff-page tab is dropped from buildLocalState', !uids.includes('diff'), JSON.stringify(uids));
    check('(a) real tabs survive and are re-indexed 0..n', uids.join(',') === 't1,t2'
        && groups[0].tabs[0].index === 0 && groups[0].tabs[1].index === 1, JSON.stringify(groups[0].tabs));
}

// ===========================================================================
// (b) With a local-only in-group extension tab, repeated planSync over a STABLE cloud state
//     converges: no perpetual tabsToMove/tabsToCreate (the reorder loop dies because the diff
//     tab never enters S0/S1).
// ===========================================================================
{
    const pulledSnapshot = {
        groups: [{id: 'g1', title: 'G1', tabs: [
            {uid: 't1', url: 'http://a', index: 0},
            {uid: 't2', url: 'https://b', index: 1},
        ]}],
        watermark: {},
    };
    // live group interleaves the diff page between the two real tabs; buildLocalState drops it.
    const localState = {groups: buildLocalStateGroups([
        {id: 'g1', title: 'G1', tabs: [
            {uid: 't1', url: 'http://a'},
            {uid: 'diff', url: DIFF_PAGE},
            {uid: 't2', url: 'https://b'},
        ]},
    ])};

    for (const label of ['first', 'second']) {
        const {browserOps} = planSync({
            pulledSnapshot, pulledDeltaLogs: [], localPendingEvents: [], selfDeviceId: SELF, localState,
        });
        check(`(b) ${label} planSync emits no tabsToMove (no reorder loop)`,
            browserOps.tabsToMove.length === 0, JSON.stringify(browserOps.tabsToMove));
        check(`(b) ${label} planSync emits no tabsToCreate`,
            browserOps.tabsToCreate.length === 0, JSON.stringify(browserOps.tabsToCreate));
    }
}

// ===========================================================================
// (c) A foreign moz-extension tab record present in the resolved snapshot does NOT become a
//     real create op: the apply-engine create guard `isUrlSyncable(unwrapStubUrl(url))` rejects
//     it (so creating a foreign-UUID URL can never throw and abort the sync cycle).
// ===========================================================================
{
    const pulledSnapshot = {groups: [{id: 'g1', title: 'G1', tabs: []}], watermark: {}};
    const pulledDeltaLogs = [
        {deviceId: REMOTE, events: [
            {seq: 1, ts: 100, op: 'tab.add', groupId: 'g1', tab: {uid: 't1', url: 'http://a', index: 0}},
            {seq: 2, ts: 101, op: 'tab.add', groupId: 'g1', tab: {uid: 'poison', url: FOREIGN_PAGE, index: 1}},
        ]},
    ];
    const localState = {groups: [{id: 'g1', title: 'G1', tabs: []}]};

    const {browserOps} = planSync({
        pulledSnapshot, pulledDeltaLogs, localPendingEvents: [], selfDeviceId: SELF, localState,
    });

    const poison = browserOps.tabsToCreate.find(t => t.uid === 'poison');
    check('(c) resolved snapshot carries the foreign moz-extension record', !!poison, JSON.stringify(browserOps.tabsToCreate));

    // the exact apply-engine create-path guard (delta-sync/apply-engine.js).
    const creatable = browserOps.tabsToCreate.filter(t => isUrlSyncable(unwrapStubUrl(t.url)));
    check('(c) foreign moz-extension record is NOT creatable (guard drops it)',
        !creatable.some(t => t.uid === 'poison'), JSON.stringify(creatable.map(t => t.uid)));
    check('(c) the ordinary http record IS still creatable',
        creatable.some(t => t.uid === 't1'), JSON.stringify(creatable.map(t => t.uid)));
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
