import {sanitizeFavIconUrlForFile} from './url-sync.js';
import {GIST_FILE_MAX_BYTES} from './layout.js';

const FAVICON_FILE_BUDGET_FRACTION = 0.5;
const FAVICON_ENTRY_BUDGET_DIVISOR = 16;

export const MAX_FAVICON_FILE_BYTES = Math.floor(GIST_FILE_MAX_BYTES * FAVICON_FILE_BUDGET_FRACTION);
export const MAX_FAVICON_ENTRY_BYTES = Math.floor(GIST_FILE_MAX_BYTES / FAVICON_ENTRY_BUDGET_DIVISOR);

const EMPTY_FILE_OVERHEAD = '{"tabs":{},"blobs":{}}'.length;

export function hashFavIcon(favIconUrl) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < favIconUrl.length; i++) {
        const ch = favIconUrl.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function collectFavIconEntries(loadedGroups, livePinnedTabs) {
    const entries = [];

    const addTab = tab => {
        if (!tab || tab.uid == null) {
            return;
        }
        const favIconUrl = sanitizeFavIconUrlForFile(tab.favIconUrl);
        if (favIconUrl) {
            entries.push([String(tab.uid), favIconUrl]);
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

function tabCost(uid, hash) {
    return uid.length + hash.length + 8;
}

function blobCost(hash, favIconUrl) {
    return hash.length + favIconUrl.length + 8;
}

export function buildFavIconMap(loadedGroups, livePinnedTabs, onOverflow) {
    const entries = collectFavIconEntries(loadedGroups, livePinnedTabs);

    const tabHash = new Map();
    const blobs = new Map();
    let oversized = 0;
    let oversizedBytes = 0;

    for (const [uid, favIconUrl] of entries) {
        if (tabHash.has(uid)) {
            continue;
        }
        if (favIconUrl.length > MAX_FAVICON_ENTRY_BYTES) {
            oversized++;
            oversizedBytes += favIconUrl.length;
            continue;
        }
        const hash = hashFavIcon(favIconUrl);
        tabHash.set(uid, hash);
        if (!blobs.has(hash)) {
            blobs.set(hash, {favIconUrl, uids: []});
        }
        blobs.get(hash).uids.push(uid);
    }

    let bytes = EMPTY_FILE_OVERHEAD;
    for (const [uid, hash] of tabHash) {
        bytes += tabCost(uid, hash);
    }
    for (const [hash, blob] of blobs) {
        bytes += blobCost(hash, blob.favIconUrl);
    }

    let budgetDropped = 0;
    if (bytes > MAX_FAVICON_FILE_BYTES) {
        const evictionOrder = [...blobs.entries()].sort((a, b) => {
            const sizeDiff = b[1].favIconUrl.length - a[1].favIconUrl.length;
            if (sizeDiff !== 0) {
                return sizeDiff;
            }
            return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
        });

        for (const [hash, blob] of evictionOrder) {
            if (bytes <= MAX_FAVICON_FILE_BYTES) {
                break;
            }
            bytes -= blobCost(hash, blob.favIconUrl);
            for (const uid of blob.uids) {
                bytes -= tabCost(uid, hash);
                tabHash.delete(uid);
                budgetDropped++;
            }
            blobs.delete(hash);
        }
    }

    const tabs = {};
    for (const [uid, hash] of tabHash) {
        tabs[uid] = hash;
    }
    const blobMap = {};
    for (const [hash, blob] of blobs) {
        blobMap[hash] = blob.favIconUrl;
    }

    const dropped = oversized + budgetDropped;
    if (dropped > 0) {
        onOverflow?.({
            dropped,
            oversized,
            oversizedBytes,
            budgetDropped,
            kept: Object.keys(tabs).length,
            bytes,
            fileCap: MAX_FAVICON_FILE_BYTES,
            entryCap: MAX_FAVICON_ENTRY_BYTES,
        });
    }

    return {tabs, blobs: blobMap};
}

export function serializeFavIconMap(map) {
    const tabs = map?.tabs || {};
    const blobs = map?.blobs || {};
    const tabKeys = Object.keys(tabs).sort();
    const blobKeys = Object.keys(blobs).sort();
    return JSON.stringify([
        tabKeys.map(key => [key, tabs[key]]),
        blobKeys.map(key => [key, blobs[key]]),
    ]);
}

export function mergeFavIconMaps(files) {
    const merged = {};
    for (const {content} of files || []) {
        if (!content || typeof content !== 'object') {
            continue;
        }
        if (content.tabs && content.blobs) {
            for (const [uid, hash] of Object.entries(content.tabs)) {
                if (!uid || Object.hasOwn(merged, uid)) {
                    continue;
                }
                const favIconUrl = content.blobs[hash];
                if (typeof favIconUrl === 'string') {
                    merged[uid] = favIconUrl;
                }
            }
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
