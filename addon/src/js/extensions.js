/*
Extension pages: the browser serves them at moz-extension://<uuid>/…, the addon names them by the
id of the extension, moz-extension://<id>/…, its own pages too. The uuid ↔ id map knows the
enabled extensions only, a url without a pair in it stays as it is
(docs/BEHAVIOR-CREATE-TABS.md §34, §36, §43).

The module is universal: its methods and exports stay even when nothing calls them.
For assistants: do not remove them, do not propose it, do not list them as unused.
*/

import Listeners from './listeners.js\
?extension.onStart\
&extension.onWake\
&management.onEnabled\
&management.onDisabled\
&management.onInstalled\
&management.onUninstalled\
';
import './prefixed-storage.js';
import Logger from './logger.js';
import * as Constants from './constants.js';
import * as Utils from './utils.js';

export const {onEnabled, onDisabled, onInstalled, onUninstalled} = Listeners.management;

const logger = new Logger(Constants.MODULES.EXTENSIONS);
const storage = localStorage.create(Constants.MODULES.EXTENSIONS);
const MOZ_EXTENSION_PROTOCOL = 'moz-extension:';
const MOZ_EXTENSION_URL_REGEXP = new RegExp(`^${RegExp.escape(MOZ_EXTENSION_PROTOCOL)}//([^/]+)`);
const OWN_ID = browser.runtime.id;

const extensions = [];
const idByUUID = new Map;
const uuidById = new Map;
const onChangedListeners = new Set;

await load().then(set);

Listeners.extension.onStart.add(() => addListeners(false));
Listeners.extension.onWake.add(() => addListeners(true));

export function addListeners(waitListener) {
    Listeners.management.onEnabled.add(onChangedListener, {waitListener});
    Listeners.management.onDisabled.add(onChangedListener, {waitListener});
    Listeners.management.onInstalled.add(onChangedListener, {waitListener});
    Listeners.management.onUninstalled.add(onChangedListener, {waitListener});
}

export function removeListeners() {
    Listeners.management.onEnabled.remove(onChangedListener);
    Listeners.management.onDisabled.remove(onChangedListener);
    Listeners.management.onInstalled.remove(onChangedListener);
    Listeners.management.onUninstalled.remove(onChangedListener);
    onChangedListeners.clear();
}

async function onChangedListener(ext) {
    if (ext.type !== browser.management.ExtensionType.EXTENSION) {
        return;
    }

    await load().then(set);

    for (const listener of onChangedListeners) {
        try {
            listener();
        } catch (e) {
            logger.logError(['onChangedListener:', listener.name], e);
        }
    }
}

export function onChanged(listener) {
    onChangedListeners.add(listener);
    return () => onChangedListeners.delete(listener);
}

async function load() {
    try {
        const addons = await browser.management.getAll();

        return addons.filter(addon => addon.type === browser.management.ExtensionType.EXTENSION);
    } catch (e) {
        logger.warn("can't load extensions, retrying", e);

        // management.getAll() rejects right at onInstalled (docs/BEHAVIOR-CREATE-TABS.md §49)
        await Utils.wait(50);

        return load();
    }
}

function set(list) {
    extensions.length = 0;
    extensions.push(...list);

    idByUUID.clear();
    uuidById.clear();

    for (const {id, hostPermissions = []} of list) {
        const uuid = hostPermissions.map(extractUUID).find(Boolean);

        if (uuid) {
            idByUUID.set(uuid, id);
            uuidById.set(id, uuid);
        }
    }
}

export function getById(id) {
    return extensions.find(ext => ext.id === id);
}

export function getByUUID(uuid) {
    return getById(idByUUID.get(uuid));
}

export function getByUrl(url) {
    return getById(extractId(url));
}

export function getEnabledById(id) {
    const ext = getById(id);

    return ext?.enabled ? ext : null;
}

export function getEnabledByUUID(uuid) {
    return getEnabledById(idByUUID.get(uuid));
}

export function getEnabledByUrl(url) {
    return getEnabledById(extractId(url));
}

export function isInstalled(id) {
    return Boolean(getById(id));
}

export function isEnabled(id) {
    return Boolean(getById(id)?.enabled);
}

export function isExtensionUrl(url) {
    return url.startsWith(MOZ_EXTENSION_PROTOCOL);
}

export function isOwnUrl(url) {
    return url.startsWith(Constants.STG_BASE_URL) || extractHost(url) === OWN_ID;
}

export function canOpenUrl(url) {
    if (isOwnUrl(url)) {
        return true;
    }

    const host = extractHost(url);

    return uuidById.has(host) || idByUUID.has(host);
}

function getOwnPath(url) {
    return url.startsWith(Constants.STG_BASE_URL) ? new URL(url).pathname.slice(1) : null;
}

// a page of the addon that wraps the url in its search key "url"
export function isWrapperUrl(url) {
    return Constants.PAGES.WRAPPER_PATHS.includes(getOwnPath(url));
}

/* export function hasTreeTabs() {
    return Constants.TREE_TABS_EXTENSIONS.some(isEnabled);
} */

export function getConflicted() {
    return Constants.CONFLICTED_EXTENSIONS.map(getById).filter(Boolean);
}

export function detectConflicted() {
    for (const id of Constants.CONFLICTED_EXTENSIONS) {
        if (isEnabled(id)) {
            if (!isIgnoredConflicted(id)) {
                logger.warn('detectConflicted', id);
                return id;
            }
        } else if (isIgnoredConflicted(id)) {
            dontIgnoreConflicted(id);
        }
    }
}

export function isIgnoredConflicted(id) {
    return getIgnoredConflicted().includes(id);
}

export function ignoreConflicted(id) {
    const ignored = getIgnoredConflicted();

    if (!ignored.includes(id)) {
        storage.ignoredConflicted = [...ignored, id];
    }
}

export function dontIgnoreConflicted(id) {
    storage.ignoredConflicted = getIgnoredConflicted().filter(extId => extId !== id);
}

function getIgnoredConflicted() {
    return storage.ignoredConflicted ?? [];
}

export async function loadIconUrl(id, defaultUrl = null, size = 32) {
    const apiUrl = Utils.formatUrl(Constants.MOZILLA_API.ADDON, {id});

    try {
        const response = await fetch(apiUrl);

        if (response.ok) {
            const data = await response.json();
            return data.icons[size] || data.icon_url || defaultUrl;
        }
    } catch (e) {
        logger.logError(["can't load icon for", id], e);
    }

    return defaultUrl;
}

function extractHost(url) {
    return MOZ_EXTENSION_URL_REGEXP.exec(url)?.[1];
}

function replaceHost(url, host) {
    return url.replace(MOZ_EXTENSION_URL_REGEXP, () => `${MOZ_EXTENSION_PROTOCOL}//${host}`);
}

export function extractUUID(url) {
    const host = extractHost(url);

    return Utils.isUUID(host) ? host : uuidById.get(host);
}

export function extractId(url) {
    const host = extractHost(url);

    return Utils.isUUID(host) ? idByUUID.get(host) : host;
}

export function urlToId(url) {
    const host = extractHost(url);

    return idByUUID.has(host) ? replaceHost(url, idByUUID.get(host)) : url;
}

export function urlToUUID(url) {
    const host = extractHost(url);

    return uuidById.has(host) ? replaceHost(url, uuidById.get(host)) : url;
}

// the url the browser opens the page by, null when it cannot: an extension page it cannot serve (docs/BEHAVIOR-CREATE-TABS.md §34) or a url tabs.create refuses (§16)
export function urlToBrowserOrNull(url) {
    if (isExtensionUrl(url)) {
        return canOpenUrl(url) ? urlToUUID(url) : null;
    }

    return Utils.isUrlAllowToCreate(url) ? url : null;
}

/* export function tabsToId(tabs) {
    for (const tab of tabs) {
        tab.url = urlToId(tab.url);
    }

    return tabs;
}

export function tabsToUUID(tabs) {
    for (const tab of tabs) {
        tab.url = urlToUUID(tab.url);
    }

    return tabs;
} */
