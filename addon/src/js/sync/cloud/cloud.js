
import * as Constants from '/js/constants.js';
import * as Containers from '/js/containers.js';
import * as Tabs from '/js/tabs.js';
import * as Groups from '/js/groups.js';
// import * as Cache from '/js/cache.js';
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

const logger = new Logger('Cloud');

export function CloudError(langId) {
    logger.error('CloudError:', langId)
    this.id = langId;
    this.message = browser.i18n.getMessage(langId);

    if (!this.message) {
        this.message = langId;
    }

    this.toString = () => 'CloudError: ' + this.message;
}

const TRUTH_LOCAL = 'local';
const TRUTH_CLOUD = 'cloud';

export async function sync(progressFunc = null) {
    const log = logger.start('sync');

    const {syncOptionsLocation} = await Storage.get('syncOptionsLocation');

    if (syncOptionsLocation === Constants.SYNC_STORAGE_FSYNC) {
        if (!SyncStorage.IS_AVAILABLE) {
            throw new CloudError('ffSyncNotSupported');
        }
    }

    progressFunc?.(0);

    const syncOptions = syncOptionsLocation === Constants.SYNC_STORAGE_FSYNC
        ? await SyncStorage.get()
        : await Storage.get(null, Constants.DEFAULT_SYNC_OPTIONS);

    async function saveNewGistId(githubGistId) {
        syncOptionsLocation === Constants.SYNC_STORAGE_FSYNC
            ? await SyncStorage.set({githubGistId})
            : await Storage.set({githubGistId});
    }

    const GithubGistCloud = new GithubGist(
        syncOptions.githubGistToken,
        syncOptions.githubGistFileName,
        syncOptions.githubGistId
    );

    const cloudProgressFunc = function(currentProgress, progressDuration, fetchProgress) {
        const durationPart = 100 / progressDuration;
        const mainPercent = currentProgress + Math.floor(fetchProgress / durationPart);
        log.log('main and fetch progress', mainPercent, fetchProgress);
        progressFunc(mainPercent);
    };

    async function getGistData() {
        try {
            if (progressFunc) {
                GithubGistCloud.progressFunc = cloudProgressFunc.bind(null, 5, 35);
            }

            const result = await GithubGistCloud.getGist();

            GithubGistCloud.progressFunc = null;

            return result;
        } catch (e) {
            GithubGistCloud.progressFunc = null;
            log.stopError(e);
            throw new CloudError(e.message);
        }
    }

    const oldGistId = GithubGistCloud.gistId,
        cloudData = await getGistData();

    if (cloudData && GithubGistCloud.gistId && oldGistId !== GithubGistCloud.gistId) {
        await saveNewGistId(GithubGistCloud.gistId);
    }

    progressFunc?.(40);

    const localData = await Promise.all([Storage.get(), Groups.load(null, true)])
        .then(([data, {groups}]) => {
            data.groups = groups;
            data.containers = Containers.getToExport(data);
            return data;
        });

    progressFunc?.(45);
// throw Error('aaa');
    const syncResult = await syncData(localData, cloudData);

    progressFunc?.(50);

    console.debug('syncResult', syncResult);

    if (syncResult.changes.local) {
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
    }

    // remove unnecessary tabs
    if (syncResult.changes.tabsToRemove.size) {
        await Tabs.remove(Array.from(syncResult.changes.tabsToRemove));
    }

    progressFunc?.(55);

    // log.debug('before cloud syncId:', syncResult.cloudData.syncId);
    // log.debug('before local syncId:', syncResult.localData.syncId);

    if (syncResult.changes.cloud) {
        syncResult.changes.local = true; // syncId must be equal in cloud and local
        syncResult.localData.syncId = syncResult.cloudData.syncId = Date.now();
    } else if (syncResult.changes.local) { // will be true if syncResult.sourceOfTruth === TRUTH_CLOUD
        syncResult.localData.syncId = syncResult.cloudData.syncId;
    }

    // log.debug('trust:', syncResult.sourceOfTruth);
    // log.debug('changes.cloud:', syncResult.changes.cloud, syncResult.cloudData.syncId);
    // log.debug('changes.local:', syncResult.changes.local, syncResult.localData.syncId);

    if (progressFunc) {
        GithubGistCloud.progressFunc = cloudProgressFunc.bind(null, 55, 35);
    }

    if (GithubGistCloud.gistId) {
        if (syncResult.changes.cloud) {
            try {
                await GithubGistCloud.updateGist(syncResult.cloudData);
            } catch (e) {
                log.stopError(e);
                throw new CloudError('githubCantUploadBackupToGist');
            }
        }
    } else {
        try {
            const description = browser.i18n.getMessage('githubGistBackupDescription');
            const result = await GithubGistCloud.createGist(syncResult.cloudData, description);
            await saveNewGistId(result.id);
        } catch (e) {
            log.stopError(e);
            throw new CloudError('githubCantCreateBackupIntoGist');
        }
    }

    progressFunc?.(95);

    if (syncResult.changes.local) {
        // TODO normal save options
        await Storage.set(syncResult.localData);
    }

    window.localStorage.autoSyncLastTimeStamp = Utils.unixNow();

    progressFunc?.(100);

    log.stop();

    return syncResult;
}

async function syncData(localData, cloudData = null) {
    const log = logger.start('syncData');

    // syncTabFavIcons

    const hasCloudData = Boolean(cloudData);

    cloudData ??= JSON.clone(localData);

    // TODO runMigrate !!!

    const sourceOfTruth = cloudData.syncId > localData.syncId ? TRUTH_CLOUD : TRUTH_LOCAL;

    const changes = {
        // nextSyncId: Date.now(),
        tabsToRemove: new Set,
        local: false,
        cloud: !hasCloudData,
    };

    // don't care if cloudData not exist before, and it's clone of local data

    await mapContainers(localData, cloudData);

    await syncOptions(localData, cloudData, sourceOfTruth, changes);

    await syncGroups(localData, cloudData, sourceOfTruth, changes);

    await syncContainers(localData, cloudData);

    cloudData = JSON.clone(cloudData);

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
    const log = logger.start('syncGroups', {sourceOfTruth, syncTabFavIcons: localData.syncTabFavIcons});

    const localGroups = localData.groups;
    const cloudGroups = cloudData.groups;

    const resultLocalGroups = [];
    const resultCloudGroups = [];

    function prepareForSaveTab(tab, includeLastAccessed) {
        // include includeLastAccessed, tab id and openerId only for local tabs
        const includeId = includeLastAccessed;
        return Tabs.prepareForSaveTab(tab, false, localData.syncTabFavIcons, false, includeId, includeLastAccessed);
    }

    function prepareForSave(tabs, includeLastAccessed) {
        return tabs.map(tab => prepareForSaveTab(tab, includeLastAccessed));
    }

    if (sourceOfTruth === TRUTH_LOCAL) {
        localGroups.forEach(localGroup => {
            const resultLocalGroup = localGroup;
            const resultCloudGroup = {...localGroup}; // unlink tabs key

            if (resultLocalGroup.dontUploadToCloud) {
                resultLocalGroups.push(resultLocalGroup);
            } else {
                resultCloudGroup.tabs = prepareForSave(resultLocalGroup.tabs, false);

                resultLocalGroups.push(resultLocalGroup);
                resultCloudGroups.push(resultCloudGroup);
            }
        });

        if (!changes.cloud) {
            changes.cloud = resultCloudGroups.length !== cloudGroups.length;
        }

        if (!changes.cloud) {
            changes.cloud = JSON.stringify(resultCloudGroups) !== JSON.stringify(cloudGroups);
        }

    } else if (sourceOfTruth === TRUTH_CLOUD) {
        // const localTabsToRemove = new Set;

        cloudGroups.forEach(cloudGroup => {
            let localGroup;

            // if first sync - add cloud group as new. This will duplicate groups, sorry ¯\_(ツ)_/¯
            // it is impossible otherwise, because the id of the group on one computer
            // and the same id on another computer do not mean the same groups
            if (localData.syncId === Constants.DEFAULT_OPTIONS.syncId) {
                // nevertheless, we are trying to find a group with the same name and the same id,
                // this will happen when restoring groups from a backup on different computers with data cleansing
                // (then the id of the groups are saved)
                localGroup = localGroups.find(localGroup => localGroup.id === cloudGroup.id && localGroup.title === cloudGroup.title);
            } else {
                // find local group
                localGroup = localGroups.find(localGroup => localGroup.id === cloudGroup.id);
            }

            if (localGroup?.dontUploadToCloud) {
                resultLocalGroups.push(localGroup); // leave group in local
                resultCloudGroups.push(cloudGroup); // leave in cloud, beacause other comp. can sync with this group
                return;
            }

            // if not found, create it
            if (!localGroup) {
                changes.local = true;

                log.log('create/clone new local group from cloud:', cloudGroup.id);
                // TODO work with group id => to timestamp
                localGroup = JSON.clone(cloudGroup);

                if (!localGroup.isArchive) {
                    localGroup.tabs.forEach(localTab => localTab.new = true);
                }

                resultLocalGroups.push(localGroup);
                resultCloudGroups.push(cloudGroup);
                return;
            }

            const resultLocalGroup = localGroup;
            const resultCloudGroup = cloudGroup;

            log.log('group:', cloudGroup.id);
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

                    let addOffset = eachNotPreparedLocalTabFunc(localTab, localTabIndex + offset, resultLocalTabs, resultCloudTabs);

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

                resultLocalGroup.tabs = prepareForSave(resultLocalGroup.tabs);
                resultCloudGroup.tabs = prepareForSave(resultCloudGroup.tabs, false);

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

                            const cloudTab = prepareForSaveTab(localTab, false);
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

                            const cloudTab = prepareForSaveTab(localTab, false);
                            resultCloudTabs.splice(localTabIndex, 0, cloudTab);

                            changes.cloud = true;
                            return true;
                        } else {
                            // delete old tab, which doensn't exist in cloud, that means it was deleted into another computer
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
        });

        // remove groups which are not in the cloud
        localGroups.forEach(localGroup => {
            if (localGroup.isArchive) {
                return;
            }

            const keepLocalGroup = resultLocalGroups.some(group => localGroup.id === group.id);

            if (!keepLocalGroup) {
                changes.local = true;
                localGroup.tabs.forEach(tabToRemove => changes.tabsToRemove.add(tabToRemove));
            }
        });
    }

    localData.groups = resultLocalGroups;
    cloudData.groups = resultCloudGroups;

    log.stop();
}

const EXCLUDE_GROUP_KEYS = [
    'tabs',
    'bookmarkId',
];

function assignGroupKeys(localGroup, cloudGroup, sourceOfTruth, changes) {
    const isDefaultGroup = !localGroup.tabs && !cloudGroup.tabs;

    const log = logger.start('assignGroupKeys', {isDefaultGroup});

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

        if (sourceOfTruth === TRUTH_LOCAL) {
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
        } else if (sourceOfTruth === TRUTH_CLOUD) {
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
}

async function syncOptions(localData, cloudData, sourceOfTruth, changes) {
    const log = logger.start('syncOptions', {sourceOfTruth});

    const EXCLUDE_OPTION_KEY_STARTS_WITH = [
        'defaultGroupProps',
        'autoBackup',
        'sync',
    ];

    for (const key of Constants.ALL_OPTIONS_KEYS) {
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

                if (sourceOfTruth === TRUTH_LOCAL || jsonCloudValue === undefined) {
                    localData[key] = JSON.clone(Constants.DEFAULT_OPTIONS[key]);
                } else {
                    localData[key] = JSON.parse(jsonCloudValue);
                }

                changes.local = true;
            }

            if (jsonCloudValue === undefined) {
                log.warn(`cloud options key "${key}" is undefined. creating it.`);

                if (sourceOfTruth === TRUTH_CLOUD || jsonLocalValue === undefined) {
                    cloudData[key] = JSON.clone(Constants.DEFAULT_OPTIONS[key]);
                } else {
                    cloudData[key] = JSON.parse(jsonLocalValue);
                }

                changes.cloud = true;
            }

            continue;
        }

        if (jsonLocalValue !== jsonCloudValue) {
            if (sourceOfTruth === TRUTH_LOCAL) {
                cloudData[key] = JSON.parse(jsonLocalValue);
                changes.cloud = true;
                log.log('cloud has changed options key:', key);
            } else if (sourceOfTruth === TRUTH_CLOUD) {
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
    for (const [cookieStoreId, container] of Object.entries(Containers.getAll())) {
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

const GROUP_CONTAINER_KEYS = [
    'newTabContainer',
    'excludeContainersForReOpen',
    'catchTabContainers',
];

async function eachGroupContainerKeyMap(group, asyncMapFunc) {
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
