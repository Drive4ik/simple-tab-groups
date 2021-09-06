(function() {
    'use strict';

    const temporaryContainerDefaultTitle = browser.i18n.getMessage('temporaryContainerTitle'),
        defaultContainerOptions = {
            cookieStoreId: DEFAULT_COOKIE_STORE_ID,
            name: browser.i18n.getMessage('noContainerTitle'),
        },
        temporaryContainerOptions = {
            color: 'toolbar',
            colorCode: false,
            cookieStoreId: TEMPORARY_CONTAINER,
            icon: 'chill',
            iconUrl: 'resource://usercontext-content/chill.svg',
            name: temporaryContainerDefaultTitle,
        },
        containerIdRegExp = /\d+$/,
        tmpContainerTimeStamp = Date.now();

    let containers = {
            [TEMPORARY_CONTAINER]: temporaryContainerOptions,
        },
        mappedContainerCookieStoreId = {};

    async function init(temporaryContainerTitle) {
        setTemporaryContainerTitle(temporaryContainerTitle);

        // CONTAINER PROPS:
        // color: "blue"
        // colorCode: "#37adff"
        // cookieStoreId: "firefox-container-1"
        // icon: "fingerprint"
        // iconUrl: "resource://usercontext-content/fingerprint.svg"
        // name: "Personal"

        let _containers = await browser.contextualIdentities.query({});

        _containers.forEach(container => containers[container.cookieStoreId] = container);

        browser.contextualIdentities.onCreated.addListener(onCreated);
        browser.contextualIdentities.onUpdated.addListener(onUpdated);
        browser.contextualIdentities.onRemoved.addListener(utils.catchFunc(onRemoved));
    }

    function onCreated({contextualIdentity}) {
        containers[contextualIdentity.cookieStoreId] = contextualIdentity;

        if (contextualIdentity.name === (temporaryContainerOptions.name + tmpContainerTimeStamp)) {
            return;
        }

        BG.sendMessage({
            action: 'containers-updated',
        });
    }

    function onUpdated({contextualIdentity}) {
        let {cookieStoreId} = contextualIdentity,
            isOldContainerNameAreTmp = containers[cookieStoreId].name === (temporaryContainerOptions.name + tmpContainerTimeStamp);

        if (!isOldContainerNameAreTmp && containers[cookieStoreId].name !== contextualIdentity.name) {
            if (isTemporary(cookieStoreId) && !isTemporary(null, contextualIdentity)) {
                utils.notify(['thisContainerIsNotTemporary', contextualIdentity.name]);
            } else if (!isTemporary(cookieStoreId) && isTemporary(null, contextualIdentity)) {
                utils.notify(['thisContainerNowIsTemporary', contextualIdentity.name]);
            }
        }

        containers[cookieStoreId] = contextualIdentity;

        if (isOldContainerNameAreTmp) {
            return;
        }

        BG.sendMessage({
            action: 'containers-updated',
        });
    }

    async function onRemoved({contextualIdentity}) {
        let isTemporaryContainer = isTemporary(contextualIdentity.cookieStoreId);

        delete containers[contextualIdentity.cookieStoreId];

        if (isTemporaryContainer) {
            return;
        }

        if (!BG.inited) {
            return;
        }

        let groups = await Groups.load(),
            needSaveGroups = BG.normalizeContainersInGroups(groups);

        if (needSaveGroups) {
            await Groups.save(groups);
        }

        BG.sendMessage({
            action: 'containers-updated',
        });
    }


    function isDefault(cookieStoreId) {
        return DEFAULT_COOKIE_STORE_ID === cookieStoreId || !cookieStoreId;
    }

    function isTemporary(cookieStoreId, contextualIdentity, excludeMainTemporaryContainerName = false) {
        if (cookieStoreId === TEMPORARY_CONTAINER) {
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

    async function createTemporaryContainer() {
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

    function remove(cookieStoreIds) {
        return Promise.all(cookieStoreIds.map(cookieStoreId => browser.contextualIdentities.remove(cookieStoreId).catch(noop)));
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

    function get(cookieStoreId, key = null, withDefaultContainer = false) {
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

    function getAll(withDefaultContainer) {
        let _containers = utils.clone(containers);

        for (let cookieStoreId in _containers) {
            if (isTemporary(cookieStoreId)) {
                delete _containers[cookieStoreId];
            }
        }

        if (withDefaultContainer) {
            _containers = {
                [DEFAULT_COOKIE_STORE_ID]: {...defaultContainerOptions},
                ..._containers,
            };
        }

        // add temporary container to end of obj
        _containers[TEMPORARY_CONTAINER] = {...temporaryContainerOptions, name: temporaryContainerDefaultTitle};

        return _containers;
    }

    async function removeUnusedTemporaryContainers(tabs) {
        let tabContainers = tabs.map(tab => tab.cookieStoreId).filter(utils.onlyUniqueFilter);

        return remove(
            Object.keys(containers)
            .filter(cookieStoreId => isTemporary(cookieStoreId, null, true) && !tabContainers.includes(cookieStoreId))
        );
    }

    function setTemporaryContainerTitle(temporaryContainerTitle) {
        temporaryContainerOptions.name = temporaryContainerTitle;
    }

    async function updateTemporaryContainerTitle(temporaryContainerTitle) {
        let cookieStoreIds = Object.keys(containers).filter(cookieStoreId => isTemporary(cookieStoreId, null, true));

        setTemporaryContainerTitle(temporaryContainerTitle);

        if (cookieStoreIds.length) {
            browser.contextualIdentities.onUpdated.removeListener(onUpdated);

            await Promise.all(cookieStoreIds.map(function(cookieStoreId) {
                containers[cookieStoreId].name = getTemporaryContainerName(cookieStoreId);

                return browser.contextualIdentities.update(cookieStoreId, {
                    name: containers[cookieStoreId].name,
                });
            }));

            browser.contextualIdentities.onUpdated.addListener(onUpdated);

            BG.sendMessage({ // update container temporary name on tabs will work only on not archived groups
                action: 'containers-updated',
            });
        }
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
        updateTemporaryContainerTitle,
    };

})();
