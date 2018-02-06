(function() {
    'use strict';

    const BG = (function(bgWin) {
        return bgWin && bgWin.background && bgWin.background.inited ? bgWin.background : false;
    })(browser.extension.getBackgroundPage());

    if (!BG) {
        return window.close();
    }

    let templates = {},
        options = null,
        _groups = BG.getGroups(),
        containers = [],
        currentWindow = null,
        currentWindowId = null,
        contextData = null,
        $filterTabs = $('#filterTabs'),
        $on = on.bind({});

    $filterTabs.focus();

    function changeFilterTabsHandler() {
        if ($filterTabs.value.trim().length) {
            $('#clearFilterTabsButton').classList.remove('is-hidden');
            $('#filterWrapper').classList.add('has-addons');
        } else {
            $('#clearFilterTabsButton').classList.add('is-hidden');
            $('#filterWrapper').classList.remove('has-addons');
        }
    }

    changeFilterTabsHandler();

    Promise.all([
            BG.getWindow(),
            loadContainers(),
            loadOptions()
        ])
        .then(function([win, allContainers]) {
            currentWindow = win;
            currentWindowId = win.id;
            containers = allContainers;
        })
        .then(renderGroupsCards)
        .then(addEvents);

    async function loadOptions() {
        options = await storage.get(onlyBoolOptionsKeys);
    }

    function addEvents() {

        $on('click', '[data-action]', (event, data) => doAction(data.action, data, event));

        async function doAction(action, data, event) {
            if ('load-group' === action) {
                let lastFocusedNormalWindow = BG.getLastFocusedNormalWindow(); // fix bug with browser.windows.getLastFocused({windowTypes: ['normal']}), maybe find exists bug??

                if ('popup' === currentWindow.type) {
                    BG.loadGroup(lastFocusedNormalWindow.id, getGroupIndex(data.groupId), data.tabIndex);
                    browser.windows.remove(currentWindow.id);
                } else if ('normal' === currentWindow.type) {
                    let currentGroup = _groups.find(gr => gr.windowId === currentWindowId),
                        _loadGroup = function() {
                            BG.loadGroup(lastFocusedNormalWindow.id, getGroupIndex(data.groupId), data.tabIndex);
                        };

                    if (currentGroup) {
                        _loadGroup();
                    } else {
                        if (options.individualWindowForEachGroup || getGroupById(data.groupId).windowId) {
                            _loadGroup();
                        } else {
                            let tabs = await BG.getTabs(currentWindowId);
                            if (tabs.length) {
                                Popups.confirm(browser.i18n.getMessage('confirmLoadGroupAndDeleteTabs'), browser.i18n.getMessage('warning')).then(_loadGroup);
                            } else {
                                _loadGroup();
                            }
                        }
                    }
                }
            } else if ('add-tab' === action) {
                BG.addTab(data.groupId, data.cookieStoreId);
            } else if ('context-add-tab' === action) {
                BG.addTab(contextData.groupId, data.cookieStoreId);
            } else if ('context-open-group-in-new-window' === action) {
                let group = getGroupById(contextData.groupId),
                    win = await BG.getWindowByGroup(group);

                if (win) {
                    BG.setFocusOnWindow(win.id);
                } else {
                    win = await BG.createWindow({
                        state: 'maximized',
                    });

                    BG.loadGroup(win.id, getGroupIndex(group.id), contextData.tabIndex);
                }
            } else if ('set-tab-icon-as-group-icon' === action) {
                let group = getGroupById(contextData.groupId);
                group.iconUrl = group.tabs[contextData.tabIndex].favIconUrl || null;

                BG.saveGroup(group);

                renderGroupsCards();

                if (group.windowId === currentWindowId) {
                    BG.updateBrowserActionData(currentWindowId);
                    BG.updateMoveTabMenus(currentWindowId);
                }
            } else if ('remove-tab' === action) {
                let group = getGroupById(data.groupId);
                BG.removeTab(data.tabIndex, group);
            } else if ('show-delete-group-popup' === action) {
                let group = getGroupById(data.groupId);

                if (options.showConfirmDialogBeforeGroupDelete) {
                    if (group.windowId === currentWindowId && 1 === _groups.length && group.tabs.length) {
                        Popups.confirm(browser.i18n.getMessage('confirmDeleteLastGroupAndCloseTabs'), browser.i18n.getMessage('warning'))
                            .then(() => BG.removeGroup(group.id));
                    } else {
                        Popups.confirm(
                                browser.i18n.getMessage('deleteGroupBody', group.title),
                                browser.i18n.getMessage('deleteGroupTitle'),
                                'delete',
                                'is-danger'
                            )
                            .then(() => BG.removeGroup(group.id));
                    }
                } else {
                    BG.removeGroup(group.id);
                }
            } else if ('open-settings-group-popup' === action) {
                Popups.showEditGroup(getGroupById(data.groupId), {
                    popupDesign: 2,
                });
            } else if ('add-group' === action) {
                BG.addGroup();
            }
        }

        $on('contextmenu', '[contextmenu]', function(event, data) {
            contextData = data;
        });

        $on('change', '.group > .header input', function(event, data) {
            let group = getGroupById(data.groupId);

            group.title = createGroupTitle(event.target.value, group.id);

            BG.saveGroup(group);

            let currentGroup = _groups.find(gr => gr.windowId === currentWindowId);

            if (currentGroup && currentGroup.id === group.id) {
                BG.updateBrowserActionData(currentWindowId);
                BG.updateMoveTabMenus(currentWindowId);
            }
        });

        $on('click', '#clearFilterTabsButton .button', function() {
            $filterTabs.value = '';
            dispatchEvent('input', $filterTabs);
            $filterTabs.focus();
        });

        $on('input', '#filterTabs', function() {
            changeFilterTabsHandler();
            renderGroupsCards();
        });

        addDragAndDropEvents();

        // setTabEventsListener
        let updateDataTimer = null,
            listener = function(request, sender, sendResponse) {
                if (!isAllowSender(sender)) {
                    return;
                }

                if (request.groupsUpdated) {
                    clearTimeout(updateDataTimer);
                    updateDataTimer = setTimeout(function() {
                        _groups = BG.getGroups();
                        renderGroupsCards();
                    }, 100);
                }

                if (request.optionsUpdated) {
                    loadOptions();
                }
            };

        browser.runtime.onMessage.addListener(listener);
        window.addEventListener('unload', () => browser.runtime.onMessage.removeListener(listener));
    }

    function getGroupById(groupId) {
        return _groups.find(group => group.id === groupId);
    }

    function getGroupIndex(groupId) {
        return _groups.findIndex(group => group.id === groupId);
    }

    function addDragAndDropEvents() {
        DragAndDrop.create({
            selector: '[data-is-group]',
            group: {
                name: 'groups',
                put: ['tabs'],
            },
            draggableElements: '.body, [data-is-group], .icon, .tabs-count',
            onDrop(event, from, to, dataFrom, dataTo) {
                let newPosition = Array.from(to.parentNode.children).findIndex(node => node === to);
                BG.moveGroup(dataFrom.groupId, newPosition);
            },
        });

        DragAndDrop.create({
            selector: '[data-is-tab]',
            group: 'tabs',
            draggableElements: '[data-is-tab], .icon, .screenshot, .delete-tab-button, .container, .title',
            onDrop(event, from, to, dataFrom, dataTo) {
                let newTabIndex = dataTo.isGroup ? undefined : dataTo.tabIndex;
                BG.moveTabToGroup(dataFrom.tabIndex, newTabIndex, dataFrom.groupId, dataTo.groupId, false);
            },
        });
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

    function prepareTabToView(group, tab, tabIndex, showTab) {
        let container = {},
            urlTitle = '',
            classList = [];

        if (tab.cookieStoreId && tab.cookieStoreId !== DEFAULT_COOKIE_STORE_ID) {
            container = containers.find(container => container.cookieStoreId === tab.cookieStoreId) || container;
        }

        if (options.showUrlTooltipOnTabHover) {
            if (tab.title) {
                urlTitle = safeHtml(unSafeHtml(tab.title)) + '\n' + tab.url;
            } else {
                urlTitle = tab.url;
            }
        }

        if (tab.active) {
            classList.push('is-active');

            if (group.windowId) {
                classList.push('is-current');
            }
        }

        if (tab.thumbnail) {
            classList.push('has-thumbnail');
        }

        if (!showTab) {
            classList.push('is-hidden');
        }

        return {
            urlTitle: urlTitle,
            classList: classList.join(' '),
            tabIndex: tabIndex,
            groupId: group.id,
            title: safeHtml(unSafeHtml(tab.title || tab.url)),
            url: tab.url,

            favIconClass: tab.favIconUrl ? '' : 'is-hidden',
            favIconUrl: tab.favIconUrl,

            containerClass: container.cookieStoreId ? '' : 'is-hidden',
            containerIconUrl: container.cookieStoreId ? container.iconUrl : '',
            containerColorCodeFillStyle: container.cookieStoreId ? `fill: ${container.colorCode};` : '',
            containerColorCodeBorderStyle: container.cookieStoreId ? `border-color: ${container.colorCode};` : '',

            thumbnail: tab.thumbnail || '',
        };
    }

    function getTabsHtml(group, filters) {
        return group.tabs
            .map(function(tab, tabIndex) {
                let showTab = false;

                if (filters.length) {
                    for (let i = 0; i < filters.length; i++) {
                        if (-1 !== (tab.title || '').toLowerCase().indexOf(filters[i]) || -1 !== tab.url.toLowerCase().indexOf(filters[i])) {
                            showTab = true;
                        }
                    }
                } else {
                    showTab = true;
                }

                return render('tab-tmpl', prepareTabToView(group, tab, tabIndex, showTab));
            })
            .concat(filters.length ? [] : [render('new-tab-tmpl', {
                groupId: group.id,
                newTabContextMenu: containers.length ? 'contextmenu="create-tab-with-container-menu"' : '',
            })])
            .join('');
    }

    function getGroupIconHtml(group) {
        if (group.iconUrl) {
            return render('icon-img-tmpl', group);
        }

        if (group.iconColor) {
            return render('icon-color-tmpl', group);
        }

        return '';
    }

    function renderGroupsCards() {
        let filters = $filterTabs.value
                .trim()
                .split(/\s*\*\s*/)
                .filter(Boolean)
                .map(s => s.toLowerCase());

        let groupsHtml = _groups.map(function(group) {
                let customData = {
                    classList: '',
                    iconHtml: getGroupIconHtml(group),
                    tabsHtml: getTabsHtml(group, filters),
                };

                return render('group-tmpl', Object.assign({}, group, customData));
            })
            .concat([render('new-group-tmpl')])
            .join('');

        setHtml('result', groupsHtml, false);

        let containersHtml = containers
            .map(function(container) {
                return render('create-tab-with-container-item-tmpl', {
                    cookieStoreId: container.cookieStoreId,
                    icon: container.iconUrl,
                    title: container.name,
                });
            })
            .join('');

        setHtml('create-tab-with-container-menu', containersHtml);
    }

})();
