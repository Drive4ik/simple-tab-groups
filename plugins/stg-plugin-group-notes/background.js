import Listeners from './listeners.js\
?onExtensionStart=[{"delay":100}]\
&runtime.onInstalled\
&runtime.onMessageExternal\
&menus.onClicked\
&permissions.onRemoved\
&alarms.onAlarm\
&storage.local.onChanged\
';
import * as Constants from './constants.js';
import * as MainConstants from './main-constants.js';
import * as Utils from './utils.js';
import * as MainUtils from './main-utils.js';
import * as Host from './host.js';
import * as File from './file.js';
import Notification from './notification.js';
import Lang from './lang.js';

Listeners.runtime.onMessageExternal(async (request, sender) => {
    if (sender.id !== Constants.STG_ID) {
        throw new Error('Only STG support');
    }

    const requestGroupKey = MainUtils.getGroupKey(request.groupId || request.group?.id);

    switch (request.action) {
        case 'i-am-back':
            init();
            break;
        case 'group-loaded':
            const {[requestGroupKey]: notes} = await browser.storage.local.get(requestGroupKey);
            MainUtils.setBadge(notes?.notes.trim().length, request.windowId);
            break;
        case 'group-unloaded':
            MainUtils.setBadge(false, request.windowId);
            break;
        case 'group-added':
            const restoredGroupNotes = await browser.storage.session.get(requestGroupKey);
            if (restoredGroupNotes[requestGroupKey]) {
                await browser.storage.local.set(restoredGroupNotes);
                MainUtils.setBadge(true, request.windowId);
            }
            break;
        case 'group-removed':
            MainUtils.setBadge(false, request.windowId);
            const removedGroupNotes = await browser.storage.local.get(requestGroupKey);
            if (removedGroupNotes[requestGroupKey]?.notes.trim().length) {
                browser.storage.session.set(removedGroupNotes);
            }
            browser.storage.local.remove(requestGroupKey);
            break;
        case 'get-backup':
            const backup = Object.assign({...MainConstants.defaultOptions}, await browser.storage.local.get());
            return {backup};
        case 'set-backup':
            await browser.storage.local.clear();
            const hasPermission = await Host.hasPermission();
            if ((!Constants.IS_WINDOWS || !hasPermission) && request.backup.autoBackupLocation === MainConstants.AUTO_BACKUP_LOCATIONS.HOST) {
                request.backup.autoBackupLocation = MainConstants.AUTO_BACKUP_LOCATIONS.DOWNLOADS;
            }
            await browser.storage.local.set(request.backup);
            browser.runtime.reload();
            break;
    }
});

Listeners.menus.onClicked(async info => {
    if (info.menuItemId === 'openInTab') {
        MainUtils.openInTab();
    } else if (info.menuItemId === 'openOptions') {
        browser.runtime.openOptionsPage();
    } else {
        throw Error(`unknown menu id: ${info.menuItemId}`);
    }
});

Listeners.permissions.onRemoved(async () => {
    await browser.storage.local.set({
        autoBackupLocation: MainConstants.AUTO_BACKUP_LOCATIONS.DOWNLOADS,
    });
});

Listeners.alarms.onAlarm(async ({name}) => {
    if (name === 'backup') {
        const settings = Object.assign({...MainConstants.defaultOptions}, await browser.storage.local.get());

        try {
            if (settings.autoBackupLocation === MainConstants.AUTO_BACKUP_LOCATIONS.HOST) {
                await Host.saveBackup(settings);
            } else {
                await File.saveBackup(settings, true);
            }

            localStorage.lastAutoBackupUnixTime = Utils.unixNow();
        } catch (e) {
            Notification(e);
        }
    }
});

Listeners.storage.local.onChanged(async changes => {
    if (changes.autoBackupEnable || changes.autoBackupIntervalKey || changes.autoBackupIntervalValue) {
        await resetBackupAlarm();
    }
});

async function resetBackupAlarm() {
    const settings = await browser.storage.local.get(MainConstants.defaultOptions);

    await Utils.resetAlarm(
        'backup',
        settings.autoBackupEnable,
        settings.autoBackupIntervalKey,
        settings.autoBackupIntervalValue,
        localStorage.lastAutoBackupUnixTime,
    );
}

async function init() {
    await resetBackupAlarm();

    const settings = Object.assign({...MainConstants.defaultOptions}, await browser.storage.local.get());

    if (settings.autoBackupLocation === MainConstants.AUTO_BACKUP_LOCATIONS.HOST) {
        if (Constants.IS_WINDOWS) {
            if (!await Host.hasPermission()) {
                Notification('checkBackupSettings', {action: 'open-options'});
            }
        } else {
            await browser.storage.local.set({
                autoBackupLocation: settings.autoBackupLocation = MainConstants.AUTO_BACKUP_LOCATIONS.DOWNLOADS,
            });
        }
    }

    const {groupsList} = await Utils.sendExternalMessage('get-groups-list');

    for (const group of groupsList) {
        const groupKey = MainUtils.getGroupKey(group.id);
        const hasNotes = settings[groupKey]?.notes.trim().length;

        MainUtils.setBadge(hasNotes, group.windowId);
    }
}

async function setup() {
    await browser.action.setBadgeBackgroundColor({
        color: 'transparent',
    });

    init().catch(() => {});

    await Utils.createMenu({
        id: 'openInTab',
        title: Lang('openInTab'),
        contexts: [browser.menus.ContextType.ACTION],
        icon: 'icons/icon.svg',
    });

    await Utils.createMenu({
        id: 'openOptions',
        title: Lang('openOptions'),
        contexts: [browser.menus.ContextType.ACTION],
        icon: 'icons/gear-solid.svg',
    });
}

Listeners.onExtensionStart(setup);

Listeners.runtime.onInstalled(async ({reason, previousVersion}) => {
    Listeners.onExtensionStart(null, {removeListener: true});

    if (reason === browser.runtime.OnInstalledReason.UPDATE) {
        const [major] = previousVersion.split('.');

        if (major == 1) {
            const oldStorage = await browser.storage.local.get();
            const newStorage = MainUtils.migrateStrorageToV2(oldStorage);

            await browser.storage.local.clear();
            await browser.storage.local.set(newStorage);
        }
    }

    setup();
});
