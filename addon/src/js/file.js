(function() {
    'use strict';

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
            body = utils.stringify(data, 4);
        }

        let blob = new Blob([body], {type}),
            url = URL.createObjectURL(blob);

        console.log('start save file', {fileName, saveAs, overwrite, clearOnComplete, tryCount});

        try {
            let id = await browser.downloads.download({
                filename: fileName,
                url: url,
                saveAs: saveAs,
                conflictAction: overwrite
                    ? browser.downloads.FilenameConflictAction.OVERWRITE
                    : browser.downloads.FilenameConflictAction.UNIQUIFY,
            });

            let {state, error} = await utils.waitDownload(id);

            if (!state) {
                state = browser.downloads.State.INTERRUPTED;
                error = `Download ID not found, id: ${id}`;
            }

            if (error) {
                error = `Error save file:\n${fileName}\nerror: ${error}`;
            }

            if (browser.downloads.State.COMPLETE === state) {
                if (clearOnComplete) {
                    await browser.downloads.erase({id});
                }
            } else if (browser.downloads.State.INTERRUPTED === state && !saveAs && tryCount < 5) {
                await browser.downloads.erase({id});
                URL.revokeObjectURL(url);
                return save(data, fileName, saveAs, overwrite, clearOnComplete, tryCount + 1);
            } else {
                throw error;
            }

            return id;
        } catch (e) {
            console.error(e);
            utils.notify(e);
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    async function backup(data, isAutoBackup, overwrite) {
        let fileName = generateBackupFileName(!overwrite);

        if (isAutoBackup) {
            let autoBackupFolderName = await getAutoBackupFolderName();
            fileName = autoBackupFolderName + '/' + fileName;
        }

        return save(data, fileName, !isAutoBackup, overwrite, isAutoBackup);
    }

    async function openBackupFolder() {
        let autoBackupFolderName = await getAutoBackupFolderName(),
            id = await save('temp file', autoBackupFolderName + '/tmp.tmp', false, true, false);

        await browser.downloads.show(id);
        await utils.wait(750);
        await browser.downloads.removeFile(id);
        await browser.downloads.erase({id});
    }

    async function getAutoBackupFolderName() {
        let {autoBackupFolderName} = await storage.get('autoBackupFolderName');

        if (
            !autoBackupFolderName.length ||
            /^STG\-backups\-FF\-[a-z\d\.]+$/.test(autoBackupFolderName) ||
            /^STG\-backups\-(win|linux|mac|openbsd)\-\d+$/.test(autoBackupFolderName)
        ) {
            let {version} = await browser.runtime.getBrowserInfo(),
                newAutoBackupFolderName = `STG-backups-FF-${version}`;

            if (autoBackupFolderName !== newAutoBackupFolderName) {
                autoBackupFolderName = newAutoBackupFolderName;

                await storage.set({autoBackupFolderName});
            }
        }

        return autoBackupFolderName;
    }

    function generateBackupFileName(withTime) {
        let now = new Date(),
            day = _intToStr(now.getDate()),
            month = _intToStr(now.getMonth() + 1),
            year = now.getFullYear(),
            hours = _intToStr(now.getHours()),
            min = _intToStr(now.getMinutes()),
            time = withTime ? `~${hours}-${min}` : '';

        return `stg-backup-${year}-${month}-${day}${time}@drive4ik.json`;
    }

    function _intToStr(i) {
        return ('0' + i).substr(-2);
    }

    window.file = {
        load,
        save,
        backup,
        openBackupFolder,
        getAutoBackupFolderName,
    };

})();
