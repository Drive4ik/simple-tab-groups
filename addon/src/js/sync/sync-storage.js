
import * as Constants from '../constants.js';
import * as StorageUtils from '../storage-utils.js';
import Logger from '../logger.js';

const logger = new Logger('SyncStorage');


// const ratio = 0.7; // for FF
// const chunkCountPerFetch = 16; // Must be a power of 2
// const MAX_ITEMS = Math.floor((browser.storage.sync.MAX_ITEMS || 512) * ratio) & ~(chunkCountPerFetch - 1);
// const QUOTA_BYTES_PER_ITEM = Math.floor((browser.storage.sync.QUOTA_BYTES_PER_ITEM || 8192) * ratio);

export const IS_AVAILABLE = Constants.IS_AVAILABLE_SYNC_STORAGE;
/*
const MAX_ITEMS = browser.storage.sync?.MAX_ITEMS || 512;
const QUOTA_BYTES_PER_ITEM = browser.storage.sync?.QUOTA_BYTES_PER_ITEM || 8192;
const QUOTA_BYTES = browser.storage.sync?.QUOTA_BYTES || 102400;

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

export async function get(key) {
    if (!IS_AVAILABLE) {
        throw Error('Browser sync is not available');
    }

    let data = await browser.storage.sync.get(getAllChunkKeys(key)),
        i = 0,
        json = '';

    while (data[key + i] !== undefined) {
        json += data[key + i];
        i++;
    }

    return json.length ? JSON.parse(json) : null;
}

export async function set(key, data) {
    if (!IS_AVAILABLE) {
        throw Error('Browser sync is not available');
    }

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

export async function remove(key) {
    const log = logger.start('remove', key);

    if (!IS_AVAILABLE) {
        log.throwError('Browser sync is not available');
    }

    return browser.storage.sync.remove(getAllChunkKeys(key));
}
/**/

export async function get(keys) {
    const log = logger.start('get', keys);

    if (!IS_AVAILABLE) {
        log.throwError('Browser sync is not available');
    }

    const keysData = StorageUtils.getKeysData(keys, Constants.DEFAULT_SYNC_OPTIONS);

    const result = await StorageUtils.nativeGet('sync', keysData, log);

    log.stop();

    return result;
}

export async function set(data) {
    const log = logger.start('set', Object.keys(data));

    if (!IS_AVAILABLE) {
        log.throwError('Browser sync is not available');
    }

    const result = await browser.storage.sync.set(data);

    log.stop();

    return result;
}

export async function remove(keys) {
    const log = logger.start('remove', keys);

    if (!IS_AVAILABLE) {
        log.throwError('Browser sync is not available');
    }

    const result = await browser.storage.sync.remove(keys);

    log.stop();

    return result;
}
