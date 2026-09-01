import {OTHER_ADDON_WAIT, NETWORK_URL} from '../constants.js';
import {OpenerTest, OPENER_KEYS} from '../opener.js';
import {sceneUrl} from '../tabs.js';

export const quiet = OTHER_ADDON_WAIT;

export const note = `Round 16 — what tabs.create({openerTabId}) accepts: the opener states a
recreate path meets. A hidden, discarded or hidden-and-discarded opener takes the link at
creation, and a tab created discarded carries it (OPENER-BEHAVIOR.md §11); an opener in another
window or an already closed one rejects the call and creates NO tab (§12, §13). Every cell prints
the opener as a suffix: c1→p means c1.openerTabId points at p. The expectations are the
clean-profile facts; the silence window is OTHER_ADDON_WAIT so a re-run in a Tree Style Tab
profile needs no edits.`;

export const testClass = OpenerTest;

async function requireOpenerState(t, hidden, discarded) {
    const p = await browser.tabs.get(t.id('p'));

    t.require(
        `setup: p hidden:${hidden} discarded:${discarded}`,
        p.hidden === hidden && p.discarded === discarded,
        `actual hidden:${p.hidden} discarded:${p.discarded}`,
    );
}

async function createAtEnd(t, name, comment) {
    const index = (await t.query()).length;

    const created = await t.tryStep(
        `tabs.create({url: ${name}, openerTabId: p, index: ${index}})  // ${comment}`,
        () => t.create(name, {openerTabId: t.id('p'), index}),
        {snap: `created with ${comment}`},
    );

    if (created) {
        t.note(`${name}: resolved object opener ${t.describeOpener(created)}; tabs.get opener ${await t.opener(name)}`);
    }

    t.expect(`${comment}: the link is taken at creation (§11)`, created ? await t.opener(name) : 'rejected', 'p');
}

export const tests = [

{
    id: 'R16.01',
    title: 'tabs.create({openerTabId}) at an explicit index — the opener is hidden, hidden and discarded, discarded: is the link taken',
    async run(t) {
        await t.scene(['x', 'p', 'a']);

        const applied = await t.setting('newTabPosition', 'atEnd');
        t.note(`newTabPosition: requested atEnd, applied ${applied.applied}`);

        t.watch(['tabs.onCreated', 'tabs.onUpdated'], {updatedKeys: [...OPENER_KEYS, 'hidden', 'discarded']});
        await t.snap('before');

        await t.step('tabs.hide([p])', () => t.hide(['p'], {settle: false}), {snap: 'opener hidden'});
        await requireOpenerState(t, true, false);
        await createAtEnd(t, 'c1', 'hidden opener');

        await t.step('tabs.discard(p)', () => browser.tabs.discard(t.id('p')), {snap: 'opener hidden and discarded'});
        await requireOpenerState(t, true, true);
        await createAtEnd(t, 'c2', 'hidden and discarded opener');

        await t.step('tabs.show([p])', () => t.show(['p'], {settle: false}), {snap: 'opener shown, still discarded'});
        await requireOpenerState(t, false, true);
        await createAtEnd(t, 'c3', 'discarded opener');

        t.expect('only the created tabs carry links (§11)', await t.openers(), {x: 'absent', p: 'absent', a: 'absent', c1: 'p', c2: 'p', c3: 'p'});
        t.expectRow('opener hidden', ['x*', 'p(h)', 'a']);
        t.expectRow('created with hidden opener', ['x*', 'p(h)', 'a', '➕c1→p']);
        t.expectRow('opener hidden and discarded', ['x*', 'p(h)', 'a', '➕c1→p']);
        t.expectRow('created with hidden and discarded opener', ['x*', 'p(h)', 'a', '➕c1→p', '➕c2→p']);
        t.expectRow('opener shown, still discarded', ['x*', 'p', 'a', '➕c1→p', '➕c2→p']);
        t.expectRow('created with discarded opener', ['x*', 'p', 'a', '➕c1→p', '➕c2→p', '➕c3→p']);
    },
},

{
    id: 'R16.02',
    title: 'tabs.create({openerTabId}) across windows — created in window 2 with an opener from window 1, and created in window 1 with an opener from window 2',
    async run(t) {
        await t.scene(['p', 'x']);

        const applied = await t.setting('newTabPosition', 'atEnd');
        t.note(`newTabPosition: requested atEnd, applied ${applied.applied}`);

        t.watch(['tabs.onCreated', 'tabs.onUpdated'], {updatedKeys: OPENER_KEYS});
        await t.snap('before (window 1)');

        const win2 = await t.buildWindow(['w']);
        await t.snapWindow('before (window 2)', win2);

        const c1 = await t.tryStep(
            'tabs.create({windowId: 2, url: c1, openerTabId: p})  // the opener stays in window 1',
            () => t.create('c1', {windowId: win2, openerTabId: t.id('p')}),
            {snap: 'created in window 2 (window 1)'},
        );
        await t.snapWindow('created in window 2 (window 2)', win2);

        if (c1) {
            const fresh = await browser.tabs.get(c1.id);
            t.note(`c1: resolved object opener ${t.describeOpener(c1)}; tabs.get opener ${t.describeOpener(fresh)}; landed in window ${fresh.windowId === win2 ? 2 : 1}`);
        }

        const c2 = await t.tryStep(
            'tabs.create({url: c2, openerTabId: w})  // created in window 1, the opener lives in window 2',
            () => t.create('c2', {openerTabId: t.id('w')}),
            {snap: 'created in window 1 (window 1)'},
        );
        await t.snapWindow('created in window 1 (window 2)', win2);

        if (c2) {
            const fresh = await browser.tabs.get(c2.id);
            t.note(`c2: resolved object opener ${t.describeOpener(c2)}; tabs.get opener ${t.describeOpener(fresh)}; landed in window ${fresh.windowId === t.win ? 1 : 2}`);
        }

        t.expect('a cross-window opener rejects the call, both directions (§12)', {c1: c1 === null, c2: c2 === null}, {c1: true, c2: true});
        t.expectRow('created in window 2 (window 1)', ['p*', 'x']);
        t.expectRow('created in window 2 (window 2)', ['w*']);
        t.expectRow('created in window 1 (window 1)', ['p*', 'x']);
        t.expectRow('created in window 1 (window 2)', ['w*']);
    },
},

{
    id: 'R16.03',
    title: 'tabs.create({openerTabId}) pointing at a tab that was just removed — rejected, or created without the link',
    async run(t) {
        await t.scene(['x', 'p']);

        t.watch(['tabs.onCreated', 'tabs.onUpdated', 'tabs.onRemoved'], {updatedKeys: OPENER_KEYS});
        await t.snap('before');

        const deadId = t.id('p');

        await t.step('tabs.remove(p)  // the future opener', () => browser.tabs.remove(deadId), {snap: 'opener removed'});

        const created = await t.tryStep(
            'tabs.create({url: c1, openerTabId: p, index: 1})  // p is already closed',
            () => t.create('c1', {openerTabId: deadId, index: 1}),
        );

        if (created) {
            t.note(`c1: resolved object opener ${t.describeOpener(created)}; tabs.get opener ${await t.opener('c1')}`);
        }

        t.expect('a removed opener rejects the call, no tab is created (§13)', created, null);
        t.expectRow('opener removed', ['x*']);
        t.expectRow('after', ['x*']);
    },
},

{
    id: 'R16.04',
    title: 'tabs.create({discarded: true, openerTabId}) — the shape STG recreates background tabs with: is the link on the discarded tab',
    async run(t) {
        await t.scene(['p', 'x']);

        t.watch(['tabs.onCreated', 'tabs.onUpdated'], {updatedKeys: [...OPENER_KEYS, 'discarded']});
        await t.snap('before');

        // an http url on purpose - the STG shape: a discarded tab is created with the real page url, it never loads
        const created = await t.tryStep(
            'tabs.create({url: https://…/?tab=c1, title: c1, discarded: true, openerTabId: p, index: 2})',
            () => t.create('c1', {url: sceneUrl('c1', NETWORK_URL), discarded: true, openerTabId: t.id('p'), index: 2}),
        );

        const fresh = created && await browser.tabs.get(created.id);

        if (fresh) {
            t.note(`c1: resolved object opener ${t.describeOpener(created)}, discarded ${created.discarded}; tabs.get opener ${t.describeOpener(fresh)}, discarded ${fresh.discarded}`);
        }

        t.expect('a discarded create carries the link (§11)', fresh ? {opener: t.describeOpener(fresh), discarded: fresh.discarded} : 'rejected', {opener: 'p', discarded: true});
        t.expectRow('after', ['p*', 'x', '➕c1→p']);
    },
},

];
