import {ACTION_WAIT} from '../constants.js';
import {TabsTest} from '../tabs.js';

export const note = `Round 13 — a window whose LAST VISIBLE tabs are removed while hidden (tabHide)
tabs remain: does the window survive, which hidden tab gets revealed, and — critically — which
events announce the reveal (a cross-window move reveals SILENTLY, TABGROUPS-BEHAVIOR.md §17 — does
this reveal too?). Watched: tabs.onRemoved / onActivated / onUpdated and windows.onRemoved.
Asserts the recorded facts: REMOVE-TABS-BEHAVIOR.md §1 (the window closes, hidden tabs die, no
reveal) and §2 (a pinned tab keeps the window alive).`;

class WindowLifeTest extends TabsTest {
    cell(tab) {
        return super.cell(tab) + (tab.pinned ? '(p)' : '');
    }

    eventFormatters() {
        return {
            ...super.eventFormatters(),
            'windows.onRemoved': ([windowId]) => windowId === this.win ? 'SCENE window closed' : 'other window closed',
        };
    }
}

export const testClass = WindowLifeTest;

const WATCH = ['tabs.onRemoved', 'tabs.onActivated', 'tabs.onUpdated', 'windows.onRemoved'];

async function requireHidden(t, names) {
    const tabs = await t.query();
    const hidden = names.filter(name => tabs.find(tab => t.nameOf(tab) === name)?.hidden);

    t.require('setup: tabs are hidden', hidden.length === names.length, `hidden: [${hidden.join(', ')}] of [${names.join(', ')}]`);
}

async function afterRemoval(t, expectAlive) {
    const alive = Boolean(await browser.windows.get(t.win).catch(() => null));

    t.note(`scene window alive: ${alive}`);
    t.expect('scene window alive', alive, expectAlive);

    if (!alive) {
        t.win = null;
        return;
    }

    await t.settled();
    await t.snap('after');

    const tabs = await t.query();
    const visible = tabs.filter(tab => !tab.hidden);

    t.note(`visible now: ${visible.map(tab => t.cell(tab)).join(', ') || '(none)'}`);

    for (const tab of visible) {
        t.note(`${t.nameOf(tab)} fresh: active:${tab.active} pinned:${tab.pinned} hidden:${tab.hidden} discarded:${tab.discarded} status:${tab.status}`);
    }
}

export const tests = [

{
    id: 'R13.01',
    title: 'array remove of ALL visible tabs, two hidden remain — the sync shape',
    async run(t) {
        await t.scene(['v1', 'v2', 'h1', 'h2']);
        await t.hide(['h1', 'h2']);
        await requireHidden(t, ['h1', 'h2']);

        t.watch(WATCH);
        await t.snap('before');

        await t.step('tabs.remove([v1, v2])  // every visible tab in one call', () => {
            return browser.tabs.remove(t.ids(['v1', 'v2'])).then(
                () => t.note('tabs.remove resolved'),
                error => t.note(`tabs.remove rejected: ${error.message}`),
            );
        }, {wait: ACTION_WAIT, snap: false});

        await afterRemoval(t, false);
    },
},

{
    id: 'R13.02',
    title: 'one-by-one: the inactive visible goes first, then the LAST visible (active)',
    async run(t) {
        await t.scene(['v1', 'v2', 'h1', 'h2']);
        await t.hide(['h1', 'h2']);
        await requireHidden(t, ['h1', 'h2']);

        t.watch(WATCH);
        await t.snap('before');

        await t.step('tabs.remove(v2)  // an inactive visible, v1 still visible', () => browser.tabs.remove(t.id('v2')));
        t.expectRow('after', ['v1*', 'h1(h)', 'h2(h)']);

        await t.step('tabs.remove(v1)  // the last visible tab of the window', () => {
            return browser.tabs.remove(t.id('v1')).then(
                () => t.note('tabs.remove resolved'),
                error => t.note(`tabs.remove rejected: ${error.message}`),
            );
        }, {wait: ACTION_WAIT, snap: false});

        await afterRemoval(t, false);
    },
},

{
    id: 'R13.03',
    title: 'which hidden tab is revealed: hidden neighbours on BOTH sides of the removed tab',
    async run(t) {
        await t.scene(['h1', 'v1', 'h2', 'h3']);
        await t.activate('v1');
        await t.hide(['h1', 'h2', 'h3']);
        await requireHidden(t, ['h1', 'h2', 'h3']);

        t.watch(WATCH);
        await t.snap('before');

        await t.step('tabs.remove(v1)  // hidden at index 0, removed at 1, hidden at 2 and 3', () => {
            return browser.tabs.remove(t.id('v1'));
        }, {wait: ACTION_WAIT, snap: false});

        await afterRemoval(t, false);
    },
},

{
    id: 'R13.04',
    title: 'a PINNED tab is present: is it activated instead of revealing a hidden tab',
    async run(t) {
        await t.scene(['v1', 'p', 'h1']);
        await browser.tabs.update(t.id('p'), {pinned: true});
        await t.settled();

        const pinnedTab = await browser.tabs.get(t.id('p'));
        t.require('setup: p is pinned', pinnedTab.pinned === true, `pinned:${pinnedTab.pinned}`);

        await t.hide(['h1']);
        await requireHidden(t, ['h1']);

        t.watch(WATCH);
        await t.snap('before');

        await t.step('tabs.remove(v1)  // the only visible unpinned tab', () => {
            return browser.tabs.remove(t.id('v1'));
        }, {wait: ACTION_WAIT, snap: false});

        await afterRemoval(t, true);
        t.expectRow('after', ['p*(p)', 'h1(h)']);
    },
},

{
    id: 'R13.05',
    title: 'the only hidden tab is DISCARDED: is it still revealed, does it start loading',
    async run(t) {
        await t.scene(['v1', 'h1']);
        await t.hide(['h1']);
        await browser.tabs.discard(t.id('h1'));
        await t.settled();
        await requireHidden(t, ['h1']);

        const before = await browser.tabs.get(t.id('h1'));
        t.require('setup: h1 is discarded', before.discarded === true, `discarded:${before.discarded}`);

        t.watch(WATCH);
        await t.snap('before');

        await t.step('tabs.remove(v1)  // the only other tab is hidden AND discarded', () => {
            return browser.tabs.remove(t.id('v1'));
        }, {wait: ACTION_WAIT, snap: false});

        await afterRemoval(t, false);
    },
},

];
