import * as Constants from './constants.js';
import * as BrowserConstants from '/js/browser-constants.js';
import Logger, {catchFunc} from './logger.js';
import * as Utils from './utils.js';
import * as Groups from './groups.js';
import JSON from './json.js';
import backgroundSelf from './background.js';
import cacheStorage, {createStorage} from './cache-storage.js';

const logger = new Logger('Containers');

const containers = cacheStorage.containers ??= createStorage({});

const defaultContainerOptions = {
    cookieStoreId: Constants.DEFAULT_COOKIE_STORE_ID,
    name: browser.i18n.getMessage('noContainerTitle'),
};

export const temporaryContainerOptions = containers[Constants.TEMPORARY_CONTAINER] ??= createStorage({
    color: 'toolbar',
    colorCode: false,
    cookieStoreId: Constants.TEMPORARY_CONTAINER,
    icon: Constants.TEMPORARY_CONTAINER_ICON,
    iconUrl: BrowserConstants.getContainerIconUrl(Constants.TEMPORARY_CONTAINER_ICON),
    name: browser.i18n.getMessage('temporaryContainerTitle'),
});

const tmpUniq = Utils.getRandomInt();

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

    browser.contextualIdentities.onCreated.addListener(onCreated);
    browser.contextualIdentities.onUpdated.addListener(onUpdated);
    browser.contextualIdentities.onRemoved.addListener(catchFunc(onRemoved));

    log.stop();
}

export async function load(containersStorage = containers) {
    const log = logger.start('load');

    const loadedContainers = await browser.contextualIdentities.query({}).catch(log.onCatch('cant load containers'));

    for(const cookieStoreId in containersStorage) {
        if (cookieStoreId !== Constants.TEMPORARY_CONTAINER) {
            delete containersStorage[cookieStoreId];
        }
    }

    log.stop();
    return Utils.arrayToObj(loadedContainers, 'cookieStoreId', containersStorage);
}

function onCreated({contextualIdentity}) {
    containers[contextualIdentity.cookieStoreId] = contextualIdentity;

    if (contextualIdentity.name === (temporaryContainerOptions.name + tmpUniq)) {
        return;
    }

    backgroundSelf.sendMessage('containers-updated');
}

function onUpdated({contextualIdentity}) {
    const {cookieStoreId} = contextualIdentity,
        isOldContainerNameAreTmp = containers[cookieStoreId].name === (temporaryContainerOptions.name + tmpUniq);

    if (!isOldContainerNameAreTmp && containers[cookieStoreId].name !== contextualIdentity.name) {
        if (isTemporary(cookieStoreId) && !isTemporary(null, contextualIdentity)) {
            Utils.notify(['thisContainerIsNotTemporary', contextualIdentity.name]);
        } else if (!isTemporary(cookieStoreId) && isTemporary(null, contextualIdentity)) {
            Utils.notify(['thisContainerNowIsTemporary', contextualIdentity.name]);
        }
    }

    containers[cookieStoreId] = contextualIdentity;

    if (isOldContainerNameAreTmp) {
        return;
    }

    backgroundSelf.sendMessage('containers-updated');
}

async function onRemoved({contextualIdentity}) {
    const log = logger.create('onRemoved', contextualIdentity)
    let isTemporaryContainer = isTemporary(contextualIdentity.cookieStoreId, contextualIdentity);

    delete containers[contextualIdentity.cookieStoreId];

    if (isTemporaryContainer) {
        log.stop('isTemporaryContainer');
        return;
    }

    if (!backgroundSelf.inited) {
        log.stopError('background not inited');
        return;
    }

    let {groups} = await Groups.load(),
        needSaveGroups = Groups.normalizeContainersInGroups(groups);

    if (needSaveGroups) {
        await Groups.save(groups);
    }

    backgroundSelf.sendMessage('containers-updated');
    log.stop();
}


export function isDefault(cookieStoreId) {
    return Constants.DEFAULT_COOKIE_STORE_ID === cookieStoreId || !cookieStoreId;
}

export function isTemporary(cookieStoreId, contextualIdentity, excludeMainTemporaryContainerName = false, containersStorage = containers) {
    if (cookieStoreId === Constants.TEMPORARY_CONTAINER) {
        if (excludeMainTemporaryContainerName) {
            return false;
        }

        return true;
    }

    if (!contextualIdentity) {
        contextualIdentity = containersStorage[cookieStoreId];
    }

    if (!contextualIdentity) {
        return false;
    }

    return contextualIdentity.name === getTemporaryContainerName(contextualIdentity.cookieStoreId);
}

const containerIdRegExp = /\d+$/;
function getTemporaryContainerName(cookieStoreId) {
    let [containerId] = containerIdRegExp.exec(cookieStoreId);
    return temporaryContainerOptions.name + ' ' + containerId;
}

export async function createTemporaryContainer(containersStorage = containers) {
    let {cookieStoreId} = await create({
        name: temporaryContainerOptions.name + tmpUniq,
        color: temporaryContainerOptions.color,
        icon: temporaryContainerOptions.icon,
    }, containersStorage);

    await update(cookieStoreId, {
        name: getTemporaryContainerName(cookieStoreId),
    }, containersStorage);

    return cookieStoreId;
}

export async function update(cookieStoreId, details, containersStorage = containers) {
    Object.assign(containersStorage[cookieStoreId], details);
    const contextualIdentity = await browser.contextualIdentities.update(cookieStoreId, details);
    containersStorage[cookieStoreId] = contextualIdentity;
    return contextualIdentity;
}

export async function remove(cookieStoreIds, containersStorage = containers) {
    await Promise.all(cookieStoreIds.map(async cookieStoreId => {
        delete containersStorage[cookieStoreId];
        await browser.contextualIdentities.remove(cookieStoreId).catch(() => {});
    }));
}

export async function create(details, containersStorage = containers) {
    const contextualIdentity = await browser.contextualIdentities.create(details);
    containersStorage[contextualIdentity.cookieStoreId] = contextualIdentity;
    return contextualIdentity;
}

export async function findExistOrCreateSimilar(cookieStoreId, containerData = null, storageMap = new Map, containersStorage = containers) {
    if (isDefault(cookieStoreId)) {
        return Constants.DEFAULT_COOKIE_STORE_ID;
    }

    if (containersStorage[cookieStoreId]) {
        return cookieStoreId;
    }

    if (!storageMap.has(cookieStoreId)) {
        if (containerData) {
            for (const csId in containersStorage) {
                if (
                    !isTemporary(csId, undefined, undefined, containersStorage) &&
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

export function get(cookieStoreId, key = null, withDefaultContainer = false, containersStorage = containers) {
    let result = null;

    if (containersStorage[cookieStoreId]) {
        result = containersStorage[cookieStoreId];
    } else if (withDefaultContainer) {
        result = defaultContainerOptions;
    }

    if (result) {
        return key ? result[key] : {...result};
    }

    return null;
}

export function getAll(withDefaultContainer, containersStorage = containers) {
    let containers = JSON.clone(containersStorage);

    for (const cookieStoreId in containers) {
        if (isTemporary(cookieStoreId, undefined, undefined, containersStorage)) {
            delete containers[cookieStoreId];
        }
    }

    if (withDefaultContainer) {
        containers = {
            [Constants.DEFAULT_COOKIE_STORE_ID]: {...defaultContainerOptions},
            ...containers,
        };
    }

    // add temporary container to end of obj
    containers[Constants.TEMPORARY_CONTAINER] = {...temporaryContainerOptions};

    return containers;
}

export function getToExport(storageData, containersStorage = containers) {
    const containersToExport = new Set;

    storageData.groups.forEach(group => {
        group.tabs.forEach(tab => {
            if (!isTemporary(tab.cookieStoreId, undefined, undefined, containersStorage)) {
                containersToExport.add(tab.cookieStoreId);
            }
        });

        containersToExport.add(group.newTabContainer);

        group.catchTabContainers.forEach(cookieStoreId => containersToExport.add(cookieStoreId));
        group.excludeContainersForReOpen.forEach(cookieStoreId => containersToExport.add(cookieStoreId));
    });

    containersToExport.delete(Constants.DEFAULT_COOKIE_STORE_ID);
    containersToExport.delete(Constants.TEMPORARY_CONTAINER);

    const result = {};

    [...containersToExport]
        .filter(Boolean)
        .forEach(cookieStoreId => result[cookieStoreId] = {...containersStorage[cookieStoreId]});

    return result;
}

export async function removeUnusedTemporaryContainers(tabs, containersStorage = containers) {
    const log = logger.start('removeUnusedTemporaryContainers');

    const tabContainers = new Set(tabs.map(tab => tab.cookieStoreId));

    const tempContainersToRemove = Object.keys(containersStorage)
        .filter(cookieStoreId => isTemporary(cookieStoreId, null, true, containersStorage) && !tabContainers.has(cookieStoreId));

    if (!tempContainersToRemove.length) {
        return log.stop('not found');
    }

    log.log('removing...');

    await remove(tempContainersToRemove, containersStorage);

    log.stop('removed:', tempContainersToRemove.length);
}

export function setTemporaryContainerTitle(temporaryContainerTitle) {
    temporaryContainerOptions.name = temporaryContainerTitle;
}

export function getTemporaryContainerTitle() {
    return temporaryContainerOptions.name;
}

export async function updateTemporaryContainerTitle(temporaryContainerTitle, containersStorage = containers) {
    const cookieStoreIds = Object.keys(containersStorage)
        .filter(cookieStoreId => isTemporary(cookieStoreId, null, true, containersStorage));

    setTemporaryContainerTitle(temporaryContainerTitle);

    if (cookieStoreIds.length) {
        const isInternalStorage = containersStorage === containers;

        if (isInternalStorage) {
            browser.contextualIdentities.onUpdated.removeListener(onUpdated);
        }

        await Promise.all(cookieStoreIds.map(async cookieStoreId => {
            await update(cookieStoreId, {
                name: getTemporaryContainerName(cookieStoreId),
            }, containersStorage);
        }));

        if (isInternalStorage) {
            browser.contextualIdentities.onUpdated.addListener(onUpdated);
        }

        backgroundSelf.sendMessage('containers-updated'); // update container temporary name on tabs will work only on not archived groups
    }
}
