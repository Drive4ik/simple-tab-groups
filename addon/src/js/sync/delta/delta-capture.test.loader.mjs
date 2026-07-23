/**
 * ESM loader hook for `delta-capture.test.mjs`.
 *
 * `delta-capture.js` is browser-impure: it imports the addon's absolute-path modules
 * (`/js/logger.js`, `/js/cache.js`, `/js/constants.js`) and a sibling (`./delta-log.js`)
 * that themselves touch browser globals. To exercise the REAL `optionsChanged` gate (the
 * fix under test) instead of re-implementing it, we load `delta-capture.js` unchanged and
 * redirect just those four specifiers to tiny virtual stubs. Its remaining siblings
 * (`option-keys`, `url-sync`, `group-relative-index`, `applied-nav-echo`) are pure and
 * load unchanged. Appended events land on `globalThis.__appended` so the test can inspect
 * exactly what the capture path logged.
 *
 * Registered via `module.register()` from the test file so a plain `node <file>.test.mjs`
 * (the suite's invocation, no CLI flags) still picks it up.
 */

const STUBS = {
    'stg:logger': `
        export default function Logger() {
            return { info() {}, log() {}, warn() {}, error() {}, onCatch() { return () => {}; } };
        }
    `,
    'stg:cache': 'export {};',
    'stg:constants': `
        export const ALL_OPTION_KEYS = ['closePopupAfterSelectTab', 'syncEnable'];
    `,
    'stg:delta-log': `
        export const OPS = { OPTION_SET: 'OPTION_SET' };
        export async function appendMany(items) {
            globalThis.__appended.push(...items);
            return items;
        }
        export async function append() {}
    `,
};

const SPECIFIER_TO_STUB = {
    '/js/logger.js': 'stg:logger',
    '/js/cache.js': 'stg:cache',
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
