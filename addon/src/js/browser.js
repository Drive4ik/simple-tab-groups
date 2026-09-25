
import * as Constants from './constants.js';
import * as Cache from './cache.js';
import * as Utils from './utils.js';
import Lang, {hasMessage} from './lang.js';
import Logger from './logger.js';
import Queue from './queue.js';

let Groups;
let Windows;

const logger = new Logger('Browser');

const actionQueue = new Queue('Action');

export function action(...args) {
    return actionQueue.run('set', () => actionNow(...args));
}

async function actionNow({
    title = Constants.MANIFEST.browser_action.default_title,
    icon = Constants.MANIFEST.browser_action.default_icon,
    popup = Constants.MANIFEST.browser_action.default_popup,
    enable = null,
    windowId = null,
    isSticky = false,
    badgeBackgroundColor = null,
}) {
    const log = logger.start('setAction', {
        title,
        icon,
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
    }).catch(log.onCatch('setTitle', false));

    await browser.browserAction.setIcon({
        ...winObj,
        path: icon,
    }).catch(log.onCatch('setIcon', false));

    await browser.browserAction.setBadgeText({
        ...winObj,
        text: isSticky ? Constants.STICKY_SYMBOL : '',
    }).catch(log.onCatch('setBadgeText', false));

    await browser.browserAction.setPopup({
        ...winObj,
        popup: popup,
    }).catch(log.onCatch('setPopup', false));

    if (badgeBackgroundColor) {
        await browser.browserAction.setBadgeBackgroundColor({
            ...winObj,
            color: badgeBackgroundColor,
        }).catch(log.onCatch('setBadgeBackgroundColor', false));
    }

    log.stop();
}

export function actionAllWindows(...args) {
    return actionQueue.run('all-windows', () => actionAllWindowsNow(...args));
}

async function actionAllWindowsNow(details) {
    Windows ??= await import('./windows.js');
    const windows = await Windows.load();

    await actionNow(details); // for new windows

    for (const {id} of windows) { // for every window
        await actionNow({
            ...details,
            windowId: id,
        });
    }
}

export function actionGroup(...args) {
    return actionQueue.run('group', () => actionGroupNow(...args));
}

async function actionGroupNow(group, windowId) {
    const log = logger.start('actionGroup', {groupId: group?.id, windowId});

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
        log.stop('group not loaded');
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
        details.title = Utils.sliceText(Groups.getTitle(group, 'withContainer'), 43) + ' - ' + Constants.MANIFEST.short_name;
        details.icon = Groups.getIconUrl(group);
        details.isSticky = group.isSticky;
    }

    await actionNow(details);

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
        .catch(log.onCatch(['prependWindowTitle', {windowId, titlePreface}], false));

    log.stop();
}

export function actionLoading(start = true) {
    return actionQueue.run(start ? 'loading' : 'restore', () => actionLoadingNow(start));
}

async function actionLoadingNow(start) {
    if (start) {
        await actionAllWindowsNow({
            title: '__MSG_loading__',
        });
    } else {
        Windows ??= await import('./windows.js');

        await actionNow({
            enable: true,
        });

        const windows = await Windows.load();

        for (const {id} of windows) {
            await actionGroupNow(null, id);
        }
    }
}
