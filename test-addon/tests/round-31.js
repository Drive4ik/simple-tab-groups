import {POLL_WAIT, SETTLE_TIMEOUT, SENDER_URL, CONTENT_SCRIPT_URL} from '../constants.js';
import {wait} from '../test.js';
import {sceneUrl} from '../tabs.js';

export const note = `Round 31 - what runtime.MessageSender tells the background about who sent a message.
The senders: a page of the add-on in a tab, and the content script the manifest declares, in the
main frame of a web page, in a frame of the same site and in an about:blank frame - the script is
declared the way the add-on declares its own, for every frame and for about:blank. Each of them
sends a message with runtime.sendMessage and opens a port with runtime.connect, and for either the
background prints the keys of the sender, whether the id is the add-on's, the url, the tab, the
frame and the envType, and whether the url starts with the origin of the add-on - the rule the
add-on tells its own pages by (R31.01). A popup of the toolbar button and a sidebar are not among
the senders: the harness has neither. The expectations are the fact of BEHAVIOR-CREATE-TABS.md 56.
Needs the network: the web page is a real one. The own uuid is never printed.`;

const OWN_ORIGIN = browser.runtime.getURL('');
const PORT_PREFIX = 'sender: ';
const WAYS = ['runtime.sendMessage', 'runtime.connect'];
const KEYS = 'contextId, documentId, envType, frameId, id, origin, tab, url';
const SILENT = 'nothing arrived';

const mask = text => text.replaceAll(OWN_ORIGIN, '<own page>/');
const line = ({keys, id, url, tab, frameId, envType}) => `keys: ${keys}; id: ${id}; url: ${url}; tab: ${tab}; frameId: ${frameId}; envType: ${envType}; the url starts with the origin of the add-on: ${url.startsWith('<own page>/')}`;

// every sender with what the background has to get from it, by a message and by a port alike (BEHAVIOR-CREATE-TABS.md 56)
const page = {keys: KEYS, id: 'of the add-on', url: mask(sceneUrl('page', SENDER_URL)), tab: 'page', frameId: 0, envType: 'addon_child'};
const script = {keys: KEYS, id: 'of the add-on', url: sceneUrl('web', CONTENT_SCRIPT_URL), tab: 'web', frameId: 0, envType: 'content_child'};
const SENDERS = {
    'page of the add-on': line(page),
    'content script, main frame': line(script),
    'content script, frame': line({...script, frameId: 'not 0'}),
    'content script, about:blank frame': SILENT,
};

export const tests = [

{
    id: 'R31.01',
    title: 'runtime.MessageSender of a message and of a port, as the background gets it - from a page of the add-on in a tab, and from the declared content script in the main frame of a web page, in a frame of the same site and in an about:blank frame: the keys, the id, the url, the tab, the frameId and the envType of each',
    async run(t) {
        const heard = [];
        const onMessage = (message, sender) => {
            message?.sender && heard.push({label: message.sender, way: WAYS[0], sender});
        };
        const onConnect = port => {
            if (port.name.startsWith(PORT_PREFIX)) {
                heard.push({label: port.name.slice(PORT_PREFIX.length), way: WAYS[1], sender: port.sender});
                port.disconnect();
            }
        };
        const tell = sender => line({
            keys: Object.keys(sender).sort().join(', '),
            id: sender.id === browser.runtime.id ? 'of the add-on' : sender.id,
            url: sender.url === undefined ? 'absent' : mask(sender.url),
            tab: sender.tab ? t.known(sender.tab.id) : 'absent',
            frameId: sender.frameId === undefined ? 'absent' : sender.frameId === 0 ? 0 : 'not 0',
            envType: sender.envType ?? 'absent',
        });

        t.mask = mask;

        await t.scene(['x']);
        await t.snap('before');

        browser.runtime.onMessage.addListener(onMessage);
        browser.runtime.onConnect.addListener(onConnect);
        t.listeners.push({target: browser.runtime.onMessage, handler: onMessage}, {target: browser.runtime.onConnect, handler: onConnect});

        const pages = [
            ['page', 'tabs.create({url: sender.html})', SENDER_URL],
            ['web', `tabs.create({url: ${CONTENT_SCRIPT_URL}})  // the content script adds a frame of the same site and an about:blank frame`, CONTENT_SCRIPT_URL],
        ];

        for (const [name, label, base] of pages) {
            await t.step(label, async () => {
                const tab = await browser.tabs.create({windowId: t.win, active: false, url: sceneUrl(name, base)});

                t.bind(tab.id, name);
                t.createdByAction.add(tab.id);
            }, {snap: name});
        }

        // a frame reports once the page it stands in has loaded and the frame itself has
        const from = (label, way) => heard.filter(message => message.label === label && message.way === way);
        const reported = () => Object.keys(SENDERS).every(label => WAYS.every(way => from(label, way).length));
        const started = Date.now();

        while (!reported() && Date.now() - started < SETTLE_TIMEOUT) {
            await wait(POLL_WAIT);
        }

        // no content script runs on the error page of a load that failed
        const web = await browser.tabs.get(t.id('web'));

        t.note(`web: status ${web.status}, title ${JSON.stringify(web.title)}`);

        const got = {};

        for (const label of Object.keys(SENDERS)) {
            got[label] = WAYS.map(way => from(label, way).map(({sender}) => tell(sender)).join(' | ') || SILENT);

            for (const [index, way] of WAYS.entries()) {
                t.note(`${label}, ${way}: ${got[label][index]}`);
            }
        }

        for (const {label, way} of heard.filter(message => !Object.hasOwn(SENDERS, message.label))) {
            t.note(`a sender outside the list: ${label}, ${way}`);
        }

        t.expect('a page of the add-on and its content script carry the same id, the url and the envType tell them apart, a message and a port give the same sender (BEHAVIOR-CREATE-TABS.md §56)', got, Object.fromEntries(Object.entries(SENDERS).map(([label, told]) => [label, WAYS.map(() => told)])));
    },
},

];
