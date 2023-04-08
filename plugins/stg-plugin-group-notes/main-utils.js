
export const defaultOptions = Object.freeze({
    tabFaviconAsGroup: false,
    editorLineNumbers: false,
    editorLineWrapping: true,
    editorUseRTLDirection: false,
});

const BADGE_SYMBOL = '⭐️';

export async function setBadge(show, windowId) {
    if (windowId) {
        await browser.action.setBadgeText({
            text: show ? BADGE_SYMBOL : '',
            windowId,
        });
    }
}

export function getGroupKey(groupId) {
    return `group-${groupId}`;
}

export function migrateStrorageToV2(oldStorage) {
    const newStorage = {};

    for(const [groupId, notes] of Object.entries(oldStorage)) {
        if (Number(groupId) == groupId) {
            newStorage[getGroupKey(groupId)] = notes;
        } else {
            newStorage[groupId] = notes;
        }
    }

    return newStorage;
}

export async function openInTab() {
    const [tab] = await browser.tabs.query({
        url: browser.runtime.getURL('popup/popup.html'),
        windowId: browser.windows.WINDOW_ID_CURRENT,
    });

    if (tab) {
        browser.tabs.update(tab.id, {active: true});
    } else {
        browser.tabs.create({
            active: true,
            pinned: true,
            url: browser.runtime.getURL('popup/popup.html#tab'),
        }).catch(() => {});
    }
}
