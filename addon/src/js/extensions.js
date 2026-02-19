
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
import * as Windows from './windows.js';
import * as Utils from './utils.js';

export const {onEnabled, onDisabled, onInstalled, onUninstalled} = Listeners.management;

const logger = new Logger(Constants.MODULES.EXTENSIONS);
const storage = localStorage.create(Constants.MODULES.EXTENSIONS);
const MOZ_EXTENSION_URL_REGEXP = /^moz-extension:\/\/([^\/]+)/;

const extensions = [... await (self.__extensionsLoadPromise ??= load())];

const onChangedListeners = new Set;
const autoDetectConflicted = new URL(import.meta.url).searchParams.has('auto-detect-conflicted');

Listeners.extension.onStart.add(() => autoDetectConflicted && detectConflicted());
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

    extensions.length = 0;
    extensions.push(...await load());

    if (autoDetectConflicted) {
        detectConflicted();
    }

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
    const log = logger.start('load');

    let result = [];

    try {
        const addons = await browser.management.getAll();
        result = addons.filter(addon => addon.type === browser.management.ExtensionType.EXTENSION);
        log.stop();
    } catch (e) {
        log.logError("can't load extensions", e).stopError();
    }

    return result;
}

export function getById(id) {
    return extensions.find(ext => ext.id === id);
}

export function isInstalled(id) {
    return !!getById(id);
}

export function isEnabled(id) {
    return getById(id)?.enabled;
}

export function hasTreeTabs() {
    return Constants.TREE_TABS_EXTENSIONS.some(isEnabled);
}

export function getConflicted() {
    return Constants.CONFLICTED_EXTENSIONS.map(getById).filter(Boolean);
}

export function detectConflicted() {
    for (const id of Constants.CONFLICTED_EXTENSIONS) {
        if (isEnabled(id)) {
            if (!isIgnoredConflicted(id)) {
                logger.warn('detectConflicted', id);
                Windows.createPopup({
                    url: Constants.PAGES.HELP.CONFLICTED_EXTENSIONS,
                });
                break;
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

export function getByUUID(uuid) {
    if (Utils.isUUID(uuid)) {
        for (const ext of extensions) {
            if (ext.hostPermissions?.some(url => url.includes(uuid))) {
                return ext;
            }
        }
    }
}

export function extractUUID(url) {
    const [, uuid] = MOZ_EXTENSION_URL_REGEXP.exec(url) ?? [];
    return Utils.isUUID(uuid) ? uuid : null;
}

function UUIDtoId(uuid) {
    return getByUUID(uuid)?.id;
}

function idToUUID(id) {
    for (const url of getById(id)?.hostPermissions ?? []) {
        const uuid = extractUUID(url);

        if (uuid) {
            return uuid;
        }
    }
}

export function tabsToId(tabs) {
    replaceTabs(tabs, UUIDtoId);
}

export function tabsToUUID(tabs) {
    replaceTabs(tabs, idToUUID);
}

function replaceTabs(tabs, func) {
    for (const tab of tabs) {
        tab.url = tab.url.replace(MOZ_EXTENSION_URL_REGEXP, (match, value) => {
            value = func(value) ?? value;
            return `moz-extension://${value}`;
        });
    }
}
