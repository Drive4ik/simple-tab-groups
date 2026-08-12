/*
Data format versioning + migrations. The single owner of the `version` marker.

The marker is the full manifest version ("6.0"), but the data FORMAT is its major part
only: 5.5/5.6.9 - one format, 6.0 - another. Migration entries are keyed by a major
version string ("6", "7"); an entry runs when the data major is below it. Entry "6" is
the epoch: it covers every pre-6 state by the shape of the data, not by the version
label - the historical version bug could leave a <=5.3 marker absent or inflated,
never lowered, so those labels are unreliable.

Local startup (initLocalData): empty storage - a fresh install, write the marker;
data major above mine - 'updateAddonToLatestVersion', don't touch the data; otherwise
run the migrations and commit data+marker in one Storage.set - the marker never
travels without its data. Legacy storage keys are removed only after that commit:
a crash before it leaves them in place for the repeated run.

Sync area (migrateSyncData): rules run on every read regardless of the marker -
Firefox merges the area per-key between devices running different addon versions, so
old-format keys can resurrect at any time; the rules are shape-guarded and
re-runnable. The area marker only protects the data from OLDER addon versions:
a newer major - read/write refused.
*/

import Logger from './logger.js';
import JSON from './json.js';
import * as Constants from './constants.js';
import * as Utils from './utils.js';
import * as Storage from './storage.js';
import mainMigrations from './migrations-main.js';
import syncMigrations from './migrations-sync.js';

const logger = new Logger('Migration');

const CURRENT_VERSION = Constants.MANIFEST.version;

const LEGACY_VERSION = '0';

for (const migrations of [mainMigrations, syncMigrations]) {
    let prevVersion = null;

    for (const {version} of migrations) {
        if (typeof version !== 'string' || version.split('.').length > 1) {
            throw new Error(`migration version "${version}" must be a major version string, like "6"`);
        }

        if (prevVersion !== null && Utils.compareNumericVersions(prevVersion, version) !== -1) {
            throw new Error(`migration versions must be unique and ascending: "${prevVersion}" -> "${version}"`);
        }

        prevVersion = version;
    }
}

export function stampVersion(data) {
    data.version = CURRENT_VERSION;
    return data;
}

export function isDataVersionNewer(version) {
    return Boolean(version) && Utils.compareNumericVersions(version, CURRENT_VERSION) === 1;
}

export default async function migrate(data, applyToCurrentInstance = false) {
    const DATA_VERSION = data?.version;

    const log = logger.start('migrate',
        'data version:', DATA_VERSION,
        'CURRENT_VERSION:', CURRENT_VERSION,
        'applyToCurrentInstance:', applyToCurrentInstance
    );

    const result = {
        data,
        migrated: false,
        error: null,
        keysToRemove: [],
    };

    if (!DATA_VERSION) {
        log.throwError('data.version is not defined');
    }

    if (isDataVersionNewer(DATA_VERSION)) {
        result.error = 'updateAddonToLatestVersion';
        log.stopError(result.error);
        return result;
    }

    const originalKeys = new Set(Object.keys(data));
    const keysToRemove = new Set;

    for (const migration of mainMigrations) {
        if (Utils.compareNumericVersions(DATA_VERSION, migration.version) === -1) {
            const mlog = log.start('', 'apply version:', migration.version, '...');

            await migration.migration?.(data, applyToCurrentInstance);

            migration.remove?.forEach(key => originalKeys.has(key) && keysToRemove.add(key));

            result.migrated = true;

            mlog.stop();
        }
    }

    if (!result.migrated) {
        log.stop('data format is actual', DATA_VERSION);
        return result;
    }

    data.version = CURRENT_VERSION;

    if (keysToRemove.size) {
        log.log('removing keys in data object:', Array.from(keysToRemove), '...');
        keysToRemove.forEach(key => delete data[key]);
        // the storage keys are removed by the caller AFTER the migrated data is committed -
        // removing them here would starve a repeated run after a crash before the commit
        result.keysToRemove = Array.from(keysToRemove);
    }

    log.stop('migration from', DATA_VERSION, 'to', CURRENT_VERSION, 'has been finished');
    return result;
}

export async function initLocalData() {
    const log = logger.start('initLocalData');

    const storageData = await Storage.getRaw();

    if (!Object.keys(storageData).length) {
        await Storage.set({version: CURRENT_VERSION});

        const data = stampVersion(JSON.clone(Constants.DEFAULT_OPTIONS));

        log.stop('fresh install');
        return {data, error: null};
    }

    const data = {
        ...JSON.clone(Constants.DEFAULT_OPTIONS),
        ...storageData,
    };

    if (!data.version) {
        log.warn('version marker is missing, treat data as legacy');
        data.version = LEGACY_VERSION;
    }

    const result = await migrate(data, true);

    if (result.error) {
        log.stopError(result.error);
        return {data: null, error: result.error};
    }

    if (result.migrated) {
        await Storage.set(result.data);

        // only after the migrated data is committed - a crash before this point leaves the
        // legacy keys in place for the repeated migration run
        if (result.keysToRemove.length) {
            log.log('removing migrated keys from storage:', result.keysToRemove);
            await Storage.remove(result.keysToRemove);
        }
    }

    log.stop();
    return {data: result.data, error: null};
}

export async function migrateSyncData(data) {
    const log = logger.start('migrateSyncData', 'data version:', data.version);

    const result = {
        data,
        migrated: false,
        error: null,
        keysToRemove: [],
    };

    if (!Object.keys(data).length) {
        log.stop('sync area is empty');
        return result;
    }

    if (isDataVersionNewer(data.version)) {
        result.error = 'updateAddonToLatestVersion';
        log.stopError(result.error);
        return result;
    }

    const originalKeys = new Set(Object.keys(data));
    const dataBefore = JSON.stringify(data);
    const keysToRemove = new Set;

    for (const migration of syncMigrations) {
        await migration.migration?.(data);

        migration.remove?.forEach(key => originalKeys.has(key) && keysToRemove.add(key));
    }

    if (keysToRemove.size) {
        keysToRemove.forEach(key => delete data[key]);
        result.keysToRemove = Array.from(keysToRemove);
    }

    result.migrated = keysToRemove.size > 0 || JSON.stringify(data) !== dataBefore;

    log.stop('migrated:', result.migrated);
    return result;
}
