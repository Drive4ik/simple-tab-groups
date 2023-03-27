import Logger from './logger.js';
import * as Constants from './constants.js';
import * as Utils from './utils.js';
import * as Urls from './urls.js';

const logger = new Logger('Management');

const extensions = self.cacheStorage.extensions;

export async function init() {
    const log = logger.start('init');

    await reloadExtensions();

    browser.management.onEnabled.addListener(onChanged);
    browser.management.onDisabled.addListener(onChanged);
    browser.management.onInstalled.addListener(onChanged);
    browser.management.onUninstalled.addListener(onChanged);

    log.stop();
}

async function reloadExtensions() {
    const log = logger.start('reloadExtensions');
    await Utils.wait(100);

    clearExtensions();

    let addons = await browser.management.getAll();

    addons.forEach(addon => {
        if (addon.type === browser.management.ExtensionType.EXTENSION) {
            extensions[addon.id] = addon;
        }
    });

    log.stop();
}

function clearExtensions() {
    for (let extId in extensions) delete extensions[extId];
}

async function onChanged({type}) {
    if (type === browser.management.ExtensionType.EXTENSION) {
        await reloadExtensions();
        await detectConflictedExtensions();
    }
}

export function isEnabled(id) {
    return extensions[id]?.enabled;
}

export async function detectConflictedExtensions() {
    if (Constants.CONFLICTED_EXTENSIONS.some(isEnabled)) {
        await Urls.openHelp('extensions-that-conflict-with-stg');
    }
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

export function getExtensionByUUID(uuid) {
    if (!uuid) {
        return;
    }

    for (let i in extensions) {
        if (extensions[i]?.hostPermissions?.some(url => url.includes(uuid))) {
            return extensions[i];
        }
    }
}
