(function() {
    'use strict';

    const VIEW_GROUPS = 'groups',
        VIEW_SEARCH_TABS = 'search-tabs',
        VIEW_GROUP_TABS = 'group-tabs';

    let background = browser.extension.getBackgroundPage().background,
        templates = {},
        options = null,
        allData = null,
        groupIdInContext = -1,
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

        function doAction(action, data) {
            if ('load-group' === action) {
                let isCurrentGroup = data.groupId === allData.currentGroupId;

                if (isCurrentGroup && -1 === data.tabIndex) {
                    return renderTabsList(data.groupId);
                }

                background.loadGroup(getGroupById(data.groupId), isCurrentGroup, data.tabIndex)
                    .then(function() {
                        if (!options.closePopupAfterChangeGroup && options.openGroupAfterChange) {
                            renderTabsList(data.groupId);
                        }
                    });

                if (options.closePopupAfterChangeGroup && !isCurrentGroup) {
                    window.close();
                }
            } else if ('show-group' === action) {
                renderTabsList(data.groupId);
            } else if ('remove-tab' === action) {
                let group = getGroupById(data.groupId);

                background.removeTab(group.tabs[data.tabIndex], data.tabIndex, group);
            } else if ('add-tab' === action) {
                background.addTab(getGroupById(data.groupId), data.cookieStoreId);
            } else if ('open-settings-group-popup' === action) {
                let group = getGroupById(data.groupId);

                $('#editGroupPopup').dataset.groupId = data.groupId;
                $('#groupEditTitle').value = unSafeHtml(group.title);
                $('#groupEditIconColorCircle').style.backgroundColor = group.iconColor;
                $('#groupEditIconColor').value = group.iconColor;
                $('#groupEditMoveNewTabsToThisGroupByRegExp').value = group.moveNewTabsToThisGroupByRegExp;

                $('html').classList.add('no-scroll');
                $('#editGroupPopup').classList.add('is-flex');
            } else if ('context-open-settings-group-popup' === action) {
                doAction('open-settings-group-popup', {
                    groupId: groupIdInContext,
                });
            } else if ('submit-edit-group-popup' === action) {
                let groupId = Number($('#editGroupPopup').dataset.groupId),
                    group = getGroupById(groupId);

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
                    .then(function() {
                        if (groupId === allData.currentGroupId) {
                            background.updateBrowserActionIcon();
                        }
                    })
                    .then(background.removeMoveTabMenus)
                    .then(background.createMoveTabMenus);

                $('html').classList.remove('no-scroll');
                $('#editGroupPopup').classList.remove('is-flex');
            } else if ('close-edit-group-popup' === action) {
                $('html').classList.remove('no-scroll');
                $('#editGroupPopup').classList.remove('is-flex');
            } else if ('show-delete-group-popup' === action) {
                let group = getGroupById(data.groupId);

                $('#deleteGroupPopup').dataset.groupId = data.groupId;
                $('#groupDeleteQuestion').innerText = browser.i18n.getMessage('removeGroupPopupBody', unSafeHtml(group.title));
                $('#deleteGroupPopup').classList.add('is-active');
            } else if ('context-show-delete-group-popup' === action) {
                doAction('show-delete-group-popup', {
                    groupId: groupIdInContext,
                });
            } else if ('close-delete-group-popup' === action) {
                $('#deleteGroupPopup').classList.remove('is-active');

            } else if ('submit-delete-group-popup' === action) {
                let groupId = Number($('#deleteGroupPopup').dataset.groupId);

                background.removeGroup(getGroupById(groupId));

                $('#deleteGroupPopup').classList.remove('is-active');
            } else if ('move-tab-to-group' === action) {
                let tab = getGroupById(state.groupId).tabs[moveTabToGroupTabIndex];

                background.moveTabToGroup(tab, moveTabToGroupTabIndex, state.groupId, data.groupId);
            } else if ('move-tab-to-new-group' === action) {
                let expandedGroup = getGroupById(state.groupId),
                    tab = expandedGroup.tabs[moveTabToGroupTabIndex];

                background.addGroup()
                    .then(function(newGroup) {
                        background.moveTabToGroup(tab, moveTabToGroupTabIndex, state.groupId, newGroup.id);
                    });
            } else if ('add-group' === action) {
                background.addGroup();
            } else if ('show-groups-list' === action) {
                renderGroupsList();
            } else if ('context-move-group-up' === action) {
                background.moveGroup(getGroupById(groupIdInContext), 'up');
            } else if ('context-move-group-down' === action) {
                background.moveGroup(getGroupById(groupIdInContext), 'down');
            }
        }

        $on('click', '[data-action]', data => doAction(data.action, data));

        $on('input', '#searchTab', function() {
            renderSearchTabsList();
        });

        $on('input', '#groupEditIconColor', function() {
            $('#groupEditIconColorCircle').style.backgroundColor = this.value.trim();
        });

        $on('click', '#settings', function() {
            browser.runtime.openOptionsPage();
        });

        $on('contextmenu', '[contextmenu="group-menu"]', function({groupId}) {
            groupIdInContext = groupId;
        });

        $on('contextmenu', '[contextmenu="move-tab-to-group-menu"]', function({tabIndex}) {
            moveTabToGroupTabIndex = tabIndex;
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

    function showResultHtml(html, doTranslatePage = true) {
        setHtml('result', html);

        if (doTranslatePage) {
            translatePage();
        }
    }

    function setHtml(id, html) {
        $('#' + id).innerHTML = html;
    }

    function loadData() {
        return Promise.all([
                background.getData(undefined, false),
                browser.contextualIdentities.query({})
            ])
            .then(function([result, containers]) {
                allData = {
                    groups: result.groups,
                    currentGroupId: result.currentGroup.id,
                    activeTabIndex: result.tabs.findIndex(tab => tab.active),
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

        if (!group) {
            return console.error(`group id ${groupId} not found`);
        }

        let tabsListHtml = '';

        if (group.tabs.length) {
            let tabs = group.tabs.map((tab, tabIndex) => prepareTabToView(groupId, tab, tabIndex));

            tabsListHtml = render('tabs-list-tmpl', {
                tabsHtml: getPreparedTabsHtml(tabs),
            });
        }

        let tabsListWrapperHtml = render('tabs-list-wrapper-tmpl', {
            colorCircleHtml: render('color-circle-tmpl', {
                title: '',
                iconColor: group.iconColor,
            }),
            group,
            tabsListHtml,
            cookieStoreId: DEFAULT_COOKIE_STORE_ID,
        });

        showResultHtml(tabsListWrapperHtml, false);

        let groupsMenuItems = allData.groups
            .map(function(gr) {
                return render('move-tab-to-group-menu-item-tmpl', {
                    title: gr.title,
                    groupId: gr.id,
                    icon: createGroupSvgColoredIcon(gr.iconColor),
                    disabled: gr.id === state.groupId ? 'disabled' : '',
                });
            })
            .join('');

        setHtml('move-tab-to-group-menu', render('move-tab-to-group-menu-tmpl', {
            groupsMenuItems,
        }));


        let containersHtml = allData.containers
            .map(function(container) {
                return render('create-tab-with-container-item-tmpl', {
                    cookieStoreId: container.cookieStoreId,
                    icon: container.iconUrl,
                    title: container.name,
                    groupId: state.groupId,
                });
            })
            .join('');

        setHtml('create-tab-with-container-menu', containersHtml);

        translatePage();
    }

})();
