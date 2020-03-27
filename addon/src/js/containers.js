(function() {
    'use strict';

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

        let _containers = await browser.contextualIdentities.query({});

        _containers.forEach(container => containers[container.cookieStoreId] = container);

        browser.contextualIdentities.onCreated.removeListener(onCreated);
        browser.contextualIdentities.onUpdated.removeListener(onUpdated);
        browser.contextualIdentities.onRemoved.removeListener(onRemoved);

        browser.contextualIdentities.onCreated.addListener(onCreated);
        browser.contextualIdentities.onUpdated.addListener(onUpdated);
        browser.contextualIdentities.onRemoved.addListener(onRemoved);
    }

    function onCreated({contextualIdentity}) {
        containers[contextualIdentity.cookieStoreId] = contextualIdentity;

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

        BG.sendMessage({
            action: 'containers-updated',
        });
    }

    async function onRemoved({contextualIdentity}) {
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
        if (!cookieStoreId) {
            return false;
        }

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
        let {cookieStoreId} = await browser.contextualIdentities.create({
                name: temporaryContainerOptions.name,
                color: temporaryContainerOptions.color,
                icon: temporaryContainerOptions.icon,
            }),
            [containerId] = /\d+$/.exec(cookieStoreId);

        browser.contextualIdentities.update(cookieStoreId, {
            name: temporaryContainerOptions.name + ' ' + containerId,
        });

        return cookieStoreId;
    }

    function remove(cookieStoreId) {
        return browser.contextualIdentities.remove(cookieStoreId).catch(noop);
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

    function get(cookieStoreId, key = null) {
        let result = null;

        if (containers[cookieStoreId]) {
            result = containers[cookieStoreId];
        } else if (containers[mappedContainerCookieStoreId[cookieStoreId]]) {
            result = containers[mappedContainerCookieStoreId[cookieStoreId]];
        }

        if (result) {
            return key ? result[key] : {...result};
        }

        return null;
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

    function removeUnusedTemporaryContainers(windows) {
        let tabContainers = windows.reduce(function(acc, win) {
            win.tabs.forEach(tab => acc.includes(tab.cookieStoreId) ? null : acc.push(tab.cookieStoreId));
            return acc;
        }, []);

        Object.keys(containers)
            .filter(cookieStoreId => isTemporary(cookieStoreId) && !tabContainers.includes(cookieStoreId))
            .forEach(remove);
    }

    window.containers = {
        init,
        isDefault,
        isTemporary,
        createTemporaryContainer,
        remove,
        normalize,
        get,
        getAll,
        removeUnusedTemporaryContainers,
    };

})();
