import {LOAD_WAIT, NETWORK_URL, POLL_WAIT, SETTLE_TIMEOUT} from '../constants.js';
import {wait} from '../test.js';
import {TabsTest, nameFromUrl, openedWindows, sceneUrl, withContainer} from '../tabs.js';

export const note = `Round 36 - containers seen from the tabs API. What contextualIdentities.remove does to the open
tabs of the container - a plain, a hidden and a pinned one: do they survive, what cookieStoreId they
report, what the cookies API still answers for the removed store, whether a tab can still be created
in it, and whether a surviving tab still navigates (R36.01). Whether a window of type popup can hold
a tab in a container, by the three ways such a window is made: windows.create with a cookieStoreId
and type popup, window.open with window features from a page that lives in the container, and
windows.create with the tabId of a container tab - and which of those tabs
tabs.query({windowType: 'normal'}) and tabs.query({}) return (R36.02). The facts behind STG's cleanup
of temporary containers: the list of tabs it is handed must name every container a tab still uses.
The expectations are the facts of BEHAVIOR-CREATE-TABS.md 60 and 61.
Needs the cookies and contextualIdentities permissions, creates and removes its own container;
R36.01 loads ${NETWORK_URL}. R36.02 calls window.open from a page of the add-on without a user
gesture: when the browser blocks it, the test stops and asks to allow the pop-up in the bar, as
R21.03 needed.`;

const LINK_URL = browser.runtime.getURL('link.html');
const COOKIE = {name: 'stg-test', value: 'container'};
const POPUP_FEATURES = 'popup,width=400,height=300';
const WINDOW_TYPES = ['normal', 'popup', 'panel'];

class ContainersTest extends TabsTest {
    eventFormatters() {
        return {
            ...super.eventFormatters(),
            'contextualIdentities.': ([{contextualIdentity}]) => `${contextualIdentity.name}  ${contextualIdentity.cookieStoreId}`,
            'windows.onCreated': ([win]) => `type:${win.type}`,
        };
    }
}

export const testClass = ContainersTest;

const outcome = promise => promise.then(value => ({value}), error => ({error: error.message}));
const verdict = ({error}) => error ? 'rejected' : 'resolved';
const container = (tab, cookieStoreId, label = 'the container') => tab.cookieStoreId === cookieStoreId ? label : tab.cookieStoreId;
const cookiesCount = ({value, error}) => error ? `rejected - ${error}` : value.length;

async function createInContainer(t, name, cookieStoreId, properties = {}) {
    const tab = await browser.tabs.create({windowId: t.win, url: t.tabUrl(name), active: false, cookieStoreId, ...properties});

    t.bind(tab.id, name);
    t.expected.set(tab.id, name);

    return tab;
}

async function storeState(cookieStoreId) {
    const store = (await browser.cookies.getAllCookieStores()).find(store => store.id === cookieStoreId);

    return store ? {listed: true, tabs: store.tabIds.length} : {listed: false};
}

const describeStore = ({listed, tabs}) => listed ? `listed by getAllCookieStores with ${tabs} tab(s)` : 'not listed by getAllCookieStores';

// a window the step made: its type, and the container of its named tab once the tab has loaded
async function inspectWindow(t, windowId, name, cookieStoreId) {
    openedWindows.add(windowId);
    t.trackWindow(windowId);

    const win = await browser.windows.get(windowId).catch(() => null);
    const tabs = await t.waitWindowLoaded(windowId, [name]);
    const tab = tabs?.find(tab => nameFromUrl(tab.url) === name);

    if (tab) {
        t.bind(tab.id, name);
    }

    return {type: win?.type ?? '(gone)', tab: tab ? 'there' : 'missing', container: tab ? container(tab, cookieStoreId) : '-'};
}

const describeWay = way => typeof way === 'string' ? way : `a window of type ${way.type}, the tab is ${way.tab}, container ${way.container}`;

// where the page's window.open put the tab: a window that was not there before, or the scene window
async function findOpened(t, windowsBefore, name) {
    const started = Date.now();

    while (Date.now() - started < SETTLE_TIMEOUT) {
        const fresh = (await browser.windows.getAll({windowTypes: WINDOW_TYPES})).find(win => !windowsBefore.has(win.id));

        if (fresh) {
            return {windowId: fresh.id};
        }

        const tab = (await browser.tabs.query({windowId: t.win})).find(tab => nameFromUrl(tab.url) === name);

        if (tab) {
            return {tab};
        }

        await wait(POLL_WAIT);
    }

    return null;
}

export const tests = [

{
    id: 'R36.01',
    title: 'contextualIdentities.remove of a container with open tabs - a plain, a hidden and a pinned one: do the tabs survive and what they report, what the cookies API answers for the removed store, can a tab still be created in it, does a surviving tab still navigate',
    async run(t) {
        await t.scene(['x']);

        await withContainer(t, async cookieStoreId => {
            await createInContainer(t, 'plain', cookieStoreId);
            await createInContainer(t, 'hid', cookieStoreId);
            await createInContainer(t, 'pinned', cookieStoreId, {pinned: true});
            await t.settled();

            const hidden = await t.hide(['hid']);
            t.require('hid is hidden', hidden.length === 1, `tabs.hide returned ${hidden.length} id(s)`);

            const containers = await Promise.all(['plain', 'hid', 'pinned'].map(name => browser.tabs.get(t.id(name)).then(tab => tab.cookieStoreId)));
            t.require('plain, hid and pinned live in the container', containers.every(id => id === cookieStoreId), containers.join(', '));

            await browser.cookies.set({url: NETWORK_URL, ...COOKIE, storeId: cookieStoreId});

            const before = {cookies: cookiesCount(await outcome(browser.cookies.getAll({storeId: cookieStoreId}))), store: await storeState(cookieStoreId)};
            t.note(`before: cookies.getAll({storeId}) returns ${before.cookies} cookie(s); the store is ${describeStore(before.store)}`);

            t.watch(['tabs.onCreated', 'tabs.onRemoved', 'tabs.onUpdated', 'tabs.onActivated', 'contextualIdentities.onRemoved']);
            await t.snap('before');

            const removed = await t.step('contextualIdentities.remove(container)  // plain, hid(h) and pinned(p) are open in it', () => outcome(browser.contextualIdentities.remove(cookieStoreId)));
            const eventsOfRemoval = t.queued.map(({spec}) => spec);

            t.note(`contextualIdentities.remove: ${removed.error ? `rejected - ${removed.error}` : 'resolved'}`);

            const survivors = {};

            for (const name of ['plain', 'hid', 'pinned']) {
                const tab = await browser.tabs.get(t.id(name)).catch(() => null);

                survivors[name] = tab
                    ? {container: container(tab, cookieStoreId, 'the removed container'), hidden: tab.hidden, pinned: tab.pinned, discarded: tab.discarded, status: tab.status}
                    : 'gone';

                t.note(`${name}: ${tab ? `alive, container ${survivors[name].container}, hidden ${tab.hidden}, pinned ${tab.pinned}, discarded ${tab.discarded}, status ${tab.status}` : 'gone'}`);
            }

            const get = await outcome(browser.contextualIdentities.get(cookieStoreId));
            t.note(`contextualIdentities.get(container): ${get.error ? `rejected - ${get.error}` : 'resolved, the container still exists'}`);

            const after = {cookies: cookiesCount(await outcome(browser.cookies.getAll({storeId: cookieStoreId}))), store: await storeState(cookieStoreId)};
            t.note(`after: cookies.getAll({storeId}) returns ${after.cookies} cookie(s); the store is ${describeStore(after.store)}`);

            const byStore = await outcome(browser.tabs.query({cookieStoreId}));
            t.note(`tabs.query({cookieStoreId: container}): ${byStore.error ? `rejected - ${byStore.error}` : `${byStore.value.length} tab(s): ${byStore.value.map(tab => t.nameOf(tab)).join(', ') || '-'}`}`);

            const created = await t.step('tabs.create({url: new, cookieStoreId: the removed container})', async () => {
                const result = await outcome(browser.tabs.create({windowId: t.win, url: t.tabUrl('new'), active: false, cookieStoreId}));

                if (result.value) {
                    t.bind(result.value.id, 'new');
                    t.createdByAction.add(result.value.id);
                }

                return result;
            }, {snap: 'created'});

            t.note(`tabs.create in the removed container: ${created.error ? `rejected - ${created.error}` : `resolved, the tab reports container ${container(created.value, cookieStoreId, 'the removed container')}`}`);

            let navigation = 'plain is gone, nothing to navigate';

            if (await browser.tabs.get(t.id('plain')).catch(() => null)) {
                const to = sceneUrl('plain', NETWORK_URL);
                const navigated = await t.step(`tabs.update(plain, {url: ${NETWORK_URL}?tab=plain})`, () => outcome(browser.tabs.update(t.id('plain'), {url: to})), {wait: 0, snap: false});
                const settled = await t.settled({until: state => state.tabs.some(tab => tab.id === t.id('plain') && tab.url === to && tab.status === 'complete')});

                t.data.rows.findLast(row => row.kind === 'action').timing = `settled ${settled.ms} ms`;
                await t.snap('navigated');

                const plain = await browser.tabs.get(t.id('plain')).catch(() => null);

                navigation = navigated.error
                    ? `tabs.update rejected - ${navigated.error}`
                    : plain ? {url: plain.url === to ? 'the url' : plain.url, status: plain.status, container: container(plain, cookieStoreId, 'the removed container')} : 'gone';
            }

            t.note(`plain after the navigation: ${typeof navigation === 'string' ? navigation : `url ${navigation.url}, status ${navigation.status}, container ${navigation.container}`}`);

            t.expect('the removal resolves and fires contextualIdentities.onRemoved alone, no tab event (BEHAVIOR-CREATE-TABS.md §60)', {removed: verdict(removed), events: eventsOfRemoval}, {removed: 'resolved', events: ['contextualIdentities.onRemoved']});
            t.expectRow('after', ['pinned(p)', 'x*', 'plain', 'hid(h)']);
            t.expect('the tabs survive unchanged under the removed cookieStoreId (§60)', survivors, {
                plain: {container: 'the removed container', hidden: false, pinned: false, discarded: false, status: 'complete'},
                hid: {container: 'the removed container', hidden: true, pinned: false, discarded: false, status: 'complete'},
                pinned: {container: 'the removed container', hidden: false, pinned: true, discarded: false, status: 'complete'},
            });
            t.expect('the cookies of the container are wiped, its store stays listed with the tabs (§60)', {before, after}, {
                before: {cookies: 1, store: {listed: true, tabs: 3}},
                after: {cookies: 0, store: {listed: true, tabs: 3}},
            });
            t.expect('contextualIdentities.get of the removed id rejects, tabs.query by it still returns the three, tabs.create into it rejects (§60)', {get: verdict(get), query: byStore.error ? 'rejected' : byStore.value.length, create: verdict(created)}, {get: 'rejected', query: 3, create: 'rejected'});
            t.expect('a surviving tab navigates under the removed cookieStoreId (§60)', navigation, {url: 'the url', status: 'complete', container: 'the removed container'});
        });
    },
},

{
    id: 'R36.02',
    title: 'a window of type popup and a container - windows.create with a cookieStoreId and type popup, window.open with window features from a page in the container, windows.create with the tabId of a container tab; which of those tabs tabs.query({windowType: normal}) and tabs.query({}) return',
    async run(t) {
        await t.scene(['x']);

        await withContainer(t, async cookieStoreId => {
            const popups = new Map();
            const ways = {};

            t.watch(['windows.onCreated', 'tabs.onDetached']);
            await t.snap('before');

            {
                const made = await t.step('windows.create({url: popA, type: popup, cookieStoreId: container})', () => outcome(browser.windows.create({url: t.tabUrl('popA'), type: 'popup', cookieStoreId})), {snap: false});

                if (made.value) {
                    popups.set('A: popA', made.value.id);
                }

                ways.A = made.error ? `rejected - ${made.error}` : await inspectWindow(t, made.value.id, 'popA', cookieStoreId);
                t.note(`A: windows.create ${made.error ? ways.A : `resolved, ${describeWay(ways.A)}`}`);
            }

            {
                const to = t.tabUrl('popB');
                const page = await browser.tabs.create({windowId: t.win, url: `${LINK_URL}?tab=page&to=${encodeURIComponent(to)}`, active: true, cookieStoreId});

                t.bind(page.id, 'page');
                t.expected.set(page.id, 'page');
                await t.settled();
                await wait(LOAD_WAIT);

                const windowsBefore = new Set((await browser.windows.getAll({windowTypes: WINDOW_TYPES})).map(win => win.id));
                const opened = await t.step(`tabs.sendMessage(page, {action: open, to: popB, features: ${POPUP_FEATURES}})  // the page lives in the container and calls window.open with window features`, () => outcome(browser.tabs.sendMessage(page.id, {action: 'open', to, features: POPUP_FEATURES})), {wait: 0, snap: false});

                t.note(`B: window.open ${opened.error ? `sendMessage rejected - ${opened.error}` : `returned ${opened.value?.opened ? 'a window' : 'null (blocked)'}`}`);

                if (!opened.error && !opened.value?.opened) {
                    await t.ask('The active tab of the scene window shows the pop-up blocked bar: allow pop-ups for this page, or pick "Show" in the menu of the bar, so the browser opens the blocked window; then T.visualAnswer("done")');
                }

                const found = await findOpened(t, windowsBefore, 'popB');

                if (!found) {
                    ways.B = 'popB appeared neither in a new window nor in the scene window';
                } else if (found.tab) {
                    t.bind(found.tab.id, 'popB');
                    ways.B = {type: 'the scene window', tab: 'there', container: container(found.tab, cookieStoreId)};
                } else {
                    popups.set('B: popB', found.windowId);
                    ways.B = await inspectWindow(t, found.windowId, 'popB', cookieStoreId);
                }

                t.note(`B: ${typeof ways.B === 'string' ? ways.B : `popB opened in ${describeWay(ways.B)}`}`);
            }

            {
                const c = await createInContainer(t, 'c', cookieStoreId);

                await t.settled();

                const made = await t.step('windows.create({tabId: c, type: popup})  // c is a container tab of the scene window', () => outcome(browser.windows.create({tabId: c.id, type: 'popup'})), {snap: 'after C'});

                if (made.value) {
                    popups.set('C: c', made.value.id);
                }

                ways.C = made.error ? `rejected - ${made.error}` : await inspectWindow(t, made.value.id, 'c', cookieStoreId);
                t.note(`C: windows.create ${made.error ? ways.C : `resolved, ${describeWay(ways.C)}`}`);
            }

            const names = ['popA', 'popB', 'c'];
            const found = tabs => tabs.map(tab => nameFromUrl(tab.url)).filter(name => names.includes(name));
            const ours = windows => windows.filter(win => openedWindows.has(win.id)).length;
            const reads = {
                normal: found(await browser.tabs.query({windowType: 'normal'})),
                all: found(await browser.tabs.query({})).toSorted(),
                windowsNormal: ours(await browser.windows.getAll({windowTypes: ['normal']})),
                windowsAll: ours(await browser.windows.getAll()),
            };

            t.note(`tabs.query({windowType: 'normal'}) returns of ${names.join('/')}: ${reads.normal.join(', ') || '(none)'}; tabs.query({}) returns: ${reads.all.join(', ') || '(none)'}`);
            t.note(`windows of the stand: ${reads.windowsNormal} in windows.getAll({windowTypes: ['normal']}), ${reads.windowsAll} in windows.getAll()`);

            await t.snap('after (scene window)');

            for (const [label, windowId] of popups) {
                await t.snapWindow(`after (${label})`, windowId);
            }

            const popup = {type: 'popup', tab: 'there', container: 'the container'};

            t.expect('every way gives a popup window whose tab reports the container (BEHAVIOR-CREATE-TABS.md §61)', ways, {A: popup, B: popup, C: popup});
            t.expect('the normal-window filters leave the popup windows out, the unfiltered reads include them (§61)', reads, {normal: [], all: names.toSorted(), windowsNormal: 1, windowsAll: 4});
            t.expectRow('after C', ['x', 'page*']);
            t.expectRow('after (A: popA)', ['popA*']);
            t.expectRow('after (B: popB)', ['popB*']);
            t.expectRow('after (C: c)', ['c*']);
        });
    },
},

];
