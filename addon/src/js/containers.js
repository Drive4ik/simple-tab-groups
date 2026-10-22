
import Listeners from './listeners.js\
?contextualIdentities.onCreated\
&contextualIdentities.onUpdated\
&contextualIdentities.onRemoved\
';
import * as Constants from './constants.js';
import * as ConstantsBrowser from './constants-browser.js';
import Logger from './logger.js';
import Notification from './notification.js';
import Lang from './lang.js';
import * as ContainersBroadcast from './broadcast.js?channel=containers';
import * as Storage from './storage.js';

const logger = new Logger('Containers');

export const DEFAULT = {
    cookieStoreId: Constants.DEFAULT_COOKIE_STORE_ID,
    name: Lang('noContainerTitle'),
};
const TEMPORARY_SUFIX = '\u229E\u200D\u23F3'; // ⊞ + glue + ⏳
const SHARED_KEY = Symbol.for('__ext_containers_shared_state__');
const shared = self[SHARED_KEY] ??= {
    containers: await load(),
    onChangedListeners: new Set(),
    TEMPORARY: {
        color: 'toolbar',
        colorCode: false,
        cookieStoreId: Constants.TEMPORARY_CONTAINER,
        icon: Constants.TEMPORARY_CONTAINER_ICON,
        iconUrl: ConstantsBrowser.getContainerIconUrl(Constants.TEMPORARY_CONTAINER_ICON),
        name: await Storage.get('temporaryContainerTitle')
            .then(data => data.temporaryContainerTitle || Promise.reject(new Error('is empty')))
            .catch(e => {
                logger.logError("can't get temporaryContainerTitle from storage", e);
                return Lang('temporaryContainerTitle');
            }),
    },
};

export const TEMPORARY = shared.TEMPORARY;
const containers = shared.containers;
const onChangedListeners = shared.onChangedListeners;
const contextParams = new URL(import.meta.url).searchParams;

if (contextParams.has('add-listeners')) {
    addListeners();
} else {
    ContainersBroadcast.on('updated', ({data}) => {
        if (data.temporaryContainerTitle) {
            TEMPORARY.name = data.temporaryContainerTitle;
            logger.log('temporaryContainerTitle updated from broadcast');
        }

        if (data.containers) {
            Object.keys(containers).forEach(cookieStoreId => delete containers[cookieStoreId]);
            Object.assign(containers, data.containers);
            logger.log('containers updated from broadcast');
            processOnChangedListeners();
        }
    });
}

function broadcastUpdate(data) {
    ContainersBroadcast.send({action: 'updated', data}, {includeSelf: false});
}

function addListeners() {
    Listeners.contextualIdentities.onCreated.add(onCreated);
    Listeners.contextualIdentities.onUpdated.add(onUpdated);
    Listeners.contextualIdentities.onRemoved.add(onRemoved);
}

export function removeListeners() {
    Listeners.contextualIdentities.onCreated.remove(onCreated);
    Listeners.contextualIdentities.onUpdated.remove(onUpdated);
    Listeners.contextualIdentities.onRemoved.remove(onRemoved);
}

async function load() {
    const log = logger.start(load);

    let result = {};

    try {
        const containersArray = await browser.contextualIdentities.query({});
        result = Object.fromEntries(containersArray.map(container => [container.cookieStoreId, container]));
        log.stop();
    } catch (e) {
        log.logError("can't load containers", e).stopError();
    }

    return result;
}

function onCreated({contextualIdentity}) {
    containers[contextualIdentity.cookieStoreId] = contextualIdentity;

    if (contextualIdentity.name === TEMPORARY.name + TEMPORARY_SUFIX) {
        return;
    }

    broadcastUpdate({containers});
    processOnChangedListeners();
}

function onUpdated({contextualIdentity}) {
    const {cookieStoreId} = contextualIdentity;
    const isOldNameWasIntermediate = containers[cookieStoreId].name === TEMPORARY.name + TEMPORARY_SUFIX;

    if (!isOldNameWasIntermediate && containers[cookieStoreId].name !== contextualIdentity.name) {
        if (isTemporary(cookieStoreId) && !isTemporary(null, contextualIdentity)) {
            Notification(['thisContainerIsNotTemporary', contextualIdentity.name]);
        } else if (!isTemporary(cookieStoreId) && isTemporary(null, contextualIdentity)) {
            Notification(['thisContainerNowIsTemporary', contextualIdentity.name]);
        }
    }

    containers[cookieStoreId] = contextualIdentity;

    if (isOldNameWasIntermediate) {
        return;
    }

    broadcastUpdate({containers});
    processOnChangedListeners();
}

async function onRemoved({contextualIdentity}) {
    delete containers[contextualIdentity.cookieStoreId];

    if (isTemporary(contextualIdentity.cookieStoreId, contextualIdentity)) {
        return;
    }

    broadcastUpdate({containers});
    processOnChangedListeners();
}

export function onChanged(listener) {
    onChangedListeners.add(listener);
    return () => onChangedListeners.delete(listener);
}

function processOnChangedListeners() {
    for (const listener of onChangedListeners) {
        try {
            listener();
        } catch (e) {
            logger.logError(['onChangedListener:', listener.name], e);
        }
    }
}

export function isDefault(cookieStoreId) {
    return !cookieStoreId || DEFAULT.cookieStoreId === cookieStoreId || cookieStoreId.includes('default');
}

export function isTemporary(cookieStoreId, contextualIdentity = containers[cookieStoreId]) {
    if (cookieStoreId === TEMPORARY.cookieStoreId) {
        return true;
    }

    return contextualIdentity?.name === createTemporaryName(contextualIdentity?.cookieStoreId);
}

export async function createTemporary() {
    const log = logger.start(createTemporary);

    const {cookieStoreId} = await create({
        name: TEMPORARY.name + TEMPORARY_SUFIX,
        color: TEMPORARY.color,
        icon: TEMPORARY.icon,
    }).catch(log.onCatch("can't create"));

    const contextualIdentity = await update(cookieStoreId, {
        name: createTemporaryName(cookieStoreId),
    }).catch(log.onCatch("can't update"));

    broadcastUpdate({containers});

    log.stop(cookieStoreId);

    return contextualIdentity;
}

export async function create(details) {
    const contextualIdentity = await browser.contextualIdentities.create(details);
    containers[contextualIdentity.cookieStoreId] = contextualIdentity;
    return contextualIdentity;
}

async function update(cookieStoreId, details) {
    Object.assign(containers[cookieStoreId], details); // TODO check if need
    const contextualIdentity = await browser.contextualIdentities.update(cookieStoreId, details);
    containers[cookieStoreId] = contextualIdentity;
    return contextualIdentity;
}

async function remove(cookieStoreIds) {
    for (const cookieStoreId of cookieStoreIds) {
        await browser.contextualIdentities.remove(cookieStoreId);
        delete containers[cookieStoreId];
    }
}

export async function findExistOrCreateSimilar(cookieStoreId, containerData = null, storageMap = new Map) {
    if (isDefault(cookieStoreId)) {
        return DEFAULT.cookieStoreId;
    }

    if (containers[cookieStoreId]) {
        return cookieStoreId;
    }

    if (!storageMap.has(cookieStoreId)) {
        if (containerData) {
            for (const csId in containers) {
                if (
                    !isTemporary(csId) &&
                    containerData.name === containers[csId].name &&
                    containerData.color === containers[csId].color &&
                    containerData.icon === containers[csId].icon
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
                });
                storageMap.set(cookieStoreId, csId);
                broadcastUpdate({containers});
            }
        } else {
            storageMap.set(cookieStoreId, (await createTemporary()).cookieStoreId);
        }
    }

    return storageMap.get(cookieStoreId);
}

export function get(cookieStoreId) {
    if (containers[cookieStoreId]) {
        return {...containers[cookieStoreId]};
    } else if (isDefault(cookieStoreId)) {
        return {...DEFAULT};
    } else if (isTemporary(cookieStoreId)) {
        return {...TEMPORARY};
    }

    return null;
}

export function query(params = {}) {
    params.defaultContainer ??= false;
    params.temporaryContainers ??= false;
    params.temporaryContainer ??= false;

    const result = {};

    if (params.defaultContainer) {
        // add default container to start of obj
        result[DEFAULT.cookieStoreId] = {...DEFAULT};
    }

    for (const cookieStoreId in containers) {
        if (params.temporaryContainers || !isTemporary(cookieStoreId)) {
            result[cookieStoreId] = {...containers[cookieStoreId]};
        }
    }

    if (params.temporaryContainer) {
        // add temporary container to end of obj
        result[TEMPORARY.cookieStoreId] = {...TEMPORARY};
    }

    return result;
}

export function getToExport(storageData) {
    const containersToExport = new Set;

    for (const group of storageData.groups) {
        group.tabs.forEach(tab => containersToExport.add(tab.cookieStoreId));
        containersToExport.add(group.newTabContainer);
        group.catchTabContainers.forEach(cookieStoreId => containersToExport.add(cookieStoreId));
        group.excludeContainersForReOpen.forEach(cookieStoreId => containersToExport.add(cookieStoreId));
    }

    for (const cookieStoreId of containersToExport) {
        if (isDefault(cookieStoreId) || isTemporary(cookieStoreId)) {
            containersToExport.delete(cookieStoreId);
        }
    }

    const result = {};

    for (const cookieStoreId of containersToExport) {
        result[cookieStoreId] = {...containers[cookieStoreId]};
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

export async function removeTemporaryUnusedBy(tabs) {
    const log = logger.start(removeTemporaryUnusedBy);

    const tabContainers = new Set(tabs.map(tab => tab.cookieStoreId));

    const tempContainersToRemove = Object.keys(containers)
        .filter(cookieStoreId => isTemporary(cookieStoreId) && !tabContainers.has(cookieStoreId));

    await remove(tempContainersToRemove).catch(log.onCatch("can't remove"));

    broadcastUpdate({containers});

    log.stop('removed count:', tempContainersToRemove.length);
}

export async function updateTemporaryContainerTitle(temporaryContainerTitle) {
    const log = logger.start(updateTemporaryContainerTitle, temporaryContainerTitle);

    // find temporary containers before update title
    const cookieStoreIds = Object.keys(containers).filter(cookieStoreId => isTemporary(cookieStoreId));

    TEMPORARY.name = temporaryContainerTitle;

    if (contextParams.has('add-listeners')) {
        Listeners.contextualIdentities.onUpdated.remove(onUpdated);
    }

    for (const cookieStoreId of cookieStoreIds) {
        await update(cookieStoreId, {
            name: createTemporaryName(cookieStoreId),
        }).catch(log.onCatch(["can't update", cookieStoreId]));
    }

    if (contextParams.has('add-listeners')) {
        Listeners.contextualIdentities.onUpdated.add(onUpdated, {waitListener: false});
    }

    const broadcastUpdateData = {temporaryContainerTitle};

    if (cookieStoreIds.length) {
        broadcastUpdateData.containers = containers;
    }

    broadcastUpdate(broadcastUpdateData);

    log.stop('updated count:', cookieStoreIds.length);
}

function createTemporaryName(cookieStoreId) {
    const [containerId = cookieStoreId] = /\d+$/.exec(cookieStoreId) ?? [];
    return `${TEMPORARY.name} ${containerId}`;
}
