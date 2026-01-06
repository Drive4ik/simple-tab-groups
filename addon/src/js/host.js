
import * as Constants from './constants.js';
import * as Utils from './utils.js';
import Logger from '/js/logger.js';

const logger = new Logger('Host');

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
    const log = logger.start('sendMessage', `HOST_ACTION#${action}`);

    if (params.filePath) {
        params.filePath = Utils.format(params.filePath, Utils.getFilePathVariables());
    }

    const response = await browser.runtime.sendNativeMessage(Constants.HOST.NAME, {
        action,
        ...params,
    });

    if (response.ok) {
        log.stop(response);
        return response;
    }

    log.stopError();
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

export async function getLastBackup(progressFunc = null) {
    return await getLastBackupPartByParts(progressFunc);
}

async function getLastBackupPartByParts(progressFunc = null, partIndex = 0, prevData = '') {
    const response = await sendMessage('get-last-backup', {partIndex});

    if (['base64', 'json'].some(encoding => response.encoding?.includes(encoding))) {
        response.data = prevData + response.data;

        if (response.nextPartIndex) {
            progressFunc?.(Math.floor(response.nextPartIndex / response.lastPartIndex * 100));
            return await getLastBackupPartByParts(progressFunc, response.nextPartIndex, response.data);
        }
    }

    return joinParts(response);
}

function joinParts(response) {
    const step = response.encoding?.shift();

    if (step === 'base64') {
        response.data = Utils.base64Decode(response.data);
    } else if (step === 'json') {
        response.data = JSON.parse(response.data);
    } else if (!step) {
        return response;
    }

    return joinParts(response);
}

export async function testFilePath(filePath) {
    await sendMessage('save-backup', {
        filePath: filePath + '.json',
        test: true,
    });
}

export async function saveBackup(data) {
    await sendMessage('save-backup', {
        filePath: data.autoBackupFilePathHost + '.json',
        data,
    });
}
