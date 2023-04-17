import Logger from './logger.js';
import backgroundSelf from './background.js';
import * as Constants from './constants.js';
import * as Storage from './storage.js';
import * as Cache from './cache.js';
import * as Containers from './containers.js';
// import Messages from './messages.js';
// import JSON from './json.js';
import * as Tabs from './tabs.js';
import * as Utils from './utils.js';

const logger = new Logger('Groups');

// if set return {group, groups, groupIndex}
export async function load(groupId = null, withTabs = false, includeFavIconUrl, includeThumbnail) {
    const log = logger.start('load', groupId, {withTabs, includeFavIconUrl, includeThumbnail});

    let [allTabs, {groups}] = await Promise.all([
        withTabs ? Tabs.get(null, false, null, undefined, includeFavIconUrl, includeThumbnail) : false,
        Storage.get('groups')
    ]);

    if (withTabs) {
        let groupTabs = groups.reduce((acc, group) => (acc[group.id] = [], acc), {});

        await Promise.all(allTabs.map(async function(tab) {
            if (tab.groupId) {
                if (groupTabs[tab.groupId]) {
                    groupTabs[tab.groupId].push(tab);
                } else {
                    delete tab.groupId;
                    await Cache.removeTabGroup(tab.id);
                }
            }
        }));

        groups = groups.map(function(group) {
            if (!group.isArchive) {
                group.tabs = groupTabs[group.id].sort(Utils.sortBy('index'));
            }

            return group;
        });
    }

    log.stop();

    const groupIndex = groups.findIndex(group => group.id === groupId);

    return {
        group: groups[groupIndex],
        groups,
        groupIndex,
        archivedGroups: groups.filter(group => group.isArchive),
        notArchivedGroups: groups.filter(group => !group.isArchive),
    };
}

export async function save(groups, withMessage = false) {
    const log = logger.start('save', {withMessage});

    if (!Array.isArray(groups)) {
        log.throwError('groups has invalid type');
    }

    await Storage.set({groups});

    if (isNeedBlockBeforeRequest(groups)) {
        backgroundSelf.addListenerOnBeforeRequest();
    } else {
        backgroundSelf.removeListenerOnBeforeRequest();
    }

    if (withMessage) {
        backgroundSelf.sendMessage('groups-updated');
    }

    log.stop();

    return groups;
}

export function create(id, title, defaultGroupProps = {}) {
    const group = {
        id,
        title: null,
        iconColor: null,
        iconUrl: null,
        iconViewType: Constants.DEFAULT_GROUP_ICON_VIEW_TYPE,
        tabs: [],
        isArchive: false,
        discardTabsAfterHide: false,
        discardExcludeAudioTabs: false,
        prependTitleToWindow: false,
        exportToBookmarksWhenAutoBackup: true,
        leaveBookmarksOfClosedTabs: false,
        newTabContainer: Constants.DEFAULT_COOKIE_STORE_ID,
        ifDifferentContainerReOpen: false,
        excludeContainersForReOpen: [],
        isSticky: false,
        catchTabContainers: [],
        catchTabRules: '',
        moveToGroupIfNoneCatchTabRules: null,
        muteTabsWhenGroupCloseAndRestoreWhenOpen: false,
        showTabAfterMovingItIntoThisGroup: false,
        showOnlyActiveTabAfterMovingItIntoThisGroup: false,
        showNotificationAfterMovingTabIntoThisGroup: true,
        bookmarkId: null,

        ...defaultGroupProps,
    };

    if (id) { // create title for group
        group.title = createTitle(title, id, defaultGroupProps);
    } else { // create title for default group, if needed
        group.title ??= createTitle(title, id, defaultGroupProps);
    }

    group.iconColor ??= Utils.randomColor();

    return group;
}

export async function getDefaults() {
    const {defaultGroupProps} = await Storage.get('defaultGroupProps');

    const defaultGroup = create(undefined, undefined, defaultGroupProps);
    const defaultCleanGroup = create(undefined, undefined, {});

    delete defaultGroup.id;
    delete defaultGroup.tabs;

    delete defaultCleanGroup.id;
    delete defaultCleanGroup.tabs;

    defaultGroup.iconColor = defaultGroupProps.iconColor || '';
    defaultCleanGroup.iconColor = '';

    return {
        defaultGroup,
        defaultCleanGroup,
        defaultGroupProps,
    };
}

export async function saveDefault(defaultGroupProps) {
    const log = logger.start('saveDefault', defaultGroupProps);

    await Storage.set({defaultGroupProps});

    log.stop();
}

export async function add(windowId, tabIds = [], title = null) {
    tabIds = tabIds?.slice?.() || [];
    title = title?.slice(0, 256);

    const log = logger.start('add', {windowId, tabIds, title});

    const windowGroupId = Cache.getWindowGroup(windowId);

    if (windowGroupId) {
        const result = await unload(windowGroupId);

        if (!result) {
            log.stopError('cant unload');
            return;
        }
    }

    let [
        {lastCreatedGroupPosition},
        {defaultGroupProps},
    ] = await Promise.all([
        Storage.get('lastCreatedGroupPosition'),
        getDefaults(),
    ]);

    lastCreatedGroupPosition++;

    const {groups} = await load(),
        newGroup = create(lastCreatedGroupPosition, title, defaultGroupProps);

    groups.push(newGroup);

    await save(groups);

    await Storage.set({lastCreatedGroupPosition});

    if (windowId) {
        await Cache.setWindowGroup(windowId, newGroup.id);
        await backgroundSelf.updateBrowserActionData(newGroup.id);
    }

    backgroundSelf.updateMoveTabMenus();

    if (windowId && !tabIds.length) {
        tabIds = await Tabs.get(windowId).then(tabs => tabs.map(Tabs.extractId));
    }

    if (tabIds.length) {
        newGroup.tabs = await Tabs.move(tabIds, newGroup.id, {
            ...newGroup,
            showNotificationAfterMovingTabIntoThisGroup: false,
        });
    }

    backgroundSelf.sendMessage('group-added', {
        group: newGroup,
    });

    backgroundSelf.sendExternalMessage('group-added', {
        group: mapForExternalExtension(newGroup),
    });

    return log.stop(newGroup);
}

export async function remove(groupId) {
    const log = logger.start('remove', groupId);

    const groupWindowId = Cache.getWindowId(groupId);

    log.log('groupWindowId', groupWindowId);

    if (groupWindowId) {
        const result = await unload(groupId);

        if (!result) {
            log.stopError('cant unload');
            return;
        }
    }

    const [
        {group, groups, groupIndex},
        {defaultGroupProps},
    ] = await Promise.all([
        load(groupId, true),
        getDefaults(),
    ]);

    if (!group) {
        log.stopError('groupId', groupId, 'not found');
        return;
    }

    backgroundSelf.addUndoRemoveGroupItem(group);

    groups.splice(groupIndex, 1);

    groups.forEach(gr => {
        if (gr.moveToGroupIfNoneCatchTabRules === group.id) {
            gr.moveToGroupIfNoneCatchTabRules = null;
            log.log('remove moveToGroupIfNoneCatchTabRules from group', gr.id);
        }
    });

    await save(groups);

    if (defaultGroupProps.moveToGroupIfNoneCatchTabRules === group.id) {
        log.log('remove moveToGroupIfNoneCatchTabRules from default group props');
        delete defaultGroupProps.moveToGroupIfNoneCatchTabRules;
        await saveDefault(defaultGroupProps);
    }

    if (!group.isArchive) {
        await Tabs.remove(group.tabs);

        backgroundSelf.updateMoveTabMenus();
    }

    backgroundSelf.removeGroupBookmark(group).catch(log.onCatch('cant remove group bookmark', false));

    backgroundSelf.sendMessage('group-removed', {
        groupId: groupId,
        windowId: groupWindowId,
    });

    backgroundSelf.sendExternalMessage('group-removed', {
        groupId: groupId,
        windowId: groupWindowId,
    });

    log.stop();
}

export async function update(groupId, updateData) {
    const log = logger.start('update', {groupId, updateData});

    if (updateData.iconUrl?.startsWith('chrome:')) {
        Utils.notify('Icon not supported');
        delete updateData.iconUrl;
    }

    const updateDataKeys = Object.keys(updateData);

    if (!updateDataKeys.length) {
        return log.stop(null, 'no updateData keys to update');
    }

    const {group, groups} = await load(groupId);

    if (!group) {
        log.throwError(['group', groupId, 'not found for update it']);
    }

    // updateData = JSON.clone(updateData); // clone need for fix bug: dead object after close tab which create object

    if (updateData.title) {
        updateData.title = updateData.title.slice(0, 256);
    }

    Object.assign(group, updateData);

    await save(groups);

    backgroundSelf.sendMessage('group-updated', {
        group: {
            id: groupId,
            ...updateData,
        },
    });

    if (updateDataKeys.some(key => ExternalExtensionGroupDependentKeys.has(key))) {
        backgroundSelf.sendExternalMessage('group-updated', {
            group: mapForExternalExtension(group),
        });
    }

    if (KEYS_RESPONSIBLE_VIEW.some(key => updateData.hasOwnProperty(key))) {
        backgroundSelf.updateMoveTabMenus();

        await backgroundSelf.updateBrowserActionData(groupId);
    }

    if (updateData.hasOwnProperty('title')) {
        backgroundSelf.updateGroupBookmarkTitle(group);
    }

    log.stop();
}

const KEYS_RESPONSIBLE_VIEW = Object.freeze([
    'title',
    'iconUrl',
    'iconColor',
    'iconViewType',
    'isArchive',
    'isSticky',
    'prependTitleToWindow',
]);

export async function move(groupId, newGroupIndex) {
    const log = logger.start('move', {groupId, newGroupIndex});

    let {groups, groupIndex} = await load(groupId);

    groups.splice(newGroupIndex, 0, groups.splice(groupIndex, 1)[0]);

    await save(groups, true);

    backgroundSelf.updateMoveTabMenus();

    log.stop();
}

export async function sort(vector = 'asc') {
    const log = logger.start('sort', vector);

    if (!['asc', 'desc'].includes(vector)) {
        log.throwError(`invalid sort vector: ${vector}`);
    }

    let {groups} = await load();

    if ('asc' === vector) {
        groups.sort(Utils.sortBy('title'));
    } else {
        groups.sort(Utils.sortBy('title', undefined, true));
    }

    await save(groups, true);

    backgroundSelf.updateMoveTabMenus();

    log.stop();
}

export async function unload(groupId) {
    const log = logger.start('unload', groupId);

    if (!groupId) {
        Utils.notify(['groupNotFound'], 7, 'groupNotFound');
        return log.stopError(false, 'groupNotFound');
    }

    const windowId = Cache.getWindowId(groupId);

    if (!windowId) {
        Utils.notify(['groupNotLoaded'], 7, 'groupNotLoaded');
        return log.stopError(false, 'groupNotLoaded');
    }

    const {group} = await load(groupId, true);

    if (!group) {
        Utils.notify(['groupNotFound'], 7, 'groupNotFound');
        return log.stopError(false, 'groupNotFound');
    }

    if (group.isArchive) {
        Utils.notify(['groupIsArchived', group.title], 7, 'groupIsArchived');
        return log.stopError(false, 'groupIsArchived');
    }

    if (group.tabs.some(Utils.isTabCanNotBeHidden)) {
        Utils.notify(['notPossibleSwitchGroupBecauseSomeTabShareMicrophoneOrCamera']);
        return log.stopError(false, 'some Tab Can Not Be Hidden');
    }

    log.log('windowId', windowId);

    await backgroundSelf.loadingBrowserAction(true, windowId);

    await Cache.removeWindowSession(windowId);

    let tabs = await Tabs.get(windowId, false, true);
    // remove tabs without group
    tabs = tabs.filter(tab => !tab.groupId);

    if (tabs.length) {
        await Tabs.show(tabs);
        await Tabs.setActive(null, tabs);
    } else {
        await Tabs.createTempActiveTab(windowId, false);
    }

    await Tabs.safeHide(group.tabs);

    if (group.discardTabsAfterHide) {
        log.log('run discard tabs');

        let tabs = group.tabs;

        if (group.discardExcludeAudioTabs) {
            tabs = group.tabs.filter(tab => !tab.audible);
        }

        Tabs.discard(tabs).catch(log.onCatch(['Tabs.discard from unload group', tabs]));
    }

    await backgroundSelf.updateBrowserActionData(null, windowId);

    backgroundSelf.updateMoveTabMenus();

    backgroundSelf.sendMessage('group-unloaded', {
        groupId,
        windowId,
    });

    backgroundSelf.sendExternalMessage('group-unloaded', {
        groupId,
        windowId,
    });

    return log.stop(true);
}

export async function archiveToggle(groupId) {
    const log = logger.start('archiveToggle', groupId);

    await backgroundSelf.loadingBrowserAction();

    let {group, groups} = await load(groupId, true),
        tabsToRemove = [];

    log.log('group.isArchive', group.isArchive, '=>', !group.isArchive);

    if (group.isArchive) {
        group.isArchive = false;

        await backgroundSelf.createTabsSafe(setNewTabsParams(group.tabs, group), true);

        group.tabs = [];
    } else {
        if (Cache.getWindowId(groupId)) {
            const result = await unload(groupId);

            if (!result) {
                log.stopError('cant unload group');
                return null;
            }

            ({group, groups} = await load(groupId, true));
        }

        tabsToRemove = group.tabs;

        group.isArchive = true;
        group.tabs = Tabs.prepareForSave(group.tabs, false, true, true);
    }

    await save(groups);

    if (tabsToRemove.length) {
        backgroundSelf.addExcludeTabIds(tabsToRemove);
        await Tabs.remove(tabsToRemove);
        backgroundSelf.removeExcludeTabIds(tabsToRemove);
    }

    backgroundSelf.sendMessage('groups-updated');

    backgroundSelf.sendExternalMessage('group-updated', {
        group: mapForExternalExtension(group),
    });

    backgroundSelf.loadingBrowserAction(false).catch(log.onCatch('loadingBrowserAction'));

    backgroundSelf.updateMoveTabMenus();

    log.stop();
}

const ExternalExtensionGroupDependentKeys = new Set([
    'title',
    'isArchive',
    'isSticky',
    'iconColor',
    'iconUrl',
    'iconViewType',
    'newTabContainer',
]);

export function mapForExternalExtension(group) {
    return {
        id: group.id,
        title: getTitle(group),
        isArchive: group.isArchive,
        isSticky: group.isSticky,
        iconUrl: getIconUrl(group),
        contextualIdentity: Containers.get(group.newTabContainer),
        windowId: Cache.getWindowId(group.id) || null,
    };
}

export function getNewTabParams({id, newTabContainer, ifDifferentContainerReOpen, excludeContainersForReOpen}) {
    return {groupId: id, newTabContainer, ifDifferentContainerReOpen, excludeContainersForReOpen};
}

export function setNewTabsParams(tabs, group) {
    let newTabParams = getNewTabParams(group);

    return tabs.map(tab => Object.assign(tab, newTabParams));
}

export async function getNextTitle() {
    const [
        {lastCreatedGroupPosition},
        {defaultGroupProps},
    ] = await Promise.all([
        Storage.get('lastCreatedGroupPosition'),
        getDefaults(),
    ]);

    return createTitle(null, lastCreatedGroupPosition + 1, defaultGroupProps);
}

function isCatchedUrl(url, catchTabRules) {
    return catchTabRules
        .split(/\s*\n\s*/)
        .map(regExpStr => regExpStr.trim())
        .filter(Boolean)
        .some(regExpStr => {
            try {
                return new RegExp(regExpStr).test(url);
            } catch (e) {};
        });
}

export function normalizeContainersInGroups(groups) {
    let allContainers = Containers.getAll(true),
        hasChanges = false;

    groups.forEach(function(group) {
        let oldNewTabContainer = group.newTabContainer,
            oldCatchTabContainersLength = group.catchTabContainers.length,
            oldExcludeContainersForReOpenLength = group.excludeContainersForReOpen.length;

        group.newTabContainer = Containers.get(group.newTabContainer, 'cookieStoreId', true);
        group.catchTabContainers = group.catchTabContainers.filter(cookieStoreId => allContainers[cookieStoreId]);
        group.excludeContainersForReOpen = group.excludeContainersForReOpen.filter(cookieStoreId => allContainers[cookieStoreId]);

        if (
            oldNewTabContainer !== group.newTabContainer ||
            oldCatchTabContainersLength !== group.catchTabContainers.length ||
            oldExcludeContainersForReOpenLength !== group.excludeContainersForReOpen.length
        ) {
            hasChanges = true;

            backgroundSelf.sendMessage('group-updated', {
                group: {
                    id: group.id,
                    newTabContainer: group.newTabContainer,
                    catchTabContainers: group.catchTabContainers,
                    excludeContainersForReOpen: group.excludeContainersForReOpen,
                },
            });
        }
    });

    return hasChanges;
}

export function getCatchedForTab(notArchivedGroups, currentGroup, {cookieStoreId, url}) {
    if (currentGroup.isSticky) {
        return;
    }

    const destGroup = notArchivedGroups.find(({catchTabContainers, catchTabRules}) => {
        if (catchTabContainers.includes(cookieStoreId)) {
            return true;
        }

        if (isCatchedUrl(url, catchTabRules)) {
            return true;
        }
    });

    if (destGroup) {
        if (destGroup.id === currentGroup.id) {
            return;
        }

        return destGroup;
    }

    if (currentGroup.catchTabRules && currentGroup.moveToGroupIfNoneCatchTabRules) {
        return notArchivedGroups.find(group => group.id === currentGroup.moveToGroupIfNoneCatchTabRules);
    }
}

export function isNeedBlockBeforeRequest(groups) {
    return groups.some(function({isArchive, catchTabContainers, catchTabRules, ifDifferentContainerReOpen, newTabContainer}) {
        if (isArchive) {
            return false;
        }

        if (catchTabContainers.length || catchTabRules) {
            return true;
        }

        if (ifDifferentContainerReOpen) {
            return true;
        }

        return newTabContainer !== Constants.DEFAULT_COOKIE_STORE_ID;
    });
}

export async function setIconUrl(groupId, iconUrl) {
    try {
        await update(groupId, {
            iconViewType: null,
            iconUrl: await Utils.normalizeGroupIcon(iconUrl),
        });
    } catch (e) {
        Utils.notify(e);
    }
}

const emojiRegExp = /\p{RI}\p{RI}|\p{Emoji}(\p{EMod}+|\u{FE0F}\u{20E3}?|[\u{E0020}-\u{E007E}]+\u{E007F})?(\u{200D}\p{Emoji}(\p{EMod}+|\u{FE0F}\u{20E3}?|[\u{E0020}-\u{E007E}]+\u{E007F})?)+|\p{EPres}(\p{EMod}+|\u{FE0F}\u{20E3}?|[\u{E0020}-\u{E007E}]+\u{E007F})?|\p{Emoji}(\p{EMod}+|\u{FE0F}\u{20E3}?|[\u{E0020}-\u{E007E}]+\u{E007F})/u;
const firstCharEmojiRegExp = new RegExp(`^(${emojiRegExp.source})`, emojiRegExp.flags);

export function getEmojiIcon(group) {
    if (group.iconViewType === 'title') {
        const [emoji] = firstCharEmojiRegExp.exec(group.title) || [];
        return emoji;
    }
}

export function getIconUrl(group, keyInObj = null) {
    group ??= {
        iconViewType: Constants.DEFAULT_GROUP_ICON_VIEW_TYPE,
        title: browser.i18n.getMessage('title'),
    };

    let result = null;

    if (group.iconUrl) {
        result = group.iconUrl;
    } else {
        if (!group.iconColor) {
            group.iconColor = 'transparent';
        }

        const stroke = 'transparent' === group.iconColor ? 'stroke="#606060" stroke-width="1"' : '',
            emoji = getEmojiIcon(group),
            title = emoji || group.title;

        const icons = {
            'main-squares': `
            <svg width="128" height="128" xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg">
                <g fill="context-fill" fill-opacity="context-fill-opacity">
                    <rect height="32" width="32" />
                    <rect height="32" width="32" x="48" />
                    <rect height="32" width="32" x="96" y="48" />
                    <rect height="32" width="32" y="48" />
                    <rect height="32" width="32" x="48" y="48" />
                    <rect height="32" width="32" x="96" />
                    <rect height="32" width="32" y="96" />
                    <rect height="32" width="32" x="48" y="96" />
                    <rect height="32" width="32" x="96" y="96" />
                    <path transform="rotate(-90, 73, 71)" fill="${group.iconColor}" d="m16.000351,126.001527l0,-110.000003l108.999285,110.000003l-108.999285,0z"/>
                </g>
            </svg>
        `,
            circle: `
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
                <circle fill="${group.iconColor}" cx="8" cy="8" r="8" ${stroke} />
            </svg>
        `,
            squares: `
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
                <g fill="context-fill" fill-opacity="context-fill-opacity">
                    <rect x="1" y="1" width="6" height="6" rx="1" ry="1"></rect>
                    <rect x="9" y="1" width="6" height="6" rx="1" ry="1"></rect>
                    <rect x="1" y="9" width="6" height="6" rx="1" ry="1"></rect>
                    <rect x="9" y="9" width="6" height="6" rx="1" ry="1" fill="${group.iconColor}"></rect>
                </g>
            </svg>
        `,
            'old-tab-groups': `
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
                <g fill="context-fill" fill-opacity="context-fill-opacity">
                    <rect width="9" height="6" x="1" y="1" rx="1"></rect>
                    <rect width="4" height="6" x="11" y="1" rx="1"></rect>
                    <rect width="5" height="7" x="1" y="8" rx="1"></rect>
                    <rect width="8" height="7" x="7" y="8" rx="1" fill="${group.iconColor}"></rect>
                </g>
            </svg>
        `,
            'title': `
            <svg width="16" height="16" xmlns="http://www.w3.org/2000/svg">
                <text ${emoji ? 'text-anchor="middle" x="50%"' : 'x="0"'} y="13" fill="${group.iconColor}" font-family="Segoe UI, Verdana, Arial, sans-serif" font-size="12px">${title}</text>
            </svg>
        `,
        };

        try {
            result = Utils.convertSvgToUrl(icons[group.iconViewType].trim());
        } catch (e) {
            result = getIconUrl({
                title: '❓',
                iconViewType: 'title',
                iconColor: 'gray',
            });
        }
    }

    if (keyInObj) {
        return {
            [keyInObj]: result,
        };
    }

    return result;
}

export function createTitle(title = null, groupId = null, defaultGroupProps = {}) {
    if (title) {
        return String(title);
    }

    if (defaultGroupProps.title && groupId) {
        return Utils.format(defaultGroupProps.title, {
            index: groupId,
        });
    }

    return browser.i18n.getMessage('newGroupTitle', groupId || '{index}');
}

export function getTitle({id, title, isArchive, isSticky, tabs, iconViewType, newTabContainer}, args = '') {
    let withActiveGroup = args.includes('withActiveGroup'),
        withCountTabs = args.includes('withCountTabs'),
        withContainer = args.includes('withContainer'),
        withSticky = args.includes('withSticky'),
        withTabs = args.includes('withTabs'),
        beforeTitle = [];

    if (withSticky && isSticky) {
        beforeTitle.push(Constants.STICKY_SYMBOL);
    }

    if (withContainer && newTabContainer !== Constants.DEFAULT_COOKIE_STORE_ID) {
        beforeTitle.push('[' + Containers.get(newTabContainer, 'name') + ']');
    }

    if (withActiveGroup) {
        if (Cache.getWindowId(id)) {
            beforeTitle.push(Constants.ACTIVE_SYMBOL);
        } else if (isArchive) {
            beforeTitle.push(Constants.DISCARDED_SYMBOL);
        }
    }

    // replace first emoji to empty string
    if (iconViewType === 'title') {
        title = title.replace(firstCharEmojiRegExp, '');
    }

    if (beforeTitle.length) {
        title = beforeTitle.join(' ') + ' ' + title;
    }

    tabs = tabs.slice();

    if (withCountTabs) {
        title += ' (' + tabsCountMessage(tabs, isArchive) + ')';
    }

    if (withTabs && tabs.length) {
        title += ':\n' + tabs
            .slice(0, 30)
            .map(tab => Tabs.getTitle(tab, false, 70, !isArchive))
            .join('\n');

        if (tabs.length > 30) {
            title += '\n...';
        }
    }

    if (window.localStorage.enableDebug) {
        let windowId = Cache.getWindowId(id) || tabs[0]?.windowId || 'no window';
        title = `@${windowId}:#${id} ${title}`;
    }

    return title;
}

export function tabsCountMessage(tabs, groupIsArchived, lang = true) {
    if (groupIsArchived) {
        return lang ? browser.i18n.getMessage('groupTabsCount', tabs.length) : tabs.length;
    }

    let activeTabsCount = tabs.filter(tab => !tab.discarded).length;

    if (lang) {
        return browser.i18n.getMessage('groupTabsCountActive', [activeTabsCount, tabs.length]);
    }

    return activeTabsCount ? (activeTabsCount + '/' + tabs.length) : tabs.length;
}
