import * as Storage from '/js/storage.js';
import * as Tabs from '/js/tabs.js';
import * as Groups from '/js/groups.js';
import * as Windows from '/js/windows.js';
import * as Cache from '/js/cache.js';
import backgroundSelf from '/js/background.js';
import Logger from '/js/logger.js';
import * as DeltaCapture from './delta-capture.js';
import {shouldSleepSyncedTab, SLEEP_OPTION_KEYS} from './tab-sleep.js';
import {isUrlSyncable, unwrapStubUrl, liveUrlMatchesSource, shouldNavigateLiveTabUrl} from './url-sync.js';
import {getLivePinnedTabs} from './local-state.js';

const logger = new Logger('DeltaSyncApply');

let currentApplyPhase = null;

export function getCurrentApplyPhase() {
    return currentApplyPhase;
}

export function resetApplyPhase() {
    currentApplyPhase = null;
}

export function beginApplyPhase(name, log) {
    currentApplyPhase = name;
    const startedAt = Date.now();
    return function endPhase() {
        log.log('apply phase done', {phase: name, ms: Date.now() - startedAt});
    };
}

async function stampTabIdentity(newTab, source, log, label) {
    await Cache.setTabUid(newTab.id, source.uid).catch(log.onCatch([`cant set ${label}uid`, newTab.id], false));
    if (source.lastModified != null) {
        await Cache.setTabLastModified(newTab.id, source.lastModified)
            .catch(log.onCatch([`cant set ${label}lastModified`, newTab.id], false));
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
        const liveGroupTabsByUid = await buildLiveTabIndexByUid();
        const pinnedToActuallyCreate = toCreate.filter(tab => {
            if (tab.uid != null && (liveByUidForCreate.has(tab.uid) || liveGroupTabsByUid.has(tab.uid))) {
                log.log('idempotent pinned create: skip already-live uid', tab.uid);
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

export async function applyOptions(optionsToApply) {
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

export async function applyBrowserOps(browserOps, resolvedSnapshot) {
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

            const removeIds = new Set(
                browserOps.groupsToRemove
                    .filter(g => !Groups.isPinnedGroupId(g.id))
                    .map(g => g.id)
            );
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
        const livePinnedByUid = browserOps.tabsToCreate.length
            ? new Map((await getLivePinnedTabs()).filter(t => t.uid != null).map(t => [t.uid, t.id]))
            : new Map();

        const createsByGroup = new Map();
        for (const tab of browserOps.tabsToCreate) {
            const groupId = tab.target?.groupId;
            if (groupId == null) {
                continue;
            }
            if (tab.uid != null && (liveByUidForCreate.has(tab.uid) || livePinnedByUid.has(tab.uid))) {
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
