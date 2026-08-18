
import '/js/prefixed-storage.js';
import Lang from '/js/lang.js';
import JSON from '/js/json.js';
import * as Constants from '/js/constants.js';
import * as Extensions from '/js/extensions.js';
import * as Utils from '/js/utils.js';
import * as Tabs from '/js/tabs.js';
import * as Windows from '/js/windows.js';
import * as Messages from '/js/messages.js';

const storage = localStorage.create(Constants.MODULES.BACKGROUND);

export default [{
    version: '6',
    remove: [
        'windowsGroup',
        'showGroupCircleInSearchedTab',
        'enableKeyboardShortcutLoadNextPrevGroup',
        'enableKeyboardShortcutLoadByIndexGroup',
        'enableFastGroupSwitching',
        'enableFavIconsForNotLoadedTabs',
        'createNewGroupAfterAttachTabToNewWindow',
        'individualWindowForEachGroup',
        'openNewWindowWhenCreateNewGroup',
        'showNotificationIfGroupsNotSyncedAtStartup',
        'showGroupIconWhenSearchATab',
        'showUrlTooltipOnTabHover',
        'browserActionIconColor',
        'createThumbnailsForTabs',
        'useTabsFavIconsFromGoogleS2Converter',
        'doRemoveSTGNewTabUrls',
        'thumbnails',
        'followToLoadedGroupInSideBar',
        'withoutSession',
        'reverseTabsOnCreate',
        'enableDarkTheme',
        'autoBackupBookmarksFolderName',
        'showNotificationAfterMoveTab',
        'defaultGroupIconViewType',
        'defaultGroupIconColor',
        'discardTabsAfterHide',
        'discardAfterHideExcludeAudioTabs',
        'prependGroupTitleToWindowTitle',
        'autoBackupGroupsToFile',
        'autoBackupGroupsToBookmarks',
        'leaveBookmarksOfClosedTabs',
        'autoBackupLastBackupTimeStamp',
        'lastCreatedGroupPosition',
        'autoBackupFolderName',
        'autoBackupByDayIndex',
        'theme',
    ],
    async migration(data, applyToCurrentInstance) {
        // options, by data shape

        if (Object.hasOwn(data, 'enableDarkTheme')) {
            data.theme = data.enableDarkTheme ? 'dark' : 'auto';
        }

        if (Object.hasOwn(data, 'theme')) {
            data.colorScheme = data.theme;
        }

        if (data.autoBackupFolderName?.toLowerCase() === 'stg-backups') {
            data.autoBackupFolderName = '';
        }

        // hotkeys, by data shape
        data.hotkeys ??= [];

        const keysMap = new Map([
            [110, 'Decimal'],
            [109, 'Subtract'],
            [106, 'Multiply'],
            [111, 'Divide'],
            [222, 'Quote'],
            [192, 'Backquote'],
            [13, 'Enter'],
            [191, 'Slash'],
            [220, 'Backslash'],
            [61, 'Equal'],
            [173, 'Minus'],
            [32, 'Space'],
            [188, 'Comma'],
            [190, 'Period'],
            [59, 'Semicolon'],

            ...['Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'Enter'].map(value => [value, value]),
        ]);

        function normalizeHotkeyKey({key, keyCode}) {
            return keysMap.get(keyCode) || keysMap.get(key) || key?.toUpperCase();
        }

        for (const hotkey of data.hotkeys) {
            if (typeof hotkey.action === 'object' && hotkey.action !== null) {
                if (hotkey.action.groupId) {
                    hotkey.groupId = hotkey.action.groupId;
                }

                hotkey.action = hotkey.action.id;
            }

            if (hotkey.action === 'move-active-tab-to-custom-group') {
                hotkey.action = 'move-selected-tabs-to-custom-group';
            }

            if (Object.hasOwn(hotkey, 'key') || Object.hasOwn(hotkey, 'keyCode')) {
                if (!hotkey.value) {
                    const valueParts = [];

                    if (hotkey.ctrlKey) {
                        valueParts.push(Constants.IS_MAC ? 'MacCtrl' : 'Ctrl');
                    }

                    if (hotkey.metaKey) {
                        valueParts.push('Command');
                    }

                    if (hotkey.altKey) {
                        valueParts.push('Alt');
                    }

                    if (hotkey.shiftKey) {
                        valueParts.push('Shift');
                    }

                    valueParts.push(normalizeHotkeyKey(hotkey));

                    hotkey.value = valueParts.join('+');
                }

                delete hotkey.ctrlKey;
                delete hotkey.shiftKey;
                delete hotkey.altKey;
                delete hotkey.metaKey;
                delete hotkey.key;
                delete hotkey.keyCode;
            }
        }

        // groups, by data shape

        const autoMovePropsRenames = [
            ['showTabAfterMovingItIntoThisGroup', 'afterAutoMoveShowTab'],
            ['showOnlyActiveTabAfterMovingItIntoThisGroup', 'afterAutoMoveShowOnlyActiveTab'],
            ['showNotificationAfterMovingTabIntoThisGroup', 'afterAutoMoveShowNotification'],
        ];

        function renameAutoMoveProps(obj) {
            for (const [oldKey, newKey] of autoMovePropsRenames) {
                if (Object.hasOwn(obj, oldKey)) {
                    obj[newKey] = obj[oldKey];
                    delete obj[oldKey];
                }
            }
        }

        // the 6.0-era group defaults, frozen: the live Groups.create defaults will drift in future versions
        const exampleGroup = {
            iconUrl: null,
            iconViewType: 'main-squares',
            isArchive: false,
            discardTabsAfterHide: false,
            discardExcludeAudioTabs: false,
            prependTitleToWindow: false,
            dontUploadToCloud: false,
            exportToBookmarks: true,
            newTabContainer: Constants.DEFAULT_COOKIE_STORE_ID,
            ifDifferentContainerReOpen: false,
            excludeContainersForReOpen: [],
            isSticky: false,
            catchTabContainers: [],
            catchTabRules: '',
            moveToGroupIfNoneCatchTabRules: null,
            muteTabsWhenGroupCloseAndRestoreWhenOpen: false,
            afterAutoMoveShowTab: false,
            afterAutoMoveShowOnlyActiveTab: false,
            afterAutoMoveShowNotification: true,
            groupsNative: [],
        };

        const mainGroupId = data.groups.find(group => group.isMain)?.id;

        for (const group of data.groups) {
            delete group.windowId;
            delete group.classList;
            delete group.colorCircleHtml;
            delete group.isExpanded;

            group.title = String(group.title);

            if (Object.hasOwn(group, 'moveNewTabsToThisGroupByRegExp')) {
                group.catchTabRules = group.moveNewTabsToThisGroupByRegExp || '';
                delete group.moveNewTabsToThisGroupByRegExp;
            }

            group.iconViewType ??= 'main-squares';

            group.catchTabContainers ??= [];

            if (Object.hasOwn(group, 'ifNotDefaultContainerReOpenInNew')) {
                group.ifDifferentContainerReOpen = group.ifNotDefaultContainerReOpenInNew;
                delete group.ifNotDefaultContainerReOpenInNew;
            }

            if (!group.newTabContainer) {
                group.newTabContainer = Constants.DEFAULT_COOKIE_STORE_ID;
                group.ifDifferentContainerReOpen = false;
            }

            group.excludeContainersForReOpen ??= [];

            if (Object.hasOwn(group, 'isMain') || Object.hasOwn(group, 'moveToMainIfNotInCatchTabRules')) {
                group.moveToGroupIfNoneCatchTabRules = (group.moveToMainIfNotInCatchTabRules && mainGroupId) ? mainGroupId : null;
                delete group.isMain;
                delete group.moveToMainIfNotInCatchTabRules;
            }

            if (!Object.hasOwn(group, 'discardTabsAfterHide')) {
                group.discardTabsAfterHide = !!data.discardTabsAfterHide && !group.dontDiscardTabsAfterHideThisGroup;
            }

            delete group.dontDiscardTabsAfterHideThisGroup;

            if (!Object.hasOwn(group, 'discardExcludeAudioTabs')) {
                group.discardExcludeAudioTabs = !!group.discardTabsAfterHide && !!data.discardAfterHideExcludeAudioTabs;
            }

            if (!Object.hasOwn(group, 'prependTitleToWindow')) {
                group.prependTitleToWindow = !!data.prependGroupTitleToWindowTitle;
            }

            if (Object.hasOwn(data, 'autoBackupGroupsToBookmarks') && !Object.hasOwn(group, 'exportToBookmarksWhenAutoBackup')) {
                group.exportToBookmarksWhenAutoBackup = !!data.autoBackupGroupsToBookmarks;
            }

            renameAutoMoveProps(group);

            if (Object.hasOwn(data, 'showNotificationAfterMoveTab') && !Object.hasOwn(group, 'afterAutoMoveShowNotification')) {
                group.afterAutoMoveShowNotification = data.showNotificationAfterMoveTab;
            }

            group.tabs = group.tabs.filter(Boolean);

            for (const tab of group.tabs) {
                if (tab.session) {
                    if (tab.session.favIconUrl) {
                        tab.favIconUrl = tab.session.favIconUrl;
                    }

                    if (tab.session.thumbnail) {
                        tab.thumbnail = tab.session.thumbnail;
                    }

                    delete tab.session;
                }
            }

            delete group.leaveBookmarksOfClosedTabs;
            delete group.bookmarkId;

            if (Object.hasOwn(group, 'exportToBookmarksWhenAutoBackup')) {
                group.exportToBookmarks = group.exportToBookmarksWhenAutoBackup;
                delete group.exportToBookmarksWhenAutoBackup;
            }

            if (group.isArchive) {
                Extensions.tabsToId(group.tabs);
            }

            for (const key in exampleGroup) {
                if (!Object.hasOwn(group, key)) {
                    group[key] = JSON.clone(exampleGroup[key]);
                }
            }
        }

        // defaultGroupProps, by data shape
        data.defaultGroupProps ??= {};

        renameAutoMoveProps(data.defaultGroupProps);

        if (data.defaultGroupIconViewType && data.defaultGroupIconViewType !== 'main-squares') {
            data.defaultGroupProps.iconViewType ??= data.defaultGroupIconViewType;
        }

        if (data.defaultGroupIconColor) {
            data.defaultGroupProps.iconColor ??= data.defaultGroupIconColor;
        }

        if (data.discardTabsAfterHide) {
            data.defaultGroupProps.discardTabsAfterHide ??= true;

            if (data.discardAfterHideExcludeAudioTabs) {
                data.defaultGroupProps.discardExcludeAudioTabs ??= true;
            }
        }

        if (data.prependGroupTitleToWindowTitle) {
            data.defaultGroupProps.prependTitleToWindow ??= true;
        }

        if (data.autoBackupGroupsToBookmarks) {
            data.defaultGroupProps.exportToBookmarksWhenAutoBackup ??= true;
        }

        delete data.defaultGroupProps.leaveBookmarksOfClosedTabs;

        if (data.defaultGroupProps.exportToBookmarksWhenAutoBackup !== undefined) {
            data.defaultGroupProps.exportToBookmarks = data.defaultGroupProps.exportToBookmarksWhenAutoBackup;
        }

        delete data.defaultGroupProps.exportToBookmarksWhenAutoBackup;

        data.browserSettings ??= {};

        if (applyToCurrentInstance) {
            // the key is consumed here; a repeated run after a crash must not force false
            if (localStorage.showArchivedGroupsInPopup !== undefined) {
                data.showArchivedGroups = localStorage.showArchivedGroupsInPopup === '1';
            }

            // a crashed earlier run has already consumed these source keys - a repeated run
            // must not overwrite the transferred values with emptiness
            storage.autoBackupLastTimeStamp = data.autoBackupLastBackupTimeStamp ?? storage.autoBackupLastTimeStamp;
            storage.mainBookmarksFolderId = localStorage.mainBookmarksFolderId ?? storage.mainBookmarksFolderId;
            storage.showTabsInThisWindowWereHidden = Number(localStorage.showTabsInThisWindowWereHidden) || storage.showTabsInThisWindowWereHidden || 0;

            delete localStorage.START_TIME;
            delete localStorage.autoBackupLastTimeStamp;
            delete localStorage.mainBookmarksFolderId;
            delete localStorage.showArchivedGroupsInPopup;
            delete localStorage.showTabsInThisWindowWereHidden;
            delete localStorage.optionsSection;
            delete localStorage.enableDebug;

            try {
                let errorLogs = localStorage.errorLogs;
                delete localStorage.errorLogs;
                errorLogs = JSON.parse(errorLogs);

                if (Array.isArray(errorLogs) && errorLogs.length) {
                    localStorage.create(Constants.MODULES.LOGGER).errors = errorLogs;
                }
            } catch {}

            // pre-3.0 stg-newtab pages: reopen with their target urls, the user must not lose these tabs
            const stgNewTabs = await browser.tabs.query({
                url: 'moz-extension://*/stg-newtab/newtab.html*',
            });

            if (stgNewTabs.length) {
                for (const tab of stgNewTabs) {
                    delete tab.groupId; // native groupId conflicts with STG groupId key
                    Tabs.normalizeUrl(tab);
                }

                await Tabs.createMultiple(stgNewTabs, true);

                await Tabs.remove(stgNewTabs);
            }
        }

        // ! MIGRATE group ids from small int to UUID

        const groupIdsMap = new Map;

        async function createGroupUUID(group) {
            const similarityData = [
                'title',
                'iconUrl',
                'iconColor',
                'iconViewType',
            ].map(key => group[key]);

            let newGroupId = await Utils.dataToUUIDv8(similarityData);

            if (new Set(groupIdsMap.values()).has(newGroupId)) {
                newGroupId = await Utils.dataToUUIDv8([group.id, ...similarityData]);
            }

            return newGroupId;
        }

        // an id that is already a UUID keeps its identity - a repeated run and UUID-era
        // pre-6 data must not re-mint ids the sessions already reference
        for (const group of data.groups) {
            if (Utils.isUUID(group.id)) {
                groupIdsMap.set(group.id, group.id);
            }
        }

        for (const group of data.groups) {
            if (!Utils.isUUID(group.id)) {
                const oldGroupId = String(group.id);
                const newGroupId = await createGroupUUID(group);

                groupIdsMap.set(oldGroupId, newGroupId);
                group.id = newGroupId;
            }

            // only after the id: a random color inside the similarity data would break
            // the deterministic id on a repeated run
            if (group.iconColor === undefined || group.iconColor === 'undefined') { // fix missed group icons :)
                group.iconColor = Utils.randomColor();
            }

            if (!group.iconColor?.trim()) {
                group.iconColor = 'transparent';
            }
        }

        function getNewGroupId(groupId) {
            if (!groupId) {
                return null;
            }

            return groupIdsMap.get(String(groupId)) || null;
        }

        for (const group of data.groups) {
            if (group.moveToGroupIfNoneCatchTabRules) {
                group.moveToGroupIfNoneCatchTabRules = getNewGroupId(group.moveToGroupIfNoneCatchTabRules);
            }
        }

        if (data.defaultGroupProps.moveToGroupIfNoneCatchTabRules) {
            data.defaultGroupProps.moveToGroupIfNoneCatchTabRules = getNewGroupId(data.defaultGroupProps.moveToGroupIfNoneCatchTabRules);
        }

        if (!data.defaultGroupProps.moveToGroupIfNoneCatchTabRules) {
            delete data.defaultGroupProps.moveToGroupIfNoneCatchTabRules;
        }

        for (const hotkey of data.hotkeys) {
            hotkey.groupId = getNewGroupId(hotkey.groupId);
        }

        if (applyToCurrentInstance) {
            // pre-4.0 model: tabs of not loaded groups exist only in the saved data - adopt the
            // live tabs and create the missing ones, otherwise the commit strips them away forever
            if (data.groups.some(group => !group.isArchive && group.tabs.length)) {
                const preWindows = await Windows.load(true, true, true);

                // Windows.load swallows API errors into an empty list; committing without the
                // materialization would strip these tabs away forever - abort instead, the
                // untouched data will retry on the next start
                if (!preWindows.length) {
                    throw Lang('notFoundWindowsAddonStoppedWorking');
                }

                await Promise.allSettled(preWindows.map(win => Tabs.createTempActiveTab(win.id, false, 'about:blank')));

                const allTabs = Utils.flatTabs(preWindows);

                await Tabs.hide(allTabs, true);

                data.groups = await Tabs.reconcile(data.groups, allTabs);
            }

            // update group id for all windows
            const windows = await browser.windows.getAll({
                windowTypes: [browser.windows.WindowType.NORMAL],
            });

            await Promise.allSettled(windows.map(async win => {
                const groupId = await browser.sessions.getWindowValue(win.id, 'groupId');

                // already a UUID - an interrupted earlier run rewrote this window; the repeated
                // run has no int→UUID mapping for it and must not erase the binding
                if (Utils.isUUID(groupId)) {
                    return;
                }

                const newGroupId = getNewGroupId(groupId);

                if (newGroupId) {
                    await browser.sessions.setWindowValue(win.id, 'groupId', newGroupId);
                } else {
                    await browser.sessions.removeWindowValue(win.id, 'groupId');
                }
            }));

            // update group id for all tabs
            const tabs = await browser.tabs.query({
                pinned: false,
                windowType: browser.windows.WindowType.NORMAL,
            });

            await Promise.allSettled(tabs.map(async tab => {
                delete tab.groupId; // native groupId conflicts with STG groupId key
                const groupId = await browser.sessions.getTabValue(tab.id, 'groupId');

                // already a UUID - an interrupted earlier run rewrote this tab; the repeated
                // run has no int→UUID mapping for it and must not erase the membership
                if (Utils.isUUID(groupId)) {
                    return;
                }

                const newGroupId = getNewGroupId(groupId);

                if (groupId) {
                    if (newGroupId) {
                        await browser.sessions.setTabValue(tab.id, 'groupId', newGroupId);
                    } else {
                        await browser.sessions.removeTabValue(tab.id, 'groupId');
                    }
                }
            }));

            // adopt the live native groups of each window: per-tab membership → sessions,
            // metadata → the STG group that OWNS the member tabs. Hidden tabs keep their native
            // membership (docs/TABGROUPS-BEHAVIOR.md §4) and pre-5.5 STG hid tabs without
            // ungrouping, so one live group can span several STG groups: visible members belong
            // to the window's active group, hidden ones to their unloaded groups. Every
            // (live group, owner) pair gets its OWN stable id - one id never lives in two STG
            // groups. The id minting is inlined - group identity must not depend on evolving
            // module code
            await Promise.allSettled(windows.map(async win => {
                const groupsNativeList = await browser.tabGroups.query({windowId: win.id});

                if (!groupsNativeList.length) {
                    return;
                }

                const liveById = new Map(groupsNativeList.map(groupNative => [groupNative.id, groupNative]));
                const activeStgGroupId = await browser.sessions.getWindowValue(win.id, 'groupId');

                const winTabs = await browser.tabs.query({
                    windowId: win.id,
                    pinned: false,
                });

                const stableIdByOwnerAndLiveId = new Map;

                for (const tab of winTabs) {
                    const live = liveById.get(tab.groupId);

                    if (!live) {
                        continue;
                    }

                    const sessionGroupId = await browser.sessions.getTabValue(tab.id, 'groupId');
                    const ownerGroupId = sessionGroupId ?? (tab.hidden ? null : activeStgGroupId) ?? null;
                    const key = `${ownerGroupId}:${live.id}`;

                    let stableId = stableIdByOwnerAndLiveId.get(key);

                    if (!stableId) {
                        stableId = self.crypto.randomUUID().slice(0, 8);
                        stableIdByOwnerAndLiveId.set(key, stableId);

                        const ownerGroup = data.groups.find(gr => gr.id === ownerGroupId);

                        if (ownerGroup && !ownerGroup.isArchive) {
                            ownerGroup.groupsNative.push({
                                id: stableId,
                                title: live.title,
                                collapsed: live.collapsed,
                                color: live.color,
                            });
                        }
                    }

                    await browser.sessions.setTabValue(tab.id, 'groupNativeId', stableId);
                }
            }));

            // migrate STG addons
            const STG_GROUP_NOTES_ID = 'stg-plugin-group-notes@drive4ik';
            const result = await Messages.sendExternalMessage(STG_GROUP_NOTES_ID, {
                action: 'get-backup',
            });

            if (result?.backup) {
                const backupData = {};
                const keyStart = 'group-';
                let hasOldKeys = false;

                for (const [key, value] of Object.entries(result.backup)) {
                    let groupId;

                    if (Number(key) == key) {
                        groupId = Number(key);
                    } else if (key.startsWith(keyStart)) {
                        const keyPart = key.slice(keyStart.length);

                        if (!Utils.isUUID(keyPart)) {
                            groupId = Number(keyPart);
                        }
                    }

                    // set-backup replaces the WHOLE plugin storage - unknown keys (plugin
                    // options, notes already keyed by UUID) must survive the round trip
                    if (groupId === undefined) {
                        backupData[key] = value;
                        continue;
                    }

                    hasOldKeys = true;

                    const newGroupId = getNewGroupId(groupId);

                    if (newGroupId) {
                        backupData[`${keyStart}${newGroupId}`] = value;
                    }
                }

                if (hasOldKeys) {
                    await Messages.sendExternalMessage(STG_GROUP_NOTES_ID, {
                        action: 'set-backup',
                        backup: backupData,
                    });
                }
            }
        }

        // migrate backup folder to file path
        if (Object.hasOwn(data, 'autoBackupFolderName') || Object.hasOwn(data, 'autoBackupByDayIndex')) {
            data.autoBackupFilePath = data.autoBackupFolderName || '';

            if (
                !data.autoBackupFolderName?.length ||
                /^STG\-backups\-FF\-[a-z\d\.]+$/.test(data.autoBackupFolderName) ||
                /^STG\-backups\-(win|linux|mac|openbsd)\-\d+$/.test(data.autoBackupFolderName)
            ) {
                data.autoBackupFilePath = `STG-backups-FF-{ff-version}/`;
            } else {
                data.autoBackupFilePath += '/';
            }

            if (data.autoBackupByDayIndex) {
                data.autoBackupFilePath += `auto-stg-backup-day-of-month-{day-2-digit}@drive4ik`;
            } else {
                data.autoBackupFilePath += `STG-backup {date-full} {time-short}@drive4ik`;
            }
        }
    },
}];
