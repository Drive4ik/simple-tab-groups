import * as Constants from '/js/constants.js';
import * as Storage from '/js/storage.js';
import * as Tabs from '/js/tabs.js';
import * as Groups from '/js/groups.js';
import * as MenusMain from '/js/menus-main.js';
import * as Windows from '/js/windows.js';
import * as Cache from '/js/cache.js';
import * as Containers from '/js/containers.js';
import backgroundSelf from '/js/background.js';
import Logger from '/js/logger.js';
import {createCloudProvider} from '../cloud/provider.js';
import * as SyncStorage from '../sync-storage.js';
import {CloudError, send, ALARM_NAME_RETRY} from '../cloud/cloud.js?can-do-synchronization';
import {runSyncApply, isUserActive, DEFAULT_SYNC_APPLY_WATCHDOG_MS} from './user-priority-lock.js';
import * as DeltaLog from './delta-log.js';
import * as DeltaCapture from './delta-capture.js';
import {invalidateCaptureGate} from './capture-gate-state.js';
import {getDeviceId} from './device-id.js';
import {planSync, computeBootstrapEvents, baselineFromSnapshot} from './plan-sync.js';
import {
    evaluateCompaction,
    selfFoldedSeq,
    truncateSelfEvents,
    resolveDeferredTruncation,
} from './compaction.js';
import {
    makeOutboundMapper,
    makeInboundMapper,
    mapStateContainers,
    mapEventContainers,
} from './container-map.js';
import {syncedOptionKeys} from './option-keys.js';
import {shouldSleepSyncedTab, SLEEP_OPTION_KEYS} from './tab-sleep.js';
import {isUrlSyncable, unwrapStubUrl, sanitizeFavIconUrl, liveUrlMatchesSource, shouldNavigateLiveTabUrl} from './url-sync.js';
import {
    SNAPSHOT_FILE_NAME,
    DELTA_FILE_PREFIX,
    deltaFileName,
    deviceIdFromDeltaFileName,
} from './layout.js';

const logger = new Logger('DeltaSync');

const storage = localStorage.create(Constants.MODULES.CLOUD);

let currentApplyPhase = null;

function beginApplyPhase(name, log) {
    currentApplyPhase = name;
    const startedAt = Date.now();
    return function endPhase() {
        log.log('apply phase done', {phase: name, ms: Date.now() - startedAt});
    };
}

const LAST_PUSHED_SEQ_PREFIX = 'deltaLastPushedSeq:';
const RESET_PENDING_PREFIX = 'deltaResetPending:';
const PENDING_TRUNCATE_PREFIX = 'deltaPendingTruncateSeq:';
const BASELINE_PREFIX = 'deltaBaseline:';

const PRE_APPLY_BACKUP_SLOTS = 5;
const PRE_APPLY_BACKUP_SLOT_KEY = 'deltaPreApplyBackupSlot';
function preApplyBackupFilePath(template, slot) {
    return template.replaceAll('{slot}', String(slot));
}

function lastPushedSeqKey(deviceId) {
    return LAST_PUSHED_SEQ_PREFIX + deviceId;
}

function baselineKey(deviceId) {
    return BASELINE_PREFIX + deviceId;
}

function resetPendingKey(deviceId) {
    return RESET_PENDING_PREFIX + deviceId;
}

function pendingTruncateKey(deviceId) {
    return PENDING_TRUNCATE_PREFIX + deviceId;
}

function maxSeq(events, seed) {
    return events.reduce((max, e) => (e.seq > max ? e.seq : max), seed);
}

async function stampTabIdentity(newTab, source, log, label) {
    await Cache.setTabUid(newTab.id, source.uid).catch(log.onCatch([`cant set ${label}uid`, newTab.id], false));
    if (source.lastModified != null) {
        await Cache.setTabLastModified(newTab.id, source.lastModified)
            .catch(log.onCatch([`cant set ${label}lastModified`, newTab.id], false));
    }
}

DeltaLog.onOverflow(() => {
    const selfDeviceId = getDeviceId();
    delete storage[baselineKey(selfDeviceId)];
    delete storage[lastPushedSeqKey(selfDeviceId)];
    delete storage[pendingTruncateKey(selfDeviceId)];
    storage[resetPendingKey(selfDeviceId)] = '1';
});

function loadBaseline(deviceId) {
    const raw = storage[baselineKey(deviceId)];
    if (!raw) {
        return {tabUids: new Set(), groupIds: new Set(), optionKeys: new Set(), pinnedUids: new Set()};
    }
    try {
        const parsed = JSON.parse(raw);
        return {
            tabUids: new Set(parsed.tabUids || []),
            groupIds: new Set(parsed.groupIds || []),
            optionKeys: new Set(parsed.optionKeys || []),
            pinnedUids: new Set(parsed.pinnedUids || []),
        };
    } catch {
        return {tabUids: new Set(), groupIds: new Set(), optionKeys: new Set(), pinnedUids: new Set()};
    }
}

function saveBaseline(deviceId, baseline) {
    storage[baselineKey(deviceId)] = JSON.stringify({
        tabUids: baseline.tabUids || [],
        groupIds: baseline.groupIds || [],
        optionKeys: baseline.optionKeys || [],
        pinnedUids: baseline.pinnedUids || [],
    });
}

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
                favIconUrl: sanitizeFavIconUrl(tab.favIconUrl),
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
            favIconUrl: sanitizeFavIconUrl(tab.favIconUrl),
            ...(tab.discarded === false ? {loaded: true} : {}),
            id: tab.id,
        }));

    return {groups, pinnedTabs, options: {...syncedOptions}};
}

async function resolveBaseSnapshot(Cloud, cycle) {
    const snapshot = await Cloud.readFile(SNAPSHOT_FILE_NAME, null, cycle);
    if (snapshot) {
        return {snapshot, snapshotExists: true};
    }

    return {snapshot: {groups: [], watermark: {}}, snapshotExists: false};
}

async function resolvePulledDeltaLogs(Cloud, cycle) {
    const files = await Cloud.readAllMatching(DELTA_FILE_PREFIX, null, cycle);

    return (files || []).map(({name, content}) => ({
        deviceId: content?.deviceId ?? deviceIdFromDeltaFileName(name),
        events: Array.isArray(content?.events) ? content.events : [],
    }));
}

async function applyBrowserOps(browserOps, resolvedSnapshot) {
    const log = logger.start('applyBrowserOps', {
        groupsToCreate: browserOps.groupsToCreate.length,
        groupsToUpdate: browserOps.groupsToUpdate.length,
        groupsToRemove: browserOps.groupsToRemove.length,
        groupsReorder: browserOps.groupsOrder ? browserOps.groupsOrder.length : 0,
        tabsToCreate: browserOps.tabsToCreate.length,
        tabsToMove: browserOps.tabsToMove.length,
        tabsToUpdate: browserOps.tabsToUpdate?.length || 0,
        tabsToRemove: browserOps.tabsToRemove.length,
        pinnedToCreate: browserOps.pinnedToCreate?.length || 0,
        pinnedToMove: browserOps.pinnedToMove?.length || 0,
        pinnedToUpdate: browserOps.pinnedToUpdate?.length || 0,
        pinnedToRemove: browserOps.pinnedToRemove?.length || 0,
    });

    DeltaCapture.beginApply();

    const sleepOptions = await Storage.get(SLEEP_OPTION_KEYS);

    try {
        const needGroupWrite = browserOps.groupsToCreate.length
            || browserOps.groupsToUpdate.length
            || browserOps.groupsToRemove.length
            || browserOps.groupsOrder;

        if (needGroupWrite) {
            const endPhase = beginApplyPhase('groups-write', log);
            const {groups} = await Groups.load(null, false);
            const byId = new Map(groups.map(g => [g.id, g]));

            for (const props of browserOps.groupsToCreate) {
                if (!byId.has(props.id)) {
                    const created = {...Groups.create(props.id, props.title), ...props, tabs: []};
                    groups.push(created);
                    byId.set(created.id, created);
                }
            }

            const archiveTransitions = [];
            for (const props of browserOps.groupsToUpdate) {
                const existing = byId.get(props.id);
                if (existing) {
                    const {props: plainProps, archiveTransition} = extractArchiveTransition(existing.isArchive, props);
                    Object.assign(existing, plainProps);
                    if (archiveTransition !== null) {
                        archiveTransitions.push({groupId: existing.id, isArchive: archiveTransition});
                    }
                }
            }

            const removeIds = new Set(browserOps.groupsToRemove.map(g => g.id));
            for (const id of removeIds) {
                if (Groups.isLoaded(id)) {
                    await Groups.unload(id).catch(log.onCatch(['cant unload group', id], false));
                }
            }

            let nextGroups = groups.filter(g => !removeIds.has(g.id));

            if (browserOps.groupsOrder) {
                nextGroups = reorderGroups(nextGroups, browserOps.groupsOrder);
            }

            await Groups.save(nextGroups);

            for (const {groupId, isArchive} of archiveTransitions) {
                if (removeIds.has(groupId)) {
                    continue;
                }
                await Groups.setArchiveStateWhileHoldingLock(groupId, isArchive)
                    .catch(log.onCatch(['cant apply archive state', groupId], false));
            }
            endPhase();
        }

        const endCreatePhase = browserOps.tabsToCreate.length ? beginApplyPhase('tabs-create', log) : null;
        const liveByUidForCreate = await buildLiveTabIndexByUid();

        const createsByGroup = new Map();
        for (const tab of browserOps.tabsToCreate) {
            const groupId = tab.target?.groupId;
            if (groupId == null) {
                continue;
            }
            if (tab.uid != null && liveByUidForCreate.has(tab.uid)) {
                log.log('idempotent create: skip already-live tab uid', tab.uid);
                continue;
            }
            if (!createsByGroup.has(groupId)) {
                createsByGroup.set(groupId, []);
            }
            createsByGroup.get(groupId).push(tab);
        }

        for (const [groupId, allTabs] of createsByGroup) {
            const groupWindowId = Cache.getWindowId(groupId);

            const tabs = allTabs.filter(tab => {
                if (isUrlSyncable(unwrapStubUrl(tab.url))) {
                    return true;
                }
                log.log('skip create of url-less/blank tab record', tab.uid, tab.url);
                return false;
            });
            if (!tabs.length) {
                continue;
            }

            const toCreate = tabs.map(tab => ({
                url: tab.url,
                title: tab.title,
                cookieStoreId: tab.cookieStoreId,
                index: tab.target?.index,
                groupId,
                windowId: groupWindowId,
                favIconUrl: tab.favIconUrl,
                groupPinned: tab.pinned === true,
                discarded: shouldSleepSyncedTab(tab, false, sleepOptions),
            }));

            const created = await Tabs.createMultiple(toCreate, true);

            const createdPool = created.filter(Boolean);
            const usedCreated = new Set();

            const unmatchedSources = [];
            for (const source of tabs) {
                const match = createdPool.find(t => !usedCreated.has(t.id)
                    && liveUrlMatchesSource(t.url, source.url));
                if (match) {
                    usedCreated.add(match.id);
                    await stampTabIdentity(match, source, log, '');
                } else {
                    unmatchedSources.push(source);
                }
            }

            const remainingCreated = createdPool.filter(t => !usedCreated.has(t.id));
            for (let k = 0; k < unmatchedSources.length && k < remainingCreated.length; k++) {
                await stampTabIdentity(remainingCreated[k], unmatchedSources[k], log, '');
            }

            if (!Groups.isLoaded(groupId)) {
                await Tabs.hide(created, true).catch(log.onCatch(['cant hide tabs for group', groupId], false));
            } else if (tabs.some(tab => tab.pinned === true)) {
                await Groups.applyGroupPinnedOrder(groupId)
                    .catch(log.onCatch(['cant apply group-pinned order', groupId], false));
            }
        }
        endCreatePhase?.();

        if (browserOps.tabsToMove.length) {
            const endPhase = beginApplyPhase('tabs-move', log);
            const liveByUid = await buildLiveTabRecordByUid();

            for (const move of browserOps.tabsToMove) {
                const liveTab = liveByUid.get(move.uid);
                if (liveTab == null) {
                    continue;
                }
                await applyTabMove(liveTab, move.target || {}, log);
            }
            endPhase();
        }

        if (browserOps.tabsToUpdate?.length) {
            const endPhase = beginApplyPhase('tabs-update', log);
            const liveByUid = await buildLiveTabRecordByUid();

            for (const update of browserOps.tabsToUpdate) {
                const liveTab = liveByUid.get(update.uid);
                if (liveTab == null) {
                    continue;
                }
                await applyTabContentUpdate(liveTab, update.target || {}, log);
            }
            endPhase();
        }

        if (browserOps.tabsToRemove.length) {
            const endPhase = beginApplyPhase('tabs-remove', log);
            const liveByUid = await buildLiveTabIndexByUid();
            const removeIds = browserOps.tabsToRemove
                .map(t => liveByUid.get(t.uid))
                .filter(id => id != null);

            if (removeIds.length) {
                await Tabs.remove(removeIds.map(id => ({id})), true)
                    .catch(log.onCatch('cant remove tabs', false));
            }
            endPhase();
        }

        const endReconcile = beginApplyPhase('reconcile-group-tab-orders', log);
        await reconcileGroupTabOrders(resolvedSnapshot, log);
        endReconcile();

        const endPinned = beginApplyPhase('pinned-ops', log);
        await applyPinnedOps(browserOps, log, sleepOptions);
        endPinned();

        log.stop();
    } finally {
        DeltaCapture.endApply();
    }
}

async function reconcileGroupTabOrders(resolvedSnapshot, log) {
    const resolvedGroups = resolvedSnapshot?.groups;
    if (!Array.isArray(resolvedGroups) || !resolvedGroups.length) {
        return;
    }

    const resolvedOrderByGroupId = new Map();
    for (const group of resolvedGroups) {
        const uids = (Array.isArray(group.tabs) ? group.tabs : [])
            .map(tab => tab?.uid)
            .filter(uid => uid != null);
        if (uids.length) {
            resolvedOrderByGroupId.set(group.id, uids);
        }
    }
    if (!resolvedOrderByGroupId.size) {
        return;
    }

    const {groups: liveGroups} = await Groups.load(null, true);

    for (const group of liveGroups) {
        if (group.isArchive || !Array.isArray(group.tabs)) {
            continue;
        }
        const resolvedUidOrder = resolvedOrderByGroupId.get(group.id);
        if (!resolvedUidOrder) {
            continue;
        }

        const orderedIds = orderedGroupTabIds(resolvedUidOrder, group.tabs);
        if (!orderedIds.length) {
            continue;
        }

        const minIndex = Math.min(...group.tabs.map(tab => tab.index).filter(Number.isFinite));
        if (!Number.isFinite(minIndex)) {
            continue;
        }

        await Tabs.moveNative(orderedIds.map(id => ({id})), {index: minIndex}, true)
            .catch(log.onCatch(['cant reorder group tabs to resolved order', group.id], false));

        if (Groups.isLoaded(group.id) && group.tabs.some(tab => tab.groupPinned)) {
            await Groups.applyGroupPinnedOrder(group.id)
                .catch(log.onCatch(['cant re-apply group-pinned order after reorder', group.id], false));
        }
    }
}

async function applyPinnedOps(browserOps, log, sleepOptions = {}) {
    const toCreate = browserOps.pinnedToCreate || [];
    const toMove = browserOps.pinnedToMove || [];
    const toRemove = browserOps.pinnedToRemove || [];
    const toUpdate = browserOps.pinnedToUpdate || [];

    if (!toCreate.length && !toMove.length && !toRemove.length && !toUpdate.length) {
        return;
    }

    if (toCreate.length) {
        const liveByUidForCreate = new Map(
            (await getLivePinnedTabs()).filter(t => t.uid != null).map(t => [t.uid, t.id])
        );
        const pinnedToActuallyCreate = toCreate.filter(tab => {
            if (tab.uid != null && liveByUidForCreate.has(tab.uid)) {
                log.log('idempotent pinned create: skip already-live pinned uid', tab.uid);
                return false;
            }
            if (!isUrlSyncable(unwrapStubUrl(tab.url))) {
                log.log('skip create of url-less/blank pinned record', tab.uid, tab.url);
                return false;
            }
            return true;
        });

        const windowId = await Windows.getLastFocusedNormalWindow()
            .catch(log.onCatch('cant resolve normal window for pinned create', false));

        const createProps = pinnedToActuallyCreate.map(tab => ({
            url: tab.url,
            title: tab.title,
            cookieStoreId: tab.cookieStoreId,
            index: tab.target?.index,
            pinned: true,
            discarded: shouldSleepSyncedTab(tab, true, sleepOptions),
            windowId: Number.isFinite(windowId) ? windowId : undefined,
            favIconUrl: tab.favIconUrl,
        }));

        const created = await Tabs.createMultiple(createProps, true);
        const createdPool = (created || []).filter(Boolean);
        const usedCreated = new Set();

        const indexOf = source => source.target?.index;
        const matchesUrl = (t, source) => liveUrlMatchesSource(t.url, source.url);
        const urlCount = new Map();
        for (const source of pinnedToActuallyCreate) {
            urlCount.set(source.url, (urlCount.get(source.url) || 0) + 1);
        }

        const stillUnmatched = [];
        for (const source of pinnedToActuallyCreate) {
            let match = Number.isInteger(indexOf(source))
                ? createdPool.find(t => !usedCreated.has(t.id) && matchesUrl(t, source) && t.index === indexOf(source))
                : undefined;

            if (!match && urlCount.get(source.url) === 1) {
                match = createdPool.find(t => !usedCreated.has(t.id) && matchesUrl(t, source));
            }

            if (match) {
                usedCreated.add(match.id);
                await stampTabIdentity(match, source, log, 'pinned ');
            } else {
                stillUnmatched.push(source);
            }
        }

        if (stillUnmatched.length) {
            const remainingCreated = createdPool
                .filter(t => !usedCreated.has(t.id))
                .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
            const remainingSources = stillUnmatched
                .slice()
                .sort((a, b) => (indexOf(a) ?? 0) - (indexOf(b) ?? 0));
            for (let k = 0; k < remainingSources.length && k < remainingCreated.length; k++) {
                usedCreated.add(remainingCreated[k].id);
                await stampTabIdentity(remainingCreated[k], remainingSources[k], log, 'pinned ');
            }
            const leftover = remainingSources.length - remainingCreated.length;
            if (leftover > 0) {
                log.log('pinned create: more sources than created tabs, left unstamped', leftover);
            }
        }
    }

    if (toUpdate.length || toMove.length || toRemove.length) {
        const livePinned = await getLivePinnedTabs();
        const idByUid = new Map(livePinned.filter(t => t.uid != null).map(t => [t.uid, t.id]));
        const tabByUid = new Map(livePinned.filter(t => t.uid != null).map(t => [t.uid, t]));

        for (const update of toUpdate) {
            const liveTab = tabByUid.get(update.uid);
            if (liveTab == null) {
                continue;
            }
            await applyTabContentUpdate(liveTab, update.target || {}, log);
        }

        for (const move of toMove) {
            const tabId = idByUid.get(move.uid);
            if (tabId == null) {
                continue;
            }
            await Tabs.moveNative([{id: tabId}], {index: move.target?.index}, true)
                .catch(log.onCatch(['cant move pinned tab', move.uid], false));
        }

        const removeIds = toRemove
            .map(t => idByUid.get(t.uid))
            .filter(id => id != null);

        if (removeIds.length) {
            await Tabs.remove(removeIds.map(id => ({id})), true)
                .catch(log.onCatch('cant remove pinned tabs', false));
        }
    }
}

async function getLivePinnedTabs() {
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
                const uid = Cache.getTabUid(tab.id) || await Cache.setTabUid(tab.id).catch(() => null);
                tab.uid = uid;
                tab.lastModified = Cache.getTabLastModified(tab.id);
                return tab;
            })
    );
}

async function applyOptions(optionsToApply) {
    const keys = Object.keys(optionsToApply || {});
    if (!keys.length) {
        return;
    }

    const log = logger.start('applyOptions', {keys});

    DeltaCapture.beginApply();
    try {
        await backgroundSelf.saveOptions(optionsToApply);
        log.stop();
    } catch (e) {
        log.logError('cant apply options', e);
    } finally {
        DeltaCapture.endApply();
    }
}

function buildOutboundContainerMapping(pulledContainers) {
    const localContainers = Containers.query({temporaryContainers: false});

    const registry = {...(pulledContainers || {})};

    const mapToPortable = makeOutboundMapper(
        localContainers,
        registry,
        Containers.isDefault,
        Containers.isTemporary,
    );

    return {registry, mapToPortable};
}

function buildInboundContainerMapper(registry) {
    const findOrCreateMap = new Map();

    const findOrCreate = identity => {
        const key = identity.name + identity.color + identity.icon;
        return findOrCreateMap.has(key) ? findOrCreateMap.get(key) : Constants.DEFAULT_COOKIE_STORE_ID;
    };

    const mapper = makeInboundMapper(
        registry || {},
        Constants.DEFAULT_COOKIE_STORE_ID,
        findOrCreate,
        () => Constants.DEFAULT_COOKIE_STORE_ID,
    );

    return {mapper, findOrCreateMap};
}

async function resolveInboundContainers(registry, findOrCreateMap, log) {
    const containerStorageMap = new Map();

    for (const [, identity] of Object.entries(registry || {})) {
        const identityKey = identity.name + identity.color + identity.icon;
        if (findOrCreateMap.has(identityKey)) {
            continue;
        }
        const syntheticId = 'sync-container:' + identityKey;
        const cookieStoreId = await Containers.findExistOrCreateSimilar(syntheticId, identity, containerStorageMap)
            .catch(log.onCatch(['cant find-or-create container', identityKey], false));
        if (cookieStoreId) {
            findOrCreateMap.set(identityKey, cookieStoreId);
        }
    }
}

async function translateInboundContainers(browserOps, optionsToApply, containerRegistry, log) {
    const {mapper, findOrCreateMap} = buildInboundContainerMapper(containerRegistry);

    await resolveInboundContainers(containerRegistry, findOrCreateMap, log);

    for (const props of browserOps.groupsToCreate || []) {
        mapEventContainers({group: props}, mapper);
    }
    for (const props of browserOps.groupsToUpdate || []) {
        mapEventContainers({group: props}, mapper);
    }

    for (const tab of browserOps.tabsToCreate || []) {
        if (tab.cookieStoreId != null) {
            tab.cookieStoreId = mapper(tab.cookieStoreId);
        }
    }
    for (const tab of browserOps.pinnedToCreate || []) {
        if (tab.cookieStoreId != null) {
            tab.cookieStoreId = mapper(tab.cookieStoreId);
        }
    }

    if (optionsToApply && optionsToApply.defaultGroupProps) {
        mapStateContainers({options: optionsToApply}, mapper);
    }
}

function reorderGroups(groups, order) {
    const byId = new Map(groups.map(g => [g.id, g]));
    const placed = new Set();
    const result = [];

    for (const id of order) {
        const group = byId.get(id);
        if (group && !placed.has(id)) {
            result.push(group);
            placed.add(id);
        }
    }

    for (const group of groups) {
        if (!placed.has(group.id)) {
            result.push(group);
            placed.add(group.id);
        }
    }

    return result;
}

export function orderedGroupTabIds(resolvedUidOrder, liveTabs) {
    const live = (Array.isArray(liveTabs) ? liveTabs : []).filter(t => t && t.id != null);
    if (live.length < 2) {
        return [];
    }

    const byUid = new Map();
    for (const t of live) {
        if (t.uid != null && !byUid.has(t.uid)) {
            byUid.set(t.uid, t);
        }
    }

    const placed = new Set();
    const ordered = [];

    for (const uid of (Array.isArray(resolvedUidOrder) ? resolvedUidOrder : [])) {
        const t = byUid.get(uid);
        if (t && !placed.has(t.id)) {
            ordered.push(t);
            placed.add(t.id);
        }
    }
    for (const t of live) {
        if (!placed.has(t.id)) {
            ordered.push(t);
            placed.add(t.id);
        }
    }

    const orderedIds = ordered.map(t => t.id);

    const sameOrder = orderedIds.length === live.length
        && orderedIds.every((id, i) => id === live[i].id);

    return sameOrder ? [] : orderedIds;
}

async function buildLiveTabRecordByUid() {
    const {groups} = await Groups.load(null, true);
    const byUid = new Map();
    for (const group of groups) {
        if (group.isArchive || !Array.isArray(group.tabs)) {
            continue;
        }
        for (const tab of group.tabs) {
            if (tab.uid != null && tab.id != null) {
                byUid.set(tab.uid, tab);
            }
        }
    }
    return byUid;
}

async function buildLiveTabIndexByUid() {
    const byUid = new Map();
    for (const [uid, tab] of await buildLiveTabRecordByUid()) {
        byUid.set(uid, tab.id);
    }
    return byUid;
}

async function applyTabMove(liveTab, target, log) {
    const groupId = target.groupId;
    const destinationWindowId = groupId != null ? Cache.getWindowId(groupId) : null;
    const groupChanged = groupId != null && Cache.getTabGroup(liveTab.id) !== groupId;

    if (!groupChanged) {
        const moveProps = {index: target.index};
        if (Number.isFinite(destinationWindowId)) {
            moveProps.windowId = destinationWindowId;
        }
        await Tabs.moveNative([{id: liveTab.id}], moveProps, true)
            .catch(log.onCatch(['cant move tab', liveTab.id], false));
        return;
    }

    if (Number.isFinite(destinationWindowId)) {
        await Tabs.moveNative([{id: liveTab.id}], {index: target.index, windowId: destinationWindowId}, true)
            .catch(log.onCatch(['cant move tab', liveTab.id], false));
        if (liveTab.hidden) {
            await Tabs.show([{id: liveTab.id}], true)
                .catch(log.onCatch(['cant show moved tab', liveTab.id], false));
        }
    } else if (!liveTab.hidden) {
        await Tabs.hide([{id: liveTab.id}], true)
            .catch(log.onCatch(['cant hide moved tab', liveTab.id], false));
    }

    await Cache.setTabGroup(liveTab.id, groupId)
        .catch(log.onCatch(['cant set moved tab group', liveTab.id], false));
}

async function applyTabContentUpdate(liveTab, target, log) {
    const liveId = liveTab.id;

    if (Object.hasOwn(target, 'url') || Object.hasOwn(target, 'title') || Object.hasOwn(target, 'favIconUrl')) {
        const nextUrl = Object.hasOwn(target, 'url') ? target.url : liveTab.url;
        const nextTitle = Object.hasOwn(target, 'title') ? target.title : liveTab.title;

        Cache.setTab({
            id: liveId,
            url: nextUrl,
            title: nextTitle,
            favIconUrl: Object.hasOwn(target, 'favIconUrl') ? target.favIconUrl : liveTab.favIconUrl,
            cookieStoreId: liveTab.cookieStoreId,
            status: liveTab.status,
        });

        if (Object.hasOwn(target, 'favIconUrl')) {
            await Cache.setTabFavIcon(liveId, target.favIconUrl)
                .catch(log.onCatch(['cant set favIcon (update)', liveId], false));
        }

        if (Object.hasOwn(target, 'url') && liveTab.discarded !== true
            && isUrlSyncable(unwrapStubUrl(target.url))
            && shouldNavigateLiveTabUrl(liveTab.url, target.url)) {
            await browser.tabs.update(liveId, {url: target.url})
                .catch(log.onCatch(['cant update tab url', liveId], false));
        }
    }

    if (Object.hasOwn(target, 'pinned') && Cache.getTabGroupPinned(liveId) !== (target.pinned === true)) {
        await Groups.setTabGroupPinned(liveId, target.pinned === true)
            .catch(log.onCatch(['cant set group-pin (update)', liveId], false));
    }
}

let inProgress = false;

const USER_DEFER_RESCHEDULE_MINUTES = 0.2;

const LOCK_CONTENDED_RESCHEDULE_MINUTES = 0.5;

async function rescheduleSoon(log, delayInMinutes, reason) {
    try {
        await browser.alarms.create(ALARM_NAME_RETRY, {delayInMinutes});
    } catch (e) {
        log.warn(`cant reschedule ${reason} sync; will run on next periodic alarm`, String(e));
    }
}

function rescheduleSoonAfterDefer(log) {
    return rescheduleSoon(log, USER_DEFER_RESCHEDULE_MINUTES, 'deferred');
}

function rescheduleSoonAfterLockContention(log) {
    return rescheduleSoon(log, LOCK_CONTENDED_RESCHEDULE_MINUTES, 'lock-contended');
}

export async function resetSyncState() {
    if (inProgress) {
        return {ok: false, inProgress: true};
    }

    inProgress = true;

    const log = logger.start(resetSyncState);

    const selfDeviceId = getDeviceId();

    try {
        storage[resetPendingKey(selfDeviceId)] = '1';

        delete storage[baselineKey(selfDeviceId)];
        delete storage[lastPushedSeqKey(selfDeviceId)];
        delete storage[pendingTruncateKey(selfDeviceId)];

        await DeltaLog.clear();

        log.stop('reset local delta-sync state (cloud untouched)', {selfDeviceId});

        return {ok: true};
    } finally {
        inProgress = false;
    }
}

export function extractArchiveTransition(currentIsArchive, props) {
    if (!props || !Object.hasOwn(props, 'isArchive')) {
        return {props, archiveTransition: null};
    }

    const {isArchive, ...plainProps} = props;

    if (Boolean(isArchive) === Boolean(currentIsArchive)) {
        return {props, archiveTransition: null};
    }

    return {props: plainProps, archiveTransition: Boolean(isArchive)};
}

export function summarizeOps(browserOps, optionsToApply) {
    const ops = browserOps || {};
    const len = arr => (Array.isArray(arr) ? arr.length : 0);

    const groupsChanged = !!(
        len(ops.groupsToCreate) || len(ops.groupsToUpdate)
        || len(ops.groupsToRemove) || ops.groupsOrder
    );

    const anyBrowserOp = !!(
        groupsChanged
        || len(ops.tabsToCreate) || len(ops.tabsToMove) || len(ops.tabsToRemove) || len(ops.tabsToUpdate)
        || len(ops.pinnedToCreate) || len(ops.pinnedToMove) || len(ops.pinnedToRemove) || len(ops.pinnedToUpdate)
    );

    const anyOption = Object.keys(optionsToApply || {}).length > 0;

    return {
        anyBrowserOp,
        anyOption,
        groupsChanged,
        mutatesBrowser: anyBrowserOp || anyOption,
    };
}

function planMutatesBrowser(plan) {
    return summarizeOps(plan.browserOps, plan.optionsToApply).mutatesBrowser;
}

async function maybeBackupBeforeApply(plan, log) {
    if (!planMutatesBrowser(plan)) {
        return;
    }

    const {syncBackupBeforeApply, syncBackupFilePath, syncBackupLocation} = await Storage.get([
        'syncBackupBeforeApply',
        'syncBackupFilePath',
        'syncBackupLocation',
    ]);
    if (!syncBackupBeforeApply) {
        return;
    }

    const prevSlot = Number(storage[PRE_APPLY_BACKUP_SLOT_KEY]);
    const slot = Number.isInteger(prevSlot) && prevSlot >= 0 ? prevSlot % PRE_APPLY_BACKUP_SLOTS : 0;

    log.info('pre-apply safety backup', {slot});

    await backgroundSelf.createBackup(true, false, false, preApplyBackupFilePath(syncBackupFilePath, slot), syncBackupLocation);

    storage[PRE_APPLY_BACKUP_SLOT_KEY] = (slot + 1) % PRE_APPLY_BACKUP_SLOTS;
}

async function gatherLocalPending(selfDeviceId, log) {
    const priorBaseline = loadBaseline(selfDeviceId);

    const {groups: loadedGroups} = await Groups.load(null, true, true);
    const syncedKeys = syncedOptionKeys(Constants.ALL_OPTION_KEYS);
    const allLocalOptions = await Storage.get(syncedKeys);
    const localSyncedOptions = {};
    for (const key of syncedKeys) {
        localSyncedOptions[key] = allLocalOptions[key];
    }
    const livePinnedTabs = await getLivePinnedTabs();
    const localState = buildLocalState(loadedGroups, localSyncedOptions, livePinnedTabs);

    const localLogEvents = await DeltaLog.getEvents();
    const logUids = new Set();
    const logGroupIds = new Set();
    const logOptionKeys = new Set();
    for (const event of localLogEvents) {
        if (event.groupId != null) {
            logGroupIds.add(event.groupId);
        }
        if (event.group?.id != null) {
            logGroupIds.add(event.group.id);
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

    const bootstrapEvents = computeBootstrapEvents(localState, priorBaseline, logUids, logGroupIds, logOptionKeys);
    await DeltaLog.appendMany(bootstrapEvents);
    if (bootstrapEvents.length) {
        log.info('bootstrap-uploaded never-synced local items', {count: bootstrapEvents.length});
    }

    const lastPushedSeq = Number(storage[lastPushedSeqKey(selfDeviceId)]) || 0;

    return {localState, priorBaseline, lastPushedSeq};
}

async function pushLocalPendingOnly(Cloud, selfDeviceId, localPendingEvents, lastPushedSeq, cycle, log) {
    if (!localPendingEvents.length) {
        return {pushed: false};
    }

    const {mapToPortable} = buildOutboundContainerMapping(null);
    const allEvents = await DeltaLog.getEvents();
    for (const event of allEvents) {
        mapEventContainers(event, mapToPortable);
    }

    await Cloud.writeFiles({
        [deltaFileName(selfDeviceId)]: {
            v: DeltaLog.SCHEMA_VERSION,
            deviceId: selfDeviceId,
            events: allEvents,
        },
    }, null, cycle);

    storage[lastPushedSeqKey(selfDeviceId)] = maxSeq(localPendingEvents, lastPushedSeq);

    log.info('conditional fast path: pushed local pending without pull/apply', {
        events: localPendingEvents.length,
    });

    return {pushed: true};
}

export async function deltaSynchronization() {
    const syncResult = {ok: false};

    if (inProgress) {
        syncResult.inProgress = true;
        return syncResult;
    }

    const log = logger.start(deltaSynchronization);
    let lastProgress = 0;

    const progress = percent => {
        lastProgress = percent;
        send('sync-progress', {progress: percent});
    };

    let Cloud = null;
    let lockAcquired = false;

    try {
        inProgress = true;
        send('sync-start');
        progress(1);

        const {syncOptionsLocation, syncProvider} = await Storage.get(['syncOptionsLocation', 'syncProvider']);

        if (syncOptionsLocation === Constants.SYNC_STORAGE_FSYNC && !SyncStorage.IS_AVAILABLE) {
            const error = new CloudError('ffSyncNotSupported');
            storage.lastError = String(error);
            log.throwError('sync not supported', error);
        }

        const syncOptions = syncOptionsLocation === Constants.SYNC_STORAGE_FSYNC
            ? await SyncStorage.get()
            : await Storage.get(null, Constants.DEFAULT_SYNC_OPTIONS);

        invalidateCaptureGate();

        try {
            Cloud = createCloudProvider(syncProvider, syncOptions);
        } catch (error) {
            const cloudError = new CloudError(error.message, {cause: error});
            storage.lastError = String(cloudError);
            log.throwError('create cloud provider instance', cloudError);
        }

        const selfDeviceId = getDeviceId();

        progress(10);

        const {localState, priorBaseline, lastPushedSeq} =
            await gatherLocalPending(selfDeviceId, log);
        let localPendingEvents = await DeltaLog.getEventsSince(lastPushedSeq);

        const resetPending = !!storage[resetPendingKey(selfDeviceId)];

        const cycle = Cloud.beginSyncCycle ? await Cloud.beginSyncCycle() : null;
        const remoteUnchanged = !resetPending && !!cycle?.unchanged;
        if (remoteUnchanged) {
            const {pushed} = await pushLocalPendingOnly(
                Cloud, selfDeviceId, localPendingEvents, lastPushedSeq, cycle, log,
            );

            Cloud.commitSyncCycle?.(cycle);

            progress(100);
            syncResult.ok = true;
            syncResult.progress = 100;
            syncResult.skippedPull = true;
            syncResult.changes = {local: false, cloud: pushed};

            send('sync-end', syncResult);
            log.stop('remote unchanged: skipped pull/apply', {pushedLocalPending: pushed});
            return syncResult;
        }

        if (Cloud.acquireLock) {
            lockAcquired = await Cloud.acquireLock(selfDeviceId, null, cycle);
            if (!lockAcquired) {
                log.info('advisory lock held by a peer; skipping this cycle, retry soon');
                await rescheduleSoonAfterLockContention(log);

                progress(100);
                syncResult.ok = true;
                syncResult.progress = 100;
                syncResult.lockContended = true;
                syncResult.changes = {local: false, cloud: false};

                send('sync-end', syncResult);
                log.stop('advisory lock contended: skipped cycle');
                return syncResult;
            }
        }

        const {snapshot: pulledSnapshot, snapshotExists} = await resolveBaseSnapshot(Cloud, cycle);
        progress(30);
        const pulledDeltaLogs = await resolvePulledDeltaLogs(Cloud, cycle);
        progress(45);

        if (resetPending) {
            const cloudSelfWatermark = Number(pulledSnapshot?.watermark?.[selfDeviceId]) || 0;
            const pulledSelfLog = (pulledDeltaLogs || []).find(dl => dl.deviceId === selfDeviceId);
            const highestCloudSelfSeq = (pulledSelfLog?.events || []).reduce(
                (max, e) => (Number(e.seq) > max ? Number(e.seq) : max), 0,
            );
            const floor = Math.max(cloudSelfWatermark, highestCloudSelfSeq);
            const shifted = await DeltaLog.fastForwardSeqsAbove(floor);
            if (shifted) {
                localPendingEvents = await DeltaLog.getEventsSince(lastPushedSeq);
                log.info('E2: fast-forwarded local log above stale cloud watermark/delta after reset', {
                    cloudSelfWatermark,
                    highestCloudSelfSeq,
                    floor,
                    pendingEvents: localPendingEvents.length,
                });
            }
            delete storage[resetPendingKey(selfDeviceId)];
        }

        const pendingTruncateSeq = Number(storage[pendingTruncateKey(selfDeviceId)]) || 0;
        const {confirmed: deferredTruncateConfirmed, truncateSeq: confirmedTruncateSeq} =
            resolveDeferredTruncation(pendingTruncateSeq, pulledSnapshot?.watermark, selfDeviceId);

        const {shouldCompact, unfoldedCount} = evaluateCompaction(
            pulledDeltaLogs, pulledSnapshot?.watermark,
        );

        const {registry: containerRegistry, mapToPortable} = buildOutboundContainerMapping(pulledSnapshot.containers);
        mapStateContainers(localState, mapToPortable);
        for (const event of localPendingEvents) {
            mapEventContainers(event, mapToPortable);
        }

        progress(50);

        const plan = planSync({
            pulledSnapshot,
            pulledDeltaLogs,
            localPendingEvents,
            selfDeviceId,
            localState,
            priorBaseline,
        });

        plan.resolvedSnapshot.containers = {...plan.resolvedSnapshot.containers, ...containerRegistry};

        const resolvedEmpty = (plan.resolvedSnapshot.groups || []).length === 0
            && (plan.resolvedSnapshot.pinnedTabs || []).length === 0;
        const localHasState = (localState.groups || []).length > 0
            || (localState.pinnedTabs || []).length > 0;
        if (resolvedEmpty && localHasState) {
            log.warn('resolved state empty but local has groups/pinned - suppressing removals this round');
            plan.browserOps.groupsToRemove = [];
            plan.browserOps.tabsToRemove = [];
            plan.browserOps.pinnedToRemove = [];
        }

        log.info('plan', {
            ops: {
                groupsToCreate: plan.browserOps.groupsToCreate.length,
                groupsToUpdate: plan.browserOps.groupsToUpdate.length,
                groupsToRemove: plan.browserOps.groupsToRemove.length,
                tabsToCreate: plan.browserOps.tabsToCreate.length,
                tabsToMove: plan.browserOps.tabsToMove.length,
                tabsToRemove: plan.browserOps.tabsToRemove.length,
                pinnedToCreate: plan.browserOps.pinnedToCreate.length,
                pinnedToMove: plan.browserOps.pinnedToMove.length,
                pinnedToRemove: plan.browserOps.pinnedToRemove.length,
            },
            willPush: !!plan.deltaFileToWrite,
        });

        progress(55);

        await translateInboundContainers(plan.browserOps, plan.optionsToApply, plan.resolvedSnapshot.containers, log);

        await maybeBackupBeforeApply(plan, log);

        currentApplyPhase = null;
        const applyStartedAt = Date.now();
        const applyOutcome = await runSyncApply(async () => {
            await applyBrowserOps(plan.browserOps, plan.resolvedSnapshot);

            const endOptions = beginApplyPhase('apply-options', log);
            await applyOptions(plan.optionsToApply);
            endOptions();

            const {groupsChanged} = summarizeOps(plan.browserOps, plan.optionsToApply);
            if (groupsChanged) {
                const endMenus = beginApplyPhase('menus-rebuild', log);
                const {groups: rebuiltGroups} = await Groups.load(null, false);
                await MenusMain.groupsUpdated(rebuiltGroups)
                    .catch(log.onCatch('cant rebuild group menus after delta sync', false));
                endMenus();
            }
            currentApplyPhase = null;
        }, {
            watchdogMs: DEFAULT_SYNC_APPLY_WATCHDOG_MS,
            onWatchdog: ({elapsedMs}) => {
                log.warn('SYNC APPLY WATCHDOG TRIPPED: apply exceeded the held-lock bound; releasing the user-priority lock so user actions recover. Apply continues detached.', {
                    stuckPhase: currentApplyPhase,
                    elapsedMs,
                    watchdogMs: DEFAULT_SYNC_APPLY_WATCHDOG_MS,
                    sinceApplyStartMs: Date.now() - applyStartedAt,
                });
            },
        });

        if (applyOutcome.deferred || applyOutcome.watchdog) {
            log.info('apply did not complete this cycle: skipping push/watermark/baseline; rescheduling sync soon', {
                deferred: applyOutcome.deferred === true,
                watchdog: applyOutcome.watchdog === true,
                userActive: isUserActive(),
            });
            await rescheduleSoonAfterDefer(log);

            syncResult.ok = true;
            syncResult.deferred = applyOutcome.deferred === true;
            syncResult.watchdog = applyOutcome.watchdog === true;
            syncResult.progress = lastProgress;
            syncResult.changes = {local: false, cloud: false};

            send('sync-end', syncResult);
            log.stop(applyOutcome.watchdog ? 'apply watchdog tripped: no push this cycle' : 'deferred to user');
            return syncResult;
        }

        progress(85);

        const writeSnapshot = shouldCompact || !snapshotExists;

        const cloudSelfTruncateSeq = deferredTruncateConfirmed ? confirmedTruncateSeq : 0;

        const filesToWrite = {};
        if (writeSnapshot) {
            filesToWrite[SNAPSHOT_FILE_NAME] = plan.resolvedSnapshot;
        }
        if (plan.deltaFileToWrite) {
            const selfEvents = cloudSelfTruncateSeq > 0
                ? truncateSelfEvents(plan.deltaFileToWrite.events, cloudSelfTruncateSeq)
                : plan.deltaFileToWrite.events;
            filesToWrite[deltaFileName(selfDeviceId)] = {
                v: DeltaLog.SCHEMA_VERSION,
                deviceId: plan.deltaFileToWrite.deviceId,
                events: selfEvents,
            };
        }

        if (Object.keys(filesToWrite).length) {
            await Cloud.writeFiles(filesToWrite, null, cycle);
        }

        if (plan.deltaFileToWrite) {
            storage[lastPushedSeqKey(selfDeviceId)] = maxSeq(plan.deltaFileToWrite.events, lastPushedSeq);
        }

        if (deferredTruncateConfirmed && confirmedTruncateSeq > 0) {
            await DeltaLog.clearUpTo(confirmedTruncateSeq);
            delete storage[pendingTruncateKey(selfDeviceId)];
            log.info('deferred truncation CONFIRMED: cloud snapshot durably carries folded events; truncated own log', {
                truncatedUpToSeq: confirmedTruncateSeq,
                cloudSelfWatermark: Number(pulledSnapshot?.watermark?.[selfDeviceId]) || 0,
            });
        }

        if (shouldCompact) {
            const foldedSelfSeq = selfFoldedSeq(plan.newWatermark, selfDeviceId, lastPushedSeq);
            if (foldedSelfSeq > 0) {
                const newPending = Math.max(pendingTruncateSeq, foldedSelfSeq);
                storage[pendingTruncateKey(selfDeviceId)] = newPending;
                log.info('compaction: wrote snapshot base + recorded DEFERRED self-truncation marker', {
                    unfoldedCount,
                    pendingTruncateSeq: newPending,
                    newWatermark: plan.newWatermark,
                });
            } else {
                log.info('compaction: rewrote snapshot base (nothing foldable to defer-truncate)', {
                    unfoldedCount,
                    newWatermark: plan.newWatermark,
                });
            }
        }

        progress(90);

        saveBaseline(selfDeviceId, baselineFromSnapshot(plan.resolvedSnapshot));

        Cloud.commitSyncCycle?.(cycle);

        progress(100);

        syncResult.ok = true;
        syncResult.progress = 100;

        syncResult.changes = {
            local: summarizeOps(plan.browserOps, plan.optionsToApply).mutatesBrowser,
            cloud: !!plan.deltaFileToWrite,
        };

        send('sync-end', syncResult);
        log.stop();
    } catch (e) {
        syncResult.langId = e.langId;
        syncResult.progress = lastProgress;
        Object.assign(syncResult, {message: String(e), stack: e.stack});

        send('sync-error', syncResult);
        log.logError('cant delta sync', e);
        log.stopError();
    } finally {
        if (lockAcquired && Cloud?.releaseLock) {
            await Cloud.releaseLock().catch(e =>
                log.warn('cant release advisory lock; TTL will reclaim it', String(e)));
        }
        inProgress = false;
        send('sync-finish', syncResult);
    }

    return syncResult;
}
