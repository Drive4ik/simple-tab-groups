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
        .then(renderGroupsCards)
        .then(addEvents);

    function loadOptions() {
        return storage.get(onlyOptionsKeys).then(result => options = result);
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
                BG.addTab(getGroupById(data.groupId), data.cookieStoreId);
            } else if ('context-add-tab' === action) {
                BG.addTab(getGroupById(groupIdContext), data.cookieStoreId);
            } else if ('context-open-group-in-new-window' === action) {
                let group = getGroupById(groupIdContext);

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

        $on('contextmenu', '[contextmenu="create-tab-with-container-menu"], [contextmenu="group-menu"]', function(event, {groupId}) {
            groupIdContext = groupId;
        });

        $on('change', '.group > .header input', function(event, data) {
            let group = getGroupById(data.groupId);

            group.title = safeHtml(event.target.value.trim());

            BG.saveGroup(group)
                .then(() => BG.getGroupByWindowId(currentWindowId))
                .then(function(currentGroup) {
                    if (currentGroup && currentGroup.id === group.id) {
                        BG.updateBrowserActionData();
                    }
                })
                .then(BG.updateMoveTabMenus);
        });

        addDragAndDropEvents();

        // setTabEventsListener
        let loadDataTimer = null,
            listener = function(request, sender, sendResponse) {
                if (request.groupsUpdated) {
                    _groups = BG.getGroups();
                    renderGroupsCards();

                    // clearTimeout(loadDataTimer);
                    // loadDataTimer = setTimeout(() => _groups = BG.getGroups(), 100);
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
        // groups
        let groupSelector = '[data-is-group]';

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

    function prepareTabToView(groupId, tab, tabIndex) {
        let container = {},
            urlTitle = '';

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

        return {
            urlTitle: urlTitle,
            classList: tab.active ? 'is-active' : '',
            tabIndex: tabIndex,
            groupId: groupId,
            title: safeHtml(unSafeHtml(tab.title || tab.url)),
            url: tab.url,

            favIconClass: tab.favIconUrl ? '' : 'is-hidden',
            favIconUrl: tab.favIconUrl,

            containerClass: container.cookieStoreId ? '' : 'is-hidden',
            containerIconUrl: container.cookieStoreId ? container.iconUrl : '',
            containerColorCodeFillStyle: container.cookieStoreId ? `fill: ${container.colorCode};` : '',
            containerColorCodeBorderStyle: container.cookieStoreId ? `border-color: ${container.colorCode};` : '',

            thumbnailClass: '',
            thumbnail: tab.thumbnail || '',
        };
    }

    function getTabsHtml(group) {
        return group.tabs
            .map(function(tab, tabIndex) {
                return render('tab-tmpl', prepareTabToView(group.id, tab, tabIndex));
            })
            .concat([render('new-tab-tmpl', {
                groupId: group.id,
                newTabContextMenu: containers.length ? 'contextmenu="create-tab-with-container-menu"' : '',
            })])
            .join('');
    }

    function renderGroupsCards() {
        let groupsHtml = _groups.map(function(group) {
                let customData = {
                    classList: '',
                    colorCircleHtml: render('color-circle-tmpl', group),
                    tabsHtml: getTabsHtml(group),
                };

                return render('group-tmpl', Object.assign({}, group, customData));
            })
            .concat([render('new-group-tmpl')])
            .join('');

        setHtml('result', groupsHtml, false);

        // $$('.tab > .screenshot > img').forEach(img => img.onload = () => img.parentNode.parentNode.classList.add('has-thumbnail')); // TODO

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
