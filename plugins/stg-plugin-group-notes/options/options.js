import Listeners from '/listeners.js?permissions.onRemoved';
import * as Host from '/host.js';
import * as File from '/file.js';
import * as Utils from '/utils.js';
import * as Constants from '/constants.js';
import * as MainConstants from '/main-constants.js';
import * as MainUtils from '/main-utils.js';
import Lang from '/lang.js?translate-page&text';

const $ = document.querySelector.bind(document);
const $$ = selector => Array.from(document.querySelectorAll(selector));

const FILE_PATH_VARIABLES = Utils.getFilePathVariables();
const filePathNodes = $$('.auto-backup-content input[data-file-path]');
const locationNodeDownloads = getBackupLocationNode(MainConstants.AUTO_BACKUP_LOCATIONS.DOWNLOADS);
const locationNodeHost = getBackupLocationNode(MainConstants.AUTO_BACKUP_LOCATIONS.HOST);
const nativeMessaging = $('#nativeMessaging');

loadSettings().then(setNodeValues).then(setEvents);

Listeners.permissions.onRemoved(() => {
    nativeMessaging.checked = false;
    locationNodeDownloads.checked = true;
    locationNodeHost.disabled = true;
});

async function loadSettings(key = null) {
    const settings = Object.assign({...MainConstants.defaultOptions}, await browser.storage.local.get());
    return key ? settings[key] : settings;
}

function setValueFilePathNodes(value) {
    filePathNodes.forEach(node => node.value = value);
}

function getBackupLocationNode(value) {
    return $(`[name="autoBackupLocation"][value="${value}"]`);
}

async function setNodeValues(options) {
    for (const [optionId, optionValue] of Object.entries(options)) {
        if (!Object.hasOwn(MainConstants.defaultOptions, optionId)) continue;

        const optionNode = $(`#${optionId}`);

        if (!optionNode) continue;

        if (optionNode.type === 'checkbox') {
            optionNode.checked = optionValue;
        } else if (optionNode.type === 'number') {
            optionNode.valueAsNumber = optionValue;
        } else if (optionNode.nodeName === 'SELECT') {
            optionNode.value = optionValue;
        }
    }

    setValueFilePathNodes(options.autoBackupFilePath);

    const hasPermission = nativeMessaging.checked = await Host.hasPermission();

    locationNodeHost.disabled = !Constants.IS_WINDOWS || !hasPermission;

    if (options.autoBackupLocation === MainConstants.AUTO_BACKUP_LOCATIONS.DOWNLOADS) {
        locationNodeDownloads.checked = true;
    } else if (options.autoBackupLocation === MainConstants.AUTO_BACKUP_LOCATIONS.HOST) {
        if (Constants.IS_WINDOWS && hasPermission) {
            locationNodeHost.checked = true;
        } else {
            locationNodeDownloads.checked = true;
            await saveOption('autoBackupLocation', MainConstants.AUTO_BACKUP_LOCATIONS.DOWNLOADS);
        }
    }

    $('#location-downloads-input').value = Lang('downloadsFolder') + '/';

    $('#auto-backup-wrapper').classList.toggle('is-windows', Constants.IS_WINDOWS);
}

async function saveOption(optionId, value) {
    await browser.storage.local.set({
        [optionId]: value,
    });

    Utils.sendMessage('options-updated').catch(() => {});
}

async function setFilePathEvents(filePathNode) {
    const errorNode = $(`#${filePathNode.dataset.filePath}-error-message`);

    filePathNode.selectionStart = filePathNode.value.length;
    filePathNode.addEventListener('change', async () => {
        try {
            const autoBackupFilePath = filePathNode.value.trim();

            if (!autoBackupFilePath) {
                throw new Error('');
            }

            setValueFilePathNodes(autoBackupFilePath);

            if (filePathNode.dataset.filePath === MainConstants.AUTO_BACKUP_LOCATIONS.HOST) {
                await Host.testBackupFilePath(autoBackupFilePath);
            } else {
                await File.testBackupFilePath(autoBackupFilePath);
            }

            await saveOption('autoBackupFilePath', autoBackupFilePath);

            errorNode.innerText = '';
        } catch (e) {
            errorNode.innerText = e.message ? e : '';
            const autoBackupFilePath = await loadSettings('autoBackupFilePath');
            setValueFilePathNodes(autoBackupFilePath);
        }
    });

    const variableButtonNode = $(`#${filePathNode.dataset.filePath}-variable-button`);
    const variableContentMenu = variableButtonNode.nextElementSibling;

    document.documentElement.addEventListener('click', () => variableContentMenu.classList.remove('open'));
    variableButtonNode.addEventListener('click', e => (e.stopPropagation(), variableContentMenu.classList.toggle('open')));
    for (const [key, value] of Object.entries(FILE_PATH_VARIABLES)) {
        const button = document.createElement('button');
        button.innerText = `{${key}} - ${value}`;
        button.addEventListener('click', () => {
            setValueFilePathNodes(Utils.insertVariable(filePathNode, filePathNode.value, key));
            filePathNode.dispatchEvent(new Event('change', {bubbles: true}));
        });
        variableContentMenu.appendChild(button);
    }
}

async function setDownloadsEvents() {
    locationNodeDownloads.addEventListener('change', async () => {
        if (locationNodeDownloads.checked) {
            await saveOption('autoBackupLocation', MainConstants.AUTO_BACKUP_LOCATIONS.DOWNLOADS);

            const autoBackupIntervalKey = $('#autoBackupIntervalKey');
            if (autoBackupIntervalKey.value === Constants.INTERVAL_KEY.minutes) {
                autoBackupIntervalKey.value = Constants.INTERVAL_KEY.hours;
                autoBackupIntervalKey.dispatchEvent(new Event('change', {bubbles: true}));
            }
        }
    });

    $('#downloads-open-backup-folder').addEventListener('click', File.openBackupFolder);

    setFilePathEvents(filePathNodes.find(node => node.dataset.filePath === MainConstants.AUTO_BACKUP_LOCATIONS.DOWNLOADS));
}

async function setHostEvents() {
    const errorNode = $('#host-error-message');
    const backupFolderNode = $('#host-backup-folder');
    const deleteBackupDaysNode = $('#deleteBackupDays');
    const keepBackupFilesNode = $('#keepBackupFiles');

    backupFolderNode.addEventListener('click', async () => {
        backupFolderNode.value = await Host.selectBackupFolder();
    });

    deleteBackupDaysNode.addEventListener('change', async () => {
        const {deleteBackupDays} = await Host.setSettings({
            deleteBackupDays: Utils.clamp(deleteBackupDaysNode.valueAsNumber, deleteBackupDaysNode.min, deleteBackupDaysNode.max),
        });
        deleteBackupDaysNode.value = deleteBackupDays;
    });

    keepBackupFilesNode.addEventListener('change', async () => {
        const {keepBackupFiles} = await Host.setSettings({
            keepBackupFiles: Utils.clamp(keepBackupFilesNode.valueAsNumber, keepBackupFilesNode.min, keepBackupFilesNode.max),
        });
        keepBackupFilesNode.value = keepBackupFiles;
    });

    nativeMessaging.addEventListener('change', async ({target}) => {
        if (target.checked) {
            target.checked = await Host.requestPermission();
        } else {
            await Host.removePermission();
            locationNodeDownloads.checked = true; // state will save by BG
        }
        locationNodeHost.disabled = !target.checked;
    });

    locationNodeHost.addEventListener('change', async () => {
        if (locationNodeHost.checked) {
            saveOption('autoBackupLocation', MainConstants.AUTO_BACKUP_LOCATIONS.HOST);
            await loadHostSettings();
        }
    });

    if (locationNodeHost.checked) {
        await loadHostSettings();
    }

    $('#host-check-button').addEventListener('click', loadHostSettings);

    $('#host-link').href = Constants.HOST.DOWNLOAD_URL;

    setFilePathEvents(filePathNodes.find(node => node.dataset.filePath === MainConstants.AUTO_BACKUP_LOCATIONS.HOST));

    $('#host-open-backup-folder').addEventListener('click', Host.openBackupFolder);

    $('#host-restore-last-backup').addEventListener('click', async ({target}) => {
        try {
            target.disabled = true;
            const progressNode = $('#download-backup-progress');
            const response = await Host.getLastBackup(progress => progressNode.value = progress);
            progressNode.value = 0;

            const message = Lang('confirmRestoreBackupTitle', [
                response.relativeFilePath,
                new Date(response.lastWriteUnix * 1000).toLocaleString(),
            ]);

            if (confirm(message)) {
                await browser.storage.local.clear();
                await browser.storage.local.set(response.data);
                alert('Success');
                browser.runtime.reload();
            }
        } catch (e) {
            errorNode.innerText = e;
        } finally {
            target.disabled = false;
        }
    });

    async function loadHostSettings() {
        try {
            const {backupFolderResponse, deleteBackupDays, keepBackupFiles} = await Host.getSettings();

            if (backupFolderResponse.ok) {
                backupFolderNode.value = backupFolderResponse.data;
            } else {
                errorNode.innerText = new Host.HostError(backupFolderResponse);
            }

            deleteBackupDaysNode.value = deleteBackupDays;
            keepBackupFilesNode.value = keepBackupFiles;
            $('#host-not-found-message').classList.add('is-hidden');
        } catch {
            $('#host-not-found-message').classList.remove('is-hidden');
        }
    }
}

async function setEvents() {
    for (const optionId of Object.keys(MainConstants.defaultOptions)) {
        const optionNode = $(`#${optionId}`);

        if (!optionNode) continue;

        if (optionNode.type === 'checkbox') {
            optionNode.addEventListener('change', () => saveOption(optionId, optionNode.checked));
        } else if (optionNode.type === 'number') {
            optionNode.addEventListener('change', () => {
                const value = Utils.clamp(optionNode.valueAsNumber, optionNode.min, optionNode.max);
                saveOption(optionId, value);
            });
        } else if (optionNode.nodeName === 'SELECT') {
            optionNode.addEventListener('change', () => saveOption(optionId, optionNode.value));
        }
    }

    setDownloadsEvents();

    if (Constants.IS_WINDOWS) {
        setHostEvents();
    }

    $('#importBackup').addEventListener('click', async () => {
        try {
            const file = await File.loadJson();

            if (!file.data) {
                throw new Error('Invalid backup');
            }

            const isV1 = Object.keys(file.data).every(key => Number(key).toString() === key && file.data[key].hasOwnProperty('notes'));
            const isV2 = file.data.id === browser.runtime.id;

            let backup;

            if (isV1) {
                backup = MainUtils.migrateStrorageToV2(file.data);
            } else if (isV2) {
                delete file.data.id;
                backup = file.data;
            } else {
                throw new Error('Invalid backup');
            }

            await browser.storage.local.clear();
            await browser.storage.local.set(backup);
            alert('Success');
            browser.runtime.reload();
        } catch (e) {
            alert(e);
        }
    });

    $('#exportBackup').addEventListener('click', async () => {
        const backup = await loadSettings();

        try {
            await File.saveBackup(backup, false);
        } catch (e) {
            alert(e);
        }
    });
}
