'use strict';

import constants from './constants';

let containers = {};

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
    return constants.DEFAULT_COOKIE_STORE_ID === cookieStoreId || constants.PRIVATE_COOKIE_STORE_ID === cookieStoreId || !cookieStoreId;
}

function get(cookieStoreId, key = null) {
    let result = containers[cookieStoreId] || {
        cookieStoreId: constants.DEFAULT_COOKIE_STORE_ID,
        name: 'default',
    };

    return key ? result[key] : JSON.parse(JSON.stringify(result));
}

function getAll(asArray) {
    return JSON.parse(JSON.stringify(asArray ? Object.values(containers) : containers));
}

export default {
    init,
    isDefault,
    get,
    getAll,
};
