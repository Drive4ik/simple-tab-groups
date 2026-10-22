import Listeners from '/js/listeners.js?extension.onStart';
import '/js/prefixed-storage.js';
import * as Constants from '/js/constants.js';
import * as Containers from '/js/containers.js';
import * as Cache from '/js/cache.js';
import * as Tabs from '/js/tabs.js';
import * as Groups from '/js/groups.js';
import * as SubGroups from '/js/sub-groups.js';
import * as Operations from '/js/operations.js';
import * as MenusMain from '/js/menus-main.js';
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

export {on, off} from '/js/broadcast.js?channel=cloud';

const logger = new Logger(Constants.MODULES.CLOUD);

const storage = localStorage.create(Constants.MODULES.CLOUD);
const syncStorage = storage.create('sync');
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
    const lastSyncGist = storage.lastSync?.gist;

    return Boolean(gist) &&
        gist.id === lastSyncGist?.id &&
        githubGistFileName === lastSyncGist?.fileName;
}

export function updateHasChanges(gist, syncOptions) {
    if (isLastSyncedGist(gist, syncOptions)) {
        storage.hasChanges = gist.contentSha !== storage.lastSync.gist.contentSha;
    }
}

export function getLastSyncTime() {
    return storage.lastSync?.time;
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
    const createCloudProgress = (currentProgress, progressDuration) => fetchProgress => {
        const durationPart = (progressDuration - currentProgress) / 100;
        const mainPercent = currentProgress + Math.floor(fetchProgress * durationPart);

        if (lastProgressPercent !== mainPercent) {
            lastProgressPercent = mainPercent;
            progressFunc?.(mainPercent);
        }
    };

    let cloudData, cloudInfo;

    try {
        [cloudData, cloudInfo] = await Cloud.getContent(revision, true, createCloudProgress(10, 45));
    } catch (error) {
        if (error.langId !== 'githubNotFound' || isRestoring) {
            log.throwError('get GithubGist content', error);
        }
    }

    progressFunc?.(45);

    const sameGist = isLastSyncedGist(cloudInfo, syncOptions);

    updateHasChanges(cloudInfo, syncOptions);

    const cloudUnchanged = sameGist && !storage.hasChanges;

    const sourceOfTruth =
        trust
        ? trust
        : !cloudInfo || cloudUnchanged ? TRUST_LOCAL : TRUST_CLOUD;

    log.info('sourceOfTruth:', sourceOfTruth);

    const hasCloudData = Boolean(cloudData);

    // DESIGN-CLOUD-UPLOAD.md §1 "Keep local tabs since": now before the snapshot - the active tab reads
    // lastAccessed as now (BEHAVIOR-CREATE-TABS.md §58); a memory from the future - the clock was set back
    const now = Date.now();
    const lastSyncTime = sameGist && storage.lastSync.time <= now ? storage.lastSync.time : 0;

    const syncContext = {
        uploadedGroupIds: new Set(sameGist ? storage.lastSync.uploadedGroupIds : []),
        localOnlyGroupIds: new Set(sameGist ? storage.lastSync.localOnlyGroupIds : []),
        stubGroupIds: new Set(sameGist ? storage.lastSync.stubGroupIds : []),
        isFirstLocalSync: !trust && !sameGist,
        keepLocalTabsSince: trust === TRUST_CLOUD ? now : lastSyncTime,
        newCloudGroupIds: null,
    };

    let syncResult;

    // one queue turn for the snapshot, the merge and the local save: edits made while the tabs
    // are applied and the gist is uploaded land after the turn and win over the stale snapshot
    await Groups.save(async () => {
        const localData = await Promise.all([Storage.get(), Groups.load(null, true)])
            .then(([data, {groups}]) => {
                stampVersion(data);
                data.groups = groups;
                data.containers = Containers.getToExport(data);
                Containers.mapDefaultContainer(data, Constants.DEFAULT_COOKIE_STORE_ID_FIREFOX);
                return data;
            });

        const localGroupIds = new Set(localData.groups.map(group => group.id));
        syncContext.newCloudGroupIds = NewCloudGroups.getIds().intersection(localGroupIds);

        progressFunc?.(46);

        if (!cloudData) {
            cloudData = JSON.clone(localData);
            cloudData.groups = cloudData.groups.filter(group => group.uploadToCloud);
        }

        syncResult = await syncData(localData, cloudData, sourceOfTruth, syncContext, createCloudProgress(46, 48))
            .catch(log.onCatch('cant sync'));

        if (!hasCloudData || isRestoring) {
            syncResult.changes.cloud = true;
        }

        if (syncResult.changes.groupsToRemove.size) {
            syncResult.changes.local = true;
        }

        if (!syncResult.changes.local) {
            return null;
        }

        Containers.mapDefaultContainer(syncResult.localData, Constants.DEFAULT_COOKIE_STORE_ID);

        await backgroundSelf.saveOptions(syncResult.localData);

        // the groups doomed by the cloud stay in storage until Groups.remove closes their tabs below
        return [...syncResult.localData.groups, ...syncResult.changes.groupsToRemove.values()];
    });

    // unlink loaded archived groups
    for (const group of syncResult.localData.groups) {
        if (group.isArchive) {
            const windowId = Cache.getWindowId(group.id);

            if (windowId) {
                await Cache.removeWindowSession(windowId);
            }
        }
    }

    progressFunc?.(48);

    // remove unnecessary groups
    if (syncResult.changes.groupsToRemove.size) {
        await Groups.remove(syncResult.changes.groupsToRemove);
    }

    progressFunc?.(50);

    // remove unnecessary tabs
    if (syncResult.changes.tabsToRemove.size) {
        await Tabs.remove(Array.from(syncResult.changes.tabsToRemove));
    }

    progressFunc?.(52);

    if (syncResult.changes.local) {
        for (const group of syncResult.localData.groups) {
            if (group.isArchive) {
                continue;
            }

            const savedTabs = group.tabs;

            for (const tab of savedTabs) {
                if (tab.new) {
                    tab.groupId = group.id;
                }
            }

            const creation = await Tabs.createMultiple(savedTabs, {createMissing: true, hideUnloaded: false});

            await Promise.allSettled(creation.live.map(tab => {
                if (Cache.getTabSubGroupId(tab.id) !== tab.subGroupId) {
                    return Cache.setTabSubGroupId(tab.id, tab.subGroupId);
                }
            }));

            // the sort runs even without new tabs - the order may have changed, for hidden groups too
            group.tabs = await Groups.settleTabs(group, savedTabs, creation);
        }

        const {groups} = await Groups.load();
        await MenusMain.groupsUpdated(groups);
    }

    // after the tabs from the cloud are created - DESIGN-CLOUD-UPLOAD.md §1 "Sync memory"
    const syncTime = Date.now();

    progressFunc?.(55);

    // the upload goes last - DESIGN-CLOUD-UPLOAD.md §5 "A failed upload"
    if (syncResult.changes.cloud) {
        // somebody may have uploaded while the local work ran - abort, the retry re-syncs
        // on top of the fresh cloud; a restore replaces the cloud deliberately - no check
        if (!isRestoring && hasCloudData) {
            const latestCommitSha = await Cloud.getLatestCommitSha()
                .catch(log.onCatch('get latest commit sha'));

            if (latestCommitSha !== cloudInfo.commitSha) {
                log.throwError('gist changed during sync', new CloudError(null, {
                    message: 'the cloud was updated from another device during synchronization',
                    temporary: true,
                }));
            }
        }

        try {
            const description = Lang('githubGistBackupDescription');
            cloudInfo = await Cloud.setContent(syncResult.cloudData, description, createCloudProgress(55, 100));
        } catch (error) {
            log.throwError('set GithubGist content', error);
        }
    }

    storage.lastSync = {
        gist: {
            id: cloudInfo.id,
            fileName: syncOptions.githubGistFileName,
            contentSha: cloudInfo.contentSha,
            updatedAt: cloudInfo.updatedAt,
        },
        time: syncTime,
        uploadedGroupIds: syncResult.localData.groups.filter(group => group.uploadToCloud).map(group => group.id),
        localOnlyGroupIds: syncResult.localData.groups.filter(group => !group.uploadToCloud).map(group => group.id),
        stubGroupIds: syncResult.cloudData.groups.filter(group => !group.uploadToCloud).map(group => group.id),
    };

    storage.hasChanges = false;

    progressFunc?.(100);

    const uploadedGroupIds = new Set(syncResult.cloudData.groups.filter(group => group.uploadToCloud).map(group => group.id));
    NewCloudGroups.remove(syncContext.newCloudGroupIds.intersection(uploadedGroupIds));

    log.stop();

    delete syncResult.localData;
    delete syncResult.cloudData;

    return syncResult;
}

async function syncData(localData, cloudData, sourceOfTruth, syncContext, progressFunc = null) {
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

    await syncGroups(localData, cloudData, sourceOfTruth, syncContext, changes);

    progressFunc?.(70);

    await syncContainers(localData, cloudData);

    cloudData = JSON.clone(cloudData);

    progressFunc?.(100);

    log.stop();

    return {
        localData,
        cloudData,
        changes,
        sourceOfTruth,
    };
}

async function syncGroups(localData, cloudData, sourceOfTruth, syncContext, changes) {
    const log = logger.start('syncGroups');

    const localGroups = localData.groups;
    const cloudGroups = cloudData.groups;

    const resultLocalGroups = [];
    const resultCloudGroups = [];

    const favIconsByUrl = new Map(
        [...localGroups, ...cloudGroups.filter(group => group.uploadToCloud)]
            .flatMap(group => group.tabs)
            .filter(tab => isFavIconAllowed(tab.favIconUrl))
            .map(tab => [tab.url, tab.favIconUrl])
    );

    const localOpeners = new Map(localGroups.map(group => [group.id, Tabs.getOpeners(group.tabs)]));
    const cloudOpeners = new Map(cloudGroups.map(group => [group.id, Tabs.getOpeners(group.tabs ?? [])]));

    function prepareForSaveTabs(tabs, prepareFor, groupIsArchive) {
        if (prepareFor !== TRUST_LOCAL && prepareFor !== TRUST_CLOUD) throw new Error('invalid "prepareFor" argument');

        // local syncTabFavIcons have already been synchronized and it's equal to cloud
        const includeFavIconUrl = localData.syncTabFavIcons;

        if (prepareFor === TRUST_CLOUD && includeFavIconUrl) {
            tabs = tabs.map(tab => ({
                ...tab,
                favIconUrl: isFavIconAllowed(tab.favIconUrl)
                    ? tab.favIconUrl
                    : favIconsByUrl.get(tab.url),
            }));
        }

        const includeLastAccessed = prepareFor === TRUST_LOCAL || groupIsArchive === true;

        return Tabs.prepareForSave(tabs, {
            includeFavIconUrl,
            includeLastAccessed,
        });
    }

    function matchTabs(tabs, otherTabs) {
        const containerOf = tab => tab.cookieStoreId || Constants.DEFAULT_COOKIE_STORE_ID;
        const free = new Set(otherTabs);

        return tabs.map(tab => {
            const match = otherTabs.find(other => {
                return free.has(other) && other.url === tab.url && containerOf(other) === containerOf(tab);
            });

            free.delete(match);

            return match;
        });
    }

    function assignOpeners(groupId, localTabs, cloudTabs) {
        const own = localOpeners.get(groupId);
        const cloud = cloudOpeners.get(groupId) ?? new Map;
        const openers = new Map;

        for (const [index, localTab] of localTabs.entries()) {
            const cloudOpener = cloud.get(cloudTabs[index]);
            let opener = cloudOpener && localTabs[cloudTabs.indexOf(cloudOpener)];

            if (own.has(localTab) && (!opener || sourceOfTruth === TRUST_LOCAL)) {
                opener = own.get(localTab);
            }

            if (opener && opener !== own.get(localTab)) {
                changes.local = true;
            }

            openers.set(localTab, opener);
        }

        return Tabs.withOffsets(localTabs, openers);
    }

    function prepareCloudGroup(localGroup, cloudGroup = null) {
        const resultCloudGroup = JSON.clone(localGroup);

        if (!localGroup.isArchive) {
            resultCloudGroup.subGroups = SubGroups.referencedSubGroups(localGroup);
        }

        localGroup.tabs = assignOpeners(localGroup.id, localGroup.tabs, matchTabs(localGroup.tabs, cloudGroup?.tabs ?? []));

        resultCloudGroup.tabs = prepareForSaveTabs(localGroup.tabs, TRUST_CLOUD, resultCloudGroup.isArchive);

        return resultCloudGroup;
    }

    const syncUpload = (localGroup, cloudGroup) => syncGroupUpload(localGroup, cloudGroup, sourceOfTruth, syncContext, prepareCloudGroup, changes);

    if (sourceOfTruth === TRUST_LOCAL) {
        const cloudGroupById = new Map(cloudGroups.map(cloudGroup => [cloudGroup.id, cloudGroup]));

        for (const localGroup of localGroups) {
            const upload = syncUpload(localGroup, cloudGroupById.get(localGroup.id));

            if (upload.settled) {
                resultLocalGroups.push(upload.localGroup);

                if (upload.cloudGroup) {
                    resultCloudGroups.push(upload.cloudGroup);
                }

                continue;
            }

            resultLocalGroups.push(localGroup);
            resultCloudGroups.push(prepareCloudGroup(localGroup, cloudGroupById.get(localGroup.id)));
        }

        for (const [cloudIndex, cloudGroup] of cloudGroups.entries()) {
            if (localGroups.some(localGroup => localGroup.id === cloudGroup.id)) {
                continue;
            }

            const upload = syncUpload(null, cloudGroup);

            if (upload.settled && upload.cloudGroup) {
                resultCloudGroups.splice(cloudIndex, 0, upload.cloudGroup);
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
            let localGroup = localGroups.find(localGroup => localGroup.id === cloudGroup.id);

            const upload = syncUpload(localGroup, cloudGroup);

            if (upload.settled) {
                if (upload.localGroup) {
                    resultLocalGroups.push(upload.localGroup);
                }

                if (upload.cloudGroup) {
                    resultCloudGroups.push(upload.cloudGroup);
                }

                continue;
            }

            // DESIGN-CLOUD-UPLOAD.md §1 "Keep local tabs since", §3 "Merging a copy that returns to the cloud"
            const isLocalTabKept = localTab => upload.union || localTab.lastAccessed > syncContext.keepLocalTabsSince;

            if (!localGroup) {
                changes.local = true;

                log.log('create/clone new local group from cloud:', cloudGroup.id);

                localGroup = JSON.clone(cloudGroup);

                if (!localGroup.isArchive) {
                    for (const localTab of localGroup.tabs) {
                        localTab.new = true;
                    }
                }

                resultLocalGroups.push(localGroup);
                resultCloudGroups.push(cloudGroup);
                continue;
            }

            const resultLocalGroup = localGroup;
            const resultCloudGroup = cloudGroup;

            log.log('sync cloud group:', resultCloudGroup.id);
            log.log('group archive state local:', resultLocalGroup.isArchive, 'cloud:', resultCloudGroup.isArchive);

            // leaves the local and cloud tab lists aligned by index - the openers rely on it
            function syncTabs(prepareFoundLocalTabFunc, eachNotPreparedLocalTabFunc) {
                const resultLocalTabs = [];
                const resultCloudTabs = resultCloudGroup.tabs;
                const matchedLocalTabs = matchTabs(resultCloudTabs, resultLocalGroup.tabs);

                for (const [cloudIndex, cloudTab] of resultCloudTabs.entries()) {
                    const localTab = matchedLocalTabs[cloudIndex];
                    const localIndex = resultLocalGroup.tabs.indexOf(localTab);

                    resultLocalTabs.push(prepareFoundLocalTabFunc(localTab, cloudTab, localIndex, cloudIndex));
                }

                let offset = 0;

                resultLocalGroup.tabs.forEach((localTab, localTabIndex) => {
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

                const cloudOffsetsBefore = resultCloudTabs.map(tab => tab.openerOffset);

                resultLocalGroup.tabs = assignOpeners(resultLocalGroup.id, resultLocalTabs, resultCloudTabs);
                resultCloudGroup.tabs = Tabs.withOffsets(resultCloudTabs, Tabs.getOpenersByOffset(resultLocalGroup.tabs, resultCloudTabs));

                if (!isEqual(cloudOffsetsBefore, resultCloudGroup.tabs.map(tab => tab.openerOffset))) {
                    changes.cloud = true;
                }
            }

            // the cloud wins the keys of a matched tab: the sub-group (DESIGN-SUB-GROUPS.md §8) and the
            // stamp of an archived tab (DESIGN-CLOUD-UPLOAD.md §5)
            function syncTabKeys(localTab, cloudTab) {
                if ((localTab.subGroupId ?? null) !== (cloudTab.subGroupId ?? null)) {
                    if (cloudTab.subGroupId) {
                        localTab.subGroupId = cloudTab.subGroupId;
                    } else {
                        delete localTab.subGroupId;
                    }

                    changes.local = true;
                }

                if (cloudTab.lastAccessed && localTab.lastAccessed !== cloudTab.lastAccessed) {
                    localTab.lastAccessed = cloudTab.lastAccessed;
                    changes.local = true;
                }
            }

            if (resultCloudGroup.isArchive !== resultLocalGroup.isArchive) {
                if (resultCloudGroup.isArchive) {
                    resultLocalGroup.tabs.forEach(tabToRemove => changes.tabsToRemove.add(tabToRemove));
                }

                syncTabs(
                    (localTab, cloudTab) => {
                        localTab && syncTabKeys(localTab, cloudTab);
                        return localTab ?? {...cloudTab};
                    },
                    (localTab, localTabIndex, resultLocalTabs, resultCloudTabs) => {
                        if (isLocalTabKept(localTab)) {
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

                if (resultLocalGroup.isArchive) {
                    for (const tab of resultLocalGroup.tabs) {
                        tab.new = true;
                    }
                }

            } else if (resultCloudGroup.isArchive && resultLocalGroup.isArchive) {

                syncTabs(
                    (localTab, cloudTab, localIndex, cloudIndex) => {
                        if (localIndex !== cloudIndex) {
                            changes.local = true;
                        }

                        localTab && syncTabKeys(localTab, cloudTab);

                        return localTab ?? {...cloudTab};
                    },
                    (localTab, localTabIndex, resultLocalTabs, resultCloudTabs) => {
                        if (isLocalTabKept(localTab)) {
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

                            syncTabKeys(localTab, cloudTab);
                        }

                        return localTab;
                    },
                    (localTab, localTabIndex, resultLocalTabs, resultCloudTabs) => {
                        if (isLocalTabKept(localTab)) {
                            resultLocalTabs.splice(localTabIndex, 0, localTab);

                            const [cloudTab] = prepareForSaveTabs([localTab], TRUST_CLOUD, resultCloudGroup.isArchive);
                            resultCloudTabs.splice(localTabIndex, 0, cloudTab);

                            changes.cloud = true;
                            return true;
                        }

                        changes.tabsToRemove.add(localTab);
                        changes.local = true;
                        return false;
                    }
                );
            }

            mergeSubGroups(resultLocalGroup, resultCloudGroup, changes);

            assignGroupKeys(resultLocalGroup, resultCloudGroup, sourceOfTruth, changes);

            resultLocalGroups.push(resultLocalGroup);
            resultCloudGroups.push(resultCloudGroup);
        }

        for (const [localIndex, localGroup] of localGroups.entries()) {
            const localGroupProcessed = resultLocalGroups.some(group => group.id === localGroup.id);

            if (localGroupProcessed) {
                continue;
            }

            const upload = syncUpload(localGroup, null);

            if (upload.settled) {
                resultLocalGroups.splice(localIndex, 0, upload.localGroup);

                if (upload.cloudGroup) {
                    log.log('restore the stub of local-only group:', localGroup.id);
                    resultCloudGroups.splice(localIndex, 0, upload.cloudGroup);
                } else {
                    log.log('keep local-only group out of the cloud:', localGroup.id);
                }
            } else if (syncContext.isFirstLocalSync || syncContext.newCloudGroupIds.has(localGroup.id)) {
                log.log('add local group to cloud:', localGroup.id);

                changes.cloud = true;
                resultLocalGroups.push(localGroup);
                resultCloudGroups.push(prepareCloudGroup(localGroup));
            } else {
                log.log('remove local group:', localGroup.id);

                changes.groupsToRemove.set(localGroup.id, localGroup);
                changes.local = true;
            }
        }

        if (!changes.local) {
            changes.local = localGroups.some((group, index) => group.id !== resultLocalGroups[index]?.id);
        }
    }

    // DESIGN-SUB-GROUPS.md §8, DESIGN-CLOUD-UPLOAD.md §2
    for (const localGroup of resultLocalGroups) {
        localGroup.subGroups = SubGroups.referencedSubGroups(localGroup);
    }

    const localSubGroupIdsByGroupId = SubGroups.collectSubGroupIds(resultLocalGroups);
    const resultCloudGroupById = new Map(resultCloudGroups.map(group => [group.id, group]));

    for (const localGroup of resultLocalGroups) {
        const cloudGroup = resultCloudGroupById.get(localGroup.id);
        const hasCloudCopy = Boolean(cloudGroup?.uploadToCloud);
        const copies = hasCloudCopy ? [localGroup, cloudGroup] : [localGroup];

        if (SubGroups.reissueSubGroupIds(copies, localSubGroupIdsByGroupId)) {
            changes.local = true;
            changes.cloud ||= hasCloudCopy;
        }
    }

    localData.groups = resultLocalGroups;
    cloudData.groups = resultCloudGroups;

    log.stop();
}

function createStub(groupId) {
    return {
        id: groupId,
        uploadToCloud: false,
    };
}

// the rows (C1-C8 trust cloud, L1-L5 trust local) are docs/DESIGN-CLOUD-UPLOAD.md §2
function syncGroupUpload(localGroup, cloudGroup, sourceOfTruth, syncContext, prepareCloudGroup, changes) {
    const settled = (resultLocalGroup, resultCloudGroup) => ({
        settled: true,
        localGroup: resultLocalGroup,
        cloudGroup: resultCloudGroup,
    });
    const regular = union => ({settled: false, union});

    const localWins = sourceOfTruth === TRUST_LOCAL;
    const copyWasLocal = groupId => syncContext.localOnlyGroupIds.has(groupId);

    if (localGroup && cloudGroup) {
        if (localGroup.uploadToCloud && cloudGroup.uploadToCloud) {
            // C1 / L1; a copy that was local until now merges by union (§3)
            return regular(copyWasLocal(localGroup.id));
        }

        if (localGroup.uploadToCloud) {
            const uploadTurnedOnHere = localWins || copyWasLocal(localGroup.id);

            if (uploadTurnedOnHere) {
                // C2 / L1: turned on here
                changes.cloud = true;
                return settled(localGroup, prepareCloudGroup(localGroup));
            }

            // C2: turned off on another device
            localGroup.uploadToCloud = false;
            changes.local = true;
            return settled(localGroup, cloudGroup);
        }

        if (cloudGroup.uploadToCloud) {
            const uploadTurnedOffHere = localWins || syncContext.uploadedGroupIds.has(localGroup.id);

            if (uploadTurnedOffHere) {
                // C4 / L2: turned off here
                changes.cloud = true;
                return settled(localGroup, createStub(localGroup.id));
            }

            // C4: turned on on another device, the tabs join by union (§3)
            return regular(true);
        }

        // C5 / L2
        return settled(localGroup, cloudGroup);
    }

    if (localGroup) {
        if (localGroup.uploadToCloud) {
            // C3 / L1
            return regular(false);
        }

        const stubRemovedByOtherDevice = syncContext.stubGroupIds.has(localGroup.id);

        if (stubRemovedByOtherDevice) {
            // C6 / L3: restore the stub
            changes.cloud = true;
            return settled(localGroup, createStub(localGroup.id));
        }

        // C6 / L3: no stub of mine to restore
        return settled(localGroup, null);
    }

    if (cloudGroup.uploadToCloud) {
        // C7 / L4
        return regular(false);
    }

    if (copyWasLocal(cloudGroup.id)) {
        // C8 / L5: my copy was removed here
        changes.cloud = true;
        return settled(null, null);
    }

    // C8 / L5: a stub of another device
    return settled(null, cloudGroup);
}

// DESIGN-SUB-GROUPS.md §8
function mergeSubGroups(localGroup, cloudGroup, changes) {
    const subGroupById = new Map;

    for (const subGroup of cloudGroup.subGroups) {
        subGroupById.set(subGroup.id, subGroup);
    }

    for (const subGroup of localGroup.subGroups) {
        if (!subGroupById.has(subGroup.id)) {
            subGroupById.set(subGroup.id, subGroup);
        }
    }

    const referencedIds = new Set([...localGroup.tabs, ...cloudGroup.tabs].map(tab => tab.subGroupId));
    const merged = [...subGroupById.values()].filter(subGroup => referencedIds.has(subGroup.id));

    if (!isEqual(cloudGroup.subGroups, merged)) {
        changes.cloud = true;
        cloudGroup.subGroups = merged;
    }

    if (!isEqual(localGroup.subGroups, merged)) {
        changes.local = true;
        localGroup.subGroups = JSON.clone(merged);
    }
}

function assignGroupKeys(localGroup, cloudGroup, sourceOfTruth, changes) {
    const isDefaultGroup = !localGroup.tabs && !cloudGroup.tabs;

    const log = logger.start('assignGroupKeys', {isDefaultGroup});

    const EXCLUDE_GROUP_KEYS = [
        'tabs',
        'subGroups',
    ];

    // because we also need to be able to compare "defaultGroupProps"
    const allGroupKeys = new Set([...Object.keys(localGroup), ...Object.keys(cloudGroup)]);

    for (const key of allGroupKeys) {
        if (EXCLUDE_GROUP_KEYS.includes(key)) {
            continue;
        }

        // sorting for equal json stringify value
        const localValue = Array.isArray(localGroup[key]) ? localGroup[key].toSorted() : localGroup[key];
        const cloudValue = Array.isArray(cloudGroup[key]) ? cloudGroup[key].toSorted() : cloudGroup[key];

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
    const localUnMap = new Map([...localData.containers.map].map(e => e.reverse()));
    const cloudUnMap = new Map([...cloudData.containers.map].map(e => e.reverse()));

    // make Businesscircle#red => firefox-container-1; not in the local map: a new container from the cloud
    await mapDataContainers(localData, async mappedCookieStoreId => {
        const cloudCookieStoreId = cloudUnMap.get(mappedCookieStoreId);

        const newContainer = await Containers.create({
            name: cloudData.containers[cloudCookieStoreId].name,
            color: cloudData.containers[cloudCookieStoreId].color,
            icon: cloudData.containers[cloudCookieStoreId].icon,
        });

        localData.containers[newContainer.cookieStoreId] = newContainer;
        localData.containers.map.set(newContainer.cookieStoreId, stringifyContainer(newContainer));

        return newContainer.cookieStoreId;
    }, localUnMap);


    let containerIndex = 1;
    cloudData.containers = {};

    // make Businesscircle#red => cloud-container-1
    await mapDataContainers(cloudData, mappedCookieStoreId => {
        const localCookieStoreId = localUnMap.get(mappedCookieStoreId);

        if (Containers.isTemporary(localCookieStoreId)) {
            return Constants.TEMPORARY_CONTAINER;
        }

        // new ids, apart from the local ones
        const cloudCookieStoreId = 'cloud-container-' + containerIndex++;

        cloudData.containers[cloudCookieStoreId] = {
            ...localData.containers[localCookieStoreId],
            cookieStoreId: cloudCookieStoreId,
        };

        return cloudCookieStoreId;
    });

    // never saved into the storage
    delete localData.containers;
}

// make firefox-container-1 => Businesscircle#red
async function mapContainers(localData, cloudData) {
    localData.containers ??= {};
    localData.containers.map = new Map;

    for (const [cookieStoreId, container] of Object.entries(Containers.query({temporaryContainers: true}))) {
        if (Containers.isTemporary(cookieStoreId)) {
            localData.containers.map.set(cookieStoreId, Constants.TEMPORARY_CONTAINER);
        } else {
            localData.containers[cookieStoreId] = container;
            localData.containers.map.set(cookieStoreId, stringifyContainer(container));
        }
    }

    // every id is in the map already, the map func is never called
    await mapDataContainers(localData, null, localData.containers.map);

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
        if (Object.hasOwn(group, containerKey)) {
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

function isFavIconAllowed(favIconUrl) {
    return favIconUrl?.startsWith('data:');
}

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

// a temporary error is worth a retry; the github errors carry the flag themselves,
// isNetworkError is the fallback for the other sources
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
