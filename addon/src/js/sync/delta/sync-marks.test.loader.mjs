/**
 * ESM loader hook for `sync-marks.test.mjs`.
 *
 * `sync-marks.js` is the persistence layer: it opens a prefixed `localStorage` view at
 * module scope and derives the capture-side content marks from the delta log. To exercise
 * the REAL persistence (survival across a background restart, the reset sweep) we load it
 * unchanged and redirect only `/js/constants.js` and `./delta-log.js` to virtual stubs;
 * its remaining siblings (`content-marks`, `pending-nav`, `offline-remove-record`) are
 * pure and load unchanged. The stubbed log serves `globalThis.__deltaLogEvents`, and the
 * test installs `globalThis.localStorage` before importing so the same backing store can
 * be handed to a freshly evaluated module instance.
 *
 * Registered via `module.register()` from the test file so a plain `node <file>.test.mjs`
 * (the suite's invocation, no CLI flags) still picks it up.
 */

const STUBS = {
    'stg:constants': `
        export const MODULES = {CLOUD: 'cloud'};
    `,
    'stg:delta-log': `
        export async function getEventsSince(seq) {
            return (globalThis.__deltaLogEvents || []).filter(event => event.seq > seq);
        }
    `,
};

const SPECIFIER_TO_STUB = {
    '/js/constants.js': 'stg:constants',
    './delta-log.js': 'stg:delta-log',
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
