/**
 * ESM loader hook for `delta-log-hydration.test.mjs`.
 *
 * `delta-log.js` is browser-impure: it imports the addon's absolute-path modules
 * (`/js/prefixed-storage.js`, `/js/utils.js`, `/js/logger.js`) and a sibling
 * (`./device-id.js`) that themselves touch browser globals. To exercise the REAL
 * `ensureLoaded()` memoization (the fix under test) instead of re-implementing it, we
 * load `delta-log.js` unchanged and redirect just those four specifiers to tiny virtual
 * stubs. `browser.storage.local` is provided as a global by the test (main thread); the
 * stubs only reference globals at call time, so the worker-thread loader needs no shared
 * state.
 *
 * Registered via `module.register()` from the test file so a plain `node <file>.test.mjs`
 * (the suite's invocation, no CLI flags) still picks it up.
 */

const STUBS = {
    'stg:prefixed-storage': 'export {};',
    'stg:utils': `
        let __t = 1_000_000;
        // strictly increasing so it never matters, but the test relies on seq (not ts) anyway
        export function unixNowMs() { return __t++; }
    `,
    'stg:logger': `
        export default function Logger() {
            return { info() {}, log() {}, warn() {}, error() {}, onCatch() { return () => {}; } };
        }
    `,
    'stg:device-id': `
        export function getDeviceId() { return 'test-device'; }
        export function getDeviceLabel() { return 'test-label'; }
        export function setDeviceLabel() {}
    `,
    'stg:delta-log-store': `
        function idb() { return globalThis.__deltaLogIdb; }
        export default {
            load: (...args) => idb().load(...args),
            saveMeta: (...args) => idb().saveMeta(...args),
            putEvents: (...args) => idb().putEvents(...args),
            deleteUpTo: (...args) => idb().deleteUpTo(...args),
            replaceEvents: (...args) => idb().replaceEvents(...args),
        };
    `,
    'stg:capture-gate-state': `
        export async function isCaptureGateOpen() { return globalThis.__captureGateOpen ?? true; }
        export function invalidateCaptureGate() {}
    `,
};

const SPECIFIER_TO_STUB = {
    '/js/prefixed-storage.js': 'stg:prefixed-storage',
    '/js/utils.js': 'stg:utils',
    '/js/logger.js': 'stg:logger',
    './device-id.js': 'stg:device-id',
    './delta-log-store.js': 'stg:delta-log-store',
    './capture-gate-state.js': 'stg:capture-gate-state',
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
