import {sanitizeFavIconUrlForFile} from './url-sync.js';

export const MAX_FAVICON_FILE_BYTES = 512_000;

function collectFavIconEntries(loadedGroups, livePinnedTabs) {
    const entries = [];

    const addTab = tab => {
        if (!tab || tab.uid == null) {
            return;
        }
        const favIconUrl = sanitizeFavIconUrlForFile(tab.favIconUrl);
        if (favIconUrl) {
            entries.push([tab.uid, favIconUrl]);
        }
    };

    for (const group of loadedGroups || []) {
        for (const tab of Array.isArray(group.tabs) ? group.tabs : []) {
            addTab(tab);
        }
    }

    for (const tab of Array.isArray(livePinnedTabs) ? livePinnedTabs : []) {
        addTab(tab);
    }

    return entries;
}

export function buildFavIconMap(loadedGroups, livePinnedTabs) {
    const entries = collectFavIconEntries(loadedGroups, livePinnedTabs);
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    const map = {};
    let bytes = 2;
    for (const [uid, favIconUrl] of entries) {
        if (Object.hasOwn(map, uid)) {
            continue;
        }
        const cost = uid.length + favIconUrl.length + 8;
        if (bytes + cost > MAX_FAVICON_FILE_BYTES) {
            continue;
        }
        map[uid] = favIconUrl;
        bytes += cost;
    }

    return map;
}

export function serializeFavIconMap(map) {
    const keys = Object.keys(map || {}).sort();
    return JSON.stringify(keys.map(key => [key, map[key]]));
}

export function mergeFavIconMaps(files) {
    const merged = {};
    for (const {content} of files || []) {
        if (!content || typeof content !== 'object') {
            continue;
        }
        for (const [uid, favIconUrl] of Object.entries(content)) {
            if (uid && typeof favIconUrl === 'string' && !Object.hasOwn(merged, uid)) {
                merged[uid] = favIconUrl;
            }
        }
    }
    return merged;
}
