
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
        newStorage[getGroupKey(groupId)] = notes;
    }

    return newStorage;
}
