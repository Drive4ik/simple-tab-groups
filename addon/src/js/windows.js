(function() {
    'use strict';

    // fix FF bug on browser.windows.getAll ... it's not return all windows
    // without "pinned: false" because need all windows, without normal tabs but with pinned tabs
    async function load(withTabs) {
        let [tabs, windows] = await Promise.all([
            withTabs ? Tabs.get(null, null, null) : false,
            browser.windows.getAll({
                windowTypes: [browser.windows.WindowType.NORMAL],
            })
        ]);

        windows = await Promise.all(windows.filter(utils.isWindowAllow).map(cache.loadWindowSession));

        return windows
            .map(function(win) {
                if (withTabs) {
                    win.tabs = tabs.filter(tab => tab.pinned ? false : tab.windowId === win.id);
                }

                return win;
            })
            .sort(utils.sortBy('id'));
    }

    async function get(windowId = browser.windows.WINDOW_ID_CURRENT, checkIsWindowAllow = true) {
        let win = await browser.windows.get(windowId);

        if (checkIsWindowAllow && !utils.isWindowAllow(win)) {
            throw Error(`[Windows.get] normal window not found! windowId: ${windowId}, win: ` + utils.stringify(win));
        }

        return cache.loadWindowSession(win);
    }

    async function create(createData = {}, groupId, activeTabId) {
        if (groupId) {
            let groupWindowId = cache.getWindowId(groupId);

            if (groupWindowId) {
                BG.applyGroup(groupWindowId, groupId, activeTabId);
                return null;
            }

            BG.canAddGroupToWindowAfterItCreated = false;
        }

        let win = await browser.windows.create(createData);

        console.log('created window', win);

        if (groupId) {
            BG.canAddGroupToWindowAfterItCreated = true;
        }

        if (utils.isWindowAllow(win)) {
            if (groupId) {
                await BG.applyGroup(win.id, groupId, activeTabId);

                let tabs = await Tabs.get(win.id),
                    [emptyTab] = win.tabs;

                if (tabs.length > 1) {
                    await Tabs.remove(emptyTab.id);
                }
            }

            win = await cache.loadWindowSession(win);
        }

        return win;
    }

    function setFocus(windowId) {
        return browser.windows.update(windowId, {
            focused: true,
        });
    }

    async function getLastFocusedNormalWindow(returnId = true) {
        let lastFocusedWindow = await browser.windows.getLastFocused().catch(errorEventHandler);

        if (lastFocusedWindow && utils.isWindowAllow(lastFocusedWindow)) {
            return returnId ? lastFocusedWindow.id : cache.loadWindowSession(lastFocusedWindow);
        }

        // hard way (((
        let windows = await load(),
            win = windows.find(win => win.focused) || windows.pop();

        if (!win) {
            throw Error('[Windows.getLastFocusedNormalWindow] normal window not found!');
        }

        return returnId ? win.id : win;
    }

    window.Windows = {
        load,
        get,
        create,
        setFocus,
        getLastFocusedNormalWindow,
    };

})();
