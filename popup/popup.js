(function() {
    'use strict';

    const BG = (function(bgWin) {
        return bgWin && bgWin.background && bgWin.background.inited ? bgWin.background : false;
    })(browser.extension.getBackgroundPage());

    if (!BG) {
        return window.close();
    }

    const VIEW_GROUPS = 'groups',
        VIEW_SEARCH_TABS = 'search-tabs',
        VIEW_GROUP_TABS = 'group-tabs';

    let templates = {},
        options = null,
        _groups = BG.getGroups(),
        containers = [],
        currentWindowId = null,
        groupIdInContext = -1,
        moveTabToGroupTabIndex = -1,
        state = {
            view: VIEW_GROUPS,
        },
        $on = on.bind({});

    Promise.all([
            BG.getWindow(),
            loadContainers(),
            loadOptions()
        ])
        .then(function([win, allContainers]) {
            currentWindowId = win.id;
            containers = allContainers;
        })
        .then(selectRender)
        .then(addEvents);

    function loadOptions() {
        return storage.get(onlyOptionsKeys).then(result => options = result);
    }

    function addEvents() {

        $on('click', '[data-action]', (event, data) => doAction(data.action, data, event));

        function doAction(action, data, event) {
            if ('load-group' === action) {
                let currentGroup = _groups.find(group => group.windowId === currentWindowId);

                if (!currentGroup) {
                    return;
                }

                let isCurrentGroup = data.groupId === currentGroup.id;

                if (isCurrentGroup && -1 === data.tabIndex) { // open group
                    return renderTabsList(data.groupId);
                }

                BG.loadGroup(currentWindowId, getGroupIndex(data.groupId), data.tabIndex)
                    .then(function() {
                        if (!options.closePopupAfterChangeGroup && options.openGroupAfterChange) {
                            renderTabsList(data.groupId);
                        }

                        if (options.closePopupAfterChangeGroup && !isCurrentGroup) {
                            window.close();
                        }
                    });
            } else if ('show-group' === action) {
                renderTabsList(data.groupId);
            } else if ('remove-tab' === action) {
                let group = getGroupById(data.groupId);

                BG.removeTab(data.tabIndex, group);
            } else if ('add-tab' === action) {
                BG.addTab(getGroupById(data.groupId), data.cookieStoreId);
            } else if ('open-settings-group-popup' === action) {
                Popups.showEditGroup(getGroupById(data.groupId), 1);
            } else if ('context-open-settings-group-popup' === action) {
                Popups.showEditGroup(getGroupById(groupIdInContext), 1);
            } else if ('show-delete-group-popup' === action) {
                let group = getGroupById(data.groupId);

                if (options.showConfirmDialogBeforeGroupDelete) {
                    Popups.showDeleteGroup(group);
                } else {
                    BG.removeGroup(group);
                }
            } else if ('context-show-delete-group-popup' === action) {
                doAction('show-delete-group-popup', {
                    groupId: groupIdInContext,
                });
            } else if ('move-tab-to-group' === action) {
                BG.moveTabToGroup(moveTabToGroupTabIndex, undefined, state.groupId, data.groupId);
            } else if ('move-tab-to-new-group' === action) {
                BG.addGroup(undefined, undefined, false).then(newGroup => BG.moveTabToGroup(moveTabToGroupTabIndex, undefined, state.groupId, newGroup.id));
            } else if ('add-group' === action) {
                BG.addGroup();
            } else if ('show-groups-list' === action) {
                renderGroupsList();
            } else if ('open-options-page' === action) {
                browser.runtime.openOptionsPage();
            } else if ('open-manage-page' === action) {
                let manageUrl = browser.extension.getURL('/manage/manage.html');

                if (options.openManageGroupsInTab) {
                    browser.tabs.query({
                            windowId: currentWindowId,
                            url: manageUrl,
                        })
                        .then(function(tabs) {
                            if (tabs.length) { // if manage tab is found
                                browser.tabs.update(tabs[0].id, {
                                    active: true,
                                });
                            } else {
                                browser.tabs.create({
                                    active: true,
                                    url: manageUrl,
                                });
                            }
                        });
                } else {
                    browser.windows.getAll({
                            populate: true,
                            windowTypes: ['popup'],
                        })
                        .then(function(allWindows) {
                            return allWindows.some(function(win) {
                                if ('popup' === win.type && 1 === win.tabs.length && manageUrl === win.tabs[0].url) { // if manage popup is now open
                                    return BG.setFocusOnWindow(win.id);
                                }
                            });
                        })
                        .then(function(isFoundWindow) {
                            if (isFoundWindow) {
                                return;
                            }

                            browser.windows.create({
                                url: manageUrl,
                                type: 'popup',
                                left: 0,
                                top: 0,
                                width: window.screen.availWidth,
                                height: window.screen.availHeight,
                            });
                        });
                }

                // window.close(); // be or not to be ?? :)
            } else if ('context-move-group-up' === action) {
                BG.moveGroup(groupIdInContext, 'up');
            } else if ('context-move-group-down' === action) {
                BG.moveGroup(groupIdInContext, 'down');
            } else if ('context-open-group-in-new-window' === action) {
                let group = getGroupById(groupIdInContext);

                BG.getWindowByGroup(group)
                    .then(function(win) {
                        if (win) {
                            BG.setFocusOnWindow(group.windowId);
                        } else {
                            browser.windows.create({
                                    state: 'maximized',
                                })
                                .then(win => BG.loadGroup(win.id, getGroupIndex(group.id)));
                        }
                    });
            }
        }

        $on('input', '#searchTab', renderSearchTabsList);

        $on('mousedown mouseup', '[data-is-tab]', function(event, data) {
            if (1 === event.button) { // delete tab by middle mouse click
                if ('mousedown' === event.type) {
                    event.preventDefault();
                } else if ('mouseup' === event.type) {
                    doAction('remove-tab', data);
                }
            }
        });

        $on('contextmenu', '[contextmenu="group-menu"]', function(event, {groupId}) {
            groupIdInContext = groupId;
        });

        $on('contextmenu', '[contextmenu="move-tab-to-group-menu"]', function(event, {tabIndex}) {
            moveTabToGroupTabIndex = tabIndex;
        });

        let selectableElementsSelectors = ['[data-is-tab]', '[data-is-group]'];
        $on('mouseover', selectableElementsSelectors.join(', '), function() {
            $$(selectableElementsSelectors.join(', ')).forEach(element => element.classList.remove('is-hover'));
        });

        $on('keydown', 'body', function(event) {
            if (Popups.show) {
                return;
            }

            if (KeyEvent.DOM_VK_UP === event.keyCode || KeyEvent.DOM_VK_DOWN === event.keyCode) {
                let elements = $$(selectableElementsSelectors.join(', ')),
                    currentIndex = elements.findIndex(el => el.classList.contains('is-hover')),
                    currentActiveIndex = elements.findIndex(el => el.classList.contains('is-active')),
                    textPosition = KeyEvent.DOM_VK_UP === event.keyCode ? 'prev' : 'next',
                    nextIndex = getNextIndex(-1 !== currentIndex ? currentIndex : currentActiveIndex, elements.length, textPosition);

                if (false === nextIndex) {
                    return;
                }

                event.preventDefault();

                if (-1 !== currentIndex) {
                    elements[currentIndex].classList.remove('is-hover');
                }

                elements[nextIndex].classList.add('is-hover');

                if (!checkVisibleElement(elements[nextIndex])) {
                    let rect = elements[nextIndex].getBoundingClientRect(),
                        jumpPos = Math.round(window.innerHeight / 2),
                        newPos = window.scrollY + rect.top - jumpPos;

                    if (newPos < 0) {
                        newPos = 0;
                    }

                    window.scrollTo(0, newPos);
                }
            } else if (KeyEvent.DOM_VK_RETURN === event.keyCode) { // enter command
                let element = $('.is-hover' + selectableElementsSelectors.join(', .is-hover'));

                if (element) {
                    dispatchEvent('click', element);
                }
            } else if (state.view === VIEW_GROUPS && KeyEvent.DOM_VK_RIGHT === event.keyCode) { // open group
                let element = $('.is-hover[data-is-group]');

                if (!element) {
                    element = $('.is-active[data-is-group]');
                }

                if (element) {
                    renderTabsList(dataFromElement(element).groupId);
                }
            } else if (state.view === VIEW_GROUP_TABS && KeyEvent.DOM_VK_LEFT === event.keyCode) { // close group
                renderGroupsList();
            }
        });

        // setTabEventsListener
        let loadDataTimer = null,
            listener = function(request, sender, sendResponse) {
                if (request.groupsUpdated) {
                    // _groups = BG.getGroups();
                    // selectRender();

                    clearTimeout(loadDataTimer);
                    loadDataTimer = setTimeout(function() {
                        _groups = BG.getGroups();
                        selectRender();
                    }, 300);
                }

                if (undefined !== request.loadingGroupPosition) {
                    if (request.loadingGroupPosition) {
                        $('#loading').firstElementChild.style.width = request.loadingGroupPosition + 'vw';
                        $('#loading').classList.remove('is-hidden');
                    } else {
                        $('#loading').classList.add('is-hidden');
                    }
                }

                if (request.optionsUpdated) {
                    loadOptions();
                }

                sendResponse(':)');
            };

        browser.runtime.onMessage.addListener(listener);
        window.addEventListener('unload', () => browser.runtime.onMessage.removeListener(listener));
    }

    function getCurrentGroup() {
        return _groups.find(group => group.windowId === currentWindowId) || {};
    }

    function getActiveIndex() {
        let group = getCurrentGroup();

        return group ? group.tabs.findIndex(tab => tab.active) : -1;
    }

    function getGroupById(groupId) {
        return _groups.find(group => group.id === groupId);
    }

    function getGroupIndex(groupId) {
        return _groups.findIndex(group => group.id === groupId);
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

    function setHtml(id, html, doTranslatePage = true, attr = 'innerHTML') {
        $('#' + id)[attr] = html;

        if (doTranslatePage) {
            translatePage();
        }
    }

    function selectRender() {
        if (state.view === VIEW_SEARCH_TABS) {
            renderSearchTabsList();
        } else if (state.view === VIEW_GROUPS) {
            renderGroupsList();
        } else if (state.view === VIEW_GROUP_TABS) {
            renderTabsList(state.groupId || getCurrentGroup().id);
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
            containerColorCode = 'border-bottom: 2px solid ' + containers.find(container => container.cookieStoreId === tab.cookieStoreId).colorCode;
        }

        return {
            urlTitle: options.showUrlTooltipOnTabHover ? tab.url : '',
            classList: (groupId === getCurrentGroup().id && tabIndex === getActiveIndex()) ? 'is-active' : '',
            tabIndex: tabIndex,
            groupId: groupId,
            title: safeHtml(unSafeHtml(tab.title || tab.url)),
            url: tab.url,
            containerColorCode: containerColorCode,
            favIconUrl: tab.favIconUrl || 'chrome://browser/skin/urlbar-tab.svg',
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

        _groups.forEach(function(group) {
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

        setHtml('result', searchHtml);
    }

    function renderGroupsList() {
        state.view = VIEW_GROUPS;

        let groupsHtml = _groups.map(function(group) {
                let customData = {
                    classList: group.id === getCurrentGroup().id ? 'is-active' : '',
                    colorCircleHtml: render('color-circle-tmpl', {
                        title: '',
                        iconColor: group.iconColor,
                    }),
                };

                return render('group-tmpl', Object.assign({}, group, customData));
            })
            .join('');

        let showGroupsHtml = render('groups-list-tmpl', {
            groupsHtml,
        });

        setHtml('result', showGroupsHtml);
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
                classList: '',
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
            newTabContextMenu: containers.length ? 'contextmenu="create-tab-with-container-menu"' : '',
            cookieStoreId: DEFAULT_COOKIE_STORE_ID,
        });

        setHtml('result', tabsListWrapperHtml, false);

        let groupsMenuItems = _groups
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
        }), false);

        let containersHtml = containers
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
    }

})();
