import * as Constants from '/js/constants.js';
import * as Storage from '/js/storage.js';
import * as Tabs from '/js/tabs.js';
import * as Groups from '/js/groups.js';
import * as Cache from '/js/cache.js';
import Logger from '/js/logger.js';
import * as DeltaLog from './delta-log.js';
import {computeBootstrapEvents} from './plan-sync.js';
import {planStartupReconcile} from './startup-reconcile.js';
import {isApplying} from './delta-capture.js';
import {isCaptureGateOpen} from './capture-gate-state.js';
import {getDeviceId} from './device-id.js';
import {syncedOptionKeys} from './option-keys.js';
import {isUrlSyncable, unwrapStubUrl} from './url-sync.js';
import {buildFavIconMap} from './favicon-map.js';
import {loadBaseline, lastPushedSeqKey, storage} from './sync-marks.js';

const logger = new Logger('DeltaSyncLocalState');

export function buildLocalState(loadedGroups, syncedOptions = {}, livePinnedTabs = []) {
    const groups = (loadedGroups || []).map(group => {
        const {tabs, ...props} = group;

        const mappedTabs = (Array.isArray(tabs) ? tabs : [])
            .filter(tab => tab && tab.uid != null)
            .map((tab, index) => ({
                uid: tab.uid,
                url: unwrapStubUrl(tab.url),
                title: tab.title,
                cookieStoreId: tab.cookieStoreId,
                index,
                lastModified: tab.lastModified,
                ...(tab.groupPinned ? {pinned: true} : {}),
                ...(tab.discarded === false ? {loaded: true} : {}),
                id: tab.id,
            }));

        const inputTabCount = Array.isArray(tabs) ? tabs.length : 0;
        if (!group.isArchive && inputTabCount > mappedTabs.length) {
            logger.warn('buildLocalState: non-archived group dropped tabs from local snapshot', {
                groupId: group.id,
                inputTabCount,
                mappedTabCount: mappedTabs.length,
                droppedCount: inputTabCount - mappedTabs.length,
            });
        }

        return {...props, tabs: mappedTabs};
    });

    const pinnedTabs = (Array.isArray(livePinnedTabs) ? livePinnedTabs : [])
        .filter(tab => tab && tab.uid != null)
        .map((tab, index) => ({
            uid: tab.uid,
            url: tab.url,
            title: tab.title,
            cookieStoreId: tab.cookieStoreId,
            index: Number.isFinite(tab.index) ? tab.index : index,
            lastModified: tab.lastModified,
            ...(tab.discarded === false ? {loaded: true} : {}),
            id: tab.id,
        }));

    return {groups, pinnedTabs, options: {...syncedOptions}};
}

export async function getLivePinnedTabs() {
    let pinnedTabs = await Tabs.get(null, true, null).catch(() => []);

    return Promise.all(
        pinnedTabs
            .filter(tab => !Cache.getTabGroup(tab.id))
            .map(tab => {
                tab.url = unwrapStubUrl(tab.url);
                return tab;
            })
            .filter(tab => isUrlSyncable(tab.url))
            .map(async tab => {
                const uid = Cache.getTabUid(tab.id) || await Cache.ensureTabUid(tab.id).catch(() => null);
                tab.uid = uid;
                tab.lastModified = Cache.getTabLastModified(tab.id);
                return tab;
            })
    );
}

async function collectAliveUids() {
    const aliveUids = new Set();

    const liveTabs = await Tabs.get(null, null, null).catch(() => []);
    for (const tab of liveTabs) {
        const uid = Cache.getTabUid(tab.id);
        if (uid) {
            aliveUids.add(uid);
        }
    }

    const {archivedGroups} = await Groups.loadWithArchivedTabs();
    for (const group of archivedGroups) {
        for (const tab of Array.isArray(group.tabs) ? group.tabs : []) {
            if (tab.uid != null) {
                aliveUids.add(tab.uid);
            }
        }
    }

    return aliveUids;
}

export async function reconcileClosedTabRecords() {
    if (isApplying() || !await isCaptureGateOpen()) {
        return [];
    }

    const aliveUids = await collectAliveUids();

    const selfDeviceId = getDeviceId();
    const lastPushedSeq = Number(storage[lastPushedSeqKey(selfDeviceId)]) || 0;
    const events = await DeltaLog.getEvents();

    const items = planStartupReconcile({
        events,
        lastPushedSeq,
        aliveUids,
        isPinnedGroupId: Groups.isPinnedGroupId,
    });

    const appended = await DeltaLog.appendMany(items);
    if (appended.length) {
        logger.info('startup reconcile: captured closures of tabs that died while the background was down', {
            count: appended.length,
        });
    }

    return appended;
}

export async function gatherLocalPending(selfDeviceId, log) {
    const priorBaseline = loadBaseline(selfDeviceId);

    const {groups: loadedGroups} = await Groups.loadWithArchivedTabs(null, true, true);
    const syncedKeys = syncedOptionKeys(Constants.ALL_OPTION_KEYS);
    const allLocalOptions = await Storage.get(syncedKeys);
    const localSyncedOptions = {};
    for (const key of syncedKeys) {
        localSyncedOptions[key] = allLocalOptions[key];
    }
    const livePinnedTabs = await getLivePinnedTabs();
    const localState = buildLocalState(loadedGroups, localSyncedOptions, livePinnedTabs);
    const favIconMap = buildFavIconMap(loadedGroups, livePinnedTabs);

    const localLogEvents = await DeltaLog.getEvents();
    const logUids = new Set();
    const logGroupRecordIds = new Set();
    const logOptionKeys = new Set();
    for (const event of localLogEvents) {
        if (event.group?.id != null) {
            logGroupRecordIds.add(event.group.id);
        }
        if (event.uid != null) {
            logUids.add(event.uid);
        }
        if (event.tab?.uid != null) {
            logUids.add(event.tab.uid);
        }
        if (event.op === DeltaLog.OPS.OPTION_SET && event.key != null) {
            logOptionKeys.add(event.key);
        }
    }

    const bootstrapEvents = computeBootstrapEvents(localState, priorBaseline, logUids, logGroupRecordIds, logOptionKeys);
    await DeltaLog.appendMany(bootstrapEvents);
    if (bootstrapEvents.length) {
        log.info('bootstrap-uploaded never-synced local items', {count: bootstrapEvents.length});
    }

    const lastPushedSeq = Number(storage[lastPushedSeqKey(selfDeviceId)]) || 0;

    return {localState, priorBaseline, lastPushedSeq, favIconMap};
}
