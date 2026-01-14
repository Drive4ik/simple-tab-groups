
const listeners = {};

const CUSTOM_EVENT_SCHEMES = new Map;

CUSTOM_EVENT_SCHEMES.set('onExtensionStart', {
    event: {
        async addListener(listener) {
            const START_KEY = '__ext_start';
            const storage = await browser.storage.session.get(START_KEY);
            if (!storage[START_KEY]) {
                await browser.storage.session.set({[START_KEY]: true});
                listener();
            }
        },
    },
});

CUSTOM_EVENT_SCHEMES.set('runtime.onMessage', {
    returnPromise: true,
    promiseRejectionHandler: eventName => Promise.reject(new Error(`No listener for "${eventName}", please call back later`)),
});

CUSTOM_EVENT_SCHEMES.set('runtime.onMessageExternal', {
    returnPromise: true,
    promiseRejectionHandler: eventName => Promise.reject(new Error(`No listener for "${eventName}", please call back later`)),
});

CUSTOM_EVENT_SCHEMES.set('webRequest.onBeforeRequest', {
    returnPromise: true,
    promiseRejectionHandler: () => ({}),
});

for (const [eventName, eventJsonParameters] of new URL(import.meta.url).searchParams) {
    const eventPrefs = {
        name: eventName,
        ...(CUSTOM_EVENT_SCHEMES.get(eventName) ?? {}),
    };

    let eventParameters = [];

    if (eventJsonParameters) {
        try {
            eventParameters = JSON.parse(eventJsonParameters);
        } catch {
            throw new Error(`Invalid JSON value for listener event "${eventName}" json: ${eventJsonParameters}`);
        }
    }

    if (!Array.isArray(eventParameters)) {
        throw new Error(`Arguments for "${eventName}" must be an array!`);
    }

    createMockedListener(eventPrefs, ...eventParameters);
}

function createMockedListener(eventPrefs, ...eventParameters) {
    let listener = null;
    let lastArgs = null;
    let pending = null;

    eventPrefs.name.split('.').reduce((schema, eventNamePart, index, self) => {
        if (index < self.length - 1) {
            return schema[eventNamePart] ??= {};
        }

        schema[eventNamePart] = function setLateFunc(lateFunc = null, lateCall = true) {
            if (listener && lateFunc) {
                throw Error(`Listener for "${eventPrefs.name}" is already set`);
            }

            listener = lateFunc;

            const args = lastArgs;
            lastArgs = null;

            if (!listener || !args) {
                return;
            }

            if (eventPrefs.returnPromise) {
                pending.resolve(listener(...args));
                pending = null;
            } else if (lateCall) {
                listener(...args);
            }
        };
    }, listeners);

    const event = eventPrefs.event ?? eventPrefs.name.split('.').reduce((obj, eventNamePart) => obj?.[eventNamePart], browser);

    if (!event) {
        throw new Error(`Event object for "${eventPrefs.name}" listener not found!`);
    }

    event.addListener((...args) => {
        if (listener) {
            return listener(...args);
        }

        lastArgs = args;

        if (eventPrefs.returnPromise) {
            pending?.resolve(eventPrefs.promiseRejectionHandler(eventPrefs.name));
            pending = Promise.withResolvers();
            return pending.promise;
        }
    }, ...eventParameters);
}

export default Object.freeze(listeners); // use like listeners.runtime.onInstalled(func);
