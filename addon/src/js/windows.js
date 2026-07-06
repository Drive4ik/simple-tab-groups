import Listeners from '/js/listeners.js\
?windows.onCreated\
&windows.onFocusChanged\
&windows.onRemoved\
&storage.local.onChanged\
';
import Logger from './logger.js';
import backgroundSelf from './background.js';
import BatchProcessor from './batch-processor.js';
import * as Browser from './browser.js';
import * as Broadcast from './broadcast.js';
import * as WindowsBroadcast from './broadcast.js?channel=windows';
import * as Constants from './constants.js';
import * as Tabs from './tabs.js';
import * as Groups from './groups.js';
import * as Utils from './utils.js';
import * as Cache from './cache.js';
import * as MenusMain from '/js/menus-main.js';
import * as Storage from './storage.js';

export {on, off} from './broadcast.js?channel=windows';

const logger = new Logger('Windows');
const mainStorage = localStorage.create(Constants.MODULES.BACKGROUND);
const settings = await Storage.get(['createNewGroupWhenOpenNewWindow']);
const restoreTabsOnRemoved = [];
const skip = {
    nextCreation: false,
};

Listeners.storage.local.onChanged.add(onStorageChanged, {waitListener: false});

export function addListeners(options) {
    Listeners.windows.onCreated.add(onCreated, options);
    Listeners.windows.onFocusChanged.add(onFocusChanged, options);
    Listeners.windows.onRemoved.add(onRemoved, options);
    Broadcast.on('add-restore-tab-on-removed-window', addRestoreTabOnRemoved);
}

export function removeListeners() {
    Listeners.windows.onCreated.remove(onCreated);
    Listeners.windows.onFocusChanged.remove(onFocusChanged);
    Listeners.windows.onRemoved.remove(onRemoved);
    Broadcast.off(addRestoreTabOnRemoved);
}

function send(action, data = {}) {
    WindowsBroadcast.send({action, ...data}, {
        includeSelf: false,
    });
}

// listeners
function addRestoreTabOnRemoved({tabId}) {
    restoreTabsOnRemoved.push(tabId);
}

const grandRestoreBatch = new BatchProcessor(runGrandRestore, 10);

export async function GrandRestore(windowId) {
    const {promise} = enqueueGrandRestore(windowId);
    await promise;
}

function enqueueGrandRestore(windowId) {
    Tabs.skipTrackingWindow(windowId);

    const isBatchLeader = grandRestoreBatch.size() === 0;

    const promise = grandRestoreBatch.add(windowId);

    promise.finally(() => Tabs.continueTrackingWindow(windowId));

    return {
        promise,
        // cancel() {
        //     grandRestoreBatch.delete(windowId);
        //     Tabs.continueTrackingWindow(windowId);
        // },
        isBatchLeader,
    };
}

async function runGrandRestore(restoredWindowIds) {
    const log = logger.start(runGrandRestore, Array.from(restoredWindowIds));

    const allWindowsMap = await load(true).then(windows => new Map(windows.map(win => [win.id, win])));
    const {groups} = await Groups.load();
    let {tabsToRestore = []} = await Storage.get('tabsToRestore');

    log.log('all windows', Array.from(allWindowsMap.keys()));

    let tabsToRestoreChanged = false;
    function deleteTabsToRestoreByGroup({id}) {
        const lengthBefore = tabsToRestore.length;
        tabsToRestore = tabsToRestore.filter(tab => tab.groupId !== id);

        if (!tabsToRestoreChanged) {
            tabsToRestoreChanged = lengthBefore !== tabsToRestore.length;
        }
    }

    // prepare windows
    for (const win of allWindowsMap.values()) {
        win.groups = [];

        for (const gr of groups) {
            if (gr.isArchive) {
                continue;
            }

            const group = {...gr};

            group.tabs = win.tabs.filter(tab => tab.groupId === group.id);

            if (!group.tabs.length) {
                continue;
            }

            const glog = log.start('preparing group', gr.id, 'in window', win.id);

            for (const tab of group.tabs) {
                if (tab.active && Utils.isUrlEmpty(tab.url)) {
                    tab.url = Utils.normalizeUrl(Cache.getTabSession(tab.id, 'url'));
                }
            }

            group.isLoaded = group.id === win.groupId;

            glog.log('isLoaded', group.isLoaded);
            // если группа загружена, ставим минимальный доступ (без конфликтов если она загружена в нескольких окнах одновременно), для того чтоб группа осталась в восстанавливаемом окне, а вкладки из другого окна переместятся туда
            if (group.isLoaded) {
                group.lastAccessed = win.id;
            } else {
                // иначе ищем минимальное значение доступа ко вкладке
                // если оно будет меньше чем доступ этой группы в других окнах - именно эта группа этого окна и останется - вкладки этой группы в других окнах удаляться или переместятся
                group.lastAccessed = Math.min(...group.tabs.map(tab => tab.lastAccessed));
            }

            glog.log('lastAccessed', group.lastAccessed);

            group.window = win;
            win.groups.push(group);

            glog.stop('finished preparing group');
        }
    }

    const tabsToDelete = new Map();
    const tabsToMoving = new Map();
    const groupsAlreadyRestored = new Map();
    const sameTabKeys = ['url', 'cookieStoreId'];

    // restore tabs
    for (const win of allWindowsMap.values()) {
        const wlog = log.start('processing window', win.id);

        // не восстановленное окно пропускаем
        if (!restoredWindowIds.has(win.id)) {
            wlog.stop('🛑 skip not restored window');
            continue;
        }

        // ищем группу которую надо восстановить и оставить, вкладки этой группы в других окнах переместить/удалить
        for (let groupToKeep of win.groups) {
            const glog = wlog.start('find groupToKeep', 'for group:', groupToKeep.id);

            if (groupsAlreadyRestored.has(groupToKeep.id)) {
                glog.stop('🛑 already restored, skip');
                continue;
            }

            // only groups of restored windows are processed

            const sameGroupsAllWindows = new Map();

            // ищем востанавливаемую группу во всех окнах
            for (const w of allWindowsMap.values()) {
                for (const group of w.groups) {
                    if (group.id === groupToKeep.id) {
                        sameGroupsAllWindows.set(group.lastAccessed, group);
                        break;
                    }
                }
            }

            glog.log('sameGroupsAllWindows:', Array.from(sameGroupsAllWindows.keys()));

            const isLiveInUnrestoredWindow = Array.from(sameGroupsAllWindows.values()).some(group => {
                return group.isLoaded && !restoredWindowIds.has(group.window.id);
            });

            if (isLiveInUnrestoredWindow) {
                deleteTabsToRestoreByGroup(groupToKeep);
                glog.stop('🛑 group is loaded in a window outside this restore, leave both windows intact');
                continue;
            }

            // если группа из всех окон одна
            if (sameGroupsAllWindows.size === 1) {
                const [onlyGroup] = sameGroupsAllWindows.values();

                // если группы нет в восстановленных окнах - пропускаем
                if (!restoredWindowIds.has(onlyGroup.window.id)) {
                    glog.stop('🛑 group is only in one window but not in the restored one, skip');
                    continue;
                }

                // вкладки группы есть только в одном восстановленом окне, оставляем её, удаляя из восстановления
                // она в одном экземпляре и в нужном восстановленном окне
                // это состояние когда группа открыта в новом окне, все окна одновременно закрылись, а потом одновременно восстановились. удаляем только из восстановления
                deleteTabsToRestoreByGroup(groupToKeep);
                glog.stop('🛑 group is only in one window and in the restored one, delete its tabs from restore as they are already restored');
                continue;
            }

            // ищем группу с минимальным значением доступа (это когда она загружена в окне),
            // именно в этом окне она и будет оставлена
            const minGroupLastAccessed = Math.min(...sameGroupsAllWindows.keys());

            glog.log('sameGroupsAllWindows:', Array.from(sameGroupsAllWindows.keys()));

            groupToKeep = sameGroupsAllWindows.get(minGroupLastAccessed);

            sameGroupsAllWindows.delete(minGroupLastAccessed);
            const otherSameGroupsAllWindows = sameGroupsAllWindows;

            glog.log('groupToKeep lastAccessed', groupToKeep.lastAccessed, ', window', groupToKeep.window.id);

            // ищем вкладки в других окнах, которых нет в окне результующей группы (по url и cookieStoreId)
            for (const otherSameGroup of otherSameGroupsAllWindows.values()) {
                glog.log('processing other same group in window', otherSameGroup.window.id);

                for (const [index, oTab] of otherSameGroup.tabs.entries()) {
                    const found = groupToKeep.tabs.some(tab => Tabs.isSame(oTab, tab, sameTabKeys));

                    if (found) {
                        glog.log('tab found, mark to delete', oTab.id);
                        tabsToDelete.set(oTab.id, oTab);
                    } else {
                        glog.log('tab not found, mark to move', oTab.id);
                        // insert tab into the same position as in the same group
                        groupToKeep.tabs.splice(index, 0, oTab);
                        tabsToMoving.set(oTab.id, oTab);
                    }
                }
            }

            groupsAlreadyRestored.set(groupToKeep.id, groupToKeep);
            deleteTabsToRestoreByGroup(groupToKeep);

            glog.stop('finished processing group');
        }

        wlog.stop('finished processing window');
    }

    const activeTabs = [];

    tabsToDelete.forEach(tab => tab.active && activeTabs.push(tab));
    tabsToMoving.forEach(tab => tab.active && activeTabs.push(tab));

    // делаем активной другую вкладку и удаляем привязку окна к группе
    await Promise.all(activeTabs.map(async activeTab => {
        const win = allWindowsMap.get(activeTab.windowId);
        const groupToKeep = win && groupsAlreadyRestored.get(win.groupId);

        if (!groupToKeep) {
            return;
        }

        log.log('processing active tab', activeTab.id, 'in window', activeTab.windowId, 'groupToKeep', groupToKeep.id, 'lastAccessed', groupToKeep.lastAccessed);

        // если удаляемая вкладка находится в нужном окне группы которую оставляем, делаем активной другую вкладку группы
        if (activeTab.windowId === groupToKeep.window.id) {
            // ищем неудаляемые вкладки текущего окна
            const tabsToActive = groupToKeep.tabs.filter(tab => {
                return !tabsToDelete.has(tab.id) && tab.windowId === activeTab.windowId;
            });

            if (tabsToActive.length) {
                await Tabs.setActive(null, tabsToActive);
            } else {
                // если их нет - делаем активной перемещаемую вкладку, после временной
                const otherMoveTabs = groupToKeep.tabs.filter(tab => tab.windowId !== activeTab.windowId);

                if (otherMoveTabs.length) {
                    groupToKeep.deleteTabAfterMove = await Tabs.createTempActiveTab(activeTab.windowId, true);
                } else {
                    await Tabs.createTempActiveTab(activeTab.windowId, false);
                }
            }
        } else {
            // если вкладка в другом окне этой группы - удаляем привязку группы к окну, и делаем пустую вкладку
            await Cache.removeWindowSession(activeTab.windowId);
            await Tabs.createTempActiveTab(activeTab.windowId, false);
        }
    }));

    // перемещаем недостающие вкладки из других окон
    // TODO проверить, надо ли отключать отслеживание вкладок, так как уже трекинг отключен для восстановленных окон
    const skippTrackingTabs = new Set();
    for (const groupToKeep of groupsAlreadyRestored.values()) {
        const tabsIntoAnotherWindows = groupToKeep.tabs.filter(tab => tab.windowId !== groupToKeep.window.id);

        if (!tabsIntoAnotherWindows.length) {
            continue;
        }

        Tabs.skipTracking(tabsIntoAnotherWindows, skippTrackingTabs);

        groupToKeep.tabs = await Tabs.moveNative(groupToKeep.tabs, {
            windowId: groupToKeep.window.id,
            index: -1,
        });

        if (groupToKeep.window.groupId === groupToKeep.id) {
            log.log('showing group tabs, group', groupToKeep.id, 'in window', groupToKeep.window.id);
            await Tabs.show(groupToKeep.tabs);

            if (groupToKeep.deleteTabAfterMove) {
                await Tabs.setActive(null, groupToKeep.tabs.filter(tab => !tabsToDelete.has(tab.id)));
                await Tabs.remove(groupToKeep.deleteTabAfterMove, true);
            }
        } else {
            log.log('hiding group tabs, group', groupToKeep.id, 'in window', groupToKeep.window.id);
            await Tabs.hide(groupToKeep.tabs);
        }
    }
    Tabs.continueTracking(skippTrackingTabs);

    const tabsToDeleteIds = Array.from(tabsToDelete.keys());
    log.log('deleting tabs:', tabsToDeleteIds);
    await Tabs.remove(tabsToDeleteIds, true);

    const result = {
        shouldRestoreMissedTabs: false,
    };

    if (tabsToRestoreChanged) {
        if (tabsToRestore.length) {
            // If multiple windows were closed but only one was restored, it needs to restore the remaining tabs in that window
            result.shouldRestoreMissedTabs = true;
            await Storage.set({tabsToRestore});
        } else {
            await Storage.remove('tabsToRestore');
        }
    }

    log.stop();

    return result;
}

const createdBatch = new BatchProcessor(async (windowIds) => {
    windowIds = Array.from(windowIds);
    logger.log('run createdBatch with windowIds:', windowIds);
    send('opened', {windowIds});
}, 250);

// align the flow of windows.onCreated events on multiple restore windows, because they can be fired with a delay up to 0-1000ms between events, dependent on user computer performance and number of tabs in windows
const createdFlowAlignmentBatch = new BatchProcessor(null, 1000);

async function onCreated(win) {
    const log = logger.start(['info', onCreated], win.id);

    if (!isNormal(win)) {
        log.stop('not a normal window');
        return;
    }

    Cache.setWindow(win);

    if (skip.nextCreation) {
        skip.nextCreation = false;
        log.stop('🛑 skip', win.id);
        return;
    }

    // skip tracking all tabs of created window, continueTrackingWindow will be called on finally of grandRestorePromise
    Tabs.skipTrackingWindow(win.id);

    // wait 1000ms for all created events in batch
    await createdFlowAlignmentBatch.add(win.id);

    const {
        promise: grandRestorePromise,
        isBatchLeader,
    } = enqueueGrandRestore(win.id);

    if (isBatchLeader) {
        await Browser.actionLoading();
    }

    let grandRestoreResult;

    try {
        log.log('waiting grand restore, isBatchLeader:', isBatchLeader, '...');
        grandRestoreResult = await grandRestorePromise;
        log.info('grand restore finished');
    } catch (e) {
        if (isBatchLeader) {
            await Browser.actionLoading(false);
        }
        log.logError('🛑 GrandRestore', e);
        log.stopError();
        return;
    }

    win = await get(win.id).catch(log.onCatch(['window not found:', win], false));

    if (!win) {
        if (isBatchLeader) {
            await Browser.actionLoading(false);
        }
        log.stopError('🛑 window not found');
        return;
    }

    if (!win.groupId && settings.createNewGroupWhenOpenNewWindow) {
        // TODO if window restored with tabs, do not create new group
        log.log('create new group into window', win.id);
        const newGroup = await Groups.add(win.id);

        if (newGroup) {
            win.groupId = newGroup.id;
        }
    }

    log.log('groupId:', win.groupId);

    if (win.groupId) {
        const {group} = await Groups.load(win.groupId);
        await MenusMain.groupLoaded(group);
    }

    createdBatch.add(win.id);

    if (grandRestoreResult.callbackResult.shouldRestoreMissedTabs && isBatchLeader) {
        log.log('running tryRestoreMissedTabs...');
        await tryRestoreMissedTabs(false).catch(log.onCatch('tryRestoreMissedTabs'));
    }

    if (isBatchLeader) {
        await Browser.actionLoading(false);
    }

    log.stop();
}

function onFocusChanged(windowId) {
    !mainStorage.IS_TEMPORARY && logger.log('onFocusChangedWindow', windowId);
}

const removedBatch = new BatchProcessor(async (windowIds) => {
    windowIds = Array.from(windowIds);
    logger.log('removedBatch, starting tryRestoreMissedTabs...');
    await tryRestoreMissedTabs(true);
    send('closed', {windowIds});
}, 250);

async function onRemoved(windowId) {
    const log = logger.start(['info', onRemoved], windowId);

    const groupId = Cache.getWindowGroup(windowId);

    Cache.removeWindow(windowId);

    createdBatch.delete(windowId);
    grandRestoreBatch.delete(windowId);

    const tabsToRestore = normalizeTabs(Cache.getTabsSessionAndRemove(restoreTabsOnRemoved));

    restoreTabsOnRemoved.length = 0;

    if (tabsToRestore.length) {
        log.info('start merge tabs');
        const prevRestore = await getTabsToRestore();
        const tabsToRestoreFiltered = tabsToRestore.filter(tab => !prevRestore.some(t => Tabs.isSame(t, tab)));
        await Storage.set({
            tabsToRestore: [...prevRestore, ...tabsToRestoreFiltered],
        });

        removedBatch.add(windowId);
    }

    if (groupId) {
        const {group} = await Groups.load(groupId);
        await MenusMain.groupUnloaded(group);
    }

    log.stop();
}

function onStorageChanged(changes) {
    if (Storage.isChangedBooleanKey('createNewGroupWhenOpenNewWindow', changes)) {
        settings.createNewGroupWhenOpenNewWindow = changes.createNewGroupWhenOpenNewWindow.newValue;
    }
}


// methods
export async function load(withTabs = false, includeFavIconUrl, includeThumbnail) {
    const log = logger.start(load, {withTabs, includeFavIconUrl, includeThumbnail});

    let [tabs, windows] = await Promise.all([
        withTabs ? Tabs.get(null, false, null, undefined, includeFavIconUrl, includeThumbnail) : false,
        browser.windows.getAll({
            windowTypes: [browser.windows.WindowType.NORMAL],
        }).catch(() => []),
    ]);

    windows = await Promise.all(windows.filter(isNormal).map(Cache.loadWindowSession));
    windows = windows.filter(Boolean);

    if (withTabs) {
        windows = windows.map(win => (win.tabs = tabs.filter(tab => tab.windowId === win.id), win));
    }

    log.stop();
    return windows.sort(Utils.sortBy('id'));
}

export async function get(windowId = browser.windows.WINDOW_ID_CURRENT) {
    const log = logger.start(get, {windowId});

    const win = await browser.windows.get(windowId)
        .then(Cache.loadWindowSession)
        .catch(log.onCatch(['get', windowId]));

    log.assert(win, 'windowId', windowId, 'not found');
    log.stop(win);
    return win;
}

export async function create(groupId, activeTabId) {
    const log = logger.start(create, {groupId, activeTabId});

    if (!groupId) {
        log.throwError('No group id');
    }

    if (Groups.isPinnedGroupId(groupId)) {
        log.stopWarn('pinned group cannot be opened in a new window');
        return;
    }

    const groupWindowId = Cache.getWindowId(groupId);

    log.log('groupWindowId', groupWindowId);

    if (groupWindowId) {
        await Groups.apply(groupWindowId, groupId, activeTabId);
        log.stop('load exist window', groupWindowId);
    } else {
        log.log('creating new window for group', groupId);
        skip.nextCreation = true;
        const win = await browser.windows.create();

        log.log('applying group to window', win.id);
        await Groups.apply(win.id, groupId, activeTabId);
        log.stop('load new window', win);
    }
}

export async function setFocus(windowId) {
    return await browser.windows.update(windowId, {
        focused: true,
    }).catch(logger.onCatch(['setFocus', windowId]));
}

export function isNormal(win) {
    return win?.type === browser.windows.WindowType.NORMAL;
}

export async function isNormalId(windowId) {
    const log = logger.start(isNormalId, windowId);

    const win = await browser.windows.get(windowId).catch(() => null);

    if (!win) {
        log.stopWarn(false);
        return false;
    }

    const normal = isNormal(win);

    log.stop(normal);
    return normal;
}

export async function getLastFocusedNormalWindow(returnId = true) {
    const log = logger.start(getLastFocusedNormalWindow, {returnId});

    let lastFocusedWindow = await browser.windows.getLastFocused().catch(log.onCatch('windows.getLastFocused', false));

    if (isNormal(lastFocusedWindow)) {
        if (returnId) {
            log.stop('windowId', lastFocusedWindow.id);
            return lastFocusedWindow.id;
        } else {
            lastFocusedWindow = await Cache.loadWindowSession(lastFocusedWindow);

            if (lastFocusedWindow) {
                log.stop('window', lastFocusedWindow);
                return lastFocusedWindow;
            }
        }
    }

    log.warn('hard way (((');

    const windows = await load();
    const win = windows.find(win => win.focused) || windows.pop();

    log.assert(win, 'normal window not found!');
    log.stop('windowId', win?.id);
    return returnId ? win?.id : win;
}

export async function createPopup(createData, once = true) {
    const log = logger.start(createPopup, createData);

    createData = {
        focused: true,
        type: browser.windows.CreateType.POPUP,
        state: browser.windows.WindowState.NORMAL,
        ...createData,
    };

    let win;

    if (once) {
        const windows = await browser.windows.getAll({
            windowTypes: [createData.type],
            populate: true,
        }).catch(e => {
            log.logError(["can't get", createData.type], e);
            return [];
        });

        win = windows.find(win => win.tabs[0].url.startsWith(createData.url));

        if (win && createData.focused) {
            await setFocus(win.id);
        }
    }

    win ??= await browser.windows.create(createData).catch(log.onCatch(createData));

    log.stop(win);

    return win;
}

function normalizeTabs(tabs) {
    return tabs.map(Tabs.normalizeUrl).filter(tab => tab.url);
}

async function getTabsToRestore() {
    const {tabsToRestore} = await Storage.get('tabsToRestore');
    const normalizedTabsToRestore = normalizeTabs(tabsToRestore ?? []);

    if (!normalizedTabsToRestore.length && tabsToRestore) {
        await Storage.remove('tabsToRestore');
    }

    return normalizedTabsToRestore;
}

export async function tryRestoreMissedTabs(actionLoading = true) {
    const log = logger.start(['info', tryRestoreMissedTabs]);

    const tabsToRestore = await getTabsToRestore();

    if (!tabsToRestore.length) {
        log.stop('tabs not found');
        return;
    }

    const windows = await load();

    if (!windows.length) {
        log.stopWarn('windows not found');
        return;
    }

    log.log('restoring tabs count:', tabsToRestore.length);

    if (actionLoading) {
        await Browser.actionLoading();
    }

    const allTabs = await Tabs.get(null, null, null).then(normalizeTabs);

    // normalize blank tab urls
    for (const tab of allTabs) {
        if (Tabs.isLoading(tab) && Utils.isUrlEmpty(tab.url)) {
            tab.url = Utils.normalizeUrl(Cache.getTabSession(tab.id, 'url'));
        }
    }

    // strict find exist tabs
    const {groups} = await Groups.load();
    const groupNewTabParams = groups
            .filter(group => !group.isArchive)
            .reduce((acc, group) => (acc[group.id] = Groups.getNewTabParams(group), acc), {});

    const tabsNeedRestore = [];
    const existTabs = new Set();

    for (const tab of tabsToRestore) {
        // if no groupId, or group not found
        if (!groupNewTabParams[tab.groupId]) {
            continue;
        }

        const existTab = allTabs.find(t => !existTabs.has(t) && Tabs.isSame(tab, t));

        if (existTab) {
            existTabs.add(existTab);
        } else {
            tabsNeedRestore.push(Object.assign(tab, groupNewTabParams[tab.groupId]));
        }
    }

    log.info('start Tabs.createMultiple for tabs count:', tabsNeedRestore.length, '...');

    const createdTabs = await Tabs.createMultiple(tabsNeedRestore, true);
    log.log('finish Tabs.createMultiple');

    const loadedGroupIds = groups.filter(group => Groups.isLoaded(group.id)).map(group => group.id);
    const tabsToHide = createdTabs.filter(tab => !loadedGroupIds.includes(tab.groupId));

    log.log('hide tabs count:', tabsToHide.length);
    await Tabs.hide(tabsToHide, true);

    log.log('filtering and saving tabs that have already been restored');
    let tabsInDB = await getTabsToRestore();

    tabsInDB = tabsInDB.filter(tab => !tabsToRestore.some(t => Tabs.isSame(t, tab)));

    if (tabsInDB.length) {
        await Storage.set({
            tabsToRestore: tabsInDB,
        });
    } else {
        await Storage.remove('tabsToRestore');
    }

    if (tabsNeedRestore.length) {
        Groups.sendUpdatedAll();
    }

    if (actionLoading) {
        await Browser.actionLoading(false);
    }

    log.stop();
}
