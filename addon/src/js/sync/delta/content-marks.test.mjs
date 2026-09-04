/**
 * Standalone node test for the PURE last-synced content marks (`content-marks.js`).
 *
 * Plain `node content-marks.test.mjs` (STG has no test runner). The module is pure (no
 * `browser.*` / storage), so it imports directly.
 *
 * Regression for the two-device url/title ping-pong: capture was level-triggered on any
 * `onUpdated` carrying url/title, so a tab drifting BACK to the value the sync layer had
 * already agreed on was pushed as a brand-new change, which the peer applied, drifted from
 * and pushed back — a stable 2-cycle. The mark is the per-uid record of that agreed
 * content, so capture can become edge-triggered against it.
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs).
 */

import {
    CONTENT_MARK_MAX_ENTRIES,
    contentMark,
    contentMarksFromSnapshot,
    contentMarksFromEvents,
    capContentMarks,
    isSyncedContent,
} from './content-marks.js';

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

// --- 1. the mark covers exactly the synced content fields -----------------------------
{
    const base = {url: 'https://a.test/', title: 'A', pinned: false};

    check('same url+title+pinned ⇒ same mark',
        contentMark(base) === contentMark({...base}));

    check('a different url ⇒ a different mark',
        contentMark(base) !== contentMark({...base, url: 'https://a.test/#x'}));

    check('a different title ⇒ a different mark',
        contentMark(base) !== contentMark({...base, title: 'B'}));

    check('a group-pin flip ⇒ a different mark',
        contentMark(base) !== contentMark({...base, pinned: true}));

    check('fields outside the synced content set do not move the mark',
        contentMark(base) === contentMark({...base, index: 7, loaded: true, lastModified: 42, uid: 'u'}));

    check('absent pinned and explicit false are the same content',
        contentMark({url: 'https://a.test/', title: 'A'}) === contentMark(base));

    check('the mark stays small (it is persisted for every synced uid)',
        contentMark({url: 'https://a.test/' + 'x'.repeat(4000), title: 'y'.repeat(4000)}).length <= 16);
}

// --- 2. marks derived from the resolved snapshot -------------------------------------
{
    const snapshot = {
        groups: [
            {id: 1, tabs: [
                {uid: 'u1', url: 'https://a.test/', title: 'A'},
                {uid: 'u2', url: 'https://b.test/', title: 'B', pinned: true},
            ]},
            {id: 2, tabs: null},
            {id: 3},
        ],
        pinnedTabs: [
            {uid: 'p1', url: 'https://p.test/', title: 'P'},
            {url: 'https://nouid.test/'},
        ],
    };

    const marks = contentMarksFromSnapshot(snapshot);

    check('every snapshot uid gets a mark',
        Object.keys(marks).sort().join(',') === 'p1,u1,u2');

    check('group tab mark matches the tab record it came from',
        marks.u1 === contentMark({url: 'https://a.test/', title: 'A'}));

    check('a group-pinned tab marks as pinned',
        marks.u2 === contentMark({url: 'https://b.test/', title: 'B', pinned: true}));

    check('a browser-pinned tab marks as not group-pinned',
        marks.p1 === contentMark({url: 'https://p.test/', title: 'P', pinned: false}));

    check('a malformed snapshot yields an empty map',
        Object.keys(contentMarksFromSnapshot(null)).length === 0
        && Object.keys(contentMarksFromSnapshot({})).length === 0);
}

// --- 3. uids that leave the snapshot are garbage-collected ---------------------------
{
    const before = contentMarksFromSnapshot({groups: [{id: 1, tabs: [{uid: 'u1', url: 'x'}, {uid: 'u2', url: 'y'}]}]});
    const after = contentMarksFromSnapshot({groups: [{id: 1, tabs: [{uid: 'u1', url: 'x'}]}]});

    check('the store is rebuilt per cycle, so a vanished uid is dropped',
        Object.hasOwn(before, 'u2') && !Object.hasOwn(after, 'u2'));
}

// --- 4. the store is hard-bounded ----------------------------------------------------
{
    const tabs = [];
    for (let i = 0; i < CONTENT_MARK_MAX_ENTRIES + 25; i++) {
        tabs.push({uid: `u${i}`, url: `https://a.test/${i}`, title: `T${i}`});
    }

    const marks = contentMarksFromSnapshot({groups: [{id: 1, tabs}]});

    check('an oversized snapshot is capped at CONTENT_MARK_MAX_ENTRIES',
        Object.keys(marks).length === CONTENT_MARK_MAX_ENTRIES);

    check('a store under the cap is returned untouched',
        capContentMarks({a: '1'}).a === '1');
}

// --- 5. the capture-side comparison ---------------------------------------------------
{
    const record = {uid: 'u1', url: 'https://a.test/', title: 'A', pinned: false, index: 3, loaded: true};
    const marks = {u1: contentMark(record)};

    check('content equal to the last-synced value is recognised',
        isSyncedContent(marks, 'u1', record) === true);

    check('a user edit to a DIFFERENT url is never recognised',
        isSyncedContent(marks, 'u1', {...record, url: 'https://a.test/other'}) === false);

    check('a user edit to a DIFFERENT title is never recognised',
        isSyncedContent(marks, 'u1', {...record, title: 'edited'}) === false);

    check('a group-pin change is never recognised as agreed content',
        isSyncedContent(marks, 'u1', {...record, pinned: true}) === false);

    check('an index-only difference is agreed content (moves ride TAB_MOVE)',
        isSyncedContent(marks, 'u1', {...record, index: 9}) === true);

    check('a uid with no mark yet behaves exactly as before (capture)',
        isSyncedContent(marks, 'u2', record) === false);

    check('a missing store behaves exactly as before (capture)',
        isSyncedContent(null, 'u1', record) === false
        && isSyncedContent({}, 'u1', record) === false);

    check('a null uid never matches',
        isSyncedContent(marks, null, record) === false);

    check('a non-string mark is ignored',
        isSyncedContent({u1: 1}, 'u1', record) === false);
}

// --- 6. marks derived from the un-pushed delta log ------------------------------------
{
    const synced = contentMarksFromSnapshot({groups: [{id: 1, tabs: [
        {uid: 'u1', url: 'https://u0.test/', title: 'A'},
        {uid: 'u2', url: 'https://keep.test/', title: 'K'},
    ]}]});

    check('with no un-pushed events the synced marks are returned unchanged',
        JSON.stringify(contentMarksFromEvents(synced, [])) === JSON.stringify(synced));

    const navigated = contentMarksFromEvents(synced, [
        {seq: 1, op: 'tab.modify', groupId: 1, tab: {uid: 'u1', url: 'https://u1.test/', title: 'A'}},
    ]);

    check('a queued TAB_MODIFY moves the mark to the value the log will push',
        navigated.u1 === contentMark({url: 'https://u1.test/', title: 'A'}));

    check('a uid with no un-pushed event keeps its synced mark',
        navigated.u2 === synced.u2);

    check('deriving does not mutate the stored synced marks',
        synced.u1 === contentMark({url: 'https://u0.test/', title: 'A'}));

    check('the LAST event for a uid wins',
        contentMarksFromEvents(synced, [
            {seq: 1, op: 'tab.modify', tab: {uid: 'u1', url: 'https://u1.test/', title: 'A'}},
            {seq: 2, op: 'tab.modify', tab: {uid: 'u1', url: 'https://u2.test/', title: 'A'}},
        ]).u1 === contentMark({url: 'https://u2.test/', title: 'A'}));

    check('TAB_ADD and PINNED_ADD/MODIFY also carry a mark',
        contentMarksFromEvents({}, [
            {seq: 1, op: 'tab.add', tab: {uid: 'a1', url: 'https://a.test/', title: 'A'}},
            {seq: 2, op: 'pinned.add', tab: {uid: 'p1', url: 'https://p.test/', title: 'P'}},
            {seq: 3, op: 'pinned.modify', tab: {uid: 'p2', url: 'https://q.test/', title: 'Q'}},
        ]).a1 === contentMark({url: 'https://a.test/', title: 'A'}));

    check('a queued removal drops the mark, so a re-created uid captures',
        contentMarksFromEvents(synced, [{seq: 1, op: 'tab.remove', groupId: 1, uid: 'u1'}]).u1 === undefined);

    check('a queued pinned removal drops the mark too',
        contentMarksFromEvents({p1: 'x'}, [{seq: 1, op: 'pinned.remove', uid: 'p1'}]).p1 === undefined);

    check('moves and group/option events never touch a mark',
        JSON.stringify(contentMarksFromEvents(synced, [
            {seq: 1, op: 'tab.move', uid: 'u1', toIndex: 3},
            {seq: 2, op: 'pinned.move', uid: 'u2', toIndex: 0},
            {seq: 3, op: 'group.modify', group: {id: 1, title: 'G'}},
            {seq: 4, op: 'option.set', key: 'syncEnable', value: true},
        ])) === JSON.stringify(synced));

    check('a malformed store or event list degrades to capturing, never throws',
        Object.keys(contentMarksFromEvents(null, null)).length === 0
        && Object.keys(contentMarksFromEvents('garbage', undefined)).length === 0
        && Object.keys(contentMarksFromEvents(['x'], [null, {}, {op: 'tab.modify'}])).length === 0);

    const overflow = [];
    for (let i = 0; i < CONTENT_MARK_MAX_ENTRIES + 25; i++) {
        overflow.push({seq: i + 1, op: 'tab.modify', tab: {uid: `e${i}`, url: `https://a.test/${i}`}});
    }

    check('the derived store is capped exactly like the snapshot-built one',
        Object.keys(contentMarksFromEvents({}, overflow)).length === CONTENT_MARK_MAX_ENTRIES);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
