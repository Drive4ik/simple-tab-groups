
import './prefixed-storage.js';
import * as Constants from './constants.js';
import * as Utils from './utils.js';
import backgroundSelf from './background.js';

export const GROUP_KEY = 'groupId';
export const FAVICON_KEY = 'favIconUrl';
export const THUMBNAIL_KEY = 'thumbnail';
export const UID_KEY = 'uid';
export const LAST_MODIFIED_KEY = 'lastModified';
export const GROUP_PINNED_KEY = 'groupPinned';
export const KEYS = [GROUP_KEY, FAVICON_KEY, THUMBNAIL_KEY, UID_KEY, LAST_MODIFIED_KEY, GROUP_PINNED_KEY];

export const tabs = {};
export const lastTabsState = {}; // BUG https://bugzilla.mozilla.org/show_bug.cgi?id=1818392
export const windows = {};

function hashFavIconUrl(favIconUrl) {
    if (typeof favIconUrl !== 'string') {
        return favIconUrl;
    }

    let hash = 5381;

    for (let i = 0; i < favIconUrl.length; i++) {
        hash = ((hash << 5) + hash) ^ favIconUrl.charCodeAt(i);
    }

    return hash >>> 0;
}

function setLastTabState({id, url, title, status, hidden, pinned, favIconUrl}) {
    lastTabsState[id] = {id, url, title, status, hidden, pinned, favIconUrlHash: hashFavIconUrl(favIconUrl)};
}

// don't forget for pinned tabs events
export function getRealTabStateChanged(tab) {
    let changeInfo = null;

    if (lastTabsState[tab.id]) {
        for (const key of Constants.ON_UPDATED_TAB_PROPERTIES) {
            const lastValue = key === FAVICON_KEY ? lastTabsState[tab.id].favIconUrlHash : lastTabsState[tab.id][key];
            const currentValue = key === FAVICON_KEY ? hashFavIconUrl(tab[key]) : tab[key];

            if (currentValue !== lastValue) {
                changeInfo ??= {};
                changeInfo[key] = tab[key];
            }
        }
    }

    return changeInfo;
}

export function clear() {
    for (const key in tabs) delete tabs[key];
    for (const key in lastTabsState) delete lastTabsState[key];
    for (const key in windows) delete windows[key];
}

// TABS
export function setTab({id, url, title, favIconUrl, cookieStoreId, openerTabId, status}) {
    tabs[id] ??= {};
    tabs[id].id ??= id;
    tabs[id].cookieStoreId ??= cookieStoreId;

    setLastTabState(arguments[0]);

    tabs[id].openerTabId = openerTabId;

    if (status === browser.tabs.TabStatus.LOADING && tabs[id].url && Utils.isUrlEmpty(url)) {
        return;
    }

    const nextTitle = title || url;

    if (tabs[id].lastModified && (tabs[id].url !== url || tabs[id].title !== nextTitle)) {
        tabs[id].lastModified = Utils.unixNowMs();
    }

    tabs[id].url = url;
    tabs[id].title = nextTitle;

    if (Utils.isAvailableFavIconUrl(favIconUrl)) {
        tabs[id].favIconUrl = favIconUrl;
    }
}

export function hasTab(id) {
    return !!tabs[id];
}

export function removeTab(id) {
    delete tabs[id];
    delete lastTabsState[id];
}

// groupId
async function loadTabGroup(id) {
    if (tabs[id]) {
        await waitPromises(tabs[id]);

        if (tabs[id].groupId) {
            return tabs[id].groupId;
        }

        return tabs[id].groupId = await addPromise(tabs[id], browser.sessions.getTabValue(id, GROUP_KEY));
    }
}

export async function setTabGroup(id, groupId = null, windowId = null) {
    groupId ??= getWindowGroup(windowId);

    if (groupId) {
        tabs[id] ??= {id};

        await waitPromises(tabs[id]);

        await addPromise(tabs[id], browser.sessions.setTabValue(id, GROUP_KEY, groupId));

        tabs[id].groupId = groupId;
    } else if (getTabGroup(id)) {
        await removeTabGroup(id).catch(() => {});
    }
}

export function getTabGroup(id) {
    return tabs[id]?.groupId;
}

export async function removeTabGroup(id) {
    await waitPromises(tabs[id]);
    await addPromise(tabs[id], browser.sessions.removeTabValue(id, GROUP_KEY));
    delete tabs[id]?.groupId;
}

// favIconUrl
async function loadTabFavIcon(id) {
    if (tabs[id]) {
        await waitPromises(tabs[id]);

        if (tabs[id].favIconUrl) {
            return tabs[id].favIconUrl;
        }

        return tabs[id].favIconUrl = await addPromise(tabs[id], browser.sessions.getTabValue(id, FAVICON_KEY));
    }
}

export async function setTabFavIcon(id, favIconUrl) {
    if (favIconUrl?.startsWith('data:')) {
        tabs[id] ??= {id};

        await waitPromises(tabs[id]);

        await addPromise(tabs[id], browser.sessions.setTabValue(id, FAVICON_KEY, favIconUrl));

        tabs[id].favIconUrl = favIconUrl;
    }
}

export function getTabFavIcon(id) {
    return tabs[id]?.favIconUrl;
}

export async function removeTabFavIcon(id) {
    await waitPromises(tabs[id]);
    await addPromise(tabs[id], browser.sessions.removeTabValue(id, FAVICON_KEY));
    delete tabs[id]?.favIconUrl;
}

// thumbnail
async function loadTabThumbnail(id) {
    if (!backgroundSelf.options.showTabsWithThumbnailsInManageGroups) {
        return;
    }

    if (tabs[id]) {
        await waitPromises(tabs[id]);

        if (tabs[id].thumbnail) {
            return tabs[id].thumbnail;
        }

        return tabs[id].thumbnail = await addPromise(tabs[id], browser.sessions.getTabValue(id, THUMBNAIL_KEY));
    }
}

export async function setTabThumbnail(id, thumbnail) {
    if (!backgroundSelf.options.showTabsWithThumbnailsInManageGroups) {
        return;
    }

    if (thumbnail) {
        tabs[id] ??= {id};

        await waitPromises(tabs[id]);

        await addPromise(tabs[id], browser.sessions.setTabValue(id, THUMBNAIL_KEY, thumbnail));

        tabs[id].thumbnail = thumbnail;
    }
}

export function getTabThumbnail(id) {
    return tabs[id]?.thumbnail;
}

export async function removeTabThumbnail(id) {
    await waitPromises(tabs[id]);
    await addPromise(tabs[id], browser.sessions.removeTabValue(id, THUMBNAIL_KEY));
    delete tabs[id]?.thumbnail;
}

async function loadTabUid(id) {
    if (tabs[id]) {
        await waitPromises(tabs[id]);

        if (tabs[id].uid) {
            return tabs[id].uid;
        }

        const uid = await addPromise(tabs[id], browser.sessions.getTabValue(id, UID_KEY));

        if (uid) {
            return tabs[id].uid = uid;
        }

        return setTabUid(id);
    }
}

export async function setTabUid(id, uid = null) {
    tabs[id] ??= {id};

    await waitPromises(tabs[id]);

    uid ||= tabs[id].uid || self.crypto.randomUUID();

    await addPromise(tabs[id], browser.sessions.setTabValue(id, UID_KEY, uid));

    return tabs[id].uid = uid;
}

export function getTabUid(id) {
    return tabs[id]?.uid;
}

async function loadTabLastModified(id) {
    if (tabs[id]) {
        await waitPromises(tabs[id]);

        if (tabs[id].lastModified) {
            return tabs[id].lastModified;
        }

        const lastModified = await addPromise(tabs[id], browser.sessions.getTabValue(id, LAST_MODIFIED_KEY));

        if (lastModified) {
            return tabs[id].lastModified = lastModified;
        }

        return setTabLastModified(id);
    }
}

export async function setTabLastModified(id, lastModified = null) {
    tabs[id] ??= {id};

    await waitPromises(tabs[id]);

    lastModified ||= Utils.unixNowMs();

    await addPromise(tabs[id], browser.sessions.setTabValue(id, LAST_MODIFIED_KEY, lastModified));

    return tabs[id].lastModified = lastModified;
}

export function getTabLastModified(id) {
    return tabs[id]?.lastModified;
}

export async function removeTabUid(id) {
    await waitPromises(tabs[id]);
    await addPromise(tabs[id], browser.sessions.removeTabValue(id, UID_KEY));
    delete tabs[id]?.uid;
}

async function loadTabGroupPinned(id) {
    if (tabs[id]) {
        await waitPromises(tabs[id]);

        if (tabs[id].groupPinned !== undefined) {
            return tabs[id].groupPinned;
        }

        const groupPinned = await addPromise(tabs[id], browser.sessions.getTabValue(id, GROUP_PINNED_KEY));
        return tabs[id].groupPinned = groupPinned === true;
    }
}

export async function setTabGroupPinned(id, groupPinned = false) {
    if (groupPinned) {
        tabs[id] ??= {id};

        await waitPromises(tabs[id]);

        await addPromise(tabs[id], browser.sessions.setTabValue(id, GROUP_PINNED_KEY, true));

        tabs[id].groupPinned = true;
    } else if (getTabGroupPinned(id)) {
        await removeTabGroupPinned(id).catch(() => {});
    }
}

export function getTabGroupPinned(id) {
    return tabs[id]?.groupPinned === true;
}

export async function removeTabGroupPinned(id) {
    await waitPromises(tabs[id]);
    await addPromise(tabs[id], browser.sessions.removeTabValue(id, GROUP_PINNED_KEY));
    delete tabs[id]?.groupPinned;
}

export async function removeTabLastModified(id) {
    await waitPromises(tabs[id]);
    await addPromise(tabs[id], browser.sessions.removeTabValue(id, LAST_MODIFIED_KEY));
    delete tabs[id]?.lastModified;
}

// tab
export function getTabSession(id, key = null) {
    if (key) {
        return tabs[id]?.[key];
    }

    const session = {...tabs[id] ?? {id}};
    delete session.promises;

    return session;
}

export async function loadTabSession(tab, includeFavIconUrl = true, includeThumbnail = true) {
    try {
        setTab(tab);

        await Promise.all([
            loadTabGroup(tab.id),
            loadTabUid(tab.id),
            loadTabLastModified(tab.id),
            loadTabGroupPinned(tab.id),
            includeFavIconUrl === true ? loadTabFavIcon(tab.id) : null,
            includeThumbnail === true ? loadTabThumbnail(tab.id) : null,
        ]);

        return applyTabSession(tab);
    } catch {
        removeTab(tab?.id);
    }
}

export async function setTabSession(tab, session = null) {
    setTab(tab);

    applySession(tab, session);

    await Promise.all([
        setTabGroup(tab.id, tab.groupId),
        setTabUid(tab.id, tab.uid),
        setTabLastModified(tab.id, tab.lastModified),
        setTabGroupPinned(tab.id, tab.groupPinned),
        setTabFavIcon(tab.id, tab.favIconUrl),
        setTabThumbnail(tab.id, tab.thumbnail),
    ]);

    return tab;
}

export function clearTabSessionCache(id) {
    delete tabs[id]?.groupId;
    delete tabs[id]?.favIconUrl;
    delete tabs[id]?.thumbnail;
    delete tabs[id]?.uid;
    delete tabs[id]?.lastModified;
    delete tabs[id]?.groupPinned;
}

export function applySession(toObj, fromObj) {
    fromObj?.groupId && (toObj.groupId = fromObj.groupId);
    fromObj?.favIconUrl && (toObj.favIconUrl = fromObj.favIconUrl);
    fromObj?.thumbnail && (toObj.thumbnail = fromObj.thumbnail);
    fromObj?.uid && (toObj.uid = fromObj.uid);
    fromObj?.lastModified && (toObj.lastModified = fromObj.lastModified);
    fromObj?.groupPinned && (toObj.groupPinned = true);

    return toObj;
}

export function applyTabSession(tab) {
    return applySession(tab, tabs[tab.id]);
}

export async function removeTabSession(id) {
    await Promise.allSettled([
        removeTabGroup(id),
        removeTabFavIcon(id),
        removeTabThumbnail(id),
        removeTabUid(id),
        removeTabLastModified(id),
        removeTabGroupPinned(id),
    ]);
}

export function getTabsSessionAndRemove(ids) {
    return ids
        .map(id => {
            if (!tabs[id]?.groupId || !tabs[id]?.url) {
                removeTab(id);
                return false;
            }

            const session = {...tabs[id]};

            delete session.promises;

            removeTab(id);

            return session;
        })
        .filter(Boolean);
}

// WINDOWS
export function setWindow({id}) {
    windows[id] ??= {id};
}

export async function setWindowGroup(id, groupId) {
    windows[id] ??= {id};

    await waitPromises(windows[id]);

    await addPromise(windows[id], browser.sessions.setWindowValue(id, GROUP_KEY, groupId));

    windows[id].groupId = groupId;
}

export function getWindowId(groupId) {
    for (const id in windows) {
        if (groupId && windows[id].groupId === groupId) {
            return Number(id);
        }
    }
}

export function getWindowGroup(id) {
    return windows[id]?.groupId;
}

export function removeWindow(id) {
    delete windows[id];
}

export async function removeWindowGroup(id) {
    await waitPromises(windows[id]);
    await addPromise(windows[id], browser.sessions.removeWindowValue(id, GROUP_KEY));
    delete windows[id].groupId;
}

export async function loadWindowSession(win) {
    try {
        const id = win.id;

        windows[id] ??= {id};

        await waitPromises(windows[id]);

        windows[id].groupId = win.groupId = await addPromise(windows[id], browser.sessions.getWindowValue(id, GROUP_KEY));

        return win; // TODO check in stg-debug.js and others
    } catch {
        removeWindow(win?.id);
    }
}

export async function removeWindowSession(id) {
    try {
        await removeWindowGroup(id);
    } catch {
        //
    } finally {
        removeWindow(id);
    }
}

async function waitPromises(obj) {
    if (obj?.promises) {
        await Promise.allSettled([...obj.promises]);
    }
}

async function addPromise(obj, promise) {
    if (obj) {
        obj.promises ??= new Set;
        obj.promises.add(promise);
    }

    return promise.finally(() => obj?.promises.delete(promise));
}
