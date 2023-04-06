import '/translate-page.js';
import * as Utils from '/utils.js';
import * as MainUtils from '/main-utils.js';

async function loadOptions() {
    const options = await browser.storage.local.get(MainUtils.defaultOptions);

    for(const [optionId, optionValue] of Object.entries(options)) {
        if (typeof optionValue === 'boolean') {
            document.getElementById(optionId).checked = optionValue;
        }
    }
}

function setOptionInputEvents() {
    for(const [optionId, optionValue] of Object.entries(MainUtils.defaultOptions)) {
        if (typeof optionValue === 'boolean') {
            document.getElementById(optionId).addEventListener('change', e => saveOption(e.target.id, e.target.checked));
        }
    }
}

async function saveOption(optionId, value) {
    await browser.storage.local.set({
        [optionId]: value,
    });

    Utils.sendMessage('options-updated').catch(() => {});
}

loadOptions().then(setOptionInputEvents);


const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = '.json';

document.getElementById('importBackup').addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
    const uploadedBackup = await Utils.readFileAsText(fileInput.files[0])
        .then(result => JSON.parse(result))
        .catch(alert);

    const isV1 = Object.keys(uploadedBackup).every(key => Number(key).toString() === key && uploadedBackup[key].hasOwnProperty('notes'));
    const isV2 = uploadedBackup?.id === browser.runtime.id;

    let backupToSave;

    if (isV1) {
        backupToSave = MainUtils.migrateStrorageToV2(uploadedBackup);
    } else if (isV2) {
        delete uploadedBackup.id;
        backupToSave = uploadedBackup;
    } else {
        alert('Invalid backup');
    }

    if (backupToSave) {
        await browser.storage.local.clear();
        await browser.storage.local.set(backupToSave);

        alert('Success!');

        browser.runtime.reload();
    }
});

const exportBackupButton = document.getElementById('exportBackup');
exportBackupButton.addEventListener('click', async () => {
    const backupToSave = await browser.storage.local.get();

    backupToSave.id = browser.runtime.id;

    const backupToSaveStr = JSON.stringify(backupToSave, null, 4),
        backupFileName = 'notes-backup-' + (new Date).toLocaleDateString().replace(/[\\/]/g, '-') + '.json',
        aTag = document.createElement('a');

    aTag.download = backupFileName;
    aTag.href = Utils.toBase64(backupToSaveStr, 'application/json');
    aTag.click();
});
