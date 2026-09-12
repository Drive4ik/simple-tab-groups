
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

const TYPE_CHECKS = new Map([
    [Boolean, value => typeof value === 'boolean'],
    [String, value => typeof value === 'string'],
    [Number, value => typeof value === 'number'],
    [Array, value => Array.isArray(value)],
    [Object, value => typeof value === 'object' && value !== null && !Array.isArray(value)],
]);

// the first write of a key comes with oldValue present as undefined, a removal without newValue,
// and an unchanged write fires just the same (docs/STORAGE-BEHAVIOR.md §1, §2): a change is a
// new value of the type that differs from the old one, or that has no old one at all
export function isChangedKey(key, changes, type) {
    const {newValue, oldValue} = changes[key] ?? {};
    const isType = TYPE_CHECKS.get(type);

    if (!isType(newValue)) {
        return false;
    }

    if (oldValue === undefined) {
        return true;
    }

    if (!isType(oldValue)) {
        return false;
    }

    if (type === Array || type === Object) {
        return JSON.stringify(newValue) !== JSON.stringify(oldValue);
    }

    return newValue !== oldValue;
}
