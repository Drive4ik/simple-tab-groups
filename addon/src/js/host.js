
import * as Constants from './constants.js';
import * as Utils from './utils.js';
import * as Permissions from './permissions.js';
import Queue from './queue.js';
import Logger from '/js/logger.js';
import Lang from '/js/lang.js';

const logger = new Logger('Host');

// one message to the host at a time; the version check holds the turn over its own messages (docs/DESIGN-QUEUES.md §2)
const hostQueue = new Queue('Host');

// the folder dialog and the update wait for the user and the network (docs/DESIGN-QUEUES.md §5)
const LONG_ACTION_STUCK_AFTER = 10 * 60_000;

export async function hasPermission() {
    return Permissions.has(Permissions.NATIVE_MESSAGING);
}

export async function requestPermission() {
    return Permissions.request(Permissions.NATIVE_MESSAGING);
}

export async function removePermission() {
    return Permissions.remove(Permissions.NATIVE_MESSAGING);
}

export class HostError extends Error {
    constructor(response, cause = response) {
        let message;

        if (response.message) {
            message = response.message;
        } else if (response.lang) {
            message = Lang(response.lang, response.args) || response.lang;
        } else {
            message = 'Unknown error';
        }

        super(message, {cause});

        this.name = 'HostError';
        this.lang = response.lang;

        logger.error(`HostError: ${message}`, response, this);
    }
}

export function getErrorMessage(error) {
    if (error instanceof HostError) {
        return error.message;
    }

    return String(error);
}

async function sendMessage(action, params = {}, stuckAfter) {
    using turn = await hostQueue.wait(action, this, {stuckAfter});
    using log = logger.start('sendMessage', `HOST_ACTION#${action}`);

    if (params.filePath) {
        params.filePath = Utils.format(params.filePath, Utils.getFilePathVariables());
    }

    const response = await browser.runtime.sendNativeMessage(Constants.HOST.NAME, {
        action,
        ...params,
    });

    if (response.ok) {
        log.log(response);
        return response;
    }

    throw new HostError(response);
}

export async function checkVersion() {
    using turn = await hostQueue.wait('check-version', null, {stuckAfter: LONG_ACTION_STUCK_AFTER});

    try {
        const {data: hostVersion} = await sendMessage.call(turn, 'get-version');

        const versionDiffIndex = Utils.compareNumericVersions(Constants.HOST.VERSION, hostVersion);

        if (versionDiffIndex > 0) {
            let version;

            if (versionDiffIndex === 1) {
                version = Constants.HOST.VERSION;
            } else {
                version = 'latest'; // will update to latest NOT major version
            }

            await sendMessage.call(turn, 'update', {version});
        }
    } catch (e) {
        if (e instanceof HostError) {
            throw e;
        } else {
            throw new HostError({
                lang: 'hostAppNotFound',
                args: [],
            }, e);
        }
    }
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
        dialogTitle: Lang('selectBackupFolder'),
    }, LONG_ACTION_STUCK_AFTER);
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

export async function testBackupFilePath(filePath) {
    await sendMessage('save-backup', {
        filePath: filePath + '.json',
        test: true,
    });
}

export async function saveBackup(data) {
    await sendMessage('save-backup', {
        filePath: data.autoBackupFilePath + '.json',
        data,
    });
}
