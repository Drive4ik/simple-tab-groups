import * as Groups from '/js/groups.js';
import * as Cache from '/js/cache.js';
import Logger from '/js/logger.js';
import * as DeltaCapture from './delta-capture.js';
import {getLivePinnedTabs} from './local-state.js';

const logger = new Logger('DeltaSyncFavIcons');

async function applyLiveFavIcon(tab, mergedMap) {
    if (tab.uid == null || tab.id == null || !Object.hasOwn(mergedMap, tab.uid)) {
        return;
    }
    const target = mergedMap[tab.uid];
    if (Cache.getTabFavIcon(tab.id) === target) {
        return;
    }
    await Cache.setSyncedTabFavIcon(tab.id, target).catch(() => {});
}

async function applyLiveFavIcons(mergedMap) {
    const {groups} = await Groups.load(null, true);
    for (const group of groups) {
        if (group.isArchive || !Array.isArray(group.tabs)) {
            continue;
        }
        for (const tab of group.tabs) {
            await applyLiveFavIcon(tab, mergedMap);
        }
    }

    const pinnedTabs = await getLivePinnedTabs().catch(() => []);
    for (const tab of pinnedTabs) {
        await applyLiveFavIcon(tab, mergedMap);
    }
}

async function applyArchivedFavIcons(mergedMap) {
    const {groups} = await Groups.loadWithArchivedTabs(null, false);
    let changed = false;

    for (const group of groups) {
        if (!group.isArchive || !Array.isArray(group.tabs)) {
            continue;
        }
        for (const tab of group.tabs) {
            if (tab.uid != null && Object.hasOwn(mergedMap, tab.uid) && tab.favIconUrl !== mergedMap[tab.uid]) {
                tab.favIconUrl = mergedMap[tab.uid];
                changed = true;
            }
        }
    }

    if (!changed) {
        return;
    }

    DeltaCapture.beginApply();
    try {
        await Groups.save(groups);
    } finally {
        DeltaCapture.endApply();
    }
}

export async function applyFavIconMap(mergedMap) {
    if (!mergedMap || !Object.keys(mergedMap).length) {
        return;
    }

    try {
        await applyLiveFavIcons(mergedMap);
        await applyArchivedFavIcons(mergedMap);
    } catch (e) {
        logger.onCatch('applyFavIconMap', false)(e);
    }
}
