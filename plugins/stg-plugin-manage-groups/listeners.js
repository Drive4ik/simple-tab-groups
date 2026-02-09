/*
use like:
import Listeners from './listeners.js?runtime.onInstalled&tabs.onCreated';
var unsubscribeSomeFuncListener = Listeners.runtime.onInstalled.add(someFunc);
Listeners.runtime.onInstalled.remove(someFunc); // return is someFunc was removed
Listeners.tabs.onCreated.has(someFunc); // return true if someFunc in listeners list
Listeners.tabs.onCreated.clear(); // remove all listeners, ! but doesn't unsubscribe from real browser listeners. return deleted listeners count
*/

const Listeners = {};

const ON_EXTENSION_START_TIME_STORAGE_KEY = '__ext_start_time';

const DEFAULT_EVENT_PREFS = {
    waitListener: true,
    pendingPromiseTimeout: 8_000, // used only if waitListener && returnPromise are true
    calledOnce: false, // an event that is triggered once
};

const mockedEventNames = new Set;
const CUSTOM_EVENT_SCHEMES = new Map;

CUSTOM_EVENT_SCHEMES.set('onExtensionStart', {
    calledOnce: true,
    event: {
        async addListener(realListener) {
            const isFirstGlobalPromise = !self.__extensionStartPromise;
            const EXTENSION_START_TIME = await (self.__extensionStartPromise ??= getExtensionStartTime());

            if (!EXTENSION_START_TIME) {
                if (isFirstGlobalPromise) {
                    await setExtensionStartTime(Date.now());
                }

                realListener();
            }

            delete self.__extensionStartPromise;
        },
    },
});

CUSTOM_EVENT_SCHEMES.set('runtime.onMessage', {
    returnPromise: true,
    noListenerPromiseHandler: () => Promise.reject(new Error('No listener for "runtime.onMessage", please call back later')),
});

CUSTOM_EVENT_SCHEMES.set('runtime.onMessageExternal', {
    returnPromise: true,
    noListenerPromiseHandler: () => Promise.reject(new Error('No listener for "runtime.onMessageExternal", please call back later')),
});

CUSTOM_EVENT_SCHEMES.set('runtime.onInstalled', {
    calledOnce: true,
});

CUSTOM_EVENT_SCHEMES.set('runtime.onStartup', {
    calledOnce: true,
});

CUSTOM_EVENT_SCHEMES.set('runtime.onUpdateAvailable', {
    calledOnce: true,
});

CUSTOM_EVENT_SCHEMES.set('webRequest.onBeforeRequest', {
    waitListener: false,
    returnPromise: true,
    noListenerPromiseHandler: () => ({}),
    async resoveMultipleListeners(promises) {
        const outcome = {
            canceled: false,
            redirectUrl: null,
        };

        const responses = await Promise.all(promises);

        for (let response of responses) {
            response ??= {};

            if (response.cancel) {
                outcome.canceled = true;
                break;
            }

            outcome.redirectUrl ??= response.redirectUrl;
        }

        if (outcome.canceled) {
            return {cancel: true};
        } else if (outcome.redirectUrl) {
            return {redirectUrl: outcome.redirectUrl};
        }

        return {};
    },
});

for (const [eventName, eventJsonParameters] of new URL(import.meta.url).searchParams) {
    if (mockedEventNames.has(eventName)) {
        throw new Error(`Detect duplicate ${eventName}`);
    }

    mockedEventNames.add(eventName);

    const eventPrefs = {
        name: eventName,
        ...DEFAULT_EVENT_PREFS,
    };

    Object.assign(eventPrefs, CUSTOM_EVENT_SCHEMES.get(eventPrefs.name));

    if (eventPrefs.returnPromise && eventPrefs.calledOnce) {
        throw new Error(`returnPromise and calledOnce cannot be true at the same time for ${eventPrefs.name}`);
    }

    let eventParameters = [];

    if (eventJsonParameters) {
        try {
            eventParameters = JSON.parse(eventJsonParameters);
        } catch {
            throw new Error(`Invalid JSON value for listener event "${eventPrefs.name}" json: ${eventJsonParameters}`);
        }

        if (!Array.isArray(eventParameters)) {
            throw new Error(`Arguments for "${eventPrefs.name}" must be an array!`);
        }
    }

    createMockedListener(eventPrefs, ...eventParameters);
}

function createMockedListener(eventPrefs, ...eventParameters) {
    const listeners = new Set;
    const calledOnceListeners = new Set;
    let pendingArgs = null;
    let pending = null;

    const event = eventPrefs.event
        ?? eventPrefs.name.split('.').reduce((obj, eventNamePart) => obj?.[eventNamePart], browser);

    if (!event) {
        throw new Error(`Event object for "${eventPrefs.name}" listener not found!`);
    }

    event.addListener(realListener, ...eventParameters);

    function settlePending() {
        self.clearTimeout(pending?.timer);
        pending?.resolve(eventPrefs.noListenerPromiseHandler(...(pendingArgs ?? [])));
        if (!eventPrefs.calledOnce) {
            pendingArgs = null;
        }
        pending = null;
    }

    function processListeners(args) {
        const promises = [];

        for (const listener of listeners) {
            if (eventPrefs.calledOnce) {
                if (calledOnceListeners.has(listener)) {
                    continue;
                }

                calledOnceListeners.add(listener);
            }

            try {
                const result = listener(...args);

                if (eventPrefs.returnPromise) {
                    promises.push(result);
                }
            } catch (e) {
                console.error('Catch error:', e, 'when calling listener:', listener, 'with args:', args, 'event name:', eventPrefs.name);

                if (eventPrefs.returnPromise) {
                    return Promise.reject(e);
                }
            }
        }

        if (eventPrefs.returnPromise) {
            let response = eventPrefs.resoveMultipleListeners?.(promises);
            response ??= promises.find(v => v instanceof Promise);
            response ??= promises.find(v => v);
            return response;
        }
    }

    function add(listener, {waitListener = eventPrefs.waitListener} = {}) {
        if (!has(listener)) {
            listeners.add(listener);

            if (waitListener && pendingArgs) {
                const promisedResult = processListeners(pendingArgs);

                if (eventPrefs.returnPromise) {
                    pending.resolve(promisedResult);
                }
            }

            settlePending();
        }

        return () => remove(listener);
    }

    function remove(listener) {
        const deleted = listeners.delete(listener);
        calledOnceListeners.delete(listener);
        settlePending();
        return deleted;
    }

    function has(listener) {
        return listeners.has(listener);
    }

    function clear() {
        const size = listeners.size;
        listeners.clear();
        calledOnceListeners.clear();

        // if (fullUnsubscribe) {
        //     event.removeListener?.(realListener);
        // }
        return size;
    }

    function realListener(...args) {
        if (listeners.size) {
            return processListeners(args);
        }

        if (eventPrefs.waitListener) {
            if (eventPrefs.returnPromise) {
                settlePending();
                pending = Promise.withResolvers();
                pendingArgs = args;
                pending.timer = self.setTimeout(settlePending, eventPrefs.pendingPromiseTimeout);
                return pending.promise;
            }

            pendingArgs = args;
        } else if (eventPrefs.returnPromise) {
            return eventPrefs.noListenerPromiseHandler(...args);
        }
    }

    eventPrefs.name.split('.').reduce((schema, eventNamePart, index, selfArr) => {
        if (index < selfArr.length - 1) {
            return schema[eventNamePart] ??= {};
        }

        schema[eventNamePart] = {add, remove, has, clear};
    }, Listeners);
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
