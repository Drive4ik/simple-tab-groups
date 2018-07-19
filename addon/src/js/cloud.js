'use strict';

// const ratio = 0.7; // for FF
// const chunkCountPerFetch = 16; // Must be a power of 2
// const MAX_ITEMS = Math.floor((browser.storage.sync.MAX_ITEMS || 512) * ratio) & ~(chunkCountPerFetch - 1);
// const QUOTA_BYTES_PER_ITEM = Math.floor((browser.storage.sync.QUOTA_BYTES_PER_ITEM || 8192) * ratio);

const MAX_ITEMS = browser.storage.sync.MAX_ITEMS || 512;
const QUOTA_BYTES_PER_ITEM = browser.storage.sync.QUOTA_BYTES_PER_ITEM || 8192;
const QUOTA_BYTES = browser.storage.sync.QUOTA_BYTES || 102400;

function getAllChunkKeys(key, fromIndex = 0) {
    return Array(MAX_ITEMS)
        .fill()
        .map((v, i) => i)
        .slice(fromIndex)
        .map(i => key + i);
}

function chunkStr(str, size) {
    return str.match(new RegExp('.{1,' + size + '}', 'g'));
}

async function get(key) {
    let data = await browser.storage.sync.get(getAllChunkKeys(key)),
        i = 0,
        json = '';

    while (data[key + i] !== undefined) {
        json += data[key + i];
        i++;
    }

    return json.length ? JSON.parse(json) : null;
}

async function set(key, data) {
    let bin = {},
        chunkCount = chunkStr(
            JSON.stringify({
                unix: Date.now(),
                data: data,
            }),
            QUOTA_BYTES_PER_ITEM - key.length - 4
        )
        .map((value, i) => bin[key + i] = value)
        .length;

    let error = null;
    try {
        await browser.storage.sync.set(bin);
    } catch (e) {
        error = e;
        chunkCount = 0;
    }

    browser.storage.sync.remove(getAllChunkKeys(key, chunkCount));

    if (error) {
        throw error;
    }
}

async function remove(key) {
    return browser.storage.sync.remove(getAllChunkKeys(key));
}

export default {
    isAvailable: browser.storage.sync instanceof Object, // Not all platforms support `browser.storage.sync`.
    get: get,
    set: set,
    remove: remove,
};
