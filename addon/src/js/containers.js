import * as Constants from './constants.js';
import Logger from './logger.js';
import * as Utils from './utils.js';
import * as Groups from './groups.js';
import JSON from './json.js';
import backgroundSelf from './background.js';
import cacheStorage from './cache-storage.js';

const logger = new Logger('Containers');

// init storage
cacheStorage.containers ??= {
    containers: {},
    mappedContainerCookieStoreId: {},
    defaultContainerOptions: {
        cookieStoreId: Constants.DEFAULT_COOKIE_STORE_ID,
        name: browser.i18n.getMessage('noContainerTitle'),
    },
};

const temporaryContainerDefaultTitle = browser.i18n.getMessage('temporaryContainerTitle'),
    containerIdRegExp = /\d+$/,
    tmpContainerTimeStamp = Date.now();

const containers = cacheStorage.containers.containers;
const mappedContainerCookieStoreId = cacheStorage.containers.mappedContainerCookieStoreId;
const defaultContainerOptions = cacheStorage.containers.defaultContainerOptions;

containers[Constants.TEMPORARY_CONTAINER] ??= {
    color: 'toolbar',
    colorCode: false,
    cookieStoreId: Constants.TEMPORARY_CONTAINER,
    icon: 'chill',
    iconUrl: 'resource://usercontext-content/chill.svg',
    name: temporaryContainerDefaultTitle,
};

const temporaryContainerOptions = containers[Constants.TEMPORARY_CONTAINER];

export async function init(temporaryContainerTitle) {
    const log = logger.start('init', {temporaryContainerTitle});

    temporaryContainerOptions.name = temporaryContainerTitle;

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
    browser.contextualIdentities.onRemoved.addListener(Utils.catchFunc(onRemoved));

    log.stop();
}

async function load() {
    for(let cookieStoreId in containers) {
        if (cookieStoreId !== Constants.TEMPORARY_CONTAINER) {
            delete containers[cookieStoreId];
        }
    }

    let _containers = await browser.contextualIdentities.query({});

    _containers.forEach(container => containers[container.cookieStoreId] = container);
}

function onCreated({contextualIdentity}) {
    containers[contextualIdentity.cookieStoreId] = contextualIdentity;

    if (contextualIdentity.name === (temporaryContainerOptions.name + tmpContainerTimeStamp)) {
        return;
    }

    backgroundSelf.sendMessage('containers-updated');
}

function onUpdated({contextualIdentity}) {
    let {cookieStoreId} = contextualIdentity,
        isOldContainerNameAreTmp = containers[cookieStoreId].name === (temporaryContainerOptions.name + tmpContainerTimeStamp);

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
    let isTemporaryContainer = isTemporary(contextualIdentity.cookieStoreId);

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

export function isTemporary(cookieStoreId, contextualIdentity, excludeMainTemporaryContainerName = false) {
    if (cookieStoreId === Constants.TEMPORARY_CONTAINER) {
        if (excludeMainTemporaryContainerName) {
            return false;
        }

        return true;
    }

    if (!contextualIdentity) {
        contextualIdentity = containers[cookieStoreId];
    }

    if (!contextualIdentity) {
        return false;
    }

    return contextualIdentity.name === getTemporaryContainerName(contextualIdentity.cookieStoreId);
}

function getTemporaryContainerName(cookieStoreId) {
    let [containerId] = containerIdRegExp.exec(cookieStoreId);
    return temporaryContainerOptions.name + ' ' + containerId;
}

export async function createTemporaryContainer() {
    let {cookieStoreId} = await browser.contextualIdentities.create({
        name: temporaryContainerOptions.name + tmpContainerTimeStamp,
        color: temporaryContainerOptions.color,
        icon: temporaryContainerOptions.icon,
    });

    await browser.contextualIdentities.update(cookieStoreId, {
        name: getTemporaryContainerName(cookieStoreId),
    });

    return cookieStoreId;
}

export function remove(cookieStoreIds) {
    return Promise.all(cookieStoreIds.map(cookieStoreId => browser.contextualIdentities.remove(cookieStoreId).catch(() => {})));
}

export async function normalize(cookieStoreId, containerData) {
    if (isDefault(cookieStoreId)) {
        return Constants.DEFAULT_COOKIE_STORE_ID;
    }

    if (containers[cookieStoreId]) {
        return cookieStoreId;
    }

    // TODO надо ли очищать mappedContainerCookieStoreId ????
    if (!mappedContainerCookieStoreId[cookieStoreId]) {
        if (containerData) {
            for (let csId in containers) {
                if (
                    !isTemporary(csId) &&
                    containerData.name === containers[csId].name &&
                    containerData.color === containers[csId].color &&
                    containerData.icon === containers[csId].icon
                ) {
                    mappedContainerCookieStoreId[cookieStoreId] = csId;
                    break;
                }
            }

            if (!mappedContainerCookieStoreId[cookieStoreId]) {
                let {cookieStoreId: csId} = await browser.contextualIdentities.create({
                    name: containerData.name,
                    color: containerData.color,
                    icon: containerData.icon,
                });
                mappedContainerCookieStoreId[cookieStoreId] = csId;
            }
        } else {
            mappedContainerCookieStoreId[cookieStoreId] = await createTemporaryContainer();
        }
    }

    return mappedContainerCookieStoreId[cookieStoreId];
}

export function get(cookieStoreId, key = null, withDefaultContainer = false) {
    let result = null;

    if (containers[cookieStoreId]) {
        result = containers[cookieStoreId];
    } else if (containers[mappedContainerCookieStoreId[cookieStoreId]]) {
        result = containers[mappedContainerCookieStoreId[cookieStoreId]];
    } else if (withDefaultContainer) {
        result = defaultContainerOptions;
    }

    if (result) {
        return key ? result[key] : {...result};
    }

    return null;
}

export function getAll(withDefaultContainer) {
    let _containers = JSON.clone(containers);

    for (let cookieStoreId in _containers) {
        if (isTemporary(cookieStoreId)) {
            delete _containers[cookieStoreId];
        }
    }

    if (withDefaultContainer) {
        _containers = {
            [Constants.DEFAULT_COOKIE_STORE_ID]: {...defaultContainerOptions},
            ..._containers,
        };
    }

    // add temporary container to end of obj
    _containers[Constants.TEMPORARY_CONTAINER] = {...temporaryContainerOptions, name: temporaryContainerDefaultTitle};

    return _containers;
}

export async function removeUnusedTemporaryContainers(tabs) {
    const log = logger.start('removeUnusedTemporaryContainers');
    let tabContainers = new Set(tabs.map(tab => tab.cookieStoreId));

    let tempContainersToRemove = Object.keys(containers)
        .filter(cookieStoreId => isTemporary(cookieStoreId, null, true) && !tabContainers.has(cookieStoreId));

    if (!tempContainersToRemove.length) {
        return log.stop();
    }

    log.log('removing temp containers');

    await remove(
        Object.keys(containers)
        .filter(cookieStoreId => isTemporary(cookieStoreId, null, true) && !tabContainers.has(cookieStoreId))
    );

    log.stop();
}

export async function updateTemporaryContainerTitle(temporaryContainerTitle) {
    let cookieStoreIds = Object.keys(containers).filter(cookieStoreId => isTemporary(cookieStoreId, null, true));

    temporaryContainerOptions.name = temporaryContainerTitle;

    if (cookieStoreIds.length) {
        browser.contextualIdentities.onUpdated.removeListener(onUpdated);

        await Promise.all(cookieStoreIds.map(function(cookieStoreId) {
            containers[cookieStoreId].name = getTemporaryContainerName(cookieStoreId);

            return browser.contextualIdentities.update(cookieStoreId, {
                name: containers[cookieStoreId].name,
            });
        }));

        browser.contextualIdentities.onUpdated.addListener(onUpdated);

        backgroundSelf.sendMessage('containers-updated'); // update container temporary name on tabs will work only on not archived groups
    }
}
