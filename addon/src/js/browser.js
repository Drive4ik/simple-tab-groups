
import * as Constants from './constants.js';
import * as Cache from './cache.js';
import * as Utils from './utils.js';
import Lang, {hasMessage} from './lang.js';
import Logger from './logger.js';
import Queue from './queue.js';

let Groups;
let Windows;

const logger = new Logger('Browser');

// the drawing chain is one turn of the queue (docs/DESIGN-QUEUES.md §2): inside a turn the functions
// of this module are called through .call(turn, …)
const actionQueue = new Queue('Action');

export async function action({
    title = Constants.MANIFEST.browser_action.default_title,
    icon = Constants.MANIFEST.browser_action.default_icon,
    popup = Constants.MANIFEST.browser_action.default_popup,
    enable = null,
    windowId = null,
    isSticky = false,
    badgeBackgroundColor = null,
}) {
    using turn = await actionQueue.wait('set', this);

    using log = logger.start('setAction', {
        title,
        icon: Utils.sliceText(icon, 25),
        popup,
        enable,
        windowId,
        isSticky,
        badgeBackgroundColor,
    });

    if (hasMessage(title)) {
        if (title.includes('loading')) {
            icon = 'icons/icon-animate.svg';
            enable = false;
        }

        title = Lang(title, null, {html: false});
    }

    if (enable !== null) {
        if (enable) {
            await browser.browserAction.enable();
        } else {
            await browser.browserAction.disable();
        }
    }

    const winObj = windowId ? {windowId} : {};

    await browser.browserAction.setTitle({
        ...winObj,
        title: title,
    }).catch(log.catchSilent('setTitle'));

    await browser.browserAction.setIcon({
        ...winObj,
        path: icon,
    }).catch(log.catchSilent('setIcon'));

    await browser.browserAction.setBadgeText({
        ...winObj,
        text: isSticky ? Constants.STICKY_SYMBOL : '',
    }).catch(log.catchSilent('setBadgeText'));

    await browser.browserAction.setPopup({
        ...winObj,
        popup: popup,
    }).catch(log.catchSilent('setPopup'));

    if (badgeBackgroundColor) {
        await browser.browserAction.setBadgeBackgroundColor({
            ...winObj,
            color: badgeBackgroundColor,
        }).catch(log.catchSilent('setBadgeBackgroundColor'));
    }
}

export async function actionAllWindows(details) {
    using turn = await actionQueue.wait('all-windows', this);

    Windows ??= await import('./windows.js');
    const windows = await Windows.load();

    await action.call(turn, details); // for new windows

    for (const {id} of windows) { // for every window
        await action.call(turn, {
            ...details,
            windowId: id,
        });
    }
}

export async function actionAllGroups() {
    using turn = await actionQueue.wait('all-groups', this);

    Windows ??= await import('./windows.js');
    const windows = await Windows.load();

    for (const {id} of windows) {
        await actionGroup.call(turn, null, id);
    }
}

export async function actionGroup(group, windowId) {
    using turn = await actionQueue.wait('group', this);

    using log = logger.start('actionGroup', {groupId: group?.id, windowId});

    Groups ??= await import('./groups.js');

    if (group) {
        windowId ??= Cache.getWindowId(group.id);
    } else if (windowId) {
        const groupId = Cache.getWindowGroup(windowId);

        if (groupId) {
            ({group} = await Groups.load(groupId));
        }
    }

    if (!windowId) {
        log.log('group not loaded');
        return;
    }

    log.log({
        groupId: group?.id,
        windowId,
    });

    const details = {
        windowId,
        enable: true,
    };

    if (group) {
        details.title = Utils.sliceText(Groups.getTitle(group, 'withContainer', windowId), 43) + ' - ' + Constants.MANIFEST.short_name;
        details.icon = Groups.getIconUrl(group);
        details.isSticky = group.isSticky;
    }

    await action.call(turn, details);

    // prependWindowTitle
    let titlePreface = '';

    if (group?.prependTitleToWindow) {
        const emoji = Groups.getEmojiIcon(group);

        if (emoji) {
            titlePreface = `${emoji} - `;
        } else {
            titlePreface = `${Utils.sliceText(group.title, 25)} - `;
        }
    }

    await browser.windows.update(windowId, {titlePreface})
        .catch(log.catchSilent('prependWindowTitle', {windowId, titlePreface}));
}

export async function actionLoading(start = true) {
    using turn = await actionQueue.wait(start ? 'loading' : 'restore');

    if (start) {
        await actionAllWindows.call(turn, {
            title: '__MSG_loading__',
        });
    } else {
        await action.call(turn, {
            enable: true,
        });

        await actionAllGroups.call(turn);
    }
}
