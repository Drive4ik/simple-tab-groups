/**
 * ESM loader hook for `real-tab-state.test.mjs`.
 *
 * `cache.js` is browser-impure, but `setLastTabState`/`getRealTabStateChanged` are pure
 * functions over plain objects and the module-level `lastTabsState` map. To exercise the
 * REAL pair (and the REAL `Constants.ON_UPDATED_TAB_PROPERTIES` they are coupled to) we
 * load `cache.js` unchanged and redirect only the specifiers that need a live browser:
 * `./prefixed-storage.js` (patches `Storage.prototype`), `./background.js` (pulls in the
 * whole addon) and `./utils.js` (reads `browser.i18n` at module scope). `./constants.js`
 * stays REAL — the test asserts that every compared property is remembered, so a ninth
 * entry added to the constant fails the suite until `setLastTabState` covers it.
 *
 * Registered via `module.register()` from the test file so a plain `node <file>.test.mjs`
 * (the suite's invocation, no CLI flags) still picks it up.
 */

const STUBS = {
    'stg:prefixed-storage': `
        export {};
    `,
    'stg:background': `
        export default {options: {}};
    `,
    'stg:utils': `
        export function isUrlEmpty(url) { return !url || url === 'about:blank'; }
        export function unixNowMs() { return Date.now(); }
        export function isAvailableFavIconUrl(favIconUrl) { return !!favIconUrl && !favIconUrl.startsWith('chrome:'); }
    `,
};

const SPECIFIER_TO_STUB = {
    './prefixed-storage.js': 'stg:prefixed-storage',
    './background.js': 'stg:background',
    './utils.js': 'stg:utils',
};

export async function resolve(specifier, context, nextResolve) {
    const stub = SPECIFIER_TO_STUB[specifier];

    if (stub) {
        return {url: stub, shortCircuit: true};
    }

    return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
    if (Object.hasOwn(STUBS, url)) {
        return {format: 'module', source: STUBS[url], shortCircuit: true};
    }

    return nextLoad(url, context);
}
