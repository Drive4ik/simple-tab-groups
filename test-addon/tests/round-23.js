import {TIGHT_POLL_WAIT, SETTLE_TIMEOUT} from '../constants.js';
import {wait} from '../test.js';
import {TabsTest} from '../tabs.js';

export const note = `Round 23 - a tab that is being removed, seen through tabs.query. tabs.onRemoved fires before the
tab has left the window (bugzilla 1396758): a tabs.query issued from the onRemoved handler is said to still
return it. STG filters such tabs out of every read of its own (skip.removed) and takes an appending index
for tabs.create from a count of tabs.query (Tabs.createMultiple, Tabs.resolveMoveIndex); the question is whether a tab that is still
closing occupies an index slot for tabs.create - a count WITHOUT it would then land the new tab one slot
short. R23.01 samples the removed tab in tabs.query from inside the onRemoved handler, at the resolve of
tabs.remove, and every ${TIGHT_POLL_WAIT} ms after until it is gone. R23.02 and R23.03 create a tab from inside the
onRemoved handler with an index equal to the count WITH the closing tab and WITHOUT it; the closing tab
stands in the middle of the window, so the two hypotheses land the new tab in different slots: "the
closing tab holds a slot" gives [a, c, ➕n1, d] for the WITHOUT count, "it does not" gives [a, c, d, ➕n1].
R23.04 is R23.03 with the ACTIVE tab removed - the browser blurs it first. R23.05 is the shape of the
addon's own race: the create at the WITHOUT count goes right after tabs.remove has resolved, not from the
handler. For tabs.remove the removed tab is already out of tabs.query inside the handler
(REMOVE-TABS-BEHAVIOR.md §3), so R23.01-R23.05 assert that and the appending create. R23.06 and R23.07
are MANUAL: the user closes the tab - the close button of an inactive tab, Ctrl+W on the active one -
the gestures the bug report ties to the closing animation; the handler samples tabs.query, creates at
the WITHOUT count and keeps sampling until the tab is gone. There the tab lingers for about 110 ms and
holds its slot, the create lands one short of the end (§4), and both tests assert that. Every create is recorded with what tabs.query
showed right before it and right after it: a closing tab that was already gone at the create makes the
WITH and WITHOUT counts equal, and the row is then read as "no closing tab was present", not as an answer.`;

const WATCH = ['tabs.onRemoved', 'tabs.onCreated', 'tabs.onMoved', 'tabs.onActivated'];
const HYPOTHESES = '[a, c, ➕n1, d] - the closing tab held a slot, a filtered count lands short; [a, c, d, ➕n1] - it did not';

class ClosingTabTest extends TabsTest {
    onRemovedOf(tabId, fn) {
        const {promise, resolve, reject} = Promise.withResolvers();

        const handler = removedId => {
            if (removedId !== tabId) {
                return;
            }

            browser.tabs.onRemoved.removeListener(handler);
            fn().then(resolve, reject);
        };

        browser.tabs.onRemoved.addListener(handler);
        this.listeners.push({target: browser.tabs.onRemoved, handler});

        return promise;
    }

    async seen(tabId) {
        const tabs = await this.query();
        const closing = tabs.find(tab => tab.id === tabId);

        return {
            tabs,
            closing,
            text: `count:${tabs.length}, ${this.known(tabId)} ${closing ? `present at index ${closing.index}` : 'gone'}`,
        };
    }

    async untilGone(tabId) {
        const started = this.ms();
        let samples = 0;

        while (this.ms() - started < SETTLE_TIMEOUT) {
            if (!(await this.seen(tabId)).closing) {
                this.record('tabs.query', `${this.known(tabId)} gone after ${samples} more sample(s), ${this.ms() - started} ms after onRemoved`);
                return;
            }

            samples++;
            await wait(TIGHT_POLL_WAIT);
        }

        this.record('tabs.query', `${this.known(tabId)} still present when the sampling gave up`);
    }

    async createAgainst(name, closingId, {withClosing}) {
        const before = await this.seen(closingId);

        this.record('tabs.query', before.text);

        const index = withClosing ? before.tabs.length : before.tabs.filter(tab => tab.id !== closingId).length;

        this.record('tabs.create', `index:${index} (count ${withClosing ? 'WITH' : 'WITHOUT'} the closing tab)`);

        const tab = await this.create(name, {index});
        const after = await this.seen(closingId);

        this.record('tabs.create resolved', `${name} at index ${tab.index}; ${after.text}`);
    }

    async removeAndCreate(closingName, name, {withClosing, from}) {
        const closingId = this.id(closingName);

        if (from === 'onRemoved') {
            const done = this.onRemovedOf(closingId, () => this.createAgainst(name, closingId, {withClosing}));

            await browser.tabs.remove(closingId);
            await done;
            return;
        }

        await browser.tabs.remove(closingId);
        this.record('tabs.remove resolved', '');
        await this.createAgainst(name, closingId, {withClosing});
    }

    async userClosesAndCreate(closingName, name, gesture) {
        const closingId = this.id(closingName);

        const done = this.onRemovedOf(closingId, async () => {
            const first = await this.seen(closingId);

            this.expect(`${closingName} is still in tabs.query inside onRemoved after the user's close (REMOVE-TABS-BEHAVIOR.md §4)`, first.closing !== undefined, true);

            await this.createAgainst(name, closingId, {withClosing: false});
            await this.untilGone(closingId);
        });

        this.act(`USER: ${gesture}`);
        await this.ask(`${gesture}. Then T.visualAnswer("done")`);
        await done;
        await this.settled();
        await this.snap('after');
        this.note(HYPOTHESES);
    }
}

export const testClass = ClosingTabTest;

export const tests = [

{
    id: 'R23.01',
    title: 'tabs.remove of a middle tab: is it still in tabs.query inside onRemoved, at the resolve of tabs.remove, and for how long after',
    async run(t) {
        await t.scene(['a', 'b', 'c', 'd']);

        t.watch(WATCH);
        await t.snap('before');

        await t.step('tabs.remove(b)  // sampled from onRemoved until gone', async () => {
            const bId = t.id('b');

            const done = t.onRemovedOf(bId, async () => {
                const first = await t.seen(bId);

                t.record('onRemoved+query', first.text);
                t.expect('b is out of tabs.query inside onRemoved (REMOVE-TABS-BEHAVIOR.md §3)', first.closing === undefined, true);

                await t.untilGone(bId);
            });

            await browser.tabs.remove(bId);

            const atResolve = await t.seen(bId);

            t.record('tabs.remove resolved', atResolve.text);
            t.expect('b is out of tabs.query at the resolve of tabs.remove (§3)', atResolve.closing === undefined, true);

            await done;
        });

        t.expectRow('after', ['a*', 'c', 'd']);
    },
},

{
    id: 'R23.02',
    title: 'create from inside onRemoved at the count WITH the closing tab: the control, both hypotheses put the new tab last',
    async run(t) {
        await t.scene(['a', 'b', 'c', 'd']);

        t.watch(WATCH);
        await t.snap('before');

        await t.step('tabs.remove(b); in onRemoved: tabs.create(n1, {index: count WITH b})', () => t.removeAndCreate('b', 'n1', {withClosing: true, from: 'onRemoved'}));

        t.expectRow('after', ['a*', 'c', 'd', '➕n1']);
    },
},

{
    id: 'R23.03',
    title: 'create from inside onRemoved at the count WITHOUT the closing tab: does the closing tab still hold a slot',
    async run(t) {
        await t.scene(['a', 'b', 'c', 'd']);

        t.watch(WATCH);
        await t.snap('before');

        await t.step('tabs.remove(b); in onRemoved: tabs.create(n1, {index: count WITHOUT b})', () => t.removeAndCreate('b', 'n1', {withClosing: false, from: 'onRemoved'}));

        t.expectRow('after', ['a*', 'c', 'd', '➕n1']);
        t.note(HYPOTHESES);
    },
},

{
    id: 'R23.04',
    title: 'the ACTIVE tab removed, create from inside onRemoved at the count WITHOUT it',
    async run(t) {
        await t.scene(['a', 'b', 'c', 'd']);
        await t.activate('b');

        t.watch(WATCH);
        await t.snap('before');

        await t.step('tabs.remove(b*); in onRemoved: tabs.create(n1, {index: count WITHOUT b})', () => t.removeAndCreate('b', 'n1', {withClosing: false, from: 'onRemoved'}));

        t.expectRow('after', ['a', 'c*', 'd', '➕n1']);
        t.note(HYPOTHESES);
    },
},

{
    id: 'R23.05',
    title: 'the addon shape: tabs.remove awaited, then tabs.query and a create at the count WITHOUT the removed tab',
    async run(t) {
        await t.scene(['a', 'b', 'c', 'd']);

        t.watch(WATCH);
        await t.snap('before');

        await t.step('await tabs.remove(b); tabs.create(n1, {index: count WITHOUT b})', () => t.removeAndCreate('b', 'n1', {withClosing: false, from: 'resolved'}));

        t.expectRow('after', ['a*', 'c', 'd', '➕n1']);
        t.note(HYPOTHESES);
    },
},

{
    id: 'R23.06',
    title: 'MANUAL: the user closes an INACTIVE tab with its close button - is it still in tabs.query inside onRemoved, and where does a create at the count WITHOUT it land',
    async run(t) {
        await t.scene(['a', 'b', 'c', 'd']);

        t.watch(WATCH);
        await t.snap('before');

        await t.userClosesAndCreate('b', 'n1', 'Hover tab b (the second tab, NOT the active one) and click its close button');
        t.expectRow('after', ['a*', 'c', '➕n1', 'd']);
    },
},

{
    id: 'R23.07',
    title: 'MANUAL: the user closes the ACTIVE tab with Ctrl+W - is it still in tabs.query inside onRemoved, and where does a create at the count WITHOUT it land',
    async run(t) {
        await t.scene(['a', 'b', 'c', 'd']);
        await t.activate('b');

        t.watch(WATCH);
        await t.snap('before');

        await t.userClosesAndCreate('b', 'n1', 'Click into the scene window so tab b (the active one) has focus and press Ctrl+W');
        t.expectRow('after', ['a', 'c*', '➕n1', 'd']);
    },
},

];
