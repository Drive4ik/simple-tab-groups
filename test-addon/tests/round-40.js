import {SCENE_URL, SETTLE_TIMEOUT} from '../constants.js';
import {until} from '../test.js';
import {openedWindows, sceneUrl} from '../tabs.js';
import {ErrorsTest, shape, isError, outcome} from '../errors.js';

export const note = `Round 40 - the error objects the browser hands to an extension, field by field, the way the logger
of the add-on reads them (logger-utils.js normalizeError, nativeErrorToObject, getStack): a rejection of a
browser.* call the browser answers from its parent process, next to a rejection with no receiver, a schema
error thrown at the call and the plain Error constructor with an explicit undefined as its file name (R40.01);
a DOMException made by the test, the same one after structuredClone, one the platform rejects with and one it
throws (R40.02); an Error with a custom name, own properties, a cause and an assigned stack across
structuredClone, next to one named after a standard error (R40.03); Error.isError, typeof, JSON.stringify,
Object.keys and the in operator on an object of a page that was closed, the dead object a logged argument
can hold (R40.04). In the event log every action is its own line and the shapes under it are what it
produced. A line or a column is printed only as present or not: the number depends on the file of the test.
The own uuid is never printed.`;

export const testClass = ErrorsTest;

const UNKNOWN_ID = 2147483647; // the largest id the schema takes; no tab and no window has it
const OWN_FILE = 'fileName: string "<own page>/tests/round-40.js"';
const DEAD = "throws TypeError: can't access dead object";

// the call under test: whether it threw at the call, rejected or resolved, and the error it gave
async function tryCall(t, label, call) {
    return t.step(label, async () => {
        let result;

        try {
            result = call();
        } catch (error) {
            t.record('threw at the call', shape(error));
            return {kind: 'threw at the call', error};
        }

        try {
            await result;
            t.record('resolved', 'no error');
            return {kind: 'resolved', error: null};
        } catch (error) {
            t.record('rejected with', shape(error));
            return {kind: 'rejected', error};
        }
    });
}

const PARENT_KEYS = ['name', 'message', 'fileName', 'lineNumber', 'stack'];
const parentShape = message => `name: string "Error"; message: string "${message}"; fileName: string "undefined"; lineNumber: number 0; stack: empty`;

export const tests = [

{
    id: 'R40.01',
    title: 'a rejection of browser.* answered from the parent process (windows.get, tabs.get, tabs.update with an id no window or tab has), a rejection with no receiver (runtime.sendMessage), a schema error at the call (tabs.get and tabs.update with -1, tabs.get with a string), and the control: new Error(message, undefined)',
    async run(t) {
        await t.step("new Error('message', undefined) - the control", () => {
            const error = new Error('message', undefined);

            t.record('made', shape(error));
            t.expect('an explicit undefined as the file name becomes the string "undefined" (BEHAVIOR-ERRORS.md §1)', shape(error, ['fileName']), 'fileName: string "undefined"');
        });

        await t.step("new Error('message') - one argument", () => {
            const error = new Error('message');

            t.record('made', shape(error));
            t.expect('one argument: the file of the caller (§1)', shape(error, ['fileName']), OWN_FILE);
        });

        {
            const {kind, error} = await tryCall(t, 'browser.windows.get(UNKNOWN_ID)', () => browser.windows.get(UNKNOWN_ID));

            t.expect('a rejection answered from the parent process: the file name is the string "undefined", the line is 0, the stack is empty (§1)', [kind, shape(error, PARENT_KEYS)], ['rejected', parentShape(`Invalid window ID: ${UNKNOWN_ID}`)]);
        }

        await tryCall(t, 'browser.tabs.get(UNKNOWN_ID)', () => browser.tabs.get(UNKNOWN_ID));
        await tryCall(t, 'browser.tabs.update(UNKNOWN_ID, {active: true})', () => browser.tabs.update(UNKNOWN_ID, {active: true}));

        {
            const {kind, error} = await tryCall(t, 'browser.runtime.sendMessage({}) - no receiver', () => browser.runtime.sendMessage({}));

            t.expect('a rejection with no receiver: the file and the line of the caller (§2)', [kind, shape(error, ['fileName', 'lineNumber'])], ['rejected', `${OWN_FILE}; lineNumber: number >0`]);
        }

        for (const [label, call] of [
            ['browser.tabs.get(-1)', () => browser.tabs.get(-1)],
            ['browser.tabs.update(-1, {active: true})', () => browser.tabs.update(-1, {active: true})],
            ["browser.tabs.get('x')", () => browser.tabs.get('x')],
        ]) {
            const {kind, error} = await tryCall(t, `${label} - a schema error`, call);

            t.expect(`${label}: a schema error is thrown at the call, with the file and the line of the caller (§2)`, [kind, shape(error, ['name', 'fileName', 'lineNumber'])], ['threw at the call', `name: string "Error"; ${OWN_FILE}; lineNumber: number >0`]);
        }
    },
},

{
    id: 'R40.02',
    title: 'a DOMException: made by the test, the same after structuredClone, the AbortError fetch rejects with on an aborted signal, the DataCloneError structuredClone throws on a function',
    async run(t) {
        const made = new DOMException('message', 'AbortError');

        await t.step("new DOMException('message', 'AbortError')", () => {
            t.record('made', shape(made));
            t.expect('a DOMException is an error to Error.isError and instanceof Error, names its file filename and has no fileName (§3)', shape(made, ['Error.isError', 'instanceof Error', 'fileName', 'filename', 'lineNumber', 'code']), 'Error.isError: true; instanceof Error: true; fileName: absent; filename: string "<own page>/tests/round-40.js"; lineNumber: number >0; code: number 20');
        });

        await t.step('structuredClone(the DOMException)', () => {
            const clone = structuredClone(made);

            t.record('the clone', shape(clone));
            t.expect('the clone keeps the name and the message and loses the place: an empty filename, line and column 0, an empty stack (§3)', shape(clone, ['name', 'message', 'filename', 'lineNumber', 'columnNumber', 'stack']), 'name: string "AbortError"; message: string "message"; filename: string ""; lineNumber: number 0; columnNumber: number 0; stack: empty');
        });

        {
            const {kind, error} = await tryCall(t, 'fetch(an own page, {signal: AbortSignal.abort()})', () => fetch(SCENE_URL, {signal: AbortSignal.abort()}));

            t.expect('fetch on an aborted signal rejects with an AbortError DOMException that has the place of the call (§3)', [kind, shape(error, ['instanceof DOMException', 'name', 'fileName', 'lineNumber'])], ['rejected', 'instanceof DOMException: true; name: string "AbortError"; fileName: absent; lineNumber: number >0']);
        }

        {
            const {kind, error} = await tryCall(t, 'structuredClone(() => {})', () => structuredClone(() => {}));

            t.expect('structuredClone of a function throws a DataCloneError DOMException at the call (§3)', [kind, shape(error, ['instanceof DOMException', 'name', 'fileName', 'lineNumber'])], ['threw at the call', 'instanceof DOMException: true; name: string "DataCloneError"; fileName: absent; lineNumber: number >0']);
        }
    },
},

{
    id: 'R40.03',
    title: 'an Error across structuredClone: a custom name, own properties lang and arguments, a cause, an assigned stack; and an Error renamed after a standard one',
    async run(t) {
        const custom = new Error('message', {cause: {a: 1}});

        custom.name = 'CustomError';
        custom.lang = 'key';
        custom.arguments = [1, 'two'];
        custom.stack = 'assigned stack';

        await t.step("an Error with name 'CustomError', lang, arguments, cause {a: 1} and stack 'assigned stack'", () => {
            t.record('the original', shape(custom));
            t.expect('the original carries them as own keys (§4)', shape(custom, ['name', 'stack', 'cause', 'own keys']), 'name: string "CustomError"; stack: 1 frame(s), first: assigned stack; cause: object {"a":1}; own keys: [name, lang, arguments, stack]');
        });

        await t.step('structuredClone(the Error)', () => {
            const clone = structuredClone(custom);

            t.record('the clone', shape(clone));
            t.expect('the clone: the custom name becomes Error, the own keys are gone, the cause stays (§4)', shape(clone, ['name', 'message', 'cause', 'own keys']), 'name: string "Error"; message: string "message"; cause: object {"a":1}; own keys: []');
            t.expect('the assigned stack string does not survive the clone (§4)', clone.stack === custom.stack, false);
        });

        const renamed = new Error('message');

        renamed.name = 'RangeError';

        await t.step("an Error renamed to 'RangeError', then structuredClone", () => {
            const clone = structuredClone(renamed);

            t.record('the original', shape(renamed));
            t.record('the clone', shape(clone));
            t.expect('a standard name survives the clone (§4)', shape(clone, ['name', 'own keys']), 'name: string "RangeError"; own keys: []');
        });
    },
},

{
    id: 'R40.04',
    title: 'an object of a page of the add-on after the page is closed: Error.isError, typeof, JSON.stringify, Object.keys and the in operator on it, before and after the close',
    async run(t) {
        const url = sceneUrl('dead');
        const win = await browser.windows.create({url});

        openedWindows.add(win.id);

        const viewOf = () => browser.extension.getViews({type: 'tab'}).find(view => view.location.href === url);

        t.require('the page of the window is among extension.getViews', await until(() => Boolean(viewOf())), 'no view with the url of the page');

        const view = viewOf();
        const probe = new view.Object();
        const pageDocument = view.document;

        probe.a = 1;

        const answers = value => [
            `Error.isError: ${isError(value)}`,
            `typeof: ${outcome(() => typeof value)}`,
            `JSON.stringify: ${outcome(() => JSON.stringify(value))}`,
            `Object.keys: ${outcome(() => Object.keys(value))}`,
            `'a' in: ${outcome(() => 'a' in value)}`,
        ];

        await t.step('the page is open: an object made by its Object and its document', () => {
            t.record('new view.Object() with a = 1', answers(probe).join('; '));
            t.record('view.document', answers(pageDocument).join('; '));
            t.expect('a live object of another page: Error.isError answers false, nothing throws (§5)', answers(probe), ['Error.isError: false', 'typeof: gives "object"', 'JSON.stringify: gives "{\\"a\\":1}"', 'Object.keys: gives ["a"]', "'a' in: gives true"]);
        });

        await t.step('browser.windows.remove(the window of the page)', () => browser.windows.remove(win.id));

        const dead = await until(() => {
            try {
                return probe.a !== 1;
            } catch {
                return true;
            }
        });

        t.note(dead ? 'the object stopped answering after the close' : `the object still answers ${SETTLE_TIMEOUT} ms after the close`);

        await t.step('the page is closed: the same object and document', () => {
            t.record('new view.Object() with a = 1', answers(probe).join('; '));
            t.record('view.document', answers(pageDocument).join('; '));
            t.expect('a dead object: Error.isError, JSON.stringify, Object.keys and in throw, typeof answers (§5)', answers(probe), [`Error.isError: ${DEAD}`, 'typeof: gives "object"', `JSON.stringify: ${DEAD}`, `Object.keys: ${DEAD}`, `'a' in: ${DEAD}`]);
        });
    },
},

];
