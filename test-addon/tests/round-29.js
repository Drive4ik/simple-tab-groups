import {NETWORK_URL, SCENE_URL, BOOKMARKS_PARENT_ID, BOOKMARKS_FOLDER} from '../constants.js';
import {MenusTest, requireBookmarks} from '../menus.js';

export const note = `Round 29 - the urls browser.bookmarks.create takes. A saved tab can hold any url the browser
has ever shown, and the add-on turns its tabs into bookmarks: which url classes the call accepts,
which it refuses and with what error, and whether the bookmark gives the url back as it was passed
- from the created node and from bookmarks.getChildren (R29.01). MANUAL: the optional bookmarks
permission is granted on the page the test opens. The bookmarks live in a folder the test makes in
Other Bookmarks and removes at the end. The expectations are the facts of
BEHAVIOR-CREATE-TABS.md 42. The extension ids in the urls are made up, the own uuid is never
printed.`;

export const testClass = MenusTest;

const OWN_ORIGIN = browser.runtime.getURL('');
const KEPT = 'the url as passed';
const REFUSED = 'refused';

// the url, and what the bookmark holds for it (BEHAVIOR-CREATE-TABS.md 42)
const URL_CASES = [
    ['http', NETWORK_URL, KEPT],
    ['reader', `about:reader?url=${encodeURIComponent(NETWORK_URL)}`, KEPT],
    ['blank', 'about:blank', KEPT],
    ['config', 'about:config', KEPT],
    ['file', 'file:///C:/stg-behavior-tests.txt', KEPT],
    ['datatext', 'data:text/plain,hello', KEPT],
    ['js', 'javascript:void(0)', KEPT],
    ['view', `view-source:${NETWORK_URL}`, KEPT],
    ['own', `${SCENE_URL}?tab=own`, KEPT],
    ['unknown', 'moz-extension://9a1b7c52-3f0e-4d8a-b6c1-2e5f7a9d0c34/page.html', KEPT],
    ['name@domain', `moz-extension://some-addon@example.com/page.html?url=${encodeURIComponent(NETWORK_URL)}`, KEPT],
    ['Name@Domain', 'moz-extension://Some-Addon@Example.Com/page.html', 'moz-extension://Some-Addon@example.com/page.html'],
    ['@name', 'moz-extension://@some-addon/page.html', 'moz-extension://some-addon/page.html'],
    ['{guid}', 'moz-extension://{506e023c-7f2b-40a3-8066-bc5deb40aebe}/page.html', KEPT],
    ['{GUID}', 'moz-extension://{66E978CD-981F-47DF-AC42-E3CF417C1467}/page.html', 'moz-extension://{66e978cd-981f-47df-ac42-e3cf417c1467}/page.html'],
    ['noscheme', 'example.com', REFUSED],
];

const mask = text => text.replaceAll(OWN_ORIGIN, 'moz-extension://<own uuid>/');
const shortError = message => message.length > 200 ? `${message.slice(0, 200)}...` : message;
const held = (url, passed) => url === passed ? KEPT : mask(String(url));
const given = (url, passed) => url === passed ? KEPT : `ANOTHER url: ${mask(String(url))}`;

export const tests = [

{
    id: 'R29.01',
    title: 'MANUAL: bookmarks.create with every url class a saved tab can hold - which are accepted, which are refused and with what error, and does the bookmark give the url back as it was passed',
    async run(t) {
        await requireBookmarks(t);

        const folder = await browser.bookmarks.create({parentId: BOOKMARKS_PARENT_ID, title: BOOKMARKS_FOLDER});
        const got = {};

        try {
            const created = new Map();

            for (const [name, url] of URL_CASES) {
                try {
                    created.set(name, await browser.bookmarks.create({parentId: folder.id, title: name, url}));
                } catch (error) {
                    got[name] = REFUSED;
                    t.note(`${name}  ${mask(url)}: refused - ${mask(shortError(error.message))}`);
                }
            }

            const children = await browser.bookmarks.getChildren(folder.id);

            for (const [name, url] of URL_CASES) {
                if (!created.has(name)) {
                    continue;
                }

                const node = created.get(name);
                const child = children.find(candidate => candidate.id === node.id);

                got[name] = child?.url === node.url ? held(node.url, url) : 'the created node and getChildren differ';

                t.note(`${name}  ${mask(url)}: accepted, the created node holds ${given(node.url, url)}, getChildren gives ${child ? given(child.url, url) : 'NO such bookmark'}`);
            }
        } finally {
            await browser.bookmarks.removeTree(folder.id).catch(error => t.note(`the test folder was not removed: ${error.message}`));
        }

        t.expect(
            'every url with a scheme is accepted, one without it is refused, and the bookmark holds the url as the URL constructor serializes it (BEHAVIOR-CREATE-TABS.md §42)',
            Object.fromEntries(URL_CASES.map(([name]) => [name, got[name]])),
            Object.fromEntries(URL_CASES.map(([name, , outcome]) => [name, outcome])),
        );
    },
},

];
