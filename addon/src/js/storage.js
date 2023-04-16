
import * as Constants from './constants.js';
import Logger from './logger.js';
import * as Urls from './urls.js';
import JSON from './json.js';

const logger = new Logger('Storage');

export async function get(keys, errorCounter = 0, forMigrate = false) {
    const log = logger.start('get', keys);

    let keysData;
    if (!keys) {
        if (!forMigrate) {
            keysData = Constants.DEFAULT_OPTIONS;
        }
    } else if (Array.isArray(keys)) {
        keysData = keys.reduce((acc, key) => (acc[key] = Constants.DEFAULT_OPTIONS[key], acc), {});
    } else if (typeof keys === 'string') {
        keysData = {[keys]: Constants.DEFAULT_OPTIONS[keys]};
    } else { // if keys is object
        keysData = keys;
    }

    let result = null;

    try {
        result = await browser.storage.local.get(keysData);
    } catch (e) {
        errorCounter++;

        if (errorCounter > 100) {
            Urls.openUrl('db-error-reinstall', true);
            log.throwError('db-error-reinstall', e);
        }

        log.error("can't read keys", {errorCounter});

        await new Promise(resolve => setTimeout(resolve, 200));
        return get(keys, errorCounter);
    }

    if (!keys && forMigrate) {
        result = {
            ...JSON.clone(Constants.DEFAULT_OPTIONS),
            ...result,
        };
    }

    log.stop();
    return result;
}

export async function set(data) {
    const log = logger.start('set', Object.keys(data));

    if (data.groups) {
        data.groups.forEach(group => !group.isArchive && (group.tabs = []));
    }

    const result = await browser.storage.local.set(data);

    log.stop();

    return result;
}

export function remove(...args) {
    return browser.storage.local.remove(...args);
}

export function clear(...args) {
    return browser.storage.local.clear(...args);
}
