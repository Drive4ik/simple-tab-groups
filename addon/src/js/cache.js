
import './prefixed-storage.js';
import * as Constants from './constants.js';
import * as Utils from './utils.js';
import backgroundSelf from './background.js';

export const GROUP_KEY = 'groupId';
export const GROUP_NATIVE_KEY = 'groupNativeId';
export const FAVICON_KEY = 'favIconUrl';
export const THUMBNAIL_KEY = 'thumbnail';
export const KEYS = [GROUP_KEY, GROUP_NATIVE_KEY, FAVICON_KEY, THUMBNAIL_KEY];

export const tabs = {};
export const lastTabsState = {}; // BUG https://bugzilla.mozilla.org/show_bug.cgi?id=1818392
export const windows = {};

function setLastTabState(tab) {
    lastTabsState[tab.id] = Utils.extractKeys(tab, ['id', ...Constants.ON_UPDATED_TAB_PROPERTIES]);
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
// the mirror, and the diff base only for a tab the base does not know yet. The base moves with
// the events that change the state - processed in full or the addon's own (tabs.js onUpdated,
// setTab); a read or a side snapshot inside the 50-70 ms event wait must not overwrite it, or
// the pending event diffs against its own result and is swallowed. A read (isRead) never makes
// the mirror know less either: an empty url replaces a known one only through an event, and
// only once the tab has settled on it
export function mirrorTab(tab, isRead = false) {
    const {id, url, title, favIconUrl, cookieStoreId, openerTabId, status} = tab;

    lastTabsState[id] || setLastTabState(tab);

    tabs[id] ??= {};
    tabs[id].id ??= id;
    tabs[id].cookieStoreId ??= cookieStoreId;

    if (openerTabId === undefined) {
        delete tabs[id].openerTabId;
    } else {
        tabs[id].openerTabId = openerTabId;
    }

    if (tabs[id].url && Utils.isUrlEmpty(url) && (isRead || status === browser.tabs.TabStatus.LOADING)) {
        return;
    }

    tabs[id].url = url;
    tabs[id].title = title || url;

    if (Utils.isAvailableFavIconUrl(favIconUrl)) {
        tabs[id].favIconUrl = favIconUrl;
    }
}

export function setTab(tab) {
    setLastTabState(tab);
    mirrorTab(tab);
}

export function mirrorTabUrl(id, url) {
    tabs[id] ??= {id};
    tabs[id].url = url;
}

export function hasTab(id) {
    return !!tabs[id];
}

export function removeTab(id) {
    delete tabs[id];
    delete lastTabsState[id];
}

// a cross-window move erases every link to and from the tab, with no event (docs/OPENER-BEHAVIOR.md §7, §9)
export function clearTabOpeners(id) {
    delete tabs[id]?.openerTabId;

    for (const tab of Object.values(tabs)) {
        if (tab.openerTabId === id) {
            delete tab.openerTabId;
        }
    }
}

// who points at these tabs, by the mirror: the recreate re-points them at the copies
export function getTabChildren(tabIds) {
    const ids = new Set(tabIds);

    return Object.values(tabs).filter(tab => ids.has(tab.openerTabId));
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

// groupNativeId - membership in a native tab group: the stable string id of the sub-group
// (GroupsNative.createSubGroupId), never the ephemeral browser group id. The single source of
// truth: survives addon and browser restarts and travels with the tab.
export async function loadTabNativeGroupId(id) {
    tabs[id] ??= {id};

    await waitPromises(tabs[id]);

    if (tabs[id].groupNativeId) {
        return tabs[id].groupNativeId;
    }

    return tabs[id].groupNativeId = await addPromise(tabs[id], browser.sessions.getTabValue(id, GROUP_NATIVE_KEY));
}

export async function setTabNativeGroupId(id, groupNativeId) {
    if (groupNativeId) {
        tabs[id] ??= {id};

        await waitPromises(tabs[id]);

        await addPromise(tabs[id], browser.sessions.setTabValue(id, GROUP_NATIVE_KEY, groupNativeId));

        tabs[id].groupNativeId = groupNativeId;
    } else {
        await removeTabNativeGroupId(id).catch(() => {});
    }
}

export function getTabNativeGroupId(id) {
    return tabs[id]?.groupNativeId;
}

export async function removeTabNativeGroupId(id) {
    await waitPromises(tabs[id]);
    await addPromise(tabs[id], browser.sessions.removeTabValue(id, GROUP_NATIVE_KEY));
    delete tabs[id]?.groupNativeId;
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
        mirrorTab(tab, true);

        await Promise.all([
            loadTabGroup(tab.id),
            loadTabNativeGroupId(tab.id),
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
        setTabNativeGroupId(tab.id, tab.groupNativeId),
        setTabFavIcon(tab.id, tab.favIconUrl),
        setTabThumbnail(tab.id, tab.thumbnail),
    ]);

    return tab;
}

export function clearTabSessionCache(id) {
    delete tabs[id]?.groupId;
    delete tabs[id]?.groupNativeId;
    delete tabs[id]?.favIconUrl;
    delete tabs[id]?.thumbnail;
}

export function applySession(toObj, fromObj) {
    fromObj?.groupId && (toObj.groupId = fromObj.groupId);
    fromObj?.groupNativeId && (toObj.groupNativeId = fromObj.groupNativeId);
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
        removeTabNativeGroupId(id),
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
