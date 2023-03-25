(function() {
    'use strict';

    function noop() {}

    const logger = new Logger('Windows');

    async function load(withTabs = false, includeFavIconUrl, includeThumbnail) {
        const log = logger.start('load', {withTabs, includeFavIconUrl, includeThumbnail});

        let [tabs, windows] = await Promise.all([
            withTabs ? Tabs.get(null, false, null, undefined, includeFavIconUrl, includeThumbnail) : false,
            browser.windows.getAll({
                windowTypes: [browser.windows.WindowType.NORMAL],
            })
        ]);

        windows = await Promise.all(windows.filter(utils.isWindowAllow).map(cache.loadWindowSession));

        if (withTabs) {
            windows = windows.map(win => (win.tabs = tabs.filter(tab => tab.windowId === win.id), win));
        }

        return log.stop(), windows.sort(utils.sortBy('id'));
    }

    async function get(windowId = browser.windows.WINDOW_ID_CURRENT) {
        const log = logger.start('get', {windowId});
        let win = await browser.windows.get(windowId);

        return log.stop(win), cache.loadWindowSession(win);
    }

    async function create(groupId, activeTabId) {
        const log = logger.start('create', {groupId, activeTabId});

        if (!groupId) {
            log.throwError('No group id');
        }

        let groupWindowId = cache.getWindowId(groupId);

        if (groupWindowId) {
            await BG.applyGroup(groupWindowId, groupId, activeTabId);
            log.stop('load exist window', groupWindowId);
        } else {
            BG.skipAddGroupToNextNewWindow = true;

            let win = await browser.windows.create();

            await BG.applyGroup(win.id, groupId, activeTabId);
            log.stop('load new window', win.id);
        }
    }

    function setFocus(windowId) {
        return browser.windows.update(windowId, {
            focused: true,
        }).catch(logger.onCatch(windowId));
    }

    async function getLastFocusedNormalWindow(returnId = true) {
        const log = logger.start('getLastFocusedNormalWindow', {returnId});
        let lastFocusedWindow = await browser.windows.getLastFocused().catch(log.onCatch('windows.getLastFocused', false));

        if (lastFocusedWindow && utils.isWindowAllow(lastFocusedWindow)) {
            log.stop('windowId:', lastFocusedWindow.id);
            return returnId ? lastFocusedWindow.id : cache.loadWindowSession(lastFocusedWindow);
        }

        log.warn('hard way (((');

        let windows = await load(),
            win = windows.find(win => win.focused) || windows.pop();

        if (!win) {
            log.throwError('normal window not found!');
        }

        log.stop('windowId:', win.id);
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
