import * as Constants from '/js/constants.js';
import * as Containers from '/js/containers.js';
import {
    makeOutboundMapper,
    makeInboundMapper,
    mapStateContainers,
    mapEventContainers,
} from './container-map.js';

export function buildOutboundContainerMapping(pulledContainers) {
    const localContainers = Containers.query({temporaryContainers: false});

    const registry = {...(pulledContainers || {})};

    const mapToPortable = makeOutboundMapper(
        localContainers,
        registry,
        Containers.isDefault,
        Containers.isTemporary,
    );

    return {registry, mapToPortable};
}

function buildInboundContainerMapper(registry) {
    const findOrCreateMap = new Map();

    const findOrCreate = identity => {
        const key = identity.name + identity.color + identity.icon;
        return findOrCreateMap.has(key) ? findOrCreateMap.get(key) : Constants.DEFAULT_COOKIE_STORE_ID;
    };

    const mapper = makeInboundMapper(
        registry || {},
        Constants.DEFAULT_COOKIE_STORE_ID,
        findOrCreate,
        () => Constants.DEFAULT_COOKIE_STORE_ID,
    );

    return {mapper, findOrCreateMap};
}

async function resolveInboundContainers(registry, findOrCreateMap, log) {
    const containerStorageMap = new Map();

    for (const [, identity] of Object.entries(registry || {})) {
        const identityKey = identity.name + identity.color + identity.icon;
        if (findOrCreateMap.has(identityKey)) {
            continue;
        }
        const syntheticId = 'sync-container:' + identityKey;
        const cookieStoreId = await Containers.findExistOrCreateSimilar(syntheticId, identity, containerStorageMap)
            .catch(log.onCatch(['cant find-or-create container', identityKey], false));
        if (cookieStoreId) {
            findOrCreateMap.set(identityKey, cookieStoreId);
        }
    }
}

export async function translateInboundContainers(browserOps, optionsToApply, containerRegistry, log) {
    const {mapper, findOrCreateMap} = buildInboundContainerMapper(containerRegistry);

    await resolveInboundContainers(containerRegistry, findOrCreateMap, log);

    for (const props of browserOps.groupsToCreate || []) {
        mapEventContainers({group: props}, mapper);
    }
    for (const props of browserOps.groupsToUpdate || []) {
        mapEventContainers({group: props}, mapper);
    }

    for (const tab of browserOps.tabsToCreate || []) {
        if (tab.cookieStoreId != null) {
            tab.cookieStoreId = mapper(tab.cookieStoreId);
        }
    }
    for (const tab of browserOps.pinnedToCreate || []) {
        if (tab.cookieStoreId != null) {
            tab.cookieStoreId = mapper(tab.cookieStoreId);
        }
    }

    if (optionsToApply && optionsToApply.defaultGroupProps) {
        mapStateContainers({options: optionsToApply}, mapper);
    }
}
