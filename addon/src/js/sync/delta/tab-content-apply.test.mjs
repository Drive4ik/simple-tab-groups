/**
 * Standalone node test for the PURE apply-side tab-content decision
 * (`tab-content-apply.js`).
 *
 * Plain `node tab-content-apply.test.mjs` (STG has no test runner). The module only depends on
 * the pure url classifiers, so it imports directly.
 *
 * Regression for the DISCARDED-tab apply lie: `browser.tabs.update({url})` is never issued for a
 * discarded (unloaded) tab — navigating it would wake it — yet the apply used to write the
 * incoming url/title into the cache anyway. That write is a double falsehood:
 *   - the local record claims a url the browser tab does not have, so the next `Tabs.get` reverts
 *     it and stamps `lastModified` = now (a revert recorded as a modification);
 *   - `Cache.setTab` also arms `lastTabsState`, so when the tab is eventually WOKEN and reports
 *     its own (frozen, unchanged) url, `getRealTabStateChanged` sees a difference and captures a
 *     spurious tab.modify — the local device pushes its stale value back over the peer's, which
 *     is one driver of the endless cross-device ping-pong.
 *
 * The fix REFUSES honestly: the recorded content stays whatever the live tab really has, and the
 * refusal is reported, so the peer's value legitimately keeps winning instead of oscillating.
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs); it uses node
 * globals (process, console) the browser config bans.
 */

import {
    planTabContentApply,
    REFUSED_DISCARDED,
    REFUSED_UNSYNCABLE_URL,
} from './tab-content-apply.js';

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

const stubFor = url => {
    const u = new URL('moz-extension://abc-123/help/stg-unsupported-url.html');
    u.searchParams.set('url', url);
    return u.href;
};

const liveTab = extra => ({id: 1, url: 'http://old', title: 'Old', discarded: false, ...extra});
const discardedTab = extra => liveTab({discarded: true, ...extra});

// --- LOADED tab: unchanged behaviour, the url is applied and navigated ----------------------
{
    const plan = planTabContentApply(liveTab(), {url: 'http://new', title: 'New'});
    check('loaded tab, url+title change ⇒ navigate & record the target',
        plan.navigate === true && plan.url === 'http://new' && plan.title === 'New' && plan.refusal === null,
        JSON.stringify(plan));
}
{
    const plan = planTabContentApply({id: 1, url: 'http://old', title: 'Old'}, {url: 'http://new'});
    check('missing `discarded` is treated as loaded ⇒ navigate',
        plan.navigate === true && plan.url === 'http://new' && plan.refusal === null,
        JSON.stringify(plan));
}
{
    const plan = planTabContentApply(liveTab(), {title: 'New'});
    check('loaded tab, title-only change ⇒ recorded, no navigation',
        plan.navigate === false && plan.url === 'http://old' && plan.title === 'New' && plan.refusal === null,
        JSON.stringify(plan));
}

// --- DISCARDED tab: the change is REFUSED, the live content is kept -------------------------
{
    const plan = planTabContentApply(discardedTab(), {url: 'http://new', title: 'New'});
    check('discarded tab, url change ⇒ REFUSED, live url/title kept, no navigation',
        plan.navigate === false && plan.url === 'http://old' && plan.title === 'Old'
        && plan.refusal === REFUSED_DISCARDED,
        JSON.stringify(plan));
}
{
    const plan = planTabContentApply(discardedTab(), {title: 'New'});
    check('discarded tab, title-only change ⇒ REFUSED (a frozen title cannot be set either)',
        plan.navigate === false && plan.title === 'Old' && plan.refusal === REFUSED_DISCARDED,
        JSON.stringify(plan));
}
{
    const plan = planTabContentApply(discardedTab(), {url: 'http://old', title: 'Old'});
    check('discarded tab already at the target content ⇒ nothing to refuse',
        plan.navigate === false && plan.url === 'http://old' && plan.title === 'Old' && plan.refusal === null,
        JSON.stringify(plan));
}
{
    const plan = planTabContentApply(discardedTab(), {favIconUrl: 'http://icon'});
    check('discarded tab, favIcon-only target ⇒ no content decision, no refusal',
        plan.navigate === false && plan.url === 'http://old' && plan.title === 'Old' && plan.refusal === null,
        JSON.stringify(plan));
}

// --- a target url that can never be navigated to is refused as well -------------------------
{
    const plan = planTabContentApply(liveTab(), {url: 'about:newtab', title: 'New'});
    check('loaded tab, non-syncable target url ⇒ REFUSED, live content kept',
        plan.navigate === false && plan.url === 'http://old' && plan.title === 'Old'
        && plan.refusal === REFUSED_UNSYNCABLE_URL,
        JSON.stringify(plan));
}

// --- stub-rendered tabs: the live (wrapped) url stays the record, no revert churn -----------
{
    const stub = stubFor('about:config');
    const plan = planTabContentApply(liveTab({url: stub}), {url: 'about:config'});
    check('stub-wrapped live url already matches the target ⇒ keep the live url, no navigation',
        plan.navigate === false && plan.url === stub && plan.refusal === null,
        JSON.stringify(plan));
}

// --- convergence: a loaded tab converges in one apply, a discarded one never churns ---------
{
    const first = planTabContentApply(liveTab(), {url: 'http://new'});
    const settled = liveTab({url: 'http://new'});
    const second = planTabContentApply(settled, {url: 'http://new'});
    check('loaded tab: 2nd apply of the same target is a no-op (converged)',
        first.navigate === true && second.navigate === false && second.refusal === null,
        JSON.stringify({first, second}));
}
{
    let tab = discardedTab();
    let refusals = 0;
    for (let i = 0; i < 5; i++) {
        const plan = planTabContentApply(tab, {url: 'http://new', title: 'New'});
        if (plan.refusal) {
            refusals++;
        }
        tab = {...tab, url: plan.url, title: plan.title};
    }
    check('discarded tab: repeated applies never mutate the recorded content (peer keeps winning)',
        refusals === 5 && tab.url === 'http://old' && tab.title === 'Old',
        JSON.stringify({refusals, tab}));
}

// --- the ping-pong PROOF: what `Cache.setTab` would arm in `lastTabsState` -------------------
// `Cache.setTab` stores the written url/title as the "last state the browser reported". When the
// discarded tab is later woken it reports its own frozen url, and `getRealTabStateChanged`
// compares against that armed state. Arming the never-applied target makes the wake look like a
// user navigation and pushes the stale value back to the peers.
{
    const tab = discardedTab();
    const target = {url: 'http://new', title: 'New'};

    const armedByOldApply = {url: target.url, title: target.title};
    const plan = planTabContentApply(tab, target);
    const armedByFix = {url: plan.url, title: plan.title};

    const wokenTab = {url: tab.url, title: tab.title};
    const spurious = armed => armed.url !== wokenTab.url || armed.title !== wokenTab.title;

    check('old behaviour armed a state the woken tab contradicts ⇒ spurious tab.modify',
        spurious(armedByOldApply) === true);
    check('refusing keeps the armed state equal to the woken tab ⇒ no spurious tab.modify',
        spurious(armedByFix) === false, JSON.stringify(armedByFix));
}

// --- robustness ------------------------------------------------------------------------------
{
    const plan = planTabContentApply(discardedTab(), {});
    check('empty target ⇒ live content, no refusal',
        plan.navigate === false && plan.url === 'http://old' && plan.refusal === null,
        JSON.stringify(plan));
}
{
    const plan = planTabContentApply(undefined, undefined);
    check('missing tab/target ⇒ no crash, no navigation',
        plan.navigate === false && plan.url === undefined && plan.refusal === null,
        JSON.stringify(plan));
}
{
    const plan = planTabContentApply(discardedTab(), {url: null});
    check('null target url ⇒ REFUSED as non-navigable, live url kept',
        plan.navigate === false && plan.url === 'http://old' && plan.refusal === REFUSED_UNSYNCABLE_URL,
        JSON.stringify(plan));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
