import {OTHER_ADDON_WAIT} from '../constants.js';
import {OpenerTest, OPENER_KEYS} from '../opener.js';

export const quiet = OTHER_ADDON_WAIT;

export const note = `Round 17 — a FOREIGN extension clears an opener with tabs.update({openerTabId: -1}):
the call STG makes when a link must not survive a group-boundary crossing. What does a tree
extension do in response — move tabs, write a link back, or take the clear silently? A clear on a
visible child among siblings, on a mid-chain parent, on a hidden child, and a clear followed by
re-linking. Every cell prints the opener as a suffix: c1→p means c1.openerTabId points at p. Run
it twice — in the clean profile, and in a profile with Tree Style Tab and no STG: the
expectations are the clean-profile facts, so in the TST profile every MISMATCH line is a TST
fact. A tree extension acts with a delay, so a step counts as settled only after OTHER_ADDON_WAIT
of silence — in both profiles alike.`;

export const testClass = OpenerTest;

export const tests = [

{
    id: 'R17.01',
    title: 'a foreign -1 on a visible child among siblings — does anything move, does anything write the link back',
    async run(t) {
        await t.scene(['x', 'p', 'c1', 'c2']);
        await t.setOpeners([['c1', 'p'], ['c2', 'p']]);

        t.watch(['tabs.onUpdated', 'tabs.onMoved'], {updatedKeys: OPENER_KEYS});
        await t.snap('before');

        await t.step('tabs.update(c1, {openerTabId: -1})  // the first child of two', () => t.setOpener('c1', null), {snap: 'cleared'});

        t.expect('c1 has no opener, c2 keeps its own (§3, §14)', await t.openers(), {x: 'absent', p: 'absent', c1: 'absent', c2: 'p'});
        t.expectRow('cleared', ['x*', 'p', 'c1', 'c2→p']);
        t.note(`openers after the clear: ${JSON.stringify(await t.openers())}`);
    },
},

{
    id: 'R17.02',
    title: 'a foreign -1 on a mid-chain parent — the child keeps pointing at it; does the subtree move',
    async run(t) {
        await t.scene(['x', 'g', 'p', 'c']);
        await t.setOpeners([['p', 'g'], ['c', 'p']]);

        t.watch(['tabs.onUpdated', 'tabs.onMoved'], {updatedKeys: OPENER_KEYS});
        await t.snap('before');

        await t.step('tabs.update(p, {openerTabId: -1})  // p leaves g, c still points at p', () => t.setOpener('p', null), {snap: 'cleared'});

        t.expect('p has no opener, c keeps pointing at p (§14)', await t.openers(), {x: 'absent', g: 'absent', p: 'absent', c: 'p'});
        t.expectRow('cleared', ['x*', 'g', 'p', 'c→p']);
        t.note(`openers after the clear: ${JSON.stringify(await t.openers())}`);
    },
},

{
    id: 'R17.03',
    title: 'a foreign -1 on a HIDDEN child, then show — is the clear taken on a hidden tab, does showing it move anything',
    async run(t) {
        await t.scene(['x', 'p', 'c1', 'c2']);
        await t.setOpeners([['c1', 'p'], ['c2', 'p']]);

        t.watch(['tabs.onUpdated', 'tabs.onMoved'], {updatedKeys: [...OPENER_KEYS, 'hidden']});
        await t.snap('before');

        await t.step('tabs.hide([c1])', () => t.hide(['c1'], {settle: false}), {snap: 'child hidden'});
        await t.step('tabs.update(c1, {openerTabId: -1})  // hidden child', () => t.setOpener('c1', null), {snap: 'cleared hidden'});

        t.note(`c1 hidden, opener: ${await t.opener('c1')}`);

        await t.step('tabs.show([c1])', () => t.show(['c1'], {settle: false}), {snap: 'shown back'});

        t.expect('the clear is taken on a hidden tab and survives the show (§14)', await t.openers(), {x: 'absent', p: 'absent', c1: 'absent', c2: 'p'});
        t.expectRow('child hidden', ['x*', 'p', 'c1→p(h)', 'c2→p']);
        t.expectRow('cleared hidden', ['x*', 'p', 'c1(h)', 'c2→p']);
        t.expectRow('shown back', ['x*', 'p', 'c1', 'c2→p']);
        t.note(`openers after show: ${JSON.stringify(await t.openers())}`);
    },
},

{
    id: 'R17.04',
    title: 'a foreign -1, then the same link applied again — the STG return trip; does the round trip move anything',
    async run(t) {
        await t.scene(['x', 'p', 'c1', 'c2']);
        await t.setOpeners([['c1', 'p'], ['c2', 'p']]);

        t.watch(['tabs.onUpdated', 'tabs.onMoved'], {updatedKeys: OPENER_KEYS});
        await t.snap('before');

        await t.step('tabs.update(c2, {openerTabId: -1})', () => t.setOpener('c2', null), {snap: 'cleared'});
        await t.step('tabs.update(c2, {openerTabId: p})  // the same link again', () => t.setOpener('c2', 'p'), {snap: 're-linked'});

        t.expect('the link is back (§14)', await t.openers(), {x: 'absent', p: 'absent', c1: 'p', c2: 'p'});
        t.expectRow('cleared', ['x*', 'p', 'c1→p', 'c2']);
        t.expectRow('re-linked', ['x*', 'p', 'c1→p', 'c2→p']);
        t.note('the "re-linked" row against "before" shows whether the round trip moved anything');
    },
},

];
