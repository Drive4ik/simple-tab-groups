'use strict';

import utils from './utils';

// fix FF bug on browser.windows.getAll ... it's not return all windows
// without pinned: false because need all windows, without normal tabs but with pinned tabs
async function load(withTabs) {
    const {BG} = browser.extension.getBackgroundPage();

    let [allTabs, allWindows] = await Promise.all([
            withTabs ? browser.tabs.query({
                windowType: browser.windows.WindowType.NORMAL,
            }) : true,
            browser.windows.getAll({
                windowTypes: [browser.windows.WindowType.NORMAL],
            })
        ]);

    if (withTabs) {
        allTabs = await Promise.all(allTabs.map(BG.cache.loadTabSession));
    }

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

async function get(windowId = browser.windows.WINDOW_ID_CURRENT) {
    const {BG} = browser.extension.getBackgroundPage();

    let win = await browser.windows.get(windowId);

    if (!utils.isWindowAllow(win)) {
        throw Error('normal window not found! addon not worked in incognito mode');
    }

    return BG.cache.loadWindowSession(win);
}

async function create(createData = {}, groupId, activeTabId) {
    const {BG} = browser.extension.getBackgroundPage();

    if (groupId) {
        browser.windows.onCreated.removeListener(BG.events.onCreatedWindow);
    }

    let win = await browser.windows.create(createData);

    if (groupId) {
        browser.windows.onCreated.addListener(BG.events.onCreatedWindow);
    }

    if (utils.isWindowAllow(win)) {
        win = await BG.cache.loadWindowSession(win);

        if (groupId) {
            await BG.applyGroup(win.id, groupId, activeTabId);
        }
    }

    return win;
}

function setFocus(windowId) {
    return browser.windows.update(windowId, {
        focused: true,
    });
}

async function getLastFocusedNormalWindow(returnId = true) {
    const {BG} = browser.extension.getBackgroundPage();

    let lastFocusedWindow = await browser.windows.getLastFocused();

    if (utils.isWindowAllow(lastFocusedWindow)) {
        return returnId ? lastFocusedWindow.id : BG.cache.loadWindowSession(lastFocusedWindow);
    }

    // hard way (((
    let windows = await browser.windows.getAll({
            windowTypes: [browser.windows.WindowType.NORMAL],
        }),
        filteredWindows = windows.filter(utils.isWindowAllow).sort(utils.sortBy('id')),
        win = filteredWindows.find(win => win.focused) || filteredWindows.pop();

    if (!win) {
        throw Error('normal window not found! addon not worked in incognito mode');
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
