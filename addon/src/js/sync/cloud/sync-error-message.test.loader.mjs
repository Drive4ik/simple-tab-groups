const REAL_LOGGER_UTILS = new URL('../../logger-utils.js', import.meta.url).href;

const STUBS = {
    'stg:broadcast': `
        export function channel() {
            return {
                on: () => () => {},
                off() {},
                send() {},
            };
        }
    `,
    'stg:prefixed-storage': `
        globalThis.localStorage = {create: () => ({})};
        export {};
    `,
    'stg:constants': `
        export const MODULES = {BACKGROUND: 'background'};
        export const DEBUG = {MANUAL: 'manual', AUTO: 'auto'};
        export const STG_BASE_URL = 'moz-extension://stg/';
    `,
};

const SPECIFIER_TO_STUB = {
    '/js/broadcast.js': 'stg:broadcast',
    '/js/prefixed-storage.js': 'stg:prefixed-storage',
    './constants.js': 'stg:constants',
};

export async function resolve(specifier, context, nextResolve) {
    const stub = SPECIFIER_TO_STUB[specifier];

    if (stub) {
        return {url: stub, shortCircuit: true};
    }

    if (specifier === '/js/logger.js') {
        return {url: REAL_LOGGER_UTILS, shortCircuit: true};
    }

    return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
    if (Object.hasOwn(STUBS, url)) {
        return {format: 'module', source: STUBS[url], shortCircuit: true};
    }

    return nextLoad(url, context);
}
