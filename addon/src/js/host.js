
import * as Constants from './constants.js';
import * as Utils from './utils.js';
import Logger from '/js/logger.js';

const logger = new Logger(Constants.HOST.NAME);

export async function hasPermission() {
    return browser.permissions.contains(Constants.PERMISSIONS.NATIVE_MESSAGING);
}

export async function requestPermission() {
    return browser.permissions.request(Constants.PERMISSIONS.NATIVE_MESSAGING);
}

export class HostError extends Error {
    constructor(response) {
        let message;

        if (response.message) {
            message = response.message;
        } else if (response.lang) {
            message = browser.i18n.getMessage(response.lang, ...response.args) || response.lang;
        } else {
            message = 'Unknown error';
        }

        logger.error(`HostError: ${message}`, response);

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
    if (params.filePath) {
        params.filePath = Utils.format(params.filePath, Utils.getFilePathVariables());
    }

    const response = await browser.runtime.sendNativeMessage(Constants.HOST.NAME, {
        action,
        ...params,
    });

    logger.debug(response);

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

export async function testFilePath(filePath) {
    await sendMessage('test-save-backup', {
        filePath: filePath + '.json',
    });
}

export async function saveBackup(data) {
    await sendMessage('save-backup', {
        filePath: data.autoBackupFilePathHost + '.json',
        data,
    });
}
