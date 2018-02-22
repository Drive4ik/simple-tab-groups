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
        contextData = null,
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
        return storage.get(onlyBoolOptionsKeys).then(result => options = result);
    }

    function addEvents() {

        $on('click', '[data-action]', (event, data) => doAction(data.action, data, event));

        async function doAction(action, data, event) {
            if ('load-group' === action) {
                let currentGroup = _groups.find(group => group.windowId === currentWindowId),
                    isCurrentGroup = currentGroup ? currentGroup.id === data.groupId : false;

                if (isCurrentGroup && -1 === data.tabIndex) { // open group
                    return renderTabsList(data.groupId);
                }

                BG.loadGroup(currentWindowId, getGroupIndex(data.groupId), data.tabIndex)
                    .then(function() {
                        if (options.closePopupAfterChangeGroup) {
                            if (!isCurrentGroup) {
                                window.close();
                            }
                        } else {
                            if (options.openGroupAfterChange) {
                                renderTabsList(data.groupId);
                            }
                        }
                    });
            } else if ('show-group' === action) {
                renderTabsList(data.groupId);
            } else if ('remove-tab' === action) {
                let group = getGroupById(data.groupId);

                BG.removeTab(data.tabIndex, group);
            } else if ('add-tab' === action) {
                BG.addTab(data.groupId, data.cookieStoreId);
            } else if ('open-settings-group-popup' === action) {
                Popups.showEditGroup(getGroupById(data.groupId), {
                    popupDesign: 1,
                });
            } else if ('context-open-settings-group-popup' === action) {
                doAction('open-settings-group-popup', contextData);
            } else if ('show-delete-group-popup' === action) {
                let group = getGroupById(data.groupId),
                    _removeGroup = () => BG.removeGroup(group.id).then(renderGroupsList);

                if (options.showConfirmDialogBeforeGroupDelete) {
                    if (group.windowId === currentWindowId && 1 === _groups.length && group.tabs.length) {
                        Popups.confirm(browser.i18n.getMessage('confirmDeleteLastGroupAndCloseTabs'), browser.i18n.getMessage('warning'))
                            .then(_removeGroup);
                    } else {
                        Popups.confirm(
                                browser.i18n.getMessage('deleteGroupBody', group.title),
                                browser.i18n.getMessage('deleteGroupTitle'),
                                'delete',
                                'is-danger'
                            )
                            .then(_removeGroup);
                    }
                } else {
                    _removeGroup();
                }

            } else if ('context-show-delete-group-popup' === action) {
                doAction('show-delete-group-popup', contextData);
            } else if ('move-tab-to-group' === action) {
                BG.moveTabToGroup(contextData.tabIndex, undefined, state.groupId, data.groupId);
            } else if ('move-tab-to-new-group' === action) {
                let newGroup = await BG.addGroup(undefined, undefined, false);

                BG.moveTabToGroup(contextData.tabIndex, undefined, state.groupId, newGroup.id);
            } else if ('set-tab-icon-as-group-icon' === action) {
                let group = getGroupById(state.groupId);

                BG.updateGroup(state.groupId, {
                    iconViewType: null,
                    iconUrl: BG.getTabFavIconUrl(group.tabs[contextData.tabIndex], options.useTabsFavIconsFromGoogleS2Converter),
                });

                renderTabsList(state.groupId);

                if (group.windowId === currentWindowId) {
                    BG.updateBrowserActionData(currentWindowId);
                    BG.updateMoveTabMenus(currentWindowId);
                }
            } else if ('add-group' === action) {
                BG.addGroup();
            } else if ('context-add-group-with-current-tabs' === action) {
                BG.addGroup(undefined, undefined, undefined, true);
            } else if ('show-groups-list' === action) {
                renderGroupsList();
            } else if ('open-options-page' === action) {
                browser.runtime.openOptionsPage();
            } else if ('open-manage-page' === action) {
                BG.openManageGroups(window.screen);
            } else if ('context-sort-groups' === action) {
                BG.sortGroups(data.vector);
            } else if ('context-open-group-in-new-window' === action) {
                let group = getGroupById(contextData.groupId);

                if (group.windowId) {
                    BG.setFocusOnWindow(group.windowId);
                } else {
                    let win = await BG.createWindow({
                        state: 'maximized',
                    });

                    BG.loadGroup(win.id, getGroupIndex(group.id));
                }
            }
        }

        $on('mousedown mouseup', '[data-is-tab]', function(event, data) {
            if (1 === event.button) { // delete tab by middle mouse click
                if ('mousedown' === event.type) {
                    event.preventDefault();
                } else if ('mouseup' === event.type) {
                    doAction('remove-tab', data);
                }
            }
        });

        $on('contextmenu', '[contextmenu]', function(event, data) {
            contextData = data;
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

        $on('click', '#clearSearchTabsButton .button', function() {
            let searchTabs = $('#searchTabs');
            searchTabs.value = '';
            dispatchEvent('input', searchTabs);
            searchTabs.focus();
        });

        $on('input', '#searchTabs', function() {
            if ($('#searchTabs').value.trim().length) {
                $('#clearSearchTabsButton').classList.remove('is-hidden');
                $('#searchWrapper > .field').classList.add('has-addons');
            } else {
                $('#clearSearchTabsButton').classList.add('is-hidden');
                $('#searchWrapper > .field').classList.remove('has-addons');
            }

            renderSearchTabsList();
        });

        $('#searchTabs').focus();

        addDragAndDropEvents();

        // setTabEventsListener
        let loadDataTimer = null,
            listener = function(request, sender, sendResponse) {
                if (!isAllowSender(sender)) {
                    return;
                }

                if (request.groupsUpdated) {
                    // _groups = BG.getGroups();
                    // selectRender();

                    clearTimeout(loadDataTimer);
                    loadDataTimer = setTimeout(function() {
                        _groups = BG.getGroups();
                        selectRender();
                    }, 100);
                }

                if (request.optionsUpdated) {
                    loadOptions();
                }
            };

        browser.runtime.onMessage.addListener(listener);
        window.addEventListener('unload', () => browser.runtime.onMessage.removeListener(listener));
    }

    function addDragAndDropEvents() {
        DragAndDrop.create({
            selector: '[data-is-group]',
            group: {
                name: 'groups',
                put: ['tabs'],
            },
            draggableElements: '.item, .item-title, .item-icon, .item-icon > .circle',
            onDrop(event, from, to, dataFrom, dataTo) {
                let newPosition = Array.from(to.parentNode.children).findIndex(node => node === to);
                BG.moveGroup(dataFrom.groupId, newPosition);
            },
        });

        DragAndDrop.create({
            selector: '[data-is-tab]:not(.is-searching)',
            group: 'tabs',
            draggableElements: '.item, .item-title, .item-title > .bordered, .item-icon',
            onDrop(event, from, to, dataFrom, dataTo) {
                let newTabIndex = dataTo.isGroup ? undefined : dataTo.tabIndex;
                BG.moveTabToGroup(dataFrom.tabIndex, newTabIndex, dataFrom.groupId, dataTo.groupId, false);
            },
        });
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
        if (!templates[templateId]) {
            templates[templateId] = $('#' + templateId).innerHTML;
        }

        return format(templates[templateId], data);
    }

    function setHtml(id, html, doTranslatePage = true) {
        $('#' + id)[INNER_HTML] = html;

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

    function prepareTabToView(groupId, tab, tabIndex, isSearching = false) {
        let containerColorCode = '',
            classList = [];

        if (tab.cookieStoreId && tab.cookieStoreId !== DEFAULT_COOKIE_STORE_ID) {
            containerColorCode = 'border-bottom: 2px solid ' + containers.find(container => container.cookieStoreId === tab.cookieStoreId).colorCode;
        }

        if (groupId === getCurrentGroup().id && tabIndex === getActiveIndex()) {
            classList.push('is-active');
        }

        if (isSearching) {
            classList.push('is-searching');
        }

        return {
            urlTitle: options.showUrlTooltipOnTabHover ? safeHtml(unSafeHtml([String(tab.id), tab.title, tab.url].join('\n'))) : '', // TODO change
            classList: classList.join(' '),
            tabIndex: tabIndex,
            groupId: groupId,
            title: safeHtml(unSafeHtml([String(tab.id), tab.title, tab.url].join('\n'))), // TODO change
            url: tab.url,
            containerColorCode: containerColorCode,
            favIconUrl: BG.getTabFavIconUrl(tab, options.useTabsFavIconsFromGoogleS2Converter),
        };
    }

    async function getGroupIconHtml(group, idAddGroupTitle) {
        let title = idAddGroupTitle ? group.title : '';

        return render('icon-img-tmpl', {
            title,
            iconUrl: await getGroupIconUrl(group),
        });
    }

    async function renderSearchTabsList() {
        state.view = VIEW_SEARCH_TABS;
        state.searchStr = safeHtml($('#searchTabs').value.trim().toLowerCase());

        if (!state.searchStr.length) {
            return renderGroupsList();
        }

        let tabsToView = [],
            searchHtml = null;

        await Promise.all(_groups.map(async function(group) {
            await Promise.all(group.tabs.map(async function(tab, tabIndex) {
                if ((tab.title || '').toLowerCase().indexOf(state.searchStr) !== -1 || (tab.url || '').toLowerCase().indexOf(state.searchStr) !== -1) {
                    let preparedTab = prepareTabToView(group.id, tab, tabIndex, true);

                    if (options.showGroupIconWhenSearchATab) {
                        preparedTab.title = await getGroupIconHtml(group, true) + preparedTab.title;
                    }

                    tabsToView.push(preparedTab);
                }
            }));
        }));

        searchHtml = render('tabs-list-tmpl', {
            classList: 'h-margin-top-10',
            tabsHtml: getPreparedTabsHtml(tabsToView) || render('search-not-found-tmpl', state),
        });

        setHtml('result', searchHtml);
    }

    async function renderGroupsList() {
        state.view = VIEW_GROUPS;

        let groupsHtml = await Promise.all(_groups.map(async function(group) {
            let customData = {
                classList: group.id === getCurrentGroup().id ? 'is-active' : '',
                colorCircleHtml: await getGroupIconHtml(group),
            };

            return render('group-tmpl', Object.assign({}, group, customData));
        }));

        let showGroupsHtml = render('groups-list-tmpl', {
            groupsHtml: groupsHtml.join(''),
        });

        setHtml('result', showGroupsHtml);
    }

    async function renderTabsList(groupId) {
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
            colorCircleHtml: await getGroupIconHtml(group),
            group,
            tabsListHtml,
            newTabContextMenu: containers.length ? 'contextmenu="create-tab-with-container-menu"' : '',
            cookieStoreId: DEFAULT_COOKIE_STORE_ID,
        });

        setHtml('result', tabsListWrapperHtml, false);

        let groupsMenuItems = await Promise.all(_groups
            .map(async function(gr) {
                return render('move-tab-to-group-menu-item-tmpl', {
                    title: gr.title,
                    groupId: gr.id,
                    icon: await getGroupIconUrl(gr),
                    disabled: gr.id === state.groupId ? 'disabled' : '',
                });
            }));

        setHtml('move-tab-to-group-menu', render('move-tab-to-group-menu-tmpl', {
            groupsMenuItems: groupsMenuItems.join(''),
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
