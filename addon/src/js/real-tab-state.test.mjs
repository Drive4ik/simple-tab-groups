/**
 * Standalone node test for `Cache.getRealTabStateChanged` — the "did anything we care
 * about actually change?" guard behind `Tabs.onUpdated`'s early return.
 *
 * Plain `node real-tab-state.test.mjs` (STG has no test runner). The contract lives inside
 * the browser-impure `cache.js`, so the REAL module is loaded and only its browser-bound
 * imports are stubbed via `real-tab-state.test.loader.mjs` (registered below).
 * `constants.js` stays real, so the last assertion pins the invariant that every property
 * in `ON_UPDATED_TAB_PROPERTIES` is also remembered by `setLastTabState`.
 *
 * The bug: `setLastTabState` remembered seven properties while the comparison walked
 * eight, so `discarded` and `audible` compared a live boolean against `undefined` and
 * always reported a change. `getRealTabStateChanged` therefore never returned `null` for a
 * known tab, the `onUpdated` early return was dead code, and every recomputed `changeInfo`
 * carried a phantom `discarded`/`audible` key.
 */

import {register} from 'node:module';

globalThis.location = {pathname: '/background.html'};
globalThis.self = globalThis;
globalThis.fetch = async () => ({text: async () => '<svg></svg>'});

globalThis.browser = {
    runtime: {
        getManifest: () => ({version: '5.5.1'}),
        getURL: path => `moz-extension://stg/${path}`,
        getBrowserInfo: async () => ({name: 'Firefox', vendor: 'Mozilla', version: '140.0'}),
        getPlatformInfo: async () => ({os: 'linux'}),
        PlatformOs: {WIN: 'win', MAC: 'mac'},
    },
    storage: {sync: {}},
    i18n: {getMessage: key => key},
    tabs: {
        TabStatus: {LOADING: 'loading', COMPLETE: 'complete'},
        UpdatePropertyName: {
            TITLE: 'title',
            STATUS: 'status',
            URL: 'url',
            FAVICONURL: 'favIconUrl',
            HIDDEN: 'hidden',
            PINNED: 'pinned',
            DISCARDED: 'discarded',
            AUDIBLE: 'audible',
        },
    },
};

register(new URL('./real-tab-state.test.loader.mjs', import.meta.url));

let passed = 0;
const failures = [];

function check(name, cond, detail) {
    if (cond) {
        passed++;
        console.log(`  PASS  ${name}`);
    } else {
        failures.push(name);
        console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

const {tabs, setTab, removeTab, getRealTabStateChanged, clear} = await import('./cache.js');
const {ON_UPDATED_TAB_PROPERTIES} = await import('./constants.js');
const {planTabContentApply, buildTabContentCacheWrite, REFUSED_DISCARDED} = await import('./sync/delta/tab-content-apply.js');
const {recordPendingNav, getPendingNav, planPendingNavOnTabUpdate} = await import('./sync/delta/pending-nav.js');

const TAB_ID = 42;

const baseTab = extra => ({
    id: TAB_ID,
    url: 'https://a.test/',
    title: 'A',
    status: 'complete',
    favIconUrl: 'https://a.test/icon.png',
    hidden: false,
    pinned: false,
    discarded: false,
    audible: false,
    cookieStoreId: 'firefox-default',
    ...extra,
});

function seen(extra) {
    clear();
    setTab(baseTab(extra));
}

const json = value => JSON.stringify(value);

// --- 1. first sighting of an unknown tab -----------------------------------------------
{
    clear();

    check('an unknown tab reports no change (nothing remembered to compare against)',
        getRealTabStateChanged(baseTab()) === null);
}

// --- 2. the guard is live: an unchanged known tab reports null --------------------------
{
    seen();

    check('a known tab whose state did not move reports null',
        getRealTabStateChanged(baseTab()) === null,
        json(getRealTabStateChanged(baseTab())));
}

// --- 3. a real content change reports only that key -------------------------------------
{
    seen();
    const changeInfo = getRealTabStateChanged(baseTab({url: 'https://b.test/'}));

    check('a url change reports only `url`',
        json(changeInfo) === json({url: 'https://b.test/'}),
        json(changeInfo));
}

{
    seen();
    const changeInfo = getRealTabStateChanged(baseTab({title: 'B'}));

    check('a title change reports only `title`',
        json(changeInfo) === json({title: 'B'}),
        json(changeInfo));
}

{
    seen();
    const changeInfo = getRealTabStateChanged(baseTab({status: 'loading'}));

    check('a status change reports only `status`',
        json(changeInfo) === json({status: 'loading'}),
        json(changeInfo));
}

// --- 4. discard and wake ---------------------------------------------------------------
{
    seen();
    const changeInfo = getRealTabStateChanged(baseTab({discarded: true}));

    check('a real discard reports only `discarded: true`',
        json(changeInfo) === json({discarded: true}),
        json(changeInfo));
}

{
    seen({discarded: true});
    const changeInfo = getRealTabStateChanged(baseTab({discarded: false}));

    check('a real wake reports only `discarded: false`',
        json(changeInfo) === json({discarded: false}),
        json(changeInfo));
}

{
    seen({discarded: true});

    check('a tab that stays discarded reports null',
        getRealTabStateChanged(baseTab({discarded: true})) === null,
        json(getRealTabStateChanged(baseTab({discarded: true}))));
}

// --- 5. audible ------------------------------------------------------------------------
{
    seen();
    const changeInfo = getRealTabStateChanged(baseTab({audible: true}));

    check('a tab starting to play sound reports only `audible: true`',
        json(changeInfo) === json({audible: true}),
        json(changeInfo));
}

{
    seen({audible: true});

    check('a tab that keeps playing sound reports null',
        getRealTabStateChanged(baseTab({audible: true})) === null,
        json(getRealTabStateChanged(baseTab({audible: true}))));
}

// --- 6. hidden, pinned, favIconUrl ------------------------------------------------------
{
    seen();
    const changeInfo = getRealTabStateChanged(baseTab({hidden: true}));

    check('a hide reports only `hidden`',
        json(changeInfo) === json({hidden: true}),
        json(changeInfo));
}

{
    seen();
    const changeInfo = getRealTabStateChanged(baseTab({pinned: true}));

    check('a pin reports only `pinned`',
        json(changeInfo) === json({pinned: true}),
        json(changeInfo));
}

{
    seen();
    const changeInfo = getRealTabStateChanged(baseTab({favIconUrl: 'https://b.test/icon.png'}));

    check('a favIcon change reports only `favIconUrl`',
        json(changeInfo) === json({favIconUrl: 'https://b.test/icon.png'}),
        json(changeInfo));
}

// --- 7. several real changes at once ----------------------------------------------------
{
    seen();
    const changeInfo = getRealTabStateChanged(baseTab({url: 'https://b.test/', status: 'loading', discarded: true}));

    check('simultaneous changes report exactly the keys that moved',
        json(changeInfo) === json({status: 'loading', url: 'https://b.test/', discarded: true}),
        json(changeInfo));
}

// --- 8. a forgotten tab is unknown again -------------------------------------------------
{
    seen();
    removeTab(TAB_ID);

    check('a removed tab is unknown again',
        getRealTabStateChanged(baseTab({url: 'https://b.test/'})) === null);
}

// --- 9. the invariant: everything compared is also remembered -----------------------------
{
    const FLIPPED = {
        title: 'Z',
        status: 'loading',
        url: 'https://z.test/',
        favIconUrl: 'https://z.test/icon.png',
        hidden: true,
        pinned: true,
        discarded: true,
        audible: true,
    };

    check('the flip table covers every compared property',
        ON_UPDATED_TAB_PROPERTIES.every(key => Object.hasOwn(FLIPPED, key)),
        json(ON_UPDATED_TAB_PROPERTIES.filter(key => !Object.hasOwn(FLIPPED, key))));

    for (const key of ON_UPDATED_TAB_PROPERTIES) {
        seen();
        const changeInfo = getRealTabStateChanged(baseTab({[key]: FLIPPED[key]}));

        check(`moving \`${key}\` reports that key alone — nothing else is a phantom`,
            json(changeInfo) === json({[key]: FLIPPED[key]}),
            json(changeInfo));
    }
}

// --- 10. the sync-apply write must not report state it never observed ---------------------
const applyWrite = (live, target) => buildTabContentCacheWrite(live, planTabContentApply(live, target), target);

{
    const write = applyWrite(baseTab(), {url: 'https://b.test/'});
    const absent = ON_UPDATED_TAB_PROPERTIES.filter(key => !Object.hasOwn(write, key));

    check('the apply write carries every property the guard compares',
        absent.length === 0,
        json(absent));
}

{
    seen();
    setTab(applyWrite(baseTab(), {url: 'https://b.test/'}));
    const changeInfo = getRealTabStateChanged(baseTab({url: 'https://b.test/'}));

    check('a settled applied navigation reports no phantom pinned/hidden/discarded/audible',
        changeInfo === null,
        json(changeInfo));
}

{
    const hiddenTab = extra => baseTab({hidden: true, ...extra});

    seen({hidden: true});
    setTab(applyWrite(hiddenTab(), {url: 'https://b.test/'}));
    const changeInfo = getRealTabStateChanged(hiddenTab({url: 'https://b.test/'}));

    check('a hidden tab keeps its group: the applied navigation reports no phantom `hidden`',
        changeInfo === null,
        json(changeInfo));
}

{
    seen();
    setTab(applyWrite(baseTab(), {favIconUrl: 'https://b.test/icon.png'}));
    const changeInfo = getRealTabStateChanged(baseTab({favIconUrl: 'https://b.test/icon.png', audible: true}));

    check('a favIcon-only apply leaves nothing behind: a later sound reports only `audible`',
        json(changeInfo) === json({audible: true}),
        json(changeInfo));
}

{
    seen();
    setTab(applyWrite(baseTab(), {url: 'https://b.test/'}));
    const changeInfo = getRealTabStateChanged(baseTab({url: 'https://b.test/', pinned: true}));

    check('a genuine pin after an applied navigation still reports `pinned: true`',
        json(changeInfo) === json({pinned: true}),
        json(changeInfo));
}

{
    seen({pinned: true});
    setTab(applyWrite(baseTab({pinned: true}), {url: 'https://b.test/'}));
    const changeInfo = getRealTabStateChanged(baseTab({url: 'https://b.test/', pinned: false}));

    check('a genuine unpin after an applied navigation still reports `pinned: false`',
        json(changeInfo) === json({pinned: false}),
        json(changeInfo));
}

{
    seen({discarded: true});
    setTab(applyWrite(baseTab({discarded: true}), {url: 'https://b.test/', title: 'B'}));
    const changeInfo = getRealTabStateChanged(baseTab({discarded: false}));

    check('a refused apply on a discarded tab reports only `discarded` when the tab wakes',
        json(changeInfo) === json({discarded: false}),
        json(changeInfo));
}

{
    seen();
    setTab({...baseTab(), openerTabId: 7});
    setTab(applyWrite({...baseTab(), openerTabId: 7}, {url: 'https://b.test/'}));

    check('the apply write keeps the cached openerTabId',
        tabs[TAB_ID].openerTabId === 7,
        json(tabs[TAB_ID].openerTabId));
}

// --- 11. a title-only peer target must never become a pushed tab.modify -------------------
// A tab's title belongs to its page — Firefox has no API to set it. `Tabs.onUpdated` decides
// whether to append a `DeltaCapture.tabModified` from `changeInfo` carrying `title` or `url`, so
// the whole question is what the wake leaves armed in `lastTabsState`.
const contentChangedOf = changeInfo =>
    !!changeInfo && (Object.hasOwn(changeInfo, 'title') || Object.hasOwn(changeInfo, 'url'));

const PEER_TITLE = 'A title only the peer\'s page ever produced';

{
    const store = {};
    const sleeping = baseTab({discarded: true});
    const target = {title: PEER_TITLE};

    seen({discarded: true});

    const plan = planTabContentApply(sleeping, target);
    setTab(buildTabContentCacheWrite(sleeping, plan, target));
    recordPendingNav(store, 'uid-1', sleeping, target, Date.now());

    check('the apply refuses the title-only target and defers nothing for the wake',
        plan.refusal === REFUSED_DISCARDED && getPendingNav(store, 'uid-1') === null,
        json({plan, store}));

    const woken = baseTab({discarded: false});
    setTab(woken);

    const wake = planPendingNavOnTabUpdate(getPendingNav(store, 'uid-1'), woken, {woke: true, now: Date.now()});
    check('the wake has nothing to deliver, so nothing is written into the cache',
        wake.clear === false && wake.navigate === false, json(wake));

    const nextEvent = getRealTabStateChanged(baseTab({discarded: false, audible: true}));
    check('the next event after the wake reports only `audible` — the peer title armed nothing',
        json(nextEvent) === json({audible: true}), json(nextEvent));
    check('no content change ⇒ Tabs.onUpdated appends no tab.modify for the peer title',
        contentChangedOf(nextEvent) === false, json(nextEvent));
}

{
    seen({discarded: true});
    setTab(baseTab({discarded: false}));
    setTab({...baseTab({discarded: false}), title: PEER_TITLE});

    const nextEvent = getRealTabStateChanged(baseTab({discarded: false, audible: true}));
    check('contrast: delivering the peer title on wake makes the next event revert and push it',
        contentChangedOf(nextEvent) === true && nextEvent.title === 'A', json(nextEvent));
}

console.log(`\npassed: ${passed}, failed: ${failures.length}`);

if (failures.length) {
    process.exit(1);
}
