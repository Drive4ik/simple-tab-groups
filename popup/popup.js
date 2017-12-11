(function() {
    'use strict';

    const BG = (function(bgWin) {
        return bgWin && bgWin.background.inited ? bgWin.background : false;
    })(browser.extension.getBackgroundPage());

    if (!BG) {
        return window.close();
    }

    const VIEW_GROUPS = 'groups',
        VIEW_SEARCH_TABS = 'search-tabs',
        VIEW_GROUP_TABS = 'group-tabs';

    let templates = {},
        options = null,
        allData = null,
        groupIdInContext = -1,
        moveTabToGroupTabIndex = -1,
        state = {
            view: VIEW_GROUPS,
        },
        popupIsShow = false,
        $on = on.bind({});

    storage.get(['closePopupAfterChangeGroup', 'openGroupAfterChange', 'showGroupCircleInSearchedTab', 'showUrlTooltipOnTabHover', 'showNotificationAfterMoveTab'])
        .then(result => options = result)
        .then(loadData);

    addEvents();

    function addEvents() {

        function doAction(action, data, event) {
            if ('load-group' === action) {
                let isCurrentGroup = data.groupId === allData.currentGroup.id;

                if (isCurrentGroup && -1 === data.tabIndex) { // open group
                    return renderTabsList(data.groupId);
                }

                BG.loadGroup(allData.currentWindowId, getGroupById(data.groupId), data.tabIndex)
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

                BG.removeTab(group.tabs[data.tabIndex], data.tabIndex, group);
            } else if ('add-tab' === action) {
                BG.addTab(getGroupById(data.groupId), data.cookieStoreId);
            } else if ('open-settings-group-popup' === action) {
                popupIsShow = true;
                let group = getGroupById(data.groupId);

                $('#editGroupPopup').dataset.groupId = data.groupId;
                $('#groupEditTitle').value = unSafeHtml(group.title);
                $('#groupEditIconColorCircle').style.backgroundColor = group.iconColor;
                $('#groupEditIconColor').value = group.iconColor;
                $('#groupEditCatchTabRules').value = group.catchTabRules;

                $('html').classList.add('no-scroll');
                $('#editGroupPopup').classList.add('is-flex');
            } else if ('context-open-settings-group-popup' === action) {
                doAction('open-settings-group-popup', {
                    groupId: groupIdInContext,
                });
            } else if ('submit-edit-group-popup' === action) {
                popupIsShow = false;

                let groupId = Number($('#editGroupPopup').dataset.groupId),
                    group = getGroupById(groupId);

                group.title = safeHtml($('#groupEditTitle').value.trim());

                group.iconColor = $('#groupEditIconColorCircle').style.backgroundColor; // safed color

                group.catchTabRules = $('#groupEditCatchTabRules').value.trim();

                group.catchTabRules
                    .split(/\s*\n\s*/)
                    .filter(Boolean)
                    .forEach(function(regExpStr) {
                        try {
                            new RegExp(regExpStr);
                        } catch (e) {
                            notify(browser.i18n.getMessage('invalidRegExpRuleTitle', regExpStr));
                        }
                    });

                BG.saveGroup(group)
                    .then(function() {
                        if (groupId === allData.currentGroup.id) {
                            BG.updateBrowserActionData();
                        }
                    })
                    .then(BG.removeMoveTabMenus)
                    .then(BG.createMoveTabMenus);

                $('html').classList.remove('no-scroll');
                $('#editGroupPopup').classList.remove('is-flex');
            } else if ('set-random-group-color' === action) {
                $('#groupEditIconColor').value = randomColor();
                dispatchEvent('input', $('#groupEditIconColor'));
            } else if ('close-edit-group-popup' === action) {
                popupIsShow = false;
                $('html').classList.remove('no-scroll');
                $('#editGroupPopup').classList.remove('is-flex');
            } else if ('show-delete-group-popup' === action) {
                popupIsShow = true;
                let group = getGroupById(data.groupId);

                $('#deleteGroupPopup').dataset.groupId = data.groupId;
                $('#groupDeleteQuestion').innerText = browser.i18n.getMessage('deleteGroupPopupBody', unSafeHtml(group.title));
                $('#deleteGroupPopup').classList.add('is-active');
            } else if ('context-show-delete-group-popup' === action) {
                doAction('show-delete-group-popup', {
                    groupId: groupIdInContext,
                });
            } else if ('close-delete-group-popup' === action) {
                popupIsShow = false;
                $('#deleteGroupPopup').classList.remove('is-active');

            } else if ('submit-delete-group-popup' === action) {
                popupIsShow = false;
                let groupId = Number($('#deleteGroupPopup').dataset.groupId);

                BG.removeGroup(getGroupById(groupId)).then(renderGroupsList);

                $('#deleteGroupPopup').classList.remove('is-active');
            } else if ('move-tab-to-group' === action) {
                let tab = getGroupById(state.groupId).tabs[moveTabToGroupTabIndex];

                BG.moveTabToGroup(tab, moveTabToGroupTabIndex, state.groupId, data.groupId);
            } else if ('move-tab-to-new-group' === action) {
                let expandedGroup = getGroupById(state.groupId),
                    tab = expandedGroup.tabs[moveTabToGroupTabIndex];

                BG.addGroup()
                    .then(function(newGroup) {
                        BG.moveTabToGroup(tab, moveTabToGroupTabIndex, state.groupId, newGroup.id);
                    });
            } else if ('add-group' === action) {
                BG.addGroup();
            } else if ('show-groups-list' === action) {
                renderGroupsList();
            } else if ('open-options-page' === action) {
                browser.runtime.openOptionsPage();
            } else if ('open-manage-page' === action) {
                browser.windows.create({
                    url: '/manage/manage.html',
                    titlePreface: browser.i18n.getMessage('extensionName') + ' - ',
                    type: 'popup',
                    left: 0,
                    top: 0,
                    width: window.screen.availWidth,
                    height: window.screen.availHeight,
                });
            } else if ('context-move-group-up' === action) {
                BG.moveGroup(getGroupById(groupIdInContext), 'up');
            } else if ('context-move-group-down' === action) {
                BG.moveGroup(getGroupById(groupIdInContext), 'down');
            } else if ('context-open-group-in-new-window' === action) {
                let group = getGroupById(groupIdInContext);

                BG.isGroupLoadInWindow(group)
                    .then(function() {
                        browser.windows.update(group.windowId, {
                            focused: true,
                        });
                    })
                    .catch(function() {
                        browser.windows.create({
                                state: 'maximized',
                            })
                            .then(win => BG.loadGroup(win.id, group));
                    });
            }
        }

        $on('click', '[data-action]', (data, event) => doAction(data.action, data, event));

        $on('input', '#searchTab', function() {
            renderSearchTabsList();
        });

        $on('input', '#groupEditIconColor', function() {
            $('#groupEditIconColorCircle').style.backgroundColor = this.value.trim();
        });

        // $on('click', '#settings', function() {
        //     browser.runtime.openOptionsPage();
        // });

        $on('mousedown mouseup', '[data-is-tab]', function(data, event) {
            if (1 === event.button) {
                if ('mousedown' === event.type) {
                    event.preventDefault();
                } else if ('mouseup' === event.type) {
                    doAction('remove-tab', data);
                }
            }
        });

        $on('contextmenu', '[contextmenu="group-menu"]', function({groupId}) {
            groupIdInContext = groupId;
        });

        $on('contextmenu', '[contextmenu="move-tab-to-group-menu"]', function({tabIndex}) {
            moveTabToGroupTabIndex = tabIndex;
        });

        let selectableElementsSelectors = ['[data-is-tab]', '[data-is-group]'];
        $on('mouseover', selectableElementsSelectors.join(', '), function() {
            document.querySelectorAll(selectableElementsSelectors.join(', '))
                .forEach(element => element.classList.remove('is-hover'));
        });

        $on('keydown', 'body', function(data, event) {
            if (popupIsShow) {
                return;
            }

            if (KeyEvent.DOM_VK_UP === event.keyCode || KeyEvent.DOM_VK_DOWN === event.keyCode) {
                let elements = Array.from(document.querySelectorAll(selectableElementsSelectors.join(', '))),
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
                if (request.storageUpdated) {
                    clearTimeout(loadDataTimer);
                    loadDataTimer = setTimeout(loadData, 100);
                } else if (undefined !== request.loadingGroupPosition) {
                    if (request.loadingGroupPosition) {
                        $('#loading').firstElementChild.style.width = request.loadingGroupPosition + 'vw';
                        $('#loading').classList.remove('is-hidden');
                    } else {
                        $('#loading').classList.add('is-hidden');
                    }
                }

                sendResponse();
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

    function setHtml(id, html, attr = 'innerHTML') {
        $('#' + id)[attr] = html;
    }

    function getContainers() {
        return new Promise(function(resolve) {
            browser.contextualIdentities.query({})
                .then(resolve, () => resolve([]));
        });
    }

    function loadData() {
        return Promise.all([
                BG.getData(undefined, false),
                getContainers()
            ])
            .then(function([result, containers]) {
                allData = {
                    groups: result.groups,
                    currentGroup: result.currentGroup,
                    currentWindowId: result.windowId,
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
            renderTabsList(state.groupId || allData.currentGroup.id);
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
            classList: (groupId === allData.currentGroup.id && tabIndex === allData.activeTabIndex) ? 'is-active' : '',
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
                    classList: group.id === allData.currentGroup.id ? 'is-active' : '',
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
