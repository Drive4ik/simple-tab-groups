import './prefixed-storage.js';

import Logger from './logger.js';
import backgroundSelf from './background.js';
import * as Constants from './constants.js';
import * as Storage from './storage.js';
import * as Cache from './cache.js';
import * as Containers from './containers.js';
import * as Bookmarks from './bookmarks.js';
import * as Management from './management.js';
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

export function createId() {
    return self.crypto.randomUUID();
}

// extract "uid" from "group.id" that matches UUID
export function extractUId(groupId) {
    return groupId?.slice(0, 4);
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
        showTabAfterMovingItIntoThisGroup: false,
        showOnlyActiveTabAfterMovingItIntoThisGroup: false,
        showNotificationAfterMovingTabIntoThisGroup: true,

        ...defaultGroupProps,
    };

    if (id) { // create title for group
        group.title = createTitle(title, id, defaultGroupProps);
    } else { // create title for default group, if needed
        group.title ??= createTitle(title, null, defaultGroupProps);
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

    const [
        {groups},
        {defaultGroupProps},
    ] = await Promise.all([
        load(),
        getDefaults(),
    ]);

    const newGroup = create(createId(), title, defaultGroupProps);

    groups.push(newGroup);

    await save(groups);

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

    if (await Bookmarks.hasPermission()) {
        backgroundSelf.onBackgroundMessage({
            action: 'remove-group-from-bookmarks',
            groupId: group.id,
        }, backgroundSelf);
    }

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
        // Utils.notify('Icon not supported');
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

    if (updateDataKeys.includes('title')) {
        const {defaultGroupProps} = await getDefaults();
        updateData.title = createTitle(updateData.title, groupId, defaultGroupProps).slice(0, 256);
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

    if (KEYS_RESPONSIBLE_VIEW.some(key => updateDataKeys.includes(key))) {
        backgroundSelf.updateMoveTabMenus();

        await backgroundSelf.updateBrowserActionData(groupId);
    }

    if (await Bookmarks.hasPermission()) {
        if (updateDataKeys.includes('title')) {
            await Bookmarks.updateGroupTitle(group);
        }

        if (updateDataKeys.includes('exportToBookmarks')) {
            await backgroundSelf.onBackgroundMessage({
                action: updateData.exportToBookmarks ? 'export-group-to-bookmarks' : 'remove-group-from-bookmarks',
                groupId: group.id,
            }, backgroundSelf);
        }
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

        Management.replaceMozExtensionTabUrls(group.tabs, 'uuid');

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

        Management.replaceMozExtensionTabUrls(group.tabs, 'id');

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

function isCatchedUrl(url, catchTabRules) {
    return catchTabRules
        .split(/\s*\n\s*/)
        .map(regExpStr => regExpStr.trim())
        .filter(Boolean)
        .some(regExpStr => {
            try {
                return new RegExp(regExpStr).test(url);
            } catch (e) {}
        });
}

export function normalizeContainersInGroups(groups) {
    const allContainers = Containers.getAll(true);

    let hasChanges = false;

    groups.forEach(group => {
        const oldNewTabContainer = group.newTabContainer,
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

            if (backgroundSelf.inited) {
                backgroundSelf.sendMessage('group-updated', {
                    group: {
                        id: group.id,
                        newTabContainer: group.newTabContainer,
                        catchTabContainers: group.catchTabContainers,
                        excludeContainersForReOpen: group.excludeContainersForReOpen,
                    },
                });
            }
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

const UNKNOWN_GROUP_ICON_PROPS = {
    title: '❓',
    iconViewType: 'title',
    iconColor: 'gray',
};

export function getIconUrl(group, keyInObj = null) {
    group ??= UNKNOWN_GROUP_ICON_PROPS;

    let result = null;

    if (group.iconUrl) {
        result = group.iconUrl;
    } else {
        const iconColor = group.iconColor || 'transparent';

        let svg = Constants.GROUP_ICON_VIEW_TYPES[group.iconViewType];

        switch (group.iconViewType) {
            case 'main-squares':
                if (iconColor !== 'transparent') {
                    svg = svg.replace('transparent', iconColor);
                }
                break;
            case 'circle':
                svg = svg.replace('fill=""', `fill="${iconColor}"`);

                if (iconColor === 'transparent') {
                    svg = svg.replace('stroke-width="0"', 'stroke-width="1"');
                }
                break;
            case 'squares':
                if (iconColor !== 'transparent') {
                    svg = svg.replace('fill=""', `fill="${iconColor}"`);
                }
                break;
            case 'old-tab-groups':
                if (iconColor !== 'transparent') {
                    svg = svg.replace('fill=""', `fill="${iconColor}"`);
                }
                break;
            case 'title':
                const emoji = getEmojiIcon(group);

                svg = svg
                    .replace('position=""', emoji ? 'text-anchor="middle" x="50%"' : 'x="0"')
                    .replace('text-content', emoji || group.title);

                if (iconColor !== 'transparent') {
                    svg = svg.replace('fill=""', `fill="${iconColor}"`);
                }
                break;
        }

        try {
            result = Utils.convertSvgToUrl(svg.trim());
        } catch (e) {
            result = getIconUrl(UNKNOWN_GROUP_ICON_PROPS);
        }
    }

    return keyInObj ? {[keyInObj]: result} : result;
}

export function createTitle(title = null, groupId = null, defaultGroupProps = {}, format = true) {
    const uid = extractUId(groupId) || '{uid}';

    if (title) {
        title = String(title);
    } else if (defaultGroupProps.title) {
        title = defaultGroupProps.title;
    } else {
        title = browser.i18n.getMessage('newGroupTitle', uid);
    }

    if (format) {
        return Utils.format(title, {uid}, Utils.DATE_LOCALE_VARIABLES);
    }

    return title;
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

    if (withCountTabs) {
        title += ' (' + tabsCountMessage(tabs.slice(), isArchive) + ')';
    }

    if (withTabs) {
        if (tabs.length) {
            title += ':\n' + tabs
                .slice(0, 30)
                .map(tab => Tabs.getTitle(tab, false, 70, !isArchive))
                .join('\n');

            if (tabs.length > 30) {
                title += '\n...';
            }
        }
    }

    if (backgroundSelf.storage.enableDebug) {
        let windowId = Cache.getWindowId(id) || tabs?.[0]?.windowId || 'no window';
        title = `@${windowId}:#${id.slice(-4)} ${title}`;
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
