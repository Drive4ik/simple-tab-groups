import Logger from '/js/logger.js';
import * as Cache from '/js/cache.js';
import * as Constants from '/js/constants.js';
import * as DeltaLog from './delta-log.js';
import {syncedOptionKeys} from './option-keys.js';
import {isUrlSyncable, unwrapStubUrl, sanitizeFavIconUrl, sanitizeGroupRecordForSync} from './url-sync.js';
import {computeGroupRelativeIndex} from './group-relative-index.js';
import {isAppliedNavigationEcho} from './applied-nav-echo.js';

const logger = new Logger('DeltaCapture');

let applyDepth = 0;

export function beginApply() {
    applyDepth++;
}

export function endApply() {
    if (applyDepth > 0) {
        applyDepth--;
        if (applyDepth === 0) {
            lastApplyEndedAt = Date.now();
        }
    }
}

function isApplying() {
    return applyDepth > 0;
}

const appliedNavTabs = new Map();
const APPLIED_NAV_WINDOW_MS = 4_000;
let lastApplyEndedAt = 0;

export function shouldArmAppliedNavigation() {
    return isApplying() || (Date.now() - lastApplyEndedAt) < APPLIED_NAV_WINDOW_MS;
}

export function markAppliedNavigation(tabId, url) {
    if (!Number.isFinite(tabId)) {
        return;
    }
    const existing = appliedNavTabs.get(tabId);
    const expiry = Date.now() + APPLIED_NAV_WINDOW_MS;
    const markUrl = (existing && existing.url != null)
        ? existing.url
        : (typeof url === 'string' ? unwrapStubUrl(url) : undefined);
    appliedNavTabs.set(tabId, {expiry, url: markUrl});
}

export function clearAppliedNavigation(tabId) {
    appliedNavTabs.delete(tabId);
}

function consumeAppliedNavigationEcho(tabId, observedUrl) {
    const mark = appliedNavTabs.get(tabId);
    const now = Date.now();
    const echo = isAppliedNavigationEcho({
        applying: isApplying(),
        markExpiry: mark?.expiry,
        markUrl: mark?.url,
        observedUrl: typeof observedUrl === 'string' ? unwrapStubUrl(observedUrl) : observedUrl,
        now,
    });
    if (mark != null && now >= mark.expiry) {
        appliedNavTabs.delete(tabId);
    }
    return echo;
}

async function resolveUid(tabId) {
    const uid = Cache.getTabUid(tabId);
    if (uid) {
        return uid;
    }
    try {
        return await Cache.setTabUid(tabId);
    } catch {
        return null;
    }
}

async function getGroupRelativeIndex(tabId, windowId, groupId) {
    try {
        if (!Number.isFinite(windowId) || !groupId) {
            return null;
        }

        const windowTabs = await browser.tabs.query({windowId});

        return computeGroupRelativeIndex(windowTabs, Cache.getTabGroup, tabId, groupId);
    } catch {
        return null;
    }
}

function buildBaseTabRecord(tab, uid, snapshot) {
    return {
        uid,
        url: unwrapStubUrl(tab.url),
        title: tab.title,
        cookieStoreId: tab.cookieStoreId,
        favIconUrl: sanitizeFavIconUrl(tab.favIconUrl ?? snapshot?.favIconUrl),
        lastModified: snapshot?.lastModified ?? Cache.getTabLastModified(tab.id),
    };
}

function buildTabRecord(tab, uid, groupRelativeIndex, snapshot = null) {
    const record = buildBaseTabRecord(tab, uid, snapshot);
    if (Number.isInteger(groupRelativeIndex)) {
        record.index = groupRelativeIndex;
    }
    record.pinned = (snapshot ? snapshot.groupPinned : Cache.getTabGroupPinned(tab.id)) === true;
    record.loaded = tab.discarded === false;
    return record;
}

async function tabAddItem(tab) {
    const groupId = Cache.getTabGroup(tab.id);
    if (!groupId) {
        return null;
    }

    if (!isUrlSyncable(unwrapStubUrl(tab.url))) {
        return null;
    }

    const uid = await resolveUid(tab.id);
    if (!uid) {
        return null;
    }

    const index = await getGroupRelativeIndex(tab.id, tab.windowId, groupId);

    return {
        op: DeltaLog.OPS.TAB_ADD,
        groupId,
        tab: buildTabRecord(tab, uid, index),
    };
}

export async function tabAdded(tab) {
    try {
        if (isApplying()) {
            return;
        }

        const item = await tabAddItem(tab);
        if (!item) {
            return;
        }

        const {op, ...payload} = item;
        await DeltaLog.append(op, payload);
    } catch (e) {
        logger.onCatch('tabAdded', false)(e);
    }
}

export async function tabsAdded(tabs) {
    try {
        if (isApplying()) {
            return;
        }

        const items = [];
        for (const tab of tabs) {
            const item = await tabAddItem(tab);
            if (item) {
                items.push(item);
            }
        }

        await DeltaLog.appendMany(items);
    } catch (e) {
        logger.onCatch('tabsAdded', false)(e);
    }
}

export async function tabModified(tab, snapshot = null) {
    try {
        if (isApplying()) {
            return;
        }

        if (consumeAppliedNavigationEcho(tab.id, tab.url)) {
            return;
        }

        const groupId = snapshot?.groupId ?? Cache.getTabGroup(tab.id);
        if (!groupId) {
            return;
        }

        if (!isUrlSyncable(unwrapStubUrl(tab.url))) {
            return;
        }

        const uid = snapshot?.uid || await resolveUid(tab.id);
        if (!uid) {
            return;
        }

        const index = await getGroupRelativeIndex(tab.id, tab.windowId, groupId);

        await DeltaLog.append(DeltaLog.OPS.TAB_MODIFY, {
            groupId,
            tab: buildTabRecord(tab, uid, index, snapshot),
        });
    } catch (e) {
        logger.onCatch('tabModified', false)(e);
    }
}

export async function tabMoved(tabId) {
    try {
        if (isApplying()) {
            return;
        }

        const groupId = Cache.getTabGroup(tabId);
        if (!groupId) {
            return;
        }

        const uid = await resolveUid(tabId);
        if (!uid) {
            return;
        }

        const windowId = Cache.getWindowId(groupId);
        const groupRelativeIndex = await getGroupRelativeIndex(tabId, windowId, groupId);

        if (Cache.getTabGroup(tabId) !== groupId) {
            return;
        }

        const payload = {groupId, uid};
        if (Number.isInteger(groupRelativeIndex)) {
            payload.toIndex = groupRelativeIndex;
        }

        await DeltaLog.append(DeltaLog.OPS.TAB_MOVE, payload);
    } catch (e) {
        logger.onCatch('tabMoved', false)(e);
    }
}

export async function tabRemoved(uid, groupId) {
    try {
        if (isApplying()) {
            return;
        }

        if (!uid || !groupId) {
            return;
        }

        await DeltaLog.append(DeltaLog.OPS.TAB_REMOVE, {
            groupId,
            uid,
        });
    } catch (e) {
        logger.onCatch('tabRemoved', false)(e);
    }
}

export async function groupAdded(group) {
    try {
        if (isApplying()) {
            return;
        }

        await DeltaLog.append(DeltaLog.OPS.GROUP_ADD, {group: sanitizeGroupRecordForSync(group)});
    } catch (e) {
        logger.onCatch('groupAdded', false)(e);
    }
}

export async function groupModified(fullGroup) {
    try {
        if (isApplying()) {
            return;
        }

        await DeltaLog.append(DeltaLog.OPS.GROUP_MODIFY, {group: sanitizeGroupRecordForSync(fullGroup)});
    } catch (e) {
        logger.onCatch('groupModified', false)(e);
    }
}

export async function groupMoved(groupId, toIndex) {
    try {
        if (isApplying()) {
            return;
        }

        if (groupId == null || !Number.isInteger(toIndex)) {
            return;
        }

        await DeltaLog.append(DeltaLog.OPS.GROUP_MOVE, {groupId, toIndex});
    } catch (e) {
        logger.onCatch('groupMoved', false)(e);
    }
}

export async function groupRemoved(groupId) {
    try {
        if (isApplying()) {
            return;
        }

        await DeltaLog.append(DeltaLog.OPS.GROUP_REMOVE, {groupId});
    } catch (e) {
        logger.onCatch('groupRemoved', false)(e);
    }
}

const SYNCED_OPTION_KEYS = new Set(syncedOptionKeys(Constants.ALL_OPTION_KEYS));

export async function optionsChanged(savedOptions) {
    try {
        if (isApplying()) {
            return;
        }

        const items = Object.entries(savedOptions || {})
            .filter(([key]) => SYNCED_OPTION_KEYS.has(key))
            .map(([key, value]) => ({op: DeltaLog.OPS.OPTION_SET, key, value}));

        await DeltaLog.appendMany(items);
    } catch (e) {
        logger.onCatch('optionsChanged', false)(e);
    }
}

function buildPinnedRecord(tab, uid, snapshot = null) {
    const record = buildBaseTabRecord(tab, uid, snapshot);
    if (Number.isInteger(tab.index)) {
        record.index = tab.index;
    }
    record.loaded = tab.discarded === false;
    return record;
}

export async function pinnedAdded(tab) {
    try {
        if (isApplying()) {
            return;
        }

        if (!isUrlSyncable(unwrapStubUrl(tab.url))) {
            return;
        }

        const uid = await resolveUid(tab.id);
        if (!uid) {
            return;
        }

        await DeltaLog.append(DeltaLog.OPS.PINNED_ADD, {
            tab: buildPinnedRecord(tab, uid),
        });
    } catch (e) {
        logger.onCatch('pinnedAdded', false)(e);
    }
}

export async function pinnedModified(tab, snapshot = null) {
    try {
        if (isApplying()) {
            return;
        }

        if (consumeAppliedNavigationEcho(tab.id, tab.url)) {
            return;
        }

        if (!isUrlSyncable(unwrapStubUrl(tab.url))) {
            return;
        }

        const uid = snapshot?.uid || await resolveUid(tab.id);
        if (!uid) {
            return;
        }

        await DeltaLog.append(DeltaLog.OPS.PINNED_MODIFY, {
            tab: buildPinnedRecord(tab, uid, snapshot),
        });
    } catch (e) {
        logger.onCatch('pinnedModified', false)(e);
    }
}

export async function pinnedMoved(tabId, toIndex) {
    try {
        if (isApplying()) {
            return;
        }

        const uid = await resolveUid(tabId);
        if (!uid) {
            return;
        }

        const payload = {uid};
        if (Number.isInteger(toIndex)) {
            payload.toIndex = toIndex;
        }

        await DeltaLog.append(DeltaLog.OPS.PINNED_MOVE, payload);
    } catch (e) {
        logger.onCatch('pinnedMoved', false)(e);
    }
}

export async function pinnedRemoved(uid) {
    try {
        if (isApplying()) {
            return;
        }

        if (!uid) {
            return;
        }

        await DeltaLog.append(DeltaLog.OPS.PINNED_REMOVE, {uid});
    } catch (e) {
        logger.onCatch('pinnedRemoved', false)(e);
    }
}
