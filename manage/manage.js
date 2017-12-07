(function() {
    'use strict';

    let background = browser.extension.getBackgroundPage().background,
        templates = {},
        options = null,
        allData = null,
        allGroupsNodes = null,
        allTabsNodes = null,
        $on = on.bind({});

    storage.get(['closePopupAfterChangeGroup', 'openGroupAfterChange', 'showGroupCircleInSearchedTab', 'showUrlTooltipOnTabHover', 'showNotificationAfterMoveTab'])
        .then(result => options = result)
        .then(loadData);

    addEvents();

    function addEvents() {

        $on('click', '[data-action]', (data, event) => doAction(data.action, data, event));

        function doAction(action, data, event) {
            if ('load-group' === action) {
                //
            }
        }

        // setTabEventsListener
        let loadDataTimer = null,
            listener = function(request, sender, sendResponse) {
                if (request.storageUpdated) {
                    clearTimeout(loadDataTimer);
                    loadDataTimer = setTimeout(loadData, 100);
                }
                sendResponse(':)');
            };

        browser.runtime.onMessage.addListener(listener);
        window.addEventListener('unload', () => browser.runtime.onMessage.removeListener(listener));
    }

    function addDragAndDropEvents() {
        // groups
        let groupsSelector = '[data-is-group]';

        allGroupsNodes = Array.from(document.querySelectorAll(groupsSelector));

        allGroupsNodes.forEach(function(group) {
            group.addEventListener('dragstart', groupHandleDragStart, false);
            group.addEventListener('dragenter', groupHandleDragEnter, false);
            group.addEventListener('dragover', groupHandleDragOver, false);
            group.addEventListener('dragleave', groupHandleDragLeave, false);
            group.addEventListener('drop', groupHandleDrop, false);
            group.addEventListener('dragend', groupHandleDragEnd, false);
        });


    /*
        $on('dragstart', groupSelector, function(data, event) {
            this.classList.add('ghost');
        });

        $on('dragenter', groupSelector, function(data, event) {
            this.classList.add('over');
        });

        $on('dragover', groupSelector, function(data, event) {
            // if (event.preventDefault) {
            //     event.preventDefault(); // Necessary. Allows us to drop.
            // }

            event.dataTransfer.dropEffect = 'move'; // See the section on the DataTransfer object.

            return false;
        });

        $on('dragleave', groupSelector, function(data, event) {
            this.classList.remove('over');
        });

        $on('drop', groupSelector, function(data, event) {
            // event.stopPropagation(); // stops the browser from redirecting.
        });

        $on('dragend', groupSelector, function(data, event) {
            this.classList.remove('over');
        });*/


    }

    function groupHandleDragStart(e) {
        console.log('groupHandleDragStart');
        this.classList.add('ghost'); // this / e.target is the source node.
    }

    function groupHandleDragEnter(e) {
        console.log('groupHandleDragEnter');
        // this / e.target is the current hover target.
        this.classList.add('over');
    }

    function groupHandleDragOver(e) {
        console.log('groupHandleDragOver');
        e.preventDefault(); // Necessary. Allows us to drop.
        e.dataTransfer.dropEffect = 'move'; // See the section on the DataTransfer object.
        return false;
    }

    function groupHandleDragLeave(e) {
        console.log('groupHandleDragLeave');
        this.classList.remove('over'); // this / e.target is previous target element.
    }

    function groupHandleDrop(e) {
        console.log('groupHandleDrop');
        // this / e.target is current target element.
        e.stopPropagation(); // stops the browser from redirecting.
        // See the section on the DataTransfer object.
        return false;
    }

    function groupHandleDragEnd(e) {
        console.log('groupHandleDragEnd');
        // this/e.target is the source node.
        allGroupsNodes.forEach(function(group) {
            group.classList.remove('over');
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

    function setHtml(id, html) {
        $('#' + id).innerHTML = html;
    }

    function getContainers() {
        return new Promise(function(resolve) {
            browser.contextualIdentities.query({})
                .then(resolve, () => resolve([]));
        });
    }

    function loadData() {
        return Promise.all([
                background.getData(undefined, false),
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
            .then(renderGroupsCards)
            .then(addDragAndDropEvents);
    }

    function prepareTabToView(groupId, tab, tabIndex) {
        let container = {},
            urlTitle = '';

        if (tab.cookieStoreId && tab.cookieStoreId !== DEFAULT_COOKIE_STORE_ID) {
            container = allData.containers.find(container => container.cookieStoreId === tab.cookieStoreId);
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

        showResultHtml(groupsHtml);
    }

})();
