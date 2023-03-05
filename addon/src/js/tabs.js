(function() {
    'use strict';

    async function createNative({url, active, pinned, title, index, windowId, openerTabId, cookieStoreId, newTabContainer, ifDifferentContainerReOpen, excludeContainersForReOpen, groupId, favIconUrl, thumbnail}) {
        let tab = {};

        if (utils.isUrlAllowToCreate(url)) { // TODO create page for unsupported urls
            tab.url = url;
        }

        tab.active = !!active;

        if (pinned) {
            tab.pinned = true;
        }

        if (!tab.active && !tab.pinned && tab.url && !tab.url.startsWith('about:')) {
            tab.discarded = true;
        }

        if (tab.discarded && title) {
            tab.title = title;
        }

        if (Number.isFinite(index) && index >= 0) {
            tab.index = index;
        }

        let groupWindowId = cache.getWindowId(groupId);

        if (groupWindowId) {
            windowId = groupWindowId;
        }

        if (Number.isFinite(windowId) && windowId >= 1) {
            tab.windowId = windowId;
        }

        if (Number.isFinite(openerTabId) && openerTabId >= 1) {
            tab.openerTabId = openerTabId;
        }

        tab.cookieStoreId = cookieStoreId || DEFAULT_COOKIE_STORE_ID;

        tab.cookieStoreId = getNewTabContainer(tab, {newTabContainer, ifDifferentContainerReOpen, excludeContainersForReOpen});

        if (tab.cookieStoreId === TEMPORARY_CONTAINER) {
            tab.cookieStoreId = await Containers.createTemporaryContainer();
        } else {
            tab.cookieStoreId = Containers.get(tab.cookieStoreId, 'cookieStoreId', true);
        }

        let newTab = await browser.tabs.create(tab);

        cache.setTab(newTab);

        return cache.applySession(newTab, {groupId, favIconUrl, thumbnail});
    }

    async function create(tab, sendMessage = true) {
        BG.groupIdForNextTab = tab.groupId;

        BG.skipCreateTab = true;

        let newTab = await createNative(tab);

        BG.skipCreateTab = false;

        BG.groupIdForNextTab = null;

        newTab = await cache.setTabSession(newTab);

        return newTab;
    }

    async function createUrlOnce(url, windowId) {
        let [tab] = await get(windowId, null, null, {url});

        if (tab) {
            return setActive(tab.id);
        } else {
            return createNative({
                active: true,
                url: url,
                windowId: windowId,
            });
        }
    }

    async function setActive(tabId = null, tabs = []) {
        let tabToActive = null;

        if (tabId) {
            tabToActive = tabs.find(tab => tab.id === tabId) || {
                id: tabId,
            };
        } else if (tabs.length) { // find lastAccessed tab
            let maxLastAccessed = Math.max(...tabs.map(tab => tab.lastAccessed));

            tabToActive = tabs.find(tab => tab.lastAccessed === maxLastAccessed);
        }

        if (tabToActive) {
            tabs.forEach(tab => tab.active = tab.id === tabToActive.id);

            await browser.tabs.update(tabToActive.id, {
                active: true,
            });
        }

        return tabToActive;
    }

    async function getActive(windowId = browser.windows.WINDOW_ID_CURRENT) {
        let [activeTab] = await get(windowId, null, null, {
            active: true,
        });

        return activeTab;
    }

    async function getHighlightedIds(windowId = browser.windows.WINDOW_ID_CURRENT, clickedTab = null, pinned = false) {
        let tabs = await get(windowId, pinned, false, {
            highlighted: true,
        });

        if (clickedTab && !tabs.some(tab => tab.id === clickedTab.id)) { // if clicked tab not in selected tabs - add it
            tabs.push(clickedTab);

            if (2 === tabs.length) {
                tabs = tabs.filter(tab => tab.active ? (tab.id === clickedTab.id) : true); // exclude active tab if need to move another tab
            }
        }

        return tabs.map(utils.keyId);
    }

    async function get(
            windowId = browser.windows.WINDOW_ID_CURRENT,
            pinned = false,
            hidden = false,
            otherProps = {},
            includeFavIconUrl = false,
            includeThumbnail = false
        ) {
        let query = {
            windowId,
            pinned,
            hidden,
            windowType: browser.windows.WindowType.NORMAL,
            ...otherProps,
        };

        for (let key in query) {
            if (null === query[key]) {
                delete query[key];
            }
        }

        console.log('START Tabs.get', {query});

        let tabs = await browser.tabs.query(query);

        tabs = tabs
            .filter(tab => !cache.removedTabs.has(tab.id))
            .map(utils.normalizeTabUrl);

        let result = query.pinned ? tabs : await Promise.all(tabs.map(tab => cache.loadTabSession(tab, includeFavIconUrl, includeThumbnail)));

        console.log('STOP Tabs.get');

        return result;
    }

    async function getOne(id) {
        try {
            let tab = await browser.tabs.get(id);
            return utils.normalizeTabUrl(tab);
        } catch (e) {
            return null;
        }
    }

    async function getList(tabIds, includeFavIconUrl, includeThumbnail) {
        let tabs = await Promise.all(tabIds.map(getOne));

        return Promise.all(tabs.filter(Boolean).map(tab => cache.loadTabSession(tab, includeFavIconUrl, includeThumbnail)));
    }

    async function setMute(tabs, muted) {
        return Promise.all(
            tabs
            .filter(tab => muted ? tab.audible : tab.mutedInfo.muted)
            .map(function(tab) {
                tab.audible = !muted;
                tab.mutedInfo.muted = muted;

                return browser.tabs.update(tab.id, {muted});
            })
        );
    }

    async function createTempActiveTab(windowId, createPinnedTab = true, newTabUrl) {
        let pinnedTabs = await get(windowId, true, null);

        if (pinnedTabs.length) {
            if (!pinnedTabs.some(tab => tab.active)) {
                await setActive(utils.getLastActiveTab(pinnedTabs).id);
            }
        } else {
            return createNative({
                url: createPinnedTab ? (newTabUrl || 'about:blank') : (newTabUrl || 'about:newtab'),
                pinned: createPinnedTab,
                active: true,
                windowId: windowId,
            });
        }
    }

    async function add(groupId, cookieStoreId, url, title) {
        let {group} = await Groups.load(groupId),
            [tab] = await BG.createTabsSafe([{
                url,
                title,
                cookieStoreId,
                ...Groups.getNewTabParams(group),
            }]);

        return tab;
    }

    async function remove(...tabs) { // id or ids or tabs
        tabs = tabs.flat();

        if (tabs.length) {
            console.log('Tabs.remove before');
            tabs = await filterExist(tabs, true);
            await browser.tabs.remove(tabs);
            console.log('Tabs.remove after');
        }
    }

    async function updateThumbnail(tabId, force) {
        if (!BG.options.showTabsWithThumbnailsInManageGroups) {
            return;
        }

        let tab = await getOne(tabId);

        if (!tab) {
            return;
        }

        if (!utils.isTabLoaded(tab)) {
            return;
        }

        if (!force && cache.getTabThumbnail(tab.id)) {
            return;
        }

        if (tab.discarded) {
            reload([tab]);
            return;
        }

        let thumbnail = null;

        try {
            let thumbnailBase64 = await browser.tabs.captureTab(tab.id, {
                format: browser.extensionTypes.ImageFormat.JPEG,
                quality: 25,
            });

            thumbnail = await new Promise(function(resolve, reject) {
                let img = new Image();

                img.onload = function() {
                    resolve(utils.resizeImage(img, 192, Math.floor(img.width * 192 / img.height), false, 'image/jpeg', 0.7));
                };

                img.onerror = img.onabort = reject;

                img.src = thumbnailBase64;
            });
        } catch (e) {}

        cache.setTabThumbnail(tab.id, thumbnail);

        BG.sendMessage({
            action: 'thumbnail-updated',
            tabId: tab.id,
            thumbnail: thumbnail,
        });
    }

    async function move(tabIds, groupId, newTabIndex = -1, showNotificationAfterMoveTab = true, showTabAfterMoving = false) {
        tabIds = tabIds.slice();

        console.info('moveTabs', {tabIds, groupId, newTabIndex, showNotificationAfterMoveTab, showTabAfterMoving});

        BG.addExcludeTabIds(tabIds);

        let showPinnedMessage = false,
            tabsCantHide = new Set,
            groupWindowId = cache.getWindowId(groupId),
            {group} = await Groups.load(groupId, !groupWindowId),
            windowId = groupWindowId || (group.tabs[0]?.windowId) || await Windows.getLastFocusedNormalWindow(),
            activeTabs = [];

        let tabs = await getList(tabIds);

        if (!tabs.length) {
            return [];
        }

        tabs = tabs.filter(function(tab) {
            if (tab.pinned) {
                showPinnedMessage = true;
                BG.excludeTabIds.delete(tab.id);
                return false;
            }

            if (utils.isTabCanNotBeHidden(tab)) {
                tabsCantHide.add(utils.getTabTitle(tab, false, 20));
                BG.excludeTabIds.delete(tab.id);
                return false;
            }

            if (tab.active && tab.groupId !== groupId) {
                activeTabs.push(tab);
            }

            return true;
        });

        if (tabs.length) {
            const excludeMovingTabs = tab => !tabs.some(t => t.id === tab.id);

            await Promise.all(activeTabs.map(async function(activeTab) {
                let allTabsInActiveTabWindow = await get(activeTab.windowId, null, null),
                    tabsToActive = allTabsInActiveTabWindow.filter(tab => !tab.hidden && excludeMovingTabs(tab));

                if (tabsToActive.length) {
                    await setActive(undefined, tabsToActive);
                } else if (activeTab.windowId !== windowId && !allTabsInActiveTabWindow.filter(excludeMovingTabs).length) {
                    await createTempActiveTab(activeTab.windowId, false);
                }
            }));

            let tabIdsToRemove = [],
                newTabParams = Groups.getNewTabParams(group);

            BG.groupIdForNextTab = group.id;

            BG.skipCreateTab = true;

            tabs = await Promise.all(tabs.map(async function(tab) {
                let newTabContainer = getNewTabContainer(tab, group);

                if (tab.cookieStoreId === newTabContainer) {
                    return tab;
                } else {
                    tab.cookieStoreId = newTabContainer;
                }

                tabIdsToRemove.push(tab.id);

                tab.url = cache.getTabSession(tab.id, 'url');
                tab.title = cache.getTabSession(tab.id, 'title');

                let newTab = await createNative({
                    ...tab,
                    active: false,
                    openerTabId: null,
                    windowId,
                    ...newTabParams,
                });

                tabIds.push(newTab.id);
                BG.excludeTabIds.add(newTab.id);

                return cache.setTabSession(newTab);
            }));

            BG.skipCreateTab = false;

            BG.groupIdForNextTab = null;

            await remove(tabIdsToRemove);

            tabs = await moveNative(tabs, {
                index: newTabIndex,
                windowId,
            });

            if (groupWindowId) {
                await show(tabs.filter(tab => tab.hidden));
            } else {
                await hide(tabs.filter(tab => !tab.hidden));
            }

            await Promise.all(tabs.map(tab => cache.setTabGroup(tab.id, groupId)));

            BG.removeExcludeTabIds(tabIds);

            BG.sendMessage({
                action: 'groups-updated',
            });
        }

        if (showPinnedMessage) {
            utils.notify(['pinnedTabsAreNotSupported']);
        }

        if (tabsCantHide.size) {
            utils.notify(['thisTabsCanNotBeHidden', Array.from(tabsCantHide).join(', ')]);
        }

        if (!tabs.length) {
            return [];
        }

        let [firstTab] = tabs;

        if (showTabAfterMoving) {
            await BG.applyGroup(windowId, groupId, firstTab.id);
            showNotificationAfterMoveTab = false;
        }

        if (!showNotificationAfterMoveTab || !BG.options.showNotificationAfterMoveTab) {
            return tabs;
        }

        let message = [],
            iconUrl = null;

        if (tabs.length > 1) {
            message = ['moveMultipleTabsToGroupMessage', tabs.length];
            iconUrl = utils.getGroupIconUrl(group);
        } else {
            let tabTitle = utils.getTabTitle(firstTab, false, 50);
            message = ['moveTabToGroupMessage', [group.title, tabTitle]];
            firstTab = utils.normalizeTabFavIcon(firstTab);
            iconUrl = firstTab.favIconUrl;
        }

        utils.notify(message, undefined, undefined, iconUrl, async function(groupId, tabId) {
            let {group} = await Groups.load(groupId),
                tab = await getOne(tabId);

            if (group && tab) {
                let winId = cache.getWindowId(groupId) || await Windows.getLastFocusedNormalWindow();

                BG.applyGroup(winId, groupId, tabId);
            }
        }.bind(null, groupId, firstTab.id));

        return tabs;
    }

    async function filterExist(tabs, returnTabIds = false) {
        let returnFunc = returnTabIds ? t => t.id : t => t;
        tabs = await Promise.all(tabs.map(tabOrId => browser.tabs.get(tabOrId.id || tabOrId).then(returnFunc, noop)));
        return tabs.filter(Boolean);
    }

    async function moveNative(tabs, options = {}) {
        console.log('Tabs.moveNative called args', {tabs, options});

        let openerTabIds = options.windowId ? tabs.map(tab => tab.openerTabId) : [],
            tabIds = await filterExist(tabs, true);

        console.assert(tabIds.length === tabs.length, `Tabs.moveNative tabs length after filter are not equal: ${tabs.length}`, tabIds);

        if (!tabIds.length) {
            return [];
        }

        console.log('Tabs.moveNative before');

        let movedTabs = await browser.tabs.move(tabIds, options),
            movedTabsObj = utils.arrayToObj(movedTabs, 'id');

        console.log('Tabs.moveNative after');

        let movedTabIdsSet = new Set(tabIds);

        return tabs
            .map(function(tab, index) {
                if (!movedTabIdsSet.has(tab.id)) {
                    return;
                }

                if (options.windowId) {
                    tab.windowId = options.windowId;
                    // Tabs moved across windows always lose their openerTabId even
                    // if it is also moved to the same window together, thus we need
                    // to restore it manually.
                    // https://github.com/piroor/treestyletab/issues/2546#issuecomment-733488187
                    if (openerTabIds[index] > 0) {
                        tab.openerTabId = openerTabIds[index];
                        browser.tabs.update(tab.id, {
                            openerTabId: tab.openerTabId,
                        }).catch(noop);
                    }
                }

                if (movedTabsObj[tab.id]) {
                    tab.index = movedTabsObj[tab.id].index;
                }

                return tab;
            })
            .filter(Boolean);
    }

    async function show(...tabs) {
        tabs = tabs.flat();

        if (tabs.length) {
            console.log('Tabs.show before');
            tabs = await filterExist(tabs, true);
            await browser.tabs.show(tabs);
            console.log('Tabs.show after');
        }
    }

    async function hide(...tabs) {
        tabs = tabs.flat();

        if (tabs.length) {
            console.log('Tabs.hide before');
            tabs = await filterExist(tabs, true);
            await browser.tabs.hide(tabs);
            console.log('Tabs.hide after');
        }
    }

    async function discard(...tabs) { // ids or tabs
        tabs = tabs.flat();

        if (tabs.length) {
            console.log('Tabs.discard before');
            tabs = await filterExist(tabs);
            tabs = tabs
                .filter(tab => !tab.url.startsWith(utils.BROWSER_PAGES_STARTS))
                .map(utils.keyId);

            await browser.tabs.discard(tabs);
            console.log('Tabs.discard after');
        }
    }

    async function safeHide(...tabs) { // ids or tabs
        tabs = tabs.flat();

        if (tabs.length) {
            let tabIds = tabs.map(tab => tab.id || tab);

            BG.addExcludeTabIds(tabIds);
            try {
                console.log('Tabs.safeHide before');
                await hide(tabIds);
                console.log('Tabs.safeHide after');
                BG.removeExcludeTabIds(tabIds);
            } catch (e) {
                BG.removeExcludeTabIds(tabIds);
                throw e;
            }

            tabs.forEach(tab => tab.hidden = true);
        }
    }

    const extensionsWebextensionsRestrictedDomains = ['accounts-static.cdn.mozilla.net', 'accounts.firefox.com', 'addons.cdn.mozilla.net', 'addons.mozilla.org', 'api.accounts.firefox.com', 'content.cdn.mozilla.net', 'discovery.addons.mozilla.org', 'install.mozilla.org', 'oauth.accounts.firefox.com', 'profile.accounts.firefox.com', 'support.mozilla.org', 'sync.services.mozilla.com'];

    function isCanSendMessage({url}) {
        if (url === 'about:blank') {
            return true;
        }

        if (url.startsWith('moz-extension') || url.startsWith('about:')) {
            return false;
        }

        return !extensionsWebextensionsRestrictedDomains.some(host => (new RegExp('^https?://' + host).test(url)));
    }

    function sendMessage(tabId, message) {
        message.theme = BG.options.theme;

        return browser.tabs.sendMessage(tabId, message).catch(noop);
    }

    async function reload(tabs = [], bypassCache = false) { // ids or tabs
        if (tabs.length) {
            await Promise.all(tabs.map(tab => browser.tabs.reload((tab.id || tab), {bypassCache}).catch(noop)));
        }
    }

    function prepareForSave(tabs, includeGroupId = false, includeFavIconUrl = false, includeThumbnail = false) {
        return tabs.map(function({id, url, title, cookieStoreId, favIconUrl, openerTabId, groupId, thumbnail}) {
            let tab = {url, title};

            if (!Containers.isDefault(cookieStoreId)) {
                tab.cookieStoreId = Containers.isTemporary(cookieStoreId) ? TEMPORARY_CONTAINER : cookieStoreId;
            }

            if (id) {
                tab.id = id;

                if (openerTabId) {
                    tab.openerTabId = openerTabId;
                }
            }

            if (includeGroupId && groupId) {
                tab.groupId = groupId;
            }

            if (includeFavIconUrl && favIconUrl?.startsWith('data:')) {
                tab.favIconUrl = favIconUrl;
            }

            if (includeThumbnail && thumbnail) {
                tab.thumbnail = thumbnail;
            }

            return tab;
        });
    }

    function getNewTabContainer(
            {url, cookieStoreId, status},
            {newTabContainer = DEFAULT_COOKIE_STORE_ID, ifDifferentContainerReOpen, excludeContainersForReOpen = []}
        ) {

        if (cookieStoreId === newTabContainer || Containers.isTemporary(cookieStoreId)) {
            return cookieStoreId;
        }

        if (url && !url.startsWith('http') && !url.startsWith('ftp') && status !== browser.tabs.TabStatus.LOADING) {
            return DEFAULT_COOKIE_STORE_ID;
        }

        if (ifDifferentContainerReOpen) {
            return excludeContainersForReOpen.includes(cookieStoreId) ? cookieStoreId : newTabContainer;
        }

        return Containers.isDefault(cookieStoreId) ? newTabContainer : cookieStoreId;
    }

    window.Tabs = {
        createNative,
        create,
        createUrlOnce,
        setActive,
        getActive,
        getHighlightedIds,
        get,
        getOne,
        getList,
        setMute,
        createTempActiveTab,
        add,
        remove,
        updateThumbnail,
        move,
        moveNative,
        show,
        hide,
        discard,
        safeHide,
        isCanSendMessage,
        sendMessage,
        reload,
        prepareForSave,
        getNewTabContainer,
    };

})();
