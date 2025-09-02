
import './prefixed-storage.js';
import Logger from './logger.js';
import * as Constants from './constants.js';
import * as Storage from './storage.js';

const logger = new Logger('Bookmarks');

const storage = localStorage.create('bookmarks');

const MAX_LENGTH = 1024 * 60;

export async function hasPermission() {
    return browser.permissions.contains(Constants.PERMISSIONS.BOOKMARKS);
}

async function findGroup(group, parentId, createIfNeed = false) {
    let bookmark;

    if (storage[group.id]) {
        [bookmark] = await browser.bookmarks.get(storage[group.id]).catch(() => []);

        if (!bookmark && !createIfNeed) {
            delete storage[group.id];
        }
    }

    if (!bookmark && createIfNeed) {
        bookmark = await browser.bookmarks.create({
            title: group.title,
            parentId,
            type: browser.bookmarks.BookmarkTreeNodeType.FOLDER,
        });

        storage[group.id] = bookmark.id;
    }

    if (bookmark) {
        bookmark.children = await browser.bookmarks.getChildren(bookmark.id);
    }

    return bookmark;
}

async function getGroup(group, createIfNeed) {
    const {defaultBookmarksParent} = await Storage.get('defaultBookmarksParent');

    const rootBookmark = await findGroup({
        id: 'rootId',
        title: browser.i18n.getMessage('extensionName'),
    }, defaultBookmarksParent, createIfNeed);

    if (rootBookmark) {
        return findGroup(group, rootBookmark.id, createIfNeed);
    }
}

export async function removeGroup(group) {
    const groupBookmarkFolder = await getGroup(group);

    if (groupBookmarkFolder) {
        try {
            await browser.bookmarks.removeTree(groupBookmarkFolder.id);

            delete storage[group.id];

            return true;
        } catch (e) {
            logger.logError('removeGroup', e);
        }
    }

    return false;
}

export async function updateGroupTitle(group) {
    const groupBookmarkFolder = await getGroup(group);

    if (groupBookmarkFolder) {
        try {
            await browser.bookmarks.update(groupBookmarkFolder.id, {
                title: group.title,
            });

            return true;
        } catch (e) {
            logger.logError(['updateGroupTitle', {groupId: group.id, title: group.title}], e);
        }
    }

    return false;
}

export async function exportGroup(group, groupIndex) {
    const log = logger.start('exportGroup', {groupId: group.id, groupIndex});

    const {BOOKMARK} = browser.bookmarks.BookmarkTreeNodeType;

    const groupBookmark = await getGroup(group, true);

    storage[group.id] = groupBookmark.id;

    if (groupBookmark.parentId === storage.rootId && groupBookmark.index !== groupIndex) {
        await browser.bookmarks.move(groupBookmark.id, {
            index: groupIndex,
        });
    }

    const bookmarks = groupBookmark.children;
    const bookmarksToSave = new Set;

    for (const [index, tab] of group.tabs.entries()) {
        tab.title ??= tab.url;

        let bookmark = bookmarks.find(({id, url}) => !bookmarksToSave.has(id) && url === tab.url);

        if (bookmark) {
            if (bookmark.index !== index) {
                await browser.bookmarks.move(bookmark.id, {index});
            }
        } else {
            if (tab.url.length > MAX_LENGTH || tab.title.length > MAX_LENGTH) {
                log.warn('skip tab', tab.url.slice(0, 30), tab.title.slice(0, 10));
                continue;
            }

            bookmark = await browser.bookmarks.create({
                title: tab.title,
                url: tab.url,
                type: BOOKMARK,
                index,
                parentId: groupBookmark.id,
            });
        }

        bookmarksToSave.add(bookmark.id);
    }

    for (const bookmark of bookmarks) {
        if (bookmark.type === BOOKMARK && !bookmarksToSave.has(bookmark.id)) {
            await browser.bookmarks.remove(bookmark.id);
        }
    }

    log.stop();

    return true;
}

export async function exportGroups(groups) {
    const log = logger.start('exportGroups');

    for (const [groupIndex, group] of groups.entries()) {
        if (group.exportToBookmarks) {
            await exportGroup(group, groupIndex);
        }
    }

    log.stop();

    return true;
}
