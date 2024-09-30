import '/js/prefixed-storage.js';
import Logger from './logger.js';
import * as Constants from './constants.js';
import * as Urls from './urls.js';
import cacheStorage, {createStorage} from './cache-storage.js';

const logger = new Logger('Management');

const storage = localStorage.create('management');

const extensions = cacheStorage.extensions ??= createStorage({});

export async function init() {
    const log = logger.start('init');

    await load();

    browser.management.onEnabled.addListener(onChanged);
    browser.management.onDisabled.addListener(onChanged);
    browser.management.onInstalled.addListener(onChanged);
    browser.management.onUninstalled.addListener(onChanged);

    log.stop();
}

async function onChanged({type}) {
    if (type === browser.management.ExtensionType.EXTENSION) {
        await load();
        detectConflictedExtensions();
    }
}

async function load(extensionsStorage = extensions) {
    const log = logger.start('load');

    await new Promise(res => setTimeout(res, 100));

    const addons = await browser.management.getAll().catch(log.onCatch('cant load extensions'));

    for (const id in extensionsStorage) delete extensionsStorage[id];

    addons.forEach(addon => {
        if (addon.type === browser.management.ExtensionType.EXTENSION) {
            extensionsStorage[addon.id] = addon;
        }
    });

    log.stop();

    return extensionsStorage;
}

export function isEnabled(id, extensionsStorage = extensions) {
    return extensionsStorage[id]?.enabled;
}

export function detectConflictedExtensions(extensionsStorage = extensions) {
    Constants.CONFLICTED_EXTENSIONS.some(id => {
        if (isEnabled(id, extensionsStorage)) {
            if (!isIgnoredConflictedExtension(id)) {
                Urls.openUrl('extensions-that-conflict-with-stg', true);
                return true;
            }
        } else if (extensionsStorage[id] && isIgnoredConflictedExtension(id)) {
            dontIgnoreConflictedExtension(id);
        }
    });
}

export function isIgnoredConflictedExtension(extId) {
    return getIgnoredConflictedExtensions().includes(extId);
}

export function ignoreConflictedExtension(extId) {
    const ignored = getIgnoredConflictedExtensions();

    if (!ignored.includes(extId)) {
        ignored.push(extId);
        storage.ignoredConflictedExtensions = ignored;
    }
}

export function dontIgnoreConflictedExtension(extId) {
    storage.ignoredConflictedExtensions = getIgnoredConflictedExtensions().filter(id => id !== extId);
}

export function getIgnoredConflictedExtensions() {
    return storage.ignoredConflictedExtensions ?? [];
}

// can't have permission to read other addon icon :((
/* export function getExtensionIcon({icons} = {}) {
    if (Array.isArray(icons)) {
        let maxSize = Math.max(...icons.map(({size}) => size)),
            {url} = icons.find(icon => icon.size === maxSize);

        return url;
    }

    return '/icons/extension-generic.svg';
} */

export function getExtensionByUUID(uuid, extensionsStorage = extensions) {
    if (!uuid) {
        return;
    }

    for (let i in extensionsStorage) {
        if (extensionsStorage[i]?.hostPermissions?.some(url => url.includes(uuid))) {
            return extensionsStorage[i];
        }
    }
}
