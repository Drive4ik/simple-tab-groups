(function() {
    'use strict';

    const VIEW_GROUPS = 'groups',
        VIEW_SEARCH_TABS = 'search-tabs',
        VIEW_GROUP_TABS = 'group-tabs';

    let background = browser.extension.getBackgroundPage().background,
        templates = {},
        options = null,
        allData = null,
        moveTabToGroupTabIndex = -1,
        state = {
            view: VIEW_GROUPS,
        },
        $on = on.bind({});

    storage.get(['closePopupAfterChangeGroup', 'openGroupAfterChange', 'showGroupCircleInSearchedTab', 'showUrlTooltipOnTabHover', 'showNotificationAfterMoveTab'])
        .then(result => options = result);

    loadData();
    addEvents();

    function addEvents() {
        $on('input', '#searchTab', function() {
            renderSearchTabsList();
        });

        $on('input', '#groupEditIconColor', function() {
            $('#groupEditIconColorCircle').style.backgroundColor = this.value.trim();
        });

        $on('click', '[data-action="load-group"]', function({groupId, tabIndex, openGroupIfCurrent}) { // TODO refactor this func
            let isCurrentGroup = groupId === allData.currentGroupId;

            if (isCurrentGroup && openGroupIfCurrent === 'true') {
                return renderTabsList(groupId);
            }

            background.loadGroup(getGroupById(groupId), isCurrentGroup, tabIndex)
                .then(loadData)
                .then(function() {
                    if (!options.closePopupAfterChangeGroup && options.openGroupAfterChange) {
                        renderTabsList(groupId);
                    }
                });

            if (options.closePopupAfterChangeGroup && !isCurrentGroup) {
                window.close();
            }
        });

        $on('click', '#settings', function() {
            browser.runtime.openOptionsPage();
        });

        $on('click', '[data-action="show-group"]', function({groupId}) {
            renderTabsList(groupId);
        });

        $on('click', '[data-show-groups-list]', function() {
            renderGroupsList();
        });

        $on('click', '[data-action="remove-tab"]', function({groupId, tabIndex}) {
            let group = getGroupById(groupId);

            background.removeTab(group.tabs[tabIndex], group, groupId === allData.currentGroupId);
        });

        $on('click', '[data-action="add-tab"]', function({groupId, cookieStoreId}) {
            background.addTab(getGroupById(groupId), cookieStoreId);
        });

        $on('click', '[data-action="open-group-settings-popup"]', function({groupId}) {
            let group = getGroupById(groupId);

            $('#groupEditTitle').value = unSafeHtml(group.title);
            $('#groupEditIconColorCircle').style.backgroundColor = group.iconColor;
            $('#groupEditIconColor').value = group.iconColor;
            $('#groupEditMoveNewTabsToThisGroupByRegExp').value = group.moveNewTabsToThisGroupByRegExp;

            $('html').classList.add('no-scroll');
            $('#groupEditPopup').classList.add('is-flex');
        });

        $on('click', '[data-submit-edit-popup]', function() {
            let group = getGroupById(state.groupId);

            group.title = safeHtml($('#groupEditTitle').value.trim());

            group.iconColor = $('#groupEditIconColorCircle').style.backgroundColor; // safed color

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
                .then(background.removeMoveTabMenus)
                .then(background.createMoveTabMenus)
                .then(createMoveTabContextMenu);

            $('html').classList.remove('no-scroll');
            $('#groupEditPopup').classList.remove('is-flex');
        });

        $on('click', '[data-close-edit-popup]', function() {
            $('html').classList.remove('no-scroll');
            $('#groupEditPopup').classList.remove('is-flex');
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
                .then(createMoveTabContextMenu);

            $('#groupDeletePopup').classList.remove('is-active');
        });

        $on('click', '[data-add-group]', function() {
            background.addGroup()
                .then(createMoveTabContextMenu);
        });

        $on('contextmenu', '[data-is-tab="true"]', function({tabIndex}) {
            moveTabToGroupTabIndex = tabIndex;
        });

        $on('click', '[data-action="move-tab-to-group"]', function({groupId}) {
            let tab = allData.groups.find(group => group.id === state.groupId).tabs[moveTabToGroupTabIndex];

            background.moveTabToGroup(tab, moveTabToGroupTabIndex, state.groupId, groupId);
        });

        $on('click', '[data-move-tab-to-new-group]', function() {
            let expandedGroup = allData.groups.find(group => group.id === state.groupId),
                tab = expandedGroup.tabs[moveTabToGroupTabIndex];

            background.addGroup()
                .then(function(newGroup) {
                    background.moveTabToGroup(tab, moveTabToGroupTabIndex, state.groupId, newGroup.id);
                });
        });

        // setTabEventsListener
        let loadDataTimer = null,
            listener = function(request, sender, sendResponse) {
            if (request.storageUpdated) {
                clearTimeout(loadDataTimer);
                loadDataTimer = setTimeout(loadData, 100);
            } else if (undefined !== request.loadingGroupPosition) {
                if (request.loadingGroupPosition) {
                    $('#loading').classList.remove('is-hidden');
                    $('#loading').firstElementChild.style.width = request.loadingGroupPosition + 'vw';
                } else {
                    $('#loading').classList.add('is-hidden');
                }
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
        setHtml('result', html);
        translatePage();
    }

    function setHtml(id, html) {
        $('#' + id).innerHTML = html;
    }

    function loadData() {
        console.log('loadData');

        return Promise.all([
                background.getCurrentData(),
                background.getNotPinnedTabs(true, false),
                browser.contextualIdentities.query({}).then(Array.from)
            ])
            .then(function(result) {
                let [curData, tabs, containers] = result;

                allData = {
                    groups: curData.groups,
                    currentGroupId: curData.currentGroup.id,
                    activeTabIndex: tabs.findIndex(tab => tab.active),
                    containers,
                };
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
        let containerColorCode = '';

        if (tab.cookieStoreId && tab.cookieStoreId !== DEFAULT_COOKIE_STORE_ID) {
            containerColorCode = 'border-bottom: 2px solid ' + allData.containers.find(container => container.cookieStoreId === tab.cookieStoreId).colorCode;
        }

        return {
            urlTitle: options.showUrlTooltipOnTabHover ? tab.url : '',
            classList: (groupId === allData.currentGroupId && tabIndex === allData.activeTabIndex) ? 'is-active' : '',
            tabIndex: tabIndex,
            groupId: groupId,
            title: safeHtml(unSafeHtml(tab.title || tab.url)),
            url: tab.url,
            containerColorCode: containerColorCode,
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
                let customData = {
                    classList: group.id === allData.currentGroupId ? 'is-active' : '',
                    colorCircleHtml: render('color-circle-tmpl', {
                        title: '',
                        iconColor: group.iconColor,
                    }),
                };

                delete group.classList; // TMP
                delete group.colorCircleHtml; // TMP

                return render('group-tmpl', Object.assign({}, group, customData));
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
            cookieStoreId: DEFAULT_COOKIE_STORE_ID,
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

        setHtml('move-tab-to-group-menu', render('move-tab-to-group-menu-tmpl', {
            menuItemsHtml,
        }));


        menuItemsHtml = allData.containers
            .map(function(container) {
                return render('create-tab-with-container-item-tmpl', {
                    cookieStoreId: container.cookieStoreId,
                    icon: container.iconUrl,
                    title: container.name,
                    groupId: state.groupId,
                });
            })
            .join('');

        setHtml('create-tab-with-container-menu', menuItemsHtml);

        if (translatePageAfterRender) {
            translatePage();
        }
    }

})();
