'use strict';

import * as utils from './utils';
import * as constants from './constants';

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

    try {
        let id = await browser.downloads.download({
            filename: fileName,
            url: url,
            saveAs: saveAs,
            conflictAction: overwrite ? 'overwrite' : 'uniquify',
        });

        let state = await utils.waitDownload(id);

        if (clearOnComplete && 'complete' === state) {
            await browser.downloads.erase({id});
        }

        return id;
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function backup(data, isAutoBackup, overwrite) {
    let fileName = generateBackupFileName(!overwrite);

    if (isAutoBackup) {
        fileName = constants.BACKUP_FOLDER + fileName;
    }

    return save(data, fileName, !isAutoBackup, overwrite, isAutoBackup);
}

async function openBackupFolder() {
    let id = await save('temp file', constants.BACKUP_FOLDER + 'tmp.tmp', false, true, false);

    await browser.downloads.show(id);
    await utils.wait(150);
    await browser.downloads.removeFile(id);
    await browser.downloads.erase({id});

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

export {
    load,
    save,
    backup,
    openBackupFolder,
};
