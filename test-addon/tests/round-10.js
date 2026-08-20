import {TAB_GROUP_ID_NONE, LOAD_WAIT, NETWORK_URL} from '../constants.js';
import {wait} from '../test.js';
import {TabsTest, sceneUrl} from '../tabs.js';

export const note = `Round 10 — API pinning, the facts behind pin-and-detach of tabs that cannot be hidden.
(A) tabs.update({pinned: true}) on a native-group member: membership, events, session values, where unpin returns the tab — recorded as TABGROUPS-BEHAVIOR.md §19;
(B) the same on the ACTIVE and ONLY member — the group dies, the tab stays active (§19);
(C) MANUAL: tabs.hide silently skips a tab with a LIVE microphone, tabs.update({pinned: true}) pins it
normally with the microphone staying live (§19) — the microphone is requested by an injected script
on NETWORK_URL (extension pages get the microphone without it ever reaching tab.sharingState), so
the run needs only the permission grant.`;

const WATCH = [
    'tabs.onMoved', 'tabs.onUpdated', 'tabs.onActivated',
    'tabGroups.onCreated', 'tabGroups.onUpdated', 'tabGroups.onRemoved',
];
const UPDATED_KEYS = ['pinned', 'groupId', 'hidden'];

class PinTest extends TabsTest {
    cell(tab) {
        return super.cell(tab) + (tab.pinned ? '(p)' : '');
    }
}

export const testClass = PinTest;

export const tests = [

{
    id: 'R10.01',
    title: 'tabs.update({pinned: true}) on a MIDDLE member of a native group — membership, session value, unpin return',
    async run(t) {
        await t.scene(['keep1', 'gr1', 'gr2', 'gr3']);
        await t.group(['gr1', 'gr2', 'gr3'], {title: 'G'});

        await browser.sessions.setTabValue(t.id('gr2'), 'testKey', 'testValue');

        t.watch(WATCH, {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        await t.step('tabs.update(gr2, {pinned: true})', () => browser.tabs.update(t.id('gr2'), {pinned: true}));

        const pinned = await browser.tabs.get(t.id('gr2'));
        t.note(`gr2 after pin: pinned:${pinned.pinned} index:${pinned.index} group:${t.square(pinned.groupId) || pinned.groupId} hidden:${pinned.hidden}`);
        t.note(`groups left: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);

        t.expectRow('after', ['gr2(p)', 'keep1*', '🟥 gr1', '🟥 gr3']);
        t.expect('pin stripped the membership, the group survived', [pinned.groupId, (await t.groupsInfo()).length], [TAB_GROUP_ID_NONE, 1]);
        t.expect('session value survived the pin', await browser.sessions.getTabValue(t.id('gr2'), 'testKey'), 'testValue');

        await t.step('tabs.update(gr2, {pinned: false})', () => browser.tabs.update(t.id('gr2'), {pinned: false}));

        const unpinned = await browser.tabs.get(t.id('gr2'));
        t.note(`gr2 after unpin: pinned:${unpinned.pinned} index:${unpinned.index} group:${t.square(unpinned.groupId) || unpinned.groupId}`);

        t.expectRow('after 2', ['gr2', 'keep1*', '🟥 gr1', '🟥 gr3']);
        t.expect('unpin did not rejoin the group and did not move the tab', [unpinned.groupId, unpinned.index], [TAB_GROUP_ID_NONE, 0]);
        t.expect('session value survived the unpin', await browser.sessions.getTabValue(t.id('gr2'), 'testKey'), 'testValue');
    },
},

{
    id: 'R10.02',
    title: 'tabs.update({pinned: true}) on the ACTIVE and ONLY member — group death, active state',
    async run(t) {
        await t.scene(['keep1', 'gr1']);
        await t.group(['gr1'], {title: 'G'});
        await t.activate('gr1');

        t.watch(WATCH, {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        await t.step('tabs.update(gr1, {pinned: true})  — gr1 is active, the only member', () => {
            return browser.tabs.update(t.id('gr1'), {pinned: true});
        });

        const pinned = await browser.tabs.get(t.id('gr1'));
        t.note(`gr1 after pin: pinned:${pinned.pinned} index:${pinned.index} active:${pinned.active} group:${t.square(pinned.groupId) || pinned.groupId}`);
        t.note(`groups left: ${(await t.groupsInfo()).join(' | ') || '(none)'}`);

        t.expectRow('after', ['gr1*(p)', 'keep1']);
        t.expect('the group died, the pinned tab stayed active', [(await t.groupsInfo()).length, pinned.active], [0, true]);
    },
},

{
    id: 'R10.03',
    title: 'MANUAL: tabs.hide and tabs.update({pinned: true}) on a tab with a LIVE microphone',
    async run(t) {
        await t.scene(['keep1']);

        await t.create('mic1', {url: sceneUrl('mic1', NETWORK_URL), active: true});
        await wait(LOAD_WAIT);

        const grant = browser.tabs.executeScript(t.id('mic1'), {
            code: 'navigator.mediaDevices.getUserMedia({audio: true}).then(stream => { window.__micStream = stream; return "ok"; }, error => String(error));',
        });

        t.act('USER: allow the microphone prompt in tab mic1');
        await t.ask('Tab mic1 is asking for the MICROPHONE — ALLOW it. The tab must get the microphone indicator. Then T.visualAnswer("done")');

        const [granted] = await grant;
        t.note(`injected getUserMedia: ${granted}`);

        const live = await browser.tabs.get(t.id('mic1'));
        t.note(`mic1 sharingState: ${JSON.stringify(live.sharingState)}`);
        t.require('microphone is live', live.sharingState?.microphone === true, `sharingState: ${JSON.stringify(live.sharingState)}`);

        await t.activate('keep1');

        t.watch(WATCH, {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        const hideOutcome = await t.step('tabs.hide([mic1])  — microphone is live, mic1 is not active', async () => {
            try {
                return {ok: true, hidden: await browser.tabs.hide([t.id('mic1')])};
            } catch (error) {
                return {ok: false, error: String(error)};
            }
        });

        if (hideOutcome.ok) {
            t.note(`tabs.hide resolved with [${hideOutcome.hidden.map(id => t.known(id)).join(', ')}]`);

            if (hideOutcome.hidden.length) {
                await t.show(['mic1']);
                t.note('mic1 was hidden by the call — shown back');
            }
        } else {
            t.note(`tabs.hide REJECTED: ${hideOutcome.error}`);
        }

        t.expectRow('after', ['keep1*', '➕mic1']);
        t.expect('tabs.hide silently skipped the sharing tab', [hideOutcome.ok, hideOutcome.hidden ?? null], [true, []]);

        const pinOutcome = await t.step('tabs.update(mic1, {pinned: true})  — microphone is live', async () => {
            try {
                return {ok: true, tab: await browser.tabs.update(t.id('mic1'), {pinned: true})};
            } catch (error) {
                return {ok: false, error: String(error)};
            }
        });

        t.note(pinOutcome.ok ? 'tabs.update resolved' : `tabs.update REJECTED: ${pinOutcome.error}`);

        const fresh = await browser.tabs.get(t.id('mic1'));
        t.note(`mic1 after the pin attempt: pinned:${fresh.pinned} index:${fresh.index} sharingState:${JSON.stringify(fresh.sharingState)}`);

        t.expectRow('after 2', ['➕mic1(p)', 'keep1*']);
        t.expect('the sharing tab pinned normally, the microphone stayed live', [pinOutcome.ok, fresh.pinned, fresh.sharingState?.microphone], [true, true, true]);

        await t.ask('Look at the tab bar: is mic1 pinned (small leftmost tab)? Is the microphone indicator still shown? Answer what you see');
    },
},

{
    id: 'R10.04',
    title: 'tabs.create with an index INSIDE the pinned block — where an unpinned tab lands',
    async run(t) {
        await t.scene(['p1', 'p2', 'a', 'b']);
        await browser.tabs.update(t.id('p1'), {pinned: true});
        await browser.tabs.update(t.id('p2'), {pinned: true});
        await t.settled();

        const pinned = await Promise.all(t.ids(['p1', 'p2']).map(id => browser.tabs.get(id)));
        t.require(
            'setup: p1 and p2 are pinned at 0 and 1',
            pinned.every(tab => tab.pinned) && pinned.map(tab => tab.index).join(',') === '0,1',
            pinned.map(tab => `${t.nameOf(tab)}: pinned:${tab.pinned} index:${tab.index}`).join(', '),
        );

        t.watch(['tabs.onCreated', 'tabs.onMoved', 'tabs.onUpdated'], {updatedKeys: UPDATED_KEYS});
        await t.snap('before');

        const n0 = await t.step('tabs.create(n0, {index: 0})  — the slot of pinned p1', () => t.create('n0', {index: 0}));
        t.note(`n0 resolved: index:${n0.index} pinned:${n0.pinned}`);
        const fresh0 = await browser.tabs.get(n0.id);
        t.note(`n0 fresh: index:${fresh0.index} pinned:${fresh0.pinned}`);

        t.expectRow('after', ['p1*(p)', 'p2(p)', '➕n0', 'a', 'b']);

        const n1 = await t.step('tabs.create(n1, {index: 1})  — the slot of pinned p2', () => t.create('n1', {index: 1}));
        t.note(`n1 resolved: index:${n1.index} pinned:${n1.pinned}`);
        const fresh1 = await browser.tabs.get(n1.id);
        t.note(`n1 fresh: index:${fresh1.index} pinned:${fresh1.pinned}`);

        t.expectRow('after 2', ['p1*(p)', 'p2(p)', '➕n1', '➕n0', 'a', 'b']);
        t.expect('both clamp to the first unpinned slot, staying unpinned', [fresh0.index, fresh0.pinned, fresh1.index, fresh1.pinned], [2, false, 2, false]);
    },
},

];
