import assert from 'node:assert/strict';
import test from 'node:test';

import {computeSyncDiff, isEmptySyncDiff, summarizeSyncDiff} from './sync-diff.js';

function snapshot({groups = [], pinnedTabs = [], options = {}} = {}) {
    return {groups, pinnedTabs, options};
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

test('a tab moving between groups (same url/title) is moved, not changed', () => {
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

    assert.equal(moved.kind, 'moved');
    assert.equal(moved.fromGroup, 1);
    assert.equal(moved.group, 2);
    const groupChange = moved.changes.find(c => c.field === 'group');
    assert.equal(groupChange.from, 1);
    assert.equal(groupChange.to, 2);
    assert.equal(diff.counts.tabs.moved, 1);
    assert.equal(diff.counts.tabs.changed, 0);
});

test('reordering a tab within a group (index only) is moved', () => {
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

    assert.equal(diff.tabs.find(t => t.uid === 'u1').kind, 'moved');
    assert.equal(diff.tabs.find(t => t.uid === 'u2').kind, 'moved');
    assert.equal(diff.counts.tabs.moved, 2);
    assert.equal(diff.counts.tabs.changed, 0);
});

test('a url change stays changed even when the index also moves', () => {
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

    assert.equal(diff.tabs.find(t => t.uid === 'u1').kind, 'changed');
    assert.equal(diff.tabs.find(t => t.uid === 'u2').kind, 'moved');
    assert.equal(diff.counts.tabs.changed, 1);
    assert.equal(diff.counts.tabs.moved, 1);
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

test('summary shows moved tabs separately from changed', () => {
    const summary = summarizeSyncDiff({
        tabs: [{kind: 'changed'}, {kind: 'moved'}, {kind: 'moved'}],
        groups: [],
        options: [],
    });

    assert.equal(summary, '~1 ↔2 tabs');
});
