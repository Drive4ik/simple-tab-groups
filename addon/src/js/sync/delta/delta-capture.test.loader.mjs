/**
 * ESM loader hook for `delta-capture.test.mjs`.
 *
 * `delta-capture.js` is browser-impure: it imports the addon's absolute-path modules
 * (`/js/logger.js`, `/js/cache.js`, `/js/constants.js`) and siblings (`./delta-log.js`,
 * `./sync-marks.js`, `./device-id.js`) that themselves touch browser globals. To exercise
 * the REAL capture gates (the fixes under test) instead of re-implementing them, we load
 * `delta-capture.js` unchanged and redirect just those specifiers to tiny virtual stubs.
 * Its remaining siblings (`option-keys`, `url-sync`, `group-relative-index`,
 * `applied-nav-echo`, `content-marks`) are pure and load unchanged. Appended events land
 * on `globalThis.__appended` so the test can inspect exactly what the capture path logged;
 * the last-synced content marks live on `globalThis.__contentMarks`, the tab facts the
 * capture path reads out of the cache live on `globalThis.__tabFacts`, and the persistent
 * sync store (`pending-nav-store`'s backing) lives on `globalThis.__syncStorage`.
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
    'stg:cache': `
        const facts = () => globalThis.__tabFacts || {};
        export function getTabUid(tabId) { return facts()[tabId]?.uid ?? null; }
        export async function ensureTabUid(tabId) { return getTabUid(tabId); }
        export function getTabGroup(tabId) { return facts()[tabId]?.groupId ?? null; }
        export function getTabGroupPinned(tabId) { return facts()[tabId]?.groupPinned === true; }
        export function getTabLastModified(tabId) { return facts()[tabId]?.lastModified ?? 0; }
        export function getWindowId() { return null; }
    `,
    'stg:constants': `
        export const ALL_OPTION_KEYS = ['closePopupAfterSelectTab', 'syncEnable'];
    `,
    'stg:delta-log': `
        export const OPS = {
            OPTION_SET: 'OPTION_SET',
            TAB_ADD: 'TAB_ADD',
            TAB_MODIFY: 'TAB_MODIFY',
            TAB_REMOVE: 'TAB_REMOVE',
            PINNED_MODIFY: 'PINNED_MODIFY',
            PINNED_REMOVE: 'PINNED_REMOVE',
        };
        export async function appendMany(items) {
            globalThis.__appended.push(...items);
            return items;
        }
        export async function append(op, payload) {
            globalThis.__appended.push({op, ...payload});
        }
    `,
    'stg:sync-marks': `
        export const storage = (globalThis.__syncStorage ||= {});
        const marks = () => (globalThis.__contentMarks ||= {});
        export function loadContentMarks() { return marks(); }
        export function rememberContentMark(deviceId, uid, mark) { marks()[uid] = mark; }
        export function forgetContentMark(deviceId, uid) { delete marks()[uid]; }
    `,
    'stg:device-id': `
        export function getDeviceId() { return 'test-device'; }
    `,
};

const SPECIFIER_TO_STUB = {
    '/js/logger.js': 'stg:logger',
    '/js/cache.js': 'stg:cache',
    '/js/constants.js': 'stg:constants',
    './delta-log.js': 'stg:delta-log',
    './sync-marks.js': 'stg:sync-marks',
    './device-id.js': 'stg:device-id',
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
