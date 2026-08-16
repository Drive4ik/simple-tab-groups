import {MenusTest} from '../menus.js';

export const note = `Round 11 — browser.menus registration lifecycle, the facts behind STG's menus.js mirror.
(A) duplicate ids, cascade removal of children, removeAll, errors on missing ids — what the mirror
bookkeeping relies on every day;
(B) bookmark-context items vs the optional "bookmarks" permission: registration is permission-blind
(items survive a revoke, remove/update work without the permission), only the DISPLAY is gated —
the facts behind the permission-toggle fix in menus-bookmark.js. R11.06 is MANUAL: one or two
permission grants on the page the test opens, and three 👁️ looks at a bookmark's context menu.
Menu existence is probed with menus.update(id, {enabled: true}) — there is no menus.getAll.`;

export const testClass = MenusTest;

export const tests = [

{
    id: 'R11.01',
    title: 'duplicate menu id — second create fails, first stays registered',
    async run(t) {
        t.expect('create {id: dup}', await t.create({id: 'dup', title: 'dup', contexts: ['tab']}), {ok: true});

        const second = await t.create({id: 'dup', title: 'dup', contexts: ['tab']});
        t.expect('create {id: dup} again fails', second, {ok: false, error: 'ID already exists: dup'});

        t.expect('dup still registered after the failed duplicate', await t.exists('dup'), true);
    },
},

{
    id: 'R11.02',
    title: 'menus.remove(parent) — children and grandchildren go with it',
    async run(t) {
        t.expect('create parent', await t.create({id: 'parent', title: 'parent', contexts: ['tab']}), {ok: true});
        t.expect('create child1', await t.create({id: 'child1', parentId: 'parent', title: 'child1'}), {ok: true});
        t.expect('create child2', await t.create({id: 'child2', parentId: 'parent', title: 'child2'}), {ok: true});
        t.expect('create grandchild under child1', await t.create({id: 'grandchild', parentId: 'child1', title: 'grandchild'}), {ok: true});

        t.expect('remove(parent)', await t.remove('parent'), {ok: true});

        t.expect('parent gone', await t.exists('parent'), false);
        t.expect('child1 gone with the parent', await t.exists('child1'), false);
        t.expect('child2 gone with the parent', await t.exists('child2'), false);
        t.expect('grandchild gone with the parent', await t.exists('grandchild'), false);
    },
},

{
    id: 'R11.03',
    title: 'remove and update of a missing id — both fail with the same error',
    async run(t) {
        t.expect('remove(nope) fails', await t.remove('nope'), {ok: false, error: 'Cannot find menu item with id nope'});
        t.expect('update(nope) fails', await t.update('nope', {title: 'nope'}), {ok: false, error: 'Cannot find menu item with id nope'});
    },
},

{
    id: 'R11.04',
    title: 'menus.removeAll — clears everything, is a no-op on empty',
    async run(t) {
        t.expect('create top1', await t.create({id: 'top1', title: 'top1', contexts: ['tab']}), {ok: true});
        t.expect('create top2', await t.create({id: 'top2', title: 'top2', contexts: ['tab']}), {ok: true});
        t.expect('create nested under top1', await t.create({id: 'nested', parentId: 'top1', title: 'nested'}), {ok: true});

        t.expect('removeAll()', await t.removeAll(), {ok: true});

        t.expect('top1 gone', await t.exists('top1'), false);
        t.expect('top2 gone', await t.exists('top2'), false);
        t.expect('nested gone', await t.exists('nested'), false);

        t.expect('removeAll() on empty is fine', await t.removeAll(), {ok: true});
    },
},

{
    id: 'R11.05',
    title: 'bookmark context WITHOUT the bookmarks permission — create/update/remove all work',
    async run(t) {
        if (await t.hasBookmarks()) {
            await t.revokeBookmarks();
            t.note('bookmarks permission was granted from an earlier run — revoked for this test');
        }

        t.require('bookmarks permission absent', !(await t.hasBookmarks()));

        t.expect('create {contexts: [bookmark]} without the permission', await t.create({id: 'bm', title: 'bm', contexts: ['bookmark']}), {ok: true});
        t.expect('update it without the permission', await t.update('bm', {title: 'bm renamed'}), {ok: true});
        t.expect('remove it without the permission', await t.remove('bm'), {ok: true});
    },
},

{
    id: 'R11.06',
    title: 'MANUAL: bookmark menu across grant → revoke → re-grant — registration survives, only the display is gated',
    async run(t) {
        if (!await t.hasBookmarks()) {
            await t.openGrantPage();
            await t.ask('A grant page opened. Click "Grant bookmarks permission" and ALLOW the prompt. Then T.visualAnswer("granted")');
        }

        t.require('bookmarks permission granted', await t.hasBookmarks());

        t.expect('create bm-parent {contexts: [bookmark]}', await t.create({id: 'bm-parent', title: 'test bookmark item', contexts: ['bookmark']}), {ok: true});
        t.expect('create bm-child under it', await t.create({id: 'bm-child', parentId: 'bm-parent', title: 'test bookmark child'}), {ok: true});

        await t.ask('Open the bookmarks sidebar (Ctrl+B) and RIGHT-CLICK any bookmark: is "test bookmark item" in the context menu? Answer what you see');

        await t.revokeBookmarks();
        t.require('bookmarks permission revoked', !(await t.hasBookmarks()));

        await t.ask('RIGHT-CLICK the same bookmark again: is "test bookmark item" GONE from the context menu? Answer what you see');

        const duplicate = await t.create({id: 'bm-parent', title: 'probe', contexts: ['bookmark']});
        t.expect('bm-parent still registered while revoked — duplicate create fails', duplicate, {ok: false, error: 'ID already exists: bm-parent'});

        t.expect('update works without the permission', await t.update('bm-parent', {title: 'test bookmark item'}), {ok: true});
        t.expect('remove of the child works without the permission', await t.remove('bm-child'), {ok: true});
        t.expect('bm-child gone', await t.exists('bm-child'), false);
        t.expect('bm-parent still registered', await t.exists('bm-parent'), true);

        await t.ask('One more grant: click "Grant bookmarks permission" on the grant page again and ALLOW (open it via the tab that is still open). Then RIGHT-CLICK the bookmark: is "test bookmark item" BACK? Answer what you see, or T.visualAnswer() to skip');

        if (await t.hasBookmarks()) {
            const regrant = await t.create({id: 'bm-parent', title: 'probe', contexts: ['bookmark']});
            t.expect('after the re-grant it is the same registered item — duplicate create still fails', regrant, {ok: false, error: 'ID already exists: bm-parent'});
        } else {
            t.note('re-grant skipped — the re-grant probe did not run');
        }

        t.expect('remove(bm-parent) cleans up', await t.remove('bm-parent'), {ok: true});
    },
},

];
