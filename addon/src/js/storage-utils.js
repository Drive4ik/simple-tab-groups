
import * as Constants from './constants.js';

export function getKeysData(keys, defaultData) {
    let keysData;

    if (!keys) {
        keysData = defaultData;
    } else if (Array.isArray(keys)) {
        keysData = keys.reduce((acc, key) => (acc[key] = defaultData[key], acc), {});
    } else if (typeof keys === 'string') {
        keysData = {[keys]: defaultData[keys]};
    } else { // if keys is object
        keysData = {...keys};
    }

    return keysData;
}

export async function nativeGet(area, keysData, log, errorCounter = 0) {
    try {
        return await browser.storage[area].get(keysData);
    } catch (e) {
        if (errorCounter++ > 100) {
            browser.tabs.create({
                url: Constants.PAGES.HELP.REINSTALL,
                active: true,
            });
            log.throwError('db-error-reinstall', e);
        }

        log.error("can't read keys", {area, errorCounter});

        await new Promise(resolve => setTimeout(resolve, 200));

        return nativeGet(area, keysData, log, errorCounter);
    }
}
