(function() {
    'use strict';

    // fix FF bug on browser.windows.getAll ... it's not return all windows
    // without "pinned: false" because need all windows, without normal tabs but with pinned tabs
    async function load(withTabs = false, includeFavIconUrl, includeThumbnail) {
        console.log('START Windows.load', withTabs, includeFavIconUrl, includeThumbnail);

        let [tabs, windows] = await Promise.all([
            withTabs ? Tabs.get(null, false, null, undefined, includeFavIconUrl, includeThumbnail) : false,
            browser.windows.getAll({
                windowTypes: [browser.windows.WindowType.NORMAL],
            })
        ]);

        windows = await Promise.all(
            windows
                .filter(utils.isWindowAllow)
                .map(cache.loadWindowSession)
        );

        if (withTabs) {
            windows = windows.map(win => (win.tabs = tabs.filter(tab => tab.windowId === win.id), win));
        }

        console.log('STOP Windows.load');

        return windows.sort(utils.sortBy('id'));
    }

    async function get(windowId = browser.windows.WINDOW_ID_CURRENT) {
        let win = await browser.windows.get(windowId);

        return cache.loadWindowSession(win);
    }

    async function create(createData = {}, groupId, activeTabId) {
        if (groupId) {
            let groupWindowId = cache.getWindowId(groupId);

            if (groupWindowId) {
                BG.applyGroup(groupWindowId, groupId, activeTabId);
                return null;
            }

            BG.skipAddGroupToNextNewWindow = true;
        }

        let win = await browser.windows.create(createData);

        console.log('created window', win);

        if (utils.isWindowAllow(win)) {
            if (groupId) {
                await BG.applyGroup(win.id, groupId, activeTabId);
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
        let lastFocusedWindow = await browser.windows.getLastFocused().catch(noop);

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
