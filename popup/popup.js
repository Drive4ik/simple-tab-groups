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
            let isCurrentGroup = data.groupId === allData.currentGroupId;

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

            background.removeTab(group.tabs[data.tabIndex], group, group.id === allData.currentGroupId);
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
        });

        $on('click', '[data-submit-edit-popup]', function() {
            let group = getGroupById(state.groupId),
                iconColor = $('#groupEditIconColor').value.trim();

            group.title = safeHtml($('#groupEditTitle').value.trim());

            group.iconColor = iconColor === safeHtml(iconColor) ? iconColor : '';

            group.moveNewTabsToThisGroupByRegExp = $('#groupEditMoveNewTabsToThisGroupByRegExp').value.trim();

            group.moveNewTabsToThisGroupByRegExp
                .split(/\s*\n\s*/)
                .filter(Boolean)
                .forEach(function(regExpStr) {
                    try {
                        new RegExp(regExpStr);
                    } catch (e) {
                        notify(browser.i18n.getMessage('invalidRegExpRuleTitle', regExpStr));
                    }
                });

            background.saveGroup(group)
                .then(() => renderTabsList(state.groupId))
                .then(background.prepareMoveTabMenus)
                .then(createMoveTabContextMenu);

            $('#groupEditPopup').classList.remove('is-active');
        });

        $on('click', '[data-close-edit-popup]', function() {
            $('#groupEditPopup').classList.remove('is-active');
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
                .then(renderGroupsList)
                .then(background.prepareMoveTabMenus)
                .then(createMoveTabContextMenu);

            $('#groupDeletePopup').classList.remove('is-active');
        });

        $on('click', '[data-add-group]', function() {
            background.addGroup();
        });

        $on('contextmenu', '[data-is-tab="true"]', function(data) {
            moveTabToGroupTabIndex = data.tabIndex;
        });

        $on('click', '[data-action="move-tab-to-group"]', function(data) {
            let tab = allData.groups.find(group => group.id === state.groupId).tabs[moveTabToGroupTabIndex];

            background.moveTabToGroup(tab, moveTabToGroupTabIndex, state.groupId, data.groupId);
        });

        $on('click', '[data-move-tab-to-new-group]', function(data) {
            let expandedGroup = allData.groups.find(group => group.id === state.groupId),
                tab = expandedGroup.tabs[moveTabToGroupTabIndex];

            background.addGroup()
                .then(function(newGroup) {
                    background.moveTabToGroup(tab, moveTabToGroupTabIndex, state.groupId, newGroup.id);
                });
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
        return allData.groups.find(group => group.id === groupId);
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
            classList: (groupId === allData.currentGroupId && tabIndex === allData.activeTabIndex) ? 'is-active' : '',
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
                return render('group-tmpl', Object.assign({}, group, {
                    classList: group.id === allData.currentGroupId ? 'is-active' : '',
                    colorCircleHtml: render('color-circle-tmpl', {
                        title: '',
                        iconColor: group.iconColor,
                    }),
                }));
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

        createMoveTabContextMenu();

        showResultHtml(result);
    }

    function createMoveTabContextMenu(translatePageAfterRender) {
        if (state.view != VIEW_GROUP_TABS) {
            return;
        }

        let menuItemsHtml = allData.groups
            .map(function(gr) {
                return render('move-tab-to-group-menu-item-tmpl', {
                    title: gr.title,
                    groupId: gr.id,
                    icon: background.createSvgColoredIcon(gr.iconColor),
                    disabled: gr.id === state.groupId ? 'disabled' : '',
                });
            })
            .join('');

        $('#move-tab-to-group-menu').innerHTML = render('move-tab-to-group-menu-tmpl', {
            menuItemsHtml,
        });

        if (translatePageAfterRender) {
            translatePage();
        }
    }

})();
