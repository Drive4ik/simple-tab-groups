
import '/js/prefixed-storage.js';
import * as Constants from '/js/constants.js';
import * as Containers from '/js/containers.js';
import * as Tabs from '/js/tabs.js';
import * as Groups from '/js/groups.js';
import * as Management from '/js/management.js';
import * as Utils from '/js/utils.js';
import JSON from '/js/json.js';
import Logger from '/js/logger.js';
import GithubGist from './githubgist.js';
import * as SyncStorage from '../sync-storage.js';
import * as Storage from '/js/storage.js';
import backgroundSelf from '/js/background.js';
// export {
//     default as GithubGist,
// } from './githubgist.js';

const logger = new Logger(Constants.MODULES.CLOUD);

const storage = localStorage.create(Constants.MODULES.CLOUD);
const mainStorage = localStorage.create(Constants.MODULES.BACKGROUND);

export function CloudError(langId) {
    logger.error('CloudError:', langId)

    this.id = langId;
    this.name = 'CloudError';

    if (langId.startsWith('githubRateLimit')) {
        const relativeTime = Utils.relativeTime(Number(langId.split(':').pop()));
        this.message = browser.i18n.getMessage('githubRateLimit', relativeTime);
    } else {
        this.message = browser.i18n.getMessage(langId) || langId;
    }

    this.toString = () => `${this.name}: ${this.message}`;
}

export const LOCAL = 'local';
export const CLOUD = 'cloud';

export async function sync(trust = null, revision = null, progressFunc = null) {
    const isRestoring = !!revision;

    if (isRestoring) {
        trust = CLOUD;
    }

    const log = logger.start('sync', {trust, isRestoring});

    if (trust && trust !== LOCAL && trust !== CLOUD) {
        log.throwError('unknown source of trust argument');
    }

    const {syncOptionsLocation} = await Storage.get('syncOptionsLocation');

    if (syncOptionsLocation === Constants.SYNC_STORAGE_FSYNC) {
        if (!SyncStorage.IS_AVAILABLE) {
            log.stopError('ffSyncNotSupported');
            throw new CloudError('ffSyncNotSupported');
        }
    }

    progressFunc?.(1);

    const syncOptions = syncOptionsLocation === Constants.SYNC_STORAGE_FSYNC
        ? await SyncStorage.get()
        : await Storage.get(null, Constants.DEFAULT_SYNC_OPTIONS);

    progressFunc?.(10);

    let cloudInstance;

    try {
        cloudInstance = new GithubGist(
            syncOptions.githubGistToken,
            syncOptions.githubGistFileName
        );
    } catch (e) {
        log.stopError(e);
        throw new CloudError(e.message);
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
    } catch (e) {
        if (e.message === 'githubNotFound') {
            //
        } else {
            log.stopError(e);
            throw new CloudError(e.message);
        }
    }

    progressFunc?.(40);

    const localData = await Promise.all([Storage.get(), Groups.load(null, true)])
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
        : cloudLastUpdate > localLastUpdate ? CLOUD : LOCAL;

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
            const description = browser.i18n.getMessage('githubGistBackupDescription');
            cloudInfo = await Cloud.setContent(syncResult.cloudData, description, createCloudProgress(55, 85));
        } catch (e) {
            log.stopError(e);
            throw new CloudError(e.message);
        }

        syncResult.changes.local = true; // sync date must be equal in cloud and local
    }

    progressFunc?.(85);

    // remove unnecessary groups
    for (const groupToRemove of syncResult.changes.groupsToRemove) {
        syncResult.changes.local = true;

        if (Groups.isLoaded(groupToRemove.id)) {
            // remove group from windows
            await Groups.unload(groupToRemove.id);

            // remove tabs
            if (!groupToRemove.isArchive) {
                for (const tabToRemove of groupToRemove.tabs) {
                    syncResult.changes.tabsToRemove.add(tabToRemove);
                }
            }
        }
    }

    progressFunc?.(90);

    // remove unnecessary tabs
    if (syncResult.changes.tabsToRemove.size) {
        // if has local changes - do silent remove. "sync-end" event will trigger "groups-updated" event and reload all groups with tabs
        await Tabs.remove(Array.from(syncResult.changes.tabsToRemove), syncResult.changes.local);
    }

    progressFunc?.(95);

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

            const moveTabsParams = {
                index: -1,
            };

            const tabsToCreate = group.tabs.filter(tab => tab.new);

            if (tabsToCreate.length) {
                tabsToCreate.map(tab => tab.groupId = group.id);

                const newTabs = await backgroundSelf.createTabsSafe(tabsToCreate),
                    [newTab] = newTabs,
                    existTab = group.tabs.find(tab => !tab.new);

                group.tabs = group.tabs.map(tab => tab.new ? newTabs.shift() : tab);

                if (existTab && existTab.windowId !== newTab.windowId) {
                    moveTabsParams.windowId = existTab.windowId;
                }
            }

            // sorting tabs
            group.tabs = await Tabs.moveNative(group.tabs, moveTabsParams);
        }

        syncResult.localData.syncLastUpdate = cloudInfo.lastUpdate;

        await backgroundSelf.saveOptions(syncResult.localData);
        await Groups.save(syncResult.localData.groups);
    }

    progressFunc?.(100);

    log.stop();

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

    const resultMigrate = await backgroundSelf.runMigrateForData(cloudData, false);

    progressFunc?.(10);

    if (resultMigrate.migrated) {
        cloudData = resultMigrate.data;
    } else if (resultMigrate.error) {
        log.stopError(resultMigrate.error);
        throw new CloudError(resultMigrate.error);
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
            Management.replaceMozExtensionTabUrls(group.tabs, 'id');
        }
    }

    const isAvailableFavIconToSync = favIconUrl => favIconUrl?.startsWith('data:');

    const favIconUrlsMap = new Map;
    for (const tab of Utils.concatTabs([...localGroups, ...cloudGroups])) {
        if (isAvailableFavIconToSync(tab.favIconUrl)) {
            favIconUrlsMap.set(tab.url, tab.favIconUrl);
        }
    }

    const hasSomeTreeTabsExtension = Constants.TREE_TABS_EXTENSIONS.some(id => Management.isEnabled(id));

    function prepareForSaveTabs(tabs, prepareFor, groupIsArchive) {
        if (prepareFor !== LOCAL && prepareFor !== CLOUD) throw new Error('invalid "prepareFor" argument');

        // local syncTabFavIcons have already been synchronized and it's equal to cloud
        const includeFavIconUrl = localData.syncTabFavIcons;

        if (prepareFor === CLOUD && includeFavIconUrl) {
            for (const tab of tabs) {
                if (!isAvailableFavIconToSync(tab.favIconUrl)) {
                    tab.favIconUrl = null;
                }

                tab.favIconUrl ??= favIconUrlsMap.get(tab.url);
            }
        }

        const includeId = hasSomeTreeTabsExtension;
        const includeLastAccessed = prepareFor === LOCAL || groupIsArchive === true;

        return Tabs.prepareForSave(tabs, false, includeFavIconUrl, false, includeId, includeLastAccessed);
    }

    if (sourceOfTruth === LOCAL) {
        for (const localGroup of localGroups) {
            const resultLocalGroup = localGroup;
            const resultCloudGroup = {...localGroup}; // unlink tabs key

            if (resultLocalGroup.dontUploadToCloud) {
                resultLocalGroups.push(resultLocalGroup);
            } else {
                resultCloudGroup.tabs = prepareForSaveTabs(resultLocalGroup.tabs, CLOUD, resultCloudGroup.isArchive);

                resultLocalGroups.push(resultLocalGroup);
                resultCloudGroups.push(resultCloudGroup);
            }
        }

        if (!changes.cloud) {
            changes.cloud = resultCloudGroups.length !== cloudGroups.length;
        }

        if (!changes.cloud) {
            changes.cloud = JSON.stringify(resultCloudGroups) !== JSON.stringify(cloudGroups);
        }

    } else if (sourceOfTruth === CLOUD) {

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

                resultLocalGroup.tabs = prepareForSaveTabs(resultLocalGroup.tabs, LOCAL, resultLocalGroup.isArchive);
                resultCloudGroup.tabs = prepareForSaveTabs(resultCloudGroup.tabs, CLOUD, resultCloudGroup.isArchive);

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

                            const [cloudTab] = prepareForSaveTabs([localTab], CLOUD, resultCloudGroup.isArchive);
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

                            const [cloudTab] = prepareForSaveTabs([localTab], CLOUD, resultCloudGroup.isArchive);
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
                cloudGroup.tabs = prepareForSaveTabs(localGroup.tabs, CLOUD, cloudGroup.isArchive);

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
            Management.replaceMozExtensionTabUrls(group.tabs, 'uuid');
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

        if (sourceOfTruth === LOCAL) {
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
        } else if (sourceOfTruth === CLOUD) {
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

                if (sourceOfTruth === LOCAL || jsonCloudValue === undefined) {
                    localData[key] = JSON.clone(Constants.DEFAULT_OPTIONS[key]);
                } else {
                    localData[key] = JSON.parse(jsonCloudValue);
                }

                changes.local = true;
            }

            if (jsonCloudValue === undefined) {
                log.warn(`cloud options key "${key}" is undefined. creating it.`);

                if (sourceOfTruth === CLOUD || jsonLocalValue === undefined) {
                    cloudData[key] = JSON.clone(Constants.DEFAULT_OPTIONS[key]);
                } else {
                    cloudData[key] = JSON.parse(jsonLocalValue);
                }

                changes.cloud = true;
            }

            continue;
        }

        if (jsonLocalValue !== jsonCloudValue) {
            if (sourceOfTruth === LOCAL) {
                cloudData[key] = JSON.parse(jsonLocalValue);
                changes.cloud = true;
                log.log('cloud has changed options key:', key);
            } else if (sourceOfTruth === CLOUD) {
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
