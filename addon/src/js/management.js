
import Listeners from './listeners.js\
?management.onEnabled\
&management.onDisabled\
&management.onInstalled\
&management.onUninstalled\
';
import './prefixed-storage.js';
import Logger, {catchFunc} from './logger.js';
import * as Constants from './constants.js';
import * as Utils from './utils.js';
import * as Urls from './urls.js';

const logger = new Logger(Constants.MODULES.MANAGEMENT);

const storage = localStorage.create(Constants.MODULES.MANAGEMENT);

const extensions = {};

if (Constants.IS_BACKGROUND_PAGE) {
    const onChangedBinded = catchFunc(onChanged, logger);

    Listeners.management.onEnabled(onChangedBinded);
    Listeners.management.onDisabled(onChangedBinded);
    Listeners.management.onInstalled(onChangedBinded);
    Listeners.management.onUninstalled(onChangedBinded);
}

export async function init() {
    const log = logger.start('init');

    await load();

    log.stop();
}

async function load(extensionsStorage = extensions) {
    const log = logger.start('load');

    for (const id in extensionsStorage) {
        delete extensionsStorage[id];
    }

    await Utils.wait(100);

    const addons = await browser.management.getAll().catch(log.onCatch("can't load extensions"));

    for (const addon of addons) {
        if (addon.type === browser.management.ExtensionType.EXTENSION) {
            extensionsStorage[addon.id] = addon;
        }
    }

    log.stop();

    return extensionsStorage;
}

async function onChanged({type}) {
    if (type === browser.management.ExtensionType.EXTENSION) {
        logger.log('onChanged', arguments[0]);
        await load();
        detectConflictedExtensions();
    }
}

export function isInstalled(id, extensionsStorage = extensions) {
    return !!extensionsStorage[id];
}

export function isEnabled(id, extensionsStorage = extensions) {
    return extensionsStorage[id]?.enabled;
}

export function detectConflictedExtensions(extensionsStorage = extensions) {
    for (const id of Constants.CONFLICTED_EXTENSIONS) {
        if (isEnabled(id, extensionsStorage)) {
            if (!isIgnoredConflictedExtension(id)) {
                logger.warn('detectConflictedExtensions', id);
                Urls.openUrl('extensions-that-conflict-with-stg', true);
                break;
            }
        } else if (isIgnoredConflictedExtension(id)) {
            dontIgnoreConflictedExtension(id);
        }
    }
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
    if (Utils.isUUID(uuid)) {
        for (const id in extensionsStorage) {
            if (extensionsStorage[id]?.hostPermissions?.some(url => url.includes(uuid))) {
                return extensionsStorage[id];
            }
        }
    }
}

const MOZ_EXTENSION_URL_REGEXP = /^moz-extension:\/\/([^\/]+)/;

export function extractUUID(url) {
    const [, uuid] = MOZ_EXTENSION_URL_REGEXP.exec(url) ?? [];
    return Utils.isUUID(uuid) ? uuid : null;
}

function UUIDtoId(uuid, extensionsStorage = extensions) {
    return getExtensionByUUID(uuid, extensionsStorage)?.id;
}

function idToUUID(id, extensionsStorage = extensions) {
    if (extensionsStorage[id]?.hostPermissions) {
        for (const url of extensionsStorage[id].hostPermissions) {
            const uuid = extractUUID(url);

            if (uuid) {
                return uuid;
            }
        }
    }
}

export function replaceMozExtensionTabUrls(tabs, replaceTo, extensionsStorage = extensions) {
    const func = replaceTo === 'id' ? UUIDtoId : idToUUID;

    for (const tab of tabs) {
        tab.url = tab.url.replace(MOZ_EXTENSION_URL_REGEXP, (match, value) => {
            value = func(value, extensionsStorage) ?? value;
            return `moz-extension://${value}`;
        });
    }
}
