'use strict';

import utils from './utils';
import storage from './storage';

const BACKUP_FILE_EXT = '.json';

async function load(accept = BACKUP_FILE_EXT, readAs = 'json') { // readAs: json, text, url
    if (!['json', 'text', 'url'].includes(readAs)) {
        throw Error('wrong readAs parameter');
    }

    let result = await new Promise(function(resolve, reject) {
        let fileInput = document.createElement('input');

        fileInput.type = 'file';
        fileInput.accept = accept;

        if ('json' === readAs || 'text' === readAs) {
            fileInput.acceptCharset = 'utf-8';
        }

        fileInput.initialValue = fileInput.value;

        fileInput.onchange = function() {
            if (fileInput.value === fileInput.initialValue) {
                reject('no changes');
                return;
            }

            let file = fileInput.files[0];

            if (0 === file.size) {
                reject('empty file');
                return;
            }

            if (file.size > 500e6) {
                reject('500MB backup? I don\'t believe you');
                return;
            }

            let reader = new FileReader();

            reader.addEventListener('loadend', () => resolve(reader.result));
            reader.addEventListener('error', reject);

            if ('json' === readAs || 'text' === readAs) {
                reader.readAsText(file, 'utf-8');
            } else if ('url' === readAs) {
                reader.readAsDataURL(file);
            }
        };

        fileInput.click();
    });

    if ('json' === readAs) {
        return JSON.parse(result);
    }

    return result;
}

async function save(data, fileName = 'file-name', saveAs = true, overwrite = false, clearOnComplete = false) { // data : Object/Array/Text
    let body = null,
        type = null;

    if ('string' === typeof data) {
        type = 'text/plain';
        body = data;
    } else {
        type = 'application/json';
        body = JSON.stringify(data, null, 4);
    }

    let blob = new Blob([body], {type}),
        url = URL.createObjectURL(blob);

    const {BG} = browser.extension.getBackgroundPage();

    try {
        let id = await BG.browser.downloads.download({
            filename: fileName,
            url: url,
            saveAs: saveAs,
            conflictAction: overwrite ? 'overwrite' : 'uniquify',
        });

        let state = await utils.waitDownload(id);

        if (clearOnComplete && 'complete' === state) {
            await BG.browser.downloads.erase({id});
        }

        return id;
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function backup(data, isAutoBackup, overwrite) {
    let fileName = generateBackupFileName(!overwrite);

    if (isAutoBackup) {
        let {autoBackupFolderName} = await storage.get('autoBackupFolderName');
        fileName = autoBackupFolderName + '/' + fileName;
    }

    return save(data, fileName, !isAutoBackup, overwrite, isAutoBackup);
}

async function openBackupFolder() {
    const {BG} = browser.extension.getBackgroundPage();

    let {autoBackupFolderName} = await storage.get('autoBackupFolderName'),
        id = await save('temp file', autoBackupFolderName + '/tmp.tmp', false, true, false);

    await BG.browser.downloads.show(id);
    await utils.wait(750);
    await BG.browser.downloads.removeFile(id);
    await BG.browser.downloads.erase({id});

}

function generateBackupFileName(withTime) {
    let now = new Date(),
        day = _intToStr(now.getDate()),
        month = _intToStr(now.getMonth() + 1),
        year = now.getFullYear(),
        hours = _intToStr(now.getHours()),
        min = _intToStr(now.getMinutes()),
        time = withTime ? `~${hours}-${min}` : '';

    return `stg-backup-${year}-${month}-${day}${time}@drive4ik${BACKUP_FILE_EXT}`;
}

function _intToStr(i) {
    return ('0' + i).substr(-2);
}

export default {
    load,
    save,
    backup,
    openBackupFolder,
};
