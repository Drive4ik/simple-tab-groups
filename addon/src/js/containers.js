import * as Constants from './constants.js';
import * as ConstantsBrowser from './constants-browser.js';
import Logger, {catchFunc} from './logger.js';
import Notification from './notification.js';
import * as Utils from './utils.js';
import * as Groups from './groups.js';
import backgroundSelf from './background.js';
import cacheStorage, {createStorage} from './cache-storage.js';

const logger = new Logger('Containers');

const containers = cacheStorage.containers ??= createStorage({});

export const DEFAULT = {
    cookieStoreId: Constants.DEFAULT_COOKIE_STORE_ID,
    name: browser.i18n.getMessage('noContainerTitle'),
};

export const TEMPORARY = cacheStorage.TEMPORARY ??= createStorage({
    color: 'toolbar',
    colorCode: false,
    cookieStoreId: Constants.TEMPORARY_CONTAINER,
    icon: Constants.TEMPORARY_CONTAINER_ICON,
    iconUrl: ConstantsBrowser.getContainerIconUrl(Constants.TEMPORARY_CONTAINER_ICON),
    name: browser.i18n.getMessage('temporaryContainerTitle'),
});

const tmpUniq = Utils.getRandomInt();

let LISTENING_EVENTS = true;
if (Constants.IS_BACKGROUND_PAGE) {
    browser.contextualIdentities.onCreated.addListener(catchFunc(onCreated, logger));
    browser.contextualIdentities.onUpdated.addListener(catchFunc(onUpdated, logger));
    browser.contextualIdentities.onRemoved.addListener(catchFunc(onRemoved, logger));
}

export async function init(temporaryContainerTitle) {
    const log = logger.start('init', {temporaryContainerTitle});

    setTemporaryContainerTitle(temporaryContainerTitle);

    // CONTAINER PROPS:
    // color: "blue"
    // colorCode: "#37adff"
    // cookieStoreId: "firefox-container-1"
    // icon: "fingerprint"
    // iconUrl: "resource://usercontext-content/fingerprint.svg"
    // name: "Personal"

    await load();

    log.stop();
}

export async function load(containersStorage = containers) {
    const log = logger.start('load');

    const loadedContainers = await browser.contextualIdentities.query({}).catch(log.onCatch('cant load containers'));

    for (const cookieStoreId in containersStorage) {
        delete containersStorage[cookieStoreId];
    }

    log.stop();
    return Utils.arrayToObj(loadedContainers, 'cookieStoreId', containersStorage);
}

function onCreated({contextualIdentity}) {
    if (!LISTENING_EVENTS) {
        return;
    }

    containers[contextualIdentity.cookieStoreId] = contextualIdentity;

    if (contextualIdentity.name === (TEMPORARY.name + tmpUniq)) {
        return;
    }

    backgroundSelf.sendMessageFromBackground('containers-updated');
}

function onUpdated({contextualIdentity}) {
    if (!LISTENING_EVENTS) {
        return;
    }

    const {cookieStoreId} = contextualIdentity,
        isOldContainerNameAreTmp = containers[cookieStoreId].name === (TEMPORARY.name + tmpUniq);

    if (!isOldContainerNameAreTmp && containers[cookieStoreId].name !== contextualIdentity.name) {
        if (isTemporary(cookieStoreId) && !isTemporary(null, contextualIdentity)) {
            Notification(['thisContainerIsNotTemporary', contextualIdentity.name]);
        } else if (!isTemporary(cookieStoreId) && isTemporary(null, contextualIdentity)) {
            Notification(['thisContainerNowIsTemporary', contextualIdentity.name]);
        }
    }

    containers[cookieStoreId] = contextualIdentity;

    if (isOldContainerNameAreTmp) {
        return;
    }

    backgroundSelf.sendMessageFromBackground('containers-updated');
}

async function onRemoved({contextualIdentity}) {
    if (!LISTENING_EVENTS) {
        return;
    }

    const log = logger.start('onRemoved', contextualIdentity);

    const isTemporaryContainer = isTemporary(contextualIdentity.cookieStoreId, contextualIdentity);

    delete containers[contextualIdentity.cookieStoreId];

    if (isTemporaryContainer) {
        log.stop('isTemporaryContainer');
        return;
    }

    if (!backgroundSelf.inited) {
        log.stopError('background not inited');
        return;
    }

    const {groups} = await Groups.load();
    const needSaveGroups = Groups.normalizeContainersInGroups(groups);

    if (needSaveGroups) {
        await Groups.save(groups);
    }

    backgroundSelf.sendMessageFromBackground('containers-updated');
    log.stop();
}


export function isDefault(cookieStoreId) {
    return !cookieStoreId || DEFAULT.cookieStoreId === cookieStoreId || cookieStoreId.includes('default');
}

export function isTemporary(cookieStoreId, contextualIdentity = null, containersStorage = containers) {
    if (cookieStoreId === TEMPORARY.cookieStoreId) {
        return true;
    }

    contextualIdentity ??= containersStorage[cookieStoreId];

    if (!contextualIdentity) {
        return false;
    }

    return contextualIdentity.name === getTemporaryContainerName(contextualIdentity.cookieStoreId);
}

const containerIdRegExp = /\d+$/;
function getTemporaryContainerName(cookieStoreId) {
    const [containerId] = containerIdRegExp.exec(cookieStoreId);
    return TEMPORARY.name + ' ' + containerId;
}

export async function createTemporaryContainer(containersStorage = containers) {
    const log = logger.start('createTemporaryContainer');

    const {cookieStoreId} = await create({
        name: TEMPORARY.name + tmpUniq,
        color: TEMPORARY.color,
        icon: TEMPORARY.icon,
    }, containersStorage).catch(log.onCatch("can't create"));

    await update(cookieStoreId, {
        name: getTemporaryContainerName(cookieStoreId),
    }, containersStorage).catch(log.onCatch("can't update"));

    log.stop(cookieStoreId);

    return cookieStoreId;
}

export async function update(cookieStoreId, details, containersStorage = containers) {
    const log = logger.start('update', cookieStoreId, details);

    Object.assign(containersStorage[cookieStoreId], details);

    const contextualIdentity = await browser.contextualIdentities.update(cookieStoreId, details)
        .catch(log.onCatch("can't update"));

    containersStorage[cookieStoreId] = contextualIdentity;

    log.stop();

    return contextualIdentity;
}

export async function remove(cookieStoreIds, containersStorage = containers) {
    const log = logger.start('remove', cookieStoreIds);

    for (const cookieStoreId of [cookieStoreIds].flat()) {
        try {
            await browser.contextualIdentities.remove(cookieStoreId);
            delete containersStorage[cookieStoreId];
        } catch (e) {
            log.logError("can't remove", e);
        }
    }

    log.stop();
}

export async function create(details, containersStorage = containers) {
    const log = logger.start('create', details);

    const contextualIdentity = await browser.contextualIdentities.create(details)
        .catch(log.onCatch("can't create"));

    containersStorage[contextualIdentity.cookieStoreId] = contextualIdentity;

    log.stop();

    return contextualIdentity;
}

export async function findExistOrCreateSimilar(cookieStoreId, containerData = null, storageMap = new Map, containersStorage = containers) {
    if (isDefault(cookieStoreId)) {
        return DEFAULT.cookieStoreId;
    }

    if (containersStorage[cookieStoreId]) {
        return cookieStoreId;
    }

    if (!storageMap.has(cookieStoreId)) {
        if (containerData) {
            for (const csId in containersStorage) {
                if (
                    !isTemporary(csId, undefined, containersStorage) &&
                    containerData.name === containersStorage[csId].name &&
                    containerData.color === containersStorage[csId].color &&
                    containerData.icon === containersStorage[csId].icon
                ) {
                    storageMap.set(cookieStoreId, csId);
                    break;
                }
            }

            if (!storageMap.has(cookieStoreId)) {
                const {cookieStoreId: csId} = await create({
                    name: containerData.name,
                    color: containerData.color,
                    icon: containerData.icon,
                }, containersStorage);
                storageMap.set(cookieStoreId, csId);
            }
        } else {
            storageMap.set(cookieStoreId, await createTemporaryContainer(containersStorage));
        }
    }

    return storageMap.get(cookieStoreId);
}

export function get(cookieStoreId, containersStorage = containers) {
    if (containersStorage[cookieStoreId]) {
        return {...containersStorage[cookieStoreId]};
    } else if (isDefault(cookieStoreId)) {
        return {...DEFAULT};
    } else if (isTemporary(cookieStoreId, undefined, containersStorage)) {
        return {...TEMPORARY};
    }

    return null;
}

export function query(params = {}, containersStorage = containers) {
    params.defaultContainer ??= false;
    params.temporaryContainers ??= false;
    params.temporaryContainer ??= false;

    const result = {};

    if (params.defaultContainer) {
        // add default container to start of obj
        result[DEFAULT.cookieStoreId] = {...DEFAULT};
    }

    for (const cookieStoreId in containersStorage) {
        if (
            params.temporaryContainers ||
            !isTemporary(cookieStoreId, undefined, containersStorage)
        ) {
            result[cookieStoreId] = {...containersStorage[cookieStoreId]};
        }
    }

    if (params.temporaryContainer) {
        // add temporary container to end of obj
        result[TEMPORARY.cookieStoreId] = {...TEMPORARY};
    }

    return result;
}

export function getToExport(storageData, containersStorage = containers) {
    const containersToExport = new Set;

    for (const group of storageData.groups) {
        group.tabs.forEach(tab => containersToExport.add(tab.cookieStoreId));
        containersToExport.add(group.newTabContainer);
        group.catchTabContainers.forEach(cookieStoreId => containersToExport.add(cookieStoreId));
        group.excludeContainersForReOpen.forEach(cookieStoreId => containersToExport.add(cookieStoreId));
    }

    for (const cookieStoreId of containersToExport) {
        if (isDefault(cookieStoreId) || isTemporary(cookieStoreId, undefined, containersStorage)) {
            containersToExport.delete(cookieStoreId);
        }
    }

    const result = {};

    for (const cookieStoreId of containersToExport) {
        result[cookieStoreId] = {...containersStorage[cookieStoreId]};
    }

    return result;
}

// normalize default cookie store id: icecat-default => firefox-default
export function mapDefaultContainer(storageData, defaultCookieStoreId) {
    function normalize(group) {
        if (!group) {
            return;
        }

        group.tabs?.forEach(tab => {
            if (tab.cookieStoreId && isDefault(tab.cookieStoreId)) {
                tab.cookieStoreId = defaultCookieStoreId;
            }
        });

        if (group.newTabContainer && isDefault(group.newTabContainer)) {
            group.newTabContainer = defaultCookieStoreId;
        }

        if (group.catchTabContainers) {
            group.catchTabContainers = group.catchTabContainers.map(cookieStoreId => {
                return isDefault(cookieStoreId) ? defaultCookieStoreId : cookieStoreId;
            });
        }

        if (group.excludeContainersForReOpen) {
            group.excludeContainersForReOpen = group.excludeContainersForReOpen.map(cookieStoreId => {
                return isDefault(cookieStoreId) ? defaultCookieStoreId : cookieStoreId;
            });
        }
    }

    storageData.groups?.forEach(normalize);

    normalize(storageData.defaultGroupProps);
}

export async function removeUnusedTemporaryContainers(tabs, containersStorage = containers) {
    const log = logger.start('removeUnusedTemporaryContainers');

    const tabContainers = new Set(tabs.map(tab => tab.cookieStoreId));

    const tempContainersToRemove = Object.keys(containersStorage)
        .filter(cookieStoreId => isTemporary(cookieStoreId, null, containersStorage) && !tabContainers.has(cookieStoreId));

    if (!tempContainersToRemove.length) {
        log.stop('not found');
        return;
    }

    log.log('removing...');

    await remove(tempContainersToRemove, containersStorage);

    log.stop('removed:', tempContainersToRemove.length);
}

export function setTemporaryContainerTitle(temporaryContainerTitle) {
    TEMPORARY.name = temporaryContainerTitle;
}

export function getTemporaryContainerTitle() {
    return TEMPORARY.name;
}

export async function updateTemporaryContainerTitle(temporaryContainerTitle, containersStorage = containers) {
    const log = logger.start('updateTemporaryContainerTitle', temporaryContainerTitle);

    const cookieStoreIds = Object.keys(containersStorage)
        .filter(cookieStoreId => isTemporary(cookieStoreId, null, containersStorage));

    setTemporaryContainerTitle(temporaryContainerTitle);

    log.log('cookieStoreIds', cookieStoreIds);

    if (cookieStoreIds.length) {
        LISTENING_EVENTS = false;

        for (const cookieStoreId of cookieStoreIds) {
            await update(cookieStoreId, {
                name: getTemporaryContainerName(cookieStoreId),
            }, containersStorage).catch(log.onCatch(["can't update", cookieStoreId]));
        }

        LISTENING_EVENTS = true;

        backgroundSelf.sendMessageFromBackground('containers-updated'); // update container temporary name on tabs will work only on not archived groups
    }

    log.stop();
}
