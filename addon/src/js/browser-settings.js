import Logger from './logger.js';
import * as Constants from './constants.js';
import * as Permissions from './permissions.js';

const logger = new Logger('BrowserSettings');

export async function hasPermission() {
    return Permissions.has(Permissions.BROWSER_SETTINGS);
}

export async function requestPermission() {
    return Permissions.request(Permissions.BROWSER_SETTINGS);
}

export async function removePermission() {
    return Permissions.remove(Permissions.BROWSER_SETTINGS);
}

export function isNotControllable(rawSetting) {
    return rawSetting.levelOfControl === browser.types.LevelOfControl.NOT_CONTROLLABLE;
}

async function getSetting(name) {
    return browser.browserSettings[name].get({});
}

async function setSetting(name, value) {
    const currentRaw = await getSetting(name);

    if (isNotControllable(currentRaw) || currentRaw.value === value) {
        return currentRaw;
    }

    await browser.browserSettings[name].set({value});

    return getSetting(name);
}

export async function get() {
    const log = logger.start('get');
    const resultRaw = {};

    for (const name of Object.keys(Constants.BROWSER_SETTINGS_SCHEME)) {
        try {
            resultRaw[name] = await getSetting(name);
        } catch (e) {
            log.logError(name, e);
        }
    }

    log.stop(resultRaw);
    return resultRaw;
}

export async function set(settings = {}) {
    const log = logger.start('set', settings);
    const resultRaw = {};

    for (const [name, value] of Object.entries(settings)) {
        try {
            resultRaw[name] = await setSetting(name, value);
        } catch (e) {
            log.logError(String(e), e);
        }
    }

    log.stop(resultRaw);
    return resultRaw;
}
