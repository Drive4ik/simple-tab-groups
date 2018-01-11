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
        currentWindowId = null,
        groupIdContext = 0,
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
            currentWindowId = win.id;
            containers = allContainers;
        })
        .then(renderGroupsCards)
        .then(addEvents);

    async function loadOptions() {
        options = await storage.get(onlyOptionsKeys);
    }

    function addEvents() {

        $on('click', '[data-action]', (event, data) => doAction(data.action, data, event));

        function doAction(action, data, event) {
            if ('load-group' === action) {
                Promise.all([
                        // browser.windows.getLastFocused({ // not working :(
                        //     windowTypes: ['normal']
                        // }),
                        BG.getLastFocusedNormalWindow(), // fix bug with browser.windows.getLastFocused({windowTypes: ['normal']}), maybe find exists bug??
                        browser.windows.getCurrent()
                    ])
                    .then(function([lastFocusedNormalWindow, currentWindow]) {
                        BG.loadGroup(lastFocusedNormalWindow.id, getGroupIndex(data.groupId), data.tabIndex);

                        if ('popup' === currentWindow.type) {
                            browser.windows.remove(currentWindow.id);
                        }
                    });
            } else if ('add-tab' === action) {
                BG.addTab(data.groupId, data.cookieStoreId);
            } else if ('context-add-tab' === action) {
                BG.addTab(groupIdContext, data.cookieStoreId);
            } else if ('context-open-group-in-new-window' === action) {
                let group = getGroupById(groupIdContext);

                BG.getWindowByGroup(group)
                    .then(function(win) {
                        if (win) {
                            BG.setFocusOnWindow(win.id);
                        } else {
                            browser.windows.create({
                                    state: 'maximized',
                                })
                                .then(win => BG.loadGroup(win.id, getGroupIndex(group.id)));
                        }
                    });
            } else if ('remove-tab' === action) {
                let group = getGroupById(data.groupId);
                BG.removeTab(data.tabIndex, group);
            } else if ('show-delete-group-popup' === action) {
                let group = getGroupById(data.groupId);

                if (options.showConfirmDialogBeforeGroupDelete) {
                    Popups.showDeleteGroup(group);
                } else {
                    BG.removeGroup(group);
                }
            } else if ('open-settings-group-popup' === action) {
                Popups.showEditGroup(getGroupById(data.groupId), 2);
            } else if ('add-group' === action) {
                BG.addGroup();
            }
        }

        $on('contextmenu', '[contextmenu="create-tab-with-container-menu"], [contextmenu="group-menu"]', function(event, { groupId }) {
            groupIdContext = groupId;
        });

        $on('change', '.group > .header input', function(event, data) {
            let group = getGroupById(data.groupId);

            group.title = safeHtml(event.target.value.trim());

            BG.saveGroup(group, true);

            let currentGroup = _groups.find(gr => gr.windowId === currentWindowId);

            if (currentGroup && currentGroup.id === group.id) {
                BG.updateBrowserActionData(currentWindowId);
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

                sendResponse(':)');
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

    function prepareTabToView(group, tab, tabIndex, showTab) {
        let container = {},
            urlTitle = '',
            classList = [];

        if (tab.cookieStoreId && tab.cookieStoreId !== DEFAULT_COOKIE_STORE_ID) {
            container = containers.find(container => container.cookieStoreId === tab.cookieStoreId);
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

    function renderGroupsCards() {
        let filters = $filterTabs.value
                .trim()
                .split(/\s*\*\s*/)
                .filter(Boolean)
                .map(s => s.toLowerCase());

        let groupsHtml = _groups.map(function(group) {
                let customData = {
                    classList: '',
                    colorCircleHtml: render('color-circle-tmpl', group),
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
