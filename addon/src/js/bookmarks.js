
import './prefixed-storage.js';
import Logger from './logger.js';
import Lang from '/js/lang.js';
import * as Constants from './constants.js';
import * as Storage from './storage.js';
import * as Permissions from './permissions.js';

const logger = new Logger(Constants.MODULES.BOOKMARKS);

const storage = localStorage.create(Constants.MODULES.BOOKMARKS);

const MAX_LENGTH = 1024 * 60;

const ROOT = {
    id: 'rootId',
    title: Lang('extensionName'),
};

export async function hasPermission() {
    return Permissions.has(Permissions.BOOKMARKS);
}

export async function requestPermission() {
    return Permissions.request(Permissions.BOOKMARKS);
}

export async function removePermission() {
    return Permissions.remove(Permissions.BOOKMARKS);
}

async function findGroup(group, parentId, createIfNeed = false) {
    let bookmark;

    if (storage[group.id]) {
        [bookmark] = await browser.bookmarks.get(storage[group.id]).catch(() => []);

        if (!bookmark && !createIfNeed) {
            delete storage[group.id];
        }
    }

    if (!bookmark && group.id === ROOT.id) {
        const bookmarks = await browser.bookmarks.search({
            title: ROOT.title,
        });

        for (const bookmarkCandidate of bookmarks) {
            if (
                bookmarkCandidate.parentId === parentId &&
                bookmarkCandidate.type === browser.bookmarks.BookmarkTreeNodeType.FOLDER
            ) {
                bookmark = bookmarkCandidate;
                break;
            }
        }

        if (bookmark) {
            storage[group.id] = bookmark.id;
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

    const rootBookmark = await findGroup(ROOT, defaultBookmarksParent, createIfNeed);

    if (rootBookmark) {
        return findGroup(group, rootBookmark.id, createIfNeed);
    }
}

export async function removeGroup(group) {
    const log = logger.start('removeGroup', group.id);

    if (await hasPermission()) {
        const groupBookmarkFolder = await getGroup(group);

        if (groupBookmarkFolder) {
            await browser.bookmarks.removeTree(groupBookmarkFolder.id)
                .catch(log.onCatch(groupBookmarkFolder));

            delete storage[group.id];

            log.stop('success');

            return true;
        }
    }

    log.stop();

    return false;
}

export async function updateGroupTitle(group) {
    const log = logger.start('updateGroupTitle', {groupId: group.id, title: group.title});

    if (await hasPermission()) {
        const groupBookmarkFolder = await getGroup(group);

        if (groupBookmarkFolder) {
            await browser.bookmarks.update(groupBookmarkFolder.id, {
                title: group.title,
            }).catch(log.onCatch(groupBookmarkFolder));

            log.stop('success');

            return true;
        }
    }

    log.stop();

    return false;
}

export async function exportGroup(group, groupIndex) {
    const log = logger.start('exportGroup', {groupId: group.id, groupIndex});

    if (!await hasPermission()) {
        log.stop('no permission');
    }

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
                log.warn('skip tab', tab.url.slice(0, 30), tab.title.slice(0, 50));
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

    if (!await hasPermission()) {
        log.stop('no permission');
    }

    for (const [groupIndex, group] of groups.entries()) {
        if (group.exportToBookmarks) {
            await exportGroup(group, groupIndex);
        }
    }

    log.stop();

    return true;
}
