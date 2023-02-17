(function() {
    'use strict';

    // if set groupId => return [group, groups, groupIndex]
    async function load(groupId = null, withTabs = false, includeFavIconUrl, includeThumbnail) {
        let [allTabs, {groups}] = await Promise.all([
            withTabs ? Tabs.get(null, false, null, undefined, includeFavIconUrl, includeThumbnail) : false,
            storage.get('groups')
        ]);

        if (withTabs) {
            let groupTabs = {};

            groups.forEach(group => groupTabs[group.id] = []);

            await Promise.all(allTabs.map(async function(tab) {
                if (tab.groupId) {
                    if (groupTabs[tab.groupId]) {
                        groupTabs[tab.groupId].push(tab);
                    } else {
                        delete tab.groupId;
                        await cache.removeTabGroup(tab.id);
                    }
                }
            }));

            groups = groups.map(function(group) {
                if (!group.isArchive) {
                    group.tabs = groupTabs[group.id].sort(utils.sortBy('index'));
                }

                return group;
            });
        }

        let groupIndex = groups.findIndex(group => group.id === groupId);

        return {
            group: groups[groupIndex],
            groups,
            groupIndex,
        };

        // if (groupId) {
        //     return [groups.find(group => group.id === groupId), groups, groups.findIndex(group => group.id === groupId)];
        // }

        // return groups;
    }

    async function save(groups, withMessage = false) {
        if (!Array.isArray(groups)) {
            throw Error('groups has invalid type');
        }

        await storage.set({
            groups,
        });

        if (isNeedBlockBeforeRequest(groups)) {
            BG.addListenerOnBeforeRequest();
        } else {
            BG.removeListenerOnBeforeRequest();
        }

        if (withMessage) {
            BG.sendMessage({
                action: 'groups-updated',
            });
        }

        return groups;
    }

    function create(id, title) {
        return {
            id: id,
            title: utils.createGroupTitle(title, id),
            iconColor: BG.options.defaultGroupIconColor || utils.randomColor(),
            iconUrl: null,
            iconViewType: BG.options.defaultGroupIconViewType,
            tabs: [],
            isArchive: false,
            newTabContainer: DEFAULT_COOKIE_STORE_ID,
            ifDifferentContainerReOpen: false,
            excludeContainersForReOpen: [],
            isMain: false,
            isSticky: false,
            catchTabContainers: [],
            catchTabRules: '',
            moveToMainIfNotInCatchTabRules: false,
            muteTabsWhenGroupCloseAndRestoreWhenOpen: false,
            showTabAfterMovingItIntoThisGroup: false,
            dontDiscardTabsAfterHideThisGroup: false,
            bookmarkId: null,
        };
    }

    async function add(windowId, tabIds = [], title = null, showTabsAfterMoving) {
        tabIds = Array.isArray(tabIds) ? tabIds.slice() : [];

        title = title ? title.slice(0, 256) : null;

        let {lastCreatedGroupPosition} = await storage.get('lastCreatedGroupPosition');

        lastCreatedGroupPosition++;

        let groups = await load(),
            newGroup = create(lastCreatedGroupPosition, title);

        groups.push(newGroup);

        await save(groups);

        await storage.set({
            lastCreatedGroupPosition,
        });

        if (windowId) {
            await cache.setWindowGroup(windowId, newGroup.id);
            BG.updateBrowserActionData(newGroup.id, undefined, groups);
        }

        BG.updateMoveTabMenus(groups);

        if (windowId && !tabIds.length) {
            let tabs = await Tabs.get(windowId);
            tabIds = tabs.map(utils.keyId);
        }

        if (tabIds.length) {
            newGroup.tabs = await Tabs.move(tabIds, newGroup.id, undefined, false, showTabsAfterMoving);
        }

        if (!showTabsAfterMoving) {
            BG.sendMessage({
                action: 'group-added',
                group: newGroup,
            });
        }

        BG.sendExternalMessage({
            action: 'group-added',
            group: mapForExternalExtension(newGroup),
        });

        return newGroup;
    }

    async function remove(groupId) {
        let [group, groups, index] = await load(groupId, true);

        BG.addUndoRemoveGroupItem(group);

        groups.splice(index, 1);

        await save(groups);

        let groupWindowId = cache.getWindowId(groupId);

        if (!group.isArchive) {
            if (groupWindowId) {
                BG.setBrowserAction(groupWindowId, 'loading');
                await cache.removeWindowSession(groupWindowId);
            }

            if (group.tabs.length) {
                if (groupWindowId) {
                    await Tabs.createTempActiveTab(groupWindowId, false);
                }

                await Tabs.remove(group.tabs);
            }

            BG.updateMoveTabMenus(groups);

            if (groupWindowId) {
                BG.updateBrowserActionData(null, groupWindowId, groups);
            }

            if (group.isMain) {
                utils.notify(['thisGroupWasMain'], 7);
            }
        }

        BG.removeGroupBookmark(group);

        BG.sendMessage({
            action: 'group-removed',
            groupId: groupId,
            windowId: groupWindowId,
        });

        BG.sendExternalMessage({
            action: 'group-removed',
            groupId: groupId,
            windowId: groupWindowId,
        });
    }

    async function update(groupId, updateData) {
        let [group, groups] = await load(groupId);

        if (!group) {
            throw Error(`group ${groupId} not found for update it`);
        }

        updateData = utils.clone(updateData); // clone need for fix bug: dead object after close tab which create object

        if (updateData.iconUrl && updateData.iconUrl.startsWith('chrome:')) {
            utils.notify('Icon not supported');
            delete updateData.iconUrl;
        }

        if (updateData.title) {
            updateData.title = updateData.title.slice(0, 256);
        }

        if (!Object.keys(updateData).length) {
            return;
        }

        if (updateData.isMain) {
            groups.forEach(gr => gr.isMain = gr.id === groupId);
        }

        Object.assign(group, updateData);

        await save(groups);

        BG.sendMessage({
            action: 'group-updated',
            group: {
                id: groupId,
                ...updateData,
            },
        });

        let externalGroup = mapForExternalExtension(group);

        if (Object.keys(externalGroup).some(key => updateData.hasOwnProperty(key))) {
            BG.sendExternalMessage({
                action: 'group-updated',
                group: externalGroup,
            });
        }

        if (['title', 'iconUrl', 'iconColor', 'iconViewType', 'isArchive', 'isSticky'].some(key => updateData.hasOwnProperty(key))) {
            BG.updateMoveTabMenus(groups);

            BG.updateBrowserActionData(groupId, undefined, groups);
        }

        if (updateData.hasOwnProperty('title')) {
            BG.updateGroupBookmarkTitle(group);
        }
    }

    async function move(groupId, newGroupIndex) {
        let [group, groups, groupIndex] = await load(groupId);

        groups.splice(newGroupIndex, 0, groups.splice(groupIndex, 1)[0]);

        await save(groups, true);

        BG.updateMoveTabMenus(groups);
    }

    async function sort(vector = 'asc') {
        if (!['asc', 'desc'].includes(vector)) {
            throw Error(`invalid sort vector: ${vector}`);
        }

        let groups = await load();

        if ('asc' === vector) {
            groups.sort(utils.sortBy('title'));
        } else {
            groups.sort(utils.sortBy('title', undefined, true));
        }

        await save(groups, true);

        BG.updateMoveTabMenus(groups);
    }

    async function unload(groupId) {
        if (!groupId) {
            utils.notify(['groupNotFound'], 7, 'groupNotFound');
            return false;
        }

        let windowId = cache.getWindowId(groupId);

        if (!windowId) {
            utils.notify(['groupNotLoaded'], 7, 'groupNotLoaded');
            return false;
        }

        let [group, groups] = await load(groupId, true);

        if (!group) {
            utils.notify(['groupNotFound'], 7, 'groupNotFound');
            return false;
        }

        if (group.isArchive) {
            utils.notify(['groupIsArchived', group.title], 7, 'groupIsArchived');
            return false;
        }

        if (group.tabs.some(utils.isTabCanNotBeHidden)) {
            utils.notify(['notPossibleSwitchGroupBecauseSomeTabShareMicrophoneOrCamera']);
            return false;
        }

        await BG.loadingBrowserAction(true, windowId);

        await cache.removeWindowSession(windowId);

        let tabs = await Tabs.get(windowId, false, true);
        // remove tabs without group
        tabs = tabs.filter(tab => !tab.groupId);

        if (tabs.length) {
            await BG.Tabs.show(tabs);
            await BG.Tabs.setActive(null, tabs);
        } else {
            await BG.Tabs.createTempActiveTab(windowId, false);
        }

        await BG.Tabs.safeHide(group.tabs);

        if (BG.options.discardTabsAfterHide && !group.dontDiscardTabsAfterHideThisGroup) {
            BG.Tabs.discard(group.tabs);
        }

        BG.updateBrowserActionData(null, windowId, groups);

        BG.updateMoveTabMenus(groups);

        BG.sendMessage({
            action: 'group-unloaded',
            groupId,
            windowId,
        });

        BG.sendExternalMessage({
            action: 'group-unloaded',
            groupId,
            windowId,
        });

        return true;
    }

    async function archiveToggle(groupId) {
        await BG.loadingBrowserAction();

        let [group, groups] = await load(groupId, true);

        if (group.isArchive) {
            group.isArchive = false;

            await BG.createTabsSafe(setNewTabsParams(group.tabs, group), true);

            group.tabs = [];
        } else {
            group.isArchive = true;

            group.tabs = Tabs.prepareForSave(group.tabs, false, true, true);

            let groupWindowId = cache.getWindowId(group.id);

            if (groupWindowId) {
                await cache.removeWindowSession(groupWindowId);
                await Tabs.createTempActiveTab(groupWindowId, false);
            }

            let tabIds = group.tabs.map(utils.keyId);

            BG.addExcludeTabIds(tabIds);
            await Tabs.remove(tabIds);
            BG.removeExcludeTabIds(tabIds);

            if (group.isMain) {
                group.isMain = false;
                utils.notify(['thisGroupWasMain'], 7);
            }
        }

        BG.sendExternalMessage({
            action: 'group-updated',
            group: mapForExternalExtension(group),
        });

        await save(groups, true);

        BG.loadingBrowserAction(false);

        BG.updateMoveTabMenus(groups);
    }

    function mapForExternalExtension(group) {
        return {
            id: group.id,
            title: utils.getGroupTitle(group),
            isArchive: group.isArchive,
            isSticky: group.isSticky,
            iconUrl: utils.getGroupIconUrl(group),
            contextualIdentity: Containers.get(group.newTabContainer),
            windowId: cache.getWindowId(group.id),
        };
    }

    function getNewTabParams({id, newTabContainer, ifDifferentContainerReOpen, excludeContainersForReOpen}) {
        return {groupId: id, newTabContainer, ifDifferentContainerReOpen, excludeContainersForReOpen};
    }

    function setNewTabsParams(tabs, group) {
        let newTabParams = getNewTabParams(group);

        return tabs.map(tab => Object.assign(tab, newTabParams));
    }

    async function getNextTitle() {
        let {lastCreatedGroupPosition} = await storage.get('lastCreatedGroupPosition');
        return utils.createGroupTitle(null, lastCreatedGroupPosition + 1);
    }

    function isCatchedUrl(url, catchTabRules) {
        return catchTabRules
            .split(/\s*\n\s*/)
            .map(regExpStr => regExpStr.trim())
            .filter(Boolean)
            .some(function(regExpStr) {
                try {
                    return new RegExp(regExpStr).test(url);
                } catch (e) {};
            });
    }

    function getCatchedForTab(groups, currentGroup, {cookieStoreId, url}) {
        groups = groups.filter(group => !group.isArchive);

        let destGroup = groups.find(function({catchTabContainers, catchTabRules}) {
            if (catchTabContainers.includes(cookieStoreId)) {
                return true;
            }

            if (catchTabRules && isCatchedUrl(url, catchTabRules)) {
                return true;
            }
        });

        if (destGroup) {
            if (destGroup.id === currentGroup.id) {
                return false;
            }

            return destGroup;
        }

        if (!currentGroup.moveToMainIfNotInCatchTabRules || !currentGroup.catchTabRules) {
            return false;
        }

        let mainGroup = groups.find(group => group.isMain);

        if (!mainGroup || mainGroup.id === currentGroup.id) {
            return false;
        }

        return mainGroup;
    }

    function isNeedBlockBeforeRequest(groups) {
        return groups.some(function({isArchive, catchTabContainers, catchTabRules, ifDifferentContainerReOpen, newTabContainer}) {
            if (isArchive) {
                return false;
            }

            if (catchTabContainers.length || catchTabRules) {
                return true;
            }

            if (ifDifferentContainerReOpen) {
                return true;
            }

            return newTabContainer !== DEFAULT_COOKIE_STORE_ID;
        });
    }

    async function setIconUrl(groupId, iconUrl) {
        try {
            await update(groupId, {
                iconViewType: null,
                iconUrl: await utils.normalizeGroupIcon(iconUrl),
            });
        } catch (e) {
            utils.notify(e);
        }
    }

    window.Groups = {
        load,
        save,
        create,
        add,
        remove,
        update,
        move,
        sort,
        unload,
        archiveToggle,
        mapForExternalExtension,
        getNewTabParams,
        setNewTabsParams,
        getNextTitle,
        getCatchedForTab,
        isNeedBlockBeforeRequest,
        setIconUrl,
    };

})();
