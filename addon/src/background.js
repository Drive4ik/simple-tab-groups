
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
import Logger, {Logs, Errors, showLog, setDebug, onDebugChanged, setTemporaryInstall} from '/js/logger.js';
import {objectToNativeError} from '/js/logger-utils.js';
import * as Utils from '/js/utils.js';
import Notification from '/js/notification.js?add-listeners';
import JSON from '/js/json.js';
import BatchProcessor from '/js/batch-processor.js';
import Lang from '/js/lang.js';
import {initLocalData, stampVersion} from '/js/migration.js';
import * as Broadcast from '/js/broadcast.js';
import * as Containers from '/js/containers.js?add-listeners';
import * as Storage from '/js/storage.js';
import * as Cache from '/js/cache.js';
import * as File from '/js/file.js';
import * as Host from '/js/host.js';
import * as Menus from '/js/menus.js';
import * as MenusMain from '/js/menus-main.js';
// import * as MenusBookmark from '/js/menus-bookmark.js';
import * as Groups from '/js/groups.js';
import * as SubGroups from '/js/sub-groups.js';
import * as External from '/js/external.js';
import * as Tabs from '/js/tabs.js';
import * as Windows from '/js/windows.js';
import * as Extensions from '/js/extensions.js';
import * as Bookmarks from '/js/bookmarks.js';
import * as Permissions from '/js/permissions.js';
import * as BrowserSettings from '/js/browser-settings.js';
import * as Cloud from '/js/sync/cloud/cloud.js?can-do-synchronization';
import * as NewCloudGroups from '/js/sync/new-cloud-groups.js';

const storage = localStorage.create(Constants.MODULES.BACKGROUND);

delete storage.inited;
setTemporaryInstall(false);

// if debug was auto-enabled before - disable it now (after restart addon/browser)
if (storage.debugMode === Constants.DEBUG.AUTO) {
    setDebug(null);
}

const logger = self.logger = new Logger(Constants.MODULES.BACKGROUND);

const options = self.options = {};
const NOT_LOADED_ERROR = `[STG] I'm not loaded yet.`;

const ignoreExtForReopenContainer = new Set([...Constants.SAFE_EXTENSIONS_FOR_REOPEN_TAB_IN_CONTAINER]);

// TODO temp
self.CacheTabs = Cache.tabs;
self.CacheLastTabsState = Cache.lastTabsState;
self.CacheWindows = Cache.windows;

const moveTabsBatch = new BatchProcessor(async (tabIds, groupId) => {
    tabIds = Array.from(tabIds);
    using log = logger.start('moveTabsBatch', {tabIds, groupId});
    await Tabs.move(tabIds, groupId, {auto: true}).catch(log.catch('Tabs.move'));
});

const reopenTabsBatch = new BatchProcessor(async (paramsByTabId, groupId) => {
    const tabIds = Array.from(paramsByTabId.keys());
    using log = logger.start('reopenTabsBatch', {tabIds, groupId});
    await Tabs.recreate(tabIds, tab => paramsByTabId.get(tab.id)).catch(log.catch('Tabs.recreate'));
}, {useMap: true});

// BUG https://bugzilla.mozilla.org/show_bug.cgi?id=1683646
// only onBeforeNavigate can detect view-source, but it's need new permission "webNavigation" in manifest
const canceledRequests = new Map;
const reopenedForExtension = new Map;

async function getRequestedTab(tabId, requestedUrl) {
    const tab = await Tabs.get(tabId);

    if (!tab) {
        return null;
    }

    tab.url = requestedUrl;

    if (Utils.isUrlEmpty(tab.url)) {
        delete tab.title;
    }

    return tab;
}

const onBeforeTabRequest = logger.catchFunc(async function onBeforeTabRequest({
    tabId,
    url: requestedUrl,
    cookieStoreId,
    originUrl = '',
    requestId,
    frameId,
    method,
}) {
    using log = logger.start(onBeforeTabRequest, {
        tabId,
        requestedUrl,
        cookieStoreId,
        originUrl,
        requestId,
        frameId,
        method,
    });

    if (frameId !== 0 || tabId === browser.tabs.TAB_ID_NONE) {
        log.log('exclude');
        return {};
    }

    Cache.setTabRequestedUrl(tabId, requestedUrl);

    if (Containers.isTemporary(cookieStoreId)) {
        log.log('exclude temporary container');
        return {};
    }

    if (canceledRequests.has(requestId)) {
        log.log('stop by requestId', requestId);
        return {cancel: true};
    }

    if (Extensions.isOwnUrl(originUrl)) {
        originUrl = 'stg://';
    }

    log.log('final originUrl', originUrl);

    if (Tabs.isSkippedTracking(tabId)) {
        log.log('🛑 tab was skiped from tracking');
        return {};
    }

    await Tabs.waitOnCreated(tabId);

    let tab = await getRequestedTab(tabId, requestedUrl);

    if (!tab) {
        log.warn('tab not found', tabId);
        return {};
    }

    if (Tabs.isPinned(tab)) {
        log.log('tab is pinned');
        return {};
    }

    if (!tab.groupId) {
        log.log('tab does not have group id');
        return {};
    }

    log.log(tab);

    const canRecreateTab = method === 'GET';
    const {group: tabGroup, notArchivedGroups} = await Groups.load(tab.groupId);
    const destGroup = Groups.getCatchedForTab(notArchivedGroups, tabGroup, tab);

    if (destGroup) {
        if (!canRecreateTab && Tabs.getNewTabContainer(tab, destGroup) !== tab.cookieStoreId) {
            log.log('skip move: only GET request can be reopened in another container', {method, destGroupId: destGroup.id});
            return {};
        }

        // past the cache: the origin check wants the url the tab really shows
        tab = await Tabs.get(tabId, {withSession: false});

        if (!tab) {
            log.warn('tab not found', tabId);
            return {};
        }

        if (new URL(tab.url).origin !== new URL(requestedUrl).origin) {
            Cache.removeTabThumbnail(tab.id);
        }

        moveTabsBatch.add(tab.id, destGroup.id);
        log.log('move tab from groupId:', tabGroup.id, 'to groupId:', destGroup.id);
        return {};
    }

    const newTabContainer = Tabs.getNewTabContainer(tab, tabGroup);

    if (tab.cookieStoreId === newTabContainer) {
        log.log('cookieStoreId is equal');
        return {};
    }

    if (!canRecreateTab) {
        log.log('only GET request can be reopened in another container', method);
        return {};
    }

    const originExt = Extensions.getEnabledByUrl(originUrl);

    function rememberFor(map, key, ms) {
        clearTimeout(map.get(key));
        map.set(key, setTimeout(() => map.delete(key), ms));
    }

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

    if (originExt && Constants.CONFLICTED_EXTENSIONS_FOR_REOPEN_TAB_IN_CONTAINER.includes(originExt.id)) {
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
                }, {skipTrackingCreated: false}],
            });
        }

        log.log('deny reopen tab in required conteiner by extension', originExt.id);
        return {};
    }

    if (Constants.CONFLICTED_EXTENSIONS_FOR_REOPEN_TAB_IN_CONTAINER.some(Extensions.isEnabled)) {
        await Utils.wait(100);
    }

    // the copy is built from this object: the whole session of the original goes with it
    tab = await getRequestedTab(tabId, requestedUrl);

    if (!tab) {
        log.log('tab not found, maybe reopened by another extension', tabId);
        return {};
    }

    rememberFor(canceledRequests, requestId, 2000);

    const newTabParams = {
        ...tab,
        cookieStoreId: newTabContainer,
        ...Groups.getNewTabParams(tabGroup),
    };

    const mayAskUser = !tab.hidden && originExt && !ignoreExtForReopenContainer.has(originExt.id);
    const reopenKey = mayAskUser ? `${originExt.id} ${requestedUrl}` : null;
    const alreadyReopened = reopenedForExtension.has(reopenKey);

    if (reopenKey) {
        rememberFor(reopenedForExtension, reopenKey, 10_000);
    }

    if (alreadyReopened) {
        log.log('extension reopened the tab in its container again, ask the user', originExt.id);
        newTabParams.active = true;
        newTabParams.url = getNewAddonTabUrl();
    }

    reopenTabsBatch.add([tab.id, newTabParams], tabGroup.id);

    log.log('reopen tab');
    return {cancel: true};
});

const onPermissionsAdded = logger.catchFunc(async function onPermissionsAdded(permissions) {
    using log = logger.start('onPermissionsAdded', permissions);

    if (Permissions.hasAny(permissions, Permissions.BROWSER_SETTINGS)) {
        await BrowserSettings.set(options.browserSettings);
    }
});

const onPermissionsRemoved = logger.catchFunc(async function onPermissionsRemoved(permissions) {
    using log = logger.start('onPermissionsRemoved', permissions);

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
});

async function onAlarm({name}) {
    using log = logger.start('onAlarm', {name});

    if (name === LOCAL_BACKUP_ALARM_NAME) {
        await createBackup({
            includeFavIconUrl: options.autoBackupIncludeTabFavIcons,
            includeThumbnail: options.autoBackupIncludeTabThumbnails,
        }, true)
            .catch(log.catch("can't createBackup()", {
                autoBackupIncludeTabFavIcons: options.autoBackupIncludeTabFavIcons,
                autoBackupIncludeTabThumbnails: options.autoBackupIncludeTabThumbnails,
            }));
    } else if (name === Cloud.ALARM_NAME) {
        await cloudSync({trigger: Cloud.TRIGGER_AUTO})
            .catch(log.catch("can't auto cloudSync"));
    } else if (name === Cloud.ALARM_NAME_RETRY) {
        await cloudSync({trigger: Cloud.TRIGGER_RETRY})
            .catch(log.catch("can't cloudSync retry"));
    }
}

// wait for reload addon if found update
// Listeners.runtime.onUpdateAvailable.add(() => Utils.safeReloadAddon());

function addListenerOnBeforeRequest() {
    logger.log('addListenerOnBeforeRequest');
    Listeners.webRequest.onBeforeRequest.add(onBeforeTabRequest);
}

function removeListenerOnBeforeRequest() {
    logger.log('removeListenerOnBeforeRequest');
    Listeners.webRequest.onBeforeRequest.remove(onBeforeTabRequest);
}

// the request handler follows every save of the groups (docs/DESIGN-EVENTS.md §5)
Groups.on('saved', ({needBlockBeforeRequest}) => {
    if (needBlockBeforeRequest) {
        addListenerOnBeforeRequest();
    } else {
        removeListenerOnBeforeRequest();
    }
});

let offDebugChanged = null;

function addEvents() {
    logger.info('addEvents');

    Tabs.addListeners();
    Windows.addListeners();
    External.addListeners();
    SubGroups.addListeners();

    Permissions.onAdded.add(onPermissionsAdded);
    Permissions.onRemoved.add(onPermissionsRemoved);

    Listeners.alarms.onAlarm.add(onAlarm);

    Menus.addListeners();
    MenusMain.addListeners();

    offDebugChanged = onDebugChanged(async () => {
        await MenusMain.groupsUpdated();
        await Browser.actionAllGroups();
    });
}

function removeEvents() {
    logger.info('removeEvents');

    Tabs.removeListeners();
    Windows.removeListeners();
    External.removeListeners();
    SubGroups.removeListeners();

    Permissions.onAdded.clear();
    Permissions.onRemoved.clear();

    Listeners.alarms.onAlarm.clear();

    Notification.removeListeners();
    Menus.removeListeners();
    MenusMain.removeListeners();

    offDebugChanged?.();
    offDebugChanged = null;

    Extensions.removeListeners();

    removeListenerOnBeforeRequest();
}

function sendMessageFromBackground(...args) {
    return Messages.sendMessageFromBackground(...args);
}

Listeners.runtime.onConnect.add(Messages.createListenerOnConnectedBackground(onBackgroundMessage));
Listeners.runtime.onMessage.add(onBackgroundMessage);
Listeners.commands.onCommand.add(name => onBackgroundMessage(name, self));

// from the logger of any document (docs/DESIGN-LOGGER.md §3)
Broadcast.on('show-error-notification', () => {
    sendMessageFromBackground('show-error-notification');

    Notification('whatsWrongMessage', {
        iconUrl: 'icons/exclamation-triangle-yellow.svg',
        module: ['windows', 'createPopup', {
            url: Constants.PAGES.HELP.DEBUG,
        }],
        expires: Notification.MAX_EXPIRES,
    }).catch(logger.catchSilent('show-error-notification'));
});

Listeners.runtime.onMessageExternal.add(async function onMessageExternal(request, sender) {
    using log = logger.start(['info', 'onMessageExternal'], `RECEIVED-EXTERNAL-ACTION#${request?.action}`, {request, sender});

    if (request?.action === 'ignore-ext-for-reopen-container') {
        ignoreExtForReopenContainer.add(sender.id);
        log.log('add to ignore', sender.id, 'done');
        return {
            ok: true,
        };
    }

    if (!storage.inited) {
        log.warn('background not inited');
        return {
            ok: false,
            error: NOT_LOADED_ERROR,
        };
    }

    const extensionRules = {};

    if (!External.isAllowedRequest(request, sender, extensionRules)) {
        log.warn('sender is not allowed');
        return {
            ok: false,
            error: '[STG] Your extension/action does not in white list. If you want to add your extension/action to white list - please contact with me.',
            yourExtentionRules: extensionRules,
        };
    }

    if (!request?.action || typeof request.action !== 'string') {
        log.warn('unknown action');
        return {
            ok: false,
            error: 'unknown action',
        };
    }

    return await onBackgroundMessage(request, sender);
});

self.saveOptions = saveOptions;

const INTERNAL_MODULES = {
    BG: {
        saveOptions,
        restoreBackup,
        clearAddon,
        cloudSync,
    },
    Tabs,
    Groups,
    Windows,
    Logs, // for the debug page (docs/DESIGN-LOGGER.md §5)
    Errors,
};

function isStgSender(sender) {
    return sender === self || sender.id === browser.runtime.id;
}

async function onBackgroundMessage(message, sender) {
    sender = sender.sender ?? sender; // a port carries its MessageSender inside

    const isSTGMessage = isStgSender(sender);
    const senderToLogs = isSTGMessage ? browser.runtime.id : sender;

    let result = {
        ok: false,
    };

    const data = typeof message === 'string' ? {action: message} : message;

    if (!data?.action) {
        result.error = '[STG] invalid "action"';
        logger.error('onBackgroundMessage', result.error, data, senderToLogs);
        return result;
    }

    // simple messages
    switch (data.action) {
        case 'are-you-here':
            if (storage.inited) {
                result.ok = true;
            } else {
                result.error = NOT_LOADED_ERROR;
            }
            return result;

        case 'save-log':
            Logs.add(data.log);
            showLog(data.log);
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

        default: break;
    }

    if (isSTGMessage) {
        const moduleMethod = data.action.split('.').reduce((obj, key) => obj?.[key], INTERNAL_MODULES);

        if (moduleMethod) {
            logger.info('onBackgroundMessage internal module', `ACTION#${data.action}`);

            try {
                return await moduleMethod(...data.args);
            } catch (e) {
                throw logger.error(
                    'onBackgroundMessage call internal module:', `ACTION#${data.action}`,
                    'args:', data.args,
                    // 'sender:', senderToLogs,
                    objectToNativeError(data.breadcrumbs),
                    e,
                );
            }
        }
    }

    using log = logger.start(
        ['info', 'onBackgroundMessage'],
        ...(isSTGMessage ? [`ACTION#${data.action}`] : [sender.id, `RECEIVED-EXTERNAL-ACTION#${data.action}`, data])
    );

    try {
        // null for a private or a popup window in focus: the actions bound to a window are refused, the rest work
        const focusedWindow = await Windows.getFocusedNormalWindow({withSession: true});

        const getFocusedWindow = () => {
            if (!focusedWindow) {
                throw log.error('no normal window in focus');
            }

            return focusedWindow;
        };

        const getActiveTab = () => Tabs.getActive(getFocusedWindow().id);

        const {
            group: currentGroup,
            groups,
            groupsById,
            notArchivedGroups,
        } = await Groups.load(focusedWindow?.groupId);

        const applyByPosition = async (direction, groupsToJump) => {
            if (notArchivedGroups.length) {
                result.ok = await Groups.applyByPosition(direction, getFocusedWindow().id, groupsToJump, currentGroup?.id);
            } else {
                result.error = Lang('noGroupsAvailable');
            }
        };

        if (data.windowId === browser.windows.WINDOW_ID_CURRENT) {
            data.windowId = getFocusedWindow().id;
        }

        log.log('check action, data:', data);

        switch (data.action) {
            // groups
            case 'get-groups-list':
                result.groupsList = groups.map(Groups.mapForExternalExtension);
                result.ok = true;
                break;
            case 'load-next-group':
                await applyByPosition('next', notArchivedGroups);
                break;
            case 'load-prev-group':
                await applyByPosition('prev', notArchivedGroups);
                break;
            case 'load-next-unloaded-group':
                {
                    const unloadedGroups = notArchivedGroups.filter(group => !Cache.getWindowId(group.id) || group.id === currentGroup?.id);
                    await applyByPosition('next', unloadedGroups);
                }
                break;
            case 'load-prev-unloaded-group':
                {
                    const unloadedGroups = notArchivedGroups.filter(group => !Cache.getWindowId(group.id) || group.id === currentGroup?.id);
                    await applyByPosition('prev', unloadedGroups);
                }
                break;
            case 'load-next-non-empty-group':
                {
                    const {notArchivedGroups} = await Groups.load(null, true);
                    const nonEmptyGroups = notArchivedGroups.filter(group => group.tabs.length);
                    await applyByPosition('next', nonEmptyGroups);
                }
                break;
            case 'load-prev-non-empty-group':
                {
                    const {notArchivedGroups} = await Groups.load(null, true);
                    const nonEmptyGroups = notArchivedGroups.filter(group => group.tabs.length);
                    await applyByPosition('prev', nonEmptyGroups);
                }
                break;
            case 'load-history-next-group':
                result.ok = await Groups.applyByHistory('next', getFocusedWindow().id, notArchivedGroups);
                break;
            case 'load-history-prev-group':
                result.ok = await Groups.applyByHistory('prev', getFocusedWindow().id, notArchivedGroups);
                break;
            case 'load-first-group':
                if (notArchivedGroups.length) {
                    result.ok = await Groups.apply(getFocusedWindow().id, notArchivedGroups.shift().id);
                } else {
                    result.error = Lang('noGroupsAvailable');
                }
                break;
            case 'load-last-group':
                if (notArchivedGroups.length) {
                    result.ok = await Groups.apply(getFocusedWindow().id, notArchivedGroups.pop().id);
                } else {
                    result.error = Lang('noGroupsAvailable');
                }
                break;
            case 'load-custom-group':
                if (data.groupId === 'new') {
                    const {ok, group, error} = await onBackgroundMessage({
                        action: 'add-new-group',
                        proposalTitle: data.title,
                    }, sender);

                    if (ok) {
                        result.ok = await Groups.apply(getFocusedWindow().id, group.id);
                    } else {
                        result.error = error;
                    }
                } else if (data.groupId) {
                    const groupToLoad = groupsById.get(data.groupId);

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
                                result.ok = await Groups.apply(getFocusedWindow().id, data.groupId, data.tabId);
                            }
                        }
                    } else {
                        delete data.groupId;
                        result = await onBackgroundMessage(data, sender);
                    }
                } else {
                    const {error} = await Tabs.showGroupsPopup(getFocusedWindow().id, {
                        popupAction: 'load-custom-group',
                        popupTitle: Lang('hotkeyActionTitleLoadCustomGroup'),
                        groups: notArchivedGroups.map(Groups.mapForExternalExtension),
                        disableGroupIds: [currentGroup?.id].filter(Boolean),
                    });

                    if (error) {
                        result.error = error;
                    } else {
                        result.ok = true;
                    }
                }
                break;
            case 'unload-group':
                if (currentGroup) {
                    result.ok = await Groups.unload(currentGroup.id);
                } else {
                    result.error = Lang('windowNotHaveGroup');
                }
                break;
            case 'add-new-group':
                {
                    const {group, error} = data.title
                        ? {group: await Groups.add(data.windowId, data.tabIds, data.title)}
                        : await Groups.addByUser(data.windowId, data.tabIds, data.proposalTitle);

                    if (group) {
                        result.ok = true;
                        result.group = Groups.mapForExternalExtension(group);
                    } else {
                        result.error = error;
                    }
                }
                break;
            case 'rename-group':
                if (!groups.length) {
                    result.error = Lang('noGroupsAvailable');
                    Notification(result.error);
                } else if (!data.groupId) {
                    const {error} = await Tabs.showGroupsPopup(getFocusedWindow().id, {
                        popupAction: 'rename-group',
                        popupTitle: Lang('hotkeyActionTitleRenameGroup'),
                        groups: groups.map(Groups.mapForExternalExtension),
                        focusedGroupId: currentGroup?.id,
                        disableNewGroupItem: true,
                    });

                    if (error) {
                        result.error = error;
                    } else {
                        result.ok = true;
                    }
                } else if (data.groupId && !data.title) {
                    const groupToRename = groupsById.get(data.groupId);

                    if (groupToRename) {
                        const {value: title, error} = await Tabs.prompt(getFocusedWindow().id, Lang('hotkeyActionTitleRenameGroup'), groupToRename.title);

                        if (error) {
                            result.error = error;
                        } else if (title) {
                            data.title = title;
                            result = await onBackgroundMessage(data, sender);
                        } else {
                            result.error = 'cancelled by the user';
                        }
                    } else {
                        result = await onBackgroundMessage('rename-group', sender);
                    }
                } else if (data.groupId && data.title && typeof data.title === 'string') {
                    const groupToRename = groupsById.get(data.groupId);

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
                    const {group: groupToExport} = await Groups.load(data.groupId, true);

                    if (groupToExport) {
                        await Browser.actionLoading();
                        result.ok = await Bookmarks.exportGroup(groupToExport);
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
                    const {error} = await Tabs.showGroupsPopup(getFocusedWindow().id, {
                        popupAction: 'export-group-to-bookmarks',
                        popupTitle: Lang('exportGroupToBookmarks'),
                        groups: groups.map(Groups.mapForExternalExtension),
                        focusedGroupId: currentGroup?.id,
                        disableNewGroupItem: true,
                    });

                    if (error) {
                        result.error = error;
                    } else {
                        result.ok = true;
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

                    if (!isSTGMessage) {
                        Notification([
                            'groupRemovedByExtension',
                            currentGroup.title,
                            External.getTitle(sender.id),
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
                const activeTab = await getActiveTab(),
                    tabIds = await Tabs.getHighlightedIds(activeTab.windowId, undefined, null);

                if (data.groupId === 'new') {
                    const {ok, error} = await onBackgroundMessage({
                        action: 'add-new-group',
                        title: data.title,
                        proposalTitle: activeTab.title,
                        tabIds: tabIds,
                    }, sender);

                    if (ok) {
                        result.ok = true;
                    } else {
                        result.error = error;
                    }
                } else if (data.groupId) {
                    const groupMoveTo = groupsById.get(data.groupId);

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
                    const {error} = await Tabs.showGroupsPopup(activeTab.windowId, {
                        popupAction: data.action,
                        popupTitle: Lang('hotkeyActionTitleMoveSelectedTabsToCustomGroup'),
                        groups: notArchivedGroups.map(Groups.mapForExternalExtension),
                        focusedGroupId: activeTab.groupId,
                    });

                    if (error) {
                        result.error = error;
                    } else {
                        result.ok = true;
                    }
                }
                break;
            case 'discard-group':
                {
                    const {group: groupToDiscard, notArchivedGroups} = await Groups.load(data.groupId, true);

                    if (groupToDiscard) {
                        if (groupToDiscard.isArchive) {
                            result.error = Lang('groupIsArchived', groupToDiscard.title);
                            Notification(result.error);
                        } else {
                            await Tabs.discard(groupToDiscard.tabs);
                            result.ok = true;
                        }
                    } else {
                        const {error} = await Tabs.showGroupsPopup(getFocusedWindow().id, {
                            popupAction: 'discard-group',
                            popupTitle: Lang('hotkeyActionTitleDiscardGroup'),
                            groups: notArchivedGroups.map(Groups.mapForExternalExtension),
                            focusedGroupId: currentGroup?.id,
                            disableNewGroupItem: true,
                        });

                        if (error) {
                            result.error = error;
                        } else {
                            result.ok = true;
                        }
                    }
                }
                break;
            case 'discard-other-groups':
                {
                    const {notArchivedGroups} = await Groups.load(null, true);

                    const tabs = notArchivedGroups
                        .filter(gr => gr.id !== currentGroup?.id && !Cache.getWindowId(gr.id))
                        .flatMap(gr => gr.tabs);

                    await Tabs.discard(tabs);

                    result.ok = true;
                }
                break;
            case 'reload-all-tabs-in-current-group':
                if (currentGroup) {
                    const {group} = await Groups.load(currentGroup.id, true);
                    await Tabs.reload(group.tabs);
                    result.ok = true;
                } else {
                    result.error = Lang('windowNotHaveGroup');
                }

                break;
            case 'get-current-group':
                if (Number.isSafeInteger(data.windowId) && data.windowId > 0) {
                    let group = groupsById.get(Cache.getWindowGroup(data.windowId));

                    if (group) {
                        group = Groups.mapForExternalExtension(group);
                    }

                    result.group = group || null;
                    result.ok = true;
                } else {
                    throw log.error(data.windowId ? 'Invalid window id' : 'windowId is required');
                }

                break;
            case 'exclude-container-for-group':
                const group = groupsById.get(data.groupId);

                if (!group || !data.cookieStoreId || Containers.get(data.cookieStoreId).cookieStoreId !== data.cookieStoreId) {
                    throw log.error('invalid groupId or cookieStoreId');
                }

                await Groups.update(data.groupId, group => {
                    if (group.excludeContainersForReOpen.includes(data.cookieStoreId)) {
                        return {};
                    }

                    return {
                        excludeContainersForReOpen: [...group.excludeContainersForReOpen, data.cookieStoreId],
                    };
                });

                result.ok = true;

                break;

            // tabs
            case 'get-active-tab':
                {
                    // a page in a tab asks about its own window; the popup and the sidebar live in a normal window in focus
                    const windowId = sender.tab?.windowId ?? getFocusedWindow().id;

                    result.tab = await Tabs.getActive(windowId) ?? null;
                    result.ok = true;
                }
                break;
            case 'create-temp-tab':
                await Tabs.create({
                    active: data.active,
                    cookieStoreId: Constants.TEMPORARY_CONTAINER,
                }, {skipTrackingCreated: false});

                result.ok = true;

                break;

            // other actions
            case 'create-backup':
                result.ok = await createBackup({
                    includeFavIconUrl: data.includeFavIconUrl === true,
                    includeThumbnail: data.includeThumbnail === true,
                });
                break;
            case 'get-startup-data':
                {
                    const includeThumbnail = data.isManage === true;

                    [
                        result.windows,
                        {groups: result.groups},
                    ] = await Promise.all([
                        Windows.load(true, {includeFavIconUrl: true, includeThumbnail}),
                        Groups.load(null, true, {includeFavIconUrl: true, includeThumbnail}),
                    ]);

                    result.ok = true;
                }

                break;
            case 'start-cloud-sync':
                if (options.syncEnable) {
                    const syncResult = await cloudSync({});

                    result.ok = syncResult.ok;

                    if (!syncResult.ok) {
                        result.error = syncResult.error.message;
                    }
                } else {
                    result.error = Lang('syncIsDisabled');
                }
                break;
            default:
                throw log.error(`Action '${data.action}' is wrong`);
        }

    } catch (e) {
        result.ok = false;
        result.error = '[STG] ' + String(e);
        log.error(e);
    }

    // a refusal without a reason still gets a string (docs/DESIGN-MESSAGES.md §5)
    if (!result.ok) {
        result.error ||= `[STG] the action "${data.action}" was not done`;
    }

    log.assert(result.ok === !result.error, 'you forgot the error!', {
        action: data.action,
        ok: result.ok,
        error: result.error,
    });
    log.log('ok:', result.ok);

    return result;
}

async function saveOptions(_options) {
    using log = logger.start('saveOptions');

    if (!storage.inited) {
        log.warn('background not yet inited');
        return;
    }

    const optionsToSave = {};

    for (const [key, value] of Object.entries(_options)) {
        if (Constants.ALL_OPTION_KEYS.includes(key)) {
            optionsToSave[key] = Utils.isPrimitive(value) ? value : JSON.clone(value);
        } else if (!Constants.NON_OPTION_KEYS.includes(key)) {
            throw log.error(`option key "${key}" is unknown`);
        }
    }

    const optionsKeys = Object.keys(optionsToSave);

    if (!optionsKeys.length) {
        log.log('options not found');
        return;
    }

    // the sync saves every option: an alarm or a broadcast moves only when its own option changed
    const changedKeys = optionsKeys.filter(key => JSON.stringify(options[key]) !== JSON.stringify(optionsToSave[key]));

    await Storage.set(optionsToSave);

    Object.assign(options, optionsToSave);

    if (changedKeys.includes('hotkeys')) {
        const tabs = await Tabs.query({discarded: false}),
            actionData = {
                action: 'update-hotkeys',
                hotkeys: options.hotkeys,
            };

        tabs.forEach(tab => Tabs.sendMessage(tab.id, actionData));
    }

    if (changedKeys.some(key => ['autoBackupEnable', 'autoBackupIntervalKey', 'autoBackupIntervalValue'].includes(key))) {
        await resetLocalBackupAlarm();
    }

    if (changedKeys.some(key => ['syncEnable', 'syncOptionsLocation', 'syncIntervalKey', 'syncIntervalValue'].includes(key))) {
        await resetSyncAlarm();
    }

    if (optionsKeys.includes('temporaryContainerTitle')) {
        await Containers.updateTemporaryContainerTitle(options.temporaryContainerTitle);
    }

    sendMessageFromBackground('options-updated', {
        keys: optionsKeys,
    });
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
        options.syncEnable,
        options.syncIntervalKey,
        options.syncIntervalValue,
        useCurrentTimeAsLastRun ? undefined : Cloud.getLastSyncTime()
    );
}

async function resetAlarm(
        name,
        isEnable,
        intervalKey,
        intervalValue,
        lastAlarmRunTime = null,
        minDelayMinutes = 0.5
    ) {
    lastAlarmRunTime ??= Date.now();

    using log = logger.start('resetAlarm', {name, isEnable, intervalKey, intervalValue, lastAlarmRunTime, minDelayMinutes});

    await browser.alarms.clear(name);

    if (!isEnable) {
        log.log(name, 'is disabled');
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

    const minutesNow = Math.floor(Date.now() / 60_000);
    // a stamp from the future - the clock was set back
    const minutesLastRun = Math.min(minutesNow, Math.floor(lastAlarmRunTime / 60_000));
    const minutesWhenBackup = periodInMinutes + minutesLastRun;

    const delayInMinutes = minutesWhenBackup > minutesNow
        ? minutesWhenBackup - minutesNow
        : minDelayMinutes;

    await browser.alarms.create(name, {
        delayInMinutes,
        periodInMinutes,
    });
}

async function createBackup(params = {}, isAutoBackup = false) {
    using log = logger.start('createBackup', {params, isAutoBackup});

    const data = stampVersion(await Storage.get());
    const {groups} = await Groups.load(null, true, params);

    if (isAutoBackup && (!groups.length || groups.filter(gr => !gr.isArchive).every(gr => !gr.tabs.length))) {
        log.warn('skip create auto backup, groups are empty');
        return false;
    }

    const pinnedTabs = await Tabs.query({pinned: true}, {withSession: false});

    if (pinnedTabs.length) {
        data.pinnedTabs = Tabs.prepareForSave(pinnedTabs, {includeOpener: false});
    }

    data.groups = groups.map(group => {
        if (!group.isArchive) {
            group.subGroups = SubGroups.referencedSubGroups(group);
        }

        group.tabs = Tabs.prepareForSave(group.tabs, params);

        return group;
    });

    data.containers = Containers.getToExport(data);

    if (isAutoBackup) {
        if (data.autoBackupLocation === Constants.AUTO_BACKUP_LOCATIONS.DOWNLOADS) {
            await File.saveBackup(data, true);
        } else {
            await Host.saveBackup(data);
        }

        await Bookmarks.exportGroups(data.groups).catch(log.catchSilent('cant create bookmarks'));

        storage.autoBackupLastTimeStamp = Date.now();
    } else {
        await File.saveBackup(data, false);
    }

    return true;
}

// data may not be a full backup, but a partial of it
async function restoreBackup(data, clearAddonDataBeforeRestore = false) {
    // before any teardown: a separately downloaded gist restored as a backup holds cloud stubs
    // {id, uploadToCloud: false} without tabs (migration.js header) - they are not groups and are
    // dropped; anything else without tabs is a broken file, refuse it while nothing is touched yet
    data.groups = data.groups?.filter(group => {
        if (group.uploadToCloud === false && !group.tabs) {
            return false;
        }

        if (!group.tabs) {
            throw logger.error(`group "${group.id}" has no tabs and is not a cloud stub`);
        }

        return true;
    });

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

    // the backup's thumbnails option applies to the restore itself, ahead of the storage write
    if (clearAddonDataBeforeRestore) {
        options.showTabsWithThumbnailsInManageGroups = Constants.DEFAULT_OPTIONS.showTabsWithThumbnailsInManageGroups;
    }

    if (Object.hasOwn(data, 'showTabsWithThumbnailsInManageGroups')) {
        options.showTabsWithThumbnailsInManageGroups = data.showTabsWithThumbnailsInManageGroups;
    }

    Cache.setUseThumbnails(options.showTabsWithThumbnailsInManageGroups);

    if (clearAddonDataBeforeRestore) {
        currentData.groups = [];
        currentData.hotkeys = [];
    } else {
        [
            {hotkeys: currentData.hotkeys},
            {groups: currentData.groups},
        ] = await Promise.all([
            Storage.get('hotkeys'),
            Groups.load(null, true, {includeFavIconUrl: true, includeThumbnail: true}),
        ]);
    }

    data.groups ??= [];
    data.hotkeys ??= [];

    const existGroupIds = new Set(currentData.groups.map(({id}) => id));
    const subGroupIdsByGroupId = SubGroups.collectSubGroupIds(currentData.groups);
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
    const restoredAt = Date.now();

    data.groups = data.groups.map(group => {
        const newGroupId = existGroupIds.has(group.id)
            ? Groups.createId()
            : (group.id || Groups.createId());

        const newGroup = Groups.create(newGroupId, group.title, defaultGroupProps);

        for (const key in group) {
            if (key === 'id') {
                continue;
            }

            if (Object.hasOwn(newGroup, key)) {
                newGroup[key] = group[key];
            }
        }

        SubGroups.reissueSubGroupIds(newGroup, subGroupIdsByGroupId);

        // another add-on's backup names extension pages the browser's way
        newGroup.tabs.forEach(Tabs.tabUrlToAddon);

        // a restored archive counts as touched now - DESIGN-CLOUD-UPLOAD.md §5 "Keep local tabs since"
        if (newGroup.isArchive) {
            for (const tab of newGroup.tabs) {
                tab.lastAccessed = restoredAt;
            }
        }

        for (const tab of newGroup.tabs) {
            if (Containers.isDefault(tab.cookieStoreId) || Containers.isTemporary(tab.cookieStoreId)) {
                continue;
            }

            neededContainers.add(tab.cookieStoreId);
        }

        return newGroup;
    });

    const restoredGroups = data.groups;
    const restoredGroupIds = restoredGroups.map(group => group.id);

    data.groups = [...currentData.groups, ...restoredGroups];
    data.hotkeys = [...currentData.hotkeys, ...data.hotkeys];

    data.hotkeys = data.hotkeys.filter((hotkey, index, self) => {
        return self.findIndex(h => h.value === hotkey.value) === index;
    });

    const containersStorageMap = new Map;

    if (data.containers) {
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

    const allTabs = await Tabs.query({pinned: false}, {
        includeFavIconUrl: true,
        includeThumbnail: true,
    });

    await Tabs.reconcile(restoredGroups, allTabs.filter(tab => !existGroupIds.has(tab.groupId)), containersStorageMap);

    {
        if (Array.isArray(data.pinnedTabs)) {
            const currentPinnedTabs = await Tabs.query({pinned: true}, {withSession: false});

            data.pinnedTabs = data.pinnedTabs.map(Tabs.tabUrlToAddon).filter(tab => {
                tab.pinned = true;
                return !currentPinnedTabs.some(t => t.url === tab.url);
            });

            if (data.pinnedTabs.length) {
                await Tabs.createMultiple(data.pinnedTabs);
            }
        }

        delete data.pinnedTabs;
    }

    let result;

    if (clearAddonDataBeforeRestore) {
        const defaultOptions = structuredClone(Constants.DEFAULT_OPTIONS);

        result = Object.assign(defaultOptions, data);
    } else {
        result = data;
    }

    NewCloudGroups.add(restoredGroupIds);

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

    const [tabs, windows] = await Promise.all([Tabs.query(), Windows.load()]);

    await Promise.all(tabs.map(tab => Cache.removeTabSession(tab.id)));
    await Promise.all(windows.map(win => Cache.removeWindowSession(win.id)));

    await Storage.clear();

    Cache.clear();

    localStorage.clear();

    if (reloadAddonOnFinish) {
        browser.runtime.reload(); // reload addon
    }
}

let cloudSyncResetTimer;
async function cloudSync({
        trigger = Cloud.TRIGGER_MANUAL,
        trust = null,
        revision = null,
    }) {
    using log = logger.start(cloudSync, {trust, trigger, revision: revision?.slice(0, 7) ?? null});

    let shouldResetSyncAlarm = false;

    if (trigger === Cloud.TRIGGER_MANUAL) {
        const EXTENSION_START_TIME = await getExtensionStartTime();
        shouldResetSyncAlarm = (Cloud.getLastSyncTime() ?? 0) < EXTENSION_START_TIME;
    }

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
        if (ok) {
            Browser.actionLoading(false);
        } else {
            cloudSyncResetTimer = setTimeout(() => Browser.actionLoading(false), 5_000);
        }
    }));
    clearTimeout(cloudSyncResetTimer);

    let syncResult;

    try {
        syncResult = await Cloud.synchronization(trust, revision);
    } finally {
        actionListeners.forEach(off => off());
    }

    if (syncResult.inProgress) {
        syncResult.error = {message: 'sync in progress'};
        log.warn(syncResult.error.message);
        return syncResult;
    }

    if (await Cloud.shouldShowSyncErrorNotification(syncResult, trigger)) {
        Notification(objectToNativeError(syncResult.error), {
            id: Cloud.ERROR_NOTIFICATION_ID,
            module: ['tabs', 'createUrlOnce', Constants.PAGES.SETTINGS + '#backup/sync'],
            expires: trigger === Cloud.TRIGGER_MANUAL ? undefined : Cloud.RETRY_DELAY_MINUTES * 60,
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

    log.log(syncResult);

    return syncResult;
}

// { reason: "update", previousVersion: "3.0.1", temporary: true }
// { reason: "install", temporary: true }
Listeners.runtime.onInstalled.add(async ({reason, previousVersion, temporary}) => {
    using log = logger.start('runtime.onInstalled', {reason, previousVersion, temporary});

    if (temporary) {
        setTemporaryInstall(true);
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
        }, {skipTrackingCreated: false});
    }
});

async function init() {
    using log = logger.start(['info', '[init]']);

    try {
        const {data, error} = await initLocalData();

        if (error) {
            Notification(error);
            throw '';
        }

        const dataChanged = new Set;

        Utils.assignKeys(options, data, Constants.ALL_OPTION_KEYS);

        NewCloudGroups.keepOnly(data.groups.map(group => group.id));

        if (await BrowserSettings.hasPermission()) {
            await BrowserSettings.set(options.browserSettings);
        }

        dataChanged.add(Groups.normalizeContainersInGroups(data.groups));

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
            log.log('data was changed, saving data');
            await Storage.set(data);
        }

        let windows = await Windows.load();

        if (!windows.length) {
            log.error('no windows found');
            storage.notFoundWindowsAddonStoppedWorking = 1;
            // Notification('notFoundWindowsAddonStoppedWorking');
            Listeners.windows.onCreated.add(win => Windows.isNormal(win) && browser.runtime.reload(), {waitListener: false});
            throw '';
        } else if (storage.notFoundWindowsAddonStoppedWorking) {
            log.warn('try run grand restore, attempt:', storage.notFoundWindowsAddonStoppedWorking);

            try {
                await Promise.all(windows.map(win => Windows.GrandRestore(win.id)));
            } catch (e) {
                log.error('cant grand restore', e);
                if (storage.notFoundWindowsAddonStoppedWorking++ < 10) {
                    browser.runtime.reload();
                } else {
                    await setActionToReloadAddon();
                }
                return;
            }

            log.info('grand restore finish');

            delete storage.notFoundWindowsAddonStoppedWorking;
        }

        await Windows.tryRestoreMissedTabs(false);

        windows = await Windows.initializeGroups(data.groups, storage.isBackupRestoring);

        await Groups.fillHistory(windows);

        await Tabs.removeUnusedTemporaryContainers();
        log.log('Tabs.removeUnusedTemporaryContainers finish');

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
        External.send('i-am-back');

        log.log('loading groups for creating cache...');
        await Groups.load(null, true, {includeFavIconUrl: true}); // load favIconUrls, speed up first run popup
    } catch (e) {
        await setActionToReloadAddon();

        if (e) {
            log.handleError(e, 'with errors:');
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

function showConflictedExtensions() {
    if (Extensions.detectConflicted()) {
        Windows.createPopup({
            url: Constants.PAGES.HELP.CONFLICTED_EXTENSIONS,
        });
    }
}

Listeners.extension.onStart.add(showConflictedExtensions);
Extensions.onChanged(showConflictedExtensions);

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
