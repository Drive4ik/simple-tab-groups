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

function exportToFile(data, fileName = generateFileName()) { // data : Object
    let text = JSON.stringify(data, null, '    '),
        a = document.createElement('a');

    a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
    a.setAttribute('download', fileName);
    a.setAttribute('type', 'application/json');
    a.dispatchEvent(new MouseEvent('click'));
}

function generateFileName() {
    let today = new Date(),
        dd = ('0' + today.getDate()).substr(-2),
        mm = ('0' + (today.getMonth() + 1)).substr(-2),
        yyyy = today.getFullYear();

    return `simple-tab-groups-backup-${yyyy}-${mm}-${dd}${BACKUP_FILE_EXT}`;
}

export {
    importFromFile,
    exportToFile,
};
