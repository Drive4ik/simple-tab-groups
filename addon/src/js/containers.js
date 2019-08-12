'use strict';

import constants from './constants';
import utils from './utils';

let containers = {},
    mappedContainerCookieStoreId = {};

async function init() {
    // CONTAINER PROPS:
    // color: "blue"
    // ​​colorCode: "#37adff"
    // ​​cookieStoreId: "firefox-container-1"
    // ​​icon: "fingerprint"
    // ​​iconUrl: "resource://usercontext-content/fingerprint.svg"
    // ​​name: "Personal"

    let _containers = await browser.contextualIdentities.query({});

    _containers.forEach(container => containers[container.cookieStoreId] = container);

    let contextualIdentityHandler = changeInfo => containers[changeInfo.contextualIdentity.cookieStoreId] = changeInfo.contextualIdentity;

    browser.contextualIdentities.onCreated.addListener(contextualIdentityHandler);
    browser.contextualIdentities.onUpdated.addListener(contextualIdentityHandler);
    browser.contextualIdentities.onRemoved.addListener(changeInfo => delete containers[changeInfo.contextualIdentity.cookieStoreId]);
}

function isDefault(cookieStoreId) {
    return constants.DEFAULT_COOKIE_STORE_ID === cookieStoreId || !cookieStoreId;
}

async function normalize(cookieStoreId) {
    if (isDefault(cookieStoreId)) {
        return constants.DEFAULT_COOKIE_STORE_ID;
    }

    if (containers[cookieStoreId]) {
        return cookieStoreId;
    }

    if (!mappedContainerCookieStoreId[cookieStoreId]) {
        let contextualIdentity = await browser.contextualIdentities.create({
            name: cookieStoreId,
            color: ['toolbar', 'blue', 'turquoise', 'green', 'yellow', 'orange', 'red', 'pink', 'purple'][utils.getRandomInt(0, 8)],
            icon: 'circle',
        });

        containers[contextualIdentity.cookieStoreId] = contextualIdentity;

        mappedContainerCookieStoreId[cookieStoreId] = contextualIdentity.cookieStoreId;
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

function getAll(asArray) {
    return utils.clone(asArray ? Object.values(containers) : containers);
}

export default {
    init,
    isDefault,
    normalize,
    get,
    getAll,
};
