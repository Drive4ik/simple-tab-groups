
import '/js/prefixed-storage.js';
import Lang from '/js/lang.js';
import Logger from '/js/logger.js';
import Notification from '/js/notification.js';
import * as Constants from '/js/constants.js';
import * as Extensions from '/js/extensions.js';
import * as Utils from '/js/utils.js';
import * as Groups from '/js/groups.js';
import * as Tabs from '/js/tabs.js';
import * as Windows from '/js/windows.js';
import * as Messages from '/js/messages.js';
import * as Storage from '/js/storage.js';

const logger = new Logger(Constants.MODULES.BACKGROUND);
const storage = localStorage.create(Constants.MODULES.BACKGROUND);

const CURRENT_VERSION = Constants.MANIFEST.version;

const migrations = [];

migrations.push({
    version: '1.8.1',
    remove: ['windowsGroup'],
    migration(data) {
        data.groups = data.groups.map(function (group) {
            group.windowId = null;

            group.catchTabRules = group.moveNewTabsToThisGroupByRegExp || '';
            delete group.moveNewTabsToThisGroupByRegExp;

            delete group.classList;
            delete group.colorCircleHtml;
            delete group.isExpanded;

            if (group.iconColor === undefined || group.iconColor === 'undefined') { // fix missed group icons :)
                group.iconColor = Utils.randomColor();
            }

            return group;
        });
    },
});

migrations.push({
    version: '2.2',
    remove: ['showGroupCircleInSearchedTab'],
    migration(data) {
        if (data.hasOwnProperty('showGroupCircleInSearchedTab')) {
            data.showGroupIconWhenSearchATab = data.showGroupCircleInSearchedTab;
        }
    },
});

migrations.push({
    version: '2.3',
    remove: ['enableKeyboardShortcutLoadNextPrevGroup', 'enableKeyboardShortcutLoadByIndexGroup'],
    migration(data) {
        data.groups = data.groups.map(function (group) {
            group.tabs = group.tabs.filter(Boolean);
            return group;
        });
    },
});

migrations.push({
    version: '2.4',
    migration(data) {
        data.groups = data.groups.map(function (group) {
            if (!group.catchTabContainers) {
                group.catchTabContainers = [];
            }

            return group;
        });
    },
});

migrations.push({
    version: '2.4.5',
    migration(data) {
        data.groups = data.groups.map(function (group) {
            if (!group.iconColor?.trim()) {
                group.iconColor = 'transparent';
            }

            group.iconViewType = 'main-squares';

            return group;
        });
    },
});

migrations.push({
    version: '3.0',
    remove: ['enableFastGroupSwitching', 'enableFavIconsForNotLoadedTabs', 'createNewGroupAfterAttachTabToNewWindow', 'individualWindowForEachGroup', 'openNewWindowWhenCreateNewGroup', 'showNotificationIfGroupsNotSyncedAtStartup', 'showGroupIconWhenSearchATab', 'showUrlTooltipOnTabHover'],
    async migration(data, applyToCurrentInstance) {
        data.groups.forEach(group => group.title = Utils.unSafeHtml(group.title));

        if (applyToCurrentInstance) {
            let tabs = await browser.tabs.query({
                url: 'moz-extension://*/stg-newtab/newtab.html*',
            });

            if (tabs.length) {
                tabs.forEach(tab => delete tab.openerTabId);
                tabs.forEach(tab => delete tab.groupId); // TODO temp

                await Promise.all(tabs.map(tab => Tabs.create(Tabs.normalizeUrl(tab), true)));

                await Utils.wait(100);

                await Tabs.remove(tabs);

                await Utils.wait(100);
            }
        }
    },
});

migrations.push({
    version: '3.0.9',
    migration(data) {
        data.hotkeys.forEach(hotkey => hotkey.hasOwnProperty('metaKey') ? null : hotkey.metaKey = false);
        data.groups.forEach(group => delete group.isExpanded);
    },
});

migrations.push({
    version: '3.0.10',
    remove: ['browserActionIconColor'],
    migration(data) {
        data.hotkeys.forEach(function (hotkey) {
            if (hotkey.action.groupId) {
                hotkey.groupId = hotkey.action.groupId;
            }

            hotkey.action = hotkey.action.id;
        });
    },
});

migrations.push({
    version: '3.1',
    migration(data) {
        if (!data.thumbnails) {
            data.thumbnails = {};
        }

        data.groups.forEach(function (group) {
            group.muteTabsWhenGroupCloseAndRestoreWhenOpen = false;
            group.showTabAfterMovingItIntoThisGroup = false;

            group.tabs.forEach(function (tab) {
                if (tab.thumbnail && tab.url && !data.thumbnails[tab.url]) {
                    data.thumbnails[tab.url] = tab.thumbnail;
                }

                delete tab.thumbnail;
            });
        });
    },
});

migrations.push({
    version: '3.3.5',
    migration(data) {
        data.hotkeys.forEach(hotkey => hotkey.groupId = hotkey.groupId || 0);
    },
});

migrations.push({
    version: '3.4.4',
    remove: ['createThumbnailsForTabs'],
});

migrations.push({
    version: '4.0',
    remove: ['useTabsFavIconsFromGoogleS2Converter', 'doRemoveSTGNewTabUrls', 'thumbnails'],
    async migration(data, applyToCurrentInstance) {
        data.groups.forEach(function (group) {
            delete group.windowId;
            group.dontDiscardTabsAfterHideThisGroup = false;
        });

        let windows;

        if (applyToCurrentInstance) {
            windows = await Windows.load(true, true, true);

            if (!windows.length) {
                throw Lang('notFoundWindowsAddonStoppedWorking');
            }

            Notification('loading', {id: 'loading'});

            await Promise.all(windows.map(win => Tabs.createTempActiveTab(win.id, false, 'about:blank')));
        }

        data.groups.forEach(function (group) {
            group.tabs.forEach(function (tab) {
                if (tab.session) {
                    if (tab.session.favIconUrl) {
                        tab.favIconUrl = tab.session.favIconUrl;
                    }

                    if (tab.session.thumbnail) {
                        tab.thumbnail = tab.session.thumbnail;
                    }
                }

                delete tab.session;
            });
        });

        if (applyToCurrentInstance) {
            let allTabs = Utils.flatTabs(windows);

            await Tabs.hide(allTabs, true);

            data.groups = await Tabs.reconcile(data.groups, allTabs);

            Notification.clear('loading');

            await Utils.wait(1000);
        }
    },
});

migrations.push({
    version: '4.1',
    remove: [],
    migration(data) {
        data.groups.forEach(group => group.newTabContainer = null);

        this.remove = [];

        migrations.some(prevMigration => {
            if (prevMigration.version === '4.1') {
                return true;
            }

            if (Array.isArray(prevMigration.remove)) {
                this.remove.push(...prevMigration.remove);
            }
        });
    },
});

migrations.push({
    version: '4.2',
    remove: ['followToLoadedGroupInSideBar'],
    migration(data) {
        data.openGroupAfterChange = data.followToLoadedGroupInSideBar;
    },
});

migrations.push({
    version: '4.3.5',
    migration(data) {
        data.groups.forEach(group => group.ifNotDefaultContainerReOpenInNew = true);
    },
});

migrations.push({
    version: '4.4',
    migration(data, applyToCurrentInstance) {
        if (applyToCurrentInstance) {
            localStorage.clear();
        }

        data.groups.forEach(function (group) {
            group.isArchive = false;

            group.tabs.forEach(function (tab) {
                if (tab.session) {
                    if (tab.session.favIconUrl) {
                        tab.favIconUrl = tab.session.favIconUrl;
                    }

                    if (tab.session.thumbnail) {
                        tab.thumbnail = tab.session.thumbnail;
                    }
                }

                delete tab.session;
            });
        });
    },
});

migrations.push({
    version: '4.4.2.5',
    migration(data) {
        data.openGroupAfterChange = false;
    },
});

migrations.push({
    version: '4.5',
    remove: ['withoutSession'],
    migration(data) {
        data.groups.forEach(function (group) {
            group.isMain = false;
            group.moveToMainIfNotInCatchTabRules = false;

            group.ifDifferentContainerReOpen = group.ifNotDefaultContainerReOpenInNew;
            delete group.ifNotDefaultContainerReOpenInNew;
        });

        data.leaveBookmarksOfClosedTabs = false;

        if (data.autoBackupFolderName?.toLowerCase() === 'stg-backups') {
            data.autoBackupFolderName = '';
        }
    },
});

migrations.push({
    version: '4.5.1',
    migration(data) {
        data.groups.forEach(function (group) {
            if (!group.newTabContainer) {
                group.newTabContainer = Constants.DEFAULT_COOKIE_STORE_ID;
                group.ifDifferentContainerReOpen = false;
            }

            group.excludeContainersForReOpen = [];
        });
    },
});

migrations.push({
    version: '4.5.2',
    migration(data) {
        data.groups.forEach(function (group) {
            data.groups.forEach(function (gr) {
                if (gr.title === group.title && gr.id !== group.id) {
                    gr.title += ` ${gr.id}`;
                }
            });
        });

        data.hotkeys.forEach(function (hotkey) {
            if (hotkey.action === 'move-active-tab-to-custom-group') {
                hotkey.action = 'move-selected-tabs-to-custom-group';
            }
        });
    },
});

migrations.push({
    version: '4.5.5',
    remove: ['reverseTabsOnCreate'],
});

migrations.push({
    version: '4.7.1',
    async migration(data, applyToCurrentInstance) {
        let latestExampleGroup = Groups.create(),
            latestExampleGroupKeys = Object.keys(latestExampleGroup).filter(key => !['id', 'title', 'tabs'].includes(key));

        data.groups.forEach(function (group) {
            latestExampleGroupKeys
                .forEach(key => !group.hasOwnProperty(key) && (group[key] = JSON.clone(latestExampleGroup[key])));
        });

        if (applyToCurrentInstance) {
            await Tabs.restoreOldExtensionUrls(({url, cookieStoreId}) => {
                if (!url.includes('open-in-container')) {
                    return url;
                }

                let urlObj = new URL(url),
                    uuid = urlObj.searchParams.get('uuid');

                if (uuid) {
                    let ext = Extensions.getByUUID(uuid);

                    if (ext) {
                        urlObj.searchParams.set('conflictedExtId', ext.id);
                        urlObj.searchParams.set('destCookieStoreId', cookieStoreId);
                        urlObj.searchParams.delete('uuid');
                        url = urlObj.href;
                    }
                }

                return url;
            });
        }
    },
});

migrations.push({
    version: '4.7.2',
    remove: ['enableDarkTheme', 'autoBackupBookmarksFolderName'],
    async migration(data, applyToCurrentInstance) {
        data.theme = data.enableDarkTheme ? 'dark' : Constants.DEFAULT_OPTIONS.colorScheme;
        data.groups.forEach(group => {
            group.title = String(group.title);
            group.bookmarkId = null;
        });

        if (!applyToCurrentInstance) {
            return;
        }

        let hasBookmarksPermission = await browser.permissions.contains({
            permissions: ['bookmarks']
        });

        if (!hasBookmarksPermission) {
            return;
        }

        let _bookmarkFolderFromTitle = async function (title, parentId) {
            let bookmarks = await browser.bookmarks.search({ title });

            return bookmarks.find(b => b.type === browser.bookmarks.BookmarkTreeNodeType.FOLDER && b.parentId === parentId);
        };

        let _getBookmarkGroup = async function (title) {
            let rootFolder = {
                id: data.defaultBookmarksParent,
            };

            if (data.exportGroupToMainBookmarkFolder) {
                rootFolder = await _bookmarkFolderFromTitle(data.autoBackupBookmarksFolderName, rootFolder.id);

                if (!rootFolder) {
                    return;
                }
            }

            return _bookmarkFolderFromTitle(title, rootFolder.id);
        };

        for (let group of data.groups) {
            let bookmark = await _getBookmarkGroup(group.title);

            if (bookmark) {
                group.bookmarkId = bookmark.id;
            }
        }

        let rootFolder = await _bookmarkFolderFromTitle(data.autoBackupBookmarksFolderName, data.defaultBookmarksParent);
        if (rootFolder) {
            localStorage.mainBookmarksFolderId = rootFolder.id;
        }
    },
});

migrations.push({
    version: '4.8.1',
    remove: ['showNotificationAfterMoveTab'],
    async migration(data) {
        data.groups.forEach(group => {
            group.showNotificationAfterMovingTabIntoThisGroup = data.showNotificationAfterMoveTab;
            group.showOnlyActiveTabAfterMovingItIntoThisGroup = false;
        });

        data.closePopupAfterSelectTab = false;
    },
});

migrations.push({
    version: '5.1',
    remove: [
        'defaultGroupIconViewType',
        'defaultGroupIconColor',
        'discardTabsAfterHide',
        'discardAfterHideExcludeAudioTabs',
        'prependGroupTitleToWindowTitle',
        'autoBackupGroupsToFile',
        'autoBackupGroupsToBookmarks',
        'leaveBookmarksOfClosedTabs',
    ],
    async migration(data) {
        data.groups.forEach(group => {
            group.discardTabsAfterHide = !!data.discardTabsAfterHide && !group.dontDiscardTabsAfterHideThisGroup;
            delete group.dontDiscardTabsAfterHideThisGroup;

            group.discardExcludeAudioTabs = !!group.discardTabsAfterHide && !!data.discardAfterHideExcludeAudioTabs;

            group.prependTitleToWindow = !!data.prependGroupTitleToWindowTitle;

            group.exportToBookmarksWhenAutoBackup = !!data.autoBackupGroupsToBookmarks;
            group.leaveBookmarksOfClosedTabs = !!data.leaveBookmarksOfClosedTabs;
        });

        data.defaultGroupProps = {};

        if (data.defaultGroupIconViewType && data.defaultGroupIconViewType !== Constants.DEFAULT_GROUP_ICON_VIEW_TYPE) {
            data.defaultGroupProps.iconViewType = data.defaultGroupIconViewType;
        }

        if (data.defaultGroupIconColor && data.defaultGroupIconColor !== '') {
            data.defaultGroupProps.iconColor = data.defaultGroupIconColor;
        }

        if (data.discardTabsAfterHide) {
            data.defaultGroupProps.discardTabsAfterHide = true;
        }

        if (data.discardTabsAfterHide && data.discardAfterHideExcludeAudioTabs) {
            data.defaultGroupProps.discardExcludeAudioTabs = true;
        }

        if (data.prependGroupTitleToWindowTitle) {
            data.defaultGroupProps.prependTitleToWindow = true;
        }

        if (data.autoBackupGroupsToBookmarks) {
            data.defaultGroupProps.exportToBookmarksWhenAutoBackup = true;
        }

        if (data.autoBackupGroupsToBookmarks && data.leaveBookmarksOfClosedTabs) {
            data.defaultGroupProps.leaveBookmarksOfClosedTabs = true;
        }
    },
});

migrations.push({
    version: '5.2',
    async migration(data) {
        // migrate groups
        const mainGroupId = data.groups.find(group => group.isMain)?.id;

        data.groups.forEach(group => {
            if (group.moveToMainIfNotInCatchTabRules && mainGroupId) {
                group.moveToGroupIfNoneCatchTabRules = mainGroupId;
            } else {
                group.moveToGroupIfNoneCatchTabRules = null;
            }

            delete group.isMain;
            delete group.moveToMainIfNotInCatchTabRules;
        });

        // migrate hotkeys
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

        data.hotkeys.forEach(hotkey => {
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

            delete hotkey.ctrlKey;
            delete hotkey.shiftKey;
            delete hotkey.altKey;
            delete hotkey.metaKey;
            delete hotkey.key;
            delete hotkey.keyCode;
        });
    },
});

migrations.push({
    version: '5.5',
    remove: [
        'autoBackupLastBackupTimeStamp',
        'lastCreatedGroupPosition',
        'autoBackupFolderName',
        'autoBackupByDayIndex',
        'theme',
    ],
    async migration(data, applyToCurrentInstance) {
        for (const group of data.groups) {
            group.dontUploadToCloud = false;
            delete group.leaveBookmarksOfClosedTabs;
            group.exportToBookmarks = group.exportToBookmarksWhenAutoBackup;
            delete group.exportToBookmarksWhenAutoBackup;
            delete group.bookmarkId;

            if (group.isArchive) {
                Extensions.tabsToId(group.tabs);
            }
        }

        delete data.defaultGroupProps.leaveBookmarksOfClosedTabs;

        if (data.defaultGroupProps.exportToBookmarksWhenAutoBackup !== undefined) {
            data.defaultGroupProps.exportToBookmarks = data.defaultGroupProps.exportToBookmarksWhenAutoBackup;
        }

        delete data.defaultGroupProps.exportToBookmarksWhenAutoBackup;

        data.showArchivedGroups = localStorage.showArchivedGroupsInPopup === '1';

        data.colorScheme = data.theme;

        data.browserSettings = {};

        if (applyToCurrentInstance) {
            storage.autoBackupLastTimeStamp = data.autoBackupLastBackupTimeStamp;
            storage.mainBookmarksFolderId = localStorage.mainBookmarksFolderId;
            storage.showTabsInThisWindowWereHidden = Number(localStorage.showTabsInThisWindowWereHidden) || 0;

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

        for (const group of data.groups) {
            const oldGroupId = String(group.id);
            const newGroupId = await createGroupUUID(group);

            groupIdsMap.set(oldGroupId, newGroupId);
            group.id = newGroupId;
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

        // replace {index} => {uid} for default group title
        /* if (data.defaultGroupProps.title) {
            data.defaultGroupProps.title = Utils.format(data.defaultGroupProps.title, {index: '{uid}'});
        } */

        for (const hotkey of data.hotkeys) {
            hotkey.groupId = getNewGroupId(hotkey.groupId);
        }

        if (applyToCurrentInstance) {
            // update group id for all windows
            const windows = await browser.windows.getAll({
                windowTypes: [browser.windows.WindowType.NORMAL],
            });

            await Promise.allSettled(windows.map(async win => {
                const groupId = await browser.sessions.getWindowValue(win.id, 'groupId');

                // Re-entrancy guard: if a previous (crashed) run already rewrote this
                // session value to a UUID, leave it untouched. Re-running 5.5 over
                // already-migrated session data must be a no-op, never a removal.
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
                delete tab.groupId; // TODO temp
                const groupId = await browser.sessions.getTabValue(tab.id, 'groupId');

                // Re-entrancy guard: see windows above. An already-migrated UUID must
                // not be treated as an unknown old id and removed.
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

            // migrate STG addons
            const STG_GROUP_NOTES_ID = 'stg-plugin-group-notes@drive4ik';
            const result = await Messages.sendExternalMessage(STG_GROUP_NOTES_ID, {
                action: 'get-backup',
            });

            if (result?.backup) {
                const notesData = {};
                const keyStart = 'group-';

                for (const [key, value] of Object.entries(result.backup)) {
                    let groupId;

                    if (Number(key) == key) {
                        groupId = Number(key);
                    } else if (key.startsWith(keyStart)) {
                        const keyPart = key.slice(keyStart.length);

                        if (Utils.isUUID(keyPart)) {
                            continue;
                        }

                        groupId = Number(keyPart);
                    }

                    const newGroupId = getNewGroupId(groupId);

                    if (newGroupId) {
                        notesData[`${keyStart}${newGroupId}`] = value;
                    }
                }

                if (Object.keys(notesData).length) {
                    await Messages.sendExternalMessage(STG_GROUP_NOTES_ID, {
                        action: 'set-backup',
                        backup: notesData,
                    });
                }
            }
        }

        // migrate backup folder to file path
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
    },
});

migrations.push({
    version: '5.5.1',
    // Add a stable per-tab identity (uid) + lastModified for sync (see feat/sync-tab-uid / B3).
    // Backfill inline tabs stored in `data` (archived groups, file backups). Live tabs of
    // non-archive groups are sessions-backed and get their uid lazily on read (Cache.loadTabSession).
    migration(data) {
        const now = Utils.unixNowMs();

        data.groups?.forEach(group => {
            group.tabs?.forEach(tab => {
                tab.uid ||= self.crypto.randomUUID();
                tab.lastModified ||= now;
            });
        });
    },
});

migrations.push({
    version: '5.5.2',
    migration(data) {
        if (Array.isArray(data.contextMenuTab) && !data.contextMenuTab.includes('pin-in-group')) {
            const moveToGroupIndex = data.contextMenuTab.indexOf('move-tab-to-group');

            if (moveToGroupIndex === -1) {
                data.contextMenuTab.push('pin-in-group');
            } else {
                data.contextMenuTab.splice(moveToGroupIndex, 0, 'pin-in-group');
            }
        }
    },
});

export default async function(data, applyToCurrentInstance = false) {
    const DATA_VERSION = data?.version;

    const log = logger.start('Migration',
        'data version:', DATA_VERSION,
        'CURRENT_VERSION:', CURRENT_VERSION,
        'applyToCurrentInstance:', applyToCurrentInstance
    );

    const resultMigrate = {
        data,
        migrated: false,
        error: null,
    };

    if (DATA_VERSION === CURRENT_VERSION) {
        log.stop('data.version === CURRENT_VERSION', CURRENT_VERSION);
        return resultMigrate;
    } else if (!DATA_VERSION) {
        log.throwError('data.version is not defined');
    }

    const keysToRemoveFromStorage = new Set;

    // if data version < required latest migrate version then need migration
    if (Utils.compareNumericVersions(DATA_VERSION, migrations[migrations.length - 1].version) < 0) {

        for (const migration of migrations) {
            if (Utils.compareNumericVersions(DATA_VERSION, migration.version) < 0) {
                const mlog = log.start('', 'apply version:', migration.version, '...');

                await migration.migration?.(data, applyToCurrentInstance);

                migration.remove?.forEach(key => keysToRemoveFromStorage.add(key));

                mlog.stop();
            }
        }

    } else {
        const versionDiffIndex = Utils.compareNumericVersions(DATA_VERSION, CURRENT_VERSION);

        // Allow rollback only inside the same build line, for example 1.2.3.4 -> 1.2.3.0.
        // If major/minor/patch is newer, then this addon may not understand that data schema.
        if (versionDiffIndex > 0 && versionDiffIndex <= 3) {
            resultMigrate.error = 'updateAddonToLatestVersion';
            log.stopError(resultMigrate.error);
            return resultMigrate;
        }
    }

    data.version = CURRENT_VERSION;

    if (keysToRemoveFromStorage.size) {
        log.log('removing keys in data object:', Array.from(keysToRemoveFromStorage), '...');
        keysToRemoveFromStorage.forEach(key => delete data[key]);
        if (applyToCurrentInstance) {
            log.log('and remove these keys in storage...');
            await Storage.remove(...keysToRemoveFromStorage);
        }
    }

    resultMigrate.migrated = true;
    log.stop('migration from', DATA_VERSION, 'to', CURRENT_VERSION, 'has been finished');
    return resultMigrate;
}
