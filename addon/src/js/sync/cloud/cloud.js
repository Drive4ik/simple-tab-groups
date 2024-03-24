
import * as Constants from '/js/constants.js';
import * as Containers from '/js/containers.js';
import * as Tabs from '/js/tabs.js';
import * as Groups from '/js/groups.js';
import * as Cache from '/js/cache.js';
import * as Utils from '/js/utils.js';
import JSON from '/js/json.js';
import Logger from '/js/logger.js';
import GithubGist from './githubgist.js';
import * as SyncStorage from '../sync-storage.js';
import * as Storage from '/js/storage.js';
import backgroundSelf from '../../background.js';
// export {
//     default as GithubGist,
// } from './githubgist.js';

const logger = new Logger('Cloud');

export function CloudError(langId) {
    this.id = langId;
    this.message = browser.i18n.getMessage(langId);
    this.toString = () => 'CloudError: ' + this.message;
}

const TRUTH_LOCAL = 'local';
const TRUTH_CLOUD = 'cloud';

export async function sync() {
    const log = logger.start('sync');

    const {syncOptionsLocation} = await Storage.get('syncOptionsLocation');

    if (syncOptionsLocation === Constants.SYNC_STORAGE_FSYNC) {
        if (!SyncStorage.IS_AVAILABLE) {
            throw new CloudError('ffSyncNotSupported');
        }
    }

    const syncOptions = syncOptionsLocation === Constants.SYNC_STORAGE_FSYNC
        ? await SyncStorage.get()
        : await Storage.get(null, Constants.DEFAULT_SYNC_OPTIONS);

    const GithubGistCloud = new GithubGist(syncOptions.githubGistToken, syncOptions.githubGistFileName, syncOptions.githubGistId);

    try {
        await GithubGistCloud.checkToken();
    } catch (e) {
        throw new CloudError('invalidGithubToken');
    }

    // throw error only on invalid json content
    async function getGistData() {
        const gist = await GithubGistCloud.getGist().catch(() => {});

        if (gist) {
            try {
                return JSON.parse(gist.content);
            } catch (e) {
                throw new CloudError('invalidGithubGistContent');
            }
        }

        return null;
    }

    let cloudData = await getGistData(),
        githubGistId = null;

    if (!cloudData) {
        githubGistId = await GithubGistCloud.findGistId();

        if (githubGistId) {
            cloudData = await getGistData();
        }
    }

    async function saveNewGistId(githubGistId) {
        syncOptionsLocation === Constants.SYNC_STORAGE_FSYNC
            ? await SyncStorage.set({githubGistId})
            : await Storage.set({githubGistId});
    }

    if (cloudData && githubGistId) {
        await saveNewGistId(githubGistId);
    }

    const localData = await Promise.all([Storage.get(), Groups.load(null, true)])
        .then(([data, {groups}]) => {
            data.groups = groups;
            // data.groups = groups.map(group => {
            //     group.tabs = Tabs.prepareForSave(group.tabs, false, data.syncTabFavIcons);
            //     return group;
            // });
            data.containers = Containers.getToExport(data);
            return data;
        });

    // console.debug('before', JSON.clone(localData), JSON.clone(cloudData));
    const syncResult = await syncData(localData, cloudData);

    console.debug('syncResult', syncResult);

    if (syncResult.changes.localChanged) {
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

    const allTabIds = syncResult.localData.groups.reduce((acc, group) => {
        if (group.isArchive) {
            return acc;
        }

        return [...acc, ...group.tabs.map(Tabs.extractId)];
    }, []);


    let syncId/* ,
        hasChanges */;

    if (syncResult.sourceOfTruth === TRUTH_CLOUD) {
        // hasChanges = checkChanges(syncResult.localData, syncResult.cloudData);

        syncId = syncResult.changes.cloudChanged ? Date.now() : syncResult.cloudData.syncId;

        // if (syncResult.changes.cloudChanged) {
        //     syncId = Date.now();
        // } else {
        //     syncId = syncResult.cloudData.syncId;
        // }
    } else {
        // hasChanges = true;
        syncId = Date.now();
    }

    syncResult.cloudData.syncId = syncResult.localData.syncId = syncId;

    // await Promise.all(allTabIds.map(tabId => )); // TODO last stop here

    // TODO syncData for all tabs: Date.now() + tab.url
    // await Promise.all(allTabIds.map(tabId => Cache.setSyncId(tabId, syncId)));

    if (GithubGistCloud.gistId) {
        try {
            await GithubGistCloud.updateGist(syncResult.cloudData);
        } catch (e) {
            throw new CloudError('cantUploadBackupToGithubGist');
        }
    } else {
        try {
            const result = await GithubGistCloud.createGist(syncResult.cloudData, 'Simple Tab Groups backup');
            await saveNewGistId(result.id);
        } catch (e) {
            throw new CloudError('cantCreateBackupIntoGithubGist');
        }
    }

    // TODO normal save options
    await Storage.set(syncResult.localData);

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
        nextSyncId: Date.now(),
        tabsToRemove: new Set,
        localChanged: false,
        cloudChanged: !hasCloudData,
    };

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
    const log = logger.start('syncGroups', {sourceOfTruth});

    const localGroups = localData.groups;
    const cloudGroups = cloudData.groups;

    const resultLocalGroups = [];
    const resultCloudGroups = [];

    // tab.sync == String(options.syncId + tab.url)
    // if tabs was synced -
    // tab.sync.id === options.syncId
    // AND
    // tab.sync.url === tab.url
    // else - it's new tab or not synced tab or old synced tab

    // check real exist tab or archive tab
    // const isLocalTabSynced = localTab => localTab.noSync ? false : Tabs.isSynced(localData.syncId, localTab);

    // const START_TIME = +self.localStorage.START_TIME;

    if (sourceOfTruth === TRUTH_LOCAL) {
        localGroups.forEach(localGroup => {
            if (localGroup.dontUploadToCloud) { // TODO check & do this on all code
                return;
            }

            const resultLocalGroup = localGroup;
            const resultCloudGroup = {...localGroup}; // unlink tabs array

            if (resultCloudGroup.isArchive) {
                resultCloudGroup.tabs = resultLocalGroup.tabs.map(tab => {
                    const tabToCloud = {...tab};

                    delete tabToCloud.id;
                    delete tabToCloud.openerTabId;
                    delete tabToCloud.thumbnail;
                    delete tabToCloud.groupId; // ???? TODO check need it?
                    delete tabToCloud.noSync;

                    return tabToCloud;
                });
            } else {
                resultCloudGroup.tabs = Tabs.prepareForSave(resultLocalGroup.tabs, false, localData.syncTabFavIcons, false, false);
            }

            resultLocalGroups.push(resultLocalGroup);
            resultCloudGroups.push(resultCloudGroup);
        });
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
                // found local group
                localGroup = localGroups.find(localGroup => localGroup.id === cloudGroup.id);
            }

            // if not found, create it
            if (!localGroup) {
                changes.localChanged = true;

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

            function findNotSyncLocalTab(cloudTab, skipTabFunc, excludeTabs = []) {
                const cloudCookieStoreId = cloudTab.cookieStoreId || Constants.DEFAULT_COOKIE_STORE_ID;

                const localTab = resultLocalGroup.tabs.find(localTab => {
                    if (excludeTabs.includes(localTab)) {
                        return false;
                    }

                    if (skipTabFunc(localTab)) {
                        return false;
                    }

                    if (localTab.url !== cloudTab.url) { // url should be normalized
                        return false;
                    }

                    const localCookieStoreId = localTab.cookieStoreId || Constants.DEFAULT_COOKIE_STORE_ID;

                    return localCookieStoreId === cloudCookieStoreId;
                });

                return [localTab, resultLocalGroup.tabs.indexOf(localTab)];
            }

            function syncTabs(skipTabFunc, prepareFoundLocalTabFunc, eachNotPreparedLocalTabFunc) {
                const resultLocalTabs = [];
                const resultCloudTabs = resultCloudGroup.tabs;

                resultCloudGroup.tabs.forEach((cloudTab, cloudIndex) => {
                    const [localTab, localIndex] = findNotSyncLocalTab(cloudTab, skipTabFunc, resultLocalTabs);

                    const preparedLocalTab = prepareFoundLocalTabFunc(localTab, cloudTab, localIndex, cloudIndex);

                    resultLocalTabs.push(preparedLocalTab);
                });

                resultLocalGroup.tabs.forEach((localTab, localTabIndex) => {
                    // skip tabs that remain locally
                    if (resultLocalTabs.includes(localTab)) {
                        return;
                    }

                    eachNotPreparedLocalTabFunc(localTab, localTabIndex, resultLocalTabs, resultCloudTabs);
                });

                resultLocalGroup.tabs = resultLocalTabs;
                resultCloudGroup.tabs = resultCloudTabs;
            }

            // sync tabs:
            if (resultCloudGroup.isArchive !== resultLocalGroup.isArchive) {
                // changes.localChanged = true;

                if (resultCloudGroup.isArchive) { // make local group an archive
                    // remove all local tabs, because group makes an archive
                    resultLocalGroup.tabs.forEach(tabToRemove => changes.tabsToRemove.add(tabToRemove));

                    const isUnSyncTab = localTab => !Tabs.isSynced(localData.syncId, localTab);

                    syncTabs(
                        isUnSyncTab,
                        (localTab, cloudTab) => {
                            return localTab ?? {...cloudTab};
                        },
                        (localTab, localTabIndex, resultLocalTabs, resultCloudTabs) => {
                            if (isUnSyncTab(localTab)) {
                                // if a tab not synced, it means it has not yet been in the cloud and on another computer
                                // i.e. it is new. leave it and add it to the cloud

                                // it may be necessary to check in the future if the insertion position can be improved
                                const cloudTab = Tabs.prepareForSaveTab(localTab, false, localData.syncTabFavIcons, false, false);
                                resultLocalTabs.splice(localTabIndex, 0, cloudTab);
                                resultCloudTabs.splice(localTabIndex, 0, {...cloudTab});
                                changes.cloudChanged = true;
                            }
                        }
                    );

                } else if (resultLocalGroup.isArchive) { // UN archive local group
                    const isUnSyncTab = localTab => localTab.noSync;

                    syncTabs(
                        isUnSyncTab,
                        (localTab, cloudTab) => {
                            const preparedLocalTab = localTab ?? {...cloudTab};
                            preparedLocalTab.new = true;

                            return preparedLocalTab;
                        },
                        (localTab, localTabIndex, resultLocalTabs, resultCloudTabs) => {
                            if (isUnSyncTab(localTab)) {
                                delete localTab.noSync;
                                delete localTab.id;
                                delete localTab.openerTabId;

                                resultLocalTabs.splice(localTabIndex, 0, {...localTab, new: true});
                                resultCloudTabs.splice(localTabIndex, 0, {...localTab});

                                changes.cloudChanged = true;
                            }
                        }
                    );
                }
            } else if (resultCloudGroup.isArchive && resultLocalGroup.isArchive) {
                const isUnSyncTab = localTab => localTab.noSync;

                syncTabs(
                    isUnSyncTab,
                    (localTab, cloudTab, localIndex, cloudIndex) => {
                        if (localIndex !== cloudIndex) {
                            changes.localChanged = true;
                        }

                        return localTab ?? {...cloudTab};
                    },
                    (localTab, localTabIndex, resultLocalTabs, resultCloudTabs) => {
                        if (isUnSyncTab(localTab)) {
                            delete localTab.noSync;

                            resultLocalTabs.splice(localTabIndex, 0, localTab);

                            const cloudTab = {...localTab};
                            delete cloudTab.id;
                            delete cloudTab.openerTabId;

                            resultCloudTabs.splice(localTabIndex, 0, cloudTab);

                            changes.cloudChanged = true;
                        }
                    }
                );
            } else if (!resultCloudGroup.isArchive && !resultLocalGroup.isArchive) {
                const isUnSyncTab = localTab => !Tabs.isSynced(localData.syncId, localTab);

                syncTabs(
                    isUnSyncTab,
                    (localTab, cloudTab, localIndex, cloudIndex) => {
                        if (!localTab) {
                            localTab = {...cloudTab, new: true};
                            changes.localChanged = true;
                        } else if (localIndex !== cloudIndex) {
                            changes.localChanged = true;
                        }

                        return localTab;
                    },
                    (localTab, localTabIndex, resultLocalTabs, resultCloudTabs) => {
                        if (isUnSyncTab(localTab)) {
                            // if a tab not synced, it means it has not yet been in the cloud and on another computer
                            // i.e. it is new. leave it and add it to the cloud

                            // it may be necessary to check in the future if the insertion position can be improved
                            const cloudTab = Tabs.prepareForSaveTab(localTab, false, localData.syncTabFavIcons, false, false);
                            resultLocalTabs.splice(localTabIndex, 0, localTab);
                            resultCloudTabs.splice(localTabIndex, 0, cloudTab);
                            changes.cloudChanged = true;
                        } else {
                            // delete a synced tab that was deleted on another computer
                            changes.tabsToRemove.add(localTab);
                            changes.localChanged = true;
                        }
                    }
                );
            }

            // assign group keys
            assignGroupKeys(resultLocalGroup, resultCloudGroup, sourceOfTruth, changes);

            resultLocalGroups.push(resultLocalGroup);
            resultCloudGroups.push(resultCloudGroup);
        });

        // remove groups that are not in the cloud
        localGroups.forEach(localGroup => {
            if (localGroup.isArchive) {
                return;
            }

            const keepLocalGroup = resultLocalGroups.some(group => localGroup.id === group.id);

            if (!keepLocalGroup) {
                changes.localChanged = true;
                localGroup.tabs.forEach(tabToRemove => changes.tabsToRemove.add(tabToRemove));
            }
        });
    }

    localData.groups = resultLocalGroups;
    cloudData.groups = resultCloudGroups;

    // cloudData.syncId = localData.syncId = Date.now();

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
            changes.cloudChanged = true;

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
            changes.localChanged = true;

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

    const EXCLUDE_OPTION_KEYS = [
        'defaultGroupProps',
        'autoBackup',
        'sync',
    ];

    for (const key of Constants.ALL_OPTIONS_KEYS) {
        if (EXCLUDE_OPTION_KEYS.some(exKey => key.startsWith(exKey))) {
            continue;
        }

        const jsonLocalValue = JSON.stringify(localData[key]);
        const jsonCloudValue = JSON.stringify(cloudData[key]);

        if (jsonLocalValue !== jsonCloudValue) {
            if (sourceOfTruth === TRUTH_LOCAL) {
                cloudData[key] = JSON.parse(jsonLocalValue);
                changes.cloudChanged = true;
                log.log('cloudChanged:', key);
            } else if (sourceOfTruth === TRUTH_CLOUD) {
                localData[key] = JSON.parse(jsonCloudValue);
                changes.localChanged = true;
                log.log('localChanged:', key);
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

    // no need map func, it is never call
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
