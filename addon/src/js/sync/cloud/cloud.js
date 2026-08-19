import Listeners from '/js/listeners.js?extension.onStart';
import '/js/prefixed-storage.js';
import * as Constants from '/js/constants.js';
import * as Containers from '/js/containers.js';
import * as Cache from '/js/cache.js';
import * as Tabs from '/js/tabs.js';
import * as Groups from '/js/groups.js';
import * as GroupsNative from '/js/groups-native.js';
import * as Operations from '/js/operations.js';
import * as MenusMain from '/js/menus-main.js';
import * as Extensions from '/js/extensions.js';
import * as Utils from '/js/utils.js';
import Lang from '/js/lang.js';
import JSON from '/js/json.js';
import Logger, {nativeErrorToObject, objectToNativeError} from '/js/logger.js';
import GithubGist from './githubgist.js';
import CloudError from './error.js';
import * as CloudBroadcast from '/js/broadcast.js?channel=cloud';
import * as SyncStorage from '../sync-storage.js';
import * as NewCloudGroups from '../new-cloud-groups.js';
import * as Storage from '/js/storage.js';
import Migration, {stampVersion} from '/js/migration.js';
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

export const RETRY_DELAY_MINUTES = 3;
const MAX_RETRY_ATTEMPTS = 3;

let inProgress = false;

Listeners.extension.onStart.add(() => syncStorage.clear());

function send(action, data = {}) {
    CloudBroadcast.send({action, ...data});
}

export async function synchronization(trust = null, revision = null) {
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

        const syncRes = await Operations.run('cloud-sync', () => sync(trust, revision, progress => {
            lastProgress = progress;
            log.log('progress', progress);
            send('sync-progress', {progress});
        }));

        syncResult.ok = true;
        syncResult.progress = 100;
        Object.assign(syncResult, syncRes);

        delete storage.lastError;

        send('sync-end', syncResult);

        log.stop();
    } catch (e) {
        syncResult.langId = e.langId;
        syncResult.temporary = e.temporary ?? false;
        syncResult.retryAfter = e.retryAfter ?? null;
        syncResult.progress = lastProgress;
        Object.assign(syncResult, nativeErrorToObject(e));

        storage.lastError = String(e);

        send('sync-error', syncResult);

        log.logError('cant sync', e);
        log.stopError();
    } finally {
        inProgress = false;
        send('sync-finish', syncResult);
    }

    return syncResult;
}

export function isLastSyncedGist(gist, {githubGistFileName}) {
    const lastSyncGist = storage.gist;

    return Boolean(gist) &&
        gist.id === lastSyncGist?.id &&
        githubGistFileName === lastSyncGist?.fileName;
}

async function sync(trust = null, revision = null, progressFunc = null) {
    const isRestoring = !!revision;

    if (isRestoring) {
        trust = TRUST_CLOUD;
    }

    const log = logger.start('sync', {trust, isRestoring});

    if (trust && trust !== TRUST_LOCAL && trust !== TRUST_CLOUD) {
        log.throwError('unknown source of trust argument');
    }

    const {syncOptionsLocation} = await Storage.get('syncOptionsLocation');

    if (syncOptionsLocation === Constants.SYNC_STORAGE_FSYNC) {
        if (!SyncStorage.IS_AVAILABLE) {
            log.throwError('sync not supported', new CloudError('ffSyncNotSupported'));
        }
    }

    progressFunc?.(1);

    let syncOptions;

    try {
        syncOptions = syncOptionsLocation === Constants.SYNC_STORAGE_FSYNC
            ? await SyncStorage.get()
            : await Storage.get(null, Constants.DEFAULT_SYNC_OPTIONS);
    } catch (error) {
        log.throwError('get sync options', error);
    }

    progressFunc?.(10);

    let cloudInstance;

    try {
        cloudInstance = new GithubGist(
            syncOptions.githubGistToken,
            syncOptions.githubGistFileName
        );
    } catch (error) {
        log.throwError('create GithubGist instance', error);
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
        if (error.langId === 'githubNotFound' && !isRestoring) {
            //
        } else {
            log.throwError('get GithubGist content', error);
        }
    }

    progressFunc?.(40);

    const sameGist = isLastSyncedGist(cloudInfo, syncOptions);

    const isFirstLocalSync = !trust && !sameGist;

    const localLastUpdate = sameGist ? new Date(storage.gist.lastUpdate).getTime() : 0;
    const cloudLastUpdate = new Date(cloudInfo?.lastUpdate ?? 0).getTime();

    const sourceOfTruth =
        trust
        ? trust
        : cloudLastUpdate > localLastUpdate ? TRUST_CLOUD : TRUST_LOCAL;

    log.info('sourceOfTruth:', sourceOfTruth);

    const hasCloudData = Boolean(cloudData);

    let syncResult, newCloudGroupIds;

    // the snapshot, the merge and the local save are one queue turn: edits made while the
    // sync uploads to the gist and applies tabs land after the turn and win - nothing is
    // rolled back by a stale snapshot
    await Groups.save(async () => {
        const localData = await Promise.all([Storage.get(), Groups.load(null, true)])
            .then(([data, {groups}]) => {
                stampVersion(data);
                data.groups = groups;
                data.containers = Containers.getToExport(data);
                // map cookie-store-id to Firefox browser
                Containers.mapDefaultContainer(data, Constants.DEFAULT_COOKIE_STORE_ID_FIREFOX);
                return data;
            });

        const localGroupIds = new Set(localData.groups.map(group => group.id));
        newCloudGroupIds = NewCloudGroups.getIds().intersection(localGroupIds);

        progressFunc?.(45);

        cloudData ??= JSON.clone(localData);

        cloudData.syncId = trust === TRUST_CLOUD ? cloudLastUpdate : localLastUpdate;

        syncResult = await syncData(localData, cloudData, sourceOfTruth, newCloudGroupIds, isFirstLocalSync, createCloudProgress(45, 55))
            .catch(log.onCatch('cant sync'));

        delete syncResult.cloudData.syncId;

        if (!hasCloudData || isRestoring) {
            syncResult.changes.cloud = true;
        }

        if (syncResult.changes.cloud) {
            syncResult.changes.local = true; // sync date must be equal in cloud and local
        }

        if (syncResult.changes.groupsToRemove.size) {
            syncResult.changes.local = true;
        }

        // set last-update before call saveOptions, saveOptions will reset alarm and it depends on last-update time
        mainStorage.autoSyncLastTimeStamp = Utils.unixNow();

        if (!syncResult.changes.local) {
            return null;
        }

        // map cookie-store-id to gecko browser
        Containers.mapDefaultContainer(syncResult.localData, Constants.DEFAULT_COOKIE_STORE_ID);

        await backgroundSelf.saveOptions(syncResult.localData);

        // the groups doomed by the cloud stay in storage until Groups.remove closes their tabs below
        return [...syncResult.localData.groups, ...syncResult.changes.groupsToRemove.values()];
    });

    progressFunc?.(55);

    if (syncResult.changes.cloud) {
        try {
            const description = Lang('githubGistBackupDescription');
            cloudInfo = await Cloud.setContent(syncResult.cloudData, description, createCloudProgress(55, 85));
        } catch (error) {
            log.throwError('set GithubGist content', error);
        }
    }

    progressFunc?.(85);

    // remove unnecessary groups
    if (syncResult.changes.groupsToRemove.size) {
        await Groups.remove(syncResult.changes.groupsToRemove);
    }

    progressFunc?.(90);

    // remove unnecessary tabs
    if (syncResult.changes.tabsToRemove.size) {
        // a whole live span closed in one call would be saved by the browser into its saved groups
        await GroupsNative.ungroup(Array.from(syncResult.changes.tabsToRemove));
        // if has local changes - do silent remove. "Cloud.sync-end" event will trigger "Groups.updated.all" event and reload all groups with tabs
        await Tabs.remove(Array.from(syncResult.changes.tabsToRemove), syncResult.changes.local);
    }

    progressFunc?.(95);

    if (syncResult.changes.local) {
        // the native-group mirror is gated inside GroupsNative.apply itself,
        // and apply makes the browser match the synced state - no extra reconcile pass is needed
        // sync changes with current profile
        for (const group of syncResult.localData.groups) {
            if (group.isArchive) {
                continue;
            }

            const tabsToCreate = group.tabs.filter(tab => tab.new);
            const groupWindowId = Cache.getWindowId(group.id) || group.tabs.find(tab => !tab.new)?.windowId;

            if (tabsToCreate.length) {
                for (const tabToCreate of tabsToCreate) {
                    tabToCreate.groupId = group.id;
                    tabToCreate.windowId = groupWindowId;
                }

                // the created tabs carry tab.groupNativeId into their sessions
                const newTabs = await Tabs.createMultiple(tabsToCreate, true);

                group.tabs = group.tabs.map(tab => tab.new ? newTabs.shift() : tab).filter(Boolean);
            }

            // per-tab membership: the merge left the final sub-group id on each tab object
            await Promise.allSettled(group.tabs.map(tab => {
                if (Cache.getTabNativeGroupId(tab.id) !== tab.groupNativeId) {
                    return Cache.setTabNativeGroupId(tab.id, tab.groupNativeId);
                }
            }));

            // sort tabs to the synced order (must run even without new tabs - order may have changed,
            // including for hidden groups: their tabs can be reordered in the addon or the browser)
            const firstTabIndex = group.tabs[0]?.index;
            if (Number.isInteger(firstTabIndex)) {
                group.tabs = await Tabs.moveNative(group.tabs, {index: firstTabIndex}, true);
            }

            if (Groups.isLoaded(group.id)) {
                // the sort above may have torn live native groups apart (moving an array of tabs
                // breaks their groups), and the synced state may differ - apply is a no-op when
                // the live state still matches
                await GroupsNative.apply(groupWindowId, group);
            } else {
                // the sort above can drop hidden tabs onto live-member slots (docs/TABGROUPS-BEHAVIOR.md §11),
                // ungroup works on hidden members too (§12); the browser skips the already hidden on hide
                await GroupsNative.ungroup(group.tabs);
                await Tabs.hide(group.tabs, true);
            }
        }

        const {groups} = await Groups.load();
        await MenusMain.groupsUpdated(groups);
    }

    storage.gist = {
        id: cloudInfo.id,
        lastUpdate: cloudInfo.lastUpdate,
        fileName: syncOptions.githubGistFileName,
    };

    progressFunc?.(100);

    NewCloudGroups.remove(newCloudGroupIds);

    log.stop();

    delete syncResult.localData;
    delete syncResult.cloudData;

    return syncResult;
}

async function syncData(localData, cloudData, sourceOfTruth, newCloudGroupIds, isFirstLocalSync, progressFunc = null) {
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
        log.throwError('migrate data', new CloudError(resultMigrate.error));
    }

    const changes = {
        groupsToRemove: new Map,
        tabsToRemove: new Set,
        local: false,
        cloud: false,
    };

    await mapContainers(localData, cloudData);

    await syncOptions(localData, cloudData, sourceOfTruth, changes);

    progressFunc?.(30);

    await syncGroups(localData, cloudData, sourceOfTruth, changes, newCloudGroupIds, isFirstLocalSync);

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

async function syncGroups(localData, cloudData, sourceOfTruth, changes, newCloudGroupIds, isFirstLocalSync) {
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

        return Tabs.prepareForSave(tabs, {includeGroupNativeId: true, includeFavIconUrl, includeId, includeLastAccessed});
    }

    function prepareCloudGroup(localGroup) {
        const cloudGroup = JSON.clone(localGroup);

        // the cloud gets only sub-groups that still have member tabs
        if (!localGroup.isArchive) {
            cloudGroup.groupsNative = GroupsNative.referencedGroupsNative(localGroup);
        }

        cloudGroup.tabs = prepareForSaveTabs(localGroup.tabs, TRUST_CLOUD, cloudGroup.isArchive);

        return cloudGroup;
    }

    if (sourceOfTruth === TRUST_LOCAL) {
        for (const localGroup of localGroups) {
            if (localGroup.dontUploadToCloud) {
                resultLocalGroups.push(localGroup);
            } else {
                resultLocalGroups.push(localGroup);
                resultCloudGroups.push(prepareCloudGroup(localGroup));
            }
        }

        if (!changes.cloud) {
            changes.cloud = resultCloudGroups.length !== cloudGroups.length;
        }

        if (!changes.cloud) {
            changes.cloud = JSON.stringify(resultCloudGroups) !== JSON.stringify(cloudGroups);
        }

    } else if (sourceOfTruth === TRUST_CLOUD) {

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
                    // the tabs carry their groupNativeId - creation writes it into the sessions
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
            // cloud wins the per-tab sub-group membership of matched tabs
            function syncTabNativeMembership(localTab, cloudTab) {
                if ((localTab.groupNativeId ?? null) !== (cloudTab.groupNativeId ?? null)) {
                    if (cloudTab.groupNativeId) {
                        localTab.groupNativeId = cloudTab.groupNativeId;
                    } else {
                        delete localTab.groupNativeId;
                    }

                    changes.local = true;
                }
            }

            if (resultCloudGroup.isArchive !== resultLocalGroup.isArchive) {
                // changes.local = true; // set when sync group keys

                if (resultCloudGroup.isArchive) { // make local group an archive
                    // remove all local tabs, because group makes an archive
                    resultLocalGroup.tabs.forEach(tabToRemove => changes.tabsToRemove.add(tabToRemove));
                }

                syncTabs(
                    (localTab, cloudTab) => {
                        localTab && syncTabNativeMembership(localTab, cloudTab);
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

                        changes.local = true;
                        return false;
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

                        localTab && syncTabNativeMembership(localTab, cloudTab);

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

                        changes.local = true;
                        return false;
                    }
                );

            } else if (!resultCloudGroup.isArchive && !resultLocalGroup.isArchive) {

                syncTabs(
                    (localTab, cloudTab, localIndex, cloudIndex) => {
                        if (!localTab) {
                            localTab = {...cloudTab, new: true};
                            changes.local = true;
                        } else {
                            if (localIndex !== cloudIndex) {
                                changes.local = true;
                            }

                            syncTabNativeMembership(localTab, cloudTab);
                        }

                        return localTab;
                    },
                    (localTab, localTabIndex, resultLocalTabs, resultCloudTabs) => {
                        localTab.lastAccessed ??= cloudData.syncId + 1;

                        if (localTab.lastAccessed > cloudData.syncId) {
                            resultLocalTabs.splice(localTabIndex, 0, localTab);

                            const [cloudTab] = prepareForSaveTabs([localTab], TRUST_CLOUD, resultCloudGroup.isArchive);
                            resultCloudTabs.splice(localTabIndex, 0, cloudTab);

                            changes.cloud = true;
                            return true;
                        }

                        // delete old tab, which doesn't exist in cloud, that means it was deleted into another computer
                        changes.tabsToRemove.add(localTab);
                        changes.local = true;
                        return false;
                    }
                );
            }

            mergeGroupsNative(resultLocalGroup, resultCloudGroup, changes);

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

                resultLocalGroups.splice(localIndex, 0, localGroup); // leave group in local and don't add it to the cloud
            } else if (isFirstLocalSync || newCloudGroupIds.has(localGroup.id)) {
                // the cloud has never seen this group - it must be uploaded, not removed
                log.log('add local group to cloud:', localGroup.id);

                changes.cloud = true;
                resultLocalGroups.push(localGroup);
                resultCloudGroups.push(prepareCloudGroup(localGroup));
            } else {
                // local group is skipped and deleted...
                log.log('remove local group:', localGroup.id);

                changes.groupsToRemove.set(localGroup.id, localGroup);
                changes.local = true;
            }
        }

        if (!changes.local) {
            changes.local = localGroups.some((group, index) => group.id !== resultLocalGroups[index]?.id);
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

// sub-group metadata merge after the tab merge: cloud meta wins by id, local-only sub-groups
// that still have member tabs are added, entries nobody references are dropped on both sides
function mergeGroupsNative(localGroup, cloudGroup, changes) {
    const entryById = new Map;

    for (const entry of cloudGroup.groupsNative ?? []) {
        entryById.set(entry.id, entry);
    }

    for (const entry of localGroup.groupsNative ?? []) {
        if (!entryById.has(entry.id)) {
            entryById.set(entry.id, entry);
        }
    }

    const referencedIds = new Set([...localGroup.tabs, ...cloudGroup.tabs].map(tab => tab.groupNativeId));
    const merged = [...entryById.values()].filter(entry => referencedIds.has(entry.id));

    if (!isEqual(cloudGroup.groupsNative, merged)) {
        changes.cloud = true;
        cloudGroup.groupsNative = merged;
    }

    if (!isEqual(localGroup.groupsNative, merged)) {
        changes.local = true;
        localGroup.groupsNative = JSON.clone(merged);
    }
}

function assignGroupKeys(localGroup, cloudGroup, sourceOfTruth, changes) {
    const isDefaultGroup = !localGroup.tabs && !cloudGroup.tabs;

    const log = logger.start('assignGroupKeys', {isDefaultGroup});

    const EXCLUDE_GROUP_KEYS = [
        'tabs',
        'groupsNative', // merged explicitly by mergeGroupsNative
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

// a temporary error heals itself - the sync is worth retrying; everything else
// (invalid token, no access, not found, too large) needs the user. The github errors carry
// the flag themselves, isNetworkError is the fallback for the non-github sources
function isTemporaryError(syncResult) {
    return Boolean(syncResult.temporary) || isNetworkError(objectToNativeError(syncResult));
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

    if (trigger === TRIGGER_AUTO && !isTemporaryError(syncResult)) {
        return true;
    }

    return syncStorage.retryAttempt === MAX_RETRY_ATTEMPTS;
}

export async function getSyncRetryDelayInMinutes(syncResult, trigger) {
    if (syncResult.ok || trigger === TRIGGER_MANUAL) {
        delete syncStorage.retryAttempt;
        return 0;
    }

    if (isTemporaryError(syncResult)) {
        const retryAttempt = (syncStorage.retryAttempt ?? 0) + 1;

        if (retryAttempt <= MAX_RETRY_ATTEMPTS) {
            syncStorage.retryAttempt = retryAttempt;

            const delayInMinutes = retryAttempt * RETRY_DELAY_MINUTES;

            if (syncResult.retryAfter) {
                const minutesToRetry = Math.ceil((syncResult.retryAfter - Date.now()) / 60_000) + 1;
                return Math.max(delayInMinutes, minutesToRetry);
            }

            return delayInMinutes;
        }
    }

    delete syncStorage.retryAttempt;
    return 0;
}
