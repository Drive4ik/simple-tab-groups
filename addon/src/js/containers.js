'use strict';

import constants from './constants';
import utils from './utils';

const temporaryContainerOptions = Object.freeze({
    name: browser.i18n.getMessage('temporaryContainerTitle'),
    color: 'toolbar',
    icon: 'chill',
});

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
    return constants.DEFAULT_COOKIE_STORE_ID === cookieStoreId || !cookieStoreId;
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

async function normalize(cookieStoreId) {
    if (isDefault(cookieStoreId)) {
        return constants.DEFAULT_COOKIE_STORE_ID;
    }

    if (containers[cookieStoreId]) {
        return cookieStoreId;
    }

    if (!mappedContainerCookieStoreId[cookieStoreId]) {
        mappedContainerCookieStoreId[cookieStoreId] = await createTemporaryContainer();
    }

    return mappedContainerCookieStoreId[cookieStoreId];
}

function get(cookieStoreId, key = null) {
    let result = containers[cookieStoreId] || {
        cookieStoreId: constants.DEFAULT_COOKIE_STORE_ID,
        name: 'default',
    };

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
};
