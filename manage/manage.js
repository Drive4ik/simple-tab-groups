(function() {
    'use strict';

    let background = browser.extension.getBackgroundPage().background,
        templates = {},
        options = null,
        allData = null,
        $on = on.bind({});

    storage.get(['closePopupAfterChangeGroup', 'openGroupAfterChange', 'showGroupCircleInSearchedTab', 'showUrlTooltipOnTabHover', 'showNotificationAfterMoveTab'])
        .then(result => options = result);

    addEvents();
    loadData();

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
            .then(renderGroupsCards);
    }

    function prepareTabToView(groupId, tab, tabIndex) {
        let container = {
                hiddenClass: 'is-hidden',
            };

        if (tab.cookieStoreId && tab.cookieStoreId !== DEFAULT_COOKIE_STORE_ID) {
            container = allData.containers.find(container => container.cookieStoreId === tab.cookieStoreId);
            container.hiddenClass = '';
        }

        return {
            urlTitle: options.showUrlTooltipOnTabHover ? tab.url : '',
            classList: (groupId === allData.currentGroup.id && tabIndex === allData.activeTabIndex) ? 'is-active' : '',
            tabIndex: tabIndex,
            groupId: groupId,
            title: safeHtml(unSafeHtml(tab.title || tab.url)),
            url: tab.url,
            container: container,
            favIconClass: tab.favIconUrl ? '' : 'is-hidden',
            favIconUrl: tab.favIconUrl,
        };
    }

    function getTabsHtml(group) {
        return group.tabs
            .map(function(tab, tabIndex) {
                return render('tab-tmpl', prepareTabToView(group.id, tab, tabIndex));
            })
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
            .join('');

        // let showGroupsHtml = render('groups-list-tmpl', {
        //     groupsHtml,
        // });

        showResultHtml(groupsHtml);
    }

})();
