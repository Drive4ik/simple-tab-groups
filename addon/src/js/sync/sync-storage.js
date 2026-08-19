
import * as Constants from '../constants.js';
import * as StorageUtils from '../storage-utils.js';
import {migrateSyncData, isDataVersionNewer, stampVersion} from '../migration.js';
import Logger from '../logger.js';
import JSON from '../json.js';
import CloudError from './cloud/error.js';

const logger = new Logger('SyncStorage');

export const IS_AVAILABLE = Constants.IS_AVAILABLE_SYNC_STORAGE;

export async function get() {
    const log = logger.start('get');

    if (!IS_AVAILABLE) {
        log.throwError('Browser sync is not available');
    }

    const areaData = await StorageUtils.nativeGet('sync', null, log);

    const result = await migrateSyncData(areaData);

    if (result.error) {
        log.stopError(result.error);
        throw new CloudError(result.error);
    }

    if (result.migrated) {
        log.log('sync area was migrated, commit');

        await browser.storage.sync.set(stampVersion(result.data));

        if (result.keysToRemove.length) {
            await browser.storage.sync.remove(result.keysToRemove);
        }
    }

    const syncOptions = {};

    for (const [key, defaultValue] of Object.entries(Constants.DEFAULT_SYNC_OPTIONS)) {
        syncOptions[key] = result.data[key] !== undefined ? result.data[key] : JSON.clone(defaultValue);
    }

    log.stop();

    return syncOptions;
}

export async function set(data) {
    const log = logger.start('set', Object.keys(data));

    if (!IS_AVAILABLE) {
        log.throwError('Browser sync is not available');
    }

    const {version} = await StorageUtils.nativeGet('sync', 'version', log);

    if (isDataVersionNewer(version)) {
        log.throwError('updateAddonToLatestVersion');
    }

    const result = await browser.storage.sync.set(stampVersion({...data}));

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
