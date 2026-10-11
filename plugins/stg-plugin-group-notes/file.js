
// import * as Constants from './constants.js';
import * as MainConstants from './main-constants.js';
import * as Utils from './utils.js';
import * as Downloads from './downloads.js';

const SAVE_TRY_COUNT = 5; // STG issue #374: backups that failed for no known reason, BEHAVIOR-DOWNLOADS.md conclusion 3

export async function load(accept = '*/*', readAs = 'text') { // readAs: text, url. null when the user closes the dialog without a file
    if (!['text', 'url'].includes(readAs)) {
        throw new Error('wrong readAs parameter');
    }

    const {promise, resolve, reject} = Promise.withResolvers();

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.initialValue = input.value;

    input.addEventListener('cancel', () => resolve(null));
    input.addEventListener('change', () => {
        if (input.initialValue === input.value) {
            return reject('no changes');
        }

        const [file] = input.files;

        if (!file.size) {
            return reject('empty file');
        } else if (file.size > 2048e6) {
            return reject('The file exceeds 2GB');
        }

        const reader = new FileReader();

        reader.addEventListener('loadend', () => {
            file.data = reader.result;
            resolve(file);
        });
        reader.addEventListener('error', reject);
        reader.addEventListener('abort', reject);

        if ('url' === readAs) {
            reader.readAsDataURL(file);
        } else {
            reader.readAsText(file);
        }
    });

    input.click();

    return promise;
}

export async function loadJson() {
    const file = await load('application/json', 'text');

    if (file) {
        file.data = JSON.parse(file.data);
    }

    return file;
}

// data : Object/Array/Text
export async function save(data, filePath = 'file-name', options = {}) {
    const {saveAs = true, clearOnComplete = false, throwError = false} = options;

    filePath = Utils.format(filePath, Utils.getFilePathVariables());

    const blob = typeof data === 'string'
        ? new Blob([data], {type: 'text/plain'})
        : new Blob([JSON.stringify(data, null, 4)], {type: 'application/json'});

    try {
        for (let tryIndex = 1; ; tryIndex++) {
            const {id, state, error} = await Downloads.download(blob, {
                filename: filePath,
                saveAs,
                conflictAction: Downloads.FilenameConflictAction.OVERWRITE,
            });

            if (state === Downloads.State.COMPLETE) {
                if (clearOnComplete) {
                    await Downloads.eraseId(id);
                }

                return id;
            }

            if (error === Downloads.InterruptReason.USER_CANCELED) { // the user canceled the download in the downloads panel
                return;
            }

            if (saveAs || tryIndex >= SAVE_TRY_COUNT) {
                throw new Error(`Error save file:\n${filePath}\nerror: ${error}`);
            }

            await Downloads.eraseId(id);
            console.warn('download interrupted, try again', {id, tryIndex, error});
        }
    } catch (e) {
        if (Downloads.isCanceledByUser(e)) {
            return;
        }

        console.error(e);

        if (throwError) {
            throw e;
        }
    }
}

export async function saveBackup(data, isAutoBackup) {
    const filePath = data.autoBackupFilePath + '.json';

    data.id = browser.runtime.id;

    return await save(data, filePath, {
        saveAs: !isAutoBackup,
        clearOnComplete: isAutoBackup,
        throwError: true,
    });
}

export async function testBackupFilePath(filePath, exploreFolder = false) {
    let id = null;

    try {
        id = await save({}, filePath + '.json', {
            saveAs: false,
            throwError: true,
        });

        if (id && exploreFolder) {
            await Downloads.show(id);
            await new Promise(resolve => setTimeout(resolve, 750));
        }
    } finally {
        if (id) {
            await Downloads.removeFile(id).catch(() => {});
            await Downloads.eraseId(id).catch(() => {});
        }
    }
}

export async function openBackupFolder() {
    const TEMP_FILE_NAME = 'folder-check';

    let {autoBackupFilePath} = await browser.storage.local.get(MainConstants.defaultOptions);

    autoBackupFilePath = autoBackupFilePath.replaceAll('\\', '/');

    const slashIndex = autoBackupFilePath.lastIndexOf('/');

    if (slashIndex > -1) {
        autoBackupFilePath = autoBackupFilePath.slice(0, slashIndex + 1) + TEMP_FILE_NAME;
    } else {
        autoBackupFilePath = TEMP_FILE_NAME;
    }

    await testBackupFilePath(autoBackupFilePath, true);
}
