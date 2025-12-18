
import * as Constants from './constants.js';
import * as Utils from './utils.js';
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
export async function save(data, filePath = 'file-name', options = {}) {
    options.saveAs ??= true;
    options.clearOnComplete ??= false;
    options.throwError ??= false;
    options.tryCount ??= 0;

    filePath = Utils.format(filePath, Utils.getFilePathVariables());

    const log = logger.start('save', {filePath, ...options});

    let body = null,
        type = null;

    if ('string' === typeof data) {
        type = 'text/plain';
        body = data;
    } else {
        type = 'application/json';
        body = JSON.stringify(data, null, 4);
    }

    const blob = new Blob([body], {type});
    const url = URL.createObjectURL(blob);

    try {
        const id = await browser.downloads.download({
            filename: filePath,
            url: url,
            saveAs: options.saveAs,
            conflictAction: browser.downloads.FilenameConflictAction.OVERWRITE,
        });

        log.log('id download', id);

        let {
            state: state = browser.downloads.State.INTERRUPTED,
            error: error = `Download ID not found, id: ${id}`,
        } = await waitDownload(id);

        error = `Error save file:\n${filePath}\nerror: ${String(error)}`;

        if (browser.downloads.State.COMPLETE === state) {
            if (options.clearOnComplete) {
                await browser.downloads.erase({id});
            }
        } else if (browser.downloads.State.INTERRUPTED === state && !options.saveAs && options.tryCount < 5) {
            await browser.downloads.erase({id});
            log.stopWarn('cant download id:', id, 'tryCount:', options.tryCount, error);
            options.tryCount++;
            return save(data, filePath, options);
        } else {
            throw error;
        }

        log.stop(id);

        return id;
    } catch (e) {
        if (!String(e.message || e).toLowerCase().includes('canceled')) {
            log.logError(e.message || e, e);
            log.stopError();

            if (options.throwError) {
                throw e;
            }
        } else {
            log.stop();
        }
    } finally {
        URL.revokeObjectURL(url);
    }
}

export async function saveBackup(data, isAutoBackup) {
    const filePath = data.autoBackupFilePathFile + '.json';

    return await save(data, filePath, {
        saveAs: !isAutoBackup,
        clearOnComplete: isAutoBackup,
        throwError: true,
    });
}

export async function testFilePath(filePath, exploreFolder = false) {
    let id = null;

    try {
        id = await save({test:'test'}, filePath + '.json', {
            saveAs: false,
            throwError: true,
        });

        if (id && exploreFolder) {
            await browser.downloads.show(id);
            await Utils.wait(750);
        }
    } finally {
        if (id) {
            await browser.downloads.removeFile(id).catch(() => {});
            await browser.downloads.erase({id}).catch(() => {});
        }
    }
}

export async function openBackupFolder() {
    const TEMP_FILE_NAME = 'folder-check';

    let {autoBackupFilePathFile} = await Storage.get('autoBackupFilePathFile');

    autoBackupFilePathFile = autoBackupFilePathFile.replaceAll('\\', '/');

    const slashIndex = autoBackupFilePathFile.lastIndexOf('/');

    if (slashIndex > -1) {
        autoBackupFilePathFile = autoBackupFilePathFile.slice(0, slashIndex + 1) + TEMP_FILE_NAME;
    } else {
        autoBackupFilePathFile = TEMP_FILE_NAME;
    }

    try {
        await testFilePath(autoBackupFilePathFile, true);
    } catch (e) {
        logger.logError(String(e), e);
    }
}

async function waitDownload(id, maxWaitSec = 10) {
    let downloadObj = null;

    for (let i = 0; i < maxWaitSec * 5; i++) {
        [downloadObj] = await browser.downloads.search({id});

        if (downloadObj && browser.downloads.State.IN_PROGRESS !== downloadObj.state) {
            break;
        }

        await Utils.wait(200);
    }

    return downloadObj || {};
}
