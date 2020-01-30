'use strict';

import utils from './utils';
import storage from './storage';

async function load(accept = '.json', readAs = 'json') { // readAs: json, text, url
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

async function save(data, fileName = 'file-name', saveAs = true, overwrite = false, clearOnComplete = false, tryCount = 0) { // data : Object/Array/Text
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

        if (browser.downloads.State.COMPLETE === state) {
            if (clearOnComplete) {
                await BG.browser.downloads.erase({id});
            }
        } else if ((browser.downloads.State.INTERRUPTED === state || !state) && tryCount < 5) {
            await BG.browser.downloads.erase({id});
            URL.revokeObjectURL(url);
            return save(data, fileName, saveAs, overwrite, clearOnComplete, tryCount + 1);
        }

        return id;
    } catch (e) {
        utils.notify(String(e), 7000);
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function backup(data, isAutoBackup, overwrite) {
    let fileName = await generateBackupFileName(!overwrite);

    if (isAutoBackup) {
        let autoBackupFolderName = await getAutoBackupFolderName();
        fileName = autoBackupFolderName + '/' + fileName;
    }

    return save(data, fileName, !isAutoBackup, overwrite, isAutoBackup);
}

async function openBackupFolder() {
    const {BG} = browser.extension.getBackgroundPage();

    let autoBackupFolderName = await getAutoBackupFolderName(),
        id = await save('temp file', autoBackupFolderName + '/tmp.tmp', false, true, false);

    await BG.browser.downloads.show(id);
    await utils.wait(750);
    await BG.browser.downloads.removeFile(id);
    await BG.browser.downloads.erase({id});
}

async function getAutoBackupFolderName() {
    let {autoBackupFolderName} = await storage.get('autoBackupFolderName');

    if (!autoBackupFolderName.length || /^STG\-backups\-FF\-[a-z\d\.]+$/.test(autoBackupFolderName)) {
        let {version} = await browser.runtime.getBrowserInfo(),
            newAutoBackupFolderName = `STG-backups-FF-${version}`;

        if (autoBackupFolderName !== newAutoBackupFolderName) {
            autoBackupFolderName = newAutoBackupFolderName;

            await storage.set({autoBackupFolderName});
        }
    }

    return autoBackupFolderName;
}

async function generateBackupFileName(withTime) {
    let now = new Date(),
        day = _intToStr(now.getDate()),
        month = _intToStr(now.getMonth() + 1),
        year = now.getFullYear(),
        hours = _intToStr(now.getHours()),
        min = _intToStr(now.getMinutes()),
        {os} = await browser.runtime.getPlatformInfo(),
        time = withTime ? `~${hours}-${min}` : '';

    return `stg-backup-${os}-${year}-${month}-${day}${time}@drive4ik.json`;
}

function _intToStr(i) {
    return ('0' + i).substr(-2);
}

export default {
    load,
    save,
    backup,
    openBackupFolder,
    getAutoBackupFolderName,
};
