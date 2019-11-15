'use strict';

import utils from './utils';

const temporaryContainerOptions = Object.freeze({
    name: browser.i18n.getMessage('temporaryContainerTitle'),
    color: 'toolbar',
    icon: 'chill',
});

const TEMPORARY_CONTAINER = 'temporary-container';
const DEFAULT_COOKIE_STORE_ID = 'firefox-default';

let containers = {},
    mappedContainerCookieStoreId = {};

async function init() {
    const {BG} = browser.extension.getBackgroundPage();

    // CONTAINER PROPS:
    // color: "blue"
    // ​​colorCode: "#37adff"
    // ​​cookieStoreId: "firefox-container-1"
    // ​​icon: "fingerprint"
    // ​​iconUrl: "resource://usercontext-content/fingerprint.svg"
    // ​​name: "Personal"

    let _containers = await BG.browser.contextualIdentities.query({});

    _containers.forEach(container => containers[container.cookieStoreId] = container);

    BG.browser.contextualIdentities.onCreated.addListener(function({contextualIdentity}) {
        containers[contextualIdentity.cookieStoreId] = contextualIdentity;
    });

    BG.browser.contextualIdentities.onUpdated.addListener(function({contextualIdentity}) {
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
    });

    BG.browser.contextualIdentities.onRemoved.addListener(function({contextualIdentity}) {
        delete containers[contextualIdentity.cookieStoreId];
        BG.normalizeContainersInGroups();
    });
}

function isDefault(cookieStoreId) {
    return DEFAULT_COOKIE_STORE_ID === cookieStoreId || !cookieStoreId;
}

function isTemporary(cookieStoreId, contextualIdentity) {
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

    let {cookieStoreId} = await BG.browser.contextualIdentities.create(temporaryContainerOptions);

    BG.browser.contextualIdentities.update(cookieStoreId, {
        name: temporaryContainerOptions.name + ' ' + /\d+$/.exec(cookieStoreId)[0],
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
                if (!isTemporary(csId) && containerData.name === containers[csId].name) {
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
    } else if (cookieStoreId === TEMPORARY_CONTAINER) {
        result = temporaryContainerOptions;
    } else {
        result = {
            cookieStoreId: DEFAULT_COOKIE_STORE_ID,
            name: 'default',
        };
    }

    return key ? result[key] : {...result};
}

function getAll(temporary = false) {
    let _containers = utils.clone(containers);

    if (null !== temporary) {
        for (let cookieStoreId in _containers) {
            if (temporary) { // if true - return only temporary
                if (!isTemporary(cookieStoreId)) {
                    delete _containers[cookieStoreId];
                }
            } else { // if false - return only NOT temporary
                if (isTemporary(cookieStoreId)) {
                    delete _containers[cookieStoreId];
                }
            }
        }
    }

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
