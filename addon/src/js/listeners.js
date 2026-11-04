/*
One real browser listener per event, registered while this module is evaluated, so only a static import subscribes; the
handlers of the add-on are added later. The events that come before the first handler are kept and replayed to it (the keys
of PREF_RULES). Several handlers of one event are indistinguishable from several real listeners: the answers of messages,
blocking requests and proxies are combined by the rules of the browser, every handler gets its own copy of the arguments, a
handler that throws is reported as uncaught and the others still run.

import Listeners, {getExtensionStartTime} from '/js/listeners.js\
?extension.onStart\
&webRequest.onBeforeRequest=[{"urls":["<all_urls>"],"types":["main_frame"]},["blocking"]]\
&tabs.onCreated={"keepAllPending":true}\
&windows.onCreated';

The value of an event: an array - the arguments of addListener after the listener; an object - the prefs of this
subscription (the keys of PREF_RULES marked query) with the arguments in "args". The value is read as a query string:
"&", "#" and "+" inside it are written as %26, %23 and %2B. The same query from two modules is one instance: one set of
handlers, one kept list.

const off = Listeners.tabs.onCreated.add(handler);            // the kept events are replayed to the first handler; off() removes it
Listeners.tabs.onCreated.add(handler, {waitListener: false}); // takes nothing kept
Listeners.tabs.onCreated.remove(handler);                     // true when it was there
Listeners.tabs.onCreated.has(handler);
Listeners.tabs.onCreated.clear();                             // removes every handler, the real listener stays; returns the count
Listeners.tabs.onCreated.unsubscribe();                       // removes the real listener, the handlers and the kept events; add() throws after it

extension.onStart and extension.onWake are own events: the background writes its start time into storage.session once; a
context that loads with no time there gets onStart, with a time already there onWake (a page opened after the start gets
onWake at every open). They need the storage permission.

The schemes of the add-on itself, for events this module has no scheme for and for own events (the "event" key): a module
evaluated before every instance of this one, the first import of every entry, puts a Map of name → scheme (the keys of
PREF_RULES) on self[Symbol.for('__listeners_custom_event_schemes__')]; a name this module has throws.

What differs from the browser on purpose: the error event of a message handler that throws carries the thrown object, not a
copy; a rejected promise of a handler of an ordinary event stays an unhandled rejection of the page; proxy.onError does not
fire for a rejected handler, and the proxy handlers run at once, not one after another; a CSP header and a header name that
appears twice are not merged between handlers; a message that comes after the last handler was removed waits for a handler
like one before the first, up to pendingPromiseTimeout.
*/

const Listeners = {};

const ON_EXTENSION_START_TIME_STORAGE_KEY = '__ext_start_time';
const GENERATED_BACKGROUND_PAGE = '_generated_background_page.html'; // the page the browser makes for background.scripts
const {background: BACKGROUND = {}} = browser.runtime.getManifest();
// the manifest takes bg.html, ./bg.html and /bg.html alike, and runtime.getURL concatenates as it is: resolved as the browser does
const BACKGROUND_URL = new URL(BACKGROUND.page ?? BACKGROUND.service_worker ?? GENERATED_BACKGROUND_PAGE, browser.runtime.getURL(''));
const IS_BACKGROUND_PAGE = self.location.origin + self.location.pathname === BACKGROUND_URL.href;

const EXTENSION_START_TIME_PROMISE_SYMBOL = Symbol.for('__listeners_extension_start_time_promise__');
const CUSTOM_EVENT_SCHEMES_SYMBOL = Symbol.for('__listeners_custom_event_schemes__');
// one read per page, shared by the instances through the symbol, made by the first start event
const getExtensionStartTimePromise = () => self[EXTENSION_START_TIME_PROMISE_SYMBOL] ??= readExtensionStartTime();

const isBoolean = value => typeof value === 'boolean';
const isFunction = value => typeof value === 'function';
const isInteger = (value, min = 0, max = Infinity) => Number.isInteger(value) && value >= min && value <= max;
const isEvent = value => ['addListener', 'removeListener', 'hasListener'].every(method => isFunction(value?.[method]));
const isOn = value => value !== false && value !== null; // a boolean key is on when true, a nullable key when it holds a value: 0 is on

// the keys of a scheme and of a query, and their rules
const PREF_RULES = {
    // keep what came while there was no listener and give it to the first listener added (the option of add() too); false: nothing is kept
    waitListener: {default: true, isValid: isBoolean, query: true},
    // keep every event, not only the last one
    keepAllPending: {default: false, isValid: isBoolean, query: true, needs: ['waitListener', 'canKeepAllPending'], excludes: ['returnPromise', 'calledOnce']},
    // every event of this one is a fact of its own, not a state: keepAllPending may be set, by the scheme or by the query
    canKeepAllPending: {default: false, isValid: isBoolean},
    // ms a returnPromise event waits for a listener before noListenerPromiseHandler answers it
    pendingPromiseTimeout: {default: 8_000, isValid: isInteger, query: true, needs: ['waitListener', 'returnPromise']},
    // every delivery of the event is kept and reaches every listener once; a listener added later gets the latest one
    calledOnce: {default: false, isValid: isBoolean, query: true, needs: ['waitListener'], excludes: ['returnPromise']},
    // the browser takes an answer from the listener: the outcomes of the handlers are combined into one by combineAnswers
    returnPromise: {default: false, isValid: isBoolean, needs: ['noListenerPromiseHandler', 'combineAnswers']},
    // noListenerPromiseHandler(...args): the answer of a returnPromise event that no listener handled
    noListenerPromiseHandler: {default: null, isValid: isFunction, needs: ['returnPromise']},
    // combineAnswers(outcomes, args): one answer out of the outcomes of the handlers, {result, threw, error, response} each, in the order of adding
    combineAnswers: {default: null, isValid: isFunction, needs: ['returnPromise']},
    // the index of the argument a handler answers through (sendResponse, asyncCallback): every handler gets one of its own
    answerArg: {default: null, isValid: isInteger, needs: ['returnPromise']},
    // the browser takes the answer only through that argument and ignores the return value (asyncBlocking)
    answerOnlyThroughArg: {default: false, isValid: isBoolean, needs: ['answerArg']},
    // the handlers get the very arguments the browser gave, one object for all (a message, a port, an argument that cannot be
    // cloned); false: every handler gets a structured clone of each argument that is not a function
    sharedArgs: {default: false, isValid: isBoolean, query: true},
    // the event object of an own event, with the methods of events.Event, instead of browser.<name>
    event: {default: null, isValid: isEvent},
};

for (const [key, {needs = [], excludes = []}] of Object.entries(PREF_RULES)) {
    for (const other of [...needs, ...excludes]) {
        if (!Object.hasOwn(PREF_RULES, other)) {
            throw new Error(`Unknown key "${other}" in the rule of "${key}"`);
        }
    }
}

const DEFAULT_PREFS = Object.fromEntries(Object.entries(PREF_RULES).map(([key, rule]) => [key, rule.default]));

const CUSTOM_EVENT_SCHEMES = new Map;

CUSTOM_EVENT_SCHEMES.set('extension.onStart', {
    calledOnce: true,
    event: createStartEvent(EXTENSION_START_TIME => !EXTENSION_START_TIME),
});

CUSTOM_EVENT_SCHEMES.set('extension.onWake', {
    calledOnce: true,
    event: createStartEvent(EXTENSION_START_TIME => Boolean(EXTENSION_START_TIME)),
});

for (const name of ['runtime.onMessage', 'runtime.onMessageExternal', 'runtime.onUserScriptMessage']) {
    CUSTOM_EVENT_SCHEMES.set(name, {
        sharedArgs: true,
        returnPromise: true,
        answerArg: 2,
        noListenerPromiseHandler: () => Promise.reject(new Error(`No listener for "${name}", please call back later`)),
        combineAnswers: combineMessageAnswers,
    });
}

for (const name of ['runtime.onConnect', 'runtime.onConnectExternal', 'runtime.onUserScriptConnect']) {
    CUSTOM_EVENT_SCHEMES.set(name, {
        sharedArgs: true, // a port cannot be cloned
        canKeepAllPending: true,
        keepAllPending: true, // every event is a port: a port nobody handled is lost for good
    });
}

// every event is a fact of its own, not a state: a subscription may keep all of them
const CAN_KEEP_ALL_PENDING_EVENTS = [
    'tabs.onCreated',
    'tabs.onUpdated',
    'tabs.onRemoved',
    'tabs.onMoved',
    'tabs.onAttached',
    'tabs.onDetached',
    'tabs.onReplaced',
    'windows.onCreated',
    'windows.onRemoved',
    'tabGroups.onCreated',
    'tabGroups.onUpdated',
    'tabGroups.onMoved',
    'tabGroups.onRemoved',
    'storage.onChanged',
    'storage.local.onChanged',
    'storage.sync.onChanged',
    'storage.session.onChanged',
    'storage.managed.onChanged',
    'bookmarks.onCreated',
    'bookmarks.onRemoved',
    'bookmarks.onChanged',
    'bookmarks.onMoved',
    'downloads.onCreated',
    'downloads.onChanged',
    'downloads.onErased',
    'history.onVisited',
    'history.onVisitRemoved',
    'history.onTitleChanged',
    'cookies.onChanged',
    'webNavigation.onBeforeNavigate',
    'webNavigation.onCommitted',
    'webNavigation.onDOMContentLoaded',
    'webNavigation.onCompleted',
    'webNavigation.onErrorOccurred',
    'webNavigation.onCreatedNavigationTarget',
    'webNavigation.onReferenceFragmentUpdated',
    'webNavigation.onHistoryStateUpdated',
    'webNavigation.onTabReplaced',
    'webRequest.onSendHeaders',
    'webRequest.onResponseStarted',
    'webRequest.onBeforeRedirect',
    'webRequest.onCompleted',
    'webRequest.onErrorOccurred',
    'menus.onClicked',
    'contextMenus.onClicked',
    'commands.onCommand',
    'alarms.onAlarm',
    'notifications.onClicked',
    'notifications.onClosed',
    'notifications.onButtonClicked',
    'notifications.onShown',
    'contextualIdentities.onCreated',
    'contextualIdentities.onUpdated',
    'contextualIdentities.onRemoved',
    'permissions.onAdded',
    'permissions.onRemoved',
    'management.onInstalled',
    'management.onUninstalled',
    'management.onEnabled',
    'management.onDisabled',
];

for (const name of CAN_KEEP_ALL_PENDING_EVENTS) {
    CUSTOM_EVENT_SCHEMES.set(name, {
        canKeepAllPending: true,
    });
}

CUSTOM_EVENT_SCHEMES.set('runtime.onInstalled', {
    calledOnce: true,
});

CUSTOM_EVENT_SCHEMES.set('runtime.onStartup', {
    calledOnce: true,
});

CUSTOM_EVENT_SCHEMES.set('runtime.onUpdateAvailable', {
    calledOnce: true,
});

for (const name of ['webRequest.onBeforeRequest', 'webRequest.onBeforeSendHeaders', 'webRequest.onHeadersReceived', 'webRequest.onAuthRequired']) {
    CUSTOM_EVENT_SCHEMES.set(name, {
        waitListener: false,
        returnPromise: true,
        noListenerPromiseHandler: () => ({}),
        combineAnswers: combineRequestAnswers,
    });
}

Object.assign(CUSTOM_EVENT_SCHEMES.get('webRequest.onAuthRequired'), {
    answerArg: 1, // asyncCallback of a subscription with "asyncBlocking"
    answerOnlyThroughArg: true,
});

CUSTOM_EVENT_SCHEMES.set('proxy.onRequest', {
    waitListener: false,
    returnPromise: true,
    noListenerPromiseHandler: () => undefined,
    combineAnswers: combineProxyAnswers,
});

for (const [name, scheme] of self[CUSTOM_EVENT_SCHEMES_SYMBOL] ?? []) {
    if (CUSTOM_EVENT_SCHEMES.has(name)) {
        throw new Error(`The scheme of "${name}" is already in the module`);
    }

    CUSTOM_EVENT_SCHEMES.set(name, scheme);
}

// subscribed or not: a slip in a scheme breaks at the first start
for (const [name, scheme] of CUSTOM_EVENT_SCHEMES) {
    for (const key of Object.keys(scheme)) {
        if (!Object.hasOwn(PREF_RULES, key)) {
            throw new Error(`Unknown key "${key}" in the scheme of "${name}"`);
        }
    }

    checkPrefs({...DEFAULT_PREFS, ...scheme}, name);
}

function checkPrefs(prefs, eventName) {
    for (const [key, {default: defaultValue, isValid, needs = [], excludes = []}] of Object.entries(PREF_RULES)) {
        const value = prefs[key];

        if (value === defaultValue) {
            continue;
        }

        if (!isValid(value)) {
            throw new Error(`Invalid value of "${key}" for "${eventName}": ${value}`);
        }

        if (!isOn(value)) {
            continue;
        }

        for (const other of needs) {
            if (!isOn(prefs[other])) {
                throw new Error(`"${key}" needs "${other}" for "${eventName}"`);
            }
        }

        for (const other of excludes) {
            if (isOn(prefs[other])) {
                throw new Error(`"${key}" excludes "${other}" for "${eventName}"`);
            }
        }
    }
}

// the race of the browser (ExtensionChild.sys.mjs, MessageEvent.emit): the first settled answer wins
function combineMessageAnswers(outcomes) {
    const answers = [];

    for (const {result, threw, error, response} of outcomes) {
        if (threw) {
            answers.push(Promise.reject(error));
        } else if (result instanceof Promise) {
            answers.push(settledLater(result));
        } else if (result === true && response) {
            answers.push(settledLater(response.promise));
        } else if (response?.called) {
            answers.push(response.promise);
        }
    }

    return answers.length ? Promise.race(answers) : undefined;
}

// a promise settled one turn after the given one: in the race of the answers a returned promise loses to a throw and to a
// sendResponse called at once, as it does in the browser
const settledLater = promise => new Promise((resolve, reject) => promise.then(resolve, reject));

const HEADER_KINDS = ['requestHeaders', 'responseHeaders'];
const REJECTED = Symbol('a handler that threw or rejected');

// as WebRequest.sys.mjs applyChanges: the results in the order of adding, each awaited in its turn, the first cancel or
// redirectUrl ends it
async function combineRequestAnswers(outcomes, [details]) {
    const answer = {};
    const kind = HEADER_KINDS.find(kind => Array.isArray(details[kind])); // present when the subscription asked for the headers
    const origHeaders = kind ? headersByName(details[kind]) : null; // as the browser gave them
    let merged = null; // as the handlers left them

    // subscribed before any decision: a rejection after the result that decided is nothing, as in the browser
    const values = [];

    for (const {result, threw, response} of outcomes) {
        if (threw) {
            values.push(REJECTED);
        } else if (response) {
            values.push(response.promise.catch(() => REJECTED));
        } else {
            values.push(Promise.resolve(result).catch(() => REJECTED));
        }
    }

    for (const promise of values) {
        const value = await promise;

        if (value === REJECTED || !value || typeof value !== 'object') {
            continue;
        }

        if (value.authCredentials && !answer.authCredentials) {
            answer.authCredentials = value.authCredentials;
        }

        if (value.cancel) {
            return {cancel: true};
        }

        if (value.redirectUrl) {
            return {redirectUrl: value.redirectUrl};
        }

        if (value.upgradeToSecure) {
            answer.upgradeToSecure = true;
        }

        if (kind && Array.isArray(value[kind])) {
            merged ??= new Map(origHeaders);
            applyHeaderChanges(merged, origHeaders, headersByName(value[kind]));
        }
    }

    if (merged) {
        answer[kind] = [...merged.values()];
    }

    return answer;
}

function headersByName(headers) {
    return new Map(headers.map(header => [header.name.toLowerCase(), header]));
}

// as HeaderChanger.applyChanges of WebRequest.sys.mjs: the list a handler returns is its changes against the original headers,
// not the result - an original header missing from the list is removed, a new or changed one is set, the rest stays; so an
// addition of one handler survives the list of the next, and an omission of any one handler removes the header
function applyHeaderChanges(merged, origHeaders, newHeaders) {
    for (const name of origHeaders.keys()) {
        if (!newHeaders.has(name)) {
            merged.delete(name);
        }
    }

    for (const [name, header] of newHeaders) {
        const original = origHeaders.get(name);

        if (!original || original.value !== header.value || original.binaryValue !== header.binaryValue) {
            merged.set(name, header);
        }
    }
}

// as ProxyChannelFilter.sys.mjs createProxyInfoFromData: a result does not replace the chain so far, it goes before it, and the
// chain so far becomes its failover
async function combineProxyAnswers(outcomes) {
    let chain; // undefined: nothing, the browser decides; null: a direct connection; an array: the proxies, the first one first

    for (const {result, threw} of outcomes) {
        if (threw) {
            continue;
        }

        let value;

        try {
            value = await result;
        } catch {
            continue; // as the browser: a rejected handler keeps the chain so far
        }

        if (value === undefined) {
            continue;
        }

        if (value === null) {
            chain = null;
            continue;
        }

        const entries = [];

        for (const entry of Array.isArray(value) ? value : [value]) {
            if (entry === null || entry === undefined) {
                entries.push(null); // a null entry ends the list: nothing comes after it
                break;
            }

            if (entry.type?.toLowerCase() === 'direct' && chain !== undefined) {
                break; // a direct entry after a result: what is so far stays, the rest of the list is dropped
            }

            entries.push(entry);
        }

        if (!entries.length) {
            continue;
        }

        if (entries.at(-1) === null || chain === undefined) {
            chain = entries;
        } else {
            chain = [...entries, ...(chain ?? [null])];
        }
    }

    return chain;
}

function createResponse() {
    const deferred = Promise.withResolvers();
    const response = {
        promise: deferred.promise,
        called: false,
        resolve(value) {
            response.called = true;
            deferred.resolve(value);
        },
    };

    return response;
}

// its own copy for every handler, as every real listener gets one; the functions of the browser stay
function cloneArgs(args) {
    return args.map(arg => isFunction(arg) ? arg : structuredClone(arg));
}

const subscribedEventNames = new Set;
for (const [eventName, json] of new URL(import.meta.url).searchParams) {
    if (subscribedEventNames.has(eventName)) {
        throw new Error(`Duplicate event "${eventName}" in the query`);
    }

    subscribedEventNames.add(eventName);

    const prefs = {
        name: eventName,
        ...DEFAULT_PREFS,
        ...CUSTOM_EVENT_SCHEMES.get(eventName),
    };

    let eventArgs = [];

    if (json) {
        let value;

        try {
            value = JSON.parse(json);
        } catch {
            throw new Error(`Invalid JSON value for listener event "${eventName}" json: ${json}`);
        }

        if (value === null || typeof value !== 'object') {
            throw new Error(`The value of "${eventName}" must be an array or an object`);
        }

        const {args = [], ...queryPrefs} = Array.isArray(value) ? {args: value} : value;

        if (!Array.isArray(args)) {
            throw new Error(`Arguments for "${eventName}" must be an array!`);
        }

        for (const key of Object.keys(queryPrefs)) {
            if (!PREF_RULES[key]?.query) {
                throw new Error(`"${key}" cannot be set in the query of "${eventName}"`);
            }
        }

        eventArgs = args;
        Object.assign(prefs, queryPrefs);
    }

    checkPrefs(prefs, eventName);
    createMockedListener(prefs, eventArgs);
}

function createMockedListener(prefs, eventArgs) {
    const listeners = new Set;
    const calledOnceListeners = new Set;
    let pendingArgsList = []; // the args of the events that came while there was no listener
    let pending = null;

    const event = prefs.event
        ?? prefs.name.split('.').reduce((obj, namePart) => obj?.[namePart], browser);

    if (!event) {
        throw new Error(`Event object for "${prefs.name}" listener not found!`);
    }

    if (!isEvent(event)) {
        throw new Error(`"${prefs.name}" is not an event object`);
    }

    event.addListener(realListener, ...eventArgs);

    function answerPending(waiting, answer) {
        self.clearTimeout(waiting.timer);
        waiting.resolve(answer);
    }

    // taken out before a replay: an add from a replayed handler replays nothing twice; a calledOnce event stays kept
    function takePendingArgsList() {
        const kept = pendingArgsList;

        if (!prefs.calledOnce) {
            pendingArgsList = [];
        }

        return kept;
    }

    function dropPending() {
        if (pending) {
            const args = pendingArgsList[0];

            answerPending(pending, answerBrowser(prefs.noListenerPromiseHandler(...args), answerCallbackOf(args)));
            pending = null;
        }

        takePendingArgsList();
    }

    function processListeners(args) {
        const outcomes = [];
        const answerCallback = answerCallbackOf(args);

        // a snapshot, as in the browser: a handler added during the dispatch is not called for it, one removed before its turn is skipped
        for (const listener of [...listeners]) {
            if (!listeners.has(listener)) {
                continue;
            }

            if (prefs.calledOnce) {
                if (calledOnceListeners.has(listener)) {
                    continue;
                }

                calledOnceListeners.add(listener);
            }

            const outcome = {result: undefined, threw: false, error: undefined, response: null};
            const ownArgs = prefs.sharedArgs ? args : cloneArgs(args);

            if (answerCallback) {
                outcome.response = createResponse();
            }

            try {
                if (outcome.response) {
                    outcome.result = listener(...ownArgs.with(prefs.answerArg, outcome.response.resolve));
                } else {
                    outcome.result = listener(...ownArgs);
                }
            } catch (error) {
                outcome.threw = true;
                outcome.error = error;
                self.reportError(error); // as the browser reports a listener that throws: the error event of the window and the console
            }

            outcomes.push(outcome);
        }

        if (prefs.returnPromise) {
            return answerBrowser(prefs.combineAnswers(outcomes, args), answerCallback);
        }
    }

    function answerCallbackOf(args) {
        if (prefs.answerArg !== PREF_RULES.answerArg.default && isFunction(args[prefs.answerArg])) {
            return args[prefs.answerArg];
        }

        return null;
    }

    function answerBrowser(answer, answerCallback) {
        if (prefs.answerOnlyThroughArg && answerCallback) {
            Promise.resolve(answer).then(answerCallback); // the answer may be a promise, the callback takes the value
            return;
        }

        return answer;
    }

    function add(listener, {waitListener = prefs.waitListener} = {}) {
        if (!event.hasListener(realListener)) {
            throw new Error(`"${prefs.name}" is unsubscribed, a handler cannot be added`);
        }

        if (!has(listener)) {
            listeners.add(listener);

            if (waitListener) {
                for (const args of takePendingArgsList()) {
                    // a handler may unsubscribe while it runs: the message it handles still gets its answer
                    const waiting = pending;
                    pending = null;

                    const answer = processListeners(args);

                    if (waiting) {
                        answerPending(waiting, answer);
                    }
                }
            } else if (prefs.calledOnce && pendingArgsList.length) {
                calledOnceListeners.add(listener); // declined the event that already came: it had its once
            }

            dropPending();
        }

        return () => remove(listener);
    }

    function remove(listener) {
        const deleted = listeners.delete(listener);
        calledOnceListeners.delete(listener);
        return deleted;
    }

    function has(listener) {
        return listeners.has(listener);
    }

    function clear() {
        const size = listeners.size;
        listeners.clear();
        calledOnceListeners.clear();
        return size;
    }

    function unsubscribe() {
        event.removeListener(realListener);
        clear();
        dropPending();
        pendingArgsList = [];
    }

    function realListener(...args) {
        if (listeners.size) {
            if (prefs.calledOnce) {
                pendingArgsList = [args]; // the latest delivery: a handler added later gets it once as well
                calledOnceListeners.clear(); // every delivery reaches every handler once
            }

            return processListeners(args);
        }

        if (prefs.waitListener) {
            if (prefs.returnPromise) {
                dropPending();
                pending = Promise.withResolvers();
                pendingArgsList = [args];
                pending.timer = self.setTimeout(dropPending, prefs.pendingPromiseTimeout);
                return pending.promise;
            }

            if (prefs.keepAllPending) {
                pendingArgsList.push(args);
            } else {
                pendingArgsList = [args];
            }
        } else if (prefs.returnPromise) {
            return answerBrowser(prefs.noListenerPromiseHandler(...args), answerCallbackOf(args));
        }
    }

    prefs.name.split('.').reduce((schema, namePart, index, selfArr) => {
        if (index < selfArr.length - 1) {
            return schema[namePart] ??= {};
        }

        schema[namePart] = {add, remove, has, clear, unsubscribe};
    }, Listeners);
}

// an own event: its one listener is called when fires(startTime) says so
function createStartEvent(fires) {
    let listener = null;

    return {
        async addListener(realListener) {
            listener = realListener;

            const EXTENSION_START_TIME = await getExtensionStartTimePromise();

            if (listener && fires(EXTENSION_START_TIME)) {
                listener();
            }
        },
        removeListener(realListener) {
            if (listener === realListener) {
                listener = null;
            }
        },
        hasListener(realListener) {
            return listener === realListener;
        },
    };
}

// the time as it was before this load; written only by a fresh start of the background
async function readExtensionStartTime() {
    const EXTENSION_START_TIME = await getExtensionStartTime();

    if (!EXTENSION_START_TIME && IS_BACKGROUND_PAGE) {
        await setExtensionStartTime(Date.now());
    }

    return EXTENSION_START_TIME;
}

export async function getExtensionStartTime() {
    const storage = await browser.storage.session.get(ON_EXTENSION_START_TIME_STORAGE_KEY);
    return storage[ON_EXTENSION_START_TIME_STORAGE_KEY];
}

async function setExtensionStartTime(EXTENSION_START_TIME) {
    await browser.storage.session.set({
        [ON_EXTENSION_START_TIME_STORAGE_KEY]: EXTENSION_START_TIME,
    });
}

export default Object.freeze(Listeners);
