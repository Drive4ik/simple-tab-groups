
import * as Constants from './constants.js';
import Logger from '/js/logger.js';

const logger = new Logger(Constants.HOST_NAME);

export async function hasPermission() {
    return browser.permissions.contains(Constants.PERMISSIONS.NATIVE_MESSAGING);
}

export async function requestPermission() {
    return browser.permissions.request(Constants.PERMISSIONS.NATIVE_MESSAGING);
}

function normalizeResponseMessage(response) {
    if (response.lang) {
        response.message = browser.i18n.getMessage(response.lang, ...response.args);
    }

    return response;
}

export class HostError extends Error {
    constructor(response) {
        const message = normalizeResponseMessage(response).message || 'Unknown host error';
        super(message, 'STGHost.exe');
        this.name = 'HostError';
        this.response = response;
    }
}

export function getErrorMessage(error) {
    if (error instanceof HostError) {
        return error.message;
    }

    return String(error);
}

async function sendMessage(action, params = {}) {
    const response = await browser.runtime.sendNativeMessage(Constants.HOST_NAME, {
        action,
        ...params,
    });

    logger.assert(response.ok, 'response:', response);

    if (response.ok) {
        return response;
    }

    throw new HostError(response);
}

export async function getSettings() {
    const {data} = await sendMessage('get-settings');
    return data;
}

export async function setSettings(settings) {
    const {data} = await sendMessage('set-settings', {settings});
    return data;
}

export async function getBackupFolder() {
    const {data} = await sendMessage('get-backup-folder');
    return data;
}

export async function openBackupFolder() {
    await sendMessage('open-backup-folder');
}

export async function selectBackupFolder() {
    const {data} = await sendMessage('select-backup-folder', {
        dialogTitle: browser.i18n.getMessage('selectBackupFolder'),
    });
    return data;
}
