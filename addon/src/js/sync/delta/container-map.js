export const DEFAULT_MARKER = 'firefox-default';

export const TEMPORARY_MARKER = 'temporary-container';

export const GROUP_CONTAINER_KEYS = Object.freeze([
    'newTabContainer',
    'catchTabContainers',
    'excludeContainersForReOpen',
]);

export function stringifyContainer({name, color, icon} = {}) {
    return [name, color, icon].join('');
}

export function mapGroupContainers(group, mapFn) {
    if (!group || typeof group !== 'object') {
        return;
    }

    for (const key of GROUP_CONTAINER_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(group, key)) {
            continue;
        }
        const value = group[key];
        if (Array.isArray(value)) {
            group[key] = value.map(csId => mapFn(csId));
        } else if (value != null) {
            group[key] = mapFn(value);
        }
    }

    if (Array.isArray(group.tabs)) {
        for (const tab of group.tabs) {
            if (tab && tab.cookieStoreId != null) {
                tab.cookieStoreId = mapFn(tab.cookieStoreId);
            }
        }
    }
}

export function mapEventContainers(event, mapFn) {
    if (!event || typeof event !== 'object') {
        return;
    }

    if (event.tab && event.tab.cookieStoreId != null) {
        event.tab.cookieStoreId = mapFn(event.tab.cookieStoreId);
    }

    if (event.group) {
        mapGroupContainers(event.group, mapFn);
    }

    if (event.op === 'option.set' && event.key === 'defaultGroupProps' && event.value) {
        mapGroupContainers(event.value, mapFn);
    }
}

export function mapStateContainers(state, mapFn) {
    if (!state || typeof state !== 'object') {
        return;
    }

    for (const group of Array.isArray(state.groups) ? state.groups : []) {
        mapGroupContainers(group, mapFn);
    }

    for (const tab of Array.isArray(state.pinnedTabs) ? state.pinnedTabs : []) {
        if (tab && tab.cookieStoreId != null) {
            tab.cookieStoreId = mapFn(tab.cookieStoreId);
        }
    }

    if (state.options && state.options.defaultGroupProps) {
        mapGroupContainers(state.options.defaultGroupProps, mapFn);
    }
    if (state.defaultGroupProps) {
        mapGroupContainers(state.defaultGroupProps, mapFn);
    }
}

export function makeOutboundMapper(localContainers, registry, isDefault, isTemporary) {
    return cookieStoreId => {
        if (cookieStoreId == null || isDefault(cookieStoreId)) {
            return DEFAULT_MARKER;
        }
        if (isTemporary(cookieStoreId)) {
            return TEMPORARY_MARKER;
        }

        const container = localContainers[cookieStoreId];
        if (!container) {
            return DEFAULT_MARKER;
        }

        const key = stringifyContainer(container);
        if (!registry[key]) {
            registry[key] = {
                name: container.name,
                color: container.color,
                icon: container.icon,
            };
        }
        return key;
    };
}

export function makeInboundMapper(registry, localDefault, findOrCreate, resolveTemporary) {
    const cache = new Map();

    return portableKey => {
        if (portableKey == null || portableKey === DEFAULT_MARKER) {
            return localDefault;
        }
        if (portableKey === TEMPORARY_MARKER) {
            if (!cache.has(portableKey)) {
                cache.set(portableKey, resolveTemporary());
            }
            return cache.get(portableKey);
        }

        if (cache.has(portableKey)) {
            return cache.get(portableKey);
        }

        const identity = registry && registry[portableKey];
        if (!identity) {
            cache.set(portableKey, localDefault);
            return localDefault;
        }

        const cookieStoreId = findOrCreate({
            name: identity.name,
            color: identity.color,
            icon: identity.icon,
        });
        cache.set(portableKey, cookieStoreId);
        return cookieStoreId;
    };
}
