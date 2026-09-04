/**
 * ESM loader hook for `apply-depth.test.mjs`.
 *
 * The property under test — an apply pass can never leave the capture-suppression counter
 * raised — lives in the seam between `apply-engine.js` / `favicon-file.js` /
 * `pending-nav-wake.js` and the REAL `delta-capture.js` that owns the counter, so all four
 * modules load unchanged and only their browser-dependent imports are redirected to stubs.
 * The stubs are steered from `globalThis.__stubs`, which lets a test make any single browser
 * call reject and then assert that `isApplying()` came back down.
 *
 * `tab-sleep`, `url-sync`, `tab-content-apply`, `apply-index`, `group-order`,
 * `applied-nav-echo`, `applied-move-echo`, `content-marks`, `option-keys`,
 * `group-relative-index`, `pending-nav` and `pending-nav-store` are pure and load unchanged.
 * `local-state.js` is stubbed because its own import graph reaches the whole addon.
 */

const STUBS = {
    'stg:logger': `
        function makeLog() {
            return {
                log() {}, info() {}, warn() {}, error() {}, stop() {}, logError() {},
                onCatch() { return () => {}; },
            };
        }
        export default function Logger() {
            return {
                log() {}, info() {}, warn() {}, error() {},
                start() { return makeLog(); },
                onCatch() { return () => {}; },
            };
        }
    `,
    'stg:storage': `
        export async function get(keys) {
            const stubs = globalThis.__stubs || {};
            if (typeof stubs.storageGet === 'function') {
                return stubs.storageGet(keys);
            }
            return {};
        }
    `,
    'stg:cache': `
        const facts = () => globalThis.__tabFacts || {};
        export function getTabUid(tabId) { return facts()[tabId]?.uid ?? null; }
        export async function ensureTabUid(tabId) { return getTabUid(tabId); }
        export function getTabGroup(tabId) { return facts()[tabId]?.groupId ?? null; }
        export function getTabGroupPinned(tabId) { return facts()[tabId]?.groupPinned === true; }
        export function getTabLastModified(tabId) { return facts()[tabId]?.lastModified ?? 0; }
        export function getTabFavIcon() { return null; }
        export function getWindowId() { return null; }
        export async function setTabUid() {}
        export async function setTabLastModified() {}
        export async function setSyncedTabFavIcon() {}
        export function setTab() {}
    `,
    'stg:constants': `
        export const ALL_OPTION_KEYS = ['closePopupAfterSelectTab', 'syncEnable'];
    `,
    'stg:tabs': `
        export async function createMultiple() { return []; }
        export async function moveNative() {}
        export async function remove() {}
        export async function hide() {}
    `,
    'stg:groups': `
        function stubs() { return globalThis.__stubs || {}; }
        export async function load(...args) {
            const fn = stubs().groupsLoad;
            return typeof fn === 'function' ? fn(...args) : {groups: []};
        }
        export async function loadWithArchivedTabs(...args) {
            const fn = stubs().groupsLoadWithArchivedTabs;
            return typeof fn === 'function' ? fn(...args) : {groups: []};
        }
        export async function save(...args) {
            const fn = stubs().groupsSave;
            return typeof fn === 'function' ? fn(...args) : undefined;
        }
        export async function unload() {}
        export async function setArchiveStateWhileHoldingLock() {}
        export async function applyGroupPinnedOrder() {}
        export function create(id, title) { return {id, title}; }
        export function isLoaded() { return false; }
        export function isPinnedGroupId() { return false; }
    `,
    'stg:windows': `
        export async function get() { return null; }
    `,
    'stg:background': `
        export default {
            async saveOptions(...args) {
                const fn = (globalThis.__stubs || {}).saveOptions;
                return typeof fn === 'function' ? fn(...args) : undefined;
            },
        };
    `,
    'stg:local-state': `
        export async function getLivePinnedTabs() {
            const fn = (globalThis.__stubs || {}).getLivePinnedTabs;
            return typeof fn === 'function' ? fn() : [];
        }
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
    '/js/storage.js': 'stg:storage',
    '/js/cache.js': 'stg:cache',
    '/js/constants.js': 'stg:constants',
    '/js/tabs.js': 'stg:tabs',
    '/js/groups.js': 'stg:groups',
    '/js/windows.js': 'stg:windows',
    '/js/background.js': 'stg:background',
    './local-state.js': 'stg:local-state',
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
