(function() {
    'use strict';

    const VIEW_GROUPS = 'groups',
        VIEW_SEARCH_TABS = 'search-tabs',
        VIEW_GROUP_TABS = 'group-tabs';

    let background = browser.extension.getBackgroundPage().background,
        templates = {},
        options = null,
        allData = null,
        moveTabToGroupTabIndex = null,
        state = {
            view: VIEW_GROUPS,
        },
        $on = on.bind({});

    storage.get(defaultOptions)
        .then(result => options = result);

    loadData();
    addEvents();

    function addEvents() {
        $on('input', '#searchTab', function() {
            renderSearchTabsList();
        });

        $on('input', '#groupEditIconColor', function() {
            $('#groupEditIconColorCircle').style.backgroundColor = '';
            $('#groupEditIconColorCircle').style.backgroundColor = safeHtml(this.value.trim());
        });

        $on('click', '[data-action="load-group"]', function(data) {
            let isCurrentGroup = data.groupId == allData.currentGroupId;

            if (isCurrentGroup && data.openGroupIfCurrent === 'true') {
                return renderTabsList(data.groupId);
            }

            background.loadGroup(getGroupById(data.groupId), isCurrentGroup, data.tabIndex)
                .then(loadData)
                .then(function() {
                    if (!options.closePopupAfterChangeGroup && options.openGroupAfterChange) {
                        renderTabsList(data.groupId);
                    }
                });

            if (options.closePopupAfterChangeGroup && !isCurrentGroup) {
                window.close();
            }
        });

        $on('click', '#settings', function() {
            browser.runtime.openOptionsPage();
        });

        $on('click', '[data-action="show-group"]', function(data) {
            renderTabsList(data.groupId);
        });

        $on('click', '[data-show-groups-list]', function() {
            renderGroupsList();
        });

        $on('click', '[data-action="remove-tab"]', function(data) {
            let group = getGroupById(data.groupId);

            background.removeTab(group.tabs[data.tabIndex], group, group.id == allData.currentGroupId);
        });

        $on('click', '[data-action="add-tab"]', function(data) {
            background.addTab(getGroupById(data.groupId));
        });

        $on('click', '[data-action="open-group-settings-popup"]', function(data) {
            let group = getGroupById(data.groupId);

            $('#groupEditTitle').value = unSafeHtml(group.title);
            $('#groupEditIconColorCircle').style.backgroundColor = unSafeHtml(group.iconColor);
            $('#groupEditIconColor').value = group.iconColor;
            $('#groupEditMoveNewTabsToThisGroupByRegExp').value = group.moveNewTabsToThisGroupByRegExp;
            $('#groupEditPopup').classList.add('is-active');
            $('#stg').classList.add('fix-height-popup');
        });

        $on('click', '[data-submit-edit-popup]', function() {
            let group = getGroupById(state.groupId);

            group.title = safeHtml($('#groupEditTitle').value.trim());
            group.iconColor = safeHtml($('#groupEditIconColor').value.trim());
            group.moveNewTabsToThisGroupByRegExp = $('#groupEditMoveNewTabsToThisGroupByRegExp').value.trim();

            background.saveGroup(group)
                .then(() => renderTabsList(state.groupId));

            $('#groupEditPopup').classList.remove('is-active');
            $('#stg').classList.remove('fix-height-popup');
        });

        $on('click', '[data-close-edit-popup]', function() {
            $('#groupEditPopup').classList.remove('is-active');
            $('#stg').classList.remove('fix-height-popup');
        });

        $on('click', '[data-action="show-delete-group-popup"]', function(data) {
            let group = getGroupById(data.groupId);

            $('#groupDeleteQuestion').innerText = browser.i18n.getMessage('removeGroupPopupBody', unSafeHtml(group.title));
            $('#groupDeletePopup').classList.add('is-active');
        });

        $on('click', '[data-close-delete-popup]', function() {
            $('#groupDeletePopup').classList.remove('is-active');
        });

        $on('click', '[data-submit-remove-group]', function() {
            background.removeGroup(getGroupById(state.groupId))
                .then(renderGroupsList);

            $('#groupDeletePopup').classList.remove('is-active');
        });

        $on('click', '[data-add-group]', function() {
            background.addGroup();
        });

        $on('contextmenu', '[data-is-tab="true"]', function(data) {
            moveTabToGroupTabIndex = data.tabIndex;
        });

        $on('click', '[data-action="move-tab-to-group"]', function(data) {
            let tab = allData.groups.find(group => group.id == state.groupId).tabs[moveTabToGroupTabIndex];

            background.moveTabToGroup(tab, state.groupId, data.groupId);
        });

        // setTabEventsListener
        let listener = function(request, sender, sendResponse) {
            if (request.storageUpdated) {
                loadData();
            }
        };

        browser.runtime.onMessage.addListener(listener);
        window.addEventListener('unload', () => browser.runtime.onMessage.removeListener(listener));
    }

    function getGroupById(groupId) {
        return allData.groups.find(group => String(group.id) === String(groupId));
    }

    function render(templateId, data) {
        let tmplHtml = null;

        if (templates[templateId]) {
            tmplHtml = templates[templateId];
        } else {
            tmplHtml = templates[templateId] = $('#' + templateId).innerHTML;
        }

        return format(tmplHtml, data);
    }

    function showResultHtml(html) {
        $('#result').innerHTML = html;
        translatePage();
    }

    function loadData() {
        return Promise.all([
                background.getCurrentData(),
                background.getNotPinnedTabs(true)
            ])
            .then(function(result) {
                let [curData, tabs] = result;

                allData = {
                    groups: curData.groups,
                    currentGroupId: curData.currentGroup.id,
                    activeTabIndex: tabs.findIndex(tab => tab.active),
                };

                window.allData = allData;
            })
            .then(selectRender);
    }

    function selectRender() {
        if (state.view === VIEW_SEARCH_TABS) {
            renderSearchTabsList();
        } else if (state.view === VIEW_GROUPS) {
            renderGroupsList();
        } else if (state.view === VIEW_GROUP_TABS) {
            renderTabsList(state.groupId || allData.currentGroupId);
        }
    }

    function getPreparedTabsHtml(tabs) {
        return tabs
            .map(tab => render('tab-tmpl', tab))
            .join('');
    }

    function prepareTabToView(groupId, tab, tabIndex) {
        return {
            urlTitle: options.showUrlTooltipOnTabHover ? tab.url : '',
            classList: (groupId == allData.currentGroupId && tabIndex == allData.activeTabIndex) ? 'is-active' : '',
            tabIndex: tabIndex,
            groupId: groupId,
            title: safeHtml(unSafeHtml(tab.title || tab.url)),
            url: tab.url,
            favIconUrl: tab.favIconUrl || '/icons/tab.svg',
        };
    }

    function renderSearchTabsList() {
        state.view = VIEW_SEARCH_TABS;
        state.searchStr = safeHtml($('#searchTab').value.trim().toLowerCase());

        if (!state.searchStr.length) {
            return renderGroupsList();
        }

        let tabsToView = [],
            searchHtml = null;

        allData.groups.forEach(function(group) {
            group.tabs.forEach(function(tab, tabIndex) {
                if ((tab.title || '').toLowerCase().indexOf(state.searchStr) !== -1 || (tab.url || '').toLowerCase().indexOf(state.searchStr) !== -1) {
                    let preparedTab = prepareTabToView(group.id, tab, tabIndex);

                    if (options.showGroupCircleInSearchedTab) {
                        preparedTab.title = render('color-circle-tmpl', group) + preparedTab.title;
                    }

                    tabsToView.push(preparedTab);
                }
            });
        });

        searchHtml = render('tabs-list-tmpl', {
            classList: 'h-margin-top-10',
            tabsHtml: getPreparedTabsHtml(tabsToView) || render('search-not-found-tmpl', state),
        });

        showResultHtml(searchHtml);
    }

    function renderGroupsList() {
        state.view = VIEW_GROUPS;

        let groupsHtml = allData.groups.map(function(group) {
                group.classList = group.id == allData.currentGroupId ? 'is-active' : '';
                group.colorCircleHtml = render('color-circle-tmpl', {
                    title: '',
                    iconColor: group.iconColor,
                });
                return render('group-tmpl', group);
            })
            .join('');

        let showGroupsHtml = render('groups-list-tmpl', {
            groupsHtml,
        });

        showResultHtml(showGroupsHtml);
    }

    function renderTabsList(groupId) {
        state.view = VIEW_GROUP_TABS;
        state.groupId = groupId;

        let group = getGroupById(groupId);

        let tabsListHtml = '';

        if (group.tabs.length) {
            let tabs = group.tabs.map((tab, tabIndex) => prepareTabToView(groupId, tab, tabIndex));

            tabsListHtml = render('tabs-list-tmpl', {
                tabsHtml: getPreparedTabsHtml(tabs),
            });
        }

        let result = render('tabs-list-wrapper-tmpl', {
            colorCircleHtml: render('color-circle-tmpl', {
                title: '',
                iconColor: group.iconColor,
            }),
            group,
            tabsListHtml,
        });

        // prepare context menus for tab moving to other group
        let menuItemsHtml = allData.groups
            .filter(gr => gr.id !== group.id)
            .map(function(gr) {
                return render('#move-tab-to-group-menu-item-tmpl', {
                    title: gr.title,
                    groupId: gr.id,
                    icon: createSvgColoredIcon(group.iconColor),
                });
            })
            .join('');

        $('#move-tab-to-group-menu').innerHTML = render('#move-tab-to-group-menu-tmpl', {
            menuItemsHtml,
        });

        showResultHtml(result);
    }

})();
