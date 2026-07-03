
import Listeners, {getExtensionStartTime} from '/js/listeners.js\
?extension.onStart\
&webRequest.onBeforeRequest=[{"urls":["<all_urls>"],"types":["main_frame"]},["blocking"]]\
&windows.onCreated\
&windows.onFocusChanged\
&windows.onRemoved\
&runtime.onConnect\
&runtime.onMessage\
&runtime.onMessageExternal\
&runtime.onInstalled\
&browserAction.onClicked\
&commands.onCommand\
&alarms.onAlarm\
';
import '/js/prefixed-storage.js';
import * as Constants from '/js/constants.js';
import * as Browser from '/js/browser.js';
import * as Messages from '/js/messages.js';
import Logger, {
    catchFunc,
    addLog,
    showLog,
    getLogs,
    clearLogs,
    getErrors,
    clearErrors,
    errorEventHandler,
    objectToNativeError,
} from '/js/logger.js';
import * as Utils from '/js/utils.js';
import Notification from '/js/notification.js?add-listeners';
import JSON from '/js/json.js';
import BatchProcessor from '/js/batch-processor.js';
import Lang from '/js/lang.js';
import Migration from '/js/migration.js';
// import * as Broadcast from '/js/broadcast.js';
import * as Containers from '/js/containers.js?add-listeners';
import * as Storage from '/js/storage.js';
import * as Cache from '/js/cache.js';
import * as File from '/js/file.js';
import * as Host from '/js/host.js';
import * as Menus from '/js/menus.js';
import * as MenusMain from '/js/menus-main.js';
// import * as MenusBookmark from '/js/menus-bookmark.js';
import * as Groups from '/js/groups.js';
import * as GroupsExternal from '/js/groups-external.js';
import * as Tabs from '/js/tabs.js';
import * as Windows from '/js/windows.js';
import * as Extensions from '/js/extensions.js?auto-detect-conflicted';
import * as Bookmarks from '/js/bookmarks.js';
import * as Permissions from '/js/permissions.js';
import * as BrowserSettings from '/js/browser-settings.js';
import * as Cloud from '/js/sync/cloud/cloud.js?can-do-synchronization';
import {deltaSynchronization, resetSyncState} from '/js/sync/delta/delta-sync.js';
import * as DeltaCapture from '/js/sync/delta/delta-capture.js';
import {invalidateCaptureGate} from '/js/sync/delta/capture-gate-state.js';

const storage = localStorage.create(Constants.MODULES.BACKGROUND);

delete storage.inited;
storage.IS_TEMPORARY = false;

if (storage.enableDebug === Constants.DEBUG.AUTO) { // if debug was auto-enabled - disable on next start addon/browser
    delete storage.enableDebug;
}

const logger = self.logger = new Logger(Constants.MODULES.BACKGROUND);

self.loggerFuncs = {
    getLogs,
    clearLogs,
    getErrors,
    clearErrors,
};

const options = self.options = {};

const ignoreExtForReopenContainer = new Set([...Constants.SAFE_EXTENSIONS_FOR_REOPEN_TAB_IN_CONTAINER]);

// TODO temp
self.CacheTabs = Cache.tabs;
self.CacheLastTabsState = Cache.lastTabsState;
self.CacheWindows = Cache.windows;

function sendExternalMessage(...args) {
    if (!storage.inited) {
        logger.warn('sendExternalMessage addon not yet loaded');
        return;
    }

    const message = Messages.normalizeSendData(...args);

    for (const [exId, params] of Object.entries(Constants.EXTENSIONS_WHITE_LIST)) {
        if (params.postActions?.includes(message.action) && Extensions.isEnabled(exId)) {
            Messages.sendExternalMessage(exId, message);
        }
    }
}

const moveTabsBatch = new BatchProcessor(async (tabIds, groupId) => {
    tabIds = Array.from(tabIds);
    const log = logger.start('moveTabsBatch', {tabIds, groupId});
    await Tabs.move(tabIds, groupId).catch(log.onCatch('Tabs.move'));
    log.stop();
});

const canceledRequests = new Set;
const onBeforeTabRequest = catchFunc(async function onBeforeTabRequest({tabId, url, cookieStoreId, originUrl, requestId, frameId}) {
    const log = logger.start('onBeforeTabRequest', {tabId, url, cookieStoreId, originUrl, requestId, frameId});

    if (frameId !== 0 || tabId === browser.tabs.TAB_ID_NONE || Containers.isTemporary(cookieStoreId)) {
        log.stop('exclude');
        return {};
    }

    if (canceledRequests.has(requestId)) {
        log.stop('stop by requestId', requestId);
        return {
            cancel: true,
        };
    }

    originUrl = originUrl || '';

    if (originUrl.startsWith(Constants.STG_BASE_URL)) {
        originUrl = 'stg://';
    }

    if (Tabs.isSkippedTracking(tabId)) {
        log.stop('🛑 tab was skiped from tracking', {tabId, url, originUrl});
        return {};
    }

    if (!Cache.getTabGroup(tabId)) {
        log.stop("tab doesn't have a group", {tabId, url, originUrl});
        return {};
    }

    log.log({tabId, url, originUrl});

    await Utils.wait(100);

    let tab = await Tabs.getOne(tabId);

    if (!tab) {
        log.stopWarn('tab not found', tabId);
        return {};
    }

    if (Tabs.isPinned(tab)) {
        log.stop('tab is pinned');
        return {};
    }

    tab.url = url;

    if (Utils.isUrlEmpty(tab.url)) {
        delete tab.title;
    }

    Cache.applyTabSession(tab);

    if (!tab.groupId) {
        log.stop('tab does not have group id');
        return {};
    }

    log.log(tab);

    const {
        group: tabGroup,
        notArchivedGroups,
    } = await Groups.load(tab.groupId);

    const destGroup = Groups.getCatchedForTab(notArchivedGroups, tabGroup, tab);

    if (destGroup) {
        tab = await Tabs.getOne(tabId);

        if (!tab) {
            log.stopWarn('tab not found', tabId);
            return {};
        }

        if (new URL(tab.url).origin !== new URL(url).origin) {
            tab.favIconUrl = null;
            Cache.removeTabThumbnail(tab.id).catch(() => {});
        }

        tab.url = url;
        tab.status = browser.tabs.TabStatus.COMPLETE;
        Cache.setTab(tab);

        moveTabsBatch.add(tab.id, destGroup.id);
        log.stop('move tab from groupId:', tabGroup.id, 'to groupId:', destGroup.id);
        return {};
    }

    const newTabContainer = Tabs.getNewTabContainer(tab, tabGroup);

    if (tab.cookieStoreId === newTabContainer) {
        log.stop('cookieStoreId is equal');
        return {};
    }

    const originExt = Extensions.getByUUID(Extensions.extractUUID(originUrl));
    const originExtEnabled = originExt && Extensions.isEnabled(originExt.id);

    function getNewAddonTabUrl(asInfo) {
        const params = {
            url: tab.url,
            anotherCookieStoreId: tab.cookieStoreId,
            destCookieStoreId: newTabContainer,
            conflictedExtId: originExt.id,
            groupId: tabGroup.id,
        };

        if (asInfo) {
            params.asInfo = true;
        }

        return Utils.setUrlSearchParams(Constants.PAGES.HELP.OPEN_IN_CONTAINER, params);
    }

    if (originExtEnabled && Constants.CONFLICTED_EXTENSIONS_FOR_REOPEN_TAB_IN_CONTAINER.includes(originExt.id)) {
        let showNotif = storage.ignoreExtensionsForReopenTabInContainer ?? 0;

        if (showNotif < 3) {
            storage.ignoreExtensionsForReopenTabInContainer = ++showNotif;

            const str = Lang('__MSG_helpPageOpenInContainerMainTitle__\n\n__MSG_clickHereForInfo__', {
                helpPageOpenInContainerMainTitle: Containers.get(newTabContainer).name,
            }, {html: false});

            Notification(str, {
                module: ['tabs', 'create', {
                    active: true,
                    url: getNewAddonTabUrl(true),
                    groupId: tabGroup.id,
                }],
            });
        }

        log.stop('deny reopen tab in required conteiner by extension', originExt.id);
        return {};
    }

    canceledRequests.add(requestId);
    setTimeout(requestId => canceledRequests.delete(requestId), 2000, requestId);

    Promise.resolve().then(async () => {
        const newTabParams = {
            ...tab,
            cookieStoreId: newTabContainer,
            ...Groups.getNewTabParams(tabGroup),
        };

        if (originUrl.startsWith('moz-extension')) {
            if (tab.hidden) {
                //
            } else if (originExtEnabled) {
                if (!ignoreExtForReopenContainer.has(originExt.id)) {
                    newTabParams.active = true;
                    newTabParams.url = getNewAddonTabUrl();
                }
            }
        }

        const newTab = await Tabs.create(newTabParams, true);

        log.log('remove tab', tab);
        Tabs.remove(tab);

        if (tab.hidden) {
            log.log('hide tab', newTab);
            Tabs.hide(newTab, true);
        }
    });

    log.stop('reopen tab');
    return {
        cancel: true,
    };
}, logger);

const onPermissionsAdded = catchFunc(async function onPermissionsAdded(permissions) {
    const log = logger.start('onPermissionsAdded', permissions);

    if (Permissions.hasAny(permissions, Permissions.BROWSER_SETTINGS)) {
        await BrowserSettings.set(options.browserSettings);
    }

    log.stop();
}, logger);

const onPermissionsRemoved = catchFunc(async function onPermissionsRemoved(permissions) {
    const log = logger.start('onPermissionsRemoved', permissions);

    if (Permissions.hasAny(permissions, Permissions.NATIVE_MESSAGING)) {
        if (options.autoBackupLocation === Constants.AUTO_BACKUP_LOCATIONS.HOST) {
            await saveOptions({
                autoBackupLocation: Constants.AUTO_BACKUP_LOCATIONS.DOWNLOADS,
            });
        }
    }

    // if (Permissions.hasAny(permissions, Permissions.BOOKMARKS)) {
    //     await MenusMain.permissionChanged();
    // }

    log.stop();
}, logger);

async function onAlarm({name}) {
    const log = logger.start('onAlarm', {name});

    if (name === LOCAL_BACKUP_ALARM_NAME) {
        await createBackup(options.autoBackupIncludeTabFavIcons, options.autoBackupIncludeTabThumbnails, true)
            .catch(log.onCatch(["can't createBackup()", {
                autoBackupIncludeTabFavIcons: options.autoBackupIncludeTabFavIcons,
                autoBackupIncludeTabThumbnails: options.autoBackupIncludeTabThumbnails,
            }]));
    } else if (name === Cloud.ALARM_NAME) {
        await cloudSync({trigger: Cloud.TRIGGER_AUTO})
            .catch(log.onCatch("can't auto cloudSync"));
    } else if (name === Cloud.ALARM_NAME_RETRY) {
        await cloudSync({trigger: Cloud.TRIGGER_RETRY})
            .catch(log.onCatch("can't cloudSync retry"));
    }

    log.stop();
}

// wait for reload addon if found update
// Listeners.runtime.onUpdateAvailable.add(() => Utils.safeReloadAddon());

function addListenerOnBeforeRequest() {
    logger.log('addListenerOnBeforeRequest');
    Listeners.webRequest.onBeforeRequest.add(onBeforeTabRequest);
}

function removeListenerOnBeforeRequest() {
    logger.log('removeListenerOnBeforeRequest');
    Listeners.webRequest.onBeforeRequest.clear();
}

function addEvents() {
    logger.info('addEvents');

    Tabs.addListeners();
    Windows.addListeners();
    GroupsExternal.addListeners();

    Permissions.onAdded.add(onPermissionsAdded);
    Permissions.onRemoved.add(onPermissionsRemoved);

    Listeners.alarms.onAlarm.add(onAlarm);

    Menus.addListeners();
    MenusMain.addListeners();
}

function removeEvents() {
    logger.info('removeEvents');

    Tabs.removeListeners();
    Windows.removeListeners();
    GroupsExternal.removeListeners();

    Permissions.onAdded.clear();
    Permissions.onRemoved.clear();

    Listeners.alarms.onAlarm.clear();

    Notification.removeListeners();
    Menus.removeListeners();
    MenusMain.removeListeners();

    Extensions.removeListeners();

    removeListenerOnBeforeRequest();
}

const sendMessageFromBackground = self.sendMessageFromBackground = Messages.sendMessageFromBackground;

Listeners.runtime.onConnect.add(Messages.createListenerOnConnectedBackground(onBackgroundMessage));
Listeners.runtime.onMessage.add(onBackgroundMessage);
Listeners.commands.onCommand.add(name => onBackgroundMessage(name, self));

Listeners.runtime.onMessageExternal.add(async function onMessageExternal(request, sender) {
    const log = logger.start(['info', 'onMessageExternal'], `RECEIVED-EXTERNAL-ACTION#${request?.action}`, {request, sender});

    if (request?.action === 'ignore-ext-for-reopen-container') {
        ignoreExtForReopenContainer.add(sender.id);
        log.stop('add to ignore', sender.id, 'done');
        return {
            ok: true,
        };
    }

    if (!storage.inited) {
        log.stopWarn('background not inited');
        return {
            ok: false,
            error: `[STG] I'm not loaded yet.`,
        };
    }

    const extensionRules = {};

    if (!Utils.isAllowExternalRequestAndSender(request, sender, extensionRules)) {
        log.stopWarn('sender is not allowed');
        return {
            ok: false,
            error: '[STG] Your extension/action does not in white list. If you want to add your extension/action to white list - please contact with me.',
            yourExtentionRules: extensionRules,
        };
    }

    if (!request?.action || typeof request.action !== 'string') {
        log.stopWarn('unknown action');
        return {
            ok: false,
            error: 'unknown action',
        };
    }

    const result = await onBackgroundMessage(request, sender);

    log.stop();

    return result;
});

self.saveOptions = saveOptions;
self.createBackup = createBackup;

const INTERNAL_MODULES = {
    BG: {
        saveOptions,
        restoreBackup,
        clearAddon,
        cloudSync,
        cloudBackupPush,
        cloudBackupRestore,
    },
    Tabs,
    Groups,
    Windows,
};

function isStgSender(sender) {
    return sender === self ||
        sender.id === browser.runtime.id ||
        sender.sender?.id === browser.runtime.id;
}

self.onBackgroundMessage = onBackgroundMessage;

async function onBackgroundMessage(message, sender) {
    const isSTGMessage = isStgSender(sender);
    const senderToLogs = isSTGMessage ? browser.runtime.id : sender;

    let result = {
        ok: false,
    };

    const data = typeof message === 'string' ? { action: message } : message;

    if (!data?.action) {
        result.error = '[STG] invalid "action"';
        logger.error('onBackgroundMessage', result.error, data, senderToLogs);
        return result;
    }

    // simple messages
    switch (data.action) {
        case 'are-you-here':
            result.ok = storage.inited === true;
            return result;

        case 'save-log':
            addLog(data.log);
            showLog.call(data.logger, data.log, data.options);
            result.ok = true;
            return result;

        case 'show-error-notification':
            sendMessageFromBackground('show-error-notification');

            Notification('whatsWrongMessage', {
                iconUrl: '/icons/exclamation-triangle-yellow.svg',
                module: ['windows', 'createPopup', {
                    url: Constants.PAGES.HELP.DEBUG,
                }],
                expires: Notification.MAX_EXPIRES,
            });

            result.ok = true;
            return result;

        case 'safe-reload-addon':
            Utils.safeReloadAddon();
            result.ok = true;
            return result;

        case 'ignore-ext-for-reopen-container':
            ignoreExtForReopenContainer.add(data.id);
            result.ok = true;
            return result;

        case 'reset-cloud-sync-state':
            return await resetSyncState();

        default: break;
    }

    if (isSTGMessage) {
        const moduleMethod = data.action.split('.').reduce((obj, key) => obj?.[key], INTERNAL_MODULES);

        if (moduleMethod) {
            logger.info('onBackgroundMessage internal module', `ACTION#${data.action}`);

            try {
                return await moduleMethod(...data.args);
            } catch (e) {
                logger.throwError([
                    'onBackgroundMessage call internal module:', `ACTION#${data.action}`,
                    'args:', data.args,
                    // 'sender:', senderToLogs,
                    objectToNativeError(data.breadcrumbs),
                ], e);
            }
        }
    }

    const log = logger.start(
        ['info', 'onBackgroundMessage'],
        ...(isSTGMessage ? [`ACTION#${data.action}`] : [sender.id, `RECEIVED-EXTERNAL-ACTION#${data.action}`, data])
    );

    try {
        const currentWindow = await Windows.getLastFocusedNormalWindow(false);

        if (!currentWindow) {
            throw new Error('no windows found');
        }

        const {
            group: currentGroup,
            groups,
            notArchivedGroups,
        } = await Groups.load(currentWindow.groupId);

        if (data.windowId === browser.windows.WINDOW_ID_CURRENT) {
            data.windowId = currentWindow.id;
        }

        log.log('check action, data:', data);

        switch (data.action) {
            case 'get-groups-list':
                result.groupsList = groups.map(Groups.mapForExternalExtension);
                result.ok = true;
                break;
            case 'load-next-group':
                result.ok = await Groups.applyByPosition('next', currentWindow.id, notArchivedGroups, currentGroup?.id);
                break;
            case 'load-prev-group':
                result.ok = await Groups.applyByPosition('prev', currentWindow.id, notArchivedGroups, currentGroup?.id);
                break;
            case 'load-next-unloaded-group':
                {
                    const unloadedGroups = notArchivedGroups.filter(group => !Cache.getWindowId(group.id) || group.id === currentGroup?.id);
                    result.ok = await Groups.applyByPosition('next', currentWindow.id, unloadedGroups, currentGroup?.id);
                }
                break;
            case 'load-prev-unloaded-group':
                {
                    const unloadedGroups = notArchivedGroups.filter(group => !Cache.getWindowId(group.id) || group.id === currentGroup?.id);
                    result.ok = await Groups.applyByPosition('prev', currentWindow.id, unloadedGroups, currentGroup?.id);
                }
                break;
            case 'load-next-non-empty-group':
                {
                    const {notArchivedGroups} = await Groups.load(null, true);
                    result.ok = await Groups.applyByPosition('next', currentWindow.id, notArchivedGroups.filter(group => group.tabs.length), currentGroup?.id);
                }
                break;
            case 'load-prev-non-empty-group':
                {
                    const {notArchivedGroups} = await Groups.load(null, true);
                    result.ok = await Groups.applyByPosition('prev', currentWindow.id, notArchivedGroups.filter(group => group.tabs.length), currentGroup?.id);
                }
                break;
            case 'load-history-next-group':
                result.ok = await Groups.applyByHistory('next', currentWindow.id, notArchivedGroups);
                break;
            case 'load-history-prev-group':
                result.ok = await Groups.applyByHistory('prev', currentWindow.id, notArchivedGroups);
                break;
            case 'load-first-group':
                {
                    const navigableGroups = notArchivedGroups.filter(group => !Groups.isPinnedGroup(group));
                    if (navigableGroups.length) {
                        result.ok = await Groups.apply(currentWindow.id, navigableGroups.shift().id);
                    }
                }
                break;
            case 'load-last-group':
                {
                    const navigableGroups = notArchivedGroups.filter(group => !Groups.isPinnedGroup(group));
                    if (navigableGroups.length) {
                        result.ok = await Groups.apply(currentWindow.id, navigableGroups.pop().id);
                    }
                }
                break;
            case 'load-custom-group':
                if (data.groupId === 'new') {
                    let {ok, group} = await onBackgroundMessage({
                        action: 'add-new-group',
                        proposalTitle: data.title,
                    }, sender);

                    if (ok) {
                        result.ok = await Groups.apply(currentWindow.id, group.id);
                    }
                } else if (data.groupId) {
                    let groupToLoad = groups.find(group => group.id === data.groupId);

                    if (groupToLoad) {
                        if (groupToLoad.isArchive) {
                            result.error = Lang('groupIsArchived', groupToLoad.title);
                            Notification(result.error);
                        } else {
                            if (data.windowId) {
                                if (data.windowId === 'new') {
                                    await Windows.create(data.groupId, data.tabId);
                                    result.ok = true;
                                } else if (Number.isSafeInteger(data.windowId) && data.windowId > 0) {
                                    result.ok = await Groups.apply(data.windowId, data.groupId, data.tabId);
                                } else {
                                    result.error = 'Invalid window id';
                                }
                            } else {
                                result.ok = await Groups.apply(currentWindow.id, data.groupId, data.tabId);
                            }
                        }
                    } else {
                        delete data.groupId;
                        result = await onBackgroundMessage(data, sender);
                    }
                } else {
                    let activeTab = await Tabs.getActive();

                    if (Tabs.isCanSendMessage(activeTab)) {
                        Tabs.sendMessage(activeTab.id, {
                            action: 'show-groups-popup',
                            popupAction: 'load-custom-group',
                            popupTitle: Lang('hotkeyActionTitleLoadCustomGroup'),
                            groups: notArchivedGroups.map(Groups.mapForExternalExtension),
                            disableGroupIds: [currentGroup?.id].filter(Boolean),
                        });

                        result.ok = true;
                    } else {
                        result.error = Lang('impossibleToAskUserAboutAction', [
                            activeTab.title,
                            Lang('hotkeyActionTitleLoadCustomGroup'),
                        ]);
                        Notification(result.error, {
                            module: ['tabs', 'createUrlOnce', Constants.PAGES.DOC.UNSUPPORTED_URL],
                        });
                    }
                }
                break;
            case 'unload-group':
                if (currentGroup) {
                    result.ok = await Groups.unload(currentGroup.id);
                }
                break;
            case 'add-new-group':
                if (!options.alwaysAskNewGroupName || data.title) {
                    const newGroup = await Groups.add(data.windowId, data.tabIds, data.title);

                    result.ok = true;
                    result.group = Groups.mapForExternalExtension(newGroup);
                } else {
                    const activeTab = await Tabs.getActive();
                    const {defaultGroupProps} = await Groups.getDefaults();
                    data.proposalTitle = Groups.createTitle(data.proposalTitle, null, defaultGroupProps);

                    if (Tabs.isCanSendMessage(activeTab)) {
                        const title = await Tabs.sendMessage(activeTab.id, {
                            action: 'show-prompt',
                            promptTitle: Lang('createNewGroup'),
                            value: data.proposalTitle,
                        });

                        if (title) {
                            result = await onBackgroundMessage({
                                action: 'add-new-group',
                                title: title,
                                tabIds: data.tabIds,
                                windowId: data.windowId,
                            }, sender);
                        } else {
                            result.error = 'title is empty - skip create group';
                        }
                    } else {
                        result = await onBackgroundMessage({
                            action: 'add-new-group',
                            title: data.proposalTitle,
                            tabIds: data.tabIds,
                            windowId: data.windowId,
                        }, sender);

                        if (options.alwaysAskNewGroupName) {
                            result.error = Lang('impossibleToAskUserAboutAction', [
                                activeTab.title,
                                Lang('createNewGroup'),
                            ]);
                            Notification(result.error, {
                                module: ['tabs', 'createUrlOnce', Constants.PAGES.DOC.UNSUPPORTED_URL],
                            });
                        }
                    }
                }
                break;
            case 'rename-group':
                if (!groups.length) {
                    result.error = Lang('noGroupsAvailable');
                    Notification(result.error);
                } else if (!data.groupId) {
                    let activeTab = await Tabs.getActive();

                    if (Tabs.isCanSendMessage(activeTab)) {
                        Tabs.sendMessage(activeTab.id, {
                            action: 'show-groups-popup',
                            popupAction: 'rename-group',
                            popupTitle: Lang('hotkeyActionTitleRenameGroup'),
                            groups: groups.map(Groups.mapForExternalExtension),
                            focusedGroupId: currentGroup?.id,
                            disableNewGroupItem: true,
                        });

                        result.ok = true;
                    } else {
                        result.error = Lang('impossibleToAskUserAboutAction', [
                            activeTab.title,
                            Lang('hotkeyActionTitleRenameGroup'),
                        ]);
                        Notification(result.error, {
                            module: ['tabs', 'createUrlOnce', Constants.PAGES.DOC.UNSUPPORTED_URL],
                        });
                    }
                } else if (data.groupId && !data.title) {
                    let groupToRename = groups.find(group => group.id === data.groupId);

                    if (groupToRename) {
                        let activeTab = await Tabs.getActive();

                        if (Tabs.isCanSendMessage(activeTab)) {
                            let title = await Tabs.sendMessage(activeTab.id, {
                                action: 'show-prompt',
                                promptTitle: Lang('hotkeyActionTitleRenameGroup'),
                                value: groupToRename.title,
                            });

                            if (title) {
                                data.title = title;
                                result = await onBackgroundMessage(data, sender);
                            } else {
                                result.error = 'title in empty - skip rename group';
                            }
                        } else {
                            result.error = Lang('impossibleToAskUserAboutAction', [
                                activeTab.title,
                                Lang('hotkeyActionTitleRenameGroup'),
                            ]);
                            Notification(result.error, {
                                module: ['tabs', 'createUrlOnce', Constants.PAGES.DOC.UNSUPPORTED_URL],
                            });
                        }
                    } else {
                        result = await onBackgroundMessage('rename-group', sender);
                    }
                } else if (data.groupId && data.title && typeof data.title === 'string') {
                    let groupToRename = groups.find(group => group.id === data.groupId);

                    if (groupToRename) {
                        Groups.update(groupToRename.id, {
                            title: data.title,
                        });
                        result.ok = true;
                    } else {
                        result = await onBackgroundMessage('rename-group', sender);
                    }
                } else {
                    result = await onBackgroundMessage('rename-group', sender);
                }
                break;
            case 'export-group-to-bookmarks':
                if (!await Bookmarks.hasPermission()) {
                    result.error = Lang('noAccessToBookmarks');
                    break;
                }

                if (data.groupId) {
                    const {
                        group: groupToExport,
                        groupIndex,
                    } = await Groups.load(data.groupId, true);

                    if (groupToExport) {
                        await Browser.actionLoading();
                        result.ok = await Bookmarks.exportGroup(groupToExport, groupIndex);
                        await Browser.actionLoading(false);

                        if (data.showMessages) {
                            Notification(['groupExportedToBookmarks', groupToExport.title]);
                        }
                    } else {
                        // delete data.groupId;
                        result.error = Lang('groupNotFound');
                    }
                }

                if (!data.groupId) {
                    let activeTab = await Tabs.getActive();

                    if (Tabs.isCanSendMessage(activeTab)) {
                        Tabs.sendMessage(activeTab.id, {
                            action: 'show-groups-popup',
                            popupAction: 'export-group-to-bookmarks',
                            popupTitle: Lang('exportGroupToBookmarks'),
                            groups: groups.map(Groups.mapForExternalExtension),
                            focusedGroupId: currentGroup?.id,
                            disableNewGroupItem: true,
                        });

                        result.ok = true;
                    } else {
                        result.error = Lang('impossibleToAskUserAboutAction', [
                            activeTab.title,
                            Lang('hotkeyActionTitleRenameGroup'),
                        ]);
                        Notification(result.error, {
                            module: ['tabs', 'createUrlOnce', Constants.PAGES.DOC.UNSUPPORTED_URL],
                        });
                    }
                }
                break;
            case 'remove-group-from-bookmarks':
                if (!await Bookmarks.hasPermission()) {
                    result.error = Lang('noAccessToBookmarks');
                    break;
                }

                if (data.groupId) {
                    const {group} = await Groups.load(data.groupId);

                    if (group) {
                        await Browser.actionLoading();
                        result.ok = await Bookmarks.removeGroup(group);
                        await Browser.actionLoading(false);
                    } else {
                        result.error = Lang('groupNotFound');
                    }
                } else {
                    result.error = Lang('groupNotFound');
                }
                break;
            case 'delete-current-group':
                if (currentGroup) {
                    await Groups.remove(currentGroup.id);

                    if (!isSTGMessage && sender?.id) {
                        Notification([
                            'groupRemovedByExtension',
                            currentGroup.title,
                            Utils.getSupportedExternalExtensionName(sender.id),
                        ]);
                    }

                    result.ok = true;
                } else {
                    result.error = Lang('windowNotHaveGroup');
                }

                break;
            case 'open-manage-groups':
                if (options.openManageGroupsInTab) {
                    await Tabs.createUrlOnce(Constants.PAGES.MANAGE);
                } else {
                    const manageStorage = localStorage.create(Constants.MODULES.MANAGE);

                    await Windows.createPopup({
                        url: Constants.PAGES.MANAGE,
                        width: manageStorage.windowWidth ?? 1000,
                        height: manageStorage.windowHeight ?? 700,
                    });
                }
                result.ok = true;
                break;
            case 'open-options-page':
                const settingsUrl = Constants.PAGES.SETTINGS + (data.section ? `#${data.section}` : '');
                await Tabs.createUrlOnce(settingsUrl);
                result.ok = true;
                break;
            case 'open-debug-page':
                await Windows.createPopup({
                    url: Constants.PAGES.HELP.DEBUG,
                });
                result.ok = true;
                break;
            case 'move-selected-tabs-to-custom-group':
                let activeTab = await Tabs.getActive(),
                    tabIds = await Tabs.getHighlightedIds(activeTab.windowId, undefined, null);

                if (data.groupId === 'new') {
                    let {ok} = await onBackgroundMessage({
                        action: 'add-new-group',
                        title: data.title,
                        proposalTitle: activeTab.title,
                        tabIds: tabIds,
                    }, sender);

                    result.ok = ok;
                } else if (data.groupId) {
                    let groupMoveTo = groups.find(group => group.id === data.groupId);

                    if (groupMoveTo) {
                        if (groupMoveTo.isArchive) {
                            result.error = Lang('groupIsArchived', groupMoveTo.title);
                            Notification(result.error);
                        } else {
                            await Tabs.move(tabIds, data.groupId);
                            result.ok = true;
                        }
                    } else {
                        delete data.groupId;
                        result = await onBackgroundMessage(data, sender);
                    }
                } else {
                    if (Tabs.isCanSendMessage(activeTab)) {
                        Tabs.sendMessage(activeTab.id, {
                            action: 'show-groups-popup',
                            popupAction: data.action,
                            popupTitle: Lang('hotkeyActionTitleMoveSelectedTabsToCustomGroup'),
                            groups: notArchivedGroups.map(Groups.mapForExternalExtension),
                            focusedGroupId: activeTab.groupId,
                        });

                        result.ok = true;
                    } else {
                        result.error = Lang('impossibleToAskUserAboutAction', [
                            activeTab.title,
                            Lang('hotkeyActionTitleMoveSelectedTabsToCustomGroup'),
                        ]);
                        Notification(result.error, {
                            module: ['tabs', 'createUrlOnce', Constants.PAGES.DOC.UNSUPPORTED_URL],
                        });
                    }
                }
                break;
            case 'discard-group':
                {
                    const { groups, notArchivedGroups } = await Groups.load(null, true);

                    let groupToDiscard = groups.find(group => group.id === data.groupId);

                    if (groupToDiscard) {
                        if (groupToDiscard.isArchive) {
                            result.error = Lang('groupIsArchived', groupToDiscard.title);
                            Notification(result.error);
                        } else {
                            await Tabs.discard(groupToDiscard.tabs);
                            result.ok = true;
                        }
                    } else {
                        let activeTab = await Tabs.getActive();

                        if (Tabs.isCanSendMessage(activeTab)) {
                            Tabs.sendMessage(activeTab.id, {
                                action: 'show-groups-popup',
                                popupAction: 'discard-group',
                                popupTitle: Lang('hotkeyActionTitleDiscardGroup'),
                                groups: notArchivedGroups.map(Groups.mapForExternalExtension),
                                focusedGroupId: currentGroup?.id,
                                disableNewGroupItem: true,
                            });

                            result.ok = true;
                        } else {
                            result.error = Lang('impossibleToAskUserAboutAction', [
                                activeTab.title,
                                Lang('hotkeyActionTitleDiscardGroup'),
                            ]);
                            Notification(result.error, {
                                module: ['tabs', 'createUrlOnce', Constants.PAGES.DOC.UNSUPPORTED_URL],
                            });
                        }
                    }
                }
                break;
            case 'discard-other-groups':
                {
                    let { notArchivedGroups } = await Groups.load(null, true);

                    let tabs = notArchivedGroups.reduce(function (acc, gr) {
                        if (gr.id !== currentGroup?.id && !Cache.getWindowId(gr.id)) {
                            acc.push(...gr.tabs);
                        }
                        return acc;
                    }, []);

                    await Tabs.discard(tabs);

                    result.ok = true;
                }
                break;
            case 'reload-all-tabs-in-current-group':
                if (currentGroup) {
                    let { group } = await Groups.load(currentGroup.id, true);
                    await Tabs.reload(group.tabs);
                    result.ok = true;
                }

                break;
            case 'create-temp-tab':
                await Tabs.create({
                    active: data.active,
                    cookieStoreId: Constants.TEMPORARY_CONTAINER,
                });

                result.ok = true;

                break;
            case 'get-current-group':
                if (data.windowId) {
                    let groupId = Cache.getWindowGroup(data.windowId),
                        group = groups.find(gr => gr.id === groupId);

                    if (group) {
                        group = Groups.mapForExternalExtension(group);
                    }

                    result.group = group || null;
                    result.ok = true;
                } else {
                    throw new Error('windowId is required');
                }

                break;
            case 'exclude-container-for-group':
                let group = groups.find(group => group.id === data.groupId);

                if (!group || !data.cookieStoreId || Containers.get(data.cookieStoreId).cookieStoreId !== data.cookieStoreId) {
                    throw new Error('invalid groupId or cookieStoreId');
                }

                if (!group.excludeContainersForReOpen.includes(data.cookieStoreId)) {
                    group.excludeContainersForReOpen.push(data.cookieStoreId);
                    await Groups.save(groups);
                }

                result.ok = true;

                break;
            case 'create-backup':
                result.ok = await createBackup(data.includeTabFavIcons === true, data.includeTabThumbnails === true);
                break;
            case 'get-startup-data':
                {
                    const includeThumbnail = data.isManage
                        ? options.showTabsWithThumbnailsInManageGroups
                        : false;

                    [
                        result.windows,
                        {groups: result.groups},
                    ] = await Promise.all([
                        Windows.load(true, true, includeThumbnail),
                        Groups.load(null, true, true, includeThumbnail),
                    ]);

                    result.ok = true;
                }

                break;
            case 'start-cloud-sync':
                if (options.syncEnable) {
                    const syncResult = await cloudSync({});

                    result.ok = syncResult.ok;

                    if (!syncResult.ok) {
                        throw objectToNativeError(syncResult);
                    }
                } else {
                    result.error = Lang('syncIsDisabled');
                }
                break;
            default:
                throw new Error(`Action '${data.action}' is wrong`);
        }

    } catch (e) {
        result.error = '[STG] ' + String(e);
        log.logError(e.message || e, e);
    }

    result.error ? log.stopError(result.error) : log.stop();

    return result;
}

async function saveOptions(_options) {
    const log = logger.start('saveOptions');

    if (!storage.inited) {
        log.stopError('background not yet inited');
        return;
    }

    const optionsToSave = {};

    for (const [key, value] of Object.entries(_options)) {
        if (Constants.ALL_OPTION_KEYS.includes(key)) {
            optionsToSave[key] = Utils.isPrimitive(value) ? value : JSON.clone(value);
        } else if (Constants.DEFAULT_OPTIONS[key] === undefined) {
            log.throwError(`option key "${key}" is unknown`);
        }
    }

    const optionsKeys = Object.keys(optionsToSave);

    if (!optionsKeys.length) {
        log.stop('options not found');
        return;
    }

    await Storage.set(optionsToSave);

    Object.assign(options, optionsToSave);

    if (optionsKeys.includes('hotkeys')) {
        const tabs = await Tabs.get(null, null, null, {
                discarded: false,
            }),
            actionData = JSON.clone({
                action: 'update-hotkeys',
                hotkeys: options.hotkeys,
            });

        tabs.forEach(tab => Tabs.sendMessage(tab.id, actionData));
    }

    if (optionsKeys.some(key => ['autoBackupEnable', 'autoBackupIntervalKey', 'autoBackupIntervalValue'].includes(key))) {
        await resetLocalBackupAlarm();
    }

    if (optionsKeys.some(key => ['syncEnable', 'autoSyncEnable', 'syncOptionsLocation', 'syncIntervalKey', 'syncIntervalValue'].includes(key))) {
        invalidateCaptureGate();
        await resetSyncAlarm();
    }

    if (optionsKeys.includes('temporaryContainerTitle')) {
        await Containers.updateTemporaryContainerTitle(options.temporaryContainerTitle);
    }

    await DeltaCapture.optionsChanged(optionsToSave);

    sendMessageFromBackground('options-updated', {
        keys: optionsKeys,
    });

    log.stop();
}

const LOCAL_BACKUP_ALARM_NAME = 'local-backup';

async function resetLocalBackupAlarm() {
    await resetAlarm(
        LOCAL_BACKUP_ALARM_NAME,
        options.autoBackupEnable,
        options.autoBackupIntervalKey,
        options.autoBackupIntervalValue,
        storage.autoBackupLastTimeStamp
    );
}

async function resetSyncAlarm(useCurrentTimeAsLastRun = false) {
    await resetAlarm(
        Cloud.ALARM_NAME,
        options.syncEnable && options.autoSyncEnable,
        options.syncIntervalKey,
        options.syncIntervalValue,
        useCurrentTimeAsLastRun ? undefined : storage.autoSyncLastTimeStamp
    );
}

async function resetAlarm(
        name,
        isEnable,
        intervalKey,
        intervalValue,
        lastAlarmRunUnixTime = Utils.unixNow(),
        minDelayMinutes = 0.5
    ) {
    const log = logger.start('resetAlarm', {name, isEnable, intervalKey, intervalValue, lastAlarmRunUnixTime, minDelayMinutes});

    await browser.alarms.clear(name);

    if (!isEnable) {
        log.stop(name, 'is disabled');
        return;
    }

    let periodInMinutes;

    if (Constants.INTERVAL_KEY.minutes === intervalKey) {
        periodInMinutes = intervalValue;
    } else if (Constants.INTERVAL_KEY.hours === intervalKey) {
        periodInMinutes = intervalValue * 60;
    } else if (Constants.INTERVAL_KEY.days === intervalKey) {
        periodInMinutes = intervalValue * 60 * 24;
    }

    const minutesNow = Math.floor(Utils.unixNow() / 60);
    const minutesWhenBackup = periodInMinutes + Math.floor(lastAlarmRunUnixTime / 60);

    const delayInMinutes = minutesWhenBackup > minutesNow
        ? minutesWhenBackup - minutesNow
        : minDelayMinutes;

    await browser.alarms.create(name, {
        delayInMinutes,
        periodInMinutes,
    });

    log.stop();
}

async function createBackup(includeTabFavIcons, includeTabThumbnails, isAutoBackup = false, filePathOverride = null, locationOverride = null) {
    const log = logger.start('createBackup', {includeTabFavIcons, includeTabThumbnails, isAutoBackup, filePathOverride, locationOverride});

    const data = await Storage.get();
    const {groups} = await Groups.load(null, true, includeTabFavIcons, includeTabThumbnails);

    if (isAutoBackup && (!groups.length || groups.filter(gr => !gr.isArchive).every(gr => !gr.tabs.length))) {
        log.stopWarn('skip create auto backup, groups are empty');
        return false;
    }

    if (includeTabThumbnails) {
        includeTabThumbnails = options.showTabsWithThumbnailsInManageGroups;
    }

    let pinnedTabs = await Tabs.get(null, true, null);

    pinnedTabs = pinnedTabs.filter(tab => Utils.isUrlAllowToCreate(tab.url));

    if (pinnedTabs.length) {
        Extensions.tabsToId(pinnedTabs);
        data.pinnedTabs = Tabs.prepareForSave(pinnedTabs); // TODO remove from all
    }

    // const containersToExport = new Set;

    data.groups = groups.map(group => {
        if (!group.isArchive) {
            Extensions.tabsToId(group.tabs);
        }

        group.tabs = Tabs.prepareForSave(group.tabs, false, includeTabFavIcons, includeTabThumbnails);

        // group.tabs.forEach(({ cookieStoreId }) => {
        //     if (cookieStoreId && !Containers.isTemporary(cookieStoreId)) {
        //         containersToExport.add(cookieStoreId);
        //     }
        // });

        // if (group.newTabContainer !== Constants.TEMPORARY_CONTAINER &&
        //     group.newTabContainer !== Constants.DEFAULT_COOKIE_STORE_ID
        // ) {
        //     containersToExport.add(group.newTabContainer);
        // }

        // group.catchTabContainers.forEach(containersToExport.add, containersToExport);

        return group;
    });

    // if (containersToExport.size) {
    //     const allContainers = Containers.query({temporaryContainer: true});

    //     data.containers = {};

    //     containersToExport.forEach(cookieStoreId => data.containers[cookieStoreId] = allContainers[cookieStoreId]);
    // }

    data.containers = Containers.getToExport(data);

    if (filePathOverride) {
        data.autoBackupFilePath = filePathOverride;

        const location = locationOverride ?? data.autoBackupLocation;

        if (location === Constants.AUTO_BACKUP_LOCATIONS.DOWNLOADS) {
            await File.saveBackup(data, true);
        } else {
            await Host.saveBackup(data);
        }

        log.stop();

        return true;
    }

    if (isAutoBackup) {
        if (data.autoBackupLocation === Constants.AUTO_BACKUP_LOCATIONS.DOWNLOADS) {
            await File.saveBackup(data, true);
        } else {
            await Host.saveBackup(data);
        }

        await Bookmarks.exportGroups(data.groups).catch(log.onCatch('cant create bookmarks', false));

        storage.autoBackupLastTimeStamp = Utils.unixNow();
    } else {
        await File.saveBackup(data, false);
    }

    log.stop();

    return true;
}

// data may not be a full backup, but a partial of it
async function restoreBackup(data, clearAddonDataBeforeRestore = false) {
    removeEvents();

    sendMessageFromBackground('lock-addon');

    await Browser.actionLoading();

    const currentData = {};

    if (clearAddonDataBeforeRestore) {
        await clearAddon(false);

        // await Utils.wait(1000);
    }

    Containers.mapDefaultContainer(data, Constants.DEFAULT_COOKIE_STORE_ID);

    if (data.temporaryContainerTitle) {
        await Containers.updateTemporaryContainerTitle(data.temporaryContainerTitle);
    }

    if (clearAddonDataBeforeRestore) {
        options.showTabsWithThumbnailsInManageGroups = Constants.DEFAULT_OPTIONS.showTabsWithThumbnailsInManageGroups;
    }

    if (data.hasOwnProperty('showTabsWithThumbnailsInManageGroups')) {
        options.showTabsWithThumbnailsInManageGroups = data.showTabsWithThumbnailsInManageGroups;
    }

    if (clearAddonDataBeforeRestore) {
        currentData.groups = [];
        currentData.hotkeys = [];
    } else {
        [
            { hotkeys: currentData.hotkeys },
            { groups: currentData.groups },
        ] = await Promise.all([
            Storage.get('hotkeys'),
            Groups.load(null, true, true, options.showTabsWithThumbnailsInManageGroups),
        ]);
    }

    data.groups ??= [];
    data.hotkeys ??= [];

    const existGroupIds = new Set(currentData.groups.map(({id}) => id));
    const restoreGroupIds = new Set(data.groups.map(({id}) => id));

    for (const groupToRestore of data.groups) {
        if (
            groupToRestore.moveToGroupIfNoneCatchTabRules &&
            !existGroupIds.has(groupToRestore.moveToGroupIfNoneCatchTabRules) &&
            !restoreGroupIds.has(groupToRestore.moveToGroupIfNoneCatchTabRules)
        ) {
            groupToRestore.moveToGroupIfNoneCatchTabRules = null;
        }
    }

    const neededContainers = new Set;
    const defaultGroupProps = clearAddonDataBeforeRestore ? data.defaultGroupProps : options.defaultGroupProps;

    data.groups = data.groups.map(group => {
        const newGroupId = existGroupIds.has(group.id)
            ? Groups.createId()
            : (group.id || Groups.createId());

        const newGroup = Groups.create(newGroupId, group.title, defaultGroupProps);

        for (const key in group) {
            if (key === 'id') {
                continue;
            }

            if (newGroup.hasOwnProperty(key)) {
                newGroup[key] = group[key];
            }
        }

        if (!newGroup.isArchive) {
            Extensions.tabsToUUID(newGroup.tabs);
        }

        for (const tab of newGroup.tabs) {
            if (Containers.isDefault(tab.cookieStoreId) || Containers.isTemporary(tab.cookieStoreId)) {
                continue;
            }

            neededContainers.add(tab.cookieStoreId);
        }

        return newGroup;
    });

    data.groups = [...currentData.groups, ...data.groups];
    data.hotkeys = [...currentData.hotkeys, ...data.hotkeys];

    data.hotkeys = data.hotkeys.filter((hotkey, index, self) => {
        return self.findIndex(h => h.value === hotkey.value) === index;
    });

    if (data.containers) {
        const containersStorageMap = new Map;

        for (const [cookieStoreId, value] of Object.entries(data.containers)) {
            if (!neededContainers.has(cookieStoreId)) {
                continue;
            }

            const newCookieStoreId = await Containers.findExistOrCreateSimilar(cookieStoreId, value, containersStorageMap);

            if (newCookieStoreId !== cookieStoreId) {
                for (const group of data.groups) {
                    if (group.newTabContainer === cookieStoreId) {
                        group.newTabContainer = newCookieStoreId;
                    }

                    group.excludeContainersForReOpen = group.excludeContainersForReOpen
                        .map(csId => csId === cookieStoreId ? newCookieStoreId : csId);

                    group.catchTabContainers = group.catchTabContainers
                        .map(csId => csId === cookieStoreId ? newCookieStoreId : csId);
                }
            }
        }
    }

    delete data.containers;

    const allTabs = await Tabs.get(null, false, null, undefined, true, options.showTabsWithThumbnailsInManageGroups);

    await Tabs.reconcile(data.groups, allTabs);

    if (Array.isArray(data.pinnedTabs)) {
        const currentPinnedTabs = await Tabs.get(null, true, null);

        Extensions.tabsToId(currentPinnedTabs);

        data.pinnedTabs = data.pinnedTabs.filter(tab => {
            tab.pinned = true;
            return !currentPinnedTabs.some(t => t.url === tab.url);
        });

        if (data.pinnedTabs.length) {
            Extensions.tabsToUUID(data.pinnedTabs);
            await Tabs.createMultiple(data.pinnedTabs, true);
        }
    }

    delete data.pinnedTabs;

    let result;

    if (clearAddonDataBeforeRestore) {
        const defaultOptions = JSON.clone(Constants.DEFAULT_OPTIONS);

        result = Object.assign(defaultOptions, data);
    } else {
        result = data;
    }

    await Storage.set(result);

    storage.isBackupRestoring = true;

    await Utils.wait(200);

    browser.runtime.reload(); // reload addon
}

async function clearAddon(reloadAddonOnFinish = true) {
    if (reloadAddonOnFinish) {
        await Browser.actionLoading();
        sendMessageFromBackground('lock-addon');
    }

    removeEvents();

    const [tabs, windows] = await Promise.all([Tabs.get(null, null, null), Windows.load()]);

    await Promise.all(tabs.map(tab => Cache.removeTabSession(tab.id)));
    await Promise.all(windows.map(win => Cache.removeWindowSession(win.id)));

    await Storage.clear();

    Cache.clear();

    localStorage.clear();

    if (reloadAddonOnFinish) {
        browser.runtime.reload(); // reload addon
    }
}

async function withCloudActionProgress(operation) {
    const syncSuccessColor = 'hsl(153, 53%, 53%)'; // --bulma-success
    const syncDangerColor = 'hsl(348, 100%, 70%)'; // --bulma-danger

    const rawProgressSvg = await fetch('/icons/progress.svg').then(r => r.text());

    function browserActionProgress(progress, color = undefined, enable = null) {
        const iconSize = 16;
        const strokeWidth = 2.5;
        const iconSizeHalf = iconSize / 2;
        const radius = iconSizeHalf - strokeWidth / 2;
        const dashoffset = 2 * Math.PI * radius;
        const offset = dashoffset - (progress / 100) * dashoffset;

        const progressSvg = Utils.format(rawProgressSvg, {color, offset, radius, strokeWidth, iconSize, iconSizeHalf});
        const progressUrl = Utils.convertSvgToUrl(progressSvg);

        Browser.actionAllWindows({
            title: Lang('syncProgressTitle', progress),
            icon: progressUrl,
            enable,
        });
    }

    const actionListeners = new Set();
    actionListeners.add(Cloud.on('sync-start', () => browserActionProgress(0, undefined, false)));
    actionListeners.add(Cloud.on('sync-progress', ({progress}) => browserActionProgress(progress)));
    actionListeners.add(Cloud.on('sync-end', () => browserActionProgress(100, syncSuccessColor, true)));
    actionListeners.add(Cloud.on('sync-error', ({progress}) => browserActionProgress(progress, syncDangerColor, true)));
    actionListeners.add(Cloud.on('sync-finish', ({ok}) => {
        withCloudActionProgress.resetTimer = setTimeout(() => Browser.actionLoading(false), ok ? 0 : 5_000);
    }));
    clearTimeout(withCloudActionProgress.resetTimer);

    try {
        return await operation();
    } finally {
        actionListeners.forEach(off => off());
    }
}

async function cloudSync({
        trigger = Cloud.TRIGGER_MANUAL,
    } = {}) {
    const log = logger.start(cloudSync, {trigger});

    let shouldResetSyncAlarm = false;

    if (trigger === Cloud.TRIGGER_MANUAL) {
        const autoSyncLastTimeStamp = (storage.autoSyncLastTimeStamp ?? 0) * 1000;
        const EXTENSION_START_TIME = await getExtensionStartTime();
        shouldResetSyncAlarm = autoSyncLastTimeStamp < EXTENSION_START_TIME;
    }

    const syncResult = await withCloudActionProgress(deltaSynchronization);

    if (syncResult.inProgress) {
        log.stopWarn('sync in progress');
        return syncResult;
    }

    if (await Cloud.shouldShowSyncErrorNotification(syncResult, trigger)) {
        Notification(objectToNativeError(syncResult), {
            id: Cloud.ERROR_NOTIFICATION_ID,
            module: ['tabs', 'createUrlOnce', Constants.PAGES.SETTINGS + '#backup/sync'],
            expires: trigger === Cloud.TRIGGER_MANUAL ? undefined : Cloud.NETWORK_RETRY_DELAY_MINUTES * 60,
        });
    }

    const retryDelayInMinutes = await Cloud.getSyncRetryDelayInMinutes(syncResult, trigger);

    if (retryDelayInMinutes) {
        await browser.alarms.create(Cloud.ALARM_NAME_RETRY, {
            delayInMinutes: retryDelayInMinutes,
        });
    } else {
        await browser.alarms.clear(Cloud.ALARM_NAME_RETRY);
    }

    if (shouldResetSyncAlarm) {
        // use current time as last run to prevent situation when user do MANUAL sync, then auto sync will run immediately because last run time is before extension start time
        await resetSyncAlarm(true);
    }

    if (syncResult.ok) {
        log.stop(syncResult);
    } else {
        log.stopError(syncResult);
    }

    return syncResult;
}

async function cloudBackup(trust, revision = null) {
    const log = logger.start('cloudBackup', {trust, revision: revision?.slice(0, 7) ?? null});

    const result = await withCloudActionProgress(() => Cloud.synchronization(trust, revision, {useBackupFile: true}));

    if (result.inProgress) {
        log.stopWarn('cloud backup in progress');
        return result;
    }

    if (!result.ok && result.langId !== 'githubInvalidToken') {
        Notification(objectToNativeError(result), {
            id: Cloud.ERROR_NOTIFICATION_ID,
            module: ['tabs', 'createUrlOnce', Constants.PAGES.SETTINGS + '#backup/backup'],
        });
    }

    if (result.ok) {
        log.stop(result);
    } else {
        log.stopError(result);
    }

    return result;
}

function cloudBackupPush() {
    return cloudBackup(Cloud.TRUST_LOCAL);
}

function cloudBackupRestore(revision) {
    return cloudBackup(Cloud.TRUST_CLOUD, revision);
}

self.sendExternalMessage = sendExternalMessage;


self.addListenerOnBeforeRequest = addListenerOnBeforeRequest;
self.removeListenerOnBeforeRequest = removeListenerOnBeforeRequest;

// { reason: "update", previousVersion: "3.0.1", temporary: true }
// { reason: "install", temporary: true }
Listeners.runtime.onInstalled.add(async ({reason, previousVersion, temporary}) => {
    const log = logger.start('runtime.onInstalled', {reason, previousVersion, temporary});

    if (!temporary) {
        if (reason === browser.runtime.OnInstalledReason.UPDATE) {
            const {version} = await Storage.get('version', {});

            if (version !== previousVersion) {
                log.log('update old version in storage:', version, 'to:', previousVersion);
                await Storage.set({
                    version: previousVersion,
                });
            }
        } else if (reason === browser.runtime.OnInstalledReason.INSTALL) {
            await Storage.set({
                version: Constants.MANIFEST.version,
            });
        }
    }

    if (temporary) {
        storage.IS_TEMPORARY = true;
        log.log('addon is temp');
    } else if (
        reason === browser.runtime.OnInstalledReason.INSTALL ||
        (
            reason === browser.runtime.OnInstalledReason.UPDATE &&
            Utils.compareNumericVersions(previousVersion, '5.0') < 0
        )
    ) {
        log.log('open welcome');
        await Tabs.create({
            url: Constants.PAGES.HELP.WELCOME,
            active: true,
        });
    }

    log.stop();
});

async function initializeGroupWindows(windows, currentGroupIds) {
    const log = logger.start('initializeGroupWindows windows count:', windows.length);

    const EXTENSION_START_TIME = await getExtensionStartTime();

    let tabsToShow = [],
        tabsToHide = [],
        moveTabsToWin = {};

    windows.forEach(function (win) {
        let otherWindows = windows.filter(w => w.id !== win.id),
            duplicateGroupWindows = otherWindows.filter(w => w.groupId && w.groupId === win.groupId);

        if (win.groupId && (!currentGroupIds.includes(win.groupId) || duplicateGroupWindows.length)) {
            duplicateGroupWindows.push(win);

            duplicateGroupWindows.forEach(function (w) {
                delete w.groupId;
                Cache.removeWindowSession(w.id);
            });
        }

        win.tabs.forEach(function (tab) {
            if (Groups.isPinnedGroupId(tab.groupId)) {
                return;
            }

            if (tab.groupId && !currentGroupIds.includes(tab.groupId)) {
                delete tab.groupId;
                Cache.removeTabGroup(tab.id).catch(log.onCatch(['cant removeTabGroup', tab.id], false));
            }

            if (tab.groupId) {
                // TODO create bug in bugzilla: if set tab session, disable addon, move tab to other window, enable addon - session will empty
                let tabWin = otherWindows.find(w => w.groupId === tab.groupId);

                if (tabWin) {
                    moveTabsToWin[tabWin.id] ??= [];
                    moveTabsToWin[tabWin.id].push(tab);

                    if (tab.hidden) {
                        tabsToShow.push(tab);
                    }
                } else {
                    if (win.groupId === tab.groupId) {
                        if (tab.hidden) {
                            tabsToShow.push(tab);
                        }
                    } else {
                        if (!tab.hidden) {
                            tabsToHide.push(tab);
                        }
                    }
                }
            } else if (win.groupId) {
                if (!tab.hidden) {
                    if (Tabs.isLoading(tab) || tab.url.startsWith('file:') || tab.lastAccessed > EXTENSION_START_TIME) {
                        Cache.setTabGroup(tab.id, win.groupId)
                            .then(() => tab.groupId = win.groupId)
                            .catch(log.onCatch(["can't setTabGroup", tab.id, 'group', win.groupId], false));
                    } else {
                        tabsToHide.push(tab);
                    }
                }
            } else {
                if (tab.hidden) {
                    tabsToShow.push(tab);
                }
            }
        });
    });

    for (const [windowId, tabs] of Object.entries(moveTabsToWin)) {
        await Tabs.moveNative(tabs, {
            index: -1,
            windowId: Number(windowId),
        });

        log.log('moveTabsToWin length', tabs.length);
    }

    if (tabsToShow.length) {
        await Tabs.show(tabsToShow, true);

        tabsToShow.forEach(tab => tab.hidden = false);

        log.log('tabsToShow length', tabsToShow.length);
    }

    if (tabsToHide.length) {
        let activeTabsToHide = tabsToHide.filter(tab => tab.active);

        for (let tabToHide of activeTabsToHide) {
            let visibleTabs = windows.reduce(function (acc, win) {
                acc.push(...win.tabs.filter(tab => tabToHide.windowId === tab.windowId && !tab.hidden && !tabsToHide.includes(tab)));

                return acc;
            }, []);

            if (visibleTabs.length) {
                await Tabs.setActive(null, visibleTabs);
            } else {
                await Tabs.createTempActiveTab(tabToHide.windowId, false);
            }
        }

        await Tabs.hide(tabsToHide, true);

        log.log('tabsToHide length', tabsToHide.length);
    }

    log.stop();
}

async function init() {
    const log = logger.start(['info', '[init]']);

    try {
        let data = await Storage.getForMigrate();

        const dataChanged = new Set;

        const resultMigrate = await Migration(data, true);

        if (resultMigrate.migrated) {
            data = resultMigrate.data;
            dataChanged.add(true);
            log.log('Migration finish');
        } else if (resultMigrate.error) {
            Notification(resultMigrate.error);
            throw '';
        }

        Utils.assignKeys(options, data, Constants.ALL_OPTION_KEYS);

        if (await BrowserSettings.hasPermission()) {
            await BrowserSettings.set(options.browserSettings);
        }

        dataChanged.add(Groups.normalizeContainersInGroups(data.groups));

        dataChanged.add(Groups.ensurePinnedGroup(data.groups));

        if (data.autoBackupLocation === Constants.AUTO_BACKUP_LOCATIONS.HOST) {
            if (Constants.IS_WINDOWS && await Host.hasPermission()) {
                Host.checkVersion().catch(e => {
                    Notification(e, {
                        module: ['browser', 'tabs.create', {url: Constants.HOST.DOWNLOAD_URL}],
                    });
                });
            } else {
                data.autoBackupLocation = Constants.AUTO_BACKUP_LOCATIONS.DOWNLOADS;
                dataChanged.add(true);
            }
        }

        if (dataChanged.has(true)) {
            log.log('data was changed, save data');
            await Storage.set(data);
        }

        let windows = await Windows.load();

        if (!windows.length) {
            log.error('no windows found');
            storage.notFoundWindowsAddonStoppedWorking = 1;
            // Notification('notFoundWindowsAddonStoppedWorking');
            Listeners.windows.onCreated.add(() => browser.runtime.reload());
            throw '';
        } else if (storage.notFoundWindowsAddonStoppedWorking) {
            log.warn('try run grand restore, attempt:', storage.notFoundWindowsAddonStoppedWorking);

            try {
                await Promise.all(windows.map(win => Windows.GrandRestore(win.id)));
            } catch (e) {
                log.logError('cant grand restore', e);
                if (storage.notFoundWindowsAddonStoppedWorking++ < 10) {
                    browser.runtime.reload();
                } else {
                    await setActionToReloadAddon();
                }
                log.stop();
                return;
            }

            log.info('grand restore finish');

            delete storage.notFoundWindowsAddonStoppedWorking;
        }

        await Windows.tryRestoreMissedTabs(false);

        windows = await Windows.load(true);

        await initializeGroupWindows(windows, data.groups.map(g => g.id));

        await Groups.fillHistory(windows);

        let tabs = Utils.flatTabs(windows);

        await Containers.removeUnusedTemporaryContainers(tabs);
        log.log('Containers.removeUnusedTemporaryContainers finish');

        await Tabs.restoreOldExtensionUrls();
        log.log('restoreOldExtensionUrls finish');

        resetLocalBackupAlarm();
        resetSyncAlarm();

        await MenusMain.create();
        log.log('MenusMain.create finish');

        addEvents();

        if (Groups.isNeedBlockBeforeRequest(data.groups)) {
            log.log('addListenerOnBeforeRequest');
            addListenerOnBeforeRequest();
        }

        if (storage.isBackupRestoring) {
            delete storage.isBackupRestoring;
            Notification('backupSuccessfullyRestored');
        }

        await Browser.actionLoading(false);

        storage.inited = true;

        // send message for addon pages if it's open
        sendMessageFromBackground('i-am-back');

        // send message for addon plugins
        sendExternalMessage('i-am-back');

        log.log('loading groups for creating cache...');
        await Groups.load(null, true, true); // load favIconUrls, speed up first run popup

        log.stop();
    } catch (e) {
        await setActionToReloadAddon();

        if (e) {
            errorEventHandler.call(log, e);
            log.stopError('with errors');
        } else {
            log.stop();
        }
    }
}

async function setActionToReloadAddon() {
    await Browser.actionAllWindows({
        title: '__MSG_clickHereToReloadAddon__',
        icon: 'icons/exclamation-triangle-yellow.svg',
        popup: '',
        enable: true,
    });

    Listeners.browserAction.onClicked.add(() => browser.runtime.reload());
}

Listeners.extension.onStart.add(async () => {
    await Browser.action({
        title: '__MSG_loading__',
        badgeBackgroundColor: 'transparent',
    });

    // delay startup to avoid errors with extensions "Facebook Container", "Firefox Multi-Account Containers" etc.
    // TransactionInactiveError: A request was placed against a transaction which is currently not active, or which is finished.
    // An unexpected error occurred
    // etc.
    self.setTimeout(init, 200);
});
