'use strict';

const BACKUP_FILE_EXT = '.json';

let _downloads = {};

browser.downloads.onChanged.addListener(function(delta) {
    if (_downloads[delta.id] && delta.state && 'in_progress' !== delta.state.current) {
        URL.revokeObjectURL(_downloads[delta.id].url);

        if (!_downloads[delta.id].saveAs && 'complete' === delta.state.current) {
            browser.downloads.erase({
                id: delta.id,
            });
        }

        delete _downloads[delta.id];
    }
});

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

async function save(data, fileName = generateBackupFileName(), saveAs = true) { // data : Object/Array/Text
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
        let deltaId = await browser.downloads.download({
            filename: fileName,
            saveAs: saveAs,
            url: url,
        });

        _downloads[deltaId] = {url, saveAs};

        return true;
    } catch (e) {
        URL.revokeObjectURL(url);
        throw e;
    }
}

function generateBackupFileName() {
    let now = new Date(),
        day = ('0' + now.getDate()).substr(-2),
        month = ('0' + (now.getMonth() + 1)).substr(-2),
        year = now.getFullYear(),
        hours = now.getHours(),
        min = now.getMinutes();

    return `stg-backup-${year}-${month}-${day}-${hours}-${min}@drive4ik${BACKUP_FILE_EXT}`;
}

export {
    load,
    save,
};
