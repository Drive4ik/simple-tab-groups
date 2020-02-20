'use strict';

import utils from './utils';

const TEMPORARY_CONTAINER = 'temporary-container';
const DEFAULT_COOKIE_STORE_ID = 'firefox-default';

const temporaryContainerOptions = Object.freeze({
    color: 'toolbar',
    colorCode: false,
    cookieStoreId: TEMPORARY_CONTAINER,
    icon: 'chill',
    iconUrl: 'resource://usercontext-content/chill.svg',
    name: browser.i18n.getMessage('temporaryContainerTitle'),
});

let containers = {},
    mappedContainerCookieStoreId = {};

async function init() {
    const {BG} = browser.extension.getBackgroundPage();

    containers = {
        [TEMPORARY_CONTAINER]: temporaryContainerOptions,
    };
    mappedContainerCookieStoreId = {};

    // CONTAINER PROPS:
    // color: "blue"
    // colorCode: "#37adff"
    // cookieStoreId: "firefox-container-1"
    // icon: "fingerprint"
    // iconUrl: "resource://usercontext-content/fingerprint.svg"
    // name: "Personal"

    let _containers = await BG.browser.contextualIdentities.query({});

    _containers.forEach(container => containers[container.cookieStoreId] = container);

    BG.browser.contextualIdentities.onCreated.removeListener(onCreated);
    BG.browser.contextualIdentities.onUpdated.removeListener(onUpdated);
    BG.browser.contextualIdentities.onRemoved.removeListener(onRemoved);

    BG.browser.contextualIdentities.onCreated.addListener(onCreated);
    BG.browser.contextualIdentities.onUpdated.addListener(onUpdated);
    BG.browser.contextualIdentities.onRemoved.addListener(onRemoved);
}

function onCreated({contextualIdentity}) {
    containers[contextualIdentity.cookieStoreId] = contextualIdentity;

    const {BG} = browser.extension.getBackgroundPage();

    BG.sendMessage({
        action: 'containers-updated',
    });
}

function onUpdated({contextualIdentity}) {
    let {cookieStoreId} = contextualIdentity;

    if (
        containers[cookieStoreId].name !== contextualIdentity.name &&
        containers[cookieStoreId].name !== temporaryContainerOptions.name
    ) {
        if (isTemporary(cookieStoreId) && !isTemporary(null, contextualIdentity)) {
            utils.notify(browser.i18n.getMessage('thisContainerIsNotTemporary', contextualIdentity.name));
        }

        if (!isTemporary(cookieStoreId) && isTemporary(null, contextualIdentity)) {
            utils.notify(browser.i18n.getMessage('thisContainerNowIsTemporary', contextualIdentity.name));
        }
    }

    containers[cookieStoreId] = contextualIdentity;

    const {BG} = browser.extension.getBackgroundPage();

    BG.sendMessage({
        action: 'containers-updated',
    });
}

async function onRemoved({contextualIdentity}) {
    const {BG} = browser.extension.getBackgroundPage();

    delete containers[contextualIdentity.cookieStoreId];

    await BG.normalizeContainersInGroups();

    BG.sendMessage({
        action: 'containers-updated',
    });
}


function isDefault(cookieStoreId) {
    return DEFAULT_COOKIE_STORE_ID === cookieStoreId || !cookieStoreId;
}

function isTemporary(cookieStoreId, contextualIdentity) {
    if (cookieStoreId === TEMPORARY_CONTAINER) {
        return true;
    }

    if (!contextualIdentity) {
        contextualIdentity = containers[cookieStoreId];
    }

    if (!contextualIdentity) {
        return false;
    }

    return contextualIdentity.name.includes(temporaryContainerOptions.name);
}

async function createTemporaryContainer() {
    const {BG} = browser.extension.getBackgroundPage();

    let {cookieStoreId} = await BG.browser.contextualIdentities.create({
            name: temporaryContainerOptions.name,
            color: temporaryContainerOptions.color,
            icon: temporaryContainerOptions.icon,
        }),
        [containerId] = /\d+$/.exec(cookieStoreId);

    BG.browser.contextualIdentities.update(cookieStoreId, {
        name: temporaryContainerOptions.name + ' ' + containerId,
    });

    return cookieStoreId;
}

function remove(cookieStoreId) {
    const {BG} = browser.extension.getBackgroundPage();

    return BG.browser.contextualIdentities.remove(cookieStoreId);
}

async function normalize(cookieStoreId, containerData) {
    if (isDefault(cookieStoreId)) {
        return DEFAULT_COOKIE_STORE_ID;
    }

    if (containers[cookieStoreId]) {
        return cookieStoreId;
    }

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
                const {BG} = browser.extension.getBackgroundPage();
                let {cookieStoreId: csId} = await BG.browser.contextualIdentities.create({
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

function get(cookieStoreId, key = null) {
    let result = null;

    if (containers[cookieStoreId]) {
        result = containers[cookieStoreId];
    } else if (containers[mappedContainerCookieStoreId[cookieStoreId]]) {
        result = containers[mappedContainerCookieStoreId[cookieStoreId]];
    } else {
        result = {
            cookieStoreId: DEFAULT_COOKIE_STORE_ID,
            name: 'default',
        };
    }

    return key ? result[key] : {...result};
}

function getAll() {
    let _containers = utils.clone(containers);

    for (let cookieStoreId in _containers) {
        if (isTemporary(cookieStoreId)) {
            delete _containers[cookieStoreId];
        }
    }

    // add temporary container to end of obj
    _containers[TEMPORARY_CONTAINER] = utils.clone(temporaryContainerOptions);

    return _containers;
}

export default {
    init,
    isDefault,
    isTemporary,
    createTemporaryContainer,
    remove,
    normalize,
    get,
    getAll,
    TEMPORARY_CONTAINER,
};
