
import * as Constants from './constants.js';
import * as StorageUtils from './storage-utils.js';
import Logger from './logger.js';

export * from './storage-utils.js';

const logger = new Logger('Storage');

export async function get(keys, defaultData = Constants.DEFAULT_OPTIONS) {
    using log = logger.start('get', keys);

    const keysData = StorageUtils.getKeysData(keys, defaultData);

    const result = await StorageUtils.nativeGet('local', keysData, log);

    return result;
}

export async function getRaw() {
    using log = logger.start('getRaw');

    const result = await StorageUtils.nativeGet('local', null, log);

    return result;
}

export async function set(data) {
    using log = logger.start('set', Object.keys(data));

    // the tabs of non-archived groups live in the browser, not in storage - strip them
    // from the persisted copy only, never by mutating the caller's objects
    if (data.groups) {
        data = {
            ...data,
            groups: data.groups.map(group => group.isArchive ? group : {...group, tabs: []}),
        };
    }

    const result = await browser.storage.local.set(data);

    return result;
}

export function remove(...args) {
    logger.log('remove', args);
    return browser.storage.local.remove(args.flat());
}

export function clear() {
    logger.log('clear');
    return browser.storage.local.clear();
}
