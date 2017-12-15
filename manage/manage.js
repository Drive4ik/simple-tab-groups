(function() {
    'use strict';

    const BG = (function(bgWin) {
        return bgWin && bgWin.background.inited ? bgWin.background : false;
    })(browser.extension.getBackgroundPage());

    if (!BG) {
        return window.close();
    }

    let templates = {},
        options = null,
        allData = null,
        createGroupIdContext = 0,
        $on = on.bind({});

    loadOptions()
        .then(loadData)
        .then(addEvents);

    function loadOptions() {
        return storage.get(onlyOptionsKeys).then(result => options = result);
    }

    function addEvents() {

        $on('click', '[data-action]', (event, data) => doAction(data.action, data, event));

        function doAction(action, data, event) {
            if ('load-group' === action) {
                BG.loadGroup(allData.currentWindowId, getGroupById(data.groupId), data.tabIndex);
            } else if ('add-tab' === action) {
                BG.addTab(getGroupById(data.groupId), data.cookieStoreId);
            } else if ('context-add-tab' === action) {
                BG.addTab(getGroupById(createGroupIdContext), data.cookieStoreId);
            } else if ('remove-tab' === action) {
                let group = getGroupById(data.groupId);
                BG.removeTab(group.tabs[data.tabIndex], data.tabIndex, group);
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

        $on('contextmenu', '[contextmenu="create-tab-with-container-menu"]', function(event, {groupId}) {
            createGroupIdContext = groupId;
        });

        $on('change', '.group > .header input', function(event, data) {
            let group = getGroupById(data.groupId);

            group.title = safeHtml(event.target.value.trim());

            BG.saveGroup(group)
                .then(() => BG.getData(undefined, false))
                .then(function(result) {
                    if (group.id === result.currentGroup.id) {
                        BG.updateBrowserActionData();
                    }
                })
                .then(BG.removeMoveTabMenus)
                .then(BG.createMoveTabMenus);
        });

        addDragAndDropEvents();

        // setTabEventsListener
        let loadDataTimer = null,
            listener = function(request, sender, sendResponse) {
                if (request.groupsUpdated) {
                    clearTimeout(loadDataTimer);
                    loadDataTimer = setTimeout(loadData, 100);
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
        return allData.groups.find(group => group.id === groupId);
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
                let group = getGroupById(dataFrom.groupId),
                    newPosition = Array.from(to.parentNode.children).findIndex(node => node === to);

                BG.moveGroup(group, newPosition);
            },
        });

        DragAndDrop.create({
            selector: '[data-is-tab]',
            group: 'tabs',
            draggableElements: '[data-is-tab], .icon, .screenshot, .delete-tab-button, .container, .title',
            onDrop(event, from, to, dataFrom, dataTo) {
                let newTabIndex = dataTo.isGroup ? -1 : dataTo.tabIndex;
                BG.moveTabToGroup(dataFrom.tabIndex, newTabIndex, dataFrom.groupId, dataTo.groupId, false);
            },
        });
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
        // console.log('loadData manage');

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
            .then(renderGroupsCards);
    }

    function prepareTabToView(groupId, tab, tabIndex) {
        let container = {},
            urlTitle = '';

        if (tab.cookieStoreId && tab.cookieStoreId !== DEFAULT_COOKIE_STORE_ID) {
            container = allData.containers.find(container => container.cookieStoreId === tab.cookieStoreId);
        }

        if (options.showUrlTooltipOnTabHover) {
            if (tab.title) {
                urlTitle = '';
                // urlTitle = safeHtml(unSafeHtml(tab.title)) + '\n' + tab.url; // TMP
            } else {
                urlTitle = tab.url;
            }
        }

        return {
            urlTitle: urlTitle,
            classList: (groupId === allData.currentGroup.id && tabIndex === allData.activeTabIndex) ? 'is-active' : '',
            tabIndex: tabIndex,
            groupId: groupId,
            title: safeHtml(unSafeHtml(tab.title || tab.url)),
            url: tab.url,

            favIconClass: tab.favIconUrl ? '' : 'is-hidden',
            favIconUrl: tab.favIconUrl,

            containerClass: container.cookieStoreId ? '' : 'is-hidden',
            containerIconUrl: container.iconUrl,
            containerColorCodeFillStyle: container.cookieStoreId ? `fill: ${container.colorCode};` : '',
            containerColorCodeBorderStyle: container.cookieStoreId ? `border-color: ${container.colorCode};` : '',

            thumbnailClass: '',
            thumbnail: tab.thumbnail || '/test.jpg',
        };
    }

    function getTabsHtml(group) {
        return group.tabs
            .map(function(tab, tabIndex) {
                return render('tab-tmpl', prepareTabToView(group.id, tab, tabIndex));
            })
            .concat([render('new-tab-tmpl', {
                groupId: group.id,
            })])
            .join('');
    }

    function renderGroupsCards() {
        let groupsHtml = allData.groups.map(function(group) {
                let customData = {
                    classList: '',
                    colorCircleHtml: render('color-circle-tmpl', group),
                    tabsHtml: getTabsHtml(group),
                };

                return render('group-tmpl', Object.assign({}, group, customData));
            })
            .concat([render('new-group-tmpl')])
            .join('');

        showResultHtml(groupsHtml, false);

        let containersHtml = allData.containers
            .map(function(container) {
                return render('create-tab-with-container-item-tmpl', {
                    cookieStoreId: container.cookieStoreId,
                    icon: container.iconUrl,
                    title: container.name,
                });
            })
            .join('');

        setHtml('create-tab-with-container-menu', containersHtml);

        translatePage();
    }

})();
