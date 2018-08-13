'use strict';

const BACKUP_FILE_EXT = '.json';

function importFromFile() {
    return new Promise(function(resolve, reject) {
        let fileInput = document.createElement('input');

        fileInput.type = 'file';
        fileInput.accept = BACKUP_FILE_EXT;
        fileInput.acceptCharset = 'utf-8';

        fileInput.initialValue = fileInput.value;
        fileInput.onchange = readFile;
        fileInput.click();

        function readFile() {
            if (fileInput.value !== fileInput.initialValue) {
                let file = fileInput.files[0];
                if (file.size > 100e6) {
                    reject('100MB backup? I don\'t believe you');
                    return;
                }

                let fReader = new FileReader();

                fReader.addEventListener('loadend', function(event) {
                    fileInput.remove();
                    try {
                        resolve(JSON.parse(event.target.result)); // resolve: parsed Object
                    } catch (e) {
                        reject(e);
                    }
                });

                fReader.addEventListener('error', function(event) {
                    fileInput.remove();
                    reject(event);
                });

                fReader.readAsText(file, 'utf-8');
            } else {
                fileInput.remove();
                reject();
            }
        }
    });
}

function exportToFile(data, fileName, type = 'application/json') { // data : Object/Array/Text
    let text = data,
        a = document.createElement('a');

    if ('string' !== typeof data) {
        text = JSON.stringify(data, null, '    ');
    }

    a.href = `data:${type};charset=utf-8,` + encodeURIComponent(text);
    a.setAttribute('download', fileName);
    a.setAttribute('type', type);
    a.dispatchEvent(new MouseEvent('click'));
}

function generateBackupFileName() {
    let today = new Date(),
        dd = ('0' + today.getDate()).substr(-2),
        mm = ('0' + (today.getMonth() + 1)).substr(-2),
        yyyy = today.getFullYear(),
        appName = browser.runtime.getManifest().applications.gecko.id.split('@').shift();

    return `${appName}-backup-${yyyy}-${mm}-${dd}${BACKUP_FILE_EXT}`;
}

export {
    importFromFile,
    exportToFile,
    generateBackupFileName,
};
