import Listeners from '/js/listeners.js?extension.onStart';
import '/js/prefixed-storage.js';
import * as Constants from '/js/constants.js';
import * as Containers from '/js/containers.js';
import * as Tabs from '/js/tabs.js';
import * as Groups from '/js/groups.js';
import * as Extensions from '/js/extensions.js';
import * as Utils from '/js/utils.js';
import Lang from '/js/lang.js';
import JSON from '/js/json.js';
import Logger, {nativeErrorToObject, objectToNativeError} from '/js/logger.js';
import {createCloudProvider} from './provider.js';
import * as CloudBroadcast from '/js/broadcast.js?channel=cloud';
import * as SyncStorage from '../sync-storage.js';
import {isReservedFileName} from '../delta/layout.js';
import * as Storage from '/js/storage.js';
import Migration from '/js/migration.js';
import backgroundSelf from '/js/background.js';
// export {
//     default as GithubGist,
// } from './githubgist.js';

export {on, off} from '/js/broadcast.js?channel=cloud';

const logger = new Logger(Constants.MODULES.CLOUD);

const storage = localStorage.create(Constants.MODULES.CLOUD);
const syncStorage = storage.create('sync');
const mainStorage = localStorage.create(Constants.MODULES.BACKGROUND);
const params = new URL(import.meta.url).searchParams;
const canDoSynchronization = params.has('can-do-synchronization');

export const TRUST_LOCAL = 'trust-local';
export const TRUST_CLOUD = 'trust-cloud';

export const ALARM_NAME = 'cloud';
export const ALARM_NAME_RETRY = 'cloud-retry';
export const ERROR_NOTIFICATION_ID = 'cloud-error';

export const TRIGGER_MANUAL = 'cloud-trigger-manual';
export const TRIGGER_AUTO = 'cloud-trigger-auto';
export const TRIGGER_RETRY = 'cloud-trigger-retry';

export const NETWORK_RETRY_DELAY_MINUTES = 3;
const MAX_NETWORK_RETRY_ATTEMPTS = 3;
const MAX_RATE_LIMIT_BACKOFF_MINUTES = 65;

let inProgress = false;

Listeners.extension.onStart.add(() => syncStorage.clear());

// ! Be careful: "instanceof" doesn't work in different contexts (cloud.js?can-do-synchronization)
export class CloudError extends Error {
    constructor(langId, ...args) {
        logger.error('CloudError:', langId);

        let message;

        if (langId.startsWith('githubRateLimit')) {
            const relativeTime = Utils.relativeTime(Number(langId.split(':').pop()));
            message = Lang(['githubRateLimit', relativeTime]);
        } else if (langId.startsWith('githubContentsTooLarge')) {
            const size = Utils.formatBytes(Number(langId.split(':').pop()), 0);
            message = Lang(['githubContentsTooLarge', size]);
        } else {
            message = Lang(langId) || langId;
        }

        super(message, ...args);

        this.langId = langId === message ? null : langId;
        this.name = 'CloudError';
    }
}

export function send(action, data = {}) {
    CloudBroadcast.send({action, ...data});
}

export async function synchronization(trust = null, revision = null, {useBackupFile = false} = {}) {
    if (!canDoSynchronization) {
        throw new Error('synchronization is not available in this context');
    }

    const syncResult = {
        ok: false,
    };

    if (inProgress) {
        syncResult.inProgress = true;
        return syncResult;
    }

    const log = logger.start(synchronization, {trust, revision: revision?.slice(0, 7) ?? null});

    let lastProgress = 0;

    try {
        inProgress = true;

        send('sync-start');

        const syncRes = await sync(trust, revision, progress => {
            lastProgress = progress;
            log.log('progress', progress);
            send('sync-progress', {progress});
        }, useBackupFile);

        syncResult.ok = true;
        syncResult.progress = 100;
        Object.assign(syncResult, syncRes);

        send('sync-end', syncResult);

        log.stop();
    } catch (e) {
        syncResult.langId = e.langId;
        syncResult.progress = lastProgress;
        Object.assign(syncResult, nativeErrorToObject(e));

        send('sync-error', syncResult);

        log.logError('cant sync', e);
        log.stopError();
    } finally {
        inProgress = false;
        send('sync-finish', syncResult);
    }

    return syncResult;
}

async function sync(trust = null, revision = null, progressFunc = null, useBackupFile = false) {
    const isRestoring = !!revision;

    if (isRestoring) {
        trust = TRUST_CLOUD;
    }

    const log = logger.start('sync', {trust, isRestoring});

    if (trust && trust !== TRUST_LOCAL && trust !== TRUST_CLOUD) {
        log.throwError('unknown source of trust argument');
    }

    const {syncOptionsLocation, syncProvider} = await Storage.get(['syncOptionsLocation', 'syncProvider']);

    if (syncOptionsLocation === Constants.SYNC_STORAGE_FSYNC) {
        if (!SyncStorage.IS_AVAILABLE) {
            const error = new CloudError('ffSyncNotSupported');
            storage.lastError = String(error);
            log.throwError('sync not supported', error);
        }
    }

    progressFunc?.(1);

    const syncOptions = syncOptionsLocation === Constants.SYNC_STORAGE_FSYNC
        ? await SyncStorage.get()
        : await Storage.get(null, Constants.DEFAULT_SYNC_OPTIONS);

    progressFunc?.(10);

    let cloudInstance;

    if (useBackupFile && isReservedFileName(syncOptions.githubGistBackupFileName)) {
        const error = new CloudError('githubBackupFileNameReserved');
        storage.lastError = String(error);
        log.throwError('reserved backup file name', error);
    }

    const providerOptions = useBackupFile
        ? {...syncOptions, githubGistFileName: syncOptions.githubGistBackupFileName}
        : syncOptions;

    try {
        cloudInstance = createCloudProvider(syncProvider, providerOptions);
    } catch (error) {
        const cloudError = new CloudError(error.message, {cause: error});
        storage.lastError = String(cloudError);
        log.throwError('create cloud provider instance', cloudError);
    }

    const Cloud = cloudInstance;

    let lastProgressPercent = 0;
    const createCloudProgress = function(currentProgress, progressDuration) {
        return fetchProgress => {
            const durationPart = (progressDuration - currentProgress) / 100;
            const mainPercent = currentProgress + Math.floor(fetchProgress * durationPart);

            if (lastProgressPercent !== mainPercent) {
                lastProgressPercent = mainPercent;
                progressFunc?.(mainPercent);
            }
        };
    };

    let cloudData, cloudInfo;

    try {
        [cloudData, cloudInfo] = await Cloud.getContent(revision, true, createCloudProgress(10, 40));
    } catch (error) {
        if (error.message === 'githubNotFound') {
            //
        } else {
            const cloudError = new CloudError(error.message, {cause: error});
            storage.lastError = String(cloudError);
            log.throwError('get cloud content', cloudError);
        }
    }

    progressFunc?.(40);

    const localData = await Promise.all([Storage.get(), Groups.loadWithArchivedTabs(null, true)])
        .then(([data, {groups}]) => {
            data.groups = groups;
            data.containers = Containers.getToExport(data);
            // map cookie-store-id to Firefox browser
            Containers.mapDefaultContainer(data, Constants.DEFAULT_COOKIE_STORE_ID_FIREFOX);
            return data;
        });

    progressFunc?.(45);

    const localLastUpdate = new Date(localData.syncLastUpdate).getTime();
    const cloudLastUpdate = new Date(cloudInfo?.lastUpdate ?? 0).getTime();

    const sourceOfTruth =
        trust
        ? trust
        : cloudLastUpdate > localLastUpdate ? TRUST_CLOUD : TRUST_LOCAL;

    log.info('sourceOfTruth:', sourceOfTruth);

    const hasCloudData = Boolean(cloudData);

    cloudData ??= JSON.clone(localData);

    localData.syncId = localLastUpdate;
    cloudData.syncId = cloudLastUpdate;

    const syncResult = await syncData(localData, cloudData, sourceOfTruth, createCloudProgress(45, 55))
        .catch(log.onCatch('cant sync'));

    delete syncResult.localData.syncId;
    delete syncResult.cloudData.syncId;

    // log.log('changes1', {
    //     hasCloudData,
    //     local: syncResult.changes.local,
    //     cloud: syncResult.changes.cloud,

    //     localUpdate: localData.syncLastUpdate,
    //     cloudUpdate: cloudInfo.lastUpdate,
    // });

    if (!hasCloudData || isRestoring) {
        syncResult.changes.cloud = true;
    }

    progressFunc?.(55);

    if (syncResult.changes.cloud) {
        try {
            cloudInfo = await Cloud.setContent(syncResult.cloudData, createCloudProgress(55, 85));
        } catch (error) {
            const cloudError = new CloudError(error.message, {cause: error});
            storage.lastError = String(cloudError);
            log.throwError('set cloud content', cloudError);
        }

        syncResult.changes.local = true; // sync date must be equal in cloud and local
    }

    progressFunc?.(85);

    for (const groupToRemove of syncResult.changes.groupsToRemove) {
        syncResult.changes.local = true;

        if (Groups.isLoaded(groupToRemove.id) && !groupToRemove.isArchive) {
            for (const tabToRemove of groupToRemove.tabs) {
                syncResult.changes.tabsToRemove.add(tabToRemove);
            }
        }
    }

    progressFunc?.(90);

    // set last-update before call saveOptions, saveOptions will reset alarm and it depends on last-update time
    storage.githubGistFileName = syncOptions.githubGistFileName;
    mainStorage.autoSyncLastTimeStamp = Utils.unixNow();

    if (syncResult.changes.local) {
        // map cookie-store-id to gecko browser
        Containers.mapDefaultContainer(syncResult.localData, Constants.DEFAULT_COOKIE_STORE_ID);

        // sync changes with current profile
        for (const group of syncResult.localData.groups) {
            if (group.isArchive) {
                continue;
            }

            const tabsToCreate = group.tabs.filter(tab => tab.new);

            if (!tabsToCreate.length) {
                continue;
            }

            const groupWindowId = group.tabs.find(tab => !tab.new)?.windowId;

            for (const tabToCreate of tabsToCreate) {
                tabToCreate.groupId = group.id;
                tabToCreate.windowId = groupWindowId;
            }

            const newTabs = await Tabs.createMultiple(tabsToCreate, true);

            // filter(Boolean): if some tabs weren't created (due to invalid url) - remove them from group.tabs
            group.tabs = group.tabs.map(tab => tab.new ? newTabs.shift() : tab).filter(Boolean);

            // sorting tabs
            const firstTabIndex = group.tabs[0]?.index;
            if (Number.isFinite(firstTabIndex)) {
                group.tabs = await Tabs.moveNative(group.tabs, {index: firstTabIndex}, true);
            }

            if (!Groups.isLoaded(group.id)) {
                await Tabs.hide(group.tabs, true);
            }
        }

        syncResult.localData.syncLastUpdate = cloudInfo.lastUpdate;

        await backgroundSelf.saveOptions(syncResult.localData);
        await Groups.save(syncResult.localData.groups);
    }

    progressFunc?.(95);

    for (const groupToRemove of syncResult.changes.groupsToRemove) {
        if (Groups.isLoaded(groupToRemove.id)) {
            // remove group from windows
            await Groups.unload(groupToRemove.id);
        }
    }

    // remove unnecessary tabs
    if (syncResult.changes.tabsToRemove.size) {
        // if has local changes - do silent remove. "Cloud.sync-end" event will trigger "Groups.updated.all" event and reload all groups with tabs
        await Tabs.remove(Array.from(syncResult.changes.tabsToRemove), syncResult.changes.local);
    }

    progressFunc?.(100);

    log.stop();

    delete storage.lastError;

    delete syncResult.localData;
    delete syncResult.cloudData;

    return syncResult;
}

async function syncData(localData, cloudData, sourceOfTruth, progressFunc = null) {
    const log = logger.start('syncData', {
        localVersion: localData.version,
        cloudVersion: cloudData.version,
    });

    progressFunc?.(0);

    const resultMigrate = await Migration(cloudData);

    progressFunc?.(10);

    if (resultMigrate.migrated) {
        cloudData = resultMigrate.data;
    } else if (resultMigrate.error) {
        const error = new CloudError(resultMigrate.error);
        storage.lastError = String(error);
        log.throwError('migrate data', error);
    }

    const changes = {
        groupsToRemove: new Set,
        tabsToRemove: new Set,
        local: false,
        cloud: false,
    };

    await mapContainers(localData, cloudData);

    await syncOptions(localData, cloudData, sourceOfTruth, changes);

    progressFunc?.(30);

    await syncGroups(localData, cloudData, sourceOfTruth, changes);

    progressFunc?.(70);

    await syncContainers(localData, cloudData);

    cloudData = JSON.clone(cloudData);

    progressFunc?.(100);

    // log.stop('localData:', localData, 'cloudData:', cloudData);
    log.stop();

    return {
        localData,
        cloudData,
        changes,
        sourceOfTruth,
    };
}

async function syncGroups(localData, cloudData, sourceOfTruth, changes) {
    const log = logger.start('syncGroups');

    const localGroups = localData.groups;
    const cloudGroups = cloudData.groups;

    const resultLocalGroups = [];
    const resultCloudGroups = [];

    for (const group of localGroups) {
        if (!group.isArchive) {
            Extensions.tabsToId(group.tabs);
        }
    }

    const isAvailableFavIconToSync = favIconUrl => favIconUrl?.startsWith('data:');

    const favIconUrlsMap = new Map;
    for (const tab of Utils.flatTabs([...localGroups, ...cloudGroups])) {
        if (isAvailableFavIconToSync(tab.favIconUrl)) {
            favIconUrlsMap.set(tab.url, tab.favIconUrl);
        }
    }

    const hasSomeTreeTabsExtension = Extensions.hasTreeTabs();

    function prepareForSaveTabs(tabs, prepareFor, groupIsArchive) {
        if (prepareFor !== TRUST_LOCAL && prepareFor !== TRUST_CLOUD) throw new Error('invalid "prepareFor" argument');

        // local syncTabFavIcons have already been synchronized and it's equal to cloud
        const includeFavIconUrl = localData.syncTabFavIcons;

        if (prepareFor === TRUST_CLOUD && includeFavIconUrl) {
            for (const tab of tabs) {
                if (!isAvailableFavIconToSync(tab.favIconUrl)) {
                    tab.favIconUrl = null;
                }

                tab.favIconUrl ??= favIconUrlsMap.get(tab.url);
            }
        }

        const includeId = hasSomeTreeTabsExtension;
        const includeLastAccessed = prepareFor === TRUST_LOCAL || groupIsArchive === true;

        return Tabs.prepareForSave(tabs, false, includeFavIconUrl, false, includeId, includeLastAccessed);
    }

    if (sourceOfTruth === TRUST_LOCAL) {
        for (const localGroup of localGroups) {
            const resultLocalGroup = localGroup;
            const resultCloudGroup = {...localGroup}; // unlink tabs key

            if (resultLocalGroup.dontUploadToCloud) {
                resultLocalGroups.push(resultLocalGroup);
            } else {
                resultCloudGroup.tabs = prepareForSaveTabs(resultLocalGroup.tabs, TRUST_CLOUD, resultCloudGroup.isArchive);

                resultLocalGroups.push(resultLocalGroup);
                resultCloudGroups.push(resultCloudGroup);
            }
        }

        if (!changes.cloud) {
            changes.cloud = resultCloudGroups.length !== cloudGroups.length;
        }

        if (!changes.cloud) {
            changes.cloud = stringifyGroupsForChangeDetection(resultCloudGroups) !== stringifyGroupsForChangeDetection(cloudGroups);
        }

    } else if (sourceOfTruth === TRUST_CLOUD) {

        const isFirstLocalSync = localData.syncId === new Date(Constants.DEFAULT_OPTIONS.syncLastUpdate).getTime();

        for (const cloudGroup of cloudGroups) {
            // find local group
            let localGroup = localGroups.find(localGroup => localGroup.id === cloudGroup.id);

            if (localGroup?.dontUploadToCloud) {
                // leave local and cloud groups without changes
                resultLocalGroups.push(localGroup);
                resultCloudGroups.push(cloudGroup);
                continue;
            }

            // if not found, create it
            if (!localGroup) {
                changes.local = true;

                log.log('create/clone new local group from cloud:', cloudGroup.id);

                localGroup = JSON.clone(cloudGroup);

                if (!localGroup.isArchive) {
                    localGroup.tabs.forEach(localTab => localTab.new = true);
                }

                resultLocalGroups.push(localGroup);
                resultCloudGroups.push(cloudGroup);
                continue;
            }

            // if local group exist in cloud

            const resultLocalGroup = localGroup;
            const resultCloudGroup = cloudGroup;

            log.log('sync cloud group:', resultCloudGroup.id);
            log.log('group archive state local:', resultLocalGroup.isArchive, 'cloud:', resultCloudGroup.isArchive);

            function findEqualLocalTab(cloudTab, excludeTabs = []) {
                const cloudCookieStoreId = cloudTab.cookieStoreId || Constants.DEFAULT_COOKIE_STORE_ID;

                const localTab = resultLocalGroup.tabs.find(localTab => {
                    if (excludeTabs.includes(localTab)) {
                        return false;
                    }

                    if (localTab.url !== cloudTab.url) { // url should be normalized
                        return false;
                    }

                    const localCookieStoreId = localTab.cookieStoreId || Constants.DEFAULT_COOKIE_STORE_ID;

                    if (localCookieStoreId !== cloudCookieStoreId) {
                        return false;
                    }

                    return true;
                });

                return [localTab, resultLocalGroup.tabs.indexOf(localTab)];
            }

            function syncTabs(prepareFoundLocalTabFunc, eachNotPreparedLocalTabFunc) {
                const resultLocalTabs = [];
                const resultCloudTabs = resultCloudGroup.tabs;

                resultCloudGroup.tabs.forEach((cloudTab, cloudIndex) => {
                    const [localTab, localIndex] = findEqualLocalTab(cloudTab, resultLocalTabs);

                    const preparedLocalTab = prepareFoundLocalTabFunc(localTab, cloudTab, localIndex, cloudIndex);

                    resultLocalTabs.push(preparedLocalTab);
                });

                let offset = 0;

                resultLocalGroup.tabs.forEach((localTab, localTabIndex) => {
                    // skip tabs that remain locally
                    // or if tab is new from cloud
                    if (resultLocalTabs.includes(localTab)) {
                        return;
                    }

                    const addOffset = eachNotPreparedLocalTabFunc(localTab, localTabIndex + offset, resultLocalTabs, resultCloudTabs);

                    if (addOffset === true) {
                        offset++;
                    } else if (addOffset === false) {
                        offset--;
                    }
                });

                resultLocalGroup.tabs = resultLocalTabs;
                resultCloudGroup.tabs = resultCloudTabs;
            }

            /*
            если lastAccessed у вкладки меньше чем cloudData.syncId - тогда удаляем эти вкладки,
            если больше оставляем их. будет проблема с активной вкладкой, её lastAccessed всегда текущее время, поэтому оставляем её, синкаем как новую вкладку. если пользователь захочет узалить её из облака вообще - удаляет локально и тут же нажимает синк. на другом компе её уже нет, и удалять нечего.
            */

            // sync tabs:
            if (resultCloudGroup.isArchive !== resultLocalGroup.isArchive) {
                // changes.local = true; // set when sync group keys

                if (resultCloudGroup.isArchive) { // make local group an archive
                    // remove all local tabs, because group makes an archive
                    resultLocalGroup.tabs.forEach(tabToRemove => changes.tabsToRemove.add(tabToRemove));
                }

                syncTabs(
                    (localTab, cloudTab) => {
                        return localTab ?? cloudTab;
                    },
                    (localTab, localTabIndex, resultLocalTabs, resultCloudTabs) => {
                        // if first time sync archive group (I didn't save lastAccessed key in archived group before)
                        localTab.lastAccessed ??= cloudData.syncId + 1;

                        if (localTab.lastAccessed > cloudData.syncId) {
                            // если вкладка имеет последний доступ больше чем последний syncId облака
                            // значит вкладку открывали после синка, а значит она нужна, иначе удаляем её

                            resultLocalTabs.splice(localTabIndex, 0, localTab);
                            resultCloudTabs.splice(localTabIndex, 0, localTab);

                            changes.cloud = true;
                            return true;
                        }
                    }
                );

                resultLocalGroup.tabs = prepareForSaveTabs(resultLocalGroup.tabs, TRUST_LOCAL, resultLocalGroup.isArchive);
                resultCloudGroup.tabs = prepareForSaveTabs(resultCloudGroup.tabs, TRUST_CLOUD, resultCloudGroup.isArchive);

                if (resultLocalGroup.isArchive) { // UN archive local group
                    resultLocalGroup.tabs.forEach(tab => tab.new = true);
                }

            } else if (resultCloudGroup.isArchive && resultLocalGroup.isArchive) {

                syncTabs(
                    (localTab, cloudTab, localIndex, cloudIndex) => {
                        if (localIndex !== cloudIndex) {
                            changes.local = true;
                        }

                        return localTab ?? {...cloudTab};
                    },
                    (localTab, localTabIndex, resultLocalTabs, resultCloudTabs) => {
                        // if first time sync archive group (I didn't save lastAccessed key in archived group before)
                        localTab.lastAccessed ??= cloudData.syncId + 1;

                        if (localTab.lastAccessed > cloudData.syncId) {
                            resultLocalTabs.splice(localTabIndex, 0, localTab);

                            const [cloudTab] = prepareForSaveTabs([localTab], TRUST_CLOUD, resultCloudGroup.isArchive);
                            resultCloudTabs.splice(localTabIndex, 0, cloudTab);

                            changes.cloud = true;
                            return true;
                        }
                    }
                );

            } else if (!resultCloudGroup.isArchive && !resultLocalGroup.isArchive) {

                syncTabs(
                    (localTab, cloudTab, localIndex, cloudIndex) => {
                        if (!localTab) {
                            localTab = {...cloudTab, new: true};
                            changes.local = true;
                        } else if (localIndex !== cloudIndex) {
                            changes.local = true;
                        }

                        return localTab;
                    },
                    (localTab, localTabIndex, resultLocalTabs, resultCloudTabs) => {
                        if (localTab.lastAccessed > cloudData.syncId) {
                            resultLocalTabs.splice(localTabIndex, 0, localTab);

                            const [cloudTab] = prepareForSaveTabs([localTab], TRUST_CLOUD, resultCloudGroup.isArchive);
                            resultCloudTabs.splice(localTabIndex, 0, cloudTab);

                            changes.cloud = true;
                            return true;
                        } else {
                            // delete old tab, which doesn't exist in cloud, that means it was deleted into another computer
                            changes.tabsToRemove.add(localTab);
                            changes.local = true;
                            return false;
                        }
                    }
                );
            }

            // assign group keys
            assignGroupKeys(resultLocalGroup, resultCloudGroup, sourceOfTruth, changes);

            resultLocalGroups.push(resultLocalGroup);
            resultCloudGroups.push(resultCloudGroup);
        }

        for (const [localIndex, localGroup] of localGroups.entries()) {
            const localGroupProcessed = resultLocalGroups.some(group => group.id === localGroup.id);

            if (localGroupProcessed) {
                continue;
            }

            // localGroup is not in the cloud

            if (localGroup.dontUploadToCloud) {
                log.log('skip upload local group to cloud:', localGroup.id);

                // changes.local = true;
                resultLocalGroups.splice(localIndex, 0, localGroup); // leave group in local and don't add it to the cloud
                // resultLocalGroups.push(localGroup); // leave group in local and don't add it to the cloud
            } else if (isFirstLocalSync) {
                // don't remove group because it must be synced with another computer
                log.log('add local group to cloud:', localGroup.id);

                const cloudGroup = JSON.clone(localGroup);
                cloudGroup.tabs = prepareForSaveTabs(localGroup.tabs, TRUST_CLOUD, cloudGroup.isArchive);

                // changes.local = true;
                resultLocalGroups.push(localGroup);
                resultCloudGroups.push(cloudGroup);
            } else {
                // local group is skipped and deleted...
                log.log('remove local group:', localGroup.id);

                changes.groupsToRemove.add(localGroup);
                changes.local = true;
            }
        }
    }

    for (const group of resultLocalGroups) {
        if (!group.isArchive) {
            Extensions.tabsToUUID(group.tabs);
        }
    }

    localData.groups = resultLocalGroups;
    cloudData.groups = resultCloudGroups;

    log.stop();
}

function assignGroupKeys(localGroup, cloudGroup, sourceOfTruth, changes) {
    const isDefaultGroup = !localGroup.tabs && !cloudGroup.tabs;

    const log = logger.start('assignGroupKeys', {isDefaultGroup});

    const EXCLUDE_GROUP_KEYS = [
        'tabs',
    ];

    // because we also need to be able to compare "defaultGroupProps"
    const allGroupKeys = [...Object.keys(localGroup), ...Object.keys(cloudGroup)].filter(Utils.onlyUniqueFilter);

    for (const key of allGroupKeys) {
        if (EXCLUDE_GROUP_KEYS.includes(key)) {
            continue;
        }

        // sorting for equal json stringify value
        const localValue = Array.isArray(localGroup[key]) ? localGroup[key].slice().sort() : localGroup[key];
        const cloudValue = Array.isArray(cloudGroup[key]) ? cloudGroup[key].slice().sort() : cloudGroup[key];

        if (isEqual(localValue, cloudValue)) {
            continue;
        }

        if (sourceOfTruth === TRUST_LOCAL) {
            changes.cloud = true;

            if (isDefaultGroup) {
                if (localValue === undefined) {
                    delete cloudGroup[key];
                } else {
                    cloudGroup[key] = localValue;
                }
            } else {
                cloudGroup[key] = localValue;
            }

            log.log('cloud group key changed:', key);
        } else if (sourceOfTruth === TRUST_CLOUD) {
            changes.local = true;

            if (isDefaultGroup) {
                if (cloudValue === undefined) {
                    delete localGroup[key];
                } else {
                    localGroup[key] = cloudValue;
                }
            } else {
                localGroup[key] = cloudValue;
            }

            log.log('local group key changed:', key);
        }
    }

    log.stop();
}

async function syncOptions(localData, cloudData, sourceOfTruth, changes) {
    const log = logger.start('syncOptions');

    const EXCLUDE_OPTION_KEY_STARTS_WITH = [
        'defaultGroupProps',
        'autoBackup',
        'sync',
    ];

    for (const key of Constants.ALL_OPTION_KEYS) {
        if (EXCLUDE_OPTION_KEY_STARTS_WITH.some(exKey => key.startsWith(exKey))) {
            continue;
        }

        // this code below used for "number", "strings", "array" option values,
        // and can be used for object values without any changes
        const jsonLocalValue = JSON.stringify(localData[key]);
        const jsonCloudValue = JSON.stringify(cloudData[key]);

        if (jsonLocalValue === undefined || jsonCloudValue === undefined) {
            if (jsonLocalValue === undefined) {
                log.warn(`local options key "${key}" is undefined. creating it.`);

                if (sourceOfTruth === TRUST_LOCAL || jsonCloudValue === undefined) {
                    localData[key] = JSON.clone(Constants.DEFAULT_OPTIONS[key]);
                } else {
                    localData[key] = JSON.parse(jsonCloudValue);
                }

                changes.local = true;
            }

            if (jsonCloudValue === undefined) {
                log.warn(`cloud options key "${key}" is undefined. creating it.`);

                if (sourceOfTruth === TRUST_CLOUD || jsonLocalValue === undefined) {
                    cloudData[key] = JSON.clone(Constants.DEFAULT_OPTIONS[key]);
                } else {
                    cloudData[key] = JSON.parse(jsonLocalValue);
                }

                changes.cloud = true;
            }

            continue;
        }

        if (jsonLocalValue !== jsonCloudValue) {
            if (sourceOfTruth === TRUST_LOCAL) {
                cloudData[key] = JSON.parse(jsonLocalValue);
                changes.cloud = true;
                log.log('cloud has changed options key:', key);
            } else if (sourceOfTruth === TRUST_CLOUD) {
                localData[key] = JSON.parse(jsonCloudValue);
                changes.local = true;
                log.log('local has changed options key:', key);
            }
        }
    }

    assignGroupKeys(localData.defaultGroupProps, cloudData.defaultGroupProps, sourceOfTruth, changes);

    log.stop();
}

async function syncContainers(localData, cloudData) {
    // unmap cookie store values to id
    const localUnMap = new Map([...localData.containers.map].map(e => e.reverse()));
    const cloudUnMap = new Map([...cloudData.containers.map].map(e => e.reverse()));

    // make Businesscircle#red => firefox-container-1
    await mapDataContainers(localData, async mappedCookieStoreId => {
        // if not found in local unmap, than it's cloud new container
        // create it localy, and save to maps

        const cloudCookieStoreId = cloudUnMap.get(mappedCookieStoreId);

        const newContainer = await Containers.create({
            name: cloudData.containers[cloudCookieStoreId].name,
            color: cloudData.containers[cloudCookieStoreId].color,
            icon: cloudData.containers[cloudCookieStoreId].icon,
        });

        // don't forget add to real local map
        localData.containers[newContainer.cookieStoreId] = newContainer;
        localData.containers.map.set(newContainer.cookieStoreId, stringifyContainer(newContainer));

        return newContainer.cookieStoreId;
    }, localUnMap);


    let containerIndex = 1;
    cloudData.containers = {}; // no need old cloud map

    // make Businesscircle#red => cloud-container-1
    await mapDataContainers(cloudData, mappedCookieStoreId => {
        const localCookieStoreId = localUnMap.get(mappedCookieStoreId);

        // don't save temp containers
        if (Containers.isTemporary(localCookieStoreId)) {
            return Constants.TEMPORARY_CONTAINER;
        }

        // create new ids to avoid similarity with local ids
        const cloudCookieStoreId = 'cloud-container-' + containerIndex++;

        cloudData.containers[cloudCookieStoreId] = {
            ...localData.containers[localCookieStoreId],
            cookieStoreId: cloudCookieStoreId,
        };

        return cloudCookieStoreId;
    });

    // delete the reference to the containers so we don't accidentally save them
    delete localData.containers;
}

// make firefox-container-1 => Businesscircle#red
async function mapContainers(localData, cloudData) {
    localData.containers ??= {};
    localData.containers.map = new Map;

    // fill local containers map
    for (const [cookieStoreId, container] of Object.entries(Containers.query({temporaryContainers: true}))) {
        if (Containers.isTemporary(cookieStoreId)) {
            localData.containers.map.set(cookieStoreId, Constants.TEMPORARY_CONTAINER);
        } else {
            localData.containers[cookieStoreId] = container;
            localData.containers.map.set(cookieStoreId, stringifyContainer(container));
        }
    }

    // no need map func, it is never be called
    await mapDataContainers(localData, null, localData.containers.map);


    // cloud
    cloudData.containers ??= {};
    cloudData.containers.map = new Map;

    await mapDataContainers(cloudData, cookieStoreId => {
        return stringifyContainer(cloudData.containers[cookieStoreId]);
    }, cloudData.containers.map);
}

function stringifyContainer({name, color, icon}) {
    return [name, color, icon].join('');
}

async function mapDataContainers(data, joinSplitFunc, containersMap = new Map) {
    containersMap.set(Constants.DEFAULT_COOKIE_STORE_ID, Constants.DEFAULT_COOKIE_STORE_ID);
    containersMap.set(Constants.TEMPORARY_CONTAINER, Constants.TEMPORARY_CONTAINER);

    for (const group of [...data.groups, data.defaultGroupProps]) {
        await eachGroupContainerKeyMap(group, async cookieStoreId => {
            if (!containersMap.has(cookieStoreId)) {
                containersMap.set(cookieStoreId, await joinSplitFunc(cookieStoreId));
            }

            return containersMap.get(cookieStoreId);
        });
    }
}

async function eachGroupContainerKeyMap(group, asyncMapFunc) {
    const GROUP_CONTAINER_KEYS = [
        'newTabContainer',
        'excludeContainersForReOpen',
        'catchTabContainers',
    ];

    for (const containerKey of GROUP_CONTAINER_KEYS) {
        if (group.hasOwnProperty(containerKey)) {
            const result = [];

            for (const cookieStoreId of [group[containerKey]].flat()) {
                result.push(await asyncMapFunc(cookieStoreId, containerKey));
            }

            group[containerKey] = Array.isArray(group[containerKey]) ? result : result[0];
        }
    }

    if (group.tabs) {
        for (const tab of group.tabs) {
            if (tab.cookieStoreId) {
                tab.cookieStoreId = await asyncMapFunc(tab.cookieStoreId, 'cookieStoreId');
            }
        }
    }
}

function isEqual(value1, value2) {
    return JSON.stringify(value1) === JSON.stringify(value2);
}

const CHANGE_DETECTION_IGNORE_TAB_KEYS = ['uid', 'lastModified'];

function stringifyGroupsForChangeDetection(groups) {
    const stripped = groups.map(group => {
        if (!Array.isArray(group.tabs)) {
            return group;
        }

        return {
            ...group,
            tabs: group.tabs.map(tab => {
                const cleanTab = {...tab};
                CHANGE_DETECTION_IGNORE_TAB_KEYS.forEach(key => delete cleanTab[key]);
                return cleanTab;
            }),
        };
    });

    return JSON.stringify(stripped);
}

// alarm utils
function isNetworkError(error) {
    const message = String(error);

    const NETWORK_ERROR_PARTS = [
        'NetworkError',
        'NS_ERROR_NET_',
    ];

    const isNetErr = NETWORK_ERROR_PARTS.some(part => message.includes(part));

    if (isNetErr) {
        logger.warn('network error:', message);
    }

    return isNetErr;
}

function syncErrorText(syncResult) {
    return [syncResult?.langId, syncResult?.message].filter(s => typeof s === 'string').join(' ');
}

function getRateLimitResetMs(syncResult) {
    const match = syncErrorText(syncResult).match(/githubRateLimit:(\d+)/);
    if (!match) {
        return null;
    }
    const resetMs = Number(match[1]);
    return Number.isFinite(resetMs) ? resetMs : null;
}

function isRetryableSyncError(syncResult) {
    return isNetworkError(objectToNativeError(syncResult))
        || getRateLimitResetMs(syncResult) !== null;
}

export function onSyncUiRequestListener() {
    return CloudBroadcast.on('sync-ui-request', () => send('sync-ui-response'));
}

export async function shouldShowSyncErrorNotification(syncResult, trigger) {
    if (syncResult.ok) {
        return false;
    }

    if (syncResult.langId === 'githubInvalidToken' && syncResult.cause?.isEmpty) {
        return false;
    }

    if (trigger === TRIGGER_MANUAL) {
        const {promise, resolve} = Promise.withResolvers();

        const off = CloudBroadcast.on('sync-ui-response', () => resolve(false));
        setTimeout(() => resolve(true), 1000);

        send('sync-ui-request');

        const result = await promise;

        off();

        return result;
    }

    if (trigger === TRIGGER_AUTO && !isRetryableSyncError(syncResult)) {
        return true;
    }

    return syncStorage.networkRetryAttempt === MAX_NETWORK_RETRY_ATTEMPTS;
}

export async function getSyncRetryDelayInMinutes(syncResult, trigger) {
    if (syncResult.ok || trigger === TRIGGER_MANUAL) {
        delete syncStorage.networkRetryAttempt;
        return 0;
    }

    if (isRetryableSyncError(syncResult)) {
        const networkRetryAttempt = (syncStorage.networkRetryAttempt ?? 0) + 1;

        if (networkRetryAttempt <= MAX_NETWORK_RETRY_ATTEMPTS) {
            syncStorage.networkRetryAttempt = networkRetryAttempt;

            const resetMs = getRateLimitResetMs(syncResult);
            if (resetMs !== null) {
                const minutesUntilReset = Math.ceil((resetMs - Date.now()) / 60_000);
                return Math.min(Math.max(minutesUntilReset, 1), MAX_RATE_LIMIT_BACKOFF_MINUTES);
            }

            return networkRetryAttempt * NETWORK_RETRY_DELAY_MINUTES;
        }
    }

    delete syncStorage.networkRetryAttempt;
    return 0;
}
