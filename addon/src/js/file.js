
import Logger from './logger.js';
import * as Storage from './storage.js';

const logger = new Logger('File');

export async function load(accept = '.json', readAs = 'json') { // readAs: json, text, url
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

// data : Object/Array/Text
export async function save(data, fileName = 'file-name', saveAs = true, clearOnComplete = false, tryCount = 0) {
    const log = logger.start('save', {fileName, saveAs, clearOnComplete, tryCount});

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
        const id = await browser.downloads.download({
            filename: fileName,
            url: url,
            saveAs: saveAs,
            conflictAction: browser.downloads.FilenameConflictAction.OVERWRITE,
        });

        log.log('id download', id);

        let {
            state: state = browser.downloads.State.INTERRUPTED,
            error: error = `Download ID not found, id: ${id}`,
        } = await waitDownload(id);

        error = `Error save file:\n${fileName}\nerror: ${String(error)}`;

        if (browser.downloads.State.COMPLETE === state) {
            if (clearOnComplete) {
                await browser.downloads.erase({id});
            }
        } else if (browser.downloads.State.INTERRUPTED === state && !saveAs && tryCount < 5) {
            await browser.downloads.erase({id});
            URL.revokeObjectURL(url);
            log.stopWarn('cant download id:', id, 'tryCount:', tryCount, error);
            return save(data, fileName, saveAs, clearOnComplete, tryCount + 1);
        } else {
            throw error;
        }

        URL.revokeObjectURL(url);

        return log.stop(id);
    } catch (e) {
        URL.revokeObjectURL(url);
        if (!String(e.message || e).toLowerCase().includes('canceled')) {
            log.logError(e.message || e, e);
            log.stopError();
        } else {
            log.stop();
        }
    } finally {
        URL.revokeObjectURL(url);
    }
}

export async function backup(data, isAutoBackup, byDayIndex) {
    let fileName = generateBackupFileName(isAutoBackup, byDayIndex);

    if (isAutoBackup) {
        let autoBackupFolderName = await getAutoBackupFolderName();
        fileName = autoBackupFolderName + '/' + fileName;
    }

    return save(data, fileName, !isAutoBackup, isAutoBackup);
}

export async function openBackupFolder() {
    let autoBackupFolderName = await getAutoBackupFolderName(),
        id = await save('temp file', autoBackupFolderName + '/tmp.tmp', false);

    if (id) {
        await browser.downloads.show(id);
        await new Promise(res => setTimeout(res, 750));
        await browser.downloads.removeFile(id);
        await browser.downloads.erase({id});
    }
}

export async function getAutoBackupFolderName() {
    let {autoBackupFolderName} = await Storage.get('autoBackupFolderName');

    if (
        !autoBackupFolderName.length ||
        /^STG\-backups\-FF\-[a-z\d\.]+$/.test(autoBackupFolderName) ||
        /^STG\-backups\-(win|linux|mac|openbsd)\-\d+$/.test(autoBackupFolderName)
    ) {
        let {version} = await browser.runtime.getBrowserInfo(),
            newAutoBackupFolderName = `STG-backups-FF-${version}`;

        if (autoBackupFolderName !== newAutoBackupFolderName) {
            autoBackupFolderName = newAutoBackupFolderName;

            await Storage.set({autoBackupFolderName});
        }
    }

    return autoBackupFolderName;
}

function generateBackupFileName(isAutoBackup, byDayIndex = false) {
    let now = new Date(),
        day = _intToStr(now.getDate()),
        month = _intToStr(now.getMonth() + 1),
        year = now.getFullYear(),
        type = isAutoBackup ? 'auto' : 'manual',
        dateOrDayIndex = (isAutoBackup && byDayIndex) ? `day-of-month-${day}` : `${year}-${month}-${day}`;

    return `${type}-stg-backup-${dateOrDayIndex}@drive4ik.json`;
}

function _intToStr(i) {
    return ('0' + i).slice(-2);
}

export async function waitDownload(id, maxWaitSec = 10) {
    let downloadObj = null;

    for (let i = 0; i < maxWaitSec * 5; i++) {
        [downloadObj] = await browser.downloads.search({id});

        if (downloadObj && browser.downloads.State.IN_PROGRESS !== downloadObj.state) {
            break;
        }

        await new Promise(resolve => setTimeout(resolve, 200));
    }

    return downloadObj || {};
}
