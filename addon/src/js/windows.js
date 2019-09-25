'use strict';

import utils from './utils';
import Tabs from './tabs';

// fix FF bug on browser.windows.getAll ... it's not return all windows
// without "pinned: false" because need all windows, without normal tabs but with pinned tabs
async function load(withTabs) {
    const {BG} = browser.extension.getBackgroundPage();

    let [allTabs, allWindows] = await Promise.all([
            withTabs ? Tabs.get(null, null, null) : false,
            BG.browser.windows.getAll({
                windowTypes: [browser.windows.WindowType.NORMAL],
            })
        ]);

    let windows = await Promise.all(allWindows.map(async function(win) {
        if (!utils.isWindowAllow(win)) {
            return false;
        }

        win = await BG.cache.loadWindowSession(win);

        if (withTabs) {
            win.tabs = allTabs.filter(tab => tab.pinned ? false : tab.windowId === win.id);
        }

        return win;
    }));

    return windows.filter(Boolean).sort(utils.sortBy('id'));
}

async function get(windowId = browser.windows.WINDOW_ID_CURRENT, checkIsWindowAllow = true) {
    const {BG} = browser.extension.getBackgroundPage();

    let win = await BG.browser.windows.get(windowId);

    if (checkIsWindowAllow && !utils.isWindowAllow(win)) {
        throw Error('normal window not found!');
    }

    return BG.cache.loadWindowSession(win);
}

async function create(createData = {}, groupId, activeTabId) {
    const {BG} = browser.extension.getBackgroundPage();

    if (groupId) {
        BG.canAddGroupToWindowAfterItCreated = false;
    }

    let win = await BG.browser.windows.create(createData);

    console.log('created window', win);

    if (groupId) {
        BG.canAddGroupToWindowAfterItCreated = true;
    }

    if (utils.isWindowAllow(win)) {
        win = await BG.cache.loadWindowSession(win);

        if (groupId) {
            await BG.applyGroup(win.id, groupId, activeTabId);

            let tabs = await Tabs.get(win.id),
                emptyTab = win.tabs[0];

            if (tabs.length > 1) {
                await Tabs.setActive(null, tabs.filter(t => t.id !== emptyTab.id));
                await Tabs.remove(emptyTab.id);
            }
        }
    }

    return win;
}

function setFocus(windowId) {
    const {BG} = browser.extension.getBackgroundPage();

    return BG.browser.windows.update(windowId, {
        focused: true,
    });
}

async function getLastFocusedNormalWindow(returnId = true) {
    const {BG} = browser.extension.getBackgroundPage();

    let lastFocusedWindow = await BG.browser.windows.getLastFocused();

    if (utils.isWindowAllow(lastFocusedWindow)) {
        return returnId ? lastFocusedWindow.id : BG.cache.loadWindowSession(lastFocusedWindow);
    }

    // hard way (((
    let windows = await BG.browser.windows.getAll({
            windowTypes: [browser.windows.WindowType.NORMAL],
        }),
        filteredWindows = windows.filter(utils.isWindowAllow).sort(utils.sortBy('id')),
        win = filteredWindows.find(win => win.focused) || filteredWindows.pop();

    if (!win) {
        throw Error('normal window not found!');
    }

    return returnId ? win.id : BG.cache.loadWindowSession(win);
}

export default {
    load,
    get,
    create,
    setFocus,
    getLastFocusedNormalWindow,
};
