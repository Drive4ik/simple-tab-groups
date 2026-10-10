import {LOAD_WAIT, NETWORK_URL, NAVIGATE_URL} from '../constants.js';

export const note = `Round 30 - what a blocking webRequest listener learns about who asked for a load. The loads go
to an https address of a host no server answers for, so nothing but the request itself decides
the outcome. What a tab on such an address reports when nobody listens, for a made-up top-level
domain and for a reserved one (R30.01); which requests reach the listener and what they say about
who asked - tabs.create, tabs.update, a page of the add-on, a script of a web page, a web address
a listener redirects (R30.02). The expectations are the facts of BEHAVIOR-CREATE-TABS.md 51-52.
Needs the network for the web page of R30.02. The own uuid is never printed.`;

const OWN_UUID = new URL(browser.runtime.getURL('')).host;
const OWN_ORIGIN = browser.runtime.getURL('');

// a top-level domain nobody has registered, and one that is reserved and can never be
const MADE_UP = 'stg.addon';
const RESERVED = 'stg.invalid';
const HOSTS = [['madeup', MADE_UP], ['reserved', RESERVED]];
const FILTER = {urls: HOSTS.map(([, host]) => `https://${host}/*`), types: ['main_frame']};

const HOP_MARK = 'hop=1';

const address = (host, name) => `https://${host}/tab.html?tab=${name}`;
const mask = text => text.replaceAll(OWN_UUID, '<own uuid>');
const describe = tab => `url:${mask(tab.url)} status:${tab.status} discarded:${tab.discarded} title:${JSON.stringify(mask(tab.title ?? ''))}`;

function asker(url) {
    if (!url) {
        return 'none';
    }

    if (url.startsWith(OWN_ORIGIN)) {
        return `a page of the add-on (${new URL(url).pathname})`;
    }

    return mask(url);
}

function listen(t, handler, filter = FILTER) {
    browser.webRequest.onBeforeRequest.addListener(handler, filter, ['blocking']);
    t.listeners.push({target: browser.webRequest.onBeforeRequest, handler});
}

function bindCreated(t, tab, name) {
    t.bind(tab.id, name);
    t.createdByAction.add(tab.id);

    return tab;
}

async function create(t, name, label, properties) {
    return t.step(`tabs.create(${label})`, async () => {
        try {
            return bindCreated(t, await browser.tabs.create({windowId: t.win, active: false, ...properties}), name);
        } catch (error) {
            t.note(`${name}: rejected - ${mask(error.message)}`);
            return null;
        }
    }, {wait: LOAD_WAIT, snap: name});
}

async function tell(t, name, moment = 'after the wait') {
    const tab = await browser.tabs.get(t.id(name)).catch(() => null);

    t.note(`${name} ${moment}: ${tab ? describe(tab) : 'the tab is gone'}`);

    return tab;
}

export const tests = [

{
    id: 'R30.01',
    title: 'an https address that no server answers for, with NO listener armed - what a tab created on it reports, for a made-up top-level domain and for a reserved one',
    async run(t) {
        const got = {};

        await t.scene(['x']);

        // the urls a tab goes through: the formatter of the harness prints a url as it is, the mask takes the own uuid out
        t.mask = mask;
        t.watch(['tabs.onUpdated'], {updatedKeys: ['status', 'url']});
        await t.snap('before');

        for (const [name, host] of HOSTS) {
            if (await create(t, name, `{url: ${address(host, name)}}`, {url: address(host, name)})) {
                const tab = await tell(t, name);

                got[name] = tab ? {url: mask(tab.url), status: tab.status, title: tab.title} : 'the tab is gone';
            } else {
                got[name] = 'rejected';
            }
        }

        t.expect(
            'a tab on an address no server answers for keeps the address as its url, complete, with the title of the error page, for either top-level domain (BEHAVIOR-CREATE-TABS.md §51)',
            got,
            Object.fromEntries(HOSTS.map(([name, host]) => [name, {url: address(host, name), status: 'complete', title: 'Problem loading page'}])),
        );
    },
},

{
    id: 'R30.02',
    title: 'the requests for the address as a blocking webRequest listener gets them, the listener lets them go - opened by tabs.create, by tabs.update, by location.replace of a page of the add-on, by a script of a web page that sets its location, and by a listener that redirects a web address: tab, method, type, frame, who asked, and whether a redirect keeps the request',
    async run(t) {
        const requests = new Map();
        const request = id => requests.get(id) ?? requests.set(id, `request ${requests.size + 1}`).get(id);
        const kind = details => `${details.method} ${details.type} frame:${details.frameId}`;
        const askedBy = details => `origin: ${asker(details.originUrl)}  document: ${asker(details.documentUrl)}`;
        const told = details => `${details.tabId === browser.tabs.TAB_ID_NONE ? 'no tab' : t.known(details.tabId)}  ${kind(details)}  ${details.url}  ${askedBy(details)}  ${request(details.requestId)}`;
        const navigation = `location.href = ${JSON.stringify(address(RESERVED, 'web'))};`;
        const seen = [];
        let hopFirst = null;

        await t.scene(['x', 'y']);

        // told when the report is written: by then every tab has its name
        listen(t, details => {
            seen.push(details);
            t.record('webRequest.onBeforeRequest', () => told(details));

            return {};
        });

        listen(t, details => {
            if (!details.url.includes(HOP_MARK)) {
                return {};
            }

            hopFirst = details;
            t.record('webRequest.onBeforeRequest', () => `${told(details)}  -> redirectUrl: the address`);

            return {redirectUrl: address(RESERVED, 'hop')};
        }, {urls: [`${NETWORK_URL}*`], types: ['main_frame']});

        await t.snap('before');

        await create(t, 'created', `{url: ${address(RESERVED, 'created')}}`, {url: address(RESERVED, 'created')});

        await t.step(`tabs.update(y, {url: ${address(RESERVED, 'y')}})`, () => {
            return browser.tabs.update(t.id('y'), {url: address(RESERVED, 'y')}).catch(error => t.note(`y: rejected - ${mask(error.message)}`));
        }, {wait: LOAD_WAIT, snap: 'y updated'});

        await create(t, 'replaced', `{url: navigate.html?to=${address(RESERVED, 'replaced')}}  // the page of the add-on calls location.replace on load`, {
            url: `${NAVIGATE_URL}?tab=replaced&to=${encodeURIComponent(address(RESERVED, 'replaced'))}`,
        });

        const web = await create(t, 'web', `{url: ${NETWORK_URL}}`, {url: NETWORK_URL});

        if (web) {
            await t.step(`a script of the web page sets location.href = ${address(RESERVED, 'web')}  // put into the page as a <script> element, it runs as the page's own`, () => {
                return browser.tabs.executeScript(web.id, {code: `document.documentElement.append(Object.assign(document.createElement('script'), {textContent: ${JSON.stringify(navigation)}}));`})
                    .catch(error => t.note(`web: executeScript rejected - ${mask(error.message)}`));
            }, {wait: LOAD_WAIT, snap: 'web navigated'});

            t.note(`web: ${seen.some(details => details.tabId === web.id) ? 'a request of the page reached the listener' : 'NO request of the page reached the listener - the script did not run, or the page did not ask'}`);
        }

        await create(t, 'hop', `{url: ${NETWORK_URL}?${HOP_MARK}}  // a listener redirects this web address to the address`, {url: `${NETWORK_URL}?${HOP_MARK}`});

        const got = {};
        const byAddon = 'GET main_frame frame:0  origin: a page of the add-on (/)  document: none';
        const onErrorPage = 'on the error page with the address';

        for (const name of ['created', 'y', 'replaced', 'web', 'hop'].filter(name => t.idByName.has(name))) {
            const tab = await tell(t, name);
            const request = seen.find(details => details.tabId === t.id(name));

            got[name] = {
                asked: request ? `${kind(request)}  ${askedBy(request)}` : 'no request',
                ended: tab?.url === address(RESERVED, name) && tab.title === 'Problem loading page' ? onErrorPage : `elsewhere: ${tab ? describe(tab) : 'the tab is gone'}`,
            };
        }

        got.hopKeepsTheRequest = Boolean(hopFirst) && seen.some(details => details.requestId === hopFirst.requestId && details.originUrl === hopFirst.originUrl);

        t.expect('every way of asking reaches the listener as a GET main_frame request of frame 0 with originUrl naming who asked, a redirect keeps the request, and every tab ends on the error page (BEHAVIOR-CREATE-TABS.md §52)', got, {
            created: {asked: byAddon, ended: onErrorPage},
            y: {asked: byAddon, ended: onErrorPage},
            replaced: {asked: 'GET main_frame frame:0  origin: a page of the add-on (/navigate.html)  document: none', ended: onErrorPage},
            web: {asked: `GET main_frame frame:0  origin: ${NETWORK_URL}  document: none`, ended: onErrorPage},
            hop: {asked: byAddon, ended: onErrorPage},
            hopKeepsTheRequest: true,
        });
    },
},

];
