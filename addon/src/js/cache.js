
import './prefixed-storage.js';
import * as Constants from './constants.js';
import * as Utils from './utils.js';
import backgroundSelf from './background.js';

export const tabs = {};
export const lastTabsState = {}; // BUG https://bugzilla.mozilla.org/show_bug.cgi?id=1818392
export const windows = {};

function setLastTabState({id, url, title, status, hidden, pinned, favIconUrl}) {
    lastTabsState[id] = {id, url, title, status, hidden, pinned, favIconUrl};
}

// don't forget for pinned tabs events
export function getRealTabStateChanged(tab) {
    let changeInfo = null;

    if (lastTabsState[tab.id]) {
        for (const key of Constants.ON_UPDATED_TAB_PROPERTIES) {
            if (tab[key] !== lastTabsState[tab.id][key]) {
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

    tabs[id].url = url;
    tabs[id].title = title || url;

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

        return tabs[id].groupId = await addPromise(tabs[id], browser.sessions.getTabValue(id, 'groupId'));
    }
}

export async function setTabGroup(id, groupId = null, windowId = null) {
    groupId ??= getWindowGroup(windowId);

    if (groupId) {
        tabs[id] ??= {id};

        await waitPromises(tabs[id]);

        await addPromise(tabs[id], browser.sessions.setTabValue(id, 'groupId', groupId));

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
    await addPromise(tabs[id], browser.sessions.removeTabValue(id, 'groupId'));
    delete tabs[id]?.groupId;
}

// favIconUrl
async function loadTabFavIcon(id) {
    if (tabs[id]) {
        await waitPromises(tabs[id]);

        if (tabs[id].favIconUrl) {
            return tabs[id].favIconUrl;
        }

        return tabs[id].favIconUrl = await addPromise(tabs[id], browser.sessions.getTabValue(id, 'favIconUrl'));
    }
}

export async function setTabFavIcon(id, favIconUrl) {
    if (favIconUrl?.startsWith('data:')) {
        tabs[id] ??= {id};

        await waitPromises(tabs[id]);

        await addPromise(tabs[id], browser.sessions.setTabValue(id, 'favIconUrl', favIconUrl));

        tabs[id].favIconUrl = favIconUrl;
    }
}

export function getTabFavIcon(id) {
    return tabs[id]?.favIconUrl;
}

export async function removeTabFavIcon(id) {
    await waitPromises(tabs[id]);
    await addPromise(tabs[id], browser.sessions.removeTabValue(id, 'favIconUrl'));
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

        return tabs[id].thumbnail = await addPromise(tabs[id], browser.sessions.getTabValue(id, 'thumbnail'));
    }
}

export async function setTabThumbnail(id, thumbnail) {
    if (!backgroundSelf.options.showTabsWithThumbnailsInManageGroups) {
        return;
    }

    if (thumbnail) {
        tabs[id] ??= {id};

        await waitPromises(tabs[id]);

        await addPromise(tabs[id], browser.sessions.setTabValue(id, 'thumbnail', thumbnail));

        tabs[id].thumbnail = thumbnail;
    }
}

export function getTabThumbnail(id) {
    return tabs[id]?.thumbnail;
}

export async function removeTabThumbnail(id) {
    await waitPromises(tabs[id]);
    await addPromise(tabs[id], browser.sessions.removeTabValue(id, 'thumbnail'));
    delete tabs[id]?.thumbnail;
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
        setTabFavIcon(tab.id, tab.favIconUrl),
        setTabThumbnail(tab.id, tab.thumbnail),
    ]);

    return tab;
}

export function applySession(toObj, fromObj) {
    fromObj?.groupId && (toObj.groupId = fromObj.groupId);
    fromObj?.favIconUrl && (toObj.favIconUrl = fromObj.favIconUrl);
    fromObj?.thumbnail && (toObj.thumbnail = fromObj.thumbnail);

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

    await addPromise(windows[id], browser.sessions.setWindowValue(id, 'groupId', groupId));

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
    await addPromise(windows[id], browser.sessions.removeWindowValue(id, 'groupId'));
    delete windows[id].groupId;
}

export async function loadWindowSession(win) {
    try {
        const id = win.id;

        windows[id] ??= {id};

        await waitPromises(windows[id]);

        windows[id].groupId = win.groupId = await addPromise(windows[id], browser.sessions.getWindowValue(id, 'groupId'));

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
