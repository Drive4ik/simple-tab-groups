import assert from 'node:assert/strict';
import test from 'node:test';

import {computeSyncDiff, isEmptySyncDiff, summarizeSyncDiff} from './sync-diff.js';

function snapshot({groups = [], pinnedTabs = [], options = {}} = {}) {
    return {groups, pinnedTabs, options};
}

function isMove(item) {
    return item.kind === 'changed' && item.moveOnly === true;
}

function viewKind(item) {
    return isMove(item) ? 'moved' : item.kind;
}

test('empty diff for identical snapshots', () => {
    const state = snapshot({
        groups: [{id: 1, title: 'A', isArchive: false, tabs: [{uid: 'u1', url: 'http://a', title: 'a'}]}],
        options: {closePopupAfterSelectTab: false},
    });

    const diff = computeSyncDiff(state, state);

    assert.ok(isEmptySyncDiff(diff));
    assert.equal(diff.summary, '');
});

test('detects added, removed and changed tabs', () => {
    const before = snapshot({
        groups: [{id: 1, title: 'A', tabs: [
            {uid: 'keep', url: 'http://keep', title: 'keep'},
            {uid: 'gone', url: 'http://gone', title: 'gone'},
        ]}],
    });
    const after = snapshot({
        groups: [{id: 1, title: 'A', tabs: [
            {uid: 'keep', url: 'http://keep2', title: 'keep'},
            {uid: 'new', url: 'http://new', title: 'new'},
        ]}],
    });

    const diff = computeSyncDiff(before, after);

    const added = diff.tabs.find(t => t.uid === 'new');
    const removed = diff.tabs.find(t => t.uid === 'gone');
    const changed = diff.tabs.find(t => t.uid === 'keep');

    assert.equal(added.kind, 'added');
    assert.equal(removed.kind, 'removed');
    assert.equal(changed.kind, 'changed');

    const urlChange = changed.changes.find(c => c.field === 'url');
    assert.equal(urlChange.from, 'http://keep');
    assert.equal(urlChange.to, 'http://keep2');

    assert.deepEqual(diff.counts.tabs, {added: 1, removed: 1, changed: 1, moved: 0});
});

test('a tab moving between groups (same url/title) is a changed move, not a content change', () => {
    const before = snapshot({
        groups: [
            {id: 1, title: 'A', tabs: [{uid: 'u1', url: 'http://a', title: 'a'}]},
            {id: 2, title: 'B', tabs: []},
        ],
    });
    const after = snapshot({
        groups: [
            {id: 1, title: 'A', tabs: []},
            {id: 2, title: 'B', tabs: [{uid: 'u1', url: 'http://a', title: 'a'}]},
        ],
    });

    const diff = computeSyncDiff(before, after);
    const moved = diff.tabs.find(t => t.uid === 'u1');

    assert.equal(moved.kind, 'changed');
    assert.equal(moved.moveOnly, true);
    assert.equal(moved.fromGroup, 1);
    assert.equal(moved.group, 2);
    assert.equal(moved.changes.some(c => c.field === 'group'), false);
    assert.equal(moved.fromGroupTitle, 'A');
    assert.equal(moved.groupTitle, 'B');
    assert.equal(diff.counts.tabs.changed, 1);
    assert.equal(diff.counts.tabs.moved, 1);
});

test('a container or pin change (same url/title/index) is a content change, not a move', () => {
    const before = snapshot({
        groups: [{id: 1, title: 'A', tabs: [
            {uid: 'u1', url: 'http://a', title: 'a', cookieStoreId: 'firefox-default', pinned: false},
        ]}],
    });
    const after = snapshot({
        groups: [{id: 1, title: 'A', tabs: [
            {uid: 'u1', url: 'http://a', title: 'a', cookieStoreId: 'firefox-container-3', pinned: true},
        ]}],
    });

    const diff = computeSyncDiff(before, after);
    const changed = diff.tabs.find(t => t.uid === 'u1');

    assert.equal(changed.kind, 'changed');
    assert.notEqual(changed.moveOnly, true);

    const containerChange = changed.changes.find(c => c.field === 'cookieStoreId');
    const pinChange = changed.changes.find(c => c.field === 'pinned');
    assert.equal(containerChange.to, 'firefox-container-3');
    assert.equal(pinChange.to, true);

    assert.deepEqual(diff.counts.tabs, {added: 0, removed: 0, changed: 1, moved: 0});
});

test('group labels fall back to a short id, never the raw uid', () => {
    const uidA = '11111111-2222-3333-4444-5555aaaabbbb';
    const uidB = '99999999-8888-7777-6666-5555ccccdddd';
    const before = snapshot({
        groups: [
            {id: uidA, title: '', tabs: [{uid: 't1', url: 'http://a', title: 'a'}]},
            {id: uidB, title: '', tabs: []},
        ],
    });
    const after = snapshot({
        groups: [
            {id: uidA, title: '', tabs: []},
            {id: uidB, title: '', tabs: [{uid: 't1', url: 'http://a', title: 'a'}]},
        ],
    });

    const diff = computeSyncDiff(before, after);
    const moved = diff.tabs.find(t => t.uid === 't1');

    assert.equal(moved.moveOnly, true);
    assert.equal(moved.fromGroupTitle, 'Group bbbb');
    assert.equal(moved.groupTitle, 'Group dddd');
    assert.equal(moved.groupTitle.includes(uidB), false);
    assert.equal(moved.fromGroupTitle.includes(uidA), false);
    assert.equal(moved.changes.some(c => c.field === 'group'), false);
});

test('reordering a tab within a group (index only) is a move subtype of changed', () => {
    const before = snapshot({
        groups: [{id: 1, title: 'A', tabs: [
            {uid: 'u1', url: 'http://a', title: 'a'},
            {uid: 'u2', url: 'http://b', title: 'b'},
        ]}],
    });
    const after = snapshot({
        groups: [{id: 1, title: 'A', tabs: [
            {uid: 'u2', url: 'http://b', title: 'b'},
            {uid: 'u1', url: 'http://a', title: 'a'},
        ]}],
    });

    const diff = computeSyncDiff(before, after);

    for (const uid of ['u1', 'u2']) {
        const item = diff.tabs.find(t => t.uid === uid);
        assert.equal(item.kind, 'changed');
        assert.equal(item.moveOnly, true);
    }
    assert.equal(diff.counts.tabs.changed, 2);
    assert.equal(diff.counts.tabs.moved, 2);
});

test('a url change stays a content change even when the index also moves', () => {
    const before = snapshot({
        groups: [{id: 1, title: 'A', tabs: [
            {uid: 'u1', url: 'http://a', title: 'a'},
            {uid: 'u2', url: 'http://b', title: 'b'},
        ]}],
    });
    const after = snapshot({
        groups: [{id: 1, title: 'A', tabs: [
            {uid: 'u2', url: 'http://b', title: 'b'},
            {uid: 'u1', url: 'http://a2', title: 'a'},
        ]}],
    });

    const diff = computeSyncDiff(before, after);
    const u1 = diff.tabs.find(t => t.uid === 'u1');
    const u2 = diff.tabs.find(t => t.uid === 'u2');

    assert.equal(u1.kind, 'changed');
    assert.notEqual(u1.moveOnly, true);
    assert.equal(u2.kind, 'changed');
    assert.equal(u2.moveOnly, true);
    assert.equal(diff.counts.tabs.changed, 2);
    assert.equal(diff.counts.tabs.moved, 1);
});

test('a tab shifted by a removed predecessor (index only) renders as a move in the flat list', () => {
    const before = snapshot({
        groups: [{id: 1, title: 'A', tabs: [
            {uid: 'gone', url: 'http://gone', title: 'gone'},
            {uid: 'shift', url: 'http://a', title: 'OL-1685'},
        ]}],
    });
    const after = snapshot({
        groups: [{id: 1, title: 'A', tabs: [
            {uid: 'shift', url: 'http://a', title: 'OL-1685'},
        ]}],
    });

    const diff = computeSyncDiff(before, after);
    const shifted = diff.tabs.find(t => t.uid === 'shift');

    assert.equal(shifted.kind, 'changed');
    assert.equal(shifted.moveOnly, true);
    assert.deepEqual(shifted.changes.map(c => c.field), ['index']);
    assert.equal(viewKind(shifted), 'moved');
});

test('a url fragment change keeps the row a content change even while its index shifts', () => {
    const before = snapshot({
        groups: [{id: 1, title: 'A', tabs: [
            {uid: 'gone', url: 'http://gone', title: 'gone'},
            {uid: 'frag', url: 'https://gh/pull/1447/files#chg-a/x.csv', title: 'PR'},
        ]}],
    });
    const after = snapshot({
        groups: [{id: 1, title: 'A', tabs: [
            {uid: 'frag', url: 'https://gh/pull/1447/files#chg-b/y.csv', title: 'PR'},
        ]}],
    });

    const diff = computeSyncDiff(before, after);
    const frag = diff.tabs.find(t => t.uid === 'frag');

    assert.equal(frag.kind, 'changed');
    assert.notEqual(frag.moveOnly, true);
    assert.equal(viewKind(frag), 'changed');
});

test('detects group add/remove/change', () => {
    const before = snapshot({groups: [
        {id: 1, title: 'A', isArchive: false, tabs: []},
        {id: 2, title: 'Old', isArchive: false, tabs: []},
    ]});
    const after = snapshot({groups: [
        {id: 1, title: 'A renamed', isArchive: true, tabs: []},
        {id: 3, title: 'New', isArchive: false, tabs: []},
    ]});

    const diff = computeSyncDiff(before, after);

    assert.equal(diff.groups.find(g => g.id === 3).kind, 'added');
    assert.equal(diff.groups.find(g => g.id === 2).kind, 'removed');
    const changed = diff.groups.find(g => g.id === 1);
    assert.equal(changed.kind, 'changed');
    assert.ok(changed.changes.some(c => c.field === 'title'));
    assert.ok(changed.changes.some(c => c.field === 'isArchive'));
});

test('detects option changes key-by-key', () => {
    const before = snapshot({options: {closePopupAfterSelectTab: false, syncIntervalValue: 5}});
    const after = snapshot({options: {closePopupAfterSelectTab: true, showArchivedGroups: true}});

    const diff = computeSyncDiff(before, after);

    const changed = diff.options.find(o => o.key === 'closePopupAfterSelectTab');
    assert.equal(changed.kind, 'changed');
    assert.equal(changed.from, false);
    assert.equal(changed.to, true);

    assert.equal(diff.options.find(o => o.key === 'syncIntervalValue').kind, 'removed');
    assert.equal(diff.options.find(o => o.key === 'showArchivedGroups').kind, 'added');
});

test('an inbound OPTION_SET applied on this device surfaces as a before/after option change', () => {
    const diffBefore = snapshot({
        groups: [{id: 1, title: 'A', tabs: [{uid: 'u1', url: 'http://a', title: 'a'}]}],
        options: {closePopupAfterSelectTab: false},
    });
    const diffAfter = snapshot({
        groups: [{id: 1, title: 'A', tabs: [{uid: 'u1', url: 'http://a', title: 'a'}]}],
        options: {closePopupAfterSelectTab: true},
    });

    const diff = computeSyncDiff(diffBefore, diffAfter);

    assert.ok(!isEmptySyncDiff(diff));

    const changed = diff.options.find(o => o.key === 'closePopupAfterSelectTab');
    assert.equal(changed.kind, 'changed');
    assert.equal(changed.from, false);
    assert.equal(changed.to, true);

    assert.ok(diff.summary.includes('option'));
});

test('treats pinned tabs as their own group', () => {
    const before = snapshot({pinnedTabs: [{uid: 'p1', url: 'http://p', title: 'p'}]});
    const after = snapshot({pinnedTabs: []});

    const diff = computeSyncDiff(before, after);
    const removed = diff.tabs.find(t => t.uid === 'p1');

    assert.equal(removed.kind, 'removed');
    assert.equal(removed.group, 'pinned');
});

test('strips data: URIs and truncates long text (no blob leakage)', () => {
    const bigData = 'data:image/png;base64,' + 'A'.repeat(5000);
    const longTitle = 'x'.repeat(2000);

    const before = snapshot({groups: [{id: 1, title: 'A', tabs: []}]});
    const after = snapshot({groups: [{id: 1, title: 'A', tabs: [
        {uid: 'u1', url: bigData, title: longTitle},
    ]}]});

    const diff = computeSyncDiff(before, after);
    const added = diff.tabs.find(t => t.uid === 'u1');

    assert.equal(added.url, 'data:[stripped]');
    assert.ok(added.title.length <= 501);
});

test('summary formats counts with signs', () => {
    const summary = summarizeSyncDiff({
        tabs: [{kind: 'added'}, {kind: 'added'}, {kind: 'added'}, {kind: 'removed'}],
        groups: [{kind: 'added'}],
        options: [],
    });

    assert.equal(summary, '+3 −1 tabs, +1 group');
});

test('summary shows moves (a changed subtype) separately from content changes', () => {
    const summary = summarizeSyncDiff({
        tabs: [{kind: 'changed'}, {kind: 'changed', moveOnly: true}, {kind: 'changed', moveOnly: true}],
        groups: [],
        options: [],
    });

    assert.equal(summary, '~1 ↔2 tabs');
});
