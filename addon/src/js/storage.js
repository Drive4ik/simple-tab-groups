
import * as Constants from './constants.js';
import * as StorageUtils from './storage-utils.js';
import Logger from './logger.js';
import JSON from './json.js';

export * from './storage-utils.js';

const logger = new Logger('Storage');

export async function get(keys, defaultData = Constants.DEFAULT_OPTIONS) {
    const log = logger.start('get', keys);

    const keysData = StorageUtils.getKeysData(keys, defaultData);

    const result = await StorageUtils.nativeGet('local', keysData, log);

    log.stop();

    return result;
}

export async function getForMigrate() {
    const log = logger.start('getForMigrate');

    const storageData = await StorageUtils.nativeGet('local', null, log);

    const result = {
        ...JSON.clone(Constants.DEFAULT_OPTIONS),
        ...storageData,
    };

    log.stop();

    return result;
}

export async function set(data) {
    const log = logger.start('set', Object.keys(data));

    if ('groups' in data) {
        log.throwError('setting "groups" via Storage.set is forbidden, it stales the groups cache — use Groups.saveRaw');
    }

    const result = await browser.storage.local.set(data);

    log.stop();

    return result;
}

export async function setGroups(groups) {
    const log = logger.start('setGroups');

    groups.forEach(group => !group.isArchive && (group.tabs = []));

    const result = await browser.storage.local.set({groups});

    log.stop();

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
