import {LOAD_WAIT, POLL_WAIT, SETTLE_TIMEOUT, MANAGEMENT_READ_WAIT, BACKGROUND_TAB_TIMER, NAVIGATE_URL, MANAGEMENT_URL} from '../constants.js';
import {wait} from '../test.js';
import {withContainer} from '../tabs.js';
import {ownOrigin, hosts, extensions, probe, watch, READ_MOMENTS} from '../management.js';
import * as Startup from '../startup.js';

export const note = `Round 28 - other add-ons in the profile. NOT a part of T.start(): the round needs a profile
prepared for it, with two more add-ons next to the harness, one enabled and one disabled, STG not
among them; the enabled one has an options page. What management.getAll() reports for a disabled
and for an enabled extension (R28.01); the manifest.json of another enabled extension opened by
tabs.create, by tabs.update of a live tab and by location.replace from a page of the harness
(R28.02); the same opened by tabs.update that a page of the harness calls on its own tab, in the
default container and in another one (R28.03); whether management.getAll() lists the calling
extension itself (R28.04); R28.05 is MANUAL - management.onDisabled and onEnabled as the
background and a page in a tab get them, in a background tab, in a container and in a hidden
tab, with what management.getAll() reports to each at the event and after it; the manifest.json
created discarded and then activated (R28.07); tabs.update called by a page as soon as its script
runs, and by a page in a hidden tab (R28.08); R28.10 is MANUAL - what happens to the tabs on the
options page of an extension the user disables, a page that runs the code of the extension,
loaded, discarded and hidden ones, with the management events and the uuid of the extension told;
the options page opened by tabs.create, created discarded and activated, and by tabs.update a
page of the harness calls (R28.12); what management.getAll() tells at the first line of a
background that starts with the browser, and when it first tells something else (R28.13, stops and
asks for a restart, and needs the harness INSTALLED in the profile, a temporary one is gone at the
restart); R28.14 is MANUAL - management.onUninstalled and onInstalled as the background and a
page in a background tab and in a hidden tab get them, with what management.getAll() reports to
each at the event and after it, the add-on is removed and installed again by hand; R28.11 is
MANUAL and stands last on purpose - the same tabs of an extension the user REMOVES, the add-on
has to be installed again afterwards. The
expectations are the facts of CREATE-TABS-BEHAVIOR.md 36, 37, 39, 43, 44, 46-50, 55 and 57. The other
extensions are numbered, their ids and uuids are never printed; a MANUAL test names the add-on
the user has to act on, and checks through management.getAll() that the user has done it.`;

const CONTEXTS = ['background', 'plain', 'contained', 'hidden'];
const PROBED = CONTEXTS.slice(0, 3); // the page of the hidden tab is probed before its tab is hidden: the same as plain
const EXTENSION_HOST = /(?<=moz-extension:\/\/)[^/]+/g;
const OWN_UUID = new URL(browser.runtime.getURL('')).host;

// what the four tabs of tabsOfLeavingExtension are before the extension leaves
const ROLES = {
    loaded: {discarded: false, hidden: false},
    lazy: {discarded: true, hidden: false},
    hidden: {discarded: false, hidden: true},
    hiddenlazy: {discarded: true, hidden: true},
};

// the steps the user makes by hand, each with what management.getAll() has to show once it is made,
// and with the management event and the three reads a context gets at it (CREATE-TABS-BEHAVIOR.md 44, 48, 49)
const DISABLED_STATE = 'enabled:false hostPermissions: absent';
const ENABLED_STATE = 'enabled:true hostPermissions: lists its own origin';
const DISABLE = {
    label: 'disables',
    ask: name => `open about:addons and DISABLE the add-on "${name}"`,
    moment: 'disabled',
    check: 'the add-on is disabled',
    holds: extension => extension?.enabled === false,
    event: 'onDisabled',
    reads: [DISABLED_STATE, DISABLED_STATE, DISABLED_STATE],
};
const ENABLE = {
    label: 'enables',
    ask: name => `ENABLE the add-on "${name}"`,
    moment: 'enabled again',
    check: 'the add-on is enabled',
    holds: extension => extension?.enabled === true,
    event: 'onEnabled',
    reads: [ENABLED_STATE, ENABLED_STATE, ENABLED_STATE],
};
const REMOVE = {
    label: 'removes',
    ask: name => `open about:addons, REMOVE the add-on "${name}" and CLOSE the about:addons tab`,
    moment: 'removed',
    check: 'the add-on is gone',
    holds: extension => !extension,
    event: 'onUninstalled',
    reads: ['not in the list', 'not in the list', 'not in the list'],
};
const INSTALL = {
    label: 'installs again',
    ask: name => `INSTALL the add-on "${name}" again`,
    moment: 'installed again',
    check: 'the add-on is installed and enabled',
    holds: extension => extension?.enabled === true,
    event: 'onInstalled',
    reads: ['getAll rejected - An unexpected error occurred', ENABLED_STATE, ENABLED_STATE],
};

async function otherExtensions(t) {
    t.require('management.getAll is present', Boolean(browser.management?.getAll), 'the management permission is missing from the manifest');

    return (await extensions()).filter(extension => extension.id !== browser.runtime.id);
}

// something of another enabled extension to open, by its uuid: manifest.json is a file every
// extension has, the options page (real) is a page that runs the code of the extension
async function otherPage(t, {real = false} = {}) {
    const others = await otherExtensions(t);
    const subject = others.find(extension => ownOrigin(extension) && (!real || extension.optionsUrl));

    if (real) {
        t.require('the profile holds another enabled extension with an options page', Boolean(subject), 'the enabled add-on next to the harness has no options page: install one that has');
    } else {
        t.require('the profile holds another enabled extension', Boolean(subject), 'install any add-on next to the harness and leave it enabled');
    }

    const origin = ownOrigin(subject).slice(0, -1);
    const uuid = new URL(origin).host;

    return {
        subject,
        origin,
        target: real ? subject.optionsUrl : `${origin}manifest.json`,
        numberOf(id) {
            const index = others.findIndex(extension => extension.id === id);

            return index === -1 ? 'an extension outside the list' : `extension ${index + 1}`;
        },
        mask: text => text
            .replace(EXTENSION_HOST, host => host === uuid ? '<other uuid>' : host === OWN_UUID ? '<own uuid>' : '<another uuid>')
            .replaceAll(uuid, '<other uuid>'),
    };
}

const describe = (tab, mask) => `url:${mask(tab.url)} status:${tab.status} discarded:${tab.discarded} hidden:${tab.hidden}`;

// what the contexts heard: a line for every management event with its reads, or a line that says none came
function tellManagement(t, moment, reports, contexts, numberOf) {
    for (const context of contexts) {
        const events = reports.filter(report => !report.probe && report.context === context);

        if (!events.length) {
            t.note(`${moment}, ${context}: no management event arrived`);
        }

        for (const {event, id, type, reads, timer} of events) {
            const told = reads.map(({ms, state}, index) => `${READ_MOMENTS[index]} (+${ms} ms): ${state}`);

            t.note(`${moment}, ${context}: ${event} of ${numberOf(id)}, type ${type} - ${told.join('; ')}; a setTimeout of ${MANAGEMENT_READ_WAIT} ms took ${timer} ms`);
        }
    }
}

async function until(condition, timeout = SETTLE_TIMEOUT) {
    const started = Date.now();

    while (Date.now() - started < timeout) {
        if (await condition()) {
            return true;
        }

        await wait(POLL_WAIT);
    }

    return false;
}

function bindCreated(t, tab, name) {
    t.bind(tab.id, name);
    t.createdByAction.add(tab.id);

    return tab;
}

// a page of the harness is asked to send its own tab to the url, and tells how the call ended
async function updateItself(tab, url, mask) {
    const answer = await browser.tabs.sendMessage(tab.id, {action: 'update', to: url}).catch(error => ({ok: false, unheard: true, error: error.message}));

    return answer?.ok ? 'resolved' : `${answer?.unheard ? 'no reply from the page' : 'rejected'} - ${mask(String(answer?.error))}`;
}

// the user acts by hand, and the test goes on only once management.getAll() shows the step was made
async function userStep(t, subject, {label, ask, check, holds}) {
    t.act(`the user ${label} "${subject.name}"`);
    await t.ask(`${ask(subject.name)}, then answer: done`);

    const extension = (await extensions()).find(candidate => candidate.id === subject.id);

    t.require(check, holds(extension), `management.getAll() shows ${extension ? `enabled:${extension.enabled}` : 'no such add-on'}`);
}

// four tabs on the options page of the extension - loaded, discarded, hidden, hidden and discarded -
// and the user takes the extension away and brings it back: the loaded tabs are closed and the
// discarded ones stay (48, 49), the background tells the management events it got with their
// reads, and the uuid is the same after an enable and another after an install
async function tabsOfLeavingExtension(t, steps, {uuidKept = true} = {}) {
    const {subject, origin, target, mask, numberOf} = await otherPage(t, {real: true});
    const names = Object.keys(ROLES);
    const reports = [];

    await t.scene(['x']);

    for (const name of names) {
        t.bind((await browser.tabs.create({windowId: t.win, active: false, url: target})).id, name);
    }

    const readAll = () => Promise.all(names.map(name => browser.tabs.get(t.id(name)).catch(() => null)));
    const tell = tab => tab ? describe(tab, mask) : 'the tab is gone';
    const told = tabs => names.map((name, index) => `${name}: ${tell(tabs[index])}`).join('; ');

    const loaded = await until(async () => (await readAll()).every(tab => tab?.url.startsWith(origin) && tab.status === 'complete'));

    t.require('the four tabs are on the page of the extension', loaded, told(await readAll()));

    await t.settled();
    await browser.tabs.discard(t.ids(names.filter(name => ROLES[name].discarded)));
    await t.hide(names.filter(name => ROLES[name].hidden));

    const tabs = await readAll();
    const asNamed = names.every((name, index) => tabs[index]?.discarded === ROLES[name].discarded && tabs[index].hidden === ROLES[name].hidden);

    t.require('every tab is what its name says: discarded, hidden', asNamed, told(tabs));

    t.watch(['tabs.onRemoved', 'tabs.onUpdated'], {updatedKeys: ['status', 'discarded', 'hidden']});
    t.listeners.push(...watch('background', report => reports.push(report)));

    const report = async moment => {
        for (const [index, tab] of (await readAll()).entries()) {
            t.note(`${moment}, ${names[index]}: ${tell(tab)}`);
        }
    };

    await t.snap('before');
    await report('before');

    const closedLoaded = names.map((name, index) => `${name}: ${ROLES[name].discarded ? tell(tabs[index]) : 'the tab is gone'}`).join('; ');

    for (const step of steps) {
        const seen = reports.length;

        await userStep(t, subject, step);
        await wait(MANAGEMENT_READ_WAIT + LOAD_WAIT * 2);
        await t.settled();
        await t.snap(step.moment);
        await report(step.moment);

        const heard = reports.slice(seen).filter(report => report.id === subject.id);

        tellManagement(t, step.moment, reports.slice(seen), ['background'], numberOf);
        t.expect(`${step.moment}: the loaded tabs are closed, the discarded ones stay as they were (CREATE-TABS-BEHAVIOR.md §48, §49)`, told(await readAll()), closedLoaded);
        t.expect(
            `${step.moment}: the background gets the event, and its three reads of management.getAll() are what §48 and §49 record`,
            heard.map(({event, reads}) => ({event, reads: reads.map(read => read.state)})),
            [{event: step.event, reads: step.reads}],
        );
    }

    const back = (await extensions()).find(candidate => candidate.id === subject.id);
    const kept = ownOrigin(back) === ownOrigin(subject);

    t.note(`the add-on has ${kept ? 'the same uuid as before' : 'ANOTHER uuid'}`);
    t.expect(uuidKept ? 'the extension keeps its uuid across a disable and an enable (§48)' : 'the extension comes back with another uuid after a removal and an install (§49)', kept, uuidKept);
}

export const tests = [

{
    id: 'R28.01',
    title: 'management.getAll() in a profile with other add-ons - does a disabled extension report hostPermissions, does an enabled one list its own origin there',
    async run(t) {
        const others = await otherExtensions(t);
        const enabled = others.filter(extension => extension.enabled);
        const disabled = others.filter(extension => !extension.enabled);

        t.require('the profile holds another enabled extension', enabled.length > 0, 'install any add-on next to the harness and leave it enabled');
        t.require('the profile holds a disabled extension', disabled.length > 0, 'install any add-on next to the harness and disable it');

        for (const [index, extension] of others.entries()) {
            t.note(`extension ${index + 1}: enabled:${extension.enabled} hostPermissions: ${hosts(extension)}`);
        }

        t.expect('a disabled extension reports no hostPermissions (CREATE-TABS-BEHAVIOR.md §36)', disabled.map(hosts), disabled.map(() => 'absent'));
        t.expect('an enabled extension lists its own origin there (§34, §36)', enabled.map(hosts), enabled.map(() => 'lists its own origin'));
    },
},

{
    id: 'R28.02',
    title: 'a page of ANOTHER enabled extension, its manifest.json - opened by tabs.create, by tabs.update of a live tab and by location.replace from a page of the harness: which of them the browser lets through',
    async run(t) {
        const {target, mask} = await otherPage(t);

        const settle = async name => {
            await wait(LOAD_WAIT);
            await t.settled();

            return browser.tabs.get(t.id(name));
        };
        const landing = tab => `${tab.url === target ? 'on the page' : `on ${mask(tab.url)}`}, status ${tab.status}`;
        const outcomes = {create: 'rejected', update: 'rejected'};

        await t.scene(['x', 'y']);
        await t.snap('before');

        const created = await t.step('tabs.create({url: <manifest.json of the other extension>})', async () => {
            try {
                return bindCreated(t, await browser.tabs.create({windowId: t.win, active: false, url: target}), 'created');
            } catch (error) {
                t.note(`created: rejected - ${mask(error.message)}`);
                return null;
            }
        }, {snap: 'created'});

        if (created) {
            outcomes.create = landing(await settle('created'));
            t.note(`created: resolved, ${outcomes.create}`);
        }

        // an accepted update takes the scene name out of the url: the settle must not wait for it to come back
        t.expected.delete(t.id('y'));

        const updated = await t.step('tabs.update(y, {url: <the same page>})', async () => {
            try {
                await browser.tabs.update(t.id('y'), {url: target});
                return true;
            } catch (error) {
                t.note(`y: rejected - ${mask(error.message)}`);
                return false;
            }
        }, {snap: 'y updated'});

        if (updated) {
            outcomes.update = landing(await settle('y'));
            t.note(`y: resolved, ${outcomes.update}`);
        }

        await t.step('tabs.create({url: navigate.html?to=<the same page>})  // the page of the harness calls location.replace on load', async () => {
            bindCreated(t, await browser.tabs.create({windowId: t.win, active: false, url: `${NAVIGATE_URL}?tab=nav&to=${encodeURIComponent(target)}`}), 'nav');
        }, {snap: 'nav'});

        const nav = await settle('nav');
        const navigated = nav.url === target ? 'navigated to the page' : nav.url.startsWith(NAVIGATE_URL) ? 'BLOCKED - still on the page of the harness' : `elsewhere, on ${mask(nav.url)}`;

        t.note(`nav: ${navigated}, status ${nav.status}`);
        t.expect('tabs.create and tabs.update open the page, location.replace is denied (CREATE-TABS-BEHAVIOR.md §37)', {...outcomes, replace: navigated}, {
            create: 'on the page, status complete',
            update: 'on the page, status complete',
            replace: 'BLOCKED - still on the page of the harness',
        });
    },
},

{
    id: 'R28.03',
    title: 'tabs.update called by an extension PAGE on its own tab, with a page of another enabled extension - in the default container and in a non-default one',
    async run(t) {
        const {target, mask} = await otherPage(t);
        const outcomes = {};

        await t.scene(['x']);
        await t.snap('before');

        const attempt = async (name, properties) => {
            const tab = await t.step(`tabs.create({url: navigate.html}${properties.cookieStoreId ? ', cookieStoreId: container' : ''})`, async () => {
                return bindCreated(t, await browser.tabs.create({windowId: t.win, active: false, url: `${NAVIGATE_URL}?tab=${name}`, ...properties}), name);
            }, {wait: LOAD_WAIT, snap: name});

            const update = await t.step(`${name} calls tabs.update(its own tab, {url: <manifest.json of the other extension>, loadReplace: true})`, () => {
                return updateItself(tab, target, mask);
            }, {wait: LOAD_WAIT, snap: `${name} updated`});

            const fresh = await browser.tabs.get(tab.id);
            const landed = fresh.url === target ? 'on the page' : `on ${mask(fresh.url)}`;

            outcomes[name] = {update, landed, status: fresh.status, sameContainer: fresh.cookieStoreId === tab.cookieStoreId};

            t.note(`${name}: ${update}, ${landed}, status ${fresh.status}, container ${fresh.cookieStoreId === properties.cookieStoreId ? 'the requested one' : fresh.cookieStoreId}`);
        };

        await attempt('plain', {});

        await withContainer(t, cookieStoreId => attempt('contained', {cookieStoreId}));

        const onThePage = {update: 'resolved', landed: 'on the page', status: 'complete', sameContainer: true};

        t.expect('a page may send its own tab to a page of another extension, in either container (CREATE-TABS-BEHAVIOR.md §39)', outcomes, {plain: onThePage, contained: onThePage});
    },
},

{
    id: 'R28.04',
    title: 'management.getAll() - is the calling extension itself in the list, and does its entry name the origin runtime.getURL gives; enabled, installType and hostPermissions of every other entry',
    async run(t) {
        const others = await otherExtensions(t);
        const self = (await extensions()).find(extension => extension.id === browser.runtime.id);
        const named = Boolean(self) && ownOrigin(self) === `${browser.runtime.getURL('')}*`;

        t.note(`the list holds ${others.length} other extension(s), the harness ${self ? 'is' : 'is NOT'} in it too`);

        if (self) {
            t.note(`the harness: enabled:${self.enabled} installType:${self.installType} hostPermissions: ${hosts(self)}, the origin ${named ? 'is' : 'is NOT'} the one runtime.getURL gives`);
        }

        for (const [index, extension] of others.entries()) {
            t.note(`extension ${index + 1}: enabled:${extension.enabled} installType:${extension.installType} hostPermissions: ${hosts(extension)}`);
        }

        t.expect('the calling extension is in its own list, with the origin runtime.getURL gives (CREATE-TABS-BEHAVIOR.md §43)', {listed: Boolean(self), named}, {listed: true, named: true});
    },
},

{
    id: 'R28.05',
    title: `MANUAL: management.onDisabled and onEnabled as the background and a PAGE of the add-on in a background tab get them, in the default container and in another one, and a page in a HIDDEN tab - which contexts get the event, what their own management.getAll() reports at the event, ${MANAGEMENT_READ_WAIT} ms later and ${LOAD_WAIT} ms after that, and how long a setTimeout of ${MANAGEMENT_READ_WAIT} ms takes in each context`,
    async run(t) {
        const {subject, numberOf} = await otherPage(t);

        await t.scene(['x']);
        await t.snap('before');

        const reports = [];
        const handler = message => {
            message?.management && reports.push(message.management);
        };

        browser.runtime.onMessage.addListener(handler);
        t.listeners.push({target: browser.runtime.onMessage, handler}, ...watch('background', report => reports.push(report)));
        reports.push(await probe('background'));

        const turn = async step => {
            const seen = reports.length;

            await userStep(t, subject, step);
            await wait(MANAGEMENT_READ_WAIT + LOAD_WAIT * 2);

            // a page reports once its own timers have run
            await until(() => CONTEXTS.every(context => reports.slice(seen).some(report => !report.probe && report.context === context)));
            await t.settled();
            await t.snap(step.moment);

            const heard = reports.slice(seen).filter(report => !report.probe);
            const own = context => heard.filter(report => report.context === context && report.id === subject.id);

            tellManagement(t, step.moment, heard, CONTEXTS, numberOf);

            t.expect(
                `${step.moment}: every context gets the event and reads the new state from the first read on (CREATE-TABS-BEHAVIOR.md §44)`,
                Object.fromEntries(CONTEXTS.map(context => [context, own(context).map(({event, reads}) => ({event, reads: reads.map(read => read.state)}))])),
                Object.fromEntries(CONTEXTS.map(context => [context, [{event: step.event, reads: step.reads}]])),
            );
            t.expect(
                `${step.moment}: a timer of ${MANAGEMENT_READ_WAIT} ms takes ${BACKGROUND_TAB_TIMER} ms and more in the page of a background tab and of a hidden one, not in the background page (§44)`,
                Object.fromEntries(CONTEXTS.map(context => [context, own(context).map(({timer}) => timer >= BACKGROUND_TAB_TIMER)])),
                {background: [false], plain: [true], contained: [true], hidden: [true]},
            );
        };

        await withContainer(t, async cookieStoreId => {
            for (const [name, properties] of [['plain', {}], ['contained', {cookieStoreId}], ['hidden', {}]]) {
                await t.step(`tabs.create({url: management.html}${properties.cookieStoreId ? ', cookieStoreId: container' : ''})`, async () => {
                    const tab = bindCreated(t, await browser.tabs.create({windowId: t.win, active: false, url: `${MANAGEMENT_URL}?tab=${name}`, ...properties}), name);

                    t.expected.set(tab.id, name);
                }, {snap: name});
            }

            await until(() => CONTEXTS.every(context => reports.some(report => report.probe && report.context === context)));

            t.require('the page that is to be hidden has loaded', reports.some(report => report.probe && report.context === 'hidden'), 'management.html never reported from it');

            // hidden once its page has loaded: the listeners of the page are in place
            await t.step('tabs.hide(hidden)', () => browser.tabs.hide(t.id('hidden')), {snap: 'page hidden'});
            t.require('the tab of the hidden page is hidden', (await browser.tabs.get(t.id('hidden'))).hidden);

            const reach = {};

            for (const context of PROBED) {
                const report = reports.find(candidate => candidate.probe && candidate.context === context);

                reach[context] = report ? `${report.getAll.split(',')[0]}, ${report.sessionStorage}` : 'no report';
                t.note(`${context}: ${report ? `management.getAll ${report.getAll}; storage.session.get ${report.sessionStorage}` : 'the page never reported'}`);
            }

            t.expect('management.getAll and storage.session.get both resolve in every context (§44)', reach, Object.fromEntries(PROBED.map(context => [context, 'resolved, resolved'])));

            await turn(DISABLE);
            await turn(ENABLE);
        });
    },
},

{
    id: 'R28.07',
    title: 'tabs.create({url: <a page of another enabled extension>, discarded: true, title}) - is the call accepted, what the tab reports while it is discarded, and what it shows once activated; in the default container and in a non-default one',
    async run(t) {
        const {target, mask} = await otherPage(t);
        const outcomes = {};
        const place = tab => tab.url === target ? 'on the page' : 'elsewhere';

        await t.scene(['x']);
        await t.snap('before');

        const attempt = async (name, properties) => {
            const tab = await t.step(`tabs.create({url: <manifest.json of the other extension>, discarded: true, title}${properties.cookieStoreId ? ', cookieStoreId: container' : ''})`, async () => {
                try {
                    const created = bindCreated(t, await browser.tabs.create({windowId: t.win, active: false, url: target, discarded: true, title: name, ...properties}), name);

                    t.note(`${name} at the resolve: ${describe(created, mask)}`);

                    return created;
                } catch (error) {
                    t.note(`${name}: rejected - ${mask(error.message)}`);
                    return null;
                }
            }, {snap: name});

            if (!tab) {
                outcomes[name] = 'rejected';
                return;
            }

            t.note(`${name} settled: ${describe(await browser.tabs.get(tab.id), mask)}`);

            await t.step(`tabs.update(${name}, {active: true})`, () => browser.tabs.update(tab.id, {active: true}), {wait: LOAD_WAIT, snap: `${name} activated`});

            const fresh = await browser.tabs.get(tab.id);

            outcomes[name] = {
                born: `${place(tab)}, discarded ${tab.discarded}`,
                activated: `${place(fresh)}, status ${fresh.status}, discarded ${fresh.discarded}`,
                sameContainer: fresh.cookieStoreId === tab.cookieStoreId,
            };

            t.note(`${name} activated: ${describe(fresh, mask)}, container ${fresh.cookieStoreId === properties.cookieStoreId ? 'the requested one' : fresh.cookieStoreId}`);
        };

        await attempt('lazy', {});

        await withContainer(t, cookieStoreId => attempt('lazycontained', {cookieStoreId}));

        const bornLazy = {born: 'on the page, discarded true', activated: 'on the page, status complete, discarded false', sameContainer: true};

        t.expect('a page of another extension is born discarded on its url and loads when activated, in either container (CREATE-TABS-BEHAVIOR.md §46)', outcomes, {lazy: bornLazy, lazycontained: bornLazy});
    },
},

{
    id: 'R28.08',
    title: 'tabs.update to a page of another enabled extension, called by a page of the add-on on its own tab AS SOON AS ITS SCRIPT RUNS, and by a page whose tab is HIDDEN - does the tab get there, where the call falls among the status events of the load, and does a hidden tab stay hidden',
    async run(t) {
        const {target, mask} = await otherPage(t);
        const refusals = new Map();
        const handler = message => {
            message?.navigate && refusals.set(message.navigate, message.error);
        };
        const place = tab => tab.url === target ? 'on the page' : `on ${mask(tab.url)}`;

        browser.runtime.onMessage.addListener(handler);
        t.listeners.push({target: browser.runtime.onMessage, handler});

        await t.scene(['x']);
        t.watch(['tabs.onUpdated'], {updatedKeys: ['status']});
        await t.snap('before');

        const atLoad = await t.step('tabs.create({url: navigate.html?update=<manifest.json of the other extension>})  // the script of the page calls tabs.update on its own tab as soon as it runs', async () => {
            return bindCreated(t, await browser.tabs.create({windowId: t.win, active: false, url: `${NAVIGATE_URL}?tab=atload&update=${encodeURIComponent(target)}`}), 'atload');
        }, {wait: LOAD_WAIT, snap: 'atload'});

        const loaded = await browser.tabs.get(atLoad.id);
        const told = `${refusals.has('atload') ? `rejected - ${mask(String(refusals.get('atload')))}` : 'no refusal reported'}, ${place(loaded)}, status ${loaded.status}`;

        t.note(`atload: ${told}`);

        const hidden = await t.step('tabs.create({url: navigate.html})', async () => {
            return bindCreated(t, await browser.tabs.create({windowId: t.win, active: false, url: `${NAVIGATE_URL}?tab=hidden`}), 'hidden');
        }, {wait: LOAD_WAIT, snap: 'hidden created'});

        await t.step('tabs.hide(hidden)', () => browser.tabs.hide(hidden.id), {snap: 'hidden'});

        const update = await t.step('hidden calls tabs.update(its own tab, {url: <manifest.json of the other extension>, loadReplace: true})', () => {
            return updateItself(hidden, target, mask);
        }, {wait: LOAD_WAIT, snap: 'hidden updated'});

        const fresh = await browser.tabs.get(hidden.id);
        const toldHidden = `${update}, ${place(fresh)}, status ${fresh.status}, hidden ${fresh.hidden}, discarded ${fresh.discarded}`;

        t.note(`hidden: ${toldHidden}`);
        t.expect('the update made as soon as the script runs and the one made from a hidden tab both reach the page, the hidden tab stays hidden (CREATE-TABS-BEHAVIOR.md §47)', {atload: told, hidden: toldHidden}, {
            atload: 'no refusal reported, on the page, status complete',
            hidden: 'resolved, on the page, status complete, hidden true, discarded false',
        });
    },
},

{
    id: 'R28.10',
    title: 'MANUAL: the tabs on a page that RUNS THE CODE of an extension, its options page, when the user DISABLES the extension - a loaded tab, a discarded one, a hidden one and a hidden discarded one: which of them the browser closes, which events announce it, what is there once the extension is enabled again; the management events the background gets, and whether the extension keeps its uuid',
    async run(t) {
        await tabsOfLeavingExtension(t, [DISABLE, ENABLE]);
    },
},

{
    id: 'R28.12',
    title: 'a page that RUNS THE CODE of another enabled extension, its options page - opened by tabs.create, created discarded and then activated, and by tabs.update a page of the harness calls on its own tab: does each of them reach the page',
    async run(t) {
        const {origin, target, mask} = await otherPage(t, {real: true});
        const place = tab => tab.url.startsWith(origin) ? 'on a page of the extension' : 'elsewhere';
        const outcomes = {};

        await t.scene(['x']);
        await t.snap('before');

        const create = async (name, label, properties) => {
            return t.step(`tabs.create(${label})`, async () => {
                try {
                    const created = bindCreated(t, await browser.tabs.create({windowId: t.win, active: false, ...properties}), name);

                    t.note(`${name} at the resolve: ${describe(created, mask)}`);

                    return created;
                } catch (error) {
                    t.note(`${name}: rejected - ${mask(error.message)}`);
                    outcomes[name] = 'rejected';
                    return null;
                }
            }, {wait: LOAD_WAIT, snap: name});
        };
        const tell = async (name, moment, tab) => {
            const fresh = await browser.tabs.get(tab.id);

            t.note(`${name} ${moment}: ${place(fresh)}, ${describe(fresh, mask)}`);

            return `${place(fresh)}, discarded ${fresh.discarded}`;
        };

        const created = await create('created', '{url: <options page of the other extension>}', {url: target});

        if (created) {
            outcomes.created = await tell('created', 'loaded', created);
        }

        const lazy = await create('lazy', '{url: <options page of the other extension>, discarded: true, title}', {url: target, discarded: true, title: 'lazy'});

        if (lazy) {
            const born = `${place(lazy)}, discarded ${lazy.discarded}`;

            await t.step('tabs.update(lazy, {active: true})', () => browser.tabs.update(lazy.id, {active: true}), {wait: LOAD_WAIT, snap: 'lazy activated'});
            outcomes.lazy = {born, activated: await tell('lazy', 'activated', lazy)};
        }

        const page = await create('page', '{url: navigate.html}', {url: `${NAVIGATE_URL}?tab=page`});

        if (page) {
            const update = await t.step('page calls tabs.update(its own tab, {url: <options page of the other extension>, loadReplace: true})', () => {
                return updateItself(page, target, mask);
            }, {wait: LOAD_WAIT, snap: 'page updated'});

            t.note(`page: the call ${update}`);
            outcomes.page = `${update}, ${await tell('page', 'updated', page)}`;
        }

        const onThePage = 'on a page of the extension, discarded false';

        t.expect('a page that runs the code of another extension opens by tabs.create, created discarded and activated, and by tabs.update a page calls on its own tab (CREATE-TABS-BEHAVIOR.md §50)', outcomes, {
            created: onThePage,
            lazy: {born: 'on a page of the extension, discarded true', activated: onThePage},
            page: `resolved, ${onThePage}`,
        });
    },
},

{
    id: 'R28.13',
    title: 'the list of extensions at the FIRST LINE of a background that starts with the browser - does management.getAll() already tell every enabled extension with its own origin there, and if not, at which ms a read first does; the harness has to be INSTALLED in the profile, not loaded through about:debugging',
    async run(t) {
        const others = await otherExtensions(t);

        t.require('the profile holds another enabled extension', others.some(extension => extension.enabled), 'install any add-on next to the harness and leave it enabled');

        // an add-on loaded through about:debugging tells installType development (CREATE-TABS-BEHAVIOR.md 43)
        t.require('the harness is installed in the profile', (await browser.management.getSelf()).installType !== 'development', 'a temporary add-on is gone at the restart: zip the CONTENTS of test-addon, manifest.json at the root, install the zip from about:addons - Install Add-on From File, and start the test from the installed one');

        await t.scene(['x']);
        await t.snap('before restart');

        Startup.arm();

        await t.restart('restart Firefox, load nothing by hand: the installed harness starts with the browser. Then run:  T.continue()');
    },
    async afterRestart(t) {
        // the probe reads for SETTLE_TIMEOUT from the start of the background
        await Promise.race([Startup.finished, wait(SETTLE_TIMEOUT)]);

        const record = Startup.take();

        await t.settled();
        await t.snap('after restart');

        t.require('the probe ran at a start of the background', record !== null, 'nothing was recorded: the background has not started again since the probe was armed');

        const others = await otherExtensions(t);
        const named = id => {
            if (id === browser.runtime.id) {
                return 'the harness';
            }

            const index = others.findIndex(extension => extension.id === id);

            return index === -1 ? 'an extension outside the list' : `extension ${index + 1}`;
        };
        const moment = ms => ms === record.reads[0].ms ? `at the first line (+${ms} ms)` : `from +${ms} ms`;
        const lists = record.reads.filter(({state}) => Array.isArray(state));
        const ids = [...new Set([browser.runtime.id, ...others.map(extension => extension.id), ...lists.flatMap(({state}) => state.map(extension => extension.id))])];

        t.note(`add-on starts while the test was suspended: ${t.rebirths}; the harness now: installType ${(await browser.management.getSelf()).installType}`);
        t.note(`the first line ran when the background page was ${record.pageAge} ms old; windows at the first line: ${record.windows ?? 'the read never resolved'}; runtime.onStartup: ${record.onStartup === null ? 'not delivered' : `+${record.onStartup} ms`}; the first windows.onCreated: ${record.windowCreated === null ? 'none' : `+${record.windowCreated} ms`}`);
        t.note(`${record.polls} read(s) of management.getAll() over ${record.watched} ms, ${record.reads.length} of them told something new`);

        for (const {ms, state} of record.reads) {
            if (!Array.isArray(state)) {
                t.note(`${moment(ms)}: management.getAll() ${state}`);
            }
        }

        const tellings = new Map();

        for (const id of ids) {
            const told = [];

            for (const {ms, state} of lists) {
                const extension = state.find(candidate => candidate.id === id);
                const telling = extension ? `enabled:${extension.enabled} hostPermissions: ${extension.hosts}` : 'not in the list';

                if (telling !== told.at(-1)?.telling) {
                    told.push({ms, telling});
                }
            }

            tellings.set(id, told.map(({telling}) => telling));
            t.note(`${named(id)}: ${told.map(({ms, telling}) => `${moment(ms)} - ${telling}`).join('; ')}`);
        }

        const enabled = [browser.runtime.id, ...others.filter(extension => extension.enabled).map(extension => extension.id)];

        t.expect('every enabled extension lists its own origin at the first line, and no later read tells anything else (CREATE-TABS-BEHAVIOR.md §55)', enabled.map(id => tellings.get(id)), enabled.map(() => [ENABLED_STATE]));
        t.require('the background started exactly once since the probe was armed', t.rebirths === 1, `add-on starts while the test was suspended: ${t.rebirths}; the record is of the first of them`);
    },
},

{
    id: 'R28.14',
    title: `MANUAL: management.onUninstalled and onInstalled as the background and a PAGE of the add-on in a background tab and in a HIDDEN tab get them - which contexts get the event, what their own management.getAll() reports at the event, ${MANAGEMENT_READ_WAIT} ms later and ${LOAD_WAIT} ms after that; the add-on is removed and installed again by hand`,
    async run(t) {
        const {subject, numberOf} = await otherPage(t);
        const pages = ['plain', 'hidden'];
        const contexts = ['background', ...pages];

        await t.scene(['x']);
        await t.snap('before');

        const reports = [];
        const handler = message => {
            message?.management && reports.push(message.management);
        };

        browser.runtime.onMessage.addListener(handler);
        t.listeners.push({target: browser.runtime.onMessage, handler}, ...watch('background', report => reports.push(report)));

        for (const name of pages) {
            await t.step('tabs.create({url: management.html})', async () => {
                const tab = bindCreated(t, await browser.tabs.create({windowId: t.win, active: false, url: `${MANAGEMENT_URL}?tab=${name}`}), name);

                t.expected.set(tab.id, name);
            }, {snap: name});
        }

        const loaded = await until(() => pages.every(context => reports.some(report => report.probe && report.context === context)));

        t.require('both pages have loaded', loaded, 'management.html never reported from one of them');

        // hidden once its page has loaded: the listeners of the page are in place
        await t.step('tabs.hide(hidden)', () => browser.tabs.hide(t.id('hidden')), {snap: 'page hidden'});
        t.require('the tab of the hidden page is hidden', (await browser.tabs.get(t.id('hidden'))).hidden);

        for (const step of [REMOVE, INSTALL]) {
            const seen = reports.length;

            await userStep(t, subject, step);
            await wait(MANAGEMENT_READ_WAIT + LOAD_WAIT * 2);

            // a page reports once its own timers have run; a context that got nothing never reports, and the wait gives up
            await until(() => contexts.every(context => reports.slice(seen).some(report => !report.probe && report.context === context)));
            await t.settled();
            await t.snap(step.moment);

            tellManagement(t, step.moment, reports.slice(seen), contexts, numberOf);

            const heard = reports.slice(seen).filter(report => !report.probe);
            const own = context => heard.filter(report => report.context === context && report.id === subject.id);

            t.expect(
                `${step.moment}: every context gets the event, and its reads are the ones §49 records for the background (CREATE-TABS-BEHAVIOR.md §57)`,
                Object.fromEntries(contexts.map(context => [context, own(context).map(({event, reads}) => ({event, reads: reads.map(read => read.state)}))])),
                Object.fromEntries(contexts.map(context => [context, [{event: step.event, reads: step.reads}]])),
            );
            t.expect(
                `${step.moment}: a timer of ${MANAGEMENT_READ_WAIT} ms takes ${BACKGROUND_TAB_TIMER} ms and more in the pages, not in the background page (§57)`,
                Object.fromEntries(contexts.map(context => [context, own(context).map(({timer}) => timer >= BACKGROUND_TAB_TIMER)])),
                {background: [false], plain: [true], hidden: [true]},
            );
        }
    },
},

{
    id: 'R28.11',
    title: 'MANUAL, the last test of the round: the tabs on a page that RUNS THE CODE of an extension, its options page, when the user REMOVES the extension - a loaded tab, a discarded one, a hidden one and a hidden discarded one: which of them the browser closes, which events announce it, what is there once the add-on is installed again; the management events the background gets, and whether the extension comes back with its uuid',
    async run(t) {
        await tabsOfLeavingExtension(t, [REMOVE, INSTALL], {uuidKept: false});
    },
},

];
