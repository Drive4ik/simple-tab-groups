(async function() {
    'use strict';

    const STG_ID = 'simple-tab-groups@drive4ik',
        STG_HOME_PAGE = 'https://addons.mozilla.org/firefox/addon/simple-tab-groups/';

    document.title = browser.i18n.getMessage('extensionName') + ' - ' + browser.i18n.getMessage('importBackup');
    document.getElementById('importBackupText').innerText = browser.i18n.getMessage('importBackup');

    let fileInput = document.getElementById('importBackupFile');
    fileInput.onchange = function() {
        new Promise(function(resolve, reject) {
                let file = fileInput.files[0];

                if (0 === file.size) {
                    reject('empty file');
                    return;
                }

                if (file.size > 700e6) {
                    reject('700MB backup? I don\'t believe you');
                    return;
                }

                let reader = new FileReader();

                reader.addEventListener('loadend', () => resolve(reader.result));
                reader.addEventListener('error', reject);

                reader.readAsText(file, 'utf-8');
            })
            .then(async function(result) {
                let backup = JSON.parse(result);

                if (Object.keys(backup).every(key => Number(key).toString() === key && backup[key].hasOwnProperty('notes'))) {
                    await browser.storage.local.set(backup);

                    let {id} = await browser.tabs.getCurrent();
                    await browser.tabs.remove(id);

                    browser.runtime.reload();
                } else {
                    throw Error('Invalid backup');
                }
            })
            .catch(alert);
    };

    browser.menus.create({
        id: 'openInTab',
        title: browser.i18n.getMessage('openInTab'),
        onclick: function() {
            browser.tabs.create({
                active: true,
                pinned: true,
                url: browser.runtime.getURL('popup/popup.html#tab'),
            });
        },
        contexts: ['browser_action'],
        icons: {
            16: '/icons/icon.svg',
        },
    });

    browser.menus.create({
        type: 'separator',
    });

    browser.menus.create({
        id: 'importBackup',
        title: browser.i18n.getMessage('importBackup'),
        onclick: function() {
            browser.tabs.create({
                url: window.location.href,
                active: true,
            });
        },
        contexts: ['browser_action'],
        icons: {
            16: '/icons/upload.svg',
        },
    });

    browser.menus.create({
        id: 'exportBackup',
        title: browser.i18n.getMessage('exportBackup'),
        onclick: async function() {
            let notes = await browser.storage.local.get(),
                notesStr = JSON.stringify(notes, null, 4),
                blob = new Blob([notesStr], {type: 'application/json'}),
                url = URL.createObjectURL(blob);

            try {
                let id = await browser.downloads.download({
                    filename: 'notes-backup-' + (new Date).toLocaleDateString().replace(/[\\/]/g, '-') + '.json',
                    url: url,
                    saveAs: true,
                });

                await waitDownload(id);
            } catch (e) {
                //
            } finally {
                URL.revokeObjectURL(url);
            }
        },
        contexts: ['browser_action'],
        icons: {
            16: '/icons/download.svg',
        },
    });

    async function waitDownload(id, maxWaitSec = 10) {
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

    function sendExternalMessage(data) {
        return new Promise(function(resolve, reject) {
            browser.runtime.sendMessage(STG_ID, data, function(responce) {
                if (responce && responce.ok) {
                    resolve(responce);
                } else {
                    reject(responce);
                }
            });
        });
    }

    function setBadge(show, windowId) {
        windowId && browser.browserAction.setBadgeText({
            text: show ? '⭐️' : '',
            windowId,
        });
    }

    async function init() {
        let {groupsList} = await sendExternalMessage({
                action: 'get-groups-list',
            }),
            notes = await browser.storage.local.get(null);

        groupsList.forEach(function({id, windowId}) {
            if (windowId && notes[id]?.notes.trim()) {
                setBadge(true, windowId);
            }
        });
    }

    init();

    browser.runtime.onMessageExternal.addListener(async function(request, sender) {
        if (sender.id !== STG_ID) {
            return;
        }

        switch (request.action) {
            case 'i-am-back':
                init();
                sendExternalMessage({
                    action: 'ignore-ext-for-reopen-container',
                });
                break;
            case 'group-loaded':
                let {[request.groupId]: notes} = await browser.storage.local.get(String(request.groupId));

                setBadge(notes?.notes?.trim(), request.windowId);
                break;
            case 'group-unloaded':
                setBadge(false, request.windowId);
                break;
            case 'group-removed':
                setBadge(false, request.windowId);
                browser.storage.local.remove(`${request.groupId}`);
                break;
        }
    });

    browser.browserAction.setBadgeBackgroundColor({
        color: 'transparent',
    });

    sendExternalMessage({
        action: 'ignore-ext-for-reopen-container',
    });

    window.STG_ID = STG_ID;
    window.STG_HOME_PAGE = STG_HOME_PAGE;
    window.sendExternalMessage = sendExternalMessage;
    window.setBadge = setBadge;

})()
