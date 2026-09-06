import {OTHER_ADDON_WAIT, NOISY_UPDATE_KEYS} from '../constants.js';
import {OpenerTest, OPENER_KEYS} from '../opener.js';

export const quiet = OTHER_ADDON_WAIT;

export const note = `Round 14 — tab.openerTabId as STG has to carry it: set by tabs.create and tabs.update,
what survives hide/show, discard, a move (same window, across windows), a pin, the opener's removal
and a browser restart. Every cell prints the opener as a suffix right after the name: c1→p means
c1.openerTabId points at p; (p) is a pinned tab. Run it twice — in the clean profile, and in a profile with Tree Style
Tab and no STG: the expectations are the clean-profile facts, so in the TST profile every MISMATCH
line is a TST fact (OPENER-BEHAVIOR.md, the Tree Style Tab section). A tree extension acts with a delay, so
a step here counts as settled only after OTHER_ADDON_WAIT of silence — in both profiles alike.

PRECONDITION for R14.08: about:preferences → Startup → "Open previous windows and tabs" must be ON.`;

class Round14OpenerTest extends OpenerTest {
    constructor(options) {
        super(options);
        this.openerEvents = new Map();
    }

    suffix(tab) {
        return super.suffix(tab) + (tab.pinned ? '(p)' : '');
    }

    async createChildren(names) {
        await this.createMany(names.map((name, index) => ({name, index: CHILDREN_START_INDEX + index})));
        await this.settled();

        const actual = (await this.query()).map(tab => this.nameOf(tab));

        this.require('setup: children created at explicit indexes, no opener', actual.join(',') === ['x', 'p', ...names].join(','), actual.join(','));
    }

    watchUpdatedFiltered(tag, properties) {
        const target = browser.tabs.onUpdated;

        this.openerEvents.set(tag, 0);

        const handler = (tabId, changeInfo, tab) => {
            if (tab.windowId !== this.win) {
                return;
            }

            if (Object.hasOwn(changeInfo, 'openerTabId')) {
                this.openerEvents.set(tag, this.openerEvents.get(tag) + 1);
            }

            const keys = Object.keys(changeInfo).filter(key => !NOISY_UPDATE_KEYS.includes(key));

            if (!keys.length) {
                this.data.dropped++;
                return;
            }

            const shown = keys.map(key => {
                const value = changeInfo[key];
                const named = key === 'openerTabId' ? (value === -1 ? 'none' : this.known(value)) : value;
                return `${key}: ${named}`;
            });

            this.record(`onUpdated[${tag}]`, `${this.known(tabId)}  {${shown.join(', ')}}  tab.opener=${this.describeOpener(tab)}`);
        };

        if (properties) {
            target.addListener(handler, {properties});
        } else {
            target.addListener(handler);
        }

        this.listeners.push({target, handler});
    }

    openerEventCounts() {
        return Array.from(this.openerEvents, ([tag, count]) => `${tag}: ${count}`).join(', ');
    }
}

export const testClass = Round14OpenerTest;

const STG_UPDATED_FILTER = ['title', 'status', 'favIconUrl', 'hidden', 'pinned', 'discarded', 'audible', 'groupId'];
const TREE = {c1: 'p', c2: 'c1', c3: 'p', c4: 'p'};
const CHILDREN = ['c1', 'c2', 'c3'];
const CHILDREN_START_INDEX = 2;
const CHILDREN_OF_P = {c1: 'p', c2: 'p', c3: 'p', p: 'absent', x: 'absent'};

export const tests = [

{
    id: 'R14.01',
    title: 'tabs.create({openerTabId}) — is the opener on the resolved object, on tabs.get and on tabs.query',
    async run(t) {
        await t.scene(['p', 'x']);

        const applied = await t.setting('newTabPosition', 'atEnd');
        t.note(`newTabPosition: requested atEnd, applied ${applied.applied}`);

        t.watch(['tabs.onCreated', 'tabs.onUpdated'], {updatedKeys: OPENER_KEYS});
        await t.snap('before');

        const created = await t.step('tabs.create({url: c, openerTabId: p})', () => t.create('c', {openerTabId: t.id('p')}));

        t.note(`resolved object of tabs.create: opener ${t.describeOpener(created)}`);
        t.expect('the resolved object carries the opener', t.describeOpener(created), 'p');
        t.expect('tabs.get carries the opener', await t.opener('c'), 'p');
        t.expect('tabs.query carries the opener', await t.openers(), {p: 'absent', x: 'absent', c: 'p'});
        t.expectRow('after', ['p*', 'x', '➕c→p']);
    },
},

{
    id: 'R14.02',
    title: 'tabs.create({openerTabId}) under relatedAfterCurrent — placement without an index, and does an explicit index still win',
    async run(t) {
        await t.scene(['p', 'a', 'b']);

        const applied = await t.setting('newTabPosition', 'relatedAfterCurrent');
        t.note(`newTabPosition: requested relatedAfterCurrent, applied ${applied.applied}`);

        t.watch(['tabs.onCreated']);
        await t.snap('before');

        await t.step('tabs.create({openerTabId: p})  // p is active, no index', () => t.create('c1', {openerTabId: t.id('p')}), {snap: 'no index, opener active'});
        await t.step('tabs.create({openerTabId: a})  // a is NOT active, no index', () => t.create('c2', {openerTabId: t.id('a')}), {snap: 'no index, opener inactive'});
        await t.step('tabs.create({openerTabId: p, index: 0})', () => t.create('c3', {openerTabId: t.id('p'), index: 0}), {snap: 'index 0'});
        await t.step('tabs.create({openerTabId: p, index: 6})  // the end of the window', () => t.create('c4', {openerTabId: t.id('p'), index: 6}), {snap: 'index at the end'});

        t.expect('every created tab carries its opener', await t.openers(), {c3: 'p', p: 'absent', c1: 'p', a: 'absent', c2: 'a', b: 'absent', c4: 'p'});
        t.expectRow('no index, opener active', ['p*', '➕c1→p', 'a', 'b']);
        t.expectRow('no index, opener inactive', ['p*', '➕c1→p', 'a', '➕c2→a', 'b']);
        t.expectRow('index 0', ['➕c3→p', 'p*', '➕c1→p', 'a', '➕c2→a', 'b']);
        t.expectRow('index at the end', ['➕c3→p', 'p*', '➕c1→p', 'a', '➕c2→a', 'b', '➕c4→p']);
        t.note('CREATE-TABS-BEHAVIOR.md §2 holds for tabs WITHOUT an opener; the index rows above are the same check WITH one');
    },
},

{
    id: 'R14.03',
    title: 'tabs.update({openerTabId}) — set, re-point, clear with -1, point at itself; which events announce it',
    async run(t) {
        await t.scene(['p', 'c', 'x']);

        t.watch(['tabs.onUpdated'], {updatedKeys: OPENER_KEYS});
        await t.snap('before');

        const updated = await t.step('tabs.update(c, {openerTabId: p})', () => t.setOpener('c', 'p'), {snap: 'set'});

        t.note(`resolved object of tabs.update: opener ${t.describeOpener(updated)}`);
        t.expect('set: c → p', await t.openers(), {p: 'absent', c: 'p', x: 'absent'});

        await t.step('tabs.update(c, {openerTabId: x})  // re-point', () => t.setOpener('c', 'x'), {snap: 're-pointed'});
        t.expect('re-point: c → x', await t.openers(), {p: 'absent', c: 'x', x: 'absent'});

        await t.step('tabs.update(c, {openerTabId: -1})  // clear', () => t.setOpener('c', null), {snap: 'cleared'});
        t.expect('clear: c has no opener', await t.openers(), {p: 'absent', c: 'absent', x: 'absent'});

        const fresh = await browser.tabs.get(t.id('c'));
        t.note(`after clearing, tabs.get(c): 'openerTabId' in tab → ${'openerTabId' in fresh}, opener ${t.describeOpener(fresh)}`);

        await t.tryStep('tabs.update(c, {openerTabId: c})  // itself', () => t.setOpener('c', 'c'));
        t.note(`after pointing at itself: c → ${await t.opener('c')}`);

        t.expectRow('set', ['p*', 'c→p', 'x']);
        t.expectRow('re-pointed', ['p*', 'c→x', 'x']);
        t.expectRow('cleared', ['p*', 'c', 'x']);
        t.expectRow('after', ['p*', 'c→c', 'x']);
    },
},

{
    id: 'R14.04',
    title: 'hide / show — does the opener survive hiding the child, hiding the opener; can a hidden tab be re-pointed',
    async run(t) {
        await t.scene(['x', 'p', 'c1', 'c2']);
        await t.setOpeners([['c1', 'p'], ['c2', 'p']]);

        t.watch(['tabs.onUpdated'], {updatedKeys: [...OPENER_KEYS, 'hidden']});
        await t.snap('before');

        await t.step('tabs.hide([c1])  // the child', () => t.hide(['c1'], {settle: false}), {snap: 'child hidden'});
        t.expect('child hidden: openers kept', await t.openers(), {x: 'absent', p: 'absent', c1: 'p', c2: 'p'});

        await t.step('tabs.hide([p])  // the opener', () => t.hide(['p'], {settle: false}), {snap: 'opener hidden'});
        t.expect('opener hidden: openers kept', await t.openers(), {x: 'absent', p: 'absent', c1: 'p', c2: 'p'});

        await t.step('tabs.hide([c2]), then tabs.update(c2, {openerTabId: x})  // hidden child → visible opener', async () => {
            await t.hide(['c2'], {settle: false});
            return t.setOpener('c2', 'x');
        }, {snap: 'hidden child re-pointed'});
        t.expect('a hidden tab can be re-pointed', await t.openers(), {x: 'absent', p: 'absent', c1: 'p', c2: 'x'});

        await t.step('tabs.update(c2, {openerTabId: p})  // hidden child → hidden opener', () => t.setOpener('c2', 'p'), {snap: 'hidden → hidden'});
        t.expect('a hidden tab can point at a hidden opener', await t.openers(), {x: 'absent', p: 'absent', c1: 'p', c2: 'p'});

        await t.step('tabs.show([p, c1, c2])', () => t.show(['p', 'c1', 'c2'], {settle: false}), {snap: 'shown'});
        t.expect('shown: openers kept', await t.openers(), {x: 'absent', p: 'absent', c1: 'p', c2: 'p'});

        t.expectRow('child hidden', ['x*', 'p', 'c1→p(h)', 'c2→p']);
        t.expectRow('opener hidden', ['x*', 'p(h)', 'c1→p(h)', 'c2→p']);
        t.expectRow('hidden child re-pointed', ['x*', 'p(h)', 'c1→p(h)', 'c2→x(h)']);
        t.expectRow('hidden → hidden', ['x*', 'p(h)', 'c1→p(h)', 'c2→p(h)']);
        t.expectRow('shown', ['x*', 'p', 'c1→p', 'c2→p']);
    },
},

{
    id: 'R14.05',
    title: 'discard — does the opener survive discarding the child, discarding the opener, and the reload that follows',
    async run(t) {
        await t.scene(['x', 'p', 'c1', 'c2']);
        await t.setOpeners([['c1', 'p'], ['c2', 'p']]);

        t.watch(['tabs.onUpdated'], {updatedKeys: [...OPENER_KEYS, 'discarded']});
        await t.snap('before');

        await t.step('tabs.discard(c1)  // the child', () => browser.tabs.discard(t.id('c1')), {snap: 'child discarded'});
        t.expect('child discarded: openers kept', await t.openers(), {x: 'absent', p: 'absent', c1: 'p', c2: 'p'});

        await t.step('tabs.discard(p)  // the opener', () => browser.tabs.discard(t.id('p')), {snap: 'opener discarded'});
        t.expect('opener discarded: openers kept', await t.openers(), {x: 'absent', p: 'absent', c1: 'p', c2: 'p'});

        await t.step('tabs.discard(c2), then tabs.update(c2, {openerTabId: x})  // discarded child re-pointed', async () => {
            await browser.tabs.discard(t.id('c2'));
            return t.setOpener('c2', 'x');
        }, {snap: 'discarded child re-pointed'});
        t.expect('a discarded tab can be re-pointed', await t.openers(), {x: 'absent', p: 'absent', c1: 'p', c2: 'x'});

        await t.step('tabs.update(c2, {openerTabId: p})  // discarded child → discarded opener', () => t.setOpener('c2', 'p'), {snap: 'discarded → discarded'});
        t.expect('a discarded tab can point at a discarded opener', await t.openers(), {x: 'absent', p: 'absent', c1: 'p', c2: 'p'});

        await t.step('tabs.update(c1, {active: true})  // reloads the discarded child', () => t.activate('c1', {settle: false}), {snap: 'child reloaded'});
        t.expect('reloaded child: openers kept', await t.openers(), {x: 'absent', p: 'absent', c1: 'p', c2: 'p'});

        const tabs = await t.query();
        t.note(`discarded flags now: ${tabs.map(tab => `${t.nameOf(tab)}=${tab.discarded}`).join(', ')}`);

        t.expectRow('child discarded', ['x*', 'p', 'c1→p', 'c2→p']);
        t.expectRow('opener discarded', ['x*', 'p', 'c1→p', 'c2→p']);
        t.expectRow('discarded child re-pointed', ['x*', 'p', 'c1→p', 'c2→x']);
        t.expectRow('discarded → discarded', ['x*', 'p', 'c1→p', 'c2→p']);
        t.expectRow('child reloaded', ['x', 'p', 'c1→p*', 'c2→p']);
    },
},

{
    id: 'R14.06',
    title: 'removing the opener — what the child reports afterwards, with a grandparent above',
    async run(t) {
        await t.scene(['x', 'g', 'p', 'c']);
        await t.setOpeners([['p', 'g'], ['c', 'p']]);

        t.watch(['tabs.onUpdated', 'tabs.onRemoved'], {updatedKeys: OPENER_KEYS});
        await t.snap('before');

        await t.step('tabs.remove(p)  // the opener of c, itself a child of g', () => browser.tabs.remove(t.id('p')));
        t.expect('c lost its opener, g untouched', await t.openers(), {x: 'absent', g: 'absent', c: 'absent'});
        t.expectRow('after', ['x*', 'g', 'c']);

        const fresh = await browser.tabs.get(t.id('c'));
        t.note(`tabs.get(c): 'openerTabId' in tab → ${'openerTabId' in fresh}, opener ${t.describeOpener(fresh)}`);
    },
},

{
    id: 'R14.07',
    title: 'moves — same window keeps the opener; across windows: the child alone, the pair together, back again, restored by tabs.update; an opener from another window is refused',
    async run(t) {
        await t.scene(['p', 'c1', 'c2', 'x']);
        await t.setOpeners([['c1', 'p'], ['c2', 'p']]);

        t.watch(['tabs.onUpdated', 'tabs.onDetached', 'tabs.onAttached'], {updatedKeys: OPENER_KEYS});
        await t.snap('before');

        await t.step('tabs.move(c2, {index: 0})  // same window', () => browser.tabs.move(t.id('c2'), {index: 0}), {snap: 'moved in the window'});
        t.expect('same-window move keeps the opener', await t.openers(), {c2: 'p', p: 'absent', c1: 'p', x: 'absent'});

        await t.step('tabs.move([p, c1], {index: -1})  // array, same window', () => browser.tabs.move(t.ids(['p', 'c1']), {index: -1}), {snap: 'array moved in the window'});
        t.expect('same-window array move keeps the opener', await t.openers(), {c2: 'p', x: 'absent', p: 'absent', c1: 'p'});

        const win2 = await t.buildWindow(['w']);
        await t.snapWindow('before (window 2)', win2);

        await t.step('tabs.move(c1, {windowId: 2, index: -1})  // the child alone', () => browser.tabs.move(t.id('c1'), {windowId: win2, index: -1}), {snap: 'child moved out (window 1)'});
        await t.snapWindow('child moved out (window 2)', win2);
        t.note(`c1 in window 2: opener ${await t.opener('c1')}`);
        t.expect('child alone in another window: opener gone', await t.opener('c1'), 'absent');

        await t.step('tabs.move(c1, {windowId: 1, index: -1})  // back to its opener', () => browser.tabs.move(t.id('c1'), {windowId: t.win, index: -1}), {snap: 'child moved back (window 1)'});
        t.note(`c1 back next to p: opener ${await t.opener('c1')}`);

        await t.step('tabs.move([p, c2], {windowId: 2, index: -1})  // opener and child together, one call', () => browser.tabs.move(t.ids(['p', 'c2']), {windowId: win2, index: -1}), {snap: 'pair moved out (window 1)'});
        await t.snapWindow('pair moved out (window 2)', win2);
        t.note(`window 2 openers: ${JSON.stringify(await t.openers(win2))}`);
        t.expect('the pair moved together: the child still lost its opener', (await t.openers(win2)).c2, 'absent');

        await t.step('tabs.update(c2, {openerTabId: p})  // both in window 2 now', () => t.setOpener('c2', 'p'), {snap: false});
        await t.snapWindow('restored by update (window 2)', win2);
        t.expect('tabs.update restores the opener in the new window', (await t.openers(win2)).c2, 'p');

        await t.tryStep('tabs.update(c1, {openerTabId: p})  // c1 in window 1, p in window 2', () => t.setOpener('c1', 'p'));
        t.note(`c1 after the cross-window update: opener ${await t.opener('c1')}`);

        t.expectRow('moved in the window', ['c2→p', 'p*', 'c1→p', 'x']);
        t.expectRow('array moved in the window', ['c2→p', 'x', 'p*', 'c1→p']);
        t.expectRow('before (window 2)', ['w*']);
        t.expectRow('child moved out (window 1)', ['c2→p', 'x', 'p*']);
        t.expectRow('child moved out (window 2)', ['w*', 'c1']);
        t.expectRow('child moved back (window 1)', ['c2→p', 'x', 'p*', 'c1']);
        t.expectRow('pair moved out (window 1)', ['x', 'c1*']);
        t.expectRow('pair moved out (window 2)', ['w*', 'p', 'c2']);
        t.expectRow('restored by update (window 2)', ['w*', 'p', 'c2→p']);
        t.expectRow('after', ['x', 'c1*']);
    },
},

{
    id: 'R14.08',
    title: 'browser restart — do openers come back: set by update, set by create, on a hidden child, on a discarded child',
    async run(t) {
        await t.scene(['x', 'p', 'c1', 'c2', 'c3']);
        await t.setOpeners([['c1', 'p'], ['c2', 'c1'], ['c3', 'p']]);

        await t.create('c4', {openerTabId: t.id('p'), index: 5});
        await t.settled();

        await t.hide(['c3']);
        await browser.tabs.discard(t.id('c2'));
        await t.settled();

        const before = await t.openers();
        const wrong = Object.entries(TREE).filter(([child, opener]) => before[child] !== opener);
        t.require('setup: the tree is in place', !wrong.length, JSON.stringify(before));

        const tabs = await t.query();
        t.note(`before the restart: ${tabs.map(tab => `${t.nameOf(tab)} hidden:${tab.hidden} discarded:${tab.discarded}`).join(', ')}`);

        await t.snap('before restart');
        t.expectRow('before restart', ['x*', 'p', 'c1→p', 'c2→c1', 'c3→p(h)', '➕c4→p']);

        await t.restart();
    },
    async afterRestart(t) {
        await t.settled();
        await t.snap('after restart');

        const tabs = await t.query();
        t.note(`after the restart: ${tabs.map(tab => `${t.nameOf(tab)} hidden:${tab.hidden} discarded:${tab.discarded} opener:${t.describeOpener(tab)}`).join(', ')}`);

        const after = await t.openers();
        t.expect('openers after the restart: absent on every tab (§8)', Object.fromEntries(Object.keys(TREE).map(child => [child, after[child]])), Object.fromEntries(Object.keys(TREE).map(child => [child, 'absent'])));
        t.expectRow('after restart', ['x*', 'p', 'c1', 'c2', 'c3(h)', 'c4']);
    },
},

{
    id: 'R14.09',
    title: 'tabs.update to the opener a tab ALREADY has — is it a no-op, or does the tab move again (meaningful with a tree extension)',
    async run(t) {
        await t.scene(['x', 'p', 'c1', 'c2', 'c3']);
        await t.setOpeners([['c1', 'p'], ['c2', 'p'], ['c3', 'p']]);

        t.watch(['tabs.onUpdated', 'tabs.onMoved'], {updatedKeys: OPENER_KEYS});
        await t.snap('before');

        await t.step('tabs.update(c1, {openerTabId: p})  // c1 → p again, c1 is the first child', () => t.setOpener('c1', 'p'), {snap: 'first child re-pointed'});
        await t.step('tabs.update(c3, {openerTabId: p})  // c3 → p again, c3 is the last child', () => t.setOpener('c3', 'p'), {snap: 'last child re-pointed'});
        await t.step('all three → p again, in order, in parallel', () => Promise.all([t.setOpener('c1', 'p'), t.setOpener('c2', 'p'), t.setOpener('c3', 'p')]), {snap: 'all re-pointed'});

        t.expect('openers unchanged', await t.openers(), {x: 'absent', p: 'absent', c1: 'p', c2: 'p', c3: 'p'});
        t.expectRow('first child re-pointed', ['x*', 'p', 'c1→p', 'c2→p', 'c3→p']);
        t.expectRow('last child re-pointed', ['x*', 'p', 'c1→p', 'c2→p', 'c3→p']);
        t.expectRow('all re-pointed', ['x*', 'p', 'c1→p', 'c2→p', 'c3→p']);
        t.note('the rows show whether a same-opener update moved anything');
    },
},

{
    id: 'R14.10',
    title: 'browser restart, then the saved links are applied again in the saved order — does the order survive (meaningful with a tree extension)',
    async run(t) {
        await t.scene(['x', 'p', 'c1', 'c2', 'c3']);
        await t.setOpeners([['c1', 'p'], ['c2', 'p'], ['c3', 'c2']]);

        await t.snap('before restart');
        t.expectRow('before restart', ['x*', 'p', 'c1→p', 'c2→p', 'c3→c2']);

        await t.restart();
    },
    async afterRestart(t) {
        await t.settled();

        t.watch(['tabs.onUpdated', 'tabs.onMoved'], {updatedKeys: OPENER_KEYS});
        await t.snap('after restart');

        await t.step('the saved links again, in order, in parallel: c1 → p, c2 → p, c3 → c2', () => {
            return Promise.all([t.setOpener('c1', 'p'), t.setOpener('c2', 'p'), t.setOpener('c3', 'c2')]);
        }, {snap: 'links applied'});

        t.expect('openers restored', await t.openers(), {x: 'absent', p: 'absent', c1: 'p', c2: 'p', c3: 'c2'});
        t.expectRow('after restart', ['x*', 'p', 'c1', 'c2', 'c3']);
        t.expectRow('links applied', ['x*', 'p', 'c1→p', 'c2→p', 'c3→c2']);
        t.note('compare the "links applied" row with "before restart": the same order means a tree extension took the links as a no-op');
    },
},

{
    id: 'R14.11',
    title: 'tabs created WITHOUT an opener at explicit indexes after p, then linked to p in PARALLEL — where do the siblings end up (meaningful with a tree extension)',
    async run(t) {
        await t.scene(['x', 'p']);
        await t.createChildren(CHILDREN);

        t.watch(['tabs.onUpdated', 'tabs.onMoved'], {updatedKeys: OPENER_KEYS});
        await t.snap('created');

        await t.step('tabs.update → p for c1, c2, c3, all at once', () => Promise.all(CHILDREN.map(name => t.setOpener(name, 'p'))), {snap: 'linked'});

        t.expect('every child points at p', await t.openersByName(), CHILDREN_OF_P);
        t.expectRow('created', ['x*', 'p', '➕c1', '➕c2', '➕c3']);
        t.expectRow('linked', ['x*', 'p', '➕c1→p', '➕c2→p', '➕c3→p']);
        t.note('the "linked" row against "created" shows what the parallel links did to the sibling order');
    },
},

{
    id: 'R14.12',
    title: 'the same, linked ONE BY ONE in creation order: c1, then c2, then c3 (meaningful with a tree extension)',
    async run(t) {
        await t.scene(['x', 'p']);
        await t.createChildren(CHILDREN);

        t.watch(['tabs.onUpdated', 'tabs.onMoved'], {updatedKeys: OPENER_KEYS});
        await t.snap('created');

        for (const name of CHILDREN) {
            await t.step(`tabs.update(${name}, {openerTabId: p})`, () => t.setOpener(name, 'p'), {snap: `${name} linked`});
        }

        t.expect('every child points at p', await t.openersByName(), CHILDREN_OF_P);
        t.expectRow('created', ['x*', 'p', '➕c1', '➕c2', '➕c3']);
        t.expectRow('c1 linked', ['x*', 'p', '➕c1→p', '➕c2', '➕c3']);
        t.expectRow('c2 linked', ['x*', 'p', '➕c1→p', '➕c2→p', '➕c3']);
        t.expectRow('c3 linked', ['x*', 'p', '➕c1→p', '➕c2→p', '➕c3→p']);
    },
},

{
    id: 'R14.13',
    title: 'the same, linked ONE BY ONE in REVERSE order: c3, then c2, then c1 (meaningful with a tree extension)',
    async run(t) {
        await t.scene(['x', 'p']);
        await t.createChildren(CHILDREN);

        t.watch(['tabs.onUpdated', 'tabs.onMoved'], {updatedKeys: OPENER_KEYS});
        await t.snap('created');

        for (const name of CHILDREN.toReversed()) {
            await t.step(`tabs.update(${name}, {openerTabId: p})`, () => t.setOpener(name, 'p'), {snap: `${name} linked`});
        }

        t.expect('every child points at p', await t.openersByName(), CHILDREN_OF_P);
        t.expectRow('created', ['x*', 'p', '➕c1', '➕c2', '➕c3']);
        t.expectRow('c3 linked', ['x*', 'p', '➕c1', '➕c2', '➕c3→p']);
        t.expectRow('c2 linked', ['x*', 'p', '➕c1', '➕c2→p', '➕c3→p']);
        t.expectRow('c1 linked', ['x*', 'p', '➕c1→p', '➕c2→p', '➕c3→p']);
    },
},

{
    id: 'R14.14',
    title: 'linked in parallel, then the saved order is enforced by an array tabs.move — does a tree extension accept it or re-arrange/detach (meaningful with a tree extension)',
    async run(t) {
        await t.scene(['x', 'p']);
        await t.createChildren(CHILDREN);

        t.watch(['tabs.onUpdated', 'tabs.onMoved'], {updatedKeys: OPENER_KEYS});
        await t.snap('created');

        await t.step('tabs.update → p for c1, c2, c3, all at once', () => Promise.all(CHILDREN.map(name => t.setOpener(name, 'p'))), {snap: 'linked'});
        await t.step('tabs.move([c1, c2, c3], {index: 2})  // the saved order back, the way STG sorts', () => browser.tabs.move(t.ids(CHILDREN), {index: CHILDREN_START_INDEX}), {snap: 'sorted'});

        t.note(`openers after the sort: ${JSON.stringify(await t.openersByName())}`);
        t.expect('every child still points at p', await t.openersByName(), CHILDREN_OF_P);
        t.expectRow('created', ['x*', 'p', '➕c1', '➕c2', '➕c3']);
        t.expectRow('linked', ['x*', 'p', '➕c1→p', '➕c2→p', '➕c3→p']);
        t.expectRow('sorted', ['x*', 'p', '➕c1→p', '➕c2→p', '➕c3→p']);
    },
},

{
    id: 'R14.15',
    title: 'tabs.onUpdated with a "properties" filter — is a change of openerTabId ALONE delivered to a listener whose filter lacks it (the STG subscription) and to an unfiltered one; can openerTabId be a filter value at all',
    async run(t) {
        await t.scene(['p', 'c', 'x']);

        t.note(`[stg] is the tab-keys filter an STG-like subscription would use - STG subscribes unfiltered for this very reason: ${STG_UPDATED_FILTER.join(', ')}; [none] no filter`);
        t.note(`browser.tabs.UpdatePropertyName: ${JSON.stringify(browser.tabs.UpdatePropertyName)}`);

        const probe = () => {};
        const withOpener = await Promise.resolve().then(() => browser.tabs.onUpdated.addListener(probe, {properties: [...OPENER_KEYS]})).then(
            () => 'accepted',
            error => `rejected — ${error.message}`,
        );
        browser.tabs.onUpdated.removeListener(probe);
        t.note(`addListener with {properties: ['openerTabId']}: ${withOpener}`);

        t.watchUpdatedFiltered('stg', STG_UPDATED_FILTER);
        t.watchUpdatedFiltered('none', null);
        await t.snap('before');

        await t.step('tabs.update(c, {openerTabId: p})', () => t.setOpener('c', 'p'), {snap: 'set'});
        await t.step('tabs.update(c, {openerTabId: x})  // re-point', () => t.setOpener('c', 'x'), {snap: 're-pointed'});
        await t.step('tabs.update(c, {openerTabId: -1})  // clear', () => t.setOpener('c', null), {snap: 'cleared'});
        await t.step('tabs.update(c, {openerTabId: c})  // itself, the way a tree extension writes "detached"', () => t.setOpener('c', 'c'), {snap: 'self-pointed'});
        await t.step('tabs.create({url: c2, openerTabId: p, index: 3})  // the link set at creation', () => t.create('c2', {openerTabId: t.id('p'), index: 3}), {snap: 'created'});

        t.note(`onUpdated events carrying openerTabId, per listener — ${t.openerEventCounts()}`);
        t.expect('openerTabId is not accepted as a filter value (§10)', withOpener.startsWith('rejected'), true);
        t.expect('a listener with the STG filter: not one of the opener changes (§10)', t.openerEvents.get('stg'), 0);
        t.expect('unfiltered listener: one onUpdated per tabs.update call (§3, §10), none for tabs.create (§1)', t.openerEvents.get('none'), 4);

        t.expectRow('set', ['p*', 'c→p', 'x']);
        t.expectRow('re-pointed', ['p*', 'c→x', 'x']);
        t.expectRow('cleared', ['p*', 'c', 'x']);
        t.expectRow('self-pointed', ['p*', 'c→c', 'x']);
        t.expectRow('created', ['p*', 'c→c', 'x', '➕c2→p']);
    },
},

{
    id: 'R14.16',
    title: 'the OPENER leaves the window and the child stays — what the child reports; the child follows into the opener\'s window; what tabs.get sees right inside onDetached / onAttached',
    async run(t) {
        await t.scene(['p', 'c1', 'c2', 'x']);
        await t.setOpeners([['c1', 'p'], ['c2', 'p']]);

        t.watch(['tabs.onUpdated', 'tabs.onDetached', 'tabs.onAttached'], {updatedKeys: OPENER_KEYS});
        t.watchOpenerAt('tabs.onDetached');
        t.watchOpenerAt('tabs.onAttached');
        await t.snap('before (window 1)');

        const win2 = await t.buildWindow(['w']);
        await t.snapWindow('before (window 2)', win2);

        await t.step('tabs.move(p, {windowId: 2, index: -1})  // the opener alone, both children stay', () => browser.tabs.move(t.id('p'), {windowId: win2, index: -1}), {snap: 'opener moved out (window 1)'});
        await t.snapWindow('opener moved out (window 2)', win2);
        t.expect('the children left behind lost their links (§9)', {c1: await t.opener('c1'), c2: await t.opener('c2')}, {c1: 'absent', c2: 'absent'});

        await t.step('tabs.move(c1, {windowId: 2, index: -1})  // the child follows into the opener\'s window', () => browser.tabs.move(t.id('c1'), {windowId: win2, index: -1}), {snap: 'child followed (window 1)'});
        await t.snapWindow('child followed (window 2)', win2);
        t.expect('the child that followed arrives without a link (§9)', await t.opener('c1'), 'absent');

        await t.step('tabs.update(c1, {openerTabId: p})  // both in window 2', () => t.setOpener('c1', 'p'), {snap: false});
        await t.snapWindow('restored by update (window 2)', win2);
        t.expect('tabs.update restores the link once both are in one window (§7)', (await t.openers(win2)).c1, 'p');

        t.expectRow('before (window 1)', ['p*', 'c1→p', 'c2→p', 'x']);
        t.expectRow('before (window 2)', ['w*']);
        t.expectRow('opener moved out (window 1)', ['c1*', 'c2', 'x']);
        t.expectRow('opener moved out (window 2)', ['w*', 'p']);
        t.expectRow('child followed (window 1)', ['c2*', 'x']);
        t.expectRow('child followed (window 2)', ['w*', 'p', 'c1']);
        t.expectRow('restored by update (window 2)', ['w*', 'p', 'c1→p']);
    },
},

{
    id: 'R14.17',
    title: 'pinning a tab that has an opener and a child — do the links to and from it survive the pin, which events; a fresh link set ON the pinned tab, ONTO it, a tab created with the pinned opener; -1 on the pinned tab and on its pre-pin child; what unpin brings back',
    async run(t) {
        await t.scene(['x', 'g', 'p', 'c1', 'c2', 'y']);
        await t.setOpeners([['p', 'g'], ['c1', 'p'], ['c2', 'c1']]);

        t.watch(['tabs.onUpdated', 'tabs.onMoved', 'tabs.onCreated'], {updatedKeys: [...OPENER_KEYS, 'pinned']});
        await t.snap('before');

        await t.step('tabs.update(p, {pinned: true})  // p → g and c1 → p are the links at stake, c2 → c1 the control', () => browser.tabs.update(t.id('p'), {pinned: true}), {snap: 'pinned'});

        const pinned = await browser.tabs.get(t.id('p'));
        const afterPin = await t.openers();
        t.note(`p after the pin: pinned:${pinned.pinned} index:${pinned.index} opener:${t.describeOpener(pinned)}`);
        t.note(`openers after the pin: ${JSON.stringify(afterPin)}`);
        t.expect('the pin keeps every link, to and from p (§17)', afterPin, {p: 'g', x: 'absent', g: 'absent', c1: 'p', c2: 'c1', y: 'absent'});

        const setOn = await t.tryStep('tabs.update(p, {openerTabId: x})  // a link p never had, set ON the pinned tab', () => t.setOpener('p', 'x'), {snap: 'p → x set on the pinned tab'});
        const setOnto = await t.tryStep('tabs.update(y, {openerTabId: p})  // from a tab that never pointed at p, set ONTO the pinned tab', () => t.setOpener('y', 'p'), {snap: 'y → p set onto the pinned tab'});

        const end = (await t.query()).length;
        const created = await t.tryStep(`tabs.create({url: n, openerTabId: p, index: ${end}})  // the pinned tab as the opener at creation`, () => t.create('n', {openerTabId: t.id('p'), index: end}), {snap: 'created with the pinned opener'});

        const clearedOn = await t.tryStep('tabs.update(p, {openerTabId: -1})  // the clear on the pinned tab, which holds a link', () => t.setOpener('p', null), {snap: 'cleared on the pinned tab'});
        const clearedChild = await t.tryStep('tabs.update(c1, {openerTabId: -1})  // the clear on its pre-pin child', () => t.setOpener('c1', null), {snap: 'cleared on the child'});

        t.expect('every write on and onto the pinned tab resolves: set on, set onto, create, -1 on it, -1 on its child (§17)', [setOn, setOnto, created, clearedOn, clearedChild].map(result => result !== null), [true, true, true, true, true]);

        await t.step('tabs.update(p, {pinned: false})', () => browser.tabs.update(t.id('p'), {pinned: false}), {snap: 'unpinned'});

        const unpinned = await browser.tabs.get(t.id('p'));
        const afterUnpin = await t.openers();
        t.note(`p after the unpin: pinned:${unpinned.pinned} index:${unpinned.index} opener:${t.describeOpener(unpinned)}`);
        t.note(`openers after the unpin: ${JSON.stringify(afterUnpin)}`);
        t.expect('unpin brings nothing back: the cleared links stay cleared, the links set while pinned stay (§17)', afterUnpin, {p: 'absent', x: 'absent', g: 'absent', c1: 'absent', c2: 'c1', y: 'p', n: 'p'});

        t.expectRow('before', ['x*', 'g', 'p→g', 'c1→p', 'c2→c1', 'y']);
        t.expectRow('pinned', ['p→g(p)', 'x*', 'g', 'c1→p', 'c2→c1', 'y']);
        t.expectRow('p → x set on the pinned tab', ['p→x(p)', 'x*', 'g', 'c1→p', 'c2→c1', 'y']);
        t.expectRow('y → p set onto the pinned tab', ['p→x(p)', 'x*', 'g', 'c1→p', 'c2→c1', 'y→p']);
        t.expectRow('created with the pinned opener', ['p→x(p)', 'x*', 'g', 'c1→p', 'c2→c1', 'y→p', '➕n→p']);
        t.expectRow('cleared on the pinned tab', ['p(p)', 'x*', 'g', 'c1→p', 'c2→c1', 'y→p', '➕n→p']);
        t.expectRow('cleared on the child', ['p(p)', 'x*', 'g', 'c1', 'c2→c1', 'y→p', '➕n→p']);
        t.expectRow('unpinned', ['p', 'x*', 'g', 'c1', 'c2→c1', 'y→p', '➕n→p']);
    },
},

];
