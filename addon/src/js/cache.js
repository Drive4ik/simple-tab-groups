
import * as Constants from './constants.js';
import * as Utils from './utils.js';
import Queue from './queue.js';

export const GROUP_KEY = 'groupId';
export const GROUP_NATIVE_KEY = 'groupNativeId';
export const FAVICON_KEY = 'favIconUrl';
export const THUMBNAIL_KEY = 'thumbnail';
export const KEYS = [GROUP_KEY, GROUP_NATIVE_KEY, FAVICON_KEY, THUMBNAIL_KEY];

export const tabs = new Map;
export const lastTabsState = new Map; // BUG https://bugzilla.mozilla.org/show_bug.cgi?id=1405603
export const windows = new Map;

const SESSIONS_API = new Map([
    [tabs, {
        name: 'tab',
        load: browser.sessions.getTabValue,
        set: browser.sessions.setTabValue,
        remove: browser.sessions.removeTabValue,
    }],
    [windows, {
        name: 'window',
        load: browser.sessions.getWindowValue,
        set: browser.sessions.setWindowValue,
        remove: browser.sessions.removeWindowValue,
    }],
]);

const sessionQueue = new Queue('Cache', {trace: false});

// the thumbnails option: tabs.js sets it from storage, restoreBackup from the backup being
// restored. While off, thumbnails are neither read, written, removed nor handed out - the ones
// already in the records wait for the option to come back; removeTabSession clears them regardless
let useThumbnails = false;

export function setUseThumbnails(value) {
    useThumbnails = value;
}

function createRecord(id) {
    return {id};
}

// the browser's url in the addon's form: Tabs.fillEmptyUrl rewrites tab.url, browserUrl stays the browser's own
function reportedUrl({url, browserUrl}) {
    return Utils.isUrlEmpty(browserUrl) ? browserUrl : url;
}

function isEveryTabComplete(...tabs) {
    return tabs.every(tab => tab?.status === browser.tabs.TabStatus.COMPLETE);
}

function setLastTabState(tab) {
    lastTabsState.set(tab.id, {
        ...Utils.extractKeys(tab, ['id', ...Constants.ON_UPDATED_TAB_PROPERTIES]),
        url: reportedUrl(tab),
    });
}

// don't forget for pinned tabs events
export function getRealTabStateChanged(tab) {
    let changeInfo = null;

    const lastState = lastTabsState.get(tab.id);

    if (lastState) {
        for (const key of Constants.ON_UPDATED_TAB_PROPERTIES) {
            if (!isSameTabState(tab[key], lastState[key])) {
                changeInfo ??= {};
                changeInfo[key] = tab[key];
            }
        }
    }

    return changeInfo;
}

function isSameTabState(value, lastValue) {
    return Utils.isPrimitive(value)
        ? value === lastValue
        : Utils.isEqualByKeys(value, lastValue, Object.keys(value));
}

export function clear() {
    tabs.clear();
    lastTabsState.clear();
    windows.clear();
}

// TABS

// changeInfo - what the event announced (tabs.js onUpdated), none for a snapshot
export function setTab(tab, changeInfo = null) {
    setLastTabState(tab);
    mirrorTab(tab, changeInfo);
}

// the mirror: the last state the browser reported, by events (setTab) and by reads alike;
// requestedUrl - the address the tab was asked to load (Tabs.create, onBeforeTabRequest) until the
// load has an outcome (removeTabRequestedUrl). The diff base is set here only for a tab it does
// not know yet: the base moves with the events (tabs.js onUpdated, setTab); a read or a side
// snapshot inside the 50-70 ms event wait must not overwrite it, or the pending event diffs
// against its own result and is swallowed
export function mirrorTab(tab, changeInfo = null) {
    const {id, title, favIconUrl, cookieStoreId, openerTabId} = tab;
    const url = reportedUrl(tab);

    lastTabsState.has(id) || setLastTabState(tab);

    const record = tabs.getOrInsertComputed(id, createRecord);

    record.cookieStoreId ??= cookieStoreId;

    if (openerTabId === undefined) {
        delete record.openerTabId;
    } else {
        record.openerTabId = openerTabId;
    }

    record.url = url;
    record.title = title || url;

    if (Utils.isAvailableFavIconUrl(favIconUrl)) {
        record.favIconUrl = favIconUrl;
    }

    removeTabRequestedUrl(record, tab, changeInfo);
}

// an empty address is nothing to wait for
export function setTabRequestedUrl(id, url) {
    if (!Utils.isUrlEmpty(url)) {
        tabs.getOrInsertComputed(id, createRecord).requestedUrl = url;
    }
}

// the load has its outcome: the tab settled on a url (a url read from a loading tab is not final,
// docs/BEHAVIOR-CREATE-TABS.md §28), or the event announced the end of a load that left the tab empty
function removeTabRequestedUrl(record, tab, changeInfo) {
    const settled = Utils.isUrlEmpty(reportedUrl(tab))
        ? isEveryTabComplete(tab, changeInfo)
        : isEveryTabComplete(tab);

    if (settled) {
        delete record.requestedUrl;
    }
}

// the requested url, else the last reported one
export function getTabUrl(id) {
    const record = tabs.get(id);

    return record?.requestedUrl ?? record?.url;
}

export function hasTab(id) {
    return tabs.has(id);
}

export function removeTab(id) {
    tabs.delete(id);
    lastTabsState.delete(id);
}

// a cross-window move erases every link to and from the tab, with no event (docs/BEHAVIOR-OPENER.md §7, §9)
export function clearTabOpeners(id) {
    delete tabs.get(id)?.openerTabId;

    for (const tab of tabs.values()) {
        if (tab.openerTabId === id) {
            delete tab.openerTabId;
        }
    }
}

// who points at these tabs, by the mirror: the recreate re-points them at the copies
export function getTabChildren(tabIds) {
    const ids = new Set(tabIds);

    return tabs.values().filter(tab => ids.has(tab.openerTabId)).toArray();
}

// session values, the same for tabs and windows: a record field has three states - no key means
// not read yet, null means read and the session has no value, anything else is the value. Only
// the load and the remove check the mark (a known "no value" is not read and not removed again);
// the getters and the copies never let null out of the module. Operations on one id and one
// key run one after another (queueByKey), different keys in parallel. A record deleted from the
// store (forgetTab, removeTab, removeWindow) while an operation waits its turn is dead: the load
// skips it, a write lands in it and nobody reads it again
async function loadValue(store, id, key) {
    const record = store.getOrInsertComputed(id, createRecord);

    await queueByKey('load', store, id, key, async () => {
        if (record !== store.get(id)) {
            return;
        }

        if (record[key] === undefined) {
            record[key] = await SESSIONS_API.get(store).load(id, key) ?? null;
        }
    });

    return getValue(store, id, key);
}

async function setValue(store, id, key, value) {
    const record = store.getOrInsertComputed(id, createRecord);

    await queueByKey('set', store, id, key, async () => {
        await SESSIONS_API.get(store).set(id, key, value);
        record[key] = value;
    });
}

async function removeValue(store, id, key) {
    const record = store.get(id) ?? createRecord(id);

    await queueByKey('remove', store, id, key, async () => {
        if (record[key] !== null) {
            await SESSIONS_API.get(store).remove(id, key);
            record[key] = null;
        }
    }).catch(() => {});
}

function getValue(store, id, key) {
    return store.get(id)?.[key] ?? undefined;
}

// groupId
export async function setTabGroup(id, groupId = null, windowId = null) {
    groupId ??= getWindowGroup(windowId);

    if (groupId) {
        await setValue(tabs, id, GROUP_KEY, groupId);
    } else {
        await removeTabGroup(id);
    }
}

export function getTabGroup(id) {
    return getValue(tabs, id, GROUP_KEY);
}

export async function removeTabGroup(id) {
    await removeValue(tabs, id, GROUP_KEY);
}

// groupNativeId - membership in a native tab group: the stable string id of the sub-group
// (createSubGroupId, groups-native.js), never the ephemeral browser group id. The single source of
// truth: survives addon and browser restarts and travels with the tab.
export async function loadTabNativeGroupId(id) {
    return await loadValue(tabs, id, GROUP_NATIVE_KEY);
}

export async function setTabNativeGroupId(id, groupNativeId) {
    if (groupNativeId) {
        await setValue(tabs, id, GROUP_NATIVE_KEY, groupNativeId);
    } else {
        await removeTabNativeGroupId(id);
    }
}

export function getTabNativeGroupId(id) {
    return getValue(tabs, id, GROUP_NATIVE_KEY);
}

export async function removeTabNativeGroupId(id) {
    await removeValue(tabs, id, GROUP_NATIVE_KEY);
}

// favIconUrl
export async function setTabFavIcon(id, favIconUrl) {
    if (favIconUrl?.startsWith('data:')) {
        await setValue(tabs, id, FAVICON_KEY, favIconUrl);
    } else if (getValue(tabs, id, FAVICON_KEY)) {
        await removeTabFavIcon(id);
    }
}

export async function removeTabFavIcon(id) {
    await removeValue(tabs, id, FAVICON_KEY);
}

// thumbnail
export async function setTabThumbnail(id, thumbnail) {
    if (!useThumbnails) {
        return;
    }

    if (thumbnail) {
        await setValue(tabs, id, THUMBNAIL_KEY, thumbnail);
    } else {
        await removeTabThumbnail(id);
    }
}

export async function removeTabThumbnail(id) {
    if (useThumbnails) {
        await removeValue(tabs, id, THUMBNAIL_KEY);
    }
}

// tab
export async function loadTabSession(tab, {
    includeFavIconUrl = false,
    includeThumbnail = false,
} = {}) {
    try {
        mirrorTab(tab);

        await Promise.all([
            loadValue(tabs, tab.id, GROUP_KEY),
            loadValue(tabs, tab.id, GROUP_NATIVE_KEY),
            includeFavIconUrl && loadValue(tabs, tab.id, FAVICON_KEY),
            includeThumbnail && useThumbnails && loadValue(tabs, tab.id, THUMBNAIL_KEY),
        ]);

        if (tabs.has(tab.id)) {
            return applyTabSession(tab);
        }
    } catch {
        removeTab(tab?.id);
    }
}

export async function setTabSession(tab, session = null) {
    setTab(tab);

    applySession(tab, session);

    await Promise.all([
        setTabGroup(tab.id, tab.groupId),
        setTabNativeGroupId(tab.id, tab.groupNativeId),
        setTabFavIcon(tab.id, tab.favIconUrl),
        setTabThumbnail(tab.id, tab.thumbnail),
    ]);

    return tab;
}

// forget the tab, the reads still in flight included: they land in the dropped record, the load
// that follows mirrors the tab again at once. lastTabsState stays, it is the onUpdated diff base
export function forgetTab(id) {
    tabs.delete(id);
}

export function applySession(toObj, fromObj) {
    for (const key of KEYS) {
        if (key === THUMBNAIL_KEY && !useThumbnails) {
            continue;
        }

        if (fromObj?.[key]) {
            toObj[key] = fromObj[key];
        }
    }

    return toObj;
}

export function applyTabSession(tab) {
    return applySession(tab, tabs.get(tab.id));
}

export async function removeTabSession(id) {
    await Promise.all(KEYS.map(key => removeValue(tabs, id, key)));
}

export function getTabsSessionAndRemove(ids) {
    return ids
        .map(id => {
            const record = tabs.get(id);
            const url = getTabUrl(id);
            let session = false;

            if (record?.groupId && url) {
                const {requestedUrl, ...known} = record;

                session = Object.fromEntries(Object.entries(known).filter(([, value]) => value !== null));
                session.url = url;

                // a tab still waiting for its page shows the title of no page
                if (requestedUrl) {
                    delete session.title;
                }
            }

            removeTab(id);

            return session;
        })
        .filter(Boolean);
}

// WINDOWS
export function setWindow(id) {
    windows.getOrInsertComputed(id, createRecord);
}

export async function setWindowGroup(id, groupId) {
    await setValue(windows, id, GROUP_KEY, groupId);
}

export function getWindowId(groupId) {
    if (groupId) {
        for (const [id, win] of windows) {
            if (win.groupId === groupId) {
                return id;
            }
        }
    }
}

export function getWindowGroup(id) {
    return getValue(windows, id, GROUP_KEY);
}

export function removeWindow(id) {
    windows.delete(id);
}

export async function removeWindowGroup(id) {
    await removeValue(windows, id, GROUP_KEY);
}

export async function loadWindowSession(win) {
    try {
        win.groupId = await loadValue(windows, win.id, GROUP_KEY);

        return win; // TODO check in stg-debug.js and others
    } catch {
        removeWindow(win?.id);
    }
}

export async function removeWindowSession(id) {
    await removeWindowGroup(id);
    removeWindow(id);
}

function queueByKey(name, store, id, key, fn) {
    return sessionQueue.run(name, fn, `${SESSIONS_API.get(store).name}:${id}:${key}`);
}
