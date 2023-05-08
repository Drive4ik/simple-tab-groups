import Logger from './logger.js';
import backgroundSelf from './background.js';
import * as Constants from './constants.js';
import * as Storage from './storage.js';
import * as Cache from './cache.js';
import * as Containers from './containers.js';
// import Messages from './messages.js';
// import JSON from './json.js';
import * as Groups from './groups.js';
import * as Utils from './utils.js';

const logger = new Logger('ParentGroups');

// if set return {parent, parents, parentIndex}
export async function load(parentId = null) {
    const log = logger.start('load', parentId);

    let {parents} = await Storage.get('parents')

    log.stop();

    const parentIndex = parents.findIndex(parent => parent.id === parentId);

    return {
        parent: parents[parentIndex],
        parents,
        parentIndex,
        archivedGroups: parents.filter(parent => parent.isArchive),
        notArchivedGroups: parents.filter(parent => !parent.isArchive),
    };
}

export async function save(parents, withMessage = false) {
    const log = logger.start('save', {withMessage});

    if (!Array.isArray(parents)) {
        log.throwError('parents has invalid type');
    }

    await Storage.set({parents});

    if (withMessage) {
        backgroundSelf.sendMessage('parents-updated');
    }

    log.stop();

    return parents;
}

export function create(id, title, defaultParentProps = {}, groupIds = []) {
    const parent = {
        id,
        title: null,
        iconColor: null,
        iconUrl: null,
        iconViewType: Constants.DEFAULT_GROUP_ICON_VIEW_TYPE,
        groupIds: groupIds.slice(0),
        isArchive: false,

        ...defaultParentProps,
    };

    if (id) { // create title for group
        parent.title = createTitle(title, id, defaultParentProps);
    } else { // create title for default group, if needed
        parent.title ??= createTitle(title, id, defaultParentProps);
    }

    parent.iconColor ??= Utils.randomColor();

    return parent;
}

export async function getDefaults() {
    const {defaultParentProps} = await Storage.get('defaultParentProps');

    const defaultParent = create(undefined, undefined, defaultParentProps);
    const defaultCleanParent = create(undefined, undefined, {});

    delete defaultParent.id;
    delete defaultParent.groupIds;

    delete defaultCleanParent.id;
    delete defaultCleanParent.groupIds;

    defaultParent.iconColor = defaultParentProps.iconColor || '';
    defaultCleanParent.iconColor = '';

    return {
        defaultParent,
        defaultCleanParent,
        defaultParentProps,
    };
}

export async function saveDefault(defaultParentProps) {
    const log = logger.start('saveDefault', defaultParentProps);

    await Storage.set({defaultParentProps});

    log.stop();
}

export async function add(parentId, groupIds = [], title = null) {
    groupIds = groupIds?.slice?.() || [];
    title = title?.slice(0, 256);

    const log = logger.start('add', {parentId, groupIds, title});

    const {parents} = await load();
    const newParent = create('p-' + Date.now(), title, {}, groupIds);

    parents.push(newParent);

    await save(parents);

    if (groupIds.length) {
        newParent.groupIds = groupIds
    }

    backgroundSelf.sendMessage('parent-added', {
        parent: newParent,
    });

    backgroundSelf.sendExternalMessage('parent-added', {
        parent: mapForExternalExtension(newParent),
    });

    return log.stop(newParent);
}

export async function remove(parentId) {
    const log = logger.start('remove', parentId);

    const [
        {parent, parents, parentIndex},
        {defaultParentProps},
    ] = await Promise.all([
        load(parentId),
        getDefaults(),
    ]);

    if (!parent) {
        log.stopError('parentId', parentId, 'not found');
        return;
    }

    parent.groupIds.map(groupId => {
        Groups.remove(groupId).catch(log.onCatch('cant remove group', false));
    })

    parents.splice(parentIndex, 1);


    await save(parents);

    if (!parent.isArchive) {
        parent.groupIds.map(groupId => Groups.remove(groupId).catch(log.onCatch('cant remove group', false)));
        backgroundSelf.updateMoveTabMenus();
    }

    backgroundSelf.removeGroupBookmark(parent).catch(log.onCatch('cant remove parent bookmark', false));

    backgroundSelf.sendMessage('parent-removed', {
        parentId: parentId,
    });

    backgroundSelf.sendExternalMessage('parent-removed', {
        parentId: parent,
    });

    log.stop();
}

export async function update(parentId, updateData) {
    const log = logger.start('update', {parentId, updateData});

    if (updateData.iconUrl?.startsWith('chrome:')) {
        Utils.notify('Icon not supported');
        delete updateData.iconUrl;
    }

    const updateDataKeys = Object.keys(updateData);

    if (!updateDataKeys.length) {
        return log.stop(null, 'no updateData keys to update');
    }

    const {parent, parents} = await load(parentId);

    if (!parent) {
        log.throwError(['group', parentId, 'not found for update it']);
    }

    // updateData = JSON.clone(updateData); // clone need for fix bug: dead object after close tab which create object

    if (updateData.title) {
        updateData.title = updateData.title.slice(0, 256);
    }

    Object.assign(parent, updateData);

    await save(parents);

    backgroundSelf.sendMessage('parent-updated', {
        parent: {
            id: parentId,
            ...updateData,
        },
    });

    if (updateDataKeys.some(key => ExternalExtensionGroupDependentKeys.has(key))) {
        backgroundSelf.sendExternalMessage('parent-updated', {
            group: mapForExternalExtension(parent),
        });
    }

    if (KEYS_RESPONSIBLE_VIEW.some(key => updateData.hasOwnProperty(key))) {
        backgroundSelf.updateMoveTabMenus();

        await backgroundSelf.updateBrowserActionData(parentId);
    }

    if (updateData.hasOwnProperty('title')) {
        backgroundSelf.updateGroupBookmarkTitle(parent);
    }

    log.stop();
}

const KEYS_RESPONSIBLE_VIEW = Object.freeze([
    'title',
    'iconUrl',
    'iconColor',
    'iconViewType',
    'isArchive',
]);

export async function move(parentId, newParentIndex) {
    const log = logger.start('move', {parentId, newParentIndex});

    let {parents, parentIndex} = await load(parentId);

    parents.splice(newParentIndex, 0, parents.splice(parentIndex, 1)[0]);

    await save(parents, true);

    backgroundSelf.updateMoveTabMenus();

    log.stop();
}

export async function sort(vector = 'asc') {
    const log = logger.start('sort', vector);

    if (!['asc', 'desc'].includes(vector)) {
        log.throwError(`invalid sort vector: ${vector}`);
    }

    let {parents} = await load();

    if ('asc' === vector) {
        parents.sort(Utils.sortBy('title'));
    } else {
        parents.sort(Utils.sortBy('title', undefined, true));
    }

    await save(parents, true);

    backgroundSelf.updateMoveTabMenus();

    log.stop();
}

export async function unload(parentId) {
    const log = logger.start('unload', parentId);

    if (!parentId) {
        Utils.notify(['parentNotFound'], 7, 'parentNotFound');
        return log.stopError(false, 'parentNotFound');
    }



    return log.stop(true);
}

export async function archiveToggle(parentId) {
    const log = logger.start('archiveToggle', parentId);

    await backgroundSelf.loadingBrowserAction();

    let {parent, parents} = await load(parentId, true),
        tabsToRemove = [];

    log.log('parent.isArchive', parent.isArchive, '=>', !parent.isArchive);

    if (parent.isArchive) {
        parent.isArchive = false;

        parent.groupIds = [];
    } else {

    }

    await save(parents);

    backgroundSelf.sendMessage('parents-updated');

    backgroundSelf.sendExternalMessage('parents-updated', {
        parent: mapForExternalExtension(parent),
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

export function mapForExternalExtension(parent) {
    return {
        id: parent.id,
        title: getTitle(parent),
        isArchive: parent.isArchive,
        iconUrl: getIconUrl(parent),
    };
}

export async function getNextTitle() {
    const [
        {lastCreatedParentPosition},
        {defaultParentProps},
    ] = await Promise.all([
        Storage.get('lastCreatedParentPosition'),
        getDefaults(),
    ]);

    return createTitle(null, lastCreatedParentPosition + 1, defaultParentProps);
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

export async function setIconUrl(parentId, iconUrl) {
    try {
        await update(parentId, {
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
            result = getIconUrl(UNKNOWN_GROUP_ICON_PROPS);
        }
    }

    if (keyInObj) {
        return {
            [keyInObj]: result,
        };
    }

    return result;
}

export function createTitle(title = null, parentId = null, defaultParentProps = {}) {
    if (title) {
        return String(title);
    }

    if (defaultParentProps.title && parentId) {
        return Utils.format(defaultParentProps.title, {index: parentId}, Utils.DATE_LOCALE_VARIABLES);
    }

    return browser.i18n.getMessage('newParentTitle', parentId || '{index}');
}

export function getTitle({id, title, isArchive, groups, iconViewType}, args = '') {
    let withActiveParent = args.includes('withActiveParent}'),
        withCountGroups = args.includes('withCountGroups'),
        withContainer = args.includes('withContainer'),
        withGroups = args.includes('withGroups'),
        beforeTitle = [];

    if (withActiveParent) {
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

    if (withCountGroups) {
        title += ' (' + groupsCountMessage(groups.slice(), isArchive) + ')';
    }

    if (withGroups) {
        if (groups.length) {
            title += ':\n' + groups
                .slice(0, 30)
                .map(group => Groups.getTitle(group, false, 70, !isArchive))
                .join('\n');

            if (groups.length > 30) {
                title += '\n...';
            }
        }
    }

    if (window.localStorage.enableDebug) {
        let windowId = Cache.getWindowId(id) || groups?.[0]?.windowId || 'no window';
        title = `@${windowId}:#${id} ${title}`;
    }

    return title;
}

export function groupsCountMessage(groups, groupIsArchived, lang = true) {
    if (groupIsArchived) {
        return lang ? browser.i18n.getMessage('parentGroupCount', groups.length) : groups.length;
    }

    let activeGroupCount = groups.filter(tab => !tab.discarded).length;

    if (lang) {
        return browser.i18n.getMessage('parentGroupsCountActive', [activeGroupCount, groups.length]);
    }

    return activeGroupCount ? (activeGroupCount + '/' + groups.length) : groups.length;
}
