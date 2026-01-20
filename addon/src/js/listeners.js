
const listeners = {};

export const CUSTOM_EVENT_SCHEMES = new Map;

export const ON_EXTENSION_START_TIME_STORAGE_KEY = '__ext_start_time';
CUSTOM_EVENT_SCHEMES.set('onExtensionStart', {
    event: {
        timer: 0,
        async addListener(listener, {delay = 0} = {}) {
            const storage = await browser.storage.session.get(ON_EXTENSION_START_TIME_STORAGE_KEY);

            if (!storage[ON_EXTENSION_START_TIME_STORAGE_KEY]) {
                await browser.storage.session.set({
                    [ON_EXTENSION_START_TIME_STORAGE_KEY]: Date.now(),
                });
                this.timer = self.setTimeout(listener, delay);
            }
        },
        removeListener() {
            self.clearTimeout(this.timer);
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

CUSTOM_EVENT_SCHEMES.set('webRequest.onBeforeRequest', {
    waitListener: false,
    returnPromise: true,
    noListenerPromiseHandler: () => ({}),
});

const DEFAULT_EVENT_PREFS = {
    waitListener: true,
};

for (const [eventName, eventJsonParameters] of new URL(import.meta.url).searchParams) {
    const eventPrefs = {
        name: eventName,
        ...DEFAULT_EVENT_PREFS,
    };

    Object.assign(eventPrefs, CUSTOM_EVENT_SCHEMES.get(eventPrefs.name));

    let eventParameters = [];

    if (eventJsonParameters) {
        try {
            eventParameters = JSON.parse(eventJsonParameters);
        } catch {
            throw new Error(`Invalid JSON value for listener event "${eventPrefs.name}" json: ${eventJsonParameters}`);
        }
    }

    if (!Array.isArray(eventParameters)) {
        throw new Error(`Arguments for "${eventPrefs.name}" must be an array!`);
    }

    createMockedListener(eventPrefs, ...eventParameters);
}

function createMockedListener(eventPrefs, ...eventParameters) {
    let listener = null;
    let pendingArgs = null;
    let pending = null;

    const event = eventPrefs.event
        ?? eventPrefs.name.split('.').reduce((obj, eventNamePart) => obj?.[eventNamePart], browser);

    if (!event) {
        throw new Error(`Event object for "${eventPrefs.name}" listener not found!`);
    }

    event.addListener(realListener, ...eventParameters);

    const settlePending = () => pending?.resolve(eventPrefs.noListenerPromiseHandler(eventPrefs.name));

    function setListener(func = null, options = {}) {
        if (options.addListener) {
            event.addListener(realListener, ...eventParameters);
        } else if (options.removeListener) {
            event.removeListener?.(realListener);
            settlePending();
            return;
        }

        options.waitListener ??= eventPrefs.waitListener;

        listener = func;

        if (listener && eventPrefs.waitListener && options.waitListener && pendingArgs) {
            if (eventPrefs.returnPromise) {
                pending.resolve(listener(...pendingArgs));
            } else {
                listener(...pendingArgs);
            }
        }

        pendingArgs = null;
        settlePending();
        pending = null;
    }

    function realListener(...args) {
        if (listener) {
            return listener(...args);
        }

        if (eventPrefs.waitListener) {
            pendingArgs = args;

            if (eventPrefs.returnPromise) {
                settlePending();
                pending = Promise.withResolvers();
                return pending.promise;
            }
        } else if (eventPrefs.returnPromise) {
            return eventPrefs.noListenerPromiseHandler(eventPrefs.name);
        }
    }

    eventPrefs.name.split('.').reduce((schema, eventNamePart, index, self) => {
        if (index < self.length - 1) {
            return schema[eventNamePart] ??= {};
        }

        schema[eventNamePart] = setListener;
    }, listeners);
}

export default Object.freeze(listeners); // use like listeners.runtime.onInstalled(func);
